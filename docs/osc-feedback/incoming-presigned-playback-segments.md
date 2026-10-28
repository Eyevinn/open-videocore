# OSC friction — no way to sign a whole HLS/DASH package for browser playback (issue #802)

**Date:** 2026-09-25
**Surface:** backend-api
**Service:** minio-minio (per-stack object storage)

## What we needed

Issue #802 generalizes the presigned-URL pattern so any inline media element the
ops UI renders can load its bytes — an `<img>`, and now a `<video>`/`<source>`.
The pattern works because a signed URL carries its own credential, so the
browser's plain GET (which cannot send an `Authorization` header) still resolves.

For a single object this is fine. `GET /api/v1/assets/:id/delivery` mints a
presigned GET on the stored source object (`urls.source`), and a
`<video><source src=…>` plays it directly.

For **packaged output it does not work at all**. An HLS/DASH package is one
master manifest, N variant playlists, and hundreds to thousands of CMAF segments.
A player fetches each of those itself, resolving relative references against the
manifest's own URL. We can sign the manifest; we cannot sign what the player
fetches next.

## Friction

`minio-minio` exposes only per-object presigning. There is no:

- **signed prefix / scoped policy** — no way to issue one credential valid for
  every object under `packaged/<assetId>/`, which is exactly the unit of access a
  streaming package needs;
- **signed cookie equivalent** — the mechanism a CDN normally uses for this, where
  the browser attaches the credential to every subsequent segment request
  automatically;
- **documented statement** of whether presigned GET through the instance ingress
  is a supported contract at all, so even the single-object case is built on a
  measured behaviour rather than a promise.

The consequence for this application is structural, not cosmetic. With a private
packaged bucket, browser playback has exactly two options, and both are bad:

1. **Proxy every byte through the API** — what `DELIVERY_MODE=proxy` does today
   (`GET /api/v1/assets/:id/stream/*`). It keeps the bucket private, but it puts
   the API on the playback data path for every segment of every viewer, and
   because that route is behind the API's bearer gate a bare `<video>` cannot use
   it either — only a player that can inject a header. So the ops UI cannot offer
   inline playback of packaged output at all.
2. **Make the packaged bucket publicly readable** — which trades the access
   control away entirely, and is not acceptable for a multi-tenant deployment.

Signing per object is not a third option: rewriting a manifest to replace every
child reference with its own signed URL means signing every segment up front
(thousands of signatures, all sharing one expiry — a long stream outlives them),
and it breaks any player that resolves references relatively.

## Request to OSC

- Provide a **prefix-scoped signed credential** for object storage — a signed
  URL/token valid for every object under a given prefix for a bounded window.
  That single primitive makes private-bucket HLS/DASH playable in a plain
  `<video>` with no proxy on the data path.
- Failing that, document a **supported pattern for serving a private streaming
  package to a browser**, so integrators stop re-deriving the same two bad
  options.
- State explicitly whether presigned GET via the instance ingress is a guaranteed
  contract or incidental. Everything above, including the single-object source
  playback this issue ships, rests on that answer.

## Impact if unaddressed

Inline playback in the ops UI stays limited to the raw source object. Packaged
output remains either proxied through the API (API on the playback path, and not
loadable by an inline element) or publicly readable. Any consumer application
built on this API inherits the same choice.
