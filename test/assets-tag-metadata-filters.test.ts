// @vitest-environment happy-dom
//
// Component-level tests for the Assets tab's tag + metadata filters (issue #914).
//
// VERIFIED BACKEND CONTRACT (route source + openapi.json, not guessed):
//   - GET /api/v1/search/ is the only tier that can express either filter.
//     `GET /api/v1/assets/` declares limit/offset/status/parentId/from/to and
//     nothing else (`listQuerySchema`, src/routes/assets.ts:373, mirrored at
//     openapi.json .paths["/api/v1/assets/"].get.parameters).
//   - `tags` accepts a repeated param OR one comma-separated list, normalised to a
//     trimmed non-empty array (`tagsSchema`, src/routes/search.ts:139-150;
//     openapi.json .paths["/api/v1/search/"].get.parameters[name=tags] is
//     anyOf[string, string[]]). An asset must carry EVERY listed tag
//     (src/data/search-repo.ts:378-381).
//   - Free-form metadata is filtered with dynamic `metadata.<key>=<value>` params
//     (issue #12), pulled out of the `.passthrough()` querystring by
//     `extractMetadataFilter`, src/routes/search.ts:221-240. Exact value match,
//     every pair required (src/data/search-repo.ts:392-400). Dynamic keys appear
//     in no OpenAPI `parameters` entry — the route source is their contract.
//   - `q` is `.optional()` on `searchQuerySchema` (src/routes/search.ts:155-166),
//     so a tags-only / metadata-only query is first-class and the client must NOT
//     send an empty `q` (the schema is `.min(1)`, i.e. a 400).
//   - Container/MIME (`mimeType`) is explicitly OUT OF SCOPE for #914 (issue #822).

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssetsTable } from '../public/assets-table.js';
import { decodeTableState, encodeTableStateToQuery } from '../public/table-url-state.js';

const deps = () => ({
  renderBadge: (s: string) => '<span class="badge">' + s + '</span>',
  renderTags: () => '',
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

const emptyTiers = () => ({
  assets: () => ({ items: [], total: 0 }),
  search: () => ({ assets: [], collections: [], total: 0, collectionTotal: 0, page: 1 }),
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mount(win = stubWin()) {
  const { apiFetch, calls } = fakeApi(emptyTiers());
  const t = createAssetsTable({ ...deps(), apiFetch, win });
  document.body.appendChild(t.el);
  await tick();
  return { t, calls, win };
}

describe('the filter bar offers tag and metadata controls', () => {
  it('mounts both controls with a visible label and a described accepted shape', async () => {
    const { t } = await mount();

    const tagInput = t.el.querySelector<HTMLInputElement>('.ops-filter-tags input')!;
    const metaInput = t.el.querySelector<HTMLInputElement>('.ops-filter-meta input')!;
    expect(tagInput).toBeTruthy();
    expect(metaInput).toBeTruthy();

    // Accessible name present on each (WCAG 4.1.2).
    expect(tagInput.getAttribute('aria-label')).toBe('Tags');
    expect(metaInput.getAttribute('aria-label')).toBe('Metadata');

    // And the accepted grammar is announced, not left to trial and error: the
    // describedby target must actually exist in the DOM.
    for (const input of [tagInput, metaInput]) {
      const id = input.getAttribute('aria-describedby')!;
      expect(id).toBeTruthy();
      const hint = t.el.querySelector('#' + id);
      expect(hint).toBeTruthy();
      expect((hint as HTMLElement).textContent!.length).toBeGreaterThan(0);
    }
  });

  it('offers no container/MIME control — explicitly out of scope (#822)', async () => {
    const { t } = await mount();
    expect(t.el.querySelector('.ops-filter-mimeType')).toBeNull();
    expect(t.el.querySelector('.ops-filter-mime')).toBeNull();
  });
});

describe('tag filtering from the Assets tab', () => {
  it('routes a tags-only filter to GET /search with a comma-separated tags param and NO empty q', async () => {
    const { t, calls } = await mount();

    t.state.setFilter('tags', 'news,sports');
    await tick();

    const params = lastCallParams(calls, '/search');
    expect(params.get('tags')).toBe('news,sports');
    // `q` is optional; sending '' would be a 400 against `.min(1)`.
    expect(params.has('q')).toBe(false);
    expect(params.get('page')).toBe('1');
  });

  it('drops blank and duplicate tags so the client never sends a tag the server would discard', async () => {
    const { t, calls } = await mount();

    t.state.setFilter('tags', ' news , , news ,sports,');
    await tick();

    expect(lastCallParams(calls, '/search').get('tags')).toBe('news,sports');
  });

  it('combines with the free-text term on one request, not two', async () => {
    const { t, calls } = await mount();

    t.state.setFilter('q', 'hello');
    await tick();
    t.state.setFilter('tags', 'news');
    await tick();

    const params = lastCallParams(calls, '/search');
    expect(params.get('q')).toBe('hello');
    expect(params.get('tags')).toBe('news');
    expect(calls.filter((c) => c.startsWith('/search')).length).toBe(2); // one per state change
  });

  it('falls back to the cheap list tier when the tag box is emptied', async () => {
    const { t, calls } = await mount();

    t.state.setFilter('tags', 'news');
    await tick();
    t.state.setFilter('tags', '');
    await tick();

    expect(calls[calls.length - 1].startsWith('/assets')).toBe(true);
  });

  it('keeps the tag filter on every page so paging walks the filtered set', async () => {
    const { apiFetch, calls } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
      search: () => ({
        assets: Array.from({ length: 20 }, (_v, i) => ({
          id: 's' + i,
          name: 'n' + i,
          status: 'ready',
          createdAt: '2026-02-02T00:00:00Z',
        })),
        collections: [],
        total: 60,
        collectionTotal: 0,
        page: 1,
      }),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    t.state.setFilter('tags', 'news');
    await tick();
    t.state.nextPage();
    await tick();

    const params = lastCallParams(calls, '/search');
    expect(params.get('tags')).toBe('news');
    expect(params.get('page')).toBe('2');
  });
});

describe('metadata filtering from the Assets tab', () => {
  it('sends one metadata.<key>=<value> param per pair', async () => {
    const { t, calls } = await mount();

    t.state.setFilter('meta', 'genre=documentary, language=sv');
    await tick();

    const params = lastCallParams(calls, '/search');
    expect(params.get('metadata.genre')).toBe('documentary');
    expect(params.get('metadata.language')).toBe('sv');
    expect(params.has('q')).toBe(false);
  });

  it('splits only on the first = so a value may contain one', async () => {
    const { t, calls } = await mount();

    t.state.setFilter('meta', 'expr=a=b');
    await tick();

    expect(lastCallParams(calls, '/search').get('metadata.expr')).toBe('a=b');
  });

  it('ignores a half-typed pair rather than sending a filter the grammar cannot carry', async () => {
    const { t, calls } = await mount();

    // No '=' yet: not a filter. Must not reach the search tier at all.
    t.state.setFilter('meta', 'genre');
    await tick();
    expect(calls[calls.length - 1].startsWith('/assets')).toBe(true);

    // A blank key side is equally unsendable.
    t.state.setFilter('meta', '=documentary');
    await tick();
    expect(calls[calls.length - 1].startsWith('/assets')).toBe(true);
  });

  it('keeps an empty value side, because metadata.key= is a real filter', async () => {
    const { t, calls } = await mount();

    t.state.setFilter('meta', 'genre=');
    await tick();

    const params = lastCallParams(calls, '/search');
    expect(params.get('metadata.genre')).toBe('');
  });

  it('combines tags, metadata, status and the created-at range on one search request', async () => {
    const { t, calls } = await mount();

    t.state.setFilter('tags', 'news');
    await tick();
    t.state.setFilter('meta', 'genre=documentary');
    await tick();
    t.state.setFilter('status', 'ready');
    await tick();
    t.state.setFilter('from', '2026-01-01');
    await tick();

    const params = lastCallParams(calls, '/search');
    expect(params.get('tags')).toBe('news');
    expect(params.get('metadata.genre')).toBe('documentary');
    expect(params.get('status')).toBe('ready');
    expect(params.get('from')).toBe('2026-01-01');
    // Out of scope for this issue — and never sent unasked.
    expect(params.has('mimeType')).toBe(false);
  });

  it('reports the backend total verbatim, so paging reflects the filtered set', async () => {
    const { apiFetch } = fakeApi({
      assets: () => ({ items: [], total: 0 }),
      search: () => ({
        assets: [{ id: 's1', name: 'n', status: 'ready', createdAt: '2026-02-02T00:00:00Z' }],
        collections: [],
        total: 42,
        collectionTotal: 7,
        page: 1,
      }),
    });
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    t.state.setFilter('tags', 'news');
    await tick();

    // `total` counts matching ASSETS; `collectionTotal` is a separate count this
    // assets-only table must not fold in.
    expect(t.state.getState().total).toBe(42);
  });
});

describe('URL-state round-trip for the structured filters', () => {
  it('reconstructs both controls from a shared link', async () => {
    const win = stubWin('?assets.tags=news,sports&assets.meta=genre=documentary');
    const { t, calls } = await mount(win);

    const tagInput = t.el.querySelector<HTMLInputElement>('.ops-filter-tags input')!;
    const metaInput = t.el.querySelector<HTMLInputElement>('.ops-filter-meta input')!;
    expect(tagInput.value).toBe('news,sports');
    expect(metaInput.value).toBe('genre=documentary');

    // And the seeded state produced the search-tier request, not the list tier.
    const params = lastCallParams(calls, '/search');
    expect(params.get('tags')).toBe('news,sports');
    expect(params.get('metadata.genre')).toBe('documentary');
  });

  it('writes both filters back into the URL', async () => {
    const { t, win } = await mount();

    t.state.setFilter('tags', 'news');
    await tick();
    t.state.setFilter('meta', 'genre=documentary');
    await tick();

    const applied = decodeURIComponent(win._applied.join('\n'));
    expect(applied).toContain('assets.tags=news');
    expect(applied).toContain('assets.meta=genre=documentary');
  });
});

describe('shared URL-state schema additions', () => {
  it('decodes tags as a de-duped list and meta as key=value pairs', () => {
    const s = decodeTableState('?assets.tags=a,,a,b&assets.meta=k=v,bare,=novalue,k=again', 'assets');
    expect(s.tags).toEqual(['a', 'b']);
    // 'bare' has no '=', '=novalue' has no key, and the second 'k' pair loses to
    // the first (the server keeps only the first value for a repeated key).
    expect(s.meta).toEqual(['k=v']);
  });

  it('omits both params when no filter is set, keeping default links clean', () => {
    expect(encodeTableStateToQuery({ tags: [], meta: [] }, 'assets')).toBe('');
  });

  it('round-trips through encode -> decode unchanged', () => {
    const q = encodeTableStateToQuery({ tags: ['news', 'sports'], meta: ['genre=documentary'] }, 'assets');
    const back = decodeTableState('?' + q, 'assets');
    expect(back.tags).toEqual(['news', 'sports']);
    expect(back.meta).toEqual(['genre=documentary']);
  });
});

// ─── The hint is help text, not a filter caption (issue #983) ────────────────
//
// CONTRACT GROUNDING for the markers asserted here — all internal, all read off
// their source rather than assumed:
//   - the caption hook: `span.className = 'ops-filter-caption'` in
//     public/assets-table.js (statusFilterControl / searchFilterControl /
//     structuredTextFilterControl / dateFilterControl) and in
//     public/logs-table.js labelledControl().
//   - the hint marker: `hint.className = 'form-hint ops-filter-hint'` in
//     structuredTextFilterControl(), public/assets-table.js — a DIRECT CHILD of
//     the control's <label>, exactly like the caption span.
//   - the rules keyed off those markers, in public/style.css:
//     `.ops-table-filters .ops-filter-label, .ops-table-filters .ops-filter-caption
//      { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em }`,
//     `.ops-table-filters .ops-filter-hint { font-size: 11px; font-weight: 400 }`,
//     `.ops-table-filters select, .ops-table-filters input { font-size: 13px;
//      padding: 5px 8px }`, and the issue #946 padding
//     `.ops-table-filters .ops-search-input { padding: 5px 26px }` /
//     `.ops-search-input-plain { padding-left: 8px }`.
//
// The defect this guards: the caption rule used to be keyed structurally
// (`.ops-filter-slot > label > span`), which also matched the hint span, so the
// help sentences rendered as "COMMA-SEPARATED. AN ASSET MUST CARRY EVERY TAG
// LISTED." The assertions resolve against the REAL sheet injected into the real
// mount point, so any future rule that reaches the hint fails here.
describe('filter captions and hints resolve against the real stylesheet', () => {
  const STYLESHEET = readFileSync(resolve(process.cwd(), 'public/style.css'), 'utf8');

  function withStylesheet(): () => void {
    const style = document.createElement('style');
    style.textContent = STYLESHEET;
    document.head.appendChild(style);
    return () => style.remove();
  }

  async function mountStyled() {
    const drop = withStylesheet();
    const { t } = await mount();
    return { t, drop };
  }

  it('marks the caption span and the hint span as different things in the DOM', async () => {
    const { t, drop } = await mountStyled();
    try {
      for (const name of ['tags', 'meta']) {
        const label = t.el.querySelector<HTMLElement>('.ops-filter-' + name)!;
        expect(label.tagName).toBe('LABEL');

        const caption = label.querySelector<HTMLElement>('.ops-filter-caption')!;
        const hint = label.querySelector<HTMLElement>('.ops-filter-hint')!;
        expect(caption).toBeTruthy();
        expect(hint).toBeTruthy();

        // Both are direct children of the same <label>, which is why a structural
        // selector could not tell them apart.
        expect(caption.parentElement).toBe(label);
        expect(hint.parentElement).toBe(label);

        // The hint is NOT a caption: no caption class, and it is the help text
        // referenced by aria-describedby rather than the control's name.
        expect(hint.classList.contains('ops-filter-caption')).toBe(false);
        expect(caption.classList.contains('ops-filter-hint')).toBe(false);
        const input = label.querySelector<HTMLInputElement>('input')!;
        expect(input.getAttribute('aria-describedby')).toBe(hint.id);
      }
      t.destroy();
    } finally {
      drop();
    }
  });

  it('uppercases the caption but leaves the help sentence in sentence case', async () => {
    const { t, drop } = await mountStyled();
    try {
      for (const name of ['tags', 'meta']) {
        const label = t.el.querySelector<HTMLElement>('.ops-filter-' + name)!;
        const caption = label.querySelector<HTMLElement>('.ops-filter-caption')!;
        const hint = label.querySelector<HTMLElement>('.ops-filter-hint')!;

        expect(getComputedStyle(caption).textTransform).toBe('uppercase');
        expect(getComputedStyle(caption).fontSize).toBe('11px');

        // The regression: this resolved to 'uppercase' and shouted the sentence.
        // happy-dom reports an unset inherited property as '' rather than the
        // initial keyword, so accept either spelling of "not transformed".
        const hintTransform = getComputedStyle(hint).textTransform;
        expect(hintTransform).not.toBe('uppercase');
        expect(['', 'none']).toContain(hintTransform);
        expect(getComputedStyle(hint).fontSize).toBe('11px');
      }
      t.destroy();
    } finally {
      drop();
    }
  });

  it('gives every control in the bar the same 13px text (AC2)', async () => {
    const { t, drop } = await mountStyled();
    try {
      const controls = [
        t.el.querySelector<HTMLElement>('.ops-filter-status select')!,
        t.el.querySelector<HTMLElement>('.ops-filter-q input')!,
        t.el.querySelector<HTMLElement>('.ops-filter-tags input')!,
        t.el.querySelector<HTMLElement>('.ops-filter-meta input')!,
        t.el.querySelector<HTMLElement>('.ops-filter-from input')!,
        t.el.querySelector<HTMLElement>('.ops-filter-to input')!,
      ];
      for (const c of controls) {
        expect(c).toBeTruthy();
        // Not the 12px inherited from the caption <label>, which is what made the
        // Assets and Logs bars look smaller than the Jobs one.
        expect(getComputedStyle(c).fontSize).toBe('13px');
      }
      t.destroy();
    } finally {
      drop();
    }
  });

  it('keeps the issue #946 affordance padding on the three search boxes', async () => {
    const { t, drop } = await mountStyled();
    try {
      const q = getComputedStyle(t.el.querySelector<HTMLElement>('.ops-filter-q input')!);
      expect(q.paddingLeft).toBe('26px'); // magnifier
      expect(q.paddingRight).toBe('26px'); // clear control

      for (const name of ['tags', 'meta']) {
        const box = getComputedStyle(t.el.querySelector<HTMLElement>('.ops-filter-' + name + ' input')!);
        expect(box.paddingLeft).toBe('8px'); // no magnifier on these two
        expect(box.paddingRight).toBe('26px'); // clear control still needs its room
      }
      t.destroy();
    } finally {
      drop();
    }
  });
});
