# OSC friction — service manifest exposes no key to set the profiles / public base URL (issue #285)

**Date:** 2026-08-19
**Surface:** infra
**Service:** eyevinn-open-videocore (OSC catalog service / My App)

## What we needed

Issue #283 confirmed OSC exposes **no** runtime self-URL mechanism (no self-URL
in `@osaas/client-core@0.24.0`, no injected app-URL env var; see
`docs/osc-feedback/incoming-app-self-url-discovery.md`). Therefore the ONLY way
to point each auto-scaled Encore instance at this deployment's local profile
index (`GET /api/v1/profiles/index.yml`) is an explicit operator-set env var:

- `PUBLIC_BASE_URL` — read by `resolvePublicBaseUrl()`
  (`src/services/public-base-url.ts:40-49`); the app derives
  `${PUBLIC_BASE_URL}/api/v1/profiles/index.yml` (`src/main.ts` via
  `resolveEncoreProfilesUrl()`), or
- `ENCORE_PROFILES_URL_OVERRIDE` — a NEW direct profiles-URL override added in
  this issue (`resolveEncoreProfilesUrl()`,
  `src/services/public-base-url.ts`), highest precedence, wins over both the
  `PUBLIC_BASE_URL` derivation and the `ENCORE_PROFILES_URL` default.

## Friction

The `update-service-instance` / `create-service-instance` manifest for
`eyevinn-open-videocore` accepts ONLY:

```
name, OscAccessToken, ParameterStoreApiKey, ParameterStore,
MinioRootPassword, CouchdbAdminPassword, EncoreMaxInstances,
EncoreMinInstances, EncoreIdleTimeoutMs
```

There is NO manifest key that maps to `PUBLIC_BASE_URL` or to a direct
profiles-URL override. Consequently, even though the app already consumes these
env vars correctly, an OSC operator has **no reachable way to set them** — so an
explicit profiles-URL override is unreachable via the catalog, and a
single-click deploy cannot point Encore at the local operator-managed profile
store.

## Impact / workaround

App side is complete and consumes the env vars with correct precedence
(direct override → `PUBLIC_BASE_URL` derivation → `ENCORE_PROFILES_URL` remote
default). The remaining gap is entirely in the out-of-repo OSC service manifest,
which this repo cannot change.

## Ask for OSC — exact manifest keys to add

Add the following optional config keys to the `eyevinn-open-videocore` service
manifest, each mapping to the named container env var:

| Manifest key (proposed) | Maps to env var | Effect when set |
| --- | --- | --- |
| `PublicBaseUrl` | `PUBLIC_BASE_URL` | App derives `${PublicBaseUrl}/api/v1/profiles/index.yml` and hands it to every scaler-spawned Encore instance; also used for the packager `CallbackUrl`. |
| `EncoreProfilesUrlOverride` | `ENCORE_PROFILES_URL_OVERRIDE` | Direct profiles-index URL override; highest precedence, wins over the `PublicBaseUrl` derivation and the `ENCORE_PROFILES_URL` default. |

Both keys must be OPTIONAL (unset = current behaviour: Encore falls back to the
remote default profiles index). Either key closes issue #285.
