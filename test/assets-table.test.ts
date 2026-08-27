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
