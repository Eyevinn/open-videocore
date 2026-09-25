/**
 * open-videocore ops dashboard — media-src.js
 *
 * Issue #802 (under parent #785): the shared "fetch a presigned URL, then assign
 * it" helper for INLINE MEDIA elements — `<img>`, `<video>` and `<source>`.
 *
 * WHY THIS EXISTS
 *   Every media-serving route on the assets router sits behind the router's
 *   bearer gate (`authGate`, src/routes/assets.ts:1573). A browser fetches an
 *   inline element's own URL — `img.src`, `video.src`, `<source src>` — as a
 *   plain GET with no `Authorization` header, and `apiFetch` (public/app.js) can
 *   only attach one to fetch() calls it makes itself. So an inline media element
 *   pointed at an API media path is ALWAYS refused (401), no matter how healthy
 *   the underlying object is (#785).
 *
 *   The fix, established for thumbnails in #800/#801, is a two-step: ask the API
 *   over the authenticated apiFetch for a short-lived SIGNED URL (a JSON call,
 *   which apiFetch handles normally), then assign THAT to the element. The
 *   browser's follow-up GET then carries its credential in the URL itself and
 *   never touches a token-protected path.
 *
 *   This module is that step, generalized: it knows nothing about thumbnails and
 *   nothing about which route issued the URL. Any current or future inline media
 *   element goes through it (see CONTRIBUTING.md → "Inline media elements").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetch the contract before the call)
 *
 * This module issues no hardcoded path of its own: the caller passes the
 * URL-issuing route's path and says which response field carries the loadable
 * URL. The three URL-issuing contracts on the assets router today, all verified
 * against `openapi.json` and the route source, are:
 *
 *   1. GET /api/v1/assets/{id}/thumbnails/{index}/url        (issue #800)
 *      openapi.json → .paths["/api/v1/assets/{id}/thumbnails/{index}/url"].get
 *      source       → src/routes/assets.ts:4635 (route), :621 (`thumbnailUrlSchema`)
 *      200 body (all six required, additionalProperties false):
 *        { assetId, index, objectKey, url, expiresAt, expiresInSeconds }
 *      → loadable URL field: `url`  (this module's default)
 *      documented failures: 404 unknown asset / out-of-range index,
 *        501 object storage not configured, 502 storage failed to sign.
 *
 *   2. GET /api/v1/assets/{id}/delivery                      (issues #14/#810)
 *      openapi.json → .paths["/api/v1/assets/{id}/delivery"].get
 *      source       → src/routes/assets.ts:3053 (route), :558 (`deliverySchema`),
 *                     :520 (`deliveryUrlsSchema`)
 *      200 body: { assetId, status: 'ready'|'not_configured'|'failed',
 *                  urls: { hls?, dash?, source? }, resolution?, expiresAt }
 *      → loadable URL field for a `<video>`/`<source>`: `urls.source` — the
 *        presigned GET on the stored source object (src/routes/assets.ts:3256).
 *        NOTE `urls.hls` / `urls.dash` are NOT usable here under
 *        DELIVERY_MODE=proxy: they are `/api/v1/assets/:id/stream/*` paths
 *        behind the same bearer gate, and signing the manifest would not help
 *        because the player resolves each child segment against the same gated
 *        prefix (ADR-003 §2). See `isLoadableMediaUrl` below, which refuses
 *        them, and docs/osc-feedback/incoming-presigned-playback-segments.md.
 *
 *   3. GET /api/v1/assets/{id}/files                          (issue #119)
 *      openapi.json → .paths["/api/v1/assets/{id}/files"].get
 *      source       → src/routes/assets.ts:3460 (route), :573 (`assetFileSchema`)
 *      200 body: { files: [{ id, type, name, format, objectKey, url, ... }],
 *                  fileGroups: [...] }
 *      → each `files[].url` is already a presigned GET (src/routes/assets.ts:3505),
 *        so a per-file `<video>`/`<source>` passes the entry's own `url`
 *        through `assignMediaSrc` directly — no second round trip.
 *
 * Adding a fourth? Cite its schema symbol the same way and pass its field name;
 * do not add a route-specific function here.
 */

// ─── Loadability ──────────────────────────────────────────────────────────────

// Only an absolute http(s) URL may reach a media element's `src`.
//
// Two jobs, both deliberate:
//   1. Trust boundary. The value comes from our own API, so this is an assertion
//      rather than a fix for a known attack: it stops a surprising
//      `javascript:`/`data:` value from ever being assigned.
//   2. It rejects the exact mistake this issue exists to prevent — a RELATIVE
//      API path such as `/api/v1/assets/<id>/thumbnails/0` or
//      `/api/v1/assets/<id>/stream/index.m3u8`. Those are the token-protected
//      paths an inline element cannot authenticate against, and a URL-issuing
//      route that returned one would be silently unusable. Failing loudly here
//      turns that into a visible, testable failure instead of a broken element.
export function isLoadableMediaUrl(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url);
}

// Read a loadable URL out of a JSON body by field path, e.g. `'url'`
// (thumbnailUrlSchema) or `'urls.source'` (deliverySchema). Dotted traversal
// only — no array indexing — because every URL-issuing contract above exposes
// its URL at a fixed object path. Returns '' when the path is absent or is not
// a string, which the callers treat as "no URL was issued".
export function readMediaUrl(body, field) {
  const path = typeof field === 'string' && field ? field.split('.') : ['url'];
  let cursor = body;
  for (const key of path) {
    if (!cursor || typeof cursor !== 'object') return '';
    cursor = cursor[key];
  }
  return typeof cursor === 'string' ? cursor : '';
}

// ─── Assignment ───────────────────────────────────────────────────────────────

// Assign an already-resolved URL to an inline media element.
//
// `<source>` is the reason this is a function rather than one line at each call
// site: a `<source>` does not fetch anything by itself. Its parent `<video>` /
// `<audio>` picked its resource when it first ran the resource-selection
// algorithm, so a `src` set on a child AFTER that point is ignored until the
// parent is told to re-select with `load()`. Setting `video.src` or `img.src`
// directly needs no such nudge — the element re-selects on its own.
//
// Returns true when an src was assigned, false when the URL is not loadable
// (the element is left untouched in that case).
export function assignMediaSrc(el, url) {
  if (!el || !isLoadableMediaUrl(url)) return false;
  el.src = url;
  const parent = el.tagName === 'SOURCE' ? el.parentElement : null;
  if (parent && typeof parent.load === 'function') {
    parent.load();
  }
  return true;
}

// ─── The pattern ──────────────────────────────────────────────────────────────

/**
 * Point an inline media element at a presigned URL obtained from the API.
 *
 * Sequence (the pattern this module exists to make reusable):
 *   1. `apiFetch(urlPath)` — an authenticated JSON call to a URL-ISSUING route.
 *   2. read the loadable URL out of the response at `urlField`.
 *   3. assign it to the element (re-selecting the parent for a `<source>`).
 *
 * Resolves true once an src is assigned, false when no loadable URL could be
 * obtained or the browser failed to load the one that was. NEVER throws and
 * never rejects: inline media is decoration on an ops screen, and a storage
 * hiccup must not surface as a page-level error. On failure the src is removed
 * again so the element falls back to its empty/placeholder state rather than a
 * broken-media icon.
 *
 * NO BYTE-PROXY FALLBACK, deliberately. The thumbnail helper can fall back to
 * pulling bytes through the authenticated proxy route and wrapping them in a
 * blob URL, because a thumbnail is one small whole image. That does not
 * generalize to `<video>`: a blob URL holds the entire object in memory and
 * serves no HTTP range requests, so seeking and progressive playback are gone
 * and a large source would have to download in full before the first frame. For
 * media the presigned URL is the only viable path, which is why a deployment
 * that cannot presign must degrade to "no inline playback" rather than to a
 * worse playback experience.
 *
 * @param {Element} el          an `<img>`, `<video>`, `<audio>` or `<source>`
 * @param {object}  options
 * @param {Function} options.apiFetch      injected from public/app.js (it owns
 *                                         the auth + stack headers); injected
 *                                         rather than imported so this module
 *                                         has no cycle with app.js and is
 *                                         drivable from tests.
 * @param {string}  options.urlPath        path of the URL-issuing route,
 *                                         relative to the API base, e.g.
 *                                         `/assets/<id>/thumbnails/0/url`.
 * @param {string} [options.urlField]      dotted field carrying the loadable
 *                                         URL. Default `'url'`.
 * @param {string} [options.placeholderClass] removed on success, (re)applied on
 *                                         failure.
 * @param {Function} [options.onSuccess]   called once, after the src is assigned.
 * @param {Function} [options.onFailure]   called once, when no src could be
 *                                         assigned (e.g. to drop the element).
 * @returns {Promise<boolean>}
 */
export async function applyPresignedMediaSrc(el, options) {
  const o = options || {};
  const placeholderClass = o.placeholderClass || '';
  const onSuccess = typeof o.onSuccess === 'function' ? o.onSuccess : null;
  const onFailure = typeof o.onFailure === 'function' ? o.onFailure : null;
  // Each callback fires at most once. A failure can arrive AFTER a success (a
  // signature that expires while the element is showing it), so these are two
  // independent one-shot latches rather than one "settled" flag — the element
  // must still be cleaned back to its placeholder in that case.
  let notifiedSuccess = false;
  let notifiedFailure = false;

  if (!el) return false;

  function fail() {
    if (notifiedFailure) return false;
    notifiedFailure = true;
    el.removeAttribute('src');
    if (placeholderClass && el.classList) el.classList.add(placeholderClass);
    if (onFailure) onFailure();
    return false;
  }

  function succeed() {
    if (notifiedSuccess) return true;
    notifiedSuccess = true;
    if (placeholderClass && el.classList) el.classList.remove(placeholderClass);
    if (onSuccess) onSuccess();
    return true;
  }

  // A signature can expire, or object storage can refuse the signed GET, after
  // the URL was issued — that surfaces as the element's `error` event, not as a
  // rejected fetch, so it needs its own handler. Registered before any src is
  // assigned so an immediate failure is not missed. `<source>` reports its own
  // failure on itself (the parent `<video>` only reports when every candidate
  // source failed), so listening on the element passed in is correct for both.
  el.addEventListener('error', function () {
    fail();
  });

  if (typeof o.apiFetch !== 'function') return fail();

  let body;
  try {
    body = await o.apiFetch(o.urlPath);
  } catch (_) {
    // 404 / 501 / 502 (or a deployment that cannot presign at all) — apiFetch
    // turns each into a thrown Error. There is nothing else to try; see the
    // "no byte-proxy fallback" note above.
    return fail();
  }

  const url = readMediaUrl(body, o.urlField);
  if (!isLoadableMediaUrl(url)) return fail();
  if (!assignMediaSrc(el, url)) return fail();
  return succeed();
}
