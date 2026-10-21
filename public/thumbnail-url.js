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
 * PRIMARY — GET /api/v1/assets/{id}/thumbnails/{index}/url
 *   openapi.json → .paths["/api/v1/assets/{id}/thumbnails/{index}/url"].get
 *   source       → src/routes/assets.ts:4438 (route registration, issue #800)
 *   Path params (both declared `z.string()`): `id`, `index`. `index` is the
 *   position in the asset's `thumbnails` array — the SAME key the listing route
 *   `GET /:id/thumbnails` uses when it returns one proxy URL per recorded key
 *   (src/routes/assets.ts:4352), so a list of N thumbnails is addressable as
 *   indices 0..N-1.
 *
 *   200 response (`thumbnailUrlSchema`, src/routes/assets.ts:611; all six fields
 *   required, additionalProperties false):
 *     { assetId: string, index: number, objectKey: string, url: string,
 *       expiresAt: string, expiresInSeconds: number }
 *   This module reads exactly ONE field: `url` — the signed, short-lived GET URL
 *   for the thumbnail object. `expiresAt` / `expiresInSeconds` matter only to a
 *   caller that caches the URL; the ops UI re-requests on each render instead,
 *   so a rendered thumbnail can never outlive its signature.
 *
 *   Documented failure codes: 404 (unknown asset or out-of-range index), 501
 *   (object storage not configured on this deployment), 502 (storage failed to
 *   sign the URL). apiFetch turns each into a thrown Error.
 *
 * FALLBACK — GET /api/v1/assets/{id}/thumbnails/{index}
 *   openapi.json → .paths["/api/v1/assets/{id}/thumbnails/{index}"].get
 *                  (params `id`, `index`, both `type: string`; the 200 carries
 *                  no JSON schema because it streams bytes)
 *   source       → src/routes/assets.ts:4391 — replies `Content-Type:
 *                  image/jpeg` with the object stream, 404 unknown asset or
 *                  out-of-range index, 501 storage not configured.
 *   This route is BEHIND the same bearer gate, so it is fetched with apiFetch
 *   (which attaches the header) and the bytes are turned into a blob object URL.
 *   An <img> therefore still never points at a token-protected API path — the
 *   issue's second acceptance criterion holds on this path too.
 *
 *   Why keep it: the presigned URL depends on the deployment's object store
 *   answering an anonymous signed GET from the browser's network. That is
 *   verified working on the OSC-managed store as of 2026-09-25 (signed GET 200,
 *   unsigned 403 — see docs/osc-feedback/incoming-presigned-get-thumbnails.md),
 *   but it was NOT true earlier in this project's life (#113), and an external
 *   storage backend can refuse it by policy. Falling back to the proxy bytes
 *   keeps thumbnails rendering in that case instead of showing empty boxes, and
 *   keeps the proxy route's UI consumer alive.
 */

// Only these schemes may reach `img.src`. The value comes from our own API, so
// this is a trust-boundary assertion rather than a fix for a known attack: it
// stops a surprising `javascript:`/`data:` value from ever being assigned, and
// makes "the API hands back a browser-loadable storage URL" an explicit,
// testable expectation rather than an assumption.
function isLoadableUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

function thumbnailPath(assetId, index) {
  return (
    '/assets/' +
    encodeURIComponent(assetId) +
    '/thumbnails/' +
    encodeURIComponent(index)
  );
}

// Fetch the signed URL for one thumbnail. `apiFetch` is injected (public/app.js
// owns the auth headers and the stack header) rather than imported, so this
// module stays free of a cycle with app.js and is drivable from tests.
// Rejects on any non-2xx (apiFetch throws) or on a body without a loadable `url`.
export async function fetchThumbnailUrl(apiFetch, assetId, index) {
  if (typeof apiFetch !== 'function') throw new Error('apiFetch is required');
  const body = await apiFetch(thumbnailPath(assetId, index) + '/url');
  const url = body && typeof body.url === 'string' ? body.url : '';
  if (!url) throw new Error('thumbnail URL response carried no url field');
  if (!isLoadableUrl(url)) {
    throw new Error('thumbnail URL is not an http(s) URL');
  }
  return url;
}

// Fallback: pull the thumbnail BYTES through the authenticated proxy route and
// wrap them in a blob object URL the <img> can load. Used only when the signed
// URL cannot be issued, or when the browser's GET against the signed URL fails.
//
// The object URL must be revoked by the caller once the image has loaded (or
// failed), otherwise the blob is retained for the lifetime of the document.
export async function fetchThumbnailObjectUrl(apiFetch, assetId, index) {
  if (typeof apiFetch !== 'function') throw new Error('apiFetch is required');
  const res = await apiFetch(thumbnailPath(assetId, index), { raw: true });
  if (!res || typeof res.blob !== 'function') {
    throw new Error('thumbnail byte route returned no readable body');
  }
  const blob = await res.blob();
  if (!blob || !blob.size) throw new Error('thumbnail byte route returned no bytes');
  const factory =
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'
      ? URL
      : null;
  if (!factory) throw new Error('object URLs are unavailable in this environment');
  return factory.createObjectURL(blob);
}

// Point an existing <img> at its thumbnail image.
//
// Order of attempts (see the contract block above):
//   1. the short-lived signed URL from the URL-issuing route;
//   2. if that URL cannot be issued, or the browser's GET against it fails,
//      the bytes from the authenticated proxy route as a blob object URL.
//
// Resolves true once an src has been assigned, false when neither source
// produced one. Never throws and never rejects: a thumbnail is decoration, and
// the ops UI must not surface a storage hiccup as a page-level error.
//
// On final failure the src is removed again, so the element falls back to the
// empty box it showed before hydration rather than a broken-image icon (issue
// #801 acceptance criterion). `placeholderClass`, when given, is removed on
// success and (re)applied on failure; `onFailure` lets a caller drop the
// element instead; `onSuccess` fires once, on the first assigned src.
//
// options: { apiFetch, assetId, index, placeholderClass?, onFailure?, onSuccess? }
export async function applyThumbnail(img, options) {
  const o = options || {};
  const placeholderClass = o.placeholderClass || '';
  const onFailure = typeof o.onFailure === 'function' ? o.onFailure : null;
  const onSuccess = typeof o.onSuccess === 'function' ? o.onSuccess : null;

  // Exactly one blob URL can be outstanding per <img>; revoke it as soon as the
  // browser is done with it so the bytes are not pinned for the page's lifetime.
  let objectUrl = '';
  function releaseObjectUrl() {
    if (!objectUrl) return;
    if (typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
      URL.revokeObjectURL(objectUrl);
    }
    objectUrl = '';
  }

  // Which source is currently on the element. Both the awaited path and the
  // <img> error event drive the same transition, so the stage — not the event —
  // decides what happens next, and the proxy is never attempted twice.
  let stage = 'signed'; // 'signed' → 'proxy' → 'done'

  function fail() {
    stage = 'done';
    releaseObjectUrl();
    img.removeAttribute('src');
    if (placeholderClass) img.classList.add(placeholderClass);
    if (onFailure) onFailure();
    return false;
  }

  function assign(url) {
    if (placeholderClass) img.classList.remove(placeholderClass);
    img.src = url;
    if (onSuccess) onSuccess();
    return true;
  }

  // A signature can expire, or object storage can refuse the signed GET, after
  // the URL was issued — that surfaces as an <img> error event, not as a
  // rejected fetch, so it needs its own handler. The signed URL failing that way
  // retries through the proxy bytes; a failure of THAT is final.
  img.addEventListener('error', function () {
    if (stage === 'signed') {
      void applyProxyBytes();
      return;
    }
    if (stage === 'proxy') fail();
  });
  // Harmless while the element is showing a signed URL (no blob outstanding).
  img.addEventListener('load', releaseObjectUrl);

  async function applyProxyBytes() {
    stage = 'proxy';
    try {
      objectUrl = await fetchThumbnailObjectUrl(o.apiFetch, o.assetId, o.index);
    } catch (_) {
      return fail();
    }
    return assign(objectUrl);
  }

  let url;
  try {
    url = await fetchThumbnailUrl(o.apiFetch, o.assetId, o.index);
  } catch (_) {
    // No signed URL at all (404/501/502, or a deployment that cannot presign):
    // go straight to the proxy bytes.
    return applyProxyBytes();
  }

  return assign(url);
}
