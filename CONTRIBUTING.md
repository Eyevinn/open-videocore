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

// <video> playing an asset's stored source object.
// GET /assets/:id/delivery -> { urls: { source } }, a presigned GET.
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
URL, and removes the `src` again on failure so the element falls back to its
placeholder rather than a broken-media icon. For a `<source>` it also re-selects
the parent `<video>`, which otherwise ignores a `src` set on a child after it has
already picked its resource.

Two things worth knowing before adding a new inline media feature:

- **Do not fall back to a blob object URL for audio/video.** A blob URL holds the
  whole object in memory and serves no range requests, so seeking and progressive
  playback are lost. That fallback is viable only for a single small image.
- **HLS/DASH under `DELIVERY_MODE=proxy` is not inline-playable.** `urls.hls` /
  `urls.dash` are then `/api/v1/assets/:id/stream/*` paths behind the same gate,
  and signing the manifest would not help because the player resolves every child
  segment against the same gated prefix (see `ADR-003`). Inline playback needs a
  presigned source object, a public/CDN delivery mode, or a player that can attach
  the token itself.

The helper's contract grounding (route, schema symbol, and OpenAPI path for each
URL-issuing endpoint) is in the module header; extend that list rather than
hardcoding a new path inside the helper.

## Code style

- TypeScript strict mode
- Zod for all route validation
- Graceful degradation — features should degrade to 501 rather than crashing when optional services are not configured
- No hardcoded credentials or connection strings
- Inline media elements go through `public/media-src.js` (see above), never a raw API path
