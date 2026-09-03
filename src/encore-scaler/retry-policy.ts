// Transport-vs-input failure classification and bounded-retry policy (#295).
//
// WHY THIS EXISTS
// ---------------
// A transient S3 transport blip during an Encore transcode (a connection-pool
// acquire timeout on write, #292; or a severed read stream on a source that is
// actually intact, #293) wastes the whole compute run and — because Encore's
// callback listener never signals FAILED (see
// docs/osc-feedback/incoming-encore-callback-listener-no-failure-notification.md)
// — strands the caller-facing VideoCore job in `running`. Re-running the encode
// is cheap resilience: a transient blip should cost one retry, not the job.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
// ----------------------------------------------------------
//   - Encore job document status enum: `SUCCESSFUL` | `FAILED` | `CANCELLED` |
//     `IN_PROGRESS` | `QUEUED` — verified in
//     src/pipeline/encore-client.ts normalizeEncoreStatus() (SMOKE TEST
//     CONFIRMED 2026-06-01) and the scaler's own reconcile()/sweep
//     findByStatus calls (src/encore-scaler/scaler-loop.ts:182-186,
//     src/pipeline/encore-callback-poller.ts:425).
//   - The failure detail is carried on the Encore job document's `message`
//     field — verified in src/pipeline/encore-callback-poller.ts:263
//     (`job: { externalId?; status?; message?; output? }`) and consumed at
//     line 308 (`job.message ?? 'encore status: ...'`).
//   - The concrete failure signatures come from the sibling transport
//     investigations #292 (write) and #293 (read), recorded verbatim in
//     docs/osc-feedback/incoming-encore-s3-sdk-tunables-gap.md and
//     incoming-minio-ingress-longlived-conn-gap.md.
//
// CLASSIFICATION RULE (and its rationale)
// ---------------------------------------
// Three classes:
//
//   'transport'         — S3 SDK transport failure. Signatures (case-insensitive
//                         substring match on the Encore `message`):
//                           * "SdkClientException"
//                           * "Acquire operation took longer than the configured
//                              maximum time" / "pool" + "acquire" timeout (write, #292)
//                           * "Unable to execute HTTP request"
//                         RETRYABLE up to the bound. A transport blip re-run will
//                         usually succeed.
//
//   'io-retryable'      — input-side demux/read I/O error. Signatures:
//                           * "Error during demuxing: I/O error"
//                           * "Stream ends prematurely"
//                           * "corrupt input packet"
//                           * "Invalid NAL unit size"
//                         RETRYABLE up to the bound. CRITICAL nuance from #293:
//                         these SAME demux strings were observed on a source that
//                         was byte-for-byte INTACT (a long-lived read connection
//                         severed by an ingress idle-timeout, not bad data). So we
//                         CANNOT rely on the demux string to mean "corrupt source".
//                         We therefore treat demux/IO errors as retryable: a truly
//                         corrupt source simply fails the same way again, exhausts
//                         the bound, and then fails clearly (a bounded number of
//                         wasted runs, not infinite). This deliberately errs toward
//                         retrying so a transport-severed read is never mistaken for
//                         bad input.
//
//   'deterministic'     — everything else. Profile/validation errors, a missing
//                         required audio stream, an unknown profile, etc. These are
//                         NOT transport-related and re-running produces the exact
//                         same failure, so retrying only wastes compute. NOT retried;
//                         fails clearly on the first observation.
//
// The bound guarantees a genuinely bad source (whatever its signature) is not
// retried forever: it is retried at most MAX_ENCODE_ATTEMPTS times and then fails
// clearly with the last Encore error message surfaced to the caller.
//
// SCALE-DOWN INTERRUPTION (#514) — a FOURTH class, not message-derived
// -------------------------------------------------------------------
//   'interrupted_by_scaledown' — the job did not fail: its shared-pool worker was
//                         removed/drained mid-job (issue #513 drain-don't-kill
//                         defines the boundary). The work is lost to a topology
//                         event, NOT to a real processing failure, so it is
//                         indistinguishable from a genuine failure only if you look
//                         at a message string — which is exactly why this class is
//                         NOT inferred from the Encore `message`. It is classified
//                         structurally at the drain/teardown boundary (the scaler
//                         observes a job mapped to a scaled-away instance that Encore
//                         no longer reports active and that never went terminal) and
//                         is CLEARLY recoverable: it is always re-enqueued so
//                         downstream retry logic auto-retries it without operator
//                         intervention. Because it is not message-derived,
//                         classifyEncoreFailure() never returns it — a real
//                         'deterministic' failure message can never be reclassified
//                         as scale-down interruption.

// The three MESSAGE-DERIVED failure classes: everything classifyEncoreFailure()
// can infer from an Encore `message` string. This is the ONLY set that is ever
// recorded on the caller-facing encode-attempt log (EncodeAttempt.classification,
// src/data/job-repo.ts) — a completed encode attempt always failed (or not) with
// a message, never with a topology event. Keeping this a distinct, narrower type
// means widening the internal FailureClass for #514 does NOT widen the
// caller-facing classification enum (that is #515's concern, out of scope here).
export type MessageFailureClass = 'transport' | 'io-retryable' | 'deterministic';

// The full INTERNAL classification. Adds 'interrupted_by_scaledown' (#514): work
// lost when a shared-pool worker is drained/removed mid-job — not a message-derived
// failure but a topology event. This class is only ever produced structurally at
// the scaler's drain/teardown boundary (scaler-loop.ts), never by
// classifyEncoreFailure(), and it is never written to the caller-facing
// EncodeAttempt.classification field.
export type FailureClass = MessageFailureClass | 'interrupted_by_scaledown';

// Maximum number of times a single job is DISPATCHED to an Encore instance,
// inclusive of the first attempt. 3 = first attempt + up to 2 re-dispatches.
//
// Rationale: the two observed transport failures (#292 pool-acquire timeout at
// ~35s; #293 read severed at ~5-6min) are transient and clear on their own — a
// single re-run typically succeeds. Two retries covers the case where the first
// retry coincidentally hits the same ingress idle window, while keeping the
// worst-case wasted compute bounded (at most 2 extra runs) so a truly corrupt
// source cannot burn unbounded compute before failing clearly.
export const MAX_ENCODE_ATTEMPTS = 3;

// Backoff before a re-dispatch, indexed by the attempt number that just FAILED
// (attempt 1 failed -> wait BACKOFF_MS[0] before dispatching attempt 2, etc.).
// Short, bounded waits: the failures are transient transport blips, so a brief
// pause lets a momentarily-exhausted connection pool or a flapping ingress
// settle without holding the job hostage. Values are milliseconds.
//
// The scaler re-dispatches by re-queuing the job; the actual wait is applied as
// a "not before" timestamp on the re-queued job (see retry-store.ts) so the
// scaler loop does not block. 15s, then 60s.
export const BACKOFF_MS: readonly number[] = [15_000, 60_000];

// Case-insensitive substring signatures. Kept as lowercase needles matched
// against a lowercased haystack so the match is robust to Encore casing changes.
const TRANSPORT_SIGNATURES: readonly string[] = [
  'sdkclientexception',
  'acquire operation took longer than the configured maximum time',
  'unable to execute http request',
  'connection pool shut down',
  'connection reset',
  'read timed out',
  'connection timed out'
];

// Demux / input-side read I/O signatures. Per #293 these appear on BOTH a
// transport-severed read of an intact source AND a genuinely corrupt source, so
// they are treated as retryable (the bound protects against a corrupt source).
const IO_RETRYABLE_SIGNATURES: readonly string[] = [
  'error during demuxing: i/o error',
  'i/o error',
  'stream ends prematurely',
  'corrupt input packet',
  'invalid nal unit size'
];

// Classify an Encore failure by its `message` string. An empty/absent message
// is treated as 'deterministic' (we have no transport evidence, so do not burn
// retries on an unexplained failure).
//
// This function only ever returns the three MESSAGE-DERIVED classes
// ('transport' | 'io-retryable' | 'deterministic'). It NEVER returns
// 'interrupted_by_scaledown': scale-down interruption is a topology event, not a
// property of any failure string, so it is classified structurally at the
// drain/teardown boundary (see scaler-loop.ts) — never inferred from a message.
// This guarantees a genuine 'deterministic' failure message can never be
// reclassified as scale-down interruption (#514 acceptance criterion).
export function classifyEncoreFailure(message: string | undefined): MessageFailureClass {
  if (!message) return 'deterministic';
  const hay = message.toLowerCase();
  // Transport signatures take precedence — a transport failure that also
  // mentions a demux error (e.g. a severed read that surfaces as demux) is still
  // a transport failure.
  for (const needle of TRANSPORT_SIGNATURES) {
    if (hay.includes(needle)) return 'transport';
  }
  for (const needle of IO_RETRYABLE_SIGNATURES) {
    if (hay.includes(needle)) return 'io-retryable';
  }
  return 'deterministic';
}

// Is this failure class eligible for a bounded retry?
//
// 'interrupted_by_scaledown' (#514) is CLEARLY recoverable: the job never failed,
// its worker was removed mid-flight, so it must be auto-retried by re-enqueue with
// no operator intervention. Unlike the transport/IO classes, its recoverability is
// not bounded by MAX_ENCODE_ATTEMPTS on the message-retry path — it does not
// consume a genuine encode attempt (the run produced no failure), and re-enqueue
// is handled directly at the drain boundary rather than via decideRetry().
export function isRetryableFailureClass(cls: FailureClass): boolean {
  return (
    cls === 'transport' ||
    cls === 'io-retryable' ||
    cls === 'interrupted_by_scaledown'
  );
}

// Is this failure class a scale-down interruption (#514)? A tiny, explicit
// predicate so downstream code can treat "work lost to a topology event" distinctly
// from a real processing failure without string-comparing the union member.
export function isScaleDownInterruption(cls: FailureClass): boolean {
  return cls === 'interrupted_by_scaledown';
}

// Milliseconds to wait before dispatching the NEXT attempt, given how many
// attempts have already been made (>= 1). Clamps to the last configured value
// for attempt counts beyond the table.
export function backoffForAttempt(attemptsSoFar: number): number {
  if (attemptsSoFar < 1) return 0;
  const idx = Math.min(attemptsSoFar - 1, BACKOFF_MS.length - 1);
  return BACKOFF_MS[idx];
}
