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

import { normaliseStackName } from './request-stack-context.js';

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

// Path of the STACK-SCOPED form of the same index (issue #1164), served by
// `GET /stacks/:stack/index.yml` on the profiles router
// (src/routes/profiles.ts). Built here so the URL handed to Encore and the route
// that serves it cannot drift.
export function localProfilesIndexPathForStack(stackName: string): string {
  return `/api/v1/profiles/stacks/${stackName}/index.yml`;
}

/**
 * Rewrite a resolved profiles-index URL to the STACK-SCOPED form for `stackKey`
 * (issue #1164), when — and only when — that URL is THIS app's own index.
 *
 * Why this exists: `profilesUrl` is handed to every scaler-spawned Encore
 * instance (src/encore-scaler/instance-pool.ts:604-608) as a plain, header-less,
 * tokenless GET, so the stack cannot travel in `X-Stack-Name`. Without the stack
 * in the URL, every stack's Encore reads the FIRST listed stack's profile store
 * (src/data/per-workspace-repos.ts:362-366 ->
 * src/services/workspace-stack.ts `resolve()`, no-stackName branch) and a
 * profile created against a non-first stack is invisible to that stack's own
 * transcodes.
 *
 * Narrow by construction:
 *   - Only a URL whose path ends with {@link LOCAL_PROFILES_INDEX_PATH} is
 *     rewritten. That covers the derived `${PUBLIC_BASE_URL}` tier and an
 *     `ENCORE_PROFILES_URL_OVERRIDE`/parameter-store value that points back at
 *     this app's own index (including behind an ingress path prefix). An
 *     EXTERNAL index (a bucket, the remote default seed index) is returned
 *     unchanged: it is not served by this router and has no per-stack form.
 *   - Only a syntactically valid stack name is scoped
 *     ({@link normaliseStackName}). The scaler's loop key is the effective stack
 *     identity a request resolved to, which on a single-stack env-override
 *     deployment is a fixed deployment context rather than a stack name; such a
 *     key leaves the URL unscoped, so that deployment's behaviour is unchanged.
 *
 * @param profilesIndexUrl the resolved index URL (from {@link resolveEncoreProfilesUrl}).
 * @param stackKey the stack the spawned Encore instance belongs to.
 * @returns the stack-scoped URL, or `profilesIndexUrl` unchanged.
 */
export function stackScopedProfilesIndexUrl(
  profilesIndexUrl: string,
  stackKey: string | undefined
): string {
  const stackName = normaliseStackName(stackKey);
  if (!stackName) return profilesIndexUrl;
  // Compare on the PATH only, so a query string or fragment can never decide
  // this (same rule as isProfilesIndexUrl, src/encore-scaler/retry-policy.ts).
  let pathname: string;
  try {
    pathname = new URL(profilesIndexUrl).pathname;
  } catch {
    pathname = profilesIndexUrl.split(/[?#]/)[0] ?? '';
  }
  if (!pathname.toLowerCase().endsWith(LOCAL_PROFILES_INDEX_PATH)) {
    return profilesIndexUrl;
  }
  // Replace the final occurrence of the unscoped path with the scoped one,
  // preserving any host and ingress path prefix ahead of it. Query/fragment on a
  // profiles-index URL carries no meaning for Encore's fetch and is dropped with
  // the replaced tail.
  const cut = profilesIndexUrl.toLowerCase().lastIndexOf(LOCAL_PROFILES_INDEX_PATH);
  return (
    profilesIndexUrl.slice(0, cut) + localProfilesIndexPathForStack(stackName)
  );
}

/**
 * Resolve the profiles-index URL handed to every scaler-spawned Encore instance
 * as its `profilesUrl`.
 *
 * As of #283 OSC exposes no runtime self-URL, so an operator's ONLY lever for
 * pointing Encore at this deployment's local profile index is an explicit
 * env-var. This resolver gives operators these seams, in strict precedence:
 *
 *   1. `ENCORE_PROFILES_URL_OVERRIDE` (if set) — a DIRECT profiles-URL override.
 *      Always wins. Use this to point Encore at an exact index URL (e.g. this
 *      deployment's own index behind a custom hostname, or an external index)
 *      without having to express it as a `${base}/api/v1/profiles/index.yml`
 *      derivation. Normalised (trailing slashes stripped).
 *   2. Derived local index — when `PUBLIC_BASE_URL` is set (via
 *      {@link resolvePublicBaseUrl}), returns `${base}${LOCAL_PROFILES_INDEX_PATH}`
 *      so Encore loads the operator-managed profiles served by this API.
 *   3. Parameter-store value (issue #315) — a FULL profiles-index URL persisted
 *      in the provisioned stack record and resolved at boot (see
 *      {@link resolveEncoreProfilesUrlFromParamStore}). Used DIRECTLY. Lets an
 *      operator point custom profiles at any index WITHOUT a new OSC manifest
 *      key. Only consulted when neither env-var seam above is set.
 *   4. `defaultProfilesUrl` — the caller-supplied remote default (bootstrap seed
 *      index) used when none of the seams above is set. When the parameter-store
 *      value is absent this is byte-identical to the pre-#315 behaviour.
 *
 * @param defaultProfilesUrl the remote default index URL (from `ENCORE_PROFILES_URL`).
 * @param paramStoreProfilesUrl optional FULL profiles-index URL resolved at boot
 *   from the parameter store (issue #315); undefined/empty when unset.
 * @returns the resolved profiles-index URL Encore instances should fetch.
 */
export function resolveEncoreProfilesUrl(
  defaultProfilesUrl: string,
  paramStoreProfilesUrl?: string
): string {
  const directOverride = process.env['ENCORE_PROFILES_URL_OVERRIDE']?.replace(/\/+$/, '');
  if (directOverride) return directOverride;

  const base = resolvePublicBaseUrl();
  if (base) return `${base}${LOCAL_PROFILES_INDEX_PATH}`;

  // Tier 3 (issue #315): a full profiles-index URL persisted in the parameter
  // store and resolved at boot. Used directly; normalised for trailing slashes.
  // An empty/undefined value is treated as unset so the fall-through below is
  // byte-identical to the pre-#315 behaviour (critical for catalog deploys).
  const fromParamStore = paramStoreProfilesUrl?.replace(/\/+$/, '');
  if (fromParamStore) return fromParamStore;

  return defaultProfilesUrl;
}

// StackConfig field name under which an operator-supplied full Encore
// profiles-index URL is persisted in the parameter store (issue #315). Kept as
// a shared constant so the resolver and any writer cannot drift.
export const STACK_ENCORE_PROFILES_URL_FIELD = 'encoreProfilesUrl' as const;

/**
 * Read the parameter-store-supplied Encore profiles-index URL at boot, for use
 * as tier 3 of {@link resolveEncoreProfilesUrl} (issue #315).
 *
 * The parameter store persists per-stack {@link StackConfig} blobs (there is no
 * free-standing key/value read on the {@link ParamStore} interface — reads go
 * through `loadStackConfig`). We therefore read the OPTIONAL
 * `encoreProfilesUrl` field off the first provisioned stack for the namespace,
 * mirroring how `resolveStackRedisUrl` (main.ts) discovers the stack's Valkey
 * URL. The stored value is a FULL profiles-index URL, returned as-is (the
 * resolver normalises it).
 *
 * Contracts verified (issue #315):
 *   - `ParamStore.listStackNames` / `ParamStore.loadStackConfig`
 *     (src/services/param-store.ts) — the read API.
 *   - `StackConfig.encoreProfilesUrl?` (src/services/param-store.ts) — the
 *     optional coordinate; absent in pre-#315 configs so back-compat holds.
 *
 * @returns the stored full profiles-index URL, or `undefined` when there is no
 *   parameter store, no provisioned stack, or the field is unset. Any read
 *   error resolves to `undefined` so boot never fails on this optional lookup.
 */
export async function resolveEncoreProfilesUrlFromParamStore(deps: {
  paramStore?: {
    listStackNames(workspaceId: string): Promise<string[]>;
    loadStackConfig(
      workspaceId: string,
      name: string
    ): Promise<{ encoreProfilesUrl?: string } | undefined>;
  };
  namespace: string;
  onError?: (err: unknown) => void;
}): Promise<string | undefined> {
  const { paramStore, namespace } = deps;
  if (!paramStore) return undefined;
  try {
    const names = await paramStore.listStackNames(namespace);
    if (names.length === 0) return undefined;
    const cfg = await paramStore.loadStackConfig(namespace, names[0]!);
    const url = cfg?.encoreProfilesUrl;
    return typeof url === 'string' && url.length > 0 ? url : undefined;
  } catch (err) {
    deps.onError?.(err);
    return undefined;
  }
}
