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
  ENCORE_SERVICE_ID,
  reapOrphanedInstances,
  spawnInstance
} from '../src/encore-scaler/instance-pool.js';
import {
  isNameAlreadyTakenError,
  isTransientOscError,
  oscHttpCode
} from '../src/encore-scaler/osc-error.js';
import { readSpawnFailure } from '../src/encore-scaler/spawn-failure.js';
import { keys, type EncoreScalerConfig } from '../src/encore-scaler/types.js';

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
    const all = [...this.hashes.keys(), ...this.strings.keys()];
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

  it('keeps retrying when the taken name resolves to nothing (getInstance 404)', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    createInstanceMock.mockRejectedValue(nameAlreadyTaken());
    // getInstance returns undefined on a 404 (lib/core.js:140-150). Adopting
    // `undefined` as if it were an instance is the bug this guards.
    getInstanceMock.mockResolvedValue(undefined);

    const spawn = spawnInstance(makeConfig(redis)).catch((err: unknown) => err);
    await vi.advanceTimersByTimeAsync(30_000);
    const result = (await spawn) as Error;

    expect(result).toBeInstanceOf(Error);
    expect(result.message).toMatch(/already taken/);
    // A 400 is not transient, so it fails on the first attempt rather than
    // adopting a phantom.
    expect(createInstanceMock).toHaveBeenCalledTimes(1);
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
    // next tick around the same loop. The orphan sweep owns it from here.
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
