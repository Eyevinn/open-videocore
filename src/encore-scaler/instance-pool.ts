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
  removeInstance,
  waitForInstanceReady
} from '@osaas/client-core';
import { keys, type EncoreInstanceRecord, type EncoreScalerConfig } from './types.js';

// Encore's OSC service identifier. Not hardcoded at the call sites — sourced
// from the provisioning contract (STACK_SERVICES / provision route) via this
// single constant so a future rename is a one-line change.
export const ENCORE_SERVICE_ID = 'encore';

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
      instance = (await createInstance(
        config.oscContext,
        ENCORE_SERVICE_ID,
        sat,
        { name }
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

  const record: EncoreInstanceRecord = {
    instanceId,
    url: instanceUrl(instance),
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
  try {
    await removeInstance(config.oscContext, ENCORE_SERVICE_ID, instanceId, sat);
  } finally {
    // Always drop the pool record so a stuck instance cannot pin the pool at
    // maxInstances forever, even if the OSC removeInstance call errored.
    await config.redis.hdel(keys.pool(config.workspaceId), instanceId);
  }
}
