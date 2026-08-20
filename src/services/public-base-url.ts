// Single source of truth for THIS deployment's publicly-reachable base URL.
//
// The base URL is needed in two places (issue #219):
//   1. The eyevinn-encore-packager `CallbackUrl` (provision.ts) — the packager
//      POSTs completion callbacks to `${base}/api/v1/internal/...`.
//   2. The Encore `profilesUrl` (main.ts) — each scaler-spawned Encore instance
//      fetches transcode profiles from `${base}/api/v1/profiles/index.yml`.
//
// The app learns its own OSC-assigned public URL directly from the platform at
// runtime via `OSC_HOSTNAME` (issue #283). @osaas/client-core v0.24.0 itself
// still exposes no self-URL discovery API:
//   - `Context` exposes only the PAT + environment (lib/context.d.ts:19-28);
//     there is no `getSelf`/`whoami`.
//   - `listMyApps()`/`getMyApp()` expose a My App's `url`/`appDns`
//     (lib/myapp.d.ts:2-11) but the app cannot identify WHICH app is itself:
//     no self name/id is injected, and this API may run outside the My App
//     deployment type entirely.
// But the platform DOES inject the running instance's own hostname as the
// `OSC_HOSTNAME` env var (confirmed for the OSC-deployed image via the
// `osc-entrypoint.sh` wrapper at
// https://github.com/eyevinn-osaas/open-videocore/blob/main/osc-entrypoint.sh,
// which maps it to `PUBLIC_BASE_URL` before this process starts). Reading it
// directly here — rather than depending on that wrapper — makes the derivation
// work for any deployment of this image, OSC-wrapped or not.
//
// Precedence: explicit PUBLIC_BASE_URL override → OSC-derived (OSC_HOSTNAME) →
// unset. When unset the callers keep their existing unset-fallbacks unchanged
// (CallbackUrl omitted; Encore falls back to the remote default profiles
// index).

/**
 * Resolve this deployment's publicly-reachable base URL.
 *
 * Precedence:
 *   1. Explicit `PUBLIC_BASE_URL` override (if set) — always wins. Lets an
 *      operator point at a custom hostname (e.g. behind a CDN) regardless of
 *      what OSC assigned.
 *   2. OSC-derived app URL — `https://${OSC_HOSTNAME}`, from the platform-
 *      injected `OSC_HOSTNAME` env var (issue #283; see module comment).
 *   3. `undefined` — triggers the callers' existing unset-fallbacks.
 *
 * @returns the normalised base URL (no trailing slash) or `undefined`.
 */
export function resolvePublicBaseUrl(): string | undefined {
  const override = process.env['PUBLIC_BASE_URL']?.replace(/\/+$/, '');
  if (override) return override;

  const oscHostname = process.env['OSC_HOSTNAME']?.replace(/\/+$/, '');
  if (oscHostname) return `https://${oscHostname}`;

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
 * Since #283, {@link resolvePublicBaseUrl} derives tier 2 from the OSC-injected
 * `OSC_HOSTNAME` automatically — an operator only needs an explicit env-var
 * seam to override that default. This resolver gives operators these seams,
 * in strict precedence:
 *
 *   1. `ENCORE_PROFILES_URL_OVERRIDE` (if set) — a DIRECT profiles-URL override.
 *      Always wins. Use this to point Encore at an exact index URL (e.g. this
 *      deployment's own index behind a custom hostname, or an external index)
 *      without having to express it as a `${base}/api/v1/profiles/index.yml`
 *      derivation. Normalised (trailing slashes stripped).
 *   2. Derived local index — when {@link resolvePublicBaseUrl} resolves a base
 *      (explicit `PUBLIC_BASE_URL` or OSC-derived `OSC_HOSTNAME`), returns
 *      `${base}${LOCAL_PROFILES_INDEX_PATH}` so Encore loads the
 *      operator-managed profiles served by this API.
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
