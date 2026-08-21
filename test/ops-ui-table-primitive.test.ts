// @vitest-environment happy-dom
//
// Unit tests for the shared ops-UI table primitive (issue #367, parent #366).
//
// This is a FOUNDATION ticket: the primitive (public/ops-ui-table.js) is a
// framework-free component + state hook that the assets, jobs, and logs tables
// will later adopt. It is UI-only and makes NO API calls, so there is no
// OpenAPI/schema contract to ground here — these tests exercise pure DOM +
// state behavior only.
//
// Coverage (per acceptance criteria):
//   - sort toggling (tri-state none -> asc -> desc -> none, one active column)
//   - filter change events (slot-based controls forward values into state)
//   - page navigation in BOTH paging modes (offset and cursor)
//   - shared loading / empty / error states

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createOpsTable,
  createOpsTableState,
  escHtml,
  SORT_NONE,
  SORT_ASC,
  SORT_DESC,
  PAGING_OFFSET,
  PAGING_CURSOR,
  DEFAULT_PAGE_SIZE,
} from '../public/ops-ui-table.js';

const COLUMNS = [
  { key: 'id', label: 'ID', sortable: true },
  { key: 'name', label: 'Name', sortable: true, sortKey: 'title' },
  { key: 'status', label: 'Status' }, // not sortable
];

function mount(config: Record<string, unknown> = {}) {
  const table = createOpsTable({ columns: COLUMNS, ...config });
  document.body.appendChild(table.el);
  return table;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

// ─── escape helper ─────────────────────────────────────────────────────────

describe('escHtml', () => {
  it('encodes the five XSS-relevant characters', () => {
    expect(escHtml(`<a href="x" foo='b'>&`)).toBe(
      '&lt;a href=&quot;x&quot; foo=&#39;b&#39;&gt;&amp;'
    );
  });
  it('renders null/undefined as empty string', () => {
    expect(escHtml(null)).toBe('');
    expect(escHtml(undefined)).toBe('');
  });
});

// ─── sort toggling ───────────────────────────────────────────────────────────

describe('sort toggling (tri-state)', () => {
  it('cycles a column none -> asc -> desc -> none on repeated toggles', () => {
    const s = createOpsTableState({ pagingMode: PAGING_OFFSET });
    expect(s.getState().sort).toEqual({ columnKey: null, direction: SORT_NONE });

    s.toggleSort('id');
    expect(s.getState().sort).toEqual({ columnKey: 'id', direction: SORT_ASC });

    s.toggleSort('id');
    expect(s.getState().sort).toEqual({ columnKey: 'id', direction: SORT_DESC });

    s.toggleSort('id');
    expect(s.getState().sort).toEqual({ columnKey: null, direction: SORT_NONE });
  });

  it('selecting a different column starts it at asc (single active column)', () => {
    const s = createOpsTableState();
    s.toggleSort('id');
    s.toggleSort('id'); // id => desc
    s.toggleSort('title'); // switch column
    expect(s.getState().sort).toEqual({ columnKey: 'title', direction: SORT_ASC });
  });

  it('notifies subscribers on each sort toggle', () => {
    const s = createOpsTableState();
    const spy = vi.fn();
    s.subscribe(spy);
    s.toggleSort('id');
    s.toggleSort('id');
    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy.mock.calls[1][0].sort.direction).toBe(SORT_DESC);
  });

  it('changing sort resets paging to the first page', () => {
    const s = createOpsTableState({ pagingMode: PAGING_OFFSET, pageSize: 10 });
    s.setPageInfo({ total: 100 });
    s.nextPage();
    expect(s.getState().offset).toBe(10);
    s.toggleSort('id');
    expect(s.getState().offset).toBe(0);
  });

  it('component renders a tri-state arrow + aria-sort on sortable headers only', () => {
    const table = mount();
    const sortButtons = table.el.querySelectorAll('.ops-th-sort');
    // Two of the three columns are sortable.
    expect(sortButtons.length).toBe(2);

    const idBtn = table.el.querySelector<HTMLButtonElement>('.ops-th-sort[data-sort-key="id"]')!;
    expect(idBtn.getAttribute('aria-sort')).toBe('none');

    idBtn.click(); // asc
    const idBtnAsc = table.el.querySelector<HTMLButtonElement>('.ops-th-sort[data-sort-key="id"]')!;
    expect(idBtnAsc.getAttribute('aria-sort')).toBe('ascending');
    expect(idBtnAsc.querySelector('.ops-sort-arrow')!.textContent).toContain('▲');

    idBtnAsc.click(); // desc
    const idBtnDesc = table.el.querySelector<HTMLButtonElement>('.ops-th-sort[data-sort-key="id"]')!;
    expect(idBtnDesc.getAttribute('aria-sort')).toBe('descending');
    expect(idBtnDesc.querySelector('.ops-sort-arrow')!.textContent).toContain('▼');
  });

  it('the second sortable column tracks its sortKey (not its display key)', () => {
    const table = mount();
    const nameBtn = table.el.querySelector<HTMLButtonElement>('.ops-th-sort[data-sort-key="title"]')!;
    expect(nameBtn).not.toBeNull();
    nameBtn.click();
    expect(table.state.getState().sort.columnKey).toBe('title');
  });
});

// ─── filter change events ────────────────────────────────────────────────────

describe('filter change events', () => {
  it('setFilter merges values and clears on empty/null/undefined', () => {
    const s = createOpsTableState();
    s.setFilter('status', 'ready');
    expect(s.getState().filters).toEqual({ status: 'ready' });
    s.setFilter('q', 'hello');
    expect(s.getState().filters).toEqual({ status: 'ready', q: 'hello' });
    s.setFilter('status', '');
    expect(s.getState().filters).toEqual({ q: 'hello' });
    s.setFilter('q', null);
    expect(s.getState().filters).toEqual({});
  });

  it('setFilters replaces the whole filter object and drops empty values', () => {
    const s = createOpsTableState({ initialFilters: { a: '1' } });
    s.setFilters({ status: 'failed', q: '', keep: 'yes' });
    expect(s.getState().filters).toEqual({ status: 'failed', keep: 'yes' });
  });

  it('filter change resets paging and notifies subscribers', () => {
    const s = createOpsTableState({ pagingMode: PAGING_OFFSET, pageSize: 5 });
    s.setPageInfo({ total: 50 });
    s.nextPage();
    expect(s.getState().offset).toBe(5);
    const spy = vi.fn();
    s.subscribe(spy);
    s.setFilter('status', 'ready');
    expect(s.getState().offset).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('slot-based filter controls forward their value into state', () => {
    const changes: string[] = [];
    const table = mount({
      filters: [
        {
          name: 'status',
          control: (_state: unknown, onChange: (v: string) => void) => {
            const sel = document.createElement('select');
            ['', 'ready', 'failed'].forEach((v) => {
              const o = document.createElement('option');
              o.value = v;
              o.textContent = v || 'all';
              sel.appendChild(o);
            });
            sel.addEventListener('change', () => {
              changes.push(sel.value);
              onChange(sel.value);
            });
            return sel;
          },
        },
      ],
    });

    const slot = table.el.querySelector('.ops-filter-slot[data-filter="status"]');
    expect(slot).not.toBeNull();
    const sel = slot!.querySelector('select')!;
    sel.value = 'failed';
    sel.dispatchEvent(new Event('change'));

    expect(changes).toEqual(['failed']);
    expect(table.state.getState().filters).toEqual({ status: 'failed' });
  });

  it('hides the filter bar when no filters are configured', () => {
    const table = mount();
    const bar = table.el.querySelector<HTMLElement>('.ops-table-filters')!;
    expect(bar.style.display).toBe('none');
  });
});

// ─── page navigation: offset mode ────────────────────────────────────────────

describe('page navigation — offset mode', () => {
  it('advances by pageSize and stops at the total boundary', () => {
    const s = createOpsTableState({ pagingMode: PAGING_OFFSET, pageSize: 20 });
    // Before any page info, next is not possible (total unknown).
    expect(s.canNext()).toBe(false);
    s.setPageInfo({ total: 45 });

    expect(s.canPrev()).toBe(false);
    expect(s.canNext()).toBe(true);

    expect(s.nextPage()).toBe(true);
    expect(s.getState().offset).toBe(20);
    expect(s.canPrev()).toBe(true);
    expect(s.canNext()).toBe(true); // 20 + 20 < 45

    expect(s.nextPage()).toBe(true);
    expect(s.getState().offset).toBe(40);
    expect(s.canNext()).toBe(false); // 40 + 20 >= 45 -> last page

    // Attempting to over-advance is a no-op.
    expect(s.nextPage()).toBe(false);
    expect(s.getState().offset).toBe(40);
  });

  it('prevPage walks back and never goes below zero', () => {
    const s = createOpsTableState({ pagingMode: PAGING_OFFSET, pageSize: 10 });
    s.setPageInfo({ total: 30 });
    s.nextPage();
    s.nextPage();
    expect(s.getState().offset).toBe(20);
    expect(s.prevPage()).toBe(true);
    expect(s.getState().offset).toBe(10);
    s.prevPage();
    expect(s.getState().offset).toBe(0);
    expect(s.prevPage()).toBe(false); // already at first page
  });

  it('pageParams emits limit/offset for offset backends', () => {
    const s = createOpsTableState({ pagingMode: PAGING_OFFSET, pageSize: 15 });
    s.setPageInfo({ total: 100 });
    s.nextPage();
    expect(s.pageParams()).toEqual({ limit: 15, offset: 15 });
  });

  it('component pagination buttons drive offset navigation and indicator', () => {
    const table = mount({ pagingMode: PAGING_OFFSET, pageSize: 2 });
    // Simulate the consumer loading page 1 of 5 rows.
    table.setRows([{ id: 'a' }, { id: 'b' }]);
    table.state.setPageInfo({ total: 5 });

    const prevBtn = table.el.querySelector<HTMLButtonElement>('.ops-table-prev')!;
    const nextBtn = table.el.querySelector<HTMLButtonElement>('.ops-table-next')!;
    const indicator = table.el.querySelector<HTMLElement>('.page-indicator')!;

    expect(prevBtn.disabled).toBe(true);
    expect(nextBtn.disabled).toBe(false);
    expect(indicator.textContent).toBe('1–2 of 5');

    nextBtn.click();
    expect(table.state.getState().offset).toBe(2);
    expect(prevBtn.disabled).toBe(false);
  });
});

// ─── page navigation: cursor mode ────────────────────────────────────────────

describe('page navigation — cursor mode', () => {
  it('advances via opaque cursor and can walk back through the prev stack', () => {
    const s = createOpsTableState({ pagingMode: PAGING_CURSOR, pageSize: 25 });
    // First page: no cursor sent.
    expect(s.pageParams()).toEqual({ limit: 25 });
    expect(s.canPrev()).toBe(false);
    expect(s.canNext()).toBe(false);

    // Backend reports there is a next page.
    s.setPageInfo({ nextCursor: 'cur-1' });
    expect(s.canNext()).toBe(true);

    expect(s.nextPage()).toBe(true);
    // Now the current page's request carries the cursor.
    expect(s.pageParams()).toEqual({ limit: 25, cursor: 'cur-1' });
    expect(s.canPrev()).toBe(true);
    // hasNext is unknown again until the backend reports it.
    expect(s.canNext()).toBe(false);

    s.setPageInfo({ nextCursor: 'cur-2' });
    s.nextPage();
    expect(s.pageParams()).toEqual({ limit: 25, cursor: 'cur-2' });

    // Walk back: returns to the previous cursor.
    expect(s.prevPage()).toBe(true);
    expect(s.pageParams()).toEqual({ limit: 25, cursor: 'cur-1' });
    expect(s.prevPage()).toBe(true);
    expect(s.pageParams()).toEqual({ limit: 25 }); // back to first page
    expect(s.canPrev()).toBe(false);
  });

  it('cannot advance when the backend reports no nextCursor', () => {
    const s = createOpsTableState({ pagingMode: PAGING_CURSOR });
    s.setPageInfo({ nextCursor: null });
    expect(s.canNext()).toBe(false);
    expect(s.nextPage()).toBe(false);
  });

  it('pageIndex reflects the 1-based page in the indicator', () => {
    const table = mount({ pagingMode: PAGING_CURSOR, pageSize: 3 });
    table.setRows([{ id: 'x' }, { id: 'y' }, { id: 'z' }]);
    table.state.setPageInfo({ nextCursor: 'next' });
    const indicator = table.el.querySelector<HTMLElement>('.page-indicator')!;
    expect(indicator.textContent).toBe('Page 1');

    table.el.querySelector<HTMLButtonElement>('.ops-table-next')!.click();
    expect(indicator.textContent).toBe('Page 2');
  });

  it('exposes the same nextPage/prevPage interface regardless of mode', () => {
    const offset = createOpsTableState({ pagingMode: PAGING_OFFSET });
    const cursor = createOpsTableState({ pagingMode: PAGING_CURSOR });
    ['nextPage', 'prevPage', 'canNext', 'canPrev', 'pageParams', 'setPageInfo'].forEach((fn) => {
      expect(typeof (offset as Record<string, unknown>)[fn]).toBe('function');
      expect(typeof (cursor as Record<string, unknown>)[fn]).toBe('function');
    });
  });
});

// ─── shared loading / empty / error states ───────────────────────────────────

describe('shared table states', () => {
  it('renders a loading row spanning all columns', () => {
    const table = mount();
    table.setStatus('loading');
    const loadingRow = table.el.querySelector('tr.ops-table-loading td')!;
    expect(loadingRow.getAttribute('colspan')).toBe('3');
    expect(loadingRow.querySelector('.spinner')).not.toBeNull();
    expect(loadingRow.textContent).toContain('Loading');
  });

  it('renders an error row with the supplied message', () => {
    const table = mount();
    table.setStatus('error', 'boom');
    const errRow = table.el.querySelector('tr.ops-table-error td')!;
    expect(errRow.textContent).toBe('boom');
    expect(errRow.classList.contains('msg-error')).toBe(true);
  });

  it('renders the empty state when setRows gets an empty array', () => {
    const table = mount({ emptyText: 'Nothing here.' });
    table.setRows([]);
    const emptyRow = table.el.querySelector('tr.ops-table-empty td')!;
    expect(emptyRow.textContent).toBe('Nothing here.');
    expect(table.getStatus()).toBe('empty');
    // Pagination is hidden when there is nothing to page.
    const pagination = table.el.querySelector<HTMLElement>('.ops-table-pagination')!;
    expect(pagination.style.display).toBe('none');
  });

  it('renders one row per item with escaped default cells and custom render()', () => {
    const table = mount({
      columns: [
        { key: 'id', label: 'ID' },
        { key: 'name', label: 'Name', render: (r: { name: string }) => '<b>' + escHtml(r.name) + '</b>' },
      ],
    });
    table.setRows([{ id: 'a1', name: '<script>x' }]);
    const rows = table.el.querySelectorAll('tbody tr');
    expect(rows.length).toBe(1);
    const cells = rows[0].querySelectorAll('td');
    // Default cell uses textContent (no HTML injection).
    expect(cells[0].textContent).toBe('a1');
    // Custom render inserts controlled, escaped HTML — the <b> is a real tag,
    // the payload text is escaped so no <script> element is created.
    expect(cells[1].querySelector('b')).not.toBeNull();
    expect(cells[1].querySelector('script')).toBeNull();
    expect(cells[1].textContent).toBe('<script>x');
    // Row carries a stable data-row-key derived from rowKey (defaults to id).
    expect(rows[0].getAttribute('data-row-key')).toBe('a1');
  });
});

// ─── config surface / defaults ───────────────────────────────────────────────

describe('config surface', () => {
  it('defaults to offset paging with the bounded default page size', () => {
    const s = createOpsTableState();
    expect(s.getState().pagingMode).toBe(PAGING_OFFSET);
    expect(s.getState().pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it('honours an explicit page size and rejects non-positive values', () => {
    expect(createOpsTableState({ pageSize: 50 }).getState().pageSize).toBe(50);
    expect(createOpsTableState({ pageSize: 0 }).getState().pageSize).toBe(DEFAULT_PAGE_SIZE);
    expect(createOpsTableState({ pageSize: -5 }).getState().pageSize).toBe(DEFAULT_PAGE_SIZE);
  });

  it('applies an initial single-column sort from config', () => {
    const s = createOpsTableState({ initialSort: { columnKey: 'createdAt', direction: SORT_DESC } });
    expect(s.getState().sort).toEqual({ columnKey: 'createdAt', direction: SORT_DESC });
  });

  it('renders a caption when provided and hides it otherwise', () => {
    const withCaption = mount({ caption: 'Assets' });
    expect(withCaption.el.querySelector<HTMLElement>('.ops-table-caption')!.textContent).toBe('Assets');
    document.body.innerHTML = '';
    const without = mount();
    expect(without.el.querySelector<HTMLElement>('.ops-table-caption')!.style.display).toBe('none');
  });
});
