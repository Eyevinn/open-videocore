/**
 * open-videocore ops dashboard — audit-table.js
 *
 * Issue #987: a top-level, cross-cutting AUDIT view over the audit query API.
 *
 * Until now the audit log had no cross-cutting surface in the UI: the only
 * lifecycle history an operator could see was per-asset (the asset detail
 * status-history trail, public/app.js:2614-2660), so questions that span
 * resources — "what was archived", "every failed job", "which collections were
 * deleted", "what did the system do vs an operator" — had nowhere to be asked.
 * This table asks them against the real query endpoint.
 *
 * Composed from the already-merged shared primitives; it reinvents no table,
 * filter, paging or URL-state machinery:
 *   - public/ops-ui-table.js     (#367/#372) — table component + state hook.
 *   - public/table-url-state.js  (#368/#373) — the URL query-param contract.
 *
 * Like the logs table (#371) and unlike the assets/jobs tables, EVERY filter
 * here is server-side: the endpoint accepts real filter params, so the table
 * never filters a bounded client window and never has to disclaim its counts.
 * Paging is OFFSET (the endpoint's own paging mode), so the primitive's offset
 * mode is used directly — no cursor handling.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (fetch-the-contract-before-writing-any-call, CLAUDE.md #7)
 *
 * Endpoint: GET /api/v1/audit  — verified 2026-09-30 against the route source
 * and the generated spec, NOT the issue text (which differed: it described a
 * flat `origin`/`timestamp` item, the real item nests the actor and names the
 * instant `at`).
 *
 *   Route:  src/routes/audit.ts:90-121  (`auditRouter`, GET '/')
 *   Mount:  src/main.ts:2334-2337       (prefix '/api/v1/audit')
 *   Spec:   openapi.json .paths["/api/v1/audit/"].get
 *
 *   QUERY PARAMS (listQuerySchema, src/routes/audit.ts:62-72) — the ONLY params
 *   the endpoint accepts:
 *     limit       integer 1..200          (AUDIT_MAX_LIMIT, audit-repo.ts:135)
 *     offset      integer >= 0
 *     targetType  enum asset|collection|job (AUDIT_TARGET_TYPES, audit-repo.ts:40)
 *     targetId    string, min 1
 *     origin      enum user|system|ai       (PROVENANCE_ACTORS_FOR_AUDIT,
 *                                            audit-repo.ts:48 -> asset-repo.ts:99)
 *     principalId string, min 1
 *     action      string, min 1 (EXACT match — applyAuditQuery, audit-repo.ts:147)
 *     from / to   string, inclusive ISO-8601 bounds on `at` (audit-repo.ts:148-149)
 *
 *   HARD RULE: `targetId` WITHOUT `targetType` is a 400 `invalid_query`
 *   (src/routes/audit.ts:102-107). buildAuditQuery() drops a lone targetId
 *   rather than let the UI send a request the route rejects by construction.
 *
 *   RESPONSE 200 envelope (listSchema, src/routes/audit.ts:75-80):
 *     { items: AuditEntry[], limit: number, offset: number, total: number }
 *     `total` counts matches BEFORE limit/offset (audit-repo.ts:157), so it is
 *     the honest count the primitive's offset pager needs.
 *
 *   AuditEntry item (auditEntrySchema, src/routes/audit.ts:50-58):
 *     id         string   (ULID)
 *     at         string   (ISO-8601 instant — NOT `timestamp`)
 *     actor      { principalId: string|null, origin: 'user'|'system'|'ai' }
 *     action     string
 *     targetType 'asset'|'collection'|'job'
 *     targetId   string
 *     detail     object (free-form; AuditDetailSchema, audit-repo.ts:65)
 *
 *   ORDER: fixed newest-first by `at`, ULID tiebreak (applyAuditQuery,
 *   src/data/audit-repo.ts:152-156). The endpoint exposes NO sort/order param,
 *   so — per the contract-honesty rule the logs table set — NO column here is
 *   made sortable. Offering a sort control the API cannot honour would either
 *   lie or silently re-sort one page.
 *
 *   IDENTITY: `actor.principalId` is a nullable placeholder — auth is a
 *   presence-only gate and read-authorization/principal identity is deferred to
 *   #525 (src/data/audit-repo.ts:50-54, src/data/audit-emit.ts:38-47). Every
 *   entry therefore reports `null` today. The Actor column and the note above
 *   the filter bar say so plainly instead of implying an unknown person; the
 *   coarse `origin` filter is what answers "user or system or ai". No identity
 *   is invented.
 *
 * SECURITY: mirrors app.js / the primitive's XSS posture — every dynamic value
 * written into a cell HTML string passes through escHtml().
 */

import { createOpsTable, escHtml, PAGING_OFFSET } from './ops-ui-table.js';
import { decodeTableState, encodeTableState } from './table-url-state.js';

// ─── Contract-grounded constants ─────────────────────────────────────────────

// URL-state namespace for this table (`audit.from`, `audit.page`, …).
export const AUDIT_NS = 'audit';

// Target vocabulary — AUDIT_TARGET_TYPES (src/data/audit-repo.ts:40), identical
// to the `targetType` enum in openapi.json. Keep in lockstep with the backend.
export const AUDIT_TARGET_TYPES = Object.freeze(['asset', 'collection', 'job']);

// Coarse actor origin — PROVENANCE_ACTORS_FOR_AUDIT (src/data/audit-repo.ts:48),
// which re-exports PROVENANCE_ACTORS (src/data/asset-repo.ts:99).
export const AUDIT_ORIGINS = Object.freeze(['user', 'system', 'ai']);

// Bounded, visible page size. AUDIT_DEFAULT_LIMIT is 50 and AUDIT_MAX_LIMIT is
// 200 (src/data/audit-repo.ts:132-135); we page at the endpoint's own default.
export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_LIMIT_MAX = 200;

// Known action strings, for the action control's suggestion list ONLY.
//
// `action` is `z.string()` on the wire (src/routes/audit.ts:69) — an OPEN field,
// not a published enum — so this list must never become a closed <select>: a new
// emission site would silently become unfilterable. It is the set of actions the
// backend emits today, read off the emitAudit() call sites:
//   asset.created           src/routes/assets.ts:2766
//   asset.metadata_updated  src/routes/assets.ts:5269
//   asset.status_changed    src/routes/assets.ts:5614
//   asset.archived          src/routes/assets.ts:5704
//   asset.restored          src/routes/assets.ts:5833
//   collection.created      src/routes/collections.ts:332
//   collection.deleted      src/routes/collections.ts:511
//   collection.member_added src/routes/collections.ts:616
//   collection.member_removed src/routes/collections.ts:649
//   job.submitted           src/pipeline/transcode.ts:108, packaging.ts:517
//   job.completed           src/pipeline/transcode.ts:332, packaging.ts:589
//   job.failed              src/pipeline/transcode.ts:281, packaging.ts:616
// The control is a free-text input backed by this <datalist>, so an action that
// is not listed can still be typed and queried exactly.
export const KNOWN_AUDIT_ACTIONS = Object.freeze([
  'asset.created',
  'asset.metadata_updated',
  'asset.status_changed',
  'asset.archived',
  'asset.restored',
  'collection.created',
  'collection.deleted',
  'collection.member_added',
  'collection.member_removed',
  'job.submitted',
  'job.completed',
  'job.failed',
]);

// The audit-specific filter keys. The shared URL-state contract has a FIXED key
// schema (sort/status/q/from/to/page/cursor/size — public/table-url-state.js:
// 52-60) with no targetType/origin/action member, and encodeTableState() deletes
// only those fixed keys within the namespace (table-url-state.js:330-333). So
// these three are written alongside it under the same `audit.` namespace and
// survive its re-encode untouched — the shared contract is reused, not forked.
const EXTRA_URL_KEYS = Object.freeze(['targetType', 'targetId', 'origin', 'action']);

// Shared-contract defaults for this table. No sort (the endpoint has none).
const URL_DEFAULTS = Object.freeze({ sort: null, size: AUDIT_PAGE_SIZE });

// ─── Pure query builder (exported for unit testing; no DOM, no fetch) ────────

function isBareDate(v) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(v).trim());
}

function trimmed(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * Build the querystring for GET /api/v1/audit from the primitive's state
 * snapshot. Emits ONLY the verified params; never an invented key, and never a
 * combination the route rejects.
 *
 * @param {object} snap  the primitive state snapshot (state.getState()).
 * @returns {URLSearchParams}
 */
export function buildAuditQuery(snap) {
  const s = snap || {};
  const f = s.filters || {};
  const params = new URLSearchParams();

  // Bounded page size, defensively clamped to the endpoint's [1, 200] window.
  let limit = Number.isFinite(s.pageSize) && s.pageSize > 0 ? Math.floor(s.pageSize) : AUDIT_PAGE_SIZE;
  if (limit < 1) limit = 1;
  if (limit > AUDIT_LIMIT_MAX) limit = AUDIT_LIMIT_MAX;
  params.set('limit', String(limit));

  // Offset paging (the endpoint's own mode; minimum 0).
  const offset = Number.isFinite(s.offset) && s.offset > 0 ? Math.floor(s.offset) : 0;
  params.set('offset', String(offset));

  // targetType — closed enum; anything else is dropped rather than sent.
  const targetType = trimmed(f.targetType);
  if (AUDIT_TARGET_TYPES.includes(targetType)) {
    params.set('targetType', targetType);
    // targetId is only meaningful as half of a (type, id) target and is a 400
    // on its own (src/routes/audit.ts:102-107), so it rides inside this branch.
    const targetId = trimmed(f.targetId);
    if (targetId) params.set('targetId', targetId);
  }

  // origin — closed enum (user|system|ai).
  const origin = trimmed(f.origin);
  if (AUDIT_ORIGINS.includes(origin)) params.set('origin', origin);

  // action — EXACT match server-side; sent verbatim (trimmed), open vocabulary.
  const action = trimmed(f.action);
  if (action) params.set('action', action);

  // Inclusive ISO-8601 bounds on `at`. Date inputs yield bare YYYY-MM-DD, so
  // widen `from` to start-of-day and `to` to end-of-day (UTC) — otherwise a
  // same-day `to` would exclude everything that happened that day.
  const from = trimmed(f.from);
  const to = trimmed(f.to);
  if (from) params.set('from', isBareDate(from) ? from + 'T00:00:00.000Z' : from);
  if (to) params.set('to', isBareDate(to) ? to + 'T23:59:59.999Z' : to);

  return params;
}

/**
 * One-line summary of an entry's free-form `detail` bag (AuditDetailSchema —
 * arbitrary string-keyed JSON, src/data/audit-repo.ts:65). Pure; returns a
 * PLAIN string (the caller escapes it before it enters a cell).
 *
 * @param {object} detail
 * @param {number} [maxLen]
 * @returns {string}
 */
export function summariseDetail(detail, maxLen) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return '';
  const cap = Number.isFinite(maxLen) && maxLen > 0 ? maxLen : 140;
  const parts = Object.keys(detail).map(function (k) {
    const v = detail[k];
    let text;
    if (v === null || v === undefined) text = 'null';
    else if (typeof v === 'object') {
      try {
        text = JSON.stringify(v);
      } catch {
        text = '[object]';
      }
    } else text = String(v);
    return k + '=' + text;
  });
  const joined = parts.join(' · ');
  return joined.length > cap ? joined.slice(0, cap - 1) + '…' : joined;
}

// ─── Filter controls (slot-based) ────────────────────────────────────────────
//
// Styling deliberately reuses the EXISTING jobs-tab filter-bar classes
// (.ops-filter-slot-inner / .ops-filter-label / .ops-filter-select /
// .ops-filter-date / .ops-filter-search, public/style.css:1904-1972) — the bar
// that already has colours on main. The shared filter-bar colour work in #983 is
// not merged, so nothing here depends on it; these controls inherit the same
// surface/border/text variables the Jobs controls use and cannot render
// white-on-dark.
//
// An UNSET control must READ as unset (issue #984): the same `is-unset` class
// jobs-table.js toggles (public/jobs-table.js:194-198) is applied here, since a
// <select>'s placeholder option and an empty date input have no native
// placeholder to dim.

const UNSET_CLASS = 'is-unset';

function markUnset(control) {
  control.classList.toggle(UNSET_CLASS, control.value === '');
}

// Mirrors jobs-table.js labelled(): a small uppercase caption above the control,
// programmatically associated with it (label.htmlFor) for screen readers.
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

function selectControl(id, labelText, placeholderLabel, values, initial) {
  return function control(_state, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'ops-filter-slot-inner';

    const sel = document.createElement('select');
    sel.id = id;
    sel.className = 'ops-filter-select';

    const opts = [{ value: '', label: placeholderLabel }].concat(
      values.map(function (v) {
        return { value: v, label: v };
      })
    );
    opts.forEach(function (o) {
      const opt = document.createElement('option');
      opt.value = o.value;
      opt.textContent = o.label;
      sel.appendChild(opt);
    });
    if (initial && values.includes(initial)) sel.value = initial;
    markUnset(sel);
    sel.addEventListener('change', function () {
      markUnset(sel);
      onChange(sel.value);
    });

    wrap.appendChild(labelled(labelText, sel, sel.id));
    return wrap;
  };
}

function dateControl(id, labelText, initial) {
  return function control(_state, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'ops-filter-slot-inner';
    const input = document.createElement('input');
    input.type = 'date';
    input.id = id;
    input.className = 'ops-filter-date';
    if (initial) input.value = String(initial).slice(0, 10);
    markUnset(input);
    input.addEventListener('change', function () {
      markUnset(input);
      onChange(input.value);
    });
    // A keyboard clear can fire `input` without `change` in some engines.
    input.addEventListener('input', function () {
      markUnset(input);
    });
    wrap.appendChild(labelled(labelText, input, id));
    return wrap;
  };
}

// Action: a free-text box (the server matches EXACTLY) backed by a datalist of
// the actions the backend emits today. Free text, not a <select>, because the
// wire type is an open string — a new action must stay queryable without a UI
// release.
function actionControl(initial) {
  return function control(_state, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'ops-filter-slot-inner';

    const listId = 'audit-filter-action-options';
    const list = document.createElement('datalist');
    list.id = listId;
    KNOWN_AUDIT_ACTIONS.forEach(function (a) {
      const opt = document.createElement('option');
      opt.value = a;
      list.appendChild(opt);
    });

    const input = document.createElement('input');
    input.type = 'text';
    input.id = 'audit-filter-action';
    input.className = 'ops-filter-search';
    input.placeholder = 'e.g. asset.archived';
    input.setAttribute('list', listId);
    if (initial) input.value = initial;
    // Debounce lightly: each keystroke would otherwise be a server round-trip.
    let timer = null;
    input.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        onChange(input.value.trim());
      }, 250);
    });

    wrap.appendChild(labelled('Action (exact)', input, input.id));
    wrap.appendChild(list);
    return wrap;
  };
}

function targetIdControl(initial) {
  return function control(_state, onChange) {
    const wrap = document.createElement('div');
    wrap.className = 'ops-filter-slot-inner';
    const input = document.createElement('input');
    input.type = 'search';
    input.id = 'audit-filter-target-id';
    input.className = 'ops-filter-search';
    input.placeholder = 'Needs a target type';
    if (initial) input.value = initial;
    let timer = null;
    input.addEventListener('input', function () {
      if (timer) clearTimeout(timer);
      timer = setTimeout(function () {
        onChange(input.value.trim());
      }, 250);
    });
    wrap.appendChild(labelled('Target ID', input, input.id));
    return wrap;
  };
}

// ─── Columns ─────────────────────────────────────────────────────────────────
//
// No column is `sortable`: the endpoint has no sort/order param and always
// returns newest-first (src/data/audit-repo.ts:152-156). The Time header says so
// rather than leaving the fixed order implicit.

function buildColumns(ctx) {
  const fmtDate = ctx.fmtDate;
  return [
    {
      key: 'at',
      label: 'Time (newest first)',
      render: (e) => escHtml(fmtDate(e.at)),
    },
    {
      key: 'action',
      label: 'Action',
      render: (e) => '<span class="audit-action">' + escHtml(e.action || '—') + '</span>',
    },
    {
      key: 'targetType',
      label: 'Target type',
      render: (e) => escHtml(e.targetType || '—'),
    },
    {
      key: 'targetId',
      label: 'Target ID',
      render: (e) => '<span class="cell-id">' + escHtml(e.targetId || '—') + '</span>',
    },
    {
      key: 'origin',
      label: 'Origin',
      render: (e) => {
        const origin = e.actor && e.actor.origin ? e.actor.origin : '';
        if (!AUDIT_ORIGINS.includes(origin)) return '—';
        return (
          '<span class="audit-origin audit-origin-' + escHtml(origin) + '">' +
          escHtml(origin) +
          '</span>'
        );
      },
    },
    {
      key: 'principalId',
      label: 'Actor',
      // Null for every entry until #525 lands principal identity
      // (src/data/audit-repo.ts:50-54). Rendered as an explicit dash, with the
      // reason stated once in the note above the filter bar.
      render: (e) => {
        const pid = e.actor && e.actor.principalId;
        return pid ? '<span class="cell-id">' + escHtml(pid) + '</span>' : '—';
      },
    },
    {
      key: 'detail',
      label: 'Detail',
      render: (e) => {
        const summary = summariseDetail(e.detail);
        return summary ? '<span class="audit-detail">' + escHtml(summary) + '</span>' : '—';
      },
    },
  ];
}

// ─── Public factory ──────────────────────────────────────────────────────────
//
// createAuditTable(deps) -> { el, reload, refresh, destroy, state }
//
// deps:
//   apiFetch(path) -> Promise   — the app's auth/stack-aware fetch (app.js:273).
//   fmtDate(val) -> string      — app.js date formatter.
//   win (optional)              — injectable window for URL sync (tests/SSR).
export function createAuditTable(deps) {
  const d = deps || {};
  const apiFetch = d.apiFetch;
  const fmtDate = typeof d.fmtDate === 'function' ? d.fmtDate : (v) => String(v ?? '');
  const win = 'win' in d ? d.win : typeof window !== 'undefined' ? window : undefined;

  if (typeof apiFetch !== 'function') {
    throw new Error('createAuditTable requires deps.apiFetch');
  }

  // 1) Reconstruct state from the URL. from/to/size come from the shared
  //    contract; the audit-specific keys are read from the same namespace.
  const search = win && win.location ? win.location.search : '';
  const urlState = decodeTableState(search, AUDIT_NS, URL_DEFAULTS);
  const rawParams = new URLSearchParams(search || '');
  const readExtra = (key) => {
    const v = rawParams.get(AUDIT_NS + '.' + key);
    return v == null ? '' : String(v).trim();
  };

  const initialFilters = {};
  if (urlState.from) initialFilters.from = urlState.from;
  if (urlState.to) initialFilters.to = urlState.to;
  const urlTargetType = readExtra('targetType');
  if (AUDIT_TARGET_TYPES.includes(urlTargetType)) initialFilters.targetType = urlTargetType;
  // A targetId without a targetType is dropped here as well as in the query
  // builder, so the control never shows a value the request cannot carry.
  const urlTargetId = readExtra('targetId');
  if (urlTargetId && initialFilters.targetType) initialFilters.targetId = urlTargetId;
  const urlOrigin = readExtra('origin');
  if (AUDIT_ORIGINS.includes(urlOrigin)) initialFilters.origin = urlOrigin;
  const urlAction = readExtra('action');
  if (urlAction) initialFilters.action = urlAction;

  const table = createOpsTable({
    caption: '',
    columns: buildColumns({ fmtDate }),
    filters: [
      {
        name: 'targetType',
        control: selectControl(
          'audit-filter-target-type',
          'Target type',
          'All target types',
          AUDIT_TARGET_TYPES,
          initialFilters.targetType
        ),
      },
      { name: 'targetId', control: targetIdControl(initialFilters.targetId) },
      { name: 'action', control: actionControl(initialFilters.action) },
      {
        name: 'origin',
        control: selectControl(
          'audit-filter-origin',
          'Origin',
          'All origins',
          AUDIT_ORIGINS,
          initialFilters.origin
        ),
      },
      { name: 'from', control: dateControl('audit-filter-from', 'From', initialFilters.from) },
      { name: 'to', control: dateControl('audit-filter-to', 'To', initialFilters.to) },
    ],
    pagingMode: PAGING_OFFSET,
    pageSize: urlState.size || AUDIT_PAGE_SIZE,
    initialFilters,
    rowKey: (e) => e && e.id,
    emptyText: 'No audit entries match the current filters.',
  });

  // ── Identity note ────────────────────────────────────────────────────────
  // Stated once, above the controls, so the Actor column's dashes are never
  // read as "an unknown person did this". role="note" keeps it out of the
  // live-region traffic while still being in the reading order for AT.
  const identityNote = document.createElement('p');
  identityNote.className = 'audit-note';
  identityNote.setAttribute('role', 'note');
  identityNote.textContent =
    'Entries record what changed and what caused it. Per-principal identity is not ' +
    'captured yet (read-auth is pending), so Actor is empty on every entry — filter ' +
    'by Origin to separate operator activity from system and AI activity.';
  const filterBarEl = table.el.querySelector('.ops-table-filters');
  if (filterBarEl && filterBarEl.parentNode) {
    filterBarEl.parentNode.insertBefore(identityNote, filterBarEl);
  } else {
    table.el.appendChild(identityNote);
  }

  // ── URL sync ─────────────────────────────────────────────────────────────
  // The shared encoder owns the fixed keys (and preserves every param outside
  // this namespace); the audit-specific keys are set/cleared alongside it. One
  // replaceState per load — derived changes must not spam history.
  function syncUrl(snap) {
    if (!win || !win.location || !win.history) return '';
    const loc = win.location;
    const params = encodeTableState(
      {
        sort: null,
        from: snap.filters.from || null,
        to: snap.filters.to || null,
        // 1-based page, from the offset page index. Written for shareability;
        // the primitive exposes no offset seeding, so a deep link restores the
        // filters and lands on page 1 — the same behaviour the jobs table has
        // (public/jobs-table.js:479-481).
        page: (snap.pageIndex || 0) + 1,
        size: snap.pageSize,
      },
      AUDIT_NS,
      URL_DEFAULTS,
      new URLSearchParams(loc.search || '')
    );
    EXTRA_URL_KEYS.forEach(function (key) {
      const name = AUDIT_NS + '.' + key;
      const value = trimmed(snap.filters[key]);
      if (value) params.set(name, value);
      else params.delete(name);
    });
    const qs = params.toString();
    const relative = (loc.pathname || '') + (qs ? '?' + qs : '') + (loc.hash || '');
    try {
      win.history.replaceState(win.history.state ?? null, '', relative);
    } catch {
      return '';
    }
    return relative;
  }

  // ── Load (the single network path) ───────────────────────────────────────
  let loading = false;
  // A filter change that lands while a request is in flight must not be lost:
  // it is remembered and replayed once the in-flight load settles, so the view
  // always ends up matching the controls the operator can see.
  let queued = false;
  // Recording the page facts the server just returned emits on the same store
  // we subscribe to. That emit is OUR OWN bookkeeping, not an operator action,
  // so it is suppressed — otherwise every successful load would queue another.
  let applyingPageInfo = false;

  async function reload() {
    if (loading) {
      queued = true;
      return;
    }
    loading = true;
    const snap = table.state.getState();
    syncUrl(snap);
    table.setStatus('loading');
    try {
      const qs = buildAuditQuery(snap).toString();
      const res = await apiFetch('/audit?' + qs);
      const items = res && Array.isArray(res.items) ? res.items : [];
      // `total` is the pre-paging match count (src/data/audit-repo.ts:157) —
      // exactly what the primitive's offset pager needs for prev/next + range.
      const total = res && typeof res.total === 'number' ? res.total : items.length;
      applyingPageInfo = true;
      try {
        table.state.setPageInfo({ total });
      } finally {
        applyingPageInfo = false;
      }
      table.setRows(items);
    } catch (err) {
      table.setStatus(
        'error',
        'Failed to load audit entries: ' + (err && err.message ? err.message : String(err))
      );
    } finally {
      loading = false;
      if (queued) {
        queued = false;
        // Replay the change that arrived mid-flight against the latest state.
        void reload();
      }
    }
  }

  // Any interaction (filter change / page nav) re-queries the server.
  table.state.subscribe(function () {
    if (applyingPageInfo) return;
    reload();
  });

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
