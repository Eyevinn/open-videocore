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
 *                     (the generated spec declares no operationId on any path,
 *                      so path item + method is the identifier)
 *      source       → src/routes/assets.ts:3053 (route), :558 (`deliverySchema`),
 *                     :520 (`deliveryUrlsSchema`)
 *      200 body: { assetId, status: 'ready'|'not_configured'|'failed',
 *                  urls: { hls?, dash?, source? }, resolution?, expiresAt }
 *      → loadable URL field for a `<video>`/`<source>`: `urls.source` — the
 *        presigned GET on the stored source object (src/routes/assets.ts:3256).
 *
 *      IMPORTANT: `urls.source` and `urls.hls`/`urls.dash` ARE MUTUALLY EXCLUSIVE.
 *        Every key of `deliveryUrlsSchema` is optional (:520-524) and the
 *        handler takes exactly ONE branch per asset:
 *          - asset HAS packaged output (`asset.manifestUrls.hls || .dash`):
 *            the packaged branch (:3085) early-returns `urls: { hls?, dash? }`
 *            on every one of its paths. `source` is NEVER emitted, and the
 *            source fallback is unreachable for that asset.
 *          - packaged output exists but public delivery is not configured:
 *            `status: 'not_configured'` with `urls: {}` and `resolution`
 *            instead (`notConfiguredDelivery`, :1360). No URL key at all.
 *          - asset has NO packaged output, only a stored source object
 *            (:3242): `urls: { source }`, with `status: 'failed'` rather than
 *            `'ready'` when the asset's own lifecycle failed (#810).
 *          - neither packaged output nor source object: 404 `no_delivery`
 *            (:3264), which `apiFetch` throws.
 *        documented failures: 404 unknown asset / `no_delivery` (:3264),
 *          501 `not_configured` when the asset HAS packaged output but
 *          `PACKAGED_PUBLIC_BASE_URL` is set to something that is not an
 *          absolute URL — the packaged branch throws
 *          `PublicManifestBaseUrlError` (src/pipeline/packaging.ts:346) and the
 *          route converts it to a 501 with no `urls` at all (:3215-3218).
 *          Both are thrown by `apiFetch`, so a caller needs its own catch
 *          (CONTRIBUTING.md → "Inline media elements" has the full table).
 *        So `urlField: 'urls.source'` resolves falsy for EVERY packaged asset,
 *        and this helper then returns false having assigned nothing. A caller
 *        must branch on WHICH key is present (or on `status`) rather than
 *        assume `urls.source` is always there:
 *          - `urls.source` present → pass it through this module.
 *          - `urls.hls`/`urls.dash` present → not inline-playable under
 *            DELIVERY_MODE=proxy (next paragraph). To preview such an asset
 *            inline, read its source object from contract 3 below
 *            (`files[]` entry with `type: 'source'`, whose `url` is already a
 *            presigned GET and is emitted whether or not the asset is
 *            packaged). Otherwise degrade to a "no inline playback" state.
 *          - `urls: {}` (`not_configured`) → "no inline playback".
 *        NOTE `urls.hls` / `urls.dash` are NOT usable here under
 *        DELIVERY_MODE=proxy: they are `/api/v1/assets/:id/stream/*` paths
 *        behind the same bearer gate, and signing the manifest would not help
 *        because the player resolves each child segment against the same gated
 *        prefix (ADR-003 §2), so there is nothing this module could do with one
 *        — see docs/osc-feedback/incoming-presigned-playback-segments.md.
 *        `isLoadableMediaUrl` refuses that specific gated prefix as a BACKSTOP
 *        (`isBearerGatedStreamUrl` below), so handing one to this module fails
 *        loudly and locally instead of 401-ing in the element. That backstop
 *        recognizes a path SHAPE, not authorization in general: it is not a
 *        substitute for the caller branching on WHICH key came back, which is
 *        still the caller's job (CONTRIBUTING.md → "Inline media elements").
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

// A `/assets/<id>/stream/...` path: the ONE bearer-gated route our own API can
// hand back as an ABSOLUTE, otherwise perfectly loadable-looking URL.
//
// CONTRACT (CLAUDE.md rule 7):
//   openapi.json → .paths["/api/v1/assets/{id}/stream/{*}"].get   (200 only)
//   source       → src/routes/assets.ts:3287 (`'/:id/stream/*'`), behind the
//                  router-wide bearer gate `authGate` (:1573)
// Under DELIVERY_MODE=proxy the delivery route advertises exactly this shape in
// `urls.hls`/`urls.dash`: `proxyManifestUrlsFor` (src/pipeline/packaging.ts:269)
// appends `<id>/stream/index.m3u8` (`proxyStreamPrefix`, :260) to
// `assetsBaseUrl(request.url)`, and that branch early-returns
// `notConfiguredDelivery` unless the base is absolute (src/routes/assets.ts:3151)
// — so the manifest URLs a caller can actually receive are absolute and pass an
// `^https?://` test like any presigned storage URL. Matching the path shape is
// the only way to tell them apart client-side.
//
// Matched on the PATH ONLY (query/fragment stripped by the URL parse), and
// anchored on a whole `assets/<one segment>/stream` run so a query parameter or
// a signature that merely mentions the words cannot trip it. No presigned
// storage URL we issue collides: our object keys live under `packaged/`,
// `sources/`, `ingest/`, `thumbnails/` and `subtitles/` prefixes
// (`outputPrefix`, src/pipeline/packaging.ts:63; src/routes/assets.ts:2489, :4876).
const GATED_STREAM_PATH = /(?:^|\/)assets\/[^/]+\/stream(?:\/|$)/i;

export function isBearerGatedStreamUrl(url) {
  if (typeof url !== 'string' || url === '') return false;
  let path;
  try {
    // A base is supplied so a relative path is classified too; it is never
    // fetched and never leaves this function.
    path = new URL(url, 'https://relative.invalid').pathname;
  } catch (_) {
    path = url.split('?')[0].split('#')[0];
  }
  return GATED_STREAM_PATH.test(path);
}

// Only an absolute http(s) URL that is not itself a token-protected API path may
// reach a media element's `src`.
//
// Three jobs, all deliberate:
//   1. Trust boundary. The value comes from our own API, so this is an assertion
//      rather than a fix for a known attack: it stops a surprising
//      `javascript:`/`data:` value from ever being assigned.
//   2. It rejects the exact mistake this issue exists to prevent — a RELATIVE
//      API path such as `/api/v1/assets/<id>/thumbnails/0` or
//      `/api/v1/assets/<id>/stream/index.m3u8`. Those are the token-protected
//      paths an inline element cannot authenticate against, and a URL-issuing
//      route that returned one would be silently unusable. Failing loudly here
//      turns that into a visible, testable failure instead of a broken element.
//   3. It rejects the ABSOLUTE form of the gated stream prefix too. Absoluteness
//      alone does not make a URL loadable by an unauthenticated element: under
//      DELIVERY_MODE=proxy `urls.hls`/`urls.dash` are absolute URLs on a gated
//      path (see `isBearerGatedStreamUrl`), and assigning one 401s in the
//      element — the #785/#802 failure this module exists to prevent. This is a
//      backstop for a known-emittable URL shape, NOT a general authorization
//      check: a caller must still branch on which delivery key it received.
export function isLoadableMediaUrl(url) {
  if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return false;
  return !isBearerGatedStreamUrl(url);
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
  reselectParent(el);
  return true;
}

// Tell a `<source>`'s parent to re-run the resource-selection algorithm. Shared
// by assignment and clearing: BOTH directions need it, for the same reason. A
// `<source>` never loads or unloads anything itself — the parent `<video>` /
// `<audio>` holds the selected resource, so a child's `src` changing (to a new
// URL, or to nothing) is invisible to the parent until `load()` re-selects.
// No-op for any element that is not a `<source>` inside a media parent.
function reselectParent(el) {
  const parent = el && el.tagName === 'SOURCE' ? el.parentElement : null;
  if (parent && typeof parent.load === 'function') parent.load();
}

// Undo `assignMediaSrc`: drop the element's src and, for a `<source>`, make the
// parent let go of the dead resource too.
//
// Removing the attribute alone is not enough for a `<source>` (the bug this
// exists to fix): the parent `<video>` has already SELECTED that resource, and
// clearing the child it selected from does not deselect it. Without the
// `load()` the parent stays bound to a URL that just failed — it keeps showing
// the broken/stalled resource, and any later re-selection can still resolve to
// it. `load()` makes the parent re-run selection over the now-empty candidate
// list and return to its empty state, which is what the failure path promises.
export function clearMediaSrc(el) {
  if (!el) return false;
  if (typeof el.removeAttribute === 'function') el.removeAttribute('src');
  reselectParent(el);
  return true;
}

// The URL this element is CURRENTLY pointed at, as the literal string that was
// assigned. Read from the content attribute rather than the `src` IDL property
// because the property resolves against the document base and can come back
// normalized (percent-encoding, default port), which would break the identity
// comparison in `applyPresignedMediaSrc`'s staleness check.
function currentMediaSrc(el) {
  if (el && typeof el.getAttribute === 'function') return el.getAttribute('src') || '';
  return el && typeof el.src === 'string' ? el.src : '';
}

// Where an element's current `applyPresignedMediaSrc` invocation parks its
// identity + error listener, so the NEXT invocation on the same element can
// find and retire it. A single property (not a listener registry) because only
// one invocation may own an element at a time — the later one always wins.
const OWNER_KEY = '__openVideocoreMediaSrcOwner';

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
 * SAFE ON A REUSED ELEMENT. Calling this again on an element that is already
 * showing (or still resolving) an earlier presigned URL is well defined: the
 * LAST call wins, the previous call's error listener is removed rather than
 * left to accumulate, and a superseded call can no longer clear the src or fire
 * its `onFailure` — its teardown is scoped to the URL it assigned itself. So a
 * re-rendered row or a re-populated thumbnail strip cannot blank out an element
 * a newer, healthy call just filled in.
 *
 * ONE KNOWN EDGE, bounded and deliberate: an `error` belonging to the PREVIOUS
 * invocation's resource that arrives while this invocation's `apiFetch` is still
 * in flight is attributed to this invocation (it owns the only live listener and
 * has assigned nothing yet, so neither staleness guard in `fail()` applies), and
 * aborts it. The element then lands in the documented empty/placeholder state —
 * never a stale or wrong asset — no listener leaks, and the next call on the
 * element works normally, so this is strictly better than showing the resource
 * that just failed. Closing it needs the predecessor's URL to be recorded at
 * takeover and `error`-sourced failures distinguished from fetch-sourced ones.
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

  // Elements are REUSED — a re-rendered asset row, a thumbnail strip populated
  // a second time, a `<video>` repointed at a different asset — so an element
  // can be handed to this function again while an earlier invocation on it is
  // still in flight or still listening. `token` is this invocation's identity
  // (object identity, so it cannot collide) and is parked on the element; the
  // element belongs to whichever invocation parked its token LAST.
  const token = {};

  // Is this invocation still the one that owns the element? False once a later
  // invocation has taken over — at which point everything this one does to the
  // element would be interference with a newer, healthier assignment.
  function isCurrent() {
    const owner = el[OWNER_KEY];
    return Boolean(owner) && owner.token === token;
  }

  // Stop listening and hand ownership back, so a failed/finished invocation
  // leaves no listener behind on a reused element.
  function release() {
    if (!isCurrent()) return;
    if (typeof el.removeEventListener === 'function') {
      el.removeEventListener('error', onError);
    }
    el[OWNER_KEY] = null;
  }

  // The URL THIS invocation assigned ('' until it assigns one). It scopes the
  // failure path: an invocation may only tear down the src it put there itself.
  let assignedUrl = '';

  function fail() {
    if (notifiedFailure) return false;
    // Two staleness guards, both required, covering the two windows in which a
    // later invocation can overtake this one:
    //
    //   1. Before this invocation assigned anything. Its `apiFetch` is still in
    //      flight; a newer invocation has already resolved and assigned a good
    //      URL. Ownership has moved, so this one must fail SILENTLY — no
    //      `removeAttribute`, no `onFailure` — or it would strip the healthy
    //      src the newer invocation just set and report a failure for an
    //      element that is working.
    //   2. After it assigned. The element is no longer pointed at this
    //      invocation's URL (something else, including a newer invocation via
    //      `assignMediaSrc`, has repointed it), so the resource that failed is
    //      not the one on screen and is not ours to clear.
    //
    // Either way this is not an error the caller can act on, so the one-shot
    // failure latch is deliberately NOT set: if this invocation ever does
    // regain relevance, a real failure can still be reported.
    if (!isCurrent()) return false;
    if (assignedUrl && currentMediaSrc(el) !== assignedUrl) return false;
    notifiedFailure = true;
    release();
    // Clearing a `<source>` also re-selects its parent — see `clearMediaSrc`.
    clearMediaSrc(el);
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
  function onError() {
    fail();
  }

  // Retire the previous invocation's listener BEFORE registering ours.
  // Otherwise handlers accumulate on every reuse of the element (an unbounded
  // leak on a list that re-renders), and one `error` event would run every
  // stale invocation's `fail()` as well as this one's.
  const previousOwner = el[OWNER_KEY];
  if (previousOwner && typeof el.removeEventListener === 'function') {
    el.removeEventListener('error', previousOwner.onError);
  }
  el[OWNER_KEY] = { token, onError };
  if (typeof el.addEventListener === 'function') {
    el.addEventListener('error', onError);
  }

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

  // Overtaken while the fetch was in flight: a newer invocation owns the
  // element and has assigned (or is about to assign) its own URL. Assigning
  // this older, already-superseded URL now would win the race by arriving last
  // and leave the element showing the wrong asset. Drop out silently — the
  // newer invocation reports its own outcome.
  if (!isCurrent()) return false;

  const url = readMediaUrl(body, o.urlField);
  // `urlField` resolved to nothing. For `urls.source` on a PACKAGED asset this
  // is the expected, documented outcome rather than a fault — see contract 2 in
  // the module header (packaged and source URLs are mutually exclusive).
  if (!isLoadableMediaUrl(url)) return fail();
  if (!assignMediaSrc(el, url)) return fail();
  // Recorded only now, so `fail()` before this point stays in its "assigned
  // nothing yet" mode and is scoped by ownership alone.
  assignedUrl = url;
  return succeed();
}
