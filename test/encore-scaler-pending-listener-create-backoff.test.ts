// A pending spawn whose paired callback-listener create keeps failing must back
// off, and must stop entirely when the failure is permanent (issue #1109).
//
// Found reviewing #1081 (closes #1071). resolvePendingSpawns completes a kept
// (pending) spawn by creating or adopting the callback listener its timed-out
// spawn never got to. That create was attempted on EVERY tick until the pending
// instance's readiness deadline, with no back-off and no permanent-versus-
// transient distinction — unlike the spawn path, which has always classified its
// create failures with isTransientOscError. At a 10s tick against a 15-minute
// readiness budget that is roughly 90 failing creates per stuck instance,
// including for a 4xx that could never have succeeded.
//
// What this file pins down:
//   - a non-transient failure (422) produces exactly ONE create, ever, and the
//     instance then runs out its deadline and is destroyed as normal;
//   - a transient failure (503) backs off between attempts instead of retrying
//     per tick, and a create that eventually succeeds still promotes;
//   - the deadline teardown is unaffected in both cases.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - isTransientOscError — src/encore-scaler/osc-error.ts:98. 5xx/408/429 (and
//     transport markers when there is no httpCode) are transient; every other
//     status, 4xx above all, is permanent. The resolver reuses THIS classifier,
//     the same one spawnPooledInstance uses (src/encore-scaler/instance-pool.ts,
//     the `isTransientOscError(err)` guard on the listener-create retry loop).
//   - isNameAlreadyTakenError — src/encore-scaler/osc-error.ts:118, the
//     retry-worthy "the create landed behind the gateway" case the spawn loop
//     also retries rather than treating as permanent.
//   - EncoreInstanceRecord (incl. pendingReadySince, listenerCreateAttempts,
//     listenerCreateNextAttemptAt, listenerCreateBlockedAt) and
//     keys.pool(workspaceId) — src/encore-scaler/types.ts:217. The pool hash
//     stores instanceId -> JSON EncoreInstanceRecord
//     (instance-pool.ts updateInstance/listInstances).
//   - resolvePendingSpawns(config): Promise<{ promoted: string[]; destroyed:
//     string[] }> and pendingListenerCreateBackoffMs(attempt) —
//     src/encore-scaler/instance-pool.ts.
//   - @osaas/client-core@0.24.0 lib/core.d.ts:32 createInstance(context,
//     serviceId, token, body), :46 removeInstance(context, serviceId, name,
//     token), :56 getInstance(context, serviceId, name, token), :86
//     getInstanceHealth(context, serviceId, name, token); lib/fetch.d.ts:5
//     `class FetchError extends Error { httpCode?: number }` — the error shape
//     the fake below duck-types.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createInstanceMock = vi.fn();
const getInstanceMock = vi.fn();
const getInstanceHealthMock = vi.fn(async () => 'running');
const removeInstanceMock = vi.fn(async () => undefined);
const oscListInstancesMock = vi.fn(async () => [] as unknown[]);
vi.mock('@osaas/client-core', async () => {
  const actual = await vi.importActual<typeof import('@osaas/client-core')>(
    '@osaas/client-core'
  );
  return {
    ...actual,
    createInstance: (...args: unknown[]) => createInstanceMock(...args),
    getInstance: (...args: unknown[]) => getInstanceMock(...args),
    getInstanceHealth: (...args: unknown[]) => getInstanceHealthMock(...args),
    removeInstance: (...args: unknown[]) => removeInstanceMock(...args),
    listInstances: (...args: unknown[]) => oscListInstancesMock(...args)
  };
});

import {
  ENCORE_CALLBACK_LISTENER_SERVICE_ID,
  ENCORE_SERVICE_ID,
  pendingListenerCreateBackoffMs,
  resolvePendingSpawns,
  scalerInstancePrefix
} from '../src/encore-scaler/instance-pool.js';
import {
  keys,
  type EncoreInstanceRecord,
  type EncoreScalerConfig
} from '../src/encore-scaler/types.js';

// Stand-in for @osaas/client-core's FetchError: an Error carrying `httpCode`,
// which is exactly how isTransientOscError reads it.
class FakeFetchError extends Error {
  httpCode?: number;
  constructor(message: string, httpCode?: number) {
    super(message);
    this.name = 'FetchError';
    this.httpCode = httpCode;
  }
}

// Minimal in-memory Valkey covering the commands the pending resolver touches.
class FakeRedis {
  hashes = new Map<string, Map<string, string>>();

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? new Map());
  }
  async hset(key: string, field: string, value: string): Promise<number> {
    this.hash(key).set(field, value);
    return 1;
  }
  async hdel(key: string, ...fields: string[]): Promise<number> {
    let removed = 0;
    for (const field of fields) if (this.hash(key).delete(field)) removed += 1;
    return removed;
  }
  async del(...keyList: string[]): Promise<number> {
    let removed = 0;
    for (const key of keyList) if (this.hashes.delete(key)) removed += 1;
    return removed;
  }
}

const WORKSPACE = 'ws1109';
const SERVICE_ACCESS_TOKEN = 'sat-live-0123456789abcdef';
// Comfortably longer than the first few back-offs, so the retry schedule is
// observable before the deadline teardown takes over.
const READY_BUDGET_MS = 600_000;

function makeConfig(
  redis: FakeRedis,
  overrides: Partial<EncoreScalerConfig> = {}
): EncoreScalerConfig {
  return {
    workspaceId: WORKSPACE,
    maxInstances: 3,
    minInstances: 0,
    idleTimeoutMs: 10_000,
    redisUrl: 'redis://fake-valkey:6379',
    oscContext: {
      getServiceAccessToken: async () => SERVICE_ACCESS_TOKEN
    } as unknown as EncoreScalerConfig['oscContext'],
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => SERVICE_ACCESS_TOKEN,
    spawnReadyTimeoutMs: READY_BUDGET_MS,
    spawnReadyPollIntervalMs: 1,
    ...overrides
  };
}

// The state a readiness timeout leaves behind: a tracked, never-dispatched-to
// instance with no callback listener and its own destroy deadline.
async function seedPendingSpawn(redis: FakeRedis): Promise<string> {
  const instanceId = `${scalerInstancePrefix(WORKSPACE)}pend01`;
  await redis.hset(
    keys.pool(WORKSPACE),
    instanceId,
    JSON.stringify({
      instanceId,
      url: `https://${instanceId}.osc.example`,
      activeJobs: 0,
      lastIdleAt: Date.now(),
      pendingReadySince: Date.now()
    } satisfies EncoreInstanceRecord)
  );
  return instanceId;
}

async function readRecord(
  redis: FakeRedis,
  instanceId: string
): Promise<EncoreInstanceRecord | undefined> {
  const raw = (await redis.hgetall(keys.pool(WORKSPACE)))[instanceId];
  return raw ? (JSON.parse(raw) as EncoreInstanceRecord) : undefined;
}

// How many createInstance calls have targeted the callback-listener service.
const listenerCreateCount = (): number =>
  createInstanceMock.mock.calls.filter(
    (call) => call[1] === ENCORE_CALLBACK_LISTENER_SERVICE_ID
  ).length;

beforeEach(() => {
  vi.clearAllMocks();
  // The Encore half is up throughout: the listener is the only thing missing,
  // which is precisely the state the resolver is supposed to finish.
  getInstanceHealthMock.mockResolvedValue('running');
  removeInstanceMock.mockResolvedValue(undefined);
  oscListInstancesMock.mockResolvedValue([]);
  getInstanceMock.mockResolvedValue(undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a permanently-failing callback-listener create stops retrying (#1109)', () => {
  it('attempts the create exactly once and still destroys the instance at its deadline', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    const config = makeConfig(redis);
    const instanceId = await seedPendingSpawn(redis);

    // 422: the server rejected the request body. isTransientOscError
    // (osc-error.ts:98) calls every non-408/429 4xx permanent — it will fail
    // identically on every attempt, so retrying only burns OSC API calls.
    createInstanceMock.mockRejectedValue(
      new FakeFetchError('callback listener config rejected', 422)
    );

    const first = await resolvePendingSpawns(config);
    expect(first.promoted).toEqual([]);
    expect(first.destroyed).toEqual([]);
    expect(listenerCreateCount()).toBe(1);

    // The permanent failure is recorded on the pending record rather than
    // re-derived (or silently forgotten) each tick.
    const afterFirst = await readRecord(redis, instanceId);
    expect(afterFirst?.listenerCreateBlockedAt).toBeTypeOf('number');
    expect(afterFirst?.listenerCreateNextAttemptAt).toBeUndefined();
    expect(afterFirst?.callbackListenerUrl).toBeUndefined();

    // Ten more ticks, spread over most of the readiness budget: before #1109
    // every one of these issued another doomed createInstance.
    for (let tick = 0; tick < 10; tick++) {
      await vi.advanceTimersByTimeAsync(10_000);
      const result = await resolvePendingSpawns(config);
      expect(result.promoted).toEqual([]);
      expect(result.destroyed).toEqual([]);
    }
    expect(listenerCreateCount()).toBe(1);
    // Not promoted either: an Encore instance with no listener completes jobs
    // into nowhere.
    expect((await readRecord(redis, instanceId))?.readyAt).toBeUndefined();

    // Giving up on the create does NOT make the instance immortal: the normal
    // deadline still reclaims it, so a clean spawn can replace it.
    await vi.advanceTimersByTimeAsync(READY_BUDGET_MS);
    const final = await resolvePendingSpawns(config);

    expect(final.destroyed).toEqual([instanceId]);
    const removedServices = removeInstanceMock.mock.calls.map((call) => call[1]);
    expect(removedServices).toContain(ENCORE_SERVICE_ID);
    expect(removedServices).toContain(ENCORE_CALLBACK_LISTENER_SERVICE_ID);
    expect(Object.keys(await redis.hgetall(keys.pool(WORKSPACE)))).toHaveLength(0);
    // Still exactly one create across the instance's entire life.
    expect(listenerCreateCount()).toBe(1);
  });
});

describe('a transiently-failing callback-listener create backs off (#1109)', () => {
  it('waits out an exponential back-off instead of retrying on every tick', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    const config = makeConfig(redis);
    const instanceId = await seedPendingSpawn(redis);

    // 503: transient by isTransientOscError, so this one IS worth repeating —
    // just not 90 times.
    createInstanceMock.mockRejectedValue(
      new FakeFetchError('upstream unavailable', 503)
    );

    const startedAt = Date.now();
    await resolvePendingSpawns(config);
    expect(listenerCreateCount()).toBe(1);

    const afterFirst = await readRecord(redis, instanceId);
    expect(afterFirst?.listenerCreateAttempts).toBe(1);
    expect(afterFirst?.listenerCreateBlockedAt).toBeUndefined();
    expect(afterFirst?.listenerCreateNextAttemptAt).toBe(
      startedAt + pendingListenerCreateBackoffMs(1)
    );

    // Ticks inside the back-off window issue no create at all.
    for (let tick = 0; tick < 2; tick++) {
      await vi.advanceTimersByTimeAsync(10_000);
      await resolvePendingSpawns(config);
    }
    expect(listenerCreateCount()).toBe(1);

    // Past the window: one more attempt, and the next window is longer.
    await vi.advanceTimersByTimeAsync(pendingListenerCreateBackoffMs(1));
    await resolvePendingSpawns(config);
    expect(listenerCreateCount()).toBe(2);
    const afterSecond = await readRecord(redis, instanceId);
    expect(afterSecond?.listenerCreateAttempts).toBe(2);
    expect(pendingListenerCreateBackoffMs(2)).toBeGreaterThan(
      pendingListenerCreateBackoffMs(1)
    );

    // Half of the second window: still silent.
    await vi.advanceTimersByTimeAsync(pendingListenerCreateBackoffMs(2) / 2);
    await resolvePendingSpawns(config);
    expect(listenerCreateCount()).toBe(2);

    // OSC recovers. The next attempt after the window completes the spawn: the
    // listener is created, the back-off bookkeeping is cleared, and the
    // instance joins the pool rather than being thrown away.
    createInstanceMock.mockImplementation(async (...args: unknown[]) => {
      const body = args[3] as { name: string };
      return { name: body.name, url: `https://${body.name}cb.osc.example` };
    });
    await vi.advanceTimersByTimeAsync(pendingListenerCreateBackoffMs(2));
    const { promoted } = await resolvePendingSpawns(config);

    expect(listenerCreateCount()).toBe(3);
    expect(promoted).toEqual([instanceId]);
    const promotedRecord = await readRecord(redis, instanceId);
    expect(promotedRecord?.callbackListenerUrl).toBeDefined();
    expect(promotedRecord?.pendingReadySince).toBeUndefined();
    expect(promotedRecord?.readyAt).toBeTypeOf('number');
    expect(promotedRecord?.listenerCreateAttempts).toBeUndefined();
    expect(promotedRecord?.listenerCreateNextAttemptAt).toBeUndefined();
    expect(removeInstanceMock).not.toHaveBeenCalled();
  });

  it('still destroys the instance at its deadline if the transient failure never clears', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    const config = makeConfig(redis);
    const instanceId = await seedPendingSpawn(redis);

    createInstanceMock.mockRejectedValue(
      new FakeFetchError('upstream unavailable', 503)
    );

    // A whole budget's worth of ticks at the real 10s cadence.
    for (let elapsed = 0; elapsed < READY_BUDGET_MS; elapsed += 10_000) {
      await resolvePendingSpawns(config);
      await vi.advanceTimersByTimeAsync(10_000);
    }

    // Bounded by the back-off, not by the tick rate: 60 ticks, a handful of
    // creates. Before #1109 this was one create per tick.
    expect(listenerCreateCount()).toBeLessThan(10);
    expect(listenerCreateCount()).toBeGreaterThan(1);

    const { destroyed } = await resolvePendingSpawns(config);
    expect(destroyed).toEqual([instanceId]);
    expect(Object.keys(await redis.hgetall(keys.pool(WORKSPACE)))).toHaveLength(0);
  });
});
