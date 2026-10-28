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
  type MessageFailureClass
} from './retry-policy.js';

const PAYLOAD_TTL_SECONDS = 86_400; // 24h, matches the dispatch-time UUID/URL keys.

// #743: is an entry for `jobId` already sitting in this workspace's pending queue
// (keys.queue) or transient inflight list (keys.inflight)? Both are Valkey lists of
// JSON-serialized QueuedJob objects, each carrying a `jobId` field (types.ts:185-197).
// A retry re-dispatch (decideRetry) must be idempotent: without this guard, a second
// failure signal for a job whose retry is ALREADY queued (or being dispatched, hence
// inflight) LPUSHes another copy, so one execution can accumulate far more than
// MAX_ENCODE_ATTEMPTS entries (observed: 12 entries against a bound of 3).
//
// CONTRACT SOURCES VERIFIED (CLAUDE.md rule 7)
//   - keys.queue / keys.inflight are Valkey lists (types.ts:206-207); QueuedJob has
//     a `jobId` correlation id (types.ts:185-197).
//   - Scan idiom (LRANGE 0 -1 + JSON.parse as QueuedJob + match parsed.jobId, ignore
//     unparseable entries) mirrors the router's cancel path
//     (encore-scaler-router.ts:136-148) and index.ts:104.
async function hasQueuedOrInflightEntry(
  redis: Redis,
  workspaceId: string,
  jobId: string
): Promise<boolean> {
  const [queued, inflight] = await Promise.all([
    redis.lrange(keys.queue(workspaceId), 0, -1),
    redis.lrange(keys.inflight(workspaceId), 0, -1)
  ]);
  for (const entry of [...queued, ...inflight]) {
    try {
      const parsed = JSON.parse(entry) as QueuedJob;
      if (parsed.jobId === jobId) return true;
    } catch {
      // ignore unparseable entries — mirrors the router cancel scan
    }
  }
  return false;
}

// #745: a best-effort canceler for the STILL-ACTIVE PRIOR Encore attempt of an
// externalId, invoked immediately BEFORE that externalId is re-dispatched. Re-
// dispatch (a #295 transport/IO retry, or a #514 scale-down re-enqueue) can
// otherwise submit the same externalId while the previous attempt is still
// IN_PROGRESS on another instance — producing concurrent encodes writing to the
// same output (live evidence: one externalId IN_PROGRESS on three instances at
// once). Cancelling the prior attempt first guarantees an externalId is never
// active on more than one Encore instance simultaneously.
//
// The canceler receives the full Encore job URL recorded at dispatch time —
// keys.jobEncoreUrl = `{instanceUrl}/encoreJobs/{uuid}` (src/encore-scaler/
// scaler-loop.ts:962) — and must POST `{url}/cancel`.
//
// CONTRACT SOURCE VERIFIED (CLAUDE.md rule 7)
//   - Encore cancel endpoint: POST {baseUrl}/encoreJobs/{jobId}/cancel — SVT
//     Encore EncoreController.kt, mirrored by EncoreClient.cancel
//     (src/pipeline/encore-client.ts:53-58, 142-161). Only NEW/QUEUED/IN_PROGRESS
//     jobs are cancellable; 404 (already gone) / 409 (terminal) are idempotent
//     no-ops, so calling this on EVERY re-dispatch path is safe.
export type PriorAttemptCanceler = (encoreJobUrl: string) => Promise<void>;

// Build a PriorAttemptCanceler that POSTs the Encore cancel endpoint for the
// exact prior-attempt job URL, authenticating with a fresh service access token.
// Matches makeHttpEncoreClient.cancel's contract handling (encore-client.ts:142-161)
// but cancels by full per-instance URL (the prior attempt may live on a DIFFERENT
// instance than the retry will land on, so a fixed baseUrl is not enough).
export function makePriorAttemptCanceler(
  getToken: () => Promise<string>,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch
): PriorAttemptCanceler {
  return async (encoreJobUrl: string): Promise<void> => {
    const token = await getToken();
    const res = await fetchImpl(`${encoreJobUrl.replace(/\/$/, '')}/cancel`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` }
    });
    // Idempotent no-op: 404 = job already gone, 409 = terminal / non-cancellable.
    if (res.status === 404 || res.status === 409) return;
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Encore prior-attempt cancellation failed: ${res.status} ${text}`.trim());
    }
  };
}

// #745: cancel the still-active PRIOR Encore attempt for `jobId` before its
// re-dispatch, using the full job URL stored at dispatch time (keys.jobEncoreUrl).
// MUST be called BEFORE that key is deleted by the re-queue path. Best-effort: a
// failed/missing cancel must NEVER block the re-dispatch (reconcile()'s dropped-job
// handling and the bounded-attempt cap remain the backstop), but it is logged so a
// cancel that could not be delivered is diagnosable (issue #451 observability).
async function cancelPriorActiveAttempt(
  redis: Redis,
  jobId: string,
  cancelPrior: PriorAttemptCanceler | undefined
): Promise<void> {
  if (!cancelPrior) return;
  let priorUrl: string | null = null;
  try {
    priorUrl = await redis.get(keys.jobEncoreUrl(jobId));
  } catch {
    priorUrl = null;
  }
  if (!priorUrl) return; // no recorded prior dispatch URL — nothing to cancel.
  try {
    await cancelPrior(priorUrl);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      '[encore-scaler] retry: failed to cancel prior active Encore attempt before ' +
        `re-dispatch for ${jobId} (url=${priorUrl}); proceeding with re-dispatch:`,
      err
    );
  }
}

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

// Re-enqueue a job whose worker was removed/drained mid-flight (#514,
// 'interrupted_by_scaledown'). The job did NOT fail — its shared-pool instance
// was scaled away (issue #513 drain boundary) — so this is UNCONDITIONALLY
// recoverable and is auto-re-queued with NO backoff and WITHOUT consuming a
// genuine encode attempt (the interrupted run produced no failure, so it must not
// count toward MAX_ENCODE_ATTEMPTS).
//
// Returns true when the job was rebuilt from its stored payload and re-queued;
// false when the original payload is unavailable (e.g. TTL expired) so the caller
// can fall back to the generic dropped-job path rather than fabricate a payload.
//
// CONTRACT SOURCES VERIFIED (CLAUDE.md rule 7)
//   - Re-enqueue = LPUSH a QueuedJob onto keys.queue, exactly as decideRetry()
//     (retry-store.ts:143) and the router submit path (index.ts:29). The scaler
//     loop RPOPLPUSHes and JSON.parses whatever is on the queue
//     (scaler-loop.ts:218-231).
//   - Caller-facing status kept in 'RUNNING' so getJobStatus() maps it to
//     `running` (index.ts:38-39) and the job is never observed as settled while
//     the re-dispatch is pending — same invariant decideRetry() upholds
//     (retry-store.ts:132).
//   - Stale per-attempt mappings dropped so the callback poller resolves the fresh
//     dispatch, not the scaled-away instance (mirrors retry-store.ts:136-140).
//   - keys / QueuedJob shape: src/encore-scaler/types.ts:141-189.
export async function requeueInterruptedByScaleDown(
  redis: Redis,
  workspaceId: string,
  jobId: string,
  // #745: cancel any still-active prior Encore attempt for this externalId before
  // the re-enqueue lands a fresh dispatch. Optional so non-scaler/test callers
  // that cannot cancel keep working; the real scaler wires it from getToken.
  cancelPrior?: PriorAttemptCanceler
): Promise<boolean> {
  const payloadRaw = await redis.get(keys.jobPayload(jobId));
  if (!payloadRaw) return false;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(payloadRaw) as Record<string, unknown>;
  } catch {
    return false;
  }

  // Preserve the prior dispatch count so the loop persists it unchanged: a
  // scale-down interruption is NOT a failed attempt, so it must not advance
  // toward the bound. Fall back to 0 (first dispatch) when unknown.
  const attemptsRaw = await redis.get(keys.jobAttempts(jobId));
  const attemptsSoFar = Number(attemptsRaw ?? '0') || 0;

  const requeued: QueuedJob = {
    jobId,
    payload,
    enqueuedAt: Date.now(),
    // No backoff: the work was interrupted, not failing, so re-run immediately.
    attempts: attemptsSoFar
  };

  // #745: cancel the prior attempt (if still active on its now-scaled-away
  // instance) BEFORE the jobEncoreUrl key is deleted below, so the re-enqueue
  // cannot leave the same externalId running concurrently on two instances.
  await cancelPriorActiveAttempt(redis, jobId, cancelPrior);

  // Keep the job non-terminal and drop the stale mapping to the scaled-away
  // instance BEFORE re-queuing, so it is never observed as settled/failed
  // between the interruption and the fresh dispatch.
  await redis.hset(keys.jobStatus(workspaceId), jobId, 'RUNNING');
  await redis.hdel(keys.jobInstance(workspaceId), jobId);
  // jobTerminalInstance is cleared alongside jobEncoreUrl (issue #739): both
  // describe the PREVIOUS attempt's instance, and a re-dispatch invalidates them
  // together. Leaving it would let packaging resolve a stale instance for a job
  // that has since moved.
  await redis.del(keys.jobUuid(jobId), keys.jobEncoreUrl(jobId), keys.jobTerminalInstance(jobId));

  await redis.lpush(keys.queue(workspaceId), JSON.stringify(requeued));
  return true;
}

// decideRetry only ever classifies via classifyEncoreFailure(), which returns a
// message-derived class (never the topology-event 'interrupted_by_scaledown', #514
// — that is classified structurally at the scaler's drain boundary, not here). So
// the decision's failureClass is a MessageFailureClass, which is exactly what the
// caller-facing encode-attempt log (finalizeEncodeAttempt) accepts.
export type RetryDecision =
  | { action: 'retry'; attempt: number; failureClass: MessageFailureClass; backoffMs: number }
  // #743: the job already has a retry entry queued or inflight, so re-dispatching
  // again would create a duplicate queue entry. The caller MUST treat this exactly
  // like 'retry' for settle purposes (the job stays non-terminal — a pending retry
  // is in flight) but MUST NOT settle, finalize another encode attempt, or free a
  // slot: no new dispatch happened, so there is nothing further to account for.
  | { action: 'skip'; reason: 'already-pending'; failureClass: MessageFailureClass }
  | { action: 'settle'; reason: 'exhausted' | 'not-retryable'; failureClass: MessageFailureClass };

// The gate. Given an observed Encore failure `message` for jobId, decide whether
// to re-dispatch (transport/IO class + retries remaining) or settle terminal.
//
// On 'retry' this function has ALREADY re-queued the job (with backoff) and
// pinned the caller-facing status back to 'RUNNING' so the caller does not see a
// hung/settled job while the retry is pending. The caller MUST NOT call
// completeTranscode({ success:false }) in that case.
//
// On 'skip' (#743) an entry for this job was ALREADY queued/inflight, so this
// function did NOT re-queue (avoiding a duplicate queue entry). The caller MUST
// NOT settle and MUST NOT run completeTranscode — the pending retry stays in
// flight — and it should not finalize another encode attempt or free a slot for
// this duplicate signal, since no new dispatch occurred.
//
// On 'settle' the caller settles the job terminal exactly as before (this is the
// pre-#295 behaviour) and should call clearRetryState afterwards.
export async function decideRetry(
  redis: Redis,
  workspaceId: string,
  jobId: string,
  failureMessage: string | undefined,
  // #745: cancel any still-active prior Encore attempt for this externalId before
  // the re-dispatch is queued. Optional so callers that cannot cancel (or tests)
  // keep working; the callback poller and the reconcile drop path wire it from
  // getToken. Only consulted on the 'retry' branch — a 'settle' never re-dispatches.
  cancelPrior?: PriorAttemptCanceler
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

  // #743: make re-dispatch idempotent. If an entry for this jobId is ALREADY in
  // the pending queue or the inflight list, its retry is already scheduled (or is
  // mid-dispatch), so LPUSHing another copy would create a duplicate queue entry —
  // the exact bug that let one execution accumulate 12 entries against a bound of
  // MAX_ENCODE_ATTEMPTS. Skip the enqueue and every state mutation below (the
  // pending entry already carries the correct payload/attempts). This check runs
  // BEFORE any hset/hdel/del/lpush so a duplicate failure signal is a true no-op.
  if (await hasQueuedOrInflightEntry(redis, workspaceId, jobId)) {
    return { action: 'skip', reason: 'already-pending', failureClass };
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

  // #745: cancel the prior attempt (if it is still active on the instance that
  // ran the failed run) BEFORE the jobEncoreUrl key is deleted below. A drop-
  // detected "failure" can be a FALSE POSITIVE (the job is still IN_PROGRESS on
  // its instance), so re-dispatching without cancelling first is exactly what
  // produced the same externalId active on multiple instances at once.
  await cancelPriorActiveAttempt(redis, jobId, cancelPrior);

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
    keys.jobEncoreUrl(jobId),
    // Issue #739: the terminal-instance mapping also describes the FAILED
    // attempt's instance, so it is invalidated with the rest of them.
    keys.jobTerminalInstance(jobId)
  );

  // Re-queue at the tail (FIFO) so the scaler loop re-dispatches it.
  await redis.lpush(keys.queue(workspaceId), JSON.stringify(requeued));

  return { action: 'retry', attempt: nextAttempt, failureClass, backoffMs };
}
