// #746: DELETE /encoreJobs/:id must drain EVERY buffered queue entry for a job,
// not just the first match. A job can be enqueued more than once (transport-class
// retry, #295); removing a single entry leaves duplicates behind that the scaler
// loop would later dispatch with nobody listening for completion. The handler
// uses `lrem(queue, 0, entry)` per distinct matching entry value, which removes
// ALL occurrences of that value — covering both the byte-identical case and the
// distinct-`enqueuedAt` case.
//
// This drives a real HTTP request through the encoreScalerRouter with an
// in-memory Valkey stand-in seeded with duplicate entries, and asserts the queue
// is left free of that job's entries (an unrelated job survives) and status is
// CANCELLED.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - DELETE /encoreJobs/:id drain loop (`lrem(..., 0, entry)`) + CANCELLED
//     surface: src/encore-scaler/encore-scaler-router.ts:127-184.
//   - Valkey key schema keys.queue / keys.jobStatus: src/encore-scaler/types.ts.
//   - QueuedJob shape { jobId, payload, enqueuedAt }: src/encore-scaler/types.ts.

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';

import { encoreScalerRouter } from './encore-scaler-router.js';
import { keys } from './types.js';

// Minimal in-memory stand-in for the subset of ioredis the DELETE handler uses:
// list ops (lpush/lrange/lrem/llen) and hash ops (hget/hset).
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

  async lrange(key: string, start: number, stop: number): Promise<string[]> {
    const l = this.list(key);
    // Only the full-range (0, -1) form is used by the handler.
    if (start === 0 && stop === -1) return [...l];
    const end = stop < 0 ? l.length + stop + 1 : stop + 1;
    return l.slice(start, end);
  }

  // count 0 => remove ALL occurrences equal to `value`. Returns removed count.
  async lrem(key: string, count: number, value: string): Promise<number> {
    if (count !== 0) throw new Error(`FakeRedis.lrem only models count 0, got ${count}`);
    const l = this.list(key);
    const before = l.length;
    const kept = l.filter((v) => v !== value);
    this.lists.set(key, kept);
    return before - kept.length;
  }

  async llen(key: string): Promise<number> {
    return this.list(key).length;
  }

  async hget(key: string, field: string): Promise<string | null> {
    return this.hash(key).get(field) ?? null;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    this.hash(key).set(field, value);
    return 1;
  }
}

async function buildApp(redis: FakeRedis, workspaceId: string): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(encoreScalerRouter, {
    redis: redis as unknown as Redis,
    workspaceId,
    // Not reached on the queued-only path (no dispatched instance).
    getToken: async () => 'test-token'
  });
  await app.ready();
  return app;
}

describe('#746: DELETE /encoreJobs/:id drains all duplicate queue entries', () => {
  it('removes byte-identical AND distinct-enqueuedAt duplicates, leaving unrelated jobs', async () => {
    const redis = new FakeRedis();
    const ws = 'ws1';
    const jobId = 'ext-dup-1';

    // Two BYTE-IDENTICAL duplicates (same enqueuedAt) — a single lrem(0, entry)
    // must remove both.
    const identical = JSON.stringify({
      jobId,
      payload: { externalId: jobId },
      enqueuedAt: 1000
    });
    await redis.lpush(keys.queue(ws), identical);
    await redis.lpush(keys.queue(ws), identical);

    // A DISTINCT-enqueuedAt duplicate for the same jobId — not byte-identical to
    // the pair above, so it is a separate value the loop must also drain.
    const distinct = JSON.stringify({
      jobId,
      payload: { externalId: jobId },
      enqueuedAt: 2000
    });
    await redis.lpush(keys.queue(ws), distinct);

    // An unrelated job that MUST survive the drain.
    const other = JSON.stringify({
      jobId: 'other-job',
      payload: { externalId: 'other-job' },
      enqueuedAt: 3000
    });
    await redis.lpush(keys.queue(ws), other);

    await redis.hset(keys.jobStatus(ws), jobId, 'QUEUED');

    const app = await buildApp(redis, ws);
    try {
      const res = await app.inject({ method: 'DELETE', url: `/encoreJobs/${jobId}` });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ id: jobId, status: 'CANCELLED' });

      // The queue is free of ALL of that job's entries; the unrelated job is intact.
      const remaining = await redis.lrange(keys.queue(ws), 0, -1);
      expect(remaining).toEqual([other]);
      expect(await redis.llen(keys.queue(ws))).toBe(1);

      // Terminal status recorded.
      expect(await redis.hget(keys.jobStatus(ws), jobId)).toBe('CANCELLED');
    } finally {
      await app.close();
    }
  });

  it('404s when the job has no buffered entries and is not dispatched', async () => {
    const redis = new FakeRedis();
    const ws = 'ws1';
    const app = await buildApp(redis, ws);
    try {
      const res = await app.inject({ method: 'DELETE', url: '/encoreJobs/nope' });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toEqual({ id: 'nope', status: 'NOT_FOUND' });
    } finally {
      await app.close();
    }
  });
});
