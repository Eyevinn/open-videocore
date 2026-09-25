// GET /scaler/status must surface the fields that make the #778 leak visible.
//
// The complaint behind issue #778 is that nothing surfaced an Encore instance
// that had been spawned but never dispatched a job. `readyAt` is the field that
// makes that state diagnosable, and the status response schema used to STRIP it.
// Separately, `lastIdleAt` was required, so a record with no usable timestamp —
// exactly the record an operator most needs to see, and the case
// resolveIdleSince()/isIdlePastTimeout() exist to tolerate — failed response
// validation and took the whole workspace listing down with it.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Response schema: `instanceSchema` in src/routes/scaler.ts — instanceId,
//     url, activeJobs, lastIdleAt?, readyAt? — projected by toInstanceView().
//   - Record shape: EncoreInstanceRecord (src/encore-scaler/types.ts), where
//     `readyAt` is optional and `lastIdleAt` may have been lost or written as a
//     non-number by an out-of-band repair.
//   - Valkey key schema: keys.pool (src/encore-scaler/types.ts), read by
//     listInstances(redis, workspaceId) (src/encore-scaler/instance-pool.ts).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';

import { scalerRouter } from '../src/routes/scaler.js';
import { keys } from '../src/encore-scaler/types.js';

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

describe('GET /scaler/status reports the idle-clock fields (issue #778)', () => {
  let app: FastifyInstance;
  let redis: FakeRedis;

  beforeEach(async () => {
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    redis = new FakeRedis();
    await app.register(scalerRouter, {
      prefix: '/scaler',
      redis: redis as unknown as Redis,
      maxInstances: 3,
      minInstances: 0,
      idleTimeoutMs: 300_000
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('exposes readyAt so a spawned-but-never-dispatched instance is diagnosable', async () => {
    const readyAt = Date.now() - 42_000;
    redis.hset(
      keys.pool('ws-1'),
      'inst-1',
      JSON.stringify({
        instanceId: 'inst-1',
        url: 'https://inst-1.example',
        activeJobs: 0,
        lastIdleAt: readyAt,
        readyAt
      })
    );

    const res = await app.inject({ method: 'GET', url: '/scaler/status' });

    expect(res.statusCode).toBe(200);
    const [instance] = res.json().workspaces[0].instances;
    expect(instance).toMatchObject({ instanceId: 'inst-1', readyAt, lastIdleAt: readyAt });
  });

  it('still reports an instance whose idle timestamp is missing or unusable', async () => {
    redis.hset(
      keys.pool('ws-1'),
      'no-stamp',
      JSON.stringify({
        instanceId: 'no-stamp',
        url: 'https://no-stamp.example',
        activeJobs: 0
      })
    );
    redis.hset(
      keys.pool('ws-1'),
      'bad-stamp',
      JSON.stringify({
        instanceId: 'bad-stamp',
        url: 'https://bad-stamp.example',
        activeJobs: 0,
        lastIdleAt: 'not-a-number'
      })
    );

    const res = await app.inject({ method: 'GET', url: '/scaler/status' });

    expect(res.statusCode).toBe(200);
    const instances = res.json().workspaces[0].instances as Array<Record<string, unknown>>;
    expect(instances.map((i) => i['instanceId']).sort()).toEqual(['bad-stamp', 'no-stamp']);
    for (const instance of instances) {
      expect(instance['lastIdleAt']).toBeUndefined();
      expect(instance['readyAt']).toBeUndefined();
    }
  });
});
