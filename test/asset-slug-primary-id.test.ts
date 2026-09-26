// @vitest-environment happy-dom
//
// Issue #133 — keep BOTH asset handles visible in the detail pane.
//
// SUPERSEDED IN PART BY #851: #133 originally put the slug under the label "ID"
// with the ULID on a secondary "ULID" row. #851 established that a field labelled
// ID must carry the value the API accepts as an id (the ULID — only
// `GET /api/v1/assets/:id` tolerates a slug; the collections membership routes do
// not), so the labels swapped: "ID" is the ULID, and the slug moved to its own
// "Slug" row. What survives from #133 is the part that was never in dispute — the
// human-readable slug keeps a place in the pane, and no empty or duplicate row is
// emitted for an asset that has no slug. This suite now asserts that.
//
// The asset detail body renderer (renderAssetDetailBody in public/app.js) is
// reused by both the embedded side panel and the detached pop-out window
// (public/detail.js). This suite boots it directly against a mocked fetch and
// asserts:
//   1. When an asset has a `slug`, both values are visible, each under its own
//      label: "ID" -> ULID, "Slug" -> slug. No "ULID" row remains.
//   2. When an asset has NO `slug`, "ID" still carries the ULID (the label never
//      changes meaning per asset) and NO empty/duplicate "Slug" row is emitted.
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

describe('asset detail — both handles visible, each under its own label (issues #133, #851)', () => {
  it('keeps the slug visible alongside the ULID when a slug exists', async () => {
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
    // Both handles are present in the pane — the slug keeps its place (#133).
    expect(text).toContain(SLUG);
    expect(text).toContain(ULID);
    // Each under its own label, and the old "ULID" row is gone (#851).
    const keyLabels = Array.from(body.querySelectorAll('.kv-key')).map((el) => el.textContent || '');
    expect(keyLabels).toContain('ID');
    expect(keyLabels).toContain('Slug');
    expect(keyLabels).not.toContain('ULID');
  });

  it('keeps the ULID under "ID" and emits no separate Slug row when slug is absent', async () => {
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
    // ULID is shown (under "ID"), and never the literal string "undefined".
    expect(text).toContain(ULID);
    expect(text).not.toContain('undefined');
    // No "Slug" row for a slug-less asset (avoids an empty row), and no leftover
    // "ULID" row either.
    const keyLabels = Array.from(body.querySelectorAll('.kv-key')).map((el) => el.textContent || '');
    expect(keyLabels).not.toContain('Slug');
    expect(keyLabels).not.toContain('ULID');
    expect(keyLabels).toContain('ID');
  });
});
