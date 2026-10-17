// Regression test for #1225: a job the user CANCELLED is never re-enqueued when
// its Encore instance is later deleted.
//
// Observed in v1.5.0: a cancelled job came back on a new instance after the
// original was deleted, with the scaler logging "interrupted by scale-down ...
// classified interrupted_by_scaledown and re-enqueued" (job-n0z0hqtr6yx4).
// Cancellation is terminal, so it must be excluded from BOTH re-enqueue paths:
//   (a) scale-down recovery (requeueScaleDownInterruptions, #514) — which also
//       runs when OSC confirms the instance no longer exists, and
//   (b) dropped-job reconciliation (reconcile()'s drop diff -> onJobsDropped).
//
// The status gate those paths already had is not enough on its own, because the
// status hash is last-writer-wins and dispatch() / requeueInterruptedByScaleDown
// pin a job back to running — so the cancel-then-delete case is asserted here
// both for a cleanly-cancelled job and for one whose status was overwritten back
// to 'running' by a racing dispatch.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - Cancel path under test: makeScalingEncoreClient.cancel —
//     src/encore-scaler/index.ts (drain queue -> POST
//     {instanceUrl}/encoreJobs/{uuid}/cancel -> terminal CANCELLED status).
//   - Encore cancel endpoint shape POST {baseUrl}/encoreJobs/{jobId}/cancel, no
//     body, 404/409 idempotent — src/pipeline/encore-client.ts
//     makeHttpEncoreClient.cancel (SVT Encore EncoreController.kt, verified
//     2026-07-09 per that comment).
//   - Scale-down recovery + its status gate: src/encore-scaler/scaler-loop.ts
//     requeueScaleDownInterruptions; re-enqueue = LPUSH QueuedJob onto
//     keys.queue — src/encore-scaler/retry-store.ts
//     requeueInterruptedByScaleDown.
//   - Cancellation tombstone: keys.cancelledJobs (src/encore-scaler/types.ts) via
//     markJobCancelled (src/encore-scaler/job-cancellation.ts).
//   - fetchRealActiveState HATEOAS page shape { _embedded: { encoreJobs:
//     [{ externalId }] }, page: { totalElements } } — same contract asserted by
//     scaledown-interruption.test.ts.
//   - destroyInstance is the only OSC teardown call (stubbed: no OSC I/O) —
//     src/encore-scaler/instance-pool.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';

import { EncoreScalerLoop } from './scaler-loop.js';
import { makeScalingEncoreClient } from './index.js';
import {
  keys,
  type EncoreScalerConfig,
  type EncoreInstanceRecord
} from './types.js';

const destroyInstanceMock = vi.hoisted(() => vi.fn());
vi.mock('./instance-pool.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./instance-pool.js')>();
  return { ...actual, destroyInstance: destroyInstanceMock };
});

// In-memory stand-in for the subset of ioredis these paths use (strings,
// hashes, lists, sets). Same shape as scaledown-interruption.test.ts's fake.
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

const WS = 'ws-1225';
const JOB = 'job-n0z0hqtr6yx4';
const INSTANCE = 'inst-1225';
const INSTANCE_URL = 'https://encore-1225.example';
const ENCORE_UUID = 'c0ffee00-1225-4000-8000-000000000001';
const PAYLOAD = { externalId: JOB, profile: 'abr-1080p', inputs: [{ uri: 's3://b/k' }] };

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

function encorePage(externalIds: string[]): Response {
  return {
    ok: true,
    json: async () => ({
      _embedded: { encoreJobs: externalIds.map((externalId) => ({ externalId })) },
      page: { totalElements: externalIds.length }
    })
  } as unknown as Response;
}

// Encore reports NO active work for the instance (it was deleted / scaled away),
// and accepts the cancel POST.
function fetchMock() {
  return vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/cancel') && init?.method === 'POST') {
      return { ok: true, status: 200, text: async () => '' } as unknown as Response;
    }
    if (url.includes('status=QUEUED') || url.includes('status=IN_PROGRESS')) {
      return encorePage([]);
    }
    throw new Error(`unexpected fetch: ${url}`);
  });
}

// Seed a dispatched job on an idle-and-aged (teardown-candidate) instance,
// exactly as dispatch() leaves it: pool record, job->instance mapping, running
// status, retry payload + attempt count, and the Encore UUID.
async function seedDispatchedJob(redis: FakeRedis): Promise<void> {
  const record: EncoreInstanceRecord = {
    instanceId: INSTANCE,
    url: INSTANCE_URL,
    activeJobs: 0,
    lastIdleAt: 0 // long past idleTimeoutMs — a teardown candidate
  };
  await redis.hset(keys.pool(WS), INSTANCE, JSON.stringify(record));
  await redis.hset(keys.jobInstance(WS), JOB, INSTANCE);
  await redis.hset(keys.jobStatus(WS), JOB, 'running');
  await redis.set(keys.jobPayload(JOB), JSON.stringify(PAYLOAD));
  await redis.set(keys.jobAttempts(JOB), '1');
  await redis.set(keys.jobUuid(JOB), ENCORE_UUID);
}

describe('#1225: a cancelled job is never re-enqueued when its instance is deleted', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    destroyInstanceMock.mockReset();
  });

  it('does not re-enqueue a job cancelled through the scaling client when the instance is torn down', async () => {
    const redis = new FakeRedis();
    await seedDispatchedJob(redis);

    const fetchImpl = fetchMock();
    vi.stubGlobal('fetch', fetchImpl);
    destroyInstanceMock.mockResolvedValue(undefined);

    // 1. The user cancels the job (real cancel path: drains the queue, POSTs the
    //    Encore cancel for the dispatched attempt, records CANCELLED).
    const client = makeScalingEncoreClient(makeConfig(redis));
    await client.cancel(JOB);

    // Cancel was propagated to Encore on the instance the job was dispatched to.
    expect(fetchImpl).toHaveBeenCalledWith(
      `${INSTANCE_URL}/encoreJobs/${ENCORE_UUID}/cancel`,
      expect.objectContaining({ method: 'POST' })
    );
    expect(await client.getJobStatus(JOB)).toBe('failed');

    // 2. The instance is then deleted — the tick tears down the idle instance and
    //    runs scale-down recovery over the jobs still mapped to it.
    await new EncoreScalerLoop(makeConfig(redis)).tick();
    expect(destroyInstanceMock).toHaveBeenCalledTimes(1);

    // 3. The cancelled job was NOT re-enqueued, and stays terminal.
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toEqual([]);
    expect(await redis.hget(keys.jobStatus(WS), JOB)).toBe('CANCELLED');
  });

  it('does not re-enqueue a cancelled job whose status was pinned back to running by a racing dispatch', async () => {
    const redis = new FakeRedis();
    await seedDispatchedJob(redis);

    const fetchImpl = fetchMock();
    vi.stubGlobal('fetch', fetchImpl);
    destroyInstanceMock.mockResolvedValue(undefined);

    const client = makeScalingEncoreClient(makeConfig(redis));
    await client.cancel(JOB);

    // The incident's actual shape: a dispatch (or a re-dispatch) that had already
    // claimed the job pins keys.jobStatus back to running AFTER the cancel, so
    // the status hash no longer says CANCELLED. The job must still be excluded —
    // cancellation is terminal and monotonic.
    await redis.hset(keys.jobStatus(WS), JOB, 'running');

    const onJobInterrupted = vi.fn(async () => undefined);
    const onJobsDropped = vi.fn(async () => undefined);
    await new EncoreScalerLoop(
      makeConfig(redis, { onJobInterrupted, onJobsDropped })
    ).tick();

    // Not re-enqueued, not reclassified as a scale-down interruption, and not
    // raised as a dropped job (which would send it through the retry gate).
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toEqual([]);
    expect(onJobInterrupted).not.toHaveBeenCalled();
    expect(onJobsDropped).not.toHaveBeenCalled();
  });

  it('drops a cancelled job claimed from the queue instead of dispatching it', async () => {
    const redis = new FakeRedis();

    // A ready instance with free capacity, and a cancelled job sitting on the
    // queue (the entry a cancel could not drain because it was already claimed,
    // or one re-enqueued by an earlier tick before this fix).
    const record: EncoreInstanceRecord = {
      instanceId: INSTANCE,
      url: INSTANCE_URL,
      activeJobs: 0,
      lastIdleAt: Date.now(),
      callbackTrustReady: true
    };
    await redis.hset(keys.pool(WS), INSTANCE, JSON.stringify(record));
    await redis.lpush(
      keys.queue(WS),
      JSON.stringify({ jobId: JOB, payload: PAYLOAD, enqueuedAt: Date.now() })
    );
    await redis.hset(keys.cancelledJobs(WS), JOB, String(Date.now()));
    await redis.hset(keys.jobStatus(WS), JOB, 'CANCELLED');

    const fetchImpl = fetchMock();
    vi.stubGlobal('fetch', fetchImpl);
    destroyInstanceMock.mockResolvedValue(undefined);

    await new EncoreScalerLoop(makeConfig(redis, { minInstances: 1 })).tick();

    // Never POSTed to Encore's submit endpoint, and the entry is gone from both
    // the queue and the inflight list rather than being re-queued forever.
    for (const call of fetchImpl.mock.calls) {
      expect(String(call[0])).not.toBe(`${INSTANCE_URL}/encoreJobs`);
    }
    expect(await redis.lrange(keys.queue(WS), 0, -1)).toEqual([]);
    expect(await redis.lrange(keys.inflight(WS), 0, -1)).toEqual([]);
    expect(await redis.hget(keys.jobStatus(WS), JOB)).toBe('CANCELLED');
    expect(await redis.hget(keys.jobInstance(WS), JOB)).toBeNull();
  });
});
