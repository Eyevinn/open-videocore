// Issue #1325: the scaler must not take over an Encore instance that does not
// exist.
//
// INCIDENT (from the report): three createInstance attempts for the second
// Encore instance all answered 504 Gateway Time-out ("timed out at the gateway
// after 60057ms"). At ~13:14:30 the scaler logged that Encore 2 had appeared and
// took it over; at 13:16:50 and again at 13:18:23 OSC reported that the instance
// does not exist. The scaler then stood still for at least four minutes — no new
// job went to Encore 1, which was healthy, and the queued jobs sat there with no
// error — and a callback listener had been created against the missing instance
// and had to be deleted by hand.
//
// WHY THE TAKEOVER COULD FIRE ON NOTHING. #1286 added the last-attempt takeover:
// once every create attempt has ended at the gateway, the spawn watches the SAME
// instance name for a bounded time and adopts the instance when it appears,
// instead of letting the next tick invent a new name. "It appeared" was read
// straight off `getInstance`, and that is not proof: `getInstance` returns
// whatever an ok response carried, parsed as JSON when the content type says so
// and as TEXT otherwise (@osaas/client-core@0.24.0 lib/core.js:119-150,
// lib/fetch.js:20-37), so any 200 on that path reads as an instance. The rest of
// the spawn then paid for it: the listener was created, the readiness wait polled
// a name OSC did not know (a REJECTING probe is "not ready yet" to
// waitForInstanceReadyBounded, src/services/instance-readiness.ts, so it retried
// to its deadline), and because the spawn is awaited INSIDE the tick
// (EncoreScalerLoop.tick step 3, scaler-loop.ts) nothing else in that tick ran —
// including step 5, dispatch.
//
// WHAT THIS SUITE PINS DOWN:
//   1. A takeover candidate whose existence check reports "does not exist" is
//      NOT adopted: no pool record, no callback listener, and the spawn fails
//      with the CREATE's error so the #1322 back-off applies.
//   2. The failed takeover does not block the tick: a healthy instance in the
//      pool still gets the queued job, in the same tick, without waiting out the
//      takeover watch or a readiness budget.
//   3. The existence check itself: OSC answering for the instance is 'exists', a
//      404/"does not exist" is 'absent', and anything else is 'unknown' — never
//      read as either (the #1071 rule that `undefined`/a failed probe means
//      "could not confirm").
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7):
//   - spawnInstance(config, maxAttempts = 3, hooks?): Promise<EncoreInstanceRecord>,
//     encoreInstanceExistence(config, name, sat): Promise<OscInstanceExistence>,
//     ENCORE_SERVICE_ID = 'encore', ENCORE_CALLBACK_LISTENER_SERVICE_ID,
//     SPAWN_ADOPT_PROBE_MIN_CREATE_DURATION_MS,
//     DEFAULT_SPAWN_ADOPT_PROBE_TIMEOUT_MS — src/encore-scaler/instance-pool.ts.
//   - readSpawnFailure(redis, workspaceId): Promise<SpawnFailureRecord|undefined>
//     with { at, attempts, consecutiveFailures, message, httpCode? } —
//     src/encore-scaler/spawn-failure.ts, src/encore-scaler/types.ts.
//   - EncoreScalerLoop.tick() — src/encore-scaler/scaler-loop.ts; JOBS_PER_INSTANCE,
//     keys.pool / keys.queue / keys.jobInstance / keys.jobStatus /
//     keys.spawnFailure, EncoreInstanceRecord fields (`activeJobs`, `readyAt`,
//     `lastIdleAt`, `callbackListenerUrl`, `callbackTrustReady`,
//     `callbackTrustConfirmedAt`) — src/encore-scaler/types.ts.
//   - @osaas/client-core@0.24.0: createInstance(context, serviceId, token, body)
//     (lib/core.js:76-90), getInstance(context, serviceId, name, token)
//     (lib/core.js:119-150 — rethrows only 401, so undefined is "could not
//     confirm"), getInstanceHealth(context, serviceId, name, token): Promise<string>
//     (lib/core.d.ts:86, lib/core.js:211-220 — the status field of the control
//     plane's GET /health/{name}), listInstances(context, serviceId, token)
//     (lib/core.js:160-171), removeInstance (lib/core.d.ts:46);
//     lib/fetch.d.ts `class FetchError extends Error { httpCode?: number }` with
//     `httpCode: response.status` from defaultErrorFactory — which is why the
//     doubles below are Errors carrying httpCode and the 504 body is an HTML page.
//   - Encore `GET /encoreJobs/search/findByStatus?...` HATEOAS page and
//     `POST /encoreJobs` -> `{ id }` — src/encore-scaler/encore-paging-contract.ts
//     and EncoreScalerLoop.dispatch, src/encore-scaler/scaler-loop.ts.

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
  DEFAULT_SPAWN_ADOPT_PROBE_TIMEOUT_MS,
  ENCORE_CALLBACK_LISTENER_SERVICE_ID,
  ENCORE_SERVICE_ID,
  encoreInstanceExistence,
  SPAWN_ADOPT_PROBE_MIN_CREATE_DURATION_MS,
  spawnInstance
} from '../src/encore-scaler/instance-pool.js';
import { EncoreScalerLoop } from '../src/encore-scaler/scaler-loop.js';
import { readSpawnFailure } from '../src/encore-scaler/spawn-failure.js';
import {
  keys,
  type EncoreInstanceRecord,
  type EncoreScalerConfig
} from '../src/encore-scaler/types.js';

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

// What OSC answered when asked about the instance it had just reported: the
// control plane does not know it (GET /health/{name} -> 404).
const doesNotExist = (name: string): FakeFetchError =>
  new FakeFetchError(`Instance ${name} does not exist`, 404);

// How long the real gateway waits before answering 504 (OSC ingress limit). The
// create keeps running on the platform side past this point, which is the whole
// reason #1286 watches the name at all — and the reason the watch has to be able
// to tell "still coming" from "never existed".
const INGRESS_LIMIT_MS = 60_000;

// Minimal in-memory Valkey covering the commands the pool helpers, the spawn
// failure record and one full tick touch.
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
  async lpush(key: string, value: string): Promise<number> {
    const l = this.list(key);
    l.unshift(value);
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
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const l = this.lists.get(key) ?? [];
    return stop === -1 ? l.slice(start) : l.slice(start, stop + 1);
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
  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }
  async pexpire(): Promise<number> {
    return 1;
  }
  async expire(): Promise<number> {
    return 1;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? new Map());
  }
  async hkeys(key: string): Promise<string[]> {
    return [...(this.hashes.get(key)?.keys() ?? [])];
  }
  async hget(key: string, field: string): Promise<string | null> {
    return this.hashes.get(key)?.get(field) ?? null;
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
  async hincrby(key: string, field: string, by: number): Promise<number> {
    const next = Number(this.hash(key).get(field) ?? '0') + by;
    this.hash(key).set(field, String(next));
    return next;
  }
  async set(key: string, value: string, ..._options: unknown[]): Promise<'OK'> {
    this.strings.set(key, String(value));
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async incr(key: string): Promise<number> {
    const next = Number(this.strings.get(key) ?? '0') + 1;
    this.strings.set(key, String(next));
    return next;
  }
  async del(...keyList: string[]): Promise<number> {
    let removed = 0;
    for (const key of keyList) {
      if (this.strings.delete(key)) removed += 1;
      this.hashes.delete(key);
      this.lists.delete(key);
      this.sets.delete(key);
    }
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

const WORKSPACE = 'ws1325';
const SERVICE_ACCESS_TOKEN = 'sat-live-0123456789abcdef';
// The Encore instance that is running fine throughout the incident ("Encore 1").
const HEALTHY_ID = 'encoreone';
const HEALTHY_URL = 'https://encoreone.auto.prod-se.osaas.io';
const HEALTHY_LISTENER_URL = 'https://encoreone-cb.auto.prod-se.osaas.io';

function makeConfig(
  redis: FakeRedis,
  overrides: Partial<EncoreScalerConfig> = {}
): EncoreScalerConfig {
  return {
    workspaceId: WORKSPACE,
    maxInstances: 4,
    minInstances: 0,
    idleTimeoutMs: 10 * 60_000,
    redisUrl: 'redis://fake-valkey:6379',
    oscContext: {
      getServiceAccessToken: async () => SERVICE_ACCESS_TOKEN
    } as unknown as EncoreScalerConfig['oscContext'],
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => SERVICE_ACCESS_TOKEN,
    // Instant readiness: none of these tests is about the readiness wait. (If
    // the takeover adopted the missing instance, this is also what would make
    // its readiness poll visible rather than a 15-minute hang.)
    spawnReadyTimeoutMs: 2_000,
    spawnReadyPollIntervalMs: 1,
    ...overrides
  };
}

// A create that behaves like the real one behind an ingress timeout: it RUNS for
// the gateway's limit and only then rejects with the 504 page. Non-Encore
// services (the paired callback listener) are created normally, so a listener
// created against a missing instance shows up as a call rather than as an error.
function gatewayTimingOutCreate(): (...args: unknown[]) => Promise<unknown> {
  return async (...args: unknown[]) => {
    const serviceId = args[1] as string;
    const body = args[3] as { name: string };
    if (serviceId !== ENCORE_SERVICE_ID) {
      return { name: body.name, url: `https://${body.name}-cb.osc.example` };
    }
    await new Promise((r) => setTimeout(r, INGRESS_LIMIT_MS));
    throw gatewayTimeout();
  };
}

// The phantom: OSC answers the instance GET with a perfectly well-formed
// instance body (the takeover candidate) while the control plane says the
// instance does not exist.
function phantomInstanceOnOsc(): void {
  getInstanceMock.mockImplementation(async (...args: unknown[]) => {
    const serviceId = args[1] as string;
    const name = args[2] as string;
    if (serviceId !== ENCORE_SERVICE_ID) return undefined;
    return { name, url: `https://${name}.osc.example` };
  });
  getInstanceHealthMock.mockImplementation(async (...args: unknown[]) => {
    const name = args[2] as string;
    if (name === HEALTHY_ID) return 'running';
    throw doesNotExist(name);
  });
  // OSC's own instance list for the service — the authoritative existence
  // answer this module already uses for eviction. It carries the instance that
  // is running and NOT the one the takeover is about, which is what makes the
  // control plane's 404 two independent sources agreeing.
  oscListInstancesMock.mockResolvedValue([{ name: HEALTHY_ID, url: HEALTHY_URL }]);
}

function seedHealthyInstance(redis: FakeRedis, now: number): EncoreInstanceRecord {
  const record: EncoreInstanceRecord = {
    instanceId: HEALTHY_ID,
    url: HEALTHY_URL,
    callbackListenerUrl: HEALTHY_LISTENER_URL,
    callbackTrustReady: true,
    callbackTrustConfirmedAt: now - 60_000,
    activeJobs: 0,
    lastIdleAt: now,
    readyAt: now - 120_000
  };
  const h = redis.hashes.get(keys.pool(WORKSPACE)) ?? new Map<string, string>();
  h.set(record.instanceId, JSON.stringify(record));
  redis.hashes.set(keys.pool(WORKSPACE), h);
  return record;
}

// The tick talks to Encore over HTTP: the per-instance active-state read
// (findByStatus) and the dispatch POST. The callback-trust probe is skipped for
// an instance that has already passed it (callbackTrustReady), so a 404 default
// is enough for anything else.
function stubFetchForTick(): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/encoreJobs/search/findByStatus')) {
      return new Response(
        JSON.stringify({
          _embedded: { encoreJobs: [] },
          page: { totalElements: 0, size: 500, number: 0 }
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }
    if (url.endsWith('/encoreJobs') && init?.method === 'POST') {
      return new Response(JSON.stringify({ id: 'encore-uuid-1325' }), {
        status: 201,
        headers: { 'content-type': 'application/json' }
      });
    }
    return new Response('', { status: 404 });
  });
  vi.stubGlobal('fetch', spy);
  return spy as unknown as ReturnType<typeof vi.fn>;
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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a takeover candidate that does not exist is not taken over (#1325)', () => {
  // Acceptance criterion 1: "The scaler only takes over an Encore instance that
  // actually exists. If the instance is not there, the spawn counts as failed."
  it('fails the spawn instead of adopting an instance OSC says does not exist', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    createInstanceMock.mockImplementation(gatewayTimingOutCreate());
    phantomInstanceOnOsc();

    const spawn = spawnInstance(makeConfig(redis)).catch((err: unknown) => err);
    // Three attempts of 60s, their 5s/10s back-offs, and more than the whole
    // takeover watch budget on top: there is no answer coming that changes this.
    await vi.advanceTimersByTimeAsync(
      3 * INGRESS_LIMIT_MS + 15_000 + DEFAULT_SPAWN_ADOPT_PROBE_TIMEOUT_MS + 60_000
    );
    const result = (await spawn) as Error;

    // The CREATE's error is what the spawn fails with — the 504 the operator saw
    // three times, not the existence check's answer.
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain('504 Gateway Time-out');
    // NOT ADOPTED: nothing in the pool, under any name. Not a ready record and
    // not a PENDING one either — a pending record holds a slot under
    // maxInstances and is what resolvePendingSpawns would keep waiting on.
    expect(Object.keys(await redis.hgetall(keys.pool(WORKSPACE)))).toHaveLength(0);
    // NO CALLBACK LISTENER was created for it. In the incident the orphaned
    // listener had to be deleted by hand.
    expect(
      createInstanceMock.mock.calls.filter(
        (call) => call[1] === ENCORE_CALLBACK_LISTENER_SERVICE_ID
      )
    ).toHaveLength(0);
    // The existence question was asked about the name the creates used, on the
    // Encore service, with the token the spawn already held.
    const encoreCreateNames = new Set(
      createInstanceMock.mock.calls
        .filter((call) => call[1] === ENCORE_SERVICE_ID)
        .map((call) => (call[3] as { name: string }).name)
    );
    expect(encoreCreateNames.size).toBe(1);
    const name = [...encoreCreateNames][0] as string;
    expect(getInstanceHealthMock).toHaveBeenCalledWith(
      expect.anything(),
      ENCORE_SERVICE_ID,
      name,
      SERVICE_ACCESS_TOKEN
    );
    // Nothing was destroyed: this spawn never created an instance, so the
    // adopted-vs-created cleanup rule (#1071, #417/#736) has nothing to remove —
    // and a removeInstance against a name that does not exist would be the same
    // guess in the other direction.
    expect(removeInstanceMock).not.toHaveBeenCalled();
    // The spawn COUNTS AS FAILED, with the gateway status, which is what the
    // #1322 back-off and GET /scaler/status read.
    const failure = await readSpawnFailure(
      redis as unknown as Parameters<typeof readSpawnFailure>[0],
      WORKSPACE
    );
    expect(failure?.httpCode).toBe(504);
    expect(failure?.message).toContain('504 Gateway Time-out');
  });

  // The watch must not keep asking after a definitive answer: every second here
  // is a second the tick is not dispatching (the spawn is awaited inside it).
  it('stops watching the name as soon as OSC says it does not exist', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    createInstanceMock.mockImplementation(gatewayTimingOutCreate());
    phantomInstanceOnOsc();

    const spawn = spawnInstance(
      makeConfig(redis, {
        spawnAdoptProbeTimeoutMs: 90_000,
        spawnAdoptProbeIntervalMs: 5_000
      })
    ).catch((err: unknown) => err);
    // Only the three attempts and their back-offs, with a second of slack — far
    // less than the 90s watch budget.
    await vi.advanceTimersByTimeAsync(3 * INGRESS_LIMIT_MS + 15_000 + 1_000);
    const result = (await spawn) as Error;

    // Already settled, i.e. the watch did not spend its budget re-asking about
    // an instance that was answered for.
    expect(result).toBeInstanceOf(Error);
    expect(result.message).toContain('504 Gateway Time-out');
    expect(getInstanceMock.mock.calls.length).toBeLessThanOrEqual(2);
    // A 504 that never ran long enough to have a create behind it is still not
    // watched at all (#1286), so the floor on evidence stays meaningful.
    expect(SPAWN_ADOPT_PROBE_MIN_CREATE_DURATION_MS).toBeLessThan(INGRESS_LIMIT_MS);
  });

  // Acceptance criterion 2: "jobs keep going to the Encore instances that are
  // running". The incident's stall was >= 4 minutes with Encore 1 healthy.
  it('still dispatches queued work to the healthy instance in the same tick', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    const redis = new FakeRedis();
    const now = Date.now();
    seedHealthyInstance(redis, now);
    // One queued job, and a pre-warm floor of two instances so the scale-up
    // gate fires on this tick while the healthy instance still has capacity to
    // take the job (JOBS_PER_INSTANCE = 1, src/encore-scaler/types.ts).
    const job = JSON.stringify({
      jobId: `${WORKSPACE}__job-2`,
      payload: { externalId: `${WORKSPACE}__job-2` },
      enqueuedAt: now
    });
    await redis.rpush(keys.queue(WORKSPACE), job);
    createInstanceMock.mockImplementation(gatewayTimingOutCreate());
    phantomInstanceOnOsc();
    const fetchSpy = stubFetchForTick();

    const loop = new EncoreScalerLoop(
      makeConfig(redis, {
        minInstances: 2,
        // Shorter than the default so the assertion below is about the takeover
        // path and not about how long the watch is allowed to be.
        spawnAdoptProbeTimeoutMs: 30_000,
        spawnAdoptProbeIntervalMs: 5_000
      })
    );
    let settled = false;
    const tick = loop.tick().then(() => {
      settled = true;
    });
    // The three timed-out creates and their back-offs, plus a second. The tick
    // must be DONE by then: a takeover would have added the watch budget and
    // then a readiness poll against an instance OSC does not know.
    await vi.advanceTimersByTimeAsync(3 * INGRESS_LIMIT_MS + 15_000 + 1_000);
    expect(settled).toBe(true);
    await tick;

    // THE POINT: the queued job went to the healthy instance on this very tick,
    // and did not sit still with no error.
    expect(await redis.hget(keys.jobInstance(WORKSPACE), `${WORKSPACE}__job-2`)).toBe(
      HEALTHY_ID
    );
    expect(await redis.hget(keys.jobStatus(WORKSPACE), `${WORKSPACE}__job-2`)).toBe(
      'running'
    );
    expect(await redis.llen(keys.queue(WORKSPACE))).toBe(0);
    const dispatched = fetchSpy.mock.calls.filter(
      ([input, init]) =>
        String(input) === `${HEALTHY_URL}/encoreJobs` &&
        (init as RequestInit | undefined)?.method === 'POST'
    );
    expect(dispatched).toHaveLength(1);
    // The pool still holds exactly the instance that was already there: the
    // missing one was not taken over, under its own name or any other.
    expect(Object.keys(await redis.hgetall(keys.pool(WORKSPACE)))).toEqual([HEALTHY_ID]);
    // And it got no callback listener.
    expect(
      createInstanceMock.mock.calls.filter(
        (call) => call[1] === ENCORE_CALLBACK_LISTENER_SERVICE_ID
      )
    ).toHaveLength(0);
    // The healthy instance is the one that was dispatched to, so its tracked
    // count moved — the capacity that existed was used.
    const pooled = JSON.parse(
      (await redis.hget(keys.pool(WORKSPACE), HEALTHY_ID)) as string
    ) as EncoreInstanceRecord;
    expect(pooled.activeJobs).toBe(1);
  });
});

describe('the existence check never guesses (#1325)', () => {
  it('reads an answer from OSC as exists, a 404 as absent, and anything else as unknown', async () => {
    const redis = new FakeRedis();
    const config = makeConfig(redis);

    // OSC answers for the instance — including with a state that is not ready
    // yet. Existing is not the same question as being ready, and 'pending' is
    // exactly what a node still being provisioned reports.
    getInstanceHealthMock.mockResolvedValue('pending');
    expect(await encoreInstanceExistence(config, 'scalerpending', SERVICE_ACCESS_TOKEN)).toBe(
      'exists'
    );

    // The control plane does not know it, and its instance list does not carry
    // it either: two independent sources agreeing.
    getInstanceHealthMock.mockRejectedValue(doesNotExist('scalerghost'));
    oscListInstancesMock.mockResolvedValue([{ name: HEALTHY_ID, url: HEALTHY_URL }]);
    expect(await encoreInstanceExistence(config, 'scalerghost', SERVICE_ACCESS_TOKEN)).toBe(
      'absent'
    );

    // The two sources DISAGREE (a 404 on the health route for a name the service
    // still lists). That is not proof of absence, so it is not read as one.
    oscListInstancesMock.mockResolvedValue([
      { name: 'scalerghost', url: 'https://scalerghost.osc.example' }
    ]);
    expect(await encoreInstanceExistence(config, 'scalerghost', SERVICE_ACCESS_TOKEN)).toBe(
      'unknown'
    );

    // OSC trouble says nothing either way: a 500, a 504 and a dropped socket are
    // all "could not confirm" (#1071), never "absent" and never "exists".
    oscListInstancesMock.mockResolvedValue([]);
    for (const err of [
      new FakeFetchError('internal error', 500),
      gatewayTimeout(),
      new FakeFetchError('ECONNRESET')
    ]) {
      getInstanceHealthMock.mockRejectedValue(err);
      expect(
        await encoreInstanceExistence(config, 'scalerunknown', SERVICE_ACCESS_TOKEN)
      ).toBe('unknown');
    }
  });
});

// Review finding on PR #1327: 'absent' must come from a POSITIVE, enumerated
// not-found and from nothing else.
//
// WHY THE FIRST CUT OF THIS WAS WRONG. It read the verdict off
// getInstanceHealth's rejection, on the belief that rejecting meant the control
// plane had answered about this one instance. It had not. In the pinned
// @osaas/client-core@0.24.0 the call is getInstanceHealth -> getInstanceLink ->
// getInstance, and `getInstance` (lib/core.js:119-150) returns `undefined` for
// EVERY failure but 401 — it rethrows UnauthorizedError, maps a 404 to
// `undefined`, and falls through to `return undefined` for a 500, a 504 or a
// dropped socket alike. `getInstanceLink` (lib/core.js:24-28) then throws a
// plain `Error("Instance {name} of service {serviceId} not found")` with no
// httpCode, which isInstanceAlreadyGoneError matches on its 'not found' marker.
// So a TRANSIENT control-plane fault — the very condition behind the three
// consecutive gateway timeouts in #1325 — was indistinguishable from "does not
// exist". Two more routes reached 'absent' with nothing having answered: a
// failed listInstances cross-check, and a list body that is not an array.
//
// THE COST OF GETTING IT WRONG IN THAT DIRECTION is the opposite of #1325 and
// worse than it: an instance that DID land behind the 504 is declared absent, so
// it is never adopted (instanceAdopted stays false) and never removed (the
// create's error is rethrown before the cleanup block) — a live instance,
// billing, that nothing in the system owns.
describe('an indeterminate control-plane fault is not an absence (#1327)', () => {
  // The exact error the SDK produces when the control plane faults on the way to
  // the health route: a plain Error, no httpCode, 'not found' in the message.
  const instanceLinkNotFound = (name: string): Error =>
    new Error(`Instance ${name} of service ${ENCORE_SERVICE_ID} not found`);

  it('reports unknown, not absent, when nothing authoritative has answered', async () => {
    const config = makeConfig(new FakeRedis());

    // 1. The not-found-SHAPED rejection a transient fault produces, with the
    //    instance list unreadable as well: nothing has answered at all.
    getInstanceHealthMock.mockRejectedValue(instanceLinkNotFound('scalerfault'));
    oscListInstancesMock.mockRejectedValue(new FakeFetchError('internal error', 500));
    expect(await encoreInstanceExistence(config, 'scalerfault', SERVICE_ACCESS_TOKEN)).toBe(
      'unknown'
    );

    // 2. Even a real 404 on the health route is only ONE source. With the
    //    enumeration unreadable it cannot be promoted to a verdict — this is the
    //    case that used to let "the single-instance answer stand on its own".
    getInstanceHealthMock.mockRejectedValue(doesNotExist('scalerfault'));
    oscListInstancesMock.mockRejectedValue(gatewayTimeout());
    expect(await encoreInstanceExistence(config, 'scalerfault', SERVICE_ACCESS_TOKEN)).toBe(
      'unknown'
    );

    // 3. A list that came back OK but is not an array. createFetch hands back
    //    whatever an ok response carried, parsed as JSON when the content type
    //    says so and as TEXT otherwise, so a gateway interstitial page or an
    //    empty body arrives here as a string or an object. Neither enumerates
    //    anything, and neither may fall through to 'absent'.
    for (const body of [GATEWAY_TIMEOUT_HTML, '', {}, null]) {
      oscListInstancesMock.mockResolvedValue(body as unknown as unknown[]);
      expect(
        await encoreInstanceExistence(config, 'scalerfault', SERVICE_ACCESS_TOKEN)
      ).toBe('unknown');
    }

    // The positive case still resolves, so this has not simply disabled the
    // check: OSC enumerated the service and the name is not among them.
    oscListInstancesMock.mockResolvedValue([{ name: HEALTHY_ID, url: HEALTHY_URL }]);
    expect(await encoreInstanceExistence(config, 'scalerfault', SERVICE_ACCESS_TOKEN)).toBe(
      'absent'
    );
  });

  // The orphan the finding is about, end to end: the create landed behind the
  // 504 and the control plane is faulting. The watch must NOT write the instance
  // off on the first fault — it must keep looking within its budget and adopt it
  // once OSC can answer, because walking away leaves it live with no owner.
  it('keeps the watch alive through a fault and adopts the instance that did land', async () => {
    vi.useFakeTimers();
    const redis = new FakeRedis();
    createInstanceMock.mockImplementation(gatewayTimingOutCreate());
    // The create DID complete on the platform side, so OSC reports a perfectly
    // well-formed instance under the name the creates used.
    getInstanceMock.mockImplementation(async (...args: unknown[]) => {
      const serviceId = args[1] as string;
      const name = args[2] as string;
      if (serviceId !== ENCORE_SERVICE_ID) return undefined;
      return { name, url: `https://${name}.osc.example` };
    });
    // The control plane faults for the first two probes and recovers on the
    // third. Before this fix the first probe ended the watch with 'absent'.
    let healthCalls = 0;
    getInstanceHealthMock.mockImplementation(async (...args: unknown[]) => {
      const name = args[2] as string;
      healthCalls += 1;
      if (healthCalls <= 2) throw instanceLinkNotFound(name);
      return 'running';
    });
    // And the cross-check cannot be read either, so nothing can prove absence.
    oscListInstancesMock.mockRejectedValue(new FakeFetchError('internal error', 500));
    stubFetchForTick();

    const spawn = spawnInstance(
      makeConfig(redis, {
        spawnAdoptProbeTimeoutMs: 90_000,
        spawnAdoptProbeIntervalMs: 5_000
      })
    );
    await vi.advanceTimersByTimeAsync(3 * INGRESS_LIMIT_MS + 15_000 + 90_000 + 10_000);
    const record = await spawn;

    // ADOPTED, not orphaned. The spawn resolved with the instance the 504s left
    // behind, under the one name they were sent.
    const encoreCreateNames = new Set(
      createInstanceMock.mock.calls
        .filter((call) => call[1] === ENCORE_SERVICE_ID)
        .map((call) => (call[3] as { name: string }).name)
    );
    expect(encoreCreateNames.size).toBe(1);
    const name = [...encoreCreateNames][0] as string;
    expect(record.instanceId).toBe(name);
    expect(record.url).toBe(`https://${name}.osc.example`);
    // It is in the pool, so it is tracked, counted against maxInstances and
    // dispatched to — the opposite of the live-with-no-owner outcome.
    expect(Object.keys(await redis.hgetall(keys.pool(WORKSPACE)))).toContain(name);
    // The watch really did keep going through the faults rather than settling on
    // the first one: adoption got more than a single probe.
    expect(healthCalls).toBeGreaterThanOrEqual(3);
    // Nothing was destroyed on the way: an adopted instance is never torn down
    // by the cleanup rule (#1071, #417/#736).
    expect(
      removeInstanceMock.mock.calls.filter((call) => call[1] === ENCORE_SERVICE_ID)
    ).toHaveLength(0);
  });
});
