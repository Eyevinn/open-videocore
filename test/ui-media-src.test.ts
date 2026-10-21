// @vitest-environment happy-dom
//
// Unit tests for public/media-src.js — the shared presigned-URL fetch-then-assign
// helper for INLINE MEDIA elements (issue #802, under parent #785).
//
// Why the helper exists: every media-serving route on the assets router is behind
// the router's bearer gate (`authGate`, src/routes/assets.ts:1573), and a browser
// fetches an inline element's own URL (`img.src`, `video.src`, `<source src>`) as
// a plain GET with no Authorization header. So an inline element pointed at an
// API media path is always refused. The UI must fetch a SIGNED URL over the
// authenticated apiFetch first and assign THAT.
//
// Verified contracts (CLAUDE.md rule 7) — the helper is route-agnostic, so these
// are the shapes the tests drive it with:
//   - GET /api/v1/assets/{id}/thumbnails/{index}/url (issue #800)
//     openapi.json .paths["/api/v1/assets/{id}/thumbnails/{index}/url"].get;
//     src/routes/assets.ts:4635 (route), :621 (`thumbnailUrlSchema`).
//     200 body, all six fields required: { assetId, index, objectKey, url,
//     expiresAt, expiresInSeconds }. Loadable URL field: `url`.
//     Failures 404 / 501 / 502 — apiFetch turns each into a thrown Error.
//   - GET /api/v1/assets/{id}/delivery (issues #14/#810)
//     openapi.json .paths["/api/v1/assets/{id}/delivery"].get;
//     src/routes/assets.ts:3053 (route), :558 (`deliverySchema`), :520
//     (`deliveryUrlsSchema`). 200 body: { assetId, status, urls: { hls?, dash?,
//     source? }, resolution?, expiresAt }. Loadable URL field for a
//     `<video>`/`<source>`: `urls.source` — the presigned GET on the stored
//     source object (src/routes/assets.ts:3256).
//   - GET /api/v1/assets/{id}/stream/{*} (issue #201) — the shape the helper's
//     backstop must REFUSE, not consume.
//     openapi.json .paths["/api/v1/assets/{id}/stream/{*}"].get → 200 only;
//     src/routes/assets.ts:3287 (`'/:id/stream/*'`), behind the router-wide
//     bearer gate `authGate` (:1573). Under DELIVERY_MODE=proxy this is exactly
//     what `urls.hls`/`urls.dash` point at, as an ABSOLUTE URL
//     (`proxyManifestUrlsFor`, src/pipeline/packaging.ts:269, over a base the
//     route has already checked is absolute, src/routes/assets.ts:3151).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyPresignedMediaSrc,
  assignMediaSrc,
  clearMediaSrc,
  isBearerGatedStreamUrl,
  isLoadableMediaUrl,
  readMediaUrl,
} from '../public/media-src.js';

const SIGNED_IMAGE = 'https://storage.example/thumbnails/a1/thumb_0s.jpg?sig=abc';
const SIGNED_VIDEO = 'https://storage.example/source/a1/original.mp4?sig=def';

// A 200 body matching `thumbnailUrlSchema` (all six fields present).
const thumbnailUrlBody = {
  assetId: 'a1',
  index: 0,
  objectKey: 'thumbnails/a1/thumb_0s.jpg',
  url: SIGNED_IMAGE,
  expiresAt: '2026-01-01T00:05:00Z',
  expiresInSeconds: 300,
};

// A 200 body matching `deliverySchema` on the source-only path.
const deliveryBody = {
  assetId: 'a1',
  status: 'ready',
  urls: { source: SIGNED_VIDEO },
  expiresAt: '2026-01-01T01:00:00Z',
};

// Let the awaited apiFetch inside applyPresignedMediaSrc settle.
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe('isLoadableMediaUrl', () => {
  it('accepts only absolute http(s) URLs', () => {
    expect(isLoadableMediaUrl(SIGNED_IMAGE)).toBe(true);
    expect(isLoadableMediaUrl('http://storage.example/a.mp4')).toBe(true);
    expect(isLoadableMediaUrl('')).toBe(false);
    expect(isLoadableMediaUrl(undefined)).toBe(false);
  });

  it('refuses the token-protected API paths this pattern exists to avoid', () => {
    // The two paths an inline element can never authenticate against.
    expect(isLoadableMediaUrl('/api/v1/assets/a1/thumbnails/0')).toBe(false);
    expect(isLoadableMediaUrl('/api/v1/assets/a1/stream/index.m3u8')).toBe(false);
  });

  it('refuses script-bearing and inline-data schemes', () => {
    expect(isLoadableMediaUrl('javascript:alert(1)')).toBe(false);
    expect(isLoadableMediaUrl('data:image/png;base64,AAAA')).toBe(false);
  });
});

describe('isBearerGatedStreamUrl', () => {
  // The relative gated path above is already refused by the `^https?://` scheme
  // check, so it does not exercise this backstop at all. The form that DOES need
  // it is the ABSOLUTE one, which is the only form a caller can actually receive:
  // under DELIVERY_MODE=proxy the delivery route early-returns
  // `notConfiguredDelivery` unless the proxy base is absolute
  // (src/routes/assets.ts:3151), and `proxyManifestUrlsFor`
  // (src/pipeline/packaging.ts:269) appends `<id>/stream/index.m3u8`
  // (`proxyStreamPrefix`, :259) to that absolute base. The resulting URL is the
  // bearer-gated `'/:id/stream/*'` route (src/routes/assets.ts:3287, behind the
  // router-wide `authGate` at :1573; openapi.json
  // → .paths["/api/v1/assets/{id}/stream/{*}"].get, 200 only), which an inline
  // element can never authenticate against — the #785/#802 failure itself.
  it('refuses the ABSOLUTE gated stream URLs the delivery route can emit', () => {
    const proxyHls = 'https://api.example/api/v1/assets/a1/stream/index.m3u8';
    const proxyDash = 'https://api.example/api/v1/assets/a1/stream/manifest.mpd';

    expect(isBearerGatedStreamUrl(proxyHls)).toBe(true);
    expect(isBearerGatedStreamUrl(proxyDash)).toBe(true);
    // ...and therefore never loadable, despite passing every other check.
    expect(/^https?:\/\//i.test(proxyHls)).toBe(true);
    expect(isLoadableMediaUrl(proxyHls)).toBe(false);
    expect(isLoadableMediaUrl(proxyDash)).toBe(false);

    // The bare prefix (trailing-segment anchor) and a differently-cased origin.
    expect(isLoadableMediaUrl('https://api.example/api/v1/assets/a1/stream')).toBe(false);
    expect(isLoadableMediaUrl('https://API.EXAMPLE/API/V1/ASSETS/a1/STREAM/index.m3u8')).toBe(
      false
    );
  });

  it('does not over-match the presigned storage URLs the pattern depends on', () => {
    // Anchoring pin: if the guard is ever widened, these must keep passing.
    // Object keys we mint live under `packaged/` (`outputPrefix`,
    // src/pipeline/packaging.ts:63), `sources/`, `ingest/`, `thumbnails/` and
    // `subtitles/` — none can produce an `assets/<one segment>/stream` run.
    expect(isLoadableMediaUrl('https://storage.example/packaged/a1/index.m3u8?sig=x')).toBe(true);
    expect(isLoadableMediaUrl(SIGNED_VIDEO)).toBe(true);
    expect(isLoadableMediaUrl(SIGNED_IMAGE)).toBe(true);
    // Matched on the PATH only: a query value that merely mentions the gated
    // shape (a signature, a redirect hint) must not trip it.
    expect(
      isLoadableMediaUrl(
        'https://storage.example/packaged/a1/index.m3u8?next=/assets/a1/stream/index.m3u8'
      )
    ).toBe(true);
    // The anchor does not eat a longer path segment.
    expect(isLoadableMediaUrl('https://api.example/api/v1/assets/a1/streaming/x.mp4')).toBe(true);
    expect(isBearerGatedStreamUrl('')).toBe(false);
    expect(isBearerGatedStreamUrl(undefined)).toBe(false);
  });
});

describe('readMediaUrl', () => {
  it('reads the flat `url` field of thumbnailUrlSchema by default', () => {
    expect(readMediaUrl(thumbnailUrlBody, undefined)).toBe(SIGNED_IMAGE);
    expect(readMediaUrl(thumbnailUrlBody, 'url')).toBe(SIGNED_IMAGE);
  });

  it('reads the nested `urls.source` field of deliverySchema', () => {
    expect(readMediaUrl(deliveryBody, 'urls.source')).toBe(SIGNED_VIDEO);
  });

  it('returns an empty string for an absent path or a non-string value', () => {
    expect(readMediaUrl(deliveryBody, 'urls.hls')).toBe('');
    expect(readMediaUrl({ url: 42 }, 'url')).toBe('');
    expect(readMediaUrl(null, 'url')).toBe('');
  });
});

describe('assignMediaSrc', () => {
  it('assigns to an <img> without touching anything else', () => {
    const img = document.createElement('img');
    expect(assignMediaSrc(img, SIGNED_IMAGE)).toBe(true);
    expect(img.getAttribute('src')).toBe(SIGNED_IMAGE);
  });

  it('assigns to a <video> directly', () => {
    const video = document.createElement('video');
    expect(assignMediaSrc(video, SIGNED_VIDEO)).toBe(true);
    expect(video.getAttribute('src')).toBe(SIGNED_VIDEO);
  });

  it('re-selects the parent after assigning to a <source>', () => {
    // A <source> fetches nothing by itself: the parent picked its resource when
    // it first ran resource selection, so a src set on the child afterwards is
    // ignored until the parent is told to load() again.
    const video = document.createElement('video');
    const load = vi.fn();
    (video as unknown as { load: unknown }).load = load;
    const source = document.createElement('source');
    video.appendChild(source);

    expect(assignMediaSrc(source, SIGNED_VIDEO)).toBe(true);
    expect(source.getAttribute('src')).toBe(SIGNED_VIDEO);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('leaves the element untouched for a URL that is not loadable', () => {
    const video = document.createElement('video');
    expect(assignMediaSrc(video, '/api/v1/assets/a1/stream/index.m3u8')).toBe(false);
    expect(video.hasAttribute('src')).toBe(false);
    // ...including the absolute form of the same gated route.
    expect(assignMediaSrc(video, 'https://api.example/api/v1/assets/a1/stream/index.m3u8')).toBe(
      false
    );
    expect(video.hasAttribute('src')).toBe(false);
  });
});

describe('clearMediaSrc', () => {
  it('drops the src of a plain element', () => {
    const img = document.createElement('img');
    img.setAttribute('src', SIGNED_IMAGE);
    expect(clearMediaSrc(img)).toBe(true);
    expect(img.hasAttribute('src')).toBe(false);
  });

  it('re-selects the parent after clearing a <source>', () => {
    // The clearing direction of the same asymmetry `assignMediaSrc` handles.
    const video = document.createElement('video');
    const load = vi.fn();
    (video as unknown as { load: unknown }).load = load;
    const source = document.createElement('source');
    source.setAttribute('src', SIGNED_VIDEO);
    video.appendChild(source);

    expect(clearMediaSrc(source)).toBe(true);
    expect(source.hasAttribute('src')).toBe(false);
    expect(load).toHaveBeenCalledTimes(1);
  });
});

describe('applyPresignedMediaSrc', () => {
  let apiFetch: ReturnType<typeof vi.fn>;
  let calls: string[];

  beforeEach(() => {
    calls = [];
    apiFetch = vi.fn(async (path: string) => {
      calls.push(path);
      return path.endsWith('/delivery') ? deliveryBody : thumbnailUrlBody;
    });
  });

  it('fetches the URL-issuing route over apiFetch and assigns the signed url to an <img>', async () => {
    const img = document.createElement('img');
    img.className = 'thumb-xs thumb-placeholder';
    const onSuccess = vi.fn();

    const ok = await applyPresignedMediaSrc(img, {
      apiFetch,
      urlPath: '/assets/a1/thumbnails/0/url',
      placeholderClass: 'thumb-placeholder',
      onSuccess,
    });

    expect(ok).toBe(true);
    expect(calls).toEqual(['/assets/a1/thumbnails/0/url']);
    expect(img.getAttribute('src')).toBe(SIGNED_IMAGE);
    expect(img.classList.contains('thumb-placeholder')).toBe(false);
    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('assigns a delivery `urls.source` to a <video> via urlField', async () => {
    const video = document.createElement('video');

    const ok = await applyPresignedMediaSrc(video, {
      apiFetch,
      urlPath: '/assets/a1/delivery',
      urlField: 'urls.source',
    });

    expect(ok).toBe(true);
    expect(calls).toEqual(['/assets/a1/delivery']);
    expect(video.getAttribute('src')).toBe(SIGNED_VIDEO);
    // The whole point: the element never points at a gated API path.
    expect(video.getAttribute('src')).not.toContain('/api/v1/');
  });

  it('assigns to a <source> and re-selects its parent <video>', async () => {
    const video = document.createElement('video');
    const load = vi.fn();
    (video as unknown as { load: unknown }).load = load;
    const source = document.createElement('source');
    video.appendChild(source);

    const ok = await applyPresignedMediaSrc(source, {
      apiFetch,
      urlPath: '/assets/a1/delivery',
      urlField: 'urls.source',
    });

    expect(ok).toBe(true);
    expect(source.getAttribute('src')).toBe(SIGNED_VIDEO);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it('never assigns a src when the route issues a relative API path', async () => {
    // A URL-issuing route that handed back a gated path would be silently
    // unusable from an inline element; the helper must refuse it outright.
    const video = document.createElement('video');
    const relative = vi.fn(async () => ({
      assetId: 'a1',
      status: 'ready',
      urls: { source: '/api/v1/assets/a1/stream/index.m3u8' },
      expiresAt: '2026-01-01T01:00:00Z',
    }));
    const onFailure = vi.fn();

    const ok = await applyPresignedMediaSrc(video, {
      apiFetch: relative,
      urlPath: '/assets/a1/delivery',
      urlField: 'urls.source',
      onFailure,
    });

    expect(ok).toBe(false);
    expect(video.hasAttribute('src')).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('never assigns a src when delivery issues an ABSOLUTE gated stream URL', async () => {
    // The end-to-end form of the backstop above, and the exact call a contributor
    // might reach for: `urlField: 'urls.hls'` against a proxy-mode delivery
    // response. `urls.hls` there is an absolute URL on the bearer-gated
    // `/assets/:id/stream/*` route, so assigning it would 401 in the element.
    // The helper must refuse it locally instead (openapi.json
    // → .paths["/api/v1/assets/{id}/delivery"].get, `urls: { hls?, dash?, source? }`,
    // all optional; src/routes/assets.ts:520 `deliveryUrlsSchema`).
    const video = document.createElement('video');
    const proxyDelivery = vi.fn(async () => ({
      assetId: 'a1',
      status: 'ready',
      urls: {
        hls: 'https://api.example/api/v1/assets/a1/stream/index.m3u8',
        dash: 'https://api.example/api/v1/assets/a1/stream/manifest.mpd',
      },
      expiresAt: '2026-01-01T01:00:00Z',
    }));
    const onFailure = vi.fn();

    const ok = await applyPresignedMediaSrc(video, {
      apiFetch: proxyDelivery,
      urlPath: '/assets/a1/delivery',
      urlField: 'urls.hls',
      onFailure,
    });

    expect(ok).toBe(false);
    expect(video.hasAttribute('src')).toBe(false);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('lets the LAST call win on a reused element, without accumulating listeners', async () => {
    // Elements are reused: a re-rendered row, a thumbnail strip repopulated for
    // another asset. A superseded in-flight call must not win by resolving last,
    // must not strip the newer healthy src, and must not report a failure.
    const img = document.createElement('img');
    const addSpy = vi.spyOn(img, 'addEventListener');
    const removeSpy = vi.spyOn(img, 'removeEventListener');

    let releaseFirst: (body: unknown) => void = () => {};
    const pending = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const slow = vi.fn(async () => pending);
    const SECOND_URL = 'https://storage.example/thumbnails/a2/thumb_0s.jpg?sig=two';
    const fast = vi.fn(async () => ({ ...thumbnailUrlBody, assetId: 'a2', url: SECOND_URL }));

    const staleSuccess = vi.fn();
    const staleFailure = vi.fn();
    const first = applyPresignedMediaSrc(img, {
      apiFetch: slow,
      urlPath: '/assets/a1/thumbnails/0/url',
      onSuccess: staleSuccess,
      onFailure: staleFailure,
    });

    const second = await applyPresignedMediaSrc(img, {
      apiFetch: fast,
      urlPath: '/assets/a2/thumbnails/0/url',
    });

    expect(second).toBe(true);
    expect(img.getAttribute('src')).toBe(SECOND_URL);

    // The superseded call now resolves, late, with the FIRST asset's URL.
    releaseFirst(thumbnailUrlBody);
    await expect(first).resolves.toBe(false);

    expect(img.getAttribute('src')).toBe(SECOND_URL);
    expect(staleSuccess).not.toHaveBeenCalled();
    expect(staleFailure).not.toHaveBeenCalled();

    // Two invocations, two registrations, one retirement — exactly one live
    // `error` listener, so handlers cannot pile up across re-renders.
    const added = addSpy.mock.calls.filter(([type]) => type === 'error');
    const removed = removeSpy.mock.calls.filter(([type]) => type === 'error');
    expect(added).toHaveLength(2);
    expect(removed).toHaveLength(1);

    // And a single error event now runs only the surviving invocation's teardown.
    img.dispatchEvent(new Event('error'));
    await settle();
    expect(img.hasAttribute('src')).toBe(false);
    expect(staleFailure).not.toHaveBeenCalled();
  });

  it("re-selects the parent <video> when a <source>'s signed URL fails to load", async () => {
    // A `<source>` never unloads anything itself: the parent has already SELECTED
    // that resource, so clearing the child's src is invisible until `load()`
    // re-runs selection over the now-empty candidate list. Without it the parent
    // stays bound to the resource that just failed.
    const video = document.createElement('video');
    const load = vi.fn();
    (video as unknown as { load: unknown }).load = load;
    const source = document.createElement('source');
    video.appendChild(source);
    const onFailure = vi.fn();

    const ok = await applyPresignedMediaSrc(source, {
      apiFetch,
      urlPath: '/assets/a1/delivery',
      urlField: 'urls.source',
      onFailure,
    });

    expect(ok).toBe(true);
    expect(source.getAttribute('src')).toBe(SIGNED_VIDEO);
    expect(load).toHaveBeenCalledTimes(1);

    // The signature expires (or storage refuses the signed GET) while the element
    // is showing it: that arrives as the `<source>`'s own `error` event.
    source.dispatchEvent(new Event('error'));
    await settle();

    expect(source.hasAttribute('src')).toBe(false);
    expect(load).toHaveBeenCalledTimes(2);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('degrades quietly when the URL cannot be issued (404 / 501 / 502)', async () => {
    // apiFetch throws for every documented failure of the URL-issuing routes.
    const failing = vi.fn(async () => {
      throw new Error('object storage is not configured');
    });
    const video = document.createElement('video');
    video.className = 'media-placeholder';
    const onFailure = vi.fn();

    const ok = await applyPresignedMediaSrc(video, {
      apiFetch: failing,
      urlPath: '/assets/a1/delivery',
      urlField: 'urls.source',
      placeholderClass: 'media-placeholder',
      onFailure,
    });

    expect(ok).toBe(false);
    expect(video.hasAttribute('src')).toBe(false);
    expect(video.classList.contains('media-placeholder')).toBe(true);
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('cleans the element back to its placeholder when the signed URL fails to load', async () => {
    // A signature can expire, or storage can refuse the signed GET, AFTER the
    // URL was issued — that arrives as the element's `error` event, not as a
    // rejected fetch.
    const img = document.createElement('img');
    img.className = 'thumb-placeholder';
    const onFailure = vi.fn();

    await applyPresignedMediaSrc(img, {
      apiFetch,
      urlPath: '/assets/a1/thumbnails/0/url',
      placeholderClass: 'thumb-placeholder',
      onFailure,
    });
    expect(img.getAttribute('src')).toBe(SIGNED_IMAGE);

    img.dispatchEvent(new Event('error'));
    await settle();

    expect(img.hasAttribute('src')).toBe(false);
    expect(img.classList.contains('thumb-placeholder')).toBe(true);
    expect(onFailure).toHaveBeenCalledTimes(1);

    // One failure, one notification — a second error event changes nothing.
    img.dispatchEvent(new Event('error'));
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  it('makes no request and never throws without a usable apiFetch', async () => {
    const video = document.createElement('video');
    await expect(
      applyPresignedMediaSrc(video, { urlPath: '/assets/a1/delivery' })
    ).resolves.toBe(false);
    expect(video.hasAttribute('src')).toBe(false);
  });
});
