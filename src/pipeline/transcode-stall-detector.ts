// Transcode stall detection (issue #1218).
//
// WHY THIS EXISTS
// ---------------
// When the source connection drops mid-encode, the Encore job's ffmpeg can
// freeze SILENTLY: it stops emitting progress, raises NO error, Encore keeps the
// job IN_PROGRESS, and our Job record therefore stays `running` forever. Nothing
// settles it and no retry fires — nothing lands in the packaged bucket.
//
// The SAME source drop sometimes errors fast instead ("Stream ends prematurely
// …"). That path already works: it classifies 'io-retryable' and is re-dispatched
// by the bounded retry policy (#295), reaching the gate from either the FAILED
// callback (src/pipeline/encore-callback-poller.ts handleMessage -> decideRetry)
// or the reconcile drop path (#727, src/main.ts onJobsDropped -> decideRetry).
// The gap is only the silent hang: progress stops advancing but no error is ever
// raised, so neither observation path ever fires.
//
// This module supplies the missing observation: it watches the progress numbers
// the poller's #830 sweep ALREADY reads off each instance's IN_PROGRESS page and
// reports an externalId whose progress has not advanced within a configurable
// bound. The caller then raises that id through the EXISTING failure signal
// (onJobsDropped), so the stall converges on the same decideRetry ->
// settleFailedTranscode handling the fast-error case uses. No parallel retry or
// settle logic lives here: this module is pure bookkeeping over progress samples.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
// ----------------------------------------------------------
//   - Encore job document fields consumed: `EntityModelEncoreJob.progress`
//     ({"type":"integer","format":"int32","default":"0","description":"The
//     EncoreJob progress","example":57,"readOnly":true}) and
//     `EntityModelEncoreJob.externalId` ({"type":"string","description":"External
//     id - for external backreference"}) on
//     `PagedModelEntityModelEncoreJob` from
//     `GET /encoreJobs/search/findByStatus?status=IN_PROGRESS` (operationId
//     `executeSearch-encorejob-get`) — Encore's own OpenAPI document, recorded in
//     src/pipeline/encore-callback-poller.ts:1269-1288 and re-verified against
//     the same block here. `externalId` is OUR encoreJobId (submitted at
//     src/pipeline/transcode.ts `externalId: encoreJobId`).
//   - Failure/retry contract this feeds: `DroppedJob = { encoreJobId: string;
//     reason?: string }` (src/encore-scaler/types.ts) consumed by
//     `ScalerConfig.onJobsDropped` (same file), whose main.ts handler builds
//     `dropped by Encore: ${reason}` and calls
//     `decideRetry(redis, workspaceId, encoreJobId, failureText, canceler)`
//     (src/encore-scaler/retry-store.ts) -> `classifyEncoreFailure`
//     (src/encore-scaler/retry-policy.ts).
//   - The class the synthesized message must resolve to: `MessageFailureClass`
//     ('transport' | 'io-retryable' | 'deterministic'), retryability decided by
//     `isRetryableFailureClass` (retry-policy.ts). The message built below leads
//     with TRANSCODE_STALL_SIGNATURE, which retry-policy.ts lists as a transport
//     signature, so a stall is bounded-retried exactly like the other
//     plumbing-class failures.

import { TRANSCODE_STALL_SIGNATURE } from '../encore-scaler/retry-policy.js';

// Default bound: an Encore job whose reported progress has not advanced for this
// long is declared stalled. Generous on purpose — Encore reports INTEGER percent,
// so a long encode legitimately sits on the same number for minutes at a time
// (one percent of a multi-hour source), and a false positive costs a re-encode.
// 20 minutes is comfortably longer than the slowest observed single-percent step
// while still bounding the hang that #1218 was reported from (forever).
// Overridable per deployment via ENCORE_TRANSCODE_STALL_TIMEOUT_MS.
export const DEFAULT_TRANSCODE_STALL_TIMEOUT_MS = 20 * 60_000;

// Forget a tracked job this long after we last saw it on an IN_PROGRESS page, so
// the tracker cannot grow without bound in a long-lived process (a job that stops
// appearing has gone terminal and will never be sampled again). Mirrors
// PROGRESS_THROTTLE_TTL_MS in encore-callback-poller.ts.
export const STALL_TRACKER_TTL_MS = 60 * 60_000;

// One progress sample for one Encore job, as read off the IN_PROGRESS page.
export type ProgressObservation = {
  readonly externalId: string;
  readonly progress: number;
};

// Per-job tracker state: the last progress value seen, when it last ADVANCED,
// and when the job was last seen at all (TTL pruning only).
export type StallTrackerEntry = {
  progress: number;
  advancedAt: number;
  lastSeenAt: number;
};

// A job whose progress has not advanced within the bound.
export type StalledTranscode = {
  readonly encoreJobId: string;
  readonly reason: string;
};

// Build the synthesized failure text for a stalled attempt.
//
// It MUST lead with TRANSCODE_STALL_SIGNATURE: that needle is what makes
// classifyEncoreFailure() resolve this text to the retryable 'transport' class,
// which is the whole point of routing the stall through the existing gate. The
// rest is operator-facing diagnostics (where progress froze and for how long).
export function buildStallFailureMessage(opts: {
  progress: number;
  stalledForMs: number;
  stallTimeoutMs: number;
}): string {
  const minutes = Math.max(1, Math.round(opts.stalledForMs / 60_000));
  const boundMinutes = Math.max(1, Math.round(opts.stallTimeoutMs / 60_000));
  return (
    `${TRANSCODE_STALL_SIGNATURE}: Encore reported the job IN_PROGRESS but its ` +
    `progress has not advanced past ${opts.progress}% for ${minutes} minutes ` +
    `(bound ${boundMinutes} minutes) — the encode appears frozen with no error ` +
    'raised (a source connection dropped mid-encode produces exactly this), so ' +
    'the attempt is failed here to let the retry policy re-dispatch it'
  );
}

// Record a round of progress samples and report which jobs have stalled.
//
// Rules, in order:
//   1. First sight of an externalId starts its clock — never stalled on the first
//      sample (we have no evidence about the past, and a process restart must not
//      instantly fail every running job).
//   2. A CHANGED progress value resets the clock: the job is making progress, so
//      it can never be reported stalled while the number keeps moving. Any change
//      counts (Encore's progress is monotonic in practice, but a decrease still
//      proves the encoder is alive).
//   3. An UNCHANGED value older than `stallTimeoutMs` since the last advance is
//      reported stalled, and its entry is DROPPED so one hang is raised exactly
//      once per sighting cycle rather than on every subsequent sweep. If the job
//      is still being sampled after that, rule 1 restarts its clock, so a stall
//      that the retry gate declined to act on is re-reported at most once per
//      bound — not once per sweep tick.
//
// Pure except for the `state` map it owns: no I/O, no clock of its own (the
// caller passes `now`), so the timeout path is directly unit-testable.
export function recordProgressAndDetectStalls(
  state: Map<string, StallTrackerEntry>,
  observations: readonly ProgressObservation[],
  opts: { now: number; stallTimeoutMs: number }
): StalledTranscode[] {
  const { now, stallTimeoutMs } = opts;
  const stalled: StalledTranscode[] = [];

  for (const observation of observations) {
    const { externalId, progress } = observation;
    if (!externalId || typeof progress !== 'number' || !Number.isFinite(progress)) continue;

    const previous = state.get(externalId);
    if (!previous) {
      // Rule 1: start the clock, report nothing.
      state.set(externalId, { progress, advancedAt: now, lastSeenAt: now });
      continue;
    }

    if (previous.progress !== progress) {
      // Rule 2: progress moved — reset the stall clock.
      previous.progress = progress;
      previous.advancedAt = now;
      previous.lastSeenAt = now;
      continue;
    }

    previous.lastSeenAt = now;
    const stalledForMs = now - previous.advancedAt;
    if (stalledForMs <= stallTimeoutMs) continue;

    // Rule 3: frozen past the bound.
    state.delete(externalId);
    stalled.push({
      encoreJobId: externalId,
      reason: buildStallFailureMessage({ progress, stalledForMs, stallTimeoutMs })
    });
  }

  // Bounded memory: forget jobs not sampled for a while (they went terminal).
  for (const [key, entry] of state) {
    if (now - entry.lastSeenAt > STALL_TRACKER_TTL_MS) state.delete(key);
  }

  return stalled;
}
