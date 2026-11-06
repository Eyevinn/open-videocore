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
//   getInstance(context, serviceId, name, token): Promise<any>           (:56)
//     — resolves UNDEFINED on ANY response failure except 401. lib/core.js:140-148
//       rethrows only a FetchError with httpCode 401 (as UnauthorizedError, :142-143)
//       and maps 404 to undefined (:145-146); every other error — a 500, a 504 or a
//       dropped socket — falls out of the catch to `return undefined` (:149). So
//       `undefined` means "could not confirm", NOT "does not exist", and no adopt
//       path below may read it as success OR as proof of absence.
//     — but it CAN still throw, which is why every call below goes through
//       tryGetInstance(): the `getService(context, serviceId)` subscription lookup
//       at lib/core.js:128 is OUTSIDE that try block, so a failing service catalog
//       ("Service X not found in your subscriptions", or any FetchError from
//       /mysubscriptions) propagates, as does UnauthorizedError on a 401.
//   getInstanceHealth(context, serviceId, name, token): Promise<string>  (:86)
// The bounded readiness poll loop (its own getInstanceHealth contract and the
// full rationale) was lifted out of this module in #1038 and now lives in
// src/services/instance-readiness.ts (waitForInstanceReadyBounded), so the
// provisioning route can reuse the same loop; getInstanceHealth stays imported
// here for the pending-spawn / destroy-decision paths that read health directly.
// The Encore serviceId is 'encore' (src/services/stack.ts:25). The returned
// instance object carries `name` (instance id) and `url` — same fields the
// provision route reads via instanceUrl() (src/routes/provision.ts:129).

import { createHash } from 'node:crypto';
import type { Redis } from 'ioredis';
import {
  createInstance,
  getInstance,
  getInstanceHealth,
  listInstances as oscListInstances,
  removeInstance,
  saveSecret
} from '@osaas/client-core';
import {
  encoreCredentialMapping,
  type ExternalStorageCredentials
} from '../services/external-storage-credentials.js';
import {
  DEFAULT_INSTANCE_READY_POLL_INTERVAL_MS,
  waitForInstanceReadyBounded
} from '../services/instance-readiness.js';
import { keys, type EncoreInstanceRecord, type EncoreScalerConfig } from './types.js';
import { fetchEncoreActiveState } from './encore-active-state.js';
import { hasPendingPackaging } from './packaging-pin.js';
import {
  isInstanceAlreadyGoneError,
  isNameAlreadyTakenError,
  isTransientOscError,
  oscHttpCode
} from './osc-error.js';
import {
  clearSpawnFailure,
  isGatewayTimeoutStatus,
  recordSpawnFailure,
  spawnFailureSecrets
} from './spawn-failure.js';
import { UPLOAD_PART_SIZE_OPTION } from './upload-part-size.js';

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

// getInstance as a TOTAL "could you confirm this instance?" probe (#1071 review
// finding 4).
//
// Every adopt path below runs INSIDE a `catch` for a failed createInstance, and
// it is there precisely because OSC is unhealthy. getInstance is not total —
// `getService` sits outside its internal try (lib/core.js:128) and a 401 is
// rethrown as UnauthorizedError (:142-143) — so calling it bare let the PROBE's
// error escape the retry loop: it discarded `lastErr`, skipped the remaining
// attempts and their back-off, and became the error recorded against the spawn,
// so the operator saw "Service encore not found in your subscriptions" instead of
// the create's real failure.
//
// A probe failure is therefore folded back into "could not confirm" (undefined),
// which the callers already handle by backing off and retrying the create. The
// probe error is logged, never propagated.
async function tryGetInstance(
  config: EncoreScalerConfig,
  serviceId: string,
  name: string,
  token: string
): Promise<OscInstance | undefined> {
  try {
    return (await getInstance(config.oscContext, serviceId, name, token)) as
      | OscInstance
      | undefined;
  } catch (err) {
    console.warn(
      '[encore-scaler] spawn: could not probe %s instance %s while adopting ' +
        '(workspace=%s) — treating as unconfirmed and keeping the original create ' +
        'error (#1071):',
      serviceId,
      name,
      config.workspaceId,
      err
    );
    return undefined;
  }
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
// exceed, and routes the failure into spawnInstance's cleanup path instead of
// leaking. (What that cleanup path DOES on a readiness timeout changed in
// #1071: the instance is no longer destroyed, it is recorded as a PENDING pool
// entry — see recordPendingSpawn / resolvePendingSpawns below.)
// Logged as OSC friction (CLAUDE.md rule 6):
// docs/osc-feedback/incoming-waitforinstanceready-unbounded.md.
//
// #1071: raised from 5 minutes to 15. Five minutes was sized for a POD starting
// on a node that already exists. The platform's own answer to the 504s in #1071
// is that a create may have to wait for a whole new worker NODE to be
// provisioned, and the request keeps running behind the gateway timeout while
// that happens — minutes, not seconds. A budget sized for pod start turned that
// into a loop: the create finally succeeds, the readiness wait expires while the
// node is still coming up, the cleanup path destroys the half-born instance, and
// the next tick starts the whole node provisioning over again.
// Override per deployment with ENCORE_SPAWN_READY_TIMEOUT_MS (main.ts) /
// EncoreScalerConfig.spawnReadyTimeoutMs.
export const DEFAULT_SPAWN_READY_TIMEOUT_MS = 15 * 60_000;

// Raised when the bounded readiness wait expires. Carries the service and
// instance so the spawn's cleanup path can tell this apart from every other
// failure: a readiness timeout means the instance EXISTS and is very likely
// still coming up (#1071 — node provisioning), so destroying it is wrong. Every
// other failure in that block means the spawn cannot proceed and must clean up.
export class SpawnReadyTimeoutError extends Error {
  readonly serviceId: string;
  readonly instanceId: string;
  constructor(serviceId: string, instanceId: string, message: string) {
    super(message);
    this.name = 'SpawnReadyTimeoutError';
    this.serviceId = serviceId;
    this.instanceId = instanceId;
  }
}

// How often (ms) the bounded readiness wait re-checks instance health. Matches
// the 1s cadence @osaas/client-core's own waitForInstanceReady uses
// (lib/core.js:343-353, v0.24.0) so this is no chattier than the helper it
// replaces. The final sleep is clamped to the remaining budget, so a timeout
// shorter than one interval still ends on time. Aliases the shared helper's
// default (src/services/instance-readiness.ts) — same 1s value, one source.
export const DEFAULT_SPAWN_READY_POLL_INTERVAL_MS =
  DEFAULT_INSTANCE_READY_POLL_INTERVAL_MS;

// Wait for a spawned OSC instance to report `running`, with the scaler's own
// hard deadline/cadence.
//
// The poll loop itself (own loop over getInstanceHealth, failed probe treated as
// "not ready yet", last error folded into the timeout message, deadline
// cancellation) is the shared helper in src/services/instance-readiness.ts; see
// its header for the verified @osaas/client-core contracts and the full
// rationale. #1038 lifted that loop out of this module so the provisioning route
// could reuse it. This wrapper only maps EncoreScalerConfig onto the helper's
// options AND injects SpawnReadyTimeoutError on a timeout: the spawn cleanup
// path below keys off `instanceof SpawnReadyTimeoutError` (#1071) to tell a
// still-coming-up instance (keep + record pending) apart from a broken one
// (destroy), so the timeout must carry the service and instance ids. Only the
// deadline path is remapped — a getServiceAccessToken failure before the loop
// still propagates as itself, which the cleanup path correctly treats as "not a
// readiness timeout".
// `signal` (#1170) cancels the wait when the SIBLING readiness wait this one
// runs concurrently with has already failed — see spawnPooledInstance. Passing
// it keeps the "no health probe after the spawn has rejected" property (#778
// review round 2) intact now that two waits overlap.
async function waitForSpawnedInstanceReady(
  serviceId: string,
  instanceId: string,
  config: EncoreScalerConfig,
  signal?: AbortSignal
): Promise<void> {
  await waitForInstanceReadyBounded(config.oscContext, serviceId, instanceId, {
    timeoutMs: config.spawnReadyTimeoutMs ?? DEFAULT_SPAWN_READY_TIMEOUT_MS,
    pollIntervalMs:
      config.spawnReadyPollIntervalMs ?? DEFAULT_SPAWN_READY_POLL_INTERVAL_MS,
    makeTimeoutError: (message) =>
      new SpawnReadyTimeoutError(serviceId, instanceId, message),
    ...(signal ? { signal } : {})
  });
}

// #1286: after the LAST create attempt has ended in a gateway timeout, how long
// the spawn keeps asking OSC for the same instance name before it gives up.
//
// Why there is anything to wait for: a 504 on createInstance is the ingress' 60s
// limit being hit while the platform is still creating the instance, and the
// create behind it usually completes (#1071 established that; successful creates
// take roughly 18-33s, so the ones that cross 60s are the slow ones rather than
// the failed ones). The retry loop above already adopts the instance when a
// RETRY collides with it ("Name is already taken"), but that only works if the
// create finishes while an attempt is still being made. When all three attempts
// time out first, the instance that lands afterwards used to belong to nobody:
// the spawn threw, the next tick built a NEW name
// (scaler{workspace}{ownerTag}{Date.now().toString(36)}), and the completed
// instance survived as an extra until the orphan reaper removed it — while a
// second create was already running against a platform that had just told us it
// was slow.
//
// 90s is sized on the thing being waited for: the create was at 60s when the
// gateway cut it off, and the platform-side create is ahead of that, so this is
// about a further minute and a half of "has it landed yet?". It is also cheap —
// the tick is blocked by the spawn either way, and the readiness wait that
// follows a successful adoption is 15 minutes (DEFAULT_SPAWN_READY_TIMEOUT_MS),
// so 90s is small against the budget the spawn already has.
export const DEFAULT_SPAWN_ADOPT_PROBE_TIMEOUT_MS = 90_000;

// How often that probe re-asks. Matches the retry loop's own first back-off step
// (5s) rather than inventing a new cadence: each probe is one getInstance, so at
// most 19 of them per failed spawn.
export const DEFAULT_SPAWN_ADOPT_PROBE_INTERVAL_MS = 5_000;

// The probe only runs when the timed-out create ACTUALLY RAN for about this long
// (#1286).
//
// A 504 means "nobody answered in time", and the only reason to watch the name
// afterwards is that the request may still be in flight on the platform side.
// That is true of the create the incident is about: it had been running at the
// ingress' 60s limit when the gateway gave up. It is NOT true of a 504 that
// comes back immediately — an ingress or proxy refusing the request before it
// reached the control plane never started a create, so there is no instance
// coming and the 90s probe would only delay the next attempt.
//
// 20s is deliberately well below the 60s ingress limit (a deployment behind a
// shorter-limit gateway still gets the probe) and well above the "refused on the
// spot" case. It is a floor on evidence, not an estimate of the limit.
export const SPAWN_ADOPT_PROBE_MIN_CREATE_DURATION_MS = 20_000;

// What OSC says about an instance the takeover is about to adopt (#1325).
//
//   'exists'  — OSC answered FOR THIS INSTANCE. It is there and may be adopted.
//   'absent'  — OSC's own instance list for the service was READ SUCCESSFULLY and
//               does not carry the name. A positive, enumerated not-found: there
//               is nothing to take over and nothing to clean up.
//   'unknown' — nothing answered definitively (an outage, a 5xx, a dropped
//               socket, an unreadable or non-array instance list, or two sources
//               disagreeing). Neither proof of presence nor of absence, so it is
//               never read as either: the caller keeps looking within its budget.
export type OscInstanceExistence = 'exists' | 'absent' | 'unknown';

// Does the Encore instance `name` ACTUALLY exist on OSC? (#1325)
//
// WHY A SECOND QUESTION IS NEEDED after getInstance has already answered with an
// instance body. `getInstance` is a plain GET of the instance URL through
// `createFetch`, and `createFetch` returns the response body for ANY ok status,
// parsed as JSON when the content type says so and as TEXT otherwise
// (@osaas/client-core@0.24.0 lib/core.js:119-150, lib/fetch.js:20-37). So a 200
// that is not an instance — a gateway's interstitial page, an empty body, an
// instance record the control plane is still rolling back — comes back as a
// truthy value and read as "the instance appeared". That is #1325: after three
// 504s the scaler took over an instance OSC then twice reported as not existing,
// waited on it for minutes with a callback listener created against it, and
// dispatched nothing to the instance that was running fine in the meantime.
//
// The question is asked in two steps, and ONLY THE SECOND ONE CAN PROVE ABSENCE.
//
// Step 1, getInstanceHealth — a positive signal for PRESENCE only. It is the
// instance-specific query OSC exposes and the exact one the readiness wait that
// follows an adoption would run anyway (waitForSpawnedInstanceReady ->
// waitForInstanceReadyBounded, src/services/instance-readiness.ts). Contract
// (verified against the pinned @osaas/client-core@0.24.0 tarball):
//   - getInstanceHealth(context, serviceId, name, token): Promise<string>
//     (lib/core.d.ts:86, lib/core.js:211-220) first resolves the health URL via
//     `getInstanceLink(context, token, serviceId, name, 'health')` and only then
//     GETs https://{serviceApiHost}/health/{name}. So a RESOLUTION means the
//     control plane served both the instance record and the health route: good
//     evidence of presence.
//   - Its REJECTION, however, is NOT the control plane answering about this
//     instance, and must never be read as one (#1327 review finding). The chain
//     is getInstanceHealth -> getInstanceLink (lib/core.js:24-28) -> getInstance
//     (lib/core.js:119-150), and `getInstance` returns `undefined` for EVERY
//     failure but 401 — it rethrows only UnauthorizedError, maps 404 to
//     `undefined`, and falls through to `return undefined` for a 500, a 504 or a
//     dropped socket alike. `getInstanceLink` then throws a PLAIN
//     `Error("Instance {name} of service {serviceId} not found")` with NO
//     httpCode, so isInstanceAlreadyGoneError (osc-error.ts) matches it on its
//     'not found' message marker. A transient control-plane fault — the very
//     condition that produced the three consecutive gateway timeouts in #1325 —
//     is therefore INDISTINGUISHABLE here from a real 404. `getService`'s own
//     failures propagate the same way (it is awaited outside getInstance's try),
//     so even an httpCode of 404 on this path can be the catalog's answer about
//     /mysubscriptions rather than about this instance.
//   - A non-ok response otherwise arrives as `FetchError { message, httpCode }`
//     (lib/fetch.js defaultErrorFactory), with httpCode OPTIONAL — a
//     transport-level failure is re-wrapped with none at all.
//
// Step 2, listInstances — the ARBITER, and the only thing that can return
// 'absent'. It is the authoritative enumeration this module already relies on
// for eviction (evictVanishedInstances below). A not-found-shaped rejection in
// step 1 is only a reason to ASK it, never an answer:
//   - list read, is an array, does NOT carry the name  => 'absent'. OSC
//     enumerated its instances for this service and this one is not among them.
//   - list read, is an array, DOES carry the name      => 'unknown' (the two
//     sources disagree, which is not proof of absence).
//   - list could not be read, or the body is not an array => 'unknown'. NOTHING
//     has answered, so nothing may be concluded. Letting the single-instance
//     rejection "stand on its own" here was the #1327 finding: an instance that
//     DID land behind the 504 would be reported absent, never adopted and never
//     removed — a live, billing orphan, because the create's error is rethrown
//     before the cleanup block below.
// An indeterminate verdict never ends the watch, so adoption keeps its full
// budget; only a positively enumerated absence stops it early.
export async function encoreInstanceExistence(
  config: EncoreScalerConfig,
  name: string,
  sat: string
): Promise<OscInstanceExistence> {
  try {
    await getInstanceHealth(config.oscContext, ENCORE_SERVICE_ID, name, sat);
    // Resolved => the control plane answered for this instance. The reported
    // health itself is not read here: 'pending' or any other starting state
    // still means the instance exists, and whether it is READY is the readiness
    // wait's question, with its own budget.
    return 'exists';
  } catch (err) {
    if (!isInstanceAlreadyGoneError(err)) {
      console.warn(
        '[encore-scaler] spawn: could not confirm whether Encore instance %s exists ' +
          '(workspace=%s) — treating as unconfirmed, NOT as present (#1325):',
        name,
        config.workspaceId,
        err
      );
      return 'unknown';
    }
    // The rejection is not-found-SHAPED, which (see above) a transient fault
    // produces just as readily as a real 404. It is only a reason to ask the
    // authoritative question, so the instance list decides from here on and a
    // non-answer from it resolves to 'unknown', never to 'absent' (#1327).
    let listed: unknown;
    try {
      listed = await oscListInstances(config.oscContext, ENCORE_SERVICE_ID, sat);
    } catch (listErr) {
      console.warn(
        '[encore-scaler] spawn: Encore instance %s looks not-found but the instance ' +
          'list could not be read to confirm it (workspace=%s) — INDETERMINATE, not ' +
          'absent; an instance that did land must stay adoptable (#1325, #1327):',
        name,
        config.workspaceId,
        listErr
      );
      return 'unknown';
    }
    if (!Array.isArray(listed)) {
      // createFetch hands back whatever an ok response carried, so a gateway's
      // interstitial page or an empty body arrives here as a non-array. That is
      // not an enumeration of anything.
      console.warn(
        '[encore-scaler] spawn: Encore instance %s looks not-found and OSC answered ' +
          'the instance list with a %s rather than an array (workspace=%s) — ' +
          'INDETERMINATE, not absent (#1327)',
        name,
        typeof listed,
        config.workspaceId
      );
      return 'unknown';
    }
    // Elements are typed as possibly absent on purpose: this body is whatever an
    // ok response carried, so a null or a bare string inside the array must not
    // throw on the way to a verdict.
    const instances = listed as Array<OscInstance | null | undefined>;
    if (
      instances.some((inst) => typeof inst?.name === 'string' && inst.name === name)
    ) {
      console.warn(
        '[encore-scaler] spawn: OSC reports Encore instance %s as not existing but ' +
          'still lists it (workspace=%s) — not taking it over on this probe (#1325)',
        name,
        config.workspaceId
      );
      return 'unknown';
    }
    // The only route to 'absent': OSC enumerated this service's instances and
    // the name is not among them.
    return 'absent';
  }
}

// An instance body is only a TAKEOVER CANDIDATE if it is shaped like the
// instance that was asked for (#1325).
//
// getInstance resolves whatever an ok response carried (lib/fetch.js:28-36), so
// this rejects the bodies that are not an instance at all — a text/HTML page, an
// empty object, an instance under a different name — before any existence query
// is spent on them. `name` and `url` are exactly the two fields the spawn goes
// on to read (instanceName/instanceUrl above), and the name must be the one this
// spawn created: a body for a DIFFERENT instance is somebody else's and must
// never be adopted here.
function takeoverCandidate(
  name: string,
  probed: OscInstance | undefined
): OscInstance | undefined {
  if (probed === undefined || probed === null || typeof probed !== 'object') {
    return undefined;
  }
  if (probed.name !== name) return undefined;
  if (typeof probed.url !== 'string' || probed.url.length === 0) return undefined;
  return probed;
}

// The outcome of the bounded watch below.
//
// 'absent' is kept distinct from 'gone-quiet' (the budget ran out without a
// usable answer) only for the log line each one writes; both end the spawn with
// the CREATE's error, so the spawn counts as FAILED, no callback listener is
// created, the #1322 back-off applies and the tick carries on dispatching queued
// jobs to the instances that are running (#1325).
//
// The two are NOT equivalent operationally, which is what `sawCandidate`
// records (#1327). 'absent' means OSC enumerated the service and the name was
// not there, so there is provably nothing to clean up. 'gone-quiet' means the
// budget ran out with nothing proven either way — and if a takeover candidate
// was seen during the watch, an instance under that name may well be LIVE on
// OSC while this spawn walks away from it. Nothing here can safely remove it
// (it may be another spawn's, or still coming up), so it is handed to the
// orphan reaper, loudly, instead of being written off as absent.
type GatewayTimeoutTakeover =
  | { kind: 'adopt'; instance: OscInstance }
  | { kind: 'absent' }
  | { kind: 'gone-quiet'; sawCandidate: boolean };

// Watch one instance name for a bounded time and return the instance if OSC
// starts reporting it — and CONFIRMS that it exists (#1286, #1325).
//
// Every probe goes through tryGetInstance, so the same two properties as the
// in-loop adoption hold: a probe that itself fails is "could not confirm" and
// never replaces the create's error (#1071 review finding 4), and `undefined` is
// never read as proof of absence (@osaas/client-core lib/core.js:140-150
// swallows every failure but 401). The FIRST probe is issued immediately, before
// any sleep: the create has been running for at least the gateway's limit by
// now, so it may well have completed already.
//
// #1325: a probe answer is no longer taken at face value. An instance is adopted
// only when it is shaped like the one that was asked for (takeoverCandidate) AND
// OSC confirms it exists (encoreInstanceExistence). A confirmed 'does not exist'
// ends the watch immediately — there is nothing coming, and every second spent
// here is a second the tick is not dispatching queued work.
async function probeForGatewayTimedOutInstance(
  config: EncoreScalerConfig,
  name: string,
  sat: string
): Promise<GatewayTimeoutTakeover> {
  const budgetMs =
    config.spawnAdoptProbeTimeoutMs ?? DEFAULT_SPAWN_ADOPT_PROBE_TIMEOUT_MS;
  const intervalMs =
    config.spawnAdoptProbeIntervalMs ?? DEFAULT_SPAWN_ADOPT_PROBE_INTERVAL_MS;
  if (budgetMs <= 0) return { kind: 'gone-quiet', sawCandidate: false };
  const deadline = Date.now() + budgetMs;
  // Did any probe ever see something shaped like the instance we asked for? Only
  // used to describe an indeterminate outcome accurately (#1327) — it is never
  // evidence of existence on its own, which is the whole point of #1325.
  let sawCandidate = false;
  // One probe: ask for the instance, and only if the answer looks like it, ask
  // OSC whether it really is there. Returns undefined for "nothing usable this
  // time round", which keeps the watch going.
  const lookOnce = async (
    probe: number
  ): Promise<GatewayTimeoutTakeover | undefined> => {
    const candidate = takeoverCandidate(
      name,
      await tryGetInstance(config, ENCORE_SERVICE_ID, name, sat)
    );
    if (candidate === undefined) return undefined;
    sawCandidate = true;
    const existence = await encoreInstanceExistence(config, name, sat);
    if (existence === 'exists') {
      console.warn(
        '[encore-scaler] spawn: instance %s appeared after the create timed out at ' +
          'the gateway and OSC confirms it exists (workspace=%s probe=%d) — adopting ' +
          'it instead of letting the next tick create a new name (#1286, #1325)',
        name,
        config.workspaceId,
        probe
      );
      return { kind: 'adopt', instance: candidate };
    }
    if (existence === 'absent') {
      console.warn(
        '[encore-scaler] spawn: OSC reported instance %s but says it does not exist ' +
          '(workspace=%s probe=%d) — NOT taking it over; the spawn counts as failed ' +
          'and queued jobs keep going to the instances that are running (#1325)',
        name,
        config.workspaceId,
        probe
      );
      return { kind: 'absent' };
    }
    return undefined;
  };
  for (let probe = 1; ; probe += 1) {
    const outcome = await lookOnce(probe);
    if (outcome) return outcome;
    // The sleep is clamped to what is left of the budget, so a budget shorter
    // than one interval still ends on time and never overshoots it.
    const remaining = deadline - Date.now();
    if (remaining <= 0) return { kind: 'gone-quiet', sawCandidate };
    await new Promise((r) => setTimeout(r, Math.min(intervalMs, remaining)));
    if (Date.now() >= deadline) {
      // One last look at the deadline itself: the instance may have appeared
      // during the final sleep, and the whole point is not to abandon it.
      return (await lookOnce(probe + 1)) ?? { kind: 'gone-quiet', sawCandidate };
    }
  }
}

// Mutable bookkeeping threaded through a single spawn so its failure path can
// report HOW MUCH was attempted and WHICH short-lived credentials were in play
// (#1071).
//
// `attempts` is the TOTAL number of createInstance calls this spawn made, summed
// over BOTH services it creates: the Encore instance (up to `maxAttempts`) and
// its paired callback listener (up to `maxAttempts` again). It is therefore NOT
// the attempt number of any one retry loop and can exceed `maxAttempts` — a
// spawn that created the Encore instance on its second try and then exhausted
// three listener attempts reports attempts: 5. It is a "how much work did this
// spawn burn before giving up" counter, which is what distinguishes one unlucky
// call from a workspace hammering OSC every tick. Incremented once per attempt,
// before the call, so an attempt that throws still counts.
//
// `secrets` collects the service access tokens the spawn minted, so the recorded
// error text can be scrubbed of them before it is served over HTTP.
type SpawnProgress = { attempts: number; secrets: string[] };

// Optional callbacks a caller can hang off the phases of a spawn.
//
// `onCreatesSettled` (#1322 review finding 3) is called exactly once, at the
// moment this spawn will issue no further createInstance call — both halves (the
// transcoder instance and its paired callback listener) have been created or
// adopted — and BEFORE the readiness waits are awaited.
//
// That boundary exists because the two phases of a spawn load the platform very
// differently. The create phase is what goes through the cluster's ingress
// admission webhook (two ingresses, 15-19s apiece under load) and is the burst
// the deployment-wide spawn cap exists to damp (spawn-admission.ts). The
// readiness phase that follows is a once-a-second getInstanceHealth poll against
// an instance that already exists, for up to DEFAULT_SPAWN_READY_TIMEOUT_MS (15
// minutes, because OSC may be provisioning a whole worker node) — it puts no
// create pressure on the webhook at all. Holding an admission slot across it
// would park every other workspace's scale-up for the whole node-provisioning
// wait to damp a burst that was over in seconds.
//
// It is NOT called when the spawn fails before that point; the caller is
// expected to release in a `finally` as well (SpawnSlot.release is idempotent),
// so an early throw still gives the slot back.
export type SpawnHooks = {
  onCreatesSettled?: () => void;
};

// Run a spawn hook without letting it affect the spawn.
//
// A hook is caller bookkeeping (releasing an admission slot), not a step of the
// spawn: a throwing hook must not fail an instance that was created fine, nor be
// mistaken for an OSC failure by the spawn-failure record.
function runSpawnHook(hook: (() => void) | undefined, label: string): void {
  if (hook === undefined) return;
  try {
    hook();
  } catch (err) {
    console.warn('[encore-scaler] spawn: %s hook threw (ignored):', label, err);
  }
}

// Spawn a fresh Encore OSC instance and register it in the pool. The instance
// name is unique per spawn so concurrent scale-ups never collide.
// Retries up to 3 times on transient 5xx OSC infrastructure errors (e.g.
// ingress-nginx admission webhook timeouts that appear under cluster load).
//
// #1071: whichever way this ends, it leaves a trace in the pool's own Valkey
// state. A failure is recorded under keys.spawnFailure(workspaceId) — timestamp,
// attempts made, consecutive failures, redacted message — and surfaced by GET
// /scaler/status, because the throw alone was invisible to anyone without pod
// logs: the caller (scaler-loop.ts tick step 3) could only log it and wait for
// the next tick, leaving "at cap" and "cannot spawn" indistinguishable on the
// wire. A success clears the record. Both are best-effort: the bookkeeping must
// never mask the real error, nor fail a spawn that actually worked.
//
// `hooks.onCreatesSettled` (#1322 review) fires once this spawn will make no
// further createInstance call — see SpawnHooks below.
export async function spawnInstance(
  config: EncoreScalerConfig,
  maxAttempts = 3,
  hooks?: SpawnHooks
): Promise<EncoreInstanceRecord> {
  const progress: SpawnProgress = { attempts: 0, secrets: [] };
  try {
    const record = await spawnPooledInstance(config, maxAttempts, progress, hooks);
    try {
      await clearSpawnFailure(config.redis, config.workspaceId);
    } catch {
      // The record carries a TTL and the next failure overwrites it, so a
      // failed clear self-heals. Never fail a spawn that succeeded.
    }
    return record;
  } catch (err) {
    try {
      const recorded = await recordSpawnFailure(config.redis, config.workspaceId, {
        attempts: progress.attempts,
        error: err,
        secrets: spawnFailureSecrets(config, progress.secrets)
      });
      console.error(
        '[encore-scaler] spawn failed (workspace=%s createCalls=%d consecutive=%d ' +
          'httpCode=%s): %s',
        config.workspaceId,
        recorded.attempts,
        recorded.consecutiveFailures,
        String(oscHttpCode(err) ?? 'none'),
        recorded.message
      );
    } catch (recordErr) {
      // Valkey trouble must not swallow the spawn error the caller needs.
      console.error(
        '[encore-scaler] could not record spawn failure (workspace=%s):',
        config.workspaceId,
        recordErr
      );
    }
    throw err;
  }
}

// The dedicated Valkey queue each spawned callback listener publishes completion
// messages on. Deliberately NOT the eyevinn-encore-packager default: an external
// packager subscribed to the default queue would win the BZPOPMIN race against
// our own poller and swallow our completion messages (issue #93). MUST match
// DEFAULT_QUEUE_KEY in src/pipeline/encore-callback-poller.ts.
const CALLBACK_LISTENER_QUEUE_KEY = 'ovc:transcode-done';

// Create the callback listener paired with `instanceId`, or adopt the existing
// one if that name is already taken (#1071).
//
// Single source of truth for the listener's creation body, because TWO paths now
// create it: a normal spawn, and resolvePendingSpawns completing a spawn whose
// Encore readiness wait timed out BEFORE it ever got here. If they disagreed
// about `RedisQueue` or `EncoreUrl`, the second path would produce an instance
// whose completions go somewhere nothing reads.
//
// Contracts (verified, @osaas/client-core@0.24.0):
//   - createInstance(context, serviceId, token, body) — lib/core.js:76-89.
//   - getInstance(context, serviceId, name, token) — lib/core.js:128-150;
//     rethrows ONLY 401, returns undefined for every other failure, so undefined
//     means "could not confirm" and is NOT treated as an adoption.
// Throws whatever createInstance threw when adoption is not possible, so the
// caller owns retry/back-off classification.
async function createOrAdoptCallbackListener(
  config: EncoreScalerConfig,
  instanceId: string,
  encoreUrl: string,
  callbackSat: string
): Promise<{ instance: OscInstance; adopted: boolean }> {
  try {
    console.info(
      '[encore-scaler] spawn: creating callback listener %s for Encore instance %s (workspace=%s)',
      instanceId,
      encoreUrl,
      config.workspaceId
    );
    const created = (await createInstance(
      config.oscContext,
      ENCORE_CALLBACK_LISTENER_SERVICE_ID,
      callbackSat,
      {
        name: instanceId,
        RedisUrl: config.redisUrl,
        EncoreUrl: encoreUrl.replace(/\/+$/, ''),
        RedisQueue: CALLBACK_LISTENER_QUEUE_KEY
      }
    )) as OscInstance;
    return { instance: created, adopted: false };
  } catch (err) {
    console.warn(
      '[encore-scaler] spawn: create of callback listener %s failed (workspace=%s): %s',
      instanceId,
      config.workspaceId,
      err instanceof Error ? err.message : String(err)
    );
    // Adopt-on-"already taken": the listener is named after its Encore
    // instance, so a create that landed behind a 504 makes the retry collide
    // with itself.
    if (isNameAlreadyTakenError(err)) {
      // tryGetInstance, not getInstance: the probe runs inside the create's
      // failure path, where OSC is by definition unhealthy, and getInstance can
      // throw (its getService lookup is outside its own try — lib/core.js:128).
      // A throwing probe used to replace the create's error, abandon the
      // caller's retry loop and — on the resolvePendingSpawns path — abort the
      // completion of a pending spawn (#1071 review finding 4). An unconfirmed
      // probe is "could not confirm", so the original error is re-thrown below
      // and the caller's transient classification decides what happens next.
      const existing = await tryGetInstance(
        config,
        ENCORE_CALLBACK_LISTENER_SERVICE_ID,
        instanceId,
        callbackSat
      );
      if (existing) {
        console.warn(
          '[encore-scaler] adopted pre-existing callback listener %s (workspace=%s) (#1071)',
          instanceId,
          config.workspaceId
        );
        return { instance: existing, adopted: true };
      }
    }
    throw err;
  }
}

// #1287: the secret-purpose qualifier the per-stack object-store credential is
// saved under. Identical to provision.ts's OBJECT_STORE constant
// (src/routes/provision.ts:892), so the scaler's secret name is the SAME name
// the provisioning path already pre-mints for serviceId 'encore'
// (provision.ts:1900-1912 applies encoreCredentialMapping(objectStoreCreds,
// OBJECT_STORE) under `${stackName}.${purpose}`, provision.ts:1371-1373). The
// scaler's `workspaceId` IS that stack identity (workspace-registry.ts:408-419
// resolves the loop key to the stack whose S3 config it loads), so one
// deterministic name per workspace serves both paths instead of two parallel
// naming schemes. Since the #1287 review the scaler does not WRITE that shared
// name when provisioning minted it — it references it (see
// encoreS3CreateBodyFields) — and uses this purpose only to name a secret of
// its own for a credential provisioning never minted one for.
const OBJECT_STORE_SECRET_PURPOSE = 'objectstore';

// Cached per-workspace create-body S3 fields, so the OSC secret is written ONCE
// per workspace and reused by every later spawn (#1287) rather than on every
// scale-up. `fingerprint` is a hash of the credential the fields were built
// from, so a rotated key (a re-resolved stack config, workspace-registry.ts:417)
// re-saves under the same deterministic name instead of serving a stale
// reference. Keyed by workspaceId; the value holds only the NON-secret fields
// plus `{{secrets.*}}` references — never the literal credential.
const encoreS3CreateFields = new Map<
  string,
  { fingerprint: string; fields: Record<string, string> }
>();

// Test-only / teardown seam: forget the cached fields for one workspace (or all
// of them), so a workspace whose loop was torn down does not keep a reference
// minted for a credential nobody resolved again.
export function forgetEncoreS3CreateFields(workspaceId?: string): void {
  if (workspaceId === undefined) {
    encoreS3CreateFields.clear();
    return;
  }
  encoreS3CreateFields.delete(workspaceId);
}

// Build the S3 portion of a spawned Encore instance's create body (#1287).
//
// The secret access key is NEVER a literal create-instance parameter: it is
// written as an OSC per-service secret scoped to serviceId 'encore' and the body
// carries `{{secrets.<name>}}`, exactly as the provisioning path does
// (src/routes/provision.ts:1366-1373 secretRef / 1375-1395 applyCredentialMapping,
// and the same pattern at src/routes/optional-services.ts:256-268).
//
// WHICH field is a secret and WHAT each field is called is not restated here —
// it comes from encoreCredentialMapping (src/services/external-storage-
// credentials.ts:89-116), the single source of Encore's field-name convention:
// `s3AccessKeyId` / `s3Region` / `s3Endpoint` are plain config fields,
// `s3SecretAccessKey` (and `s3SessionToken` when the resolved config ever gains
// one — EncoreS3Config has no session token today, types.ts:24-35) are secrets.
// Iterating `mapping.secrets` means a future secret field is referenced, not
// leaked, without touching this function.
//
// Contract: saveSecret(serviceId, name, value, ctx): Promise<void>
// (@osaas/client-core lib/core.d.ts:154); the implementation is a bare POST to
// /mysecrets/<serviceId> that rejects on any non-2xx (lib/core.js:355-369).
// There is no PUT/update/delete counterpart in the pinned 0.24.0 SDK, and
// ADR-002-credential-storage.md:46,48 records OSC service secrets as
// "write-once, never-read-back", :155,174 "Rotation = new secret name +
// reprovision. There is no in-place secret update."
//
// WHICH NAME IS WRITTEN AND WHICH IS ONLY REFERENCED (#1287 review finding).
// For a per-stack object-store credential the provisioning path has ALREADY
// minted `${stackName}.objectstore.s3secretaccesskey` for serviceId 'encore'
// with the same value (src/routes/provision.ts, applyCredentialMapping over
// encoreCredentialMapping(objectStoreCreds, OBJECT_STORE)). Re-POSTing an
// existing name is not a supported upsert under the contract above, so this
// function does NOT write it: `EncoreS3Config.secretAccessKeyRef` carries the
// pre-minted name (set by services/encore-s3-config.ts resolveEncoreS3Config
// for exactly the credential provisioning mints for) and the body is built as
// `{{secrets.<that name>}}` with no secret write at all. Only a credential with
// no pre-minted secret — a pre-#1094 stack on the legacy deployment-wide
// password, or a static operator-configured store — is written here, under the
// scaler's own deterministic name.
//
// Throws whatever saveSecret threw. That is deliberate: there is no fallback to
// sending the literal, so a spawn whose secret could not be written fails and is
// retried by the caller's retry/back-off path.
export async function encoreS3CreateBodyFields(
  config: EncoreScalerConfig
): Promise<Record<string, string>> {
  const s3 = config.s3Config;
  if (!s3) return {};

  const creds: ExternalStorageCredentials = {
    // encoreCredentialMapping reads accessKeyId/secretAccessKey/region/
    // endpointUrl only — `bucket` is required by the shared
    // ExternalStorageCredentials type but used solely by the packager mapping's
    // OutputFolder (external-storage-credentials.ts:118-135). The scaler's
    // EncoreS3Config carries no bucket, and Encore takes its input URI per job.
    bucket: '',
    accessKeyId: s3.accessKeyId,
    secretAccessKey: s3.secretAccessKey,
    region: s3.region,
    endpointUrl: s3.endpoint
  };

  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify([
        s3.endpoint,
        s3.accessKeyId,
        s3.secretAccessKey,
        s3.region ?? '',
        // A stack that GAINS a pre-minted secret name (first resolve after a
        // reprovision) must rebuild its fields rather than serve the cached
        // self-written reference.
        s3.secretAccessKeyRef ?? ''
      ])
    )
    .digest('hex');
  const cached = encoreS3CreateFields.get(config.workspaceId);
  if (cached && cached.fingerprint === fingerprint) {
    return { ...cached.fields };
  }

  const mapping = encoreCredentialMapping(creds, OBJECT_STORE_SECRET_PURPOSE);
  const fields: Record<string, string> = { ...mapping.configFields };
  // Encore requires SOME region value even where the store ignores it; the
  // mapping omits the field when the resolved config has none, so keep the
  // scaler's long-standing default rather than sending an absent region.
  if (fields['s3Region'] === undefined) fields['s3Region'] = 'us-east-1';

  // The purpose whose secret the provisioning path pre-mints, so a future
  // session-token secret (purpose `objectstore.s3sessiontoken`) is not silently
  // treated as pre-minted — provisioning mints only the one below.
  const PRE_MINTED_PURPOSE = `${OBJECT_STORE_SECRET_PURPOSE}.s3secretaccesskey`;

  for (const secret of mapping.secrets) {
    const preMinted =
      secret.purpose === PRE_MINTED_PURPOSE && s3.secretAccessKeyRef
        ? s3.secretAccessKeyRef
        : undefined;
    if (preMinted) {
      // Reference only. No saveSecret call: the name already exists in the
      // environment and the SDK has no update path to write it with (see the
      // header). The literal still never reaches the create body.
      fields[secret.field] = `{{secrets.${preMinted}}}`;
      continue;
    }
    const secretName = `${config.workspaceId}.${secret.purpose}`;
    await saveSecret(ENCORE_SERVICE_ID, secretName, secret.value, config.oscContext);
    fields[secret.field] = `{{secrets.${secretName}}}`;
  }

  encoreS3CreateFields.set(config.workspaceId, { fingerprint, fields });
  return { ...fields };
}

async function spawnPooledInstance(
  config: EncoreScalerConfig,
  maxAttempts: number,
  progress: SpawnProgress,
  hooks?: SpawnHooks
): Promise<EncoreInstanceRecord> {
  const sat = await config.oscContext.getServiceAccessToken(ENCORE_SERVICE_ID);
  progress.secrets.push(sat);
  // Lowercase-alphanumeric, matching OSC's instance-name rules
  // (isValidInstanceName) and the provision route's own naming constraints.
  const name = `${scalerInstancePrefix(config.workspaceId)}${Date.now().toString(36)}`;
  // #1287: the S3 fields, with the secret access key already written to OSC as a
  // per-service secret and reduced to a `{{secrets.<name>}}` reference. Resolved
  // ONCE here, outside the retry loop, so retries send the identical body and
  // the secret write is not repeated per attempt; cached per workspace so later
  // spawns reuse the same secret.
  const s3Fields = await encoreS3CreateBodyFields(config);

  let lastErr: unknown;
  let instance: OscInstance | undefined;
  // Whether the paired callback listener was created, so the cleanup path knows
  // it has a listener to remove as well (#778 review finding 3).
  let listenerCreated = false;
  // URL of that listener once it exists, so a pending-spawn record written by
  // the failure path below can carry it (#1071). Without it a resumed instance
  // would have to be dispatched to with no callback path.
  let listenerUrl: string | undefined;
  // #1071: whether the Encore instance / its listener was ADOPTED — found
  // already existing on OSC and fetched with getInstance — rather than created
  // by this spawn's own successful createInstance call. The cleanup path below
  // never destroys an adopted instance, following the adopted-vs-created
  // distinction src/routes/provision.ts already makes for rollback (#417/#736).
  let instanceAdopted = false;
  let listenerAdopted = false;
  // #1286: when the create call now being made started, so its failure path can
  // tell a request that ran into the gateway's limit from one that was refused
  // on the spot.
  let attemptStartedAt = Date.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    progress.attempts += 1;
    try {
      // #1287: s3AccessKeyId/s3Endpoint/s3Region are plain config fields and
      // s3SecretAccessKey is a `{{secrets.<name>}}` reference to an OSC secret
      // — the literal is never part of the instance configuration. Resolved
      // once before the retry loop (see above the loop) so a retry re-uses the
      // same reference instead of re-writing the secret per attempt.
      const instanceBody: Record<string, string> = { name, ...s3Fields };
      // Point the instance at our own public profile index so it loads the
      // operator-managed profiles from CouchDB (issue #84). `profilesUrl` is the
      // Encore service's own config key for the YAML profile index URL.
      if (config.profilesUrl) {
        instanceBody['profilesUrl'] = config.profilesUrl;
      }
      // Size the OUTPUT upload's multipart parts (issue #1221). Sent
      // independently of `s3Config` above: the credentials may come from the
      // static env pair instead of a resolved stack config, and this is a
      // transport tunable, not a credential. The option's declared type is
      // `string` (a decimal byte count, like its "104857600" default), so the
      // number is stringified rather than sent as JSON number — see
      // upload-part-size.ts for the instance-API schema this is verified against.
      if (config.uploadPartSizeBytes !== undefined) {
        instanceBody[UPLOAD_PART_SIZE_OPTION] = String(config.uploadPartSizeBytes);
      }
      // Say what is being created before the call: a create that hangs or
      // fails at the gateway otherwise leaves no record of having been tried.
      console.info(
        '[encore-scaler] spawn: creating Encore instance %s (workspace=%s attempt=%d/%d)',
        name,
        config.workspaceId,
        attempt,
        maxAttempts
      );
      // #1286: how long this attempt ran. A 504 only means "the create may
      // still be happening" if the request was actually in flight long enough
      // for that to be true — see SPAWN_ADOPT_PROBE_MIN_CREATE_DURATION_MS.
      attemptStartedAt = Date.now();
      instance = (await createInstance(
        config.oscContext,
        ENCORE_SERVICE_ID,
        sat,
        instanceBody
      )) as OscInstance;
      console.info(
        '[encore-scaler] spawn: created Encore instance %s (workspace=%s attempt=%d)',
        name,
        config.workspaceId,
        attempt
      );
      break;
    } catch (err) {
      lastErr = err;
      console.warn(
        '[encore-scaler] spawn: create of Encore instance %s failed (workspace=%s attempt=%d/%d): %s',
        name,
        config.workspaceId,
        attempt,
        maxAttempts,
        err instanceof Error ? err.message : String(err)
      );
      // #1071 ADOPT-ON-"ALREADY TAKEN". `name` is computed ONCE, outside this
      // loop, so every attempt sends the same name. That is deliberate: when a
      // previous attempt timed out at the gateway (504) but completed behind it,
      // OSC answers the retry with "Name is already taken" — which is proof the
      // instance we wanted exists. Fetch and adopt it instead of failing or
      // creating a duplicate, the same idempotency src/routes/provision.ts:822-843
      // implements for the provisioning path (#417).
      if (isNameAlreadyTakenError(err)) {
        // tryGetInstance, not getInstance: a probe that itself fails must not
        // replace the create's error or abandon the retry loop (#1071 review
        // finding 4). Guarded by takeoverCandidate for the same reason the
        // post-exhaustion watch is (#1325, #1327 review minor): an ok response
        // that is not this instance — an interstitial page, an empty body, a
        // record under another name — must never be adopted here either.
        const existing = takeoverCandidate(
          name,
          await tryGetInstance(config, ENCORE_SERVICE_ID, name, sat)
        );
        if (existing) {
          instance = existing;
          instanceAdopted = true;
          console.warn(
            '[encore-scaler] spawn: adopted pre-existing Encore instance %s ' +
              '(workspace=%s attempt=%d) — a previous create landed despite ' +
              'reporting a failure (#1071)',
            name,
            config.workspaceId,
            attempt
          );
          break;
        }
        // getInstance returned undefined (or a body that is not this instance),
        // which means "could not confirm" and not "does not exist" —
        // lib/core.js:119-150 swallows EVERY error but 401, so a 404, a 500 and
        // a dropped socket are indistinguishable here.
        // The name being taken is itself strong evidence the instance exists, so
        // this is retry-worthy: back off and try the create again, which will
        // collide again and give adoption a second chance. Safe because the name
        // is fixed, so a retry can never create a duplicate. On the last attempt
        // the original "already taken" error is thrown, exactly as before.
        if (attempt < maxAttempts) {
          console.warn(
            '[encore-scaler] spawn: instance name %s is taken but getInstance could ' +
              'not confirm the instance (workspace=%s attempt=%d) — retrying (#1071)',
            name,
            config.workspaceId,
            attempt
          );
          await new Promise((r) => setTimeout(r, attempt * 5_000));
          continue;
        }
        throw err;
      }
      // Retry only what can succeed on a later attempt. Classified on the
      // error's structural httpCode, NOT on substring-matching its message
      // (#1071): the 504 that caused the incident arrives as an HTML error page
      // whose text was never matched, while any message merely containing '503'
      // was retried as though it were one.
      const isTransient = isTransientOscError(err);
      if (!isTransient) throw err;
      if (attempt === maxAttempts) {
        // #1286 LAST-ATTEMPT ADOPT PROBE. Every attempt has now ended at the
        // gateway without the create ever reporting back, so the adopt-on-
        // "already taken" path above never had a collision to work with — and
        // the create it was waiting for is very likely still running. Giving up
        // here is what let the next tick build a NEW name and start a SECOND
        // create while the platform was already slow, leaving the instance that
        // finished to the orphan reaper.
        //
        // Only a request that really reached the gateway's limit is worth
        // watching for; anything else (a non-timeout 5xx, a 504 refused on the
        // spot, a transport failure with no status) throws exactly as before.
        const elapsed = Date.now() - attemptStartedAt;
        if (
          isGatewayTimeoutStatus(oscHttpCode(err)) &&
          elapsed >= SPAWN_ADOPT_PROBE_MIN_CREATE_DURATION_MS
        ) {
          console.warn(
            '[encore-scaler] spawn: all %d create attempts for Encore instance %s ' +
              'timed out at the gateway after %dms (workspace=%s) — watching the ' +
              'same name instead of giving up on it (#1286)',
            maxAttempts,
            name,
            elapsed,
            config.workspaceId
          );
          const takeover = await probeForGatewayTimedOutInstance(config, name, sat);
          if (takeover.kind === 'adopt') {
            instance = takeover.instance;
            // Adopted, never created by this spawn: the cleanup path below must
            // not destroy it (#1071, the adopted-vs-created rule
            // src/routes/provision.ts applies to rollback — #417/#736).
            instanceAdopted = true;
            break;
          }
          // #1325: either OSC enumerated the service and the instance is not
          // there, or the watch ended without OSC ever confirming that it is.
          // Both FAIL the spawn on the create's error, which is the pre-#1286
          // outcome for a create that really did not land: nothing is adopted,
          // no callback listener is created against a name that is not there
          // (an orphaned listener had to be deleted by hand in the incident),
          // the failure is recorded so the #1322 back-off holds the next create
          // off, and the tick continues straight to dispatch — so queued jobs
          // keep going to the instances that are running instead of waiting on
          // a missing one.
          //
          // #1327: the indeterminate case is logged as what it is. 'absent' is
          // proven (the instance list did not carry the name) and leaves nothing
          // behind. A watch that merely went quiet having SEEN a candidate may
          // be walking away from a live instance; this spawn cannot safely
          // remove it — it never confirmed it created it, and destroying a name
          // another spawn owns or that is still coming up is the worse error —
          // so the orphan reaper is the backstop and the line says so.
          console.warn(
            takeover.kind === 'absent'
              ? '[encore-scaler] spawn: OSC enumerated its instances and Encore ' +
                  'instance %s is not among them after the gateway timeouts ' +
                  '(workspace=%s) — failing the spawn with the create error instead of ' +
                  'taking over a missing instance; nothing to clean up; the next spawn ' +
                  'for this workspace is backed off (#1325)'
              : takeover.sawCandidate
                ? '[encore-scaler] spawn: Encore instance %s was reported by OSC during ' +
                    'the watch but its existence was NEVER CONFIRMED before the budget ' +
                    'ran out (workspace=%s) — failing the spawn with the create error. ' +
                    'This is INDETERMINATE, not absent: an instance under this name may ' +
                    'be live on OSC and this spawn cannot prove it owns it, so the ' +
                    'orphan reaper is what must reclaim it (#1286, #1327)'
                : '[encore-scaler] spawn: Encore instance %s never appeared after the ' +
                    'gateway timeouts (workspace=%s) — failing the spawn with the create ' +
                    'error; the next spawn for this workspace is backed off (#1286)',
            name,
            config.workspaceId
          );
        }
        // The CREATE's error is what propagates, never the probe's — the probe
        // is total (tryGetInstance) precisely so it cannot replace it.
        throw err;
      }
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
    // #1170: START the Encore half's readiness wait, do NOT await it yet.
    //
    // A pooled instance only becomes eligible for queued work once the pool
    // record below is written, and that record is written only after BOTH
    // halves report `running`. These two waits used to be SERIAL — the paired
    // callback listener was not even created until the Encore half was up — so
    // a workspace that needed a second instance paid for two full provisioning
    // waits end to end. That is the delay reported in #1170: the Encore half
    // (muxs3tn6) was ready at 07:21:59 with jobs queued, but its listener had
    // only just been created and the instance did not take a job until 07:26,
    // while the already-warm instance drained the whole queue in sequence. The
    // tick itself is blocked for that whole time too (EncoreScalerLoop.start
    // guards against overlapping ticks, scaler-loop.ts), so nothing else in the
    // control loop runs either.
    //
    // The listener's create only needs `encoreUrl`, which `createInstance`
    // already returned above — it does NOT need the Encore instance to be
    // `running`. So the create is issued immediately and the two readiness
    // waits overlap in the Promise.all below. Nothing downstream is weakened:
    // the record is still written only when both halves report `running`, and
    // the first job is still gated on the callback-trust probe
    // (ensureCallbackTrust, scaler-loop.ts) exactly as before.
    //
    // The no-op catch keeps a rejection that lands while the listener create is
    // still running from surfacing as an unhandled rejection; it attaches a
    // second handler and does not consume the rejection for the await below.
    const readinessAbort = new AbortController();
    // #1170 review finding: EVERYTHING from the start of the first wait down to
    // the Promise.all lives inside ONE try/finally, so the wait is aborted on
    // every exit from the block that started it — not only on the Promise.all
    // path. Three paths in between throw straight past that point:
    //   - the listener's getServiceAccessToken rejects,
    //   - a listener create that is non-transient or has exhausted maxAttempts,
    //   - `!callback` (loop fell through without an instance).
    // Each of those used to leave the Encore wait polling getInstanceHealth
    // once a second for up to 15 minutes after spawnPooledInstance had already
    // rejected — against an instance the catch below may have destroyed on its
    // way out. `encoreReady.catch(() => undefined)` silences that loop's
    // rejection, it does not stop the loop; only the abort does.
    try {
      const encoreReady = waitForSpawnedInstanceReady(
        ENCORE_SERVICE_ID,
        instanceId,
        config,
        readinessAbort.signal
      );
      encoreReady.catch(() => undefined);
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
      progress.secrets.push(callbackSat);
      // Retry callback listener creation with the same transient-error logic as
      // the Encore instance above. The OSC ingress webhook sometimes returns
      // ORCHESTRATOR_UNAVAILABLE under load; a short back-off is enough.
      let callback: OscInstance | undefined;
      let lastCallbackErr: unknown;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        progress.attempts += 1;
        try {
          const result = await createOrAdoptCallbackListener(
            config,
            instanceId,
            encoreUrl,
            callbackSat
          );
          callback = result.instance;
          listenerAdopted = result.adopted;
          break;
        } catch (err) {
          lastCallbackErr = err;
          // The adopt-on-"already taken" step lives in
          // createOrAdoptCallbackListener above, shared with
          // resolvePendingSpawns.
          const isTransient = isTransientOscError(err);
          if (!isTransient || attempt === maxAttempts) throw err;
          await new Promise((r) => setTimeout(r, attempt * 5_000));
        }
      }
      if (!callback) throw lastCallbackErr;
      listenerCreated = true;
      listenerUrl = instanceUrl(callback);
      // #1322 review finding 3: both halves now exist, so this spawn is done
      // asking the platform to create anything — every remaining step is the
      // readiness poll and the pool write. Tell the caller here, so an
      // admission slot taken to serialise CREATES is not also held for the
      // readiness budget (up to DEFAULT_SPAWN_READY_TIMEOUT_MS = 15 minutes of
      // node provisioning), which would block every other workspace's scale-up
      // long after the webhook burst this spawn caused was over.
      //
      // Deliberately after `listenerCreated`/`listenerUrl` are set, not before:
      // on this line the cleanup path already knows about both halves, so the
      // hook cannot run on a spawn whose listener is still unaccounted for.
      runSpawnHook(hooks?.onCreatesSettled, 'onCreatesSettled');
      // #1170: both halves are now provisioning; wait for them CONCURRENTLY
      // rather than one after the other. Each wait keeps its own deadline and
      // cadence (waitForSpawnedInstanceReady), and Promise.all rejects with the
      // first failure — which the cleanup path below classifies exactly as
      // before: a SpawnReadyTimeoutError keeps the instance and records it as a
      // PENDING pool entry for resolvePendingSpawns to finish. That pending
      // record now carries `callbackListenerUrl` even when it is the ENCORE half
      // that timed out, because the listener already exists by this point — the
      // "a timed-out spawn never got to the listener" case resolvePendingSpawns
      // documents is one less thing a resumed spawn has to redo.
      const listenerReady = waitForSpawnedInstanceReady(
        ENCORE_CALLBACK_LISTENER_SERVICE_ID,
        instanceId,
        config,
        readinessAbort.signal
      );
      listenerReady.catch(() => undefined);
      await Promise.all([encoreReady, listenerReady]);
    } finally {
      // Whichever way the readiness phase ends — both halves running, one half
      // timing out, or a throw before the second wait was even started — any
      // wait still in flight has nothing left to wait for. Aborting here, in
      // the same block the waits are started in, keeps the #778 property that
      // no health probe is issued once the spawn has settled: the abort checks
      // in waitForInstanceReadyBounded (src/services/instance-readiness.ts,
      // before the sleep and again after it) end the loop before its next
      // getInstanceHealth call. On the failure paths this runs BEFORE the catch
      // below starts its cleanup, so no probe races the destroy.
      readinessAbort.abort();
    }

    const readyAt = Date.now();
    const record: EncoreInstanceRecord = {
      instanceId,
      url: encoreUrl,
      callbackListenerUrl: listenerUrl,
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
    // #1071: TWO cases must NOT be torn down here.
    //
    //  a) ADOPTED. The instance was already on OSC when this spawn found it, so
    //     this spawn did not create it and must not destroy it — the same
    //     adopted-vs-created rule src/routes/provision.ts applies to rollback
    //     (#417/#736).
    //  b) STILL COMING UP. A readiness timeout (SpawnReadyTimeoutError) is not
    //     evidence of a broken instance: when OSC had to provision a new worker
    //     node the instance is simply not `running` yet. Destroying it threw
    //     away minutes of node provisioning and sent the next tick around the
    //     same loop.
    //
    // Neither is simply LEFT RUNNING either, which would be #778's billing leak
    // again: the orphan sweep deliberately refuses to destroy an instance whose
    // in-flight state it cannot confirm, so an instance that never becomes
    // reachable would survive every sweep forever, outside maxInstances, while
    // the next tick spawned a sibling beside it. Both cases are instead recorded
    // as a PENDING pool entry (recordPendingSpawn): tracked, counted against the
    // cap, never dispatched to, resumed by the next tick, and destroyed on its
    // own deadline if OSC still does not report it `running`.
    //
    // Everything else is cleaned up as before so it doesn't become an untracked
    // orphan. Best-effort: swallow cleanup errors so the original error is what
    // propagates to the caller.
    const stillComingUp = err instanceof SpawnReadyTimeoutError;
    const keepEncoreInstance = instanceAdopted || stillComingUp;
    if (keepEncoreInstance) {
      console.warn(
        '[encore-scaler] spawn failed but the Encore instance %s (workspace=%s) is ' +
          'NOT being destroyed (adopted=%s stillComingUp=%s) — recorded as a pending ' +
          'spawn for the next tick to resume (#1071)',
        instanceId,
        config.workspaceId,
        String(instanceAdopted),
        String(stillComingUp)
      );
      try {
        await recordPendingSpawn(config, {
          instanceId,
          url: encoreUrl,
          callbackListenerUrl: listenerCreated ? listenerUrl : undefined
        });
      } catch (recordErr) {
        // If the pending record cannot be written the instance is untracked, so
        // say so loudly: the orphan sweep is then the only thing that can clean
        // it up, and only once it can confirm the instance has no work.
        console.error(
          '[encore-scaler] could not record pending spawn for instance %s ' +
            '(workspace=%s) — it is live on OSC with no pool record (#1071):',
          instanceId,
          config.workspaceId,
          recordErr
        );
      }
    } else {
      try {
        await removeInstance(config.oscContext, ENCORE_SERVICE_ID, instanceId, sat);
      } catch {
        // Ignore — we're already in an error path.
      }
    }
    // #778 review finding 3: the paired callback listener leaks in exactly the
    // same way. If it was created before the failure (listener readiness wait or
    // the pool write threw), the same-named listener keeps running and billing,
    // and nothing else would ever remove it. Removed unconditionally when we know
    // it was created; a 404 is harmless either way. An ADOPTED listener, or one
    // whose Encore instance is being kept because it is still coming up, is left
    // alone for the same reasons as the instance above (#1071) — a listener with
    // no Encore instance is itself swept by the orphan reaper.
    if (listenerCreated && !listenerAdopted && !keepEncoreInstance) {
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

// Record an instance a failed spawn deliberately left running as a PENDING pool
// entry (#1071).
//
// The record is a normal EncoreInstanceRecord with `pendingReadySince` set and
// NO `readyAt`, which is what makes every existing path do the right thing with
// it: the scale-up gate counts it against maxInstances, dispatch skips it
// (scaler-loop step 5 checks pendingReadySince), the orphan sweep sees it as
// tracked and leaves it alone, and resolvePendingSpawns below either promotes or
// destroys it on the next tick.
async function recordPendingSpawn(
  config: EncoreScalerConfig,
  instance: { instanceId: string; url: string; callbackListenerUrl?: string }
): Promise<void> {
  const now = Date.now();
  await updateInstance(config.redis, config.workspaceId, {
    instanceId: instance.instanceId,
    url: instance.url,
    callbackListenerUrl: instance.callbackListenerUrl,
    activeJobs: 0,
    // No readyAt: this instance has never reported healthy. lastIdleAt is
    // stamped so the record still has a usable clock for anything that reads one.
    lastIdleAt: now,
    pendingReadySince: now
  });
}

// getInstanceHealth, reduced to "what OSC says, or nothing". Used by the pending
// resolver, where an unavailable answer is a normal state to wait through rather
// than an error to propagate.
async function instanceHealthOrUndefined(
  config: EncoreScalerConfig,
  serviceId: string,
  instanceId: string,
  token: string
): Promise<string | undefined> {
  try {
    return await getInstanceHealth(config.oscContext, serviceId, instanceId, token);
  } catch {
    return undefined;
  }
}

async function serviceTokenOrUndefined(
  config: EncoreScalerConfig,
  serviceId: string
): Promise<string | undefined> {
  try {
    return await config.oscContext.getServiceAccessToken(serviceId);
  } catch {
    return undefined;
  }
}

// #1109: back-off between the resolver's callback-listener create attempts for
// one pending instance. Exponential from 30s, capped at 5 minutes — the resolver
// runs once per tick (10s by default) against a readiness budget of 15 minutes
// (DEFAULT_SPAWN_READY_TIMEOUT_MS), so an uncapped per-tick retry meant ~90
// failing creates per stuck instance. With this it is at most a handful, and a
// listener that becomes creatable a minute in is still picked up well inside the
// budget. The schedule is deliberately coarser than spawnPooledInstance's
// 5s/10s: that loop blocks a single spawn and has to finish, this one spans
// ticks and only has to beat the deadline.
export const PENDING_LISTENER_CREATE_BACKOFF_BASE_MS = 30_000;
export const PENDING_LISTENER_CREATE_BACKOFF_MAX_MS = 300_000;

export function pendingListenerCreateBackoffMs(attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  // 2 ** (n - 1) is clamped before the multiply so a wild attempt count cannot
  // overflow into Infinity on the way to the cap.
  const factor = Math.min(2 ** Math.min(n - 1, 20), Number.MAX_SAFE_INTEGER);
  return Math.min(
    PENDING_LISTENER_CREATE_BACKOFF_BASE_MS * factor,
    PENDING_LISTENER_CREATE_BACKOFF_MAX_MS
  );
}

// Resolve every PENDING pool entry for this workspace (#1071): FINISH the spawns
// that can be finished, destroy the ones that have run out of time.
//
// This is what keeps a readiness timeout from becoming either a leak or a
// stampede. Called once per tick, before the scale-up gate, so that:
//   - an instance whose node finished provisioning is picked up and used, rather
//     than a second one being spawned beside it;
//   - an instance that is never going to come up is destroyed on a deadline we
//     own, instead of surviving indefinitely because the orphan sweep (rightly)
//     refuses to act on an instance whose in-flight state it cannot confirm.
//
// PROMOTION IS NOT JUST "THE INSTANCE IS UP". A spawn whose Encore readiness wait
// timed out never reached the code that creates the paired callback listener, so
// its pending record has no callbackListenerUrl — and an Encore instance with no
// listener completes jobs into nowhere: dispatch omits progressCallbackUri and
// every job silently falls back to the terminal-job sweep, with nothing visible
// on GET /scaler/status. (The trust gate cannot catch it either: ensureCallbackTrust
// fails OPEN on a missing listener URL, which is only sound for reconcile-from-OSC
// adoptions, where the listener genuinely exists.) So this function COMPLETES the
// spawn instead: it creates (or adopts) the missing listener, and only promotes
// the instance once the listener exists AND OSC reports both halves `running`.
// Each step is one tick's worth of work — no blocking waits inside the tick — and
// an instance that cannot be completed stays pending until its deadline, where a
// clean spawn replaces it.
//
// The destroy decision is AUTHORITATIVE, not inferred: getInstanceHealth is
// OSC's own view of the instance (@osaas/client-core lib/core.d.ts:86, the same
// call the SDK's waitForInstanceReady gates on). An instance OSC does not report
// as `running` cannot be mid-transcode, so destroying it past the deadline
// cannot interrupt work. A health probe that throws is treated the same way
// after the deadline — the instance has then been unreachable AND not-running
// for a whole extra readiness budget.
//
// A promoted instance is deliberately one tick behind for dispatch: it is written
// back here, and step 5 of the SAME tick already holds the instance list it read
// at step 2. The next tick dispatches to it (and runs its callback-trust probe).
// That is at most one tick of latency on an instance that has already been minutes
// in the making, in exchange for never dispatching against a half-written record.
//
// Returns the ids promoted and destroyed (for logging/tests). Never throws: a
// failure here must not take out the tick.
export async function resolvePendingSpawns(
  config: EncoreScalerConfig
): Promise<{ promoted: string[]; destroyed: string[] }> {
  const promoted: string[] = [];
  const destroyed: string[] = [];

  let instances: EncoreInstanceRecord[];
  try {
    instances = await listInstances(config.redis, config.workspaceId);
  } catch {
    return { promoted, destroyed };
  }
  const pending = instances.filter(
    (inst) => typeof inst.pendingReadySince === 'number'
  );
  if (pending.length === 0) return { promoted, destroyed };

  const graceMs = config.spawnReadyTimeoutMs ?? DEFAULT_SPAWN_READY_TIMEOUT_MS;
  let sat: string;
  try {
    sat = await config.oscContext.getServiceAccessToken(ENCORE_SERVICE_ID);
  } catch {
    return { promoted, destroyed };
  }

  for (const inst of pending) {
    let record = inst;
    const health = await instanceHealthOrUndefined(
      config,
      ENCORE_SERVICE_ID,
      inst.instanceId,
      sat
    );
    let blockedBy: string | undefined;

    if (health === 'running') {
      // Step 1: the Encore half is up. Make sure it has a callback listener —
      // the readiness timeout may well have struck before the spawn ever created
      // one. Best effort per tick; a failure leaves the record pending and is
      // retried on the next tick until the deadline.
      if (!record.callbackListenerUrl) {
        // #1109: this create is retried ACROSS ticks, so the "should I try
        // again?" decision the spawn path makes inside its own loop has to be
        // persisted on the record instead. Two gates come first:
        //
        //   a) a create that already failed PERMANENTLY is never attempted
        //      again — the instance simply runs out its deadline below;
        //   b) a create that failed transiently waits out its back-off.
        //
        // Previously neither existed and the resolver issued one create per
        // tick until the deadline (~90 against the OSC API for a 15-minute
        // budget at a 10s tick), including for errors that could never succeed.
        const now = Date.now();
        if (record.listenerCreateBlockedAt !== undefined) {
          blockedBy = 'callback listener create failed permanently';
        } else if (
          record.listenerCreateNextAttemptAt !== undefined &&
          now < record.listenerCreateNextAttemptAt
        ) {
          blockedBy = 'callback listener create backing off';
        } else {
          try {
            const callbackSat = await config.oscContext.getServiceAccessToken(
              ENCORE_CALLBACK_LISTENER_SERVICE_ID
            );
            const { instance: listener } = await createOrAdoptCallbackListener(
              config,
              record.instanceId,
              record.url,
              callbackSat
            );
            // The listener exists: drop the back-off bookkeeping so the record
            // that gets promoted is a normal one.
            const {
              listenerCreateAttempts: _attempts,
              listenerCreateNextAttemptAt: _nextAttemptAt,
              ...completed
            } = record;
            record = { ...completed, callbackListenerUrl: instanceUrl(listener) };
            await updateInstance(config.redis, config.workspaceId, record);
            console.warn(
              '[encore-scaler] pending spawn %s (workspace=%s): created the paired ' +
                'callback listener its timed-out spawn never got to (#1071)',
              record.instanceId,
              config.workspaceId
            );
          } catch (err) {
            // EXACTLY the spawn path's classification (spawnPooledInstance
            // above), not a second one: isTransientOscError on the error's
            // structural httpCode, plus the "name is already taken but
            // getInstance could not confirm it" case the spawn loop also treats
            // as retry-worthy — the name being taken is strong evidence the
            // listener exists, and the name is fixed so a retry cannot
            // duplicate it. createOrAdoptCallbackListener has already tried the
            // adoption and re-thrown, so reaching here means unconfirmed.
            const retryable =
              isTransientOscError(err) || isNameAlreadyTakenError(err);
            const attempts = (record.listenerCreateAttempts ?? 0) + 1;
            record = retryable
              ? {
                  ...record,
                  listenerCreateAttempts: attempts,
                  listenerCreateNextAttemptAt:
                    now + pendingListenerCreateBackoffMs(attempts)
                }
              : {
                  ...record,
                  listenerCreateAttempts: attempts,
                  listenerCreateBlockedAt: now
                };
            // Best effort: a failed bookkeeping write only costs the back-off
            // (the next tick retries as it always did) and must never take out
            // the tick — this function does not throw.
            await updateInstance(config.redis, config.workspaceId, record).catch(
              () => undefined
            );
            blockedBy = retryable
              ? 'callback listener could not be created'
              : 'callback listener create failed permanently';
            console.error(
              '[encore-scaler] pending spawn %s (workspace=%s): could not create its ' +
                'paired callback listener (attempt=%d retryable=%s) — NOT promoted, ' +
                'because an instance with no listener completes jobs into nowhere; ' +
                '%s (#1071/#1109):',
              record.instanceId,
              config.workspaceId,
              attempts,
              String(retryable),
              retryable
                ? `retrying no sooner than ${pendingListenerCreateBackoffMs(attempts)}ms from now`
                : 'no further attempts will be made, it will be destroyed on its deadline',
              err
            );
          }
        }
      }

      // Step 2: both halves must be up before this instance may take work.
      if (record.callbackListenerUrl) {
        const callbackSat = await serviceTokenOrUndefined(
          config,
          ENCORE_CALLBACK_LISTENER_SERVICE_ID
        );
        const listenerHealth = callbackSat
          ? await instanceHealthOrUndefined(
              config,
              ENCORE_CALLBACK_LISTENER_SERVICE_ID,
              record.instanceId,
              callbackSat
            )
          : undefined;
        if (listenerHealth === 'running') {
          const now = Date.now();
          const { pendingReadySince, ...rest } = record;
          try {
            await updateInstance(config.redis, config.workspaceId, {
              ...rest,
              lastIdleAt: now,
              readyAt: now
            });
            promoted.push(record.instanceId);
            console.warn(
              '[encore-scaler] pending spawn %s (workspace=%s) is fully up after ' +
                '%dms (instance and callback listener) and joined the pool — the node ' +
                'it was waiting for finished provisioning (#1071)',
              record.instanceId,
              config.workspaceId,
              now - (pendingReadySince ?? now)
            );
            continue;
          } catch (err) {
            console.error(
              '[encore-scaler] could not promote pending spawn %s (workspace=%s):',
              record.instanceId,
              config.workspaceId,
              err
            );
          }
        } else {
          blockedBy = `callback listener health=${String(listenerHealth ?? 'unavailable')}`;
        }
      }
    } else {
      blockedBy = `instance health=${String(health ?? 'unavailable')}`;
    }

    const waitedMs = Date.now() - (record.pendingReadySince ?? 0);
    if (waitedMs < graceMs) continue; // still inside its extra budget

    try {
      // Claim the record BEFORE tearing anything down, so two overlapping
      // resolvers (a slow tick overlapping the next) cannot both issue the OSC
      // teardown: hdel returns 1 for exactly one of them. destroyInstance's own
      // pool-record delete then becomes a no-op.
      const claimed = await config.redis.hdel(
        keys.pool(config.workspaceId),
        record.instanceId
      );
      if (claimed === 0) continue; // another resolver already owns this teardown
      // destroyInstance tears down the Encore instance AND its paired callback
      // listener.
      await destroyInstance(record.instanceId, config);
      destroyed.push(record.instanceId);
      console.warn(
        '[encore-scaler] pending spawn %s (workspace=%s) could not be completed ' +
          'after %dms (%s) — destroyed rather than left billing; the next scale-up ' +
          'starts a clean spawn (#1071)',
        record.instanceId,
        config.workspaceId,
        waitedMs,
        blockedBy ?? 'reason unknown'
      );
    } catch (err) {
      // Put the record back so the next tick retries the teardown rather than
      // losing track of a live instance.
      console.error(
        '[encore-scaler] could not destroy stuck pending spawn %s (workspace=%s):',
        record.instanceId,
        config.workspaceId,
        err
      );
      await updateInstance(config.redis, config.workspaceId, record).catch(
        () => undefined
      );
    }
  }

  return { promoted, destroyed };
}

// Tear down an Encore OSC instance and drop it from the pool hash. Idempotent:
// a removeInstance for an already-gone instance is tolerated.
export async function destroyInstance(
  instanceId: string,
  config: EncoreScalerConfig
): Promise<void> {
  const sat = await config.oscContext.getServiceAccessToken(ENCORE_SERVICE_ID);
  console.info(
    '[encore-scaler] destroy: removing Encore instance %s and its callback listener (workspace=%s)',
    instanceId,
    config.workspaceId
  );
  try {
    await removeInstance(config.oscContext, ENCORE_SERVICE_ID, instanceId, sat);
  } catch (err) {
    // Already gone on OSC — treat as success so the pool record is still
    // cleaned up below. Any other error means the instance may still be
    // running: keep the pool record so the next tick retries rather than
    // spawning a replacement for something that's still alive.
    //
    // #1213: classified on the error's `httpCode` (isInstanceAlreadyGoneError)
    // rather than by substring-matching its message. `removeInstance` rejects
    // with a FetchError whose message is the SERVER's body text, so a genuine
    // 404 from the instances endpoint ("Instance not found", an HTML error
    // page, or a JSON `reason`) need not contain the digits "404" at all; this
    // check used to re-throw those, which aborted the teardown of every
    // remaining instance in WorkspaceEncoreScalerRegistry.teardown().
    if (!isInstanceAlreadyGoneError(err)) throw err;
    console.info(
      '[encore-scaler] destroy: Encore instance %s was already removed on OSC (%s) — continuing with its callback listener (workspace=%s)',
      instanceId,
      err instanceof Error ? err.message : String(err),
      config.workspaceId
    );
  }
  // Best-effort teardown of the paired callback listener (same name). It may
  // already be gone, which is the normal case on a retried stack teardown, so
  // that outcome is reported as done rather than as a failure (#1213); a
  // genuine failure is still logged for the orphan reaper (#778) to pick up.
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
  } catch (err) {
    if (isInstanceAlreadyGoneError(err)) {
      console.info(
        '[encore-scaler] destroy: callback listener %s was already removed on OSC — nothing to release (workspace=%s)',
        instanceId,
        config.workspaceId
      );
    } else {
      // Nothing more to do here; the orphan reaper (#778) picks up a listener
      // that outlives its instance.
      console.warn(
        '[encore-scaler] destroy: callback listener %s removal failed (workspace=%s): %s',
        instanceId,
        config.workspaceId,
        err instanceof Error ? err.message : String(err)
      );
    }
  }
  // Only drop the pool record after OSC removal succeeds (or confirmed gone).
  // Dropping it on a transient failure would cause the pool to lose track of a
  // still-running instance, making the next tick spawn a replacement — which is
  // exactly the runaway-spawning bug this fixes.
  //
  // #1213: tolerant of an already-removed BACKEND. On a stack teardown this
  // runs while (or after) the stack's own Valkey is being deprovisioned, so
  // this write can reject with ECONNREFUSED. The OSC instances are already
  // gone at this point, and the whole key space is about to disappear with the
  // store, so a failed bookkeeping delete must not propagate — it used to
  // abort the teardown loop and leave the remaining instances (and their
  // callback listeners) running and billing.
  try {
    await config.redis.hdel(keys.pool(config.workspaceId), instanceId);
  } catch (err) {
    console.warn(
      '[encore-scaler] destroy: removed %s on OSC but failed to drop its pool record (workspace=%s): %s',
      instanceId,
      config.workspaceId,
      err instanceof Error ? err.message : String(err)
    );
  }
}

// Evict pool records whose Encore instance no longer exists on OSC.
//
// reconcile() keeps an instance whose Encore API cannot be reached: an outage
// mid-job must never cost the job. But a pool record can also outlive its
// instance — a teardown that removed the Encore instance and died before the
// pool write, or an instance removed outside the scaler. Such a record is
// permanently "unreachable": it is counted as idle capacity (activeJobs 0), so
// the loop never scales up, every dispatch to it fails and re-queues the job,
// and the queue sits there for good. Observed on OSC as a job `running` for 16+
// minutes with queueDepth 1 and one pool instance that no longer existed.
//
// Only the ids the caller found unreachable are checked, against OSC's own
// list of the Encore service — the authoritative existence answer (getInstance
// swallows every error but 401, so its undefined means "could not confirm", not
// "gone"). An instance OSC still lists is kept, as before. One that is absent is
// destroyed through destroyInstance, which tolerates the 404 on the Encore
// removal, removes the paired callback listener (the half of the pair that was
// left behind on OSC) and drops the pool record. A listing failure evicts
// nothing. Returns the evicted ids so the loop can re-queue the jobs that were
// mapped to them.
export async function evictVanishedInstances(
  config: EncoreScalerConfig,
  unreachableIds: readonly string[]
): Promise<string[]> {
  if (unreachableIds.length === 0) return [];
  let onOsc: OscInstance[];
  try {
    const sat = await config.oscContext.getServiceAccessToken(ENCORE_SERVICE_ID);
    onOsc = (await oscListInstances(config.oscContext, ENCORE_SERVICE_ID, sat)) as OscInstance[];
    if (!Array.isArray(onOsc)) return [];
  } catch {
    // Cannot confirm anything this pass; the records stay and are re-checked
    // on the next tick.
    return [];
  }
  const existing = new Set<string>();
  for (const inst of onOsc) {
    if (typeof inst.name === 'string' && inst.name.length > 0) existing.add(inst.name);
  }
  const evicted: string[] = [];
  for (const instanceId of unreachableIds) {
    if (existing.has(instanceId)) continue;
    console.warn(
      '[encore-scaler] reconcile: pool instance %s is unreachable and no longer exists on OSC ' +
        '(workspace=%s) — evicting its pool record and removing its callback listener',
      instanceId,
      config.workspaceId
    );
    try {
      await destroyInstance(instanceId, config);
      evicted.push(instanceId);
    } catch (err) {
      console.error(
        '[encore-scaler] reconcile: failed to evict vanished instance %s (workspace=%s):',
        instanceId,
        config.workspaceId,
        err
      );
    }
  }
  return evicted;
}

// Default grace window for the orphan reaper (#778): how long an instance must
// be continuously observed running on OSC with NO pool record before it is
// destroyed. It must comfortably exceed a worst-case spawn, which holds exactly
// that state (live OSC instance, pool record not yet written).
//
// That worst case is now BOUNDED (#778 review finding 4): two readiness waits of
// at most DEFAULT_SPAWN_READY_TIMEOUT_MS (Encore instance + paired callback
// listener) plus up to two 5s/10s transient createInstance retries on each.
//
// #1071 raised DEFAULT_SPAWN_READY_TIMEOUT_MS to 15 minutes to accommodate OSC
// provisioning a new worker node, which moves that worst case to ~30.5 minutes —
// past the old 20-minute window. Left at 20 the reaper would have started
// destroying instances WHILE THEIR OWN SPAWN WAS STILL WAITING ON THEM, which is
// precisely the failure it was built to avoid, so the window moves with it. 45
// minutes keeps the same kind of headroom over the new worst case, and the
// reaper additionally needs TWO sweeps (the first sighting only starts the
// clock) and a positive no-work confirmation before it acts.
export const DEFAULT_ORPHAN_GRACE_MS = 45 * 60_000;

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
        // `running` after a slow spawn. Never destroy on an unconfirmed count
        // from the instance itself... but do not stop there either: an instance
        // that never becomes reachable used to survive EVERY sweep forever,
        // which is the billing leak this reaper exists to close (#1071 review).
        //
        // So fall back to OSC's own view of the instance. getInstanceHealth
        // (@osaas/client-core lib/core.d.ts:86) is authoritative and does not
        // depend on the instance answering our HTTP calls: an instance OSC does
        // not report as `running`, a whole grace window after it was first seen
        // orphaned, cannot be running a transcode, so destroying it cannot
        // interrupt work. Only a `running`-but-unreachable instance is still
        // left alone, because that one really could be mid-job behind a network
        // problem.
        let health: string | undefined;
        try {
          const sat = await config.oscContext.getServiceAccessToken(ENCORE_SERVICE_ID);
          health = await getInstanceHealth(
            config.oscContext,
            ENCORE_SERVICE_ID,
            instanceId,
            sat
          );
        } catch {
          health = undefined;
        }
        if (health === 'running') {
          console.warn(
            '[encore-scaler] orphan sweep: could not confirm real in-flight state for ' +
              'orphaned instance %s (workspace=%s), and OSC reports it running — ' +
              'NOT reaped this sweep (#778)',
            instanceId,
            config.workspaceId
          );
          continue;
        }
        console.warn(
          '[encore-scaler] orphan sweep: orphaned instance %s (workspace=%s) is ' +
            'unreachable and OSC does not report it running (health=%s) — it cannot ' +
            'be mid-transcode, so it is being reaped rather than left billing (#1071)',
          instanceId,
          config.workspaceId,
          String(health ?? 'unavailable')
        );
        // Falls through to the teardown below.
      } else {
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
          // against it). Do NOT destroy it: ADOPT it into the pool so the
          // existing drain-don't-kill logic (#513) and the packaging pin (#525
          // pt.2) own its teardown, exactly as they do for every other instance.
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
