// #1219 part 2: a cancelled job Encore will not stop must not pin its instance.
//
// Delivering the cancel (index.cancel-frozen-job.test.ts) is only half of #1219.
// The issue reproduces the other half by hand: step 4 POSTs the Encore cancel
// endpoint directly, step 5 observes it return 200 "Ok" while ffmpeg keeps
// running. A frozen job therefore stays in Encore's QUEUED+IN_PROGRESS set, and
// scale-down — which reads that set as authoritative "real in-flight work"
// (drain-don't-kill, #513) — drains the instance on every tick and never tears
// it down. That is why the reporter found "the only thing that stopped it was
// deleting the Encore instance".
//
// These tests pin the reclaim: an Encore job the operator cancelled more than
// the grace window ago stops protecting its instance, so the EXISTING scale-down
// teardown destroys it (which does stop the frozen process), while every other
// active job keeps full drain-don't-kill protection.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - findByStatus HATEOAS page shape { _embedded: { encoreJobs: [{ externalId }] },
//     page: { totalElements } }, and that `count` comes from totalElements while
//     `activeExternalIds` comes from the returned documents —
//     src/encore-scaler/encore-active-state.ts:40-59,107-123 and the captured
//     contract docs/contracts/encore-findbystatus-paging.json.
//   - Statuses queried as active: ENCORE_ACTIVE_STATUSES (QUEUED, IN_PROGRESS) —
//     src/encore-scaler/encore-paging-contract.ts.
//   - Scale-down drain/teardown boundary (real.count > 0 => drain, else
//     destroyInstance) — src/encore-scaler/scaler-loop.ts tick() step 4.
//   - Valkey key schema keys.pool / keys.jobInstance / keys.jobStatus /
//     keys.jobCancelRequested / keys.jobEncoreUrl — src/encore-scaler/types.ts.
//   - destroyInstance is the only OSC teardown call; stubbed so no OSC I/O —
//     src/encore-scaler/instance-pool.ts.
//   - Encore cancel endpoint POST {instanceUrl}/encoreJobs/{uuid}/cancel (SVT
//     Encore EncoreController.kt), mirrored by src/pipeline/encore-client.ts:53-58.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EncoreScalerLoop } from './scaler-loop.js';
import { makeScalingEncoreClient } from './index.js';
import {
  CANCEL_RECLAIM_GRACE_MS,
  instancesHoldingStuckCancelledJobs,
  recordOperatorCancel,
  stuckCancelledActiveIds
} from './cancelled-job-reclaim.js';
import { keys, type EncoreScalerConfig, type EncoreInstanceRecord } from './types.js';

const destroyInstanceMock = vi.hoisted(() => vi.fn());
vi.mock('./instance-pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./instance-pool.js')>();
  return { ...actual, destroyInstance: destroyInstanceMock };
});

// In-memory stand-in for the subset of ioredis these paths use.
class FakeRedis {
  strings = new Map<string, string>();
  hashes = new Map<string, Map<string, string>>();
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
  private set_(key: string): Set<string> {
    let s = this.sets.get(key);
    if (!s) {
      s = new Set();
      this.sets.set(key, s);
    }
    return s;
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
    return this.set_(key).size;
  }
  async pexpire(_key: string, _ms: number): Promise<number> {
    return 1;
  }
  // The real cancel marker is written with an EX TTL; expiry is not modelled
  // here (no test exercises it), so trailing TTL arguments are accepted and
  // ignored.
  async set(key: string, val: string, ..._rest: unknown[]): Promise<'OK'> {
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
const INSTANCE_ID = 'inst-1';
const INSTANCE_URL = 'https://encore.example';

function makeConfig(
  redis: FakeRedis,
  overrides?: Partial<EncoreScalerConfig>
): EncoreScalerConfig {
  return {
    workspaceId: WS,
    maxInstances: 2,
    minInstances: 0,
    idleTimeoutMs: 1_000,
    redisUrl: 'redis://fake',
    oscContext: {} as EncoreScalerConfig['oscContext'],
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => 'test-token',
    ...overrides
  };
}

// A findByStatus HATEOAS page. `totalElements` is stated separately from the
// returned documents so a TRUNCATED page (more active jobs than documents) can
// be modelled — that is the case EncoreActiveState.truncated describes.
function encorePage(externalIds: string[], totalElements = externalIds.length): Response {
  return {
    ok: true,
    json: async () => ({
      _embedded: { encoreJobs: externalIds.map((externalId) => ({ externalId })) },
      page: { totalElements }
    })
  } as unknown as Response;
}

function fetchMock(
  queued: string[],
  inProgress: string[],
  inProgressTotal?: number
): ReturnType<typeof vi.fn> {
  return vi.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('status=QUEUED')) return encorePage(queued);
    if (url.includes('status=IN_PROGRESS')) return encorePage(inProgress, inProgressTotal);
    throw new Error(`unexpected fetch: ${url}`);
  });
}

async function seedPool(redis: FakeRedis, record: EncoreInstanceRecord): Promise<void> {
  await redis.hset(keys.pool(WS), record.instanceId, JSON.stringify(record));
}

// The #1219 shape: an instance BUSY with a job the operator cancelled, whose
// cancel Encore accepted `cancelledMsAgo` ago and never acted on.
async function seedFrozenCancelledJob(
  redis: FakeRedis,
  jobId: string,
  cancelledMsAgo: number
): Promise<void> {
  await seedPool(redis, {
    instanceId: INSTANCE_ID,
    url: INSTANCE_URL,
    // Busy and freshly "active": neither the tracked count nor the idle clock
    // would ever make this instance a teardown candidate on its own.
    activeJobs: 1,
    lastIdleAt: Date.now()
  });
  await redis.hset(keys.jobInstance(WS), jobId, INSTANCE_ID);
  await redis.hset(keys.jobStatus(WS), jobId, 'CANCELLED');
  await redis.set(keys.jobCancelRequested(jobId), String(Date.now() - cancelledMsAgo));
}

describe('#1219: an operator-cancelled job Encore kept running stops pinning its instance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    destroyInstanceMock.mockReset();
  });

  it('reclaims the instance of a cancelled job Encore still reports active past the grace window', async () => {
    const redis = new FakeRedis();
    await seedFrozenCancelledJob(redis, 'job-frozen', CANCEL_RECLAIM_GRACE_MS * 2);

    // Encore still reports the cancelled job IN_PROGRESS — the frozen ffmpeg
    // that answered the cancel 200 "Ok" and kept going (#1219 step 5).
    vi.stubGlobal('fetch', fetchMock([], ['job-frozen']));
    destroyInstanceMock.mockResolvedValue(undefined);

    await new EncoreScalerLoop(makeConfig(redis)).tick();

    // Destroying the instance is the only thing that stops that process, and is
    // what the reporter had to do by hand.
    expect(destroyInstanceMock).toHaveBeenCalledTimes(1);
    expect(destroyInstanceMock.mock.calls[0][0]).toBe(INSTANCE_ID);
  });

  it('leaves a just-cancelled job its grace window before reclaiming anything', async () => {
    const redis = new FakeRedis();
    // Cancelled seconds ago: Encore may well be stopping it cleanly right now.
    await seedFrozenCancelledJob(redis, 'job-cancelling', 5_000);

    vi.stubGlobal('fetch', fetchMock([], ['job-cancelling']));
    destroyInstanceMock.mockResolvedValue(undefined);

    await new EncoreScalerLoop(makeConfig(redis)).tick();

    // A routine cancel must not churn instances.
    expect(destroyInstanceMock).not.toHaveBeenCalled();
  });

  it('keeps protecting an instance whose OTHER job is still genuinely running', async () => {
    const redis = new FakeRedis();
    await seedFrozenCancelledJob(redis, 'job-frozen', CANCEL_RECLAIM_GRACE_MS * 2);
    // A second, healthy transcode landed on the same instance.
    await redis.hset(keys.jobInstance(WS), 'job-healthy', INSTANCE_ID);
    await redis.hset(keys.jobStatus(WS), 'job-healthy', 'RUNNING');

    vi.stubGlobal('fetch', fetchMock([], ['job-frozen', 'job-healthy']));
    destroyInstanceMock.mockResolvedValue(undefined);

    await new EncoreScalerLoop(makeConfig(redis)).tick();

    // Drain-don't-kill still holds for work nobody cancelled.
    expect(destroyInstanceMock).not.toHaveBeenCalled();
    const raw = await redis.hget(keys.pool(WS), INSTANCE_ID);
    expect(JSON.parse(raw as string).draining).toBe(true);
  });

  it('does not reclaim on a TRUNCATED active page, where unseen jobs stay counted', async () => {
    const redis = new FakeRedis();
    await seedFrozenCancelledJob(redis, 'job-frozen', CANCEL_RECLAIM_GRACE_MS * 2);

    // Encore reports 2 active jobs but returns only the cancelled one's document:
    // the second job is real work we cannot identify, so the instance must live.
    vi.stubGlobal('fetch', fetchMock([], ['job-frozen'], 2));
    destroyInstanceMock.mockResolvedValue(undefined);

    await new EncoreScalerLoop(makeConfig(redis)).tick();

    expect(destroyInstanceMock).not.toHaveBeenCalled();
  });

  it('never reclaims an instance whose real state could not be confirmed', async () => {
    const redis = new FakeRedis();
    await seedFrozenCancelledJob(redis, 'job-frozen', CANCEL_RECLAIM_GRACE_MS * 2);

    // Encore unreachable: fetchRealActiveState returns undefined.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('connection refused');
      })
    );
    destroyInstanceMock.mockResolvedValue(undefined);

    await new EncoreScalerLoop(makeConfig(redis)).tick();

    expect(destroyInstanceMock).not.toHaveBeenCalled();
  });
});

describe('#1219: cancel() records the cancel and stops routing to the holding instance', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    destroyInstanceMock.mockReset();
  });

  it('writes the cancel marker and drains the instance holding a dispatched job', async () => {
    const redis = new FakeRedis();
    await seedPool(redis, {
      instanceId: INSTANCE_ID,
      url: INSTANCE_URL,
      activeJobs: 1,
      lastIdleAt: Date.now()
    });
    await redis.set(
      keys.jobEncoreUrl('job-frozen'),
      `${INSTANCE_URL}/encoreJobs/2b2c3356-0000-0000-0000-000000000000`
    );
    await redis.hset(keys.jobInstance(WS), 'job-frozen', INSTANCE_ID);

    // The frozen instance answers the cancel 200 "Ok" (#1219 step 5).
    const fetchSpy = vi.fn(
      async (_input: unknown, _init?: unknown) =>
        ({ ok: true, status: 200, text: async () => 'Ok' }) as unknown as Response
    );
    vi.stubGlobal('fetch', fetchSpy);

    const before = Date.now();
    await makeScalingEncoreClient(makeConfig(redis)).cancel('job-frozen');

    // The cancel was POSTed to the dispatch-time job URL.
    expect(String(fetchSpy.mock.calls[0][0])).toBe(
      `${INSTANCE_URL}/encoreJobs/2b2c3356-0000-0000-0000-000000000000/cancel`
    );
    // The marker carries WHEN it was cancelled — the grace window depends on it.
    const marker = await redis.get(keys.jobCancelRequested('job-frozen'));
    expect(Number(marker)).toBeGreaterThanOrEqual(before);
    // And no further transcode is routed to an instance whose job may be stuck.
    const raw = await redis.hget(keys.pool(WS), INSTANCE_ID);
    expect(JSON.parse(raw as string).draining).toBe(true);
  });

  it('records nothing for a job that was never dispatched (only queued)', async () => {
    const redis = new FakeRedis();
    await redis.rpush(
      keys.queue(WS),
      JSON.stringify({ jobId: 'job-queued', payload: {}, enqueuedAt: Date.now() })
    );

    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('no Encore call expected for an undispatched job');
      })
    );

    await makeScalingEncoreClient(makeConfig(redis)).cancel('job-queued');

    expect(await redis.get(keys.jobCancelRequested('job-queued'))).toBeNull();
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toHaveLength(0);
    expect(await redis.hget(keys.jobStatus(WS), 'job-queued')).toBe('CANCELLED');
  });
});

describe('#1219: cancelled-job reclaim helpers', () => {
  it('treats an active job as abandoned only once its grace window has elapsed', async () => {
    const redis = new FakeRedis();
    const now = Date.now();
    await redis.set(keys.jobCancelRequested('old'), String(now - CANCEL_RECLAIM_GRACE_MS - 1));
    await redis.set(keys.jobCancelRequested('fresh'), String(now - 1_000));

    const stuck = await stuckCancelledActiveIds(
      redis as unknown as Parameters<typeof stuckCancelledActiveIds>[0],
      new Set(['old', 'fresh', 'never-cancelled']),
      now
    );

    expect([...stuck]).toEqual(['old']);
  });

  it('ignores an unparseable marker rather than abandoning the job', async () => {
    const redis = new FakeRedis();
    await redis.set(keys.jobCancelRequested('weird'), 'not-a-timestamp');

    const stuck = await stuckCancelledActiveIds(
      redis as unknown as Parameters<typeof stuckCancelledActiveIds>[0],
      new Set(['weird']),
      Date.now()
    );

    expect(stuck.size).toBe(0);
  });

  it('finds the instances still mapped to a stuck cancelled job, and only those', async () => {
    const redis = new FakeRedis();
    const now = Date.now();
    await redis.hset(keys.jobInstance(WS), 'job-frozen', 'inst-frozen');
    await redis.hset(keys.jobStatus(WS), 'job-frozen', 'CANCELLED');
    await redis.set(keys.jobCancelRequested('job-frozen'), String(now - CANCEL_RECLAIM_GRACE_MS * 2));
    // Running job on another instance: never a reclaim candidate.
    await redis.hset(keys.jobInstance(WS), 'job-running', 'inst-busy');
    await redis.hset(keys.jobStatus(WS), 'job-running', 'RUNNING');

    const hosts = await instancesHoldingStuckCancelledJobs(
      redis as unknown as Parameters<typeof instancesHoldingStuckCancelledJobs>[0],
      WS,
      now
    );

    expect([...hosts]).toEqual(['inst-frozen']);
  });

  it('leaves the pool untouched when the holding instance record is already gone', async () => {
    const redis = new FakeRedis();

    await recordOperatorCancel(
      redis as unknown as Parameters<typeof recordOperatorCancel>[0],
      WS,
      'job-gone',
      'inst-vanished'
    );

    expect(await redis.get(keys.jobCancelRequested('job-gone'))).not.toBeNull();
    expect(await redis.hget(keys.pool(WS), 'inst-vanished')).toBeNull();
  });
});

// #1219 review finding 1: the other side of the reclaim — a cancel Encore
// HONOURS, which is the overwhelmingly common case.
//
// Recording a cancel marks the host instance draining so no further transcode
// is routed to an instance whose job might be stuck. That mark must not double
// as evidence for teardown: a drain scale-down writes itself means "already a
// teardown candidate, held only until its real work clears", but a cancel-set
// drain says nothing about the instance's age or health. Treating the two the
// same destroyed a warm instance on the very next tick of any routine cancel —
// `real.count === 0`, no abandoned job, so no protected work — bypassing
// idleTimeoutMs and making every cancel cost a cold spawn. That is exactly the
// churn cancelled-job-reclaim.ts's grace-window note promises not to cause.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - teardown candidacy (`activeJobs === 0 && idlePastTimeout`, `draining`,
//     stuck-cancel hosts) and the destroy/drain boundary — scaler-loop.ts
//     tick() step 4, around the `isTeardownCandidate` / `protectedCount`
//     computation.
//   - `EncoreInstanceRecord.draining` / `.cancelDrainingSince` / `.lastIdleAt`
//     and the keys.pool / keys.jobInstance / keys.jobEncoreUrl schema —
//     src/encore-scaler/types.ts.
//   - idle age basis `lastIdleAt ?? readyAt` — resolveIdleSince /
//     isIdlePastTimeout, src/encore-scaler/scaler-loop.ts.
//   - Encore cancel endpoint POST {instanceUrl}/encoreJobs/{uuid}/cancel and
//     the findByStatus HATEOAS page shape, as cited at the top of this file.
describe('#1219: a cancel Encore honours must not cost the instance its idle lifetime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    destroyInstanceMock.mockReset();
  });

  const HONOURED_UUID = '7f1e0000-0000-0000-0000-00000000abcd';

  // Answers the Encore cancel POST 200 "Ok" AND the findByStatus probes, so one
  // test can run a real cancel() followed by a real tick().
  function cancelThenActiveFetchMock(active: string[]): ReturnType<typeof vi.fn> {
    return vi.fn(async (input: unknown, _init?: unknown) => {
      const url = String(input);
      if (url.endsWith('/cancel')) {
        return { ok: true, status: 200, text: async () => 'Ok' } as unknown as Response;
      }
      if (url.includes('status=QUEUED')) return encorePage([]);
      if (url.includes('status=IN_PROGRESS')) return encorePage(active);
      throw new Error(`unexpected fetch: ${url}`);
    });
  }

  async function seedHonouredCancelHost(redis: FakeRedis): Promise<void> {
    await seedPool(redis, {
      instanceId: INSTANCE_ID,
      url: INSTANCE_URL,
      // Warm and busy with the job about to be cancelled, idle clock just
      // stamped: nothing about this instance is near its idle timeout.
      activeJobs: 1,
      lastIdleAt: Date.now()
    });
    await redis.set(
      keys.jobEncoreUrl('job-honoured'),
      `${INSTANCE_URL}/encoreJobs/${HONOURED_UUID}`
    );
    await redis.hset(keys.jobInstance(WS), 'job-honoured', INSTANCE_ID);
  }

  it('keeps the warm instance alive and back in service when Encore stops the cancelled job', async () => {
    const redis = new FakeRedis();
    await seedHonouredCancelHost(redis);
    // Encore honours the cancel: the job is gone from the active set by the
    // time the next tick asks.
    vi.stubGlobal('fetch', cancelThenActiveFetchMock([]));
    destroyInstanceMock.mockResolvedValue(undefined);

    // Idle timeout far longer than this test: any teardown here can only come
    // from the cancel, never from the instance having aged out.
    const config = makeConfig(redis, { idleTimeoutMs: 600_000 });
    await makeScalingEncoreClient(config).cancel('job-honoured');

    await new EncoreScalerLoop(config).tick();

    // The instance survives — a routine cancel is not an instance teardown.
    expect(destroyInstanceMock).not.toHaveBeenCalled();
    const raw = await redis.hget(keys.pool(WS), INSTANCE_ID);
    expect(raw).not.toBeNull();
    const record = JSON.parse(raw as string) as EncoreInstanceRecord;
    // And with the cancel confirmed honoured, the drain it set is released, so
    // the warm instance can take the operator's next transcode instead of
    // sitting unroutable until it ages out.
    expect(record.draining).toBeUndefined();
    expect(record.cancelDrainingSince).toBeUndefined();
    // Tracked count reconciled down to the real zero Encore reported, with the
    // idle clock stamped from that confirmation.
    expect(record.activeJobs).toBe(0);
    expect(typeof record.lastIdleAt).toBe('number');
  });

  it('still tears that instance down once it has aged out, so nothing leaks', async () => {
    const redis = new FakeRedis();
    await seedHonouredCancelHost(redis);
    vi.stubGlobal('fetch', cancelThenActiveFetchMock([]));
    destroyInstanceMock.mockResolvedValue(undefined);

    const warmConfig = makeConfig(redis, { idleTimeoutMs: 600_000 });
    await makeScalingEncoreClient(warmConfig).cancel('job-honoured');
    await new EncoreScalerLoop(warmConfig).tick();
    expect(destroyInstanceMock).not.toHaveBeenCalled();

    // Age the released record past the idle timeout: the ordinary idle path —
    // the one the cancel must neither short-circuit nor disable — now applies.
    const released = JSON.parse(
      (await redis.hget(keys.pool(WS), INSTANCE_ID)) as string
    ) as EncoreInstanceRecord;
    await seedPool(redis, { ...released, lastIdleAt: Date.now() - 60_000 });

    await new EncoreScalerLoop(makeConfig(redis, { idleTimeoutMs: 1_000 })).tick();

    expect(destroyInstanceMock).toHaveBeenCalledTimes(1);
    expect(destroyInstanceMock.mock.calls[0][0]).toBe(INSTANCE_ID);
  });

  it('still reclaims the instance when the cancel-set drain is the only route in', async () => {
    const redis = new FakeRedis();
    // The #1219 frozen case with its LIVE job->instance mapping already gone
    // (success/scale-down/dropped-job handling all clear it), so the
    // stuck-cancel host lookup finds nothing and the cancel-set drain is the
    // only thing that can make this instance a teardown candidate at all.
    await seedPool(redis, {
      instanceId: INSTANCE_ID,
      url: INSTANCE_URL,
      activeJobs: 1,
      lastIdleAt: Date.now(),
      draining: true,
      cancelDrainingSince: Date.now() - CANCEL_RECLAIM_GRACE_MS * 2
    });
    await redis.hset(keys.jobStatus(WS), 'job-frozen', 'CANCELLED');
    await redis.set(
      keys.jobCancelRequested('job-frozen'),
      String(Date.now() - CANCEL_RECLAIM_GRACE_MS * 2)
    );
    // Encore still reports the cancelled job IN_PROGRESS: it ignored its cancel.
    vi.stubGlobal('fetch', fetchMock([], ['job-frozen']));
    destroyInstanceMock.mockResolvedValue(undefined);

    await new EncoreScalerLoop(makeConfig(redis)).tick();

    expect(destroyInstanceMock).toHaveBeenCalledTimes(1);
    expect(destroyInstanceMock.mock.calls[0][0]).toBe(INSTANCE_ID);
  });
});
