// A scale-up that CANNOT spawn must be visible (issue #1071).
//
// Before this, the scale-up gate (scaler-loop.ts tick step 3) called
// spawnInstance() bare. spawnInstance retries transient OSC errors and then
// throws, and that throw was caught only by the interval wrapper, which logged
// "[encore-scaler] tick error" and waited for the next tick. Two things were
// wrong with that:
//
//   1. NOTHING was recorded anywhere an operator could see. GET /scaler/status
//      returned workspaces[]/maxInstances/jobsPerInstance/idleTimeoutMs/
//      scalerActive and no spawn-failure anything, so a scaler sitting at
//      `instances: 1, queueDepth: 1` looked identical whether the cap was 1 or
//      whether OSC was refusing to create the instance.
//   2. The throw ABORTED THE WHOLE TICK. Everything after the gate — scale-down
//      (step 4), the orphan sweep (4b) and dispatch (5) — was skipped for as
//      long as spawning kept failing. On the belowMin pre-warm path the gate
//      fires every tick regardless of pending work, so such a workspace also
//      stopped dispatching to the capacity it already had.
//
// These tests run WITHOUT a real Valkey and WITHOUT OSC: the @osaas/client-core
// calls instance-pool.ts makes are mocked (so the REAL spawnInstance failure
// path runs and does the real recording) and global.fetch is stubbed for the
// Encore findByStatus pages, the callback-trust probe and the dispatch POST.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - EncoreScalerLoop.tick (src/encore-scaler/scaler-loop.ts): step 3's gate
//     `instances.length < maxInstances && (belowMin || (pending > 0 && allBusy))`
//     with `allBusy = instances.every(i => i.activeJobs >= JOBS_PER_INSTANCE)`,
//     step 4b reapOrphansIfDue(), step 5's dispatch loop.
//   - spawnInstance(config, maxAttempts = 3) (src/encore-scaler/instance-pool.ts)
//     — its createInstance retry loop only retries transient 5xx/ORCHESTRATOR_*/
//     ECONNRESET/"context deadline exceeded" text, and now records the failure
//     via recordSpawnFailure / clears it via clearSpawnFailure.
//   - @osaas/client-core createInstance / getInstanceHealth / removeInstance /
//     listInstances — the exact four functions instance-pool.ts imports
//     (lib/core.d.ts; getInstanceHealth resolves the health string, 'running'
//     being ready).
//   - SpawnFailureRecord { at, attempts, consecutiveFailures, message } and
//     keys.spawnFailure(workspaceId) (src/encore-scaler/types.ts); read/write
//     helpers readSpawnFailure/recordSpawnFailure/clearSpawnFailure and
//     redactSpawnFailureMessage (src/encore-scaler/spawn-failure.ts).
//   - Response schema: `spawnFailureSchema` on `workspaceSchema` in
//     src/routes/scaler.ts — workspaces[].spawnFailure?: { at, attempts,
//     consecutiveFailures, message }.
//   - Encore findByStatus HATEOAS page shape
//     { _embedded: { encoreJobs: [{ externalId }] }, page: { totalElements } }
//     (src/encore-scaler/encore-active-state.ts, via fetchRealActiveState).
//   - Callback-trust probe: HEAD {callbackListenerUrl}/encoreCallback, where any
//     non-401/403 response counts as trusted (src/encore-scaler/
//     callback-trust-probe.ts probeCallbackTrust/buildCallbackUri).
//   - JOBS_PER_INSTANCE, keys.pool/queue/jobInstance (src/encore-scaler/types.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';

// Mock the OSC SDK rather than instance-pool itself: the recording under test
// lives INSIDE spawnInstance, so the real function has to run.
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
import { spawnInstance } from '../src/encore-scaler/instance-pool.js';
import { scalerRouter } from '../src/routes/scaler.js';
import {
  clearSpawnFailure,
  readSpawnFailure,
  recordSpawnFailure,
  redactSpawnFailureMessage,
  SPAWN_FAILURE_MESSAGE_MAX_LENGTH
} from '../src/encore-scaler/spawn-failure.js';
import {
  JOBS_PER_INSTANCE,
  keys,
  type EncoreInstanceRecord,
  type EncoreScalerConfig
} from '../src/encore-scaler/types.js';

// A minimal in-memory Valkey covering the commands the tick, the pool helpers,
// the spawn-failure record and the status route touch.
class FakeRedis {
  private hashes = new Map<string, Map<string, string>>();
  private lists = new Map<string, string[]>();
  private sets = new Map<string, Set<string>>();
  private strings = new Map<string, string>();

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
  // The spawn-failure record is a plain string key with a PX TTL; the fake
  // ignores expiry (no test depends on it) but accepts the option arguments
  // ioredis takes.
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
      ...this.lists.keys(),
      ...this.sets.keys(),
      ...this.strings.keys()
    ];
    return ['0', [...new Set(all)].filter((k) => k.startsWith(prefix))];
  }
}

const OSC_CONTEXT_STUB = {
  getServiceAccessToken: async () => SERVICE_ACCESS_TOKEN
} as unknown as EncoreScalerConfig['oscContext'];

// Values a spawn legitimately carries and that an OSC error can echo back.
const SERVICE_ACCESS_TOKEN = 'sat-live-0123456789abcdef';
const OBJECT_STORE_SECRET = 'rootpass-do-not-leak-0001';
const BEARER_TOKEN = 'tok-abcdef1234567890';
const ORCHESTRATOR_URL = 'https://orchestrator.example/v1/service/encore/instance';

function makeConfig(
  redis: FakeRedis,
  workspaceId: string,
  overrides: Partial<EncoreScalerConfig> = {}
): EncoreScalerConfig {
  return {
    workspaceId,
    maxInstances: 3,
    minInstances: 0,
    idleTimeoutMs: 10_000,
    redisUrl: 'redis://fake-valkey:6379',
    oscContext: OSC_CONTEXT_STUB,
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => SERVICE_ACCESS_TOKEN,
    s3Config: {
      endpoint: 'https://objectstore.example',
      accessKeyId: 'storage-admin',
      secretAccessKey: OBJECT_STORE_SECRET
    },
    // Keep the bounded readiness wait instant for the success path.
    spawnReadyTimeoutMs: 2_000,
    spawnReadyPollIntervalMs: 1,
    ...overrides
  };
}

function poolRecord(
  instanceId: string,
  overrides: Partial<EncoreInstanceRecord> = {}
): EncoreInstanceRecord {
  return {
    instanceId,
    url: `https://${instanceId}.example`,
    activeJobs: 0,
    lastIdleAt: Date.now(),
    readyAt: Date.now(),
    // Pre-confirmed trust so the dispatch gate does not probe an existing
    // instance; the freshly spawned one in the scale-up test is probed for real
    // (against the stubbed fetch), which is the point of that test.
    callbackTrustReady: true,
    ...overrides
  };
}

// An Encore findByStatus HATEOAS page with `count` active jobs.
function statusPage(count: number): Response {
  const encoreJobs = Array.from({ length: count }, (_, i) => ({ externalId: `ext-${i}` }));
  return new Response(
    JSON.stringify({ _embedded: { encoreJobs }, page: { totalElements: count } }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

// Answer the three kinds of HTTP call a tick makes: the per-instance active-state
// query, the callback-trust HEAD probe, and the dispatch POST.
function stubTickFetch(activePerInstance = 0): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('/encoreJobs/search/findByStatus')) {
      return statusPage(url.includes('status=QUEUED') ? 0 : activePerInstance);
    }
    if (url.endsWith('/encoreCallback')) {
      // Any non-401/403 answer means the handshake completed -> trusted.
      return new Response('', { status: 404 });
    }
    if (url.endsWith('/encoreJobs') && (init?.method ?? 'GET') === 'POST') {
      return new Response(JSON.stringify({ id: 'encore-uuid-1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' }
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

// A non-transient OSC rejection (no 5xx / ORCHESTRATOR_* / ECONNRESET /
// "context deadline exceeded" text), so spawnInstance fails on the first
// attempt without its back-off sleeps. The text deliberately carries every
// class of thing that must never reach the wire: a credential we passed, a
// bearer token, and a URL.
function orchestratorRefusal(): Error {
  return new Error(
    `createInstance failed: 403 Forbidden from ${ORCHESTRATOR_URL} ` +
      `(authorization: Bearer ${BEARER_TOKEN}) ` +
      `body={"name":"scalerws","s3SecretAccessKey":"${OBJECT_STORE_SECRET}"}`
  );
}

async function buildStatusApp(redis: FakeRedis, maxInstances = 3): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(scalerRouter, {
    prefix: '/scaler',
    redis: redis as unknown as Redis,
    maxInstances,
    minInstances: 0,
    idleTimeoutMs: 300_000
  });
  await app.ready();
  return app;
}

type StatusWorkspace = {
  workspaceId: string;
  queueDepth: number;
  instances: Array<Record<string, unknown>>;
  spawnFailure?: {
    at: number;
    attempts: number;
    consecutiveFailures: number;
    message: string;
  };
};

describe('spawn-failure message redaction (issue #1071)', () => {
  it('strips the credentials, tokens and URLs an OSC error can echo back', () => {
    const message = redactSpawnFailureMessage(orchestratorRefusal(), [
      SERVICE_ACCESS_TOKEN,
      OBJECT_STORE_SECRET
    ]);

    expect(message).not.toContain(OBJECT_STORE_SECRET);
    expect(message).not.toContain(BEARER_TOKEN);
    expect(message).not.toContain(SERVICE_ACCESS_TOKEN);
    expect(message).not.toContain('orchestrator.example');
    expect(message).not.toContain('https://');
    // The SHAPE of the failure is what the operator needs, and it survives.
    expect(message).toContain('403 Forbidden');
    expect(message).toContain('createInstance failed');
  });

  it('redacts a credential-named field even when its value was not known up front', () => {
    const message = redactSpawnFailureMessage(
      new Error('rejected: {"apiKey":"unknown-value-9999","password":"hunter2hunter2"}')
    );

    expect(message).not.toContain('unknown-value-9999');
    expect(message).not.toContain('hunter2hunter2');
    expect(message).toContain('rejected');
  });

  it('truncates a wall of upstream text and never yields an empty message', () => {
    const long = redactSpawnFailureMessage(new Error('x'.repeat(5_000)));
    expect(long.length).toBeLessThanOrEqual(SPAWN_FAILURE_MESSAGE_MAX_LENGTH);

    expect(redactSpawnFailureMessage(new Error(''))).not.toBe('');
    expect(redactSpawnFailureMessage(undefined)).not.toBe('');
  });
});

describe('spawn-failure record (issue #1071)', () => {
  it('counts consecutive failures and is cleared outright', async () => {
    const redis = new FakeRedis();

    const first = await recordSpawnFailure(redis as unknown as Redis, 'ws-count', {
      attempts: 3,
      error: new Error('first')
    });
    expect(first).toMatchObject({ attempts: 3, consecutiveFailures: 1 });

    const second = await recordSpawnFailure(redis as unknown as Redis, 'ws-count', {
      attempts: 1,
      error: new Error('second')
    });
    expect(second).toMatchObject({ attempts: 1, consecutiveFailures: 2 });
    expect(await readSpawnFailure(redis as unknown as Redis, 'ws-count')).toMatchObject({
      consecutiveFailures: 2
    });

    await clearSpawnFailure(redis as unknown as Redis, 'ws-count');
    expect(await readSpawnFailure(redis as unknown as Redis, 'ws-count')).toBeUndefined();
  });

  it('treats a junk record as absent rather than failing the reader', async () => {
    const redis = new FakeRedis();
    await redis.set(keys.spawnFailure('ws-junk'), 'not json at all');
    expect(await readSpawnFailure(redis as unknown as Redis, 'ws-junk')).toBeUndefined();

    await redis.set(keys.spawnFailure('ws-junk'), JSON.stringify({ message: 'no timestamp' }));
    expect(await readSpawnFailure(redis as unknown as Redis, 'ws-junk')).toBeUndefined();
  });
});

describe('a failed scale-up is visible and does not abort the tick (issue #1071)', () => {
  beforeEach(() => {
    createInstanceMock.mockReset();
    getInstanceHealthMock.mockClear();
    removeInstanceMock.mockClear();
    oscListInstancesMock.mockClear();
    oscListInstancesMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('records the failure, surfaces it on GET /scaler/status, and still runs the later steps', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-cannot-spawn';
    const instance = poolRecord('inst-a', { activeJobs: 0 });
    await redis.hset(keys.pool(workspaceId), instance.instanceId, JSON.stringify(instance));
    await redis.rpush(
      keys.queue(workspaceId),
      JSON.stringify({ jobId: 'job-1', payload: {}, enqueuedAt: Date.now() })
    );

    stubTickFetch(0);
    createInstanceMock.mockRejectedValue(orchestratorRefusal());

    // minInstances 2 with one pooled instance puts the tick on the belowMin
    // pre-warm path, which is where an aborting throw hurt most: the gate fires
    // on EVERY tick regardless of pending work.
    const config = makeConfig(redis, workspaceId, {
      minInstances: 2,
      maxInstances: 3,
      // Opt into the orphan sweep (step 4b) so "the tick carried on past the
      // gate" is directly observable; the sweep runs AFTER scale-down (step 4),
      // so seeing it prove step 4 completed too.
      orphanReapIntervalMs: 60_000
    });
    const loop = new EncoreScalerLoop(config);

    // The tick itself must not reject.
    await expect(loop.tick()).resolves.toBeUndefined();

    // 1. Recorded on the pool's own state.
    const record = await readSpawnFailure(redis as unknown as Redis, workspaceId);
    expect(record).toBeDefined();
    expect(record?.attempts).toBe(1); // a 403 is not retried
    expect(record?.consecutiveFailures).toBe(1);
    expect(record?.at).toBeGreaterThan(0);

    // 2. Surfaced by the status endpoint, credentials redacted.
    const app = await buildStatusApp(redis);
    try {
      const res = await app.inject({ method: 'GET', url: '/scaler/status' });
      expect(res.statusCode).toBe(200);
      const workspace = (res.json().workspaces as StatusWorkspace[]).find(
        (w) => w.workspaceId === workspaceId
      );
      expect(workspace?.spawnFailure).toMatchObject({
        attempts: 1,
        consecutiveFailures: 1
      });
      expect(workspace?.spawnFailure?.message).toContain('403 Forbidden');
      expect(workspace?.spawnFailure?.message).not.toContain(OBJECT_STORE_SECRET);
      expect(workspace?.spawnFailure?.message).not.toContain(BEARER_TOKEN);
      expect(workspace?.spawnFailure?.message).not.toContain(SERVICE_ACCESS_TOKEN);
      expect(workspace?.spawnFailure?.message).not.toContain('https://');
      // The operator can now tell "cannot spawn" from "at cap": the pool is
      // nowhere near maxInstances and the last attempt to grow failed.
      expect(workspace?.instances).toHaveLength(1);
      expect(res.json().maxInstances).toBe(3);
    } finally {
      await app.close();
    }

    // 3. Step 4b ran: the orphan sweep listed the Encore service on OSC.
    expect(oscListInstancesMock).toHaveBeenCalled();

    // 4. Step 5 ran: the queued job was dispatched to the capacity that already
    //    existed, rather than being stranded behind the failed spawn.
    expect(await redis.llen(keys.queue(workspaceId))).toBe(0);
    const mapping = await redis.hgetall(keys.jobInstance(workspaceId));
    expect(mapping['job-1']).toBe(instance.instanceId);
    const persisted = JSON.parse(
      (await redis.hgetall(keys.pool(workspaceId)))[instance.instanceId]!
    ) as EncoreInstanceRecord;
    expect(persisted.activeJobs).toBe(1);
  });

  it('keeps counting consecutive failures across ticks', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-persistent';
    const instance = poolRecord('inst-b', { activeJobs: JOBS_PER_INSTANCE });
    await redis.hset(keys.pool(workspaceId), instance.instanceId, JSON.stringify(instance));
    await redis.rpush(
      keys.queue(workspaceId),
      JSON.stringify({ jobId: 'job-2', payload: {}, enqueuedAt: Date.now() })
    );

    // Encore reports the instance genuinely busy, so it stays at the busy
    // threshold and the scale-up gate fires on every tick.
    stubTickFetch(1);
    createInstanceMock.mockRejectedValue(orchestratorRefusal());

    const loop = new EncoreScalerLoop(makeConfig(redis, workspaceId, { maxInstances: 2 }));
    await loop.tick();
    await loop.tick();

    const record = await readSpawnFailure(redis as unknown as Redis, workspaceId);
    expect(record?.consecutiveFailures).toBe(2);
  });

  it('records the real attempt count when every transient retry is exhausted', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-retries';
    createInstanceMock.mockRejectedValue(new Error('503 Service Unavailable'));

    vi.useFakeTimers();
    try {
      const pending = spawnInstance(makeConfig(redis, workspaceId), 3);
      const settled = expect(pending).rejects.toThrow(/503/);
      // Let both back-offs (5s, 10s) elapse.
      await vi.advanceTimersByTimeAsync(60_000);
      await settled;
    } finally {
      vi.useRealTimers();
    }

    expect(await readSpawnFailure(redis as unknown as Redis, workspaceId)).toMatchObject({
      attempts: 3,
      consecutiveFailures: 1
    });
  });
});

describe('scale-up still spawns when an instance is at the busy threshold (issue #1071)', () => {
  beforeEach(() => {
    createInstanceMock.mockReset();
    getInstanceHealthMock.mockClear();
    removeInstanceMock.mockClear();
    oscListInstancesMock.mockClear();
    oscListInstancesMock.mockResolvedValue([]);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('spawns a second instance on the same tick and clears any recorded failure', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-grows';
    const busy = poolRecord('inst-busy', { activeJobs: JOBS_PER_INSTANCE });
    await redis.hset(keys.pool(workspaceId), busy.instanceId, JSON.stringify(busy));
    await redis.rpush(
      keys.queue(workspaceId),
      JSON.stringify({ jobId: 'job-3', payload: {}, enqueuedAt: Date.now() })
    );
    // A failure left over from an earlier tick must not outlive the recovery.
    await recordSpawnFailure(redis as unknown as Redis, workspaceId, {
      attempts: 1,
      error: new Error('an earlier refusal')
    });

    // Encore confirms the pooled instance really is busy, so the tracked count
    // is not reconciled down and the pool is genuinely all-busy.
    stubTickFetch(1);
    createInstanceMock.mockImplementation(
      async (_ctx: unknown, serviceId: string, _token: string, body: { name: string }) => ({
        name: body.name,
        url:
          serviceId === 'encore'
            ? `https://${body.name}.encore.example`
            : `https://${body.name}.listener.example`
      })
    );

    const config = makeConfig(redis, workspaceId, { maxInstances: 2 });
    const loop = new EncoreScalerLoop(config);
    await loop.tick();

    // A second instance exists in the pool.
    const pool = await redis.hgetall(keys.pool(workspaceId));
    const instanceIds = Object.keys(pool);
    expect(instanceIds).toHaveLength(2);
    const spawnedId = instanceIds.find((id) => id !== busy.instanceId);
    expect(spawnedId).toBeDefined();

    // ...and the pending job went to it, not to the instance already at
    // capacity: the new capacity is actually usable on the tick that made it.
    expect(await redis.llen(keys.queue(workspaceId))).toBe(0);
    const mapping = await redis.hgetall(keys.jobInstance(workspaceId));
    expect(mapping['job-3']).toBe(spawnedId);

    // The stale failure record is gone, so /status stops reporting a problem
    // the scaler has since grown past.
    expect(await readSpawnFailure(redis as unknown as Redis, workspaceId)).toBeUndefined();
    const app = await buildStatusApp(redis, 2);
    try {
      const workspace = (
        (await app.inject({ method: 'GET', url: '/scaler/status' })).json()
          .workspaces as StatusWorkspace[]
      ).find((w) => w.workspaceId === workspaceId);
      expect(workspace?.spawnFailure).toBeUndefined();
      expect(workspace?.instances).toHaveLength(2);
    } finally {
      await app.close();
    }
  });
});

describe('GET /scaler/status reports a workspace that has no pool at all (issue #1071)', () => {
  it('lists a workspace known only by its spawn failure', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-never-spawned';
    await recordSpawnFailure(redis as unknown as Redis, workspaceId, {
      attempts: 3,
      error: new Error('404 Not Found: no subscription for this service')
    });
    await redis.rpush(keys.queue(workspaceId), JSON.stringify({ jobId: 'job-4' }));

    const app = await buildStatusApp(redis);
    try {
      const res = await app.inject({ method: 'GET', url: '/scaler/status' });
      expect(res.statusCode).toBe(200);
      // Keying the listing on pool keys alone hid exactly this case: nothing
      // ever provisioned, jobs piling up, and no row to hang the reason off.
      const workspace = (res.json().workspaces as StatusWorkspace[]).find(
        (w) => w.workspaceId === workspaceId
      );
      expect(workspace).toBeDefined();
      expect(workspace?.instances).toEqual([]);
      expect(workspace?.queueDepth).toBe(1);
      expect(workspace?.spawnFailure).toMatchObject({ attempts: 3, consecutiveFailures: 1 });
      expect(workspace?.spawnFailure?.message).toContain('404 Not Found');
    } finally {
      await app.close();
    }
  });
});
