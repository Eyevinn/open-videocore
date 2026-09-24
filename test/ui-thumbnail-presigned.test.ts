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
//     at src/routes/assets.ts:4431 (issue #800).
//   - 200 body `thumbnailUrlSchema` (src/routes/assets.ts:611), all six fields
//     required: { assetId, index, objectKey, url, expiresAt, expiresInSeconds }.
//     The UI reads only `url`.
//   - Documented failures: 404 (unknown asset / out-of-range index), 501 (object
//     storage not configured), 502 (storage failed to sign) — apiFetch turns each
//     into a thrown Error (public/app.js apiFetch, non-ok branch).

import { describe, expect, it, vi } from 'vitest';
import { applyThumbnail, fetchThumbnailUrl } from '../public/thumbnail-url.js';

const PRESIGNED = 'https://storage.example/thumbnails/a1/thumb_0s.jpg?X-Amz-Signature=abc';

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

  it('never throws, leaves no src, and restores the placeholder when the route fails', async () => {
    const img = document.createElement('img');
    img.className = 'thumb-xs thumb-placeholder';
    // Mirrors apiFetch's non-ok branch for a 502 storage_error.
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

  it('drops the src again if the signed GET itself fails after the URL was issued', async () => {
    const img = document.createElement('img');
    img.className = 'thumb-xs thumb-placeholder';
    const apiFetch = vi.fn(async () => okBody());

    await applyThumbnail(img, {
      apiFetch,
      assetId: 'a1',
      index: 0,
      placeholderClass: 'thumb-placeholder',
    });
    expect(img.getAttribute('src')).toBe(PRESIGNED);

    // An expired signature surfaces as an <img> error event, not a rejected
    // fetch; the element must fall back to the placeholder, not a broken icon.
    img.dispatchEvent(new Event('error'));
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.classList.contains('thumb-placeholder')).toBe(true);
  });
});
