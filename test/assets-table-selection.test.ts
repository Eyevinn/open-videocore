// @vitest-environment happy-dom
//
// Component-level tests for the assets-table's bulk-selection column (issue
// #916) — the half of the feature that lets the Assets tab be the STARTING
// point for an action, rather than the collection detail.
//
// These assert behaviour, not markup: that selection is opt-in, that it
// survives the repaints a real operator causes (sort, filter, page), that it
// never hijacks the row-click that opens the detail panel, and that the column
// chooser cannot hide the control an active selection depends on.
//
// Backend contract is not exercised here — this module only reads the list/
// search tiers it already read (GET /api/v1/assets/, GET /api/v1/search/,
// pinned in test/assets-table.test.ts). The write path these selections feed is
// covered in test/assets-bulk-add-to-collection.test.ts.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createAssetsTable, ASSETS_SELECT_COLUMN_KEY } from '../public/assets-table.js';

const deps = () => ({
  renderBadge: (s: string) => '<span class="badge">' + s + '</span>',
  renderTags: () => '',
  fmtDate: (v: string) => String(v || '—'),
  isAssetWedged: () => false,
});

function stubWin(search = '') {
  const applied: string[] = [];
  return {
    location: { search, pathname: '/', hash: '' },
    history: {
      state: null,
      replaceState: (_s: unknown, _t: string, url: string) => applied.push(url),
      pushState: (_s: unknown, _t: string, url: string) => applied.push(url),
    },
    _applied: applied,
  };
}

// Two fixed pages of assets, so paging can be observed moving the rows under a
// live selection. `createdAt` values are DISTINCT and descending on purpose:
// the table's default sort is created-desc and it re-sorts the page
// client-side, so equal timestamps would make the on-screen row order (and
// therefore which box is `boxes(t)[0]`) an implementation detail rather than
// something these tests can name.
const PAGES: Record<string, Array<{ id: string; name: string; status: string; createdAt: string }>> =
  {
    '0': [
      { id: 'a1', name: 'One', status: 'ready', createdAt: '2026-01-03T00:00:00Z' },
      { id: 'a2', name: 'Two', status: 'ready', createdAt: '2026-01-02T00:00:00Z' },
    ],
    '20': [{ id: 'a3', name: 'Three', status: 'ready', createdAt: '2026-01-01T00:00:00Z' }],
  };

function pagedApi() {
  const apiFetch = vi.fn(async (path: string) => {
    const url = new URL('http://x' + path);
    if (url.pathname.startsWith('/search')) {
      return {
        assets: [{ id: 'a9', name: 'Nine', status: 'ready', createdAt: '2026-01-04T00:00:00Z' }],
        collections: [],
        total: 1,
        page: 1,
      };
    }
    const offset = url.searchParams.get('offset') || '0';
    return {
      items: PAGES[offset] || [],
      // Larger than one page so the primitive's `canNext()` is true and these
      // tests can actually page; the fixture pages themselves are kept short.
      total: 40,
      limit: 20,
      offset: Number(offset),
    };
  });
  return apiFetch;
}

const tick = () => new Promise((r) => setTimeout(r, 0));

function boxes(t: { el: HTMLElement }) {
  return [...t.el.querySelectorAll('tbody .asset-select-box')] as HTMLInputElement[];
}

function tickBox(box: HTMLInputElement, checked = true) {
  box.checked = checked;
  box.dispatchEvent(new Event('change', { bubbles: true }));
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('selection column is opt-in', () => {
  it('renders no tick boxes unless the consumer asks for them', async () => {
    const t = createAssetsTable({ ...deps(), apiFetch: pagedApi(), win: stubWin() });
    document.body.appendChild(t.el);
    await tick();

    expect(boxes(t).length).toBe(0);
    expect(t.getVisibleColumns()).not.toContain(ASSETS_SELECT_COLUMN_KEY);
  });

  it('renders one tick box per row, as the leading column, when selectable', async () => {
    const t = createAssetsTable({
      ...deps(),
      apiFetch: pagedApi(),
      win: stubWin(),
      selectable: true,
    });
    document.body.appendChild(t.el);
    await tick();

    expect(boxes(t).length).toBe(2);
    expect(t.getVisibleColumns()[0]).toBe(ASSETS_SELECT_COLUMN_KEY);
    // Each box carries a name, not just a value (WCAG 4.1.2).
    expect(boxes(t)[0].getAttribute('aria-label')).toBe('Select One');
  });
});

describe('selection bookkeeping', () => {
  it('reports ticked assets with their human-readable label', async () => {
    const changes: Array<Array<{ id: string; label: string }>> = [];
    const t = createAssetsTable({
      ...deps(),
      apiFetch: pagedApi(),
      win: stubWin(),
      selectable: true,
      onSelectionChange: (s: Array<{ id: string; label: string }>) => changes.push(s),
    });
    document.body.appendChild(t.el);
    await tick();

    tickBox(boxes(t)[0]);
    expect(t.getSelectedIds()).toEqual(['a1']);
    expect(t.getSelection()).toEqual([{ id: 'a1', label: 'One' }]);
    expect(changes.at(-1)).toEqual([{ id: 'a1', label: 'One' }]);

    tickBox(boxes(t)[1]);
    expect(t.getSelectedIds()).toEqual(['a1', 'a2']);

    tickBox(boxes(t)[0], false);
    expect(t.getSelectedIds()).toEqual(['a2']);
  });

  it('selects every row on the current page without dropping other pages', async () => {
    const t = createAssetsTable({
      ...deps(),
      apiFetch: pagedApi(),
      win: stubWin(),
      selectable: true,
    });
    document.body.appendChild(t.el);
    await tick();

    t.selectAllOnPage();
    expect(t.getSelectedIds()).toEqual(['a1', 'a2']);
    expect(boxes(t).every((b) => b.checked)).toBe(true);

    t.state.nextPage();
    await tick();
    t.selectAllOnPage();
    expect(t.getSelectedIds()).toEqual(['a1', 'a2', 'a3']);
  });

  it('clears the selection and unticks the rows on screen', async () => {
    const t = createAssetsTable({
      ...deps(),
      apiFetch: pagedApi(),
      win: stubWin(),
      selectable: true,
    });
    document.body.appendChild(t.el);
    await tick();

    t.selectAllOnPage();
    t.clearSelection();
    expect(t.getSelectedIds()).toEqual([]);
    expect(boxes(t).some((b) => b.checked)).toBe(false);
  });
});

describe('selection survives the repaints an operator causes', () => {
  it('stays selected across paging, and comes back ticked on return', async () => {
    const t = createAssetsTable({
      ...deps(),
      apiFetch: pagedApi(),
      win: stubWin(),
      selectable: true,
    });
    document.body.appendChild(t.el);
    await tick();

    tickBox(boxes(t)[0]);
    t.state.nextPage();
    await tick();

    // Different rows on screen, selection intact.
    expect(boxes(t).map((b) => b.value)).toEqual(['a3']);
    expect(boxes(t)[0].checked).toBe(false);
    expect(t.getSelectedIds()).toEqual(['a1']);

    t.state.prevPage();
    await tick();
    expect(boxes(t)[0].checked).toBe(true);
  });

  it('stays selected across a filter change that swaps the fetch tier', async () => {
    const t = createAssetsTable({
      ...deps(),
      apiFetch: pagedApi(),
      win: stubWin(),
      selectable: true,
    });
    document.body.appendChild(t.el);
    await tick();

    tickBox(boxes(t)[0]);
    t.state.setFilter('q', 'nine');
    await tick();

    expect(boxes(t).map((b) => b.value)).toEqual(['a9']);
    expect(t.getSelectedIds()).toEqual(['a1']);
  });
});

describe('selection does not collide with the existing row interactions', () => {
  it('ticking a row does not open that row’s detail panel', async () => {
    const opened: string[] = [];
    const t = createAssetsTable({
      ...deps(),
      apiFetch: pagedApi(),
      win: stubWin(),
      selectable: true,
      onRowClick: (id: string) => opened.push(id),
    });
    document.body.appendChild(t.el);
    await tick();

    boxes(t)[0].click();
    expect(opened).toEqual([]);

    // A click anywhere else in the row still opens the detail panel.
    (t.el.querySelector('tbody tr[data-row-key] td:nth-child(4)') as HTMLElement).click();
    expect(opened).toEqual(['a1']);
  });

  it('the column chooser cannot hide the selection column', async () => {
    // A URL that asks for a narrow column set must not be able to strip the
    // control an active selection depends on (`hideable: false`).
    const t = createAssetsTable({
      ...deps(),
      apiFetch: pagedApi(),
      win: stubWin('?assets.cols=id'),
      selectable: true,
    });
    document.body.appendChild(t.el);
    await tick();

    expect(t.getVisibleColumns()).toContain(ASSETS_SELECT_COLUMN_KEY);
    expect(boxes(t).length).toBe(2);
  });
});
