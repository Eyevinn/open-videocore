// reconcile() evicts a pool record whose Encore instance no longer exists.
//
// An unreachable pool instance is kept so an outage mid-job never costs the
// job. But a record whose instance is GONE from OSC is permanently unreachable,
// and keeping it wedges the workspace: it counts as idle capacity (activeJobs
// 0) so the scale-up gate never fires, and every dispatch to it fails and
// re-queues the job. Observed on OSC: a job `running` for 16+ minutes with
// queueDepth 1 and one pool instance that OSC no longer listed, while its
// callback listener (same name) still existed — a half-torn-down pair.
//
// Pinned here:
//   1. An unreachable instance OSC does not list is evicted: its pool record
//      is dropped and the paired listener removed (the Encore removal 404s and
//      is tolerated). A job still mapped to it is re-queued as a scale-down
//      interruption.
//   2. An unreachable instance OSC DOES list is kept (fail-safe unchanged).
//   3. When OSC cannot be listed, nothing is evicted.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const removeInstance = vi.fn();
const listInstances = vi.fn();

vi.mock('@osaas/client-core', () => ({
  createInstance: vi.fn(),
  removeInstance: (...args: unknown[]) => removeInstance(...args),
  listInstances: (...args: unknown[]) => listInstances(...args),
  getInstanceHealth: vi.fn(async () => 'running'),
  getInstance: vi.fn()
}));

import { EncoreScalerLoop } from '../src/encore-scaler/scaler-loop.js';
import {
  ENCORE_CALLBACK_LISTENER_SERVICE_ID,
  ENCORE_SERVICE_ID
} from '../src/encore-scaler/instance-pool.js';
import { recordDispatch } from '../src/encore-scaler/retry-store.js';
import {
  keys,
  type EncoreInstanceRecord,
  type EncoreScalerConfig
} from '../src/encore-scaler/types.js';

class FakeRedis {
  private strings = new Map<string, string>();
  private hashes = new Map<string, Map<string, string>>();
  private lists = new Map<string, string[]>();
  private sets = new Map<string, Set<string>>();

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
  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<'OK'> {
    this.strings.set(key, value);
    return 'OK';
  }
  async del(...ks: string[]): Promise<number> {
    let n = 0;
    for (const k of ks) {
      if (this.strings.delete(k)) n++;
      if (this.hashes.delete(k)) n++;
      if (this.lists.delete(k)) n++;
    }
    return n;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hash(key));
  }
  async hget(key: string, field: string): Promise<string | null> {
    return this.hash(key).get(field) ?? null;
  }
  async hset(key: string, field: string, value: string): Promise<number> {
    this.hash(key).set(field, value);
    return 1;
  }
  async hdel(key: string, ...fields: string[]): Promise<number> {
    let n = 0;
    for (const f of fields) if (this.hash(key).delete(f)) n++;
    return n;
  }
  async hkeys(key: string): Promise<string[]> {
    return [...this.hash(key).keys()];
  }
  async incr(key: string): Promise<number> {
    const next = Number(this.strings.get(key) ?? '0') + 1;
    this.strings.set(key, String(next));
    return next;
  }
  async pexpire(): Promise<number> {
    return 1;
  }
  async lpush(key: string, value: string): Promise<number> {
    const l = this.list(key);
    l.unshift(value);
    return l.length;
  }
  async rpush(key: string, value: string): Promise<number> {
    const l = this.list(key);
    l.push(value);
    return l.length;
  }
  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const l = this.list(key);
    return l.slice(start, stop === -1 ? undefined : stop + 1);
  }
  async llen(key: string): Promise<number> {
    return this.list(key).length;
  }
  async scard(key: string): Promise<number> {
    return this.sets.get(key)?.size ?? 0;
  }
  async scan(): Promise<[string, string[]]> {
    return ['0', [...this.hashes.keys()]];
  }
  pool(workspaceId: string): Record<string, string> {
    return Object.fromEntries(this.hash(keys.pool(workspaceId)));
  }
}

const WORKSPACE = 'stack2';
const DEAD = 'scalerstack2deadinst';
const JOB = 'stack2__job-lost';

function config(redis: FakeRedis): EncoreScalerConfig {
  return {
    workspaceId: WORKSPACE,
    maxInstances: 2,
    minInstances: 0,
    idleTimeoutMs: 300_000,
    redisUrl: 'redis://fake',
    oscContext: { getServiceAccessToken: async () => 'tok' } as unknown as EncoreScalerConfig['oscContext'],
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => 'tok',
    orphanReapIntervalMs: 0
  };
}

async function seedDeadInstance(redis: FakeRedis): Promise<void> {
  const record: EncoreInstanceRecord = {
    instanceId: DEAD,
    url: 'https://dead.example',
    activeJobs: 1,
    lastIdleAt: Date.now() - 60_000
  };
  await redis.hset(keys.pool(WORKSPACE), DEAD, JSON.stringify(record));
  // A job dispatched to it before it vanished.
  await redis.hset(keys.jobInstance(WORKSPACE), JOB, DEAD);
  await redis.hset(keys.jobStatus(WORKSPACE), JOB, 'RUNNING');
  await recordDispatch(redis as never, JOB, { externalId: JOB, profile: 'program' }, 1);
}

describe('reconcile evicts a pool instance that no longer exists on OSC', () => {
  beforeEach(() => {
    removeInstance.mockReset();
    listInstances.mockReset();
    // The instance's Encore API is unreachable.
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drops the record, removes the leftover listener and re-queues the mapped job', async () => {
    const redis = new FakeRedis();
    await seedDeadInstance(redis);
    listInstances.mockResolvedValue([]); // OSC: no Encore instance by that name
    removeInstance.mockImplementation(async (_ctx: unknown, serviceId: string) => {
      if (serviceId === ENCORE_SERVICE_ID) throw new Error('404 not found');
    });

    await new EncoreScalerLoop(config(redis)).reconcile();

    expect(redis.pool(WORKSPACE)).toEqual({});
    const removed = removeInstance.mock.calls.map((c) => [c[1], c[2]]);
    expect(removed).toContainEqual([ENCORE_SERVICE_ID, DEAD]);
    expect(removed).toContainEqual([ENCORE_CALLBACK_LISTENER_SERVICE_ID, DEAD]);
    // The lost job is back in the queue for a fresh dispatch.
    const queued = (await redis.lrange(keys.queue(WORKSPACE), 0, -1)).map((raw) => JSON.parse(raw).jobId);
    expect(queued).toEqual([JOB]);
    expect(await redis.hget(keys.jobInstance(WORKSPACE), JOB)).toBeNull();
  });

  it('keeps an unreachable instance that OSC still lists', async () => {
    const redis = new FakeRedis();
    await seedDeadInstance(redis);
    listInstances.mockResolvedValue([{ name: DEAD, url: 'https://dead.example' }]);

    await new EncoreScalerLoop(config(redis)).reconcile();

    expect(Object.keys(redis.pool(WORKSPACE))).toEqual([DEAD]);
    expect(removeInstance).not.toHaveBeenCalled();
    expect(await redis.llen(keys.queue(WORKSPACE))).toBe(0);
  });

  it('evicts nothing when OSC cannot be listed', async () => {
    const redis = new FakeRedis();
    await seedDeadInstance(redis);
    listInstances.mockRejectedValue(new Error('503'));

    await new EncoreScalerLoop(config(redis)).reconcile();

    expect(Object.keys(redis.pool(WORKSPACE))).toEqual([DEAD]);
    expect(removeInstance).not.toHaveBeenCalled();
  });
});
