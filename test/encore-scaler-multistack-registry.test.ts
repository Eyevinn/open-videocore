// The scaler registry across several stacks, each with its OWN Valkey (#615).
//
// Pinned here, because each of these was a silent first-stack assumption:
//   1. A stack whose config has no Valkey URL yet (mid-provision) resolves to
//      the injected first-stack connection, and that fallback must NOT be
//      cached: once the stack's URL is stored, the next resolution must open
//      the stack's own connection, without a restart.
//   2. `listStackConnections({ fresh: true })` sees a stack provisioned after
//      the status-poll enumeration cache was filled.
//   3. `resumeExistingWorkspaces` discovers a pool living on another stack's
//      Valkey and resumes its loop on restart — a scan of the first stack's
//      Valkey alone never found it.
//   4. `redisForEncoreJob` hands out the Valkey of the stack encoded in the
//      job id, which is where every scaler key for that job lives.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';

vi.mock('@osaas/client-core', () => ({
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  listInstances: vi.fn(async () => []),
  getInstanceHealth: vi.fn(async () => 'running'),
  getInstance: vi.fn()
}));

import { removeInstance } from '@osaas/client-core';
import { WorkspaceEncoreScalerRegistry } from '../src/encore-scaler/workspace-registry.js';
import { keys } from '../src/encore-scaler/types.js';
import { valkeyConnectionId } from '../src/encore-scaler/valkey-connection-id.js';

// One instance per PHYSICAL Valkey. Covers the commands the registry's own
// code paths issue: KEYS for the resume scan, hashes for the pool records, and
// disconnect() for teardown.
class FakeRedis {
  private hashes = new Map<string, Map<string, string>>();
  disconnected = false;

  constructor(readonly label: string) {}

  async hset(key: string, field: string, value: string): Promise<number> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    h.set(field, value);
    return 1;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? new Map());
  }
  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace(/\*$/, '');
    return [...this.hashes.keys()].filter((k) => k.startsWith(prefix));
  }
  async llen(): Promise<number> {
    return 0;
  }
  async hdel(key: string, ...fields: string[]): Promise<number> {
    let n = 0;
    for (const f of fields) if (this.hashes.get(key)?.delete(f)) n++;
    return n;
  }
  async del(...ks: string[]): Promise<number> {
    let n = 0;
    for (const k of ks) if (this.hashes.delete(k)) n++;
    return n;
  }
  disconnect(): void {
    this.disconnected = true;
  }
}

const OSC_CONTEXT = {
  getServiceAccessToken: async () => 'token',
  getPersonalAccessToken: () => 'pat'
} as unknown as import('@osaas/client-core').Context;

const GLOBAL_URL = 'redis://stack1-valkey:6379';
const STACK2_URL = 'redis://stack2-valkey:6379';

function makeRegistry(opts: {
  globalRedis: FakeRedis;
  urls: Record<string, string | undefined>;
  stackKeys?: () => Promise<string[]>;
  opened?: Map<string, FakeRedis>;
}): WorkspaceEncoreScalerRegistry {
  const opened = opts.opened ?? new Map<string, FakeRedis>();
  return new WorkspaceEncoreScalerRegistry({
    redis: opts.globalRedis as unknown as Redis,
    redisUrl: GLOBAL_URL,
    oscContext: OSC_CONTEXT,
    maxInstances: 1,
    idleTimeoutMs: 60_000,
    tickIntervalMs: 60_000,
    orphanReapIntervalMs: 0,
    resolveRedisUrl: async (stackKey) => opts.urls[stackKey],
    makeRedis: (url) => {
      let r = opened.get(url);
      if (!r) {
        r = new FakeRedis(url);
        opened.set(url, r);
      }
      return r as unknown as Redis;
    },
    listStackKeys: opts.stackKeys
  });
}

const registries: WorkspaceEncoreScalerRegistry[] = [];
afterEach(() => {
  for (const r of registries.splice(0)) r.stopAll();
});

describe('per-stack Valkey resolution', () => {
  it('does not cache the first-stack fallback for a stack whose Valkey URL is not stored yet', async () => {
    const globalRedis = new FakeRedis(GLOBAL_URL);
    const urls: Record<string, string | undefined> = { stack2: undefined };
    const registry = makeRegistry({ globalRedis, urls });
    registries.push(registry);

    // Mid-provision: no URL yet, so the first stack's connection stands in.
    const first = await registry.resolveStackRedis('stack2');
    expect(first.redis).toBe(globalRedis);
    expect(first.redisUrl).toBe(GLOBAL_URL);

    // Provision completes and stores the stack's own URL: the next resolution
    // must open THAT, not keep handing out the first stack's connection.
    urls['stack2'] = STACK2_URL;
    const second = await registry.resolveStackRedis('stack2');
    expect(second.redisUrl).toBe(STACK2_URL);
    expect((second.redis as unknown as FakeRedis).label).toBe(STACK2_URL);
    expect(second.redis).not.toBe(globalRedis);
  });

  it('resolves the Valkey of the stack encoded in an Encore job id', async () => {
    const globalRedis = new FakeRedis(GLOBAL_URL);
    const registry = makeRegistry({
      globalRedis,
      urls: { stack1: GLOBAL_URL, stack2: STACK2_URL }
    });
    registries.push(registry);

    const forStack2 = (await registry.redisForEncoreJob('stack2__job-abc')) as unknown as FakeRedis;
    expect(forStack2.label).toBe(STACK2_URL);
    // The first stack's URL is the injected connection's: no second socket.
    expect(await registry.redisForEncoreJob('stack1__job-abc')).toBe(globalRedis);
    // Undecodable id: the injected connection.
    expect(await registry.redisForEncoreJob('not-an-encore-job-id')).toBe(globalRedis);
  });

  it('lists a stack provisioned after the enumeration cache was filled when asked for a fresh view', async () => {
    const globalRedis = new FakeRedis(GLOBAL_URL);
    let provisioned = ['stack1'];
    const registry = makeRegistry({
      globalRedis,
      urls: { stack1: GLOBAL_URL, stack2: STACK2_URL },
      stackKeys: async () => provisioned
    });
    registries.push(registry);

    // A status poll fills the cache.
    expect((await registry.listStackConnections()).map((c) => c.stackKey)).toEqual(['stack1']);
    provisioned = ['stack1', 'stack2'];
    // Cached: the status read still reports the old list ...
    expect((await registry.listStackConnections()).map((c) => c.stackKey)).toEqual(['stack1']);
    // ... but a reconcile reacting to the provision sees the new stack, on its
    // own connection.
    const fresh = await registry.listStackConnections({ fresh: true });
    expect(fresh.map((c) => c.stackKey).sort()).toEqual(['stack1', 'stack2']);
    const stack2 = fresh.find((c) => c.stackKey === 'stack2')!;
    expect(stack2.connectionId).toBe(valkeyConnectionId(STACK2_URL));
    expect((stack2.redis as unknown as FakeRedis).label).toBe(STACK2_URL);
  });
});

describe('resumeExistingWorkspaces across stack Valkeys', () => {
  it('resumes a pool that lives only on a second stack’s Valkey', async () => {
    const globalRedis = new FakeRedis(GLOBAL_URL);
    const stack2Redis = new FakeRedis(STACK2_URL);
    const opened = new Map<string, FakeRedis>([[STACK2_URL, stack2Redis]]);
    // Only the second stack has a running pool, and only on ITS Valkey.
    await stack2Redis.hset(
      keys.pool('stack2'),
      'inst-1',
      JSON.stringify({ instanceId: 'inst-1', url: 'https://inst-1.example', activeJobs: 0, lastIdleAt: Date.now() })
    );
    const registry = makeRegistry({
      globalRedis,
      urls: { stack1: GLOBAL_URL, stack2: STACK2_URL },
      stackKeys: async () => ['stack1', 'stack2'],
      opened
    });
    registries.push(registry);

    const warnings: string[] = [];
    await registry.resumeExistingWorkspaces((msg) => warnings.push(msg));

    const loops = (registry as unknown as { loops: Map<string, unknown> }).loops;
    expect([...loops.keys()]).toEqual(['stack2']);
    expect(warnings).toEqual([]);
  });

  it('keeps resuming the other Valkeys when one cannot be scanned', async () => {
    const globalRedis = new FakeRedis(GLOBAL_URL);
    await globalRedis.hset(
      keys.pool('stack1'),
      'inst-0',
      JSON.stringify({ instanceId: 'inst-0', url: 'https://inst-0.example', activeJobs: 0, lastIdleAt: Date.now() })
    );
    const broken = new FakeRedis(STACK2_URL);
    broken.keys = async () => {
      throw new Error('connection refused');
    };
    const registry = makeRegistry({
      globalRedis,
      urls: { stack1: GLOBAL_URL, stack2: STACK2_URL },
      stackKeys: async () => ['stack1', 'stack2'],
      opened: new Map([[STACK2_URL, broken]])
    });
    registries.push(registry);

    const warnings: string[] = [];
    await registry.resumeExistingWorkspaces((msg) => warnings.push(msg));

    const loops = (registry as unknown as { loops: Map<string, unknown> }).loops;
    expect([...loops.keys()]).toEqual(['stack1']);
    expect(warnings.some((w) => w.includes('failed to scan Valkey'))).toBe(true);
  });
});

describe('teardown of a stack', () => {
  it('destroys the pool on the stack’s own Valkey AND a stale copy on the first stack’s, and purges both', async () => {
    const globalRedis = new FakeRedis(GLOBAL_URL);
    const stack2Redis = new FakeRedis(STACK2_URL);
    const record = (id: string) =>
      JSON.stringify({ instanceId: id, url: `https://${id}.example`, activeJobs: 0, lastIdleAt: Date.now() });
    await stack2Redis.hset(keys.pool('stack2'), 'inst-live', record('inst-live'));
    // Left behind on the first stack's Valkey by a mid-provision fallback.
    await globalRedis.hset(keys.pool('stack2'), 'inst-stale', record('inst-stale'));
    await globalRedis.hset(keys.jobInstance('stack2'), 'stack2__job-1', 'inst-stale');
    const registry = makeRegistry({
      globalRedis,
      urls: { stack1: GLOBAL_URL, stack2: STACK2_URL },
      opened: new Map([[STACK2_URL, stack2Redis]])
    });
    registries.push(registry);
    vi.mocked(removeInstance).mockReset();

    await registry.teardown('stack2');

    const removed = vi.mocked(removeInstance).mock.calls.map((c) => c[2]);
    expect(removed.filter((id) => id === 'inst-live').length).toBeGreaterThan(0);
    expect(removed.filter((id) => id === 'inst-stale').length).toBeGreaterThan(0);
    expect(await stack2Redis.hgetall(keys.pool('stack2'))).toEqual({});
    expect(await globalRedis.hgetall(keys.pool('stack2'))).toEqual({});
    expect(await globalRedis.hgetall(keys.jobInstance('stack2'))).toEqual({});
    expect(stack2Redis.disconnected).toBe(true);
    expect(globalRedis.disconnected).toBe(false);
  });
});
