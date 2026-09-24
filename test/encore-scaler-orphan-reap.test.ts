// Orphan-instance reaper + readyAt stamping tests (issue #778).
//
// Every existing teardown path iterates the Valkey pool hash
// (scaler-loop.ts scale-down, workspace-registry.ts teardown), so an Encore
// instance that is running on OSC but absent from that hash — a spawn that died
// between createInstance and the pool write, a wiped Valkey, a deleted
// deployment — has nothing that can ever destroy it and bills until an operator
// notices it by hand. reapOrphanedInstances() closes that hole.
//
// Safety property under test: an instance is reaped only after it has been
// observed orphaned for the whole grace window, so an in-progress spawn (which
// legitimately holds a live OSC instance with no pool record while it waits on
// waitForInstanceReady) is never reaped out from under itself.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - @osaas/client-core lib/core.d.ts:
//       createInstance(context, serviceId, token, body): Promise<any>  (:32)
//       removeInstance(context, serviceId, name, token): Promise<void> (:46)
//       listInstances(context, serviceId, token): Promise<any>         (:65)
//       waitForInstanceReady(serviceId, name, context): Promise<void>
//     listInstances returns the raw JSON array from the OSC instances endpoint
//     (lib/core.js listInstances) — elements carry `name`/`url`, and NO creation
//     timestamp, which is why first-sighting is tracked in Valkey.
//   - Instance naming `scaler{sanitisedWorkspaceId}{base36 ms}` and
//     scalerInstancePrefix() (src/encore-scaler/instance-pool.ts).
//   - keys.pool / keys.orphanSeen (src/encore-scaler/types.ts).
//   - EncoreInstanceRecord.readyAt (src/encore-scaler/types.ts:176-186).

import { beforeEach, describe, expect, it, vi } from 'vitest';

const createInstance = vi.fn();
const removeInstance = vi.fn(async () => undefined);
const listInstances = vi.fn(async () => [] as Array<Record<string, unknown>>);
const waitForInstanceReady = vi.fn(async () => undefined);

vi.mock('@osaas/client-core', () => ({
  createInstance: (...args: unknown[]) => createInstance(...args),
  removeInstance: (...args: unknown[]) => removeInstance(...args),
  listInstances: (...args: unknown[]) => listInstances(...args),
  waitForInstanceReady: (...args: unknown[]) => waitForInstanceReady(...args)
}));

import {
  DEFAULT_ORPHAN_GRACE_MS,
  reapOrphanedInstances,
  scalerInstancePrefix,
  spawnInstance
} from '../src/encore-scaler/instance-pool.js';
import {
  keys,
  type EncoreInstanceRecord,
  type EncoreScalerConfig
} from '../src/encore-scaler/types.js';

// In-memory Redis covering the commands the reaper and spawn path touch:
// hash reads/writes plus SCAN/HKEYS for the cross-pool tracked-id sweep.
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
  async hkeys(key: string): Promise<string[]> {
    return [...this.hash(key).keys()];
  }
  // Single-pass SCAN over the (small) in-memory keyspace; returns cursor '0'.
  async scan(
    _cursor: string,
    _match: 'MATCH',
    pattern: string,
    _count: 'COUNT',
    _n: number
  ): Promise<[string, string[]]> {
    const prefix = pattern.replace(/\*$/, '');
    return ['0', [...this.hashes.keys()].filter((k) => k.startsWith(prefix))];
  }
}

const OSC_CONTEXT_STUB = {
  getServiceAccessToken: async () => 'test-token'
} as unknown as EncoreScalerConfig['oscContext'];

function makeConfig(
  redis: FakeRedis,
  workspaceId: string,
  overrides: Partial<EncoreScalerConfig> = {}
): EncoreScalerConfig {
  return {
    workspaceId,
    maxInstances: 3,
    minInstances: 0,
    idleTimeoutMs: 300_000,
    redisUrl: 'redis://fake',
    oscContext: OSC_CONTEXT_STUB,
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => 'test-token',
    ...overrides
  };
}

describe('spawnInstance stamps readyAt on the pool record (issue #778)', () => {
  beforeEach(() => {
    createInstance.mockReset();
    removeInstance.mockReset();
    listInstances.mockReset();
    waitForInstanceReady.mockReset();
    waitForInstanceReady.mockResolvedValue(undefined);
  });

  it('records when the instance became ready so a never-dispatched instance can age out', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-spawn';
    createInstance.mockImplementation(async (_ctx, _svc, _tok, body) => ({
      name: (body as { name: string }).name,
      url: `https://${(body as { name: string }).name}.example`
    }));

    const before = Date.now();
    const record = await spawnInstance(makeConfig(redis, workspaceId));
    const after = Date.now();

    expect(record.instanceId.startsWith(scalerInstancePrefix(workspaceId))).toBe(true);
    expect(record.readyAt).toBeGreaterThanOrEqual(before);
    expect(record.readyAt!).toBeLessThanOrEqual(after);

    // And it is persisted, so the idle clock survives a restart of the API.
    const raw = await redis.hgetall(keys.pool(workspaceId));
    const persisted = JSON.parse(raw[record.instanceId]!) as EncoreInstanceRecord;
    expect(persisted.readyAt).toBe(record.readyAt);
    expect(persisted.activeJobs).toBe(0);
  });
});

describe('orphan reaper — instances on OSC with no pool record (issue #778)', () => {
  const workspaceId = 'lucas';
  const prefix = scalerInstancePrefix(workspaceId);
  const orphanId = `${prefix}dev95gh2`;

  beforeEach(() => {
    createInstance.mockReset();
    removeInstance.mockReset();
    removeInstance.mockResolvedValue(undefined);
    listInstances.mockReset();
    waitForInstanceReady.mockReset();
  });

  it('does not destroy an instance on its first sighting — it starts the grace window', async () => {
    const redis = new FakeRedis();
    listInstances.mockResolvedValue([
      { name: orphanId, url: `https://${orphanId}.example` }
    ]);

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([]);
    expect(removeInstance).not.toHaveBeenCalled();
    const seen = await redis.hgetall(keys.orphanSeen(workspaceId));
    expect(Number(seen[orphanId])).toBeGreaterThan(0);
  });

  it('destroys an instance still orphaned after the grace window', async () => {
    const redis = new FakeRedis();
    listInstances.mockResolvedValue([
      { name: orphanId, url: `https://${orphanId}.example` }
    ]);
    // Seen orphaned well before the grace window opened.
    await redis.hset(
      keys.orphanSeen(workspaceId),
      orphanId,
      String(Date.now() - (DEFAULT_ORPHAN_GRACE_MS + 60_000))
    );

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([orphanId]);
    // The Encore instance AND its paired callback listener are removed.
    expect(removeInstance).toHaveBeenCalledWith(
      expect.anything(),
      'encore',
      orphanId,
      'test-token'
    );
    expect(removeInstance).toHaveBeenCalledWith(
      expect.anything(),
      'eyevinn-encore-callback-listener',
      orphanId,
      'test-token'
    );
    // Sighting cleared so a future instance of the same name starts fresh.
    expect(await redis.hgetall(keys.orphanSeen(workspaceId))).toEqual({});
  });

  it('never touches an instance that has a pool record, however long it has run', async () => {
    const redis = new FakeRedis();
    const trackedId = `${prefix}tracked`;
    listInstances.mockResolvedValue([
      { name: trackedId, url: `https://${trackedId}.example` }
    ]);
    await redis.hset(
      keys.pool(workspaceId),
      trackedId,
      JSON.stringify({
        instanceId: trackedId,
        url: `https://${trackedId}.example`,
        activeJobs: 1,
        lastIdleAt: Date.now() - 24 * 60 * 60_000,
        readyAt: Date.now() - 24 * 60 * 60_000
      })
    );
    // Even a stale sighting from before it was adopted must not reap it.
    await redis.hset(
      keys.orphanSeen(workspaceId),
      trackedId,
      String(Date.now() - (DEFAULT_ORPHAN_GRACE_MS + 60_000))
    );

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([]);
    expect(removeInstance).not.toHaveBeenCalled();
    // The stale sighting is cleared, because it is no longer an orphan.
    expect(await redis.hgetall(keys.orphanSeen(workspaceId))).toEqual({});
  });

  it('never touches an instance tracked in ANOTHER workspace pool on the same Valkey', async () => {
    const redis = new FakeRedis();
    const otherWorkspaceId = 'lucas-2'; // sanitises to a colliding name prefix
    const sharedNameId = `${scalerInstancePrefix(otherWorkspaceId)}abc`;
    listInstances.mockResolvedValue([
      { name: sharedNameId, url: `https://${sharedNameId}.example` }
    ]);
    await redis.hset(
      keys.pool(otherWorkspaceId),
      sharedNameId,
      JSON.stringify({
        instanceId: sharedNameId,
        url: `https://${sharedNameId}.example`,
        activeJobs: 0,
        lastIdleAt: Date.now(),
        readyAt: Date.now()
      })
    );
    await redis.hset(
      keys.orphanSeen(workspaceId),
      sharedNameId,
      String(Date.now() - (DEFAULT_ORPHAN_GRACE_MS + 60_000))
    );

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([]);
    expect(removeInstance).not.toHaveBeenCalled();
  });

  it('ignores instances that belong to a different workspace prefix', async () => {
    const redis = new FakeRedis();
    listInstances.mockResolvedValue([
      { name: 'scalersomeoneelsexyz', url: 'https://other.example' },
      { name: 'manually-provisioned-encore', url: 'https://manual.example' }
    ]);

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([]);
    expect(removeInstance).not.toHaveBeenCalled();
    expect(await redis.hgetall(keys.orphanSeen(workspaceId))).toEqual({});
  });

  it('is a no-op when OSC cannot be listed (never acts on a partial view)', async () => {
    const redis = new FakeRedis();
    listInstances.mockRejectedValue(new Error('ORCHESTRATOR_UNAVAILABLE'));
    await redis.hset(
      keys.orphanSeen(workspaceId),
      orphanId,
      String(Date.now() - (DEFAULT_ORPHAN_GRACE_MS + 60_000))
    );

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([]);
    expect(removeInstance).not.toHaveBeenCalled();
  });

  it('honours a configured grace window', async () => {
    const redis = new FakeRedis();
    listInstances.mockResolvedValue([
      { name: orphanId, url: `https://${orphanId}.example` }
    ]);
    await redis.hset(
      keys.orphanSeen(workspaceId),
      orphanId,
      String(Date.now() - 30_000)
    );

    // 30s orphaned, 60s grace -> still protected.
    expect(
      await reapOrphanedInstances(makeConfig(redis, workspaceId, { orphanGraceMs: 60_000 }))
    ).toEqual([]);
    expect(removeInstance).not.toHaveBeenCalled();

    // Same sighting, 10s grace -> reaped.
    expect(
      await reapOrphanedInstances(makeConfig(redis, workspaceId, { orphanGraceMs: 10_000 }))
    ).toEqual([orphanId]);
  });
});
