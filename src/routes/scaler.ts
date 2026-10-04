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
//       spawnFailure: encore:spawn-failure:{workspaceId}
//                 (Redis string — JSON SpawnFailureRecord, read back via
//                  readSpawnFailure() in src/encore-scaler/spawn-failure.ts)
//   - EncoreInstanceRecord shape: src/encore-scaler/types.ts:37-42
//       { instanceId, url, activeJobs, lastIdleAt }
//   - listInstances(redis, workspaceId): src/encore-scaler/instance-pool.ts:46
//   - ioredis Redis.scan / .llen: ioredis type definitions.
//   - Durable scaler config (#1077): src/services/param-store.ts —
//       SCALER_CONFIG_KEY ('openvideocore/scalerconfig'), the ScalerRuntimeConfig
//       value shape, ScalerConfigStore.save/load and makeScalerConfigStore,
//       which writes through ConfigKvStore.set (POST /api/v1/config {key,value},
//       throwing `config kv write failed: <status> <body>` on a non-2xx).
//   - JOBS_PER_INSTANCE: src/encore-scaler/types.ts — the per-instance job
//     capacity the scaler loop itself treats as "busy"
//     (scaler-loop.ts:245 `activeJobs >= JOBS_PER_INSTANCE`, :395 dispatch
//     guard). Reported on the wire (#979) so a client never has to infer it.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { JOBS_PER_INSTANCE, keys } from '../encore-scaler/types.js';
import { listInstances } from '../encore-scaler/instance-pool.js';
import { readSpawnFailure } from '../encore-scaler/spawn-failure.js';
import type { ScalerConfigStore } from '../services/param-store.js';

type ScalerRouterOptions = {
  // The Valkey connection used by the scaler. Undefined when the scaler is off
  // (no stack provisioned yet). Set live by main.ts the moment a stack is
  // provisioned, so GET /status flips to scalerActive:true without a restart
  // (#103); the status endpoint reports scalerActive:false while it is undefined.
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
  // Durable store for the scaler runtime config (#1077). PATCH /config writes
  // here BEFORE it applies anything, so a restart does not lose an operator's
  // change. Undefined when the parameter store is unconfigured
  // (PARAMETER_STORE_API_KEY unset, or the config instance unresolvable) — PATCH
  // then responds 501 rather than accepting a change it cannot make durable.
  // Contract (key, value shape, error semantics): services/param-store.ts
  // SCALER_CONFIG_KEY / ScalerRuntimeConfig / makeScalerConfigStore.
  configStore?: ScalerConfigStore;
};

// Lower bound on the runtime idle timeout. A near-zero timeout would let the
// scaler destroy an instance almost as soon as it goes idle, thrashing the
// spawn/destroy cycle (spawns take 60-120s). 10s is a defensible floor.
const MIN_IDLE_TIMEOUT_MS = 10_000;

// Error body for the PATCH /config failure paths (#1077). Same { error, message }
// shape the rest of the API uses (errorSchema, src/routes/storage.ts:65).
const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

// Mirrors EncoreInstanceRecord (src/encore-scaler/types.ts) for the fields an
// operator needs to reason about scaling decisions.
//
// #778 (review finding 5):
//   - `readyAt` is surfaced because it is the one field that makes "spawned but
//     never dispatched a job" diagnosable — the leak this issue is about. Without
//     it the response schema silently STRIPPED the field and the ops UI could not
//     show it. Optional: records written before #778 do not carry it
//     (EncoreInstanceRecord.readyAt is optional for the same reason).
//   - `lastIdleAt` is optional rather than required, so a record whose idle
//     timestamp was lost or written as a non-number — precisely the case
//     resolveIdleSince()/isIdlePastTimeout() exist to tolerate — is REPORTED to
//     the operator instead of failing response validation and hiding the whole
//     workspace.
//
// #979:
//   - `draining` is surfaced because scale-down marks an instance draining
//     instead of killing it while it still has in-flight work (#513, drain-don't-
//     kill). The record has carried the flag since then, but this schema stripped
//     it, so "draining" was indistinguishable from "healthy and busy" to every
//     client. Optional, matching EncoreInstanceRecord.draining: it is only
//     present on a record that is actually draining.
const instanceSchema = z.object({
  instanceId: z.string(),
  url: z.string(),
  activeJobs: z.number(),
  lastIdleAt: z.number().optional(),
  readyAt: z.number().optional(),
  draining: z.boolean().optional()
});

// The workspace's most recent FAILED scale-up (#1071).
//
// Without this, a pool that stops growing with jobs still queued looks the same
// whether the scaler is at `maxInstances` or whether every spawn is being
// refused: `instances: 1, queueDepth: 1` either way. maxInstances + the
// instances array already answer "am I at cap"; this answers "did the last
// attempt to grow fail, when, after how many tries, and with what error" — so
// the two are finally distinguishable without reading pod logs.
//
// `message` is pre-redacted at WRITE time (spawn-failure.ts
// redactSpawnFailureMessage): credentials, URLs, bare network locations and
// tokens never reach this field, because OSC error text can echo the request
// body the spawn sent — and because this router is deliberately unauthenticated
// (see the header), so whatever lands in the field is public. The redaction is
// structural rather than a literal-secret list for exactly that reason (#1071
// review finding 2): a failed spawn is often a transport failure, and those
// quote internal hostnames and IP:port pairs with no scheme to recognise them by.
// Absent entirely when the last spawn succeeded or none has failed in
// SPAWN_FAILURE_TTL_MS.
const spawnFailureSchema = z
  .object({
    at: z
      .number()
      .describe('Epoch milliseconds at which the failed scale-up was recorded.'),
    attempts: z
      .number()
      .describe(
        'Total instance-create calls the failed spawn made, across both the ' +
          'transcoder instance and its paired callback listener. Not the attempt ' +
          'number of a single retry loop: it can exceed the per-loop retry limit.'
      ),
    consecutiveFailures: z
      .number()
      .describe(
        'How many scale-ups have failed in a row for this workspace. Reset to 0 ' +
          'by a successful spawn, so 1 is a fresh blip while a climbing number ' +
          'means the scaler has been unable to grow for a while.'
      ),
    message: z
      .string()
      .describe(
        'Error text from the failed spawn, redacted at write time: credentials, ' +
          'tokens, URLs and bare network locations (host, host:port, IP:port) are ' +
          'stripped, as is any HTML markup, because upstream error text can echo ' +
          'the request the spawn sent. This endpoint is unauthenticated, so the ' +
          'field carries the SHAPE of the failure, not its details.'
      )
  })
  .describe(
    'The last scale-up for this workspace that could not create an instance. ' +
      'Absent when the most recent spawn succeeded, or when none has failed ' +
      'recently. This is what distinguishes "the pool is at maxInstances" from ' +
      '"the pool cannot grow", which are otherwise identical on the wire.'
  );

const workspaceSchema = z.object({
  workspaceId: z.string(),
  queueDepth: z.number(),
  inflightDepth: z.number(),
  instances: z.array(instanceSchema),
  spawnFailure: spawnFailureSchema.optional()
});

const scalerStatusSchema = z.object({
  workspaces: z.array(workspaceSchema),
  maxInstances: z.number(),
  // How many concurrent jobs ONE instance can take before the scaler counts it
  // as busy (#979). A server-owned config constant, reported alongside
  // maxInstances/idleTimeoutMs so a client can render "activeJobs of capacity"
  // from the payload instead of reverse-engineering capacity from the pool's
  // observed load — an inference that is only right while the constant is 1.
  jobsPerInstance: z.number(),
  idleTimeoutMs: z.number(),
  scalerActive: z.boolean()
});

// Project a pool record onto the response shape, dropping any timestamp that is
// not a usable number (#778 review finding 5). A record whose `lastIdleAt` was
// lost or round-tripped as a non-number must still be REPORTED — it is the exact
// record an operator needs to see — so the value is omitted rather than allowed
// to fail response validation for the whole workspace.
function toInstanceView(record: {
  instanceId: string;
  url: string;
  activeJobs: number;
  lastIdleAt?: unknown;
  readyAt?: unknown;
  draining?: unknown;
}): z.infer<typeof instanceSchema> {
  const asNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  return {
    instanceId: record.instanceId,
    url: record.url,
    activeJobs: record.activeJobs,
    lastIdleAt: asNumber(record.lastIdleAt),
    readyAt: asNumber(record.readyAt),
    // Only emitted when the record is actually draining (#979). An instance that
    // is not draining carries no flag at all, exactly as the record does.
    draining: record.draining === true ? true : undefined
  };
}

// Scan for every key with `prefix` and return the workspaceId suffixes. Uses
// SCAN (cursor paging) rather than KEYS so it does not block Valkey on large
// keyspaces.
async function scanWorkspaceIdsWithPrefix(
  redis: Redis,
  prefix: string,
  into: Set<string>
): Promise<void> {
  const pattern = `${prefix}*`;
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    for (const key of batch) {
      if (key.startsWith(prefix)) {
        into.add(key.slice(prefix.length));
      }
    }
  } while (cursor !== '0');
}

// Every workspace the status response should report on.
//
// The pool hash is the primary source, but it is NOT sufficient (#1071): a
// workspace whose spawns all fail has no pool hash at all, so keying the
// listing on pool keys alone hid exactly the case the spawn-failure record
// exists to surface — nothing provisioned, jobs queueing, and no row in
// `workspaces` to hang the explanation off. The spawn-failure keyspace is
// therefore scanned too, and a workspace present in only that one is reported
// with an empty `instances` array alongside its queue depths.
const POOL_PREFIX = keys.pool('');
const SPAWN_FAILURE_PREFIX = keys.spawnFailure('');
async function scanWorkspaceIds(redis: Redis): Promise<string[]> {
  const found = new Set<string>();
  await scanWorkspaceIdsWithPrefix(redis, POOL_PREFIX, found);
  await scanWorkspaceIdsWithPrefix(redis, SPAWN_FAILURE_PREFIX, found);
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
        // Scaler off (no stack provisioned yet, or the stack's Valkey URL could
        // not be resolved). Report the CONFIGURED maxInstances, not a literal 0
        // (issue #780): a hardcoded 0 read like a misconfigured instance cap and
        // sent operators looking at scaler config instead of at activation.
        // `scalerActive:false` is the field that says the scaler is off.
        return {
          workspaces: [],
          maxInstances: liveMaxInstances,
          jobsPerInstance: JOBS_PER_INSTANCE,
          idleTimeoutMs: liveIdleTimeoutMs,
          scalerActive: false
        };
      }

      const workspaceIds = await scanWorkspaceIds(redis);
      const workspaces = await Promise.all(
        workspaceIds.map(async (workspaceId) => {
          const [queueDepth, inflightDepth, instances, spawnFailure] = await Promise.all([
            redis.llen(keys.queue(workspaceId)),
            redis.llen(keys.inflight(workspaceId)),
            listInstances(redis, workspaceId),
            // #1071. readSpawnFailure is total (never throws, drops a junk
            // record) so one unreadable key cannot take the whole status
            // response down.
            readSpawnFailure(redis, workspaceId)
          ]);
          return {
            workspaceId,
            queueDepth,
            inflightDepth,
            instances: instances.map(toInstanceView),
            spawnFailure
          };
        })
      );

      return {
        workspaces,
        maxInstances: liveMaxInstances,
        // Sourced from the scaler's own constant, not a router option, so the
        // wire value and the loop's busy threshold cannot drift (#979).
        jobsPerInstance: JOBS_PER_INSTANCE,
        idleTimeoutMs: liveIdleTimeoutMs,
        scalerActive: true
      };
    }
  );

  // PATCH /config — change the live scaler config AND persist it (#1077).
  //
  // WRITE-THEN-APPLY. The durable write happens BEFORE any live value moves, so
  // the observable contract is "never 2xx without a durable write":
  //   200 — the new values are in the parameter store and now live.
  //   501 — no parameter store is configured, so nothing could be made durable.
  //         Nothing is applied. Mirrors the registry routes' 501-when-unconfigured
  //         idiom (src/routes/storage.ts:363). This is deliberately stricter than
  //         the pre-#1077 behaviour, which returned 200 for a change that was
  //         silently lost on restart.
  //   503 — the store rejected or could not be reached. Nothing is applied, so
  //         GET /config still reports the previous values and the caller can
  //         retry.
  // Validation is unchanged: the same `scalerConfigSchema.partial()` body schema
  // rejects out-of-range values with a 400 before this handler runs, so only
  // already-valid values ever reach the store.
  app.patch(
    '/config',
    {
      schema: {
        tags: ['admin'],
        body: scalerConfigSchema.partial(),
        response: { 200: scalerConfigSchema, 501: errorSchema, 503: errorSchema }
      }
    },
    async (request, reply) => {
      const { maxInstances, minInstances, idleTimeoutMs } = request.body;
      // The complete config this request would establish: the validated fields
      // it supplied, merged over the current live values. A full snapshot is
      // what gets persisted (see SCALER_CONFIG_KEY in services/param-store.ts),
      // so a one-field PATCH never leaves a partial record in the store.
      const next = {
        maxInstances: maxInstances ?? liveMaxInstances,
        minInstances: minInstances ?? liveMinInstances,
        idleTimeoutMs: idleTimeoutMs ?? liveIdleTimeoutMs
      };

      const store = opts.configStore;
      if (!store) {
        return reply.code(501).send({
          error: 'scaler_config_not_persistable',
          message:
            'no parameter store is configured, so a scaler config change cannot be ' +
            'persisted and would be lost on restart; set PARAMETER_STORE_API_KEY'
        });
      }

      try {
        await store.save(next);
      } catch (err) {
        // Live values are untouched — the assignments below are only reached on
        // a successful durable write.
        request.log.warn(
          {
            op: 'patchScalerConfig',
            err: err instanceof Error ? { message: err.message } : String(err)
          },
          'scaler config write to the parameter store failed; change not applied'
        );
        // The upstream failure text stays in the LOG, not on the wire. This
        // router is deliberately unauthenticated (see the file header), and
        // config-service error text can echo the request the write sent plus
        // internal hostnames — the same reason spawn-failure messages are
        // redacted at write time (#1071). The response carries the SHAPE of the
        // failure; the detail is an operator-only log line.
        return reply.code(503).send({
          error: 'scaler_config_persist_failed',
          message:
            'the scaler config could not be written to the parameter store, so the ' +
            'change was not applied; retry, and see the server log for the cause'
        });
      }

      liveMaxInstances = next.maxInstances;
      liveMinInstances = next.minInstances;
      liveIdleTimeoutMs = next.idleTimeoutMs;
      opts.onConfigChange?.(next);
      return next;
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
