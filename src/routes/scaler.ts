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
//   - JOBS_PER_INSTANCE: src/encore-scaler/types.ts — the per-instance job
//     capacity the scaler loop itself treats as "busy"
//     (scaler-loop.ts:245 `activeJobs >= JOBS_PER_INSTANCE`, :395 dispatch
//     guard). Reported on the wire (#979) so a client never has to infer it.
//   - Runtime config provenance (#1079): the live config values below are seeded
//     from this router's options, which main.ts:2285 resolves from the
//     environment (ENCORE_MAX_INSTANCES main.ts:889, ENCORE_IDLE_TIMEOUT_MS
//     main.ts:899, minInstances defaulting to 0), and are overwritten in-process
//     by PATCH /config. Nothing persists them, so `sources` reports which of the
//     two each value currently is — see `configValueSourceSchema`.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { JOBS_PER_INSTANCE, keys } from '../encore-scaler/types.js';
import { listInstances } from '../encore-scaler/instance-pool.js';
import { readSpawnFailure } from '../encore-scaler/spawn-failure.js';

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
};

// Lower bound on the runtime idle timeout. A near-zero timeout would let the
// scaler destroy an instance almost as soon as it goes idle, thrashing the
// spawn/destroy cycle (spawns take 60-120s). 10s is a defensible floor.
const MIN_IDLE_TIMEOUT_MS = 10_000;

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

// Where one scaler config value came from (#1079).
//
// The reported numbers are identical whether they came from the deployment
// environment at boot or were set at runtime through PATCH /config, so after a
// process restart — which discards every runtime change, since the config lives
// in this router's closure and nothing persists it yet — an operator could not
// tell "my PATCH was reverted" from "that is the value I asked for". This says
// which of the two the value is.
const configValueSourceSchema = z
  .object({
    source: z
      .enum(['env', 'runtime'])
      .describe(
        '"env" — the value this deployment started with, from its environment ' +
          '(the environment variable, or the built-in default when it is unset). ' +
          '"runtime" — the value was set through PATCH /config on this running ' +
          'process. A field is "runtime" from the moment a PATCH body carries it, ' +
          'even if the submitted number equals the environment value: this reports ' +
          'who set the value, not whether the number changed.'
      ),
    updatedAt: z
      .string()
      .optional()
      .describe(
        'ISO 8601 UTC timestamp of the PATCH that set this value. Present only ' +
          'when source is "runtime" — an "env" value has no set-time to report, ' +
          'because it was read from the environment at process start rather than ' +
          'written by anyone.'
      )
  })
  .describe(
    'Provenance of a single scaler config value. Read-only and server-asserted: ' +
      'a PATCH /config body accepts only the config values themselves, and an ' +
      'echoed `sources` object is ignored rather than honoured.'
  );

// Provenance for the two config values GET /status reports. `jobsPerInstance` is
// deliberately absent: it is a compiled-in server constant (JOBS_PER_INSTANCE),
// neither environment-derived nor settable at runtime, so neither value of
// `source` would be true of it.
const statusConfigSourcesSchema = z
  .object({
    maxInstances: configValueSourceSchema,
    idleTimeoutMs: configValueSourceSchema
  })
  .describe(
    'Where the config values in this response came from (#1079). Covers the ' +
      'values this endpoint reports that an operator can change; see GET ' +
      '/config for the full set, including minInstances.'
  );

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
  scalerActive: z.boolean(),
  sources: statusConfigSourcesSchema
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

  // Per-field provenance (#1079). A field is absent from this map until a PATCH
  // sets it, so "never patched on this process" and "env-sourced" are the same
  // state — which is exactly right: the values above are seeded from the router
  // options, which main.ts resolves from the environment (ENCORE_MAX_INSTANCES,
  // ENCORE_MIN_INSTANCES, ENCORE_IDLE_TIMEOUT_MS, or their defaults).
  //
  // The map holds the PATCH timestamp because that is a timestamp the process
  // genuinely has. There is no equivalent for an env-sourced value: nothing
  // records when the variable was set, and process start is the time the value
  // was READ, not set. So `updatedAt` is omitted for env values rather than
  // filled in with a boot time that would read as "someone changed this at boot".
  //
  // Lifetime is this process. Nothing persists runtime config yet, so a restart
  // returns every field to "env" — the restart-reverts-silently behaviour this
  // field exists to make visible. When persistence ships, a restored value must
  // keep reporting source "runtime" with its original updatedAt.
  type ConfigField = 'maxInstances' | 'minInstances' | 'idleTimeoutMs';
  const runtimeSetAt: Partial<Record<ConfigField, string>> = {};

  function sourceOf(field: ConfigField): z.infer<typeof configValueSourceSchema> {
    const updatedAt = runtimeSetAt[field];
    return updatedAt === undefined ? { source: 'env' } : { source: 'runtime', updatedAt };
  }

  const scalerConfigSchema = z.object({
    maxInstances: z.number().int().min(1).max(20),
    minInstances: z.number().int().min(0).max(10),
    idleTimeoutMs: z.number().int().min(MIN_IDLE_TIMEOUT_MS)
  });

  // Response shape for GET and PATCH /config: the existing config values, plus
  // their provenance (#1079). Kept as a separate schema from `scalerConfigSchema`
  // so the PATCH REQUEST body stays exactly what it was — the three settable
  // numbers and nothing else. `sources` is server-owned and read-only, and the
  // body validator strips unknown keys, so a read-modify-write client that
  // echoes a whole GET response back into PATCH still works: the echoed
  // `sources` is dropped rather than rejected or mistaken for an input.
  const scalerConfigResponseSchema = scalerConfigSchema.extend({
    sources: z
      .object({
        maxInstances: configValueSourceSchema,
        minInstances: configValueSourceSchema,
        idleTimeoutMs: configValueSourceSchema
      })
      .describe('Where each config value in this response came from (#1079).')
  });

  const configResponse = (): z.infer<typeof scalerConfigResponseSchema> => ({
    maxInstances: liveMaxInstances,
    minInstances: liveMinInstances,
    idleTimeoutMs: liveIdleTimeoutMs,
    sources: {
      maxInstances: sourceOf('maxInstances'),
      minInstances: sourceOf('minInstances'),
      idleTimeoutMs: sourceOf('idleTimeoutMs')
    }
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
          scalerActive: false,
          // Reported on the inactive branch too (#1079), for the same reason the
          // configured maxInstances is (#780): these are config values the server
          // owns whether or not a pool exists, so their provenance is just as
          // readable with the scaler off.
          sources: {
            maxInstances: sourceOf('maxInstances'),
            idleTimeoutMs: sourceOf('idleTimeoutMs')
          }
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
        scalerActive: true,
        sources: {
          maxInstances: sourceOf('maxInstances'),
          idleTimeoutMs: sourceOf('idleTimeoutMs')
        }
      };
    }
  );

  app.patch(
    '/config',
    {
      schema: {
        tags: ['admin'],
        body: scalerConfigSchema.partial(),
        response: { 200: scalerConfigResponseSchema }
      }
    },
    async (request) => {
      const { maxInstances, minInstances, idleTimeoutMs } = request.body;
      // One timestamp for the whole request: every field this PATCH set was set
      // at the same moment, and reporting them as microseconds apart would be
      // fiction.
      const setAt = new Date().toISOString();
      if (maxInstances !== undefined) {
        liveMaxInstances = maxInstances;
        runtimeSetAt.maxInstances = setAt;
      }
      if (minInstances !== undefined) {
        liveMinInstances = minInstances;
        runtimeSetAt.minInstances = setAt;
      }
      if (idleTimeoutMs !== undefined) {
        liveIdleTimeoutMs = idleTimeoutMs;
        runtimeSetAt.idleTimeoutMs = setAt;
      }
      opts.onConfigChange?.({
        maxInstances: liveMaxInstances,
        minInstances: liveMinInstances,
        idleTimeoutMs: liveIdleTimeoutMs
      });
      // The full config with provenance, so a client sees in the PATCH response
      // itself which fields it just took ownership of and which are still the
      // deployment's environment values — no follow-up GET needed.
      return configResponse();
    }
  );

  app.get(
    '/config',
    {
      schema: {
        tags: ['admin'],
        response: { 200: scalerConfigResponseSchema }
      }
    },
    async () => configResponse()
  );
};
