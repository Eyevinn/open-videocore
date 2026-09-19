// Unit test for reconcile-driven dropped-job detection (issue #449, ADR-016
// Direction 2). Exercises EncoreScalerLoop.reconcile() with an in-memory Valkey
// fake and a mocked global fetch, so it runs with no OSC/Valkey dependency.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - EncoreScalerLoop.reconcile() + onJobsDropped hook — src/encore-scaler/
//     scaler-loop.ts (reconcile at :189; onJobsDropped raise at end).
//   - Valkey key schema: keys.pool / keys.jobInstance / keys.jobStatus —
//     src/encore-scaler/types.ts:114-142.
//   - Encore findByStatus HATEOAS page shape { _embedded: { encoreJobs:
//     [{ externalId }] }, page: { totalElements } } — encore-callback-poller.ts:
//     505-508 (SVT Encore, verified 2026-07-07).
//   - EncoreInstanceRecord { instanceId, url, activeJobs, lastIdleAt } —
//     types.ts:84-92.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EncoreScalerLoop } from './scaler-loop.js';
import {
  keys,
  type DroppedJob,
  type EncoreScalerConfig,
  type EncoreInstanceRecord
} from './types.js';

// Minimal in-memory stand-in for the subset of the ioredis surface reconcile()
// uses: hgetall / hset. Values are stored as string->string hashes.
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
    // These OSC-typed fields are unused by reconcile(); cast to satisfy the type.
    oscContext: {} as EncoreScalerConfig['oscContext'],
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => 'test-token',
    onJobsDropped
  };
}

// Build an Encore findByStatus HATEOAS page response for a set of externalIds.
function encorePage(externalIds: string[]): Response {
  return {
    ok: true,
    json: async () => ({
      _embedded: { encoreJobs: externalIds.map((externalId) => ({ externalId })) },
      page: { totalElements: externalIds.length }
    })
  } as unknown as Response;
}

// Build an Encore FAILED findByStatus page carrying each job's `message` (the
// field that holds Encore's own terminal error text — internal.ts:73-74,
// encoreCallbackSchema:95).
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
// FAILED documents (#704 reason recovery). `failed` defaults to an empty page —
// modelling the genuine gone-from-active-set case where Encore reports no cause.
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

describe('reconcile: dropped-job detection (issue #449)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('raises onJobsDropped for a tracked-running job Encore no longer lists', async () => {
    const redis = new FakeRedis();
    const instanceId = 'inst-1';

    // Instance tracks 2 active jobs; Encore now reports only job-live active.
    await seedPool(redis, {
      instanceId,
      url: 'https://encore.example',
      activeJobs: 2,
      lastIdleAt: 0
    });
    await redis.hset(keys.jobInstance('ws1'), 'job-live', instanceId);
    await redis.hset(keys.jobInstance('ws1'), 'job-dropped', instanceId);
    await redis.hset(keys.jobStatus('ws1'), 'job-live', 'running');
    await redis.hset(keys.jobStatus('ws1'), 'job-dropped', 'running');

    vi.stubGlobal('fetch', fetchMock([], ['job-live']));

    const dropped: DroppedJob[] = [];
    const config = makeConfig(redis, async (drops) => {
      dropped.push(...drops);
    });
    const loop = new EncoreScalerLoop(config);
    await loop.reconcile();

    // Only the vanished job is reported.
    expect(dropped).toEqual([{ encoreJobId: 'job-dropped', reason: undefined }]);
    // Its stale Valkey status is overwritten so getJobStatus won't re-report running.
    expect(await redis.hget(keys.jobStatus('ws1'), 'job-dropped')).toBe('FAILED');
    // The still-live job is untouched.
    expect(await redis.hget(keys.jobStatus('ws1'), 'job-live')).toBe('running');
    // activeJobs corrected down to the actual count.
    const rec = JSON.parse((await redis.hget(keys.pool('ws1'), instanceId))!) as EncoreInstanceRecord;
    expect(rec.activeJobs).toBe(1);
  });

  // #704 (a): when Encore reports the dropped job FAILED WITH its own error text,
  // reconcile() recovers that `message` and forwards it as the drop's `reason`,
  // so main.ts can surface the real cause instead of the generic wrapper.
  it('surfaces Encore\'s own failure reason when the dropped job is FAILED with a message', async () => {
    const redis = new FakeRedis();
    const instanceId = 'inst-1';
    const realCause = 'Job execution failed: Could not find location for profile program! Profiles: {}';

    await seedPool(redis, {
      instanceId,
      url: 'https://encore.example',
      activeJobs: 1,
      lastIdleAt: 0
    });
    await redis.hset(keys.jobInstance('ws1'), 'job-dropped', instanceId);
    await redis.hset(keys.jobStatus('ws1'), 'job-dropped', 'running');

    // Encore lists no QUEUED/IN_PROGRESS jobs (job vanished from the active set),
    // but the FAILED page carries the job with its real terminal error text.
    vi.stubGlobal(
      'fetch',
      fetchMock([], [], [{ externalId: 'job-dropped', message: realCause }])
    );

    const dropped: DroppedJob[] = [];
    const config = makeConfig(redis, async (drops) => {
      dropped.push(...drops);
    });
    await new EncoreScalerLoop(config).reconcile();

    expect(dropped).toEqual([{ encoreJobId: 'job-dropped', reason: realCause }]);
  });

  // #704 (b): a genuine gone-from-active-set case — Encore reports no FAILED
  // document (or none with a message) for the dropped job — leaves `reason`
  // undefined so main.ts keeps the generic wording, reserved for exactly this
  // no-reported-cause case.
  it('leaves reason undefined for a genuine gone-from-active-set drop', async () => {
    const redis = new FakeRedis();
    const instanceId = 'inst-1';

    await seedPool(redis, {
      instanceId,
      url: 'https://encore.example',
      activeJobs: 1,
      lastIdleAt: 0
    });
    await redis.hset(keys.jobInstance('ws1'), 'job-dropped', instanceId);
    await redis.hset(keys.jobStatus('ws1'), 'job-dropped', 'running');

    // No QUEUED/IN_PROGRESS jobs AND an empty FAILED page: Encore stopped
    // reporting the job without any cause.
    vi.stubGlobal('fetch', fetchMock([], [], []));

    const dropped: DroppedJob[] = [];
    const config = makeConfig(redis, async (drops) => {
      dropped.push(...drops);
    });
    await new EncoreScalerLoop(config).reconcile();

    expect(dropped).toEqual([{ encoreJobId: 'job-dropped', reason: undefined }]);
  });

  it('does not raise onJobsDropped when every tracked job is still active', async () => {
    const redis = new FakeRedis();
    const instanceId = 'inst-1';
    await seedPool(redis, {
      instanceId,
      url: 'https://encore.example',
      activeJobs: 1,
      lastIdleAt: 0
    });
    await redis.hset(keys.jobInstance('ws1'), 'job-live', instanceId);
    await redis.hset(keys.jobStatus('ws1'), 'job-live', 'running');

    vi.stubGlobal('fetch', fetchMock([], ['job-live']));

    const dropped: DroppedJob[] = [];
    const config = makeConfig(redis, async (drops) => {
      dropped.push(...drops);
    });
    await new EncoreScalerLoop(config).reconcile();

    expect(dropped).toEqual([]);
    expect(await redis.hget(keys.jobStatus('ws1'), 'job-live')).toBe('running');
  });

  it('ignores an already-terminal tracked job (does not re-drop it)', async () => {
    const redis = new FakeRedis();
    const instanceId = 'inst-1';
    await seedPool(redis, {
      instanceId,
      url: 'https://encore.example',
      activeJobs: 1,
      lastIdleAt: 0
    });
    // Job is mapped to the instance but already CANCELLED locally.
    await redis.hset(keys.jobInstance('ws1'), 'job-cancelled', instanceId);
    await redis.hset(keys.jobStatus('ws1'), 'job-cancelled', 'CANCELLED');

    vi.stubGlobal('fetch', fetchMock([], []));

    const dropped: DroppedJob[] = [];
    const config = makeConfig(redis, async (drops) => {
      dropped.push(...drops);
    });
    await new EncoreScalerLoop(config).reconcile();

    expect(dropped).toEqual([]);
    // Terminal status left untouched.
    expect(await redis.hget(keys.jobStatus('ws1'), 'job-cancelled')).toBe('CANCELLED');
  });
});
