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
//   - Runtime config provenance (#1079): the live config values below are seeded
//     from this router's options, which main.ts resolves from the environment
//     (ENCORE_MAX_INSTANCES, ENCORE_IDLE_TIMEOUT_MS, minInstances defaulting to 0),
//     and are overwritten in-process by PATCH /config. Since #1078 those boot
//     values are the PERSISTED snapshot when the parameter store holds a readable
//     one (main.ts resolveScalerBootConfig -> `configSource: 'persisted'`), so
//     `sources` reports which of the two each value currently is — see
//     `configValueSourceSchema` and `bootSource` below.
//   - ScalerStackConnection + WorkspaceEncoreScalerRegistry.listStackConnections():
//     src/encore-scaler/workspace-registry.ts — { stackKey, connectionId?, redis?,
//     unobservedReason? }, resolved through the registry's own
//     resolveStackRedis(), i.e. the identical connection object each loop uses.
//   - valkeyConnectionId(redisUrl): src/encore-scaler/valkey-connection-id.ts —
//     non-secret label for a physical Valkey.
//
// #1074: this endpoint used to read ONE connection — the process-global one
// main.ts assigns on activation. The loops do not: each resolves its stack's own
// Valkey (workspace-registry.ts resolveStackRedis, issue #615). So a pool living
// on a per-stack Valkey was ABSENT from the response rather than reported empty,
// and a depth could come from a different physical store than the loop that owns
// the queue ever read. It now fans out over every connection the loops use,
// labels each reported workspace with the connection it was read from, and
// reports a workspace it could not query as UNOBSERVED instead of dropping it.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { JOBS_PER_INSTANCE, keys } from '../encore-scaler/types.js';
import { listInstances } from '../encore-scaler/instance-pool.js';
import { readSpawnFailure } from '../encore-scaler/spawn-failure.js';
import type { ScalerStackConnection } from '../encore-scaler/workspace-registry.js';
import { SCALER_CONFIG_BOUNDS } from '../services/param-store.js';
import type { ScalerConfigStore } from '../services/param-store.js';

type ScalerRouterOptions = {
  // The Valkey connection used by the scaler. Undefined when the scaler is off
  // (no stack provisioned yet). Set live by main.ts the moment a stack is
  // provisioned, so GET /status flips to scalerActive:true without a restart
  // (#103); the status endpoint reports scalerActive:false while it is undefined.
  //
  // This is the PROCESS-GLOBAL connection (the first-provisioned stack's Valkey,
  // also the fallback every loop uses when no per-stack URL resolves). It is one
  // of the connections GET /status observes, not the only one — see
  // listStackConnections below (#1074).
  redis?: Redis;
  // Non-secret label for `redis` above (#1074), produced by valkeyConnectionId()
  // from the same URL the registry hashes, so a stack that falls back to the
  // process-global Valkey reports the SAME connectionId as this connection
  // instead of appearing to be a second store. Defaults to
  // DEFAULT_CONNECTION_ID when unwired (single-connection deployments, tests).
  redisConnectionId?: string;
  // Enumerate the per-stack Valkey connections the scaler loops actually use
  // (#1074). Wired by main.ts to WorkspaceEncoreScalerRegistry
  // .listStackConnections(). Absent (or returning []) keeps the historical
  // single-connection behaviour, with every reported workspace still labelled
  // with the connection it came from.
  listStackConnections?: () => Promise<ScalerStackConnection[]>;
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
  // Where the boot values above came from (#1078). 'persisted' means main.ts
  // loaded them from the parameter store at boot (resolveScalerBootConfig in
  // services/scaler-boot-config.ts), i.e. they are a previous operator's PATCH
  // restored after a restart; 'env' (the default) means they came from this
  // deployment's environment. It only affects what `sources` REPORTS — the
  // values themselves are already resolved by the caller.
  configSource?: 'env' | 'persisted';
};

// Lower bound on the runtime idle timeout. A near-zero timeout would let the
// scaler destroy an instance almost as soon as it goes idle, thrashing the
// spawn/destroy cycle (spawns take 60-120s). 10s is a defensible floor.
//
// Sourced from services/param-store.ts `SCALER_CONFIG_BOUNDS` (the same constant
// the boot-time clamp in services/scaler-boot-config.ts applies), so the value
// the API rejects and the value boot refuses to adopt cannot drift apart.
const MIN_IDLE_TIMEOUT_MS = SCALER_CONFIG_BOUNDS.idleTimeoutMs.min;

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
  // Which physical Valkey these numbers were read from (#1074). A non-secret
  // label (valkeyConnectionId) — never a URL, host or port, because this endpoint
  // is unauthenticated. Absent only on an unobserved row whose connection could
  // not even be resolved. Two rows with the same workspaceId and different
  // connectionIds mean the keys exist on two stores, which is itself the finding.
  connectionId: z.string().optional(),
  // False when this workspace's Valkey could not be queried (#1074). The pool
  // state below is then unknown, NOT empty: an operator must be able to tell "no
  // instances in this pool" (observed:true, instances:[]) from "this pool was not
  // observed" (observed:false). An unqueryable workspace is reported with this
  // flag, never silently omitted.
  observed: z.boolean(),
  unobservedReason: z
    .string()
    .describe(
      'Why this workspace could not be queried. Carries the shape of the fault ' +
        'only — connection strings and error text stay in the server log, since ' +
        'this endpoint is unauthenticated.'
    )
    .optional(),
  // Read from the SAME Valkey the owning loop reads (#1074), identified by
  // connectionId above. Absent when observed is false — the depth is unknown
  // then, and reporting 0 would read as "empty queue".
  queueDepth: z.number().optional(),
  inflightDepth: z.number().optional(),
  instances: z.array(instanceSchema),
  spawnFailure: spawnFailureSchema.optional()
});

// One physical Valkey the status read covered, and the provisioned stacks bound
// to it (#1074). This is what makes the coverage of the response explicit: a
// client can see which connections were reached, which were not, and which stacks
// hang off each — without any connection string reaching the wire.
const connectionSchema = z.object({
  connectionId: z
    .string()
    .describe(
      'Stable non-secret identifier for a physical Valkey. Equal for every ' +
        'stack sharing a store, different for different stores. Absent when the ' +
        'connection could not be resolved at all.'
    )
    .optional(),
  stacks: z
    .array(z.string())
    .describe(
      'Provisioned stacks whose scaler loop uses this connection. Empty for the ' +
        'process-global connection when no stack resolved to it.'
    ),
  observed: z.boolean(),
  unobservedReason: z.string().optional()
});

// Where one scaler config value came from (#1079).
//
// The reported numbers are identical whether they came from the deployment
// environment or were set by an operator through PATCH /config, so without this
// an operator could not tell "my PATCH is in force" from "that is just the env
// default". This says which of the two the value is.
//
// #1078 changed what a restart does, not what this field means: a restarted
// process now RESTORES the persisted snapshot, so a restored field reports
// 'runtime' (the state it was set in) rather than reverting to 'env'. 'env'
// therefore means one of two things — never configured through the API, or the
// parameter store was unreadable at boot, which the process warn-logs with the
// reason (services/scaler-boot-config.ts).
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
  // Every connection this read covered (#1074), observed or not. Without it,
  // "the response lists two workspaces" could not be distinguished from "the
  // response lists the two workspaces it managed to reach".
  connections: z.array(connectionSchema),
  // #1080: say which value this is. It is the one in force in this process —
  // the last accepted PATCH /config if any, else ENCORE_MAX_INSTANCES from boot
  // — read from the live copy, so it is reported here even while `scalerActive`
  // is false.
  maxInstances: z
    .number()
    .describe(
      'Instance cap per workspace pool in force in this process: the most recent ' +
        'PATCH /api/v1/scaler/config value if one has been accepted since startup, ' +
        'otherwise the boot value — the persisted snapshot from an earlier PATCH ' +
        'when one is stored and readable, else ENCORE_MAX_INSTANCES (#1078). ' +
        'Reported even when scalerActive is false.'
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
        '/api/v1/scaler/config value if one has been accepted since startup, ' +
        'otherwise the boot value — the persisted snapshot from an earlier PATCH ' +
        'when one is stored and readable, else ENCORE_IDLE_TIMEOUT_MS (#1078).'
    ),
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

// ---------------------------------------------------------------------------
// Multi-connection observation (#1074).
//
// The scaler's loops are spread over one Valkey per provisioned stack. A status
// read therefore has to fan out over those same connections, label what it found
// with the connection it came from, and say plainly which connections it could
// not reach.
// ---------------------------------------------------------------------------

// Label used for the process-global connection when main.ts has not supplied one
// (single-connection deployments and tests). Deliberately not a URL.
const DEFAULT_CONNECTION_ID = 'valkey-default';

const UNREACHABLE_CONNECTION_REASON =
  'this Valkey connection could not be read (scan failed); the pool state is ' +
  'unknown, not empty';
const UNREADABLE_WORKSPACE_REASON =
  'this pool could not be read from its Valkey; the state below is unknown, not empty';

type WorkspaceView = z.infer<typeof workspaceSchema>;
type ConnectionView = z.infer<typeof connectionSchema>;

// One physical Valkey to observe, plus the provisioned stacks bound to it.
type ObservationTarget = {
  connectionId: string;
  redis: Redis;
  stacks: Set<string>;
};

// Collapse the process-global connection and the per-stack connections into one
// target per PHYSICAL store.
//
// Deduplicated on both the connection object and the connectionId: a stack that
// resolves to the process-global Valkey reuses that very connection object
// (resolveStackRedis, workspace-registry.ts), and two stacks sharing a URL share
// both. Without the collapse the same workspace would be reported once per stack
// that happens to share a store.
//
// A stack whose connection could not be resolved at all has no target; it is
// returned separately so it can be reported UNOBSERVED rather than dropped.
function collectTargets(
  globalRedis: Redis | undefined,
  globalConnectionId: string,
  stackConnections: ScalerStackConnection[]
): { targets: ObservationTarget[]; unresolved: ScalerStackConnection[] } {
  const byConnectionId = new Map<string, ObservationTarget>();
  const byRedis = new Map<Redis, ObservationTarget>();
  const unresolved: ScalerStackConnection[] = [];

  const add = (connectionId: string, redis: Redis, stackKey?: string): void => {
    let target = byRedis.get(redis) ?? byConnectionId.get(connectionId);
    if (!target) {
      target = { connectionId, redis, stacks: new Set() };
      byConnectionId.set(connectionId, target);
      byRedis.set(redis, target);
    }
    if (stackKey) target.stacks.add(stackKey);
  };

  // The process-global connection first, so it keeps its own label: it is a
  // connection in its own right even when no stack resolves to it (it is where
  // keys written before per-stack resolution, or by an env-override deployment,
  // live).
  if (globalRedis) add(globalConnectionId, globalRedis);

  for (const connection of stackConnections) {
    if (!connection.redis || !connection.connectionId) {
      unresolved.push(connection);
      continue;
    }
    add(connection.connectionId, connection.redis, connection.stackKey);
  }

  return { targets: [...byConnectionId.values()], unresolved };
}

// Read one workspace's pool state from the connection its loop uses. Every depth
// and every instance in the returned row came from `target.redis`, so the numbers
// and the connectionId reported next to them cannot disagree.
async function observeWorkspace(
  target: ObservationTarget,
  workspaceId: string
): Promise<WorkspaceView> {
  try {
    const [queueDepth, inflightDepth, instances, spawnFailure] = await Promise.all([
      target.redis.llen(keys.queue(workspaceId)),
      target.redis.llen(keys.inflight(workspaceId)),
      listInstances(target.redis, workspaceId),
      // #1071. readSpawnFailure is total (never throws, drops a junk record) so
      // one unreadable key cannot take the whole status response down.
      readSpawnFailure(target.redis, workspaceId)
    ]);
    return {
      workspaceId,
      connectionId: target.connectionId,
      observed: true,
      queueDepth,
      inflightDepth,
      instances: instances.map(toInstanceView),
      spawnFailure
    };
  } catch {
    // Reported, not dropped (#1074): a workspace whose Valkey answered the scan
    // but failed the reads is exactly the one an operator needs to see.
    return {
      workspaceId,
      connectionId: target.connectionId,
      observed: false,
      unobservedReason: UNREADABLE_WORKSPACE_REASON,
      instances: []
    };
  }
}

// Observe one physical Valkey: which workspaces live on it, and their depths AS
// THAT STORE HAS THEM.
async function observeTarget(
  target: ObservationTarget
): Promise<{ workspaces: WorkspaceView[]; connection: ConnectionView }> {
  const stacks = [...target.stacks].sort();
  let scanned: string[];
  try {
    scanned = await scanWorkspaceIds(target.redis);
  } catch {
    // The store is unreachable, so nothing on it is known. Every stack bound to
    // it is still reported — as unobserved — and the connection itself is marked
    // so the gap is visible even when no stack name is bound to it.
    return {
      workspaces: stacks.map((stackKey) => ({
        workspaceId: stackKey,
        connectionId: target.connectionId,
        observed: false,
        unobservedReason: UNREACHABLE_CONNECTION_REASON,
        instances: []
      })),
      connection: {
        connectionId: target.connectionId,
        stacks,
        observed: false,
        unobservedReason: UNREACHABLE_CONNECTION_REASON
      }
    };
  }

  // Union of "has keys on this store" and "is a provisioned stack on this store",
  // so a provisioned pool with no keys at all is reported EMPTY instead of being
  // absent from the response (#1074).
  const workspaceIds = [...new Set([...scanned, ...stacks])].sort();
  const workspaces = await Promise.all(
    workspaceIds.map((workspaceId) => observeWorkspace(target, workspaceId))
  );
  return {
    workspaces,
    connection: { connectionId: target.connectionId, stacks, observed: true }
  };
}

export const scalerRouter: FastifyPluginAsync<ScalerRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Mutable runtime config — the LIVE copy, updated by PATCH /config after the
  // durable write below has landed.
  //
  // #1080 (documentation) over #1077 (persistence). Where the config lives and
  // what wins, as it actually ships:
  //   - storage:    the durable record is one instance-global key in the
  //                 parameter store, `openvideocore/scalerconfig`
  //                 (SCALER_CONFIG_KEY, services/param-store.ts), written as a
  //                 complete {maxInstances,minInstances,idleTimeoutMs} snapshot
  //                 by ScalerConfigStore.save. These three `let`s are the live
  //                 in-process copy of it, and the only thing the scaler loops
  //                 read; they are not a second source of truth.
  //   - precedence: the last PATCH this process accepted wins for this process;
  //                 before any PATCH, the boot values handed in as options
  //                 (main.ts scalerRouterOptions), which are the persisted
  //                 snapshot when one was loadable, else ENCORE_MAX_INSTANCES /
  //                 ENCORE_IDLE_TIMEOUT_MS. So: runtime PATCH, else persisted,
  //                 else environment.
  //   - restart:    the stored record SURVIVES and IS read at boot (#1078,
  //                 services/scaler-boot-config.ts), so a restarted process
  //                 comes back on the persisted values — for this endpoint and
  //                 for the scaler loops main.ts creates from the same resolved
  //                 numbers. It falls back to the environment only when nothing
  //                 is stored or the store was unreadable at boot, which is
  //                 warn-logged with the reason. A PATCH is durable AND
  //                 self-restoring.
  //   - reset:      no reset endpoint and no sentinel value. PATCH the
  //                 environment values back explicitly, which overwrites the
  //                 stored snapshot — and now that boot restores that snapshot,
  //                 that is the ONLY way back to the environment values:
  //                 restarting no longer undoes a PATCH.
  //   - fan-out:    `opts.onConfigChange` carries maxInstances/idleTimeoutMs to
  //                 the live scaler objects (main.ts onConfigChange ->
  //                 workspace-registry setMaxInstances/setIdleTimeoutMs ->
  //                 scaler-loop), which are in-memory config objects.
  //                 minInstances is persisted and echoed, never fanned out.
  // The endpoint descriptions below say all of that on the wire, because an
  // operator who cannot see this file otherwise has no way to know what a 200 OK
  // here does and does not guarantee.
  let liveMaxInstances = opts.maxInstances;
  let liveMinInstances = opts.minInstances ?? 0;
  let liveIdleTimeoutMs = opts.idleTimeoutMs;

  // Per-field provenance (#1079). A field is absent from this map until a PATCH
  // sets it, so "never patched on this process" and "env-sourced" are the same
  // state — which is exactly right: the values above are seeded from the router
  // options, which main.ts resolves from the environment — ENCORE_MAX_INSTANCES
  // and ENCORE_IDLE_TIMEOUT_MS, or their defaults (main.ts scalerRouterOptions).
  //
  // minInstances is the exception, and `sources.minInstances` says so on the
  // wire: main.ts hands this router a hardcoded `minInstances: 0` and never
  // forwards ENCORE_MIN_INSTANCES, which only ever reaches the scaler registry
  // (main.ts, the scaler-loop options). So "env" for minInstances means the
  // built-in 0 — the deployment's own ENCORE_MIN_INSTANCES is a separate value
  // this endpoint does not see and does not report.
  //
  // The map holds the PATCH timestamp because that is a timestamp the process
  // genuinely has. There is no equivalent for an env-sourced value: nothing
  // records when the variable was set, and process start is the time the value
  // was READ, not set. So `updatedAt` is omitted for env values rather than
  // filled in with a boot time that would read as "someone changed this at boot".
  //
  // Lifetime is this process: this map only records PATCHes THIS process served.
  // A value restored at boot is reported as "runtime" through `bootSource` below
  // instead, because the persisted snapshot carries no timestamp to put in
  // `updatedAt` (#1078).
  type ConfigField = 'maxInstances' | 'minInstances' | 'idleTimeoutMs';
  const runtimeSetAt: Partial<Record<ConfigField, string>> = {};

  // #1078 closes the gap the paragraph above describes. When main.ts restored
  // the boot values from the parameter store, every field starts out as an
  // OPERATOR-set value, not an environment value, so it reports
  // `source: "runtime"` from the first request — otherwise a restored PATCH
  // would be indistinguishable on the wire from the env default it overrode.
  // `updatedAt` is omitted in that state on purpose: the persisted snapshot
  // carries only the three numbers (ScalerRuntimeConfig, param-store.ts), so the
  // process genuinely does not know WHEN the original PATCH happened, and
  // `updatedAt` is optional precisely so a known-source/unknown-time value can
  // be reported without inventing a timestamp. A PATCH on this process then
  // fills the timestamp in as usual.
  const bootSource: z.infer<typeof configValueSourceSchema>['source'] =
    opts.configSource === 'persisted' ? 'runtime' : 'env';

  function sourceOf(field: ConfigField): z.infer<typeof configValueSourceSchema> {
    const updatedAt = runtimeSetAt[field];
    if (updatedAt !== undefined) return { source: 'runtime', updatedAt };
    return { source: bootSource };
  }

  const scalerConfigSchema = z.object({
    maxInstances: z
      .number()
      .int()
      .min(SCALER_CONFIG_BOUNDS.maxInstances.min)
      .max(SCALER_CONFIG_BOUNDS.maxInstances.max)
      .describe(
        'Upper bound on transcoder instances in one workspace pool. Applied to ' +
          'every running scaler loop as soon as it is set. Boot default: ' +
          'ENCORE_MAX_INSTANCES (3 when unset).'
      ),
    minInstances: z
      .number()
      .int()
      .min(SCALER_CONFIG_BOUNDS.minInstances.min)
      .max(SCALER_CONFIG_BOUNDS.minInstances.max)
      .describe(
        'Warm floor of instances kept running while a pool is idle. NOTE: unlike ' +
          'the other two fields a PATCH to this one is only recorded — persisted ' +
          'and reported back here — and is NOT fanned out to the already-running ' +
          'scaler loops, which keep enforcing the floor they were created with. ' +
          'The persisted value IS applied at the next boot (#1078), where it takes ' +
          'precedence over ENCORE_MIN_INSTANCES, so a PATCH here takes effect on ' +
          'the running loops only after a restart.'
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

  // Same shape on the way out, plus provenance (#1079), and carrying the
  // durability caveat (#1080) so the response itself states where these values
  // live and what a restart does to them. Kept separate from `scalerConfigSchema`
  // so the PATCH REQUEST body stays exactly what it was — the three settable
  // numbers and nothing else. `sources` is server-owned and read-only, and the
  // body validator strips unknown keys, so a read-modify-write client that
  // echoes a whole GET response back into PATCH still works: the echoed
  // `sources` is dropped rather than rejected or mistaken for an input.
  const scalerConfigResponseSchema = scalerConfigSchema
    .extend({
      sources: z
        .object({
          maxInstances: configValueSourceSchema,
          // Field-specific, because the generic `source` wording needs one
          // qualification for this field: since #1078 "env" here IS the
          // deployment's ENCORE_MIN_INSTANCES (0 when unset), forwarded by
          // main.ts through resolveScalerBootConfig — it is no longer the
          // hardcoded 0 this endpoint used to be seeded with. What stays
          // field-specific is the fan-out: a PATCH to this field is recorded and
          // persisted but not applied to the running loops (see the comment on
          // runtimeSetAt).
          minInstances: configValueSourceSchema.describe(
            'Provenance of `minInstances`, with one caveat specific to this ' +
              'field: `source: "env"` means the warm floor this process booted ' +
              'with from ENCORE_MIN_INSTANCES (0 when unset). `source: ' +
              '"runtime"` means the value was set by PATCH /config — on this ' +
              'process, or on an earlier one and restored from the parameter ' +
              'store at boot (#1078), in which case `updatedAt` is absent ' +
              'because the stored record carries no timestamp. Note that a ' +
              'PATCH on the RUNNING process is only recorded and echoed, not ' +
              'applied to the live scaler loops, whereas a value restored at ' +
              'boot is applied (see the `minInstances` field description). ' +
              'Read-only and server-asserted.'
          ),
          idleTimeoutMs: configValueSourceSchema
        })
        .describe('Where each config value in this response came from (#1079).')
    })
    .describe(
      'The auto-scaler configuration this process is using right now. A value set ' +
        'by PATCH is written durably to the parameter store before it is applied, ' +
        'and is read back at boot (#1078), so a restarted process serves the ' +
        'persisted values and reports them with `source: "runtime"`. The ' +
        'ENCORE_MAX_INSTANCES / ENCORE_IDLE_TIMEOUT_MS environment values apply ' +
        'only to a deployment never configured through this endpoint, or when the ' +
        'parameter store could not be read at boot (logged with the reason).'
    );

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
      // Enumerate the Valkeys the loops use (#1074). A failure here must not
      // blank the response: fall back to the process-global connection, which is
      // then the only one reported — and `connections` says so, so the narrower
      // coverage is visible rather than implied.
      let stackConnections: ScalerStackConnection[] = [];
      if (opts.listStackConnections) {
        try {
          stackConnections = await opts.listStackConnections();
        } catch (err) {
          fastify.log.warn(
            { err },
            'scaler-status: could not enumerate per-stack Valkey connections; ' +
              'reporting the process-global connection only'
          );
        }
      }

      const { targets, unresolved } = collectTargets(
        opts.redis,
        opts.redisConnectionId ?? DEFAULT_CONNECTION_ID,
        stackConnections
      );

      // Stacks whose connection could not be resolved: reported as unobserved
      // workspaces (and as unobserved connections), never omitted.
      const unresolvedWorkspaces: WorkspaceView[] = unresolved.map((connection) => ({
        workspaceId: connection.stackKey,
        observed: false,
        unobservedReason:
          connection.unobservedReason ??
          "this stack's Valkey connection could not be resolved",
        instances: []
      }));
      const unresolvedConnections: ConnectionView[] = unresolved.map((connection) => ({
        stacks: [connection.stackKey],
        observed: false,
        unobservedReason:
          connection.unobservedReason ??
          "this stack's Valkey connection could not be resolved"
      }));

      if (targets.length === 0) {
        // Scaler off (no stack provisioned yet, or the stack's Valkey URL could
        // not be resolved). Report the CONFIGURED maxInstances, not a literal 0
        // (issue #780): a hardcoded 0 read like a misconfigured instance cap and
        // sent operators looking at scaler config instead of at activation.
        // `scalerActive:false` is the field that says the scaler is off. Any
        // stack whose connection failed to resolve is still listed, so "off" and
        // "on but unobservable" stay distinguishable (#1074).
        return {
          workspaces: unresolvedWorkspaces,
          connections: unresolvedConnections,
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

      const observed = await Promise.all(targets.map((target) => observeTarget(target)));

      const workspaces = [
        ...observed.flatMap((result) => result.workspaces),
        ...unresolvedWorkspaces
      ].sort(
        (a, b) =>
          a.workspaceId.localeCompare(b.workspaceId) ||
          (a.connectionId ?? '').localeCompare(b.connectionId ?? '')
      );

      return {
        workspaces,
        connections: [...observed.map((result) => result.connection), ...unresolvedConnections],
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
        summary: 'Update auto-scaler configuration at runtime',
        description:
          'Change the auto-scaler settings of the process serving this request. ' +
          '`maxInstances` and `idleTimeoutMs` take effect on the next scaler tick, ' +
          'with no restart.\n\n' +
          '**Storage.** The values are written to the parameter store first and ' +
          'applied second, as one complete snapshot of all three fields, so a 200 ' +
          'always means "saved AND applied". A deployment with no parameter store ' +
          'configured gets a 501 and nothing is applied; a store that rejects the ' +
          'write or cannot be reached gets a 503 and nothing is applied, so ' +
          '`GET /api/v1/scaler/config` still reports the previous values. The live ' +
          'copy is per process and is not pushed to other replicas.\n\n' +
          '**Precedence.** Three layers, in order: the most recent PATCH accepted ' +
          'by this process, else the persisted snapshot this process read from the ' +
          'parameter store at boot (#1078), else the environment values read at ' +
          'boot — `ENCORE_MAX_INSTANCES` (default 3) and `ENCORE_IDLE_TIMEOUT_MS` ' +
          '(default 300000). So the environment applies to a deployment never ' +
          'configured through this endpoint, or to a boot where the stored record ' +
          'was absent or unreadable.\n\n' +
          '**Restart.** The stored record survives a restart AND is read back at ' +
          'boot (#1078), so a restarted process serves the persisted values — for ' +
          'the config endpoint and for the scaler loops — without the PATCH being ' +
          're-sent. If the parameter store cannot be read at boot the process ' +
          'starts on the environment values instead and logs a warning naming the ' +
          'reason, so a restored value must never be assumed without checking ' +
          '`sources`.\n\n' +
          '**Reset to the environment default.** There is no reset endpoint and no ' +
          'sentinel value. PATCH the environment values back explicitly, which ' +
          'overwrites the stored snapshot — and now that boot restores that ' +
          'snapshot (#1078), that is the only way back to the environment values: ' +
          'restarting no longer undoes a PATCH. `GET /api/v1/scaler/config` shows ' +
          'what is in force, and `sources` says per field whether the value was ' +
          'set through PATCH — on this process, or on an earlier one and restored ' +
          'at boot — or came from the environment (#1079). Note that PATCHing an ' +
          'environment value back still reports `source: "runtime"`, because ' +
          '`sources` reports who set the value, not whether the number changed; a ' +
          'field reports `source: "env"` again only on a process that booted with ' +
          'no usable stored record.\n\n' +
          '**Caveats.** `minInstances` is recorded, persisted and echoed back but ' +
          'is not applied to the running scaler loops (see the field description). ' +
          'A PATCH sent while `GET /api/v1/scaler/status` reports ' +
          '`scalerActive: false` is accepted and reported back, but is not carried ' +
          'into the scaler that later activates against a newly provisioned stack ' +
          '— that activation uses the values this process resolved at boot (the ' +
          'persisted snapshot when one was loaded, else the environment values), ' +
          'so re-send the PATCH afterwards.',
        body: scalerConfigSchema.partial(),
        response: { 200: scalerConfigResponseSchema, 501: errorSchema, 503: errorSchema }
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

      // One timestamp for the whole request: every field this PATCH set was set at
      // the same moment, and reporting them as microseconds apart would be fiction.
      // Recorded only here, after the durable write has landed (#1077): a 501 or a
      // 503 changes nothing, so it changes no provenance either.
      const setAt = new Date().toISOString();
      if (maxInstances !== undefined) runtimeSetAt.maxInstances = setAt;
      if (minInstances !== undefined) runtimeSetAt.minInstances = setAt;
      if (idleTimeoutMs !== undefined) runtimeSetAt.idleTimeoutMs = setAt;

      liveMaxInstances = next.maxInstances;
      liveMinInstances = next.minInstances;
      liveIdleTimeoutMs = next.idleTimeoutMs;
      opts.onConfigChange?.(next);
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
        summary: 'Get the auto-scaler configuration in force',
        description:
          'Report the auto-scaler settings this process is using. These are the ' +
          'live values: the most recent `PATCH /api/v1/scaler/config` if one has ' +
          'been accepted since startup, otherwise the boot values — the persisted ' +
          'snapshot of an earlier PATCH when the parameter store holds a readable ' +
          'one (#1078), else `ENCORE_MAX_INSTANCES` and `ENCORE_IDLE_TIMEOUT_MS`. ' +
          'This endpoint reads the live copy only — it never reads the store, so it ' +
          'cannot be used to check what is persisted. `sources` says, per field, ' +
          'whether the value is the deployment\'s environment value or was set ' +
          'through PATCH on this process (#1079). `minInstances` is reported from this endpoint\'s own ' +
          'record and is not the floor the scaler loops enforce (see the field ' +
          'description).',
        response: { 200: scalerConfigResponseSchema }
      }
    },
    async () => configResponse()
  );
};
