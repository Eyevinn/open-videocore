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

const scalerStatusSchema = z.object({
  workspaces: z.array(workspaceSchema),
  // Every connection this read covered (#1074), observed or not. Without it,
  // "the response lists two workspaces" could not be distinguished from "the
  // response lists the two workspaces it managed to reach".
  connections: z.array(connectionSchema),
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
          scalerActive: false
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
        scalerActive: true
      };
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
