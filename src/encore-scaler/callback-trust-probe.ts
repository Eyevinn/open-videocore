// Outbound TLS-trust readiness probe for a per-instance callback-listener
// ingress (issue #463).
//
// WHY THIS EXISTS
// ---------------
// Each scaler-spawned Encore instance is paired with a per-instance
// callback-listener OSC instance (instance-pool.ts:216-254). The scaler injects
// `progressCallbackUri = ${callbackListenerUrl}/encoreCallback` at dispatch time
// (scaler-loop.ts). There is a race between the per-instance callback-listener
// ingress certificate becoming ready/trusted and the instance beginning to
// process — and FAIL — its first job: `waitForInstanceReady` confirms the OSC
// deployment is up, but not that the OUTBOUND TLS trust path to the ingress
// hostname is actually established. A first job dispatched into that window can
// fail with a PKIX/handshake error the moment Encore POSTs its first progress
// callback.
//
// This service cannot observe Encore's outbound socket, but it CAN perform the
// same class of check from THIS process: a real HTTPS request to the
// callbackListenerUrl ingress whose failure would surface as a
// PKIX/handshake/connection error. If we can complete a TLS handshake to that
// exact hostname, the ingress certificate is issued and trusted by the public
// CA chain the Encore instance also uses — so the trust path is established.
// The probe is performed ONCE per instance and its result cached on the
// instance record; a warm instance is never re-probed.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
// ----------------------------------------------------------
//   - EncoreInstanceRecord.callbackListenerUrl?: string — the paired listener's
//     HTTP base URL, undefined until the listener is ready
//     (src/encore-scaler/types.ts:88-89, set in instance-pool.ts:259).
//   - The dispatch-time callback URI is
//     `${inst.callbackListenerUrl.replace(/\/$/, '')}/encoreCallback`
//     (src/encore-scaler/scaler-loop.ts, dispatch(): the `progressCallbackUri`
//     assignment). The probe targets that EXACT URL — see the #814 note below
//     for why probing the bare ingress origin was not enough.
//   - Node global fetch + AbortSignal.timeout for the bounded wait: same
//     fetch(...) usage the scaler already relies on in scaler-loop.ts:275 and
//     reconcile() (scaler-loop.ts:214-220), with a bounded timeout added.
//
// HTTP STATUS IS PART OF THE ANSWER (issue #813)
// ----------------------------------------------
// A completed TLS handshake is necessary but NOT sufficient for the callback
// path to be usable. If the listener ingress answers the probe with 401 or 403,
// the transport is fine but the ingress is REJECTING requests — the progress/
// completion POST Encore makes to `${callbackListenerUrl}/encoreCallback` will
// fail the same way (the 401 observed in #811). Folding that into the trusted
// case made the gate report readiness for a callback path that cannot work, so
// 401/403 is now its own `callback-unusable` state: reachable, trusted at the
// TLS layer, but not usable. Every other status (404/405 from a HEAD on `/`,
// 5xx while the listener finishes booting) still means "trusted" — those prove
// the handshake without proving anything about authorisation.
//
// PROBE THE CALLBACK PATH, NOT THE ORIGIN (issue #814)
// ----------------------------------------------------
// Grading 401/403 as unusable only helps if the URL we grade is the URL Encore
// actually POSTs to. It was not: this probe used to rewrite the target to
// `new URL(callbackListenerUrl).origin`, and on a freshly created listener the
// origin starts answering BEFORE the callback path does. Measured live against
// two throwaway `eyevinn-encore-callback-listener` instances created and
// destroyed for this change (2026-09-26, tenant `oscaidev`), polling from
// instance creation:
//
//   run A (diag814a)              run B (diag814b, ~1s resolution)
//   t+25s origin 200,             t+29s GET /encoreCallback 401 (nginx HTML)
//         /encoreCallback 401     t+30s origin 200, /encoreCallback 401
//   t+41s origin 404 (Fastify),   t+43s origin 200, /encoreCallback 401
//         POST /encoreCallback    t+44s origin 404 (Fastify),
//         200                           GET /encoreCallback 404,
//                                       POST /encoreCallback 200
//
// So for ~14s the origin answers 200 while `/encoreCallback` is still behind
// the ingress auth wall. A 200 is not in CALLBACK_REJECTED_STATUSES, so the
// origin-targeted probe returned 'trusted', `callbackTrustReady` was latched
// (it is sticky), and the instance's first job was dispatched straight into the
// 401 window — the failure reported in #811/#812. Targeting `/encoreCallback`
// makes the 401/403 grading reachable in exactly that window.
//
// Two live facts this relies on, both verified rather than assumed:
//   - In steady state `HEAD`/`GET /encoreCallback` returns Fastify's own 404
//     (`{"message":"Route GET:/encoreCallback not found",...}`), NOT a 401 —
//     checked unauthenticated on three warm instances on 2026-09-26. 404 is not
//     a rejected status, so a healthy listener still grades as 'trusted'.
//   - During the window the ingress verdict is method-independent: `GET`,
//     `HEAD` and `POST` on `/encoreCallback` returned 401 together in run B and
//     flipped together at t+44s. (#812's finding could only infer this and
//     asked #814 to confirm it directly. Now confirmed.)
//
// The probe deliberately stays on HEAD. A POST would be graded identically but
// would enqueue a synthetic progress callback into the listener's Redis queue.
//
// Why this is a mitigation and not a fix at the real layer: Encore cannot be
// given a credential for this leg at all — see the #814 note in
// docs/osc-feedback/incoming-callback-listener-ingress-auth-window-fresh-instance.md.

// Result of a single probe attempt.
//   - state 'trusted'          — handshake completed AND the ingress did not
//                                reject the request (`ok: true`).
//   - state 'callback-unusable'— handshake completed but the ingress answered
//                                401/403: the callback path is reachable and
//                                rejecting requests, so Encore's callback POST
//                                will fail too (issue #813).
//   - state 'probe-failed'     — no HTTP response at all; `errorClass`
//                                distinguishes a genuine trust/handshake
//                                failure (the #463 race) from a plain timeout
//                                or other connection error so the caller can
//                                surface a precise structured error.
export type CallbackTrustProbeResult =
  | { ok: true; state: 'trusted'; status: number }
  | { ok: false; state: 'callback-unusable'; status: number; detail: string }
  | {
      ok: false;
      state: 'probe-failed';
      errorClass: 'tls-trust' | 'timeout' | 'connection';
      detail: string;
    };

// HTTP statuses from the listener ingress that mean "callback path not usable"
// rather than "trust confirmed" (issue #813). Kept narrow on purpose: only an
// authentication/authorisation rejection proves the callback POST would fail.
const CALLBACK_REJECTED_STATUSES = new Set([401, 403]);

// Substrings that identify a certificate-trust / TLS-handshake failure — the
// exact class of error the #463 race produces before the ingress cert is
// trusted. Matched case-insensitively against the thrown error message and any
// nested `code`/`cause` string.
const TLS_TRUST_SIGNATURES = [
  'PKIX',
  'unable to verify the first certificate',
  'unable to get local issuer certificate',
  'self-signed certificate',
  'self signed certificate',
  'CERT_',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'certificate has expired',
  'handshake',
  'SSL routines',
  'ssl3_'
];

function stringifyError(err: unknown): string {
  if (err instanceof Error) {
    const parts = [err.message];
    // Node fetch wraps the real network error in `cause`; TLS errors also carry
    // a `code` (e.g. 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') and sometimes a nested
    // cause chain. Flatten what we can reach so the signature match sees it.
    const withCode = err as Error & { code?: unknown; cause?: unknown };
    if (typeof withCode.code === 'string') parts.push(withCode.code);
    if (withCode.cause instanceof Error) {
      parts.push(withCode.cause.message);
      const causeCode = (withCode.cause as Error & { code?: unknown }).code;
      if (typeof causeCode === 'string') parts.push(causeCode);
    } else if (typeof withCode.cause === 'string') {
      parts.push(withCode.cause);
    }
    return parts.join(' | ');
  }
  return String(err);
}

// Injectable fetch so tests can drive the handshake outcome without a network.
export type FetchLike = (
  input: string,
  init?: { method?: string; signal?: AbortSignal }
) => Promise<{ status: number }>;

// The path Encore POSTs its progress callbacks to, appended to the paired
// listener's base URL. Must stay byte-identical to the `progressCallbackUri`
// the scaler injects at dispatch time (scaler-loop.ts), because the whole point
// of the probe is to grade the URL Encore will actually use (#814).
export const CALLBACK_PATH = '/encoreCallback';

// Build the exact URL Encore will POST to (strip one trailing slash, append the
// callback path). Used by BOTH the dispatch-time `progressCallbackUri`
// injection and this probe, so the two can never drift apart — a probe of a
// different URL than Encore uses is what #814 was about. Throws if
// `callbackListenerUrl` is not a valid URL.
export function buildCallbackUri(callbackListenerUrl: string): string {
  // Parse for validation only — we keep the caller's base URL rather than
  // reducing it to `origin`, so a listener published under a sub-path still
  // resolves to the same URI the scaler injects.
  new URL(callbackListenerUrl);
  return `${callbackListenerUrl.replace(/\/$/, '')}${CALLBACK_PATH}`;
}

// Perform ONE bounded trust/usability probe against the callback-listener's
// `/encoreCallback` path — the exact URI Encore is told to POST to (#814).
// Resolves to state 'trusted' when the HTTPS request completes a handshake and
// the ingress did not reject it, 'callback-unusable' on a 401/403 (issue #813),
// else classifies the transport failure. Never throws.
export async function probeCallbackTrust(
  callbackListenerUrl: string,
  timeoutMs: number,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<CallbackTrustProbeResult> {
  let target: string;
  try {
    target = buildCallbackUri(callbackListenerUrl);
  } catch {
    return {
      ok: false,
      state: 'probe-failed',
      errorClass: 'connection',
      detail: `invalid callbackListenerUrl: ${callbackListenerUrl}`
    };
  }

  try {
    // A HEAD keeps the probe cheap and, unlike a POST, does not enqueue a
    // synthetic progress callback: the listener has no GET/HEAD route for this
    // path, so a healthy instance answers Fastify's own 404 (verified live,
    // see the header note). We only need the handshake to complete and the
    // ingress's answer to it.
    const res = await fetchImpl(target, {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs)
    });
    // A 401/403 means the handshake succeeded but the ingress is rejecting
    // requests on the callback path itself: Encore's callback POST to this
    // exact URI will be rejected the same way, so the path is NOT usable
    // (issue #813, aimed at the right URL by #814).
    if (CALLBACK_REJECTED_STATUSES.has(res.status)) {
      return {
        ok: false,
        state: 'callback-unusable',
        status: res.status,
        detail: `callback-listener ingress rejected the probe of ${target} with HTTP ${res.status} — the callback path is reachable but not usable`
      };
    }
    // Any other HTTP response — including 404/405 — means the TLS handshake
    // succeeded and the ingress certificate is issued and trusted, with nothing
    // indicating the callback POST would be rejected. Trust path confirmed.
    return { ok: true, state: 'trusted', status: res.status };
  } catch (err) {
    const detail = stringifyError(err);
    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (isTimeout) {
      return {
        ok: false,
        state: 'probe-failed',
        errorClass: 'timeout',
        detail: `probe timed out after ${timeoutMs}ms`
      };
    }
    const lower = detail.toLowerCase();
    if (TLS_TRUST_SIGNATURES.some((sig) => lower.includes(sig.toLowerCase()))) {
      return { ok: false, state: 'probe-failed', errorClass: 'tls-trust', detail };
    }
    // Any other network error (DNS not yet resolving, connection refused while
    // the ingress spins up): still not ready for a first job, but not a cert
    // problem. Treated the same as a timeout for gating (retry next tick).
    return { ok: false, state: 'probe-failed', errorClass: 'connection', detail };
  }
}
