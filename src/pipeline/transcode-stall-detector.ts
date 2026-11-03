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
// WHY A FALSE POSITIVE IS EXPENSIVE, AND WHAT BOUNDS IT
// ----------------------------------------------------
// A stall report is NOT advisory: it enters the bounded-retry gate, which cancels
// the attempt and re-dispatches the encode from scratch. A detector that misreads
// a healthy job therefore reproduces its own mistake on every attempt, and the
// job lands terminal `failed` after MAX_ENCODE_ATTEMPTS. Two independent guards
// keep a slow-but-healthy encode out of that path:
//
//   1. A PROGRESS FLOOR (MIN_ARMED_PROGRESS below). Encore's `progress` field has
//      `default: 0`, so an IN_PROGRESS job that has not yet emitted a number
//      reads as 0 — which is exactly what the pre-encode analyze step looks like
//      from here, and analyze can legitimately run for a long time on a large
//      source with no progress at all. Arming the clock on those samples would
//      count the analyze window toward the stall bound. So a sub-floor sample is
//      not evidence of anything and is ignored entirely: the clock is only armed
//      once Encore has reported the encode actually running.
//   2. A BOUND DERIVED FROM THE REPORTING GRANULARITY, not from a guess at how
//      long a job "should" take — see DEFAULT_TRANSCODE_STALL_TIMEOUT_MS.
//
// Note on the alternative the review raised: requiring an observed ADVANCE (not
// merely a sample above the floor) before arming would also close the analyze
// window, but it would additionally blind the detector to a job that is already
// frozen when this process first sees it — the restart case, where the frozen job
// is precisely the one nobody will ever settle. The floor closes the reported
// false positive without giving that up, and rule 1 below still grants every
// newly-tracked job a full bound of grace before it can be reported.
//
// WHAT A TERMINAL SETTLE LEAVES BEHIND (confirmed, not assumed)
// ------------------------------------------------------------
// Asked during review: does a stalled job that settles terminal leave its frozen
// Encore job IN_PROGRESS, still counted in the instance's activeJobs? It does.
// `decideRetry`'s prior-attempt canceler is consulted ONLY on the 'retry' branch
// (src/encore-scaler/retry-store.ts:281 "Only consulted on the 'retry' branch — a
// 'settle' never re-dispatches", and the single `cancelPriorActiveAttempt` call
// at :345, which sits after both `settle` returns at :298-303 and :286-290). The
// settle path in src/main.ts (`settleOrRetryEncoreJobDrops`) then calls
// `settleFailedTranscode` and `clearRetryState` only — neither cancels on Encore.
// So on the LAST attempt the frozen Encore job keeps its IN_PROGRESS state and
// keeps occupying an activeJobs slot on its instance until something else reaps
// it; the intermediate attempts DO reach the cancel call, because those take the
// 'retry' branch.
//
// Worth stating plainly, because it bounds how much that distinction is worth:
// cancelling a FROZEN encode does not actually free the slot either. A frozen
// job answers `POST /encoreJobs/{id}/cancel` with 200 and then stays IN_PROGRESS
// in `findByStatus` anyway — measured and written up in
// docs/osc-feedback/incoming-issue1219-encore-cancel-not-honoured-by-frozen-job.md
// (#1219). So for the specific failure this module detects, the slot is held
// until the instance is reclaimed whichever branch is taken. That is pre-existing
// behaviour of the settle path this module feeds (the reconcile drop path at #727
// settles the same way), not something stall detection introduces — but it is why
// the guards above matter: a false stall does not merely waste an encode, it can
// strand an instance slot that no cancel will give back.
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
// long is declared stalled. Overridable per deployment via
// ENCORE_TRANSCODE_STALL_TIMEOUT_MS.
//
// HOW 60 MINUTES WAS DERIVED (the review asked for the reasoning, not a number)
// ----------------------------------------------------------------------------
// Encore reports progress as an INTEGER percent, so the only thing this detector
// can observe is "the percent has not ticked". The longest a HEALTHY job can hold
// one percent is therefore its total wall-clock divided by 100 (longer, in fact,
// for the parts of an encode that are not linear — the final mux/upload commonly
// parks on 99% while it writes out). Inverting that: a bound of B only misfires
// on a healthy job whose total wall-clock exceeds 100 x B.
//
//   B = 20 minutes  ->  misfires on any encode longer than ~33 hours ... but the
//                       margin above a multi-hour ABR ladder is thin, and the
//                       non-linear tail eats it. This was the original default
//                       and the review flagged exactly this.
//   B = 60 minutes  ->  misfires only on an encode longer than ~100 hours, which
//                       is far outside anything this API dispatches (sources are
//                       minutes to a few hours; the ladder is the multiplier).
//
// 60 minutes is chosen for that margin. It still bounds the defect #1218 was
// reported from: the hang goes from unbounded (forever, nothing ever settles it)
// to at most one bound per attempt — roughly 3 hours across MAX_ENCODE_ATTEMPTS
// rather than never. The asymmetry is deliberate: being an hour late to catch a
// real hang costs latency on an already-broken job, while being early on a
// healthy one costs a re-encode and, at the bound, a wrongly-failed job.
export const DEFAULT_TRANSCODE_STALL_TIMEOUT_MS = 60 * 60_000;

// Progress floor: the smallest reported percent that counts as "the encode is
// actually running", and so the smallest sample that may arm the stall clock.
//
// Encore's `progress` is declared `{"type":"integer","format":"int32",
// "default":"0"}`, so 0 is indistinguishable between "the encode has started and
// is genuinely at 0%" and "no progress has been reported for this job yet". The
// pre-encode analyze step reads as the latter for its whole duration, and that
// window takes no input params service-side (see
// docs/osc-feedback/incoming-issue1222-mediainfo-no-input-params.md), so on a
// large source it can be long. Counting it toward the stall bound would fail a
// job that has not even begun encoding, which is the false positive this floor
// exists to remove. 1 means: wait until Encore has reported at least one percent.
export const MIN_ARMED_PROGRESS = 1;

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
//   0. A sample BELOW MIN_ARMED_PROGRESS carries no evidence that the encode has
//      started (Encore's `progress` defaults to 0, and the pre-encode analyze
//      window reads as 0 for its whole duration), so it is ignored outright: it
//      neither arms nor advances nor prunes a clock. A job sitting at 0 can
//      therefore never be reported stalled, however long it sits there — the
//      analyze window is not a freeze. See MIN_ARMED_PROGRESS above.
//   1. First sight of an externalId AT OR ABOVE the floor starts its clock —
//      never stalled on the first sample (we have no evidence about the past, and
//      a process restart must not instantly fail every running job).
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

    // Rule 0: the encode has not reported itself running yet (0 is also Encore's
    // declared default for an unreported value, and is what the pre-encode
    // analyze step looks like from here). No clock is armed, advanced or pruned
    // on such a sample, so the analyze window cannot be mistaken for a freeze.
    if (progress < MIN_ARMED_PROGRESS) continue;

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
