# OSC Friction: presigned GET behaviour is undocumented and has changed since 2026-06

**Date:** 2026-09-25
**Severity:** Medium (was High while it blocked delivery — see history)
**Service:** minio-minio
**Affected features:** thumbnail delivery to the browser (#800, #801), any
browser-loadable object URL
**Supersedes:** `incoming-minio-presigned-blocked.md` (2026-06-02)

## What we needed to know

Issue #801 makes the ops UI load thumbnails from the signed URL issued by
`GET /api/v1/assets/:id/thumbnails/:index/url` (#800). That only renders if a
presigned GET against the stack's private bucket succeeds from a browser
**outside** the cluster. The project's own 2026-06-02 log recorded the opposite:
every presigned GET returned 403 from outside, which is why the byte-proxy route
`GET /api/v1/assets/:id/thumbnails/:index` exists at all.

Nothing in the service documentation states which of the two is the contract, so
the only way to settle it was to measure it.

## Measurement (2026-09-25)

Against a live `minio-minio` instance in this workspace, from outside the
cluster, using the same SDK call the API uses (`presignedGetObject`, via
`WorkspaceStorage.presignedGet`, `src/data/storage.ts:132`):

| Request | Result |
|---|---|
| Signed GET (300 s TTL) on a private bucket | **HTTP 200**, `Content-Type: image/jpeg`, 160 bytes — the object |
| Same URL with the query string removed (unsigned) | **HTTP 403** |
| Same URL with a corrupted signature | **HTTP 403** |

Endpoint form: `https://<tenant>-<instance>.minio-minio.auto.prod-se.osaas.io`.
The probe object and its bucket were removed afterwards.

So presigned GETs **do** work through the platform ingress today, and the bucket
stays private: only a valid signature is served. The 2026-06-02 observation no
longer reproduces.

## Friction

1. **The behaviour changed with no announcement and no documented contract.** A
   403-vs-200 flip on presigned GET is the difference between "thumbnails render"
   and "thumbnails never render", and it silently reversed some time between
   2026-06 and 2026-09. We only found out by probing.
2. **There is no statement of intent to build on.** The service documentation
   does not say whether anonymous presigned GET through the ingress is a
   supported contract or an incidental property of the current proxy
   configuration, so we cannot tell whether it may flip back.
3. **Cost of the uncertainty:** every browser-facing delivery path in this
   application has to carry a second, proxy-through-the-API implementation as a
   fallback. #801 ships exactly that: the signed URL first, the authenticated
   byte route second. That is duplicated code and double the round trips on a
   degraded stack, kept solely because the contract is unstated.

## Request to OSC

- State in the service documentation whether presigned GET URLs are guaranteed
  to be servable through the instance ingress to an unauthenticated client.
- If it is guaranteed, say so explicitly so integrators can delete their proxy
  fallbacks; if it is not, say that instead so nobody builds on it.
- Announce changes to ingress behaviour that affect a documented S3 operation —
  this one silently invalidated a recorded workaround.
