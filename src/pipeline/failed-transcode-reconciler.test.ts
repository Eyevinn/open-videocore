import { describe, it, expect } from 'vitest';

import {
  InMemoryJobRepository,
  type Job
} from '../data/job-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryPipelineRepository } from '../data/pipeline-repo.js';
import type { EncoreClient } from './encore-client.js';
import {
  reconcileFailedTranscodes,
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

// Build a `running` transcode job whose source asset is `processing`, plus a
// running PipelineExecution with a running `transcode` step — i.e. the exact
// stuck shape issue #273 describes. Returns the repos + created records.
async function stuckTranscode(opts?: { encoreInternalJobId?: string }) {
  const jobs = new InMemoryJobRepository();
  const assets = new InMemoryAssetRepository();
  const pipeline = new InMemoryPipelineRepository();

  const asset = await assets.create({ name: 'clip', objectKey: 'src/clip.mov' });
  // uploading -> processing (a transcode is in flight against this asset).
  await assets.update(asset.id, { status: 'processing' });

  const internalId = opts?.encoreInternalJobId ?? 'encore-internal-1';
  const job = await jobs.create({ type: 'transcode', assetId: asset.id, profile: 'program-x265' });
  // pending -> running, with Encore's internal id recorded (as submitTranscode does).
  await jobs.update(job.id, { status: 'running', encoreInternalJobId: internalId });

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
});
