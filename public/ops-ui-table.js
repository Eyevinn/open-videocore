/**
 * open-videocore ops dashboard — shared table primitive (ops-ui-table.js)
 *
 * Foundation for issue #367 (parent #366): a single reusable table primitive
 * (component + state hook) that every ops UI table — assets, jobs, logs — will
 * consume so that sort, filter, and pagination behave identically everywhere
 * and are never reinvented per table.
 *
 * This module is intentionally UI-only and contract-free: it makes NO network
 * calls and knows NOTHING about any specific endpoint, request field, or
 * response shape. The consuming table owns its data-fetch and passes a
 * `fetchPage()` callback in; the primitive only orchestrates the interaction
 * state (sort/filter/page) and renders the shared chrome. Because it never
 * touches an API, no OpenAPI/schema contract applies here (per the "fetch the
 * contract before writing any call" rule — there is no call to ground).
 *
 * Design notes (so the follow-up per-table wiring is a natural fit):
 *   - `createOpsTableState()` is the "hook": a framework-free state container
 *     with subscribe/getState semantics and the sort/filter/page reducers.
 *   - `createOpsTable()` is the "component": a DOM factory that renders the
 *     header (sortable tri-state columns), a slot-based filter bar, the tbody
 *     with shared loading/empty/error states, and the pagination controls. It
 *     wires user interaction back into the state hook and re-renders on change.
 *   - Two paging modes are supported behind ONE interface so the offset-based
 *     assets/jobs tables and the cursor-based logs table look identical to
 *     callers: `pagingMode: 'offset'` and `pagingMode: 'cursor'`.
 *
 * Security note: this primitive mirrors app.js's XSS posture. All dynamic
 * values are written via textContent / DOM APIs — this module inserts NO raw
 * external strings into innerHTML. The escHtml() helper is exported so callers
 * that build cell HTML strings (the existing app.js style) stay consistent.
 */

// ─── Escape helper (XSS prevention) ─────────────────────────────────────────
// Mirrors escHtml() in app.js so the two modules encode identically. Kept local
// (not imported) so this primitive has zero coupling to app.js and can be unit
// tested in isolation.
export function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Constants ───────────────────────────────────────────────────────────────

// Tri-state sort direction cycle for a sortable column header:
//   none -> asc -> desc -> none
export const SORT_NONE = 'none';
export const SORT_ASC = 'asc';
export const SORT_DESC = 'desc';

// Paging modes. `offset` drives offset/limit backends (assets, jobs); `cursor`
// drives opaque forward/back cursor backends (logs). Callers pick one and the
// primitive hides the difference behind the same navigation API.
export const PAGING_OFFSET = 'offset';
export const PAGING_CURSOR = 'cursor';

// Visible, bounded default page size (acceptance criterion: "a visible,
// bounded page size"). Callers may override via config.pageSize.
export const DEFAULT_PAGE_SIZE = 20;

function nextSortDirection(dir) {
  if (dir === SORT_NONE) return SORT_ASC;
  if (dir === SORT_ASC) return SORT_DESC;
  return SORT_NONE;
}

// ─── State hook ───────────────────────────────────────────────────────────────
//
// createOpsTableState(config) -> a framework-free store exposing:
//   getState()                     -> immutable snapshot { sort, filters, page }
//   subscribe(fn) -> unsubscribe   -> notified on every state mutation
//   toggleSort(columnKey)          -> tri-state advance for a sortable column
//   setFilter(name, value)         -> merge one filter control's value
//   setFilters(obj)                -> replace the whole filter object
//   nextPage() / prevPage()        -> paging in whichever mode is configured
//   setPageInfo({...})             -> record backend paging facts after a fetch
//   canPrev() / canNext()          -> whether nav is currently possible
//   reset()                        -> back to first page, current sort/filters
//
// The store holds ONLY interaction state. It never fetches. The consuming table
// reads getState() to build its request, then calls setPageInfo() with the
// paging facts the backend returned (total for offset mode; cursors for cursor
// mode) so the store can decide can-prev / can-next.
export function createOpsTableState(config) {
  const cfg = config || {};
  const pagingMode = cfg.pagingMode === PAGING_CURSOR ? PAGING_CURSOR : PAGING_OFFSET;
  const pageSize = Number.isFinite(cfg.pageSize) && cfg.pageSize > 0
    ? Math.floor(cfg.pageSize)
    : DEFAULT_PAGE_SIZE;

  // Optional single-column initial sort.
  const initialSort = cfg.initialSort && cfg.initialSort.columnKey
    ? { columnKey: cfg.initialSort.columnKey, direction: cfg.initialSort.direction || SORT_ASC }
    : { columnKey: null, direction: SORT_NONE };

  const state = {
    pagingMode,
    pageSize,
    sort: { columnKey: initialSort.columnKey, direction: initialSort.direction },
    filters: cfg.initialFilters ? { ...cfg.initialFilters } : {},
    // Offset-mode paging facts.
    offset: 0,
    total: null, // unknown until first setPageInfo
    // Cursor-mode paging facts. `cursor` is the token sent to the backend for
    // the current page (null = first page). The stacks below let prev work.
    cursor: null,
    nextCursor: null,
    prevStack: [], // cursors of previous pages, for going back
    hasNext: false,
  };

  const listeners = new Set();
  function emit() {
    const snapshot = getState();
    listeners.forEach(function(fn) { fn(snapshot); });
  }

  function getState() {
    return {
      pagingMode: state.pagingMode,
      pageSize: state.pageSize,
      sort: { columnKey: state.sort.columnKey, direction: state.sort.direction },
      filters: { ...state.filters },
      offset: state.offset,
      total: state.total,
      cursor: state.cursor,
      nextCursor: state.nextCursor,
      hasNext: state.hasNext,
      pageIndex: pageIndex(),
    };
  }

  function pageIndex() {
    if (state.pagingMode === PAGING_OFFSET) {
      return Math.floor(state.offset / state.pageSize);
    }
    return state.prevStack.length; // 0-based page number in cursor mode
  }

  function subscribe(fn) {
    listeners.add(fn);
    return function unsubscribe() { listeners.delete(fn); };
  }

  // Advance a sortable column through none -> asc -> desc -> none. Only one
  // column is sorted at a time (selecting a new column starts it at asc).
  // Changing sort resets to the first page (paging facts become stale).
  function toggleSort(columnKey) {
    if (state.sort.columnKey === columnKey) {
      const dir = nextSortDirection(state.sort.direction);
      state.sort = { columnKey: dir === SORT_NONE ? null : columnKey, direction: dir };
    } else {
      state.sort = { columnKey: columnKey, direction: SORT_ASC };
    }
    resetPaging();
    emit();
  }

  // Merge a single filter control's value. Empty string / null / undefined
  // clears that key so the request stays clean. Filter changes reset paging.
  function setFilter(name, value) {
    if (value === '' || value === null || value === undefined) {
      delete state.filters[name];
    } else {
      state.filters[name] = value;
    }
    resetPaging();
    emit();
  }

  function setFilters(obj) {
    state.filters = {};
    if (obj && typeof obj === 'object') {
      Object.keys(obj).forEach(function(k) {
        const v = obj[k];
        if (v !== '' && v !== null && v !== undefined) state.filters[k] = v;
      });
    }
    resetPaging();
    emit();
  }

  function resetPaging() {
    state.offset = 0;
    state.cursor = null;
    state.nextCursor = null;
    state.prevStack = [];
    state.hasNext = false;
    // `total` is left intact for offset mode until the next setPageInfo — the
    // count of matching rows may change once filters change, but we do not
    // fabricate it here; the consumer refreshes it on the next fetch.
  }

  function reset() {
    resetPaging();
    emit();
  }

  // Record backend paging facts after a fetch completes.
  //   offset mode:  setPageInfo({ total })            (rows matching filters)
  //   cursor mode:  setPageInfo({ nextCursor })       (opaque token or null)
  // The consumer calls this once per successful page load.
  function setPageInfo(info) {
    const i = info || {};
    if (state.pagingMode === PAGING_OFFSET) {
      if (Number.isFinite(i.total)) state.total = i.total;
    } else {
      state.nextCursor = i.nextCursor != null ? i.nextCursor : null;
      state.hasNext = state.nextCursor != null;
    }
    emit();
  }

  function canPrev() {
    if (state.pagingMode === PAGING_OFFSET) return state.offset > 0;
    return state.prevStack.length > 0;
  }

  function canNext() {
    if (state.pagingMode === PAGING_OFFSET) {
      if (state.total == null) return false;
      return state.offset + state.pageSize < state.total;
    }
    return state.hasNext;
  }

  function nextPage() {
    if (!canNext()) return false;
    if (state.pagingMode === PAGING_OFFSET) {
      state.offset += state.pageSize;
    } else {
      // Push the current cursor so prev can return here, then advance.
      state.prevStack.push(state.cursor);
      state.cursor = state.nextCursor;
      state.nextCursor = null;
      state.hasNext = false; // unknown until the next fetch reports it
    }
    emit();
    return true;
  }

  function prevPage() {
    if (!canPrev()) return false;
    if (state.pagingMode === PAGING_OFFSET) {
      state.offset = Math.max(0, state.offset - state.pageSize);
    } else {
      state.cursor = state.prevStack.pop();
      state.nextCursor = null;
      state.hasNext = false;
    }
    emit();
    return true;
  }

  // The paging parameters the consumer should send to its backend for the
  // current page. Callers spread this into their query so they never have to
  // branch on paging mode themselves.
  function pageParams() {
    if (state.pagingMode === PAGING_OFFSET) {
      return { limit: state.pageSize, offset: state.offset };
    }
    const p = { limit: state.pageSize };
    if (state.cursor != null) p.cursor = state.cursor;
    return p;
  }

  return {
    getState,
    subscribe,
    toggleSort,
    setFilter,
    setFilters,
    setPageInfo,
    nextPage,
    prevPage,
    canPrev,
    canNext,
    pageParams,
    reset,
  };
}

// ─── Component factory ────────────────────────────────────────────────────────
//
// createOpsTable(config) -> { el, state, render, setStatus, setRows, destroy }
//
// config:
//   columns:    [{ key, label, sortable?, sortKey?, align?, width?, render? }]
//               `sortable` enables the tri-state header button; `sortKey` (falls
//               back to `key`) is what toggleSort() tracks. `render(row)` returns
//               an escaped HTML string for the cell (matches app.js style); when
//               omitted the cell shows escaped row[key].
//   filters:    [{ name, control(state, onChange) -> HTMLElement }] — slot-based.
//               Each table populates its own column-appropriate controls (status
//               select, date-range, free-text). The primitive owns no filter
//               semantics; it just mounts the control and forwards its value.
//   pagingMode: 'offset' | 'cursor'
//   pageSize:   bounded, visible page size (default DEFAULT_PAGE_SIZE)
//   rowKey:     (row) => string   — stable key for a row (defaults to row.id)
//   emptyText:  shown when a successful load returns zero rows
//   caption:    optional table title text rendered above the filter bar
//
// The component does NOT fetch. The consumer subscribes to `state` (or passes
// an onChange in config), fetches, then calls setRows()/setStatus() and
// state.setPageInfo(). This keeps ALL table-specific logic out of the primitive.
export function createOpsTable(config) {
  const cfg = config || {};
  const columns = Array.isArray(cfg.columns) ? cfg.columns : [];
  const filters = Array.isArray(cfg.filters) ? cfg.filters : [];
  const rowKey = typeof cfg.rowKey === 'function' ? cfg.rowKey : function(r) { return r && r.id; };
  const emptyText = cfg.emptyText || 'No results.';

  const state = createOpsTableState({
    pagingMode: cfg.pagingMode,
    pageSize: cfg.pageSize,
    initialSort: cfg.initialSort,
    initialFilters: cfg.initialFilters,
  });

  // status: 'idle' | 'loading' | 'ready' | 'empty' | 'error'
  let status = 'idle';
  let rows = [];
  let errorMessage = '';

  // ── DOM scaffold (mirrors the assets/jobs tab structure) ──
  const el = document.createElement('div');
  el.className = 'ops-table';

  const caption = document.createElement('div');
  caption.className = 'ops-table-caption section-title';
  if (cfg.caption) caption.textContent = cfg.caption;
  else caption.style.display = 'none';
  el.appendChild(caption);

  // Slot-based filter bar.
  const filterBar = document.createElement('div');
  filterBar.className = 'ops-table-filters';
  el.appendChild(filterBar);

  const tableScroll = document.createElement('div');
  tableScroll.className = 'ops-table-scroll table-wrap';
  el.appendChild(tableScroll);

  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  thead.appendChild(headerRow);
  const tbody = document.createElement('tbody');
  table.appendChild(thead);
  table.appendChild(tbody);
  tableScroll.appendChild(table);

  // Pagination controls (shared chrome; class names reuse app.js styling).
  const pagination = document.createElement('div');
  pagination.className = 'ops-table-pagination pagination';
  const pageIndicator = document.createElement('span');
  pageIndicator.className = 'page-indicator';
  const prevBtn = document.createElement('button');
  prevBtn.className = 'btn-ghost ops-table-prev';
  prevBtn.type = 'button';
  prevBtn.textContent = 'Previous';
  const nextBtn = document.createElement('button');
  nextBtn.className = 'btn-ghost ops-table-next';
  nextBtn.type = 'button';
  nextBtn.textContent = 'Next';
  pagination.appendChild(pageIndicator);
  pagination.appendChild(prevBtn);
  pagination.appendChild(nextBtn);
  el.appendChild(pagination);

  prevBtn.addEventListener('click', function() { state.prevPage(); });
  nextBtn.addEventListener('click', function() { state.nextPage(); });

  // ── Header (sortable tri-state columns) ──
  function renderHeader() {
    headerRow.innerHTML = '';
    const snap = state.getState();
    columns.forEach(function(col) {
      const th = document.createElement('th');
      if (col.align) th.style.textAlign = col.align;
      if (col.width) th.style.width = col.width;
      const sortKey = col.sortKey || col.key;
      if (col.sortable) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ops-th-sort';
        btn.dataset.sortKey = sortKey;
        // Label + a tri-state arrow indicator, all via textContent.
        const labelSpan = document.createElement('span');
        labelSpan.textContent = col.label != null ? String(col.label) : '';
        const arrow = document.createElement('span');
        arrow.className = 'ops-sort-arrow';
        const active = snap.sort.columnKey === sortKey ? snap.sort.direction : SORT_NONE;
        arrow.textContent = active === SORT_ASC ? ' ▲' : (active === SORT_DESC ? ' ▼' : '');
        btn.setAttribute('aria-sort', active === SORT_ASC ? 'ascending'
          : (active === SORT_DESC ? 'descending' : 'none'));
        th.setAttribute('aria-sort', btn.getAttribute('aria-sort'));
        btn.appendChild(labelSpan);
        btn.appendChild(arrow);
        btn.addEventListener('click', function() { state.toggleSort(sortKey); });
        th.appendChild(btn);
      } else {
        th.textContent = col.label != null ? String(col.label) : '';
      }
      headerRow.appendChild(th);
    });
  }

  // ── Filter bar (slot-based) ──
  // Each filter provides a control() factory returning a DOM element wired to
  // call state.setFilter(name, value). We mount them once; controls own their
  // own event handling and simply call the provided onChange.
  function renderFilters() {
    filterBar.innerHTML = '';
    if (!filters.length) { filterBar.style.display = 'none'; return; }
    filterBar.style.display = '';
    filters.forEach(function(f) {
      if (typeof f.control !== 'function') return;
      const onChange = function(value) { state.setFilter(f.name, value); };
      const control = f.control(state.getState(), onChange);
      if (control instanceof Node) {
        const slot = document.createElement('div');
        slot.className = 'ops-filter-slot';
        if (f.name) slot.dataset.filter = f.name;
        slot.appendChild(control);
        filterBar.appendChild(slot);
      }
    });
  }

  // ── Body (shared loading / empty / error states) ──
  function renderBody() {
    tbody.innerHTML = '';
    const colspan = columns.length || 1;

    if (status === 'loading') {
      tbody.appendChild(fullWidthRow(colspan, 'ops-table-loading',
        function(td) {
          const spinner = document.createElement('span');
          spinner.className = 'spinner';
          td.appendChild(spinner);
          td.appendChild(document.createTextNode(' Loading…'));
        }));
      return;
    }
    if (status === 'error') {
      tbody.appendChild(fullWidthRow(colspan, 'ops-table-error',
        function(td) {
          td.classList.add('msg-error');
          td.textContent = errorMessage || 'Failed to load.';
        }));
      return;
    }
    if (status === 'empty' || (status === 'ready' && rows.length === 0)) {
      tbody.appendChild(fullWidthRow(colspan, 'ops-table-empty',
        function(td) {
          td.classList.add('empty');
          td.textContent = emptyText;
        }));
      return;
    }
    if (status === 'idle') {
      // Nothing rendered until the consumer runs its first load.
      return;
    }

    rows.forEach(function(row) {
      const tr = document.createElement('tr');
      const key = rowKey(row);
      if (key != null) tr.dataset.rowKey = String(key);
      columns.forEach(function(col) {
        const td = document.createElement('td');
        if (col.align) td.style.textAlign = col.align;
        if (typeof col.render === 'function') {
          // Cell renderers return an escaped HTML string (app.js convention).
          // The consumer is responsible for passing dynamic values through
          // escHtml; this primitive never introduces raw external strings.
          td.innerHTML = String(col.render(row) ?? '');
        } else {
          // Default: escaped textContent of row[col.key].
          td.textContent = row && row[col.key] != null ? String(row[col.key]) : '';
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
  }

  function fullWidthRow(colspan, className, fill) {
    const tr = document.createElement('tr');
    tr.className = className;
    const td = document.createElement('td');
    td.colSpan = colspan;
    fill(td);
    tr.appendChild(td);
    return tr;
  }

  // ── Pagination chrome ──
  function renderPagination() {
    const snap = state.getState();
    const canPrev = state.canPrev();
    const canNext = state.canNext();
    prevBtn.disabled = !canPrev;
    nextBtn.disabled = !canNext;
    // Hide entirely when there is genuinely nothing to page through.
    const hasAnyNav = canPrev || canNext;
    pagination.style.display = (status === 'ready' && (rows.length > 0 || hasAnyNav)) ? '' : 'none';

    // Page indicator. Offset mode can show a range against a known total;
    // cursor mode has no total, so it shows the 1-based page number.
    if (snap.pagingMode === PAGING_OFFSET && snap.total != null) {
      const first = rows.length ? snap.offset + 1 : snap.offset;
      const last = snap.offset + rows.length;
      pageIndicator.textContent = snap.total > 0
        ? first + '–' + last + ' of ' + snap.total
        : '0 of 0';
    } else {
      pageIndicator.textContent = 'Page ' + (snap.pageIndex + 1);
    }
  }

  function render() {
    renderHeader();
    renderBody();
    renderPagination();
  }

  // Re-render sort arrows + pagination whenever interaction state changes. The
  // consumer separately reacts to the same changes to re-fetch (it subscribes
  // to `state`); here we only keep the chrome in sync.
  state.subscribe(function() {
    renderHeader();
    renderPagination();
  });

  // ── Public setters the consumer drives after a fetch ──
  function setStatus(next, message) {
    status = next;
    if (next === 'error') errorMessage = message || '';
    renderBody();
    renderPagination();
  }

  function setRows(nextRows) {
    rows = Array.isArray(nextRows) ? nextRows : [];
    status = rows.length ? 'ready' : 'empty';
    renderBody();
    renderPagination();
  }

  function destroy() {
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  // Initial paint (filters mounted once; header/body/pagination reflect idle).
  renderFilters();
  render();

  return {
    el,
    state,
    render,
    setStatus,
    setRows,
    destroy,
    // Exposed for consumers/tests that want to read current view status.
    getStatus: function() { return status; },
  };
}
