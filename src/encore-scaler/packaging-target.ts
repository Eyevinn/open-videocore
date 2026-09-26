// Resolving the packager's input for a completed Encore transcode (issue #739).
//
// The packager's work item is `{ jobId, url }` where `url` is an Encore job API
// URL it fetches to locate the transcoded output (CONTRACT: `PackagingJob`,
// src/pipeline/packaging.ts, verified from the packager's redisListener.ts).
// Dispatching packaging therefore needs two things, and every caller needs BOTH:
//
//   url        — what the packager fetches.
//   instanceId — the Encore instance serving that url, so the caller can pin it
//                against scale-down (#525 pt.2, packaging-pin.ts) and release
//                the pin afterwards.
//
// Why this is not a one-line Redis read: the two keys that used to answer it
// have different lifetimes.
//
//   keys.jobInstance  — the LIVE job->instance mapping, hdel'd the instant a
//                       transcode succeeds (encore-callback-poller.ts) so the
//                       finished job stops being a dropped-job candidate.
//   keys.jobEncoreUrl — the full URL, written at dispatch (scaler-loop.ts) with
//                       a 24h TTL; survives the hdel and pool teardown.
//   keys.jobTerminalInstance — the instance, retained past terminal with the
//                       same 24h TTL (issue #739), written by the poller from
//                       the same read it takes for `terminalInstanceId`.
//
// Any resolver that reads only keys.jobInstance is dead for exactly the case
// packaging cares about: a transcode that has already SUCCEEDED. That is the
// defect this module exists to remove, and why both the package-only pipeline
// and the direct POST /:id/package route go through it.
//
// Liveness is deliberately still required. A resolved url is only useful if the
// instance is still in the pool — the packager has to fetch it asynchronously,
// and there is nothing to pin on an instance that is gone. So resolution
// confirms the pool record before returning; an unresolvable target and a target
// the packager could never reach are the same condition, which lets callers
// refuse up front (409) instead of enqueueing a job that would stall for the
// stalled-package reconciler's full timeout.
import type { Redis } from 'ioredis';
import { keys, type EncoreInstanceRecord } from './types.js';
import { decodeEncoreJobId } from '../data/job-repo.js';

export type PackagingTarget = {
  // The Encore job API URL the packager fetches: `{instanceUrl}/encoreJobs/{uuid}`.
  url: string;
  // The pool instance serving `url`. Present because resolution alone is a
  // point-in-time check: the caller must pin this instance before enqueueing.
  instanceId: string;
};

type ReadRedis = Pick<Redis, 'get' | 'hget'>;

// Which Encore instance ran this job, whether or not the job is still live.
// Prefers the terminal-surviving mapping, falling back to the live one for jobs
// that are still running (and for jobs dispatched before jobTerminalInstance
// existed, whose live mapping is still present until they succeed).
export async function resolvePackagingInstanceId(
  redis: ReadRedis | undefined,
  encoreJobId: string
): Promise<string | undefined> {
  if (!redis) return undefined;
  const terminal = await redis.get(keys.jobTerminalInstance(encoreJobId));
  if (terminal) return terminal;
  const decoded = decodeEncoreJobId(encoreJobId);
  if (!decoded) return undefined;
  return (await redis.hget(keys.jobInstance(decoded.workspaceId), encoreJobId)) ?? undefined;
}

// Resolve the packager's `{ url, instanceId }` input for a transcode job.
// Returns undefined when the job's instance cannot be identified, is no longer
// in the pool, or no URL can be produced for it.
export async function resolvePackagingTarget(
  redis: ReadRedis | undefined,
  encoreJobId: string
): Promise<PackagingTarget | undefined> {
  if (!redis) return undefined;
  const decoded = decodeEncoreJobId(encoreJobId);
  if (!decoded) return undefined;
  const instanceId = await resolvePackagingInstanceId(redis, encoreJobId);
  if (!instanceId) return undefined;

  // Liveness gate: the packager must be able to reach this instance, and a pin
  // on an instance with no pool record is meaningless.
  const instanceJson = await redis.hget(keys.pool(decoded.workspaceId), instanceId);
  if (!instanceJson) return undefined;
  let record: EncoreInstanceRecord;
  try {
    record = JSON.parse(instanceJson) as EncoreInstanceRecord;
  } catch {
    return undefined;
  }

  // Fast path: the URL stored at dispatch time. Preferred over reconstruction
  // for the same reason the callback poller and the internal router prefer it
  // (src/pipeline/encore-callback-poller.ts, src/routes/internal.ts) — it is
  // exactly the URL the job was dispatched to, with no second key to miss.
  const direct = await redis.get(keys.jobEncoreUrl(encoreJobId));
  if (direct) return { url: direct, instanceId };

  // Fallback: reconstruct from the pool record + UUID, for jobs dispatched
  // before the direct-URL key was introduced.
  const encoreUuid = await redis.get(keys.jobUuid(encoreJobId));
  if (!encoreUuid) return undefined;
  return {
    url: `${record.url.replace(/\/+$/, '')}/encoreJobs/${encoreUuid}`,
    instanceId
  };
}
