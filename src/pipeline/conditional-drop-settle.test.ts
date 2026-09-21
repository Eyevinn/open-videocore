// Reversible / conditional gone-from-active-set drop settle (issue #709).
//
// The scaler's drop-detection path (main.ts onJobsDropped -> settleFailedTranscode
// with reason 'gone-from-active-set') settles a job `failed` when Encore's live
// QUEUED/IN_PROGRESS set no longer lists it and no completion callback arrived
// (ADR-016). That `failed` state is an INFERENCE, not proof the encode failed, so
// #709 makes it CONDITIONAL: the job is stamped `droppedByScaler` so a genuine
// SUCCESSFUL callback arriving out of order can still correct it to `done` and
// resume the pipeline. A genuine Encore-error failure ('encore-error', the
// default reason) stays UNCONDITIONAL and is never overridden.
//
// Cases (mirroring the #709 acceptance criteria):
//   (a) a gone-from-active-set drop settles when no terminal status exists.
//   (b) a drop is SUPPRESSED (no-op) when a SUCCESSFUL terminal status already
//       exists — first-terminal-write-wins for a real success.
//   (c) a SUCCESSFUL callback received AFTER a conditional-drop-fail corrects the
//       job to `done` and triggers downstream pipeline continuation (package).
//   plus: a genuine Encore-error failure is UNCONDITIONAL — a later SUCCESSFUL
//       callback cannot override it (regression guard for the criterion "existing
//       unconditional terminal failures are unaffected").
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - settleFailedTranscode(deps, job, error, reason?) + SettleReason
//     ('encore-error' | 'gone-from-active-set') —
//     src/pipeline/failed-transcode-reconciler.ts:164-201, 156-162.
//   - completeTranscode conditional-drop override + `conditionalDrop` param +
//     `droppedByScaler` clear — src/pipeline/transcode.ts:172-283.
//   - Job.droppedByScaler + ALLOWED_JOB_TRANSITIONS.failed = ['done','running']
//     — src/data/job-repo.ts.
//   - encore-callback-poller drop-failed pipeline re-open on corrective success +
//     startEncoreCallbackPoller/handleMessage — src/pipeline/encore-callback-poller.ts.
//   - encodeEncoreJobId `${workspaceId}__${jobLocalId}`; InMemory*Repository —
//     src/data/*-repo.ts; InMemoryPipelineRepository — src/data/pipeline-repo.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { completeTranscode, type CallbackRendition } from './transcode.js';
import { settleFailedTranscode } from './failed-transcode-reconciler.js';
import { startEncoreCallbackPoller } from './encore-callback-poller.js';
import { InMemoryJobRepository, encodeEncoreJobId } from '../data/job-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryPipelineRepository } from '../data/pipeline-repo.js';
import { keys, type EncoreInstanceRecord } from '../encore-scaler/types.js';

// A `running` transcode job over a `processing` source asset — exactly the state
// a job is in when the scaler's drop detection observes it vanish from Encore's
// live set (before any completion callback).
async function runningScalerJob(externalId: string) {
  const jobs = new InMemoryJobRepository();
  const assets = new InMemoryAssetRepository();
  const pipeline = new InMemoryPipelineRepository();

  const asset = await assets.create({ name: 'clip.mov' });
  await assets.update(asset.id, { status: 'processing' });

  const job = await jobs.create({
    type: 'transcode',
    assetId: asset.id,
    profile: 'program',
    encoreJobId: externalId
  });
  await jobs.update(job.id, { status: 'queued' });
  await jobs.update(job.id, { status: 'running', encoreInternalJobId: externalId });

  return { jobs, assets, pipeline, jobId: job.id, assetId: asset.id };
}

const rendition: CallbackRendition = {
  label: 'rendition-1',
  width: 1920,
  height: 1080,
  objectKey: 'transcode/asset/job/1080.mp4',
  codec: 'h264',
  bitrateBps: 5_000_000
};

describe('#709 conditional gone-from-active-set drop settle', () => {
  // (a) — the drop settles when no terminal status exists yet.
  it('(a) settles a gone-from-active-set drop to failed (conditional) when no terminal status exists', async () => {
    const externalId = 'ws1__job-a';
    const { jobs, assets, pipeline, jobId, assetId } = await runningScalerJob(externalId);

    await settleFailedTranscode(
      { jobs, assets, pipeline },
      (await jobs.get(jobId))!,
      'dropped by Encore: gone from active set with no completion',
      'gone-from-active-set'
    );

    const settled = await jobs.get(jobId);
    expect(settled?.status).toBe('failed');
    expect(settled?.error).toBeTruthy();
    // Marked reversible so a later SUCCESSFUL callback can correct it.
    expect(settled?.droppedByScaler).toBe(true);
    // Source asset moved out of `processing`.
    expect((await assets.get(assetId))?.status).toBe('failed');
  });

  // (b) — the drop is suppressed when a SUCCESSFUL terminal status already exists.
  it('(b) suppresses a gone-from-active-set drop when the job is already SUCCESSFUL (done)', async () => {
    const externalId = 'ws1__job-b';
    const { jobs, assets, jobId, assetId } = await runningScalerJob(externalId);

    // A real SUCCESSFUL callback lands first, settling the job `done`.
    const successResult = await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: [rendition] },
      { jobs, assets }
    );
    expect(successResult.applied).toBe(true);
    expect((await jobs.get(jobId))?.status).toBe('done');

    // A late gone-from-active-set drop must NOT clobber the succeeded job.
    await settleFailedTranscode(
      { jobs, assets },
      (await jobs.get(jobId))!,
      'dropped by Encore: gone from active set with no completion',
      'gone-from-active-set'
    );

    const after = await jobs.get(jobId);
    expect(after?.status).toBe('done'); // unchanged — success wins
    expect(after?.droppedByScaler).toBe(false); // success cleared the marker
    expect((await assets.get(assetId))?.status).toBe('ready'); // asset stayed ready
  });

  // Regression guard for "existing unconditional terminal failures are
  // unaffected": a genuine Encore-error failure is NOT reversible — a later
  // SUCCESSFUL callback cannot override it (first-terminal-write-wins preserved).
  it('does not override a genuine Encore-error failure with a later SUCCESSFUL callback', async () => {
    const externalId = 'ws1__job-err';
    const { jobs, assets, jobId, assetId } = await runningScalerJob(externalId);

    // Genuine Encore-reported failure — default reason 'encore-error', unconditional.
    await settleFailedTranscode(
      { jobs, assets },
      (await jobs.get(jobId))!,
      'transcode failed on Encore'
    );
    const failed = await jobs.get(jobId);
    expect(failed?.status).toBe('failed');
    expect(failed?.droppedByScaler).toBeFalsy(); // NOT marked reversible

    // A later SUCCESSFUL callback must no-op — the real failure stands.
    const override = await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: [rendition] },
      { jobs, assets }
    );
    expect(override.applied).toBe(false);
    expect((await jobs.get(jobId))?.status).toBe('failed');
    expect((await assets.get(assetId))?.status).toBe('failed');
  });

  // completeTranscode-level proof for (c): a SUCCESSFUL callback after a
  // conditional-drop-fail transitions the job failed -> done and clears the marker.
  it('(c) completeTranscode corrects a conditional-drop-failed job to done on a later SUCCESSFUL callback', async () => {
    const externalId = 'ws1__job-c1';
    const { jobs, assets, jobId, assetId } = await runningScalerJob(externalId);

    // Conditional drop settles the job failed + asset failed.
    await completeTranscode(
      { jobId, sourceAssetId: assetId, success: false, error: 'dropped', renditions: [], conditionalDrop: true },
      { jobs, assets }
    );
    expect((await jobs.get(jobId))?.status).toBe('failed');
    expect((await jobs.get(jobId))?.droppedByScaler).toBe(true);
    expect((await assets.get(assetId))?.status).toBe('failed');

    // The genuine SUCCESSFUL callback arrives late and corrects the outcome.
    const corrected = await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: [rendition] },
      { jobs, assets }
    );
    expect(corrected.applied).toBe(true);
    expect(corrected.renditionCount).toBe(1);

    const done = await jobs.get(jobId);
    expect(done?.status).toBe('done');
    expect(done?.droppedByScaler).toBe(false); // marker cleared on real success
    // Source asset recovered to ready with the produced rendition recorded.
    const asset = await assets.get(assetId);
    expect(asset?.status).toBe('ready');
    expect(asset?.renditions).toHaveLength(1);
  });
});

// (c) end-to-end through the real poller: a conditional-drop-fail that also
// released the pipeline lock (transcode step + execution `failed`) is resumed by
// a corrective SUCCESSFUL callback — the poller re-opens the failed transcode
// step and drives the pipeline into its pending `package` step (downstream
// continuation).
describe('#709 (c) poller resumes a drop-failed pipeline on a corrective SUCCESSFUL callback', () => {
  const WORKSPACE = 'ws-e2e';
  const INSTANCE_ID = 'inst-e2e';
  const BASE_URL = 'https://encore-e2e.example';
  const QUEUE_KEY = 'ovc:transcode-done';

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Minimal in-memory Redis covering exactly the commands the poller's
  // handleMessage + packaging pin touch for this scenario.
  class FakeRedis {
    strings = new Map<string, string>();
    hashes = new Map<string, Map<string, string>>();
    zsets = new Map<string, Map<string, number>>();
    sets = new Map<string, Set<string>>();

    private hash(k: string) { let h = this.hashes.get(k); if (!h) { h = new Map(); this.hashes.set(k, h); } return h; }
    private zset(k: string) { let z = this.zsets.get(k); if (!z) { z = new Map(); this.zsets.set(k, z); } return z; }
    private set_(k: string) { let s = this.sets.get(k); if (!s) { s = new Set(); this.sets.set(k, s); } return s; }

    async sadd(k: string, m: string) { const s = this.set_(k); const isNew = !s.has(m); s.add(m); return isNew ? 1 : 0; }
    async srem(k: string, m: string) { return this.set_(k).delete(m) ? 1 : 0; }
    async scard(k: string) { return this.set_(k).size; }
    async pexpire() { return 1; }
    async get(k: string) { return this.strings.get(k) ?? null; }
    async set(k: string, v: string) { this.strings.set(k, v); return 'OK' as const; }
    // #708: the success path SET keys.jobCompletionSeen then DEL's it once the
    // activeJobs decrement lands (encore-callback-poller.ts:614). ioredis del
    // accepts one or more keys and returns the count actually removed across
    // string/hash/zset spaces. Without this the corrective-callback pass threw a
    // TypeError before the pipeline re-open block, so the drop-failed execution
    // never advanced (regressed test (c) after the #708 merge).
    async del(...ks: string[]) {
      let removed = 0;
      for (const k of ks) {
        if (this.strings.delete(k)) removed++;
        if (this.hashes.delete(k)) removed++;
        if (this.zsets.delete(k)) removed++;
      }
      return removed;
    }
    async keys(pattern: string) {
      const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
      return [...this.strings.keys(), ...this.hashes.keys(), ...this.zsets.keys()].filter((x) => re.test(x));
    }
    async hgetall(k: string) { return Object.fromEntries(this.hash(k)); }
    async hget(k: string, f: string) { return this.hash(k).get(f) ?? null; }
    async hset(k: string, f: string, v: string) { this.hash(k).set(f, v); return 1; }
    // #707: the success path hdel's keys.jobInstance (encore-callback-poller.ts:450)
    // so a later reconcile drop-diff can't re-observe the completed job. ioredis
    // hdel accepts one or more fields and returns the count removed.
    async hdel(k: string, ...fs: string[]) { const h = this.hash(k); let removed = 0; for (const f of fs) if (h.delete(f)) removed++; return removed; }
    async zadd(k: string, score: number, m: string) { const z = this.zset(k); const had = z.has(m); z.set(m, score); return had ? 0 : 1; }
    async zscore(k: string, m: string) { const s = this.zset(k).get(m); return s === undefined ? null : String(s); }
    async zrem(k: string, m: string) { return this.zset(k).delete(m) ? 1 : 0; }
    async zrangebyscore(k: string, _min: string, _max: string, withScores?: string) {
      const entries = [...this.zset(k).entries()].sort((a, b) => a[1] - b[1]);
      if (withScores) return entries.flatMap(([m, s]) => [m, String(s)]);
      return entries.map(([m]) => m);
    }
    async bzpopmin(k: string, _t: number): Promise<[string, string, string] | null> {
      const z = this.zset(k);
      if (z.size === 0) { await new Promise((r) => setTimeout(r, 5)); return null; }
      const [m, s] = [...z.entries()].sort((a, b) => a[1] - b[1])[0]!;
      z.delete(m);
      return [k, m, String(s)];
    }
    zmembers(k: string) { return [...this.zset(k).keys()]; }
    duplicate() { return this; }
    on() { return this; }
    disconnect() {}
  }

  it('re-opens the drop-failed transcode step and advances into package on the corrective SUCCESSFUL callback', async () => {
    const redis = new FakeRedis();
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const pipeline = new InMemoryPipelineRepository();

    // Seed a running scaler transcode with a two-step (transcode -> package) pipeline.
    const asset = await assets.create({ name: 'source.mp4' });
    await assets.update(asset.id, { status: 'processing' });
    const job = await jobs.create({ type: 'transcode', assetId: asset.id, profile: 'program' });
    const externalId = encodeEncoreJobId(WORKSPACE, job.id);
    await jobs.update(job.id, { encoreJobId: externalId, status: 'queued' });
    await jobs.update(job.id, { status: 'running', encoreInternalJobId: externalId });

    const encoreUuid = 'uuid-drop-recover';
    const record: EncoreInstanceRecord = { instanceId: INSTANCE_ID, url: BASE_URL, activeJobs: 1, lastIdleAt: Date.now() };
    await redis.hset(keys.pool(WORKSPACE), INSTANCE_ID, JSON.stringify(record));
    await redis.set(keys.uuidToExternalId(encoreUuid), externalId);
    await redis.set(keys.jobEncoreUrl(externalId), `${BASE_URL}/encoreJobs/${encoreUuid}`);
    await redis.hset(keys.jobInstance(WORKSPACE), externalId, INSTANCE_ID);

    const execution = await pipeline.create({
      assetId: asset.id,
      pipelineName: 'transcode',
      steps: ['transcode', 'package']
    });
    const steps = execution.steps.map((s) =>
      s.name === 'transcode'
        ? { ...s, status: 'running' as const, encoreJobId: externalId, jobId: job.id, startedAt: new Date().toISOString() }
        : s
    );
    await pipeline.update(execution.id, { steps, status: 'running' });

    // 1. Gone-from-active-set drop settles the job/asset/pipeline terminal
    //    (conditionally). This is the exact main.ts onJobsDropped wiring.
    await settleFailedTranscode(
      { jobs, assets, pipeline },
      (await jobs.get(job.id))!,
      'dropped by Encore: gone from active set with no completion',
      'gone-from-active-set'
    );
    expect((await jobs.get(job.id))?.status).toBe('failed');
    expect((await jobs.get(job.id))?.droppedByScaler).toBe(true);
    const failedExec = await pipeline.get(execution.id);
    expect(failedExec?.status).toBe('failed');
    expect(failedExec?.steps.find((s) => s.name === 'transcode')?.status).toBe('failed');

    // 2. A genuine SUCCESSFUL Encore callback arrives late. Stub fetch to answer
    //    the job-document GET with SUCCESSFUL + one produced output.
    const fetchFn = vi.fn(async (input: string | URL) => {
      const url = typeof input === 'string' ? input : input.toString();
      const jsonRes = (body: unknown) => ({ ok: true, status: 200, async json() { return body; } }) as unknown as Response;
      if (url.includes('/encoreJobs/')) {
        return jsonRes({
          externalId,
          status: 'SUCCESSFUL',
          output: [{ type: 'VideoFile', file: 'out/1080.mp4', videoStreams: [{ width: 1920, height: 1080 }], overallBitrate: 5_000_000 }]
        });
      }
      return { ok: false, status: 404, async json() { return {}; } } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchFn);

    // Enqueue the callback message directly (the real callback listener enqueues
    // independent of local job state — the drop-detection had marked it failed).
    await redis.zadd(QUEUE_KEY, Date.now(), JSON.stringify({ jobId: encoreUuid, url: `${BASE_URL}/encoreJobs/${encoreUuid}` }));

    const deps = {
      redis: redis as unknown as import('ioredis').Redis,
      jobRepository: jobs,
      assetRepository: assets,
      pipelineRepository: pipeline,
      oscContext: { getServiceAccessToken: async () => 'sat' } as unknown as import('@osaas/client-core').Context,
      queueKey: QUEUE_KEY,
      logger: { info() {}, warn() {}, error() {} }
    };

    const stop = startEncoreCallbackPoller(deps);
    try {
      await waitFor(async () => (await jobs.get(job.id))?.status === 'done');
    } finally {
      stop();
    }

    // Job corrected to done, marker cleared.
    const done = await jobs.get(job.id);
    expect(done?.status).toBe('done');
    expect(done?.droppedByScaler).toBe(false);

    // Source asset recovered to ready with the produced rendition.
    const recoveredAsset = await assets.get(asset.id);
    expect(recoveredAsset?.status).toBe('ready');
    expect(recoveredAsset?.renditions).toHaveLength(1);

    // Downstream continuation: the pipeline re-opened, marked transcode done, and
    // advanced its pending `package` step to running (packaging job enqueued).
    const resumed = await pipeline.get(execution.id);
    expect(resumed?.status).toBe('running');
    expect(resumed?.steps.find((s) => s.name === 'transcode')?.status).toBe('done');
    expect(resumed?.steps.find((s) => s.name === 'package')?.status).toBe('running');
    // The packaging job was enqueued onto the packager input queue (playback path).
    expect(redis.zmembers('encore-packager:jobs').length).toBe(1);
  });

  async function waitFor(pred: () => boolean | Promise<boolean>, timeoutMs = 3000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await pred()) return;
      await new Promise((r) => setTimeout(r, 10));
    }
    throw new Error('waitFor: predicate never became true');
  }
});
