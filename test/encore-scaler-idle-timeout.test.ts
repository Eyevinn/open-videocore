// Runtime-configurable Encore idle-timeout tests (issue #87).
//
// Sibling to encore-scaler.e2e.test.ts, but runs WITHOUT OSC or a real Redis:
// the OSC-touching pool functions (spawnInstance/destroyInstance) are mocked so
// only the scaler-loop scale-down decision and the scaler router are exercised.
//
// Covers the issue #87 gap — idleTimeoutMs is made observable and
// runtime-configurable, mirroring the maxInstances plumbing:
//   (a) a runtime timeout change (loop.setIdleTimeoutMs) takes effect on the
//       next tick: an instance that was NOT past the old timeout is torn down
//       once the timeout is lowered.
//   (b) GET /api/v1/scaler/status reports the effective idleTimeoutMs, and
//       PATCH /api/v1/scaler/config updates it, validates a lower bound, and
//       fans the change out via onConfigChange.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - EncoreScalerLoop.tick / setIdleTimeoutMs (src/encore-scaler/scaler-loop.ts:65-71),
//     scale-down predicate `activeJobs===0 && now-lastIdleAt > idleTimeoutMs`
//     (src/encore-scaler/scaler-loop.ts:101).
//   - listInstances/updateInstance/destroyInstance (src/encore-scaler/instance-pool.ts:52,69,167).
//   - EncoreScalerConfig / EncoreInstanceRecord / keys (src/encore-scaler/types.ts:31,68,90).
//   - scalerRouter options + status/config schemas (src/routes/scaler.ts):
//     status returns { workspaces, maxInstances, idleTimeoutMs, scalerActive };
//     PATCH /config body is scalerConfigSchema.partial(), idleTimeoutMs floor
//     MIN_IDLE_TIMEOUT_MS = 10_000.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

// Mock ONLY the OSC-touching pool functions; keep the pure-Redis helpers real.
const destroyInstance = vi.fn(async () => undefined);
const spawnInstance = vi.fn();
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

import { EncoreScalerLoop } from '../src/encore-scaler/scaler-loop.js';
import { scalerRouter } from '../src/routes/scaler.js';
import { keys, type EncoreInstanceRecord, type EncoreScalerConfig } from '../src/encore-scaler/types.js';

// A minimal in-memory Redis exposing only the commands the scaler tick and the
// pool helpers touch. Values are stored as strings, mirroring ioredis.
class FakeRedis {
  private hashes = new Map<string, Map<string, string>>();
  private lists = new Map<string, string[]>();

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
  async hdel(key: string, field: string): Promise<number> {
    return this.hash(key).delete(field) ? 1 : 0;
  }
  async llen(key: string): Promise<number> {
    return this.lists.get(key)?.length ?? 0;
  }
  async rpoplpush(): Promise<string | null> {
    return null; // queue is always empty in these tests
  }
}

const OSC_CONTEXT_STUB = {
  getServiceAccessToken: async () => 'test-token'
} as unknown as EncoreScalerConfig['oscContext'];

function makeConfig(redis: FakeRedis, workspaceId: string, idleTimeoutMs: number): EncoreScalerConfig {
  return {
    workspaceId,
    maxInstances: 3,
    idleTimeoutMs,
    redisUrl: 'redis://fake',
    oscContext: OSC_CONTEXT_STUB,
    redis: redis as unknown as EncoreScalerConfig['redis'],
    getToken: async () => 'test-token'
  };
}

function idleRecord(instanceId: string, idleForMs: number): EncoreInstanceRecord {
  return {
    instanceId,
    url: `https://${instanceId}.example`,
    activeJobs: 0,
    lastIdleAt: Date.now() - idleForMs
  };
}

describe('Encore idle timeout — runtime scale-down (issue #87)', () => {
  beforeEach(() => {
    destroyInstance.mockClear();
    spawnInstance.mockClear();
  });

  it('a runtime timeout change takes effect on the next tick', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-idle';
    // Instance has been idle for 60s.
    const record = idleRecord('inst-1', 60_000);
    await redis.hset(keys.pool(workspaceId), record.instanceId, JSON.stringify(record));

    // Boot-time timeout is 5 min: 60s idle is NOT past it, so the tick leaves it.
    const config = makeConfig(redis, workspaceId, 300_000);
    const loop = new EncoreScalerLoop(config);
    await loop.tick();
    expect(destroyInstance).not.toHaveBeenCalled();
    expect(await redis.hgetall(keys.pool(workspaceId))).toHaveProperty(record.instanceId);

    // Lower the timeout at runtime to 10s. The very next tick must now consider
    // the same 60s-idle instance past-timeout and tear it down.
    loop.setIdleTimeoutMs(10_000);
    await loop.tick();

    // Regression guard for the teardown path: the loop dispatches the idle
    // instance to destroyInstance (which, in production, calls OSC removeInstance
    // then HDELs the pool record — see instance-pool.ts:167 + the e2e "scales
    // down" test that asserts the real hash drop against OSC).
    expect(destroyInstance).toHaveBeenCalledTimes(1);
    expect(destroyInstance).toHaveBeenCalledWith(record.instanceId, config);
  });

  it('does not tear down an instance still within the (lowered but not exceeded) timeout', async () => {
    const redis = new FakeRedis();
    const workspaceId = 'ws-idle-2';
    const record = idleRecord('inst-2', 5_000); // idle only 5s
    await redis.hset(keys.pool(workspaceId), record.instanceId, JSON.stringify(record));

    const config = makeConfig(redis, workspaceId, 300_000);
    const loop = new EncoreScalerLoop(config);
    loop.setIdleTimeoutMs(10_000); // 5s idle < 10s timeout
    await loop.tick();

    expect(destroyInstance).not.toHaveBeenCalled();
    expect(await redis.hgetall(keys.pool(workspaceId))).toHaveProperty(record.instanceId);
  });
});

describe('scaler router — observable + runtime-configurable idle timeout (issue #87)', () => {
  let app: FastifyInstance;
  const changes: Array<{ maxInstances: number; minInstances: number; idleTimeoutMs: number }> = [];

  beforeEach(async () => {
    changes.length = 0;
    app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(scalerRouter, {
      prefix: '/scaler',
      // redis undefined -> scalerActive:false, but idleTimeoutMs still reported.
      maxInstances: 3,
      minInstances: 0,
      idleTimeoutMs: 300_000,
      onConfigChange: (cfg) => changes.push(cfg)
    });
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
  });

  it('GET /status reports the effective idleTimeoutMs (default 5 min)', async () => {
    const res = await app.inject({ method: 'GET', url: '/scaler/status' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ idleTimeoutMs: 300_000, scalerActive: false });
  });

  it('PATCH /config accepts idleTimeoutMs, fans it out, and status reflects it', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: '/scaler/config',
      payload: { idleTimeoutMs: 60_000 }
    });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ idleTimeoutMs: 60_000 });
    // Fanned out via onConfigChange for the registry to apply to live loops.
    expect(changes).toEqual([{ maxInstances: 3, minInstances: 0, idleTimeoutMs: 60_000 }]);

    const status = await app.inject({ method: 'GET', url: '/scaler/status' });
    expect(status.json()).toMatchObject({ idleTimeoutMs: 60_000 });
  });

  it('PATCH /config rejects an idleTimeoutMs below the sane floor with 400', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/scaler/config',
      payload: { idleTimeoutMs: 500 }
    });
    expect(res.statusCode).toBe(400);
    // No change fanned out on a rejected patch.
    expect(changes).toHaveLength(0);
  });
});
