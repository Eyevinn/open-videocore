// Encore auto-scaler end-to-end integration test (issue #8 follow-on).
//
// Unlike the unit tests, this exercises the REAL scaler loop against a REAL
// OSC environment and a REAL Redis/Valkey. It spawns and tears down actual
// Encore OSC instances, so it is SLOW (Encore startup ~60-120s) and is
// SKIPPED automatically unless both OSC_ACCESS_TOKEN and REDIS_URL are set.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - @osaas/client-core lib/core.d.ts:
//       getInstance(context, serviceId, name, token): Promise<any>   (line 56)
//       listInstances(context, serviceId, token): Promise<any>       (line 65)
//   - Context reads OSC_ACCESS_TOKEN from env (src/main.ts:121 `new Context()`).
//   - Scaler surface: makeScalingEncoreClient / EncoreScalerLoop (src/encore-scaler/index.ts),
//     spawnInstance/destroyInstance/listInstances/updateInstance + ENCORE_SERVICE_ID
//     (src/encore-scaler/instance-pool.ts), keys/JOBS_PER_INSTANCE (types.ts).
//   - encodeEncoreJobId (src/data/job-repo.ts:143).
//   - EncoreSubmitInput / EncoreProfile shapes (src/pipeline/encore-client.ts,
//     src/pipeline/encode-presets.ts).

import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Redis as IORedis, type Redis } from 'ioredis';
import { Context, getInstance as oscGetInstance } from '@osaas/client-core';

import { makeScalingEncoreClient, EncoreScalerLoop } from '../src/encore-scaler/index.js';
import type { EncoreScalerConfig } from '../src/encore-scaler/types.js';
import { keys } from '../src/encore-scaler/types.js';
import {
  ENCORE_SERVICE_ID,
  destroyInstance,
  listInstances,
  spawnInstance,
  updateInstance
} from '../src/encore-scaler/instance-pool.js';
import { encodeEncoreJobId } from '../src/data/job-repo.js';
import type { EncoreSubmitInput } from '../src/pipeline/encore-client.js';
import type { EncoreProfile } from '../src/pipeline/encode-presets.js';

// Encore instances can take 60-120s to become ready on OSC.
const E2E_TIMEOUT_MS = 180_000;

const SKIP = !process.env['OSC_ACCESS_TOKEN'] || !process.env['REDIS_URL'];

// Minimal profile consistent with EncoreProfile (encode-presets.ts). "program"
// is the only profile confirmed present in the OSC Encore instance.
const PROFILE: EncoreProfile = {
  name: 'program',
  outputs: [
    {
      label: '1080p',
      width: 1920,
      height: 1080,
      videoBitrateBps: 4_000_000,
      audioBitrateBps: 128_000,
      format: 'mp4'
    }
  ]
};

function makeSubmitInput(workspaceId: string, jobLocalId: string): EncoreSubmitInput {
  return {
    externalId: encodeEncoreJobId(workspaceId, jobLocalId),
    inputUri: 's3://openvideocore-e2e/source/dummy.mp4',
    outputUri: 's3://openvideocore-e2e/out',
    profile: PROFILE
  };
}

// Delete every scaler key for a workspace so a test starts from a clean slate.
async function flushWorkspace(redis: Redis, workspaceId: string): Promise<void> {
  await redis.del(
    keys.queue(workspaceId),
    keys.inflight(workspaceId),
    keys.pool(workspaceId),
    keys.jobInstance(workspaceId),
    keys.jobStatus(workspaceId)
  );
}

describe.skipIf(SKIP)('Encore auto-scaler e2e (OSC + Redis)', () => {
  let redis: Redis;
  let oscContext: Context;

  // Track configs whose instances must be cleaned up regardless of outcome.
  const configsToClean: EncoreScalerConfig[] = [];

  beforeEach(() => {
    // REDIS_URL is guaranteed present here (SKIP guard covers absence).
    redis = new IORedis(process.env['REDIS_URL'] as string, {
      maxRetriesPerRequest: null
    });
    oscContext = new Context();
    configsToClean.length = 0;
  });

  // Build a scaler config for a workspace, remembering it for cleanup.
  function makeConfig(
    workspaceId: string,
    maxInstances: number,
    idleTimeoutMs: number
  ): EncoreScalerConfig {
    const config: EncoreScalerConfig = {
      workspaceId,
      maxInstances,
      idleTimeoutMs,
      oscContext,
      redis,
      getToken: () => oscContext.getServiceAccessToken(ENCORE_SERVICE_ID)
    };
    configsToClean.push(config);
    return config;
  }

  afterEach(async () => {
    // Capture the current connection locally so a deferred cleanup can't close
    // a connection that belongs to the next test (redis is reassigned by beforeEach).
    const conn = redis;
    const snapshot = configsToClean.slice();
    // Destroy any instances the test left behind so we never leak OSC compute.
    // Cleanup must be resilient: a test may already have destroyed instances.
    try {
      for (const config of snapshot) {
        const records = await listInstances(conn, config.workspaceId);
        for (const record of records) {
          try {
            await destroyInstance(record.instanceId, config);
          } catch {
            // An already-gone instance is fine; keep cleaning the rest.
          }
        }
        await flushWorkspace(conn, config.workspaceId);
      }
    } catch {
      // Never let cleanup fail the test result.
    } finally {
      await conn.quit().catch(() => undefined);
    }
  // OSC removeInstance takes ~10–30s per instance; allow up to 180s for cleanup.
  }, 180_000);

  it.skipIf(SKIP)(
    'scale-up: spawns one Encore instance when a job is queued',
    async () => {
      const workspaceId = `scalere2e-${Date.now()}`;
      const config = makeConfig(workspaceId, 1, 300_000);
      await flushWorkspace(redis, workspaceId);

      // 1. Enqueue a single fake job via the public scaler client.
      const client = makeScalingEncoreClient(config);
      await client.submit(makeSubmitInput(workspaceId, 'job-1'));

      // 2. One tick should observe the pending job and spawn an instance.
      const loop = new EncoreScalerLoop(config);
      await loop.tick();

      // 3. The pool now holds exactly one record.
      const records = await listInstances(redis, workspaceId);
      expect(records).toHaveLength(1);

      // 4. That instance really exists on OSC.
      const token = await oscContext.getServiceAccessToken(ENCORE_SERVICE_ID);
      const instance = await oscGetInstance(
        oscContext,
        ENCORE_SERVICE_ID,
        records[0]!.instanceId,
        token
      );
      expect(instance).toBeTruthy();
    },
    E2E_TIMEOUT_MS
  );

  it.skipIf(SKIP)(
    'respects maxInstances=1: never spawns a second instance',
    async () => {
      const workspaceId = `scalere2e-${Date.now()}`;
      const config = makeConfig(workspaceId, 1, 300_000);
      await flushWorkspace(redis, workspaceId);

      // 1. Enqueue three jobs.
      const client = makeScalingEncoreClient(config);
      await client.submit(makeSubmitInput(workspaceId, 'job-1'));
      await client.submit(makeSubmitInput(workspaceId, 'job-2'));
      await client.submit(makeSubmitInput(workspaceId, 'job-3'));

      // 2. Three ticks in sequence — the cap must hold across all of them.
      const loop = new EncoreScalerLoop(config);
      await loop.tick();
      await loop.tick();
      await loop.tick();

      // 3/4. Pool is capped at exactly one instance.
      const records = await listInstances(redis, workspaceId);
      expect(records).toHaveLength(1);
    },
    E2E_TIMEOUT_MS
  );

  it.skipIf(SKIP)(
    'scales up to maxInstances=2 with two queued jobs',
    async () => {
      const workspaceId = `scalere2e-${Date.now()}`;
      const config = makeConfig(workspaceId, 2, 300_000);
      await flushWorkspace(redis, workspaceId);

      // 1. Enqueue two jobs.
      const client = makeScalingEncoreClient(config);
      await client.submit(makeSubmitInput(workspaceId, 'job-1'));
      await client.submit(makeSubmitInput(workspaceId, 'job-2'));

      const loop = new EncoreScalerLoop(config);

      // 2a. First tick: spawns instance #1 and (attempts to) dispatch job-1.
      await loop.tick();
      let records = await listInstances(redis, workspaceId);
      expect(records).toHaveLength(1);

      // Force the first instance to look busy so the scale-up condition
      // (all instances busy + pending work + below max) fires on the next
      // tick. This decouples the test from whether the HTTP dispatch to the
      // dummy inputUri actually succeeded.
      await updateInstance(redis, workspaceId, {
        ...records[0]!,
        activeJobs: 1
      });

      // 2b. Second tick: instance #1 is busy and work remains -> spawn #2.
      await loop.tick();

      // 3. Pool now holds exactly two instances.
      records = await listInstances(redis, workspaceId);
      expect(records).toHaveLength(2);
    },
    E2E_TIMEOUT_MS
  );

  it.skipIf(SKIP)(
    'scales down: destroys idle instances past the idle timeout',
    async () => {
      const workspaceId = `scalere2e-${Date.now()}`;
      const idleTimeoutMs = 300_000;
      const config = makeConfig(workspaceId, 1, idleTimeoutMs);
      await flushWorkspace(redis, workspaceId);

      // 1. Spawn a real Encore instance directly.
      const spawned = await spawnInstance(config);

      // 2. It is registered in the pool.
      let records = await listInstances(redis, workspaceId);
      expect(records).toHaveLength(1);
      const instanceId = spawned.instanceId;

      // 3. Mark it idle, with lastIdleAt already past the timeout threshold.
      await updateInstance(redis, workspaceId, {
        ...spawned,
        activeJobs: 0,
        lastIdleAt: Date.now() - (idleTimeoutMs + 1000)
      });

      // 4. No jobs queued (flush guaranteed the queue is empty).

      // 5. One tick should scale the idle instance down.
      const loop = new EncoreScalerLoop(config);
      await loop.tick();

      // 6. Pool is empty.
      records = await listInstances(redis, workspaceId);
      expect(records).toHaveLength(0);

      // 7. The instance is eventually gone from OSC. OSC propagates the deletion
      //    asynchronously so we poll for up to 30s rather than asserting instantly.
      const token = await oscContext.getServiceAccessToken(ENCORE_SERVICE_ID);
      let stillPresent = true;
      const deadline = Date.now() + 30_000;
      while (Date.now() < deadline) {
        try {
          const instance = await oscGetInstance(
            oscContext,
            ENCORE_SERVICE_ID,
            instanceId,
            token
          );
          stillPresent = Boolean(instance);
          if (!stillPresent) break;
        } catch {
          stillPresent = false;
          break;
        }
        await new Promise((r) => setTimeout(r, 3_000));
      }
      expect(stillPresent).toBe(false);
    },
    E2E_TIMEOUT_MS
  );
});
