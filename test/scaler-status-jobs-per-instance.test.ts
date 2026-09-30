// GET /scaler/status must report per-instance job capacity and per-instance
// drain state (issue #979).
//
// Before this, capacity was not on the wire at all, so the ops UI inferred it
// from the highest activeJobs it happened to observe in the pool — an inference
// that agrees with the truth only while JOBS_PER_INSTANCE is 1. `draining` was
// carried by the pool record (#513, drain-don't-kill) but stripped by the
// response schema, so a draining instance looked exactly like a busy healthy one.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Response schema: `scalerStatusSchema` in src/routes/scaler.ts —
//     { workspaces, maxInstances, jobsPerInstance, idleTimeoutMs, scalerActive }.
//   - Per-instance schema: `instanceSchema` / `toInstanceView()` in
//     src/routes/scaler.ts — instanceId, url, activeJobs, lastIdleAt?, readyAt?,
//     draining?.
//   - Capacity constant: JOBS_PER_INSTANCE (src/encore-scaler/types.ts), the
//     same value the loop compares against in scaler-loop.ts:245
//     (`activeJobs >= JOBS_PER_INSTANCE`). Asserted by reference, not by
//     literal, so raising the constant keeps this test honest.
//   - Record shape: EncoreInstanceRecord.draining (src/encore-scaler/types.ts,
//     optional boolean).
//   - Valkey key schema: keys.pool (src/encore-scaler/types.ts), read by
//     listInstances(redis, workspaceId) (src/encore-scaler/instance-pool.ts).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';

import { scalerRouter } from '../src/routes/scaler.js';
import { JOBS_PER_INSTANCE, keys } from '../src/encore-scaler/types.js';

class FakeRedis {
  private hashes = new Map<string, Map<string, string>>();

  hset(key: string, field: string, value: string): void {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    h.set(field, value);
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? new Map());
  }

  async llen(): Promise<number> {
    return 0;
  }

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

async function buildApp(redis?: FakeRedis): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(scalerRouter, {
    prefix: '/scaler',
    redis: redis as unknown as Redis | undefined,
    maxInstances: 3,
    minInstances: 0,
    idleTimeoutMs: 300_000
  });
  await app.ready();
  return app;
}

describe('GET /scaler/status reports jobsPerInstance (issue #979)', () => {
  let app: FastifyInstance;
  let redis: FakeRedis;

  beforeEach(async () => {
    redis = new FakeRedis();
    app = await buildApp(redis);
  });

  afterEach(async () => {
    await app.close();
  });

  it('reports the scaler\'s own per-instance capacity constant', async () => {
    const res = await app.inject({ method: 'GET', url: '/scaler/status' });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.jobsPerInstance).toBe(JOBS_PER_INSTANCE);
    // It is a capacity, so it must be a usable positive integer a client can
    // divide by — never 0, never absent.
    expect(Number.isInteger(body.jobsPerInstance)).toBe(true);
    expect(body.jobsPerInstance).toBeGreaterThanOrEqual(1);
  });

  it('reports it alongside maxInstances and idleTimeoutMs, not instead of them', async () => {
    const res = await app.inject({ method: 'GET', url: '/scaler/status' });

    expect(res.json()).toMatchObject({
      maxInstances: 3,
      jobsPerInstance: JOBS_PER_INSTANCE,
      idleTimeoutMs: 300_000,
      scalerActive: true
    });
  });

  it('still reports it when the scaler is off (no stack provisioned)', async () => {
    // Same reasoning as maxInstances on the inactive branch (#780): capacity is
    // configuration the server owns whether or not a pool exists, so a client
    // rendering the pool-capacity context does not have to special-case it.
    const offApp = await buildApp(undefined);
    try {
      const res = await offApp.inject({ method: 'GET', url: '/scaler/status' });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        workspaces: [],
        jobsPerInstance: JOBS_PER_INSTANCE,
        scalerActive: false
      });
    } finally {
      await offApp.close();
    }
  });

  it('serialises draining per instance when the record is draining', async () => {
    redis.hset(
      keys.pool('ws-1'),
      'drain-1',
      JSON.stringify({
        instanceId: 'drain-1',
        url: 'https://drain-1.example',
        activeJobs: 1,
        lastIdleAt: Date.now() - 1_000,
        draining: true
      })
    );
    redis.hset(
      keys.pool('ws-1'),
      'busy-1',
      JSON.stringify({
        instanceId: 'busy-1',
        url: 'https://busy-1.example',
        activeJobs: 1,
        lastIdleAt: Date.now() - 1_000
      })
    );

    const res = await app.inject({ method: 'GET', url: '/scaler/status' });

    expect(res.statusCode).toBe(200);
    const instances = res.json().workspaces[0].instances as Array<Record<string, unknown>>;
    const byId = new Map(instances.map((i) => [i['instanceId'] as string, i]));
    // A draining instance is told apart from a healthy busy one with identical
    // activeJobs — the whole point of surfacing the flag.
    expect(byId.get('drain-1')).toMatchObject({ activeJobs: 1, draining: true });
    expect(byId.get('busy-1')?.['draining']).toBeUndefined();
  });

  it('omits draining for a record that carries a non-boolean value', async () => {
    redis.hset(
      keys.pool('ws-1'),
      'odd',
      JSON.stringify({
        instanceId: 'odd',
        url: 'https://odd.example',
        activeJobs: 0,
        draining: 'yes'
      })
    );

    const res = await app.inject({ method: 'GET', url: '/scaler/status' });

    // Reported, not dropped: a junk flag must not fail response validation and
    // take the whole workspace listing down (same reasoning as lastIdleAt, #778).
    expect(res.statusCode).toBe(200);
    const [instance] = res.json().workspaces[0].instances;
    expect(instance.instanceId).toBe('odd');
    expect(instance.draining).toBeUndefined();
  });
});
