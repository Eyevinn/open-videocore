// Unit test for scale-down interruption classification + re-enqueue (issue #514).
//
// Exercises EncoreScalerLoop.tick() scale-down path with an in-memory Valkey fake
// and a mocked global fetch, so it runs with no OSC/Valkey dependency. Asserts:
//   (a) a job owned by a scaled-away/drained instance that is non-terminal and no
//       longer active on Encore is classified 'interrupted_by_scaledown' and
//       re-enqueued onto the Valkey queue (NOT surfaced as a generic failure); and
//   (b) a genuine terminal FAILED (deterministic) job mapped to the same instance
//       is NOT reclassified as scale-down interruption and NOT re-enqueued.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - Scale-down drain/teardown boundary + requeueScaleDownInterruptions call —
//     src/encore-scaler/scaler-loop.ts (tick() scale-down loop; the boundary
//     introduced by #513 drain-don't-kill).
//   - fetchRealActiveState HATEOAS page shape { _embedded: { encoreJobs:
//     [{ externalId }] }, page: { totalElements } } — encore-callback-poller.ts
//     :505-508 (SVT Encore) and scaler-loop.ts:297-304.
//   - Valkey key schema keys.queue / keys.pool / keys.jobInstance / keys.jobStatus
//     / keys.jobPayload / keys.jobAttempts — src/encore-scaler/types.ts:161-189.
//   - Re-enqueue = LPUSH QueuedJob onto keys.queue; caller status pinned RUNNING;
//     stale jobInstance mapping dropped — src/encore-scaler/retry-store.ts
//     requeueInterruptedByScaleDown.
//   - destroyInstance is the only OSC teardown call; stubbed here so no OSC I/O —
//     src/encore-scaler/instance-pool.ts:280.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EncoreScalerLoop } from './scaler-loop.js';
import {
  keys,
  type EncoreScalerConfig,
  type EncoreInstanceRecord,
  type QueuedJob
} from './types.js';

// Stub only the OSC teardown (destroyInstance) so the scale-down path performs no
// real OSC I/O; keep the real listInstances/updateInstance the loop relies on.
// destroyInstance also removes the pool record on real OSC success, so the stub
// mirrors that (redis.hdel of the pool record) to keep pool state consistent.
const destroyInstanceMock = vi.hoisted(() => vi.fn());
vi.mock('./instance-pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./instance-pool.js')>();
  return { ...actual, destroyInstance: destroyInstanceMock };
});

// In-memory stand-in for the subset of ioredis the scale-down path uses:
// strings (get/set/del), hashes (hset/hget/hgetall/hdel), lists (llen/lpush/
// rpush/lrange/lrem/rpoplpush).
class FakeRedis {
  strings = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
  lists = new Map<string, string[]>();

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
  }

  async set(key: string, val: string): Promise<'OK'> {
    this.strings.set(key, val);
    return 'OK';
  }
  async get(key: string): Promise<string | null> {
    return this.strings.has(key) ? (this.strings.get(key) as string) : null;
  }
  async del(...args: string[]): Promise<number> {
    let n = 0;
    for (const k of args) if (this.strings.delete(k)) n++;
    return n;
  }
  async hset(key: string, field: string, val: string): Promise<number> {
    const h = this.hash(key);
    const isNew = !h.has(field);
    h.set(field, val);
    return isNew ? 1 : 0;
  }
  async hget(key: string, field: string): Promise<string | null> {
    return this.hash(key).get(field) ?? null;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hash(key));
  }
  async hdel(key: string, field: string): Promise<number> {
    return this.hash(key).delete(field) ? 1 : 0;
  }
  async llen(key: string): Promise<number> {
    return (this.lists.get(key) ?? []).length;
  }
  async lpush(key: string, val: string): Promise<number> {
    const l = this.lists.get(key) ?? [];
    l.unshift(val);
    this.lists.set(key, l);
    return l.length;
  }
  async rpush(key: string, val: string): Promise<number> {
    const l = this.lists.get(key) ?? [];
    l.push(val);
    this.lists.set(key, l);
    return l.length;
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const l = this.lists.get(key) ?? [];
    const end = stop === -1 ? l.length - 1 : stop;
    return l.slice(start, end + 1);
  }
  async lrem(key: string, _count: number, val: string): Promise<number> {
    const l = this.lists.get(key) ?? [];
    const idx = l.indexOf(val);
    if (idx >= 0) {
      l.splice(idx, 1);
      this.lists.set(key, l);
      return 1;
    }
    return 0;
  }
  async rpoplpush(src: string, dst: string): Promise<string | null> {
    const s = this.lists.get(src) ?? [];
    const val = s.pop();
    if (val === undefined) return null;
    this.lists.set(src, s);
    const d = this.lists.get(dst) ?? [];
    d.unshift(val);
    this.lists.set(dst, d);
    return val;
  }
}

const WS = 'ws1';

function makeConfig(redis: FakeRedis): EncoreScalerConfig {
  return {
    workspaceId: WS,
    maxInstances: 2,
    minInstances: 0,
    idleTimeoutMs: 1_000,
    redisUrl: 'redis://fake',
    oscContext: {} as EncoreScalerConfig['oscContext'],
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => 'test-token'
  };
}

// A findByStatus HATEOAS page for a set of externalIds.
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
  await redis.hset(keys.pool(WS), record.instanceId, JSON.stringify(record));
}

const PAYLOAD = { externalId: 'x', profile: 'abr-1080p', inputs: [{ uri: 's3://b/k' }] };

describe('scale-down interruption classification + re-enqueue (#514)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    destroyInstanceMock.mockReset();
  });

  it('classifies a non-terminal job on a scaled-away instance as interrupted_by_scaledown and re-enqueues it', async () => {
    const redis = new FakeRedis();
    const instanceId = 'inst-1';

    // Instance is idle-and-aged (a teardown candidate). Encore reports it has NO
    // active work (real.count === 0) so tick() will destroy it — but a job is
    // still mapped to it, non-terminal, and NOT in Encore's active set: that work
    // was lost to the scale-down.
    await seedPool(redis, {
      instanceId,
      url: 'https://encore.example',
      activeJobs: 0,
      lastIdleAt: 0 // long past idleTimeoutMs
    });
    await redis.hset(keys.jobInstance(WS), 'job-lost', instanceId);
    await redis.hset(keys.jobStatus(WS), 'job-lost', 'running');
    // Its dispatch payload is available so it can be rebuilt for re-enqueue.
    await redis.set(keys.jobPayload('job-lost'), JSON.stringify(PAYLOAD));
    await redis.set(keys.jobAttempts('job-lost'), '1');

    // Encore reports nothing active for this instance.
    vi.stubGlobal('fetch', fetchMock([], []));
    destroyInstanceMock.mockResolvedValue(undefined);

    await new EncoreScalerLoop(makeConfig(redis)).tick();

    // The instance was torn down.
    expect(destroyInstanceMock).toHaveBeenCalledTimes(1);

    // The lost job was re-enqueued onto the Valkey queue with its original payload
    // and NOT surfaced as a generic failure.
    const queued = await redis.lrange(keys.queue(WS), 0, -1);
    expect(queued).toHaveLength(1);
    const requeued = JSON.parse(queued[0]) as QueuedJob;
    expect(requeued.jobId).toBe('job-lost');
    expect(requeued.payload).toEqual(PAYLOAD);
    // A scale-down interruption is not a failed attempt: attempt count unchanged.
    expect(requeued.attempts).toBe(1);

    // Caller-facing status kept RUNNING (never observed failed) and the stale
    // mapping to the scaled-away instance was dropped.
    expect(await redis.hget(keys.jobStatus(WS), 'job-lost')).toBe('RUNNING');
    expect(await redis.hget(keys.jobInstance(WS), 'job-lost')).toBeNull();
  });

  it('does NOT reclassify a genuine terminal FAILED (deterministic) job as scale-down interruption', async () => {
    const redis = new FakeRedis();
    const instanceId = 'inst-1';

    await seedPool(redis, {
      instanceId,
      url: 'https://encore.example',
      activeJobs: 0,
      lastIdleAt: 0
    });
    // A job that already settled to a terminal FAILED (a real deterministic
    // failure). It is mapped to the instance and absent from Encore's active set,
    // but its terminal status means it must NOT be reclassified/re-enqueued.
    await redis.hset(keys.jobInstance(WS), 'job-failed', instanceId);
    await redis.hset(keys.jobStatus(WS), 'job-failed', 'FAILED');
    await redis.set(keys.jobPayload('job-failed'), JSON.stringify(PAYLOAD));
    await redis.set(keys.jobAttempts('job-failed'), '1');

    vi.stubGlobal('fetch', fetchMock([], []));
    destroyInstanceMock.mockResolvedValue(undefined);

    await new EncoreScalerLoop(makeConfig(redis)).tick();

    // NOT re-enqueued: the queue stays empty.
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
    // Terminal status left untouched — a real failure is not turned into a retry.
    expect(await redis.hget(keys.jobStatus(WS), 'job-failed')).toBe('FAILED');
  });

  it('does NOT reclassify a job still active on Encore (draining, not lost)', async () => {
    const redis = new FakeRedis();
    const instanceId = 'inst-1';

    // Tracked idle-and-aged, but Encore reports the job STILL IN_PROGRESS: the
    // instance is drained (kept alive), and its job is not lost.
    await seedPool(redis, {
      instanceId,
      url: 'https://encore.example',
      activeJobs: 0,
      lastIdleAt: 0
    });
    await redis.hset(keys.jobInstance(WS), 'job-live', instanceId);
    await redis.hset(keys.jobStatus(WS), 'job-live', 'running');
    await redis.set(keys.jobPayload('job-live'), JSON.stringify(PAYLOAD));

    vi.stubGlobal('fetch', fetchMock([], ['job-live']));
    destroyInstanceMock.mockResolvedValue(undefined);

    await new EncoreScalerLoop(makeConfig(redis)).tick();

    // Drained, not destroyed; the live job is not re-enqueued.
    expect(destroyInstanceMock).not.toHaveBeenCalled();
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
    expect(await redis.hget(keys.jobStatus(WS), 'job-live')).toBe('running');
  });
});
