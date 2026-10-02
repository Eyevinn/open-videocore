// Structural classification of errors thrown by @osaas/client-core (#1071).
//
// Why this exists: every retry loop in the scaler used to decide "is this
// transient?" by SUBSTRING-MATCHING the error message for '500' / '502' / '503'.
// That is wrong in both directions and it cost a production incident:
//
//   - A real gateway timeout was NEVER retried. OSC's ingress answers a
//     createInstance that outruns the gateway with an HTML error page whose text
//     is "<html><head><title>504 Gateway Time-out</title>..." — '504' was not in
//     the list, so the spawn was classified non-transient and thrown on attempt 1.
//   - Any message that merely CONTAINED '503' anywhere (an id, a byte count, a
//     timestamp) was retried as if it were a 503.
//
// The platform side of this — a synchronous createInstance that answers 504 while
// a new worker node is provisioned, with no idempotency key to make the retry
// unambiguous — is logged as OSC friction in the engagement repo and summarised
// on issue #1071; nothing in this repository can prevent the 504 itself.
//
// The error carries the status structurally and always has: @osaas/client-core's
// defaultErrorFactory builds `new FetchError({ message, httpCode: response.status })`
// for every non-ok response, so the number is on the object.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - @osaas/client-core@0.24.0 lib/fetch.js `defaultErrorFactory` — on a non-ok
//     response it throws `FetchError` with `httpCode: response.status` (the JSON
//     branch takes `message` from `res.message ?? res.reason ?? JSON.stringify(res)`,
//     the non-JSON branch from `response.text()`, which is the HTML 504 page).
//   - @osaas/client-core@0.24.0 lib/fetch.d.ts —
//     `class FetchError extends Error { httpCode?: number }`, i.e. httpCode is
//     OPTIONAL: `createFetch`'s outer catch re-wraps a transport-level failure as
//     `new FetchError({ message: getErrorMessage(error) })` with NO httpCode.
//     That is why the message fallback below still exists.
//   - `FetchError` is re-exported from the package root (lib/index.d.ts
//     `export { createFetch, FetchError } from './fetch'`), but this module
//     deliberately duck-types `httpCode` instead of using `instanceof`: an error
//     that crossed a module/realm boundary (or a test double) still classifies
//     correctly.
//   - createInstance's "name is already taken" response — the same condition
//     src/routes/provision.ts:828 and src/services/packager-provisioning.ts:273
//     already match ('already taken' / 'already exists'), which reach this code
//     as a FetchError message because createInstance surfaces the server's JSON
//     `message` field verbatim (lib/fetch.js defaultErrorFactory, JSON branch).

// The numeric HTTP status an OSC client error carries, when it has one.
// Returns undefined for transport-level failures (DNS, reset sockets), which
// @osaas/client-core reports as a FetchError with no httpCode.
export function oscHttpCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const code = (err as { httpCode?: unknown }).httpCode;
  return typeof code === 'number' && Number.isFinite(code) ? code : undefined;
}

// Message markers for failures that never reach a status code: the orchestrator's
// own transient signals and Node's transport errors. Only consulted when the
// error carries NO httpCode — a response with a status is classified on that
// status alone, so a 400 whose body happens to quote "ECONNRESET" is not retried.
const TRANSIENT_MESSAGE_MARKERS = [
  'ORCHESTRATOR_UNAVAILABLE',
  'ORCHESTRATOR_AUTH_TRANSIENT',
  'ECONNRESET',
  'ECONNREFUSED',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'socket hang up',
  'context deadline exceeded'
];

// Should a failed OSC call be retried?
//
//   - 5xx (500, 502, 503 and — the #1071 regression — 504) => transient.
//     A 504 specifically means the request is STILL IN PROGRESS behind the
//     gateway: OSC answers it while a new worker node is being provisioned, and
//     the instance usually does get created. Callers must therefore pair the
//     retry with adopt-on-"already taken" (isNameAlreadyTakenError below).
//   - Any other status, 4xx above all => permanent. A rejected request body, a
//     bad token or an exhausted quota will fail identically on every attempt;
//     retrying burns the back-off budget and delays the real error.
//   - No status at all => fall back to the transport/orchestrator markers.
export function isTransientOscError(err: unknown): boolean {
  const httpCode = oscHttpCode(err);
  if (httpCode !== undefined) return httpCode >= 500 && httpCode <= 599;
  const message = err instanceof Error ? err.message : String(err ?? '');
  return TRANSIENT_MESSAGE_MARKERS.some((marker) => message.includes(marker));
}

// Did createInstance fail because an instance of that name ALREADY EXISTS?
//
// This is the signal that a previous attempt landed even though it reported a
// failure — the normal outcome after a 504, where the create completed behind
// the gateway. The caller adopts the existing instance via getInstance rather
// than failing or creating a duplicate, exactly as src/routes/provision.ts does
// (#417). Matched on the message because the server's text is the only place the
// condition appears (it is returned as a 4xx, so the status cannot distinguish
// it from any other rejected create).
export function isNameAlreadyTakenError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? '');
  const lower = message.toLowerCase();
  return lower.includes('already taken') || lower.includes('already exists');
}
