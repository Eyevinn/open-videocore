// @vitest-environment happy-dom
//
// Component-level tests for the tags + metadata filters in the Assets tab filter
// bar (issue #947, broken out of #826), and for the shared request grammar they
// are built from (public/search-filter-params.js).
//
// CONTRACT GROUNDING — every param name, form and match semantic asserted below
// is verified against this repo's generated spec and route source, never the
// issue text:
//
//   `tags` (comma-separated form):
//     openapi.json .paths["/api/v1/search/"].get.parameters[name="tags"]
//       -> { anyOf: [ {type:"string"}, {type:"array", items:{type:"string"}} ] }
//     Source: `tagsSchema` src/routes/search.ts:139-150 — "`tags` accepts
//     repeated query params (?tags=a&tags=b) or a comma-separated list
//     (?tags=a,b)". AND semantics, exact match: src/data/search-repo.ts:378-382.
//
//   `metadata.<key>=<value>` (dynamic, so absent from the spec's parameter list
//   by construction — `searchQuerySchema` carries `.passthrough()`,
//   src/routes/search.ts:219):
//     Grammar declared at src/routes/search.ts:14-16; extracted by
//     `extractMetadataFilter` src/routes/search.ts:223-238 (prefix `metadata.`,
//     empty key skipped, first value used when a key repeats). Exact-match,
//     ANDed: src/data/search-repo.ts:392-399 (`md[key] !== value`).
//
//   NO tags/metadata param on the list endpoint:
//     openapi.json .paths["/api/v1/assets/"].get.parameters is exactly
//     limit, offset, status, parentId, from, to (`listQuerySchema`,
//     src/routes/assets.ts). That absence is WHY a tags/metadata filter has to
//     be answered by GET /api/v1/search/ rather than by narrowing a list page
//     client-side — the page-scoped-narrowing-with-unnarrowed-total bug #825
//     fixed, and this issue's stated dependency.
//
//   Tier-2 envelope: { assets, collections, total, collectionTotal, page }
//     (`searchResultSchema` src/routes/search.ts:123-135), where `total` counts
//     matching ASSETS. `collections` is not this table's surface (issue #561).
//
// The tests inject a fake apiFetch, so no live server is required; they assert
// on the exact path/params the module builds.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssetsTable, readFilterState } from '../public/assets-table.js';
import {
  applySearchFilterParams,
  formatMetadataFilterText,
  formatTagsFilterText,
  hasStructuredFilter,
  parseMetadataFilterText,
  parseTagsFilterText,
} from '../public/search-filter-params.js';

// Minimal render helpers matching app.js's signatures (same shape the sibling
// assets-table tests use).
const deps = () => ({
  renderBadge: (s: string) => '<span class="badge">' + s + '</span>',
  renderTags: (tags?: string[]) => (tags || []).join(' '),
  fmtDate: (v: string) => String(v || '—'),
  isAssetWedged: () => false,
});

function fakeApi(handlers: Record<string, (url: URL) => unknown>) {
  const calls: string[] = [];
  const apiFetch = vi.fn(async (path: string) => {
    calls.push(path);
    const url = new URL('http://x' + (path.startsWith('/') ? path : '/' + path));
    const key = url.pathname.replace(/^\//, '').split('?')[0];
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

const tick = () => new Promise((r) => setTimeout(r, 0));

// Canned tier-2 envelope with the verified five top-level fields.
function searchEnvelope(assets: unknown[], total = assets.length, page = 1) {
  return { assets, collections: [], total, collectionTotal: 0, page };
}

function tagsInput(el: HTMLElement): HTMLInputElement {
  return el.querySelector<HTMLInputElement>('.ops-filter-tags input')!;
}

function metaInput(el: HTMLElement): HTMLInputElement {
  return el.querySelector<HTMLInputElement>('.ops-filter-meta input')!;
}

// Drive a text filter the way a browser does: type, then commit on blur/Enter.
function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function commit(input: HTMLInputElement) {
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ─── The shared request grammar ──────────────────────────────────────────────

describe('tags filter grammar', () => {
  it('parses the comma-separated form the server flattens, trimmed and de-duped', () => {
    expect(parseTagsFilterText(' news , sports ,news ')).toEqual(['news', 'sports']);
  });

  it('reads an empty or separator-only value as no filter', () => {
    expect(parseTagsFilterText('')).toEqual([]);
    expect(parseTagsFilterText(' , , ')).toEqual([]);
    expect(parseTagsFilterText(undefined as unknown as string)).toEqual([]);
  });

  it('round-trips a tag list back into the control text', () => {
    expect(parseTagsFilterText(formatTagsFilterText(['news', 'sports']))).toEqual([
      'news',
      'sports',
    ]);
  });

  it('sends ONE comma-separated `tags` param, the form the Search tab sends', () => {
    const p = applySearchFilterParams(new URLSearchParams(), { tags: ['news', 'sports'] });
    expect(p.getAll('tags')).toEqual(['news,sports']);
  });

  it('writes no param at all for an empty tag list', () => {
    const p = applySearchFilterParams(new URLSearchParams(), { tags: [] });
    expect(p.has('tags')).toBe(false);
  });
});

describe('metadata filter grammar', () => {
  it('parses comma-separated key=value pairs', () => {
    expect(parseMetadataFilterText('genre=documentary, language=sv').entries).toEqual({
      genre: 'documentary',
      language: 'sv',
    });
  });

  it('splits on the first = only, so a value may contain one', () => {
    expect(parseMetadataFilterText('expr=a=b').entries).toEqual({ expr: 'a=b' });
  });

  it('reports a segment with no value instead of silently dropping it', () => {
    const r = parseMetadataFilterText('genre, language=sv, mood=');
    expect(r.entries).toEqual({ language: 'sv' });
    expect(r.ignored).toEqual(['genre', 'mood=']);
  });

  it('resolves a repeated key to one value rather than sending it twice', () => {
    expect(parseMetadataFilterText('genre=doc, genre=news').entries).toEqual({ genre: 'news' });
  });

  it('round-trips a pair map back into the control text', () => {
    const text = formatMetadataFilterText({ genre: 'documentary', language: 'sv' });
    expect(parseMetadataFilterText(text).entries).toEqual({
      genre: 'documentary',
      language: 'sv',
    });
  });

  it('sends one `metadata.<key>` param per pair', () => {
    const p = applySearchFilterParams(new URLSearchParams(), {
      metadata: { genre: 'documentary', language: 'sv' },
    });
    expect(p.get('metadata.genre')).toBe('documentary');
    expect(p.get('metadata.language')).toBe('sv');
  });

  it('writes no param for an empty pair map', () => {
    const p = applySearchFilterParams(new URLSearchParams(), { metadata: {} });
    expect([...p.keys()]).toEqual([]);
  });
});

describe('hasStructuredFilter', () => {
  it('is true for a tag or a metadata pair and false for neither', () => {
    expect(hasStructuredFilter({ tags: ['news'] })).toBe(true);
    expect(hasStructuredFilter({ metadata: { genre: 'doc' } })).toBe(true);
    expect(hasStructuredFilter({ tags: [], metadata: {} })).toBe(false);
    expect(hasStructuredFilter(undefined as unknown as object)).toBe(false);
  });
});

describe('readFilterState — tier decision', () => {
  it('routes a tags-only or metadata-only filter to the search tier', () => {
    expect(readFilterState({ tags: 'news' }).useSearchTier).toBe(true);
    expect(readFilterState({ meta: 'genre=documentary' }).useSearchTier).toBe(true);
  });

  it('stays on the list tier for status/date filters alone', () => {
    expect(readFilterState({ status: 'ready', from: '2026-01-01' }).useSearchTier).toBe(false);
    expect(readFilterState({}).useSearchTier).toBe(false);
  });

  it('does not route on an unusable metadata segment, which filters nothing', () => {
    expect(readFilterState({ meta: 'genre' }).useSearchTier).toBe(false);
  });
});

// ─── The Assets tab filter bar ───────────────────────────────────────────────

describe('Assets tab filter bar — controls', () => {
  it('exposes a tags and a metadata control alongside the existing filters', async () => {
    const { apiFetch } = fakeApi({ assets: () => ({ items: [], total: 0 }) });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    expect(tagsInput(t.el)).toBeTruthy();
    expect(metaInput(t.el)).toBeTruthy();
    // The free-text box keeps its place as the last control in the bar.
    const slots = [...t.el.querySelectorAll('.ops-filter-slot[data-filter]')].map(
      (s) => (s as HTMLElement).dataset.filter
    );
    expect(slots).toEqual(['status', 'from', 'to', 'tags', 'meta', 'q']);
  });

  it('names each control for assistive technology and describes its grammar', async () => {
    const { apiFetch } = fakeApi({ assets: () => ({ items: [], total: 0 }) });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    expect(tagsInput(t.el).getAttribute('aria-label')).toBe('Filter by tags');
    expect(metaInput(t.el).getAttribute('aria-label')).toBe('Filter by metadata');

    for (const input of [tagsInput(t.el), metaInput(t.el)]) {
      const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter(Boolean);
      expect(ids.length).toBeGreaterThan(0);
      // Every described-by target exists and the first one carries the grammar.
      const targets = ids.map((id) => t.el.querySelector('#' + id));
      targets.forEach((el) => expect(el).toBeTruthy());
      expect((targets[0] as HTMLElement).textContent).toMatch(/comma-separated/i);
    }
  });

  it('gives two mounted tables distinct describedby ids', async () => {
    const { apiFetch } = fakeApi({ assets: () => ({ items: [], total: 0 }) });
    const a = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    const b = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    await tick();
    expect(tagsInput(a.el).getAttribute('aria-describedby')).not.toBe(
      tagsInput(b.el).getAttribute('aria-describedby')
    );
  });

  it('says what it is NOT filtering on when a metadata segment has no value', async () => {
    const { apiFetch, calls } = fakeApi({ assets: () => ({ items: [], total: 0 }) });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    const notice = t.el.querySelector<HTMLElement>('.ops-filter-meta .ops-filter-notice')!;
    expect(notice.hidden).toBe(true);
    // A live region, so the message is announced rather than seen only.
    expect(notice.getAttribute('role')).toBe('status');

    type(metaInput(t.el), 'genre');
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toContain('genre');
    expect(notice.textContent).toContain('key=value');
    // And it is a hint, not a request: nothing was fetched for a half-typed pair.
    expect(calls.filter((c) => c.startsWith('/search'))).toEqual([]);

    type(metaInput(t.el), 'genre=documentary');
    expect(notice.hidden).toBe(true);
    expect(notice.textContent).toBe('');
  });

  it('does not re-issue the same request for Enter followed by the blur it causes', async () => {
    const { apiFetch, calls } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
      search: () => searchEnvelope([], 0),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    const input = tagsInput(t.el);
    type(input, 'news');
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await tick();
    commit(input);
    await tick();

    expect(calls.filter((c) => c.startsWith('/search'))).toHaveLength(1);
  });
});

describe('Assets tab filter bar — tags/metadata reach the verified search params', () => {
  it('answers a tags-only filter from GET /search with no free-text term', async () => {
    const { apiFetch, calls } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
      search: () => searchEnvelope([{ id: 'a1', name: 'One', status: 'ready' }], 1),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    type(tagsInput(t.el), 'news, sports');
    commit(tagsInput(t.el));
    await tick();

    const p = lastCallParams(calls, '/search');
    expect(p.get('tags')).toBe('news,sports');
    // `q` is a 1..512 string, so a tags-only filter must omit it entirely rather
    // than send `q=`.
    expect(p.has('q')).toBe(false);
    expect(p.get('page')).toBe('1');
    expect(p.get('pageSize')).toBe('20');
    // And the list endpoint — which has no `tags` param — is not asked.
    expect(calls.filter((c) => c.startsWith('/assets?')).length).toBe(1); // the first load only
  });

  it('answers a metadata-only filter from GET /search as metadata.<key>', async () => {
    const { apiFetch, calls } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
      search: () => searchEnvelope([], 0),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    type(metaInput(t.el), 'genre=documentary, language=sv');
    commit(metaInput(t.el));
    await tick();

    const p = lastCallParams(calls, '/search');
    expect(p.get('metadata.genre')).toBe('documentary');
    expect(p.get('metadata.language')).toBe('sv');
    expect(p.has('q')).toBe(false);
  });

  it('ANDs tags + metadata with the free-text, status and date filters in one request', async () => {
    const { apiFetch, calls } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
      search: () => searchEnvelope([], 0),
    });
    const win = stubWin(
      '?assets.q=clip&assets.status=ready&assets.from=2026-01-01&assets.to=2026-06-30' +
        '&assets.tags=news&assets.meta.genre=documentary'
    );
    const t = createAssetsTable({ ...deps(), apiFetch, win });
    document.body.appendChild(t.el);
    await tick();

    const p = lastCallParams(calls, '/search');
    expect(p.get('q')).toBe('clip');
    expect(p.get('status')).toBe('ready');
    expect(p.get('from')).toBe('2026-01-01');
    expect(p.get('to')).toBe('2026-06-30');
    expect(p.get('tags')).toBe('news');
    expect(p.get('metadata.genre')).toBe('documentary');
  });

  it('reconstructs both controls from a shared URL', async () => {
    const { apiFetch } = fakeApi({ search: () => searchEnvelope([], 0) });
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.tags=news,sports&assets.meta.genre=documentary'),
    });
    document.body.appendChild(t.el);
    await tick();

    expect(parseTagsFilterText(tagsInput(t.el).value)).toEqual(['news', 'sports']);
    expect(parseMetadataFilterText(metaInput(t.el).value).entries).toEqual({
      genre: 'documentary',
    });
  });

  it('writes both filters back into the URL so the view is shareable', async () => {
    const { apiFetch } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
      search: () => searchEnvelope([], 0),
    });
    const win = stubWin();
    const t = createAssetsTable({ ...deps(), apiFetch, win });
    document.body.appendChild(t.el);
    await tick();

    type(tagsInput(t.el), 'news');
    commit(tagsInput(t.el));
    await tick();
    type(metaInput(t.el), 'genre=documentary');
    commit(metaInput(t.el));
    await tick();

    const applied = win._applied[win._applied.length - 1];
    expect(applied).toContain('assets.tags=news');
    expect(applied).toContain('assets.meta.genre=documentary');
  });

  it('drops back to the list tier when the filters are cleared', async () => {
    const { apiFetch, calls } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
      search: () => searchEnvelope([], 0),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    type(tagsInput(t.el), 'news');
    commit(tagsInput(t.el));
    await tick();
    expect(calls[calls.length - 1].startsWith('/search')).toBe(true);

    type(tagsInput(t.el), '');
    commit(tagsInput(t.el));
    await tick();
    expect(calls[calls.length - 1].startsWith('/assets')).toBe(true);
  });
});

describe('Assets tab filter bar — totals and paging stay honest (#825/#834)', () => {
  it('reports the backend total verbatim for a tags filter — no page-scoped narrowing', async () => {
    // Three rows on this page, 42 matching assets in the workspace. The whole
    // point of answering tags server-side: the table never has to drop rows from
    // a page it fetched, so the count it shows is the count that matched.
    const rows = [
      { id: 'a1', name: 'One', status: 'ready', tags: ['news'] },
      { id: 'a2', name: 'Two', status: 'ready', tags: ['news'] },
      { id: 'a3', name: 'Three', status: 'ready', tags: ['news'] },
    ];
    const { apiFetch } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
      search: () => searchEnvelope(rows, 42),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    type(tagsInput(t.el), 'news');
    commit(tagsInput(t.el));
    await tick();

    expect(t.el.querySelectorAll('tbody tr[data-row-key]').length).toBe(3);
    expect(t.state.getState().total).toBe(42);
  });

  it('keeps the tags/metadata params on every page so paging walks the filtered set', async () => {
    const { apiFetch, calls } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
      search: () =>
        searchEnvelope(
          Array.from({ length: 20 }, (_, i) => ({ id: 'a' + i, name: 'A' + i, status: 'ready' })),
          60
        ),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    type(tagsInput(t.el), 'news');
    commit(tagsInput(t.el));
    await tick();
    type(metaInput(t.el), 'genre=documentary');
    commit(metaInput(t.el));
    await tick();

    t.state.nextPage();
    await tick();

    const p = lastCallParams(calls, '/search');
    expect(p.get('page')).toBe('2');
    expect(p.get('tags')).toBe('news');
    expect(p.get('metadata.genre')).toBe('documentary');
  });

  it('resets to the first page when a filter changes', async () => {
    const { apiFetch, calls } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
      search: () =>
        searchEnvelope(
          Array.from({ length: 20 }, (_, i) => ({ id: 'a' + i, name: 'A' + i, status: 'ready' })),
          60
        ),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    type(tagsInput(t.el), 'news');
    commit(tagsInput(t.el));
    await tick();
    t.state.nextPage();
    await tick();
    expect(lastCallParams(calls, '/search').get('page')).toBe('2');

    type(metaInput(t.el), 'genre=documentary');
    commit(metaInput(t.el));
    await tick();
    expect(lastCallParams(calls, '/search').get('page')).toBe('1');
  });
});

describe('Assets tab filter bar — the tier-2 projection gap still holds (#894)', () => {
  it('claims no lock state for rows fetched for a tags filter', async () => {
    // The search projection has no `deleteLock` property (verified in the header
    // block), so lock state is UNKNOWN on this tier — including when the tier was
    // chosen by a tags filter rather than by a free-text term. A `deleteLock` that
    // could not have come from the real projection must still not produce a badge.
    const { apiFetch } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
      search: () =>
        searchEnvelope([
          {
            id: 'a-locked',
            name: 'Locked',
            status: 'ready',
            deleteLock: { locked: true, lockedAt: '2026-01-01T00:00:00.000Z' },
          },
        ]),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    type(tagsInput(t.el), 'news');
    commit(tagsInput(t.el));
    await tick();

    const row = t.el.querySelector('tbody tr[data-row-key="a-locked"]')!;
    expect(row.querySelector('.asset-lock-flag')).toBeNull();
    expect(row.querySelector('.asset-delete-btn')!.getAttribute('data-locked')).toBeNull();
  });

  it('starts on the unknown-lock tier when the URL seeds a tags filter', async () => {
    const { apiFetch } = fakeApi({
      search: () =>
        searchEnvelope([
          {
            id: 'a-locked',
            name: 'Locked',
            status: 'ready',
            deleteLock: { locked: true, lockedAt: '2026-01-01T00:00:00.000Z' },
          },
        ]),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin('?assets.tags=news') });
    document.body.appendChild(t.el);
    await tick();

    expect(
      t.el.querySelector('tbody tr[data-row-key="a-locked"]')!.querySelector('.asset-lock-flag')
    ).toBeNull();
  });
});
