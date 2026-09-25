// Opt-in fronting-layer trust for the UI presence gate (issue #767).
//
// The bundled ops UI is a bare static mount (src/main.ts, `/ui/` via
// @fastify/static) with no app-level auth gate, while the API routes it calls
// sit behind the 401 presence gate (authGate, src/auth/middleware.ts:76-87,
// issue #711). A browser that has already passed the deployment's fronting auth
// layer therefore still needs a bearer credential of its own for those calls.
// This module lets an operator declare that their fronting layer marks such
// already-authenticated browser requests with a header, so the presence gate can
// admit the UI's own same-origin calls without a bearer token.
//
// DEFAULT OFF, AND DELIBERATELY WITHOUT A DEFAULT HEADER NAME. The #766
// investigation (docs/findings/ingress-ui-auth-766.md) concluded that the
// fronting layer's browser-authentication signal is UNCONFIRMED from this
// repository: the ingress configuration is external, the app reads no cookie or
// session anywhere, and no documented, verifiable signal is available (OSC gap
// logged with the agent team). We therefore do NOT guess a signal: the app
// hardcodes no header name and infers nothing. Trust is asserted entirely by the
// operator, who names the header their own fronting layer actually sets. With the
// configuration unset the gate behaves exactly as before — anonymous requests
// from outside the UI keep receiving 401 per #711.
//
// This is trust-by-configuration, exactly like the OVC_TRUST_ROLE_HEADER pattern
// (src/main.ts:442-448 `registerPrincipal`, src/auth/principal.ts:150-172
// `PrincipalOptions.trustRoleHeader`, ADR-018 decision 5): the app never verifies
// the value cryptographically. Spoof-resistance lives in the fronting layer, which
// MUST overwrite or strip any client-supplied copy of the declared header, plus
// the defensive same-origin conditions below. To narrow the blast radius if a
// fronting layer does not strip it, this module ALSO requires:
//   - `Sec-Fetch-Site: same-origin` (a browser-set, JS-unsettable fetch-metadata
//     header) — absent ⇒ NOT trusted (fail closed), and
//   - a `Referer` whose host matches this request's own `Host` and whose path is
//     under the UI mount (`/ui`), so only the UI's own pages qualify, and
//   - optionally an exact expected header value, so an operator whose fronting
//     layer can inject a shared secret gets a signal a direct caller cannot guess.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - Presence gate + the seam this hooks into: src/auth/middleware.ts:23-30
//     (`extractToken`, Authorization/Bearer only), :34-55 (`registerAuth` /
//     `authenticate`, 401 + WWW-Authenticate), :76-87 (`authGate`).
//   - Pure presence semantics: src/auth/workspace.ts:22-32,52-57 (`requireAuth`).
//   - Trust-boundary pattern mirrored: src/auth/principal.ts:36,150-172,193-206
//     (`ROLE_HEADER`, `trustRoleHeader`, strip-or-honour onRequest hook) and
//     src/main.ts:442-448 (`OVC_TRUST_ROLE_HEADER` wiring).
//   - `/ui` mount whose requests this scopes to: src/main.ts:2134-2139
//     (fastifyStatic `prefix: '/ui/'` + `/ui` redirect).
//   - Env-config shape mirrored: src/data/storage-quota.ts:78-84
//     (`storageCapBytesFromEnv` — unset/invalid ⇒ feature off).
//   - Signal status (why there is no default): docs/findings/ingress-ui-auth-766.md.

import { timingSafeEqual } from 'node:crypto';

// Env var naming the header the fronting layer sets on an already-authenticated
// browser request. Unset ⇒ feature disabled (the default).
export const UI_PRESENCE_TRUST_HEADER_ENV = 'OVC_TRUST_UI_PRESENCE_HEADER';

// Optional env var requiring the declared header to carry exactly this value
// (a shared secret injected by the fronting layer). Unset ⇒ any non-empty value.
export const UI_PRESENCE_TRUST_VALUE_ENV = 'OVC_TRUST_UI_PRESENCE_HEADER_VALUE';

// The UI mount a trusted request must have originated from (src/main.ts:2134-2139).
export const UI_PATH_PREFIX = '/ui';

// Headers that may never be nominated as the trust signal. Each is either
// already load-bearing for authentication/routing (`authorization`,
// `x-ovc-role`, `x-stack-name`, `cookie`) or is one of the same-origin
// conditions this module checks (`host`, `referer`, `origin`, `sec-fetch-site`),
// so trusting it would let one client-supplied value satisfy two checks at once.
const FORBIDDEN_TRUST_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'cookie',
  'host',
  'origin',
  'referer',
  'sec-fetch-site',
  'x-ovc-role',
  'x-stack-name'
]);

// Resolved, enabled configuration. Only ever constructed by
// resolveUiPresenceTrust(); `null` everywhere else means "feature off".
export interface UiPresenceTrustConfig {
  // Lowercased header name (Fastify lowercases inbound header keys, mirroring
  // the ROLE_HEADER read at src/auth/principal.ts:36).
  headerName: string;
  // When set, the header value must match this exactly. When absent, any
  // non-empty single value qualifies.
  expectedValue?: string;
}

// Why the feature is on or off, so the caller can log it once at startup instead
// of silently ignoring a misconfiguration.
//   - 'disabled'              : env var unset/blank — the default, no behaviour change.
//   - 'forbidden-header-name' : an operator nominated a header that must not be
//                               trusted; fail closed (feature stays off).
//   - 'enabled'               : the deployment has opted in.
export type UiPresenceTrustResolution =
  | { config: null; reason: 'disabled' }
  | { config: null; reason: 'forbidden-header-name'; headerName: string }
  | { config: UiPresenceTrustConfig; reason: 'enabled' };

// Read the opt-in configuration off the environment. Mirrors
// storageCapBytesFromEnv (src/data/storage-quota.ts:78-84): anything missing or
// unusable resolves the feature OFF rather than throwing, so a misconfigured
// deployment keeps today's 401 behaviour instead of failing to boot.
export function resolveUiPresenceTrust(
  env: NodeJS.ProcessEnv = process.env
): UiPresenceTrustResolution {
  const rawName = env[UI_PRESENCE_TRUST_HEADER_ENV];
  if (typeof rawName !== 'string' || rawName.trim().length === 0) {
    return { config: null, reason: 'disabled' };
  }

  const headerName = rawName.trim().toLowerCase();
  if (FORBIDDEN_TRUST_HEADERS.has(headerName)) {
    return { config: null, reason: 'forbidden-header-name', headerName };
  }

  const rawValue = env[UI_PRESENCE_TRUST_VALUE_ENV];
  const expectedValue =
    typeof rawValue === 'string' && rawValue.trim().length > 0 ? rawValue.trim() : undefined;

  return {
    config: { headerName, ...(expectedValue !== undefined ? { expectedValue } : {}) },
    reason: 'enabled'
  };
}

// Length-independent constant-time comparison for the optional shared secret, so
// a mismatching value does not leak its prefix through response timing.
function valuesMatch(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    return false;
  }
  return timingSafeEqual(a, b);
}

// Read a header that must be a single string. A repeated header (Fastify yields
// an array) is an anomaly the trusted fronting layer would not produce, so it is
// rejected rather than picked from — mirroring resolvePrincipalRole's treatment
// of a repeated X-OVC-Role (src/auth/principal.ts:107-116).
function singleHeader(value: string | string[] | undefined): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// True when the Referer names a page served by this same instance's UI mount.
// Same-origin is checked host-to-host (not scheme-to-scheme): a TLS-terminating
// fronting layer forwards `Host` while the browser's Referer carries https.
function refererIsOwnUi(referer: string, host: string | undefined): boolean {
  if (host === undefined) {
    return false;
  }
  let url: URL;
  try {
    url = new URL(referer);
  } catch {
    return false;
  }
  if (url.host.toLowerCase() !== host.toLowerCase()) {
    return false;
  }
  return url.pathname === UI_PATH_PREFIX || url.pathname.startsWith(`${UI_PATH_PREFIX}/`);
}

// Decide whether this request may be admitted on the fronting-layer signal alone.
// Pure (headers in, boolean out) so it is unit-testable without Fastify, and
// FAIL CLOSED: every condition must hold, and any missing/ambiguous header means
// "not trusted" — the caller then falls through to the normal 401 presence gate.
export function isTrustedUiPresenceRequest(
  headers: Record<string, string | string[] | undefined>,
  config: UiPresenceTrustConfig
): boolean {
  // 1. The operator-declared fronting-layer signal must be present, once.
  const signal = singleHeader(headers[config.headerName]);
  if (signal === undefined) {
    return false;
  }

  // 2. When a shared secret is configured, the value must match it exactly.
  if (config.expectedValue !== undefined && !valuesMatch(signal, config.expectedValue)) {
    return false;
  }

  // 3. Fetch metadata must say this is a same-origin request. Browsers set
  //    Sec-Fetch-Site themselves and page JS cannot override it; absent (older
  //    browser, or a non-browser client) ⇒ not trusted.
  const site = singleHeader(headers['sec-fetch-site']);
  if (site === undefined || site.toLowerCase() !== 'same-origin') {
    return false;
  }

  // 4. The request must have been made from one of this instance's own /ui pages.
  const referer = singleHeader(headers['referer']);
  if (referer === undefined || !refererIsOwnUi(referer, singleHeader(headers['host']))) {
    return false;
  }

  return true;
}
