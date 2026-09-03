// Drain-don't-kill scale-down tests (issue #513).
//
// The scale-down path must NEVER terminate an Encore instance that has a real
// in-flight job, even when its TRACKED activeJobs count says it is idle. The
// tracked count is a local approximation; on a shared pool at minInstances=0 it
// can lag or diverge from the instance's authoritative real IN_PROGRESS state.
// Before selecting a teardown victim the loop must reconcile the candidate
// against its real QUEUED+IN_PROGRESS state, mark a still-busy candidate
// `draining` (no new dispatch), and only remove it once its real active-job
// count hits zero.
//
// These tests run WITHOUT OSC or a real Redis: the OSC-touching pool functions
// (spawnInstance/destroyInstance) are mocked and global.fetch is stubbed to
// return the Encore /encoreJobs/search/findByStatus HATEOAS pages so only the
// scaler-loop scale-down / drain decision is exercised.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - EncoreScalerLoop.tick + the scale-down block + fetchRealActiveState
//     (src/encore-scaler/scaler-loop.ts): teardown-candidate predicate
//     `(activeJobs===0 && idlePastTimeout) || draining===true`, the real-count
//     check via findByStatus?status=QUEUED / IN_PROGRESS, and the draining
//     dispatch skip.
//   - Encore findByStatus HATEOAS page shape
//     { _embedded: { encoreJobs: [{ externalId }] }, page: { totalElements } }
//     (src/encore-scaler/scaler-loop.ts fetchRealActiveState; also
//     encore-callback-poller.ts:505-508).
//   - listInstances/updateInstance/destroyInstance
//     (src/encore-scaler/instance-pool.ts:52,69,167).
//   - EncoreInstanceRecord.draining + activeJobs/lastIdleAt
//     (src/encore-scaler/types.ts).
//   - keys.pool/keys.queue (src/encore-scaler/types.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY the OSC-touching pool functions; keep the pure-Redis helpers real.
const destroyInstance = vi.fn(async () => undefined);
// spawnInstance returns a valid, trust-ready record (as it does in production).
// When a draining instance holds real work but a job is queued, scale-up spawns
// replacement capacity; the mock must therefore not return undefined.
const spawnInstance = vi.fn(async () => ({
  instanceId: `spawned-${Date.now()}`,
  url: 'https://spawned.example',
  activeJobs: 0,
  lastIdleAt: Date.now(),
  callbackTrustReady: true
}));
vi.mock('../src/encore-scaler/instance-pool.js', async () => {
  const actual = await vi.importActual<typeof import('../src/encore-scaler/instance-pool.js')>(
    '../src/encore-scaler/instance-pool.js'
  );
  return {
    ...actual,
    destroyInstance: (...args: unknown[]) => destroyInstance(...args),
    spawnInstance: (...args: unknown[]) => spawnInstance(...args)
  };
});

import { EncoreScalerLoop } from '../src/encore-scaler/scaler-loop.js';
import {
  keys,
  type EncoreInstanceRecord,
  type EncoreScalerConfig
} from '../src/encore-scaler/types.js';

// A minimal in-memory Redis exposing only the commands the scaler tick and the
// pool helpers touch. Values are stored as strings, mirroring ioredis.
class FakeRedis {
  private hashes = new Map<string, Map<string, string>>();
  private lists = new Map<string, string[]>();

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
  async hdel(key: string, field: string): Promise<number> {
    return this.hash(key).delete(field) ? 1 : 0;
  }
  async llen(key: string): Promise<number> {
    return this.lists.get(key)?.length ?? 0;
  }
  private list(key: string): string[] {
    let l = this.lists.get(key);
    if (!l) {
      l = [];
      this.lists.set(key, l);
    }
    return l;
  }
  async rpush(key: string, value: string): Promise<number> {
    const l = this.list(key);
    l.push(value);
    return l.length;
  }
  // RPOPLPUSH: pop the tail of `src`, push to the head of `dst`, return moved val.
  async rpoplpush(src: string, dst: string): Promise<string | null> {
    const s = this.list(src);
    const v = s.pop();
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
}

const OSC_CONTEXT_STUB = {
  getServiceAccessToken: async () => 'test-token'
} as unknown as EncoreScalerConfig['oscContext'];

function makeConfig(
  redis: FakeRedis,
  workspaceId: string,
  idleTimeoutMs: number,
  minInstances = 0,
  maxInstances = 3
): EncoreScalerConfig {
  return {
    workspaceId,
    maxInstances,
    minInstances,
    idleTimeoutMs,
    redisUrl: 'redis://fake',
    oscContext: OSC_CONTEXT_STUB,
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => 'test-token'
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
    // Pre-mark trust so the dispatch gate never re-probes (irrelevant to these
    // tests, but avoids a real HTTPS probe against the stub URL).
    callbackTrustReady: true,
    ...overrides
  };
}

// Build an Encore HATEOAS findByStatus page with `count` jobs, giving each a
// synthetic externalId so the shape matches what fetchRealActiveState reads.
function statusPage(count: number): Response {
  const encoreJobs = Array.from({ length: count }, (_, i) => ({
    externalId: `ext-${i}`
  }));
  return new Response(
    JSON.stringify({ _embedded: { encoreJobs }, page: { totalElements: count } }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

// Install a fetch stub that answers /encoreJobs/search/findByStatus with the
// given per-status counts. QUEUED and IN_PROGRESS are answered independently so
// a test can place real work in either bucket.
function stubEncoreFetch(counts: { queued: number; inProgress: number }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('status=QUEUED')) return statusPage(counts.queued);
      if (url.includes('status=IN_PROGRESS')) return statusPage(counts.inProgress);
      // Any other call (e.g. a POST dispatch) is unexpected in these tests.
      throw new Error(`unexpected fetch in test: ${url}`);
    })
  );
}

describe('scale-down drain-don\'t-kill (issue #513)', () => {
  beforeEach(() => {
    destroyInstance.mockClear();
    spawnInstance.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('never terminates an instance whose tracked count says idle but real state is in-flight', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-race';
    const idleTimeoutMs = 10_000;

    // The RACE: tracked activeJobs===0 and idle well past the timeout, so the
    // old scale-down path would destroy it. But Encore reports a real
    // IN_PROGRESS job on this exact instance.
    const record = poolRecord('inst-race', {
      activeJobs: 0,
      lastIdleAt: Date.now() - (idleTimeoutMs + 60_000)
    });
    await redis.hset(keys.pool(workspaceId), record.instanceId, JSON.stringify(record));

    stubEncoreFetch({ queued: 0, inProgress: 1 });

    const config = makeConfig(redis, workspaceId, idleTimeoutMs);
    const loop = new EncoreScalerLoop(config);
    await loop.tick();

    // Must NOT have been destroyed.
    expect(destroyInstance).not.toHaveBeenCalled();

    // Must have been marked draining and its tracked count corrected up to the
    // real count so the divergence is reconciled.
    const raw = await redis.hgetall(keys.pool(workspaceId));
    expect(raw).toHaveProperty(record.instanceId);
    const persisted = JSON.parse(raw[record.instanceId]!) as EncoreInstanceRecord;
    expect(persisted.draining).toBe(true);
    expect(persisted.activeJobs).toBe(1);
  });

  it('routes no new job to a draining instance and removes it only once real work hits zero', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-drain';
    const idleTimeoutMs = 10_000;

    // Already-draining instance, tracked as busy, past idle age.
    const record = poolRecord('inst-drain', {
      activeJobs: 1,
      draining: true,
      lastIdleAt: Date.now() - (idleTimeoutMs + 60_000)
    });
    await redis.hset(keys.pool(workspaceId), record.instanceId, JSON.stringify(record));

    // A job is waiting in the queue — a draining instance must not receive it.
    await redis.rpush(
      keys.queue(workspaceId),
      JSON.stringify({ jobId: 'job-x', payload: {}, enqueuedAt: Date.now() })
    );

    // First tick: real work still in progress -> stays draining, not destroyed,
    // and the queued job is NOT dispatched to it (queue length unchanged). Pin
    // maxInstances=1 so this draining instance occupies the only slot and no
    // replacement is spawned — isolating the assertion to the drain behaviour.
    stubEncoreFetch({ queued: 0, inProgress: 1 });
    const config = makeConfig(redis, workspaceId, idleTimeoutMs, 0, 1);
    const loop = new EncoreScalerLoop(config);
    await loop.tick();

    expect(destroyInstance).not.toHaveBeenCalled();
    let raw = await redis.hgetall(keys.pool(workspaceId));
    expect(JSON.parse(raw[record.instanceId]!).draining).toBe(true);
    // The queued job was never dispatched to the draining instance.
    expect(await redis.llen(keys.queue(workspaceId))).toBe(1);

    // Second tick: real work has now drained to zero -> the instance is removed.
    stubEncoreFetch({ queued: 0, inProgress: 0 });
    await loop.tick();

    expect(destroyInstance).toHaveBeenCalledTimes(1);
    expect(destroyInstance).toHaveBeenCalledWith(record.instanceId, config);
  });

  it('keeps a teardown candidate when its real state cannot be confirmed (fail-safe)', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-unreach';
    const idleTimeoutMs = 10_000;

    const record = poolRecord('inst-unreach', {
      activeJobs: 0,
      lastIdleAt: Date.now() - (idleTimeoutMs + 60_000)
    });
    await redis.hset(keys.pool(workspaceId), record.instanceId, JSON.stringify(record));

    // Encore is unreachable: findByStatus returns 503 for both statuses, so the
    // real state cannot be determined. The instance must be KEPT (never destroyed
    // on an unconfirmed count).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('', { status: 503 }))
    );

    const config = makeConfig(redis, workspaceId, idleTimeoutMs);
    const loop = new EncoreScalerLoop(config);
    await loop.tick();

    expect(destroyInstance).not.toHaveBeenCalled();
    expect(await redis.hgetall(keys.pool(workspaceId))).toHaveProperty(record.instanceId);
  });

  it('still tears down a genuinely idle instance whose real state confirms zero work', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-idle-real';
    const idleTimeoutMs = 10_000;

    const record = poolRecord('inst-idle', {
      activeJobs: 0,
      lastIdleAt: Date.now() - (idleTimeoutMs + 60_000)
    });
    await redis.hset(keys.pool(workspaceId), record.instanceId, JSON.stringify(record));

    // Real state confirms no work: the instance is safely torn down.
    stubEncoreFetch({ queued: 0, inProgress: 0 });

    const config = makeConfig(redis, workspaceId, idleTimeoutMs);
    const loop = new EncoreScalerLoop(config);
    await loop.tick();

    expect(destroyInstance).toHaveBeenCalledTimes(1);
    expect(destroyInstance).toHaveBeenCalledWith(record.instanceId, config);
  });
});
