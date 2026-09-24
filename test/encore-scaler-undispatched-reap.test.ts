// Scale-down tests for the never-dispatched / unusable-idle-timestamp instance
// (issue #778).
//
// The leak: an Encore instance the scaler spawns but never dispatches a job to
// was held forever. `lastIdleAt` is only advanced when a job COMPLETES
// (src/pipeline/encore-callback-poller.ts:320, src/routes/internal.ts:194), so
// an instance with no completion behind it — or one whose record lost its
// timestamp — fed a non-number into `now - lastIdleAt > idleTimeoutMs`, and a
// comparison against NaN is false forever. The instance kept billing.
//
// The fix has two halves, both covered here:
//   1. `readyAt` (stamped when the instance enters the pool) is the idle clock's
//      fallback basis, so a never-dispatched instance is idle from readiness.
//   2. A record with NO usable timestamp fails CLOSED — treated as idle-aged
//      (eligible), never "hold indefinitely".
//
// The fail-closed half must NOT regress the drain protections: an eligible
// candidate is still checked against Encore's authoritative QUEUED/IN_PROGRESS
// state (#513) and the packaging pin (#525 pt.2) before anything is destroyed.
// Both of those are asserted below against a record with no timestamp at all.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - EncoreInstanceRecord { instanceId, url, activeJobs, lastIdleAt, readyAt?,
//     draining?, callbackTrustReady? } (src/encore-scaler/types.ts:146-196).
//   - keys.pool / keys.pendingPackaging (src/encore-scaler/types.ts:205-262).
//   - EncoreScalerLoop.tick scale-down block: teardown-candidate predicate
//     `(activeJobs===0 && idlePastTimeout) || draining===true`, then
//     fetchRealActiveState + hasPendingPackaging before destroyInstance
//     (src/encore-scaler/scaler-loop.ts).
//   - resolveIdleSince / isIdlePastTimeout (src/encore-scaler/scaler-loop.ts).
//   - Encore findByStatus HATEOAS page shape
//     { _embedded: { encoreJobs: [{ externalId }] }, page: { totalElements } }
//     (fetchRealActiveState, src/encore-scaler/scaler-loop.ts).
//   - hasPendingPackaging reads SCARD encore:pending-packaging:{instanceId}
//     (src/encore-scaler/packaging-pin.ts).
//   - destroyInstance(instanceId, config) (src/encore-scaler/instance-pool.ts).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY the OSC-touching pool functions; keep the pure-Redis helpers real.
const destroyInstance = vi.fn(async () => undefined);
const spawnInstance = vi.fn(async () => ({
  instanceId: `spawned-${Date.now()}`,
  url: 'https://spawned.example',
  activeJobs: 0,
  lastIdleAt: Date.now(),
  readyAt: Date.now(),
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

import {
  EncoreScalerLoop,
  isIdlePastTimeout,
  resolveIdleSince
} from '../src/encore-scaler/scaler-loop.js';
import {
  keys,
  type EncoreInstanceRecord,
  type EncoreScalerConfig
} from '../src/encore-scaler/types.js';

// Minimal in-memory Redis exposing only the commands the scaler tick and the
// pool helpers touch. Values are strings, mirroring ioredis.
class FakeRedis {
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
  private set_(key: string): Set<string> {
    let s = this.sets.get(key);
    if (!s) {
      s = new Set();
      this.sets.set(key, s);
    }
    return s;
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
  async rpoplpush(): Promise<string | null> {
    return null; // queue is always empty in these tests
  }
  // Packaging pin (#525 pt.2) — SADD/SCARD/PEXPIRE.
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
    return this.set_(key).size;
  }
  async pexpire(): Promise<number> {
    return 1;
  }
}

const OSC_CONTEXT_STUB = {
  getServiceAccessToken: async () => 'test-token'
} as unknown as EncoreScalerConfig['oscContext'];

function makeConfig(
  redis: FakeRedis,
  workspaceId: string,
  idleTimeoutMs: number
): EncoreScalerConfig {
  return {
    workspaceId,
    maxInstances: 3,
    minInstances: 0,
    idleTimeoutMs,
    redisUrl: 'redis://fake',
    oscContext: OSC_CONTEXT_STUB,
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => 'test-token'
    // orphanReapIntervalMs intentionally unset: the OSC orphan sweep is opt-in,
    // so these loop tests make no OSC list calls.
  };
}

// A record exactly as spawnInstance writes one for a FRESH instance that has
// never been dispatched a job: activeJobs 0, readyAt stamped at pool entry.
function neverDispatchedRecord(
  instanceId: string,
  readyMsAgo: number,
  overrides: Partial<EncoreInstanceRecord> = {}
): EncoreInstanceRecord {
  const readyAt = Date.now() - readyMsAgo;
  return {
    instanceId,
    url: `https://${instanceId}.example`,
    activeJobs: 0,
    lastIdleAt: readyAt,
    readyAt,
    // Pre-mark trust so the dispatch gate never runs a real HTTPS probe.
    callbackTrustReady: true,
    ...overrides
  };
}

function statusPage(count: number): Response {
  const encoreJobs = Array.from({ length: count }, (_, i) => ({
    externalId: `ext-${i}`
  }));
  return new Response(
    JSON.stringify({ _embedded: { encoreJobs }, page: { totalElements: count } }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

function stubEncoreFetch(counts: { queued: number; inProgress: number }): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL) => {
      const url = String(input);
      if (url.includes('status=QUEUED')) return statusPage(counts.queued);
      if (url.includes('status=IN_PROGRESS')) return statusPage(counts.inProgress);
      throw new Error(`unexpected fetch in test: ${url}`);
    })
  );
}

async function seed(
  redis: FakeRedis,
  workspaceId: string,
  record: Record<string, unknown>
): Promise<void> {
  await redis.hset(
    keys.pool(workspaceId),
    record['instanceId'] as string,
    JSON.stringify(record)
  );
}

describe('idle-clock basis (issue #778)', () => {
  it('prefers a real completion timestamp when there is one', () => {
    const record = neverDispatchedRecord('inst', 60_000, { lastIdleAt: 42 });
    expect(resolveIdleSince(record)).toBe(42);
  });

  it('falls back to readyAt when the instance has never completed a job', () => {
    const readyAt = Date.now() - 60_000;
    const record = {
      instanceId: 'inst',
      url: 'https://inst.example',
      activeJobs: 0,
      readyAt
    } as unknown as EncoreInstanceRecord;
    expect(resolveIdleSince(record)).toBe(readyAt);
  });

  it('treats an unusable timestamp as eligible rather than never-eligible', () => {
    const noTimestamps = {
      instanceId: 'inst',
      url: 'https://inst.example',
      activeJobs: 0
    } as unknown as EncoreInstanceRecord;
    expect(resolveIdleSince(noTimestamps)).toBeUndefined();
    expect(isIdlePastTimeout(noTimestamps, Date.now(), 300_000)).toBe(true);

    const unparseable = {
      ...noTimestamps,
      lastIdleAt: 'never'
    } as unknown as EncoreInstanceRecord;
    expect(resolveIdleSince(unparseable)).toBeUndefined();
    expect(isIdlePastTimeout(unparseable, Date.now(), 300_000)).toBe(true);
  });
});

describe('scale-down reaps an instance that was spawned but never dispatched a job (issue #778)', () => {
  beforeEach(() => {
    destroyInstance.mockClear();
    spawnInstance.mockClear();
    // A never-dispatched instance has no real work anywhere.
    stubEncoreFetch({ queued: 0, inProgress: 0 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('destroys it once idleTimeoutMs has passed since it became ready', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-never-dispatched';
    const idleTimeoutMs = 300_000; // the 5 min default from the report

    // Ready 20 hours ago and never given a job — the exact observed leak.
    const record = neverDispatchedRecord('inst-never', 20 * 60 * 60_000);
    await seed(redis, workspaceId, record);

    const loop = new EncoreScalerLoop(makeConfig(redis, workspaceId, idleTimeoutMs));
    await loop.tick();

    expect(destroyInstance).toHaveBeenCalledTimes(1);
    expect(destroyInstance).toHaveBeenCalledWith(record.instanceId, expect.anything());
  });

  it('destroys it even when the record carries readyAt only (no completion ever wrote lastIdleAt)', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-ready-only';
    const idleTimeoutMs = 300_000;

    // No lastIdleAt field at all: nothing has ever completed on this instance.
    const readyAt = Date.now() - 6 * 60_000; // ready 6 min ago, timeout 5 min
    await seed(redis, workspaceId, {
      instanceId: 'inst-ready-only',
      url: 'https://inst-ready-only.example',
      activeJobs: 0,
      readyAt,
      callbackTrustReady: true
    });

    const loop = new EncoreScalerLoop(makeConfig(redis, workspaceId, idleTimeoutMs));
    await loop.tick();

    expect(destroyInstance).toHaveBeenCalledTimes(1);
    expect(destroyInstance).toHaveBeenCalledWith('inst-ready-only', expect.anything());
  });

  it('keeps a freshly-ready instance until its idle timeout actually elapses', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-fresh';
    const idleTimeoutMs = 300_000;

    // Ready 30s ago — well inside the timeout. Scale-down must leave it alone
    // (otherwise every spawn would be torn down before it could take work).
    const record = neverDispatchedRecord('inst-fresh', 30_000);
    await seed(redis, workspaceId, record);

    const loop = new EncoreScalerLoop(makeConfig(redis, workspaceId, idleTimeoutMs));
    await loop.tick();

    expect(destroyInstance).not.toHaveBeenCalled();
    expect(await redis.hgetall(keys.pool(workspaceId))).toHaveProperty(record.instanceId);
  });
});

describe('scale-down fails closed on a missing/unparseable idle timestamp (issue #778)', () => {
  beforeEach(() => {
    destroyInstance.mockClear();
    spawnInstance.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('destroys an idle instance whose record has no idle timestamp at all', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-no-timestamp';
    stubEncoreFetch({ queued: 0, inProgress: 0 });

    await seed(redis, workspaceId, {
      instanceId: 'inst-no-ts',
      url: 'https://inst-no-ts.example',
      activeJobs: 0,
      callbackTrustReady: true
    });

    const loop = new EncoreScalerLoop(makeConfig(redis, workspaceId, 300_000));
    await loop.tick();

    expect(destroyInstance).toHaveBeenCalledTimes(1);
    expect(destroyInstance).toHaveBeenCalledWith('inst-no-ts', expect.anything());
  });

  it('destroys an idle instance whose idle timestamp is unparseable', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-bad-timestamp';
    stubEncoreFetch({ queued: 0, inProgress: 0 });

    await seed(redis, workspaceId, {
      instanceId: 'inst-bad-ts',
      url: 'https://inst-bad-ts.example',
      activeJobs: 0,
      lastIdleAt: 'not-a-number',
      callbackTrustReady: true
    });

    const loop = new EncoreScalerLoop(makeConfig(redis, workspaceId, 300_000));
    await loop.tick();

    expect(destroyInstance).toHaveBeenCalledTimes(1);
    expect(destroyInstance).toHaveBeenCalledWith('inst-bad-ts', expect.anything());
  });

  // NO REGRESSION to #513: fail-closed eligibility only makes an instance a
  // CANDIDATE. The authoritative real-state check still protects live work.
  it('drains (never destroys) an unparseable-timestamp instance that has real in-flight work', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-bad-ts-busy';
    stubEncoreFetch({ queued: 0, inProgress: 1 });

    await seed(redis, workspaceId, {
      instanceId: 'inst-bad-ts-busy',
      url: 'https://inst-bad-ts-busy.example',
      activeJobs: 0,
      lastIdleAt: null,
      callbackTrustReady: true
    });

    const loop = new EncoreScalerLoop(makeConfig(redis, workspaceId, 300_000));
    await loop.tick();

    expect(destroyInstance).not.toHaveBeenCalled();
    const raw = await redis.hgetall(keys.pool(workspaceId));
    const persisted = JSON.parse(raw['inst-bad-ts-busy']!) as EncoreInstanceRecord;
    expect(persisted.draining).toBe(true);
    expect(persisted.activeJobs).toBe(1);
  });

  // NO REGRESSION to #525 pt.2: a pending packaging handoff still pins the
  // instance, even when its idle timestamp is unusable.
  it('drains (never destroys) an unparseable-timestamp instance with a pending packaging handoff', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-bad-ts-packaging';
    stubEncoreFetch({ queued: 0, inProgress: 0 }); // Encore reports zero work

    await seed(redis, workspaceId, {
      instanceId: 'inst-bad-ts-pkg',
      url: 'https://inst-bad-ts-pkg.example',
      activeJobs: 0,
      callbackTrustReady: true
    });
    // The transcode->package handoff pinned this instance.
    await redis.sadd(keys.pendingPackaging('inst-bad-ts-pkg'), 'ws::job-1');

    const loop = new EncoreScalerLoop(makeConfig(redis, workspaceId, 300_000));
    await loop.tick();

    expect(destroyInstance).not.toHaveBeenCalled();
    const raw = await redis.hgetall(keys.pool(workspaceId));
    const persisted = JSON.parse(raw['inst-bad-ts-pkg']!) as EncoreInstanceRecord;
    expect(persisted.draining).toBe(true);
  });

  // Review finding 6: the missing-timestamp warning is re-evaluated on every 10s
  // tick and the condition persists until the instance is torn down, so an
  // unthrottled warn emitted ~6 times a minute per affected instance. It must be
  // logged, but once per instance per window — not once per tick.
  it('throttles the missing-idle-timestamp warning to once per instance', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-warn-throttle';
    // An unreachable instance is KEPT (never destroyed on an unconfirmed count),
    // and its tracked activeJobs stays 0 — so the warn condition persists across
    // every tick, exactly as it does in production until teardown.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );
    await seed(redis, workspaceId, {
      instanceId: 'inst-warn',
      url: 'https://inst-warn.example',
      activeJobs: 0,
      lastIdleAt: null,
      callbackTrustReady: true
    });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const loop = new EncoreScalerLoop(makeConfig(redis, workspaceId, 300_000));
      for (let i = 0; i < 5; i++) await loop.tick();

      const missingStampWarnings = warn.mock.calls.filter((call) =>
        String(call[0]).includes('has no usable idle timestamp')
      );
      expect(missingStampWarnings).toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });
});
