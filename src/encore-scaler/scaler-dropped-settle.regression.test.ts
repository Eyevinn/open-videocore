// Regression coverage for scaler-managed jobs silently dropped by Encore
// (issue #452). This is the END-TO-END complement to #449's unit test in
// reconcile-dropped-jobs.test.ts.
//
// #449's existing reconcile-dropped-jobs.test.ts stops at the scaler boundary:
// it asserts reconcile() raises onJobsDropped with the right ids and rewrites
// the stale Valkey `running` flag to FAILED. It uses a bare callback that only
// collects ids and never touches a Job/Asset/PipelineExecution repository.
//
// This file closes the remaining gaps #452 calls out that #449 does NOT cover:
//   1. The full settle path: wire reconcile()'s onJobsDropped to the SAME
//      settleFailedTranscode() the #273 sweep and main.ts use, and assert a
//      scaler-managed job whose Valkey flag is stuck at `running` actually
//      settles to `failed` (Job + source Asset + PipelineExecution lock) — i.e.
//      the getJobStatus()-would-report-running path is driven terminal.
//   2. The static-instance makeHttpEncoreClient path is unaffected by the
//      scaler dropped-job machinery.
//   3. The instance-scaled-down case: the whole instance is gone from Encore's
//      active set (actual=0) so no live endpoint remains — the job must not be
//      left stuck.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - EncoreScalerLoop.reconcile() + onJobsDropped raise — src/encore-scaler/
//     scaler-loop.ts:189-329 (dropped diff at :266-291; raise at :318-328).
//   - onJobsDropped signature (drops: DroppedJob[]) => Promise<void>, where
//     DroppedJob = { encoreJobId, reason? } — reason carries Encore's own FAILED
//     `message` when recoverable (#704) — src/encore-scaler/types.ts DroppedJob.
//   - Valkey key schema keys.pool / keys.jobInstance / keys.jobStatus —
//     src/encore-scaler/types.ts:124-128.
//   - Encore findByStatus HATEOAS page { _embedded: { encoreJobs: [{ externalId
//     }] }, page: { totalElements } } — scaler-loop.ts:238-241, verified against
//     encore-callback-poller.ts:505-508 (SVT Encore, 2026-07-07).
//   - settleFailedTranscode(deps, job, error) + SettleFailedDeps (jobs, assets,
//     pipeline, logger) — src/pipeline/failed-transcode-reconciler.ts:151-201.
//   - InMemoryJobRepository.findByEncoreJobId matches on job.encoreJobId —
//     src/data/job-repo.ts:372-381; create() accepts encoreJobId —
//     src/data/job-repo.ts:322-341.
//   - makeHttpEncoreClient({ baseUrl, getToken, fetch }).getJobStatus GET
//     {baseUrl}/encoreJobs/{id}; 404 -> undefined; body.status normalized —
//     src/pipeline/encore-client.ts:109-124.
//   - EncoreInstanceRecord { instanceId, url, activeJobs, lastIdleAt } —
//     types.ts:93-101.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EncoreScalerLoop } from './scaler-loop.js';
import {
  keys,
  type DroppedJob,
  type EncoreScalerConfig,
  type EncoreInstanceRecord
} from './types.js';
import { InMemoryJobRepository } from '../data/job-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryPipelineRepository } from '../data/pipeline-repo.js';
import { settleFailedTranscode } from '../pipeline/failed-transcode-reconciler.js';
import { makeHttpEncoreClient } from '../pipeline/encore-client.js';

// In-memory stand-in for the subset of the ioredis surface reconcile() uses
// (hgetall / hset / hget). Mirrors reconcile-dropped-jobs.test.ts's FakeRedis so
// both files exercise reconcile() identically without an OSC/Valkey dependency.
class FakeRedis {
  private hashes = new Map<string, Map<string, string>>();

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hash(key));
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    this.hash(key).set(field, value);
    return 1;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hash(key).get(field) ?? null;
  }
}

function makeConfig(
  redis: FakeRedis,
  onJobsDropped?: (drops: DroppedJob[]) => Promise<void>
): EncoreScalerConfig {
  return {
    workspaceId: 'ws1',
    maxInstances: 2,
    idleTimeoutMs: 300_000,
    redisUrl: 'redis://fake',
    // OSC-typed fields are unused by reconcile(); cast to satisfy the type.
    oscContext: {} as EncoreScalerConfig['oscContext'],
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => 'test-token',
    onJobsDropped
  };
}

// Build an Encore findByStatus HATEOAS page for a set of externalIds.
function encorePage(externalIds: string[]): Response {
  return {
    ok: true,
    json: async () => ({
      _embedded: { encoreJobs: externalIds.map((externalId) => ({ externalId })) },
      page: { totalElements: externalIds.length }
    })
  } as unknown as Response;
}

// Build an Encore FAILED findByStatus page carrying each job's `message` (#704).
function encoreFailedPage(jobs: Array<{ externalId: string; message?: string }>): Response {
  return {
    ok: true,
    json: async () => ({
      _embedded: { encoreJobs: jobs },
      page: { totalElements: jobs.length }
    })
  } as unknown as Response;
}

// Route a findByStatus URL to the QUEUED / IN_PROGRESS externalId lists and the
// FAILED documents (#704 failure-reason recovery). `failed` defaults to empty —
// the genuine gone-from-active-set case where Encore reports no cause.
function fetchMock(
  queued: string[],
  inProgress: string[],
  failed: Array<{ externalId: string; message?: string }> = []
) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('status=QUEUED')) return encorePage(queued);
    if (url.includes('status=IN_PROGRESS')) return encorePage(inProgress);
    if (url.includes('status=FAILED')) return encoreFailedPage(failed);
    throw new Error(`unexpected fetch: ${url}`);
  });
}

async function seedPool(redis: FakeRedis, record: EncoreInstanceRecord): Promise<void> {
  await redis.hset(keys.pool('ws1'), record.instanceId, JSON.stringify(record));
}

// Stand up a stuck scaler-managed transcode: a `running` Job whose source Asset
// is `processing` and whose PipelineExecution has a running `transcode` step —
// exactly the shape that would sit forever if the dropped job never settled. The
// Job's encoreJobId is the scaler externalId so findByEncoreJobId links the
// dropped signal (raised by reconcile) back to this Job.
async function stuckScalerJob(externalId: string) {
  const jobs = new InMemoryJobRepository();
  const assets = new InMemoryAssetRepository();
  const pipeline = new InMemoryPipelineRepository();

  const asset = await assets.create({ name: 'clip', objectKey: 'src/clip.mov' });
  await assets.update(asset.id, { status: 'processing' });

  const job = await jobs.create({
    type: 'transcode',
    assetId: asset.id,
    profile: 'program-x265',
    // The scaler correlates on externalId; makeScalingEncoreClient records this
    // same value as the job's encore internal id (encore-scaler/index.ts:33).
    encoreJobId: externalId
  });
  await jobs.update(job.id, { status: 'running', encoreInternalJobId: externalId });

  const execution = await pipeline.create({
    assetId: asset.id,
    pipelineName: 'transcode',
    steps: ['transcode']
  });
  const steps = execution.steps.map((s) => ({ ...s, status: 'running' as const }));
  await pipeline.update(execution.id, { steps });

  return { jobs, assets, pipeline, assetId: asset.id, jobId: job.id, executionId: execution.id };
}

describe('scaler dropped-job end-to-end settle (issue #452)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('settles a scaler-managed job stuck `running` to failed through settleFailedTranscode', async () => {
    // GAP vs #449: #449 asserts only that reconcile raises the id and rewrites
    // the Valkey flag. Here we run reconcile()'s raised ids through the REAL
    // settle path (main.ts wiring) and assert the durable Job/Asset/Pipeline
    // records reach terminal `failed` — the behaviour getJobStatus() stuck at
    // `running` used to prevent.
    const externalId = 'ws1__job-dropped';
    const { jobs, assets, pipeline, assetId, jobId, executionId } =
      await stuckScalerJob(externalId);

    const redis = new FakeRedis();
    const instanceId = 'inst-1';
    // Instance tracks 2 jobs; Encore now reports only job-live active — the
    // scaler-managed externalId has silently vanished (tracked=2 actual=1).
    await seedPool(redis, {
      instanceId,
      url: 'https://encore.example',
      activeJobs: 2,
      lastIdleAt: 0
    });
    await redis.hset(keys.jobInstance('ws1'), 'ws1__job-live', instanceId);
    await redis.hset(keys.jobInstance('ws1'), externalId, instanceId);
    await redis.hset(keys.jobStatus('ws1'), 'ws1__job-live', 'running');
    // The stuck flag getJobStatus() would keep reporting `running` for.
    await redis.hset(keys.jobStatus('ws1'), externalId, 'running');

    // #704: Encore reports the dropped job FAILED WITH its real error text. The
    // job vanished from the active (QUEUED/IN_PROGRESS) set but its cause is on
    // the FAILED encoreJob document's `message`.
    const realCause =
      'Job execution failed: Could not find location for profile program! Profiles: {}';
    vi.stubGlobal(
      'fetch',
      fetchMock([], ['ws1__job-live'], [{ externalId, message: realCause }])
    );

    // Wire onJobsDropped exactly as main.ts does: resolve each dropped id to its
    // Job and route it through the shared idempotent settleFailedTranscode,
    // surfacing Encore's own reason when present (#704).
    const config = makeConfig(redis, async (drops) => {
      for (const { encoreJobId, reason } of drops) {
        const found = await jobs.findByEncoreJobId(encoreJobId);
        if (!found) continue;
        const failureText =
          reason && reason.trim().length > 0
            ? `dropped by Encore: ${reason}`
            : 'dropped by Encore: gone from active set with no completion';
        await settleFailedTranscode({ jobs, assets, pipeline }, found.job, failureText);
      }
    });

    await new EncoreScalerLoop(config).reconcile();

    // Job driven terminal — no longer stuck `running`.
    const settledJob = await jobs.get(jobId);
    expect(settledJob?.status).toBe('failed');
    expect(settledJob?.error).toBeTruthy();
    // #704: the durable failure carries Encore's OWN cause, not the generic
    // wrapper — a user can distinguish a config problem from a platform one.
    expect(settledJob?.error).toContain(realCause);
    expect(settledJob?.error).not.toBe(
      'dropped by Encore: gone from active set with no completion'
    );

    // Source asset moved out of `processing`.
    expect((await assets.get(assetId))?.status).toBe('failed');

    // Pipeline lock released so a new transcode can be submitted.
    const execution = await pipeline.get(executionId);
    expect(execution?.status).toBe('failed');
    expect(execution?.steps.find((s) => s.name === 'transcode')?.status).toBe('failed');

    // The still-live job is untouched by the dropped-job settle.
    const liveJob = await jobs.findByEncoreJobId('ws1__job-live');
    expect(liveJob).toBeUndefined(); // never created a Job for it — nothing settled
    expect(await redis.hget(keys.jobStatus('ws1'), 'ws1__job-live')).toBe('running');
  });

  it('scaled-down instance (actual=0, no live endpoint) still settles its stuck job', async () => {
    // #452 explicitly: "Cover the instance-scaled-down case so no live endpoint
    // does not leave the job stuck." Here Encore reports the instance holds ZERO
    // active jobs — the whole instance was scaled down mid-flight — yet the
    // scaler-managed job is still locally `running`. It must settle to failed.
    const externalId = 'ws1__job-on-scaled-down';
    const { jobs, assets, assetId, jobId } = await stuckScalerJob(externalId);

    const redis = new FakeRedis();
    const instanceId = 'inst-gone';
    await seedPool(redis, {
      instanceId,
      url: 'https://encore.example',
      activeJobs: 1,
      lastIdleAt: 0
    });
    await redis.hset(keys.jobInstance('ws1'), externalId, instanceId);
    await redis.hset(keys.jobStatus('ws1'), externalId, 'running');

    // Encore reports no active jobs at all for this instance (actual=0) and no
    // FAILED document either — the genuine gone-from-active-set case (#704): the
    // whole instance was scaled down mid-flight, so Encore reports no cause.
    vi.stubGlobal('fetch', fetchMock([], [], []));

    const dropped: DroppedJob[] = [];
    const config = makeConfig(redis, async (drops) => {
      dropped.push(...drops);
      for (const { encoreJobId, reason } of drops) {
        const found = await jobs.findByEncoreJobId(encoreJobId);
        if (!found) continue;
        const failureText =
          reason && reason.trim().length > 0
            ? `dropped by Encore: ${reason}`
            : 'dropped by Encore: gone from active set with no completion';
        await settleFailedTranscode({ jobs, assets }, found.job, failureText);
      }
    });

    await new EncoreScalerLoop(config).reconcile();

    // #704: no Encore-reported cause -> reason undefined, generic wording reserved.
    expect(dropped).toEqual([{ encoreJobId: externalId, reason: undefined }]);
    expect((await jobs.get(jobId))?.error).toBe(
      'dropped by Encore: gone from active set with no completion'
    );
    // Stale Valkey flag rewritten so a later getJobStatus() won't say running.
    expect(await redis.hget(keys.jobStatus('ws1'), externalId)).toBe('FAILED');
    // Durable records settled terminal — the job is not left stuck.
    expect((await jobs.get(jobId))?.status).toBe('failed');
    expect((await assets.get(assetId))?.status).toBe('failed');
  });

  it('static makeHttpEncoreClient path is unaffected by the scaler dropped-job machinery', async () => {
    // #452: "Assert the static-instance makeHttpEncoreClient path is
    // unaffected." The static client speaks directly to one Encore instance and
    // has no dropped-job/reconcile logic. A 404 (Encore GC'd the record) still
    // returns undefined — the #273 sweep, not the scaler, owns that timeout — and
    // a live IN_PROGRESS still normalizes to `running`. Neither path is perturbed
    // by the scaler machinery living in a sibling module.
    const doFetch = vi.fn(async (input: unknown) => {
      const url = String(input);
      if (url.endsWith('/encoreJobs/gone')) {
        return { ok: false, status: 404, async json() { return {}; } } as unknown as Response;
      }
      if (url.endsWith('/encoreJobs/live')) {
        return {
          ok: true,
          status: 200,
          async json() {
            return { status: 'IN_PROGRESS' };
          }
        } as unknown as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });

    const client = makeHttpEncoreClient({
      baseUrl: 'https://static-encore.example/',
      getToken: async () => 'sat',
      fetch: doFetch as unknown as typeof globalThis.fetch
    });

    // 404 -> undefined (caller/#273 sweep applies the bounded timeout; the
    // scaler never touches this path).
    expect(await client.getJobStatus('gone')).toBeUndefined();
    // Live job normalizes to running, unchanged.
    expect(await client.getJobStatus('live')).toBe('running');
    // The static client hit only its own instance URL — no findByStatus /
    // dropped-job reconcile calls leaked in.
    for (const call of doFetch.mock.calls) {
      expect(String(call[0])).not.toContain('findByStatus');
    }
  });
});
