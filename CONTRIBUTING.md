# Contributing

We welcome contributions! Please open an issue to discuss what you would like to change before submitting a pull request.

## Getting started

```bash
cd backend-api
pnpm install
pnpm dev
```

## Running tests

```bash
cd backend-api
pnpm test
```

## Pull request checklist

- [ ] `pnpm build` passes (no TypeScript errors)
- [ ] `pnpm test` passes
- [ ] New features include tests
- [ ] No commercial product names, trademarks, or product-specific terminology in any file

## Continuous integration

Every pull request against `main` runs the `ci` workflow, which executes
`pnpm typecheck`, `pnpm test`, and `pnpm build`. A companion `test-guard` check
also runs and fails the PR if the diff weakens the test suite — that is, if it:

- deletes a test file (`*.test.ts` / `*.spec.ts`), or
- net-removes `test(...)` / `it(...)` / `describe(...)` blocks from a test file
  that still exists (commenting them out counts too), or
- changes a coverage threshold in a vitest/vite config.

### Intentionally removing or changing tests

Sometimes removing a test is the right call (a feature was dropped, a test was a
duplicate, etc.). To let such a PR through the `test-guard` check, add a
human-reviewed justification using **either**:

1. A line in the PR body:

   ```
   test-exception: removing duplicate coverage now folded into asset-lifecycle.test.ts
   ```

2. The label `test-exception-approved` on the PR.

Either signal makes `test-guard` pass. Reviewers should confirm the justification
before merging.

## Inline media elements (`<img>`, `<video>`, `<source>`)

Never point an inline media element at an API path.

Every media-serving route on the assets router is behind the router's bearer gate,
and a browser fetches an inline element's own URL (`img.src`, `video.src`,
`<source src>`) as a plain GET with no `Authorization` header. The UI's `apiFetch`
helper can only attach a token to `fetch()` calls it makes itself, so an element
pointed at, say, `/api/v1/assets/<id>/thumbnails/0` or
`/api/v1/assets/<id>/stream/index.m3u8` is refused with a 401 however healthy the
underlying object is — a broken-image or broken-video element on a working
pipeline.

Instead, ask the API over `apiFetch` for a short-lived **presigned URL** and
assign that. Use the shared helper — `public/media-src.js`:

```js
import { applyPresignedMediaSrc } from './media-src.js';

// <video> playing an asset's stored SOURCE object.
// GET /assets/:id/delivery -> { urls: { source } }, a presigned GET.
// Only for an asset with no packaged output — see the caveat below.
const video = document.createElement('video');
applyPresignedMediaSrc(video, {
  apiFetch,
  urlPath: '/assets/' + encodeURIComponent(id) + '/delivery',
  urlField: 'urls.source',
  placeholderClass: 'media-placeholder',
});
```

The helper is route-agnostic: pass the path of any URL-issuing route and the
dotted field carrying the loadable URL (`'url'` by default). It resolves
`true`/`false`, never throws, refuses anything that is not an absolute `http(s)`
URL — plus, as a backstop, an absolute URL on the gated `/assets/:id/stream/`
prefix, which is the one token-protected path our own API hands back in an
otherwise loadable-looking field (see the `DELIVERY_MODE=proxy` note below) — and
removes the `src` again on failure so the element falls back to its
placeholder rather than a broken-media icon. For a `<source>` it also re-selects
the parent `<video>` — in both directions, on assignment (a `src` set on a child
after the parent picked its resource is otherwise ignored) and on failure (a
cleared child otherwise leaves the parent bound to the dead resource).

It is also safe to call again on an element that is already showing or still
resolving an earlier URL — a re-rendered row, a re-populated thumbnail strip. The
last call wins: the previous call's `error` listener is removed rather than left
to pile up, and a superseded call can no longer clear the `src` or fire its
`onFailure` against the newer one.

### `urls.source` is not available for every asset

`GET /api/v1/assets/:id/delivery` returns **either** packaged manifests **or** a
source download — never both. Every key of `urls` is optional, and the handler
takes exactly one branch per asset:

| Asset | Response |
| --- | --- |
| Has packaged output (HLS/DASH) | `200` `status: 'ready'`, `urls: { hls?, dash? }` — **no `source`** |
| Has packaged output, public delivery not configured | `200` `status: 'not_configured'`, `urls: {}` plus `resolution` |
| No packaged output, stored source object only | `200` `urls: { source }`; `status: 'failed'` if the asset's own lifecycle failed, else `'ready'` |
| Has packaged output, `PACKAGED_PUBLIC_BASE_URL` set but not an absolute URL | `501 not_configured` — an explicit misconfiguration (`PublicManifestBaseUrlError`), no body `urls` at all |
| Neither packaged output nor source object | `404 no_delivery` |

So the snippet above resolves falsy — and the helper returns `false`, having
assigned nothing — for **every packaged asset**. Do not treat `urls.source` as
always present. Branch on which key you actually got (or on `status`):

```js
import { assignMediaSrc } from './media-src.js';

// Already-resolved URL, so assign it directly — no second round trip.
// `apiFetch` THROWS on the 404 (no packaged output and no source object) and on
// the 501 (misconfigured public base), so a raw call needs its own catch — the
// `applyPresignedMediaSrc` path swallows both for you.
let delivery;
try {
  delivery = await apiFetch('/assets/' + encodeURIComponent(id) + '/delivery');
} catch (err) {
  showNoInlinePlayback();                                // 404 / 501 / transport
  return;
}

if (delivery.urls.source) {
  assignMediaSrc(video, delivery.urls.source);          // presigned, plays inline
} else if (delivery.urls.hls || delivery.urls.dash) {
  // Packaged. Not inline-playable under DELIVERY_MODE=proxy (below). Either
  // preview the source object from GET /assets/:id/files (its `type: 'source'`
  // entry carries a presigned `url`, packaged or not), or show "no inline
  // playback" and link the manifest for a player that can authenticate.
  showNoInlinePlayback(delivery.status);
} else {
  showNoInlinePlayback(delivery.status);                 // not_configured
}
```

Contract: `openapi.json` →
`.paths["/api/v1/assets/{id}/delivery"].get.responses` — `200`, `404` and `501`
(the generated spec declares no `operationId`, so the path item plus method is the
identifier); source `src/routes/assets.ts` — route `:3053`, `deliverySchema`
`:558`, `deliveryUrlsSchema` `:520`, packaged branch `:3085`, source fallback
`:3242`, `notConfiguredDelivery` `:1360`, `501` catch `:3215`.

Two more things worth knowing before adding a new inline media feature:

- **Do not fall back to a blob object URL for audio/video.** A blob URL holds the
  whole object in memory and serves no range requests, so seeking and progressive
  playback are lost. That fallback is viable only for a single small image.
- **HLS/DASH under `DELIVERY_MODE=proxy` is not inline-playable.** `urls.hls` /
  `urls.dash` are then `/api/v1/assets/:id/stream/*` paths behind the same gate,
  and signing the manifest would not help because the player resolves every child
  segment against the same gated prefix (see `ADR-003`). Inline playback needs a
  presigned source object, a public/CDN delivery mode, or a player that can attach
  the token itself. Those proxy URLs are **absolute**, so an `http(s)` check alone
  does not catch them; `isLoadableMediaUrl` refuses the `/assets/:id/stream/` path
  shape specifically (`openapi.json` →
  `.paths["/api/v1/assets/{id}/stream/{*}"].get`, source `src/routes/assets.ts:3287`),
  so passing one to the helper fails locally instead of 401-ing in the element.
  Treat that as a backstop for a mistake, not a licence to skip the branch above.

The helper's contract grounding (route, schema symbol, and OpenAPI path for each
URL-issuing endpoint) is in the module header; extend that list rather than
hardcoding a new path inside the helper.

## Code style

- TypeScript strict mode
- Zod for all route validation
- Graceful degradation — features should degrade to 501 rather than crashing when optional services are not configured
- No hardcoded credentials or connection strings
- Inline media elements go through `public/media-src.js` (see above), never a raw API path
