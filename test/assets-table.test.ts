// @vitest-environment happy-dom
//
// Component-level tests for the assets-table wiring (issue #369).
//
// These tests assert the CONTRACT-critical behaviour of public/assets-table.js:
// that it routes to the correct backend tier and sends only verified query
// params, pages within bounds, filters status server-side on the list tier, and
// round-trips sort/filter/page state through the shared URL-state contract.
//
// Verified backend contract (openapi.json + route source), grounded in the module:
//   - Tier 1 (no `q`):  GET /api/v1/assets/  params: limit(1..200), offset(>=0),
//     status enum [uploading|processing|ready|failed|archived]; envelope
//     { items, limit, offset, total }; server order = createdAt ASC / ULID id.
//   - Tier 2 (`q` present): GET /api/v1/search/  params: q, page(>=1),
//     pageSize(1..100); envelope { assets, total, page }.
// The tests inject a fake apiFetch so no live server is required; they assert on
// the exact path/params the module builds.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAssetsTable, ASSET_STATUSES, ASSETS_PAGE_SIZE } from '../public/assets-table.js';

// Minimal render helpers matching app.js's signatures.
const deps = () => ({
  renderBadge: (s: string) => '<span class="badge">' + s + '</span>',
  renderTags: () => '',
  fmtDate: (v: string) => String(v || '—'),
  isAssetWedged: () => false,
});

// Build a fake apiFetch that records calls and returns canned envelopes keyed by
// the endpoint prefix. Returns [fetch, calls].
function fakeApi(handlers: Record<string, (url: URL) => unknown>) {
  const calls: string[] = [];
  const apiFetch = vi.fn(async (path: string) => {
    calls.push(path);
    const url = new URL('http://x' + (path.startsWith('/') ? path : '/' + path));
    const key = url.pathname.replace(/^\//, '').split('?')[0]; // 'assets' | 'search'
    const h = handlers[key];
    if (!h) throw new Error('unexpected endpoint: ' + key);
    return h(url);
  });
  return { apiFetch, calls };
}

function lastCallParams(calls: string[], prefix: string): URLSearchParams {
  const hit = [...calls].reverse().find((c) => c.startsWith(prefix));
  if (!hit) throw new Error('no call matching ' + prefix + ' in ' + JSON.stringify(calls));
  return new URL('http://x' + hit).searchParams;
}

// A stub window whose location.search we can seed, and whose history calls are
// captured, so URL-state round-tripping is observable without a real browser bar.
function stubWin(search = '') {
  const applied: string[] = [];
  return {
    location: { search, pathname: '/', hash: '' },
    history: {
      state: null,
      replaceState: (_s: unknown, _t: string, url: string) => {
        applied.push(url);
      },
      pushState: (_s: unknown, _t: string, url: string) => {
        applied.push(url);
      },
    },
    _applied: applied,
  };
}

// Let the module's async reload() settle.
const tick = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('assets-table contract constants', () => {
  it('exposes the ADR-005 status vocabulary verified against the OpenAPI enum', () => {
    expect(ASSET_STATUSES).toEqual([
      'uploading',
      'processing',
      'ready',
      'failed',
      'archived',
    ]);
  });

  it('uses a bounded, visible page size', () => {
    expect(ASSETS_PAGE_SIZE).toBe(20);
    expect(ASSETS_PAGE_SIZE).toBeLessThanOrEqual(100); // search pageSize max
    expect(ASSETS_PAGE_SIZE).toBeLessThanOrEqual(200); // list limit max
  });
});

describe('tier 1 — list endpoint (no free-text term)', () => {
  it('fetches GET /assets with bounded limit/offset and no q', async () => {
    const { apiFetch, calls } = fakeApi({
      assets: () => ({ items: [{ id: 'a1', name: 'One', status: 'ready', createdAt: '2026-01-01T00:00:00Z' }], total: 1 }),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    const params = lastCallParams(calls, '/assets');
    expect(params.get('limit')).toBe(String(ASSETS_PAGE_SIZE));
    expect(params.get('offset')).toBe('0');
    expect(params.get('q')).toBeNull();
    // A row rendered.
    expect(t.el.querySelectorAll('tbody tr[data-row-key]').length).toBe(1);
  });

  it('sends the status filter server-side as the verified enum param', async () => {
    const { apiFetch, calls } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    t.state.setFilter('status', 'processing');
    await tick();

    const params = lastCallParams(calls, '/assets');
    expect(params.get('status')).toBe('processing');
  });

  it('advances offset by the page size on next-page (ULID creation-order paging)', async () => {
    const { apiFetch, calls } = fakeApi({
      assets: () => ({
        items: Array.from({ length: ASSETS_PAGE_SIZE }, (_v, i) => ({
          id: 'a' + i,
          name: 'n' + i,
          status: 'ready',
          createdAt: '2026-01-0' + ((i % 9) + 1) + 'T00:00:00Z',
        })),
        total: 60,
      }),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    t.state.nextPage();
    await tick();

    const params = lastCallParams(calls, '/assets');
    expect(params.get('offset')).toBe(String(ASSETS_PAGE_SIZE));
  });
});

describe('tier 2 — free-text search endpoint (reuses the q/FTS path)', () => {
  it('routes to GET /search with q/page/pageSize and no parallel path', async () => {
    const { apiFetch, calls } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
      search: () => ({ assets: [{ id: 's1', name: 'hit', status: 'ready', createdAt: '2026-02-02T00:00:00Z' }], total: 1, page: 1 }),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    t.state.setFilter('q', 'hello');
    await tick();

    // The request went to /search (the canonical FTS path), NOT to /assets.
    const params = lastCallParams(calls, '/search');
    expect(params.get('q')).toBe('hello');
    expect(params.get('page')).toBe('1');
    expect(params.get('pageSize')).toBe(String(ASSETS_PAGE_SIZE));
    // Row from the search envelope rendered.
    expect(t.el.querySelectorAll('tbody tr[data-row-key]').length).toBe(1);
  });

  it('maps offset paging onto the search endpoint 1-based page param', async () => {
    const { apiFetch, calls } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
      search: () => ({
        assets: Array.from({ length: ASSETS_PAGE_SIZE }, (_v, i) => ({
          id: 's' + i,
          name: 'n' + i,
          status: 'ready',
          createdAt: '2026-02-02T00:00:00Z',
        })),
        total: 60,
        page: 1,
      }),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    t.state.setFilter('q', 'x');
    await tick();
    t.state.nextPage();
    await tick();

    const params = lastCallParams(calls, '/search');
    expect(params.get('page')).toBe('2'); // offset 20 / size 20 + 1
  });
});

describe('URL-state round-trip (shared contract)', () => {
  it('reconstructs status + q filters from the URL on init', async () => {
    const { apiFetch, calls } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
      search: () => ({ assets: [], total: 0, page: 1 }),
    });
    // Seed the URL with namespaced params per the shared contract.
    const win = stubWin('?assets.q=news&assets.status=ready');
    const t = createAssetsTable({ ...deps(), apiFetch, win });
    document.body.appendChild(t.el);
    await tick();

    // q present => search tier, and the seeded status is applied.
    const search = lastCallParams(calls, '/search');
    expect(search.get('q')).toBe('news');
    // The status control was seeded from the URL.
    const sel = t.el.querySelector<HTMLSelectElement>('.ops-filter-status select')!;
    expect(sel.value).toBe('ready');
  });

  it('writes the current sort/filter/page back into the URL via history.replaceState', async () => {
    const { apiFetch } = fakeApi({
      assets: () => ({ items: [{ id: 'a1', name: 'n', status: 'ready', createdAt: '2026-01-01T00:00:00Z' }], total: 1 }),
    });
    const win = stubWin();
    const t = createAssetsTable({ ...deps(), apiFetch, win });
    document.body.appendChild(t.el);
    await tick();

    t.state.setFilter('status', 'failed');
    await tick();

    const applied = win._applied.join('\n');
    expect(applied).toContain('assets.status=failed');
  });
});

describe('page-scoped narrowing caveat (operator-facing disclosure)', () => {
  // The list/search endpoints have no server-side date-range param, and the
  // search (q) tier has no status param, so those refinements narrow the current
  // page client-side while the pager total still reflects the full server set.
  // The table must DISCLOSE that to the operator with a visible note whenever
  // such a filter is active — a code comment is not sufficient.
  const caveatOf = (t: { el: HTMLElement }) =>
    t.el.querySelector<HTMLElement>('.ops-table-caveat');

  it('hides the caveat when no page-scoped narrowing filter is active', async () => {
    const { apiFetch } = fakeApi({
      assets: () => ({ items: [{ id: 'a1', name: 'n', status: 'ready', createdAt: '2026-01-01T00:00:00Z' }], total: 1 }),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    const note = caveatOf(t);
    expect(note).not.toBeNull();
    expect(note!.hidden).toBe(true);
  });

  it('shows the caveat when a created-date-range filter is active (list tier)', async () => {
    const { apiFetch } = fakeApi({
      assets: () => ({ items: [{ id: 'a1', name: 'n', status: 'ready', createdAt: '2026-01-01T00:00:00Z' }], total: 500 }),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    t.state.setFilter('from', '2026-01-01');
    await tick();

    const note = caveatOf(t);
    expect(note!.hidden).toBe(false);
    expect(note!.textContent).toMatch(/current page only/i);
  });

  it('shows the caveat when a status filter is active on the search (q) tier', async () => {
    const { apiFetch } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
      search: () => ({ assets: [{ id: 's1', name: 'hit', status: 'ready', createdAt: '2026-02-02T00:00:00Z' }], total: 40, page: 1 }),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    t.state.setFilter('q', 'hello');
    await tick();
    // q alone (no status) does not narrow client-side — caveat stays hidden.
    expect(caveatOf(t)!.hidden).toBe(true);

    t.state.setFilter('status', 'ready');
    await tick();
    // q + status => the FTS tier narrows status client-side => caveat shows.
    expect(caveatOf(t)!.hidden).toBe(false);
  });

  it('does NOT show the caveat for a status filter on the list (no-q) tier', async () => {
    // On the list tier, status IS a server-side param, so it does not narrow the
    // page — the caveat must stay hidden.
    const { apiFetch } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    t.state.setFilter('status', 'processing');
    await tick();

    expect(caveatOf(t)!.hidden).toBe(true);
  });
});

describe('shared table states', () => {
  it('renders an error row when the backend fetch rejects', async () => {
    const apiFetch = vi.fn(async () => {
      throw new Error('boom');
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();
    const err = t.el.querySelector('tr.ops-table-error td');
    expect(err!.textContent).toContain('Failed to load assets');
    expect(err!.textContent).toContain('boom');
  });

  it('renders the empty state when a page returns zero rows', async () => {
    const { apiFetch } = fakeApi({ assets: () => ({ items: [], total: 0 }) });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();
    expect(t.el.querySelector('tr.ops-table-empty td')!.textContent).toBe('No assets found.');
  });
});

// ─── Thumbnails (issue #801) ──────────────────────────────────────────────────
//
// An <img> GET carries no Authorization header, so the list cell can never point
// at the bearer-gated byte route GET /api/v1/assets/:id/thumbnails/:index. The
// table instead resolves a signed URL over the authenticated apiFetch.
//
// Verified contract: GET /api/v1/assets/{id}/thumbnails/{index}/url
//   openapi.json .paths["/api/v1/assets/{id}/thumbnails/{index}/url"].get
//   src/routes/assets.ts:4438 (route), :611 (`thumbnailUrlSchema`)
//   200 body: { assetId, index, objectKey, url, expiresAt, expiresInSeconds }.
// The table reads exactly one field: `url`.
describe('thumbnail cells resolve a presigned URL (issue #801)', () => {
  const PRESIGNED = 'https://storage.example/thumbnails/a1/thumb_0s.jpg?sig=abc';

  const rowWithThumb = {
    id: 'a1',
    name: 'One',
    status: 'ready',
    createdAt: '2026-01-01T00:00:00Z',
    thumbnails: ['thumbnails/a1/thumb_0s.jpg'],
  };

  // Routes the list call and the thumbnail-URL call apart; `onUrlCall` decides
  // what the URL endpoint does (resolve, reject, or hang).
  function thumbApi(onUrlCall: (path: string) => unknown, row: unknown = rowWithThumb) {
    const calls: string[] = [];
    const apiFetch = vi.fn(async (path: string) => {
      calls.push(path);
      if (path.includes('/thumbnails/')) return onUrlCall(path);
      return { items: row ? [row] : [], total: row ? 1 : 0 };
    });
    return { apiFetch, calls };
  }

  // One tick settles the row fetch; the second settles the thumbnail hydration
  // kicked off after the rows render.
  const settle = async () => {
    await tick();
    await tick();
  };

  it('renders the cell with no src at all, so no <img> points at the gated API path', async () => {
    // URL endpoint never answers: the cell must still be safe to display.
    const { apiFetch } = thumbApi(() => new Promise(() => {}));
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await settle();

    const img = t.el.querySelector('tbody img') as HTMLImageElement;
    expect(img).not.toBeNull();
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.classList.contains('thumb-placeholder')).toBe(true);
    expect(t.el.innerHTML).not.toContain('/api/v1/assets');
  });

  it('requests the URL by asset id + array index and assigns the returned url to img.src', async () => {
    const { apiFetch, calls } = thumbApi(() => ({
      assetId: 'a1',
      index: 0,
      objectKey: 'thumbnails/a1/thumb_0s.jpg',
      url: PRESIGNED,
      expiresAt: '2026-01-01T00:05:00Z',
      expiresInSeconds: 300,
    }));
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await settle();

    expect(calls).toContain('/assets/a1/thumbnails/0/url');
    const img = t.el.querySelector('tbody img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(PRESIGNED);
    expect(img.classList.contains('thumb-placeholder')).toBe(false);
  });

  it('falls back to the authenticated byte route when no signed URL can be issued', async () => {
    // Contract: GET /api/v1/assets/{id}/thumbnails/{index} streams image/jpeg
    // from behind the bearer gate (src/routes/assets.ts:4391), so the table
    // reads it with apiFetch and shows the bytes as a blob URL.
    const objectUrl = 'blob:ops-ui/row-thumb';
    (URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => objectUrl);
    const { apiFetch, calls } = thumbApi((path) => {
      if (path.endsWith('/url')) throw new Error('object storage failed to sign');
      return {
        blob: async () => new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' }),
      };
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await settle();
    await settle();

    expect(calls).toContain('/assets/a1/thumbnails/0');
    const img = t.el.querySelector('tbody img') as HTMLImageElement;
    expect(img.getAttribute('src')).toBe(objectUrl);
    expect(img.getAttribute('src')).not.toContain('/api/v1/');
  });

  it('keeps the placeholder — not a broken image — when neither route answers', async () => {
    // e.g. 501 not_configured / 502 storage_error, which apiFetch throws.
    const { apiFetch } = thumbApi(() => {
      throw new Error('object storage is not configured');
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await settle();

    const img = t.el.querySelector('tbody img') as HTMLImageElement;
    expect(img.hasAttribute('src')).toBe(false);
    expect(img.classList.contains('thumb-placeholder')).toBe(true);
    // A decorative thumbnail must not escalate into a table-wide error state.
    expect(t.el.querySelector('tr.ops-table-error')).toBeNull();
  });

  it('makes no thumbnail request for an asset that has none', async () => {
    const { apiFetch, calls } = thumbApi(
      () => {
        throw new Error('should not be called');
      },
      { id: 'a2', name: 'Two', status: 'ready', createdAt: '2026-01-01T00:00:00Z', thumbnails: [] }
    );
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await settle();

    expect(calls.some((c) => c.includes('/thumbnails/'))).toBe(false);
    expect(t.el.querySelector('tbody img')).toBeNull();
    expect(t.el.querySelector('tbody .thumb-placeholder')).not.toBeNull();
  });
});
