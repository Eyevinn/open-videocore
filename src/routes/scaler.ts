// Encore auto-scaler status router.
//
// Exposes read-only introspection of the per-workspace Encore auto-scaler pool
// so an ops UI can visualise queue depth, in-flight jobs, and live instances.
// Intentionally NOT behind the `authenticate` preHandler — like the admin
// status endpoints it reports aggregate operational state, not workspace data,
// so an operator or probe can read it without a workspace token.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Valkey key schema: src/encore-scaler/types.ts `keys` object
//       queue:    encore:queue:{workspaceId}    (Redis list — LLEN for depth)
//       inflight: encore:inflight:{workspaceId} (Redis list — LLEN for depth)
//       pool:     encore:pool:{workspaceId}     (Redis hash of EncoreInstanceRecord)
//   - EncoreInstanceRecord shape: src/encore-scaler/types.ts:37-42
//       { instanceId, url, activeJobs, lastIdleAt }
//   - listInstances(redis, workspaceId): src/encore-scaler/instance-pool.ts:46
//   - ioredis Redis.scan / .llen: ioredis type definitions.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { keys } from '../encore-scaler/types.js';
import { listInstances } from '../encore-scaler/instance-pool.js';

type ScalerRouterOptions = {
  // The shared Valkey connection used by the scaler. Undefined when the scaler
  // is off (no REDIS_URL); the status endpoint then reports scalerActive:false.
  redis?: Redis;
  // Upper bound on instances per workspace pool (ENCORE_MAX_INSTANCES).
  maxInstances: number;
  // Minimum instances to keep warm (0 = scale to zero when idle). Default 0.
  minInstances?: number;
  // Idle time (ms) before an idle Encore instance is torn down
  // (ENCORE_IDLE_TIMEOUT_MS). Default 5 minutes.
  idleTimeoutMs: number;
  // Callback to update the live scaler config at runtime.
  onConfigChange?: (cfg: { maxInstances: number; minInstances: number; idleTimeoutMs: number }) => void;
};

// Lower bound on the runtime idle timeout. A near-zero timeout would let the
// scaler destroy an instance almost as soon as it goes idle, thrashing the
// spawn/destroy cycle (spawns take 60-120s). 10s is a defensible floor.
const MIN_IDLE_TIMEOUT_MS = 10_000;

const instanceSchema = z.object({
  instanceId: z.string(),
  url: z.string(),
  activeJobs: z.number(),
  lastIdleAt: z.number()
});

const workspaceSchema = z.object({
  workspaceId: z.string(),
  queueDepth: z.number(),
  inflightDepth: z.number(),
  instances: z.array(instanceSchema)
});

const scalerStatusSchema = z.object({
  workspaces: z.array(workspaceSchema),
  maxInstances: z.number(),
  idleTimeoutMs: z.number(),
  scalerActive: z.boolean()
});

// Scan for every pool hash key and extract the workspaceId. Uses SCAN (cursor
// paging) rather than KEYS so it does not block Valkey on large keyspaces.
const POOL_PREFIX = keys.pool('');
async function scanWorkspaceIds(redis: Redis): Promise<string[]> {
  const pattern = `${POOL_PREFIX}*`;
  const found = new Set<string>();
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    for (const key of batch) {
      if (key.startsWith(POOL_PREFIX)) {
        found.add(key.slice(POOL_PREFIX.length));
      }
    }
  } while (cursor !== '0');
  return [...found];
}

export const scalerRouter: FastifyPluginAsync<ScalerRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Mutable runtime config — updated by PATCH /config.
  let liveMaxInstances = opts.maxInstances;
  let liveMinInstances = opts.minInstances ?? 0;
  let liveIdleTimeoutMs = opts.idleTimeoutMs;

  const scalerConfigSchema = z.object({
    maxInstances: z.number().int().min(1).max(20),
    minInstances: z.number().int().min(0).max(10),
    idleTimeoutMs: z.number().int().min(MIN_IDLE_TIMEOUT_MS)
  });

  app.get(
    '/status',
    { schema: { tags: ['admin'], response: { 200: scalerStatusSchema } } },
    async () => {
      const redis = opts.redis;
      if (!redis) {
        return { workspaces: [], maxInstances: 0, idleTimeoutMs: liveIdleTimeoutMs, scalerActive: false };
      }

      const workspaceIds = await scanWorkspaceIds(redis);
      const workspaces = await Promise.all(
        workspaceIds.map(async (workspaceId) => {
          const [queueDepth, inflightDepth, instances] = await Promise.all([
            redis.llen(keys.queue(workspaceId)),
            redis.llen(keys.inflight(workspaceId)),
            listInstances(redis, workspaceId)
          ]);
          return { workspaceId, queueDepth, inflightDepth, instances };
        })
      );

      return { workspaces, maxInstances: liveMaxInstances, idleTimeoutMs: liveIdleTimeoutMs, scalerActive: true };
    }
  );

  app.patch(
    '/config',
    {
      schema: {
        tags: ['admin'],
        body: scalerConfigSchema.partial(),
        response: { 200: scalerConfigSchema }
      }
    },
    async (request) => {
      const { maxInstances, minInstances, idleTimeoutMs } = request.body;
      if (maxInstances !== undefined) liveMaxInstances = maxInstances;
      if (minInstances !== undefined) liveMinInstances = minInstances;
      if (idleTimeoutMs !== undefined) liveIdleTimeoutMs = idleTimeoutMs;
      opts.onConfigChange?.({
        maxInstances: liveMaxInstances,
        minInstances: liveMinInstances,
        idleTimeoutMs: liveIdleTimeoutMs
      });
      return {
        maxInstances: liveMaxInstances,
        minInstances: liveMinInstances,
        idleTimeoutMs: liveIdleTimeoutMs
      };
    }
  );

  app.get(
    '/config',
    {
      schema: {
        tags: ['admin'],
        response: { 200: scalerConfigSchema }
      }
    },
    async () => ({
      maxInstances: liveMaxInstances,
      minInstances: liveMinInstances,
      idleTimeoutMs: liveIdleTimeoutMs
    })
  );
};
