// Bounded-retry state + re-dispatch gate for transport-class encode failures (#295).
//
// This is the coordination point between the failure observation path (the
// callback poller's handleMessage failure branch, and — once merged — the #273
// failed-transcode reconciler) and the scaler's dispatch queue.
//
// The scaler has no job repository of its own; its durable state is Valkey. So
// the retry bookkeeping also lives in Valkey:
//   - keys.jobPayload(jobId)  : the original Encore payload, stored at dispatch
//                               time so a retry can re-POST without the caller
//                               re-submitting. 24h TTL.
//   - keys.jobAttempts(jobId) : how many times the job has been dispatched.
//
// CONTRACT SOURCES VERIFIED (CLAUDE.md rule 7)
//   - Valkey list re-queue: the scaler loop consumes jobs with RPOPLPUSH from
//     keys.queue and dispatches whatever JSON.parses to a QueuedJob
//     (src/encore-scaler/scaler-loop.ts:117-147). Re-dispatch = LPUSH a
//     QueuedJob onto keys.queue (FIFO tail, same as the router's submit path,
//     src/encore-scaler/encore-scaler-router.ts:60).
//   - jobStatus hash values are free-form status strings; getJobStatus maps
//     QUEUED/RUNNING->running, DONE/SUCCESSFUL->done, FAILED/CANCELLED->failed
//     (src/encore-scaler/index.ts:35-43). To keep the caller-facing job in
//     `running` (NOT settled) while a retry is pending, we write 'RUNNING'.
//   - keys / QueuedJob shape: src/encore-scaler/types.ts.

import type { Redis } from 'ioredis';
import { keys, type QueuedJob } from './types.js';
import {
  MAX_ENCODE_ATTEMPTS,
  backoffForAttempt,
  classifyEncoreFailure,
  isRetryableFailureClass,
  type FailureClass
} from './retry-policy.js';

const PAYLOAD_TTL_SECONDS = 86_400; // 24h, matches the dispatch-time UUID/URL keys.

// Record the original payload + first dispatch (attempt 1) at dispatch time.
// Best-effort caller: a failure here must never block dispatch, so callers
// should swallow. Stored with a 24h TTL so stale retry state self-expires.
export async function recordDispatch(
  redis: Redis,
  jobId: string,
  payload: Record<string, unknown>,
  attempts: number
): Promise<void> {
  await redis.set(keys.jobPayload(jobId), JSON.stringify(payload), 'EX', PAYLOAD_TTL_SECONDS);
  await redis.set(keys.jobAttempts(jobId), String(attempts), 'EX', PAYLOAD_TTL_SECONDS);
}

// Clear retry bookkeeping once a job settles (success or exhausted retries) so
// it does not linger for the full TTL.
export async function clearRetryState(redis: Redis, jobId: string): Promise<void> {
  await redis.del(keys.jobPayload(jobId), keys.jobAttempts(jobId));
}

export type RetryDecision =
  | { action: 'retry'; attempt: number; failureClass: FailureClass; backoffMs: number }
  | { action: 'settle'; reason: 'exhausted' | 'not-retryable'; failureClass: FailureClass };

// The gate. Given an observed Encore failure `message` for jobId, decide whether
// to re-dispatch (transport/IO class + retries remaining) or settle terminal.
//
// On 'retry' this function has ALREADY re-queued the job (with backoff) and
// pinned the caller-facing status back to 'RUNNING' so the caller does not see a
// hung/settled job while the retry is pending. The caller MUST NOT call
// completeTranscode({ success:false }) in that case.
//
// On 'settle' the caller settles the job terminal exactly as before (this is the
// pre-#295 behaviour) and should call clearRetryState afterwards.
export async function decideRetry(
  redis: Redis,
  workspaceId: string,
  jobId: string,
  failureMessage: string | undefined
): Promise<RetryDecision> {
  const failureClass = classifyEncoreFailure(failureMessage);

  if (!isRetryableFailureClass(failureClass)) {
    // Deterministic (profile/validation) failure: re-running yields the same
    // result, so do not waste compute. Settle terminal.
    return { action: 'settle', reason: 'not-retryable', failureClass };
  }

  // How many times have we already dispatched this job? Prefer the durable
  // attempts key; if it is missing (e.g. dispatched before #295, or TTL expired)
  // fall back to treating the current run as attempt 1.
  const attemptsRaw = await redis.get(keys.jobAttempts(jobId));
  const attemptsSoFar = Number(attemptsRaw ?? '1') || 1;

  if (attemptsSoFar >= MAX_ENCODE_ATTEMPTS) {
    // Bound reached. A truly-corrupt source (or a persistent transport fault)
    // has now failed MAX_ENCODE_ATTEMPTS times: settle terminal and fail clearly
    // with the last Encore message preserved by the caller.
    return { action: 'settle', reason: 'exhausted', failureClass };
  }

  // Retryable and under the bound: re-dispatch. We need the original payload to
  // re-POST it. If it is missing we cannot rebuild the job, so we must settle.
  const payloadRaw = await redis.get(keys.jobPayload(jobId));
  if (!payloadRaw) {
    return { action: 'settle', reason: 'not-retryable', failureClass };
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadRaw) as Record<string, unknown>;
  } catch {
    return { action: 'settle', reason: 'not-retryable', failureClass };
  }

  const nextAttempt = attemptsSoFar + 1;
  const backoffMs = backoffForAttempt(attemptsSoFar);

  const requeued: QueuedJob = {
    jobId,
    payload,
    enqueuedAt: Date.now(),
    notBefore: Date.now() + backoffMs,
    attempts: attemptsSoFar // carried so the loop persists nextAttempt on dispatch
  };

  // Order matters: pin the caller-facing status to RUNNING and clear any stale
  // per-instance mapping BEFORE re-queuing, so the job is never observed as
  // settled between the failure and the re-dispatch.
  //
  // Keeping the caller-facing job in `running` (rather than settling it to
  // failed) is the #295 requirement AND the #273 coordination point: while a
  // retry is pending the job stays non-terminal, so #273's reconciler will not
  // double-settle it (a still-`running` job is exactly what #273 leaves alone
  // until it observes a terminal Encore state — and this job's Encore instance
  // has moved on to the fresh dispatch).
  await redis.hset(keys.jobStatus(workspaceId), jobId, 'RUNNING');
  // Drop the stale UUID/URL/instance mappings from the FAILED attempt so the
  // callback poller resolves the NEW dispatch, not the dead one. The fresh
  // dispatch rewrites all of these.
  await redis.hdel(keys.jobInstance(workspaceId), jobId);
  await redis.del(
    keys.jobUuid(jobId),
    keys.jobEncoreUrl(jobId)
  );

  // Re-queue at the tail (FIFO) so the scaler loop re-dispatches it.
  await redis.lpush(keys.queue(workspaceId), JSON.stringify(requeued));

  return { action: 'retry', attempt: nextAttempt, failureClass, backoffMs };
}
