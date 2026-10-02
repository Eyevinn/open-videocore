// A createInstance that answers 504 while OSC provisions a node must be
// survived, not abandoned (issue #1071).
//
// What happened in production (#1071, reproduced on an idle stack): OSC's
// gateway answered three createInstance calls in six minutes with
// "504 Gateway Time-out" — an HTML error page — because a new worker node was
// being provisioned to place the instance on. The platform's answer is that this
// is expected and the scaler has to absorb it: the create CONTINUES behind the
// gateway and the instance really is created. The scaler did the opposite of
// absorbing it, in three separate ways:
//
//   1. Its transient classifier substring-matched the error MESSAGE for
//      '500'/'502'/'503'. '504' was not in the list, so the textbook transient
//      was declared permanent and thrown on attempt 1 with no retry — while any
//      message that merely contained '503' anywhere was retried as a 503.
//   2. The instance name is computed ONCE outside the retry loop, so a retry
//      re-sends the same name and OSC answers "Name is already taken". Nothing
//      adopted that instance, so a retry could only fail again or duplicate.
//   3. The readiness budget was sized for a pod start (5 min). With a node being
//      provisioned, readiness is minutes away; the wait expired and the cleanup
//      path DESTROYED the instance the spawn had just waited for, sending the
//      next tick around the same loop.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - @osaas/client-core@0.24.0 lib/fetch.js `defaultErrorFactory` +
//     lib/fetch.d.ts `class FetchError extends Error { httpCode?: number }` —
//     every non-ok response throws a FetchError carrying `httpCode:
//     response.status`, and the non-JSON branch takes the message from
//     `response.text()`, which is why a 504 arrives as an HTML page. The fakes
//     below reproduce that shape exactly (including the real HTML body from the
//     #1071 log).
//   - @osaas/client-core@0.24.0 lib/core.js:128-150 `getInstance(context,
//     serviceId, name, token)` — returns the instance, or UNDEFINED when the
//     FetchError's httpCode is 404.
//   - @osaas/client-core@0.24.0 lib/core.js:76-89 `createInstance(context,
//     serviceId, token, body)` and lib/core.d.ts:46 `removeInstance(context,
//     serviceId, name, token)` — the argument orders asserted below.
//   - Adopt-on-"already taken" precedent: src/routes/provision.ts:822-849 —
//     getInstance on 'already taken'/'already exists', with the adopted-vs-created
//     flag that keeps rollback off instances it did not create (#417/#736).
//   - spawnInstance(config, maxAttempts = 3), reapOrphanedInstances(config),
//     DEFAULT_SPAWN_READY_TIMEOUT_MS, SpawnReadyTimeoutError —
//     src/encore-scaler/instance-pool.ts.
//   - isTransientOscError / isNameAlreadyTakenError / oscHttpCode —
//     src/encore-scaler/osc-error.ts.
//   - keys.pool(workspaceId) hash of instanceId -> JSON EncoreInstanceRecord,
//     keys.spawnFailure(workspaceId) — src/encore-scaler/types.ts.

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
  DEFAULT_SPAWN_READY_TIMEOUT_MS,
  ENCORE_CALLBACK_LISTENER_SERVICE_ID,
  ENCORE_SERVICE_ID,
  reapOrphanedInstances,
  resolvePendingSpawns,
  scalerInstancePrefix,
  spawnInstance
} from '../src/encore-scaler/instance-pool.js';
import { EncoreScalerLoop } from '../src/encore-scaler/scaler-loop.js';
import {
  isNameAlreadyTakenError,
  isTransientOscError,
  oscHttpCode
} from '../src/encore-scaler/osc-error.js';
import { readSpawnFailure } from '../src/encore-scaler/spawn-failure.js';
import {
  keys,
  type EncoreInstanceRecord,
  type EncoreScalerConfig
} from '../src/encore-scaler/types.js';

// The exact body OSC's gateway returned in the #1071 incident log.
const GATEWAY_TIMEOUT_HTML =
  '<html>\n<head><title>504 Gateway Time-out</title></head>\n' +
  '<body>\n<center><h1>504 Gateway Time-out</h1></center>\n' +
  '<hr><center>nginx</center>\n</body>\n</html>\n';

// Stand-in for @osaas/client-core's FetchError: an Error carrying `httpCode`.
// Duck-typed on purpose — that is exactly how the classifier under test reads it,
// so a real FetchError and this behave identically.
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

const nameAlreadyTaken = (): FakeFetchError =>
  new FakeFetchError('Name is already taken', 400);

// Minimal in-memory Valkey covering the commands the pool helpers and the orphan
// sweep touch.
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

const WORKSPACE = 'ws1071';
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
    // Instant readiness for everything except the test that is about readiness.
    spawnReadyTimeoutMs: 2_000,
    spawnReadyPollIntervalMs: 1,
    ...overrides
  };
}

// Every PENDING record (#1071) currently in a pool hash dump.
function pendingRecords(pool: Record<string, string>): EncoreInstanceRecord[] {
  return Object.values(pool)
    .map((raw) => JSON.parse(raw) as EncoreInstanceRecord)
    .filter((record) => record.pendingReadySince !== undefined);
}

// The tick makes HTTP calls of its own (the per-instance active-state query and
// the callback-trust probe). None of them should be reached for a pending
// instance; answering them keeps a stray call from throwing instead of failing
// the assertion that matters.
// `activeFor` reports how many jobs Encore says are really in progress on the
// instance a findByStatus query addresses — the tick's reconcile step trusts
// that over the tracked count, so a test that needs a busy instance to STAY busy
// has to answer it honestly.
function stubFetchForTick(activeFor: (url: string) => number = () => 0): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('/encoreJobs/search/findByStatus')) {
        const count = url.includes('status=QUEUED') ? 0 : activeFor(url);
        const encoreJobs = Array.from({ length: count }, (_, i) => ({
          externalId: `ext-${i}`
        }));
        return new Response(
          JSON.stringify({
            _embedded: { encoreJobs },
            page: { totalElements: count }
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      }
      return new Response('', { status: 404 });
    })
  );
}

// createInstance succeeds: echo the requested name back with a URL, as OSC does.
const creationSucceeds = async (
  ..._args: unknown[]
): Promise<{ name: string; url: string }> => {
  const body = _args[3] as { name: string };
  return { name: body.name, url: `https://${body.name}.osc.example` };
};

beforeEach(() => {
  vi.clearAllMocks();
  getInstanceHealthMock.mockResolvedValue('running');
  removeInstanceMock.mockResolvedValue(undefined);
  oscListInstancesMock.mockResolvedValue([]);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('OSC error classification is structural, not textual (#1071)', () => {
  it('reads the httpCode a FetchError carries', () => {
    expect(oscHttpCode(gatewayTimeout())).toBe(504);
    expect(oscHttpCode(new Error('no code here'))).toBeUndefined();
    expect(oscHttpCode(undefined)).toBeUndefined();
  });

  it('treats every 5xx as transient, including the 504 that was missed', () => {
    for (const code of [500, 502, 503, 504, 599]) {
      expect(isTransientOscError(new FakeFetchError('upstream', code))).toBe(true);
    }
  });

  it('never retries a 4xx', () => {
    for (const code of [400, 401, 403, 404, 409, 422]) {
      expect(isTransientOscError(new FakeFetchError('rejected', code))).toBe(false);
    }
  });

  it('does not retry a 4xx whose message merely contains "503"', () => {
    // The old substring classifier retried this. The status is what decides.
    const err = new FakeFetchError('invalid config value: maxBitrate=503000', 400);
    expect(isTransientOscError(err)).toBe(false);
  });

  it('falls back to transport markers when there is no status at all', () => {
    expect(isTransientOscError(new Error('read ECONNRESET'))).toBe(true);
    expect(isTransientOscError(new Error('context deadline exceeded'))).toBe(true);
    expect(isTransientOscError(new Error('ORCHESTRATOR_UNAVAILABLE'))).toBe(true);
    expect(isTransientOscError(new Error('bad request'))).toBe(false);
  });

  it('recognises the "already taken" collision a retry provokes', () => {
    expect(isNameAlreadyTakenError(nameAlreadyTaken())).toBe(true);
    expect(isNameAlreadyTakenError(new Error('instance already exists'))).toBe(true);
    expect(isNameAlreadyTakenError(gatewayTimeout())).toBe(false);
  });
});

describe('spawnInstance retries a 504 with back-off (#1071)', () => {
  it('retries an httpCode 504 create and waits 5s then 10s between attempts', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    createInstanceMock.mockRejectedValue(gatewayTimeout());
    getInstanceMock.mockResolvedValue(undefined);

    const spawn = spawnInstance(makeConfig(redis)).catch((err: unknown) => err);

    // Attempt 1 happens immediately.
    await vi.advanceTimersByTimeAsync(0);
    expect(createInstanceMock).toHaveBeenCalledTimes(1);

    // ...and the back-off is real: still one attempt just before 5s.
    await vi.advanceTimersByTimeAsync(4_900);
    expect(createInstanceMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(createInstanceMock).toHaveBeenCalledTimes(2);

    // Second back-off is longer (10s), not another 5s.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(createInstanceMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(createInstanceMock).toHaveBeenCalledTimes(3);

    const result = (await spawn) as Error;
    expect(result).toBeInstanceOf(Error);
    expect(oscHttpCode(result)).toBe(504);
    // Three createInstance calls, all against the Encore service.
    for (const call of createInstanceMock.mock.calls) {
      expect(call[1]).toBe(ENCORE_SERVICE_ID);
    }
  });

  it('does not retry a 4xx create', async () => {
    const redis = new FakeRedis();
    createInstanceMock.mockRejectedValue(
      new FakeFetchError('instance quota exceeded for this tenant', 403)
    );

    await expect(spawnInstance(makeConfig(redis))).rejects.toThrow(/quota exceeded/);
    expect(createInstanceMock).toHaveBeenCalledTimes(1);
  });

  it('records the 504 failure with the HTML markup stripped', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    createInstanceMock.mockRejectedValue(gatewayTimeout());
    getInstanceMock.mockResolvedValue(undefined);

    const spawn = spawnInstance(makeConfig(redis)).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(30_000);
    await spawn;

    const record = await readSpawnFailure(
      redis as unknown as Parameters<typeof readSpawnFailure>[0],
      WORKSPACE
    );
    expect(record).toBeDefined();
    expect(record?.message).toContain('504 Gateway Time-out');
    // Nothing a browser or log viewer could read as markup survives.
    expect(record?.message).not.toContain('<');
    expect(record?.message).not.toContain('>');
    expect(record?.message).not.toMatch(/<\/?html/i);
    // Three createInstance calls were burned on this spawn.
    expect(record?.attempts).toBe(3);
  });
});

describe('a retry after a 504 adopts the instance the 504 created (#1071)', () => {
  it('adopts on "Name is already taken" and completes the spawn', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    let encoreName: string | undefined;
    createInstanceMock.mockImplementation(async (...args: unknown[]) => {
      const serviceId = args[1] as string;
      const body = args[3] as { name: string };
      if (serviceId === ENCORE_SERVICE_ID) {
        encoreName = body.name;
        // 1st call: gateway timeout while a node is provisioned (the create
        // lands behind it). 2nd call: same name, so OSC rejects the collision.
        if (createInstanceMock.mock.calls.length === 1) throw gatewayTimeout();
        throw nameAlreadyTaken();
      }
      return creationSucceeds(...args);
    });
    getInstanceMock.mockImplementation(async (...args: unknown[]) => {
      const name = args[2] as string;
      return { name, url: `https://${name}.osc.example` };
    });

    const spawn = spawnInstance(makeConfig(redis));
    await vi.advanceTimersByTimeAsync(30_000);
    const record = await spawn;

    expect(encoreName).toBeDefined();
    expect(record.instanceId).toBe(encoreName);
    expect(record.url).toBe(`https://${encoreName}.osc.example`);
    // It was adopted by name, from the Encore service, with the service access
    // token the spawn already held.
    expect(getInstanceMock).toHaveBeenCalledWith(
      expect.anything(),
      ENCORE_SERVICE_ID,
      encoreName,
      SERVICE_ACCESS_TOKEN
    );
    // No duplicate: exactly one Encore instance ended up in the pool.
    const pool = await redis.hgetall(keys.pool(WORKSPACE));
    expect(Object.keys(pool)).toEqual([encoreName as string]);
    // And nothing was torn down along the way.
    expect(removeInstanceMock).not.toHaveBeenCalled();
  });

  it('retries, never adopting a phantom, when getInstance cannot confirm the name', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    createInstanceMock.mockRejectedValue(nameAlreadyTaken());
    // getInstance resolves undefined for EVERY failure except 401
    // (lib/core.js:140-150) — a 404, but equally a 500 or a dropped socket — so
    // undefined means "could not confirm", not "absent". Adopting it as if it
    // were an instance is the bug this guards; giving up on it immediately,
    // when the taken name says the instance probably does exist, is the other.
    getInstanceMock.mockResolvedValue(undefined);

    const spawn = spawnInstance(makeConfig(redis)).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = (await spawn) as Error;

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toMatch(/already taken/);
    // Retried with back-off (the name is fixed, so a retry cannot duplicate),
    // giving adoption another chance each time, then threw the original error.
    expect(createInstanceMock).toHaveBeenCalledTimes(3);
    expect(getInstanceMock).toHaveBeenCalledTimes(3);
    expect(Object.keys(await redis.hgetall(keys.pool(WORKSPACE)))).toHaveLength(0);
  });

  it('never destroys an ADOPTED instance when a later step fails', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    createInstanceMock.mockImplementation(async (...args: unknown[]) => {
      const serviceId = args[1] as string;
      if (serviceId === ENCORE_SERVICE_ID) {
        if (createInstanceMock.mock.calls.length === 1) throw gatewayTimeout();
        throw nameAlreadyTaken();
      }
      // The paired callback listener is refused outright (4xx, not transient).
      throw new FakeFetchError('callback listener config rejected', 422);
    });
    getInstanceMock.mockImplementation(async (...args: unknown[]) => {
      const serviceId = args[1] as string;
      const name = args[2] as string;
      // Only the Encore instance exists; the listener really is absent.
      if (serviceId !== ENCORE_SERVICE_ID) return undefined;
      return { name, url: `https://${name}.osc.example` };
    });

    const spawn = spawnInstance(makeConfig(redis)).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = (await spawn) as Error;

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toMatch(/callback listener config rejected/);
    // THE POINT: the spawn did not create that Encore instance, so its cleanup
    // path must not destroy it (src/routes/provision.ts's adopted-vs-created
    // rule, #417/#736).
    expect(removeInstanceMock).not.toHaveBeenCalled();
  });
});

describe('the readiness budget covers node provisioning (#1071)', () => {
  it('defaults to a node-provisioning budget, not a pod-start one', () => {
    // 5 minutes was a pod start. A node being provisioned is minutes away.
    expect(DEFAULT_SPAWN_READY_TIMEOUT_MS).toBeGreaterThan(5 * 60_000);
    expect(DEFAULT_SPAWN_READY_TIMEOUT_MS).toBe(15 * 60_000);
  });

  it('waits the configured budget before giving up on an instance coming up', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    createInstanceMock.mockImplementation(creationSucceeds);
    // Still being scheduled onto the new node.
    getInstanceHealthMock.mockResolvedValue('pending');

    const config = makeConfig(redis, {
      spawnReadyTimeoutMs: 10 * 60_000,
      spawnReadyPollIntervalMs: 1_000
    });
    const spawn = spawnInstance(config).catch((err: unknown) => err);

    await vi.advanceTimersByTimeAsync(9 * 60_000);
    // Nine minutes in, the spawn is still waiting rather than having torn the
    // instance down.
    expect(removeInstanceMock).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(2 * 60_000);
    const result = (await spawn) as Error;
    expect(result.message).toMatch(/timed out after 600000ms/);
  });

  it('does not destroy an instance that is merely not ready yet', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    createInstanceMock.mockImplementation(creationSucceeds);
    getInstanceHealthMock.mockResolvedValue('pending');

    const spawn = spawnInstance(
      makeConfig(redis, { spawnReadyTimeoutMs: 5_000, spawnReadyPollIntervalMs: 500 })
    ).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = (await spawn) as Error;

    expect(result).toBeInstanceOf(Error);
    expect(result.name).toBe('SpawnReadyTimeoutError');
    // The instance exists and is very likely still coming up: destroying it
    // threw away the node provisioning that had already happened and sent the
    // next tick around the same loop.
    expect(removeInstanceMock).not.toHaveBeenCalled();
    // It is not leaked either — it is tracked as a PENDING pool entry.
    const record = pendingRecords(await redis.hgetall(keys.pool(WORKSPACE)))[0];
    expect(record?.pendingReadySince).toBeTypeOf('number');
    expect(record?.readyAt).toBeUndefined();
    expect(record?.activeJobs).toBe(0);
  });
});

// Everything above leaves the instance ALIVE. These are the tests that say what
// then happens to it — the reason that is not simply the #778 billing leak with
// a new name.
describe('a pending spawn is resumed, capped and ultimately reclaimed (#1071)', () => {
  // Spawn once against a never-ready instance and return its pending record.
  async function spawnIntoPending(
    redis: FakeRedis,
    config: EncoreScalerConfig
  ): Promise<string> {
    createInstanceMock.mockImplementation(creationSucceeds);
    getInstanceHealthMock.mockResolvedValue('pending');
    const spawn = spawnInstance(config).catch(() => undefined);
    // Just past the readiness budget, so the pending record is stamped roughly
    // now and its own (equal) budget has barely started.
    await vi.advanceTimersByTimeAsync(6_000);
    await spawn;
    const [record] = pendingRecords(await redis.hgetall(keys.pool(WORKSPACE)));
    if (!record) throw new Error('expected a pending record');
    return record.instanceId;
  }

  it('promotes the instance as soon as OSC reports it running', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    const config = makeConfig(redis, { spawnReadyTimeoutMs: 5_000 });
    const instanceId = await spawnIntoPending(redis, config);

    // The node finished provisioning between ticks.
    getInstanceHealthMock.mockResolvedValue('running');
    const { promoted, destroyed } = await resolvePendingSpawns(config);

    expect(promoted).toEqual([instanceId]);
    expect(destroyed).toEqual([]);
    const record = JSON.parse(
      (await redis.hgetall(keys.pool(WORKSPACE)))[instanceId]!
    ) as EncoreInstanceRecord;
    expect(record.pendingReadySince).toBeUndefined();
    expect(record.readyAt).toBeTypeOf('number');
    // Promotion COMPLETED the spawn: the Encore readiness wait timed out before
    // the paired callback listener was ever created, so the resolver created it
    // and the promoted record carries its URL. Without that the instance would
    // have joined the pool with no callback path at all.
    expect(record.callbackListenerUrl).toBeDefined();
    expect(
      createInstanceMock.mock.calls.filter(
        (call) => call[1] === ENCORE_CALLBACK_LISTENER_SERVICE_ID
      )
    ).toHaveLength(1);
    // Nothing was destroyed to get here: the instance that cost a node
    // provisioning is the one that ends up serving jobs.
    expect(removeInstanceMock).not.toHaveBeenCalled();
  });

  it('never promotes an instance whose callback listener does not exist yet', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    const config = makeConfig(redis, { spawnReadyTimeoutMs: 5_000 });
    const instanceId = await spawnIntoPending(redis, config);
    // The pending record really has no listener: the Encore readiness wait
    // (instance-pool.ts) runs BEFORE the listener is created, so a timeout there
    // means the spawn never reached it.
    expect(
      pendingRecords(await redis.hgetall(keys.pool(WORKSPACE)))[0]
        ?.callbackListenerUrl
    ).toBeUndefined();

    // The Encore half is up, but the listener cannot be created — a permanent
    // 4xx, so no amount of retrying will change it.
    getInstanceHealthMock.mockImplementation(async (...args: unknown[]) =>
      args[1] === ENCORE_SERVICE_ID ? 'running' : 'pending'
    );
    createInstanceMock.mockRejectedValue(
      new FakeFetchError('callback listener config rejected', 422)
    );
    getInstanceMock.mockResolvedValue(undefined);

    const first = await resolvePendingSpawns(config);

    // NOT promoted. An Encore instance with no listener would be dispatched to
    // with no progressCallbackUri, silently degrading every job to the
    // terminal-job sweep with nothing visible on /scaler/status.
    expect(first.promoted).toEqual([]);
    const stillPending = pendingRecords(await redis.hgetall(keys.pool(WORKSPACE)));
    expect(stillPending).toHaveLength(1);
    expect(stillPending[0]?.readyAt).toBeUndefined();

    // It does not linger either: the deadline applies to an incomplete spawn
    // exactly as it does to one that never came up, so a clean spawn replaces it.
    await vi.advanceTimersByTimeAsync(6_000);
    const second = await resolvePendingSpawns(config);
    expect(second.destroyed).toEqual([instanceId]);
    expect(Object.keys(await redis.hgetall(keys.pool(WORKSPACE)))).toHaveLength(0);
  });

  it('never promotes an ADOPTED instance whose listener create failed permanently', async () => {
    // The adoption variant of the same hole: a 504'd create is adopted, its
    // listener is then refused outright, and the instance lands in the pending
    // record with no callback path.
    vi.useFakeTimers();
    const redis = new FakeRedis();
    const config = makeConfig(redis, { spawnReadyTimeoutMs: 5_000 });
    createInstanceMock.mockImplementation(async (...args: unknown[]) => {
      const serviceId = args[1] as string;
      if (serviceId === ENCORE_SERVICE_ID) {
        if (createInstanceMock.mock.calls.length === 1) throw gatewayTimeout();
        throw nameAlreadyTaken();
      }
      throw new FakeFetchError('callback listener config rejected', 422);
    });
    getInstanceMock.mockImplementation(async (...args: unknown[]) => {
      const serviceId = args[1] as string;
      const name = args[2] as string;
      if (serviceId !== ENCORE_SERVICE_ID) return undefined;
      return { name, url: `https://${name}.osc.example` };
    });
    getInstanceHealthMock.mockResolvedValue('running');

    const spawn = spawnInstance(config).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(30_000);
    await spawn;

    const [pendingRecord] = pendingRecords(await redis.hgetall(keys.pool(WORKSPACE)));
    expect(pendingRecord).toBeDefined();
    expect(pendingRecord?.callbackListenerUrl).toBeUndefined();

    // OSC reports the adopted instance running, but its listener still cannot be
    // created, so it is NOT promoted however healthy the Encore half looks.
    const { promoted } = await resolvePendingSpawns(config);
    expect(promoted).toEqual([]);
    expect(
      pendingRecords(await redis.hgetall(keys.pool(WORKSPACE)))[0]?.readyAt
    ).toBeUndefined();
  });

  it('destroys an instance that never becomes reachable, once its budget is spent', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    const config = makeConfig(redis, { spawnReadyTimeoutMs: 5_000 });
    const instanceId = await spawnIntoPending(redis, config);

    // Nothing about this instance ever answers: OSC health throws (so the
    // orphan sweep's in-flight check could never confirm it either) and it is
    // never `running`. Before #1071's review this state survived every sweep
    // forever, billing.
    getInstanceHealthMock.mockRejectedValue(new Error('instance unreachable'));

    // Inside its extra budget: still waiting, not destroyed.
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await resolvePendingSpawns(config)).toMatchObject({ destroyed: [] });
    expect(removeInstanceMock).not.toHaveBeenCalled();

    // Past it: reclaimed. An instance OSC does not report running cannot be
    // mid-transcode, so this cannot interrupt work.
    await vi.advanceTimersByTimeAsync(6_000);
    const { destroyed } = await resolvePendingSpawns(config);

    expect(destroyed).toEqual([instanceId]);
    const removedServices = removeInstanceMock.mock.calls.map((call) => call[1]);
    expect(removedServices).toContain(ENCORE_SERVICE_ID);
    // The pool record goes with it, so nothing is left behind in Valkey either.
    expect(Object.keys(await redis.hgetall(keys.pool(WORKSPACE)))).toHaveLength(0);
  });

  it('reaps the paired callback listener too when the listener is what never came up', async () => {
    // The original #778 scenario, which #1071 changed the TIMING of rather than
    // the outcome: the Encore instance is healthy, its listener never is, and
    // both must end up destroyed rather than billing.
    vi.useFakeTimers();
    const redis = new FakeRedis();
    const config = makeConfig(redis, { spawnReadyTimeoutMs: 5_000 });
    createInstanceMock.mockImplementation(creationSucceeds);
    getInstanceHealthMock.mockImplementation(async (...args: unknown[]) =>
      args[1] === ENCORE_SERVICE_ID ? 'running' : 'pending'
    );

    const spawn = spawnInstance(config).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = (await spawn) as Error;
    expect(result.name).toBe('SpawnReadyTimeoutError');
    // Neither was destroyed on the spot...
    expect(removeInstanceMock).not.toHaveBeenCalled();
    const [pending] = pendingRecords(await redis.hgetall(keys.pool(WORKSPACE)));
    expect(pending?.callbackListenerUrl).toBeDefined();

    // ...but the Encore instance reports running, so the pending spawn is
    // promoted and its (never-ready) listener comes with it. Make the whole
    // instance unreachable instead and let its budget run out: both services
    // are then torn down.
    getInstanceHealthMock.mockResolvedValue('pending');
    await vi.advanceTimersByTimeAsync(10_000);
    const { destroyed } = await resolvePendingSpawns(config);

    expect(destroyed).toEqual([pending!.instanceId]);
    const removedServices = removeInstanceMock.mock.calls.map((call) => call[1]);
    expect(removedServices).toContain(ENCORE_SERVICE_ID);
    expect(removedServices).toContain(ENCORE_CALLBACK_LISTENER_SERVICE_ID);
  });

  it('counts pending instances against maxInstances, so repeated timeouts cannot pile up', async () => {
    const redis = new FakeRedis();
    // The state a timed-out spawn leaves behind: one instance in the pool,
    // pending, never dispatched to, still inside its readiness budget.
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
    // One job queued and a cap of ONE instance, so the scale-up gate is tested
    // every tick: pending or not, there is work and no usable capacity.
    await redis.rpush(
      keys.queue(WORKSPACE),
      JSON.stringify({ jobId: 'job-1', payload: {}, enqueuedAt: Date.now() })
    );
    createInstanceMock.mockImplementation(creationSucceeds);
    getInstanceHealthMock.mockResolvedValue('pending');
    stubFetchForTick();

    const loop = new EncoreScalerLoop(
      makeConfig(redis, { maxInstances: 1, spawnReadyTimeoutMs: 10 * 60_000 })
    );
    for (let i = 0; i < 4; i += 1) await loop.tick();

    // NOTHING was created. Before the pending record existed the pool stayed
    // empty, so maxInstances — counted from the pool hash — was never reached
    // and every tick provisioned another node beside the one already coming up.
    expect(createInstanceMock).not.toHaveBeenCalled();
    expect(Object.keys(await redis.hgetall(keys.pool(WORKSPACE)))).toEqual([instanceId]);
    // Nor is the pending instance dispatched to: it has never reported healthy,
    // so the job stays queued for whichever instance is ready first.
    expect(await redis.llen(keys.queue(WORKSPACE))).toBe(1);
  });

  it('holds one slot, not the whole pool: scale-up still fires with headroom', async () => {
    const redis = new FakeRedis();
    // Two instances already at the busy threshold, one pending, a cap of five
    // and a deep queue. The pool is out of USABLE capacity and has headroom, so
    // the gate must fire. Before this fix the pending record's permanent
    // activeJobs: 0 made `allBusy` false, and scale-up froze for the whole
    // workspace for as long as anything was coming up.
    const now = Date.now();
    for (const [i, id] of ['busy01', 'busy02'].entries()) {
      const instanceId = `${scalerInstancePrefix(WORKSPACE)}${id}`;
      await redis.hset(
        keys.pool(WORKSPACE),
        instanceId,
        JSON.stringify({
          instanceId,
          url: `https://${instanceId}.osc.example`,
          callbackListenerUrl: `https://${instanceId}-cb.osc.example`,
          callbackTrustReady: true,
          activeJobs: 1,
          lastIdleAt: now - i,
          readyAt: now
        } satisfies EncoreInstanceRecord)
      );
    }
    const pendingId = `${scalerInstancePrefix(WORKSPACE)}pend02`;
    await redis.hset(
      keys.pool(WORKSPACE),
      pendingId,
      JSON.stringify({
        instanceId: pendingId,
        url: `https://${pendingId}.osc.example`,
        activeJobs: 0,
        lastIdleAt: now,
        pendingReadySince: now
      } satisfies EncoreInstanceRecord)
    );
    for (let i = 0; i < 20; i += 1) {
      await redis.rpush(
        keys.queue(WORKSPACE),
        JSON.stringify({ jobId: `job-${i}`, payload: {}, enqueuedAt: now })
      );
    }

    createInstanceMock.mockImplementation(creationSucceeds);
    getInstanceHealthMock.mockImplementation(async (...args: unknown[]) =>
      // The pending instance is still coming up, so it stays pending for the
      // whole test and the scale-up has to happen beside it.
      args[2] === pendingId ? 'pending' : 'running'
    );
    // Both existing instances really are mid-job, so the tick's reconcile step
    // leaves them busy rather than correcting them down to idle.
    stubFetchForTick((url) => (url.includes('busy') ? 1 : 0));

    const loop = new EncoreScalerLoop(
      makeConfig(redis, { maxInstances: 5, spawnReadyTimeoutMs: 10 * 60_000 })
    );
    await loop.tick();

    const encoreCreates = createInstanceMock.mock.calls.filter(
      (call) => call[1] === ENCORE_SERVICE_ID
    );
    expect(encoreCreates).toHaveLength(1);
    // The pending entry is untouched by the scale-up; it is extra capacity on
    // its way, not a reason to stop asking for more.
    expect(pendingRecords(await redis.hgetall(keys.pool(WORKSPACE)))).toHaveLength(1);
  });
});

describe('the orphan sweep can reclaim an unreachable instance (#1071 review)', () => {
  it('reaps an orphan OSC does not report running, even when it answers nothing', async () => {
    const redis = new FakeRedis();
    const config = makeConfig(redis, { orphanGraceMs: 1_000 });
    const instanceId = `${scalerInstancePrefix(WORKSPACE)}abc123`;
    oscListInstancesMock.mockResolvedValue([
      { name: instanceId, url: `https://${instanceId}.osc.example` }
    ]);
    // The instance answers no HTTP at all, so the in-flight check cannot
    // confirm anything...
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ECONNREFUSED');
      })
    );
    // ...but OSC says it is not running, which is authoritative and means it
    // cannot be mid-transcode.
    getInstanceHealthMock.mockResolvedValue('failed');

    // First sweep only starts the grace clock.
    expect(await reapOrphanedInstances(config)).toEqual([]);
    await new Promise((r) => setTimeout(r, 1_100));
    const reaped = await reapOrphanedInstances(config);

    expect(reaped).toEqual([instanceId]);
  });

  it('still refuses to reap an unreachable orphan OSC reports as running', async () => {
    const redis = new FakeRedis();
    const config = makeConfig(redis, { orphanGraceMs: 1_000 });
    const instanceId = `${scalerInstancePrefix(WORKSPACE)}def456`;
    oscListInstancesMock.mockResolvedValue([
      { name: instanceId, url: `https://${instanceId}.osc.example` }
    ]);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connect ETIMEDOUT');
      })
    );
    // Running but unreachable: it really could be mid-transcode behind a
    // network problem, so it is left alone exactly as #778 intended.
    getInstanceHealthMock.mockResolvedValue('running');

    expect(await reapOrphanedInstances(config)).toEqual([]);
    await new Promise((r) => setTimeout(r, 1_100));
    expect(await reapOrphanedInstances(config)).toEqual([]);
    expect(removeInstanceMock).not.toHaveBeenCalled();
  });
});

describe('the orphan sweep cannot reap a 504-created instance (#1071)', () => {
  it('leaves the adopted instance alone because the spawn tracked it', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    createInstanceMock.mockImplementation(async (...args: unknown[]) => {
      const serviceId = args[1] as string;
      if (serviceId === ENCORE_SERVICE_ID) {
        if (createInstanceMock.mock.calls.length === 1) throw gatewayTimeout();
        throw nameAlreadyTaken();
      }
      return creationSucceeds(...args);
    });
    getInstanceMock.mockImplementation(async (...args: unknown[]) => {
      const name = args[2] as string;
      return { name, url: `https://${name}.osc.example` };
    });

    const config = makeConfig(redis);
    const spawn = spawnInstance(config);
    await vi.advanceTimersByTimeAsync(30_000);
    const record = await spawn;

    // OSC now lists the instance the 504 created (and its paired listener).
    oscListInstancesMock.mockResolvedValue([
      { name: record.instanceId, url: record.url }
    ]);

    // Two sweeps, with the whole grace window between them: the first sighting
    // only starts the clock, so one sweep could never reap anything.
    const first = await reapOrphanedInstances(config);
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    const second = await reapOrphanedInstances(config);

    expect(first).toEqual([]);
    expect(second).toEqual([]);
    // Before the adoption fix, the instance the 504 created had no pool record
    // at all — which is exactly what the sweep reaps.
    expect(removeInstanceMock).not.toHaveBeenCalled();
    expect(Object.keys(await redis.hgetall(keys.pool(WORKSPACE)))).toContain(
      record.instanceId
    );
  });
});
