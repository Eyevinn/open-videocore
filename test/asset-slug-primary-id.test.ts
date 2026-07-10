// @vitest-environment happy-dom
//
// Issue #133 — show slug as the primary asset id with the ULID on hover.
//
// The asset detail body renderer (renderAssetDetailBody in public/app.js) is
// reused by both the embedded side panel and the detached pop-out window
// (public/detail.js). This suite boots it directly against a mocked fetch and
// asserts the slug-primary / ULID-secondary contract:
//   1. When an asset has a `slug`, the primary "ID" row shows the slug and a
//      separate "ULID" row keeps the raw ULID visible in the detail pane.
//   2. When an asset has NO `slug`, the ULID is shown as the "ID" (fallback) and
//      NO empty/duplicate "ULID" row is emitted.
//
// This mirrors the pattern in test/detached-pane.test.ts (mount + mocked fetch +
// vi.resetModules per case) but drives renderAssetDetailBody directly so the DOM
// wiring stays minimal.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ULID = '01HZY8KABCDEF0123456789XYZ';
const SLUG = 'my-first-clip';

function stubFetch(routes: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    const path = new URL(url).pathname.replace(/^\/api\/v1/, '');
    if (path in routes) {
      return new Response(JSON.stringify(routes[path]), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    // delivery / other sub-fetches 404 so the renderer degrades gracefully.
    return new Response(JSON.stringify({ error: 'not_found' }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  });
}

beforeEach(() => {
  vi.resetModules();
  document.documentElement.innerHTML = '<head></head><body></body>';
});

afterEach(() => {
  vi.restoreAllMocks();
  document.documentElement.innerHTML = '';
});

describe('asset detail — slug as primary id with ULID retained (issue #133)', () => {
  it('shows the slug as the primary ID and keeps the ULID visible when a slug exists', async () => {
    const asset = { id: ULID, slug: SLUG, title: 'My First Clip', status: 'ready', mimeType: 'video/mp4' };
    vi.stubGlobal('fetch', stubFetch({ ['/assets/' + ULID]: asset }));

    const { renderAssetDetailBody } = await import('../public/app.js');
    const body = document.createElement('div');
    document.body.appendChild(body);

    await renderAssetDetailBody(ULID, body);
    await vi.waitFor(() => {
      expect(body.querySelector('.kv-grid')).not.toBeNull();
    });

    const text = body.textContent || '';
    // Primary identifier is the slug; the raw ULID is still present in the pane.
    expect(text).toContain(SLUG);
    expect(text).toContain(ULID);
    // A dedicated "ULID" label row exposes the raw id alongside the slug.
    const keyLabels = Array.from(body.querySelectorAll('.kv-key')).map((el) => el.textContent || '');
    expect(keyLabels).toContain('ID');
    expect(keyLabels).toContain('ULID');
  });

  it('falls back to the ULID as the ID and emits no separate ULID row when slug is absent', async () => {
    const asset = { id: ULID, title: 'Legacy Asset', status: 'ready', mimeType: 'video/mp4' };
    vi.stubGlobal('fetch', stubFetch({ ['/assets/' + ULID]: asset }));

    const { renderAssetDetailBody } = await import('../public/app.js');
    const body = document.createElement('div');
    document.body.appendChild(body);

    await renderAssetDetailBody(ULID, body);
    await vi.waitFor(() => {
      expect(body.querySelector('.kv-grid')).not.toBeNull();
    });

    const text = body.textContent || '';
    // ULID is shown (as the fallback ID), and never the literal string "undefined".
    expect(text).toContain(ULID);
    expect(text).not.toContain('undefined');
    // No dedicated "ULID" label row when there is no slug (avoids duplicate rows).
    const keyLabels = Array.from(body.querySelectorAll('.kv-key')).map((el) => el.textContent || '');
    expect(keyLabels).not.toContain('ULID');
    expect(keyLabels).toContain('ID');
  });
});
