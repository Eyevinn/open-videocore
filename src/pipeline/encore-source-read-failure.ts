// Source-read failure recognition for Encore transcode failures (issue #1060).
//
// THE PROBLEM
// -----------
// When Encore cannot read the source object, the failure reaches the caller as
// one opaque sentence on the execution's `transcode` step:
//
//   dropped by Encore: ffprobe failed for input s3://<bucket>/<key>:
//   Server returned 404 Not Found
//
// Everything needed to act on that is in the string and nothing is in a field,
// so the caller has to open the Encore job and then the bucket to learn that the
// key is simply absent (#1060, broken out of #1057). This module recognises that
// class of failure and turns it into a `StepErrorDetail` with a stable code, the
// redacted source location (URL + bucket + key), the HTTP status and the
// correlation ids. The step's free-text `error` is left exactly as it is.
//
// WHY WE PARSE TEXT AT ALL
// ------------------------
// For the identical reason #1101's HTTP-failure parser does: neither call site
// has structured fields to carry. Encore's failure detail is a Java/ffmpeg error
// string produced INSIDE the Encore container and reaches us as free text on the
// job document's `message` field; nothing between there and here can add fields
// to it. So the parser IS the contract boundary, and it is kept pure and
// separately tested for that reason.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
// -----------------------------------------------------------
//   - Encore job document field names. The failure detail is `message`, the
//     correlation id is `externalId`, the state is `status` — `encoreCallbackSchema`,
//     src/routes/internal.ts:122-127, under the SMOKE-TEST-CONFIRMED field list
//     at src/routes/internal.ts:101-112 ("message — error message when
//     status=FAILED"). The scaler reads the SAME two fields off the per-instance
//     `findByStatus?status=FAILED` page
//     (`Array<{ externalId?: string; message?: string }>`,
//     src/encore-scaler/scaler-loop.ts:660-664). The status enum is normalised in
//     src/pipeline/encore-client.ts:101-107. No new field is read here: this
//     module only ever sees the `message` text those call sites already carry.
//   - The two text shapes that carry an HTTP status:
//       * `Server returned HTTP response code: <status> for URL: <url>` — the
//         fixed JDK `HttpURLConnection#getInputStream` format string, already
//         parsed by `parseHttpFailureDetail` (src/encore-scaler/retry-policy.ts:199-220).
//         REUSED here rather than re-parsed.
//       * `ffprobe failed for input <uri>: Server returned <status> <text>` —
//         #1058's verbatim source-read failure, recorded in-repo as the
//         `FFPROBE_404` fixture at
//         src/encore-scaler/profiles-index-auth-retry.test.ts:99-101 and quoted
//         again in #1060's problem statement.
//   - The source location shape. The transcode path always submits
//     `inputUri = s3://${sourceBucket}/${sourceObjectKey}`
//     (src/pipeline/transcode.ts:140), passed through as
//     `inputs: [{ uri: input.inputUri, type: 'AudioVideo' }]`
//     (src/pipeline/encore-client.ts:95). Split with the existing
//     `parseS3Uri` (src/routes/assets.ts:1381), not a new regex.
//   - Redaction helpers (reused, not re-implemented):
//       * `stripCredentials` — removes userinfo from a URL-shaped string
//         (src/services/param-store.ts:138).
//       * `redactLogQueryStrings` — strips query strings, which is where a live
//         presigned SigV4 signature lives (src/pipeline/osc-job-log.ts:41).
//
// WHAT THIS MODULE DOES NOT DO
// ----------------------------
// It does NOT change retry classification. `classifyEncoreFailure`
// (src/encore-scaler/retry-policy.ts:293) is untouched: an ffprobe 404 stays
// `deterministic` (the object genuinely is not there, re-running reproduces it)
// and a connection-class read stays retryable on the `transport` class. This
// module only decides how an ALREADY-SETTLED failure is DESCRIBED, so it cannot
// cause or suppress a retry.

import { parseHttpFailureDetail, isProfilesIndexUrl } from '../encore-scaler/retry-policy.js';
import { stripCredentials } from '../services/param-store.js';
import { redactLogQueryStrings } from './osc-job-log.js';
import { parseS3Uri } from '../routes/assets.js';
import type { StepErrorDetail } from './step-error-detail.js';

// Cap on the underlying storage error carried in the response. Encore messages
// are short sentences, but a Java stack trace can arrive on `message` and the
// detail is served to API callers, so it is bounded. Far below
// MAX_LOG_CHARS (4000, src/pipeline/osc-job-log.ts:28) because this one is for
// a caller to read, not for an operator to grep.
export const MAX_STORAGE_ERROR_CHARS = 600;

// URL-shaped tokens inside a free-text message. Deliberately stops at the
// characters that end a URL in prose (whitespace, quotes, angle brackets,
// comma, closing paren) and nothing else, so a trailing `:` or `.` stays
// attached and is trimmed separately by trimUriPunctuation.
const URL_TOKEN_RE = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>,)]+/gi;

// Redact credentials out of a free-text message by delegating to the two
// existing helpers: every URL token is round-tripped through `stripCredentials`
// (userinfo removed, src/services/param-store.ts:138) and the result is passed
// through `redactLogQueryStrings` (query strings removed, which is where a live
// presigned SigV4 signature lives, src/pipeline/osc-job-log.ts:41).
//
// Deny-list, same caveat as `redactLogQueryStrings` itself: it removes the two
// forms we know carry credentials and cannot be relied on to sanitise a form
// nobody has anticipated. That is acceptable here because the input is an error
// string from a service we do not control and the alternative — publishing it
// unredacted, which is what happens today on `error` — is strictly worse.
export function redactUrlsInText(text: string): string {
  return redactLogQueryStrings(text.replace(URL_TOKEN_RE, (token) => stripCredentials(token)));
}

// Trailing punctuation that belongs to the sentence, not to the URI. #1058's
// text is `... for input s3://bucket/key: Server returned 404 ...`, so the
// colon that introduces the status would otherwise be captured as part of the
// object key.
function trimUriPunctuation(uri: string): string {
  return uri.replace(/[:;,.]+$/, '');
}

// `input <uri>` — the structured marker that the URI names the INPUT rather than
// the output or a sidecar fetch. Accepts the separator forms seen in ffmpeg /
// ffprobe diagnostics (`input s3://…`, `input: s3://…`, `input="s3://…"`).
const INPUT_URI_RE = /\binput[\s:=]+["']?((?:s3|https?|gs|file|ftp):\/\/[^\s"'<>,)]+)/i;

// The first URL-shaped token anywhere in the message. Only consulted when the
// message is an ffprobe failure (see extractInputUri).
const ANY_URI_RE = /\b(?:s3|https?|gs|file|ftp):\/\/[^\s"'<>,)]+/i;

// The HTTP statuses that mean "this read could not be satisfied", as scoped by
// #1060. NARROW ON PURPOSE:
//   404 — the object is not there. This is #1058/#1060's actual case and the
//         single most common one: a misrouted or already-deleted source key.
//   403 — a permissions / credentials verdict on the object.
// Every other status is left alone and produces NO structured code, so a 5xx
// from the storage (a platform problem, not a source problem) is not mislabelled
// as "your key is missing".
const SOURCE_READ_STATUSES: ReadonlySet<number> = new Set([403, 404]);

// Connection-class read failures: the read never got far enough to receive an
// HTTP status. Lowercase needles matched against a lowercased haystack, the same
// convention as src/encore-scaler/retry-policy.ts:135-156.
//
// The first four are the EXACT needles that module already maintains for
// transport-class failures (retry-policy.ts:140-144), reused verbatim so the two
// lists describe the same population. The rest are the sibling members of the
// same JDK/AWS-SDK exception family. Over-matching is contained: this list is
// AND-ed with "the message names an input URI" below, so a connection failure
// that is not about an input can never be labelled a source read.
const CONNECTION_ERROR_SIGNATURES: readonly string[] = [
  'unable to execute http request',
  'connection reset',
  'read timed out',
  'connection timed out',
  'connection refused',
  'no route to host',
  'unknownhostexception',
  'sockettimeoutexception',
  'connectexception'
];

// The structured facts recovered from a source-read failure message.
export type SourceReadFailure = {
  // The input location, credentials redacted.
  url: string;
  // Bucket/key, when the location was an `s3://bucket/key` URI (which is what
  // the transcode path always submits — src/pipeline/transcode.ts:140). Split
  // out of the REDACTED `url` above, so neither can carry userinfo or a
  // presigned query string.
  bucket?: string;
  key?: string;
  // The HTTP status the storage answered, when the text carried one. Absent for
  // a connection-class failure.
  httpStatus?: number;
  // The underlying failure text, redacted and length-bounded.
  storageError: string;
};

// The HTTP status a failure text reports, from the two verified shapes:
//   1. `Server returned HTTP response code: <status> for URL: <url>` — the JDK
//      format string, via the existing parser (retry-policy.ts:209).
//   2. `Server returned <status> <text>` — #1058's shorter ffprobe form
//      (`Server returned 404 Not Found`), recorded as the FFPROBE_404 fixture at
//      src/encore-scaler/profiles-index-auth-retry.test.ts:99-101.
// Returns undefined when the text carries neither, which is the normal case for
// a connection-class failure.
export function parseStorageStatus(message: string): number | undefined {
  const jdk = parseHttpFailureDetail(message);
  if (jdk) return jdk.status;
  const short = /\bserver returned\s+(\d{3})\b/i.exec(message);
  if (!short) return undefined;
  const status = Number(short[1]);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

// The input URI a failure text names, or undefined.
//
// Two ways in, both structural rather than prose-matching:
//   1. The text names the input explicitly (`... input <uri> ...`). This is
//      #1058's shape and the one the transcode path produces.
//   2. The text is an `ffprobe` failure. ffprobe only ever reads INPUTS, so a
//      URI in an ffprobe failure is an input URI even when the word "input" was
//      not printed next to it.
// Anything else yields undefined, which is what keeps an output-write failure or
// a sidecar fetch from being labelled a source read.
export function extractInputUri(message: string): string | undefined {
  const named = INPUT_URI_RE.exec(message);
  if (named) return trimUriPunctuation(named[1]);
  if (!/\bffprobe\b/i.test(message)) return undefined;
  const any = ANY_URI_RE.exec(message);
  return any ? trimUriPunctuation(any[0]) : undefined;
}

// Recognise a source-read failure in an Encore failure message.
//
// Returns the structured facts when ALL of the following hold, and undefined
// otherwise (the caller then surfaces the failure exactly as it does today):
//   1. The message names an input URI (extractInputUri).
//   2. That URI is not the profiles index. Defensive: a 401/403 on the
//      unauthenticated profiles index is an edge-auth lapse, a different failure
//      with its own handling (#1101, retry-policy.ts:271) — it must never be
//      reported as "your source could not be read". The profiles index is
//      fetched by Encore itself, never named as an input, so this guard should
//      be unreachable; it is here so it stays unreachable.
//   3. The failure is a read verdict: a 403/404 from the storage, or a
//      connection-class error.
//
// Total and side-effect free: safe to call on any failure text, including the
// generic gone-from-active-set wording and an undefined message.
export function parseSourceReadFailure(
  message: string | undefined
): SourceReadFailure | undefined {
  if (!message || message.trim().length === 0) return undefined;

  const rawUri = extractInputUri(message);
  if (!rawUri) return undefined;
  if (isProfilesIndexUrl(rawUri)) return undefined;

  const httpStatus = parseStorageStatus(message);
  const haystack = message.toLowerCase();
  const isConnectionError = CONNECTION_ERROR_SIGNATURES.some((needle) =>
    haystack.includes(needle)
  );
  if (!(httpStatus !== undefined && SOURCE_READ_STATUSES.has(httpStatus)) && !isConnectionError) {
    return undefined;
  }

  // Redact BEFORE anything is kept: the url, the bucket/key pair and the
  // storage error all leave this module straight onto an API response.
  //
  // `bucket`/`key` are split out of the REDACTED `url`, never out of `rawUri`.
  // `parseS3Uri`'s bucket group is `[^/]+` (src/routes/assets.ts:1594), so on a
  // raw URI a `key-id:secret@` userinfo segment lands in `bucket` and a
  // presigned `?X-Amz-Signature=…` query string lands in `key` — both then get
  // interpolated into `message` by describe() below, which would publish on two
  // response fields exactly what `url` redacts on the third. Splitting the
  // redacted value instead keeps url/bucket/key internally consistent (they
  // could previously disagree) and costs nothing in the normal case: the
  // transcode path submits a clean `s3://${sourceBucket}/${sourceObjectKey}`
  // (src/pipeline/transcode.ts:140), and `stripCredentials`' `new URL`
  // round-trip (src/services/param-store.ts:162-172) leaves such a URI byte
  // identical, so the pair still parses to the real bucket and key.
  const url = redactUrlsInText(rawUri);
  const s3 = parseS3Uri(url);
  const redactedText = redactUrlsInText(message.trim());
  const storageError =
    redactedText.length > MAX_STORAGE_ERROR_CHARS
      ? `${redactedText.slice(0, MAX_STORAGE_ERROR_CHARS)}…`
      : redactedText;

  return {
    url,
    ...(s3 ? { bucket: s3.bucket, key: s3.key } : {}),
    ...(httpStatus !== undefined && SOURCE_READ_STATUSES.has(httpStatus) ? { httpStatus } : {}),
    storageError
  };
}

// The caller-facing sentence. Names the condition in the terms the remedy is
// expressed in — "the key is absent" / "access was denied" — rather than
// repeating the raw status, which is carried as a field anyway.
function describe(failure: SourceReadFailure): string {
  const where = failure.bucket && failure.key
    ? `bucket "${failure.bucket}", key "${failure.key}"`
    : failure.url;
  if (failure.httpStatus === 404) {
    return `the transcode source could not be read: storage answered 404 (the object does not exist) for ${where}`;
  }
  if (failure.httpStatus === 403) {
    return `the transcode source could not be read: storage answered 403 (access denied) for ${where}`;
  }
  return `the transcode source could not be read: the connection to storage failed for ${where}`;
}

// Build the structured step error for a source-read failure, or undefined when
// the failure is not one.
//
// This is the ONE function the settle paths call, so every path that fails a
// transcode step produces an identical detail for the same failure text. The
// three paths are:
//   - releasePipelineLock (src/pipeline/failed-transcode-reconciler.ts) — the
//     #273 stall sweep and the scaler's reconcile-detected drop (main.ts
//     onJobsDropped), which is the path #1060 actually observed.
//   - the completion poller's FAILED settle (src/pipeline/encore-callback-poller.ts).
//   - POST /api/v1/internal/encore-callback (src/routes/internal.ts).
export function buildSourceReadErrorDetail(args: {
  // The failure text as the settle path has it, including any
  // `dropped by Encore: ` prefix — the parsers SEARCH, so the prefix is
  // immaterial (same property #1101 relies on, retry-policy.ts:196-198).
  failureText: string | undefined;
  encoreJobId?: string;
  assetId?: string;
}): StepErrorDetail | undefined {
  const failure = parseSourceReadFailure(args.failureText);
  if (!failure) return undefined;
  return {
    code: 'source_read_failed',
    message: describe(failure),
    storageError: failure.storageError,
    ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
    source: {
      url: failure.url,
      ...(failure.bucket !== undefined ? { bucket: failure.bucket } : {}),
      ...(failure.key !== undefined ? { key: failure.key } : {})
    },
    ...(args.encoreJobId ? { encoreJobId: args.encoreJobId } : {}),
    ...(args.assetId ? { assetId: args.assetId } : {})
  };
}
