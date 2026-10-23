// Cancellation is terminal: a job a caller cancelled must never be resumed or
// re-enqueued (#1225).
//
// The scaler has two re-enqueue paths that rebuild a job from its stored payload
// and push it back onto the queue:
//   - scale-down recovery (scaler-loop.ts requeueScaleDownInterruptions, #514),
//     which also runs for an instance OSC confirms no longer exists
//     (reconcile()'s vanished-instance eviction), and
//   - dropped-job reconciliation (scaler-loop.ts reconcile()'s drop diff ->
//     onJobsDropped -> the retry gate, #449/#727).
// Both gate on the job's LOCAL status being non-terminal. That gate is not
// sufficient on its own, because the status hash is last-writer-wins and the
// dispatch/re-dispatch paths pin it back to running:
//   - scaler-loop.ts dispatch(): hset(keys.jobStatus, jobId, 'running')
//   - retry-store.ts requeueInterruptedByScaleDown/decideRetry: hset(..., 'RUNNING')
// so a cancel that races a claimed dispatch loses its 'CANCELLED' status and the
// job becomes a recovery candidate again. The cancellation tombstone below is a
// monotonic, write-once record that nothing on the recovery path overwrites.
//
// CONTRACT SOURCES VERIFIED (CLAUDE.md rule 7)
//   - Key schema: src/encore-scaler/types.ts `keys.cancelledJobs` (per-workspace
//     hash of externalId -> epoch ms, beside `keys.jobStatus`, purged with it in
//     workspace-registry.ts deprovision).
//   - Terminal status vocabulary the scaler records for a cancelled job
//     ('CANCELLED', mapped to `failed` by getJobStatus): src/encore-scaler/
//     index.ts makeScalingEncoreClient.getJobStatus.
//   - Caller-facing cancel contract (what must be marked cancelled):
//     EncoreClient.cancel, src/pipeline/encore-client.ts.

import type { Redis } from 'ioredis';
import { keys } from './types.js';

// Record that `jobId` has been cancelled: the monotonic tombstone FIRST, then
// the caller-facing terminal status.
//
// Order matters. The tombstone is what makes the cancel stick, so it is written
// before any remote cancel attempt and before the status write — a cancel whose
// Encore leg fails (instance unreachable, non-idempotent error status) still
// leaves the job permanently excluded from re-enqueue instead of looking
// non-terminal the moment something pins its status back to running.
export async function markJobCancelled(
  redis: Redis,
  workspaceId: string,
  jobId: string
): Promise<void> {
  await redis.hset(keys.cancelledJobs(workspaceId), jobId, String(Date.now()));
  await redis.hset(keys.jobStatus(workspaceId), jobId, 'CANCELLED');
}

// Every cancelled externalId in the workspace, as a set — one HGETALL, the same
// read shape the re-enqueue paths already use for jobInstance/jobStatus.
//
// COST / CALL DISCIPLINE: read this once per PASS, never once per candidate. All
// three call sites do (scaler-loop.ts requeueScaleDownInterruptions, reconcile()'s
// drop diff, and the dispatch loop, which reads it once per instance before
// feeding that instance), so a tick costs O(instances) HGETALLs, not
// O(instances x jobs). That discipline matters because the hash is pruned only
// when the workspace is deprovisioned — workspace-registry.ts deletes
// keys.cancelledJobs beside keys.jobStatus; there is no per-job hdel and no TTL —
// so it grows for the lifetime of the workspace and must not be re-read per job.
//
// A cancel that lands AFTER a pass's read is not lost, it is merely late: both
// re-enqueue paths consult the tombstone on every pass, so the next pass (next
// tick) sees it, and nothing clears it in the meantime.
//
// Read errors are NOT swallowed: every caller runs inside a best-effort
// try/catch that logs and abandons the pass, so unreadable tombstones withhold
// a re-enqueue (recoverable — the next tick re-evaluates) instead of performing
// one that may resurrect a cancelled job.
export async function loadCancelledJobs(
  redis: Redis,
  workspaceId: string
): Promise<Set<string>> {
  const raw = await redis.hgetall(keys.cancelledJobs(workspaceId));
  return new Set(Object.keys(raw ?? {}));
}
