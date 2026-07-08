// Scaler late-init after stack provisioning (#103).
//
// The core of issue #103 is that GET /api/v1/scaler/status must flip to
// scalerActive:true the moment a stack is provisioned — with no server restart.
// main.ts implements this by registering the scaler router with a shared options
// object whose `redis` field is undefined at boot, then having activateScaler()
// set that field the instant POST /api/v1/provision writes the stack's redisUrl
// to the parameter store. Fastify handlers read opts.redis live on every request,
// so no re-registration is needed.
//
// This test exercises exactly that contract at the router boundary without OSC or
// a real Valkey: register once with redis undefined, assert scalerActive:false,
// then mutate the SAME options object's redis field (what activateScaler does) and
// assert /status reports scalerActive:true — then clear it (what deactivateScaler
// does on deprovision) and assert it flips back to false.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - scalerRouter options: `redis?: Redis`, read live inside the /status handler
//     (src/routes/scaler.ts:29, 104-121). scalerActive is `Boolean(redis)`.
//   - Valkey key schema scanned by /status: keys.pool / keys.queue / keys.inflight
//     (src/encore-scaler/types.ts:90-104); scanWorkspaceIds uses SCAN MATCH
//     `encore:pool:*` (src/routes/scaler.ts:69-84).
//   - listInstances(redis, workspaceId) reads keys.pool via hgetall
//     (src/encore-scaler/instance-pool.ts).

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';

import { scalerRouter } from '../src/routes/scaler.js';
import { keys } from '../src/encore-scaler/types.js';

// Minimal in-memory fake of the ioredis surface the scaler router touches:
// scan (pool-key discovery), llen (queue/inflight depth), hgetall (pool read).
class FakeRedis {
  private hashes = new Map<string, Map<string, string>>();
  private lists = new Map<string, string[]>();

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

  async llen(key: string): Promise<number> {
    return this.lists.get(key)?.length ?? 0;
  }

  // SCAN cursor='0' single-page emulation over the hash keyspace. The router
  // calls redis.scan(cursor, 'MATCH', pattern, 'COUNT', n) and matches keys that
  // start with `encore:pool:`.
  async scan(
    _cursor: string,
    _match: 'MATCH',
    pattern: string,
    _count: 'COUNT',
    _n: number
  ): Promise<[string, string[]]> {
    const prefix = pattern.replace(/\*$/, '');
    const matched = [...this.hashes.keys()].filter((k) => k.startsWith(prefix));
    return ['0', matched];
  }
}

describe('scaler late-init after provisioning (#103)', () => {
  let app: FastifyInstance;
  // The shared options object main.ts holds by reference and mutates in
  // activateScaler / deactivateScaler.
  let options: { prefix: string; redis?: Redis; maxInstances: number; minInstances: number; idleTimeoutMs: number };

  beforeEach(async () => {
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    options = {
      prefix: '/scaler',
      redis: undefined, // no stack provisioned yet
      maxInstances: 3,
      minInstances: 0,
      idleTimeoutMs: 300_000
    };
    await app.register(scalerRouter, options);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('reports scalerActive:false before any stack is provisioned', async () => {
    const res = await app.inject({ method: 'GET', url: '/scaler/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ scalerActive: false, workspaces: [] });
  });

  it('flips to scalerActive:true immediately when redis is set post-registration (no restart)', async () => {
    // Before: disabled.
    const before = await app.inject({ method: 'GET', url: '/scaler/status' });
    expect(before.json()).toMatchObject({ scalerActive: false });

    // Simulate activateScaler(): a stack was provisioned, its Valkey is now live,
    // and a pool entry exists for one workspace. Mutate the SAME options object.
    const redis = new FakeRedis();
    redis.hset(
      keys.pool('ws-1'),
      'inst-1',
      JSON.stringify({ instanceId: 'inst-1', url: 'https://inst-1.example', activeJobs: 0, lastIdleAt: Date.now() })
    );
    options.redis = redis as unknown as Redis;

    // After: active on the SAME running app — no re-registration, no restart.
    const after = await app.inject({ method: 'GET', url: '/scaler/status' });
    expect(after.statusCode).toBe(200);
    const body = after.json();
    expect(body.scalerActive).toBe(true);
    expect(body.workspaces).toHaveLength(1);
    expect(body.workspaces[0]).toMatchObject({ workspaceId: 'ws-1' });
  });

  it('flips back to scalerActive:false when redis is cleared on deprovision', async () => {
    options.redis = new FakeRedis() as unknown as Redis;
    const active = await app.inject({ method: 'GET', url: '/scaler/status' });
    expect(active.json()).toMatchObject({ scalerActive: true });

    // Simulate deactivateScaler() clearing the connection on stack teardown.
    options.redis = undefined;
    const inactive = await app.inject({ method: 'GET', url: '/scaler/status' });
    expect(inactive.json()).toMatchObject({ scalerActive: false, workspaces: [] });
  });
});
