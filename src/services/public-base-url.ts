// Single source of truth for THIS deployment's publicly-reachable base URL.
//
// The base URL is needed in two places (issue #219):
//   1. The eyevinn-encore-packager `CallbackUrl` (provision.ts) — the packager
//      POSTs completion callbacks to `${base}/api/v1/internal/...`.
//   2. The Encore `profilesUrl` (main.ts) — each scaler-spawned Encore instance
//      fetches transcode profiles from `${base}/api/v1/profiles/index.yml`.
//
// Ideally the app would learn its own OSC-assigned public URL directly from the
// platform at runtime, closing the last env-var-as-stack-config gap. As of
// @osaas/client-core v0.24.0 there is NO reliable runtime self-URL discovery:
//   - No OSC-injected env var carries the running instance's own hostname/URL
//     (only OSC_ACCESS_TOKEN — the PAT — is injected; see main.ts:152).
//   - `Context` exposes only the PAT + environment (lib/context.d.ts:19-28);
//     there is no `getSelf`/`whoami`.
//   - `listMyApps()`/`getMyApp()` expose a My App's `url`/`appDns`
//     (lib/myapp.d.ts:2-11) but the app cannot identify WHICH app is itself:
//     no self name/id is injected, and this API may run outside the My App
//     deployment type entirely.
// The gap is logged in docs/osc-feedback/incoming-app-self-url-discovery.md.
//
// This function is the seam where an OSC-derived value would plug in once such
// a signal exists (precedence: explicit PUBLIC_BASE_URL override → OSC-derived
// → unset). Today it returns the PUBLIC_BASE_URL override, normalised (trailing
// slashes stripped), or undefined. When undefined the callers keep their
// existing unset-fallbacks unchanged (CallbackUrl omitted; Encore falls back to
// the remote default profiles index).

/**
 * Resolve this deployment's publicly-reachable base URL.
 *
 * Precedence:
 *   1. Explicit `PUBLIC_BASE_URL` override (if set) — always wins.
 *   2. OSC-derived app URL — reserved for a future reliable OSC self-URL
 *      discovery signal (none exists today; see module comment).
 *   3. `undefined` — triggers the callers' existing unset-fallbacks.
 *
 * @returns the normalised base URL (no trailing slash) or `undefined`.
 */
export function resolvePublicBaseUrl(): string | undefined {
  const override = process.env['PUBLIC_BASE_URL']?.replace(/\/+$/, '');
  if (override) return override;

  // OSC-derived app URL would be resolved here once the platform exposes a
  // reliable runtime self-URL signal. Until then, fall through to undefined so
  // the existing unset-fallbacks apply unchanged.

  return undefined;
}

// Path suffix (relative to the resolved public base URL) that serves this API's
// own operator-managed profile index. Each scaler-spawned Encore instance
// fetches its transcode profiles from here (see module comment, item 2). Kept
// as a shared constant so main.ts and this resolver cannot drift.
export const LOCAL_PROFILES_INDEX_PATH = '/api/v1/profiles/index.yml';

/**
 * Resolve the profiles-index URL handed to every scaler-spawned Encore instance
 * as its `profilesUrl`.
 *
 * As of #283 OSC exposes no runtime self-URL, so an operator's ONLY lever for
 * pointing Encore at this deployment's local profile index is an explicit
 * env-var. This resolver gives operators two seams, in strict precedence:
 *
 *   1. `ENCORE_PROFILES_URL_OVERRIDE` (if set) — a DIRECT profiles-URL override.
 *      Always wins. Use this to point Encore at an exact index URL (e.g. this
 *      deployment's own index behind a custom hostname, or an external index)
 *      without having to express it as a `${base}/api/v1/profiles/index.yml`
 *      derivation. Normalised (trailing slashes stripped).
 *   2. Derived local index — when `PUBLIC_BASE_URL` is set (via
 *      {@link resolvePublicBaseUrl}), returns `${base}${LOCAL_PROFILES_INDEX_PATH}`
 *      so Encore loads the operator-managed profiles served by this API.
 *   3. `defaultProfilesUrl` — the caller-supplied remote default (bootstrap seed
 *      index) used when neither override above is set.
 *
 * @param defaultProfilesUrl the remote default index URL (from `ENCORE_PROFILES_URL`).
 * @returns the resolved profiles-index URL Encore instances should fetch.
 */
export function resolveEncoreProfilesUrl(defaultProfilesUrl: string): string {
  const directOverride = process.env['ENCORE_PROFILES_URL_OVERRIDE']?.replace(/\/+$/, '');
  if (directOverride) return directOverride;

  const base = resolvePublicBaseUrl();
  if (base) return `${base}${LOCAL_PROFILES_INDEX_PATH}`;

  return defaultProfilesUrl;
}
