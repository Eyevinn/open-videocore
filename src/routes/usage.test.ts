// Tests for GET /usage — the usage read surface (issue #581).
//
// Builds the usageRouter over a real Fastify instance (with the zod type
// provider, exactly as main.ts wires it) and drives it with app.inject(), so the
// response schema is exercised end-to-end (mirrors src/routes/health.test.ts).
//
// Covers the acceptance criteria:
//   - both caps configured: reports current usage + configured limits + headroom.
//   - neither cap configured: reports limits as unset (configured:false, null).
//   - the reported numbers come from the SAME accounting source enforcement uses:
//     the storage running-total counter (StorageQuotaStore.read) and the scaler's
//     Valkey outstanding-job depths — NOT a parallel counter.

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import type { Redis } from 'ioredis';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { usageRouter, type UsageRouterOptions } from './usage.js';
import {
  InMemoryStorageQuotaStore,
  StorageQuotaGuard
} from '../data/storage-quota.js';
import { outstandingJobCount } from '../encore-scaler/job-throughput-cap.js';
import { keys } from '../encore-scaler/types.js';
import { DEPLOYMENT_CONTEXT } from '../auth/workspace.js';

// A minimal fake Redis exposing only llen over two named lists, matching what
// outstandingJobCount calls (redis.llen on keys.queue / keys.inflight). Keyed by
// the exact key strings the throughput-cap module builds, so this proves the
// surface reads the SAME Valkey keys enforcement counts.
function fakeRedis(depths: Record<string, number>): Redis {
  return {
    async llen(key: string): Promise<number> {
      return depths[key] ?? 0;
    }
  } as unknown as Redis;
}

async function buildApp(opts: UsageRouterOptions) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(usageRouter, opts);
  await app.ready();
  return app;
}

describe('GET /usage (issue #581)', () => {
  it('reports current usage, configured limits, and headroom when BOTH caps are configured', async () => {
    // Storage: 300 consumed + 100 reserved = 400 used, cap 1000 => 600 available.
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 300, reservedBytes: 100 });
    // Jobs: 3 queued + 2 inflight = 5 outstanding, cap 8 => 3 available.
    const redis = fakeRedis({
      [keys.queue(DEPLOYMENT_CONTEXT)]: 3,
      [keys.inflight(DEPLOYMENT_CONTEXT)]: 2
    });

    const app = await buildApp({
      readStorageCounter: () => store.read(),
      storageCap: () => 1000,
      jobsCap: () => 8,
      redis
    });

    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    expect(body.storage).toEqual({
      usedBytes: 400,
      consumedBytes: 300,
      reservedBytes: 100,
      configured: true,
      limitBytes: 1000,
      availableBytes: 600
    });
    expect(body.jobs).toEqual({
      outstanding: 5,
      configured: true,
      limit: 8,
      available: 3
    });

    await app.close();
  });

  it('reports limits as unset (configured:false, null) when NEITHER cap is configured', async () => {
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 42, reservedBytes: 0 });
    const redis = fakeRedis({
      [keys.queue(DEPLOYMENT_CONTEXT)]: 1,
      [keys.inflight(DEPLOYMENT_CONTEXT)]: 0
    });

    const app = await buildApp({
      readStorageCounter: () => store.read(),
      // Mirror enforcement: unset cap resolves to undefined (no cap).
      storageCap: () => undefined,
      jobsCap: () => undefined,
      redis
    });

    const res = await app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Usage is still reported; only the limits are unset.
    expect(body.storage.usedBytes).toBe(42);
    expect(body.storage.configured).toBe(false);
    expect(body.storage.limitBytes).toBeNull();
    expect(body.storage.availableBytes).toBeNull();

    expect(body.jobs.outstanding).toBe(1);
    expect(body.jobs.configured).toBe(false);
    expect(body.jobs.limit).toBeNull();
    expect(body.jobs.available).toBeNull();

    await app.close();
  });

  it('storage numbers come from the SAME running-total counter the ingest guard enforces against', async () => {
    // Build the counter, then drive it through the enforcement guard exactly as
    // the ingest admission path does (reserve -> commit). The usage surface reads
    // the SAME store and cap the guard uses; there is no parallel counter.
    const store = new InMemoryStorageQuotaStore();
    const cap = 1000;
    const guard = new StorageQuotaGuard({ store, capBytes: () => cap });

    // Simulate an ingest that reserves 250 then commits its true size (250).
    const reservation = await guard.admit(250);
    await reservation.commit(250);
    // Simulate an out-of-band committed delta (packaged output write).
    await guard.recordDelta(150);

    const app = await buildApp({
      readStorageCounter: () => store.read(),
      storageCap: () => guard.cap(),
      jobsCap: () => undefined,
      redis: undefined // scaler off => 0 outstanding
    });

    const res = await app.inject({ method: 'GET', url: '/' });
    const body = res.json();

    // 250 (committed ingest) + 150 (delta) = 400 consumed, 0 reserved.
    const counter = await store.read();
    expect(counter).toEqual({ consumedBytes: 400, reservedBytes: 0 });
    expect(body.storage.usedBytes).toBe(400);
    expect(body.storage.consumedBytes).toBe(400);
    expect(body.storage.reservedBytes).toBe(0);
    expect(body.storage.limitBytes).toBe(cap);
    expect(body.storage.availableBytes).toBe(600);

    // Scaler off: outstanding reads as 0 with no Valkey connection.
    expect(body.jobs.outstanding).toBe(0);

    await app.close();
  });

  it('job numbers come from the SAME Valkey depths outstandingJobCount reads for enforcement', async () => {
    // Prove the surface counts the exact keys the throughput-cap enforcement path
    // counts: seed queue + inflight, assert the surface equals outstandingJobCount
    // over the same fake redis.
    const redis = fakeRedis({
      [keys.queue(DEPLOYMENT_CONTEXT)]: 4,
      [keys.inflight(DEPLOYMENT_CONTEXT)]: 3
    });
    const expectedOutstanding = await outstandingJobCount(redis, DEPLOYMENT_CONTEXT);
    expect(expectedOutstanding).toBe(7);

    const store = new InMemoryStorageQuotaStore();
    const app = await buildApp({
      readStorageCounter: () => store.read(),
      storageCap: () => undefined,
      jobsCap: () => 10,
      redis
    });

    const res = await app.inject({ method: 'GET', url: '/' });
    const body = res.json();

    expect(body.jobs.outstanding).toBe(expectedOutstanding);
    expect(body.jobs.limit).toBe(10);
    expect(body.jobs.available).toBe(3);

    await app.close();
  });
});
