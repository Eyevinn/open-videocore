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
