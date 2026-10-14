// @vitest-environment happy-dom
//
// Column visibility on the assets table (issue #959, broken out of #856).
//
// WHAT IS UNDER TEST — three modules, wired together:
//   public/table-columns.js   the model (legal sets, locked toggles), the
//                             localStorage persistence, and the chooser control.
//   public/ops-ui-table.js    mounts the chooser and paints only visible columns.
//   public/assets-table.js    resolves URL -> stored default -> all, and mirrors a
//                             choice back into both.
//
// CONTRACT GROUNDING. Column visibility is VIEW state: no endpoint, param, field
// or response shape is involved, so there is no backend contract to fetch for the
// feature itself. The contracts that ARE load-bearing here are internal, and every
// symbol below is verified against its source rather than assumed:
//   - the `cols` URL param and its null-means-unspecified rule:
//     PARAM_KEYS / BASE_DEFAULTS in public/table-url-state.js.
//   - the declared column keys, the off-by-default subset and the legality group:
//     ASSETS_COLUMN_KEYS / ASSETS_OPTIONAL_COLUMN_KEYS /
//     ASSETS_DEFAULT_COLUMN_KEYS / ASSETS_REQUIRED_COLUMN_GROUPS in
//     public/assets-table.js.
//   - the storage key: columnPrefKey(ns) in public/table-columns.js.
//   - the chooser's mount point and the cascade it has to survive: renderFilters()
//     in public/ops-ui-table.js appends `.ops-columns-slot` into the bar whose
//     class is `ops-table-filters`, so `.ops-table-filters label` in
//     public/style.css applies to every chooser row. The colour tokens asserted
//     below are the :root definitions in public/style.css — `--text: #e2e8f0`,
//     `--text-muted: #94a3b8`.
//   - the request contracts the tests assert stay UNCHANGED under a reduced column
//     set are the ones already grounded in test/assets-table.test.ts:
//     tier 1 GET /api/v1/assets/ (limit/offset/status/from/to; envelope
//     { items, limit, offset, total }) and tier 2 GET /api/v1/search/ (q/page/
//     pageSize/status/from/to; envelope { assets, total, ... }).
//
// The whole point of the feature is that the last of those is untouched: hiding a
// column must not change a single query param, the page window, or the sort.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createAssetsTable,
  ASSETS_COLUMN_KEYS,
  ASSETS_DEFAULT_COLUMN_KEYS,
  ASSETS_OPTIONAL_COLUMN_KEYS,
  ASSETS_REQUIRED_COLUMN_GROUPS,
  ASSETS_NS,
  ASSETS_PAGE_SIZE,
} from '../public/assets-table.js';
import {
  columnPrefKey,
  normalizeVisibleColumns,
  defaultVisibleColumns,
  lockedColumnKeys,
  readStoredColumns,
  writeStoredColumns,
  clearStoredColumns,
  createColumnChooser,
} from '../public/table-columns.js';

const PREF_KEY = columnPrefKey(ASSETS_NS);

const deps = () => ({
  renderBadge: (s: string) => '<span class="badge">' + s + '</span>',
  renderTags: () => '',
  fmtDate: (v: string) => String(v || '—'),
  isAssetWedged: () => false,
});

function rowsFixture(n = 2) {
  return Array.from({ length: n }, (_, i) => ({
    id: 'a' + i,
    slug: 'slug-' + i,
    name: 'Asset ' + i,
    status: 'ready',
    tags: [],
    thumbnails: [],
    createdAt: '2026-01-0' + (i + 1) + 'T00:00:00Z',
  }));
}

function fakeApi(total = 2, rows = rowsFixture()) {
  const calls: string[] = [];
  const apiFetch = vi.fn(async (path: string) => {
    calls.push(path);
    const url = new URL('http://x' + (path.startsWith('/') ? path : '/' + path));
    if (url.pathname === '/assets') return { items: rows, limit: ASSETS_PAGE_SIZE, offset: 0, total };
    if (url.pathname === '/search') return { assets: rows, collections: [], total, collectionTotal: 0, page: 1 };
    // Thumbnail URL resolution (public/thumbnail-url.js) — never reached here
    // because the fixtures carry no thumbnails, but fail loudly if it is.
    throw new Error('unexpected endpoint: ' + url.pathname);
  });
  return { apiFetch, calls };
}

// A stub window: seedable location.search, captured history writes, and the REAL
// localStorage happy-dom provides (so persistence is exercised, not mocked).
function stubWin(search = '') {
  const applied: string[] = [];
  const win = {
    location: { search, pathname: '/', hash: '' },
    history: {
      state: null,
      replaceState: (_s: unknown, _t: string, url: string) => {
        applied.push(url);
        // Keep location.search in step so a later syncUrl() merges into the same
        // URL the previous one produced, exactly as a browser would.
        const q = url.indexOf('?');
        const h = url.indexOf('#');
        win.location.search = q >= 0 ? (h > q ? url.slice(q, h) : url.slice(q)) : '';
      },
      pushState: (_s: unknown, _t: string, url: string) => {
        applied.push(url);
      },
    },
    localStorage: globalThis.localStorage,
    _applied: applied,
  };
  return win;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function headerLabels(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll('thead th')).map((th) => (th.textContent || '').trim());
}

function chooserButton(el: HTMLElement): HTMLButtonElement {
  const btn = el.querySelector('.ops-columns-btn') as HTMLButtonElement | null;
  if (!btn) throw new Error('no column chooser button rendered');
  return btn;
}

function toggleFor(el: HTMLElement, key: string): HTMLInputElement {
  const cb = el.querySelector(
    '.ops-columns-item[data-column="' + key + '"] input'
  ) as HTMLInputElement | null;
  if (!cb) throw new Error('no chooser toggle for column ' + key);
  return cb;
}

// Click a chooser toggle the way an operator does: set .checked, then dispatch.
function setColumn(el: HTMLElement, key: string, visible: boolean) {
  const cb = toggleFor(el, key);
  cb.checked = visible;
  cb.dispatchEvent(new Event('change'));
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  document.body.innerHTML = '';
  localStorage.clear();
  vi.restoreAllMocks();
});

// ─── Model: legal sets and locked toggles ────────────────────────────────────

describe('normalizeVisibleColumns — repairs rather than rejects', () => {
  const columns = ASSETS_COLUMN_KEYS.map((key) => ({ key, label: key }));
  const opts = { requireAtLeastOne: ASSETS_REQUIRED_COLUMN_GROUPS as unknown as string[][] };

  it('treats null/empty as "every declared column"', () => {
    expect(normalizeVisibleColumns(null, columns, opts)).toEqual([...ASSETS_COLUMN_KEYS]);
    expect(normalizeVisibleColumns([], columns, opts)).toEqual([...ASSETS_COLUMN_KEYS]);
  });

  it('returns declared order, not requested order', () => {
    expect(normalizeVisibleColumns(['actions', 'id', 'thumb'], columns, opts)).toEqual([
      'thumb',
      'id',
      'actions',
    ]);
  });

  it('drops keys the table does not declare', () => {
    expect(normalizeVisibleColumns(['id', 'price', 'title'], columns, opts)).toEqual([
      'id',
      'title',
    ]);
  });

  it('repairs a set that would empty the required group', () => {
    // Only non-identifying, non-action columns asked for: the first declared
    // member of the group is restored.
    const out = normalizeVisibleColumns(['thumb', 'status'], columns, opts);
    expect(out).toContain('id');
    expect(out).toEqual(['thumb', 'id', 'status']);
  });

  it('honours hideable: false', () => {
    const pinned = [{ key: 'id', label: 'ID' }, { key: 'status', label: 'Status', hideable: false }];
    expect(normalizeVisibleColumns(['id'], pinned, {})).toEqual(['id', 'status']);
  });
});

describe('lockedColumnKeys — the last survivor is locked, not punished', () => {
  const columns = ASSETS_COLUMN_KEYS.map((key) => ({ key, label: key }));
  const opts = { requireAtLeastOne: ASSETS_REQUIRED_COLUMN_GROUPS as unknown as string[][] };

  it('locks nothing while two group members are visible', () => {
    const locked = lockedColumnKeys(['id', 'actions', 'status'], columns, opts);
    expect(locked.size).toBe(0);
  });

  it('locks the single remaining group member', () => {
    expect([...lockedColumnKeys(['thumb', 'actions'], columns, opts)]).toEqual(['actions']);
    expect([...lockedColumnKeys(['title'], columns, opts)]).toEqual(['title']);
  });

  it('locks a column that opted out of hiding', () => {
    const pinned = [{ key: 'id', label: 'ID' }, { key: 'status', label: 'Status', hideable: false }];
    expect([...lockedColumnKeys(['id', 'status'], pinned, {})]).toEqual(['status']);
  });
});

// ─── Persistence helpers ─────────────────────────────────────────────────────

describe('stored column preference', () => {
  it('round-trips through a namespaced localStorage key', () => {
    expect(writeStoredColumns(ASSETS_NS, ['id', 'title'], window)).toBe(true);
    expect(localStorage.getItem(PREF_KEY)).toBe('["id","title"]');
    expect(readStoredColumns(ASSETS_NS, window)).toEqual(['id', 'title']);
    clearStoredColumns(ASSETS_NS, window);
    expect(readStoredColumns(ASSETS_NS, window)).toBeNull();
  });

  it('treats a corrupt or empty stored value as no preference', () => {
    localStorage.setItem(PREF_KEY, '[not json');
    expect(readStoredColumns(ASSETS_NS, window)).toBeNull();
    localStorage.setItem(PREF_KEY, '[]');
    expect(readStoredColumns(ASSETS_NS, window)).toBeNull();
    localStorage.setItem(PREF_KEY, '   ');
    expect(readStoredColumns(ASSETS_NS, window)).toBeNull();
  });

  it('also accepts a bare comma-separated value (same shape as the URL param)', () => {
    localStorage.setItem(PREF_KEY, 'id,title');
    expect(readStoredColumns(ASSETS_NS, window)).toEqual(['id', 'title']);
  });

  it('survives storage being unavailable', () => {
    const blocked = {
      get localStorage(): Storage {
        throw new Error('blocked by policy');
      },
    } as unknown as Window;
    expect(readStoredColumns(ASSETS_NS, blocked)).toBeNull();
    expect(writeStoredColumns(ASSETS_NS, ['id'], blocked)).toBe(false);
  });
});

// ─── Chooser control ─────────────────────────────────────────────────────────

describe('createColumnChooser', () => {
  it('names a column whose header caption is empty', () => {
    const chooser = createColumnChooser({
      columns: [{ key: 'thumb', label: '', chooserLabel: 'Thumbnail' }, { key: 'id', label: 'ID' }],
      getVisible: () => ['thumb', 'id'],
      onChange: () => {},
    });
    const labels = Array.from(
      chooser.el.querySelectorAll('.ops-columns-item-label')
    ).map((s) => s.textContent);
    expect(labels).toEqual(['Thumbnail', 'ID']);
    chooser.destroy();
  });

  it('opens and closes as a disclosure, and reports state via aria-expanded', () => {
    const chooser = createColumnChooser({
      columns: [{ key: 'id', label: 'ID' }, { key: 'title', label: 'Title' }],
      getVisible: () => ['id', 'title'],
      onChange: () => {},
    });
    document.body.appendChild(chooser.el);
    const btn = chooserButton(chooser.el);
    const panel = chooser.el.querySelector('.ops-columns-panel') as HTMLElement;

    expect(panel.hidden).toBe(true);
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    btn.click();
    expect(panel.hidden).toBe(false);
    expect(btn.getAttribute('aria-expanded')).toBe('true');
    // Escape closes and hands focus back to the button it came from.
    chooser.el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel.hidden).toBe(true);
    expect(document.activeElement).toBe(btn);
    chooser.destroy();
  });

  it('closes on a click outside and stays open on a click inside', () => {
    const chooser = createColumnChooser({
      columns: [{ key: 'id', label: 'ID' }, { key: 'title', label: 'Title' }],
      getVisible: () => ['id', 'title'],
      onChange: () => {},
    });
    document.body.appendChild(chooser.el);
    const panel = chooser.el.querySelector('.ops-columns-panel') as HTMLElement;
    chooserButton(chooser.el).click();
    expect(panel.hidden).toBe(false);
    panel.click();
    expect(panel.hidden).toBe(false);
    document.body.click();
    expect(panel.hidden).toBe(true);
    chooser.destroy();
  });

  it('stops listening on the document once destroyed', () => {
    const chooser = createColumnChooser({
      columns: [{ key: 'id', label: 'ID' }],
      getVisible: () => ['id'],
      onChange: () => {},
    });
    document.body.appendChild(chooser.el);
    chooserButton(chooser.el).click();
    chooser.destroy();
    // No listener left to throw on a detached element.
    expect(() => document.body.click()).not.toThrow();
  });
});

// ─── Assets table: the chooser in place ──────────────────────────────────────

describe('assets table column chooser', () => {
  it('renders the default column set and a Columns control by default', async () => {
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    expect(t.getVisibleColumns()).toEqual([...ASSETS_DEFAULT_COLUMN_KEYS]);
    expect(t.el.querySelectorAll('thead th').length).toBe(ASSETS_DEFAULT_COLUMN_KEYS.length);
    const btn = chooserButton(t.el);
    // The count is part of the button's accessible name so "am I hiding
    // anything?" is answerable without opening the panel — and with off-by-
    // default columns declared (issue #961) the two numbers now differ.
    expect(btn.textContent).toContain('Columns');
    expect(btn.textContent).toContain(
      ASSETS_DEFAULT_COLUMN_KEYS.length + ' of ' + ASSETS_COLUMN_KEYS.length
    );
    // It is a view control, not a filter — it must not be mounted as a filter slot.
    const slot = t.el.querySelector('.ops-columns-slot') as HTMLElement;
    expect(slot.dataset.control).toBe('columns');
    expect(slot.dataset.filter).toBeUndefined();
  });

  it('hiding a column removes its header and its cell from every row', async () => {
    const { apiFetch } = fakeApi(2, rowsFixture(2));
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    expect(headerLabels(t.el)).toContain('Tags');
    const before = t.el.querySelectorAll('tbody tr[data-row-key]')[0].children.length;

    setColumn(t.el, 'tags', false);

    expect(t.getVisibleColumns()).not.toContain('tags');
    expect(headerLabels(t.el)).not.toContain('Tags');
    const rows = t.el.querySelectorAll('tbody tr[data-row-key]');
    expect(rows.length).toBe(2);
    expect(rows[0].children.length).toBe(before - 1);
    // The remaining cells still belong to the columns that are still declared —
    // the Name / Title cell has not shifted onto the Tags renderer. (Default sort
    // is created DESC, so the newest fixture row is first.)
    const a0 = t.el.querySelector('tbody tr[data-row-key="a0"]') as HTMLElement;
    expect(a0.textContent).toContain('Asset 0');
  });

  it('does NOT refetch when a column is hidden', async () => {
    const { apiFetch, calls } = fakeApi();
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();
    const callsBefore = calls.length;

    setColumn(t.el, 'tags', false);
    setColumn(t.el, 'thumb', false);
    await tick();

    // Visibility is view state: the request is byte-identical, so re-issuing it
    // would be a wasted round-trip and a loading flash for a repaint.
    expect(calls.length).toBe(callsBefore);
  });

  it('"Show all" restores every column', async () => {
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    setColumn(t.el, 'tags', false);
    const showAll = t.el.querySelector('.ops-columns-showall') as HTMLButtonElement;
    expect(showAll.disabled).toBe(false);
    showAll.click();
    expect(t.getVisibleColumns()).toEqual([...ASSETS_COLUMN_KEYS]);
    expect(showAll.disabled).toBe(true);
  });

  it('flags a column that is hidden while the table is still sorted by it', async () => {
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    // Default sort is created DESC, so hiding Created leaves an active sort with
    // no visible header. The chooser is where that fact stays reachable.
    setColumn(t.el, 'created', false);
    const item = t.el.querySelector('.ops-columns-item[data-column="created"]') as HTMLElement;
    expect(item.querySelector('.ops-columns-note')?.textContent).toBe('sorted');
    // A visible sorted column carries no such flag.
    setColumn(t.el, 'created', true);
    expect(
      (t.el.querySelector('.ops-columns-item[data-column="created"]') as HTMLElement)
        .querySelector('.ops-columns-note')
    ).toBeNull();
  });
});

// ─── Off-by-default columns (issue #961) ─────────────────────────────────────
//
// CONTRACT GROUNDING for the two new cells — verified against openapi.json in
// this repo, not assumed:
//   `renditions`  openapi.json .paths["/api/v1/assets/"].get.responses["200"]
//                 .content["application/json"].schema.properties.items.items
//                 .properties.renditions — an ARRAY of
//                 { id, label, width, height, objectKey, codec?, bitrateBps? },
//                 optional (absent from that schema's `required`, which is
//                 ['id','name','status','statusHistory','createdAt','updatedAt']).
//                 Also present on the tier-2 projection
//                 (.paths["/api/v1/search/"].get...assets.items.properties).
//                 There is NO `renditionCount` scalar in the spec.
//   `reviewState` the same items schema — a string enum
//                 ['draft','in-review','approved','rejected'], optional, camelCase
//                 (there is no `review_state`). ABSENT from the tier-2 search
//                 projection, whose asset properties are id, name, description,
//                 status, parentId, objectKey, statusHistory, technicalMetadata,
//                 technicalMetadataError, manifestUrls, packagingError,
//                 renditions, metadata, createdAt, updatedAt, type.
//   The "absent reads as draft" rule the tier-1 cell applies is the API's own:
//   `const current = asset.reviewState ?? 'draft'` (src/routes/assets.ts:5938).
//
// `slug`, `id` and `tags` are the issue's other three names. They were already
// declared and already toggleable (#959) AND already in the default view, so
// they are asserted here as still-selectable and still-default rather than moved.

function cellFor(el: HTMLElement, rowKey: string, columnKey: string): HTMLElement {
  const tr = el.querySelector('tbody tr[data-row-key="' + rowKey + '"]') as HTMLElement | null;
  if (!tr) throw new Error('no row ' + rowKey);
  const keys = ASSETS_COLUMN_KEYS.filter((k) => visibleNow(el).includes(k));
  const idx = keys.indexOf(columnKey);
  if (idx < 0) throw new Error('column ' + columnKey + ' is not visible');
  return tr.children[idx] as HTMLElement;
}

// Read the painted column order off the DOM rather than off the table handle, so
// the cell lookup above cannot drift from what is actually on screen.
function visibleNow(el: HTMLElement): string[] {
  // A sorted header carries a direction glyph after its caption; strip it so the
  // caption still maps to a key.
  const labels = headerLabels(el).map((l) => l.replace(/\s*[▲▼]$/, ''));
  const byLabel: Record<string, string> = {
    '': 'thumb',
    ID: 'id',
    Slug: 'slug',
    'Name / Title': 'title',
    Status: 'status',
    Review: 'reviewState',
    Renditions: 'renditions',
    Tags: 'tags',
    Created: 'created',
    Actions: 'actions',
  };
  return labels.map((l) => byLabel[l]);
}

describe('the default set is derived from one declaration', () => {
  it('defaults = declared minus optional', () => {
    expect(ASSETS_DEFAULT_COLUMN_KEYS).toEqual(
      ASSETS_COLUMN_KEYS.filter((k) => !ASSETS_OPTIONAL_COLUMN_KEYS.includes(k))
    );
    // The pre-#961 view, stated literally so a future reordering has to say so.
    expect([...ASSETS_DEFAULT_COLUMN_KEYS]).toEqual([
      'thumb',
      'id',
      'slug',
      'title',
      'status',
      'tags',
      'created',
      'actions',
    ]);
    expect([...ASSETS_OPTIONAL_COLUMN_KEYS]).toEqual(['reviewState', 'renditions']);
  });

  it('defaultVisibleColumns drops opted-out columns but keeps pinned ones', () => {
    const columns = [
      { key: 'id', label: 'ID' },
      { key: 'extra', label: 'Extra', defaultVisible: false },
      { key: 'pinned', label: 'Pinned', defaultVisible: false, hideable: false },
    ];
    expect(defaultVisibleColumns(columns)).toEqual(['id', 'pinned']);
    // A table whose every column opted out is a declaration bug; paint it rather
    // than render a headerless grid.
    expect(
      defaultVisibleColumns([{ key: 'a', label: 'A', defaultVisible: false }])
    ).toEqual(['a']);
  });

  it('no request means the DEFAULT set, an explicit request can still ask for more', () => {
    const columns = [
      { key: 'id', label: 'ID' },
      { key: 'extra', label: 'Extra', defaultVisible: false },
    ];
    expect(normalizeVisibleColumns(null, columns, {})).toEqual(['id']);
    expect(normalizeVisibleColumns([], columns, {})).toEqual(['id']);
    // defaultVisible describes the no-choice case ONLY — asking for the column is
    // exactly how it gets painted.
    expect(normalizeVisibleColumns(['id', 'extra'], columns, {})).toEqual(['id', 'extra']);
    expect(normalizeVisibleColumns(['extra'], columns, {})).toEqual(['extra']);
  });
});

describe('slug, id, rendition count, review state and tags are all selectable', () => {
  it('offers every one of them in the chooser', async () => {
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    for (const key of ['slug', 'id', 'renditions', 'reviewState', 'tags']) {
      expect(() => toggleFor(t.el, key)).not.toThrow();
    }
    // The chooser names the two new ones in words, not in wire keys.
    const labels = Array.from(t.el.querySelectorAll('.ops-columns-item-label')).map(
      (s) => s.textContent
    );
    expect(labels).toContain('Rendition count');
    expect(labels).toContain('Review state');
  });

  it('leaves the default view untouched: the new pair is off, the old three are on', async () => {
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    expect(headerLabels(t.el)).toEqual([
      '',
      'ID',
      'Slug',
      'Name / Title',
      'Status',
      'Tags',
      // The default sort is created DESC, so this header carries its direction
      // glyph — unchanged by #961.
      'Created \u25bc',
      'Actions',
    ]);
    expect(toggleFor(t.el, 'reviewState').checked).toBe(false);
    expect(toggleFor(t.el, 'renditions').checked).toBe(false);
    expect(toggleFor(t.el, 'slug').checked).toBe(true);
    expect(toggleFor(t.el, 'id').checked).toBe(true);
    expect(toggleFor(t.el, 'tags').checked).toBe(true);
    // …and nothing was written anywhere, because nothing was chosen.
    expect(readStoredColumns(ASSETS_NS, window)).toBeNull();
  });

  it('turning one on adds its header in declared position and a cell per row', async () => {
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();
    const widthBefore = t.el.querySelectorAll('tbody tr[data-row-key]')[0].children.length;

    setColumn(t.el, 'renditions', true);

    expect(t.getVisibleColumns()).toContain('renditions');
    // Declared order, not click order: it lands between Review and Tags.
    expect(headerLabels(t.el)).toEqual([
      '',
      'ID',
      'Slug',
      'Name / Title',
      'Status',
      'Renditions',
      'Tags',
      'Created \u25bc',
      'Actions',
    ]);
    const rows = t.el.querySelectorAll('tbody tr[data-row-key]');
    expect(rows[0].children.length).toBe(widthBefore + 1);

    setColumn(t.el, 'renditions', false);
    expect(headerLabels(t.el)).not.toContain('Renditions');
  });

  it('can be turned off again, and off is what persists', async () => {
    const { apiFetch } = fakeApi();
    const win = stubWin();
    const t = createAssetsTable({ ...deps(), apiFetch, win });
    document.body.appendChild(t.el);
    await tick();

    setColumn(t.el, 'reviewState', true);
    expect(readStoredColumns(ASSETS_NS, window)).toContain('reviewState');
    setColumn(t.el, 'reviewState', false);
    expect(readStoredColumns(ASSETS_NS, window)).not.toContain('reviewState');
    expect(t.getVisibleColumns()).toEqual([...ASSETS_DEFAULT_COLUMN_KEYS]);
  });

  it('restores an off-by-default column from the URL and from storage', async () => {
    const { apiFetch } = fakeApi();
    const fromUrl = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.cols=id,reviewState,renditions'),
    });
    document.body.appendChild(fromUrl.el);
    await tick();
    expect(fromUrl.getVisibleColumns()).toEqual(['id', 'reviewState', 'renditions']);
    fromUrl.destroy();

    localStorage.setItem(PREF_KEY, JSON.stringify(['id', 'renditions', 'created']));
    const fromStore = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(fromStore.el);
    await tick();
    expect(fromStore.getVisibleColumns()).toEqual(['id', 'renditions', 'created']);
  });

  it('"Show all" reaches the optional columns too', async () => {
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    const showAll = t.el.querySelector('.ops-columns-showall') as HTMLButtonElement;
    // Not "everything is already shown": two declared columns are off.
    expect(showAll.disabled).toBe(false);
    showAll.click();
    expect(t.getVisibleColumns()).toEqual([...ASSETS_COLUMN_KEYS]);
    expect(showAll.disabled).toBe(true);
  });
});

describe('the new cells render the verified fields', () => {
  const richRows = [
    {
      id: 'a0',
      slug: 'slug-0',
      name: 'Asset 0',
      status: 'ready',
      reviewState: 'approved',
      renditions: [
        { id: 'r1', label: '1080p', width: 1920, height: 1080, objectKey: 'k1' },
        { id: 'r2', label: '720p', width: 1280, height: 720, objectKey: 'k2' },
        { id: 'r3', label: '480p', width: 854, height: 480, objectKey: 'k3' },
      ],
      tags: [],
      thumbnails: [],
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      // No `renditions`, no `reviewState` — both are optional on the verified
      // item schema, and a document written before either field existed is the
      // normal case this has to survive.
      id: 'a1',
      slug: 'slug-1',
      name: 'Asset 1',
      status: 'uploading',
      tags: [],
      thumbnails: [],
      createdAt: '2026-01-02T00:00:00Z',
    },
  ];

  it('counts the renditions ARRAY, and reads an absent array as zero', async () => {
    const { apiFetch } = fakeApi(2, richRows);
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.cols=id,renditions'),
    });
    document.body.appendChild(t.el);
    await tick();

    expect(cellFor(t.el, 'a0', 'renditions').textContent).toBe('3');
    // The PROPERTY is in the tier-1 projection, so absent is a real answer (no
    // renditions on the document), not a projection gap.
    expect(cellFor(t.el, 'a1', 'renditions').textContent).toBe('0');
    // Right-aligned so a column of numbers scans down.
    expect(cellFor(t.el, 'a0', 'renditions').style.textAlign).toBe('right');
  });

  it('renders the review state as its own badge family, not the lifecycle badge', async () => {
    const { apiFetch } = fakeApi(2, richRows);
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.cols=id,reviewState'),
    });
    document.body.appendChild(t.el);
    await tick();

    const badge = cellFor(t.el, 'a0', 'reviewState').querySelector(
      '.review-badge'
    ) as HTMLElement;
    expect(badge.textContent).toBe('Approved');
    expect(badge.dataset.reviewState).toBe('approved');
    expect(badge.classList.contains('review-badge--approved')).toBe(true);
    // Deliberately NOT the `.badge` family the lifecycle status uses — the two
    // axes must not be mistakable for one another (WCAG 1.4.1).
    expect(badge.classList.contains('badge')).toBe(false);
  });

  it('applies the API\'s own "absent reads as draft" rule on the tier that projects the field', async () => {
    const { apiFetch } = fakeApi(2, richRows);
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.cols=id,reviewState'),
    });
    document.body.appendChild(t.el);
    await tick();

    // src/routes/assets.ts:5938 — `asset.reviewState ?? 'draft'`. The list and
    // the detail panel must not disagree about the same asset.
    const badge = cellFor(t.el, 'a1', 'reviewState').querySelector(
      '.review-badge'
    ) as HTMLElement;
    expect(badge.textContent).toBe('Draft');
    expect(badge.dataset.reviewState).toBe('draft');
  });

  it('renders an unrecognised state verbatim rather than guessing', async () => {
    const { apiFetch } = fakeApi(1, [{ ...richRows[0], reviewState: 'embargoed' }]);
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.cols=id,reviewState'),
    });
    document.body.appendChild(t.el);
    await tick();

    const badge = cellFor(t.el, 'a0', 'reviewState').querySelector(
      '.review-badge'
    ) as HTMLElement;
    expect(badge.textContent).toBe('embargoed');
    expect(badge.classList.contains('review-badge--unknown')).toBe(true);
  });

  it('shows UNKNOWN, not Draft, on the free-text tier whose projection omits the field', async () => {
    const { apiFetch, calls } = fakeApi(2, richRows);
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.q=promo&assets.cols=id,reviewState,renditions'),
    });
    document.body.appendChild(t.el);
    await tick();

    expect(calls.some((c) => c.startsWith('/search'))).toBe(true);
    // `assetSchema` (src/routes/search.ts) has no `reviewState`, so claiming
    // "Draft" here would be a promise the payload does not support.
    expect(cellFor(t.el, 'a0', 'reviewState').querySelector('.review-badge')).toBeNull();
    expect(cellFor(t.el, 'a0', 'reviewState').textContent).toBe('—');
    // `renditions` IS in that projection, so the count stays exact on both tiers.
    expect(cellFor(t.el, 'a0', 'renditions').textContent).toBe('3');
  });
});

describe('the new columns do not disturb sort, filter or paging', () => {
  it('adds no query param and no refetch when switched on', async () => {
    const { apiFetch, calls } = fakeApi(60, rowsFixture(2));
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();
    const before = calls.length;
    const paramsBefore = calls[calls.length - 1];

    setColumn(t.el, 'reviewState', true);
    setColumn(t.el, 'renditions', true);
    await tick();

    expect(calls.length).toBe(before);
    expect(calls[calls.length - 1]).toBe(paramsBefore);
    expect(t.state.getState().offset).toBe(0);
  });

  it('leaves the existing sortable columns sorting exactly as before', async () => {
    const { apiFetch } = fakeApi(2, [
      { id: 'a1', slug: 's1', name: 'Zed', status: 'ready', tags: [], thumbnails: [], createdAt: '2026-01-01T00:00:00Z' },
      { id: 'a2', slug: 's2', name: 'Alpha', status: 'ready', tags: [], thumbnails: [], createdAt: '2026-01-02T00:00:00Z' },
    ]);
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    setColumn(t.el, 'reviewState', true);
    setColumn(t.el, 'renditions', true);
    t.state.toggleSort('title');
    await tick();

    expect(
      Array.from(t.el.querySelectorAll('tbody tr[data-row-key]')).map((tr) =>
        tr.getAttribute('data-row-key')
      )
    ).toEqual(['a2', 'a1']);
  });

  it('offers no sort control on either new column', async () => {
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();
    setColumn(t.el, 'reviewState', true);
    setColumn(t.el, 'renditions', true);

    // Neither endpoint takes a `sort` param and applyClientSort knows no axis for
    // these, so a header button here would be a control that does nothing.
    const ths = Array.from(t.el.querySelectorAll('thead th'));
    const labels = ths.map((th) => (th.textContent || '').trim());
    for (const label of ['Review', 'Renditions']) {
      const th = ths[labels.indexOf(label)];
      expect(th.querySelector('button')).toBeNull();
    }
  });

  it('can be the only identifying-adjacent extras without breaking the legality rule', async () => {
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.cols=reviewState,renditions'),
    });
    document.body.appendChild(t.el);
    await tick();

    // Neither new column is identifying or actionable, so the group repair must
    // still restore one — the table can never become a grid of anonymous rows.
    const visible = t.getVisibleColumns();
    expect(ASSETS_REQUIRED_COLUMN_GROUPS[0].some((k) => visible.includes(k))).toBe(true);
    expect(visible).toEqual(['id', 'reviewState', 'renditions']);
  });
});

// ─── The legality rule ───────────────────────────────────────────────────────

describe('actions + the last identifying column can never both be hidden', () => {
  it('locks the last surviving member of the group', async () => {
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    setColumn(t.el, 'id', false);
    setColumn(t.el, 'slug', false);
    setColumn(t.el, 'title', false);

    // Actions is now the only identifying/actionable column left: its toggle is
    // disabled rather than allowed to produce an unusable table.
    expect(t.getVisibleColumns()).toContain('actions');
    expect(toggleFor(t.el, 'actions').disabled).toBe(true);
    // And the panel says why, up front, rather than after a refusal.
    const hint = t.el.querySelector('.ops-columns-hint') as HTMLElement;
    expect(hint.hidden).toBe(false);
    expect(hint.textContent).toContain('Keep at least one of');
    expect(toggleFor(t.el, 'actions').getAttribute('aria-describedby')).toBe(hint.id);
  });

  it('unlocks again as soon as a second group member comes back', async () => {
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    setColumn(t.el, 'id', false);
    setColumn(t.el, 'slug', false);
    setColumn(t.el, 'title', false);
    expect(toggleFor(t.el, 'actions').disabled).toBe(true);

    setColumn(t.el, 'title', true);
    expect(toggleFor(t.el, 'actions').disabled).toBe(false);
    expect(toggleFor(t.el, 'title').disabled).toBe(false);
  });

  it('repairs a hand-crafted URL that would leave the table unusable', async () => {
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.cols=thumb,status'),
    });
    document.body.appendChild(t.el);
    await tick();

    const visible = t.getVisibleColumns();
    expect(visible).toContain('thumb');
    expect(visible).toContain('status');
    // One group member was restored instead of honouring an illegal request.
    expect(ASSETS_REQUIRED_COLUMN_GROUPS[0].some((k) => visible.includes(k))).toBe(true);
  });

  it('never renders a headerless table, whatever the URL says', async () => {
    const { apiFetch } = fakeApi();
    for (const search of ['?assets.cols=', '?assets.cols=,,,', '?assets.cols=nope,alsonope']) {
      const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin(search) });
      document.body.appendChild(t.el);
      await tick();
      expect(t.el.querySelectorAll('thead th').length).toBeGreaterThan(0);
      t.destroy();
    }
  });
});

// ─── Cascade: the chooser lives inside the filter bar ────────────────────────
//
// The chooser mounts into `.ops-table-filters` (public/ops-ui-table.js, the
// `.ops-columns-slot` append in renderFilters), which means every chooser row —
// a <label> — is ALSO matched by `.ops-table-filters label`. That rule is
// (0,1,1) and paints a stacked, muted filter control; a bare `.ops-columns-item`
// is (0,1,0) and silently loses. The first cut of this feature shipped exactly
// that defect: rows rendered as checkbox-over-caption stacks and locked rows were
// indistinguishable from unlocked ones, because BOTH resolved to --text-muted.
//
// Every assertion below is read off the real sheet in the real mount point, so a
// future rule that outranks these selectors fails here instead of in review.
describe('chooser rows resolve against the real stylesheet', () => {
  const STYLESHEET = readFileSync(resolve(process.cwd(), 'public/style.css'), 'utf8');

  function withStylesheet(): () => void {
    const style = document.createElement('style');
    style.textContent = STYLESHEET;
    document.head.appendChild(style);
    return () => style.remove();
  }

  it('renders rows as a row-direction flex line, not a stacked filter control', async () => {
    const drop = withStylesheet();
    try {
      const { apiFetch } = fakeApi();
      const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
      document.body.appendChild(t.el);
      await tick();

      // Sanity: the row really is inside the bar whose rule it has to outrank.
      const row = t.el.querySelector('.ops-columns-item[data-column="tags"]') as HTMLElement;
      expect(row.closest('.ops-table-filters')).not.toBeNull();
      expect(row.tagName).toBe('LABEL');

      const css = getComputedStyle(row);
      expect(css.display).toBe('flex');
      // The defect: `.ops-table-filters label { flex-direction: column }` won and
      // put the caption under the checkbox.
      expect(css.flexDirection).toBe('row');
      expect(css.gap).toBe('8px');
      // --text (#e2e8f0), not the filter bar's --text-muted (#94a3b8).
      expect(css.color).toBe('#e2e8f0');

      t.destroy();
    } finally {
      drop();
    }
  });

  it('paints a locked row muted, visibly distinct from an unlocked one', async () => {
    const drop = withStylesheet();
    try {
      const { apiFetch } = fakeApi();
      const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
      document.body.appendChild(t.el);
      await tick();

      // Drive the table into the state that locks a toggle, rather than faking
      // the class: Actions becomes the last member of the required group.
      setColumn(t.el, 'id', false);
      setColumn(t.el, 'slug', false);
      setColumn(t.el, 'title', false);

      const locked = t.el.querySelector('.ops-columns-item[data-column="actions"]') as HTMLElement;
      const plain = t.el.querySelector('.ops-columns-item[data-column="tags"]') as HTMLElement;
      expect(locked.classList.contains('is-locked')).toBe(true);
      expect(plain.classList.contains('is-locked')).toBe(false);

      const lockedColor = getComputedStyle(locked).color;
      const plainColor = getComputedStyle(plain).color;
      // The defect: both resolved to --text-muted, so "you cannot hide this one"
      // was carried by the disabled checkbox alone and the row read as ordinary.
      expect(lockedColor).not.toBe(plainColor);
      expect(lockedColor).toBe('#94a3b8');
      expect(getComputedStyle(locked).cursor).toBe('not-allowed');

      t.destroy();
    } finally {
      drop();
    }
  });
});

// ─── Persistence: URL wins, storage is the fallback ──────────────────────────

describe('persistence across a reload', () => {
  it('applies a cols param from the URL', async () => {
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.cols=id,title,actions'),
    });
    document.body.appendChild(t.el);
    await tick();

    expect(t.getVisibleColumns()).toEqual(['id', 'title', 'actions']);
    expect(headerLabels(t.el)).toEqual(['ID', 'Name / Title', 'Actions']);
  });

  it('falls back to the stored per-operator default when the URL has no cols', async () => {
    localStorage.setItem(PREF_KEY, JSON.stringify(['id', 'status', 'actions']));
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    expect(t.getVisibleColumns()).toEqual(['id', 'status', 'actions']);
  });

  it('lets the URL beat the stored default', async () => {
    localStorage.setItem(PREF_KEY, JSON.stringify(['id', 'status']));
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.cols=title,created'),
    });
    document.body.appendChild(t.el);
    await tick();

    // Opening a colleague's link must not silently apply your own preference.
    const visible = t.getVisibleColumns();
    expect(visible).toContain('title');
    expect(visible).toContain('created');
    expect(visible).not.toContain('status');
    // …and it must not overwrite the stored default either.
    expect(readStoredColumns(ASSETS_NS, window)).toEqual(['id', 'status']);
  });

  it('writes a toggle to BOTH the stored default and the URL', async () => {
    const { apiFetch } = fakeApi();
    const win = stubWin();
    const t = createAssetsTable({ ...deps(), apiFetch, win });
    document.body.appendChild(t.el);
    await tick();

    setColumn(t.el, 'tags', false);

    const stored = readStoredColumns(ASSETS_NS, window) as string[];
    expect(stored).not.toContain('tags');
    expect(stored).toEqual(t.getVisibleColumns());

    const last = win._applied[win._applied.length - 1];
    const cols = new URL('http://x' + last).searchParams.get(ASSETS_NS + '.cols');
    expect(cols).toBe(t.getVisibleColumns().join(','));
  });

  it('keeps a default view\'s URL clean until a choice is actually made', async () => {
    const { apiFetch } = fakeApi();
    const win = stubWin();
    const t = createAssetsTable({ ...deps(), apiFetch, win });
    document.body.appendChild(t.el);
    await tick();

    // No URL param, no stored preference: there is no choice to record yet.
    const first = win._applied[win._applied.length - 1];
    expect(new URL('http://x' + first).searchParams.get(ASSETS_NS + '.cols')).toBeNull();

    // Toggling a column off and straight back on IS a choice, even though it
    // lands on exactly the default set — absent means "fall back to storage",
    // which is a different instruction.
    (t.el.querySelector('.ops-columns-showall') as HTMLButtonElement).disabled = false;
    setColumn(t.el, 'tags', false);
    setColumn(t.el, 'tags', true);
    const last = win._applied[win._applied.length - 1];
    expect(new URL('http://x' + last).searchParams.get(ASSETS_NS + '.cols')).toBe(
      ASSETS_DEFAULT_COLUMN_KEYS.join(',')
    );
  });

  it('does not lose a URL cols on the next reload-driven URL sync', async () => {
    const { apiFetch } = fakeApi();
    const win = stubWin('?assets.cols=id,title');
    const t = createAssetsTable({ ...deps(), apiFetch, win });
    document.body.appendChild(t.el);
    await tick();

    // encodeTableState clears the whole namespace before rewriting it, so the
    // table has to keep passing `cols` on every sync or its own first load would
    // wipe the param it was opened with.
    t.state.toggleSort('status');
    await tick();
    const last = win._applied[win._applied.length - 1];
    const params = new URL('http://x' + last).searchParams;
    expect(params.get(ASSETS_NS + '.cols')).toBe('id,title');
    expect(t.getVisibleColumns()).toEqual(['id', 'title']);
  });
});

// ─── No coupling to sort / filter / paging ───────────────────────────────────

describe('sort, filter and paging are unaffected by a reduced column set', () => {
  it('sends the same verified query params with columns hidden', async () => {
    const { apiFetch, calls } = fakeApi(60, rowsFixture(2));
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.cols=id,actions&assets.status=ready&assets.from=2026-01-01'),
    });
    document.body.appendChild(t.el);
    await tick();

    const params = new URL('http://x' + calls[calls.length - 1]).searchParams;
    expect(params.get('limit')).toBe(String(ASSETS_PAGE_SIZE));
    expect(params.get('offset')).toBe('0');
    expect(params.get('status')).toBe('ready');
    expect(params.get('from')).toBe('2026-01-01');
    // Status and Created are HIDDEN, and the filters on them still apply — the
    // filter narrows the matched set server-side, it does not depend on a column.
    expect(t.getVisibleColumns()).not.toContain('status');
    expect(t.getVisibleColumns()).not.toContain('created');
  });

  it('still sorts by a hidden column', async () => {
    const { apiFetch } = fakeApi(2, [
      { id: 'a1', slug: 's1', name: 'Zed', status: 'ready', tags: [], thumbnails: [], createdAt: '2026-01-01T00:00:00Z' },
      { id: 'a2', slug: 's2', name: 'Alpha', status: 'ready', tags: [], thumbnails: [], createdAt: '2026-01-02T00:00:00Z' },
    ]);
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    // Sort by title ASC while the Name / Title column is on screen…
    t.state.toggleSort('title');
    await tick();
    const orderVisible = Array.from(t.el.querySelectorAll('tbody tr[data-row-key]')).map((tr) =>
      tr.getAttribute('data-row-key')
    );
    expect(orderVisible).toEqual(['a2', 'a1']); // Alpha before Zed

    // …then hide it. The rows keep that order: hiding a column changes what is
    // painted, never how the page is ordered.
    setColumn(t.el, 'title', false);
    const orderHidden = Array.from(t.el.querySelectorAll('tbody tr[data-row-key]')).map((tr) =>
      tr.getAttribute('data-row-key')
    );
    expect(orderHidden).toEqual(['a2', 'a1']);
  });

  it('does not reset the page window when a column is hidden', async () => {
    const { apiFetch, calls } = fakeApi(60, rowsFixture(2));
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    t.state.nextPage();
    await tick();
    expect(t.state.getState().offset).toBe(ASSETS_PAGE_SIZE);
    const callsBefore = calls.length;

    setColumn(t.el, 'tags', false);
    await tick();

    // Every real filter resets paging via state.setFilter(); the chooser must not,
    // because it is not a filter and nothing about the current page changed.
    expect(t.state.getState().offset).toBe(ASSETS_PAGE_SIZE);
    expect(calls.length).toBe(callsBefore);
  });

  it('keeps the pagination chrome spanning the reduced table', async () => {
    const { apiFetch } = fakeApi(0, []);
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.cols=id,actions'),
    });
    document.body.appendChild(t.el);
    await tick();

    // The empty-state row spans the columns actually on screen, not the declared
    // eight, so it cannot overflow the table it sits in.
    const td = t.el.querySelector('tbody .ops-table-empty td') as HTMLTableCellElement;
    expect(td.colSpan).toBe(2);
  });

  it('still routes to the free-text tier with columns hidden', async () => {
    const { apiFetch, calls } = fakeApi(1, rowsFixture(1));
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.q=promo&assets.cols=id,title'),
    });
    document.body.appendChild(t.el);
    await tick();

    const hit = calls.find((c) => c.startsWith('/search'));
    expect(hit).toBeTruthy();
    const params = new URL('http://x' + hit).searchParams;
    expect(params.get('q')).toBe('promo');
    expect(params.get('pageSize')).toBe(String(ASSETS_PAGE_SIZE));
    expect(t.getVisibleColumns()).toEqual(['id', 'title']);
  });
});
