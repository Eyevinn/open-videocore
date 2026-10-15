// Resolving WHERE to POST the Encore cancel for one of our jobs (issue #1219).
//
// An operator pressing Cancel must stop the job on the Encore instance that is
// actually running it. That needs the full Encore job URL
// `{instanceUrl}/encoreJobs/{uuid}`, because the cancel endpoint is per-instance
// and per-UUID:
//
//   POST {instanceUrl}/encoreJobs/{uuid}/cancel — SVT Encore EncoreController.kt
//   (github.com/svt/encore, encore-web/.../controller/EncoreController.kt),
//   mirrored by EncoreClient.cancel (src/pipeline/encore-client.ts:53-58,
//   142-161) and by #745's prior-attempt canceler
//   (src/encore-scaler/retry-store.ts:85-115). 404 (job gone) / 409 (terminal)
//   are idempotent no-ops.
//
// Why this is not a one-line Redis read — the same lifetime problem
// resolvePackagingTarget documents (src/encore-scaler/packaging-target.ts:13-28):
//
//   keys.jobInstance         — the LIVE job->instance mapping. hdel'd the moment
//                              a transcode succeeds (encore-callback-poller.ts),
//                              when a scale-down/transport retry re-enqueues the
//                              job (retry-store.ts:231,361) and on the dropped-job
//                              path. A cancel that depends on it is dead for any
//                              job whose mapping has already been cleared.
//   keys.pool                — only holds instances still in the pool; the record
//                              is gone once the instance is torn down or replaced.
//   keys.jobEncoreUrl        — the exact URL the job was dispatched to, written at
//                              dispatch with a 24h TTL (scaler-loop.ts:2301).
//                              Survives the hdel AND pool teardown.
//   keys.jobTerminalInstance — the instance that ran the job, retained past
//                              terminal with the same 24h TTL (issue #739).
//
// #1219 is exactly the "mapping already cleared" case: a FROZEN job is the kind
// of job whose live mapping gets cleared or repaired underneath it, and a cancel
// resolved only from keys.jobInstance + keys.pool then silently POSTs nothing
// while Videocore still records CANCELLED — the job keeps running on Encore.
//
// Unlike resolvePackagingTarget this resolver deliberately does NOT gate on pool
// liveness. Packaging needs an instance it can pin and fetch from later; a cancel
// only needs an address to POST to, and the instance most worth cancelling is
// precisely the one the scaler no longer tracks. An unreachable address fails the
// POST, which is reported, rather than being pre-emptively skipped.
import type { Redis } from 'ioredis';
import { keys, type EncoreInstanceRecord } from './types.js';

type ReadRedis = Pick<Redis, 'get' | 'hget'>;

// Resolve the full Encore job URL for `encoreJobId` (our externalId), or
// undefined when the job has no recorded dispatch at all (never dispatched, or
// its 24h dispatch keys have expired) and so has nothing to cancel.
//
// Order: the dispatch-time URL first (no second key to miss), then
// reconstruction from the instance that ran the job + its UUID.
export async function resolveEncoreCancelUrl(
  redis: ReadRedis,
  workspaceId: string,
  encoreJobId: string
): Promise<string | undefined> {
  // (1) The URL recorded at dispatch time. Same key, and same preference order,
  // as the callback poller (src/pipeline/encore-callback-poller.ts:386), the
  // internal router (src/routes/internal.ts:229) and #745's re-dispatch cancel
  // (src/encore-scaler/retry-store.ts:131).
  const direct = await redis.get(keys.jobEncoreUrl(encoreJobId));
  if (direct) return direct;

  // (2) Reconstruct from the instance + UUID, for jobs dispatched before the
  // direct-URL key existed. Prefer the terminal-surviving instance mapping
  // (issue #739) over the live one, which may already be hdel'd.
  const encoreUuid = await redis.get(keys.jobUuid(encoreJobId));
  if (!encoreUuid) return undefined;

  const instanceId =
    (await redis.get(keys.jobTerminalInstance(encoreJobId))) ??
    (await redis.hget(keys.jobInstance(workspaceId), encoreJobId));
  if (!instanceId) return undefined;

  const poolRaw = await redis.hget(keys.pool(workspaceId), instanceId);
  if (!poolRaw) return undefined;
  let record: EncoreInstanceRecord;
  try {
    record = JSON.parse(poolRaw) as EncoreInstanceRecord;
  } catch {
    return undefined;
  }
  if (!record.url) return undefined;
  return `${record.url.replace(/\/+$/, '')}/encoreJobs/${encoreUuid}`;
}
