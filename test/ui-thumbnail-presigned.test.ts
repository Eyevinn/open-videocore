// @vitest-environment happy-dom
//
// Unit tests for public/thumbnail-url.js — the shared helper both ops-UI
// thumbnail call sites use (issue #801): the asset list cell
// (public/assets-table.js) and the asset detail strip (public/app.js).
//
// Why the helper exists: `GET /api/v1/assets/:id/thumbnails/:index` streams
// image/jpeg from behind the assets router's bearer gate, and a browser's plain
// <img> GET sends no Authorization header — so an <img> pointed at it always
// renders broken. The UI must fetch a signed URL over the authenticated
// apiFetch first and assign THAT to img.src.
//
// Verified contract (per CLAUDE.md rule 7):
//   - GET /api/v1/assets/{id}/thumbnails/{index}/url — openapi.json
//     .paths["/api/v1/assets/{id}/thumbnails/{index}/url"].get; route registered
//     at src/routes/assets.ts:4438 (issue #800).
//   - 200 body `thumbnailUrlSchema` (src/routes/assets.ts:611), all six fields
//     required: { assetId, index, objectKey, url, expiresAt, expiresInSeconds }.
//     The UI reads only `url`.
//   - Documented failures: 404 (unknown asset / out-of-range index), 501 (object
//     storage not configured), 502 (storage failed to sign) — apiFetch turns each
//     into a thrown Error (public/app.js apiFetch, non-ok branch).
//   - Fallback route GET /api/v1/assets/{id}/thumbnails/{index} — openapi.json
//     .paths["/api/v1/assets/{id}/thumbnails/{index}"].get; src/routes/assets.ts:4391
//     replies `Content-Type: image/jpeg` with the object stream. It is behind the
//     same bearer gate, so the UI reads it with apiFetch(..., { raw: true }) and
//     wraps the bytes in a blob object URL — never an <img> on the gated path.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyThumbnail,
  fetchThumbnailObjectUrl,
  fetchThumbnailUrl,
} from '../public/thumbnail-url.js';

const PRESIGNED = 'https://storage.example/thumbnails/a1/thumb_0s.jpg?sig=abc';

// Let the awaited work inside applyThumbnail settle (URL call, then blob read).
const settle = async () => {
  for (let i = 0; i < 4; i++) await Promise.resolve();
};

// A stub of the blob-URL factory: happy-dom's implementation is not needed and
// a fixed value keeps the assertions exact.
const OBJECT_URL = 'blob:ops-ui/thumb-1';
beforeEach(() => {
  vi.restoreAllMocks();
  (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => OBJECT_URL);
  (URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
});

// What apiFetch(path, { raw: true }) resolves to for the byte route: a Response
// whose body is image bytes.
const byteResponse = () => ({
  blob: async () => new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: 'image/jpeg' }),
});

// A 200 body in the exact shape the route serialises.
const okBody = (url = PRESIGNED) => ({
  assetId: 'a1',
  index: 0,
  objectKey: 'thumbnails/a1/thumb_0s.jpg',
  url,
  expiresAt: '2026-01-01T00:05:00Z',
  expiresInSeconds: 300,
});

describe('fetchThumbnailUrl', () => {
  it('calls the verified route with the asset id and array index', async () => {
    const apiFetch = vi.fn(async () => okBody());
    const url = await fetchThumbnailUrl(apiFetch, 'a1', 2);
    expect(apiFetch).toHaveBeenCalledWith('/assets/a1/thumbnails/2/url');
    expect(url).toBe(PRESIGNED);
  });

  it('percent-encodes an id that is not URL-safe', async () => {
    const apiFetch = vi.fn(async () => okBody());
    await fetchThumbnailUrl(apiFetch, 'a/b c', 0);
    expect(apiFetch).toHaveBeenCalledWith('/assets/a%2Fb%20c/thumbnails/0/url');
  });

  it('rejects when the body carries no usable url field', async () => {
    const apiFetch = vi.fn(async () => ({ assetId: 'a1', index: 0 }));
    await expect(fetchThumbnailUrl(apiFetch, 'a1', 0)).rejects.toThrow(/url/);
  });

  it('rejects a url that is not http(s), so only a loadable scheme reaches img.src', async () => {
    const apiFetch = vi.fn(async () => okBody('javascript:alert(1)'));
    await expect(fetchThumbnailUrl(apiFetch, 'a1', 0)).rejects.toThrow(/http/);
  });
});

describe('fetchThumbnailObjectUrl (authenticated byte-route fallback)', () => {
  it('reads the byte route with raw:true and wraps the bytes in an object URL', async () => {
    const apiFetch = vi.fn(async () => byteResponse());
    const url = await fetchThumbnailObjectUrl(apiFetch, 'a1', 2);

    // The gated byte route, fetched by apiFetch so the bearer header is attached.
    expect(apiFetch).toHaveBeenCalledWith('/assets/a1/thumbnails/2', { raw: true });
    expect(url).toBe(OBJECT_URL);
  });

  it('rejects when the route yields no bytes', async () => {
    const apiFetch = vi.fn(async () => ({ blob: async () => new Blob([]) }));
    await expect(fetchThumbnailObjectUrl(apiFetch, 'a1', 0)).rejects.toThrow(/bytes/);
  });
});

describe('applyThumbnail', () => {
  it('assigns the presigned URL to img.src and clears the placeholder class', async () => {
    const img = document.createElement('img');
    img.className = 'thumb-xs thumb-placeholder';
    const apiFetch = vi.fn(async () => okBody());

    const ok = await applyThumbnail(img, {
      apiFetch,
      assetId: 'a1',
      index: 0,
      placeholderClass: 'thumb-placeholder',
    });

    expect(ok).toBe(true);
    expect(img.getAttribute('src')).toBe(PRESIGNED);
    expect(img.classList.contains('thumb-placeholder')).toBe(false);
    // The signed URL is a storage URL, never the bearer-gated API path.
    expect(img.getAttribute('src')).not.toContain('/api/v1/');
  });

  it('makes no byte-route call while the signed URL loads', async () => {
    const img = document.createElement('img');
    const apiFetch = vi.fn(async () => okBody());

    await applyThumbnail(img, { apiFetch, assetId: 'a1', index: 0 });
    await settle();

    expect(apiFetch).toHaveBeenCalledTimes(1);
    expect(apiFetch).toHaveBeenCalledWith('/assets/a1/thumbnails/0/url');
  });

  it('never throws, leaves no src, and restores the placeholder when both routes fail', async () => {
    const img = document.createElement('img');
    img.className = 'thumb-xs thumb-placeholder';
    // Mirrors apiFetch's non-ok branch for a 502 storage_error on the URL route
    // and a 501 not_configured on the byte route.
    const apiFetch = vi.fn(async () => {
      throw new Error('object storage failed to sign the thumbnail URL');
    });

    const ok = await applyThumbnail(img, {
      apiFetch,
      assetId: 'a1',
      index: 0,
      placeholderClass: 'thumb-placeholder',
    });

    expect(ok).toBe(false);
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.classList.contains('thumb-placeholder')).toBe(true);
  });

  it('invokes onFailure so a caller can drop the element (detail strip behaviour)', async () => {
    const strip = document.createElement('div');
    const img = document.createElement('img');
    strip.appendChild(img);
    const apiFetch = vi.fn(async () => {
      throw new Error('not_found');
    });

    await applyThumbnail(img, {
      apiFetch,
      assetId: 'a1',
      index: 3,
      onFailure: () => img.remove(),
    });

    expect(strip.querySelector('img')).toBeNull();
  });

  it('falls back to the byte route when the signed URL cannot be issued', async () => {
    // e.g. a deployment whose object store refuses to presign (502), or one
    // where presigned GETs are blocked to the browser — the historical #113
    // condition. The thumbnail must still render.
    const img = document.createElement('img');
    img.className = 'thumb-xs thumb-placeholder';
    const calls: string[] = [];
    const apiFetch = vi.fn(async (path: string) => {
      calls.push(path);
      if (path.endsWith('/url')) throw new Error('object storage failed to sign');
      return byteResponse();
    });

    const ok = await applyThumbnail(img, {
      apiFetch,
      assetId: 'a1',
      index: 0,
      placeholderClass: 'thumb-placeholder',
    });

    expect(ok).toBe(true);
    expect(calls).toEqual(['/assets/a1/thumbnails/0/url', '/assets/a1/thumbnails/0']);
    expect(img.getAttribute('src')).toBe(OBJECT_URL);
    expect(img.classList.contains('thumb-placeholder')).toBe(false);
    // The element carries a blob URL, never the bearer-gated API path itself.
    expect(img.getAttribute('src')).not.toContain('/api/v1/');
  });

  it('falls back to the byte route when the signed GET fails after the URL was issued', async () => {
    const img = document.createElement('img');
    img.className = 'thumb-xs thumb-placeholder';
    const apiFetch = vi.fn(async (path: string) =>
      path.endsWith('/url') ? okBody() : byteResponse()
    );

    await applyThumbnail(img, {
      apiFetch,
      assetId: 'a1',
      index: 0,
      placeholderClass: 'thumb-placeholder',
    });
    expect(img.getAttribute('src')).toBe(PRESIGNED);

    // An expired signature surfaces as an <img> error event, not a rejected
    // fetch. The bytes are then pulled through the authenticated route.
    img.dispatchEvent(new Event('error'));
    await settle();

    expect(img.getAttribute('src')).toBe(OBJECT_URL);
    expect(img.classList.contains('thumb-placeholder')).toBe(false);
  });

  it('drops the src and restores the placeholder when the fallback image fails too', async () => {
    const img = document.createElement('img');
    img.className = 'thumb-xs thumb-placeholder';
    const apiFetch = vi.fn(async (path: string) =>
      path.endsWith('/url') ? okBody() : byteResponse()
    );

    await applyThumbnail(img, {
      apiFetch,
      assetId: 'a1',
      index: 0,
      placeholderClass: 'thumb-placeholder',
    });

    img.dispatchEvent(new Event('error')); // signed URL fails → fallback
    await settle();
    expect(img.getAttribute('src')).toBe(OBJECT_URL);

    img.dispatchEvent(new Event('error')); // fallback fails → placeholder
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.classList.contains('thumb-placeholder')).toBe(true);
    // The blob is released rather than pinned for the page's lifetime.
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(OBJECT_URL);
  });

  it('releases the blob URL once the fallback image has loaded', async () => {
    const img = document.createElement('img');
    const apiFetch = vi.fn(async (path: string) => {
      if (path.endsWith('/url')) throw new Error('not_configured');
      return byteResponse();
    });

    await applyThumbnail(img, { apiFetch, assetId: 'a1', index: 0 });
    await settle();
    expect(img.getAttribute('src')).toBe(OBJECT_URL);

    img.dispatchEvent(new Event('load'));
    expect(URL.revokeObjectURL).toHaveBeenCalledWith(OBJECT_URL);
  });

  it('reports success to onSuccess so a caller can reveal its heading (detail strip)', async () => {
    const img = document.createElement('img');
    const onSuccess = vi.fn();
    const apiFetch = vi.fn(async () => okBody());

    await applyThumbnail(img, { apiFetch, assetId: 'a1', index: 0, onSuccess });

    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it('does not report success when neither source resolves', async () => {
    const img = document.createElement('img');
    const onSuccess = vi.fn();
    const apiFetch = vi.fn(async () => {
      throw new Error('not_found');
    });

    await applyThumbnail(img, { apiFetch, assetId: 'a1', index: 0, onSuccess });

    expect(onSuccess).not.toHaveBeenCalled();
  });
});
