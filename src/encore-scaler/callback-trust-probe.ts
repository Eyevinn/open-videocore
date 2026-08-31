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
//   - The dispatch-time callback URI is `${callbackListenerUrl}/encoreCallback`
//     (src/encore-scaler/scaler-loop.ts:272-273). We probe the ingress ORIGIN,
//     not a specific route, so a 404 from the listener still proves the TLS
//     trust path is established (the handshake completed).
//   - Node global fetch + AbortSignal.timeout for the bounded wait: same
//     fetch(...) usage the scaler already relies on in scaler-loop.ts:275 and
//     reconcile() (scaler-loop.ts:214-220), with a bounded timeout added.

// Result of a single probe attempt. `ok` means the TLS handshake to the ingress
// completed (any HTTP status counts — even a 404 proves trust). `errorClass`
// distinguishes a genuine trust/handshake failure (the #463 race) from a
// plain timeout so the caller can surface a precise structured error.
export type CallbackTrustProbeResult =
  | { ok: true }
  | { ok: false; errorClass: 'tls-trust' | 'timeout' | 'connection'; detail: string };

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

// Perform ONE bounded TLS-trust probe against the callback-listener ingress
// origin. Resolves to { ok: true } if the HTTPS request completes a handshake
// (any HTTP status), else classifies the failure. Never throws.
export async function probeCallbackTrust(
  callbackListenerUrl: string,
  timeoutMs: number,
  fetchImpl: FetchLike = fetch as unknown as FetchLike
): Promise<CallbackTrustProbeResult> {
  let origin: string;
  try {
    // Probe the ingress ORIGIN — the handshake is to the hostname, so the exact
    // path is irrelevant; a 404 still proves the cert is trusted.
    origin = new URL(callbackListenerUrl).origin;
  } catch {
    return {
      ok: false,
      errorClass: 'connection',
      detail: `invalid callbackListenerUrl: ${callbackListenerUrl}`
    };
  }

  try {
    // A HEAD keeps the probe cheap; we only need the handshake to complete.
    await fetchImpl(origin, {
      method: 'HEAD',
      signal: AbortSignal.timeout(timeoutMs)
    });
    // Any HTTP response — including 404/405 — means the TLS handshake succeeded
    // and the ingress certificate is issued and trusted. Trust path confirmed.
    return { ok: true };
  } catch (err) {
    const detail = stringifyError(err);
    const isTimeout =
      err instanceof Error &&
      (err.name === 'TimeoutError' || err.name === 'AbortError');
    if (isTimeout) {
      return { ok: false, errorClass: 'timeout', detail: `probe timed out after ${timeoutMs}ms` };
    }
    const lower = detail.toLowerCase();
    if (TLS_TRUST_SIGNATURES.some((sig) => lower.includes(sig.toLowerCase()))) {
      return { ok: false, errorClass: 'tls-trust', detail };
    }
    // Any other network error (DNS not yet resolving, connection refused while
    // the ingress spins up): still not ready for a first job, but not a cert
    // problem. Treated the same as a timeout for gating (retry next tick).
    return { ok: false, errorClass: 'connection', detail };
  }
}
