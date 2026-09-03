// Packaging-pin bookkeeping (#525 pt.2): keeps a just-finished Encore instance
// alive, from the scaler's point of view, until the packager has actually had
// a chance to reach its /encoreJobs/{uuid} endpoint and fetch the completed
// job's output.
//
// Why this exists: scaler-loop.ts's scale-down eligibility check asks Encore's
// own /encoreJobs/search/findByStatus (fetchRealActiveState) whether an
// instance has real in-flight work. The instant a transcode job finishes,
// Encore itself reports it terminal, so the instance can look completely idle
// to the scaler in the SAME tick the transcode->package handoff still needs
// it alive. With minInstances:0 and a short idleTimeoutMs this is a real,
// reproducible race: the scaler destroys the instance before
// eyevinn-encore-packager (consuming its queue asynchronously) gets to GET
// that instance's job document, and packaging fails with "Encore instance no
// longer available for packaging" even though the transcode itself succeeded
// (#525) -- previously misdiagnosed as a URL-bookkeeping gap because it
// presents with the exact same error text; this is a genuinely different,
// physical-teardown race that a URL fix alone cannot close.
//
// pin() is called at the transcode->package handoff, for the instance that
// ran the just-completed job, BEFORE the tracked activeJobs count is
// decremented (the signal scale-down's idle clock keys off). unpin() is
// called once packaging is known to be done with that instance -- the
// packager's success callback carries our jobId, so that path unpins
// precisely. The packager's FAILURE callback carries no jobId (a known
// encore-packager contract gap -- docs/osc-feedback/incoming-encore-packager-
// contract.md), so a failure cannot always be correlated back to unpin its
// specific entry; the TTL below self-heals that case rather than pinning an
// instance forever.
import type { Redis } from 'ioredis';
import { keys } from './types.js';
import { DEFAULT_PACKAGE_STALL_TIMEOUT_MS } from '../pipeline/stalled-package-reconciler.js';

// Mirrors the bound stalled-package-reconciler.ts uses to fail a stuck
// `package` step -- by the time a pin would outlive that, the execution it
// belonged to has already been failed independently, so nothing is still
// waiting on this instance and the pin is safe to let expire.
export { DEFAULT_PACKAGE_STALL_TIMEOUT_MS as DEFAULT_PACKAGING_PIN_TTL_MS };

export async function pinInstanceForPackaging(
  redis: Pick<Redis, 'sadd' | 'pexpire'>,
  instanceId: string,
  encoreJobId: string,
  ttlMs: number = DEFAULT_PACKAGE_STALL_TIMEOUT_MS
): Promise<void> {
  const key = keys.pendingPackaging(instanceId);
  await redis.sadd(key, encoreJobId);
  // Refresh the whole set's TTL on every pin so a busy instance's pin outlives
  // its most recently added job, not its first.
  await redis.pexpire(key, ttlMs);
}

export async function unpinInstanceForPackaging(
  redis: Pick<Redis, 'srem'>,
  instanceId: string,
  encoreJobId: string
): Promise<void> {
  await redis.srem(keys.pendingPackaging(instanceId), encoreJobId);
}

export async function hasPendingPackaging(
  redis: Pick<Redis, 'scard'>,
  instanceId: string
): Promise<boolean> {
  const count = await redis.scard(keys.pendingPackaging(instanceId));
  return count > 0;
}
