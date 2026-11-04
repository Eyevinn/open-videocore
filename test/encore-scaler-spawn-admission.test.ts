// Issue #1322 — scale-up admission control.
//
// WHAT THIS COVERS
//   1. The deployment-wide spawn cap: two workspaces whose loops both want to
//      scale up on the same tick produce ONE create, not two, and the second is
//      told in the log why it was held.
//   2. The hold-off after a failed spawn lengthens with each consecutive failure
//      (and covers a status-less `fetch failed`, not only a gateway timeout),
//      and a successful spawn resets it.
//   3. The passing path: with a free slot, no hold-off and nothing being
//      adopted, the spawn still starts.
//   4. Expected behaviour 3: a workspace with an instance still being adopted
//      (or still waiting for its callback listener) does not get a sibling.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7):
//   - SpawnConcurrencyLimiter (constructor(limit), .limit, .inFlight,
//     .tryAcquire(workspaceId) -> SpawnSlot | undefined, .holders()),
//     DEFAULT_MAX_CONCURRENT_SPAWNS, resolveMaxConcurrentSpawns(raw, onInvalid),
//     adoptionPendingInstance(instances), holdReasonMessage(reason) —
//     src/encore-scaler/spawn-admission.ts.
//   - spawnGatewayBackoffRemainingMs(record, now, backoffMs, maxBackoffMs),
//     spawnBackoffWindowMs(consecutiveFailures, backoffMs, maxMs),
//     isSpawnHoldOffFailure(record), recordSpawnFailure(redis, workspaceId,
//     { attempts, error, secrets? }), readSpawnFailure(redis, workspaceId),
//     clearSpawnFailure(redis, workspaceId), DEFAULT_SPAWN_GATEWAY_BACKOFF_MS,
//     DEFAULT_SPAWN_BACKOFF_MAX_MS — src/encore-scaler/spawn-failure.ts.
//   - EncoreScalerConfig (workspaceId, maxInstances, minInstances, idleTimeoutMs,
//     redisUrl, oscContext, redis, getToken, s3Config, spawnSlots,
//     spawnGatewayBackoffMs, spawnBackoffMaxMs), EncoreInstanceRecord
//     (instanceId, url, activeJobs, lastIdleAt, readyAt, pendingReadySince,
//     callbackListenerUrl, callbackTrustReady), keys.pool/queue/spawnFailure —
//     src/encore-scaler/types.ts.
//   - EncoreScalerLoop.tick() — src/encore-scaler/scaler-loop.ts.
//   - @osaas/client-core@0.24.0 createInstance(context, serviceId, token, body)
//     and its FetchError shape ({ message, httpCode? }) — mocked here exactly as
//     test/encore-scaler-spawn-failure-visibility.test.ts does.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';

// Mock the OSC SDK rather than instance-pool: the gates under test are in the
// real spawn path, so spawnInstance itself has to run.
const createInstanceMock = vi.fn();
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
    getInstanceHealth: (...args: unknown[]) => getInstanceHealthMock(...args),
    removeInstance: (...args: unknown[]) => removeInstanceMock(...args),
    listInstances: (...args: unknown[]) => oscListInstancesMock(...args)
  };
});

import { EncoreScalerLoop } from '../src/encore-scaler/scaler-loop.js';
import {
  adoptionPendingInstance,
  holdReasonMessage,
  isAdoptionPending,
  resolveMaxConcurrentSpawns,
  SpawnConcurrencyLimiter,
  DEFAULT_MAX_CONCURRENT_SPAWNS
} from '../src/encore-scaler/spawn-admission.js';
import {
  clearSpawnFailure,
  isSpawnHoldOffFailure,
  readSpawnFailure,
  recordSpawnFailure,
  spawnBackoffWindowMs,
  spawnGatewayBackoffRemainingMs,
  DEFAULT_SPAWN_BACKOFF_MAX_MS,
  DEFAULT_SPAWN_GATEWAY_BACKOFF_MS
} from '../src/encore-scaler/spawn-failure.js';
import {
  keys,
  type EncoreInstanceRecord,
  type EncoreScalerConfig
} from '../src/encore-scaler/types.js';

const SERVICE_ACCESS_TOKEN = 'sat-test-0123456789';

// Minimal in-memory Valkey: only the commands this file's ticks touch (pool
// hash, queue list, the spawn-failure string key, and the SCAN the pool helpers
// use). Local to this file so no existing harness is modified.
class FakeRedis {
  private hashes = new Map<string, Map<string, string>>();
  private lists = new Map<string, string[]>();
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
    return Object.fromEntries(this.hashes.get(key) ?? new Map());
  }
  async hkeys(key: string): Promise<string[]> {
    return [...(this.hashes.get(key)?.keys() ?? [])];
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
  async llen(key: string): Promise<number> {
    return this.lists.get(key)?.length ?? 0;
  }
  async rpush(key: string, value: string): Promise<number> {
    const l = this.lists.get(key) ?? [];
    l.push(value);
    this.lists.set(key, l);
    return l.length;
  }
  async rpoplpush(src: string, dst: string): Promise<string | null> {
    const v = (this.lists.get(src) ?? []).pop();
    if (v === undefined) return null;
    const d = this.lists.get(dst) ?? [];
    d.unshift(v);
    this.lists.set(dst, d);
    return v;
  }
  async lrem(): Promise<number> {
    return 0;
  }
  async sadd(): Promise<number> {
    return 1;
  }
  async srem(): Promise<number> {
    return 1;
  }
  async scard(): Promise<number> {
    return 0;
  }
  async pexpire(): Promise<number> {
    return 1;
  }
  async set(key: string, value: string, ..._options: unknown[]): Promise<'OK'> {
    this.strings.set(key, String(value));
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async del(...keyList: string[]): Promise<number> {
    let removed = 0;
    for (const key of keyList) if (this.strings.delete(key)) removed += 1;
    return removed;
  }
  async scan(
    _cursor: string,
    _match: 'MATCH',
    pattern: string,
    _count: 'COUNT',
    _n: number
  ): Promise<[string, string[]]> {
    const prefix = pattern.replace(/\*$/, '');
    const all = [...this.hashes.keys(), ...this.lists.keys(), ...this.strings.keys()];
    return ['0', [...new Set(all)].filter((k) => k.startsWith(prefix))];
  }
}

const OSC_CONTEXT_STUB = {
  getServiceAccessToken: async () => SERVICE_ACCESS_TOKEN
} as unknown as EncoreScalerConfig['oscContext'];

function makeConfig(
  redis: FakeRedis,
  workspaceId: string,
  overrides: Partial<EncoreScalerConfig> = {}
): EncoreScalerConfig {
  return {
    workspaceId,
    maxInstances: 3,
    // Pre-warm: the scale-up gate then fires on every tick regardless of queued
    // work, which is the shortest path to "both workspaces want to spawn now".
    minInstances: 1,
    idleTimeoutMs: 10_000,
    redisUrl: 'redis://fake-valkey:6379',
    oscContext: OSC_CONTEXT_STUB,
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => SERVICE_ACCESS_TOKEN,
    s3Config: {
      endpoint: 'https://objectstore.example',
      accessKeyId: 'storage-admin',
      secretAccessKey: 'storage-secret-do-not-leak'
    },
    ...overrides
  };
}

// Stand-in for @osaas/client-core's FetchError: an Error carrying `httpCode`,
// which is exactly how oscHttpCode reads it.
class FakeFetchError extends Error {
  constructor(
    message: string,
    readonly httpCode?: number
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('spawn cap across all workspaces (#1322)', () => {
  beforeEach(() => {
    createInstanceMock.mockReset();
    getInstanceHealthMock.mockClear();
    removeInstanceMock.mockClear();
    oscListInstancesMock.mockClear();
    oscListInstancesMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('starts one create when two workspaces are queued at once, and says why the other was held', async () => {
    const redis = new FakeRedis();
    const slots = new SpawnConcurrencyLimiter(1);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // The first workspace's create is held open, so its spawn is genuinely IN
    // FLIGHT while the second workspace ticks — the overlap the cap exists for.
    const firstCreate = deferred<unknown>();
    createInstanceMock.mockImplementation(async () => firstCreate.promise);

    const loopA = new EncoreScalerLoop(makeConfig(redis, 'ws-a', { spawnSlots: slots }));
    const loopB = new EncoreScalerLoop(makeConfig(redis, 'ws-b', { spawnSlots: slots }));

    const tickA = loopA.tick();
    // Let tick A reach its create and take the only slot.
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((r) => setTimeout(r, 0));
    expect(slots.inFlight).toBe(1);
    expect(slots.holders()).toEqual(['ws-a']);

    // Workspace B's whole tick completes without a create.
    await loopB.tick();
    expect(createInstanceMock).toHaveBeenCalledTimes(1);

    const held = warn.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(held).toContain('spawn cap reached');
    expect(held).toContain('ws-b');
    expect(held).toContain('ws-a');

    // The slot is returned even when the spawn ends badly, so the deployment is
    // not parked at its cap for ever.
    firstCreate.reject(new FakeFetchError('403 Forbidden', 403));
    await tickA;
    expect(slots.inFlight).toBe(0);
    expect(slots.holders()).toEqual([]);
  });

  it('spawns when a slot is free and no hold-off is active (passing path)', async () => {
    const redis = new FakeRedis();
    const slots = new SpawnConcurrencyLimiter(1);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    createInstanceMock.mockImplementation(async (_ctx, serviceId: string, _t, body) => ({
      name: (body as { name: string }).name,
      url: `https://${(body as { name: string }).name}.${serviceId}.example`
    }));
    // The spawned instance's callback-trust probe is not what this test is
    // about; the pool write happens before dispatch, which is what is asserted.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('{}', { status: 200 }))
    );

    const loop = new EncoreScalerLoop(makeConfig(redis, 'ws-free', { spawnSlots: slots }));
    await loop.tick();

    expect(createInstanceMock).toHaveBeenCalled();
    const pool = await redis.hgetall(keys.pool('ws-free'));
    expect(Object.keys(pool)).toHaveLength(1);
    // And the slot it used is back.
    expect(slots.inFlight).toBe(0);
    vi.unstubAllGlobals();
  });

  it('does not spawn a sibling while an earlier instance is still being adopted', async () => {
    const redis = new FakeRedis();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    createInstanceMock.mockImplementation(async () => {
      throw new Error('no create should be attempted while an instance is being adopted');
    });
    // An instance an earlier spawn has not finished: it exists, but it has no
    // callback listener and has never been marked ready, so it is still being
    // completed and cannot usefully take work yet.
    const pendingRecord: EncoreInstanceRecord = {
      instanceId: 'inst-pending',
      url: 'https://inst-pending.example',
      activeJobs: 0,
      lastIdleAt: Date.now()
    };
    await redis.hset(
      keys.pool('ws-adopting'),
      pendingRecord.instanceId,
      JSON.stringify(pendingRecord)
    );
    // The platform still knows about it, so the vanished-instance eviction at
    // the top of the tick leaves the pool entry alone.
    oscListInstancesMock.mockResolvedValue([
      { name: pendingRecord.instanceId, url: pendingRecord.url }
    ]);
    const loop = new EncoreScalerLoop(
      makeConfig(redis, 'ws-adopting', {
        // Room under the cap: the hold must come from the adoption, not from it.
        maxInstances: 5,
        minInstances: 2,
        spawnSlots: new SpawnConcurrencyLimiter(4)
      })
    );
    await loop.tick();

    expect(createInstanceMock).not.toHaveBeenCalled();
    const held = warn.mock.calls.map((call) => call.map(String).join(' ')).join('\n');
    expect(held).toContain('adoption pending');
    expect(held).toContain('inst-pending');
  });
});

describe('the hold-off lengthens with consecutive failures and resets on success (#1322)', () => {
  it('doubles per consecutive failure up to the cap', () => {
    expect(spawnBackoffWindowMs(1, 120_000, 960_000)).toBe(120_000);
    expect(spawnBackoffWindowMs(2, 120_000, 960_000)).toBe(240_000);
    expect(spawnBackoffWindowMs(3, 120_000, 960_000)).toBe(480_000);
    expect(spawnBackoffWindowMs(4, 120_000, 960_000)).toBe(960_000);
    // Capped, not unbounded: a long outage cannot park scale-up for hours.
    expect(spawnBackoffWindowMs(20, 120_000, 960_000)).toBe(960_000);
    // A cap below the base window can never SHORTEN the first hold-off.
    expect(spawnBackoffWindowMs(1, 120_000, 1_000)).toBe(120_000);
    // Nonsense counters read as a single failure; a disabled back-off stays off.
    expect(spawnBackoffWindowMs(0, 120_000, 960_000)).toBe(120_000);
    expect(spawnBackoffWindowMs(Number.NaN, 120_000, 960_000)).toBe(120_000);
    expect(spawnBackoffWindowMs(5, 0, 960_000)).toBe(0);
    // The shipped defaults are a sane pair.
    expect(DEFAULT_SPAWN_BACKOFF_MAX_MS).toBeGreaterThan(DEFAULT_SPAWN_GATEWAY_BACKOFF_MS);
  });

  it('holds off for a status-less transport failure as well as a gateway timeout', () => {
    const now = 2_000_000;
    const base = { at: now, attempts: 1, consecutiveFailures: 1, message: 'fetch failed' };
    expect(isSpawnHoldOffFailure(base)).toBe(true);
    expect(spawnGatewayBackoffRemainingMs(base, now, 120_000)).toBe(120_000);
    // Still classified on the STATUS when there is one: a 403 that happens to
    // quote the phrase is retried at once.
    expect(isSpawnHoldOffFailure({ ...base, httpCode: 403 })).toBe(false);
    expect(spawnGatewayBackoffRemainingMs({ ...base, httpCode: 403 }, now, 120_000)).toBe(0);
    // An unrelated status-less failure is not a hold-off either.
    expect(isSpawnHoldOffFailure({ ...base, message: 'rejected by validation' })).toBe(false);
  });

  it('grows the remaining hold-off across recorded failures and drops it on a success', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-backoff';
    const timeout = new FakeFetchError('504 Gateway Time-out', 504);

    const first = await recordSpawnFailure(redis as unknown as Redis, workspaceId, {
      attempts: 3,
      error: timeout
    });
    const firstRemaining = spawnGatewayBackoffRemainingMs(
      first,
      first.at,
      120_000,
      960_000
    );

    const second = await recordSpawnFailure(redis as unknown as Redis, workspaceId, {
      attempts: 3,
      error: timeout
    });
    const secondRemaining = spawnGatewayBackoffRemainingMs(
      second,
      second.at,
      120_000,
      960_000
    );
    expect(second.consecutiveFailures).toBe(2);
    expect(secondRemaining).toBeGreaterThan(firstRemaining);

    const third = await recordSpawnFailure(redis as unknown as Redis, workspaceId, {
      attempts: 3,
      error: timeout
    });
    expect(
      spawnGatewayBackoffRemainingMs(third, third.at, 120_000, 960_000)
    ).toBeGreaterThan(secondRemaining);

    // What a successful spawn does (instance-pool.ts spawnInstance): drop the
    // record. There is no separate counter to reset, so the next failure starts
    // again at the base window.
    await clearSpawnFailure(redis as unknown as Redis, workspaceId);
    expect(await readSpawnFailure(redis as unknown as Redis, workspaceId)).toBeUndefined();
    const afterSuccess = await recordSpawnFailure(redis as unknown as Redis, workspaceId, {
      attempts: 1,
      error: timeout
    });
    expect(afterSuccess.consecutiveFailures).toBe(1);
    expect(
      spawnGatewayBackoffRemainingMs(afterSuccess, afterSuccess.at, 120_000, 960_000)
    ).toBe(firstRemaining);
  });
});

describe('spawn admission helpers (#1322)', () => {
  it('counts slots per deployment and hands them back once', () => {
    const slots = new SpawnConcurrencyLimiter(2);
    const a = slots.tryAcquire('ws-a');
    const b = slots.tryAcquire('ws-b');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(slots.tryAcquire('ws-c')).toBeUndefined();
    expect(slots.inFlight).toBe(2);
    expect(slots.holders()).toEqual(['ws-a', 'ws-b']);
    a?.release();
    // Idempotent: a double release must not credit a slot that does not exist.
    a?.release();
    expect(slots.inFlight).toBe(1);
    expect(slots.tryAcquire('ws-c')).toBeDefined();
    expect(slots.tryAcquire('ws-d')).toBeUndefined();
    // A nonsense limit falls back to the default rather than to zero.
    expect(new SpawnConcurrencyLimiter(0).limit).toBe(DEFAULT_MAX_CONCURRENT_SPAWNS);
    expect(new SpawnConcurrencyLimiter(Number.NaN).limit).toBe(DEFAULT_MAX_CONCURRENT_SPAWNS);
  });

  it('reads the operator override the same way as the other scaler bounds', () => {
    const reasons: string[] = [];
    expect(resolveMaxConcurrentSpawns(undefined)).toBe(DEFAULT_MAX_CONCURRENT_SPAWNS);
    expect(resolveMaxConcurrentSpawns('   ')).toBe(DEFAULT_MAX_CONCURRENT_SPAWNS);
    expect(resolveMaxConcurrentSpawns('3')).toBe(3);
    expect(resolveMaxConcurrentSpawns('nope', (r) => reasons.push(r))).toBe(
      DEFAULT_MAX_CONCURRENT_SPAWNS
    );
    expect(resolveMaxConcurrentSpawns('0', (r) => reasons.push(r))).toBe(
      DEFAULT_MAX_CONCURRENT_SPAWNS
    );
    expect(resolveMaxConcurrentSpawns('-5', (r) => reasons.push(r))).toBe(
      DEFAULT_MAX_CONCURRENT_SPAWNS
    );
    expect(reasons).toHaveLength(3);
  });

  it('holds only when the whole pool is still being adopted, never beside working capacity', () => {
    const ready: EncoreInstanceRecord = {
      instanceId: 'inst-ready',
      url: 'https://inst-ready.example',
      activeJobs: 0,
      lastIdleAt: 1,
      readyAt: 1,
      callbackListenerUrl: 'https://inst-ready-cb.example'
    };
    const stillComing: EncoreInstanceRecord = {
      ...ready,
      instanceId: 'inst-p',
      readyAt: undefined,
      callbackListenerUrl: undefined,
      pendingReadySince: 2
    };
    expect(isAdoptionPending(ready)).toBe(false);
    expect(isAdoptionPending(stillComing)).toBe(true);
    // A record adopted from the platform has a readyAt and its listener URL is
    // filled in by a later reconcile pass — not a reason to hold scale-up.
    expect(isAdoptionPending({ ...ready, callbackListenerUrl: undefined })).toBe(false);
    // An instance still waiting for its callback listener counts even without
    // the pending stamp: it cannot usefully take work yet.
    expect(
      isAdoptionPending({ ...ready, readyAt: undefined, callbackListenerUrl: undefined })
    ).toBe(true);

    // Nothing to hold on: an empty pool, or a pool with working capacity.
    expect(adoptionPendingInstance([])).toBeUndefined();
    expect(adoptionPendingInstance([ready])).toBeUndefined();
    // #1071's decision is preserved: a workspace whose usable instances are busy
    // still grows beside an instance that has not landed.
    expect(adoptionPendingInstance([ready, stillComing])).toBeUndefined();
    // But a workspace with nothing BUT unfinished spawns does not ask for more.
    expect(adoptionPendingInstance([stillComing])).toMatchObject({ instanceId: 'inst-p' });
  });

  it('explains every hold in one self-contained sentence', () => {
    expect(
      holdReasonMessage({ kind: 'concurrency-cap', limit: 1, inFlight: 1, holders: ['ws-a'] })
    ).toContain('spawn cap reached');
    const backoff = holdReasonMessage({
      kind: 'failure-backoff',
      remainingMs: 4_000,
      consecutiveFailures: 3,
      httpCode: 504
    });
    expect(backoff).toContain('4000ms');
    expect(backoff).toContain('3 consecutive failed spawn(s)');
    expect(backoff).toContain('504');
    expect(
      holdReasonMessage({ kind: 'failure-backoff', remainingMs: 1, consecutiveFailures: 1 })
    ).toContain('transport failure');
    expect(
      holdReasonMessage({ kind: 'adoption-pending', instanceId: 'inst-x' })
    ).toContain('inst-x');
  });
});
