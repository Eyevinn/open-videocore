# ADR-003: Delivery and stream URL contract for API consumers

**Status:** ACCEPTED 2026-09-03 — **Context amended 2026-09-25 (#857)**
**Date:** 2026-09-03
**Author agent:** claude-opus-4-8
**Issue:** #509 (closes the delivery ADR ADR-001 reserved as "ADR-003: Delivery and CDN integration")
**Amended:** 2026-09-25, #857 — the object-storage access premise recorded below was
factually wrong. It is corrected in "Object-storage access model". The described
behaviour of `/delivery` and `/stream/*` is unchanged (this amendment corrects the
document, not the implementation); the conclusions that rested only on the old
premise are now listed under "Open questions raised by the corrected premise".
Every source citation in the document was also re-resolved against `9c39239`
(they had drifted), so a reader chasing an open question lands on the code the
text actually describes.

---

## Context

ADR-001 open question 4 deferred delivery URLs to a post-v1 delivery ADR
(reserved as ADR-003), which was never written. In the absence of a documented
URL contract, a consuming application reached directly into the packaged object
bucket and reimplemented storage-layout knowledge as a workaround. That
workaround requires the consumer to know the storage layout, which is not (and
must not become) part of the API contract — the layout has already changed once
(#502/#503), and bucket listing is denied, so a consumer cannot rediscover it.

This ADR documents the **real, implemented** delivery and stream contract as
merged by #502, #503, and #506, so a developer with zero prior knowledge can
consume `GET /api/v1/assets/:id/delivery` and the `GET /api/v1/assets/:id/stream/*`
proxy for playback using only these docs, with no direct bucket access.

Every field and behaviour below is traceable to a cited source location. **All
source line numbers in this document were re-resolved against `9c39239`
(2026-09-25).** `src/routes/assets.ts` has grown substantially since the ADR was
first written — the `/delivery` handler alone moved from line 2000 to 3052 — so
the original citations had drifted onto unrelated code. If you find a citation
that does not match what the surrounding text claims, the citation has drifted
again: re-resolve it by symbol name rather than trusting the line number.

### Object-storage access model

**Corrected 2026-09-25 (#857).** An earlier revision of this section claimed that
the default OSC object-storage backend (MinIO) blocks externally-resolvable
presigned and public bucket GETs at the OSC reverse proxy, and derived the
`/stream/*` proxy design from that claim. **That premise was false**, and nothing
in this ADR should be read as resting on it.

What is actually true (confirmed by OSC, 2026-09-25):

- OSC object-storage endpoints are **publicly reachable**. Access is not gated at
  a platform reverse proxy; it is governed **per bucket, by that bucket's own
  policy**.
- The **default** bucket policy is **strict** — no anonymous access. A bucket that
  acts as a delivery **origin** (one whose objects a player fetches directly) is
  normally made **public** by policy.
- Presigned URLs **do** resolve from outside the platform.

In this deployment the origin bucket is **`openvideocore-packaged`**. Provisioning
applies an anonymous read-only policy to that bucket **and to it alone**:
`s3:GetObject` for principal `*` on `arn:aws:s3:::openvideocore-packaged/*`, with
no `s3:ListBucket` and no write. `openvideocore-source` keeps the default strict
policy. Sources: `packagedPolicy`, `src/routes/provision.ts:996-1006` and
`setBucketPolicy(PACKAGED_BUCKET, packagedPolicy)`, `src/routes/provision.ts:1011`;
rationale comment `src/routes/provision.ts:983-995` ("the SOURCE bucket MUST stay
private, so this loop deliberately targets PACKAGED_BUCKET alone … objects are
readable by exact key but the bucket is not browsable"); bucket names
`src/routes/provision.ts:63-64`.

#### Observed behaviour (evidence)

Measured externally, 2026-09-25 — unauthenticated, unsigned, **no `Authorization`
header**:

| Request | Result |
|---|---|
| `GET` packaged manifest — `openvideocore-packaged/<assetId>/<uuid>/index.m3u8` | `200`, body begins `#EXTM3U` |
| `GET` source object — `openvideocore-source/ingest/<assetId>` | `403` |
| Bucket **listing** of `openvideocore-packaged` | `403` |
| Bucket **listing** of `openvideocore-source` | `403` |
| Presigned URL from `GET /api/v1/assets/{id}/files` — `source` | `200` |
| Presigned URL from `GET /api/v1/assets/{id}/files` — each of the five renditions | `200` |

(`/files` presigns `source` and every rendition via `storage.presignedGet(key, ttl)`:
`src/routes/assets.ts:3460` onwards, presign calls at `src/routes/assets.ts:3505`
and `src/routes/assets.ts:3525-3528`.)

Two conclusions follow, and both matter for the rest of this ADR:

1. **The configuration is correct; only the earlier description of it was wrong.**
   The packaged bucket is publicly readable *by design* because it is an origin
   bucket; the source bucket is correctly strict.
2. **Neither bucket can be enumerated.** Listing is denied on both, so object
   paths are **not discoverable**. A caller can only fetch an object whose exact
   key it already holds — and packaged keys are job-nested
   (`<assetId>/<packagerJobId>/…`, see "packaged-prefix resolution" below), so
   they cannot be guessed from the asset id.

#### Why delivery is proxied through the API

The implemented behaviour is unchanged by the correction above, and is documented
in full in the Decision below:

- The API does not advertise a raw bucket URL for packaged playback; on the
  default backend it advertises `/stream/*` URLs.
- Playback is served by streaming packaged objects back through the API route
  `GET /api/v1/assets/:id/stream/*`, which reads the packaged bucket using the
  deployment's own credentials.
- **Clients must consume the URLs returned by `/delivery` — never a reconstructed
  storage path.** On the corrected premise this still holds, but for different
  reasons: listing is denied so paths are not discoverable; the real prefix is
  job-nested and resolved server-side (#502/#503); and the storage layout is not
  part of the API contract and changes without notice.

What the correction removes is the *justification* that the proxy is the only
thing that can work. It is not: the packaged bucket is a public origin, and
presigned URLs resolve externally. **Whether the proxy should remain the default
delivery posture is therefore an open product decision, deliberately not decided
here** — see "Open questions raised by the corrected premise".

Note for implementers: the old premise is still asserted by **eight code comments
across three files** (`src/routes/assets.ts`, `src/pipeline/packaging.ts`,
`src/data/storage.ts`) — not only by the three that say it verbatim. #857 is
documentation-only and does not touch them; they are wrong, and **OPEN-2 below
enumerates every one**, so a follow-up code change scoped from it does not fix a
subset and leave the rest.

---

## Decision

### 1. `GET /api/v1/assets/:id/delivery` response contract

Route handler: `src/routes/assets.ts:3052-3268`.
Response schema (Zod → OpenAPI): `deliverySchema`, `src/routes/assets.ts:558-564`;
`openapi.json:7265-7390`.

The 200 body always has this shape:

```jsonc
{
  "assetId": "string",                 // the asset id echoed back
  "status": "ready" | "not_configured" | "failed",
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

- `assetId` — the requested asset id. Schema: `src/routes/assets.ts:559`.
- `status` — the readiness signal a consumer keys off. Enum
  `["ready", "not_configured", "failed"]` (`failed` added by #810). Schema +
  semantics: `deliverySchema`, `src/routes/assets.ts:539-564`.
- `urls.hls` / `urls.dash` — playback manifest URLs. Schema:
  `src/routes/assets.ts:520-524`. Only present when `status` is `ready`.
- `urls.source` — presigned/derived source download URL for a source-only asset
  (no packaged output). Emitted at `src/routes/assets.ts:3242-3259`.
- `resolution.*` — deterministic-resolution metadata, present only on a
  `not_configured` body when the asset has a persisted `packagedOutput` block
  (#502). Schema: `src/routes/assets.ts:532-537`; populated by
  `deliveryResolutionFor`, `src/routes/assets.ts:1338-1351`.
- `expiresAt` — ISO instant at which presigned URLs stop working; for
  proxy/manifest URLs it bounds the advertised validity window. TTL is
  `DELIVERY_URL_TTL_SECONDS` (default 1h). Set at `src/routes/assets.ts:3067-3068`.

Status codes:

- `200` — a delivery body (`ready`, `not_configured`, or `failed`).
- `404` — unknown/foreign asset, or an asset with no packaged output and no
  stored source object to deliver. `src/routes/assets.ts:3063-3065`,
  `src/routes/assets.ts:3263-3266`.
- `501` — a source-only asset whose object storage is not configured on this
  deployment. `src/routes/assets.ts:3250-3255`.

#### The `ready` variant

`status: "ready"` means `urls` holds a **fully-resolvable, absolute** playback
or download URL that plays without workarounds. On the default per-stack MinIO
backend, `urls.hls` / `urls.dash` are absolute `/stream/*` proxy URLs of the form
(this is what the code does today; see OPEN-1 on whether it should stay the
default):

```
<PUBLIC_BASE_URL>/api/v1/assets/<id>/stream/index.m3u8   (HLS)
<PUBLIC_BASE_URL>/api/v1/assets/<id>/stream/manifest.mpd  (DASH)
```

The URL is built by `proxyManifestUrlsFor(assetId, apiBaseUrl)`
(`src/pipeline/packaging.ts:269-274`), whose base is
`<apiBaseUrl>/<assetId>/stream` via `proxyStreamPrefix`
(`src/pipeline/packaging.ts:259-261`). The API origin comes from
`PUBLIC_BASE_URL` via `assetsBaseUrl` (`src/routes/assets.ts:1242-1253`). Only the
formats the packaged output actually produced are advertised
(`src/routes/assets.ts:3160-3164`).

`ready` is also returned for external storage backends (the object store / CDN
is itself the public origin, `src/routes/assets.ts:3119-3131`), for a relocated
per-execution destination (`src/routes/assets.ts:3096-3112`), and for
source-only download URLs — but on the source-only path ONLY when the asset's
own lifecycle status is not `failed` (see the `failed` variant below, #810).

**A `ready` HLS/DASH URL is a `/stream/*` URL. Fetch it directly with a player —
do not attempt to resolve it against a bucket.**

#### The `not_configured` variant

`status: "not_configured"` means the asset HAS packaged output, but this
deployment cannot advertise a fully-resolvable playback URL **in the delivery
mode it is configured for**. Which setting is missing depends on the mode, and
since #860 the response says so. Body shape (built by `notConfiguredDelivery`,
`src/routes/assets.ts`):

- `urls.hls` / `urls.dash` are **omitted** (`urls` is `{}`) so a consumer never
  mistakes an unplayable value for a ready URL.
- `resolution` carries the persisted packaged location so a client with its own
  object-store access can locate the master manifest objects deterministically:
  `packagedBucket`, `packagedPrefix` (the job-nested prefix the packager wrote
  under), `masterHlsKey`, `masterDashKey`. Populated from the asset's
  `packagedOutput` block (#502) by `deliveryResolutionFor`;
  `PackagedOutput` type + field meanings: `src/data/asset-repo.ts:357-382`.
- `resolution.missingConfiguration` (array of env-var names) and
  `resolution.reason` (human-readable) name the setting to change (#860):
  `PACKAGED_PUBLIC_BASE_URL` in `public` mode, `PUBLIC_BASE_URL` in `proxy` mode.
  These are emitted even when the asset has no persisted `packagedOutput`, since
  the misconfiguration is a property of the deployment, not of the asset.

The `packaged*`/`master*Key` fields are entirely additive: an asset packaged
before #502 (no persisted `packagedOutput`) simply omits them.

`not_configured` is returned from the proxy branch when the proxy base is not
absolute, and from the public-mode branch when neither format resolves to an
absolute public URL. **The public branch never substitutes a `/stream/*` proxy
URL to avoid this status** (#860) — see section 3.

The correct fix for `not_configured` is **not** direct bucket access — it is to
set the variable the response names, so `/delivery` can advertise absolute URLs
in the configured mode. The `resolution` metadata exists only for an operator
who can already address the objects — it tells that operator the exact keys,
which is precisely what bucket listing does not (listing is `403` on both
buckets). It is not a supported path for normal API consumers, and the layout it
exposes is not part of the API contract.

#### The `failed` variant (#810)

`status: "failed"` means the asset's own ingest/processing lifecycle ended in
`failed` (`AssetStatus`, `src/data/asset-repo.ts:25-29`) AND it produced no
packaged output — so the only thing `/delivery` can point at is the stored
source object. Before #810 this case fell through the source fallback and was
reported as `ready` purely because `objectKey` was set, which told a consumer
the opposite of the truth: there is no playable output.

Body shape:

- `urls.hls` / `urls.dash` are **always omitted** (there are no manifests).
- `urls.source` is still emitted (presigned or external-origin URL, same as the
  non-failed source-only case) so an operator can fetch the raw source to
  diagnose the failure or re-ingest it.
- `status` is `failed`, never `ready`, so a consumer that treats `status` as
  "playable output exists" cannot be misled.

Scope: the check applies **only** to the source-only fallback. A `failed` asset
that did produce packaged manifests still returns `ready` for those manifests —
that output genuinely is playable. Emitting the source URL under a non-`ready`
status is the same pattern as `not_configured`: the readiness signal, not the
presence of a URL, is what a consumer keys off.

### 2. `GET /api/v1/assets/:id/stream/*` behaviour

Route handler: `src/routes/assets.ts:3286-3442`.
OpenAPI path: `openapi.json:7391-7417` (`/api/v1/assets/{id}/stream/{*}`).

This single wildcard route serves every packaged object for playback. There are
no separate `index.m3u8` / `manifest.mpd` routes — those are matched by the
wildcard `*`:

- `GET /api/v1/assets/:id/stream/index.m3u8` — the master HLS manifest.
- `GET /api/v1/assets/:id/stream/manifest.mpd` — the master DASH manifest.
- `GET /api/v1/assets/:id/stream/<relative>` — any child playlist, CMAF init
  segment, or media segment (e.g. `v0/playlist.m3u8`, `seg-00001.m4s`).

The deterministic manifest names `index.m3u8` and `manifest.mpd` are exactly the
filenames the packager emits (`src/pipeline/packaging.ts:72-77`,
`src/pipeline/packaging.ts:269-274`).

#### What the wildcard maps to (packaged-prefix resolution)

`*` is the object path **relative to the asset's packaged prefix**. The route
resolves the REAL prefix the packager wrote under and maps
`objectKey = <streamPrefix>/<relative>` inside the packaged bucket
(`src/routes/assets.ts:3324-3325`). Prefix resolution (`resolveStreamPrefix`,
`src/routes/assets.ts:1313-1327`) prefers, in order:

1. the durable `packagedOutput.prefix` persisted on the asset (#502) — the
   job-nested `<assetId>/<packagerJobId>/` prefix;
2. a lazy list fallback for assets packaged before #502 (lists the packaged
   bucket under `<assetId>/` and derives the newest job prefix);
3. the historical flat `packaged/<id>` prefix (`outputPrefix`,
   `src/pipeline/packaging.ts:63-65`) when the asset has no packaged objects
   under `<assetId>/` at all.

This is exactly the #503 fix: the proxy no longer assumes a flat prefix and
404s against the real job-nested objects (source: #503 commit message; handler
comment `src/routes/assets.ts:3316-3324`).

#### Relative child playlists and segments resolve through the same endpoint

When the requested object is a manifest (`.m3u8` / `.mpd`, detected by
`isManifestPath`, `src/pipeline/manifest-rewrite.ts:49-52`), the route rewrites
every child reference so it resolves back through this same `/stream/*` prefix
rather than escaping to a bare bucket host or a stored object-key path. Rewrite invoked at
`src/routes/assets.ts:3369-3400`; rewrite logic in
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
`src/routes/assets.ts:1280-1291`). The stored manifest bytes are never mutated —
the rewrite is a text transform applied only to the proxied response
(`src/routes/assets.ts:3365-3368`).

**Net effect for a consumer:** point a player at the `urls.hls` or `urls.dash`
value from `/delivery`. The player fetches the master manifest through
`/stream/index.m3u8` (or `/stream/manifest.mpd`), and every variant playlist,
init segment, and media segment it references is fetched back through the same
`/stream/*` route automatically. **Direct bucket access is never required for
playback.**

#### Other stream behaviours

- Range requests: a single HTTP `Range` is honored for segment fetches (`206`
  Partial Content); a manifest is always served whole (`200`) because the
  rewrite changes its length. `src/routes/assets.ts:3348-3368`,
  `src/routes/assets.ts:3412-3429`. An unsatisfiable range yields `416`
  (`src/routes/assets.ts:3353-3359`).
- Content types: `.m3u8 → application/vnd.apple.mpegurl`,
  `.mpd → application/dash+xml`, others inferred, unknown falls back to
  `application/octet-stream`. `contentTypeForPackagedObject`,
  `src/routes/assets.ts:1378-1398`.
- Status codes: `200`/`206` object stream; `404` unknown asset, empty/traversal
  path, or missing object (`src/routes/assets.ts:3292-3310`,
  `src/routes/assets.ts:3344-3346`); `501` object storage not configured
  (`src/routes/assets.ts:3298-3303`).

### 3. Delivery-mode configuration (operator-facing)

`DELIVERY_MODE` (env, 12-factor) selects a mutually-exclusive delivery posture
for the default per-stack MinIO backend (`deliveryMode`,
`src/pipeline/packaging.ts:245-253`):

- `proxy` — `/delivery` advertises `/stream/*` proxy URLs and the client is never
  handed a bucket URL (branch: `src/routes/assets.ts:3142-3167`). This mode does
  **not** change the packaged bucket's policy: the anonymous-read policy is applied
  during provisioning, unconditionally and with no reference to `DELIVERY_MODE`
  (`src/routes/provision.ts:996-1011`). The variable is read in exactly one place
  (`process.env['DELIVERY_MODE']`, `src/pipeline/packaging.ts:246`) and
  `deliveryMode()` has exactly one non-test caller (`src/routes/assets.ts:3142`),
  so no provisioning path can observe it. The bucket is a public-read origin in
  proxy mode too, and "proxy" describes what the API *advertises*, not what the
  bucket *permits*.
- `public` (default when unset/unrecognised) — advertises the stored CMAF
  manifest URLs resolved to the packaged bucket's public origin. That origin is
  `PACKAGED_PUBLIC_BASE_URL` when set, else the resolved stack's own MinIO
  endpoint (#859, `packagedPublicOrigin`). On a deployment where neither is
  available the stored value stays a **bare object-key path with no scheme and
  no host** (e.g. `/openvideocore-packaged/<id>/<uuid>/index.m3u8`), which a
  player cannot fetch.

  Since #860 that case returns `not_configured` naming
  `PACKAGED_PUBLIC_BASE_URL`. It does **not** fall back to a `/stream/*` proxy
  URL. The earlier #341 fallback did, which left a deployment nominally in
  `public` mode while behaving as `proxy` — the state this section calls
  mutually exclusive — and, worse, hid the unset origin behind a ready-looking
  `200` whose URL then `401`s, because `/stream/*` requires a bearer token.
  A missing origin is a configuration problem, reported as one; a deployment
  that wants proxy delivery asks for it with `DELIVERY_MODE=proxy`.

The two modes are genuinely exclusive on the advertised-URL surface: `public`
never emits a `/stream/*` URL and `proxy` never emits a bucket URL. To get
absolute `ready` URLs, set `PACKAGED_PUBLIC_BASE_URL` (public mode) or
`PUBLIC_BASE_URL` (proxy mode) — or, in public mode, deploy against a
provisioned stack, whose MinIO endpoint #859 derives the origin from.

> **Known divergence (out of scope for #860).** `GET /:id/files` builds its
> `fileGroups[].manifestUrl` with the same proxy fallback and is not
> delivery-mode aware, so in the unconfigured `public` case it still advertises a
> `/stream/*` URL where `/delivery` now reports `not_configured`. Tracked
> separately.

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
    `src/data/asset-repo.ts:357-382`.
  - #503 makes `/stream/*` resolve the REAL prefix (persisted → lazy list →
    flat fallback) and uses it for both the object key and the manifest-rewrite
    context, so child playlists and segments resolve back through the same
    authorized route. `resolveStreamPrefix`, `src/routes/assets.ts:1313-1327`.
  - #506 makes `/delivery` advertise a fully-resolvable ABSOLUTE playback URL
    with `status: "ready"`, or an unambiguous `status: "not_configured"` body
    (no playback URL) plus `resolution` metadata when public delivery is not
    configured. It never advertises a `200` that looks ready with no resolvable
    URL. `src/routes/assets.ts:3142-3223`, schema `src/routes/assets.ts:520-564`.

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
  bucket credentials and no storage-layout knowledge. (Re-justified on the
  corrected premise: bucket listing is `403` on both buckets and packaged keys are
  job-nested, so the layout is not discoverable by a consumer anyway — the API is
  the only supported way to learn a playable URL.)
- One advertised URL shape per deployment, resolved server-side, so the storage
  layout stays an implementation detail the API can change (as #502/#503 did)
  without breaking consumers.
- The **source** bucket stays strictly private (`403` unauthenticated), and
  **neither** bucket is enumerable — so raw masters are not externally readable
  and no bucket can be crawled.
- The `status` enum gives consumers an unambiguous readiness signal; an
  unplayable state is `not_configured` or `failed`, never a fake-ready `200`.

**Negative / trade-offs:**
- All packaged bytes transit the API process in proxy mode, so the API is on the
  playback data path (mitigate with a fronting CDN over `/stream/*` if needed —
  segment responses set `Cache-Control` and advertise `Accept-Ranges`). On the
  corrected premise this cost is now a *choice*, not a necessity — see OPEN-1.
- Fully-resolvable `ready` URLs require the origin for the configured mode
  (`PACKAGED_PUBLIC_BASE_URL` for `public`, `PUBLIC_BASE_URL` for `proxy`);
  otherwise `/delivery` returns `not_configured` naming the missing variable
  (#860). Since #860 an unconfigured `public`-mode deployment reports that
  explicitly rather than silently serving proxy URLs, so stacks that relied on
  the old fallback must set an origin — on a provisioned stack #859 derives one
  from the stack's MinIO endpoint automatically.

### Open questions raised by the corrected premise (#857)

These were previously treated as settled by the old, false premise. Correcting the
premise reopens them. #857 is documentation-only and deliberately does **not**
resolve any of them.

- **OPEN-1 — Should `/stream/*` proxying remain the default delivery posture?**
  The original justification ("a presigned or public bucket URL does not resolve
  externally") is void: the packaged bucket is a public-read origin and presigned
  URLs resolve externally with `200`. There may still be good reasons to keep the
  proxy as the default (per-request authorisation on playback, no key leakage, a
  stable URL shape, manifest rewriting, CDN-frontable single origin), but they
  have not been weighed against serving the origin bucket directly. This is a
  product decision, not a documentation fix.
- **OPEN-2 — Code comments still assert the false premise.** **Eight** sites across
  **three** files, each verified against `9c39239`. Only the first three say it
  verbatim; the other five encode the same false premise as "the packaged bucket
  stays private". All are wrong and should be corrected in a code change (out of
  scope here); until then, treat this section — not those comments — as
  authoritative.

  | Site | What it says | Why it is wrong |
  |---|---|---|
  | `src/routes/assets.ts:3079-3080` | "OSC MinIO blocks external presigned/public GETs" | Presigned GETs resolve externally with `200`; nothing is blocked at a platform proxy. |
  | `src/routes/assets.ts:3116-3118` | "the per-stack MinIO backend that blocks external GETs" | Same. |
  | `src/routes/assets.ts:3174-3175` | "OSC MinIO blocks external presigned/public GETs" | Same. |
  | `src/routes/assets.ts:3135-3137` | `proxy` → "The packaged bucket stays private (no anonymous read)." | The packaged bucket is anonymous-read by policy in **both** modes; the policy is applied unconditionally at `src/routes/provision.ts:1011`, independent of `DELIVERY_MODE`. |
  | `src/routes/assets.ts:3270-3273` | "instead of exposing the packaged bucket for anonymous GET … so the bucket stays private" | The bucket is *already* exposed for anonymous GET. The proxy is not what keeps it private, because it is not private. |
  | `src/pipeline/packaging.ts:235-238` | `'proxy'`: "the packaged bucket stays private … so no anonymous bucket read is required" | Sharpest case — this is the doc comment on `deliveryMode` itself, and it directly contradicts the policy at `provision.ts:1011`. |
  | `src/data/storage.ts:152-153` | `getObject` "bypasses presigned URLs for environments where they are blocked (e.g. OSC MinIO reverse proxy)" | The premise in its most explicit form, and the one that names the mechanism that does not exist. |
  | `src/data/storage.ts:162` | "this uses the stack's admin credentials so the packaged bucket stays private" | Using admin credentials on the read path does not make the bucket private; its policy is anonymous-read. |

  Checked and deliberately **excluded**: `src/routes/assets.ts:619` and
  `src/routes/assets.ts:4628` also read "the bucket stays private", but both
  concern presigned **thumbnail** URLs, and thumbnails live in
  `openvideocore-source` (`thumbnails/<assetId>/…`,
  `src/pipeline/thumbnail.ts:72-73`; source-bucket ownership stated at
  `src/pipeline/archived-asset-purge-sweep.ts:97-99` and `:295`). That bucket **is**
  strictly private (`403` unauthenticated, measured above), so those two are
  accurate as written. `src/routes/assets.ts:4615-4616` ("the only option where
  anonymous GETs against object storage are blocked") is conditionally phrased and
  also source-bucket scoped, so it is not false, but it cites the #113 constraint
  as its motivation and is worth re-reading when OPEN-2 is actioned.
- **OPEN-3 — `DELIVERY_MODE=public` behaviour on the default backend.**
  *Resolved by #859 + #860.* The #341 fallback routed public mode through the
  proxy because the *stored* value is a bare object-key path. Since the packaged
  bucket is an externally-readable origin, #859 derives
  `PACKAGED_PUBLIC_BASE_URL` from the stack's own MinIO endpoint when it is
  unset, making public mode genuinely direct by default; #860 then removed the
  proxy fallback, so a deployment with no derivable origin reports
  `not_configured` instead of quietly adopting the other mode's posture.
- **OPEN-4 — Is public-read on the packaged bucket the right posture for
  multi-tenant deployments?** Anyone holding an exact packaged key can fetch that
  object with no credentials and no token. Enumeration is denied and keys are
  job-nested (`<assetId>/<packagerJobId>/…`), so keys are not guessable, but the
  ADR should not assert "the packaged bucket stays private" — it does not. Whether
  unauthenticated key-based access to packaged output is acceptable, and how it
  relates to the authorisation model in ADR-018, needs a security review.

---

## References

- ADR-001 open question 4 (delivery deferral; this ADR is the reserved
  "ADR-003: Delivery and CDN integration").
- ADR-011 — per-execution packaged-output destination (relocated delivery URLs).
- ADR-018 — authorisation model (relevant to OPEN-4).
- Issues #502 (persist packaged prefix/keys), #503 (resolve packaged prefix for
  `/stream`), #506 (resolvable delivery URLs or `not_configured`), #509 (this
  documentation task), #810 (`failed` status for a failed, source-only asset),
  #199 (anonymous read-only policy on the packaged bucket), #341 (proxy fallback
  for a non-absolute public-mode URL), #857 (this amendment: correct the
  object-storage access model).
- Code: `src/routes/assets.ts` (delivery + stream handlers, schemas),
  `src/routes/provision.ts` (per-bucket policy: `PACKAGED_BUCKET` public read,
  `SOURCE_BUCKET` strict), `src/pipeline/packaging.ts` (proxy/output prefixes,
  delivery mode), `src/pipeline/manifest-rewrite.ts` (child-reference rewriting),
  `src/data/asset-repo.ts` (`PackagedOutput` shape), `openapi.json` (generated
  contract).
