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
 *   Verified query params (openapi.json
 *   .paths["/api/v1/assets/"].get.parameters and `listQuerySchema`,
 *   src/routes/assets.ts:373):
 *     limit    integer 1..200
 *     offset   integer >=0
 *     status   enum ['uploading','processing','ready','failed','archived']
 *     parentId string
 *     from     string, created-at lower bound (inclusive)
 *     to       string, created-at upper bound (inclusive)
 *   Response envelope (listSchema, top-level props): { items, limit, offset, total }.
 *   Item fields used here (verified present in the list item schema): id, slug,
 *   name (canonical title), status, reviewState, renditions, tags, thumbnails,
 *   createdAt, technicalMetadataError, deleteLock.
 *   `reviewState` and `renditions` (issue #961) are
 *   openapi.json .paths["/api/v1/assets/"].get.responses["200"]
 *   .content["application/json"].schema.properties.items.items.properties
 *   .reviewState — a string enum ['draft','in-review','approved','rejected']
 *   (`reviewStateSchema.optional()`, src/routes/assets.ts:868; `reviewState?:
 *   AssetReviewState`, src/data/asset-repo.ts:488) — and ….renditions, an ARRAY
 *   of { id, label, width, height, objectKey, codec?, bitrateBps? } (`renditions?:
 *   Rendition[]`, src/data/asset-repo.ts:546). There is NO `renditionCount`
 *   scalar and no `review_state` snake_case spelling in the contract; the count
 *   is derived from the array's length client-side. Both are OPTIONAL (absent
 *   from the item schema's `required`: ['id','name','status','statusHistory',
 *   'createdAt','updatedAt']).
 *   `deleteLock` (issue #894) is
 *   openapi.json .paths["/api/v1/assets/"].get.responses["200"]
 *   .content["application/json"].schema.properties.items.items.properties
 *   .deleteLock — an object { locked, reason?, lockedAt, lockedBy? } with
 *   required ["locked","lockedAt"] and additionalProperties:false
 *   (`deleteLockSchema`, src/routes/assets.ts:528; `DeleteLock`,
 *   src/data/asset-repo.ts:441). Only `locked` is read here; the derivation
 *   lives in public/lock-state.js.
 *   Ordering: the server ALWAYS returns createdAt-ascending with a ULID `id`
 *   tie-break (src/data/asset-repo.ts:937 — `createdAt.localeCompare … || id…`),
 *   i.e. ULID `_id` creation order per ADR-005. There is NO server `sort` or `q`
 *   param on this endpoint (confirmed absent from the schema).
 *
 * Tier 2 — free-text FTS (a `q` term is present), per ADR-005:
 *   Endpoint: GET /api/v1/search/  (the CANONICAL free-text path already used by
 *   the Search tab in app.js — we reuse it rather than adding a second search
 *   path, per the issue's explicit constraint).
 *   Verified query params (openapi.json .paths["/api/v1/search/"].get.parameters
 *   and `searchQuerySchema`, src/routes/search.ts:146): q (string 1..512),
 *   status (the SAME status enum as tier 1), from, to, page (int >=1),
 *   pageSize (int 1..100), plus tags/mimeType/tams* (unused here).
 *   Response envelope (searchResultSchema, src/routes/search.ts:118-131):
 *     { assets, collections, total, collectionTotal, page }. `total` is the count
 *     of matching ASSETS; `collectionTotal` counts collection hits separately and
 *     this table (assets only) ignores it.
 *
 * TAG + METADATA FILTERS (issue #914). The filter bar also narrows by tag and by
 * free-form operator metadata. Both are filters ONLY `GET /api/v1/search/` has —
 * `GET /api/v1/assets/` declares neither (verified: openapi.json
 * .paths["/api/v1/assets/"].get.parameters is limit/offset/status/parentId/from/to
 * only, and `listQuerySchema`, src/routes/assets.ts:373) — so setting either one
 * routes the request to the tier-2 search endpoint even with NO free-text term.
 * That is sound, not a workaround: `q` is `.optional()` on `searchQuerySchema`
 * (src/routes/search.ts:155-166), so a tags-only or metadata-only search is a
 * first-class query, and every filter is applied to the whole matched set before
 * the page slice, so the reported `total` stays exact (#834) on this tier too.
 *   tags      — `?tags=` accepts a repeated param OR one comma-separated list and
 *               normalises to a trimmed, non-empty array (`tagsSchema`,
 *               src/routes/search.ts:139-150). The control therefore sends the
 *               operator's comma-separated text as a single `tags` param, which is
 *               the SAME shape the Search tab sends (app.js renderSearchTab:
 *               `params.set('tags', tags)`).
 *   metadata  — one `metadata.<key>=<value>` param per pair (issue #12;
 *               `extractMetadataFilter`, src/routes/search.ts:221-240, which pulls
 *               the dynamic keys out of the `.passthrough()` querystring at
 *               src/routes/search.ts:218). Because the key names are dynamic they
 *               appear in no OpenAPI `parameters` list — the route source IS the
 *               contract for them.
 * Container/MIME (`mimeType`) is deliberately NOT offered here (issue #822 owns
 * that vocabulary; explicitly out of scope for #914), even though the param exists.
 *
 * `status` / `from` / `to` ARE SERVER-SIDE ON BOTH TIERS (issue #833, merged).
 * Both endpoints share ONE definition of the created-at range grammar and match
 * semantics — `CreatedFromSchema`/`CreatedToSchema`/`resolveCreatedRange` in
 * src/data/created-range.ts — so the two surfaces cannot drift. Each bound
 * accepts either `YYYY-MM-DD` (what the `<input type="date">` controls below
 * emit) or a full ISO instant, and BOTH bounds are inclusive: a bare `to` date
 * is expanded server-side to that UTC day's last instant, so the client must NOT
 * do its own end-of-day arithmetic. Every filter is applied to the WHOLE matched
 * set before the page slice, so the reported `total` already counts exactly the
 * filtered rows (src/data/asset-repo.ts:1502-1508 for the list tier,
 * src/data/search-repo.ts:49-54 for the FTS tier). We therefore pass the filters
 * through and report the backend's `total` verbatim — no client-side narrowing
 * (issue #834). An inverted range (`from` > `to`) is a 400
 * `invalid_created_range` from both routes, surfaced as a normal table error.
 *
 * TIER-2 PROJECTION GAP (delete-lock, issue #894). The search projection
 * (`assetSchema`, src/routes/search.ts:78 — Fastify serializes against it) has NO
 * `deleteLock` property, so a locked asset carries no lock field while a
 * free-text `q` is active. That is lock state UNKNOWN, not unlocked, and the
 * difference matters: rendering "unlocked" there would be a promise the payload
 * does not support. The table therefore shows no lock flag on tier-2 rows and
 * makes no counter-claim either (there is no "Unlocked" badge to contradict),
 * and the Archive control is left alone so the 409 `delete_protected` path stays
 * the authority. Tracked as gap H1 in docs/ux/asset-lock-state-spec.md §9; the
 * fix is a server-side one — add `deleteLock` to the search projection.
 *
 * KNOWN CONTRACT GAP — one left, and it is an ORDERING gap only. (The previous
 * revision of this header pointed at a friction log in the separate
 * eng-open-videocore-agents repo; no such file exists in either repo, so the gap
 * is documented here instead of behind a dangling pointer.)
 *   1. Neither endpoint accepts a server-side `sort` param; the list endpoint is
 *      fixed to createdAt-ascending. So created-date DESC and the status/title
 *      sorts are applied to the CURRENT PAGE client-side. Created-date ASC is the
 *      native server order (true ULID creation-order paging, no client sort).
 *      This is a page-scoped ORDERING refinement only — it never drops a row, so
 *      it does not affect `total` or which rows paging reaches.
 *
 * FILTER-BOX INTERACTION (issue #946). The free-text box is a FILTER, not a
 * query form: it narrows the list as you type. It fires on a ~300ms trailing
 * debounce, so one search term costs one request rather than one per keystroke,
 * and it carries its own clear control plus a magnifier affordance so the box
 * looks like the thing it is. Emptying it — by deleting the text or by pressing
 * the clear control — dispatches immediately and unconditionally: "show me
 * everything" is the cheap tier-1 list call and should never wait on a timer or
 * on a minimum term length. Enter is a shortcut that flushes a debounce still in
 * flight, never a requirement. See searchFilterControl() below.
 *
 * TIER-2 PROJECTION GAP (review state, issue #961). Same shape as the lock gap
 * above and verified the same way: `assetSchema` (src/routes/search.ts) has no
 * `reviewState` and no `slug`, so while a free-text `q` is active those two cells
 * render an em-dash. For review state that is deliberately NOT the API's `draft`
 * default — tier 1 can say "absent means draft" because it projects the field and
 * the route resolves it that way (src/routes/assets.ts:5938); tier 2 cannot say
 * anything at all. `renditions` IS in the search projection, so the rendition
 * count is exact on both tiers.
 *
 * COLUMN VISIBILITY (issue #959, extended by #961). The operator chooses which of
 * the ten declared columns are rendered; two of them — Review state and Rendition
 * count — are declared but OFF until chosen, so a first visit to a bare URL paints
 * the same eight columns it always did (ASSETS_DEFAULT_COLUMN_KEYS below).
 * This is VIEW state and touches NO part of the request: the
 * two tiers above, their params, the client sort and the paging window are all
 * computed from `snap.sort` / `snap.filters` / `snap.offset`, none of which the
 * chooser writes. Hiding the Created column does not stop the table sorting by
 * createdAt, and hiding Status does not drop the `status` param — so `total` and
 * which rows a page reaches are unchanged by definition, not by convention. The
 * two optional columns add no param and no sort axis either: both render from
 * fields the page already fetched.
 * Resolution order on load is URL -> stored per-operator default -> the default
 * column set; see resolveInitialColumns() below. The chooser's "Reset to
 * defaults" (issue #962) unwinds that same ladder from the top: it clears the
 * `assets.cols` param AND this browser's stored default, so the table falls back
 * to the declared default set — the eight painted-by-default columns, not the ten
 * declared ones — and stays there on refresh and on the next visit alike.
 *
 * ROW RENAME (issue #927). The Actions column carries a Rename control, so an
 * operator renames an asset from the list without opening the detail pane. The
 * only write it can make is the one the detail view already made:
 *   PATCH /api/v1/assets/{id} — path param `id` only; request body properties
 *   `name` (string, minLength 1, maxLength 256), `description`, `objectKey`,
 *   `status`, `metadata`, `tags`, all optional, `additionalProperties: false`;
 *   responses 200 (the full asset) / 404 / 422. Verified in openapi.json
 *   .paths["/api/v1/assets/{id}"].patch and in `updateSchema`
 *   (src/routes/assets.ts:418, `name` at :420) wired at `app.patch('/:id', …)`
 *   (src/routes/assets.ts:5682). NO schema change was needed for this control.
 * The dialog, the validation and the body construction are NOT reimplemented
 * here: the row hands off to openRenameDialog (public/asset-rename.js), the same
 * entry point the detail view uses, which sends exactly `{ name }`. This module
 * contributes the button and the reload; see the Actions column renderer.
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
// Column visibility (issue #959). Model + per-operator persistence + the chooser
// control all live in one module so any ops table can adopt the same pattern; see
// the COLUMN VISIBILITY block below for how this table resolves its set.
import {
  normalizeVisibleColumns,
  readStoredColumns,
  writeStoredColumns,
  clearStoredColumns,
} from './table-columns.js';
// Presigned thumbnail loading (issue #801). The thumbnail cell is rendered
// src-less and filled in after each render — see hydrateThumbnails() below and
// the contract grounding in public/thumbnail-url.js.
import { applyThumbnail } from './thumbnail-url.js';
import { copyableIdCellHtml, slugCellHtml, wireCopyIdButtons } from './copy-id.js';
// Editorial review state (issue #961). The vocabulary and the display labels are
// imported rather than restated so the optional "Review state" column, the detail
// panel's review block and the badge palette cannot drift onto three different
// spellings of the same four states — see public/review-state.js.
import { REVIEW_STATES, reviewStateLabel } from './review-state.js';
// Explicit delete-lock indicator (issue #894). Derivation, copy and markup all
// live in one module so the list, the detail panel (#895) and the protected-
// delete flow (#896) ship one pattern — see docs/ux/asset-lock-state-spec.md §2.
import { isAssetLocked, lockBadgeHtml, ROW_LOCKED_CLASS } from './lock-state.js';
// Muted empty state for placeholder-less filter controls (issues #984, #983 AC2).
// The class name is a CSS contract, so it is imported rather than restated — see
// public/filter-unset.js.
import { wireUnset } from './filter-unset.js';

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

// Trailing debounce for the free-text filter box (issue #946). Long enough that
// a typed word coalesces into one request, short enough that the list still feels
// like it is narrowing under the cursor. Sits between the sibling tables' lighter
// 200ms/250ms text debounces (public/jobs-table.js, public/logs-table.js) because
// this box can fan out to the heavier full-text tier.
export const SEARCH_DEBOUNCE_MS = 300;

// Sortable column keys. `created` maps to the ULID creation-order axis; `status`
// and `title` are the additional axes the acceptance criteria require.
const SORT_KEY_CREATED = 'created';
const SORT_KEY_STATUS = 'status';
const SORT_KEY_TITLE = 'title';

// Per-table URL-state defaults. Natural order is created DESC (newest first) —
// the most useful default for operators — expressed against the shared contract.
//
// `cols` is deliberately left at the shared default of null ("unspecified"), NOT
// at the full column list: that is what lets the encoder tell "this operator chose
// to show everything" from "this operator has not chosen", and only the former
// belongs in a shared link (see the `cols` note in encodeTableState).
const URL_DEFAULTS = Object.freeze({
  sort: { field: SORT_KEY_CREATED, dir: SORT_DIR.desc },
  size: ASSETS_PAGE_SIZE,
});

// ─── Bulk selection (issue #916) ─────────────────────────────────────────────
//
// The leading tick-box column that turns the Assets tab from a read-only list
// into a place bulk actions can start from. It is opt-in (`selectable: true`)
// so every other consumer of this module is unchanged, and it is declared
// `hideable: false` so the column chooser cannot hide the control an active
// selection depends on (normalizeVisibleColumns keeps a non-hideable column
// visible whatever the URL/stored set asks for — public/table-columns.js:205-207).
export const ASSETS_SELECT_COLUMN_KEY = 'select';

// ─── Column visibility contract (issue #959) ─────────────────────────────────

// The declared column keys, in render order. Exported so consumers and tests name
// the same vocabulary the `assets.cols` URL param and the stored preference use.
//
// DECLARED is not the same as PAINTED (issue #961): `reviewState` and `renditions`
// are declared, offered by the chooser and addressable by `assets.cols`, but off
// until an operator asks for them — see ASSETS_OPTIONAL_COLUMN_KEYS below.
export const ASSETS_COLUMN_KEYS = Object.freeze([
  'thumb',
  'id',
  'slug',
  'title',
  'status',
  'reviewState',
  'renditions',
  'tags',
  'created',
  'actions',
]);

// Columns that are available but OFF until chosen (issue #961).
//
// This is the SINGLE source of truth for the flag: buildColumns() stamps
// `defaultVisible: false` onto exactly these keys, and ASSETS_DEFAULT_COLUMN_KEYS
// below is derived from it, so the declared set, the painted-by-default set and
// the column objects cannot disagree.
//
// Why these two and not the rest. The issue asks for slug, id, rendition count,
// review state and tags as selectable columns; slug, id and tags were ALREADY
// declared and already toggleable through the chooser (#959), and they are
// already part of the default view. Turning them off would change the default
// view, which the issue explicitly forbids. So only the genuinely new pair —
// rendition count and review state — is added here, and it is added OFF, leaving
// a first visit to a bare URL pixel-identical to before.
//
// Both are secondary, high-cardinality-of-interest-per-operator detail: a
// transcoding operator wants the rendition count on screen all day, an editor
// wants the review state, and neither wants the other's column. That is the
// definition of a chooser column rather than a default one.
export const ASSETS_OPTIONAL_COLUMN_KEYS = Object.freeze(['reviewState', 'renditions']);

// What the table paints when nobody has chosen: every declared column except the
// optional ones. This is the pre-#961 set, unchanged, and it is what a bare URL
// with no stored preference resolves to.
export const ASSETS_DEFAULT_COLUMN_KEYS = Object.freeze(
  ASSETS_COLUMN_KEYS.filter((k) => ASSETS_OPTIONAL_COLUMN_KEYS.indexOf(k) === -1)
);

// The legality rule from the issue: the Actions column and the identifying
// columns must never ALL be hidden at once, or the table becomes a grid of
// unnamed rows you cannot act on — a view with no way back out of itself.
// Expressed as one `requireAtLeastOne` group, so the chooser disables the last
// survivor instead of letting the operator reach that state and then explaining
// the mistake. "Identifying" is all three of ID, Slug and Name / Title: any one
// of them lets an operator say WHICH asset a row is.
export const ASSETS_REQUIRED_COLUMN_GROUPS = Object.freeze([
  Object.freeze(['id', 'slug', 'title', 'actions']),
]);

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

// ─── Client-side page refinement (the one remaining contract gap: ordering) ───
//
// Status and created-date-range filtering are BOTH server-side now (issue #833),
// so this module no longer narrows a fetched page. The only refinement left is
// ordering, for the axes the endpoints do not sort by — and re-ordering a page
// never drops a row, so the backend's `total` stays exact.

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

// ─── Structured filter parsing (issue #914) ───────────────────────────────────
//
// Both controls below hold their value as the raw text the operator typed, so the
// box always shows exactly what they wrote. These two functions are the single
// place that text becomes request shape — used by the fetch layer AND by the URL
// sync, so a shared link and the request it reproduces can never disagree.

// Comma-separated tag text -> trimmed, non-empty, de-duped tag list. Mirrors the
// server's own normalisation (`tagsSchema`, src/routes/search.ts:139-150) so the
// client never sends a blank tag the server would only drop.
function parseTagsFilter(raw) {
  if (typeof raw !== 'string') return [];
  const out = [];
  const seen = new Set();
  raw.split(',').forEach(function (part) {
    const t = part.trim();
    if (!t || seen.has(t)) return;
    seen.add(t);
    out.push(t);
  });
  return out;
}

// Comma-separated `key=value` text -> [{ key, value }]. Only the first `=` splits
// a pair, so a value may contain `=`. A token with no `=` or a blank key is NOT a
// filter the `metadata.<key>=<value>` grammar can carry, so it is dropped rather
// than sent as something the server would ignore — the operator sees the full set
// of rows their partially-typed filter still matches, and the control's hint says
// what the shape is. A blank VALUE is kept: `metadata.genre=` is a real filter.
// One pair per key, because the server keeps only the first value for a repeated
// key (`extractMetadataFilter`, src/routes/search.ts:221-240).
function parseMetadataFilter(raw) {
  if (typeof raw !== 'string') return [];
  const out = [];
  const seen = new Set();
  raw.split(',').forEach(function (part) {
    const eq = part.indexOf('=');
    if (eq < 0) return;
    const key = part.slice(0, eq).trim();
    if (!key || seen.has(key)) return;
    seen.add(key);
    out.push({ key, value: part.slice(eq + 1).trim() });
  });
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
  // Structured filters only the search tier can express (issue #914).
  const tags = parseTagsFilter(filters.tags);
  const metadata = parseMetadataFilter(filters.meta);
  const limit = snap.pageSize;
  const offset = snap.offset;

  if (q || tags.length || metadata.length) {
    // ── Tier 2: free-text FTS via the canonical GET /api/v1/search/ path. ──
    // Paged by page/pageSize (page is 1-based). Envelope:
    // { assets, collections, total, collectionTotal, page }.
    const page = Math.floor(offset / limit) + 1;
    const params = new URLSearchParams();
    // `q` is optional on this endpoint, so a tags-only / metadata-only filter
    // reaches the search tier WITHOUT an empty `q` (which would be a 400: the
    // schema is `.min(1)`).
    if (q) params.set('q', q);
    params.set('page', String(page));
    params.set('pageSize', String(limit));
    // One comma-separated `tags` param — the shape `tagsSchema` normalises and
    // the shape the Search tab already sends.
    if (tags.length) params.set('tags', tags.join(','));
    // One `metadata.<key>=<value>` param per pair (issue #12 query grammar).
    metadata.forEach(function (pair) {
      params.set('metadata.' + pair.key, pair.value);
    });
    // status/from/to are real server params here (issue #833) — send them so the
    // filter narrows the whole matched set, not the page in hand.
    if (status) params.set('status', status);
    if (from) params.set('from', from);
    if (to) params.set('to', to);
    const res = await apiFetch('/search?' + params.toString());
    const assets = (res && (res.assets || res.items)) || [];
    // `total` is the backend's count of matching assets AFTER every filter, so
    // it is reported verbatim (issue #834).
    const total = res && typeof res.total === 'number' ? res.total : assets.length;
    const rows = applyClientSort(assets, snap.sort);
    // This projection has NO `deleteLock` property (verified: openapi.json
    // .paths["/api/v1/search/"].get...assets.items.properties, and `assetSchema`
    // in src/routes/search.ts which Fastify serializes against). Every row here
    // is therefore lock-state UNKNOWN, not unlocked — see the lock note in the
    // header block and docs/ux/asset-lock-state-spec.md §2 (L0) and gap H1.
    // Nor does it carry `reviewState` or `slug` (same verification — neither
    // appears in `assetSchema`'s properties), so the optional Review state
    // column renders UNKNOWN on these rows rather than the API's `draft`
    // default (issue #961). `renditions` IS in this projection, so the rendition
    // count is exact on both tiers.
    return { rows, total, projectionCarriesLock: false, projectionCarriesReviewState: false };
  }

  // ── Tier 1: exact/range list via GET /api/v1/assets/ (Mango-style). ──
  // Paged by limit/offset. Envelope: { items, limit, offset, total }.
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  params.set('offset', String(offset));
  if (status) params.set('status', status); // server-side exact status filter
  // Inclusive created-at bounds, normalised and applied server-side before the
  // page slice (issue #833). Passed through as the control emits them — the
  // server expands a bare `YYYY-MM-DD` `to` to that UTC day's last instant.
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const res = await apiFetch('/assets?' + params.toString());
  const items = (res && (res.items || res.assets)) || (Array.isArray(res) ? res : []);
  // Backend `total` already counts only the filtered set (issue #834).
  const total =
    res && typeof res.total === 'number' ? res.total : items.length;
  const rows = applyClientSort(items, snap.sort);
  // This projection DOES carry `deleteLock` (verified: openapi.json
  // .paths["/api/v1/assets/"].get...items.items.properties.deleteLock), so an
  // absent field on a row genuinely means "not locked". It likewise carries
  // `reviewState` (…items.items.properties.reviewState), so an absent value
  // there is the pre-field default `draft` rather than an unknown (issue #961).
  return { rows, total, projectionCarriesLock: true, projectionCarriesReviewState: true };
}

// Everything about the interaction state that decides WHICH request to make:
// sort, filters, and the page window. Used to tell a genuine user change from
// reload()'s own setPageInfo() bookkeeping (see the reload guard below). Filter
// keys are sorted so that reaching the same filter set by a different route does
// not read as a different state.
function stateSignature(snap) {
  const filters = (snap && snap.filters) || {};
  const sort = (snap && snap.sort) || {};
  return JSON.stringify([
    sort.columnKey || null,
    sort.direction || null,
    Object.keys(filters)
      .sort()
      .map((k) => [k, filters[k]]),
    snap ? snap.offset : null,
    snap ? snap.pageSize : null,
  ]);
}

// ─── Filter controls (slot-based) ─────────────────────────────────────────────
//
// Each control is a factory the primitive mounts once into the filter bar; it
// wires its native events to the supplied `onChange(value)` (the primitive maps
// that to state.setFilter(name, value), which resets paging). Initial values come
// from the decoded URL state so a shared link reconstructs the controls.
//
// Every control captions itself with a `<span class="ops-filter-caption">` as the
// first child of its `<label>`. The class is the hook the bar's caption typography
// is keyed off (`.ops-table-filters .ops-filter-caption` in public/style.css,
// issue #983); it replaced a structural `.ops-filter-slot > label > span`
// selector that also matched the hint spans below, which rendered the tag and
// metadata help sentences in uppercase. A caption span added here without the
// class gets the plain label treatment, not the bar's; the DOM seam is asserted in
// test/assets-tag-metadata-filters.test.ts.

function statusFilterControl(initial) {
  return function () {
    const wrap = document.createElement('label');
    wrap.className = 'ops-filter-status';
    const span = document.createElement('span');
    span.className = 'ops-filter-caption';
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
    // "All statuses" is a real <option>, not a placeholder, so an unfiltered
    // select would paint at full var(--text) while the Jobs equivalent is muted —
    // the one remaining visible difference between the bars after #983's repaint.
    // wireUnset() adds its own change/input listeners rather than relying on the
    // descriptor below, whose `event` wiring belongs to the primitive (asSlot()).
    wireUnset(sel);
    wrap.appendChild(span);
    wrap.appendChild(sel);
    return { el: wrap, input: sel, event: 'change', read: () => sel.value };
  };
}

// The free-text filter box (issue #946). Unlike the status/date controls this one
// owns its own event wiring — see the `wire` descriptor below and asSlot() — so it
// can debounce, flush, and clear on the three different rhythms the interaction
// needs.
//
// Layout is icon + input + clear, all inside one positioned wrapper so the two
// affordances sit INSIDE the input's box rather than beside it (padding on the
// input reserves the room; see `.ops-search-*` in public/style.css). The magnifier
// is drawn in CSS from a bordered circle and a rotated handle: `public/` has no
// icon set, no icon font and no inline SVG (see the note in public/lock-state.js),
// and a filter affordance is not the right place to introduce one. The copy-id
// control's glyph (issue #990) is drawn the same way, for the same reason. It is purely
// decorative — `aria-hidden`, not focusable — because the input already carries
// its own accessible name.
function searchFilterControl(initial) {
  return function () {
    const wrap = document.createElement('label');
    wrap.className = 'ops-filter-q';
    const span = document.createElement('span');
    span.className = 'ops-filter-caption';
    span.textContent = 'Search';

    const field = document.createElement('div');
    field.className = 'ops-search-field';

    const icon = document.createElement('span');
    icon.className = 'ops-search-icon';
    icon.setAttribute('aria-hidden', 'true');

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'ops-search-input';
    input.placeholder = 'Full-text search…';
    input.setAttribute('aria-label', 'Search');
    // Browser history/autofill on a live filter box just gets in the way of the
    // list updating underneath it.
    input.setAttribute('autocomplete', 'off');
    if (initial) input.value = initial;

    // Our own clear control rather than the `type="search"` native one: that is
    // absent in some engines, unstyleable in others, and invisible to the
    // keyboard. This one is a real focusable button with a real accessible name.
    // The stylesheet hides the native affordance so there is never a second x.
    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'ops-search-clear';
    clear.setAttribute('aria-label', 'Clear search');
    clear.title = 'Clear search';
    clear.textContent = '×'; // MULTIPLICATION SIGN — a glyph, not an icon font
    // Hidden while the box is empty: there is nothing to clear, and an always-on
    // x reads as a control that does nothing.
    clear.hidden = !(initial && initial.length);

    field.appendChild(icon);
    field.appendChild(input);
    field.appendChild(clear);
    wrap.appendChild(span);
    wrap.appendChild(field);

    return { el: wrap, input, clear, wire: debouncedTextWiring(input, clear, initial) };
  };
}

// The three typing rhythms a live text filter needs — debounce, flush, clear —
// factored out of searchFilterControl so the tag and metadata boxes (issue #914)
// behave identically to the free-text box instead of re-deriving the behaviour.
// Returns the `wire(onChange)` function asSlot() expects.
function debouncedTextWiring(input, clear, initial) {
  return function wire(onChange) {
      let timer = null;
      // The value most recently handed to the table. Lets the flush paths (Enter,
      // blur) skip a second, identical request when the debounce already landed.
      let dispatched = (initial || '').trim();

      function cancel() {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      }

      // Hand the box's current value to the table now, trimmed: a whitespace-only
      // value is not a filter. For the free-text box that matters because the
      // verified `q` param is a 1..512 string (openapi.json
      // .paths["/api/v1/search/"].get.parameters), and trimming it to '' is
      // exactly what drops back to the tier-1 list call.
      function dispatch() {
        cancel();
        dispatched = input.value.trim();
        onChange(dispatched);
      }

      function syncClear() {
        clear.hidden = input.value === '';
      }

      input.addEventListener('input', function () {
        syncClear();
        // An emptied box restores the full list straight away: no debounce, no
        // minimum-length gate, no dedupe.
        if (input.value.trim() === '') {
          dispatch();
          return;
        }
        cancel();
        timer = setTimeout(dispatch, SEARCH_DEBOUNCE_MS);
      });

      // Enter and blur both mean "I am done typing", so they flush a debounce
      // that is still waiting instead of being the thing that starts the query.
      // With nothing pending the term is already applied and they do nothing —
      // holding Enter must not replay the same request.
      function flush() {
        if (input.value.trim() === dispatched) {
          cancel();
          return;
        }
        dispatch();
      }

      input.addEventListener('keydown', function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        flush();
      });
      input.addEventListener('change', flush);

      clear.addEventListener('click', function () {
        input.value = '';
        syncClear();
        dispatch(); // immediate and unconditional — back to the full list
        // Keep the caret where the user was working; clearing is a refinement of
        // the search, not an exit from it.
        input.focus();
      });
  };
}

// The tag and metadata filter boxes (issue #914). Both are plain text boxes with
// the same debounce/flush/clear rhythms as the free-text box, because they are
// the same KIND of control — a filter you narrow by typing — and the operator
// should not have to learn two interaction models in one bar.
//
// Accessibility: each box carries a visible <label> (the wrapper IS a <label>, as
// with the sibling controls) plus an `aria-describedby` hint naming the accepted
// shape, so the grammar is announced rather than discovered by trial and error.
// The clear button is a real focusable button with its own accessible name.
function structuredTextFilterControl(opts) {
  return function () {
    const initial = opts.initial;
    const wrap = document.createElement('label');
    wrap.className = 'ops-filter-' + opts.name;
    const span = document.createElement('span');
    span.className = 'ops-filter-caption';
    span.textContent = opts.label;

    const field = document.createElement('div');
    field.className = 'ops-search-field';

    const input = document.createElement('input');
    input.type = 'search';
    input.className = 'ops-search-input ops-search-input-plain';
    input.placeholder = opts.placeholder;
    input.setAttribute('aria-label', opts.label);
    input.setAttribute('autocomplete', 'off');
    const hintId = 'assets-filter-' + opts.name + '-hint';
    input.setAttribute('aria-describedby', hintId);
    if (initial) input.value = initial;

    const clear = document.createElement('button');
    clear.type = 'button';
    clear.className = 'ops-search-clear';
    clear.setAttribute('aria-label', opts.clearLabel);
    clear.title = opts.clearLabel;
    clear.textContent = '×'; // MULTIPLICATION SIGN — a glyph, not an icon font
    clear.hidden = !(initial && initial.length);

    field.appendChild(input);
    field.appendChild(clear);

    const hint = document.createElement('span');
    hint.className = 'form-hint ops-filter-hint';
    hint.id = hintId;
    hint.textContent = opts.hint;

    wrap.appendChild(span);
    wrap.appendChild(field);
    wrap.appendChild(hint);

    return { el: wrap, input, clear, wire: debouncedTextWiring(input, clear, initial) };
  };
}

function tagsFilterControl(initial) {
  return structuredTextFilterControl({
    name: 'tags',
    label: 'Tags',
    placeholder: 'news,sports',
    // Says what the server actually does: `tags` is an AND across the listed
    // tags in the repo matcher, and the comma is the separator the route's
    // `tagsSchema` splits on.
    hint: 'Comma-separated. An asset must carry every tag listed.',
    clearLabel: 'Clear tag filter',
    initial,
  });
}

function metadataFilterControl(initial) {
  return structuredTextFilterControl({
    name: 'meta',
    label: 'Metadata',
    placeholder: 'genre=documentary',
    // Exact-value match on the asset's free-form metadata bag, every listed pair
    // required (src/data/search-repo.ts:392-400).
    hint: 'key=value pairs, comma-separated. Exact match on every pair given.',
    clearLabel: 'Clear metadata filter',
    initial,
  });
}

function dateFilterControl(name, labelText, initial) {
  return function () {
    const wrap = document.createElement('label');
    wrap.className = 'ops-filter-' + name;
    const span = document.createElement('span');
    span.className = 'ops-filter-caption';
    span.textContent = labelText;
    const input = document.createElement('input');
    input.type = 'date';
    input.setAttribute('aria-label', labelText);
    if (initial) input.value = initial.length >= 10 ? initial.slice(0, 10) : initial;
    // Same muted empty state as the Jobs date boxes (issue #983 AC2): the UA's
    // yyyy-mm-dd hint is not a placeholder, so `.is-unset` is what mutes it.
    wireUnset(input);
    wrap.appendChild(span);
    wrap.appendChild(input);
    return { el: wrap, input, event: 'change', read: () => input.value };
  };
}

// Adapt one of the descriptors above into the primitive's slot contract:
// `control(state, onChange) -> HTMLElement`. The primitive calls onChange(value).
//
// Two descriptor shapes are accepted. `{ input, event, read }` is the simple case
// — forward read() on one native event — and covers the status/date controls.
// `{ wire }` hands the control full responsibility for when it calls onChange,
// which is what the debounced free-text box needs (issue #946).
function asSlot(factory) {
  return function (_state, onChange) {
    const desc = factory();
    if (typeof desc.wire === 'function') {
      desc.wire(onChange);
      return desc.el;
    }
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

// ─── Optional-column cell renderers (issue #961) ──────────────────────────────

// Em-dash for "this projection cannot tell you". Matches the glyph copy-id.js
// and the Name / Title column already use for an absent value, so one missing
// cell does not look different from another.
const EMPTY_CELL = '—';

// The same em-dash, with a name a screen reader can read out (WCAG 2.1 AA,
// 1.1.1 / 1.3.1). A bare "—" is announced as "dash" or skipped entirely, which
// makes an UNKNOWN cell indistinguishable from an empty one — exactly the
// distinction this column exists to draw.
//
// `role="img"` rather than a `.visually-hidden` span, which is the pattern used
// elsewhere (lock-state.js:148): a naked <span> is a `generic` element, and
// aria-label on it is ignored by design, while role="img" makes the glyph a
// single named graphic and REPLACES the dash in the accessible name instead of
// appending to it. The visible text stays exactly one em-dash either way.
function unknownCellHtml(label) {
  return '<span role="img" aria-label="' + escHtml(label) + '">' + EMPTY_CELL + '</span>';
}

/**
 * Rendition count. VERIFIED FIELD: `renditions`, an ARRAY (not a count) on BOTH
 * projections — openapi.json
 * .paths["/api/v1/assets/"].get.responses["200"]...items.items.properties
 * .renditions (array of { id, label, width, height, objectKey, codec?,
 * bitrateBps? }) and .paths["/api/v1/search/"].get...assets.items.properties
 * .renditions. The field is OPTIONAL on both (absent from each schema's
 * `required`) and `Rendition[] | undefined` on the model (`renditions?:
 * Rendition[]`, src/data/asset-repo.ts:546). There is NO `renditionCount`
 * scalar anywhere in the contract — the count is derived here.
 *
 * Because the PROPERTY is part of both projections, an absent value is a real
 * answer and not a projection gap: the asset document carries no renditions, so
 * the honest rendering is 0, not an em-dash. A non-array value (which the schema
 * forbids but a hand-rolled fixture can still produce) is treated the same way.
 */
function renditionCountCellHtml(asset) {
  const n = asset && Array.isArray(asset.renditions) ? asset.renditions.length : 0;
  return escHtml(String(n));
}

/**
 * Editorial review state. VERIFIED FIELD: `reviewState`, a STRING enum
 * ['draft','in-review','approved','rejected'] — openapi.json
 * .paths["/api/v1/assets/"].get.responses["200"]...items.items.properties
 * .reviewState, from `reviewStateSchema.optional()` (src/routes/assets.ts:868,
 * optional so "pre-existing assets serialized before reviewState existed still
 * validate") over `reviewState?: AssetReviewState` (src/data/asset-repo.ts:488).
 * It is camelCase on the wire, NOT `review_state`.
 *
 * Two different absences, told apart rather than conflated:
 *   - TIER 1 (GET /api/v1/assets/) carries the property, so an absent value is a
 *     document written before the field existed. The API itself resolves that to
 *     `draft` — `const current = asset.reviewState ?? 'draft'` at
 *     src/routes/assets.ts:5938, commented "Absent reviewState reads as `draft`"
 *     — so the column shows Draft and agrees with the detail panel.
 *   - TIER 2 (GET /api/v1/search/) has NO `reviewState` in its projection
 *     (verified: openapi.json .paths["/api/v1/search/"].get...assets.items
 *     .properties lists id, name, description, status, parentId, objectKey,
 *     statusHistory, technicalMetadata*, manifestUrls, packagingError,
 *     renditions, metadata, createdAt, updatedAt, type — and `assetSchema`,
 *     src/routes/search.ts, which Fastify serializes against). That is UNKNOWN,
 *     not draft, so the cell renders an em-dash. Inventing "Draft" there would
 *     be a claim about editorial approval the payload does not support — the
 *     same rule the delete-lock badge already follows (gap H1).
 *
 * Markup mirrors renderReviewBadge() in public/review-state.js (same classes,
 * same `data-review-state`) so the two axes stay visually distinct from the
 * lifecycle `.badge` family and the existing palette applies unchanged. It is
 * rebuilt as a string rather than reused as a DOM node because this primitive's
 * cell renderers return escaped HTML; the vocabulary and labels are imported, so
 * only the markup is duplicated, never the state list.
 */
function reviewStateCellHtml(asset, carriesReviewState) {
  // Named, not bare: "unknown on this tier" is a different statement from "no
  // review state", and a sighted operator gets that from the header plus the
  // tier they are in. See unknownCellHtml() for why role="img".
  if (!carriesReviewState) return unknownCellHtml('Review state unknown for this search result');
  const raw = asset && typeof asset.reviewState === 'string' && asset.reviewState
    ? asset.reviewState
    : 'draft';
  // An unrecognised fifth state still renders, as its raw wire value: the API is
  // the authority on the vocabulary (see reviewStateLabel's contract).
  const known = REVIEW_STATES.indexOf(raw) !== -1;
  return (
    '<span class="review-badge review-badge--' +
    (known ? escHtml(raw) : 'unknown') +
    '" data-review-state="' +
    escHtml(raw) +
    '">' +
    escHtml(reviewStateLabel(raw)) +
    '</span>'
  );
}

function buildColumns(renderCtx) {
  const renderBadge = renderCtx.renderBadge;
  const renderTags = renderCtx.renderTags;
  const fmtDate = renderCtx.fmtDate;
  const isAssetWedged = renderCtx.isAssetWedged;
  // Mutable holder, written by the fetch layer before each setRows() and read by
  // the Status and Review state renderers below. It cannot go stale: the only
  // writer is the fetch that produced the very rows being rendered.
  const projection = renderCtx.projection;
  // Bulk selection (issue #916). `selection` is the live Map the factory owns
  // (id -> label); read at render time so a row that is already selected comes
  // back ticked after a sort/page/filter repaint.
  const selection = renderCtx.selection;
  // Client-side mirror of the ADR-018 write gate for PATCH /api/v1/assets/{id}
  // (issue #927). Read as a FUNCTION at render time, not captured as a boolean at
  // construction time, so a role changed in the UI after the table was built is
  // honoured by the next repaint instead of showing a control that is certain to
  // earn a 403.
  const canRename = typeof renderCtx.canRename === 'function' ? renderCtx.canRename : null;

  const selectColumn = {
    key: ASSETS_SELECT_COLUMN_KEY,
    label: '',
    // Named for the chooser list even though it never appears there, so a future
    // change that makes it hideable does not ship an unlabelled entry.
    chooserLabel: 'Select',
    width: '32px',
    hideable: false,
    render: (a) => {
      const label = a.name || a.slug || a.id;
      return (
        '<input type="checkbox" class="asset-select-box" value="' +
        escHtml(a.id) +
        '"' +
        (selection && selection.has(a.id) ? ' checked' : '') +
        ' data-asset-label="' +
        escHtml(label) +
        '" aria-label="Select ' +
        escHtml(label) +
        '" />'
      );
    },
  };

  const dataColumns = [
    {
      key: 'thumb',
      label: '',
      // The header caption is empty by design (a 52px column of pictures needs no
      // word over it), so the column names itself for the chooser list, where an
      // unlabelled entry would be unpickable (issue #959).
      chooserLabel: 'Thumbnail',
      width: '52px',
      // Rendered WITHOUT a src (issue #801): pointing an <img> at the API's
      // thumbnail byte route can never work, because the browser's <img> GET
      // carries no Authorization header for the router's bearer gate. The src is
      // filled in after render by hydrateThumbnails(), which asks the API for a
      // signed URL over the authenticated apiFetch. Until it arrives — and if it
      // never does — the element carries `thumb-placeholder` and shows the same
      // empty box as an asset with no thumbnails, never a broken-image icon.
      render: (a) =>
        a.thumbnails && a.thumbnails.length
          ? '<img class="thumb-xs thumb-placeholder" alt="" loading="lazy"' +
            ' data-thumb-asset-id="' +
            escHtml(a.id) +
            '" data-thumb-index="0">'
          : '<div class="thumb-xs thumb-placeholder"></div>',
    },
    // Issue #851: the column headed "ID" carries the ULID `id` — the value every
    // asset-id endpoint accepts (see the CONTRACT GROUNDING block in
    // public/copy-id.js) — as selectable text with a click-to-copy button, not a
    // hover-only tooltip. The slug keeps its place in its own "Slug" column.
    {
      key: 'id',
      label: 'ID',
      render: (a) => copyableIdCellHtml(a.id, 'Copy asset id'),
    },
    // The slug is a real field on the tier-1 list item (openapi.json
    // .paths["/api/v1/assets/"].get ... items.properties.slug) but is ABSENT from
    // the tier-2 search projection (`assetSchema` in src/routes/search.ts:67-94
    // has no `slug`, and Fastify serializes against that schema). So this cell
    // renders an em-dash while a free-text `q` term is active — an honest empty,
    // not a wrong value. Noted with the other tier-2 contract gaps above; no
    // issue tracks widening that projection yet, so treat this as a known gap
    // rather than a scheduled fix.
    {
      key: 'slug',
      label: 'Slug',
      render: (a) => slugCellHtml(a.slug),
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
        // Explicit delete-lock flag (issue #894, spec §3.1-§3.3). It shares the
        // Status cell with the attention flag rather than claiming an eighth
        // column: a lock is a rare, secondary attribute. Order in the cell is
        // status, "Needs attention", "Locked" — fault first, then policy; a row
        // can legitimately be both.
        //
        // Unlocked rows render NOTHING — no badge, no placeholder. Absence is
        // the signal (§3.2).
        //
        // Rows from the free-text tier render nothing either, because their
        // projection omits the field: isAssetLocked() answers false for the
        // UNKNOWN state so the table never asserts a lock it cannot see. It also
        // never asserts the opposite — there is no "Unlocked" badge anywhere, so
        // an unknown row makes no false promise (§3.2 L0, §1 copy rule 3). The
        // Archive control is unaffected by design: it stays enabled and the 409
        // path explains the refusal (§5.1, §5.4 — #896).
        if (isAssetLocked(a, { projectionCarriesLock: projection.carriesLock })) {
          cell += ' ' + lockBadgeHtml();
        }
        return cell;
      },
    },
    // Editorial review (issue #961) — OFF by default; the flag is stamped below
    // from ASSETS_OPTIONAL_COLUMN_KEYS. Sits straight after Status because the
    // two are the asset's two state axes, and seeing them adjacent is the point:
    // review state is INDEPENDENT of the lifecycle status, and a table that put
    // them at opposite ends would invite reading one as a stage of the other.
    // Not sortable: neither endpoint takes a `sort` param and applyClientSort()
    // knows no reviewState axis, so a header control here would be a control
    // that does nothing.
    {
      key: 'reviewState',
      label: 'Review',
      chooserLabel: 'Review state',
      render: (a) => reviewStateCellHtml(a, projection.carriesReviewState),
    },
    // Rendition count (issue #961) — OFF by default. A count, not a list: the
    // labels live on the asset detail panel, and what a list view answers is
    // "has this been transcoded, and into how many variants?". Right-aligned so
    // a column of numbers can be scanned down.
    {
      key: 'renditions',
      label: 'Renditions',
      chooserLabel: 'Rendition count',
      align: 'right',
      render: (a) => renditionCountCellHtml(a),
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
        const redriveBtn = wedged
          ? '<button class="btn-ghost asset-redrive-btn" data-id="' +
            escHtml(a.id) +
            '" title="Re-run metadata extraction to recover this asset" style="font-size:12px;padding:3px 8px;">Re-drive</button> '
          : '';

        // Archive is a NO-OP on an asset that is already `archived`, and the app
        // can tell locally, so the control is withheld rather than offered as a
        // confirmation for an action that would change nothing (issue #955,
        // broken out from #853).
        //   - The second archive SUCCEEDS — it does NOT fail with a 422.
        //     `isValidTransition` short-circuits on `from === to` ("idempotent
        //     no-op transitions are allowed", src/data/asset-repo.ts →
        //     `isValidTransition`), so `applyStatus('archived', 'archived')`
        //     returns the status and history unchanged instead of throwing, and
        //     the soft delete (`remove()` → `update({ status: 'archived' })`)
        //     resolves normally. Contract: openapi.json
        //     `paths['/api/v1/assets/{id}'].delete.responses` = 204 / 404 / 409 —
        //     there is no 422 on this route, and the handler
        //     (src/routes/assets.ts → `app.delete('/:id')`) has no
        //     already-archived guard. A repeat DELETE answers 204 and the asset
        //     stays archived.
        //   - So what is removed here is NOISE, not a confirm-then-fail: a
        //     destructive-styled button, behind a confirmation dialog, for an
        //     idempotent no-op. That makes it UNLIKE the two sibling controls
        //     that gate on locally known status — the jobs table omitting Cancel
        //     on a settled job (public/jobs-table.js, actions column) and the
        //     detail panel omitting Restore on a non-archived asset
        //     (public/app.js, `isArchived` gate) both suppress actions that would
        //     really be refused. Restore remains reachable for the archived asset
        //     from its detail panel (a row click).
        //   - The determination is purely LOCAL and not racy: `status` is a core
        //     projection column present on every row and in every search tier
        //     (unlike the lock flag, #896, whose free-text projection omits
        //     `deleteLock`), and `archived` has no ordinary outbound transition
        //     (ALLOWED_TRANSITIONS.archived = []) — only the audited restore path
        //     leaves it, and that re-renders the row.
        //   - The archive guards that genuinely BLOCK (delete_protected,
        //     referenced_by_job, has_children, member_of_collection — all 409)
        //     are untouched and stay enabled. Most are not in the row projection,
        //     so the 409 response stays the only place that can explain them
        //     (spec §5.1, §5.4 — #896).
        // Re-drive is independent of the lifecycle axis (it is a metadata-
        // extraction recovery), so a wedged archived row still offers it.
        //
        // The guard is scoped to the Archive control ALONE. An earlier revision
        // returned early for an archived row, which also withheld Rename — but
        // renaming an archived asset is a PERMITTED operation, so that removed a
        // working affordance rather than a dead one. Contract: openapi.json
        // `paths['/api/v1/assets/{id}'].patch` declares responses 200 / 404 /
        // 422 only (no 409 and no status-conflict response), and its
        // `requestBody` schema accepts a bare `{ name }` (`name`: string,
        // minLength 1, maxLength 256). The handler (src/routes/assets.ts →
        // `app.patch('/:id')`) carries no archived guard, and `repo.update`
        // consults `applyStatus` ONLY when `patch.status !== undefined`
        // (src/data/asset-repo.ts), so a name-only PATCH on an archived asset
        // never reaches the terminal-state machine and answers 200. Every other
        // permitted control therefore stays rendered on an archived row.
        const isArchived = a.status === 'archived';

        return (
          redriveBtn +
          // Rename, straight from the row (issue #927 — the "inline-in-list"
          // affordance for the detail view's existing control). It opens the SAME
          // dialog the detail view opens (openRenameDialog, public/asset-rename.js),
          // so there is one rename interaction in this UI, not two: the row saves
          // the operator a detail-pane round trip, it does not get its own rules.
          //
          // `data-name` carries the row's current title so the dialog can prefill
          // without a second GET. `name` is REQUIRED on both tiers (it is in the
          // `required` list of the tier-1 list item and non-optional on the tier-2
          // `assetSchema`), so the `|| a.slug || ''` tail is defence against a
          // malformed payload, not an expected case: it keeps the attribute
          // well-formed, and the dialog's own `min(1)` rule then makes the operator
          // supply a name rather than sending an empty one.
          //
          // Offered on BOTH tiers. Unlike the delete lock, nothing here depends on
          // a field the free-text search projection omits: `id` and `name` are
          // both present on the tier-2 asset schema (src/routes/search.ts:77-90),
          // so a search-tier row can be renamed as safely as a list-tier one.
          //
          // A viewer gets NO button rather than a disabled one: the role cannot
          // hold `write`, so the control could only ever produce a 403. The server
          // remains the authority — the dialog still handles the 403 if the
          // client-side mirror is wrong.
          (canRename && canRename()
            ? '<button class="btn-ghost asset-rename-btn" data-id="' +
              escHtml(a.id) +
              '" data-name="' +
              escHtml(a.name || a.slug || '') +
              '" title="Rename this asset" style="font-size:12px;padding:3px 8px;">Rename</button> '
            : '') +
          // `data-name` carries the SAME human-readable label the "Name / Title"
          // column renders (a.name || a.slug) so the archive confirmation can
          // name its subject without a second lookup (issue #919). Empty when the
          // asset has neither; the caller supplies its own fallback phrase.
          //
          // `data-locked` (issue #896, spec §5.1) carries the lock state the
          // Status cell just derived, so the archive handler can explain the
          // protection BEFORE issuing a request that is certain to be refused.
          // It is the same `isAssetLocked` derivation, so the badge and the
          // dialog cannot disagree, and it is `"true"` only for a row whose
          // projection actually carries `deleteLock` — an UNKNOWN row (free-text
          // search tier) falls through to the 409 path instead of guessing.
          //
          // Unlike the archived case above, the lock is only one of four archive
          // guards and the search tier cannot always see it, so the button is
          // deliberately NOT `disabled` here: a disabled control is unfocusable
          // and carries no explanation, which is precisely what #896 asks the UI
          // to provide (spec §5.1).
          //
          // THIS is the single control the archived check suppresses — an
          // already-archived row gets no Archive button, while Re-drive and
          // Rename above remain available.
          (isArchived
            ? ''
            : '<button class="btn-danger asset-delete-btn" data-id="' +
              escHtml(a.id) +
              '" data-name="' +
              escHtml(a.name || a.slug || '') +
              (isAssetLocked(a, { projectionCarriesLock: projection.carriesLock })
                ? '" data-locked="true'
                : '') +
              '" style="font-size:12px;padding:3px 8px;">Archive</button>')
        );
      },
    },
  ];

  // Stamp the off-by-default flag from the one list that declares it (issue
  // #961), rather than repeating `defaultVisible: false` next to each column and
  // hoping the two stay in step. `defaultVisible` is read ONLY when nobody has
  // chosen a set — see defaultVisibleColumns() in public/table-columns.js — so a
  // stored preference or a `cols` param that names these columns still wins.
  const declared = dataColumns.map((col) =>
    ASSETS_OPTIONAL_COLUMN_KEYS.indexOf(col.key) === -1
      ? col
      : { ...col, defaultVisible: false }
  );

  // The selection checkbox column (issue #916) is prepended AFTER that stamp: it
  // is pinned (`hideable: false`) and is not one of the optional keys, so it has
  // no business passing through the off-by-default list.
  return renderCtx.selectable ? [selectColumn, ...declared] : declared;
}

// ─── Column visibility resolution (issue #959) ────────────────────────────────
//
// Decide the initial visible set and whether it counts as an EXPLICIT choice.
// Precedence, highest first:
//   1. `assets.cols` in the URL — a shared link must reproduce the sender's view,
//      the same rule sort/filter/page already follow. Beats storage so that
//      opening a colleague's link does not silently apply your own preference.
//   2. this browser's stored default — an operator who shaped the table once
//      should not have to reshape it on every bare visit.
//   3. the table's DEFAULT set — ASSETS_DEFAULT_COLUMN_KEYS, i.e. every declared
//      column except the ones marked `defaultVisible: false` (issue #961).
//
// `explicit` is what decides whether the set is mirrored into the URL: cases 1 and
// 2 are real choices worth encoding, case 3 is the absence of one and stays out of
// the query string so a default view still has a clean URL.
//
// Both stored and URL values are passed through normalizeVisibleColumns(), so a
// hand-edited param, a set saved before a column was renamed, or one that would
// empty the required group is repaired rather than honoured or rejected.
function resolveInitialColumns(urlCols, storedCols, columns) {
  const opts = { requireAtLeastOne: ASSETS_REQUIRED_COLUMN_GROUPS };
  if (urlCols && urlCols.length) {
    return { keys: normalizeVisibleColumns(urlCols, columns, opts), explicit: true, source: 'url' };
  }
  if (storedCols && storedCols.length) {
    return {
      keys: normalizeVisibleColumns(storedCols, columns, opts),
      explicit: true,
      source: 'stored',
    };
  }
  return { keys: normalizeVisibleColumns(null, columns, opts), explicit: false, source: 'default' };
}

// ─── Thumbnail hydration (issue #801) ─────────────────────────────────────────
//
// Fill in the src of every thumbnail <img> on the page of rows just rendered.
// The cell renderer above cannot do this itself: it returns a synchronous HTML
// string, while obtaining a loadable URL needs an authenticated round-trip to
// GET /assets/:id/thumbnails/:index/url (contract in public/thumbnail-url.js).
//
// Cost is bounded by the page size — at most one request per visible row that
// actually has a thumbnail, issued once per render, never per repaint (a second
// request follows only for a row whose signed URL could not be issued or loaded,
// which then falls back to the authenticated byte route). Failures are silent by
// design: the row keeps its placeholder box (applyThumbnail re-applies
// `thumb-placeholder`) rather than turning a storage hiccup into a table-wide
// error. A response that arrives after the rows were replaced lands on a
// detached element and is discarded with it.
function hydrateThumbnails(tbodyEl, apiFetch) {
  if (!tbodyEl || typeof apiFetch !== 'function') return;
  tbodyEl.querySelectorAll('img[data-thumb-asset-id]').forEach(function (img) {
    void applyThumbnail(img, {
      apiFetch,
      assetId: img.getAttribute('data-thumb-asset-id'),
      index: img.getAttribute('data-thumb-index'),
      placeholderClass: 'thumb-placeholder',
    });
  });
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
//   onDelete(id, name, rowState) -> Promise
//                                       — archive action; the table reloads
//                                         unless the handler resolves `false`.
//                                         `name` is the row's human-readable
//                                         label (issue #919) so the caller's
//                                         confirmation can name the subject.
//                                         `rowState` is `{ locked }` (issue
//                                         #896) — the lock state this row could
//                                         derive, so the handler can explain a
//                                         guaranteed refusal pre-flight.
//   onRedrive(id) -> Promise            — re-drive action; table reloads after.
//   canRename() -> boolean (optional)   — client-side mirror of the ADR-018 write
//                                         gate (issue #927). Called at render
//                                         time; when it is absent or answers
//                                         false, no row carries a Rename control.
//   onRename(id, name) -> Promise       — rename action; `name` is the row's
//                                         current title, for the dialog's
//                                         prefill. The table reloads unless the
//                                         handler resolves `false`.
//   selectable (optional, issue #916)   — when true, prepend a tick-box column
//                                         and track a selection that survives
//                                         sort/filter/page repaints.
//   onSelectionChange(selection)        — fires on every selection change with
//                                         `[{ id, label }]`; only meaningful
//                                         alongside `selectable: true`.
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
  // Structured filters (issue #914). The shared decoder hands these back as
  // normalised arrays; the controls hold text, so they are re-joined with the
  // same comma separator the decoder split on — a round trip, not a reformat.
  if (urlState.tags && urlState.tags.length) initialFilters.tags = urlState.tags.join(',');
  if (urlState.meta && urlState.meta.length) initialFilters.meta = urlState.meta.join(',');
  if (urlState.status && urlState.status.length) initialFilters.status = urlState.status[0];
  if (urlState.from) initialFilters.from = urlState.from;
  if (urlState.to) initialFilters.to = urlState.to;

  // Whether the rows currently in hand came from a projection that carries
  // `deleteLock` (issue #894). Tier 1 does; tier 2 (free-text search) does not.
  // Written by reload() from the fetch result immediately before setRows(), so
  // the Status renderer always reads the flag belonging to the rows it renders.
  // Starts true because the first load is tier 1 unless the URL seeds a `q`.
  // A tags/metadata-only filter also routes to tier 2 (#914), so it is just as
  // lock-blind as a free-text term — the flag has to account for all three.
  //
  // `carriesReviewState` (issue #961) is the same tier question asked of a
  // different field — tier 1 projects `reviewState`, tier 2 does not — and is
  // tracked separately rather than collapsed into one "tier" flag, because the
  // two gaps are independent and the search projection may grow one field
  // without the other. It seeds off the same three-filter condition because the
  // same three filters are what route a load to tier 2 (fetchAssetsPage above).
  const projection = {
    carriesLock: !(initialFilters.q || initialFilters.tags || initialFilters.meta),
    carriesReviewState: !(initialFilters.q || initialFilters.tags || initialFilters.meta),
  };

  // Bulk selection (issue #916). id -> human-readable label, so a bulk-action
  // bar can name what it is about to act on without re-reading the rows. Lives
  // outside the row data on purpose: it must SURVIVE a repaint (sort, filter,
  // page) so an operator can gather assets from more than one page before
  // acting. Only `clearSelection()` and an explicit untick remove entries.
  const selection = new Map();
  const selectable = d.selectable === true;

  const columns = buildColumns({
    renderBadge: d.renderBadge,
    renderTags: d.renderTags,
    fmtDate: d.fmtDate,
    isAssetWedged: d.isAssetWedged,
    projection,
    canRename: d.canRename,
    selectable,
    selection,
  });

  function selectedIds() {
    return [...selection.keys()];
  }

  // One place the consumer is told the selection moved, so the bulk bar never
  // has to poll or re-derive it from the DOM.
  function emitSelection() {
    if (typeof d.onSelectionChange === 'function') {
      d.onSelectionChange(
        selectedIds().map(function (id) {
          return { id: id, label: selection.get(id) || id };
        })
      );
    }
  }

  // Initial visible column set (issue #959): URL -> stored default -> all.
  const columnChoice = resolveInitialColumns(
    urlState.cols,
    readStoredColumns(ASSETS_NS, win),
    columns
  );

  const filters = [
    { name: 'status', control: asSlot(statusFilterControl(initialFilters.status)) },
    { name: 'from', control: asSlot(dateFilterControl('from', 'Created from', initialFilters.from)) },
    { name: 'to', control: asSlot(dateFilterControl('to', 'Created to', initialFilters.to)) },
    { name: 'q', control: asSlot(searchFilterControl(initialFilters.q)) },
    // Structured filters (issue #914), after the free-text box: they REFINE a
    // list, so they read left-to-right as "search, then narrow".
    { name: 'tags', control: asSlot(tagsFilterControl(initialFilters.tags)) },
    { name: 'meta', control: asSlot(metadataFilterControl(initialFilters.meta)) },
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
    // Column chooser (issue #959). The primitive mounts the control and repaints;
    // this callback owns the two places the choice is remembered.
    columnChooser: {
      visible: columnChoice.keys,
      requireAtLeastOne: ASSETS_REQUIRED_COLUMN_GROUPS,
      label: 'Columns',
      onChange: function (keys) {
        columnChoice.keys = keys;
        columnChoice.explicit = true;
        // This browser's default for the next bare visit. Best-effort: a blocked
        // or full localStorage costs the operator a remembered preference, never
        // the table.
        writeStoredColumns(ASSETS_NS, keys, win);
        // And the URL, so the view stays shareable. Deliberately syncUrl() and
        // NOT reload(): the request is identical, so re-issuing it would be a
        // wasted round-trip and a visible loading flash for a repaint.
        syncUrl(table.state.getState());
      },
      // Reset to defaults (issue #962) — the exact inverse of onChange above, and
      // it has to undo BOTH of its writes. Clearing only one is not a partial
      // reset, it is no reset at all: a surviving `cols` param re-applies on this
      // refresh, and a surviving stored default re-applies on the next bare visit.
      // `keys` is the declared default set the primitive has already painted, so
      // this callback only forgets.
      onReset: function (keys) {
        columnChoice.keys = keys;
        // 1) The URL half. Dropping `explicit` is what removes the param rather
        //    than rewriting it: syncUrl sends `cols: null`, and encodeTableState
        //    clears every param in this namespace before writing back only the
        //    non-default ones — so `assets.cols` simply does not come back.
        columnChoice.explicit = false;
        // 2) The stored half. Best-effort like the write it undoes; a blocked
        //    store had nothing to forget in the first place.
        clearStoredColumns(ASSETS_NS, win);
        syncUrl(table.state.getState());
      },
      // Whether there is anything left to reset, so the action is greyed out in a
      // view that is already pristine. `explicit` covers both a choice made in
      // this session and one the URL arrived with; the stored read covers a
      // default saved in an earlier one.
      isCustomized: function () {
        return columnChoice.explicit || readStoredColumns(ASSETS_NS, win) != null;
      },
    },
  });

  // No page-scoped-narrowing caveat here by design: status and from/to are
  // server-side on both tiers (#833), so the reported total is exact (#834).

  // Re-entrancy guard for the load cycle. `reload()` is driven by the state
  // subscription, and it also touches state itself (setPageInfo), so it has to be
  // able to tell its own bookkeeping apart from a real user change.
  let loading = false;
  // A reload asked for while one was in flight FOR DIFFERENT STATE coalesces into
  // a single re-run afterwards instead of being dropped (issue #946). Dropping it
  // was harmless while every filter change needed a deliberate Enter, but a live
  // filter box changes state while a request is open: clearing the box mid-flight
  // used to leave the stale search results on screen for good. The last state the
  // user asked for is always the one that ends up rendered.
  let reloadQueued = false;
  // The state signature the in-flight load is FOR, so a re-entrant call can tell
  // "the user changed something" from "this load's own bookkeeping". The
  // difference matters: setPageInfo() below emits from inside reload(), and the
  // subscription turns every emit into a reload() — treating that self-emit as a
  // new request would re-fetch forever.
  let loadingSignature = null;

  // Mirror the current view into the URL (shared contract) so a refresh/share
  // reproduces it. Replace (not push) — control changes already re-render and we
  // do not want a history entry per keystroke or per column toggle.
  //
  // `cols` has to be passed on EVERY call, not only from the chooser: the encoder
  // clears all of this namespace's params before rewriting them, so omitting it
  // here would have the first load wipe a `cols` the URL arrived with. It is sent
  // as null until the operator (or their stored default) actually chose something,
  // which is what keeps a virgin default view's URL clean.
  function syncUrl(snap) {
    const page = Math.floor((snap.offset || 0) / snap.pageSize) + 1;
    return applyTableState(
      {
        sort: tableSortToUrlSort(snap.sort),
        status: snap.filters.status ? [snap.filters.status] : [],
        q: snap.filters.q || '',
        // Normalised through the SAME parsers the request uses, so the URL can
        // only ever describe filters that were actually sent (issue #914).
        tags: parseTagsFilter(snap.filters.tags),
        meta: parseMetadataFilter(snap.filters.meta).map(function (p) {
          return p.key + '=' + p.value;
        }),
        from: snap.filters.from || null,
        to: snap.filters.to || null,
        page,
        size: snap.pageSize,
        cols: columnChoice.explicit ? columnChoice.keys : null,
      },
      ASSETS_NS,
      { defaults: URL_DEFAULTS, replace: true, win }
    );
  }

  async function reload() {
    const snap = table.state.getState();
    if (loading) {
      // Same sort/filters/page window as the load already running: there is
      // nothing new to ask for.
      if (stateSignature(snap) === loadingSignature) return;
      reloadQueued = true;
      return;
    }
    loading = true;
    loadingSignature = stateSignature(snap);

    // 3) Mirror the current interaction state into the URL (shared contract) so a
    //    refresh/share reproduces the view.
    syncUrl(snap);

    table.setStatus('loading');
    try {
      const page1 = await fetchAssetsPage(snap, { apiFetch: d.apiFetch });
      const { rows, total } = page1;
      // Record which tier produced these rows BEFORE they are rendered — the
      // Status column's lock flag reads it (issue #894), as does the optional
      // Review state column (issue #961).
      projection.carriesLock = page1.projectionCarriesLock !== false;
      projection.carriesReviewState = page1.projectionCarriesReviewState !== false;
      table.state.setPageInfo({ total });
      table.setRows(rows);
      wireRowHandlers();
    } catch (err) {
      table.setStatus('error', 'Failed to load assets: ' + (err && err.message ? err.message : err));
    } finally {
      loading = false;
      if (reloadQueued) {
        reloadQueued = false;
        void reload();
      }
    }
  }

  // Attach row-level interactions after each render (rows are rebuilt each load).
  function wireRowHandlers() {
    const tbody = table.el.querySelector('tbody');
    if (!tbody) return;

    // Thumbnails are rendered src-less and resolved here (issue #801).
    hydrateThumbnails(tbody, d.apiFetch);

    // Click-to-copy for the asset id cell (issue #851). Bound before the row
    // handler below; the copy handler stops propagation so copying an id does
    // not also open that row's detail panel.
    wireCopyIdButtons(tbody);

    // Bulk-selection tick boxes (issue #916). `click` stops propagation so
    // ticking a row does not ALSO open that row's detail panel — selecting and
    // inspecting are different intents. `change` is what records the choice, so
    // keyboard operation (focus the box, press Space) works identically.
    tbody.querySelectorAll('.asset-select-box').forEach(function (box) {
      box.addEventListener('click', function (e) {
        e.stopPropagation();
      });
      box.addEventListener('change', function () {
        if (box.checked) {
          selection.set(box.value, box.dataset.assetLabel || box.value);
        } else {
          selection.delete(box.value);
        }
        emitSelection();
      });
    });

    tbody.querySelectorAll('tr[data-row-key]').forEach(function (tr) {
      const id = tr.getAttribute('data-row-key');
      // Row accent for a delete-locked row (issue #894, spec §3.1). Derived from
      // the flag the Status cell just rendered rather than from the row data a
      // second time, so the accent and the badge cannot drift apart. It is
      // decorative — indigo `--accent`, deliberately not the wedged flag's amber
      // — and never carries meaning the badge does not also carry (§6, WCAG
      // 1.4.1). Its job is to survive horizontal scrolling of a wide table.
      if (tr.querySelector('.asset-lock-flag')) tr.classList.add(ROW_LOCKED_CLASS);
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
        // Third argument (issue #896): the row's known lock state, so the
        // handler can open the blocked-archive dialog pre-flight instead of
        // waiting for the 409. `locked: false` means "not locked OR not
        // knowable" — never "safe to archive" — which is why the handler still
        // classifies the 409 afterwards.
        const ok = await d.onDelete(btn.dataset.id, btn.dataset.name || '', {
          locked: btn.dataset.locked === 'true',
        });
        if (ok !== false) reload();
      });
    });

    // Rename from the row (issue #927). The handler owns the dialog and the
    // request; this only keeps the row click from also opening the detail pane,
    // and reloads so the renamed row shows its new title in whichever tier is on
    // screen — both the list and the free-text search projection read `name` from
    // the live asset document, so one reload is enough and no reindex step
    // exists to wait for.
    //
    // `false` means "nothing changed" (cancelled, or a refusal the handler has
    // already explained), and skips the reload for the same reason the archive
    // handler does: a request that changed nothing has nothing to repaint.
    tbody.querySelectorAll('.asset-rename-btn').forEach(function (btn) {
      btn.addEventListener('click', async function (e) {
        e.stopPropagation();
        if (typeof d.onRename !== 'function') return;
        const ok = await d.onRename(btn.dataset.id, btn.dataset.name || '');
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

  // ── Bulk selection, for the consumer's action bar (issue #916) ──

  // Tick every row currently on screen. Additive: rows selected on other pages
  // stay selected.
  function selectAllOnPage() {
    const tbody = table.el.querySelector('tbody');
    if (tbody) {
      tbody.querySelectorAll('.asset-select-box').forEach(function (box) {
        box.checked = true;
        selection.set(box.value, box.dataset.assetLabel || box.value);
      });
    }
    emitSelection();
    return selectedIds();
  }

  // Untick a specific set of ids, leaving the rest of the selection alone.
  // The counterpart `clearSelection()` is all-or-nothing, which is wrong after a
  // PARTIAL bulk run: the ids that landed must leave the selection while the
  // ones that failed stay ticked for retry. Because this Map is the
  // AUTHORITATIVE selection (a consumer's own copy is only a mirror fed by
  // `onSelectionChange`), narrowing has to happen here or the next tick anywhere
  // in the table re-emits the ids that already landed. Ids not currently on
  // screen have no box to untick — dropping them from the Map is enough, the
  // next repaint renders them unticked.
  function deselect(ids) {
    const drop = new Set(
      (Array.isArray(ids) ? ids : [ids]).map(function (entry) {
        return entry && typeof entry === 'object' ? entry.id : entry;
      })
    );
    if (drop.size === 0) return selectedIds();
    let changed = false;
    drop.forEach(function (id) {
      if (selection.delete(id)) changed = true;
    });
    const tbody = table.el.querySelector('tbody');
    if (tbody) {
      tbody.querySelectorAll('.asset-select-box').forEach(function (box) {
        if (drop.has(box.value)) box.checked = false;
      });
    }
    if (changed) emitSelection();
    return selectedIds();
  }

  function clearSelection() {
    selection.clear();
    const tbody = table.el.querySelector('tbody');
    if (tbody) {
      tbody.querySelectorAll('.asset-select-box').forEach(function (box) {
        box.checked = false;
      });
    }
    emitSelection();
    return [];
  }

  return {
    el: table.el,
    reload,
    destroy: table.destroy,
    // Bulk selection (issue #916). `getSelection()` returns `{ id, label }`
    // entries in tick order so a caller can both act on the ids and name them.
    getSelection: function () {
      return selectedIds().map(function (id) {
        return { id: id, label: selection.get(id) || id };
      });
    },
    getSelectedIds: selectedIds,
    selectAllOnPage,
    // Per-id untick, for a consumer that consumed only part of its selection.
    deselect,
    clearSelection,
    // Exposed for tests/consumers that want to drive the primitive directly.
    state: table.state,
    // Column visibility (issue #959), for consumers/tests that want to read or
    // drive the chosen set without going through the chooser's DOM.
    getVisibleColumns: table.getVisibleColumns,
    _table: table,
  };
}
