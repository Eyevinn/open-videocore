// @vitest-environment happy-dom
//
// Column visibility chooser for the assets table (issue #959, broken out of
// #856).
//
// There is NO backend contract in scope here, and that is the point: column
// visibility is presentation state. It never becomes a query param, it never
// resets paging, and it never touches the sort the state hook is holding. The
// tests below assert exactly that separation alongside the feature itself.
//
// Verified symbols under test (read from source, not assumed):
//   public/column-chooser.js   createColumnChooser, resolveVisibleColumns,
//                              normalizeColumnSelection, isSelectionValid,
//                              lockedColumnKeys, readStoredColumns,
//                              writeStoredColumns, columnStorageKey,
//                              COLUMN_STORAGE_PREFIX
//   public/table-url-state.js  decodeTableState, hasTableParam, PARAM_KEYS.cols
//   public/ops-ui-table.js     createOpsTable({ toolbar }), table.setColumns()
//   public/assets-table.js     createAssetsTable, ASSETS_COLUMN_KEYS,
//                              ASSETS_DEFAULT_COLUMN_KEYS,
//                              ASSETS_ANCHOR_COLUMN_KEYS
//
// The persistence model mirrors the one #368/#373 established for
// sort/filter/paging: the URL is the shareable source of truth, and a stored
// per-operator default only fills in when the URL is silent.

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createAssetsTable,
  ASSETS_COLUMN_KEYS,
  ASSETS_DEFAULT_COLUMN_KEYS,
  ASSETS_ANCHOR_COLUMN_KEYS,
} from '../public/assets-table.js';
import {
  createColumnChooser,
  resolveVisibleColumns,
  normalizeColumnSelection,
  isSelectionValid,
  lockedColumnKeys,
  readStoredColumns,
  writeStoredColumns,
  columnStorageKey,
  COLUMN_STORAGE_PREFIX,
} from '../public/column-chooser.js';
import { decodeTableState } from '../public/table-url-state.js';

// ─── Harness (mirrors test/assets-table.test.ts) ─────────────────────────────

const deps = () => ({
  renderBadge: (s: string) => '<span class="badge">' + s + '</span>',
  renderTags: () => '',
  fmtDate: (v: string) => String(v || '—'),
  isAssetWedged: () => false,
});

const ROW = {
  id: 'a1',
  slug: 'one',
  name: 'One',
  status: 'ready',
  createdAt: '2026-01-01T00:00:00Z',
};

function fakeApi(items: unknown[] = [ROW], total = 1) {
  const calls: string[] = [];
  const apiFetch = vi.fn(async (path: string) => {
    calls.push(path);
    if (path.startsWith('/search')) return { assets: items, total, page: 1 };
    return { items, total };
  });
  return { apiFetch, calls };
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

// An in-memory Storage stand-in. Injected everywhere so a test never depends on
// (or pollutes) the ambient localStorage.
function fakeStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    _map: map,
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function headerLabels(el: HTMLElement): string[] {
  return [...el.querySelectorAll('thead th')].map((th) => (th.textContent || '').trim());
}

function chooserInput(el: HTMLElement, key: string): HTMLInputElement {
  const input = el.querySelector<HTMLInputElement>(
    '.ops-column-chooser input[data-column-key="' + key + '"]'
  );
  if (!input) throw new Error('no chooser checkbox for column ' + key);
  return input;
}

// Simulate an operator ticking/unticking one checkbox.
function toggleColumn(el: HTMLElement, key: string, checked: boolean) {
  const input = chooserInput(el, key);
  input.checked = checked;
  input.dispatchEvent(new Event('change'));
}

// The last URL the table pushed into history, decoded through the shared
// contract — i.e. what a colleague would actually receive if the link were
// pasted to them.
function lastUrlState(win: ReturnType<typeof stubWin>) {
  const last = win._applied[win._applied.length - 1] || '';
  return decodeTableState(last, 'assets', { cols: null });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ─── Selection logic (pure) ──────────────────────────────────────────────────

describe('column selection logic', () => {
  const ALL = ['thumb', 'id', 'slug', 'title', 'status', 'tags', 'created', 'actions'];
  const ANCHORS = ['id', 'slug', 'title', 'actions'];

  it('normalizes a selection into the table\'s own column order and drops unknowns', () => {
    // Order is the table's, not the caller's: this chooser controls visibility
    // only, so a hand-edited URL can never produce a surprising layout.
    expect(normalizeColumnSelection(['actions', 'id', 'nope', 'id'], ALL)).toEqual([
      'id',
      'actions',
    ]);
    expect(normalizeColumnSelection(null, ALL)).toEqual([]);
  });

  it('rejects a selection with no anchor column left', () => {
    expect(isSelectionValid(['thumb', 'status'], ANCHORS)).toBe(false);
    expect(isSelectionValid(['thumb', 'title'], ANCHORS)).toBe(true);
    expect(isSelectionValid([], ANCHORS)).toBe(false);
    // A table that declares no invariant accepts anything non-empty.
    expect(isSelectionValid(['thumb'], [])).toBe(true);
  });

  it('locks exactly the last remaining anchor column, and nothing before that', () => {
    expect(lockedColumnKeys(ALL, ANCHORS)).toEqual([]);
    expect(lockedColumnKeys(['title', 'actions', 'status'], ANCHORS)).toEqual([]);
    // Last identifying column, actions already hidden.
    expect(lockedColumnKeys(['thumb', 'title'], ANCHORS)).toEqual(['title']);
    // Mirror image: actions is all that is left.
    expect(lockedColumnKeys(['thumb', 'status', 'actions'], ANCHORS)).toEqual(['actions']);
  });

  it('resolves URL first, then the stored default, then the table default', () => {
    const base = { allKeys: ALL, defaultKeys: ALL, anchorKeys: ANCHORS };
    expect(
      resolveVisibleColumns({ ...base, urlCols: ['id', 'status'], storedCols: ['title'] })
    ).toEqual(['id', 'status']);
    expect(resolveVisibleColumns({ ...base, urlCols: null, storedCols: ['title'] })).toEqual([
      'title',
    ]);
    expect(resolveVisibleColumns({ ...base, urlCols: null, storedCols: null })).toEqual(ALL);
  });

  it('falls through a candidate that is unusable rather than rendering a broken table', () => {
    const base = { allKeys: ALL, defaultKeys: ALL, anchorKeys: ANCHORS };
    // Hand-edited nonsense, and a stale stored value naming only dropped columns.
    expect(resolveVisibleColumns({ ...base, urlCols: ['nope'], storedCols: ['id'] })).toEqual([
      'id',
    ]);
    // A URL that names only non-anchor columns breaks the invariant -> next source.
    expect(
      resolveVisibleColumns({ ...base, urlCols: ['thumb', 'status'], storedCols: null })
    ).toEqual(ALL);
  });
});

// ─── Stored per-operator default ─────────────────────────────────────────────

describe('stored column default', () => {
  it('namespaces the key per table under the app\'s ovc_ prefix', () => {
    expect(columnStorageKey('assets')).toBe(COLUMN_STORAGE_PREFIX + 'assets');
    expect(columnStorageKey('assets')).not.toBe(columnStorageKey('jobs'));
  });

  it('round-trips a selection', () => {
    const store = fakeStorage();
    writeStoredColumns('assets', ['id', 'title'], store);
    expect(readStoredColumns('assets', store)).toEqual(['id', 'title']);
  });

  it('reads nothing usable as null rather than an empty set', () => {
    expect(readStoredColumns('assets', fakeStorage())).toBeNull();
    expect(readStoredColumns('assets', fakeStorage({ ovc_cols_assets: '' }))).toBeNull();
    expect(readStoredColumns('assets', fakeStorage({ ovc_cols_assets: ' , , ' }))).toBeNull();
  });

  it('never throws when storage is unavailable or refuses the write', () => {
    // Privacy modes throw on access; a full quota throws on write. Losing a
    // preference must never break a click.
    const hostile = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('denied');
      },
    };
    expect(readStoredColumns('assets', hostile)).toBeNull();
    expect(writeStoredColumns('assets', ['id'], hostile)).toBe(false);
  });
});

// ─── Chooser control ─────────────────────────────────────────────────────────

describe('createColumnChooser', () => {
  const COLUMNS = [
    { key: 'thumb', label: '', chooserLabel: 'Thumbnail' },
    { key: 'id', label: 'ID' },
    { key: 'title', label: 'Name / Title' },
    { key: 'status', label: 'Status' },
    { key: 'actions', label: 'Actions' },
  ];
  const ANCHORS = ['id', 'title', 'actions'];

  function mountChooser(visible: string[], onChange = vi.fn()) {
    const c = createColumnChooser({
      columns: COLUMNS,
      visible,
      anchorKeys: ANCHORS,
      onChange,
    });
    document.body.appendChild(c.el);
    return { c, onChange };
  }

  it('names every column, including one whose table header is blank', () => {
    const { c } = mountChooser(COLUMNS.map((x) => x.key));
    const labels = [...c.el.querySelectorAll('.ops-column-chooser-item span')].map(
      (s) => s.textContent
    );
    expect(labels).toEqual(['Thumbnail', 'ID', 'Name / Title', 'Status', 'Actions']);
  });

  it('emits the new set in table order when a column is unticked', () => {
    const { c, onChange } = mountChooser(COLUMNS.map((x) => x.key));
    toggleColumn(c.el, 'status', false);
    expect(onChange).toHaveBeenCalledWith(['thumb', 'id', 'title', 'actions']);
    expect(c.getVisible()).toEqual(['thumb', 'id', 'title', 'actions']);
  });

  it('locks the last anchor column so the invalid state is unreachable', () => {
    const { c, onChange } = mountChooser(COLUMNS.map((x) => x.key));
    toggleColumn(c.el, 'actions', false);
    toggleColumn(c.el, 'id', false);
    // Only `title` identifies a row now, and actions is gone: it must lock.
    expect(chooserInput(c.el, 'title').disabled).toBe(true);
    expect(chooserInput(c.el, 'status').disabled).toBe(false);
    onChange.mockClear();

    // Even if something bypasses `disabled`, no invalid set is ever emitted.
    const locked = chooserInput(c.el, 'title');
    locked.checked = false;
    locked.dispatchEvent(new Event('change'));
    expect(onChange).not.toHaveBeenCalled();
    expect(c.getVisible()).toEqual(['thumb', 'title', 'status']);
    expect(locked.checked).toBe(true);
  });

  it('releases the lock as soon as a second anchor comes back', () => {
    const { c } = mountChooser(['title', 'status']);
    expect(chooserInput(c.el, 'title').disabled).toBe(true);
    toggleColumn(c.el, 'actions', true);
    expect(chooserInput(c.el, 'title').disabled).toBe(false);
    expect(chooserInput(c.el, 'actions').disabled).toBe(false);
  });

  it('explains the lock in text, not just by disabling a control', () => {
    const { c } = mountChooser(['title', 'status']);
    const hint = c.el.querySelector('.ops-column-chooser-hint');
    expect(hint!.textContent).toMatch(/at least one/i);
    const row = chooserInput(c.el, 'title').closest('.ops-column-chooser-item');
    expect(row!.getAttribute('title')).toMatch(/at least one/i);
  });

  it('shows how many columns of the total are visible', () => {
    const { c } = mountChooser(['id', 'title']);
    expect(c.el.querySelector('.ops-column-chooser-count')!.textContent!.trim()).toBe('2/5');
  });
});

// ─── Assets table integration ────────────────────────────────────────────────

describe('assets table — column chooser wiring', () => {
  it('declares one chooser entry per rendered column, with all columns visible by default', async () => {
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin(),
      storage: fakeStorage(),
    });
    document.body.appendChild(t.el);
    await tick();

    expect(t.getVisibleColumns()).toEqual([...ASSETS_DEFAULT_COLUMN_KEYS]);
    // The key list and the actual column definitions cannot drift apart.
    expect(t.el.querySelectorAll('thead th').length).toBe(ASSETS_COLUMN_KEYS.length);
    expect(
      [...t.el.querySelectorAll<HTMLInputElement>('.ops-column-chooser input')].map(
        (i) => i.dataset.columnKey
      )
    ).toEqual([...ASSETS_COLUMN_KEYS]);
    expect(t.el.querySelectorAll('tbody tr[data-row-key] td').length).toBe(
      ASSETS_COLUMN_KEYS.length
    );
  });

  it('hides a column from the header AND the rows when it is unticked', async () => {
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin(),
      storage: fakeStorage(),
    });
    document.body.appendChild(t.el);
    await tick();

    expect(headerLabels(t.el)).toContain('Tags');
    toggleColumn(t.el, 'tags', false);

    expect(headerLabels(t.el)).not.toContain('Tags');
    expect(t.getVisibleColumns()).not.toContain('tags');
    expect(t.el.querySelectorAll('tbody tr[data-row-key] td').length).toBe(
      ASSETS_COLUMN_KEYS.length - 1
    );
  });

  it('re-projects the rows in hand instead of refetching', async () => {
    // Column visibility is not a query input. A chooser click that hit the API
    // would be a bug — it would also reset nothing and cost a round-trip.
    const { apiFetch, calls } = fakeApi();
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin(),
      storage: fakeStorage(),
    });
    document.body.appendChild(t.el);
    await tick();
    const before = calls.length;

    toggleColumn(t.el, 'slug', false);
    await tick();

    expect(calls.length).toBe(before);
    expect(t.el.querySelectorAll('tbody tr[data-row-key]').length).toBe(1);
  });

  it('keeps row actions working after the columns change', async () => {
    // setColumns() rebuilds the tbody, so the row handlers have to be re-wired —
    // otherwise Archive silently stops responding on a re-projected table.
    const onDelete = vi.fn(async () => false);
    const onRowClick = vi.fn();
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      onDelete,
      onRowClick,
      win: stubWin(),
      storage: fakeStorage(),
    });
    document.body.appendChild(t.el);
    await tick();

    toggleColumn(t.el, 'thumb', false);

    t.el.querySelector<HTMLButtonElement>('tbody .asset-delete-btn')!.click();
    await tick();
    expect(onDelete).toHaveBeenCalledWith('a1', 'One', { locked: false });

    t.el.querySelector<HTMLElement>('tbody tr[data-row-key]')!.click();
    expect(onRowClick).toHaveBeenCalled();
  });
});

// ─── Persistence: URL when present, stored default otherwise ─────────────────

describe('assets table — column choice persists across a reload', () => {
  it('writes the reduced set into the URL under the shared namespaced contract', async () => {
    const { apiFetch } = fakeApi();
    const win = stubWin();
    const t = createAssetsTable({ ...deps(), apiFetch, win, storage: fakeStorage() });
    document.body.appendChild(t.el);
    await tick();

    toggleColumn(t.el, 'tags', false);
    toggleColumn(t.el, 'thumb', false);

    expect(lastUrlState(win).cols).toEqual(['id', 'slug', 'title', 'status', 'created', 'actions']);
  });

  it('leaves the URL free of a cols param while the default set is shown', async () => {
    // Consistent with the rest of the contract: "no query params" stays a valid
    // canonical representation of the default view.
    const { apiFetch } = fakeApi();
    const win = stubWin();
    const t = createAssetsTable({ ...deps(), apiFetch, win, storage: fakeStorage() });
    document.body.appendChild(t.el);
    await tick();

    expect(win._applied.join('\n')).not.toContain('assets.cols');

    toggleColumn(t.el, 'tags', false);
    expect(win._applied[win._applied.length - 1]).toContain('assets.cols');

    toggleColumn(t.el, 'tags', true);
    expect(win._applied[win._applied.length - 1]).not.toContain('assets.cols');
  });

  it('also stores the choice as this operator\'s default', async () => {
    const { apiFetch } = fakeApi();
    const storage = fakeStorage();
    const t = createAssetsTable({ ...deps(), apiFetch, win: stubWin(), storage });
    document.body.appendChild(t.el);
    await tick();

    toggleColumn(t.el, 'status', false);
    expect(readStoredColumns('assets', storage)).toEqual(
      ASSETS_COLUMN_KEYS.filter((k) => k !== 'status')
    );
  });

  it('restores the column set from the URL on a fresh mount', async () => {
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.cols=id,title,actions'),
      storage: fakeStorage(),
    });
    document.body.appendChild(t.el);
    await tick();

    expect(t.getVisibleColumns()).toEqual(['id', 'title', 'actions']);
    expect(headerLabels(t.el)).toEqual(['ID', 'Name / Title', 'Actions']);
  });

  it('restores the stored default when the URL says nothing about columns', async () => {
    const { apiFetch } = fakeApi();
    const storage = fakeStorage({ ovc_cols_assets: 'id,status,actions' });
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      // A URL carrying OTHER table state, but no cols — the stored default still
      // applies, because the two sources are independent.
      win: stubWin('?assets.page=2'),
      storage,
    });
    document.body.appendChild(t.el);
    await tick();

    expect(t.getVisibleColumns()).toEqual(['id', 'status', 'actions']);
  });

  it('lets a shared link override the recipient\'s stored default', async () => {
    // The whole reason the URL wins: a link must reproduce the SENDER's view.
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.cols=thumb,title'),
      storage: fakeStorage({ ovc_cols_assets: 'id,actions' }),
    });
    document.body.appendChild(t.el);
    await tick();

    expect(t.getVisibleColumns()).toEqual(['thumb', 'title']);
  });

  it('falls back to every column when both sources are unusable', async () => {
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.cols=made,up,keys'),
      storage: fakeStorage({ ovc_cols_assets: 'also,gone' }),
    });
    document.body.appendChild(t.el);
    await tick();

    expect(t.getVisibleColumns()).toEqual([...ASSETS_DEFAULT_COLUMN_KEYS]);
    expect(t.el.querySelector('tbody tr[data-row-key]')).not.toBeNull();
  });

  it('refuses a URL that would leave rows unidentifiable and unactionable', async () => {
    // Hand-edited `cols` cannot smuggle in the state the chooser forbids.
    const { apiFetch } = fakeApi();
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin('?assets.cols=thumb,status,tags'),
      storage: fakeStorage(),
    });
    document.body.appendChild(t.el);
    await tick();

    expect(
      ASSETS_ANCHOR_COLUMN_KEYS.some((k) => t.getVisibleColumns().includes(k))
    ).toBe(true);
  });
});

// ─── No coupling to sort / filter / paging ───────────────────────────────────

describe('assets table — sort, filter and paging are unaffected by hidden columns', () => {
  function manyRows(n: number) {
    return Array.from({ length: n }, (_v, i) => ({
      id: 'a' + i,
      slug: 's' + i,
      name: 'n' + i,
      status: 'ready',
      createdAt: '2026-01-01T00:00:00Z',
    }));
  }

  function params(calls: string[], prefix: string) {
    const hit = [...calls].reverse().find((c) => c.startsWith(prefix));
    if (!hit) throw new Error('no call matching ' + prefix + ' in ' + JSON.stringify(calls));
    return new URL('http://x' + hit).searchParams;
  }

  it('never sends a column key to either backend tier', async () => {
    const { apiFetch, calls } = fakeApi(manyRows(20), 60);
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin(),
      storage: fakeStorage(),
    });
    document.body.appendChild(t.el);
    await tick();

    toggleColumn(t.el, 'tags', false);
    t.state.setFilter('status', 'ready');
    await tick();
    t.state.setFilter('q', 'news');
    await tick();

    const list = params(calls, '/assets');
    const search = params(calls, '/search');
    for (const p of [list, search]) {
      expect(p.get('cols')).toBeNull();
      expect(p.get('columns')).toBeNull();
    }
    expect(search.get('q')).toBe('news');
    expect(search.get('status')).toBe('ready');
  });

  it('keeps an active sort — including one on a column that is now hidden', async () => {
    const { apiFetch } = fakeApi(manyRows(3), 3);
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin(),
      storage: fakeStorage(),
    });
    document.body.appendChild(t.el);
    await tick();

    t.state.toggleSort('title'); // asc
    await tick();
    const sortBefore = t.state.getState().sort;

    toggleColumn(t.el, 'title', false);

    // The sort survives the column going away: it is query/state, not chrome.
    expect(t.state.getState().sort).toEqual(sortBefore);
    expect(t.el.querySelector('.ops-th-sort[data-sort-key="title"]')).toBeNull();
    // ...and it comes straight back with the column.
    toggleColumn(t.el, 'title', true);
    expect(t.el.querySelector('.ops-th-sort[data-sort-key="title"]')).not.toBeNull();
  });

  it('does not reset paging when the column set changes', async () => {
    const { apiFetch, calls } = fakeApi(manyRows(20), 60);
    const t = createAssetsTable({
      ...deps(),
      apiFetch,
      win: stubWin(),
      storage: fakeStorage(),
    });
    document.body.appendChild(t.el);
    await tick();

    t.state.nextPage();
    await tick();
    expect(t.state.getState().offset).toBe(20);

    toggleColumn(t.el, 'thumb', false);
    expect(t.state.getState().offset).toBe(20);

    t.state.nextPage();
    await tick();
    expect(params(calls, '/assets').get('offset')).toBe('40');
  });

  it('keeps paging over a filtered set working with a reduced column set', async () => {
    const { apiFetch, calls } = fakeApi(manyRows(20), 60);
    const win = stubWin('?assets.cols=id,status,actions');
    const t = createAssetsTable({ ...deps(), apiFetch, win, storage: fakeStorage() });
    document.body.appendChild(t.el);
    await tick();

    t.state.setFilter('status', 'ready');
    await tick();
    t.state.setFilter('from', '2026-01-01');
    await tick();
    t.state.nextPage();
    await tick();

    const p = params(calls, '/assets');
    expect(p.get('status')).toBe('ready');
    expect(p.get('from')).toBe('2026-01-01');
    expect(p.get('offset')).toBe('20');
    expect(t.state.getState().total).toBe(60);
    // The reduced set rides along in the same URL as the filter + page.
    const url = lastUrlState(win);
    expect(url.cols).toEqual(['id', 'status', 'actions']);
    expect(url.status).toEqual(['ready']);
    expect(url.page).toBe(2);
  });
});
