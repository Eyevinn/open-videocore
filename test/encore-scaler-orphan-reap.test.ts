// Orphan-instance reaper + readyAt stamping tests (issue #778).
//
// Every existing teardown path iterates the Valkey pool hash
// (scaler-loop.ts scale-down, workspace-registry.ts teardown), so an Encore
// instance that is running on OSC but absent from that hash — a spawn that died
// between createInstance and the pool write, a wiped Valkey, a deleted
// deployment — has nothing that can ever destroy it and bills until an operator
// notices it by hand. reapOrphanedInstances() closes that hole.
//
// Safety properties under test (the review of PR #784 made these blocking):
//   1. OWNERSHIP IS PROVEN. `listInstances` is tenant-wide while each stack reads
//      its OWN Valkey (workspace-registry.ts resolveStackRedis, #615), so a
//      prefix-inferred owner test lets stack `dev` destroy stack `dev-2`'s LIVE
//      instances. Only the owner-tagged exact name shape is reapable.
//   2. NO WORK IS DESTROYED. An orphan is by definition not pool-tracked, so the
//      pool-side drain protections (#513/#525 pt.2) cannot speak for it: the
//      reaper must positively confirm the instance has no in-flight work, and
//      adopt it into the pool (to be drained) when it does.
//   3. GRACE WINDOW. An in-progress spawn legitimately holds a live OSC instance
//      with no pool record, so nothing is reaped on first sighting.
//   4. LEAKED LISTENERS ARE SWEPT TOO — the same billing leak one service over.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - @osaas/client-core lib/core.d.ts (v0.24.0):
//       createInstance(context, serviceId, token, body): Promise<any>  (:32)
//       removeInstance(context, serviceId, name, token): Promise<void> (:46)
//       listInstances(context, serviceId, token): Promise<any>         (:65)
//       getInstanceHealth(context, serviceId, name, token): Promise<string> (:86)
//     'running' is the ready state the SDK's own waitForInstanceReady gates on
//     (lib/core.js:347-349); the scaler polls getInstanceHealth itself because
//     waitForInstanceReady has no timeout and no abort (lib/core.js:343-353).
//     listInstances returns the raw JSON array from the OSC instances endpoint
//     (lib/core.js listInstances) — elements carry `name`/`url`, and NO creation
//     timestamp, which is why first-sighting is tracked in Valkey.
//   - isValidInstanceName = /^[a-z0-9]+$/ (lib/core.js:49-51), enforced by
//     createInstance (lib/core.js:77) — no delimiter is available in a name, which
//     is why ownership is carried by a fixed-width hex owner tag.
//   - Instance naming / ownership: scalerInstancePrefix(),
//     legacyScalerInstancePrefix(), classifyInstanceOwnership()
//     (src/encore-scaler/instance-pool.ts).
//   - Encore active-state query: GET {url}/encoreJobs/search/findByStatus?status=
//     QUEUED|IN_PROGRESS returning a Spring HATEOAS page
//     { _embedded: { encoreJobs: [{ externalId }] }, page: { totalElements } } —
//     src/encore-scaler/encore-active-state.ts, the same query
//     scaler-loop.ts fetchRealActiveState runs.
//   - keys.pool / keys.orphanSeen / keys.pendingPackaging
//     (src/encore-scaler/types.ts).
//   - EncoreInstanceRecord.readyAt (src/encore-scaler/types.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const createInstance = vi.fn();
const removeInstance = vi.fn(async () => undefined);
const listInstances = vi.fn(async () => [] as Array<Record<string, unknown>>);
const getInstanceHealth = vi.fn(async (..._args: unknown[]) => 'running');

vi.mock('@osaas/client-core', () => ({
  createInstance: (...args: unknown[]) => createInstance(...args),
  removeInstance: (...args: unknown[]) => removeInstance(...args),
  listInstances: (...args: unknown[]) => listInstances(...args),
  getInstanceHealth: (...args: unknown[]) => getInstanceHealth(...args)
}));

import {
  classifyInstanceOwnership,
  DEFAULT_ORPHAN_GRACE_MS,
  ENCORE_CALLBACK_LISTENER_SERVICE_ID,
  ENCORE_SERVICE_ID,
  legacyScalerInstancePrefix,
  reapOrphanedInstances,
  scalerInstancePrefix,
  spawnInstance
} from '../src/encore-scaler/instance-pool.js';
import {
  keys,
  type EncoreInstanceRecord,
  type EncoreScalerConfig
} from '../src/encore-scaler/types.js';

// In-memory Redis covering the commands the reaper and spawn path touch: hash
// reads/writes, SCAN/HKEYS for the cross-pool tracked-id sweep, and SCARD for the
// packaging pin (#525 pt.2).
class FakeRedis {
  private hashes = new Map<string, Map<string, string>>();
  private sets = new Map<string, Set<string>>();

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
  async sadd(key: string, member: string): Promise<number> {
    let s = this.sets.get(key);
    if (!s) {
      s = new Set();
      this.sets.set(key, s);
    }
    s.add(member);
    return 1;
  }
  async scard(key: string): Promise<number> {
    return this.sets.get(key)?.size ?? 0;
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
    // Keep the readiness poll sub-millisecond in tests; production uses the
    // 1s default (DEFAULT_SPAWN_READY_POLL_INTERVAL_MS).
    spawnReadyPollIntervalMs: 1,
    ...overrides
  };
}

// A HATEOAS findByStatus page carrying `count` active jobs, as Encore returns it.
function statusPage(count: number): Response {
  return new Response(
    JSON.stringify({
      _embedded: {
        encoreJobs: Array.from({ length: count }, (_v, i) => ({
          externalId: `job-${i}`
        }))
      },
      page: { totalElements: count }
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

// Stub global fetch so the reaper's authoritative "does this instance have work?"
// query resolves deterministically. QUEUED and IN_PROGRESS are each asked once
// per instance, so `perQuery` counts are summed by the production code.
function stubEncoreActiveJobs(perQuery: number): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async () => statusPage(perQuery));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('spawnInstance stamps readyAt on the pool record (issue #778)', () => {
  beforeEach(() => {
    createInstance.mockReset();
    removeInstance.mockReset();
    removeInstance.mockResolvedValue(undefined);
    listInstances.mockReset();
    getInstanceHealth.mockReset();
    getInstanceHealth.mockResolvedValue('running');
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

  // Review finding 3: a spawn that dies AFTER the callback listener was created
  // used to leak the listener — the identical billing leak as #778, one service
  // over, and nothing swept it either.
  it('removes the paired callback listener too when the spawn fails after creating it', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-listener-leak';
    createInstance.mockImplementation(async (_ctx, _svc, _tok, body) => ({
      name: (body as { name: string }).name,
      url: `https://${(body as { name: string }).name}.example`
    }));
    // Encore becomes ready; the LISTENER never does. getInstanceHealth's
    // 2nd positional arg is the serviceId (lib/core.d.ts:86).
    getInstanceHealth.mockImplementation(async (..._args: unknown[]) => {
      if (_args[1] === ENCORE_CALLBACK_LISTENER_SERVICE_ID) {
        throw new Error('listener never became ready');
      }
      return 'running';
    });

    await expect(
      spawnInstance(makeConfig(redis, workspaceId, { spawnReadyTimeoutMs: 20 }))
    ).rejects.toThrow(/listener never became ready/);

    const removedServices = removeInstance.mock.calls.map((call) => call[1]);
    expect(removedServices).toContain(ENCORE_SERVICE_ID);
    expect(removedServices).toContain(ENCORE_CALLBACK_LISTENER_SERVICE_ID);
    // Nothing is left in the pool for a half-spawned instance.
    expect(await redis.hgetall(keys.pool(workspaceId))).toEqual({});
  });

  // Review finding 4: @osaas/client-core's waitForInstanceReady polls
  // getInstanceHealth in a `while` loop with NO timeout (lib/core.js:343-353), so
  // an instance that never reports `running` used to hang the spawn forever while
  // holding a live, billing OSC instance with no pool record.
  it('bounds the readiness wait and cleans up when the instance never becomes ready', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-hang';
    createInstance.mockImplementation(async (_ctx, _svc, _tok, body) => ({
      name: (body as { name: string }).name,
      url: `https://${(body as { name: string }).name}.example`
    }));
    // Health never reaches 'running' — exactly the state the unbounded OSC
    // helper would spin on forever.
    getInstanceHealth.mockResolvedValue('starting');

    await expect(
      spawnInstance(makeConfig(redis, workspaceId, { spawnReadyTimeoutMs: 50 }))
    ).rejects.toThrow(/timed out after 50ms waiting for OSC instance/);

    // The live Encore instance is destroyed rather than left to bill.
    expect(removeInstance.mock.calls.map((call) => call[1])).toContain(ENCORE_SERVICE_ID);
    expect(await redis.hgetall(keys.pool(workspaceId))).toEqual({});
  });

  // Review round 2 (non-blocking, instance-pool.ts:285): the first fix raced a
  // timer against waitForInstanceReady, which has no abort — so after the
  // timeout the SDK's `while (!instanceOk)` loop kept issuing one
  // getInstanceHealth call per second for the lifetime of the process, once per
  // timed-out spawn. The scaler now owns the poll loop, so polling stops at the
  // deadline: no health call may be issued after the spawn has rejected.
  it('stops polling health once the readiness deadline passes', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-nopoll';
    createInstance.mockImplementation(async (_ctx, _svc, _tok, body) => ({
      name: (body as { name: string }).name,
      url: `https://${(body as { name: string }).name}.example`
    }));
    getInstanceHealth.mockResolvedValue('starting');

    await expect(
      spawnInstance(
        makeConfig(redis, workspaceId, {
          spawnReadyTimeoutMs: 30,
          spawnReadyPollIntervalMs: 5
        })
      )
    ).rejects.toThrow(/timed out after 30ms/);

    const callsAtRejection = getInstanceHealth.mock.calls.length;
    expect(callsAtRejection).toBeGreaterThan(0);
    // Well past several poll intervals and past the original timeout.
    await new Promise((r) => setTimeout(r, 60));
    expect(getInstanceHealth.mock.calls.length).toBe(callsAtRejection);
  });
});

describe('orphan reaper — instances on OSC with no pool record (issue #778)', () => {
  const workspaceId = 'lucas';
  const prefix = scalerInstancePrefix(workspaceId);
  const orphanId = `${prefix}mue95gh2`;

  beforeEach(() => {
    createInstance.mockReset();
    removeInstance.mockReset();
    removeInstance.mockResolvedValue(undefined);
    listInstances.mockReset();
    listInstances.mockResolvedValue([]);
    getInstanceHealth.mockReset();
    getInstanceHealth.mockResolvedValue('running');
    // Default: every instance the reaper asks reports NO active jobs.
    stubEncoreActiveJobs(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // Only the Encore service list carries `name`/`url` for the orphan; the
  // listener list is queried separately by the sweep.
  function listOnlyEncore(instances: Array<{ name: string; url?: string }>): void {
    listInstances.mockImplementation(async (_ctx, serviceId: string) =>
      serviceId === ENCORE_SERVICE_ID ? instances : []
    );
  }

  async function seenLongAgo(redis: FakeRedis, id: string): Promise<void> {
    await redis.hset(
      keys.orphanSeen(workspaceId),
      id,
      String(Date.now() - (DEFAULT_ORPHAN_GRACE_MS + 60_000))
    );
  }

  it('does not destroy an instance on its first sighting — it starts the grace window', async () => {
    const redis = new FakeRedis();
    listOnlyEncore([{ name: orphanId, url: `https://${orphanId}.example` }]);

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([]);
    expect(removeInstance).not.toHaveBeenCalled();
    const seen = await redis.hgetall(keys.orphanSeen(workspaceId));
    expect(Number(seen[orphanId])).toBeGreaterThan(0);
  });

  it('destroys an idle instance still orphaned after the grace window', async () => {
    const redis = new FakeRedis();
    listOnlyEncore([{ name: orphanId, url: `https://${orphanId}.example` }]);
    await seenLongAgo(redis, orphanId);

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([orphanId]);
    // The Encore instance AND its paired callback listener are removed.
    expect(removeInstance).toHaveBeenCalledWith(
      expect.anything(),
      ENCORE_SERVICE_ID,
      orphanId,
      'test-token'
    );
    expect(removeInstance).toHaveBeenCalledWith(
      expect.anything(),
      ENCORE_CALLBACK_LISTENER_SERVICE_ID,
      orphanId,
      'test-token'
    );
    // Sighting cleared so a future instance of the same name starts fresh.
    expect(await redis.hgetall(keys.orphanSeen(workspaceId))).toEqual({});
  });

  // Review finding 2 (blocking): scale-down never destroys without the
  // authoritative in-flight-work check, and neither may the reaper. In the
  // wiped-Valkey scenario the reaper exists for, the orphan may be mid-transcode.
  it('NEVER destroys a busy orphan — it adopts it so the drain logic owns it', async () => {
    const redis = new FakeRedis();
    listOnlyEncore([{ name: orphanId, url: `https://${orphanId}.example` }]);
    await seenLongAgo(redis, orphanId);
    stubEncoreActiveJobs(1); // Encore reports a live QUEUED + IN_PROGRESS job

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([]);
    expect(removeInstance).not.toHaveBeenCalled();
    // Adopted into the pool, with the real active count, so scale-down's
    // drain-don't-kill path (#513) takes ownership of its teardown.
    const pool = await redis.hgetall(keys.pool(workspaceId));
    const adopted = JSON.parse(pool[orphanId]!) as EncoreInstanceRecord;
    expect(adopted.instanceId).toBe(orphanId);
    expect(adopted.activeJobs).toBeGreaterThan(0);
    expect(await redis.hgetall(keys.orphanSeen(workspaceId))).toEqual({});
  });

  it('NEVER destroys an orphan whose real state cannot be confirmed', async () => {
    const redis = new FakeRedis();
    listOnlyEncore([{ name: orphanId, url: `https://${orphanId}.example` }]);
    await seenLongAgo(redis, orphanId);
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([]);
    expect(removeInstance).not.toHaveBeenCalled();
    // The sighting is kept so the next sweep retries rather than restarting the
    // grace window from scratch.
    const seen = await redis.hgetall(keys.orphanSeen(workspaceId));
    expect(seen[orphanId]).toBeDefined();
  });

  it('NEVER destroys an orphan with a pending packaging handoff (#525 pt.2)', async () => {
    const redis = new FakeRedis();
    listOnlyEncore([{ name: orphanId, url: `https://${orphanId}.example` }]);
    await seenLongAgo(redis, orphanId);
    // Encore itself reports zero work, but packaging is still pinned to it.
    await redis.sadd(keys.pendingPackaging(orphanId), 'job-abc');

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([]);
    expect(removeInstance).not.toHaveBeenCalled();
    expect(await redis.hgetall(keys.pool(workspaceId))).toHaveProperty(orphanId);
  });

  it('never touches an instance that has a pool record, however long it has run', async () => {
    const redis = new FakeRedis();
    const trackedId = `${prefix}tracked`;
    listOnlyEncore([{ name: trackedId, url: `https://${trackedId}.example` }]);
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
    await seenLongAgo(redis, trackedId);

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([]);
    expect(removeInstance).not.toHaveBeenCalled();
    // The stale sighting is cleared, because it is no longer an orphan.
    expect(await redis.hgetall(keys.orphanSeen(workspaceId))).toEqual({});
  });

  it('never touches an instance tracked in ANOTHER workspace pool on the same Valkey', async () => {
    const redis = new FakeRedis();
    const otherWorkspaceId = 'lucas-2'; // sanitises to a colliding name label
    const sharedNameId = `${scalerInstancePrefix(otherWorkspaceId)}abc`;
    listOnlyEncore([{ name: sharedNameId, url: `https://${sharedNameId}.example` }]);
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
    await seenLongAgo(redis, sharedNameId);

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([]);
    expect(removeInstance).not.toHaveBeenCalled();
  });

  // Review finding 1 (blocking, critical). This is the case a single-Valkey
  // tracked-id sweep CANNOT save: two stacks in one OSC tenant whose sanitised
  // names are prefixes of one another, each with its own Valkey (#615). Stack
  // `lucas` sees stack `lucas-2`'s healthy instances and finds no record for them
  // on ITS Valkey. Ownership must be proven by the name shape alone.
  it('never touches a prefix-colliding FOREIGN stack instance that is absent from this Valkey', async () => {
    const redis = new FakeRedis();
    const foreignWorkspaceId = 'lucas-2';
    // The foreign stack's own live instance, named by the same code path.
    const foreignId = `${scalerInstancePrefix(foreignWorkspaceId)}mue95gh2`;
    // Sanity: it DOES start with the old prefix-only ownership test for `lucas`.
    expect(foreignId.startsWith(legacyScalerInstancePrefix(workspaceId))).toBe(true);
    // ...but it is not ours under the owner-tagged shape.
    expect(classifyInstanceOwnership(workspaceId, foreignId)).toBe('foreign');
    expect(classifyInstanceOwnership(foreignWorkspaceId, foreignId)).toBe('owned');

    listOnlyEncore([{ name: foreignId, url: `https://${foreignId}.example` }]);
    // Nothing on THIS Valkey knows about it — the whole hazard.
    await seenLongAgo(redis, foreignId);

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([]);
    expect(removeInstance).not.toHaveBeenCalled();
  });

  it('never destroys a pre-owner-tag name whose owner cannot be proven', async () => {
    const redis = new FakeRedis();
    // Old-scheme name: `scaler{sanitisedWorkspaceId}{base36 Date.now()}`.
    const legacyId = `${legacyScalerInstancePrefix(workspaceId)}mue95gh2`;
    expect(classifyInstanceOwnership(workspaceId, legacyId)).toBe('legacy-ambiguous');
    listOnlyEncore([{ name: legacyId, url: `https://${legacyId}.example` }]);
    await seenLongAgo(redis, legacyId);

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([]);
    expect(removeInstance).not.toHaveBeenCalled();
  });

  // Review finding 3: a listener whose Encore instance is already gone is the
  // same billing leak, and the sweep used to list only ENCORE_SERVICE_ID.
  it('reaps a leaked callback listener whose Encore instance is already gone', async () => {
    const redis = new FakeRedis();
    listInstances.mockImplementation(async (_ctx, serviceId: string) =>
      serviceId === ENCORE_CALLBACK_LISTENER_SERVICE_ID
        ? [{ name: orphanId, url: `https://${orphanId}-listener.example` }]
        : []
    );
    await seenLongAgo(redis, orphanId);

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([orphanId]);
    expect(removeInstance).toHaveBeenCalledWith(
      expect.anything(),
      ENCORE_CALLBACK_LISTENER_SERVICE_ID,
      orphanId,
      'test-token'
    );
  });

  it('ignores instances that belong to a different workspace prefix', async () => {
    const redis = new FakeRedis();
    listOnlyEncore([
      { name: 'scalersomeoneelsexyz', url: 'https://other.example' },
      { name: 'manuallyprovisionedencore', url: 'https://manual.example' }
    ]);

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([]);
    expect(removeInstance).not.toHaveBeenCalled();
    expect(await redis.hgetall(keys.orphanSeen(workspaceId))).toEqual({});
  });

  it('is a no-op when OSC cannot be listed (never acts on a partial view)', async () => {
    const redis = new FakeRedis();
    listInstances.mockRejectedValue(new Error('ORCHESTRATOR_UNAVAILABLE'));
    await seenLongAgo(redis, orphanId);

    const reaped = await reapOrphanedInstances(makeConfig(redis, workspaceId));

    expect(reaped).toEqual([]);
    expect(removeInstance).not.toHaveBeenCalled();
  });

  it('honours a configured grace window', async () => {
    const redis = new FakeRedis();
    listOnlyEncore([{ name: orphanId, url: `https://${orphanId}.example` }]);
    await redis.hset(keys.orphanSeen(workspaceId), orphanId, String(Date.now() - 30_000));

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

describe('instance-name ownership is provable, not prefix-inferred (issue #778 review)', () => {
  it('separates stacks whose sanitised names collide entirely', () => {
    // `lu-cas` and `lucas` sanitise to the SAME label, so only the owner tag
    // (which hashes the raw id) can tell their instances apart.
    const a = `${scalerInstancePrefix('lucas')}mue95gh2`;
    const b = `${scalerInstancePrefix('lu-cas')}mue95gh2`;
    expect(a).not.toBe(b);
    expect(classifyInstanceOwnership('lucas', b)).toBe('foreign');
    expect(classifyInstanceOwnership('lu-cas', a)).toBe('foreign');
  });

  it('separates stacks whose sanitised names are prefixes of one another', () => {
    for (const [mine, theirs] of [
      ['dev', 'dev-2'],
      ['prod', 'production']
    ] as const) {
      const theirInstance = `${scalerInstancePrefix(theirs)}mue95gh2`;
      expect(classifyInstanceOwnership(mine, theirInstance)).toBe('foreign');
      expect(classifyInstanceOwnership(theirs, theirInstance)).toBe('owned');
      // And the old-scheme names are not mistaken for each other either.
      const theirLegacy = `${legacyScalerInstancePrefix(theirs)}mue95gh2`;
      expect(classifyInstanceOwnership(mine, theirLegacy)).toBe('foreign');
      expect(classifyInstanceOwnership(theirs, theirLegacy)).toBe('legacy-ambiguous');
    }
  });

  it('produces names OSC will accept (lowercase alphanumeric only)', () => {
    // isValidInstanceName = /^[a-z0-9]+$/ (@osaas/client-core lib/core.js:49-51).
    for (const ws of ['lucas', 'lu-cas', 'Prod_Stack 2', 'averyverylongstackname']) {
      const name = `${scalerInstancePrefix(ws)}mue95gh2`;
      expect(name).toMatch(/^[a-z0-9]+$/);
      expect(name.length).toBeLessThanOrEqual(34);
      expect(classifyInstanceOwnership(ws, name)).toBe('owned');
    }
  });
});
