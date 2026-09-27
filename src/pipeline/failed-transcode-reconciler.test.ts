import { describe, it, expect } from 'vitest';

import {
  InMemoryJobRepository,
  type Job
} from '../data/job-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryPipelineRepository } from '../data/pipeline-repo.js';
import { InMemoryWebhookRepository } from '../data/inmemory-webhook-repo.js';
import { WEBHOOK_EVENT_TYPES } from '../data/webhook-repo.js';
import { WebhookDispatcher } from '../services/webhook-dispatcher.js';
import type { EncoreClient } from './encore-client.js';
import { completeTranscode } from './transcode.js';
import { dispatchTranscodeCompletionEvents } from './transcode-completion-events.js';
import { ENCODE_COMPLETION_EVENT_TYPE } from './encode-completion-event.js';
import {
  reconcileFailedTranscodes,
  settleFailedTranscode,
  DEFAULT_STALL_TIMEOUT_MS
} from './failed-transcode-reconciler.js';

// A fake EncoreClient whose getJobStatus is scripted per encore internal id.
// submit/cancel are unused by the reconciler and throw if called by mistake.
function fakeEncore(
  statusByInternalId: Record<string, string | undefined>,
  calls?: string[]
): EncoreClient {
  return {
    async submit() {
      throw new Error('submit not expected');
    },
    async cancel() {
      throw new Error('cancel not expected');
    },
    async getJobStatus(encoreJobId: string): Promise<string | undefined> {
      calls?.push(encoreJobId);
      return statusByInternalId[encoreJobId];
    }
  };
}

// A fake EncoreClient that RECORDS cancel(externalId) calls instead of throwing,
// so the #746 terminal-settle cancel/drain guard (failed-transcode-reconciler.ts:237)
// can be exercised. getJobStatus/submit are unused by the direct settle path.
function cancelSpyEncore(): { encore: EncoreClient; cancels: string[] } {
  const cancels: string[] = [];
  return {
    cancels,
    encore: {
      async submit() {
        throw new Error('submit not expected');
      },
      async cancel(encoreJobId: string): Promise<void> {
        cancels.push(encoreJobId);
      },
      async getJobStatus(): Promise<string | undefined> {
        throw new Error('getJobStatus not expected');
      }
    }
  };
}

// Build a `running` transcode job whose source asset is `processing`, plus a
// running PipelineExecution with a running `transcode` step — i.e. the exact
// stuck shape issue #273 describes. Returns the repos + created records.
async function stuckTranscode(opts?: { encoreInternalJobId?: string; encoreJobId?: string }) {
  const jobs = new InMemoryJobRepository();
  const assets = new InMemoryAssetRepository();
  const pipeline = new InMemoryPipelineRepository();

  const asset = await assets.create({ name: 'clip', objectKey: 'src/clip.mov' });
  // uploading -> processing (a transcode is in flight against this asset).
  await assets.update(asset.id, { status: 'processing' });

  const internalId = opts?.encoreInternalJobId ?? 'encore-internal-1';
  const job = await jobs.create({ type: 'transcode', assetId: asset.id, profile: 'program-x265' });
  // pending -> running, with Encore's internal id recorded (as submitTranscode does).
  // encoreJobId (our externalId, the scaler's correlation key) is set only when a
  // caller asks for it — the cancel/drain guard (line 237) keys on it.
  await jobs.update(job.id, {
    status: 'running',
    encoreInternalJobId: internalId,
    ...(opts?.encoreJobId ? { encoreJobId: opts.encoreJobId } : {})
  });

  const execution = await pipeline.create({
    assetId: asset.id,
    pipelineName: 'transcode',
    steps: ['transcode']
  });
  // Move the transcode step to running so findRunningByAssetAndStep matches.
  const steps = execution.steps.map((s) => ({ ...s, status: 'running' as const }));
  await pipeline.update(execution.id, { steps });

  return { jobs, assets, pipeline, assetId: asset.id, jobId: job.id, executionId: execution.id, internalId };
}

describe('reconcileFailedTranscodes', () => {
  it('drives a FAILED Encore job to failed: job failed + asset out of processing + pipeline lock released', async () => {
    const { jobs, assets, pipeline, assetId, jobId, executionId, internalId } =
      await stuckTranscode();
    const calls: string[] = [];

    const result = await reconcileFailedTranscodes({
      jobs,
      assets,
      pipeline,
      encore: fakeEncore({ [internalId]: 'failed' }, calls)
    });

    // Polled Encore by the recorded internal id.
    expect(calls).toEqual([internalId]);
    expect(result).toEqual({ scanned: 1, failed: 1 });

    // Job settled to failed with an error surfaced (no longer null/running).
    const job = await jobs.get(jobId);
    expect(job?.status).toBe('failed');
    expect(job?.error).toBeTruthy();

    // Source asset moved out of `processing`.
    const asset = await assets.get(assetId);
    expect(asset?.status).toBe('failed');

    // Pipeline lock released: the running transcode step is failed and the
    // execution is no longer RUNNING.
    const execution = await pipeline.get(executionId);
    expect(execution?.status).toBe('failed');
    const transcodeStep = execution?.steps.find((s) => s.name === 'transcode');
    expect(transcodeStep?.status).toBe('failed');
    expect(transcodeStep?.error).toBeTruthy();
  });

  it('bounded timeout: a 404/undefined job past the stall timeout is failed', async () => {
    const { jobs, assets, pipeline, assetId, jobId, internalId } = await stuckTranscode();

    // Encore has garbage-collected the job -> getJobStatus returns undefined.
    // Freeze "now" far beyond the job's updatedAt so the bounded timeout fires.
    const base = Date.parse((await jobs.get(jobId))!.updatedAt);

    const result = await reconcileFailedTranscodes({
      jobs,
      assets,
      pipeline,
      encore: fakeEncore({ [internalId]: undefined }),
      now: () => base + DEFAULT_STALL_TIMEOUT_MS + 1
    });

    expect(result).toEqual({ scanned: 1, failed: 1 });
    expect((await jobs.get(jobId))?.status).toBe('failed');
    expect((await assets.get(assetId))?.status).toBe('failed');
  });

  it('bounded timeout: a 404/undefined job within the stall window is left running', async () => {
    const { jobs, assets, pipeline, assetId, jobId, internalId } = await stuckTranscode();

    const base = Date.parse((await jobs.get(jobId))!.updatedAt);

    const result = await reconcileFailedTranscodes({
      jobs,
      assets,
      pipeline,
      encore: fakeEncore({ [internalId]: undefined }),
      // Only a moment has passed — a transient 404 must not fail the job.
      now: () => base + 1_000
    });

    expect(result).toEqual({ scanned: 1, failed: 0 });
    expect((await jobs.get(jobId))?.status).toBe('running');
    expect((await assets.get(assetId))?.status).toBe('processing');
  });

  it('leaves a still-running Encore job untouched', async () => {
    const { jobs, assets, pipeline, jobId, assetId, internalId } = await stuckTranscode();

    const result = await reconcileFailedTranscodes({
      jobs,
      assets,
      pipeline,
      encore: fakeEncore({ [internalId]: 'running' })
    });

    expect(result).toEqual({ scanned: 1, failed: 0 });
    expect((await jobs.get(jobId))?.status).toBe('running');
    expect((await assets.get(assetId))?.status).toBe('processing');
  });

  it('skips jobs with no recorded Encore internal id (pre-dispatch)', async () => {
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip', objectKey: 'src/clip.mov' });
    const job = await jobs.create({ type: 'transcode', assetId: asset.id });
    await jobs.update(job.id, { status: 'queued' });

    const calls: string[] = [];
    const result = await reconcileFailedTranscodes({
      jobs,
      assets,
      encore: fakeEncore({}, calls)
    });

    // Never polled Encore; nothing to reconcile without an internal id.
    expect(calls).toEqual([]);
    expect(result).toEqual({ scanned: 0, failed: 0 });
    expect((await jobs.get(job.id))?.status).toBe('queued');
  });

  it('ignores terminal and non-transcode jobs', async () => {
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip', objectKey: 'src/clip.mov' });

    // A terminal transcode job (already done).
    const done = await jobs.create({ type: 'transcode', assetId: asset.id });
    await jobs.update(done.id, { status: 'running', encoreInternalJobId: 'enc-done' });
    await jobs.update(done.id, { status: 'done' });

    // A non-terminal ingest job — not our concern.
    const ingest = await jobs.create({ type: 'ingest-url', assetId: asset.id, sourceUrl: 'https://x/y' });
    await jobs.update(ingest.id, { status: 'running' });

    const calls: string[] = [];
    const result = await reconcileFailedTranscodes({
      jobs,
      assets,
      encore: fakeEncore({ 'enc-done': 'failed' }, calls)
    });

    expect(calls).toEqual([]);
    expect(result).toEqual({ scanned: 0, failed: 0 });
    // Job stays done, not re-failed.
    expect((await jobs.get(done.id))?.status).toBe('done');
  });

  it('works without a pipeline repository (bare transcode, no execution)', async () => {
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip', objectKey: 'src/clip.mov' });
    await assets.update(asset.id, { status: 'processing' });
    const job = await jobs.create({ type: 'transcode', assetId: asset.id });
    await jobs.update(job.id, { status: 'running', encoreInternalJobId: 'enc-bare' });

    const result = await reconcileFailedTranscodes({
      jobs,
      assets,
      encore: fakeEncore({ 'enc-bare': 'failed' })
    });

    expect(result).toEqual({ scanned: 1, failed: 1 });
    expect((await jobs.get(job.id))?.status).toBe('failed');
    expect((await assets.get(asset.id))?.status).toBe('failed');
  });

  // #746: on a GENUINE terminal settle (reason 'encore-error') the job is
  // cancelled/drained on Encore so no orphaned Encore job keeps running and no
  // buffered scaler-queue duplicate survives to be re-dispatched. The guard at
  // failed-transcode-reconciler.ts:237 fires only when job.encoreJobId is set —
  // the other tests set only encoreInternalJobId, so this path was unexercised.
  it('terminal encore-error settle cancels+drains on Encore when encoreJobId is set (#746)', async () => {
    const { jobs, assets, pipeline, jobId, assetId, executionId } =
      await stuckTranscode({ encoreJobId: 'ext-cancel-1' });
    const { encore, cancels } = cancelSpyEncore();

    const job = (await jobs.get(jobId))!;
    await settleFailedTranscode(
      { jobs, assets, pipeline, encore },
      job,
      'transcode failed on Encore',
      'encore-error'
    );

    // The cancel/drain was invoked with our externalId (the scaler's key).
    expect(cancels).toEqual(['ext-cancel-1']);

    // ...and the terminal settle itself still applied (job failed, asset out of
    // processing, pipeline lock released).
    expect((await jobs.get(jobId))?.status).toBe('failed');
    expect((await assets.get(assetId))?.status).toBe('failed');
    expect((await pipeline.get(executionId))?.status).toBe('failed');
  });

  // #746/#709: a CONDITIONAL 'gone-from-active-set' drop must NOT cancel on
  // Encore, because a late SUCCESSFUL callback may still correct the job to
  // `done`. The settle applies (droppedByScaler) but the cancel guard's
  // reason === 'encore-error' clause holds it back even though encoreJobId is set.
  it('conditional gone-from-active-set drop does NOT cancel on Encore (#746/#709)', async () => {
    const { jobs, assets, pipeline, jobId } =
      await stuckTranscode({ encoreJobId: 'ext-cancel-2' });
    const { encore, cancels } = cancelSpyEncore();

    const job = (await jobs.get(jobId))!;
    await settleFailedTranscode(
      { jobs, assets, pipeline, encore },
      job,
      'job vanished from Encore active set',
      'gone-from-active-set'
    );

    // The settle applied (the job is now failed/dropped)...
    expect((await jobs.get(jobId))?.status).toBe('failed');
    // ...but no Encore cancel/drain was issued for a conditional drop.
    expect(cancels).toEqual([]);
  });
});

// Wait for a fire-and-forget delivery to land. dispatchTranscodeCompletionEvents
// detaches every dispatch (`void dispatcher.dispatch(...)`,
// transcode-completion-events.ts:151) so settleFailedTranscode returns before the
// HTTP POSTs settle.
async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('waitFor: predicate never became true');
}

// #829: webhook dispatch on the THIRD terminal-state path — settleFailedTranscode.
//
// Webhook delivery used to depend on WHICH code path applied a job's terminal
// state. #829 fixed two of them (the HTTP encode-completion callback route and
// the completion poller); this module is the third, and it is the one where the
// defect survived the first fix on that same PR. It is also the ONLY path that
// can observe the two failures neither other path ever sees: the #273 stall
// sweep (Encore reports `failed`, or its record vanished past the bounded
// timeout) and the scaler's #449 `onJobsDropped` settle (the job vanished from
// Encore's live QUEUED/IN_PROGRESS set). Both drive the caller-facing Job to
// `failed` and the source asset to `failed`, so a subscriber to
// `transcode.failed` / `asset.failed` that is told nothing here gets exactly the
// silence #829 reports.
//
// These tests exist to enforce the convention the fix chose over a structural
// one: transcode-completion-events.ts:3-9 instructs implementers that every
// `completeTranscode` call MUST be paired with a dispatch. A convention is held
// up by review and tests; deleting the pairing at
// failed-transcode-reconciler.ts:258 must fail here.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Event-type vocabulary WEBHOOK_EVENT_TYPES — src/data/webhook-repo.ts:28-36;
//     the same enum POST /api/v1/webhooks validates against
//     (createBodySchema.events — src/routes/webhooks.ts:40).
//   - Delivery envelope { event, payload, timestamp } and the injectable
//     `fetchImpl` — WebhookDispatcher.deliver/post,
//     src/services/webhook-dispatcher.ts:84-89, :37-45.
//   - Payload shapes at a transcode terminal state — dispatchTranscodeCompletionEvents,
//     src/pipeline/transcode-completion-events.ts:145-177, the SAME function
//     src/routes/internal.ts and src/pipeline/encore-callback-poller.ts call.
//   - settleFailedTranscode(deps, job, error, reason) + SettleReason —
//     src/pipeline/failed-transcode-reconciler.ts:186, :204-209.
//   - completeTranscode / CompleteTranscodeParams.conditionalDrop and the #709
//     conditional-drop correction (`isConditionalDropFailed`) —
//     src/pipeline/transcode.ts:185-200, :245-261, :303-313.
//   - InMemoryWebhookRepository.create(CreateWebhookInput) —
//     src/data/inmemory-webhook-repo.ts:20.
describe('settleFailedTranscode — webhook dispatch on the reconciler path (#829)', () => {
  // A real WebhookDispatcher over the in-memory registration repo, subscribed to
  // every event type the API accepts, with an injected fetch stub that records
  // the delivered { event, payload } envelopes. Same harness the poller-path
  // tests use, so a payload difference between the two paths shows up as a
  // difference between two identically-shaped assertions.
  async function makeDispatcher(): Promise<{
    dispatcher: WebhookDispatcher;
    delivered: { event: string; payload: any }[];
  }> {
    const repo = new InMemoryWebhookRepository();
    await repo.create({ url: 'https://hook.example/webhook', events: [...WEBHOOK_EVENT_TYPES] });
    const delivered: { event: string; payload: any }[] = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { event: string; payload: unknown };
      delivered.push({ event: body.event, payload: body.payload });
      return { ok: true, status: 200 } as Response;
    };
    return {
      dispatcher: new WebhookDispatcher({
        repository: repo,
        fetchImpl: fetchImpl as unknown as typeof fetch
      }),
      delivered
    };
  }

  // The #273 stall sweep's genuine terminal failure: Encore reported `failed`,
  // or its record vanished past the bounded timeout. Unconditional settle.
  it('dispatches transcode.failed and asset.failed on an encore-error settle', async () => {
    const { jobs, assets, pipeline, jobId, assetId } = await stuckTranscode();
    const { dispatcher, delivered } = await makeDispatcher();
    const error = 'transcode failed on Encore';

    const job = (await jobs.get(jobId))!;
    await settleFailedTranscode(
      { jobs, assets, pipeline, webhookDispatcher: dispatcher },
      job,
      error,
      'encore-error'
    );
    await waitFor(() => delivered.some((d) => d.event === 'asset.failed'));

    const events = delivered.map((d) => d.event);
    expect(events).toContain('transcode.failed');
    expect(events).toContain('asset.failed');
    // A failure must never emit the success trio.
    expect(events).not.toContain('transcode.complete');
    expect(events).not.toContain('asset.ready');
    expect(events).not.toContain(ENCODE_COMPLETION_EVENT_TYPE);

    // Payload parity with the callback route and the poller: { assetId, error }.
    for (const type of ['transcode.failed', 'asset.failed']) {
      expect(delivered.find((d) => d.event === type)!.payload).toEqual({ assetId, error });
    }

    // ...and the state the subscriber was told about is the state the API reports.
    expect((await jobs.get(jobId))?.status).toBe('failed');
    expect((await assets.get(assetId))?.status).toBe('failed');
  });

  // The scaler's #449 drop settle. Deliberately emits too, even though the
  // `failed` state is CONDITIONAL (#709): staying silent would reintroduce #829
  // for the common case where the drop is genuine and no late callback arrives.
  // This test pins that decision — a later change gating emission to
  // 'encore-error' has to argue with it.
  it('dispatches on a conditional gone-from-active-set settle too', async () => {
    const { jobs, assets, pipeline, jobId, assetId } = await stuckTranscode();
    const { dispatcher, delivered } = await makeDispatcher();
    const error = 'job vanished from Encore active set';

    const job = (await jobs.get(jobId))!;
    await settleFailedTranscode(
      { jobs, assets, pipeline, webhookDispatcher: dispatcher },
      job,
      error,
      'gone-from-active-set'
    );
    await waitFor(() => delivered.some((d) => d.event === 'asset.failed'));

    expect(delivered.map((d) => d.event).sort()).toEqual(['asset.failed', 'transcode.failed']);
    for (const type of ['transcode.failed', 'asset.failed']) {
      expect(delivered.find((d) => d.event === type)!.payload).toEqual({ assetId, error });
    }
    // The settle really was the conditional kind.
    expect((await jobs.get(jobId))?.droppedByScaler).toBe(true);
  });

  // Idempotency: the sweep re-observing a job another path already settled runs
  // the same code, but completeTranscode no-ops (applied === false), so nothing
  // may be re-delivered.
  it('dispatches nothing when the settle no-ops on an already-terminal job', async () => {
    const { jobs, assets, pipeline, jobId, assetId } = await stuckTranscode();
    const { dispatcher, delivered } = await makeDispatcher();

    // Another path got there first.
    await jobs.update(jobId, { status: 'failed', error: 'settled elsewhere' });
    const job = (await jobs.get(jobId))!;

    await settleFailedTranscode(
      { jobs, assets, pipeline, webhookDispatcher: dispatcher },
      job,
      'transcode failed on Encore',
      'encore-error'
    );
    // Give any (erroneous) detached delivery a chance to land before asserting.
    await new Promise((r) => setTimeout(r, 50));

    expect(delivered).toEqual([]);
    // The winning path's terminal write is untouched, and the no-op left the
    // asset alone (the pipeline-lock release is gated on result.applied too).
    expect((await jobs.get(jobId))?.error).toBe('settled elsewhere');
    expect((await assets.get(assetId))?.status).toBe('processing');
  });

  // Webhooks are optional (`webhookDispatcher` is an optional dep, absent on a
  // deployment with webhooks disabled). The settle must be unchanged and must
  // not throw.
  it('settles normally when no dispatcher is wired (webhooks disabled)', async () => {
    const { jobs, assets, pipeline, jobId, assetId, executionId } = await stuckTranscode();

    const job = (await jobs.get(jobId))!;
    await expect(
      settleFailedTranscode({ jobs, assets, pipeline }, job, 'transcode failed on Encore')
    ).resolves.toBeUndefined();

    expect((await jobs.get(jobId))?.status).toBe('failed');
    expect((await assets.get(assetId))?.status).toBe('failed');
    expect((await pipeline.get(executionId))?.status).toBe('failed');
  });

  // #709 reversed drop, end to end: the conditional settle emits the failure
  // pair, and when the late SUCCESSFUL callback corrects the job (the one
  // documented exception to first-terminal-write-wins) the subscriber is told
  // about that too. This is what makes emitting on the conditional path safe —
  // the correction is structurally guaranteed to be delivered, because both
  // paths that can carry that callback dispatch through the same helper.
  it('reversed drop: transcode.failed is followed by transcode.complete when a late success corrects it', async () => {
    const { jobs, assets, jobId, assetId } = await stuckTranscode();
    const { dispatcher, delivered } = await makeDispatcher();

    const job = (await jobs.get(jobId))!;
    await settleFailedTranscode(
      { jobs, assets, webhookDispatcher: dispatcher },
      job,
      'job vanished from Encore active set',
      'gone-from-active-set'
    );
    await waitFor(() => delivered.length === 2);
    expect(delivered.map((d) => d.event)).toEqual(['transcode.failed', 'asset.failed']);

    // The late SUCCESSFUL callback, applied exactly as the callback route and
    // the poller apply it: completeTranscode + the paired dispatch.
    const dropped = (await jobs.get(jobId))!;
    const result = await completeTranscode(
      {
        jobId,
        sourceAssetId: assetId,
        success: true,
        renditions: [
          { label: '1080p', width: 1920, height: 1080, objectKey: 'out/1080p.mp4', codec: 'h264' }
        ]
      },
      { jobs, assets }
    );
    expect(result.applied).toBe(true);
    dispatchTranscodeCompletionEvents({ dispatcher, job: dropped, success: true, result });
    await waitFor(() => delivered.length === 5);

    // Failure pair first, then the success trio — mirroring the job/asset states
    // GET /api/v1/jobs/:id reported at each moment.
    expect(delivered.slice(0, 2).map((d) => d.event)).toEqual(['transcode.failed', 'asset.failed']);
    expect(delivered.slice(2).map((d) => d.event).sort()).toEqual(
      ['asset.ready', 'transcode.complete', ENCODE_COMPLETION_EVENT_TYPE].sort()
    );
    expect(delivered.find((d) => d.event === 'transcode.complete')!.payload).toEqual({
      assetId,
      renditionCount: 1
    });
    expect((await jobs.get(jobId))?.status).toBe('done');
    expect((await assets.get(assetId))?.status).toBe('ready');

    // A redelivered FAILED settle after the correction must no-op, not flap the
    // job back — and must therefore deliver nothing further.
    await settleFailedTranscode(
      { jobs, assets, webhookDispatcher: dispatcher },
      dropped,
      'job vanished from Encore active set',
      'gone-from-active-set'
    );
    await new Promise((r) => setTimeout(r, 50));
    expect(delivered).toHaveLength(5);
    expect((await jobs.get(jobId))?.status).toBe('done');
  });
});
