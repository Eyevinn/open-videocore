// Usage read surface (issue #581).
//
// Exposes a single read-only GET /usage endpoint reporting, for the deployment,
// current consumption vs. the configured caps for BOTH governed resources:
//   - storage:  bytes consumed (+ in-flight reserved) vs. the storage cap.
//   - jobs:     outstanding jobs (queued + inflight) vs. the throughput cap.
//
// WHY — a Media Developer otherwise has no way to see how much headroom remains
// before hitting a limit, so a `quota_exceeded` / `job_throughput_cap_exceeded`
// error arrives with no warning. This surface makes the remaining headroom
// observable up front.
//
// NO DRIFT (issue #581 acceptance criterion): every number here is read from the
// SAME authoritative accounting source that enforcement uses. This router adds no
// parallel counter:
//   - storage consumption + cap come from the running-total counter and the guard
//     the ingest admission path enforces against
//     (src/data/storage-quota.ts `StorageQuotaStore.read()` / `StorageQuotaGuard.cap()`).
//   - outstanding jobs + cap come from the scaler's own Valkey depths and the
//     env-resolved cap the submit path enforces against
//     (src/encore-scaler/job-throughput-cap.ts `outstandingJobCount()` /
//     `resolveJobThroughputCap()`).
//
// Caps are opt-in (ADR-020). When a cap is unset (STORAGE_CAP_BYTES /
// ENCORE_MAX_QUEUED_JOBS unset / 0 / invalid) enforcement treats it as no cap;
// this surface mirrors that by reporting `configured: false` and a null limit.
//
// Deployment model (ADR-020 Decision 1): a deployed instance IS the tenant, so
// there is no per-request workspace dimension. The Valkey job depths are keyed by
// the deployment-wide context (DEPLOYMENT_CONTEXT, src/auth/workspace.ts), exactly
// as the scaler and the throughput cap key them. Like the scaler/retention status
// endpoints this reports aggregate operational state (not workspace data), so it
// is intentionally not behind an authenticate preHandler.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Storage running-total read: src/data/storage-quota.ts
//       `StorageQuotaStore.read(): Promise<{ consumedBytes; reservedBytes }>` (line 119, 88-91)
//       `StorageQuotaGuard.cap(): number | undefined`                          (line 346)
//   - Job outstanding count + cap: src/encore-scaler/job-throughput-cap.ts
//       `outstandingJobCount(redis, workspaceId): Promise<number>`             (line 104)
//       `resolveJobThroughputCap(env): number | undefined`                     (line 90)
//   - Deployment context (workspaceId for Valkey keys): src/auth/workspace.ts
//       `DEPLOYMENT_CONTEXT` (line 46)
//   - Injectable-read + zod response-schema router pattern: src/routes/health.ts:49-73
//   - Redis-backed read-only status router pattern: src/routes/scaler.ts:88-125

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { DEPLOYMENT_CONTEXT } from '../auth/workspace.js';
import { outstandingJobCount } from '../encore-scaler/job-throughput-cap.js';

// The storage-usage block. `used` is the current running total the ingest guard
// enforces against: committed bytes plus in-flight reserved headroom (exactly the
// sum the reserve check evaluates, src/data/storage-quota.ts:270). `configured`
// mirrors enforcement's opt-in: false => no cap, and `limitBytes` is then null.
const storageUsageSchema = z.object({
  // Bytes currently accounted against the deployment: committed + in-flight reserved.
  usedBytes: z.number(),
  // Committed bytes (statObject-true sizes). Broken out for diagnostics.
  consumedBytes: z.number(),
  // In-flight admission headroom not yet committed. Broken out for diagnostics.
  reservedBytes: z.number(),
  // Whether a storage cap is configured at all (caps are opt-in).
  configured: z.boolean(),
  // The configured cap in bytes, or null when no cap is configured.
  limitBytes: z.number().nullable(),
  // Remaining headroom in bytes (limitBytes - usedBytes, floored at 0), or null
  // when no cap is configured. Convenience for the "how much before I hit it" DX.
  availableBytes: z.number().nullable()
});

// The job-throughput block. `used` is the current outstanding count the submit
// path enforces against (queued + inflight, src/encore-scaler/job-throughput-cap.ts:104).
const jobsUsageSchema = z.object({
  // Outstanding jobs currently accounted against the deployment: queued + inflight.
  outstanding: z.number(),
  // Whether a job-throughput cap is configured at all (caps are opt-in).
  configured: z.boolean(),
  // The configured maximum outstanding jobs, or null when no cap is configured.
  limit: z.number().nullable(),
  // Remaining headroom in jobs (limit - outstanding, floored at 0), or null when
  // no cap is configured.
  available: z.number().nullable()
});

export const usageResponseSchema = z.object({
  storage: storageUsageSchema,
  jobs: jobsUsageSchema
});

export type UsageResponse = z.infer<typeof usageResponseSchema>;

export type UsageRouterOptions = {
  // Read the current storage running total at request time from the SAME store
  // the ingest guard enforces against. Shape matches StorageQuotaStore.read().
  readStorageCounter: () => Promise<{ consumedBytes: number; reservedBytes: number }>;
  // Read the live storage cap (undefined = no cap) — the SAME value the guard
  // enforces (StorageQuotaGuard.cap()).
  storageCap: () => number | undefined;
  // Read the live job-throughput cap (undefined = no cap) — the SAME value the
  // submit path enforces (resolveJobThroughputCap()).
  jobsCap: () => number | undefined;
  // The Valkey connection used by the scaler. Undefined when the scaler is off
  // (no stack provisioned yet); outstanding jobs then read as 0, mirroring the
  // scaler status endpoint which reports empty state without a connection.
  redis?: Redis;
};

function clampNonNegative(n: number): number {
  return n > 0 ? n : 0;
}

export const usageRouter: FastifyPluginAsync<UsageRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  app.get(
    '/',
    { schema: { tags: ['admin'], response: { 200: usageResponseSchema } } },
    async () => {
      // Storage: read the running total + live cap from the enforcement source.
      const counter = await opts.readStorageCounter();
      const consumedBytes = clampNonNegative(counter.consumedBytes);
      const reservedBytes = clampNonNegative(counter.reservedBytes);
      const usedBytes = consumedBytes + reservedBytes;
      const cap = opts.storageCap();
      const storageConfigured = cap !== undefined;
      const storage = {
        usedBytes,
        consumedBytes,
        reservedBytes,
        configured: storageConfigured,
        limitBytes: storageConfigured ? cap : null,
        availableBytes: storageConfigured ? clampNonNegative(cap - usedBytes) : null
      };

      // Jobs: read outstanding depth (queued + inflight) + live cap from the
      // enforcement source. No connection => scaler off => 0 outstanding.
      const outstanding = opts.redis
        ? await outstandingJobCount(opts.redis, DEPLOYMENT_CONTEXT)
        : 0;
      const jobsCap = opts.jobsCap();
      const jobsConfigured = jobsCap !== undefined;
      const jobs = {
        outstanding,
        configured: jobsConfigured,
        limit: jobsConfigured ? jobsCap : null,
        available: jobsConfigured ? clampNonNegative(jobsCap - outstanding) : null
      };

      return { storage, jobs };
    }
  );
};
