/**
 * open-videocore ops dashboard — jobs-table.js
 *
 * Wires the JOBS table onto the shared, already-merged primitives:
 *   - public/ops-ui-table.js     (createOpsTable: sort/filter/pagination chrome)
 *   - public/table-url-state.js  (encode/decode/apply table state to the URL)
 *
 * This module composes those primitives for the jobs surface (issue #370, parent
 * #366). It does NOT reinvent a table, sort, filter, or URL-state mechanism, and
 * it mirrors the intended per-table wiring pattern (a sibling PR does the same
 * for the assets table in public/assets-table.js).
 *
 * ─── CONTRACT (verified before any call was written) ──────────────────────────
 * Jobs are distinct `type: "job"` documents with their own status vocabulary
 * (ADR-005), served on their own query surface. The live listing contract is:
 *
 *   GET /api/v1/jobs/   (source of truth, verified 2026-08-27)
 *     - src/routes/jobs.ts:87-104  (querystring zod schema)
 *     - openapi.json  path "/api/v1/jobs/"  GET parameters
 *     QUERY PARAMS (the ONLY ones the endpoint accepts):
 *       limit   number, 1..100, default 50
 *       offset  number, >= 0,   default 0
 *     RESPONSE 200: { items: Job[], total: number }
 *
 *   Job status enum — JOB_STATUSES (src/data/job-repo.ts:35, identical in
 *   openapi.json job.status enum), confirmed to include 'cancelled' (added via
 *   #124/#126):
 *       'pending' | 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
 *
 * IMPORTANT CONSEQUENCE: the jobs listing endpoint exposes NO server-side sort,
 * status filter, date-range, or text-search parameter. Per the contract-first
 * rule we must not invent query params the endpoint does not accept. So this
 * table:
 *   - PAGES against the server using only the real `limit`/`offset` params, over
 *     a BOUNDED working window (never a full-set load), and
 *   - applies sort / status filter / date-range / id-text-search CLIENT-SIDE
 *     over that bounded window.
 * The missing server-side capabilities are logged as API friction so the backend
 * can add them (see the OSC-feedback log in the sibling `eng-open-videocore-agents`
 * repo: docs/osc-feedback/incoming-jobs-table-server-sort-filter.md); when it
 * does, this file swaps the client-side passes for real query params without
 * changing the UI. The URL-state contract already reserves sort/status/q/from/to/
 * page keys, so no URL change is needed at that point.
 *
 * Until then, because the client-side passes only see the bounded newest-100
 * window, the table renders an operator-visible truncation banner whenever the
 * server's true total (res.total) exceeds that window, so counts like a
 * "Failed only" "N of N" are never mistaken for the complete system-wide set.
 *
 * Security note: mirrors app.js / the primitive's XSS posture — every dynamic
 * value is escaped (escHtml) before entering a cell's innerHTML string.
 */

import { createOpsTable, escHtml, SORT_DESC } from './ops-ui-table.js';
import {
  decodeTableState,
  applyTableState,
  SORT_DIR,
} from './table-url-state.js';

// ─── Contract-grounded constants ──────────────────────────────────────────────

// Job status vocabulary — verified against JOB_STATUSES (src/data/job-repo.ts:35)
// and the openapi.json job.status enum. Do NOT hand-edit; keep in lockstep with
// the backend enum. `failed` is the primary operator isolation target.
export const JOB_STATUSES = Object.freeze([
  'pending',
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
]);

// URL-state namespace for this table (table-url-state.js emits `jobs.<key>`).
export const JOBS_NS = 'jobs';

// Bounded, visible page size (acceptance criterion). Also the client-side page.
export const JOBS_PAGE_SIZE = 20;

// Bounded server working window. The jobs endpoint caps `limit` at 100
// (src/routes/jobs.ts:93); we fetch at most this many rows in one bounded call
// and never load the full set. Client-side sort/filter/search operate over this
// window. This is the honest ceiling until the endpoint gains real query params.
export const JOBS_WORKING_SET_MAX = 100;

// Columns whose client-side sort we support. `key` is the row field; the URL
// contract stores the sort field token, so these MUST match what we serialize.
const SORTABLE_FIELDS = Object.freeze({
  id: 'id',
  status: 'status',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt',
});

// The table's natural default order matches the server's own default: newest
// first by createdAt. Kept as the URL-state default so a pristine URL is clean.
const JOBS_DEFAULTS = Object.freeze({
  sort: { field: SORTABLE_FIELDS.createdAt, dir: SORT_DIR.desc },
  size: JOBS_PAGE_SIZE,
});

// ─── Pure client-side sort / filter / search over the bounded window ──────────
// These are exported for unit testing (no DOM, no fetch). They encode the
// filter semantics the endpoint cannot yet express server-side.

/** Case-insensitive substring match, tolerant of nullish fields. */
function includesCI(haystack, needle) {
  if (!needle) return true;
  return String(haystack ?? '').toLowerCase().includes(String(needle).toLowerCase());
}

/**
 * Filter jobs by a status set, an inclusive date range on createdAt, and a
 * free-text needle matched against job id OR associated asset id.
 *
 * @param {Array} jobs
 * @param {{ status?: string[], from?: string|null, to?: string|null, q?: string }} f
 */
export function filterJobs(jobs, f) {
  const list = Array.isArray(jobs) ? jobs : [];
  const statuses = Array.isArray(f && f.status) ? f.status.filter(Boolean) : [];
  const from = f && f.from ? Date.parse(f.from) : NaN;
  // `to` is an inclusive upper bound. When given as a bare date (YYYY-MM-DD)
  // extend to end-of-day so a same-day `to` includes that whole day.
  let to = NaN;
  if (f && f.to) {
    const bareDate = /^\d{4}-\d{2}-\d{2}$/.test(String(f.to).trim());
    to = Date.parse(bareDate ? String(f.to).trim() + 'T23:59:59.999Z' : f.to);
  }
  const q = f && typeof f.q === 'string' ? f.q.trim() : '';

  return list.filter((j) => {
    if (statuses.length && !statuses.includes(j.status)) return false;
    if (!Number.isNaN(from) || !Number.isNaN(to)) {
      const t = Date.parse(j.createdAt);
      if (!Number.isNaN(from) && !(t >= from)) return false;
      if (!Number.isNaN(to) && !(t <= to)) return false;
    }
    if (q && !(includesCI(j.id, q) || includesCI(j.assetId, q))) return false;
    return true;
  });
}

/**
 * Stable sort a job list by one field/direction. Falls back to createdAt-desc
 * (the server's natural order) when no sort is active.
 *
 * @param {Array} jobs
 * @param {{ field: string, dir: 'asc'|'desc' }|null} sort
 */
export function sortJobs(jobs, sort) {
  const list = Array.isArray(jobs) ? jobs.slice() : [];
  const field = sort && SORTABLE_FIELDS[sort.field] ? sort.field : SORTABLE_FIELDS.createdAt;
  const dir = sort && sort.dir === SORT_DIR.asc ? 'asc' : 'desc';
  const mul = dir === 'asc' ? 1 : -1;
  // Decorate-sort-undecorate for a stable order (Array.sort is stable in modern
  // engines, but we key deterministically so equal keys keep input order).
  return list
    .map((j, i) => ({ j, i }))
    .sort((a, b) => {
      const av = String(a.j[field] ?? '');
      const bv = String(b.j[field] ?? '');
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return cmp !== 0 ? cmp * mul : a.i - b.i;
    })
    .map((d) => d.j);
}

/** Slice one client-side page out of a filtered+sorted list. */
export function pageJobs(jobs, offset, size) {
  const list = Array.isArray(jobs) ? jobs : [];
  const o = Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0;
  const s = Number.isFinite(size) && size > 0 ? Math.floor(size) : JOBS_PAGE_SIZE;
  return list.slice(o, o + s);
}

// ─── Filter controls (slot factories for the shared primitive) ────────────────
// Each returns a DOM control that calls onChange(value) so the primitive's
// state.setFilter(name, value) records it. We keep the control DOM minimal and
// accessible (labelled inputs). Initial values come from the decoded URL state.

function labelled(labelText, control, forId) {
  const frag = document.createDocumentFragment();
  const label = document.createElement('label');
  label.className = 'ops-filter-label';
  label.textContent = labelText;
  if (forId) label.htmlFor = forId;
  frag.appendChild(label);
  frag.appendChild(control);
  return frag;
}

function statusFilterControl(initialStatus) {
  return function control(_state, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'ops-filter-slot-inner';

    const sel = document.createElement('select');
    sel.id = 'jobs-filter-status';
    sel.className = 'ops-filter-select';
    // 'all' + a dedicated 'failed' entry (primary operator need) + every status.
    const opts = [
      { value: '', label: 'All statuses' },
      { value: 'failed', label: 'Failed only' },
      ...JOB_STATUSES.map((s) => ({ value: s, label: s })),
    ];
    // De-dupe the explicit 'failed' shortcut against the enum entry.
    const seen = new Set();
    opts.forEach((o) => {
      const key = o.value + '|' + o.label;
      if (seen.has(key)) return;
      seen.add(key);
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    // Reflect initial URL state (single status; the URL contract supports a set,
    // but this control edits one at a time — a comma set still round-trips).
    if (Array.isArray(initialStatus) && initialStatus.length === 1) {
      sel.value = initialStatus[0];
    }
    sel.addEventListener('change', () => {
      // Empty string clears the filter (primitive treats '' as "unset").
      onChange(sel.value);
    });

    wrap.appendChild(labelled('Status', sel, sel.id));
    return wrap;
  };
}

function dateInput(id, labelText, initialValue, onValue) {
  const wrap = document.createElement('div');
  wrap.className = 'ops-filter-slot-inner';
  const input = document.createElement('input');
  input.type = 'date';
  input.id = id;
  input.className = 'ops-filter-date';
  if (initialValue) input.value = initialValue;
  input.addEventListener('change', () => onValue(input.value));
  wrap.appendChild(labelled(labelText, input, id));
  return wrap;
}

function fromDateControl(initial) {
  return function control(_state, onChange) {
    return dateInput('jobs-filter-from', 'From', initial, (v) => onChange(v));
  };
}

function toDateControl(initial) {
  return function control(_state, onChange) {
    return dateInput('jobs-filter-to', 'To', initial, (v) => onChange(v));
  };
}

function searchControl(initial) {
  return function control(_state, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'ops-filter-slot-inner';
    const input = document.createElement('input');
    input.type = 'search';
    input.id = 'jobs-filter-q';
    input.className = 'ops-filter-search';
    input.placeholder = 'Job id or asset id';
    if (initial) input.value = initial;
    // Fire on input (debounced lightly) so text search feels live.
    let timer = null;
    input.addEventListener('input', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => onChange(input.value), 200);
    });
    wrap.appendChild(labelled('Search', input, input.id));
    return wrap;
  };
}

// ─── Factory ──────────────────────────────────────────────────────────────────
//
// createJobsTable(deps) -> { el, refresh, destroy, table }
//
// deps (injected by app.js so this module stays decoupled + unit-testable):
//   apiFetch(path)          -> Promise<any>   (the existing /api/v1 fetch helper)
//   fmtDate(iso)            -> string         (app.js date formatter)
//   renderBadge(status)     -> escaped HTML   (app.js status badge)
//   onSelect(jobId)         -> void           (row click -> open detail panel)
//   onCancel(jobId)         -> Promise|void   (cancel button click)
//   win                     -> Window|null    (for URL state; defaults to window)
//
// The consumer mounts `el`, then the table self-loads. Sort/filter/page changes
// re-fetch the bounded window (only when needed) and re-render client-side.
export function createJobsTable(deps) {
  const d = deps || {};
  const apiFetch = d.apiFetch;
  const fmtDate = typeof d.fmtDate === 'function' ? d.fmtDate : (v) => String(v ?? '');
  const renderBadge = typeof d.renderBadge === 'function'
    ? d.renderBadge
    : (s) => escHtml(s ?? '');
  const onSelect = typeof d.onSelect === 'function' ? d.onSelect : () => {};
  const onCancel = typeof d.onCancel === 'function' ? d.onCancel : () => {};
  const win = 'win' in d ? d.win : (typeof window !== 'undefined' ? window : null);

  if (typeof apiFetch !== 'function') {
    throw new Error('createJobsTable requires deps.apiFetch');
  }

  // Seed interaction state from the URL so a shared link / refresh reconstructs
  // the exact view (per the URL-state contract acceptance criterion).
  const search = win && win.location ? win.location.search : '';
  const initial = decodeTableState(search, JOBS_NS, JOBS_DEFAULTS);

  // The full bounded working window (fetched once per server round-trip). Client
  // sort/filter/search/paging derive their view from this.
  let workingSet = [];
  // The true, system-wide job count reported by the server (`res.total` from
  // GET /api/v1/jobs/ -> { items, total }; src/data/job-repo.ts:356 sets
  // total = all.length). Kept distinct from the client-filtered count so the
  // truncation banner can tell the operator the honest total.
  let serverTotal = 0;
  let selectedId = null;

  // Map URL sort (field/dir) -> primitive initialSort (columnKey/direction).
  const initialSort = initial.sort
    ? {
        columnKey: initial.sort.field,
        direction: initial.sort.dir === SORT_DIR.asc ? 'asc' : SORT_DESC,
      }
    : { columnKey: SORTABLE_FIELDS.createdAt, direction: SORT_DESC };

  // Seed initial filters into the primitive's filter object so its controls and
  // our client-side passes agree from the first paint.
  const initialFilters = {};
  if (Array.isArray(initial.status) && initial.status.length === 1) {
    initialFilters.status = initial.status[0];
  }
  if (initial.from) initialFilters.from = initial.from;
  if (initial.to) initialFilters.to = initial.to;
  if (initial.q) initialFilters.q = initial.q;

  const table = createOpsTable({
    caption: 'Jobs',
    pagingMode: 'offset',
    pageSize: JOBS_PAGE_SIZE,
    initialSort,
    initialFilters,
    emptyText: 'No jobs match the current filters.',
    rowKey: (row) => row && row.id,
    columns: [
      {
        key: 'id',
        label: 'ID',
        sortable: true,
        sortKey: SORTABLE_FIELDS.id,
        render: (j) => '<span class="cell-id">' + escHtml(j.id) + '</span>',
      },
      { key: 'type', label: 'Type', render: (j) => escHtml(j.type || '—') },
      {
        key: 'status',
        label: 'Status',
        sortable: true,
        sortKey: SORTABLE_FIELDS.status,
        render: (j) => renderBadge(j.status),
      },
      {
        key: 'assetId',
        label: 'Asset ID',
        render: (j) => '<span class="cell-id">' + escHtml(j.assetId || '—') + '</span>',
      },
      {
        key: 'progress',
        label: 'Progress',
        render: (j) => (j.progress != null ? escHtml(j.progress + '%') : '—'),
      },
      {
        key: 'createdAt',
        label: 'Created',
        sortable: true,
        sortKey: SORTABLE_FIELDS.createdAt,
        render: (j) => escHtml(fmtDate(j.createdAt)),
      },
      {
        key: 'updatedAt',
        label: 'Updated',
        sortable: true,
        sortKey: SORTABLE_FIELDS.updatedAt,
        render: (j) => escHtml(fmtDate(j.updatedAt)),
      },
      {
        key: 'actions',
        label: '',
        render: (j) =>
          j.status === 'running' || j.status === 'pending'
            ? '<button class="btn-danger job-cancel-btn" data-id="' +
              escHtml(j.id) +
              '" style="font-size:12px;padding:3px 8px;">Cancel</button>'
            : '',
      },
    ],
    filters: [
      { name: 'status', control: statusFilterControl(initial.status) },
      { name: 'from', control: fromDateControl(initial.from) },
      { name: 'to', control: toDateControl(initial.to) },
      { name: 'q', control: searchControl(initial.q) },
    ],
  });

  // ── Honest-cap disclosure banner ──────────────────────────────────────────
  // The jobs endpoint has NO server-side sort/filter/search (contract: only
  // limit/offset, src/routes/jobs.ts:91-93). We fetch the newest
  // JOBS_WORKING_SET_MAX (100) and sort/filter/page CLIENT-SIDE. When the true
  // server total (res.total) exceeds the window we actually hold, the operator
  // MUST be told that filters and counts only reflect that window — otherwise
  // "Failed only" showing e.g. "3 of 3" would falsely imply the complete
  // failure set, hiding any failed job older than the 100th-most-recent. This
  // banner makes the cap visible. role="status" so assistive tech announces it.
  const truncationBanner = document.createElement('div');
  truncationBanner.className = 'ops-table-truncation';
  truncationBanner.setAttribute('role', 'status');
  truncationBanner.hidden = true;
  // Insert directly above the filter bar so it reads before the controls it
  // qualifies. The primitive appended: caption, filters, scroll, pagination.
  const filterBarEl = table.el.querySelector('.ops-table-filters');
  if (filterBarEl && filterBarEl.parentNode) {
    filterBarEl.parentNode.insertBefore(truncationBanner, filterBarEl);
  } else {
    table.el.appendChild(truncationBanner);
  }

  // ── Derive the current view (filter -> sort -> page) from the working set ──
  function currentUrlState() {
    const snap = table.state.getState();
    const sort = snap.sort.columnKey
      ? { field: snap.sort.columnKey, dir: snap.sort.direction === 'asc' ? SORT_DIR.asc : SORT_DIR.desc }
      : null;
    const status = snap.filters.status ? [snap.filters.status] : [];
    return {
      sort,
      status,
      from: snap.filters.from || null,
      to: snap.filters.to || null,
      q: snap.filters.q || '',
      // 1-based page for the URL contract, derived from the offset page index.
      page: (snap.pageIndex || 0) + 1,
      size: JOBS_PAGE_SIZE,
    };
  }

  function syncUrl() {
    // Reflect sort/filter/page into the URL via the shared contract (replace so
    // routine derived changes don't spam history; the primitive drives these).
    applyTableState(currentUrlState(), JOBS_NS, {
      defaults: JOBS_DEFAULTS,
      replace: true,
      win: win || undefined,
    });
  }

  // Re-entrancy guard: renderView() calls table.state.setPageInfo(), which the
  // primitive emits on — and we subscribe to that same emit to recompute the
  // view. Without this flag the setPageInfo emit would re-enter renderView()
  // recursively. We recompute once, then swallow the nested emit.
  let renderingView = false;
  function renderView() {
    if (renderingView) return;
    renderingView = true;
    try {
      renderViewInner();
    } finally {
      renderingView = false;
    }
  }

  function renderViewInner() {
    const snap = table.state.getState();
    const filtered = sortJobs(
      filterJobs(workingSet, {
        status: snap.filters.status ? [snap.filters.status] : [],
        from: snap.filters.from || null,
        to: snap.filters.to || null,
        q: snap.filters.q || '',
      }),
      snap.sort.columnKey
        ? { field: snap.sort.columnKey, dir: snap.sort.direction === 'asc' ? SORT_DIR.asc : SORT_DIR.desc }
        : null
    );
    // The primitive's offset paging pages the CLIENT-filtered set: report the
    // filtered length as the total so its indicator + prev/next stay correct.
    table.state.setPageInfo({ total: filtered.length });
    const pageRows = pageJobs(filtered, snap.offset, JOBS_PAGE_SIZE);
    table.setRows(pageRows);
    wireRowInteractions();
    updateTruncationBanner();
    syncUrl();
  }

  // Show/hide the honest-cap banner. The window is truncated when the server's
  // true total exceeds the number of rows we actually hold in the working set;
  // in that case sort/filter/search/counts only apply to the newest window.
  function updateTruncationBanner() {
    const held = workingSet.length;
    const truncated = serverTotal > held;
    truncationBanner.hidden = !truncated;
    if (truncated) {
      truncationBanner.textContent =
        'Showing the newest ' + held + ' of ' + serverTotal +
        ' jobs — filters and counts apply to this window only.';
    } else {
      truncationBanner.textContent = '';
    }
  }

  // ── Fetch the bounded server window (the ONLY network path) ──
  async function fetchWorkingSet(silent) {
    if (!silent) table.setStatus('loading');
    try {
      // Contract: /api/v1/jobs/ accepts ONLY limit + offset. We fetch a bounded
      // window from offset 0 (never a full-set load) and page/sort/filter it
      // client-side. limit is capped at the endpoint max (100).
      const qs = 'limit=' + JOBS_WORKING_SET_MAX + '&offset=0';
      const res = await apiFetch('/jobs?' + qs);
      workingSet = (res && Array.isArray(res.items)) ? res.items : [];
      // Capture the true system-wide total (res.total) so the truncation banner
      // reflects reality once there are >100 jobs. Fall back to the window size
      // if a caller/stub omits it, so we never over-claim truncation.
      serverTotal = (res && typeof res.total === 'number') ? res.total : workingSet.length;
      renderView();
    } catch (err) {
      if (silent) return;
      table.setStatus('error', 'Failed to load jobs: ' + (err && err.message ? err.message : String(err)));
    }
  }

  // ── Row click + cancel-button wiring (re-applied after each setRows) ──
  function wireRowInteractions() {
    const tbody = table.el.querySelector('tbody');
    if (!tbody) return;
    tbody.querySelectorAll('tr[data-row-key]').forEach((tr) => {
      const id = tr.dataset.rowKey;
      if (id === selectedId) tr.classList.add('row-selected');
      tr.addEventListener('click', () => {
        tbody.querySelectorAll('tr').forEach((r) => r.classList.remove('row-selected'));
        tr.classList.add('row-selected');
        selectedId = id;
        onSelect(id);
      });
    });
    tbody.querySelectorAll('.job-cancel-btn').forEach((btn) => {
      btn.addEventListener('click', async (e) => {
        e.stopPropagation();
        btn.disabled = true;
        try {
          await onCancel(btn.dataset.id);
          await fetchWorkingSet();
        } catch (err) {
          btn.disabled = false;
          // Surface via alert to match app.js's existing cancel-error UX.
          if (typeof win !== 'undefined' && win && typeof win.alert === 'function') {
            win.alert('Error: ' + (err && err.message ? err.message : String(err)));
          }
        }
      });
    });
  }

  // Re-render the client view whenever the user changes sort/filter/page. The
  // primitive emits on every interaction; we recompute the view WITHOUT a new
  // network round-trip (the bounded window is already in memory).
  table.state.subscribe(() => {
    renderView();
  });

  return {
    el: table.el,
    table,
    // Public refresh (used by a Refresh button and the poll timer). `silent`
    // avoids the loading flash during background polls.
    refresh: (silent) => fetchWorkingSet(silent),
    setSelected: (id) => { selectedId = id; },
    destroy: () => table.destroy(),
  };
}
