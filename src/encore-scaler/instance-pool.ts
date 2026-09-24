// Encore instance pool management.
//
// The pool is the set of Encore OSC instances the scaler currently owns. Its
// authoritative state lives in the Valkey hash encore:pool:{workspaceId}
// (field = instanceId, value = JSON EncoreInstanceRecord) so state survives an
// API restart and can be observed/repaired out of band.
//
// Contract sources (verified against @osaas/client-core lib/core.d.ts):
//   createInstance(context, serviceId, token, body): Promise<any>
//   removeInstance(context, serviceId, name, token): Promise<void>
//   waitForInstanceReady(serviceId, name, ctx): Promise<void>
// The Encore serviceId is 'encore' (src/services/stack.ts:25). The returned
// instance object carries `name` (instance id) and `url` — same fields the
// provision route reads via instanceUrl() (src/routes/provision.ts:129).

import type { Redis } from 'ioredis';
import {
  createInstance,
  listInstances as oscListInstances,
  removeInstance,
  waitForInstanceReady
} from '@osaas/client-core';
import { keys, type EncoreInstanceRecord, type EncoreScalerConfig } from './types.js';

// Encore's OSC service identifier. Not hardcoded at the call sites — sourced
// from the provisioning contract (STACK_SERVICES / provision route) via this
// single constant so a future rename is a one-line change.
export const ENCORE_SERVICE_ID = 'encore';

// The callback listener paired with each scaler-managed Encore instance. It is
// configured with the exact Encore instance URL at spawn time so its queue
// messages never embed a wrong (static) Encore URL.
export const ENCORE_CALLBACK_LISTENER_SERVICE_ID =
  'eyevinn-encore-callback-listener';

type OscInstance = { name?: string; url?: string } & Record<string, unknown>;

function instanceUrl(instance: OscInstance): string {
  if (typeof instance.url === 'string' && instance.url.length > 0) {
    return instance.url;
  }
  throw new Error('encore instance did not return a usable url');
}

function instanceName(instance: OscInstance): string {
  if (typeof instance.name === 'string' && instance.name.length > 0) {
    return instance.name;
  }
  throw new Error('encore instance did not return a usable name');
}

// Read every instance record from the pool hash.
export async function listInstances(
  redis: Redis,
  workspaceId: string
): Promise<EncoreInstanceRecord[]> {
  const raw = await redis.hgetall(keys.pool(workspaceId));
  const records: EncoreInstanceRecord[] = [];
  for (const value of Object.values(raw)) {
    try {
      records.push(JSON.parse(value) as EncoreInstanceRecord);
    } catch {
      // Skip corrupt entries rather than crash the scaling loop.
    }
  }
  return records;
}

// Write (upsert) an instance record back to the pool hash.
export async function updateInstance(
  redis: Redis,
  workspaceId: string,
  record: EncoreInstanceRecord
): Promise<void> {
  await redis.hset(keys.pool(workspaceId), record.instanceId, JSON.stringify(record));
}

// The stable name prefix every instance this scaler spawns for `workspaceId`
// carries: spawnInstance names instances
// `scaler{sanitisedWorkspaceId}{Date.now().toString(36)}`, so the prefix is the
// part that identifies ownership. Single source of truth for the three callers
// that need it (spawn, reconcile-from-OSC, orphan reap) so they can never drift.
export function scalerInstancePrefix(workspaceId: string): string {
  return `scaler${workspaceId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
}

// Reconcile the Valkey pool for workspaceId against the actual OSC instance
// list. Intended for startup after a Valkey wipe or unclean shutdown: discovers
// any scaler-owned Encore instances that are still running on OSC but absent
// from the pool hash, and re-adds them so the loop can dispatch jobs to them
// instead of spawning duplicates.
//
// Contracts verified (CLAUDE.md rule 7):
//   - oscListInstances(context, serviceId, token): Promise<any[]>
//     (@osaas/client-core lib/core.d.ts:65, lib/core.js:160-171)
//     Returns the raw JSON array from the OSC instances endpoint. Each element
//     carries at minimum `name: string` and `url: string` (same fields read by
//     instanceName()/instanceUrl() at spawnInstance time).
//   - Instance naming: `scaler${workspaceId.replace(/[^a-z0-9]/gi,'').toLowerCase()}${Date.now().toString(36)}`
//     (instance-pool.ts:88). The prefix `scaler{sanitisedWorkspaceId}` is the
//     stable part; only instances with that prefix belong to this scaler/workspace.
//   - updateInstance: writes to encore:pool:{workspaceId} hash (this file:68).
//   - listInstances (Valkey): reads encore:pool:{workspaceId} hash (this file:52).
export async function reconcilePoolFromOsc(
  config: EncoreScalerConfig
): Promise<number> {
  const sat = await config.oscContext.getServiceAccessToken(ENCORE_SERVICE_ID);
  let allOscInstances: OscInstance[];
  try {
    allOscInstances = (await oscListInstances(config.oscContext, ENCORE_SERVICE_ID, sat)) as OscInstance[];
    if (!Array.isArray(allOscInstances)) return 0;
  } catch {
    // OSC unavailable — skip reconciliation; the pool stays as-is.
    return 0;
  }

  // Instances spawned by this scaler for this workspace are named with this
  // stable prefix. Using the same sanitisation as spawnInstance.
  const prefix = scalerInstancePrefix(config.workspaceId);
  const ours = allOscInstances.filter(
    (inst) => typeof inst.name === 'string' && inst.name.startsWith(prefix)
  );
  if (ours.length === 0) return 0;

  // Read existing pool so we don't overwrite live records (e.g. activeJobs > 0).
  const existing = await listInstances(config.redis, config.workspaceId);
  const existingIds = new Set(existing.map((r) => r.instanceId));

  const now = Date.now();
  let added = 0;
  for (const inst of ours) {
    let id: string;
    let url: string;
    try {
      id = instanceName(inst);
      url = instanceUrl(inst);
    } catch {
      continue; // skip malformed OSC entries
    }
    if (existingIds.has(id)) continue; // already tracked
    await updateInstance(config.redis, config.workspaceId, {
      instanceId: id,
      url,
      // callbackListenerUrl: not stored on OSC — will be unknown until next
      // spawnInstance. Dispatch still works: Encore posts to the callback
      // listener directly using the URL it was configured with at creation time.
      activeJobs: 0,
      lastIdleAt: now,
      // #778: a re-discovered instance has no completion history we can see, so
      // its idle clock starts now — it is idle from the moment it (re)enters the
      // pool ready to take work, and idleTimeoutMs applies to it normally.
      readyAt: now
    });
    added += 1;
  }
  return added;
}

// Spawn a fresh Encore OSC instance and register it in the pool. The instance
// name is unique per spawn so concurrent scale-ups never collide.
// Retries up to 3 times on transient 5xx OSC infrastructure errors (e.g.
// ingress-nginx admission webhook timeouts that appear under cluster load).
export async function spawnInstance(
  config: EncoreScalerConfig,
  maxAttempts = 3
): Promise<EncoreInstanceRecord> {
  const sat = await config.oscContext.getServiceAccessToken(ENCORE_SERVICE_ID);
  // Lowercase-alphanumeric, matching OSC's instance-name rules
  // (isValidInstanceName) and the provision route's own naming constraints.
  const name = `${scalerInstancePrefix(config.workspaceId)}${Date.now().toString(36)}`;

  let lastErr: unknown;
  let instance: OscInstance | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const instanceBody: Record<string, string> = { name };
      if (config.s3Config) {
        instanceBody['s3Endpoint'] = config.s3Config.endpoint;
        instanceBody['s3AccessKeyId'] = config.s3Config.accessKeyId;
        instanceBody['s3SecretAccessKey'] = config.s3Config.secretAccessKey;
        instanceBody['s3Region'] = config.s3Config.region ?? 'us-east-1';
      }
      // Point the instance at our own public profile index so it loads the
      // operator-managed profiles from CouchDB (issue #84). `profilesUrl` is the
      // Encore service's own config key for the YAML profile index URL.
      if (config.profilesUrl) {
        instanceBody['profilesUrl'] = config.profilesUrl;
      }
      instance = (await createInstance(
        config.oscContext,
        ENCORE_SERVICE_ID,
        sat,
        instanceBody
      )) as OscInstance;
      break;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // Only retry on transient 5xx / network errors, not on 4xx (bad request).
      const isTransient =
        msg.includes('500') || msg.includes('502') || msg.includes('503') ||
        msg.includes('ORCHESTRATOR_UNAVAILABLE') || msg.includes('ORCHESTRATOR_AUTH_TRANSIENT') ||
        msg.includes('ECONNRESET') || msg.includes('context deadline exceeded');
      if (!isTransient || attempt === maxAttempts) throw err;
      // Exponential back-off: 5s, 10s.
      await new Promise((r) => setTimeout(r, attempt * 5_000));
    }
  }
  if (!instance) throw lastErr;

  const instanceId = instanceName(instance);
  await waitForInstanceReady(ENCORE_SERVICE_ID, instanceId, config.oscContext);
  const encoreUrl = instanceUrl(instance);

  // Everything after this point runs with the Encore instance already live on
  // OSC. If any step fails (callback listener creation, waitForInstanceReady,
  // or pool write) we must destroy the Encore instance before re-throwing so
  // it doesn't become an untracked orphan that causes the next tick to spawn
  // a duplicate.
  try {
    // Pair this Encore instance with a dedicated callback listener (same name)
    // configured with this exact Encore URL, so completion callbacks are routed
    // to the scaler-managed instance rather than a static one. RedisQueue is set
    // explicitly to a dedicated queue (`ovc:transcode-done`) that no external
    // eyevinn-encore-packager consumes, so an external packager can't win the
    // BZPOPMIN race against our poller and swallow our completion messages
    // (issue #93). This MUST match DEFAULT_QUEUE_KEY in
    // src/pipeline/encore-callback-poller.ts.
    const callbackSat = await config.oscContext.getServiceAccessToken(
      ENCORE_CALLBACK_LISTENER_SERVICE_ID
    );
    // Retry callback listener creation with the same transient-error logic as
    // the Encore instance above. The OSC ingress webhook sometimes returns
    // ORCHESTRATOR_UNAVAILABLE under load; a short back-off is enough.
    let callback: OscInstance | undefined;
    let lastCallbackErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        callback = (await createInstance(
          config.oscContext,
          ENCORE_CALLBACK_LISTENER_SERVICE_ID,
          callbackSat,
          {
            name: instanceId,
            RedisUrl: config.redisUrl,
            EncoreUrl: encoreUrl.replace(/\/+$/, ''),
            RedisQueue: 'ovc:transcode-done'
          }
        )) as OscInstance;
        break;
      } catch (err) {
        lastCallbackErr = err;
        const msg = err instanceof Error ? err.message : String(err);
        const isTransient =
          msg.includes('500') || msg.includes('502') || msg.includes('503') ||
          msg.includes('ORCHESTRATOR_UNAVAILABLE') || msg.includes('ORCHESTRATOR_AUTH_TRANSIENT') ||
          msg.includes('ECONNRESET') || msg.includes('context deadline exceeded');
        if (!isTransient || attempt === maxAttempts) throw err;
        await new Promise((r) => setTimeout(r, attempt * 5_000));
      }
    }
    if (!callback) throw lastCallbackErr;
    await waitForInstanceReady(
      ENCORE_CALLBACK_LISTENER_SERVICE_ID,
      instanceId,
      config.oscContext
    );

    const readyAt = Date.now();
    const record: EncoreInstanceRecord = {
      instanceId,
      url: encoreUrl,
      callbackListenerUrl: instanceUrl(callback),
      activeJobs: 0,
      lastIdleAt: readyAt,
      // #778: the instance is idle from right now. `lastIdleAt` only advances on
      // job COMPLETION, so an instance that never gets dispatched a job would
      // otherwise have nothing but this initial value behind its idle clock;
      // recording readiness separately keeps the clock computable even if a
      // later write drops or corrupts lastIdleAt.
      readyAt
    };
    await updateInstance(config.redis, config.workspaceId, record);
    return record;
  } catch (err) {
    // Clean up the already-created Encore instance so it doesn't become an
    // untracked orphan. Best-effort: swallow cleanup errors so the original
    // error is what propagates to the caller.
    try {
      await removeInstance(config.oscContext, ENCORE_SERVICE_ID, instanceId, sat);
    } catch {
      // Ignore — we're already in an error path.
    }
    throw err;
  }
}

// Tear down an Encore OSC instance and drop it from the pool hash. Idempotent:
// a removeInstance for an already-gone instance is tolerated.
export async function destroyInstance(
  instanceId: string,
  config: EncoreScalerConfig
): Promise<void> {
  const sat = await config.oscContext.getServiceAccessToken(ENCORE_SERVICE_ID);
  try {
    await removeInstance(config.oscContext, ENCORE_SERVICE_ID, instanceId, sat);
  } catch (err) {
    // 404 = instance already gone on OSC — treat as success so the pool record
    // is still cleaned up below. Any other error means the instance may still
    // be running: keep the pool record so the next tick retries rather than
    // spawning a replacement for something that's still alive.
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('404') && !msg.includes('not found')) throw err;
  }
  // Best-effort teardown of the paired callback listener (same name). It may
  // already be gone, so any error is swallowed.
  try {
    const callbackSat = await config.oscContext.getServiceAccessToken(
      ENCORE_CALLBACK_LISTENER_SERVICE_ID
    );
    await removeInstance(
      config.oscContext,
      ENCORE_CALLBACK_LISTENER_SERVICE_ID,
      instanceId,
      callbackSat
    );
  } catch {
    // Listener already removed or unreachable — nothing to do.
  }
  // Only drop the pool record after OSC removal succeeds (or confirmed gone).
  // Dropping it on a transient failure would cause the pool to lose track of a
  // still-running instance, making the next tick spawn a replacement — which is
  // exactly the runaway-spawning bug this fixes.
  await config.redis.hdel(keys.pool(config.workspaceId), instanceId);
}

// Default grace window for the orphan reaper (#778): how long an instance must
// be continuously observed running on OSC with NO pool record before it is
// destroyed. Must comfortably exceed a worst-case spawn, which holds exactly
// that state (live OSC instance, pool record not yet written) while it waits on
// waitForInstanceReady for both the Encore instance and its paired callback
// listener, plus up to two 5s/10s transient retries on each.
export const DEFAULT_ORPHAN_GRACE_MS = 10 * 60_000;

// Collect every instanceId tracked in ANY pool hash on this Valkey, not just
// this workspace's. Several stacks can share one Valkey, and a workspaceId that
// sanitises to the same instance-name prefix as another would otherwise let one
// workspace's sweep classify another's live instance as an orphan. Uses SCAN
// (cursor paging) rather than KEYS so a large keyspace never blocks Valkey —
// same approach as routes/scaler.ts scanWorkspaceIds.
async function trackedInstanceIdsAcrossPools(redis: Redis): Promise<Set<string>> {
  const poolPrefix = keys.pool('');
  const tracked = new Set<string>();
  let cursor = '0';
  do {
    const [next, batch] = await redis.scan(cursor, 'MATCH', `${poolPrefix}*`, 'COUNT', 100);
    cursor = next;
    for (const key of batch) {
      const fields = await redis.hkeys(key);
      for (const field of fields) tracked.add(field);
    }
  } while (cursor !== '0');
  return tracked;
}

// Destroy scaler-owned Encore instances that are running on OSC but have NO
// pool record at all (#778).
//
// Why this is needed: every other teardown path iterates the pool hash
// (scaler-loop.ts scale-down, workspace-registry.ts teardown), so an instance
// that never made it into the hash — a spawn that died between createInstance
// and the pool write, a wiped/unreachable Valkey, a deleted deployment — has
// nothing that can ever remove it, and it bills until someone notices it by
// eye. reconcilePoolFromOsc() re-adopts such instances, but only at startup and
// only when the workspace has no pool key at all.
//
// Safety: an instance is only destroyed once it has been observed orphaned for
// `orphanGraceMs` continuously (first sighting is recorded in
// keys.orphanSeen(workspaceId) and merely returns), so an in-progress spawn —
// which legitimately holds a live OSC instance with no pool record — is never
// reaped underneath itself. An instance that is tracked in any pool hash is
// never a candidate here at all, so instances with in-flight work, a pending
// packaging handoff, or a draining flag are untouched by this path: they are
// handled by the drain logic in scaler-loop.ts.
//
// Contracts verified (CLAUDE.md rule 7):
//   - oscListInstances(context, serviceId, token): Promise<any>
//     (@osaas/client-core lib/core.d.ts:65) — raw JSON array; each element
//     carries `name` (instance id). No creation timestamp is exposed, which is
//     why first-sighting is tracked in Valkey rather than read from OSC.
//   - removeInstance(context, serviceId, name, token): Promise<void>
//     (@osaas/client-core lib/core.d.ts:46), via destroyInstance() above.
//   - keys.pool / keys.orphanSeen (types.ts).
//
// Returns the ids actually destroyed. Never throws: OSC or Valkey trouble makes
// this a no-op for the tick, and the next sweep retries.
export async function reapOrphanedInstances(
  config: EncoreScalerConfig
): Promise<string[]> {
  const graceMs = config.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const seenKey = keys.orphanSeen(config.workspaceId);

  let allOscInstances: OscInstance[];
  try {
    const sat = await config.oscContext.getServiceAccessToken(ENCORE_SERVICE_ID);
    allOscInstances = (await oscListInstances(
      config.oscContext,
      ENCORE_SERVICE_ID,
      sat
    )) as OscInstance[];
    if (!Array.isArray(allOscInstances)) return [];
  } catch {
    // OSC unavailable — skip this sweep entirely rather than act on a partial
    // view of reality.
    return [];
  }

  const prefix = scalerInstancePrefix(config.workspaceId);
  const oursOnOsc = allOscInstances
    .map((inst) => (typeof inst.name === 'string' ? inst.name : undefined))
    .filter((name): name is string => !!name && name.startsWith(prefix));

  let tracked: Set<string>;
  let seen: Record<string, string>;
  try {
    [tracked, seen] = await Promise.all([
      trackedInstanceIdsAcrossPools(config.redis),
      config.redis.hgetall(seenKey)
    ]);
  } catch {
    return []; // Valkey unavailable — never destroy on an unverifiable pool view.
  }

  const orphanIds = new Set(oursOnOsc.filter((id) => !tracked.has(id)));

  // Drop sightings for instances that are no longer orphaned (adopted into a
  // pool, or gone from OSC) so a later orphaning restarts the grace window.
  const staleSightings = Object.keys(seen).filter((id) => !orphanIds.has(id));
  if (staleSightings.length > 0) {
    await config.redis.hdel(seenKey, ...staleSightings).catch(() => undefined);
  }

  const now = Date.now();
  const reaped: string[] = [];
  for (const instanceId of orphanIds) {
    const firstSeen = Number(seen[instanceId]);
    if (!Number.isFinite(firstSeen)) {
      // First sighting (or an unreadable one): start the grace window now and
      // leave the instance alone this sweep.
      await config.redis.hset(seenKey, instanceId, String(now)).catch(() => undefined);
      continue;
    }
    if (now - firstSeen <= graceMs) continue; // still inside the grace window

    try {
      await destroyInstance(instanceId, config);
      await config.redis.hdel(seenKey, instanceId).catch(() => undefined);
      reaped.push(instanceId);
      console.warn(
        '[encore-scaler] reaped orphaned Encore instance with no pool record (#778)',
        {
          workspaceId: config.workspaceId,
          instanceId,
          orphanedForMs: now - firstSeen
        }
      );
    } catch (err) {
      // Keep the sighting so the next sweep retries this instance.
      console.error(
        '[encore-scaler] failed to reap orphaned instance (workspace=%s instance=%s):',
        config.workspaceId,
        instanceId,
        err
      );
    }
  }
  return reaped;
}
