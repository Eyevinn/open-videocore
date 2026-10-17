// #1225 follow-up (review of PR #1231): deterministic proof for the DISPATCHED
// branch of DELETE /encoreJobs/:id on the scaler's Encore-compatible facade.
//
// The claim under test is that the cancellation tombstone is recorded on EVERY
// exit of that branch — the forwarded 200, the non-ok passthrough, the
// missing-pool-record 404 and the unreachable-instance 502 — with the response
// status codes unchanged, plus the newly cancellable "claimed into
// keys.inflight but not yet mapped" race.
//
// Why injected requests and not curl: `encoreScalerRouter` is a
// library-exported Fastify plugin that src/main.ts does NOT register
// (`grep -rn "encoreScalerRouter" src/` => encore-scaler-router.ts:47 definition,
// index.ts:20 re-export, and these tests only), and the compat router main.ts
// does mount (src/routes/encore-compat.ts) exposes only POST /encoreJobs and
// GET /encoreJobs/:id — there is no DELETE route on any served surface. So there
// is no live HTTP endpoint for this handler; `app.inject` through the real plugin
// is the strongest available proof and is what the PR description now claims.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - Handler under test, branch by branch: src/encore-scaler/
//     encore-scaler-router.ts — queue drain (`lrange`/`lrem(...,0,entry)`), the
//     keys.jobInstance lookup, markJobCancelled before the remote leg, the
//     missing-pool-record 404, the outbound
//     `DELETE {record.url}/encoreJobs/{id}` with `authorization: Bearer <token>`,
//     `reply.code(res.ok ? 200 : res.status)` and the catch-all 502
//     `{ id, error: 'failed to reach encore instance' }`.
//   - Valkey key schema keys.queue / keys.inflight / keys.jobInstance /
//     keys.pool / keys.cancelledJobs (`encore:job-cancelled:{workspaceId}`,
//     externalId -> epoch ms): src/encore-scaler/types.ts — keys.queue:390,
//     keys.inflight:391, keys.pool:392, keys.jobInstance:393, keys.jobStatus:394,
//     keys.cancelledJobs:435.
//   - Pool record shape { instanceId, url } read by the handler:
//     `EncoreInstanceRecord` — src/encore-scaler/types.ts:260-262.
//   - QueuedJob shape { jobId, payload, enqueuedAt }: src/encore-scaler/types.ts.
//   - Tombstone writer markJobCancelled (tombstone first, then terminal status):
//     src/encore-scaler/job-cancellation.ts.

import { afterEach, describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';

import { encoreScalerRouter } from './encore-scaler-router.js';
import { keys, type EncoreInstanceRecord, type QueuedJob } from './types.js';

const WS = 'ws-cancel-dispatched';
const INSTANCE_ID = 'encore-abc';
const INSTANCE_URL = 'https://encore-abc.example.osc';
const JOB_ID = 'ext-dispatched-1';
const TOKEN = 'test-token';

// In-memory stand-in for the subset of ioredis this handler uses: list ops
// (lpush/rpush/lrange/lrem/llen) and hash ops (hget/hset/hgetall).
class FakeRedis {
  private lists = new Map<string, string[]>();
  private hashes = new Map<string, Map<string, string>>();

  private list(key: string): string[] {
    let l = this.lists.get(key);
    if (!l) {
      l = [];
      this.lists.set(key, l);
    }
    return l;
  }

  private hash(key: string): Map<string, string> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    return h;
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
    if (start === 0 && stop === -1) return [...l];
    const end = stop < 0 ? l.length + stop + 1 : stop + 1;
    return l.slice(start, end);
  }

  // count 0 => remove ALL occurrences equal to `value`. Returns removed count.
  async lrem(key: string, count: number, value: string): Promise<number> {
    const l = this.list(key);
    if (count === 0) {
      const kept = l.filter((v) => v !== value);
      this.lists.set(key, kept);
      return l.length - kept.length;
    }
    const idx = l.indexOf(value);
    if (idx === -1) return 0;
    l.splice(idx, 1);
    return 1;
  }

  async llen(key: string): Promise<number> {
    return this.list(key).length;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hash(key).get(field) ?? null;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    const h = this.hash(key);
    const isNew = !h.has(field);
    h.set(field, value);
    return isNew ? 1 : 0;
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hash(key));
  }
}

async function buildApp(redis: FakeRedis): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(encoreScalerRouter, {
    redis: redis as unknown as Redis,
    workspaceId: WS,
    getToken: async () => TOKEN
  });
  await app.ready();
  return app;
}

function queueEntry(jobId: string, enqueuedAt: number): string {
  const job: QueuedJob = { jobId, payload: { externalId: jobId }, enqueuedAt };
  return JSON.stringify(job);
}

// Seed a job that the scaler loop already dispatched: mapped to an instance that
// is in the pool (unless `withPoolRecord` is false), status pinned to running by
// dispatch() exactly as the real loop leaves it.
async function seedDispatched(
  redis: FakeRedis,
  opts: { withPoolRecord: boolean }
): Promise<void> {
  await redis.hset(keys.jobInstance(WS), JOB_ID, INSTANCE_ID);
  await redis.hset(keys.jobStatus(WS), JOB_ID, 'running');
  if (opts.withPoolRecord) {
    const record: EncoreInstanceRecord = {
      instanceId: INSTANCE_ID,
      url: INSTANCE_URL
    } as EncoreInstanceRecord;
    await redis.hset(keys.pool(WS), INSTANCE_ID, JSON.stringify(record));
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('#1225: DELETE /encoreJobs/:id records the cancellation on every dispatched-branch exit', () => {
  it('forwards the cancel and returns 200 CANCELLED, with the tombstone written before the remote leg', async () => {
    const redis = new FakeRedis();
    await seedDispatched(redis, { withPoolRecord: true });

    // Assert ordering at the moment of the call: the tombstone must already be
    // there when the outbound cancel is attempted, so a failing remote leg can
    // never leave the job looking non-terminal.
    let tombstoneAtFetch: string | null = null;
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => {
      tombstoneAtFetch = await redis.hget(keys.cancelledJobs(WS), JOB_ID);
      return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildApp(redis);
    try {
      const res = await app.inject({ method: 'DELETE', url: `/encoreJobs/${JOB_ID}` });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: JOB_ID, status: 'CANCELLED' });

      // Outbound call shape, per encore-scaler-router.ts.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(`${INSTANCE_URL}/encoreJobs/${JOB_ID}`);
      expect(init.method).toBe('DELETE');
      expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);

      // Tombstone existed BEFORE the remote leg, and survives.
      expect(tombstoneAtFetch).not.toBeNull();
      const tombstone = await redis.hget(keys.cancelledJobs(WS), JOB_ID);
      expect(tombstone).not.toBeNull();
      expect(Number(tombstone)).toBeGreaterThan(0);
      expect(await redis.hget(keys.jobStatus(WS), JOB_ID)).toBe('CANCELLED');
    } finally {
      await app.close();
    }
  });

  it('passes a non-ok instance status through unchanged and still keeps the tombstone', async () => {
    const redis = new FakeRedis();
    await seedDispatched(redis, { withPoolRecord: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 409, json: async () => ({}) }) as unknown as Response)
    );

    const app = await buildApp(redis);
    try {
      const res = await app.inject({ method: 'DELETE', url: `/encoreJobs/${JOB_ID}` });

      expect(res.statusCode).toBe(409);
      expect(res.json()).toEqual({ id: JOB_ID, status: 'CANCELLED' });
      expect(await redis.hget(keys.cancelledJobs(WS), JOB_ID)).not.toBeNull();
      expect(await redis.hget(keys.jobStatus(WS), JOB_ID)).toBe('CANCELLED');
    } finally {
      await app.close();
    }
  });

  it('404s (status code unchanged) when the mapped instance has left the pool, but records the cancellation', async () => {
    const redis = new FakeRedis();
    await seedDispatched(redis, { withPoolRecord: false });
    const fetchMock = vi.fn(async () => {
      throw new Error('must not be called: no pool record');
    });
    vi.stubGlobal('fetch', fetchMock);

    const app = await buildApp(redis);
    try {
      const res = await app.inject({ method: 'DELETE', url: `/encoreJobs/${JOB_ID}` });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ id: JOB_ID, status: 'NOT_FOUND' });
      expect(fetchMock).not.toHaveBeenCalled();

      // This is the exit the issue is about: the instance is already gone, so
      // scale-down recovery is exactly what would otherwise re-enqueue the job.
      expect(await redis.hget(keys.cancelledJobs(WS), JOB_ID)).not.toBeNull();
      expect(await redis.hget(keys.jobStatus(WS), JOB_ID)).toBe('CANCELLED');
    } finally {
      await app.close();
    }
  });

  it('502s (status code unchanged) when the instance is unreachable, but records the cancellation', async () => {
    const redis = new FakeRedis();
    await seedDispatched(redis, { withPoolRecord: true });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      })
    );

    const app = await buildApp(redis);
    try {
      const res = await app.inject({ method: 'DELETE', url: `/encoreJobs/${JOB_ID}` });

      expect(res.statusCode).toBe(502);
      expect(res.json()).toEqual({ id: JOB_ID, error: 'failed to reach encore instance' });
      expect(await redis.hget(keys.cancelledJobs(WS), JOB_ID)).not.toBeNull();
      expect(await redis.hget(keys.jobStatus(WS), JOB_ID)).toBe('CANCELLED');
    } finally {
      await app.close();
    }
  });

  it('drains duplicate queue entries for an already-dispatched job as well as cancelling it', async () => {
    const redis = new FakeRedis();
    await seedDispatched(redis, { withPoolRecord: true });
    // A stale duplicate left over from a transport-class re-enqueue (#295), plus
    // an unrelated job that must survive.
    await redis.lpush(keys.queue(WS), queueEntry(JOB_ID, 1000));
    await redis.lpush(keys.queue(WS), queueEntry('other-job', 2000));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response)
    );

    const app = await buildApp(redis);
    try {
      const res = await app.inject({ method: 'DELETE', url: `/encoreJobs/${JOB_ID}` });

      expect(res.statusCode).toBe(200);
      expect(await redis.lrange(keys.queue(WS), 0, -1)).toEqual([queueEntry('other-job', 2000)]);
      expect(await redis.hget(keys.cancelledJobs(WS), JOB_ID)).not.toBeNull();
    } finally {
      await app.close();
    }
  });
});

describe('#1225: a cancel that races a claimed-but-unmapped entry is still recorded', () => {
  it('returns 200 CANCELLED and tombstones a job already claimed into keys.inflight', async () => {
    const redis = new FakeRedis();
    // The loop did `rpoplpush(queue -> inflight)` but dispatch() has not yet
    // written keys.jobInstance: nothing to drain, no mapping.
    const claimed = queueEntry(JOB_ID, 1234);
    await redis.rpush(keys.inflight(WS), claimed);
    await redis.hset(keys.jobStatus(WS), JOB_ID, 'QUEUED');

    const app = await buildApp(redis);
    try {
      const res = await app.inject({ method: 'DELETE', url: `/encoreJobs/${JOB_ID}` });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: JOB_ID, status: 'CANCELLED' });

      // The tombstone is what the loop's pre-dispatch guard reads.
      expect(await redis.hget(keys.cancelledJobs(WS), JOB_ID)).not.toBeNull();
      expect(await redis.hget(keys.jobStatus(WS), JOB_ID)).toBe('CANCELLED');

      // The claimed entry is deliberately left in place: the loop removes it
      // with the exact value it claimed.
      expect(await redis.lrange(keys.inflight(WS), 0, -1)).toEqual([claimed]);
    } finally {
      await app.close();
    }
  });

  it('still 404s with no tombstone for a job the scaler has never seen', async () => {
    const redis = new FakeRedis();
    await redis.rpush(keys.inflight(WS), queueEntry('some-other-job', 1));

    const app = await buildApp(redis);
    try {
      const res = await app.inject({ method: 'DELETE', url: '/encoreJobs/never-seen' });

      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ id: 'never-seen', status: 'NOT_FOUND' });
      expect(await redis.hget(keys.cancelledJobs(WS), 'never-seen')).toBeNull();
    } finally {
      await app.close();
    }
  });
});
