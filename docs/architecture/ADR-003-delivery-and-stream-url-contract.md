# ADR-003: Delivery and stream URL contract for API consumers

**Status:** ACCEPTED 2026-09-03
**Date:** 2026-09-03
**Author agent:** claude-opus-4-8
**Issue:** #509 (closes the delivery ADR ADR-001 reserved as "ADR-003: Delivery and CDN integration")

---

## Context

ADR-001 open question 4 deferred delivery URLs to a post-v1 delivery ADR
(reserved as ADR-003), which was never written. In the absence of a documented
URL contract, a consuming application reached directly into the packaged object
bucket and reimplemented storage-layout knowledge as a workaround. That
workaround requires direct bucket access, which is not available to (and must
not be required of) a normal API consumer.

This ADR documents the **real, implemented** delivery and stream contract as
merged by #502, #503, and #506, so a developer with zero prior knowledge can
consume `GET /api/v1/assets/:id/delivery` and the `GET /api/v1/assets/:id/stream/*`
proxy for playback using only these docs, with no direct bucket access.

Every field and behaviour below is traceable to a cited source location.

### Why delivery is proxied through the API

Packaged output (CMAF HLS/DASH manifests + segments) is stored in a **private**
object-storage bucket. The default OSC object-storage backend (MinIO) blocks
externally-resolvable presigned and public bucket GETs at the OSC reverse proxy,
so a presigned or raw bucket URL handed to a player does not resolve from
outside the platform. Consequently:

- The API never advertises a presigned or raw bucket URL for packaged playback.
- Playback is served by streaming packaged objects back through the authorized
  API route `GET /api/v1/assets/:id/stream/*`, which reads from the private
  bucket using the deployment's own credentials.
- **Clients must consume the `/stream/*` URLs returned by `/delivery` — never a
  presigned URL, never a raw/direct bucket URL, and never a reconstructed
  storage path.**

Source: `src/routes/assets.ts:2028` (comment: "OSC MinIO blocks external
presigned/public GETs"), `src/routes/assets.ts:2205-2212` (proxy-delivery
rationale), `src/routes/assets.ts:2123` ("OSC MinIO blocks external
presigned/public GETs").

---

## Decision

### 1. `GET /api/v1/assets/:id/delivery` response contract

Route handler: `src/routes/assets.ts:2000-2203`.
Response schema (Zod → OpenAPI): `deliverySchema`, `src/routes/assets.ts:361-367`;
`openapi.json:4732-4855`.

The 200 body always has this shape:

```jsonc
{
  "assetId": "string",                 // the asset id echoed back
  "status": "ready" | "not_configured",
  "urls": {                            // present keys depend on status (see below)
    "hls":  "string (optional)",
    "dash": "string (optional)",
    "source": "string (optional)"
  },
  "resolution": {                      // OPTIONAL — only on some not_configured bodies
    "packagedBucket": "string (optional)",
    "packagedPrefix": "string (optional)",
    "masterHlsKey":   "string (optional)",
    "masterDashKey":  "string (optional)"
  },
  "expiresAt": "string (ISO-8601 instant)"
}
```

Fields and their sources:

- `assetId` — the requested asset id. Schema: `src/routes/assets.ts:362`.
- `status` — the readiness signal a consumer keys off. Enum
  `["ready", "not_configured"]`. Schema + semantics:
  `src/routes/assets.ts:351-363`.
- `urls.hls` / `urls.dash` — playback manifest URLs. Schema:
  `src/routes/assets.ts:332-336`. Only present when `status` is `ready`.
- `urls.source` — presigned/derived source download URL for a source-only asset
  (no packaged output). Emitted at `src/routes/assets.ts:2178-2194`.
- `resolution.*` — deterministic-resolution metadata, present only on a
  `not_configured` body when the asset has a persisted `packagedOutput` block
  (#502). Schema: `src/routes/assets.ts:344-349`; populated by
  `deliveryResolutionFor`, `src/routes/assets.ts:991-1004`.
- `expiresAt` — ISO instant at which presigned URLs stop working; for
  proxy/manifest URLs it bounds the advertised validity window. TTL is
  `DELIVERY_URL_TTL_SECONDS` (default 1h). Set at `src/routes/assets.ts:2015-2016`.

Status codes:

- `200` — a delivery body (either `ready` or `not_configured`).
- `404` — unknown/foreign asset, or an asset with no packaged output and no
  stored source object to deliver. `src/routes/assets.ts:2011-2013`,
  `src/routes/assets.ts:2198-2201`.
- `501` — a source-only asset whose object storage is not configured on this
  deployment. `src/routes/assets.ts:2185-2190`.

#### The `ready` variant

`status: "ready"` means `urls` holds a **fully-resolvable, absolute** playback
or download URL that plays without workarounds. On the default private-bucket
(MinIO) backend, `urls.hls` / `urls.dash` are absolute `/stream/*` proxy URLs of
the form:

```
<PUBLIC_BASE_URL>/api/v1/assets/<id>/stream/index.m3u8   (HLS)
<PUBLIC_BASE_URL>/api/v1/assets/<id>/stream/manifest.mpd  (DASH)
```

The URL is built by `proxyManifestUrlsFor(assetId, apiBaseUrl)`
(`src/pipeline/packaging.ts:263-269`), whose base is
`<apiBaseUrl>/<assetId>/stream` via `proxyStreamPrefix`
(`src/pipeline/packaging.ts:253-255`). The API origin comes from
`PUBLIC_BASE_URL` via `assetsBaseUrl` (`src/routes/assets.ts:895-906`). Only the
formats the packaged output actually produced are advertised
(`src/routes/assets.ts:2108-2112`).

`ready` is also returned for external storage backends (the object store / CDN
is itself the public origin, `src/routes/assets.ts:2067-2079`), for a relocated
per-execution destination (`src/routes/assets.ts:2044-2060`), and for
source-only download URLs (`src/routes/assets.ts:2178-2194`).

**A `ready` HLS/DASH URL is a `/stream/*` URL. Fetch it directly with a player —
do not attempt to resolve it against a bucket.**

#### The `not_configured` variant

`status: "not_configured"` means the asset HAS packaged output, but this
deployment cannot advertise a fully-resolvable playback URL — because the API's
own public origin (`PUBLIC_BASE_URL`) is unset, so no absolute proxy URL can be
built. Body shape (built by `notConfiguredDelivery`,
`src/routes/assets.ts:1013-1025`):

- `urls.hls` / `urls.dash` are **omitted** (`urls` is `{}`) so a consumer never
  mistakes an unplayable value for a ready URL.
- `resolution` carries the persisted packaged location so a client with its own
  object-store access can locate the master manifest objects deterministically:
  `packagedBucket`, `packagedPrefix` (the job-nested prefix the packager wrote
  under), `masterHlsKey`, `masterDashKey`. Populated from the asset's
  `packagedOutput` block (#502): `src/routes/assets.ts:991-1004`;
  `PackagedOutput` type + field meanings: `src/data/asset-repo.ts:188-203`.

`resolution` is entirely additive: an asset packaged before #502 (no persisted
`packagedOutput`) simply omits `resolution` (`src/routes/assets.ts:995-997`).

`not_configured` is returned from the proxy branch when the proxy base is not
absolute (`src/routes/assets.ts:2099-2103`) and from the public-mode branch when
neither format resolves to a playable URL (`src/routes/assets.ts:2154-2156`).

The correct fix for `not_configured` is **not** direct bucket access — it is to
configure `PUBLIC_BASE_URL` on the deployment so `/delivery` can advertise
absolute `/stream/*` URLs. The `resolution` metadata exists only for operators
who already hold object-store credentials; it is not a supported path for normal
API consumers.

### 2. `GET /api/v1/assets/:id/stream/*` behaviour

Route handler: `src/routes/assets.ts:2221-2377`.
OpenAPI path: `openapi.json:4857-4883` (`/api/v1/assets/{id}/stream/{*}`).

This single wildcard route serves every packaged object for playback. There are
no separate `index.m3u8` / `manifest.mpd` routes — those are matched by the
wildcard `*`:

- `GET /api/v1/assets/:id/stream/index.m3u8` — the master HLS manifest.
- `GET /api/v1/assets/:id/stream/manifest.mpd` — the master DASH manifest.
- `GET /api/v1/assets/:id/stream/<relative>` — any child playlist, CMAF init
  segment, or media segment (e.g. `v0/playlist.m3u8`, `seg-00001.m4s`).

The deterministic manifest names `index.m3u8` and `manifest.mpd` are exactly the
filenames the packager emits (`src/pipeline/packaging.ts:71-77`,
`src/pipeline/packaging.ts:263-269`).

#### What the wildcard maps to (packaged-prefix resolution)

`*` is the object path **relative to the asset's packaged prefix**. The route
resolves the REAL prefix the packager wrote under and maps
`objectKey = <streamPrefix>/<relative>` inside the private packaged bucket
(`src/routes/assets.ts:2259-2260`). Prefix resolution (`resolveStreamPrefix`,
`src/routes/assets.ts:966-980`) prefers, in order:

1. the durable `packagedOutput.prefix` persisted on the asset (#502) — the
   job-nested `<assetId>/<packagerJobId>/` prefix;
2. a lazy list fallback for assets packaged before #502 (lists the packaged
   bucket under `<assetId>/` and derives the newest job prefix);
3. the historical flat `packaged/<id>` prefix (`outputPrefix`,
   `src/pipeline/packaging.ts:62-64`) when the asset has no packaged objects
   under `<assetId>/` at all.

This is exactly the #503 fix: the proxy no longer assumes a flat prefix and
404s against the real job-nested objects (source: #503 commit message; handler
comment `src/routes/assets.ts:2251-2258`).

#### Relative child playlists and segments resolve through the same endpoint

When the requested object is a manifest (`.m3u8` / `.mpd`, detected by
`isManifestPath`, `src/pipeline/manifest-rewrite.ts:49-52`), the route rewrites
every child reference so it resolves back through this same `/stream/*` prefix
rather than escaping to a bare bucket host or an unsigned URL. Rewrite invoked at
`src/routes/assets.ts:2304-2335`; rewrite logic in
`src/pipeline/manifest-rewrite.ts` (`rewriteManifest`,
`src/pipeline/manifest-rewrite.ts:287-296`).

Rewritten reference kinds (`rewriteReference`,
`src/pipeline/manifest-rewrite.ts:93-111`):

- HLS: bare variant/segment URI lines and `URI="..."` attributes on
  `#EXT-X-MEDIA`, `#EXT-X-MAP`, `#EXT-X-I-FRAME-STREAM-INF`, etc.
  (`src/pipeline/manifest-rewrite.ts:183-207`).
- DASH: `<BaseURL>`, `SegmentTemplate media=` / `initialization=`,
  `SegmentURL media=`, `<Initialization sourceURL=>`; `$Number$`/`$Time$`
  template variables are preserved verbatim
  (`src/pipeline/manifest-rewrite.ts:220-282`).

Each rewritten reference becomes an absolute proxy URL of the form
`<proxyBase>/<within-prefix-path>`, where `proxyBase` is
`<PUBLIC_BASE_URL>/api/v1/assets/<id>/stream` (`streamProxyBaseUrl`,
`src/routes/assets.ts:933-944`). The stored manifest bytes are never mutated —
the rewrite is a text transform applied only to the proxied response
(`src/routes/assets.ts:2296-2303`).

**Net effect for a consumer:** point a player at the `urls.hls` or `urls.dash`
value from `/delivery`. The player fetches the master manifest through
`/stream/index.m3u8` (or `/stream/manifest.mpd`), and every variant playlist,
init segment, and media segment it references is fetched back through the same
`/stream/*` route automatically. **Direct bucket access is never required for
playback.**

#### Other stream behaviours

- Range requests: a single HTTP `Range` is honored for segment fetches (`206`
  Partial Content); a manifest is always served whole (`200`) because the
  rewrite changes its length. `src/routes/assets.ts:2283-2303`,
  `src/routes/assets.ts:2347-2364`. An unsatisfiable range yields `416`
  (`src/routes/assets.ts:2289-2294`).
- Content types: `.m3u8 → application/vnd.apple.mpegurl`,
  `.mpd → application/dash+xml`, others inferred, unknown falls back to
  `application/octet-stream`. `contentTypeForPackagedObject`,
  `src/routes/assets.ts:1031-1050`.
- Status codes: `200`/`206` object stream; `404` unknown asset, empty/traversal
  path, or missing object (`src/routes/assets.ts:2228-2245`,
  `src/routes/assets.ts:2279-2281`); `501` object storage not configured
  (`src/routes/assets.ts:2233-2238`).

### 3. Delivery-mode configuration (operator-facing)

`DELIVERY_MODE` (env, 12-factor) selects a mutually-exclusive delivery posture
for the default private-bucket backend (`deliveryMode`,
`src/pipeline/packaging.ts:236-247`):

- `proxy` — `/delivery` advertises `/stream/*` proxy URLs; the packaged bucket
  stays private. `src/routes/assets.ts:2090-2114`.
- `public` (default when unset/unrecognised) — advertises the stored CMAF
  manifest URLs resolved to a public origin; on the zero-config MinIO backend
  (no `PACKAGED_PUBLIC_BASE_URL`) the stored value is a bare, non-fetchable
  object-key path, so the handler routes it through the same `/stream/*` proxy
  to keep the advertised URL absolute and resolvable (#341,
  `src/routes/assets.ts:2116-2162`).

In both modes on the default backend, resolvable playback ultimately flows
through `/stream/*`. To get absolute `ready` URLs, set `PUBLIC_BASE_URL`.

---

## Migration / regression note (previous short-path behaviour → corrected resolution)

Upgraders coming from a build before #502/#503/#506 should be aware of the
following change in resolution behaviour:

- **Before:** `/delivery` and `/stream/*` assumed a **flat** per-asset packaged
  prefix (`packaged/<id>`). The packager actually writes CMAF output under a
  **job-nested** prefix (`<assetId>/<packagerJobId>/index.m3u8`, …), driven by
  the packager's `OutputFolder` + `OutputSubfolderTemplate` default
  `$INPUTNAME$/$JOBID$`. Because the asset record never durably persisted the
  full packaged prefix, `/stream/*` mapped to the wrong (flat) key and `404`ed
  against the real objects. `/delivery` could also advertise a bare,
  non-resolvable object-key path that a player could not fetch. (Sources: #502,
  #503 commit messages.)
- **After:**
  - #502 persists the actual packaged location on the asset as an additive
    `packagedOutput` block (`bucket`, job-nested `prefix`, `masterHlsKey`,
    `masterDashKey`), captured from the packager success callback.
    `src/data/asset-repo.ts:188-203`.
  - #503 makes `/stream/*` resolve the REAL prefix (persisted → lazy list →
    flat fallback) and uses it for both the object key and the manifest-rewrite
    context, so child playlists and segments resolve back through the same
    authorized route. `resolveStreamPrefix`, `src/routes/assets.ts:966-980`.
  - #506 makes `/delivery` advertise a fully-resolvable ABSOLUTE playback URL
    with `status: "ready"`, or an unambiguous `status: "not_configured"` body
    (no playback URL) plus `resolution` metadata when public delivery is not
    configured. It never advertises a `200` that looks ready with no resolvable
    URL. `src/routes/assets.ts:2090-2172`, schema `src/routes/assets.ts:344-367`.

Assets packaged before #502 have no persisted `packagedOutput`; they are handled
by the lazy list fallback (prefix resolution) and simply omit the `resolution`
block on any `not_configured` body — no migration action is required.

**Consumer action on upgrade:** stop reconstructing storage paths or reaching
into the packaged bucket. Consume `urls.hls` / `urls.dash` from `/delivery`
directly, and let the player resolve child references through `/stream/*`.

---

## Consequences

**Positive:**
- A consumer can play back an asset using only `/delivery` + `/stream/*`, with no
  bucket credentials and no storage-layout knowledge.
- The packaged bucket stays private, which is the desirable posture for
  multi-tenant deployments.
- The `status` enum gives consumers an unambiguous readiness signal; an
  unplayable state is `not_configured`, never a fake-ready `200`.

**Negative / trade-offs:**
- All packaged bytes transit the API process in proxy mode, so the API is on the
  playback data path (mitigate with a fronting CDN over `/stream/*` if needed —
  segment responses set `Cache-Control` and advertise `Accept-Ranges`).
- Fully-resolvable `ready` URLs require `PUBLIC_BASE_URL` to be configured;
  otherwise `/delivery` returns `not_configured`.

---

## References

- ADR-001 open question 4 (delivery deferral; this ADR is the reserved
  "ADR-003: Delivery and CDN integration").
- ADR-011 — per-execution packaged-output destination (relocated delivery URLs).
- Issues #502 (persist packaged prefix/keys), #503 (resolve packaged prefix for
  `/stream`), #506 (resolvable delivery URLs or `not_configured`), #509 (this
  documentation task).
- Code: `src/routes/assets.ts` (delivery + stream handlers, schemas),
  `src/pipeline/packaging.ts` (proxy/output prefixes, delivery mode),
  `src/pipeline/manifest-rewrite.ts` (child-reference rewriting),
  `src/data/asset-repo.ts` (`PackagedOutput` shape), `openapi.json` (generated
  contract).
