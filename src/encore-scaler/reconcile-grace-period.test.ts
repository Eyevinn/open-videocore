// Regression test for the reconcile grace period (issue #708).
//
// Even after the terminal-jobStatus-write-on-success fix, a narrow race exists:
// ScalerLoop.reconcile() may diff Encore's active-job set AFTER Encore drops the
// finished job but BEFORE the callback poller has decremented record.activeJobs
// (observed ~4.4s in production). reconcile() therefore consults a short-lived
// completion timestamp (keys.jobCompletionSeen, written by the poller when it
// accepts a completion) and skips onJobsDropped for any job seen completing
// within a configurable grace window (default 10s). This test proves a reconcile
// tick WITHIN the grace window does NOT raise a drop, and one OUTSIDE it does.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - EncoreScalerLoop.reconcile() dropped-job diff + grace-window check —
//     src/encore-scaler/scaler-loop.ts:505-560 (guard 1 at :513, grace check via
//     keys.jobCompletionSeen).
//   - EncoreScalerConfig.reconcileGraceMs + DEFAULT_RECONCILE_GRACE_MS —
//     src/encore-scaler/types.ts and scaler-loop.ts:41-48.
//   - Valkey key schema keys.pool / keys.jobInstance / keys.jobStatus /
//     keys.jobCompletionSeen — src/encore-scaler/types.ts.
//   - Encore findByStatus HATEOAS page shape { _embedded: { encoreJobs:
//     [{ externalId }] }, page: { totalElements } } — verified in
//     reconcile-dropped-jobs.test.ts (SVT Encore, 2026-07-07).

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EncoreScalerLoop, DEFAULT_RECONCILE_GRACE_MS } from './scaler-loop.js';
import {
  keys,
  type DroppedJob,
  type EncoreScalerConfig,
  type EncoreInstanceRecord
} from './types.js';

// In-memory stand-in for the ioredis subset reconcile() uses: hgetall / hset /
// hget for the hashes, plus get/set for the per-job jobCompletionSeen string key.
class FakeRedis {
  private hashes = new Map<string, Map<string, string>>();
  private strings = new Map<string, string>();

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

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  // Accepts the ('PX', ttl) variadic form the poller uses; the fake ignores TTL
  // (tests drive elapsed time via the stored timestamp value, not real expiry).
  async set(key: string, value: string, ..._rest: unknown[]): Promise<'OK'> {
    this.strings.set(key, value);
    return 'OK';
  }
}

function makeConfig(
  redis: FakeRedis,
  onJobsDropped: (drops: DroppedJob[]) => Promise<void>,
  reconcileGraceMs?: number
): EncoreScalerConfig {
  return {
    workspaceId: 'ws1',
    maxInstances: 2,
    idleTimeoutMs: 300_000,
    reconcileGraceMs,
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

function fetchMock(queued: string[], inProgress: string[]) {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('status=QUEUED')) return encorePage(queued);
    if (url.includes('status=IN_PROGRESS')) return encorePage(inProgress);
    throw new Error(`unexpected fetch: ${url}`);
  });
}

async function seedPool(redis: FakeRedis, record: EncoreInstanceRecord): Promise<void> {
  await redis.hset(keys.pool('ws1'), record.instanceId, JSON.stringify(record));
}

// Seed one instance tracking 1 active job that Encore no longer lists as active
// (QUEUED + IN_PROGRESS both empty), so guard 1 (actualCount < record.activeJobs)
// fires and the job is a drop candidate — unless the grace window protects it.
async function seedVanishedJob(redis: FakeRedis, instanceId: string): Promise<void> {
  await seedPool(redis, {
    instanceId,
    url: 'https://encore.example',
    activeJobs: 1,
    lastIdleAt: 0
  });
  await redis.hset(keys.jobInstance('ws1'), 'job-x', instanceId);
  await redis.hset(keys.jobStatus('ws1'), 'job-x', 'running');
}

describe('reconcile grace period (issue #708)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does NOT raise a drop for a job seen completing within the grace window', async () => {
    const redis = new FakeRedis();
    const instanceId = 'inst-1';
    await seedVanishedJob(redis, instanceId);
    // Poller stamped completion 4.4s ago (the observed race window) — well inside
    // the default 10s grace window.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await redis.set(keys.jobCompletionSeen('job-x'), String(now - 4_400), 'PX', 12_000);

    vi.stubGlobal('fetch', fetchMock([], []));

    const dropped: string[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (ids) => {
        dropped.push(...ids.map((d) => d.encoreJobId));
      })
    ).reconcile();

    // The just-completed job is NOT re-raised as silently dropped.
    expect(dropped).toEqual([]);
    // Its status is left untouched (the poller owns the terminal settle).
    expect(await redis.hget(keys.jobStatus('ws1'), 'job-x')).toBe('running');
    // activeJobs is still corrected down to the real count.
    const rec = JSON.parse((await redis.hget(keys.pool('ws1'), instanceId))!) as EncoreInstanceRecord;
    expect(rec.activeJobs).toBe(0);
  });

  it('DOES raise a drop for a job whose completion is older than the grace window', async () => {
    const redis = new FakeRedis();
    const instanceId = 'inst-1';
    await seedVanishedJob(redis, instanceId);
    // Completion stamped longer ago than the default grace window (10s): the key
    // is stale, so this is a genuine silent drop, not a poller-mid-settle race.
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    await redis.set(
      keys.jobCompletionSeen('job-x'),
      String(now - (DEFAULT_RECONCILE_GRACE_MS + 5_000)),
      'PX',
      12_000
    );

    vi.stubGlobal('fetch', fetchMock([], []));

    const dropped: string[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (ids) => {
        dropped.push(...ids.map((d) => d.encoreJobId));
      })
    ).reconcile();

    expect(dropped).toEqual(['job-x']);
    // Stale status overwritten so getJobStatus won't re-report running.
    expect(await redis.hget(keys.jobStatus('ws1'), 'job-x')).toBe('FAILED');
  });

  it('DOES raise a drop when no completion timestamp exists at all', async () => {
    const redis = new FakeRedis();
    const instanceId = 'inst-1';
    await seedVanishedJob(redis, instanceId);
    // No keys.jobCompletionSeen written — behaviour is exactly as before #708.
    vi.stubGlobal('fetch', fetchMock([], []));

    const dropped: string[] = [];
    await new EncoreScalerLoop(
      makeConfig(redis, async (ids) => {
        dropped.push(...ids.map((d) => d.encoreJobId));
      })
    ).reconcile();

    expect(dropped).toEqual(['job-x']);
  });

  it('honours a custom reconcileGraceMs from config', async () => {
    const redis = new FakeRedis();
    const instanceId = 'inst-1';
    await seedVanishedJob(redis, instanceId);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    // Completed 8s ago: outside the default 10s? no — but with a tight 2s window
    // it IS outside, so the job must be dropped.
    await redis.set(keys.jobCompletionSeen('job-x'), String(now - 8_000), 'PX', 4_000);

    vi.stubGlobal('fetch', fetchMock([], []));

    const dropped: string[] = [];
    await new EncoreScalerLoop(
      makeConfig(
        redis,
        async (ids) => {
          dropped.push(...ids.map((d) => d.encoreJobId));
        },
        2_000 // 2s custom grace window
      )
    ).reconcile();

    expect(dropped).toEqual(['job-x']);
  });
});
