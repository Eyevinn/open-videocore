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
  // stable prefix. Using the same sanitisation as spawnInstance (line 88).
  const prefix = `scaler${config.workspaceId.replace(/[^a-z0-9]/gi, '').toLowerCase()}`;
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
      lastIdleAt: now
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
  const name = `scaler${config.workspaceId.replace(/[^a-z0-9]/gi, '').toLowerCase()}${Date.now().toString(36)}`;

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
      const isTransient = msg.includes('500') || msg.includes('502') || msg.includes('503') || msg.includes('ECONNRESET') || msg.includes('context deadline exceeded');
      if (!isTransient || attempt === maxAttempts) throw err;
      // Exponential back-off: 5s, 10s.
      await new Promise((r) => setTimeout(r, attempt * 5_000));
    }
  }
  if (!instance) throw lastErr;

  const instanceId = instanceName(instance);
  await waitForInstanceReady(ENCORE_SERVICE_ID, instanceId, config.oscContext);
  const encoreUrl = instanceUrl(instance);

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
  const callback = (await createInstance(
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
  await waitForInstanceReady(
    ENCORE_CALLBACK_LISTENER_SERVICE_ID,
    instanceId,
    config.oscContext
  );

  const record: EncoreInstanceRecord = {
    instanceId,
    url: encoreUrl,
    callbackListenerUrl: instanceUrl(callback),
    activeJobs: 0,
    lastIdleAt: Date.now()
  };
  await updateInstance(config.redis, config.workspaceId, record);
  return record;
}

// Tear down an Encore OSC instance and drop it from the pool hash. Idempotent:
// a removeInstance for an already-gone instance is tolerated.
export async function destroyInstance(
  instanceId: string,
  config: EncoreScalerConfig
): Promise<void> {
  const sat = await config.oscContext.getServiceAccessToken(ENCORE_SERVICE_ID);
  await removeInstance(config.oscContext, ENCORE_SERVICE_ID, instanceId, sat);
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
  // Only drop the pool record after OSC removal succeeds. Dropping it before
  // or on OSC failure would cause the pool to lose track of a still-running
  // instance, which makes the next tick think it can spawn a replacement.
  await config.redis.hdel(keys.pool(config.workspaceId), instanceId);
}
