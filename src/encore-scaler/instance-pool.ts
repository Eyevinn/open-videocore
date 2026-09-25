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
//   getInstanceHealth(context, serviceId, name, token): Promise<string>  (:86)
// The Encore serviceId is 'encore' (src/services/stack.ts:25). The returned
// instance object carries `name` (instance id) and `url` — same fields the
// provision route reads via instanceUrl() (src/routes/provision.ts:129).

import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  createInstance,
  getInstanceHealth,
  listInstances as oscListInstances,
  removeInstance
} from '@osaas/client-core';
import { keys, type EncoreInstanceRecord, type EncoreScalerConfig } from './types.js';
import { fetchEncoreActiveState } from './encore-active-state.js';
import { hasPendingPackaging } from './packaging-pin.js';

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

// ---------------------------------------------------------------------------
// Instance naming and OWNERSHIP.
//
// OSC instance names are restricted to /^[a-z0-9]+$/ — verified against
// isValidInstanceName (@osaas/client-core lib/core.js:49-51), which createInstance
// enforces (lib/core.js:77). There is therefore NO delimiter character available,
// and no OSC instance field the scaler can stamp with its own identity: the name
// is the only place ownership can live.
//
// A plain `scaler{sanitisedWorkspaceId}` prefix is NOT a sound ownership test,
// because `listInstances` is tenant-wide while each stack has its own Valkey
// (workspace-registry.ts resolveStackRedis, #615). Two stacks in one OSC tenant
// whose sanitised names are prefixes of one another (`dev`/`dev-2`,
// `prod`/`production`) each see the other's instances and find no pool record for
// them, so a prefix-only test lets one stack destroy the other's LIVE instances.
//
// So every name carries a fixed-width OWNER TAG derived from the FULL,
// unsanitised workspace/stack id:
//
//   scaler{sanitisedWorkspaceId(<=12)}{ownerTag(8 hex)}{Date.now().toString(36)}
//
// The tag sits at a fixed offset for a given workspace, so a foreign stack can
// only match if its sanitised label AND its tag are identical — i.e. it is the
// same workspace id. Sanitisation collisions (`lu-cas` vs `lucas`) that a
// prefix test cannot separate are separated by the tag, because the tag hashes
// the raw id. The readable label is kept purely so operators can still tell at a
// glance which stack an instance belongs to.
// ---------------------------------------------------------------------------

// Max characters of the human-readable workspace label carried in a name. Keeps
// the total name length bounded (6 + 12 + 8 + 8 = 34) regardless of stack name.
const WORKSPACE_LABEL_MAX = 12;

function sanitiseWorkspaceId(workspaceId: string): string {
  return workspaceId.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

// Fixed-width, lowercase-hex (a subset of OSC's allowed charset) fingerprint of
// the full workspace/stack id. 8 hex chars = 32 bits; this is a disambiguator
// between the handful of stacks in one OSC tenant, not a security boundary.
export function scalerOwnerTag(workspaceId: string): string {
  return createHash('sha256').update(workspaceId).digest('hex').slice(0, 8);
}

// The exact name prefix every instance this scaler spawns for `workspaceId`
// carries, INCLUDING the owner tag. Single source of truth for the callers that
// need it (spawn, reconcile-from-OSC, orphan reap) so they can never drift.
export function scalerInstancePrefix(workspaceId: string): string {
  return `scaler${sanitiseWorkspaceId(workspaceId).slice(0, WORKSPACE_LABEL_MAX)}${scalerOwnerTag(
    workspaceId
  )}`;
}

// The pre-owner-tag prefix (`scaler{sanitisedWorkspaceId}`) used by instances
// spawned before the tag existed. Retained ONLY so such instances can still be
// recognised — never as a basis for destroying anything (see
// classifyInstanceOwnership).
export function legacyScalerInstancePrefix(workspaceId: string): string {
  return `scaler${sanitiseWorkspaceId(workspaceId)}`;
}

export type InstanceOwnership =
  // Name matches the owner-tagged shape for this workspace: ownership is
  // unambiguous, so this instance may be destroyed by the orphan reaper.
  | 'owned'
  // Pre-owner-tag name shape: MAY belong to this workspace, but a stack whose
  // sanitised id is identical to ours would produce the same name, so ownership
  // cannot be proven. Discoverable (adoption) but NEVER destroyable.
  | 'legacy-ambiguous'
  // Not this workspace's instance (another stack's, or hand-provisioned).
  | 'foreign';

// Decide what an OSC instance name means for `workspaceId`.
//
// 'owned' requires the exact shape `{scalerInstancePrefix}{[0-9a-z]{1,12}}` — an
// exact shape, not a bare prefix, so a longer foreign label can never satisfy it
// by accident.
// 'legacy-ambiguous' requires `{legacyScalerInstancePrefix}{[0-9a-z]{8}}`: a
// base36 `Date.now()` is exactly 8 chars (it has been since 2015 and stays so
// until ~2059), so a foreign stack whose sanitised label merely EXTENDS ours
// leaves a 9+-char remainder and is correctly rejected.
export function classifyInstanceOwnership(
  workspaceId: string,
  name: string
): InstanceOwnership {
  const owned = scalerInstancePrefix(workspaceId);
  if (name.startsWith(owned) && /^[0-9a-z]{1,12}$/.test(name.slice(owned.length))) {
    return 'owned';
  }
  const legacy = legacyScalerInstancePrefix(workspaceId);
  if (name.startsWith(legacy) && /^[0-9a-z]{8}$/.test(name.slice(legacy.length))) {
    return 'legacy-ambiguous';
  }
  return 'foreign';
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
//   - Instance naming / ownership: classifyInstanceOwnership() above. Adoption is
//     non-destructive, so it accepts BOTH the owner-tagged shape ('owned') and the
//     pre-tag shape ('legacy-ambiguous') — the latter is how a deployment that
//     predates the owner tag still recovers its instances after a Valkey wipe.
//     Both are EXACT shapes, so a foreign stack whose sanitised label merely
//     extends ours (`dev` vs `dev-2`) is no longer misadopted.
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

  // Instances spawned by this scaler for this workspace carry an exact name
  // shape (owner-tagged, or the pre-tag legacy shape) — see
  // classifyInstanceOwnership.
  const ours = allOscInstances.filter(
    (inst) =>
      typeof inst.name === 'string' &&
      classifyInstanceOwnership(config.workspaceId, inst.name) !== 'foreign'
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

// Bound (ms) on how long a spawn waits for an OSC instance to report `running`.
//
// #778 review finding 4: @osaas/client-core's waitForInstanceReady polls
// getInstanceHealth in a `while (!instanceOk)` loop with NO timeout
// (node_modules/@osaas/client-core/lib/core.js:343-353, v0.24.0), so a spawn that
// never becomes healthy hangs forever while holding a live, billing OSC instance
// with no pool record — the exact state the orphan reaper acts on. Bounding the
// wait gives that state a real worst case that DEFAULT_ORPHAN_GRACE_MS can
// exceed, and routes the failure into spawnInstance's cleanup path (which now
// destroys the Encore instance AND its paired listener) instead of leaking.
// Logged as OSC friction (CLAUDE.md rule 6):
// docs/osc-feedback/incoming-waitforinstanceready-unbounded.md.
export const DEFAULT_SPAWN_READY_TIMEOUT_MS = 5 * 60_000;

// How often (ms) the bounded readiness wait re-checks instance health. Matches
// the 1s cadence @osaas/client-core's own waitForInstanceReady uses
// (lib/core.js:343-353, v0.24.0) so this is no chattier than the helper it
// replaces. The final sleep is clamped to the remaining budget, so a timeout
// shorter than one interval still ends on time.
export const DEFAULT_SPAWN_READY_POLL_INTERVAL_MS = 1_000;

// Wait for an OSC instance to report `running`, with a hard deadline.
//
// This polls getInstanceHealth directly rather than racing a timer against
// @osaas/client-core's waitForInstanceReady (review round 2, non-blocking
// finding on instance-pool.ts:285). Racing left the helper's internal
// `while (!instanceOk)` loop running after we stopped waiting — the SDK offers
// no AbortSignal and no cancellation — so every timed-out spawn leaked one
// getInstanceHealth request per second for the lifetime of the process. Owning
// the loop means the polling stops exactly when the deadline passes.
//
// Contract (verified, @osaas/client-core@0.24.0 lib/core.d.ts:86):
//   getInstanceHealth(context: Context, serviceId: string, name: string,
//                     token: string): Promise<string>
// It resolves the instance's health string; 'running' is the ready state the
// SDK's own helper gates on (lib/core.js:347-349). Transient health-probe
// failures (a 404/503 while the instance is still being scheduled) are treated
// as "not ready yet" and retried until the deadline rather than aborting the
// spawn, with the last error folded into the timeout message.
//
// Both limitations are logged as OSC friction (CLAUDE.md rule 6):
// docs/osc-feedback/incoming-waitforinstanceready-unbounded.md.
async function waitForInstanceReadyBounded(
  serviceId: string,
  instanceId: string,
  config: EncoreScalerConfig
): Promise<void> {
  const timeoutMs = config.spawnReadyTimeoutMs ?? DEFAULT_SPAWN_READY_TIMEOUT_MS;
  const pollIntervalMs =
    config.spawnReadyPollIntervalMs ?? DEFAULT_SPAWN_READY_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  const sat = await config.oscContext.getServiceAccessToken(serviceId);

  let lastError: unknown;
  let lastStatus: string | undefined;
  for (;;) {
    // Sleep first, as the SDK helper does: a just-created instance is never
    // healthy on the same tick it was created.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(pollIntervalMs, remaining));
      timer.unref?.();
    });

    try {
      const status = await getInstanceHealth(
        config.oscContext,
        serviceId,
        instanceId,
        sat
      );
      lastStatus = status;
      if (status === 'running') return;
    } catch (err) {
      lastError = err;
    }
    if (Date.now() >= deadline) break;
  }

  const detail = lastError
    ? `; last health check error: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    : lastStatus
      ? `; last reported health: ${lastStatus}`
      : '';
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for OSC instance ${instanceId} ` +
      `(service ${serviceId}) to report running${detail}`
  );
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
  // Whether the paired callback listener was created, so the cleanup path knows
  // it has a listener to remove as well (#778 review finding 3).
  let listenerCreated = false;
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
  const encoreUrl = instanceUrl(instance);

  // Everything after this point runs with the Encore instance already live on
  // OSC. If any step fails (readiness wait, callback listener creation, or the
  // pool write) we must destroy BOTH the Encore instance and any paired callback
  // listener before re-throwing, so neither becomes an untracked orphan that
  // bills forever and makes the next tick spawn a duplicate.
  //
  // The readiness wait is INSIDE this block (#778 review finding 4): it used to
  // sit outside, so an instance that never became `running` was left live on OSC
  // with no pool record and no cleanup.
  try {
    await waitForInstanceReadyBounded(ENCORE_SERVICE_ID, instanceId, config);
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
    listenerCreated = true;
    await waitForInstanceReadyBounded(
      ENCORE_CALLBACK_LISTENER_SERVICE_ID,
      instanceId,
      config
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
    // #778 review finding 3: the paired callback listener leaks in exactly the
    // same way. If it was created before the failure (listener readiness wait or
    // the pool write threw), the same-named listener keeps running and billing,
    // and nothing else would ever remove it. Removed unconditionally when we know
    // it was created; a 404 is harmless either way.
    if (listenerCreated) {
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
        // Ignore — we're already in an error path.
      }
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
// destroyed. It must comfortably exceed a worst-case spawn, which holds exactly
// that state (live OSC instance, pool record not yet written).
//
// That worst case is now BOUNDED (#778 review finding 4): two readiness waits of
// at most DEFAULT_SPAWN_READY_TIMEOUT_MS (Encore instance + paired callback
// listener) plus up to two 5s/10s transient createInstance retries on each, i.e.
// ~10.5 minutes with the defaults. 20 minutes leaves real headroom on top of
// that, and the reaper additionally needs TWO sweeps (first sighting only starts
// the clock) before it acts.
export const DEFAULT_ORPHAN_GRACE_MS = 20 * 60_000;

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

// Destroy Encore instances (and paired callback listeners) that are running on
// OSC, provably belong to THIS workspace, have NO pool record at all, and have
// NO in-flight work (#778).
//
// Why this is needed: every other teardown path iterates the pool hash
// (scaler-loop.ts scale-down, workspace-registry.ts teardown), so an instance
// that never made it into the hash — a spawn that died between createInstance
// and the pool write, a wiped/unreachable Valkey, a deleted deployment — has
// nothing that can ever remove it, and it bills until someone notices it by
// eye. reconcilePoolFromOsc() re-adopts such instances, but only at startup.
//
// Four independent conditions must ALL hold before anything is destroyed:
//
//  1. OWNERSHIP IS PROVEN, not inferred. Only the owner-tagged exact name shape
//     ('owned', classifyInstanceOwnership) qualifies. `listInstances` is
//     tenant-wide while each stack reads its OWN Valkey
//     (workspace-registry.ts resolveStackRedis, #615), so a prefix-inferred owner
//     test would let stack `dev` destroy stack `dev-2`'s LIVE instances. A
//     pre-owner-tag ('legacy-ambiguous') name is reported and left alone — never
//     destroyed on a name whose owner cannot be proven.
//  2. NOT TRACKED in any pool hash on this Valkey (belt and braces on top of 1).
//  3. ORPHANED FOR THE WHOLE GRACE WINDOW: the first sighting is recorded in
//     keys.orphanSeen(workspaceId) and merely returns, so an in-progress spawn —
//     which legitimately holds a live OSC instance with no pool record — is never
//     reaped underneath itself. The spawn wait is bounded
//     (DEFAULT_SPAWN_READY_TIMEOUT_MS), so that window has a real worst case.
//  4. NO IN-FLIGHT WORK, confirmed POSITIVELY against the instance itself —
//     the same authoritative query scale-down uses (#513/#525 pt.2). An orphan is
//     by definition not pool-tracked, so the pool-side drain protections cannot
//     speak for it: in the wiped-Valkey case the reaper exists for, the orphan may
//     well be mid-transcode. An instance reporting work (or a pending packaging
//     handoff) is ADOPTED into the pool instead, so the existing drain logic owns
//     it, and an instance whose state cannot be confirmed is SKIPPED.
//
// Callback listeners are swept too (#778 review finding 3): a spawn that failed
// after the listener was created leaks a listener with no Encore instance, which
// is the same billing leak one service over. Listeners share their Encore
// instance's id, so conditions 1-3 apply to them unchanged; a listener whose
// Encore instance is gone cannot have work, so condition 4 is vacuous for it.
//
// Contracts verified (CLAUDE.md rule 7):
//   - oscListInstances(context, serviceId, token): Promise<any>
//     (@osaas/client-core lib/core.d.ts:65) — raw JSON array; each element
//     carries `name` (instance id) and `url`. No creation timestamp is exposed,
//     which is why first-sighting is tracked in Valkey rather than read from OSC.
//   - removeInstance(context, serviceId, name, token): Promise<void>
//     (@osaas/client-core lib/core.d.ts:46), via destroyInstance() above.
//   - isValidInstanceName = /^[a-z0-9]+$/ (lib/core.js:49-51) — the reason the
//     owner tag is hex and there is no delimiter in the name shape.
//   - Encore active-state query: fetchEncoreActiveState (encore-active-state.ts),
//     the exact query scaler-loop.ts's fetchRealActiveState runs.
//   - hasPendingPackaging(redis, instanceId) (packaging-pin.ts) — #525 pt.2.
//   - keys.pool / keys.orphanSeen (types.ts).
//
// Returns the ids actually destroyed. Never throws: OSC or Valkey trouble makes
// this a no-op for the tick, and the next sweep retries.
export async function reapOrphanedInstances(
  config: EncoreScalerConfig
): Promise<string[]> {
  const graceMs = config.orphanGraceMs ?? DEFAULT_ORPHAN_GRACE_MS;
  const seenKey = keys.orphanSeen(config.workspaceId);

  // List the Encore service. A failure here skips the whole sweep rather than
  // acting on a partial view of reality.
  let encoreOnOsc: OscInstance[];
  try {
    const sat = await config.oscContext.getServiceAccessToken(ENCORE_SERVICE_ID);
    encoreOnOsc = (await oscListInstances(
      config.oscContext,
      ENCORE_SERVICE_ID,
      sat
    )) as OscInstance[];
    if (!Array.isArray(encoreOnOsc)) return [];
  } catch {
    return [];
  }

  // List the paired callback-listener service. Additive: if only this list fails
  // we still sweep Encore instances.
  let listenersOnOsc: OscInstance[] = [];
  try {
    const callbackSat = await config.oscContext.getServiceAccessToken(
      ENCORE_CALLBACK_LISTENER_SERVICE_ID
    );
    const listed = (await oscListInstances(
      config.oscContext,
      ENCORE_CALLBACK_LISTENER_SERVICE_ID,
      callbackSat
    )) as OscInstance[];
    if (Array.isArray(listed)) listenersOnOsc = listed;
  } catch {
    // Listener list unavailable this sweep — Encore sweep continues.
  }

  // Candidate set: every id we can PROVE belongs to this workspace, on either
  // service, with the Encore URL when there is one (needed for the work check).
  type Candidate = { encoreUrl?: string; hasEncore: boolean; hasListener: boolean };
  const candidates = new Map<string, Candidate>();
  const legacyUnreapable: string[] = [];

  const consider = (inst: OscInstance, service: 'encore' | 'listener'): void => {
    const name = typeof inst.name === 'string' ? inst.name : undefined;
    if (!name) return;
    const ownership = classifyInstanceOwnership(config.workspaceId, name);
    if (ownership === 'foreign') return;
    if (ownership === 'legacy-ambiguous') {
      if (service === 'encore') legacyUnreapable.push(name);
      return;
    }
    const existing = candidates.get(name) ?? { hasEncore: false, hasListener: false };
    if (service === 'encore') {
      existing.hasEncore = true;
      if (typeof inst.url === 'string' && inst.url.length > 0) existing.encoreUrl = inst.url;
    } else {
      existing.hasListener = true;
    }
    candidates.set(name, existing);
  };

  for (const inst of encoreOnOsc) consider(inst, 'encore');
  for (const inst of listenersOnOsc) consider(inst, 'listener');

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

  const orphanIds = new Set([...candidates.keys()].filter((id) => !tracked.has(id)));

  // A pre-owner-tag instance with no pool record cannot be attributed to a single
  // stack, so it is never destroyed here. Surface it by name so an operator can
  // decide — silence is what let #778 bill for 20 hours.
  const untrackedLegacy = legacyUnreapable.filter((id) => !tracked.has(id));
  if (untrackedLegacy.length > 0) {
    console.warn(
      '[encore-scaler] orphan sweep: %d Encore instance(s) match this workspace ' +
        'only by the pre-owner-tag name shape and have no pool record, so their ' +
        'owner cannot be proven — NOT reaped, manual cleanup may be needed ' +
        '(workspace=%s instances=%s) (#778)',
      untrackedLegacy.length,
      config.workspaceId,
      untrackedLegacy.join(',')
    );
  }

  // Drop sightings for instances that are no longer orphaned (adopted into a
  // pool, or gone from OSC) so a later orphaning restarts the grace window.
  const staleSightings = Object.keys(seen).filter((id) => !orphanIds.has(id));
  if (staleSightings.length > 0) {
    await config.redis.hdel(seenKey, ...staleSightings).catch(() => undefined);
  }

  const now = Date.now();
  const reaped: string[] = [];
  for (const instanceId of orphanIds) {
    const candidate = candidates.get(instanceId);
    if (!candidate) continue;

    const firstSeen = Number(seen[instanceId]);
    if (!Number.isFinite(firstSeen)) {
      // First sighting (or an unreadable one): start the grace window now and
      // leave the instance alone this sweep.
      await config.redis.hset(seenKey, instanceId, String(now)).catch(() => undefined);
      continue;
    }
    if (now - firstSeen <= graceMs) continue; // still inside the grace window

    // Condition 4 — positive "no work" confirmation, for any orphan that still
    // has a live Encore instance. A listener-only orphan (its Encore instance is
    // already gone) cannot be running a transcode, so it skips straight to
    // teardown.
    if (candidate.hasEncore) {
      if (!candidate.encoreUrl) {
        // No URL to ask: we cannot confirm the instance is idle, so we do not
        // touch it. Reported so the stuck state is diagnosable.
        console.warn(
          '[encore-scaler] orphan sweep: instance %s (workspace=%s) has no usable ' +
            'URL on OSC, so its in-flight work cannot be confirmed — NOT reaped (#778)',
          instanceId,
          config.workspaceId
        );
        continue;
      }

      let active: Awaited<ReturnType<typeof fetchEncoreActiveState>>;
      try {
        const token = await config.getToken();
        active = await fetchEncoreActiveState(candidate.encoreUrl, token);
      } catch {
        active = undefined;
      }

      if (active === undefined) {
        // Unreachable / unparseable — could be mid-transcode, or not yet
        // `running` after a slow spawn. Never destroy on an unconfirmed count;
        // the next sweep retries (the sighting is deliberately kept).
        console.warn(
          '[encore-scaler] orphan sweep: could not confirm real in-flight state for ' +
            'orphaned instance %s (workspace=%s) — NOT reaped this sweep (#778)',
          instanceId,
          config.workspaceId
        );
        continue;
      }

      let pendingPackaging = false;
      try {
        pendingPackaging = await hasPendingPackaging(config.redis, instanceId);
      } catch {
        // Unknown pin state is treated as "pinned": never destroy on an
        // unverifiable answer.
        pendingPackaging = true;
      }

      if (active.count > 0 || pendingPackaging) {
        // The orphan has genuine in-flight work (or a packaging handoff pinned
        // against it). Do NOT destroy it: ADOPT it into the pool so the existing
        // drain-don't-kill logic (#513) and the packaging pin (#525 pt.2) own its
        // teardown, exactly as they do for every other instance.
        try {
          await updateInstance(config.redis, config.workspaceId, {
            instanceId,
            url: candidate.encoreUrl,
            // Not recoverable from OSC; dispatch's trust gate fails open on an
            // absent listener URL (scaler-loop.ts ensureCallbackTrust), same as
            // reconcilePoolFromOsc's adoptions.
            activeJobs: active.count,
            lastIdleAt: now,
            readyAt: now
          });
          await config.redis.hdel(seenKey, instanceId).catch(() => undefined);
          console.warn(
            '[encore-scaler] orphan sweep: orphaned instance %s (workspace=%s) has ' +
              'real in-flight work (count=%d pendingPackaging=%s) — adopted into the ' +
              'pool to be drained rather than destroyed (#778)',
            instanceId,
            config.workspaceId,
            active.count,
            String(pendingPackaging)
          );
        } catch (err) {
          console.error(
            '[encore-scaler] orphan sweep: failed to adopt busy orphan %s (workspace=%s):',
            instanceId,
            config.workspaceId,
            err
          );
        }
        continue;
      }
    }

    try {
      await destroyInstance(instanceId, config);
      await config.redis.hdel(seenKey, instanceId).catch(() => undefined);
      reaped.push(instanceId);
      console.warn(
        '[encore-scaler] reaped orphaned Encore instance with no pool record and no ' +
          'in-flight work (#778)',
        {
          workspaceId: config.workspaceId,
          instanceId,
          orphanedForMs: now - firstSeen,
          hadEncoreInstance: candidate.hasEncore,
          hadCallbackListener: candidate.hasListener
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
