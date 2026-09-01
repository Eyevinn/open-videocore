/**
 * open-videocore ops dashboard — logs-table.js
 *
 * Issue #371 (parent #366): filter + cursor pagination for the ops-UI logs table.
 *
 * Wires the LOGS table onto the two already-merged shared primitives — it
 * reinvents none of the table / sort / filter / URL machinery:
 *   - public/ops-ui-table.js      (#367/#372) — the table component + state hook.
 *   - public/table-url-state.js   (#368/#373) — the URL query-param contract.
 *
 * Unlike the assets (#369) and jobs (#370) tables — whose list endpoints accept
 * ONLY limit/offset and therefore simulate sort/filter/paging over a bounded
 * client-side window — the logs endpoint is genuinely cursor-native and supports
 * server-side time-range, free-text, and order params. So this table pages,
 * filters, and orders ENTIRELY server-side. There is no offset, no full-set
 * fetch, and no truncation banner: newly appended entries never shift an
 * in-flight page because paging is by opaque cursor, not offset.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (fetch-the-contract-before-writing-any-call rule)
 *
 * Every path, query param, and field below is verified against the live OpenAPI
 * schema in this repo (openapi.json) — NOT guessed.
 *
 *   Endpoint: GET /api/v1/logs/
 *     openapi.json .paths["/api/v1/logs/"].get
 *
 *   Query params (openapi.json .paths["/api/v1/logs/"].get.parameters) — the ONLY
 *   params the endpoint accepts:
 *     limit   integer 1..200, default 50   (bounded, visible page size)
 *     cursor  string                        (opaque; from a prior nextCursor)
 *     from    string (date-time)            (ISO-8601 lower bound on `timestamp`)
 *     to      string (date-time)            (ISO-8601 upper bound on `timestamp`)
 *     q       string                        (case-insensitive message substring)
 *     order   enum ['asc','desc'], default 'desc'  (newest-first by default)
 *
 *   Response 200 envelope (openapi.json .paths["/api/v1/logs/"].get.responses
 *   ["200"].content["application/json"].schema):
 *     { items: LogRecord[], nextCursor: string | null }
 *       - nextCursor === null  =>  last page (no further forward paging).
 *
 *   LogRecord item schema (same location, .properties.items.items.properties):
 *     seq        integer  (required — the stable sequence key)
 *     timestamp  string   (required — the time-ordering axis)
 *     message    string   (required — the free-text search target)
 *     level      enum ['debug','info','warn','error']  (OPTIONAL — "if present")
 *     category   string                                (OPTIONAL — "if present")
 *
 * CONTRACT-HONEST FILTER SCOPE. The endpoint exposes server-side filters ONLY for
 * from/to (time range) and q (message text), plus order. It has NO server-side
 * `level` or `category` param. Per the fetch-the-contract-before-writing-any-call
 * rule we do NOT invent params the endpoint cannot accept, and the acceptance
 * criteria scope level/category as conditional ("if available"/"if present").
 * `level` and `category` are therefore rendered as columns (when present on the
 * records) but are NOT offered as server filters — doing so would silently only
 * narrow the current page and mislead the operator about cursor completeness.
 * (This gap is logged as backend/OSC friction in the sibling agents repo at
 * docs/osc-feedback/incoming-logs-level-category-filter.md.)
 *
 * SECURITY: mirrors app.js's XSS posture. Every dynamic value written into a cell
 * HTML string passes through escHtml() (imported from the shared primitive).
 */

import {
  createOpsTable,
  escHtml,
  PAGING_CURSOR,
  SORT_ASC,
  SORT_DESC,
} from './ops-ui-table.js';
import {
  decodeTableState,
  applyTableState,
  SORT_DIR,
} from './table-url-state.js';

// ─── Contract-grounded constants (verified above) ────────────────────────────

// URL-state namespace for THIS table (table-url-state prefixes params as
// `<ns>.<key>`, e.g. `logs.sort`, `logs.q`, `logs.cursor`).
export const LOGS_NS = 'logs';

// Bounded, visible page size (acceptance criterion). Matches the endpoint's
// default (50) and stays under its `limit` maximum (200).
export const LOGS_PAGE_SIZE = 50;
export const LOGS_LIMIT_MAX = 200;

// The single sortable axis: the log timestamp. The endpoint orders by timestamp
// and only toggles direction via `order=asc|desc`; there is no arbitrary sort
// field, so this table has exactly one sortable column keyed on `timestamp`.
export const SORT_KEY_TIMESTAMP = 'timestamp';

// Server order vocabulary — verified as the `order` enum on GET /api/v1/logs/.
export const LOG_ORDER = Object.freeze(['asc', 'desc']);

// The `level` enum — verified present on the LogRecord schema (optional field).
// Used only for column presentation / a badge class; NOT a server filter.
export const LOG_LEVELS = Object.freeze(['debug', 'info', 'warn', 'error']);

// Per-table URL-state defaults. Natural order is newest-first (order=desc),
// matching the endpoint default — the most useful default for operators.
const URL_DEFAULTS = Object.freeze({
  sort: { field: SORT_KEY_TIMESTAMP, dir: SORT_DIR.desc },
  size: LOGS_PAGE_SIZE,
});

// ─── Pure param builder (exported for unit testing; no DOM, no fetch) ─────────

/**
 * Build the querystring for GET /api/v1/logs/ from the primitive's state
 * snapshot. Emits ONLY the verified params (limit/cursor/from/to/q/order); never
 * an offset or any invented key. Returns a URLSearchParams so callers can .toString().
 *
 * @param {object} snap  the primitive state snapshot (getState()).
 * @returns {URLSearchParams}
 */
export function buildLogsQuery(snap) {
  const s = snap || {};
  const filters = s.filters || {};
  const params = new URLSearchParams();

  // Bounded page size — clamp to the endpoint's [1, 200] window defensively.
  let limit = Number.isFinite(s.pageSize) && s.pageSize > 0 ? Math.floor(s.pageSize) : LOGS_PAGE_SIZE;
  if (limit < 1) limit = 1;
  if (limit > LOGS_LIMIT_MAX) limit = LOGS_LIMIT_MAX;
  params.set('limit', String(limit));

  // Cursor-only forward paging (opaque token from a prior nextCursor). First
  // page carries no cursor, so newly appended rows can never shift it.
  if (s.cursor != null && s.cursor !== '') params.set('cursor', String(s.cursor));

  // Order: map the timestamp column's sort direction onto the endpoint's
  // asc|desc `order` param. Default (and any non-asc) is newest-first desc.
  const dir = s.sort && s.sort.columnKey === SORT_KEY_TIMESTAMP ? s.sort.direction : SORT_DESC;
  params.set('order', dir === SORT_ASC ? 'asc' : 'desc');

  // Time-range on `timestamp`. The endpoint expects ISO-8601 date-time; date
  // inputs give bare YYYY-MM-DD, so widen `from` to start-of-day and `to` to
  // end-of-day (inclusive) so a same-day range covers that whole UTC day.
  const from = typeof filters.from === 'string' ? filters.from.trim() : '';
  const to = typeof filters.to === 'string' ? filters.to.trim() : '';
  if (from) params.set('from', isBareDate(from) ? from + 'T00:00:00.000Z' : from);
  if (to) params.set('to', isBareDate(to) ? to + 'T23:59:59.999Z' : to);

  // Free-text message search (case-insensitive substring, server-side).
  const q = typeof filters.q === 'string' ? filters.q.trim() : '';
  if (q) params.set('q', q);

  return params;
}

function isBareDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim());
}

// ─── Sort <-> URL contract mappers ───────────────────────────────────────────

function urlSortToInitialSort(sort) {
  if (!sort || !sort.field) return undefined;
  return {
    columnKey: sort.field,
    direction: sort.dir === SORT_DIR.desc ? SORT_DESC : SORT_ASC,
  };
}

function tableSortToUrlSort(sort) {
  if (!sort || !sort.columnKey) return null;
  return {
    field: sort.columnKey,
    dir: sort.direction === SORT_DESC ? SORT_DIR.desc : SORT_DIR.asc,
  };
}

// ─── Filter controls (slot-based) ─────────────────────────────────────────────
//
// Each control is a factory the primitive mounts once into the filter bar; it
// wires its native events to the supplied `onChange(value)` (the primitive maps
// that to state.setFilter(name, value), which resets paging — correct for a
// cursor table: a new filter starts a fresh cursor walk). Initial values come
// from the decoded URL state so a shared link reconstructs the controls.

function labelledControl(className, labelText, control, ariaLabel) {
  const wrap = document.createElement('label');
  wrap.className = className;
  const span = document.createElement('span');
  span.textContent = labelText;
  if (ariaLabel) control.setAttribute('aria-label', ariaLabel);
  wrap.appendChild(span);
  wrap.appendChild(control);
  return wrap;
}

function dateFilterControl(name, labelText, initial) {
  return function (_state, onChange) {
    const input = document.createElement('input');
    input.type = 'date';
    if (initial) input.value = initial.length >= 10 ? initial.slice(0, 10) : initial;
    input.addEventListener('change', function () {
      onChange(input.value);
    });
    return labelledControl('ops-filter-' + name, labelText, input, labelText);
  };
}

function searchFilterControl(initial) {
  return function (_state, onChange) {
    const input = document.createElement('input');
    input.type = 'search';
    input.placeholder = 'Search message…';
    if (initial) input.value = initial;
    // Debounce lightly so server-side text search feels live but isn't chatty.
    let timer = null;
    input.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        onChange(input.value.trim());
      }, 250);
    });
    return labelledControl('ops-filter-q', 'Message', input, 'Search log messages');
  };
}

// ─── Column definitions ───────────────────────────────────────────────────────
//
// Cell renderers return escaped HTML strings (the app.js convention the primitive
// documents). Every dynamic value passes through escHtml. `level`/`category` are
// OPTIONAL on the record (see contract note); their cells degrade to '—' when the
// field is absent, so a record without them still renders cleanly.

function buildColumns(renderCtx) {
  const fmtDate = renderCtx.fmtDate;
  return [
    {
      key: 'timestamp',
      label: 'Time',
      sortable: true,
      sortKey: SORT_KEY_TIMESTAMP,
      render: (r) => escHtml(fmtDate(r.timestamp)),
    },
    {
      key: 'level',
      label: 'Level',
      // Conditional field — render a level badge when present, else a dash.
      render: (r) =>
        r.level
          ? '<span class="log-level log-level-' + escHtml(r.level) + '">' + escHtml(r.level) + '</span>'
          : '—',
    },
    {
      key: 'category',
      label: 'Category',
      render: (r) => (r.category ? '<span class="cell-id">' + escHtml(r.category) + '</span>' : '—'),
    },
    {
      key: 'message',
      label: 'Message',
      render: (r) => '<span class="log-message">' + escHtml(r.message) + '</span>',
    },
    {
      key: 'seq',
      label: 'Seq',
      align: 'right',
      render: (r) => escHtml(r.seq != null ? String(r.seq) : '—'),
    },
  ];
}

// ─── Public factory ───────────────────────────────────────────────────────────
//
// createLogsTable(deps) -> { el, reload, destroy, state }
//
// deps:
//   apiFetch(path) -> Promise           — the app's auth/stack-aware fetch.
//   fmtDate(val) -> string              — app.js date formatter.
//   win (optional)                      — injectable window for URL sync (tests).
//
// The table reads its initial sort/filter/page from the URL (shared contract),
// renders the shared primitive in CURSOR paging mode, fetches the logs endpoint
// server-side on every state change, records the returned nextCursor so the
// primitive can enable/disable Next, and writes state back to the URL so the view
// is shareable/refreshable.
export function createLogsTable(deps) {
  const d = deps || {};
  const apiFetch = d.apiFetch;
  const fmtDate = typeof d.fmtDate === 'function' ? d.fmtDate : (v) => String(v ?? '');
  const win = 'win' in d ? d.win : typeof window !== 'undefined' ? window : undefined;

  if (typeof apiFetch !== 'function') {
    throw new Error('createLogsTable requires deps.apiFetch');
  }

  // 1) Reconstruct state from the URL (tolerant; never throws).
  const search = win && win.location ? win.location.search : '';
  const urlState = decodeTableState(search, LOGS_NS, URL_DEFAULTS);

  // 2) Initial filter values for the controls come from the decoded URL. Only
  //    the contract-honest server filters (from/to/q) are seeded/round-tripped.
  const initialFilters = {};
  if (urlState.from) initialFilters.from = urlState.from;
  if (urlState.to) initialFilters.to = urlState.to;
  if (urlState.q) initialFilters.q = urlState.q;

  const columns = buildColumns({ fmtDate });

  const filters = [
    { name: 'from', control: dateFilterControl('from', 'From', initialFilters.from) },
    { name: 'to', control: dateFilterControl('to', 'To', initialFilters.to) },
    { name: 'q', control: searchFilterControl(initialFilters.q) },
  ];

  const table = createOpsTable({
    caption: '',
    columns,
    filters,
    pagingMode: PAGING_CURSOR,
    pageSize: urlState.size || LOGS_PAGE_SIZE,
    initialSort: urlSortToInitialSort(urlState.sort),
    initialFilters,
    rowKey: (r) => r && r.seq,
    emptyText: 'No log entries match the current filters.',
  });

  // Seed the initial cursor from the URL so a shared deep-linked page restores.
  // The primitive's public API tracks the current-page cursor internally and
  // only mutates it through next/prev (to keep the Previous back-stack honest).
  // So rather than fake a synthetic first page (which would create a bogus
  // Previous target), we splice this URL cursor into the FIRST request only;
  // thereafter the primitive's own cursor governs paging.
  const initialCursorFromUrl = urlState.cursor || null;
  let initialCursorApplied = false;

  let loading = false;

  async function reload() {
    if (loading) return;
    loading = true;
    const snap = table.state.getState();

    // First fetch may honour a deep-linked cursor from the URL. The primitive's
    // snapshot cursor is null on a fresh mount, so splice the URL cursor in for
    // exactly the first request; thereafter the primitive's cursor governs.
    let effectiveSnap = snap;
    if (!initialCursorApplied && initialCursorFromUrl && snap.cursor == null) {
      effectiveSnap = { ...snap, cursor: initialCursorFromUrl };
    }
    initialCursorApplied = true;

    // 3) Mirror the current interaction state into the URL (shared contract) so a
    //    refresh/share reproduces the view. Replace (not push) — control changes
    //    already re-render; we do not want a history entry per keystroke.
    applyTableState(
      {
        sort: tableSortToUrlSort(snap.sort),
        q: snap.filters.q || '',
        from: snap.filters.from || null,
        to: snap.filters.to || null,
        cursor: effectiveSnap.cursor || null,
        size: snap.pageSize,
      },
      LOGS_NS,
      { defaults: URL_DEFAULTS, replace: true, win }
    );

    table.setStatus('loading');
    try {
      const qs = buildLogsQuery(effectiveSnap).toString();
      const res = await apiFetch('/logs?' + qs);
      const items = res && Array.isArray(res.items) ? res.items : [];
      // Record the opaque forward cursor (or null on the last page) so the
      // primitive can enable/disable Next. No total exists in cursor mode.
      const nextCursor = res && res.nextCursor != null ? res.nextCursor : null;
      table.state.setPageInfo({ nextCursor });
      table.setRows(items);
    } catch (err) {
      table.setStatus('error', 'Failed to load logs: ' + (err && err.message ? err.message : String(err)));
    } finally {
      loading = false;
    }
  }

  // Any interaction (order toggle / filter change / page nav) triggers a reload.
  // The primitive already re-renders its own chrome; we react to re-fetch data.
  table.state.subscribe(function () {
    reload();
  });

  // Kick off the first load.
  reload();

  return {
    el: table.el,
    reload,
    refresh: reload,
    destroy: table.destroy,
    // Exposed for tests/consumers that want to drive the primitive directly.
    state: table.state,
    _table: table,
  };
}
