/**
 * open-videocore ops dashboard — thumbnail-url.js
 *
 * Issue #801: load every ops-UI thumbnail through the presigned-URL endpoint
 * instead of pointing an <img src> at the bearer-gated byte route.
 *
 * WHY: `GET /api/v1/assets/:id/thumbnails/:index` streams image/jpeg from behind
 * the assets router's bearer gate. A browser's plain <img> GET carries no
 * Authorization header — apiFetch (public/app.js) can only attach one to fetch()
 * calls it makes itself — so such an <img> always renders as a broken image.
 * The fix is to ask the API for a short-lived SIGNED URL first (an authenticated
 * JSON call, so apiFetch works normally) and assign that to img.src; the
 * browser's follow-up GET then carries the signature in the URL itself.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (fetch-the-contract-before-writing-any-call rule)
 *
 * Endpoint: GET /api/v1/assets/{id}/thumbnails/{index}/url
 *   openapi.json → .paths["/api/v1/assets/{id}/thumbnails/{index}/url"].get
 *   source       → src/routes/assets.ts:4431 (route registration, issue #800)
 *   Path params (both declared `z.string()`): `id`, `index`. `index` is the
 *   position in the asset's `thumbnails` array — the SAME key the listing route
 *   `GET /:id/thumbnails` uses when it returns one proxy URL per recorded key
 *   (src/routes/assets.ts:4353), so a list of N thumbnails is addressable as
 *   indices 0..N-1.
 *
 * 200 response (`thumbnailUrlSchema`, src/routes/assets.ts:611; all six fields
 * required, additionalProperties false):
 *   { assetId: string, index: number, objectKey: string, url: string,
 *     expiresAt: string, expiresInSeconds: number }
 * This module reads exactly ONE field: `url` — the signed, short-lived GET URL
 * for the thumbnail object. `expiresAt` / `expiresInSeconds` matter only to a
 * caller that caches the URL; the ops UI re-requests on each render instead, so
 * a rendered thumbnail can never outlive its signature.
 *
 * Documented failure codes, all tolerated here: 404 (unknown asset or
 * out-of-range index), 501 (object storage not configured on this deployment),
 * 502 (storage failed to sign the URL). None of them is worth an operator-facing
 * error banner for a decorative thumbnail, so the caller keeps its placeholder.
 */

// Fetch the signed URL for one thumbnail. `apiFetch` is injected (public/app.js
// owns the auth headers and the stack header) rather than imported, so this
// module stays free of a cycle with app.js and is drivable from tests.
// Rejects on any non-2xx (apiFetch throws) or on a body without a usable `url`.
export async function fetchThumbnailUrl(apiFetch, assetId, index) {
  if (typeof apiFetch !== 'function') throw new Error('apiFetch is required');
  const body = await apiFetch(
    '/assets/' +
      encodeURIComponent(assetId) +
      '/thumbnails/' +
      encodeURIComponent(index) +
      '/url'
  );
  const url = body && typeof body.url === 'string' ? body.url : '';
  if (!url) throw new Error('thumbnail URL response carried no url field');
  return url;
}

// Point an existing <img> at its presigned thumbnail URL.
//
// Resolves true once a URL has been issued and assigned, false on any failure.
// Never throws and never rejects: a thumbnail is decoration, and the ops UI must
// not surface a storage hiccup as a page-level error.
//
// On failure the src is removed again, so the element falls back to the empty
// box it showed before hydration rather than a broken-image icon (issue #801
// acceptance criterion). `placeholderClass`, when given, is removed on success
// and (re)applied on failure; `onFailure` lets a caller drop the element instead.
//
// options: { apiFetch, assetId, index, placeholderClass?, onFailure? }
export async function applyThumbnail(img, options) {
  const o = options || {};
  const placeholderClass = o.placeholderClass || '';
  const onFailure = typeof o.onFailure === 'function' ? o.onFailure : null;

  function fail() {
    img.removeAttribute('src');
    if (placeholderClass) img.classList.add(placeholderClass);
    if (onFailure) onFailure();
    return false;
  }

  // A signature can expire, or object storage can refuse the signed GET, after
  // the URL was issued — that surfaces as an <img> error event, not as a
  // rejected fetch, so it needs its own handler.
  img.addEventListener('error', fail, { once: true });

  let url;
  try {
    url = await fetchThumbnailUrl(o.apiFetch, o.assetId, o.index);
  } catch (_) {
    return fail();
  }

  if (placeholderClass) img.classList.remove(placeholderClass);
  img.src = url;
  return true;
}
