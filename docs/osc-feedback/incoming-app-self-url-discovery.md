# OSC friction — no runtime self-URL discovery for a running app instance (issue #219)

**Date:** 2026-07-13
**Surface:** infra
**Service:** the open-videocore API itself (a My App / service instance running on OSC)

## What we needed

Issue #219 aims to remove `PUBLIC_BASE_URL` as the SOURCE of this deployment's
own public base URL and instead derive it from the URL OSC assigns to the
running app instance. Two consumers need that base URL at runtime:

1. The eyevinn-encore-packager `CallbackUrl` — the packager POSTs completion
   callbacks to `${base}/api/v1/internal/...` (see
   `src/routes/provision.ts:568-583`).
2. The Encore `profilesUrl` — each scaler-spawned Encore instance fetches
   transcode profiles from `${base}/api/v1/profiles/index.yml` (see
   `src/main.ts:455-465`).

For a genuinely single-click OSC-catalog deployment, the app should learn its
own assigned public URL from the platform, not require an operator to hand-set
`PUBLIC_BASE_URL` to match the URL OSC just assigned.

## Friction

As of `@osaas/client-core` v0.24.0 there is **no reliable way for a running app
instance to discover its own OSC-assigned public URL**:

- **No OSC-injected env var carries the self URL/hostname.** The only OSC
  identity injected into the running container is `OSC_ACCESS_TOKEN` (the PAT),
  read via `new Context()` (`src/main.ts:152-154`). We grepped the full env-var
  surface of the codebase — no `OSC_*`/`OSAAS_*` host/URL/app-name/app-id var is
  present or consumed.
- **`Context` exposes no self-identity.** `lib/context.d.ts:19-28` — only
  `getPersonalAccessToken()`, `getEnvironment()`, and service-access-token
  helpers. No `getSelf` / `whoami` / `getMyInstance`.
- **`listMyApps()` / `getMyApp()` cannot identify "us".** `lib/myapp.d.ts:2-22`
  — a `MyApp` has the fields we want (`url`, `appDns`), but:
  - `getMyApp(ctx, appId)` requires an `appId` the running app is never told.
  - `listMyApps(ctx)` returns every My App in the tenant with no marker for
    which one is the caller, and no self name/id is injected to filter by.
  - This API can also be deployed outside the "My App" type, so keying off My
    App listings is not even universally applicable.
- **`getInternalEndpoint(ctx, serviceId, name, token)`** (`lib/core.d.ts:148`)
  discovers a *target* service instance you already know by serviceId+name — not
  the caller's own public endpoint.

## Impact / workaround

Kept `PUBLIC_BASE_URL` as the explicit override/source and added a single
resolver seam, `resolvePublicBaseUrl()`
(`src/services/public-base-url.ts`), now the sole source of truth for both
consumers above. Precedence: explicit `PUBLIC_BASE_URL` override → OSC-derived
app URL (reserved; unavailable today) → `undefined` (unchanged unset-fallbacks:
`CallbackUrl` omitted; Encore falls back to the remote default profiles index).
When OSC exposes a self-URL signal, it plugs into exactly one function with no
change to callers.

## Ask for OSC

Provide a reliable runtime mechanism for an app/service instance to discover its
own assigned public URL, one of:

1. Inject an env var into every running instance/app (e.g. `OSC_APP_URL` /
   `OSAAS_PUBLIC_URL` / `OSC_APP_DNS`) carrying the assigned public URL.
2. Add a `@osaas/client-core` self helper (e.g. `getSelf(ctx)` /
   `ctx.getMyAppUrl()`) that returns the caller's own `url`/`appDns` using only
   the injected PAT — no caller-supplied appId/name required.
3. Inject the app's own `appId`/`name` so the existing `getMyApp()` /
   `listMyApps()` can be used to resolve `url`/`appDns` deterministically.

Any of these lets us complete #219's goal (derive the base URL from OSC) and
achieve a true single-click catalog deployment with no operator-supplied
`PUBLIC_BASE_URL`.
