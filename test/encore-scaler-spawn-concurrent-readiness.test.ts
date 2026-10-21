// Regression test for issue #1170: a spawned Encore instance must join the pool
// — and so become eligible for queued work — as soon as BOTH halves are up, not
// after two provisioning waits run end to end.
//
// THE INCIDENT. "With scaler max 2 and three jobs queued together, the second
// instance became ready (muxs3tn6 at 07:21:59) but received no job. All three
// jobs ran in sequence on the first instance (muxri65i), and the second took its
// first job only at 07:26."
//
// HOW JOBS ARE ASSIGNED (read before changing anything): shared-queue PULL, then
// submission to a specific instance. Producers LPUSH onto
// `encore:queue:{workspaceId}` (src/encore-scaler/index.ts
// makeScalingEncoreClient.submit; src/encore-scaler/encore-scaler-router.ts
// POST /encoreJobs) and step 5 of EncoreScalerLoop.tick
// (src/encore-scaler/scaler-loop.ts) RPOPLPUSHes each entry and POSTs it to one
// instance from the pool hash. An instance can therefore only take queued work
// once it is IN that hash — which spawnPooledInstance writes only after both the
// Encore instance and its paired callback listener report `running`.
//
// Those two waits used to be serial, and the listener was not even CREATED until
// the Encore half was up, so a scale-up paid for two full provisioning waits
// back to back while the already-warm instance drained the queue alone. The
// create only needs the Encore URL (returned by createInstance), never a running
// Encore instance, so the two waits now overlap.
//
// CONTRACT SOURCES VERIFIED (CLAUDE.md rule 7)
//   - @osaas/client-core lib/core.d.ts (v0.24.0):
//       createInstance(context, serviceId, token, body): Promise<any>  (:32)
//       removeInstance(context, serviceId, name, token): Promise<void> (:46)
//       getInstanceHealth(context, serviceId, name, token): Promise<string> (:86)
//     'running' is the ready state the SDK's own waitForInstanceReady gates on
//     (lib/core.js:347-349); the scaler polls getInstanceHealth itself because
//     that helper has no timeout and no abort (lib/core.js:343-353).
//   - ENCORE_SERVICE_ID / ENCORE_CALLBACK_LISTENER_SERVICE_ID and
//     spawnInstance() — src/encore-scaler/instance-pool.ts.
//   - EncoreInstanceRecord.{callbackListenerUrl,readyAt,activeJobs} and
//     keys.pool — src/encore-scaler/types.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createInstance = vi.fn();
const removeInstance = vi.fn(async () => undefined);
const listInstances = vi.fn(async () => [] as Array<Record<string, unknown>>);
const getInstanceHealth = vi.fn(async (..._args: unknown[]) => 'running');

vi.mock('@osaas/client-core', () => ({
  createInstance: (...args: unknown[]) => createInstance(...args),
  removeInstance: (...args: unknown[]) => removeInstance(...args),
  listInstances: (...args: unknown[]) => listInstances(...args),
  getInstanceHealth: (...args: unknown[]) => getInstanceHealth(...args)
}));

import {
  ENCORE_CALLBACK_LISTENER_SERVICE_ID,
  ENCORE_SERVICE_ID,
  spawnInstance
} from '../src/encore-scaler/instance-pool.js';
import {
  keys,
  type EncoreInstanceRecord,
  type EncoreScalerConfig
} from '../src/encore-scaler/types.js';

// In-memory Valkey covering only what the spawn path touches.
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
  async hdel(key: string, ...fields: string[]): Promise<number> {
    let removed = 0;
    for (const field of fields) if (this.hash(key).delete(field)) removed += 1;
    return removed;
  }
  async del(key: string): Promise<number> {
    return this.hashes.delete(key) ? 1 : 0;
  }
  async get(): Promise<string | null> {
    return null;
  }
  async set(): Promise<'OK'> {
    return 'OK';
  }
}

const OSC_CONTEXT_STUB = {
  getServiceAccessToken: async () => 'test-token'
} as unknown as EncoreScalerConfig['oscContext'];

function makeConfig(redis: FakeRedis, workspaceId: string): EncoreScalerConfig {
  return {
    workspaceId,
    maxInstances: 2,
    minInstances: 0,
    idleTimeoutMs: 300_000,
    redisUrl: 'redis://fake',
    oscContext: OSC_CONTEXT_STUB,
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => 'test-token',
    // Keep the readiness poll sub-millisecond; production uses the 1s default
    // (DEFAULT_SPAWN_READY_POLL_INTERVAL_MS).
    spawnReadyPollIntervalMs: 1,
    spawnReadyTimeoutMs: 10_000
  };
}

describe('spawnInstance provisions both halves concurrently (#1170)', () => {
  beforeEach(() => {
    createInstance.mockReset();
    removeInstance.mockReset();
    removeInstance.mockResolvedValue(undefined);
    listInstances.mockReset();
    getInstanceHealth.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates the paired callback listener without waiting for the Encore half, and overlaps the two readiness waits', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-1170';

    // Order of events across BOTH services, so the test can prove the waits
    // interleave instead of running end to end.
    const events: string[] = [];

    createInstance.mockImplementation(async (_ctx, serviceId, _tok, body) => {
      const name = (body as { name: string }).name;
      events.push(`create:${serviceId}`);
      return { name, url: `https://${name}-${serviceId}.example` };
    });

    // Each half needs several polls before OSC reports it `running`.
    const POLLS_BEFORE_RUNNING = 4;
    const polls = new Map<string, number>();
    getInstanceHealth.mockImplementation(async (_ctx, serviceId) => {
      const svc = String(serviceId);
      const n = (polls.get(svc) ?? 0) + 1;
      polls.set(svc, n);
      const health = n >= POLLS_BEFORE_RUNNING ? 'running' : 'creating';
      events.push(`health:${svc}:${health}`);
      return health;
    });

    const record: EncoreInstanceRecord = await spawnInstance(
      makeConfig(redis, workspaceId)
    );

    // 1. The listener's create was issued BEFORE the Encore half ever reported
    //    `running` — it only needs the Encore URL, which createInstance already
    //    returned. Serialised provisioning is exactly the #1170 delay.
    const listenerCreateIdx = events.indexOf(
      `create:${ENCORE_CALLBACK_LISTENER_SERVICE_ID}`
    );
    const encoreRunningIdx = events.indexOf(
      `health:${ENCORE_SERVICE_ID}:running`
    );
    expect(listenerCreateIdx).toBeGreaterThanOrEqual(0);
    expect(encoreRunningIdx).toBeGreaterThanOrEqual(0);
    expect(listenerCreateIdx).toBeLessThan(encoreRunningIdx);

    // 2. The two readiness waits OVERLAP: the listener is polled before the
    //    Encore half's poll loop has finished. With the waits run end to end
    //    every Encore poll precedes every listener poll and this fails.
    const firstListenerPoll = events.findIndex((e) =>
      e.startsWith(`health:${ENCORE_CALLBACK_LISTENER_SERVICE_ID}:`)
    );
    const lastEncorePoll = events.reduce(
      (acc, e, i) => (e.startsWith(`health:${ENCORE_SERVICE_ID}:`) ? i : acc),
      -1
    );
    expect(firstListenerPoll).toBeGreaterThanOrEqual(0);
    expect(firstListenerPoll).toBeLessThan(lastEncorePoll);

    // 3. The record still only exists once BOTH halves are up, and still
    //    carries the listener URL the dispatch path injects as
    //    `progressCallbackUri` (scaler-loop.ts dispatch).
    expect(polls.get(ENCORE_SERVICE_ID)).toBeGreaterThanOrEqual(
      POLLS_BEFORE_RUNNING
    );
    expect(polls.get(ENCORE_CALLBACK_LISTENER_SERVICE_ID)).toBeGreaterThanOrEqual(
      POLLS_BEFORE_RUNNING
    );
    expect(record.callbackListenerUrl).toContain(
      ENCORE_CALLBACK_LISTENER_SERVICE_ID
    );
    expect(record.activeJobs).toBe(0);
    expect(record.readyAt).toBeTypeOf('number');

    // 4. ...and it is in the pool hash, which is the only thing that makes it
    //    eligible for a queued job (scaler-loop.ts step 5 iterates
    //    listInstances over keys.pool).
    const pool = await redis.hgetall(keys.pool(workspaceId));
    expect(Object.keys(pool)).toEqual([record.instanceId]);
  });

  // The cleanup/pending classification must be unchanged by the overlap: a
  // readiness timeout still keeps the instance (it is very likely still coming
  // up, #1071) and records it as a PENDING pool entry — and that record now
  // carries the listener URL, because the listener already exists by then.
  it('a readiness timeout still records a PENDING pool entry, now with the listener URL already known', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-1170-timeout';

    createInstance.mockImplementation(async (_ctx, serviceId, _tok, body) => {
      const name = (body as { name: string }).name;
      return { name, url: `https://${name}-${serviceId}.example` };
    });
    // The Encore half never reports running; the listener does.
    getInstanceHealth.mockImplementation(async (_ctx, serviceId) =>
      String(serviceId) === ENCORE_SERVICE_ID ? 'creating' : 'running'
    );

    const config = makeConfig(redis, workspaceId);
    config.spawnReadyTimeoutMs = 20;

    await expect(spawnInstance(config)).rejects.toThrow();

    const pool = await redis.hgetall(keys.pool(workspaceId));
    const records = Object.values(pool).map(
      (v) => JSON.parse(v) as EncoreInstanceRecord
    );
    expect(records).toHaveLength(1);
    expect(records[0]!.pendingReadySince).toBeTypeOf('number');
    expect(records[0]!.callbackListenerUrl).toContain(
      ENCORE_CALLBACK_LISTENER_SERVICE_ID
    );
    // Not destroyed: a readiness timeout is not evidence of a broken instance.
    expect(removeInstance).not.toHaveBeenCalled();
  });

  // Overlapping the waits means the Encore wait is ALREADY RUNNING while the
  // listener is created, so every way out of that block has to cancel it. The
  // listener create sits between the start of the Encore wait and the
  // Promise.all; a create that fails non-transiently rejects the spawn without
  // ever reaching the Promise.all, and the wait would otherwise keep polling
  // getInstanceHealth (once a second in production, for up to the full spawn
  // readiness timeout) against an instance the cleanup path has just destroyed.
  // `encoreReady.catch(() => undefined)` only silences that loop's rejection.
  it('aborts the in-flight Encore readiness wait when the listener create fails, so no further health probes are issued after the spawn rejects', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-1170-listener-create-fails';

    createInstance.mockImplementation(async (_ctx, serviceId, _tok, body) => {
      const name = (body as { name: string }).name;
      if (String(serviceId) === ENCORE_CALLBACK_LISTENER_SERVICE_ID) {
        // Let the Encore readiness wait get properly in flight first (its poll
        // interval is 1ms in this config), so this really covers "the create
        // fails WHILE the wait is running".
        await new Promise((r) => setTimeout(r, 10));
        // Non-transient, so the create loop rethrows on the first attempt:
        // isTransientOscError classifies on the error's own `httpCode`
        // (src/encore-scaler/osc-error.ts), and 400 is not retryable.
        throw Object.assign(new Error('listener create rejected'), {
          httpCode: 400
        });
      }
      return { name, url: `https://${name}-${serviceId}.example` };
    });

    // The Encore half never reports `running`, so the ONLY thing that can stop
    // its poll loop within this test is the abort.
    getInstanceHealth.mockImplementation(async () => 'creating');

    const config = makeConfig(redis, workspaceId);
    // Far longer than the test's own observation window, so the wait's own
    // deadline cannot be what stops the polling.
    config.spawnReadyTimeoutMs = 60_000;

    await expect(spawnInstance(config)).rejects.toThrow(
      'listener create rejected'
    );

    const encoreProbes = () =>
      getInstanceHealth.mock.calls.filter(
        (call) => String(call[1]) === ENCORE_SERVICE_ID
      ).length;

    // The wait was genuinely in flight when the create failed...
    const probesAtRejection = encoreProbes();
    expect(probesAtRejection).toBeGreaterThan(0);

    // ...and it stopped. At a 1ms cadence this window would otherwise add ~100
    // more probes to an instance the spawn has already abandoned and destroyed.
    await new Promise((r) => setTimeout(r, 150));
    expect(encoreProbes()).toBe(probesAtRejection);
    expect(removeInstance).toHaveBeenCalled();
  });
});
