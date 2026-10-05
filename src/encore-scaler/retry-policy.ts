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
//   'transport'         — infrastructure failure, not a media or configuration
//                         fault. Signatures (case-insensitive substring match on
//                         the Encore `message`):
//                           * "SdkClientException"
//                           * "Acquire operation took longer than the configured
//                              maximum time" / "pool" + "acquire" timeout (write, #292)
//                           * "Unable to execute HTTP request"
//                         PLUS one STRUCTURED rule, added by #1101 and matched on
//                         the HTTP status code + URL path rather than on prose:
//                           * HTTP 401 or 403 on the unauthenticated profiles
//                             index (`/api/v1/profiles/index.yml`) — the OSC
//                             login-wall exemption lapsing at the edge, which
//                             #1091 observed clearing on its own.
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

// ---------------------------------------------------------------------------
// STRUCTURED HTTP FAILURE DETAIL (#1101) — status code + URL, not English prose
// ---------------------------------------------------------------------------
//
// WHY A PARSER AND NOT ANOTHER SIGNATURE STRING
// --------------------------------------------
// The two signature lists above are hand-maintained English needles, and that
// shape has now missed the same kind of failure twice in one day: #1071 (an OSC
// 504 missed because the list held 500/502/503) and #1091 (a 401 on the
// profiles index missed because no needle covered it). An HTTP failure carries
// two pieces of STRUCTURED data — the status code and the URL — and the
// decision below is made on those two values only. One parser, tested
// independently, is the single place that turns the text back into structure.
//
// WHY WE HAVE TO PARSE AT ALL
// ---------------------------
// Neither call site has structured fields to carry. The failure detail reaches
// classifyEncoreFailure as free text in both paths:
//   - callback path: `job.message ?? 'encore status: ...'`
//     (src/pipeline/encore-callback-poller.ts:552)
//   - drop path:     `dropped by Encore: ${reason}`
//     (src/main.ts:1357-1360), where `reason` is the FAILED encoreJob
//     document's own `message` (#704).
// Encore's `message` is a Java exception string produced INSIDE the Encore
// container; nothing between there and here can add fields to it. So the status
// and URL only exist as text, and the parser is the contract boundary.
//
// CONTRACT SOURCE FOR THE TEXT SHAPE (CLAUDE.md rule 7)
// -----------------------------------------------------
// Encore fetches its profile index with Java's UrlResource — a plain,
// tokenless GET (documented at src/services/profiles-reachability.ts:1-10 and
// src/encore-scaler/instance-pool.ts:625-628, which forwards `profilesUrl`).
// On a non-2xx, `java.net.HttpURLConnection#getInputStream` throws
//   java.io.IOException("Server returned HTTP response code: " + respCode +
//                       " for URL: " + url)
// — a fixed JDK format string, not Encore wording. Both observed instances are
// recorded verbatim on issues #1091 and #110:
//   "Server returned HTTP response code: 401 for URL: .../api/v1/profiles/index.yml"
//   "java.io.IOException: Server returned HTTP response code: 401 for URL: ..."
// and the drop path prefixes "dropped by Encore: ", which is why this is a
// SEARCH for the pattern rather than a whole-string match.
const JAVA_HTTP_FAILURE_RE = /server returned http response code:\s*(\d{3})\s+for url:\s*(\S+)/i;

// The structured pair recovered from a failure string: the HTTP status the
// remote answered and the URL it was answered for.
export type HttpFailureDetail = { readonly status: number; readonly url: string };

// THE single parser (#1101). Recovers { status, url } from an Encore failure
// string, or undefined when the string carries no HTTP failure of this shape.
// Deliberately total and side-effect free so it can be tested on its own; every
// status/URL-driven rule below goes through it and nothing else re-parses.
export function parseHttpFailureDetail(
  message: string | undefined
): HttpFailureDetail | undefined {
  if (!message) return undefined;
  const match = JAVA_HTTP_FAILURE_RE.exec(message);
  if (!match) return undefined;
  const status = Number(match[1]);
  // The regex already constrains this to three digits; the range check keeps the
  // returned `status` a real HTTP status rather than any 3-digit run.
  if (!Number.isInteger(status) || status < 100 || status > 599) return undefined;
  return { status, url: match[2] };
}

// The app's own public profile index path. The profiles router is mounted at
// `/api/v1/profiles` (src/main.ts:1869-1870) and serves `GET /index.yml`
// (src/routes/profiles.ts:132) WITHOUT authentication, because the Encore
// instances the scaler spawns fetch it with a tokenless GET.
export const PROFILES_INDEX_PATH = '/api/v1/profiles/index.yml';

// Is `url` the profiles index? Compared on the PATH only: the host is whatever
// PUBLIC_BASE_URL resolved to for that deployment (resolveEncoreProfilesUrl,
// src/main.ts:957) and a query string or fragment must never decide this.
//
// Matched with endsWith rather than equality so a deployment served under an
// ingress path prefix (`/<prefix>/api/v1/profiles/index.yml`) still matches, and
// so an excerpt whose host was elided (".../api/v1/profiles/index.yml", exactly
// as recorded on #1091) still matches. A URL that merely MENTIONS the path in a
// query parameter does not: the query is stripped before comparison.
export function isProfilesIndexUrl(url: string): boolean {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    // Not an absolute URL (a truncated or host-elided excerpt). Strip the query
    // and fragment and compare what remains.
    pathname = url.split(/[?#]/)[0] ?? '';
  }
  return pathname.toLowerCase().endsWith(PROFILES_INDEX_PATH);
}

// The ONLY statuses that make a profiles-index fetch retryable (#1101).
//
// NARROW ON PURPOSE. 401 and 403 are credential verdicts everywhere else in the
// system, and treating them as transient in general would burn the whole retry
// budget on a genuinely bad token. They are infrastructure verdicts HERE and
// only here, because this one endpoint is unauthenticated by design: there is no
// in-app auth hook on the profiles router at all (src/routes/profiles.ts:20-24),
// so nothing inside this process can produce a 401/403 for it. The only thing
// that can is the OSC login wall at the platform edge, whose exemption for
// `/api/v1/profiles` is recorded as UNCONFIRMED
// (src/services/profiles-reachability.ts:28-37). A 401/403 on this path
// therefore means "the edge exemption lapsed", which is transient — confirmed in
// #1091, where the SAME instance then ran a second asset on the SAME profile.
//
// Every other status on this URL stays deterministic, 404 above all: a 404 means
// the index genuinely is not being served, and re-running produces it again.
const PROFILES_INDEX_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([401, 403]);

// Is this failure an edge-auth rejection of the unauthenticated profiles index
// (#1101)? True only when BOTH structured facts hold: the status is 401 or 403
// AND the URL path is the profiles index. A 401 from any other URL, and any
// other status on the profiles index, are both false.
export function isProfilesIndexAuthFailure(message: string | undefined): boolean {
  const detail = parseHttpFailureDetail(message);
  if (!detail) return false;
  return PROFILES_INDEX_RETRYABLE_STATUSES.has(detail.status) && isProfilesIndexUrl(detail.url);
}

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
//
// Fixing it HERE fixes both observation paths at once (#1091 acceptance
// criterion): the callback path (encore-callback-poller.ts:555) and the
// reconcile drop path (main.ts:1402) both reach decideRetry, which classifies
// through this one function (retry-store.ts:284). Neither call site changes.
export function classifyEncoreFailure(message: string | undefined): MessageFailureClass {
  if (!message) return 'deterministic';

  // #1101: the structured rule runs FIRST, and is the only rule driven by data
  // rather than prose. An edge-auth rejection of the unauthenticated profiles
  // index is infrastructure, not credentials and not media, so it is retried on
  // the existing 'transport' class — the class that already means "the failure
  // was in the plumbing, re-running is cheap resilience".
  //
  // Why 'transport' and not a new class: MessageFailureClass IS the
  // caller-facing `encodeAttemptLog[].classification` enum, asserted in sync
  // with the published `FAILURE_CLASSES` at src/routes/jobs.ts:30-38 by a
  // compile-time guard. Adding a member would widen a public API enum, which is
  // #515's scope, not this fix's. 'transport' already carries exactly the right
  // retry semantics (bounded by MAX_ENCODE_ATTEMPTS, 15s/60s backoff).
  if (isProfilesIndexAuthFailure(message)) return 'transport';

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
  // Every other HTTP status, on every URL, stays deterministic — including a
  // 404 from a misrouted source (#1058's `ffprobe failed ... Server returned 404
  // Not Found`), which is correct: the object genuinely is not there. #1101
  // explicitly does NOT widen this to all HTTP error codes.
  //
  // The #1071 504 gap is NOT reopened here. That gap was in the OSC
  // createInstance retry classifier, not this one, and it is already fixed
  // structurally: isTransientOscError keys off the error's own `httpCode` and
  // treats the whole 5xx range (504 included) as transient
  // (src/encore-scaler/osc-error.ts:98-108), consumed by spawnInstance and the
  // callback-listener creation loop (instance-pool.ts:690, :745). An Encore
  // ENCODE failure is a different population: a 5xx from a source or a sidecar
  // is not automatically worth a re-encode, so no general 5xx rule is added to
  // this classifier.
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
