// #728: drop-reason recovery must be OBSERVABLE and must NOT race the teardown it
// triggers. #704/#719 added fetchDroppedFailureReasons() so a drop-detected job
// carries Encore's own terminal `message`; in a live drop it recovered nothing and
// the caller saw the generic gone-from-active-set wording with no way to tell which
// of four branches produced the empty result. These tests pin each branch:
//   - reason recovered and surfaced (unchanged happy path)
//   - fetch not ok            -> generic wording + a `warn` naming the status code
//   - job absent from page    -> generic wording + a `warn` naming the job
//   - job present, empty msg  -> generic wording + a `warn` naming the job
// and confirm the generic wording stays reserved for the genuine no-cause case.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - EncoreScalerLoop.reconcile() + its call to fetchDroppedFailureReasons() and
//     the onJobsDropped raise — src/encore-scaler/scaler-loop.ts (reconcile;
//     fetchDroppedFailureReasons).
//   - DroppedJob { encoreJobId, reason? } + EncoreScalerConfig.onJobsDropped
//     contract (reason undefined == genuine no-reported-cause) —
//     src/encore-scaler/types.ts:39-42, :119-133.
//   - Valkey key schema keys.pool / keys.jobInstance / keys.jobStatus —
//     src/encore-scaler/types.ts:205-210.
//   - Encore findByStatus HATEOAS page shape { _embedded: { encoreJobs:
//     [{ externalId, message? }] }, page: { totalElements } } —
//     scaler-loop.ts fetchRealActiveState + fetchDroppedFailureReasons.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EncoreScalerLoop } from './scaler-loop.js';
import {
  keys,
  type DroppedJob,
  type EncoreScalerConfig,
  type EncoreInstanceRecord
} from './types.js';

// Minimal in-memory stand-in for the subset of the ioredis surface reconcile()
// uses (hgetall / hset / hget), mirroring reconcile-dropped-jobs.test.ts.
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
    oscContext: {} as EncoreScalerConfig['oscContext'],
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => 'test-token',
    onJobsDropped
  };
}

function encorePage(externalIds: string[]): Response {
  return {
    ok: true,
    json: async () => ({
      _embedded: { encoreJobs: externalIds.map((externalId) => ({ externalId })) },
      page: { totalElements: externalIds.length }
    })
  } as unknown as Response;
}

function encoreFailedPage(
  jobs: Array<{ externalId: string; message?: string }>
): Response {
  return {
    ok: true,
    json: async () => ({
      _embedded: { encoreJobs: jobs },
      page: { totalElements: jobs.length }
    })
  } as unknown as Response;
}

// QUEUED/IN_PROGRESS resolve as usual; the FAILED branch is driven by
// `failedResponder` so each test can model ok/not-ok/throw independently.
function fetchMockWithFailed(
  queued: string[],
  inProgress: string[],
  failedResponder: () => Response | Promise<Response>
) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('status=QUEUED')) return encorePage(queued);
    if (url.includes('status=IN_PROGRESS')) return encorePage(inProgress);
    if (url.includes('status=FAILED')) return failedResponder();
    throw new Error(`unexpected fetch: ${url}`);
  });
}

async function seedDrop(redis: FakeRedis, instanceId: string): Promise<void> {
  await redis.hset(
    keys.pool('ws1'),
    instanceId,
    JSON.stringify({
      instanceId,
      url: 'https://encore.example',
      activeJobs: 1,
      lastIdleAt: 0
    } satisfies EncoreInstanceRecord)
  );
  await redis.hset(keys.jobInstance('ws1'), 'job-dropped', instanceId);
  await redis.hset(keys.jobStatus('ws1'), 'job-dropped', 'running');
}

describe('#728: drop-reason recovery observability', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('recovered reason is surfaced and does NOT warn', async () => {
    const redis = new FakeRedis();
    await seedDrop(redis, 'inst-1');
    const realCause =
      'Job execution failed: Could not find location for profile program! Profiles: {}';
    vi.stubGlobal(
      'fetch',
      fetchMockWithFailed([], [], () =>
        encoreFailedPage([{ externalId: 'job-dropped', message: realCause }])
      )
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    ).reconcile();

    expect(dropped).toEqual([{ encoreJobId: 'job-dropped', reason: realCause }]);
    // No drop-reason recovery warning when the reason was recovered.
    const dropReasonWarns = warn.mock.calls.filter((c) =>
      String(c[0]).includes('drop-reason recovery')
    );
    expect(dropReasonWarns).toEqual([]);
  });

  it('fetch not ok -> generic wording + warn naming the status code', async () => {
    const redis = new FakeRedis();
    await seedDrop(redis, 'inst-1');
    vi.stubGlobal(
      'fetch',
      fetchMockWithFailed(
        [],
        [],
        () => ({ ok: false, status: 503, json: async () => ({}) }) as unknown as Response
      )
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    ).reconcile();

    // No reason recovered -> reason undefined so main.ts keeps the generic wording.
    expect(dropped).toEqual([{ encoreJobId: 'job-dropped', reason: undefined }]);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('drop-reason recovery') && m.includes('not ok'));
    expect(line).toBeDefined();
    expect(line).toContain('status 503');
    expect(line).toContain('inst-1');
    expect(line).toContain('job-dropped');
  });

  it('fetch threw -> generic wording + warn carrying the error (after one retry)', async () => {
    const redis = new FakeRedis();
    await seedDrop(redis, 'inst-1');
    const boom = new Error('ECONNREFUSED encore.example');
    let failedCalls = 0;
    vi.stubGlobal(
      'fetch',
      fetchMockWithFailed([], [], () => {
        failedCalls += 1;
        throw boom;
      })
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    ).reconcile();

    expect(dropped).toEqual([{ encoreJobId: 'job-dropped', reason: undefined }]);
    // Transport error is retried once before giving up (#728 proposal 3).
    expect(failedCalls).toBe(2);
    const call = warn.mock.calls.find(
      (c) =>
        String(c[0]).includes('drop-reason recovery') &&
        String(c[0]).includes('threw')
    );
    expect(call).toBeDefined();
    expect(String(call![0])).toContain('inst-1');
    expect(String(call![0])).toContain('job-dropped');
    // The error object itself is passed through for diagnosis.
    expect(call!.at(-1)).toBe(boom);
  });

  it('job absent from FAILED page -> generic wording + warn naming the job', async () => {
    const redis = new FakeRedis();
    await seedDrop(redis, 'inst-1');
    // FAILED page is ok but lists a DIFFERENT job; our drop is not on the page.
    vi.stubGlobal(
      'fetch',
      fetchMockWithFailed([], [], () =>
        encoreFailedPage([{ externalId: 'some-other-job', message: 'unrelated' }])
      )
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    ).reconcile();

    expect(dropped).toEqual([{ encoreJobId: 'job-dropped', reason: undefined }]);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('drop-reason recovery') && m.includes('absent'));
    expect(line).toBeDefined();
    expect(line).toContain('inst-1');
    expect(line).toContain('job-dropped');
  });

  it('job present but empty message -> generic wording + warn naming the job', async () => {
    const redis = new FakeRedis();
    await seedDrop(redis, 'inst-1');
    // FAILED document exists for our job but its message is empty/whitespace.
    vi.stubGlobal(
      'fetch',
      fetchMockWithFailed([], [], () =>
        encoreFailedPage([{ externalId: 'job-dropped', message: '   ' }])
      )
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const dropped: DroppedJob[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (drops) => {
        dropped.push(...drops);
      })
    ).reconcile();

    expect(dropped).toEqual([{ encoreJobId: 'job-dropped', reason: undefined }]);
    const line = warn.mock.calls
      .map((c) => String(c[0]))
      .find((m) => m.includes('drop-reason recovery') && m.includes('message is empty'));
    expect(line).toBeDefined();
    expect(line).toContain('inst-1');
    expect(line).toContain('job-dropped');
  });
});
