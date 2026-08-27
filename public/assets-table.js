/**
 * open-videocore ops dashboard — assets-table.js
 *
 * Issue #369: sort, filter, and pagination for the ops-UI assets table.
 *
 * This module wires the EXISTING assets table onto the two already-merged shared
 * primitives — it reinvents none of the table/sort/filter/URL machinery:
 *   - public/ops-ui-table.js      (#367/#372) — the table component + state hook.
 *   - public/table-url-state.js   (#368/#373) — the URL query-param contract.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (fetch-the-contract-before-writing-any-call rule)
 *
 * Every query param, field, and status value below is verified against the live
 * OpenAPI schema in this repo (openapi.json) and the route source, NOT guessed.
 *
 * Tier 1 — exact/range list (no free-text term), per ADR-005:
 *   Endpoint: GET /api/v1/assets/  (openapi.json path key "/api/v1/assets/").
 *   Verified query params (openapi.json .paths["/api/v1/assets/"].get.parameters
 *   and src/routes/assets.ts:283-288 `listQuerySchema`):
 *     limit   integer 1..200
 *     offset  integer >=0
 *     status  enum ['uploading','processing','ready','failed','archived']
 *     parentId string
 *   Response envelope (listSchema, top-level props): { items, limit, offset, total }.
 *   Item fields used here (verified present in the list item schema): id, slug,
 *   name (canonical title), status, tags, thumbnails, createdAt,
 *   technicalMetadataError.
 *   Ordering: the server ALWAYS returns createdAt-ascending with a ULID `id`
 *   tie-break (src/data/asset-repo.ts:937 — `createdAt.localeCompare … || id…`),
 *   i.e. ULID `_id` creation order per ADR-005. There is NO server `sort`, `q`,
 *   `from`, or `to` param on this endpoint (confirmed absent from the schema).
 *
 * Tier 2 — free-text FTS (a `q` term is present), per ADR-005:
 *   Endpoint: GET /api/v1/search/  (the CANONICAL free-text path already used by
 *   the Search tab in app.js — we reuse it rather than adding a second search
 *   path, per the issue's explicit constraint).
 *   Verified query params (openapi.json .paths["/api/v1/search/"].get.parameters
 *   and src/routes/search.ts:130-140): q (string), page (int >=1),
 *   pageSize (int 1..100), plus tags/mimeType/tams* (unused here).
 *   Response envelope (searchResultSchema, src/routes/search.ts:95-99):
 *     { assets, total, page }.
 *
 * KNOWN CONTRACT GAPS (logged as OSC/backend friction, see
 * docs/osc-feedback/incoming-assets-table-server-sort-filter.md):
 *   1. Neither endpoint accepts a server-side `sort` param; the list endpoint is
 *      fixed to createdAt-ascending. So created-date DESC and the status/title
 *      sorts are applied to the CURRENT PAGE client-side. Created-date ASC is the
 *      native server order (true ULID creation-order paging, no client sort).
 *   2. Neither endpoint accepts a created-date range (`from`/`to`) or a `status`
 *      filter on the FTS tier. Date-range narrowing (and status narrowing while a
 *      `q` term is active) is therefore applied to the current page client-side.
 *   These are page-scoped refinements, not new search paths — the URL-state
 *      contract still round-trips them so the view is shareable.
 *
 * SECURITY: mirrors app.js's XSS posture. Every dynamic value written into a cell
 * HTML string passes through escHtml() (imported from the shared primitive).
 */

import {
  createOpsTable,
  escHtml,
  PAGING_OFFSET,
  SORT_ASC,
  SORT_DESC,
} from './ops-ui-table.js';
import {
  decodeTableState,
  applyTableState,
  SORT_DIR,
} from './table-url-state.js';

// ─── Contract constants (verified above) ─────────────────────────────────────

// Asset lifecycle states — the ADR-005 state machine vocabulary. Verified as the
// `status` enum on GET /api/v1/assets/ (openapi.json) and statusSchema in
// src/routes/assets.ts / ASSET_STATUSES in src/data/asset-repo.ts.
export const ASSET_STATUSES = Object.freeze([
  'uploading',
  'processing',
  'ready',
  'failed',
  'archived',
]);

// Bounded, visible page size. Kept at the previous table's value so the change is
// behaviour-compatible; well under the list endpoint's `limit` max of 200 and the
// search endpoint's `pageSize` max of 100.
export const ASSETS_PAGE_SIZE = 20;

// URL-state namespace for THIS table (table-url-state prefixes params as
// `<ns>.<key>`, e.g. `assets.sort`, `assets.status`, `assets.page`).
export const ASSETS_NS = 'assets';

// Sortable column keys. `created` maps to the ULID creation-order axis; `status`
// and `title` are the additional axes the acceptance criteria require.
const SORT_KEY_CREATED = 'created';
const SORT_KEY_STATUS = 'status';
const SORT_KEY_TITLE = 'title';

// Per-table URL-state defaults. Natural order is created DESC (newest first) —
// the most useful default for operators — expressed against the shared contract.
const URL_DEFAULTS = Object.freeze({
  sort: { field: SORT_KEY_CREATED, dir: SORT_DIR.desc },
  size: ASSETS_PAGE_SIZE,
});

// ─── Small mappers between the URL contract and the primitive's state ─────────

// The URL contract encodes sort as { field, dir }; the table primitive tracks
// sort as { columnKey, direction }. These two helpers translate between them so
// neither shape leaks across the boundary.
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

// ─── Client-side page refinements (documented contract gaps) ──────────────────

// Narrow a page to a single status. Used ONLY on the FTS tier, where the search
// endpoint has no `status` param (the list tier filters status server-side).
function applyStatusNarrow(rows, status) {
  if (!status) return rows;
  return rows.filter((a) => a && a.status === status);
}

// Narrow a page to a created-date range [from, to] (inclusive). `from`/`to` are
// ISO date strings from the URL contract; neither endpoint accepts them, so this
// is a page-scoped refinement. Comparison is lexicographic on ISO timestamps,
// which is correct for same-offset ISO-8601 strings (the API emits UTC ISO).
function applyDateRangeNarrow(rows, from, to) {
  if (!from && !to) return rows;
  const lo = from ? from : null;
  // Make `to` inclusive of the whole day when a bare YYYY-MM-DD is given.
  const hi = to ? (to.length === 10 ? to + 'T23:59:59.999Z' : to) : null;
  return rows.filter((a) => {
    const c = a && a.createdAt;
    if (!c) return false;
    if (lo && c < lo) return false;
    if (hi && c > hi) return false;
    return true;
  });
}

// Sort a page client-side for the axes the server does not sort by. Created-date
// ASC is the server's native order so we never re-sort it here; created-date DESC
// reverses the (createdAt-ascending) page; status/title use a locale compare.
function applyClientSort(rows, sort) {
  if (!sort || !sort.columnKey) return rows;
  const dir = sort.direction === SORT_DESC ? -1 : 1;
  const key = sort.columnKey;
  const out = rows.slice();
  if (key === SORT_KEY_CREATED) {
    // ASC is native (no-op); only DESC needs a reversal.
    if (dir === -1) {
      out.sort((a, b) =>
        String(b.createdAt || '').localeCompare(String(a.createdAt || '')) ||
        String(b.id || '').localeCompare(String(a.id || ''))
      );
    }
    return out;
  }
  if (key === SORT_KEY_STATUS) {
    out.sort(
      (a, b) => dir * String(a.status || '').localeCompare(String(b.status || ''))
    );
    return out;
  }
  if (key === SORT_KEY_TITLE) {
    const title = (a) => String(a.name || a.slug || a.id || '');
    out.sort((a, b) => dir * title(a).localeCompare(title(b)));
    return out;
  }
  return out;
}

// ─── Data-source router: choose the FTS tier or the exact/range list tier ─────
//
// Given the primitive's current interaction state, build and run the correct
// request. Returns { rows, total } where `total` is the backend's match count
// for offset paging. This is the ONLY place that talks to the network; it never
// invents an endpoint — both branches use verified paths/params.
//
// `deps.apiFetch(path)` is injected (app.js owns auth headers / stack scoping),
// which also keeps this module unit-testable without a live server.
async function fetchAssetsPage(snap, deps) {
  const apiFetch = deps.apiFetch;
  const filters = snap.filters || {};
  const q = (filters.q || '').trim();
  const status = filters.status || '';
  const from = filters.from || '';
  const to = filters.to || '';
  const limit = snap.pageSize;
  const offset = snap.offset;

  if (q) {
    // ── Tier 2: free-text FTS via the canonical GET /api/v1/search/ path. ──
    // Paged by page/pageSize (page is 1-based). Envelope: { assets, total, page }.
    const page = Math.floor(offset / limit) + 1;
    const params = new URLSearchParams();
    params.set('q', q);
    params.set('page', String(page));
    params.set('pageSize', String(limit));
    const res = await apiFetch('/search?' + params.toString());
    const assets = (res && (res.assets || res.items)) || [];
    const total = res && typeof res.total === 'number' ? res.total : assets.length;
    // The FTS endpoint has no status/date params — narrow the page client-side.
    let rows = applyStatusNarrow(assets, status);
    rows = applyDateRangeNarrow(rows, from, to);
    rows = applyClientSort(rows, snap.sort);
    return { rows, total };
  }

  // ── Tier 1: exact/range list via GET /api/v1/assets/ (Mango-style). ──
  // Paged by limit/offset. Envelope: { items, limit, offset, total }.
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  if (status) params.set('status', status); // server-side exact status filter
  const res = await apiFetch('/assets?' + params.toString());
  const items = (res && (res.items || res.assets)) || (Array.isArray(res) ? res : []);
  const total =
    res && typeof res.total === 'number' ? res.total : items.length;
  // Date-range has no server param — narrow this page client-side.
  let rows = applyDateRangeNarrow(items, from, to);
  rows = applyClientSort(rows, snap.sort);
  return { rows, total };
}

// ─── Filter controls (slot-based) ─────────────────────────────────────────────
//
// Each control is a factory the primitive mounts once into the filter bar; it
// wires its native events to the supplied `onChange(value)` (the primitive maps
// that to state.setFilter(name, value), which resets paging). Initial values come
// from the decoded URL state so a shared link reconstructs the controls.

function statusFilterControl(initial) {
  return function () {
    const wrap = document.createElement('label');
    wrap.className = 'ops-filter-status';
    const span = document.createElement('span');
    span.textContent = 'Status';
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Filter by status');
    const optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = 'All statuses';
    sel.appendChild(optAll);
    ASSET_STATUSES.forEach((s) => {
      const o = document.createElement('option');
      o.value = s;
      o.textContent = s;
      sel.appendChild(o);
    });
    if (initial) sel.value = initial;
    wrap.appendChild(span);
    wrap.appendChild(sel);
    return { el: wrap, input: sel, event: 'change', read: () => sel.value };
  };
}

function textFilterControl(name, labelText, placeholder, initial) {
  return function () {
    const wrap = document.createElement('label');
    wrap.className = 'ops-filter-' + name;
    const span = document.createElement('span');
    span.textContent = labelText;
    const input = document.createElement('input');
    input.type = name === 'q' ? 'search' : 'text';
    input.placeholder = placeholder || '';
    input.setAttribute('aria-label', labelText);
    if (initial) input.value = initial;
    wrap.appendChild(span);
    wrap.appendChild(input);
    return { el: wrap, input, event: 'change', read: () => input.value.trim() };
  };
}

function dateFilterControl(name, labelText, initial) {
  return function () {
    const wrap = document.createElement('label');
    wrap.className = 'ops-filter-' + name;
    const span = document.createElement('span');
    span.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'date';
    input.setAttribute('aria-label', labelText);
    if (initial) input.value = initial.length >= 10 ? initial.slice(0, 10) : initial;
    wrap.appendChild(span);
    wrap.appendChild(input);
    return { el: wrap, input, event: 'change', read: () => input.value };
  };
}

// Adapt one of the {el,input,event,read} descriptors above into the primitive's
// slot contract: `control(state, onChange) -> HTMLElement`. The primitive calls
// onChange(value); we forward the control's read() on its native event.
function asSlot(factory) {
  return function (_state, onChange) {
    const desc = factory();
    desc.input.addEventListener(desc.event, function () {
      onChange(desc.read());
    });
    return desc.el;
  };
}

// ─── Column definitions ───────────────────────────────────────────────────────
//
// Cell renderers return escaped HTML strings (the app.js convention the primitive
// documents). Every dynamic value passes through escHtml. Thumbnail/status/tags/
// actions markup mirrors the previous assets table so styling is unchanged.

function buildColumns(renderCtx) {
  const renderBadge = renderCtx.renderBadge;
  const renderTags = renderCtx.renderTags;
  const fmtDate = renderCtx.fmtDate;
  const isAssetWedged = renderCtx.isAssetWedged;

  return [
    {
      key: 'thumb',
      label: '',
      width: '52px',
      render: (a) =>
        a.thumbnails && a.thumbnails.length
          ? '<img src="/api/v1/assets/' +
            escHtml(a.id) +
            '/thumbnails/0" class="thumb-xs" alt="" loading="lazy" onerror="this.style.display=\'none\'">'
          : '<div class="thumb-xs thumb-placeholder"></div>',
    },
    {
      key: 'id',
      label: 'ID',
      render: (a) =>
        '<span class="cell-id" title="' +
        escHtml(a.id) +
        '">' +
        escHtml(a.slug || a.id) +
        '</span>',
    },
    {
      key: 'title',
      label: 'Name / Title',
      sortable: true,
      sortKey: SORT_KEY_TITLE,
      render: (a) => escHtml(a.name || a.slug || '—'),
    },
    {
      key: 'status',
      label: 'Status',
      sortable: true,
      sortKey: SORT_KEY_STATUS,
      render: (a) => {
        let cell = renderBadge(a.status);
        if (isAssetWedged(a)) {
          cell +=
            ' <span class="badge badge-attention asset-wedged-flag" data-id="' +
            escHtml(a.id) +
            '" title="' +
            escHtml(a.technicalMetadataError) +
            '">Needs attention</span>';
        }
        return cell;
      },
    },
    {
      key: 'tags',
      label: 'Tags',
      render: (a) => renderTags(a.tags),
    },
    {
      key: 'created',
      label: 'Created',
      sortable: true,
      sortKey: SORT_KEY_CREATED,
      render: (a) => escHtml(fmtDate(a.createdAt)),
    },
    {
      key: 'actions',
      label: 'Actions',
      render: (a) => {
        const wedged = isAssetWedged(a);
        return (
          (wedged
            ? '<button class="btn-ghost asset-redrive-btn" data-id="' +
              escHtml(a.id) +
              '" title="Re-run metadata extraction to recover this asset" style="font-size:12px;padding:3px 8px;">Re-drive</button> '
            : '') +
          '<button class="btn-danger asset-delete-btn" data-id="' +
          escHtml(a.id) +
          '" style="font-size:12px;padding:3px 8px;">Archive</button>'
        );
      },
    },
  ];
}

// ─── Public factory ───────────────────────────────────────────────────────────
//
// createAssetsTable(deps) -> { el, reload, destroy }
//
// deps:
//   apiFetch(path) -> Promise           — the app's auth/stack-aware fetch.
//   renderBadge(status) -> html string
//   renderTags(tags) -> html string
//   fmtDate(val) -> string
//   isAssetWedged(asset) -> boolean
//   onRowClick(asset, tr)               — open the detail panel for a row.
//   onDelete(id) -> Promise             — archive action; table reloads after.
//   onRedrive(id) -> Promise            — re-drive action; table reloads after.
//   win (optional)                      — injectable window for URL sync (tests).
//
// The table reads its initial sort/filter/page from the URL (shared contract),
// renders the shared primitive, fetches the correct tier on every state change,
// and writes state back to the URL so the view is shareable/refreshable.
export function createAssetsTable(deps) {
  const d = deps || {};
  const win = 'win' in d ? d.win : typeof window !== 'undefined' ? window : undefined;

  // 1) Reconstruct state from the URL (tolerant; never throws).
  const search = win && win.location ? win.location.search : '';
  const urlState = decodeTableState(search, ASSETS_NS, URL_DEFAULTS);

  // 2) Initial filter values for the controls come from the decoded URL.
  const initialFilters = {};
  if (urlState.q) initialFilters.q = urlState.q;
  if (urlState.status && urlState.status.length) initialFilters.status = urlState.status[0];
  if (urlState.from) initialFilters.from = urlState.from;
  if (urlState.to) initialFilters.to = urlState.to;

  const columns = buildColumns({
    renderBadge: d.renderBadge,
    renderTags: d.renderTags,
    fmtDate: d.fmtDate,
    isAssetWedged: d.isAssetWedged,
  });

  const filters = [
    { name: 'status', control: asSlot(statusFilterControl(initialFilters.status)) },
    { name: 'from', control: asSlot(dateFilterControl('from', 'Created from', initialFilters.from)) },
    { name: 'to', control: asSlot(dateFilterControl('to', 'Created to', initialFilters.to)) },
    { name: 'q', control: asSlot(textFilterControl('q', 'Search', 'Full-text search…', initialFilters.q)) },
  ];

  const table = createOpsTable({
    caption: '',
    columns,
    filters,
    pagingMode: PAGING_OFFSET,
    pageSize: urlState.size || ASSETS_PAGE_SIZE,
    initialSort: urlSortToInitialSort(urlState.sort),
    initialFilters,
    rowKey: (a) => a && a.id,
    emptyText: 'No assets found.',
  });

  // Guard so the URL sync we do inside the state subscription does not itself
  // re-enter as a "user change" (it does not — applyTableState only touches the
  // URL — but the flag keeps intent explicit and future-proofs re-entrancy).
  let loading = false;

  async function reload() {
    if (loading) return;
    loading = true;
    const snap = table.state.getState();

    // 3) Mirror the current interaction state into the URL (shared contract) so a
    //    refresh/share reproduces the view. Replace (not push) — control changes
    //    already re-render; we do not want a history entry per keystroke.
    const page = Math.floor((snap.offset || 0) / snap.pageSize) + 1;
    applyTableState(
      {
        sort: tableSortToUrlSort(snap.sort),
        status: snap.filters.status ? [snap.filters.status] : [],
        q: snap.filters.q || '',
        from: snap.filters.from || null,
        to: snap.filters.to || null,
        page,
        size: snap.pageSize,
      },
      ASSETS_NS,
      { defaults: URL_DEFAULTS, replace: true, win }
    );

    table.setStatus('loading');
    try {
      const { rows, total } = await fetchAssetsPage(snap, { apiFetch: d.apiFetch });
      table.state.setPageInfo({ total });
      table.setRows(rows);
      wireRowHandlers();
    } catch (err) {
      table.setStatus('error', 'Failed to load assets: ' + (err && err.message ? err.message : err));
    } finally {
      loading = false;
    }
  }

  // Attach row-level interactions after each render (rows are rebuilt each load).
  function wireRowHandlers() {
    const tbody = table.el.querySelector('tbody');
    if (!tbody) return;

    tbody.querySelectorAll('tr[data-row-key]').forEach(function (tr) {
      const id = tr.getAttribute('data-row-key');
      tr.addEventListener('click', function () {
        tbody.querySelectorAll('tr').forEach((r) => r.classList.remove('row-selected'));
        tr.classList.add('row-selected');
        if (typeof d.onRowClick === 'function') d.onRowClick(id, tr);
      });
    });

    tbody.querySelectorAll('.asset-delete-btn').forEach(function (btn) {
      btn.addEventListener('click', async function (e) {
        e.stopPropagation();
        if (typeof d.onDelete !== 'function') return;
        const ok = await d.onDelete(btn.dataset.id);
        if (ok !== false) reload();
      });
    });

    tbody.querySelectorAll('.asset-redrive-btn').forEach(function (btn) {
      btn.addEventListener('click', async function (e) {
        e.stopPropagation();
        if (typeof d.onRedrive !== 'function') return;
        const prev = btn.textContent;
        btn.disabled = true;
        btn.textContent = 'Re-driving…';
        const ok = await d.onRedrive(btn.dataset.id);
        if (ok !== false) {
          reload();
        } else {
          btn.disabled = false;
          btn.textContent = prev;
        }
      });
    });
  }

  // Any interaction (sort toggle / filter change / page nav) triggers a reload.
  // The primitive already re-renders its own chrome; we react to re-fetch data.
  table.state.subscribe(function () {
    reload();
  });

  // Kick off the first load.
  reload();

  return {
    el: table.el,
    reload,
    destroy: table.destroy,
    // Exposed for tests/consumers that want to drive the primitive directly.
    state: table.state,
    _table: table,
  };
}
