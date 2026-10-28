// A create that 504s on EVERY attempt must still end up owning the instance the
// platform finishes building (issue #1286).
//
// #1071 made the scaler survive a 504 in two ways: the status is classified
// structurally so a 504 is retried, and a retry that collides with itself
// ("Name is already taken") adopts the instance the earlier create landed. Both
// need the create to finish while an attempt is still being made. The case left
// over is the one #1223 reported: all three attempts time out at the gateway
// first, so there is never a collision to adopt. The spawn threw, the next tick
// built a NEW name (scaler{workspace}{ownerTag}{Date.now().toString(36)}), and
// the instance that completed behind the gateway belonged to nobody — an extra
// Encore instance until the orphan reaper removed it, created while the platform
// had just said it was too slow to answer.
//
// What this suite pins down:
//   1. After the last attempt times out, the SAME name is probed for a bounded
//      time and the instance is adopted when it appears — no new name, no throw
//      reaching the tick, and the adopted instance is never destroyed.
//   2. When it never appears, the spawn fails with the CREATE's error as before,
//      and the next tick does not immediately start another create.
//   3. A 504 followed by a successful retry is untouched by any of this.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - spawnInstance(config, maxAttempts = 3): Promise<EncoreInstanceRecord>,
//     DEFAULT_SPAWN_ADOPT_PROBE_TIMEOUT_MS, DEFAULT_SPAWN_ADOPT_PROBE_INTERVAL_MS,
//     SPAWN_ADOPT_PROBE_MIN_CREATE_DURATION_MS, ENCORE_SERVICE_ID,
//     ENCORE_CALLBACK_LISTENER_SERVICE_ID, scalerInstancePrefix(workspaceId) —
//     src/encore-scaler/instance-pool.ts.
//   - readSpawnFailure(redis, workspaceId): Promise<SpawnFailureRecord|undefined>,
//     recordSpawnFailure(redis, workspaceId, { attempts, error, secrets }),
//     spawnGatewayBackoffRemainingMs(record, now, backoffMs),
//     isGatewayTimeoutStatus(httpCode), DEFAULT_SPAWN_GATEWAY_BACKOFF_MS —
//     src/encore-scaler/spawn-failure.ts.
//   - SpawnFailureRecord { at, attempts, consecutiveFailures, message, httpCode? },
//     EncoreScalerConfig.spawnAdoptProbeTimeoutMs / .spawnAdoptProbeIntervalMs /
//     .spawnGatewayBackoffMs, keys.pool(workspaceId) (hash instanceId -> JSON
//     EncoreInstanceRecord), keys.queue(workspaceId), keys.spawnFailure(workspaceId)
//     — src/encore-scaler/types.ts.
//   - EncoreScalerLoop.tick() — src/encore-scaler/scaler-loop.ts.
//   - @osaas/client-core@0.24.0: createInstance(context, serviceId, token, body)
//     (lib/core.js:76-89), getInstance(context, serviceId, name, token)
//     (lib/core.js:128-150 — resolves undefined for every failure but 401, so
//     undefined is "could not confirm"), getInstanceHealth(context, serviceId,
//     name, token), removeInstance(context, serviceId, name, token)
//     (lib/core.d.ts:46); lib/fetch.d.ts `class FetchError extends Error {
//     httpCode?: number }` with `httpCode: response.status` from
//     defaultErrorFactory, which is why the fake below is an Error carrying
//     httpCode and the 504 body is an HTML page.

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
  DEFAULT_SPAWN_ADOPT_PROBE_INTERVAL_MS,
  DEFAULT_SPAWN_ADOPT_PROBE_TIMEOUT_MS,
  ENCORE_CALLBACK_LISTENER_SERVICE_ID,
  ENCORE_SERVICE_ID,
  SPAWN_ADOPT_PROBE_MIN_CREATE_DURATION_MS,
  spawnInstance
} from '../src/encore-scaler/instance-pool.js';
import { EncoreScalerLoop } from '../src/encore-scaler/scaler-loop.js';
import {
  DEFAULT_SPAWN_GATEWAY_BACKOFF_MS,
  isGatewayTimeoutStatus,
  readSpawnFailure,
  recordSpawnFailure,
  spawnGatewayBackoffRemainingMs
} from '../src/encore-scaler/spawn-failure.js';
import { keys, type EncoreScalerConfig } from '../src/encore-scaler/types.js';

// The exact body OSC's gateway returns when it gives up on a create.
const GATEWAY_TIMEOUT_HTML =
  '<html>\n<head><title>504 Gateway Time-out</title></head>\n' +
  '<body>\n<center><h1>504 Gateway Time-out</h1></center>\n' +
  '<hr><center>nginx</center>\n</body>\n</html>\n';

// Stand-in for @osaas/client-core's FetchError: an Error carrying `httpCode`,
// which is exactly how the code under test reads it.
class FakeFetchError extends Error {
  httpCode?: number;
  constructor(message: string, httpCode?: number) {
    super(message);
    this.name = 'FetchError';
    this.httpCode = httpCode;
  }
}

const gatewayTimeout = (): FakeFetchError =>
  new FakeFetchError(GATEWAY_TIMEOUT_HTML, 504);

// How long the real gateway waits before answering 504 (OSC ingress limit). The
// create keeps running on the platform side past this point, which is the whole
// reason the name is worth watching.
const INGRESS_LIMIT_MS = 60_000;

// Minimal in-memory Valkey covering the commands the pool helpers, the spawn
// failure record and one tick touch.
class FakeRedis {
  hashes = new Map<string, Map<string, string>>();
  strings = new Map<string, string>();
  lists = new Map<string, string[]>();
  sets = new Map<string, Set<string>>();

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }
  private list(key: string): string[] {
    let l = this.lists.get(key);
    if (!l) {
      l = [];
      this.lists.set(key, l);
    }
    return l;
  }
  private set_(key: string): Set<string> {
    let s = this.sets.get(key);
    if (!s) {
      s = new Set();
      this.sets.set(key, s);
    }
    return s;
  }
  async llen(key: string): Promise<number> {
    return this.lists.get(key)?.length ?? 0;
  }
  async rpush(key: string, value: string): Promise<number> {
    const l = this.list(key);
    l.push(value);
    return l.length;
  }
  async rpoplpush(src: string, dst: string): Promise<string | null> {
    const v = this.list(src).pop();
    if (v === undefined) return null;
    this.list(dst).unshift(v);
    return v;
  }
  async lrem(key: string, _count: number, value: string): Promise<number> {
    const l = this.list(key);
    const idx = l.indexOf(value);
    if (idx === -1) return 0;
    l.splice(idx, 1);
    return 1;
  }
  async sadd(key: string, member: string): Promise<number> {
    const s = this.set_(key);
    const isNew = !s.has(member);
    s.add(member);
    return isNew ? 1 : 0;
  }
  async srem(key: string, member: string): Promise<number> {
    return this.set_(key).delete(member) ? 1 : 0;
  }
  async scard(key: string): Promise<number> {
    return this.sets.get(key)?.size ?? 0;
  }
  async pexpire(): Promise<number> {
    return 1;
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
    const all = [
      ...this.hashes.keys(),
      ...this.strings.keys(),
      ...this.lists.keys(),
      ...this.sets.keys()
    ];
    return ['0', [...new Set(all)].filter((k) => k.startsWith(prefix))];
  }
}

const WORKSPACE = 'ws1286';
const SERVICE_ACCESS_TOKEN = 'sat-live-0123456789abcdef';

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
    // Instant readiness: none of these tests is about the readiness wait.
    spawnReadyTimeoutMs: 2_000,
    spawnReadyPollIntervalMs: 1,
    ...overrides
  };
}

// A create that behaves like the real one behind an ingress timeout: it RUNS for
// the gateway's limit and only then rejects with the 504 page. `onAttempt` can
// answer a given attempt differently (e.g. let the last one land).
function gatewayTimingOutCreate(
  onAttempt: (attempt: number, args: unknown[]) => Promise<unknown> | undefined = () =>
    undefined
): (...args: unknown[]) => Promise<unknown> {
  return async (...args: unknown[]) => {
    const serviceId = args[1] as string;
    const body = args[3] as { name: string };
    if (serviceId !== ENCORE_SERVICE_ID) {
      return { name: body.name, url: `https://${body.name}-cb.osc.example` };
    }
    const attempt = createInstanceMock.mock.calls.filter(
      (call) => call[1] === ENCORE_SERVICE_ID
    ).length;
    const override = onAttempt(attempt, args);
    if (override) return override;
    await new Promise((r) => setTimeout(r, INGRESS_LIMIT_MS));
    throw gatewayTimeout();
  };
}

// The tick makes HTTP calls of its own (per-instance active state, the
// callback-trust probe). Answering them keeps a stray call from throwing instead
// of failing the assertion under test.
function stubFetchForTick(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/encoreJobs/search/findByStatus')) {
        return new Response(
          JSON.stringify({ _embedded: { encoreJobs: [] }, page: { totalElements: 0 } }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('', { status: 404 });
    })
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  getInstanceHealthMock.mockResolvedValue('running');
  removeInstanceMock.mockResolvedValue(undefined);
  oscListInstancesMock.mockResolvedValue([]);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the spawn adopts the instance a 504 left behind (#1286)', () => {
  // Acceptance criterion 1.
  it('adopts the instance when it appears on the first probe after the last attempt', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    let requestedName: string | undefined;
    // Every attempt runs into the gateway's limit, so there is never an
    // "already taken" collision for #1071's in-loop adoption to use.
    createInstanceMock.mockImplementation(
      gatewayTimingOutCreate((_attempt, args) => {
        const serviceId = args[1] as string;
        if (serviceId === ENCORE_SERVICE_ID) {
          requestedName = (args[3] as { name: string }).name;
        }
        return undefined;
      })
    );
    // The create that timed out has completed on the platform side by the time
    // the probe asks: OSC now reports the instance under the SAME name.
    getInstanceMock.mockImplementation(async (...args: unknown[]) => {
      const name = args[2] as string;
      return { name, url: `https://${name}.osc.example` };
    });

    const spawn = spawnInstance(makeConfig(redis));
    // Three attempts of 60s plus the 5s/10s back-offs; the probe answers at once.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const record = await spawn;

    // The spawn RESOLVED — nothing for the tick to catch — and it resolved with
    // the instance the 504s created, under the name they were sent.
    expect(requestedName).toBeDefined();
    expect(record.instanceId).toBe(requestedName);
    expect(record.url).toBe(`https://${requestedName}.osc.example`);
    // No new name was invented: every Encore create used the one name, and the
    // probe asked for that same name.
    const encoreCreateNames = new Set(
      createInstanceMock.mock.calls
        .filter((call) => call[1] === ENCORE_SERVICE_ID)
        .map((call) => (call[3] as { name: string }).name)
    );
    expect([...encoreCreateNames]).toEqual([requestedName]);
    expect(getInstanceMock).toHaveBeenCalledWith(
      expect.anything(),
      ENCORE_SERVICE_ID,
      requestedName,
      SERVICE_ACCESS_TOKEN
    );
    // Exactly one instance in the pool, and it was not torn down on the way:
    // the spawn did not create it, so the cleanup rule (#1071, #417/#736) keeps
    // its hands off it.
    expect(Object.keys(await redis.hgetall(keys.pool(WORKSPACE)))).toEqual([
      requestedName as string
    ]);
    expect(removeInstanceMock).not.toHaveBeenCalled();
    // A spawn that ended in an adoption is a SUCCESS: no failure record is left
    // behind to back off the next one.
    expect(
      await readSpawnFailure(
        redis as unknown as Parameters<typeof readSpawnFailure>[0],
        WORKSPACE
      )
    ).toBeUndefined();
  });

  it('keeps probing the same name until the instance appears, within the bound', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    createInstanceMock.mockImplementation(gatewayTimingOutCreate());
    // Not there for the first few probes — "could not confirm", which is NOT
    // proof of absence (@osaas/client-core returns undefined for any failure
    // but 401) — then the platform finishes the create.
    let probes = 0;
    getInstanceMock.mockImplementation(async (...args: unknown[]) => {
      const serviceId = args[1] as string;
      const name = args[2] as string;
      if (serviceId !== ENCORE_SERVICE_ID) {
        return { name, url: `https://${name}-cb.osc.example` };
      }
      probes += 1;
      if (probes < 4) return undefined;
      return { name, url: `https://${name}.osc.example` };
    });

    const spawn = spawnInstance(makeConfig(redis));
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    const record = await spawn;

    expect(probes).toBeGreaterThanOrEqual(4);
    expect(record.instanceId).toMatch(/^scaler/);
    // Still exactly one instance, still never destroyed.
    expect(Object.keys(await redis.hgetall(keys.pool(WORKSPACE)))).toEqual([
      record.instanceId
    ]);
    expect(removeInstanceMock).not.toHaveBeenCalled();
  });

  it('does not watch a 504 that came back instantly — nothing was ever in flight', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    // An ingress that refuses the request on the spot answers 504 too, but no
    // create was started, so there is no instance coming and spending the probe
    // budget would only delay the next attempt.
    createInstanceMock.mockRejectedValue(gatewayTimeout());
    getInstanceMock.mockResolvedValue(undefined);

    const spawn = spawnInstance(makeConfig(redis)).catch((err: unknown) => err);
    // Three attempts and their two back-offs = 15s. If the probe ran, this would
    // not have settled yet.
    await vi.advanceTimersByTimeAsync(20_000);
    const result = (await spawn) as Error;

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain('504 Gateway Time-out');
    expect(createInstanceMock).toHaveBeenCalledTimes(3);
    // The threshold is a floor on EVIDENCE: an attempt that lasted no time at
    // all cannot have a create still running behind it.
    expect(SPAWN_ADOPT_PROBE_MIN_CREATE_DURATION_MS).toBeLessThan(INGRESS_LIMIT_MS);
    expect(SPAWN_ADOPT_PROBE_MIN_CREATE_DURATION_MS).toBeGreaterThan(0);
  });

  // Acceptance criterion 3.
  it('leaves a 504 followed by a successful retry exactly as it was', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    createInstanceMock.mockImplementation(
      gatewayTimingOutCreate((attempt, args) => {
        // Attempt 2 lands normally, as it does today.
        if (attempt < 2) return undefined;
        const body = args[3] as { name: string };
        return Promise.resolve({
          name: body.name,
          url: `https://${body.name}.osc.example`
        });
      })
    );

    const spawn = spawnInstance(makeConfig(redis));
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    const record = await spawn;

    // Two Encore creates, no adopt probe (the retry succeeded, so there was
    // nothing to adopt), and the record is the created instance.
    const encoreCreates = createInstanceMock.mock.calls.filter(
      (call) => call[1] === ENCORE_SERVICE_ID
    );
    expect(encoreCreates).toHaveLength(2);
    expect(getInstanceMock).not.toHaveBeenCalled();
    expect(record.url).toBe(`https://${record.instanceId}.osc.example`);
    expect(record.callbackListenerUrl).toBe(
      `https://${record.instanceId}-cb.osc.example`
    );
    expect(removeInstanceMock).not.toHaveBeenCalled();
  });

  it('bounds the probe and records the create error when the instance never appears', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    createInstanceMock.mockImplementation(gatewayTimingOutCreate());
    // The create really did fail: the name stays unknown for the whole budget.
    getInstanceMock.mockResolvedValue(undefined);

    const spawn = spawnInstance(
      makeConfig(redis, {
        spawnAdoptProbeTimeoutMs: 30_000,
        spawnAdoptProbeIntervalMs: 5_000
      })
    ).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    const result = (await spawn) as Error;

    // The CREATE's error is what propagates — never the probe's answer.
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain('504 Gateway Time-out');
    expect(Object.keys(await redis.hgetall(keys.pool(WORKSPACE)))).toHaveLength(0);
    // The probe stayed inside its budget: 30s at 5s apart is a handful of asks,
    // not an unbounded watch.
    expect(getInstanceMock.mock.calls.length).toBeLessThanOrEqual(8);
    expect(getInstanceMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    for (const call of getInstanceMock.mock.calls) {
      expect(call[1]).toBe(ENCORE_SERVICE_ID);
    }
    // No listener was created either: the spawn never got past the Encore half.
    expect(
      createInstanceMock.mock.calls.filter(
        (call) => call[1] === ENCORE_CALLBACK_LISTENER_SERVICE_ID
      )
    ).toHaveLength(0);
    // The failure is recorded WITH its status, which is what the back-off and
    // GET /scaler/status both read (#1286 item 3).
    const failure = await readSpawnFailure(
      redis as unknown as Parameters<typeof readSpawnFailure>[0],
      WORKSPACE
    );
    expect(failure?.httpCode).toBe(504);
    expect(failure?.message).toContain('504 Gateway Time-out');
  });

  it('defaults the probe to a bound sized on the gateway limit, not on the tick', () => {
    expect(DEFAULT_SPAWN_ADOPT_PROBE_TIMEOUT_MS).toBe(90_000);
    expect(DEFAULT_SPAWN_ADOPT_PROBE_INTERVAL_MS).toBe(5_000);
    // Bounded: the budget is a whole number of probes, never an open watch.
    expect(
      DEFAULT_SPAWN_ADOPT_PROBE_TIMEOUT_MS / DEFAULT_SPAWN_ADOPT_PROBE_INTERVAL_MS
    ).toBeLessThanOrEqual(20);
  });
});

describe('the next spawn is held off after a gateway timeout (#1286)', () => {
  it('counts the remaining back-off only for a timeout status', () => {
    const now = 1_000_000;
    const base = { at: now, attempts: 3, consecutiveFailures: 1, message: 'timed out' };
    // A gateway timeout: the platform may still be building the instance.
    expect(spawnGatewayBackoffRemainingMs({ ...base, httpCode: 504 }, now, 120_000)).toBe(
      120_000
    );
    expect(
      spawnGatewayBackoffRemainingMs({ ...base, httpCode: 504 }, now + 90_000, 120_000)
    ).toBe(30_000);
    expect(
      spawnGatewayBackoffRemainingMs({ ...base, httpCode: 504 }, now + 200_000, 120_000)
    ).toBe(0);
    // Everything else says nothing about platform load: retry at once.
    for (const httpCode of [400, 403, 404, 422, 500, 502, 503]) {
      expect(spawnGatewayBackoffRemainingMs({ ...base, httpCode }, now, 120_000)).toBe(0);
    }
    // No record, no status, or a disabled back-off.
    expect(spawnGatewayBackoffRemainingMs(undefined, now, 120_000)).toBe(0);
    expect(spawnGatewayBackoffRemainingMs(base, now, 120_000)).toBe(0);
    expect(spawnGatewayBackoffRemainingMs({ ...base, httpCode: 504 }, now, 0)).toBe(0);
    // A record stamped in the future (clock skew) must not park scale-up for
    // longer than one window.
    expect(
      spawnGatewayBackoffRemainingMs({ ...base, httpCode: 504 }, now - 60_000, 120_000)
    ).toBe(120_000);
    expect(isGatewayTimeoutStatus(504)).toBe(true);
    expect(isGatewayTimeoutStatus(408)).toBe(true);
    expect(isGatewayTimeoutStatus(503)).toBe(false);
    expect(isGatewayTimeoutStatus(undefined)).toBe(false);
    expect(DEFAULT_SPAWN_GATEWAY_BACKOFF_MS).toBeGreaterThan(
      DEFAULT_SPAWN_ADOPT_PROBE_INTERVAL_MS
    );
  });

  // Acceptance criterion 2 (the back-off half).
  // Real timers: one tick drives the readiness wait and the callback-trust
  // probe, which a frozen clock would never let finish. The back-off window is
  // shortened instead (spawnGatewayBackoffMs), which is the same code path the
  // 2-minute default takes.
  it('does not start another create on the next tick, then does once the window passes', async () => {
    const redis = new FakeRedis();
    // The state a 504'd spawn leaves behind: one queued job, no instances, and a
    // spawn-failure record carrying the gateway status.
    await redis.rpush(
      keys.queue(WORKSPACE),
      JSON.stringify({ jobId: 'job-1', payload: {}, enqueuedAt: Date.now() })
    );
    await recordSpawnFailure(
      redis as unknown as Parameters<typeof recordSpawnFailure>[0],
      WORKSPACE,
      { attempts: 3, error: gatewayTimeout() }
    );
    createInstanceMock.mockImplementation(async (...args: unknown[]) => {
      const body = args[3] as { name: string };
      return { name: body.name, url: `https://${body.name}.osc.example` };
    });
    stubFetchForTick();

    const loop = new EncoreScalerLoop(
      makeConfig(redis, { maxInstances: 1, spawnGatewayBackoffMs: 1_000 })
    );
    // Several ticks inside the window: there is queued work and the pool is
    // empty, so the scale-up gate fires on every one of them.
    for (let i = 0; i < 3; i += 1) await loop.tick();
    expect(createInstanceMock).not.toHaveBeenCalled();
    // The job is still queued, waiting — not failed, not dropped.
    expect(await redis.llen(keys.queue(WORKSPACE))).toBe(1);

    // Past the window, scale-up resumes by itself.
    await new Promise((r) => setTimeout(r, 1_200));
    await loop.tick();
    expect(
      createInstanceMock.mock.calls.filter((call) => call[1] === ENCORE_SERVICE_ID)
    ).toHaveLength(1);
  });

  it('never holds off after a failure that is not a gateway timeout', async () => {
    const redis = new FakeRedis();
    await redis.rpush(
      keys.queue(WORKSPACE),
      JSON.stringify({ jobId: 'job-1', payload: {}, enqueuedAt: Date.now() })
    );
    // A refused create (quota, bad body): nothing is in flight on the platform,
    // so the next tick must be free to try again immediately.
    await recordSpawnFailure(
      redis as unknown as Parameters<typeof recordSpawnFailure>[0],
      WORKSPACE,
      { attempts: 1, error: new FakeFetchError('instance quota exceeded', 403) }
    );
    createInstanceMock.mockImplementation(async (...args: unknown[]) => {
      const body = args[3] as { name: string };
      return { name: body.name, url: `https://${body.name}.osc.example` };
    });
    stubFetchForTick();

    const loop = new EncoreScalerLoop(makeConfig(redis, { maxInstances: 1 }));
    await loop.tick();

    expect(
      createInstanceMock.mock.calls.filter((call) => call[1] === ENCORE_SERVICE_ID)
    ).toHaveLength(1);
  });
});
