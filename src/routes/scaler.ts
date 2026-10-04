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

const scalerStatusSchema = z.object({
  workspaces: z.array(workspaceSchema),
  // #1080: say which value this is. It is the one in force in this process —
  // the last PATCH /config if any, else ENCORE_MAX_INSTANCES from boot — and it
  // is in-memory, so it is reported here even while `scalerActive` is false.
  maxInstances: z
    .number()
    .describe(
      'Instance cap per workspace pool in force in this process: the most recent ' +
        'PATCH /api/v1/scaler/config value if one has been sent since startup, ' +
        'otherwise ENCORE_MAX_INSTANCES from boot. Not persisted — reverts to the ' +
        'environment value on restart. Reported even when scalerActive is false.'
    ),
  // How many concurrent jobs ONE instance can take before the scaler counts it
  // as busy (#979). A server-owned config constant, reported alongside
  // maxInstances/idleTimeoutMs so a client can render "activeJobs of capacity"
  // from the payload instead of reverse-engineering capacity from the pool's
  // observed load — an inference that is only right while the constant is 1.
  jobsPerInstance: z.number(),
  idleTimeoutMs: z
    .number()
    .describe(
      'Idle teardown timeout (ms) in force in this process: the most recent PATCH ' +
        '/api/v1/scaler/config value if one has been sent since startup, otherwise ' +
        'ENCORE_IDLE_TIMEOUT_MS from boot. Not persisted — reverts to the ' +
        'environment value on restart.'
    ),
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
  //
  // #1080: these three `let`s ARE the whole store. A PATCH writes nothing to
  // Valkey, the parameter store, or disk — it assigns these variables (:404-406)
  // and fans the change out to the live scaler objects through
  // `opts.onConfigChange` (main.ts:2291-2296 -> workspace-registry.ts:283-294 ->
  // scaler-loop.ts:201-207), which are themselves in-memory config objects. So:
  //   - storage:    this plugin instance's closure, per process.
  //   - precedence: the last PATCH this process received wins; before any PATCH,
  //                 the boot values handed in as options (main.ts:2288-2290,
  //                 sourced from ENCORE_MAX_INSTANCES / ENCORE_IDLE_TIMEOUT_MS at
  //                 main.ts:889/899). There is no third, persisted layer.
  //   - reset:      no endpoint — restart the process (these re-initialise from
  //                 the options) or PATCH the env values back explicitly.
  //   - restart:    nothing survives it.
  // The endpoint descriptions below say all of that on the wire, because an
  // operator who cannot see this file otherwise has no way to know that a
  // 200 OK here is not durable.
  let liveMaxInstances = opts.maxInstances;
  let liveMinInstances = opts.minInstances ?? 0;
  let liveIdleTimeoutMs = opts.idleTimeoutMs;

  const scalerConfigSchema = z.object({
    maxInstances: z
      .number()
      .int()
      .min(1)
      .max(20)
      .describe(
        'Upper bound on transcoder instances in one workspace pool. Applied to ' +
          'every running scaler loop as soon as it is set. Boot default: ' +
          'ENCORE_MAX_INSTANCES (3 when unset).'
      ),
    minInstances: z
      .number()
      .int()
      .min(0)
      .max(10)
      .describe(
        'Warm floor of instances kept running while a pool is idle. NOTE: unlike ' +
          'the other two fields this one is only recorded and reported back here — ' +
          'it is NOT fanned out to the running scaler loops, which keep enforcing ' +
          'the floor from ENCORE_MIN_INSTANCES as read at boot. It also reads as 0 ' +
          'until it is PATCHed, whatever ENCORE_MIN_INSTANCES is set to. Change the ' +
          'enforced floor via ENCORE_MIN_INSTANCES and a restart.'
      ),
    idleTimeoutMs: z
      .number()
      .int()
      .min(MIN_IDLE_TIMEOUT_MS)
      .describe(
        'Idle time before an idle instance is torn down, in milliseconds (minimum ' +
          '10000). Applied to every running scaler loop as soon as it is set. Boot ' +
          'default: ENCORE_IDLE_TIMEOUT_MS (300000 when unset).'
      )
  });

  // Same shape on the way out, carrying the durability caveat (#1080) so the
  // response itself states that what it echoes back is in-memory only.
  const scalerConfigResponseSchema = scalerConfigSchema.describe(
    'The auto-scaler configuration this process is using right now. Held in ' +
      'memory only: it is not persisted anywhere, so these values revert to the ' +
      'ENCORE_MAX_INSTANCES / ENCORE_IDLE_TIMEOUT_MS environment values on restart.'
  );

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

  app.patch(
    '/config',
    {
      schema: {
        tags: ['admin'],
        summary: 'Update auto-scaler configuration at runtime',
        description:
          'Override the auto-scaler settings of the process serving this request. ' +
          '`maxInstances` and `idleTimeoutMs` take effect on the next scaler tick, ' +
          'with no restart.\n\n' +
          '**Storage.** The values are kept in memory, in this process only. ' +
          'Nothing is written to Valkey, the parameter store, or disk, so a change ' +
          'is lost on restart or redeploy and is not shared with any other replica. ' +
          'A 200 here means "applied", not "saved".\n\n' +
          '**Precedence.** The most recent PATCH received by this process wins. ' +
          'Until one arrives, the values read at boot from `ENCORE_MAX_INSTANCES` ' +
          '(default 3) and `ENCORE_IDLE_TIMEOUT_MS` (default 300000) apply. There is ' +
          'no persisted layer in between, so the order is simply: runtime PATCH, ' +
          'else environment.\n\n' +
          '**Reset to the environment default.** There is no reset endpoint and no ' +
          'sentinel value. Restart the process (which re-reads the environment), or ' +
          'PATCH the environment value back explicitly — `GET /api/v1/scaler/config` ' +
          'shows what is in force, but not whether it came from a PATCH or from the ' +
          'environment.\n\n' +
          '**Caveats.** `minInstances` is recorded and echoed back but is not ' +
          'applied to the running scaler loops (see the field description). A PATCH ' +
          'sent while `GET /api/v1/scaler/status` reports `scalerActive: false` is ' +
          'accepted and reported back, but is not carried into the scaler that ' +
          'later activates against a newly provisioned stack — that activation uses ' +
          'the environment values, so re-send the PATCH afterwards.',
        body: scalerConfigSchema.partial(),
        response: { 200: scalerConfigResponseSchema }
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
        summary: 'Get the auto-scaler configuration in force',
        description:
          'Report the auto-scaler settings this process is using. These are the ' +
          'in-memory values: the most recent `PATCH /api/v1/scaler/config` if one ' +
          'has been sent since startup, otherwise the boot values from ' +
          '`ENCORE_MAX_INSTANCES` and `ENCORE_IDLE_TIMEOUT_MS`. Nothing is ' +
          'persisted, so after a restart this reports the environment values again. ' +
          'The response does not distinguish the two sources; `minInstances` is ' +
          'reported from this endpoint\'s own record and is not the floor the ' +
          'scaler loops enforce (see the field description).',
        response: { 200: scalerConfigResponseSchema }
      }
    },
    async () => ({
      maxInstances: liveMaxInstances,
      minInstances: liveMinInstances,
      idleTimeoutMs: liveIdleTimeoutMs
    })
  );
};
