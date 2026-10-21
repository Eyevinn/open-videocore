/**
 * open-videocore ops dashboard — table-url-state.js
 *
 * Self-contained URL query-param state serialization for ops-UI tables
 * (issue #368, under parent #366).
 *
 * WHAT THIS IS
 *   A single, table-agnostic contract for encoding/decoding a table's
 *   sort + filter + paging state into URL query params, so that any table
 *   view is fully reconstructable from the URL alone (share a link / refresh
 *   / open in a fresh tab -> identical view).
 *
 * WHAT THIS IS NOT
 *   - It does NOT render any controls. The shared table primitive (issue #367,
 *     not yet on main) is the consumer; this module has zero dependency on it.
 *   - It does NOT run server queries. Per-table route handlers own that.
 *
 * DESIGN NOTES
 *   - Pure functions first: encodeTableState() / decodeTableState() are pure
 *     (no window/history access) so they are trivially unit-testable and can
 *     run in any environment (browser, worker, test, SSR).
 *   - Namespacing: every table on a route declares a `ns` prefix so multiple
 *     tables on one route never collide on param names. Params are emitted as
 *     `<ns>.<key>` (e.g. `assets.sort`, `jobs.page`).
 *   - Tolerant parsing: absent, malformed, out-of-range, or hostile params
 *     degrade silently to defaults — decode never throws.
 *   - History sync (applyTableState) is a thin, optional helper kept separate
 *     from the pure core; it is the only part that touches window.history.
 *
 * PARAM SCHEMA (per table, all keys namespaced as `<ns>.<key>`)
 *   sort   sort field + direction, encoded as `<field>` (asc) or `-<field>` (desc).
 *          e.g. `assets.sort=createdAt` (asc) or `assets.sort=-createdAt` (desc).
 *   status filter: one status value, or a comma-separated set. e.g. `jobs.status=failed`
 *          or `jobs.status=queued,running`.
 *   q      filter: free-text search string.
 *   tags   filter: one tag, or a comma-separated set, e.g. `assets.tags=news,sports`
 *          (issue #914). Parsed exactly like `status` — the comma-separated form is
 *          what `GET /api/v1/search/?tags=` itself accepts (`tagsSchema`,
 *          src/routes/search.ts:139-150), so the URL and the request agree without
 *          a re-encoding step.
 *   meta   filter: comma-separated `key=value` pairs over an asset's free-form
 *          operator metadata, e.g. `assets.meta=genre=documentary,language=sv`
 *          (issue #914). Each pair becomes one `metadata.<key>=<value>` request
 *          param (`extractMetadataFilter`, src/routes/search.ts:221-240). Only the
 *          FIRST `=` splits a pair, so a value may contain `=`; a value may not
 *          contain a comma, since that is the pair separator here.
 *   from   filter: ISO date (inclusive lower bound), YYYY-MM-DD or full ISO.
 *   to     filter: ISO date (inclusive upper bound).
 *   page   1-based page number (offset-style paging).
 *   cursor opaque cursor token (cursor-style paging). Mutually informative with
 *          `page`; a table uses whichever it declares in defaults.
 *   size   page size (rows per page).
 *   cols   VIEW state, not query state (issue #959): the ordered, comma-separated
 *          set of column keys the operator has chosen to SHOW, e.g.
 *          `assets.cols=id,title,status,actions`. It never reaches a backend — it
 *          only decides which of the table's declared columns are rendered — so it
 *          can never change which rows match or in what order they arrive.
 *          `null` means UNSPECIFIED (use the table's own default set), which is
 *          why an empty/blank `cols` decodes to null rather than to "show nothing":
 *          a garbled param must never produce a headerless table. Column keys are
 *          the table's own vocabulary, so the consumer is responsible for dropping
 *          keys it does not declare — this module only parses the list.
 */

// ─── Schema constants ────────────────────────────────────────────────────────

/**
 * The canonical, shared param keys. One schema for ALL tables — do not fork
 * per-table names. These are the un-namespaced keys; the namespace is prefixed
 * at (de)serialization time.
 */
const PARAM_KEYS = Object.freeze({
  sort: 'sort',
  status: 'status',
  q: 'q',
  tags: 'tags',
  meta: 'meta',
  from: 'from',
  to: 'to',
  page: 'page',
  cursor: 'cursor',
  size: 'size',
  cols: 'cols',
});

const SORT_DIR = Object.freeze({ asc: 'asc', desc: 'desc' });

/**
 * Baseline defaults used when a table does not override them. A table SHOULD
 * pass its own `defaults` (e.g. its natural sort field and page size) into
 * encode/decode; anything it omits falls back to these.
 */
const BASE_DEFAULTS = Object.freeze({
  sort: null, // { field: string, dir: 'asc'|'desc' } | null (server default order)
  status: [], // string[]  (empty = no status filter)
  q: '', // string
  tags: [], // string[]  (empty = no tag filter)
  meta: [], // string[] of 'key=value' pairs (empty = no metadata filter)
  from: null, // string | null (ISO date)
  to: null, // string | null (ISO date)
  page: 1, // 1-based
  cursor: null, // string | null
  size: 20, // rows per page
  cols: null, // string[] | null  (null = unspecified -> table's own default set)
});

// Guardrails so a hostile/garbled URL can never blow up a table.
const SIZE_MIN = 1;
const SIZE_MAX = 500;
const PAGE_MIN = 1;
const PAGE_MAX = 1_000_000;
// A column set is bounded by how many columns a table can plausibly declare. A
// hostile `cols` with thousands of entries is truncated rather than walked.
const COLS_MAX = 64;
const COL_KEY_MAX_LEN = 64;

// ─── Small pure helpers ──────────────────────────────────────────────────────

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Merge a caller's partial defaults over BASE_DEFAULTS, defensively cloning the
 * array/object-valued fields so callers can't mutate shared state.
 */
function resolveDefaults(defaults) {
  const d = isPlainObject(defaults) ? defaults : {};
  const sort = normalizeSortValue(
    'sort' in d ? d.sort : BASE_DEFAULTS.sort,
  );
  return {
    sort,
    status: normalizeStatusValue('status' in d ? d.status : BASE_DEFAULTS.status),
    q: typeof d.q === 'string' ? d.q : BASE_DEFAULTS.q,
    tags: normalizeStatusValue('tags' in d ? d.tags : BASE_DEFAULTS.tags),
    meta: normalizeMetaValue('meta' in d ? d.meta : BASE_DEFAULTS.meta),
    from: normalizeDateValue('from' in d ? d.from : BASE_DEFAULTS.from),
    to: normalizeDateValue('to' in d ? d.to : BASE_DEFAULTS.to),
    page: clampInt(d.page, BASE_DEFAULTS.page, PAGE_MIN, PAGE_MAX),
    cursor: typeof d.cursor === 'string' && d.cursor.length > 0 ? d.cursor : BASE_DEFAULTS.cursor,
    size: clampInt(d.size, BASE_DEFAULTS.size, SIZE_MIN, SIZE_MAX),
    cols: normalizeColumnsValue('cols' in d ? d.cols : BASE_DEFAULTS.cols),
  };
}

function clampInt(raw, fallback, min, max) {
  // Accept numbers or numeric strings; reject everything else -> fallback.
  const n =
    typeof raw === 'number'
      ? raw
      : typeof raw === 'string' && /^-?\d+$/.test(raw.trim())
        ? Number.parseInt(raw.trim(), 10)
        : NaN;
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/** Normalize any sort input into `{ field, dir }` or null. */
function normalizeSortValue(v) {
  if (v == null) return null;
  if (typeof v === 'string') return parseSortToken(v);
  if (isPlainObject(v) && typeof v.field === 'string' && v.field.length > 0) {
    const field = v.field.trim();
    if (!field) return null;
    const dir = v.dir === SORT_DIR.desc ? SORT_DIR.desc : SORT_DIR.asc;
    return { field, dir };
  }
  return null;
}

/** Parse a `-field` / `field` token into `{ field, dir }` or null. */
function parseSortToken(token) {
  if (typeof token !== 'string') return null;
  let s = token.trim();
  if (!s) return null;
  let dir = SORT_DIR.asc;
  if (s.startsWith('-')) {
    dir = SORT_DIR.desc;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  s = s.trim();
  if (!s) return null;
  return { field: s, dir };
}

/** Serialize `{ field, dir }` into a `-field` / `field` token, or '' if empty. */
function serializeSortToken(sort) {
  if (!isPlainObject(sort) || typeof sort.field !== 'string' || !sort.field) return '';
  return (sort.dir === SORT_DIR.desc ? '-' : '') + sort.field;
}

/** Normalize a status filter into a de-duped string[] (empty = no filter). */
function normalizeStatusValue(v) {
  let parts;
  if (Array.isArray(v)) {
    parts = v;
  } else if (typeof v === 'string') {
    parts = v.split(',');
  } else {
    return [];
  }
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    if (typeof p !== 'string') continue;
    const t = p.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/**
 * Normalize a free-form metadata filter into a de-duped `key=value` string[]
 * (empty = no filter). Issue #914.
 *
 * Deliberately NOT normalizeStatusValue: a bare token with no `=`, or one whose
 * key side is blank, is not a filter the backend can express — the request param
 * is literally `metadata.<key>=<value>` (`extractMetadataFilter`,
 * src/routes/search.ts:221-240) — so such tokens are dropped rather than sent as
 * something the server would ignore. Only the FIRST `=` splits a pair, so a value
 * may itself contain `=`. An EMPTY value side is kept: `metadata.genre=` is a real
 * filter (match the empty string), not a malformed one, and silently dropping it
 * would show the operator rows their filter said to exclude.
 */
function normalizeMetaValue(v) {
  let parts;
  if (Array.isArray(v)) {
    parts = v;
  } else if (typeof v === 'string') {
    parts = v.split(',');
  } else {
    return [];
  }
  const out = [];
  const seenKeys = new Set();
  for (const p of parts) {
    if (typeof p !== 'string') continue;
    const eq = p.indexOf('=');
    if (eq < 0) continue;
    const key = p.slice(0, eq).trim();
    const value = p.slice(eq + 1).trim();
    // One filter per key: the backend keeps only the first value for a repeated
    // key, so a second pair for the same key would be a promise the request
    // cannot keep.
    if (!key || seenKeys.has(key)) continue;
    seenKeys.add(key);
    out.push(key + '=' + value);
  }
  return out;
}

/**
 * Normalize a visible-column set into a de-duped, order-preserving string[], or
 * null when nothing usable was supplied.
 *
 * Deliberately NOT normalizeStatusValue: that one maps empty to `[]`, meaning
 * "no filter". Here `[]` would have to mean "render no columns at all", which is
 * not a view any table should be talked into by a blank or hostile param — so an
 * empty result collapses to null ("unspecified"), and the caller falls back to
 * its own default set. Order is preserved because the operator's chosen order is
 * data in its own right for a consumer that wants to honour it; consumers that
 * render in declared order simply ignore it.
 */
function normalizeColumnsValue(v) {
  let parts;
  if (Array.isArray(v)) {
    parts = v;
  } else if (typeof v === 'string') {
    parts = v.split(',');
  } else {
    return null;
  }
  const out = [];
  const seen = new Set();
  for (const p of parts) {
    if (typeof p !== 'string') continue;
    const t = p.trim();
    if (!t || t.length > COL_KEY_MAX_LEN || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= COLS_MAX) break;
  }
  return out.length ? out : null;
}

/**
 * Normalize a date-bound value. Accepts `YYYY-MM-DD` or a full ISO string;
 * returns the original trimmed string if it parses to a real date, else null.
 * We keep the caller's original representation (do not force to full ISO) so a
 * `from=2026-01-01` round-trips as `2026-01-01`, not `...T00:00:00.000Z`.
 */
function normalizeDateValue(v) {
  if (typeof v !== 'string') return null;
  const s = v.trim();
  if (!s) return null;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return null;
  return s;
}

// ─── Core: decode (URL -> state) ─────────────────────────────────────────────

/**
 * Read one string param for a table's namespace from a URLSearchParams-like
 * source. Returns null when absent/blank.
 */
function readParam(params, ns, key) {
  const name = ns ? ns + '.' + key : key;
  const raw = params.get(name);
  if (raw == null) return null;
  const s = String(raw).trim();
  return s.length ? s : null;
}

/**
 * Coerce a query-string-ish input into a URLSearchParams. Accepts:
 *   - a URLSearchParams instance (returned as-is)
 *   - a query string ('?a=1' or 'a=1')
 *   - a full/partial URL string (uses its search)
 *   - null/undefined -> empty
 * Never throws.
 */
function toSearchParams(input) {
  if (input == null) return new URLSearchParams();
  if (input instanceof URLSearchParams) return input;
  if (typeof input !== 'string') {
    // Anything else (objects) — best effort via URLSearchParams, else empty.
    try {
      return new URLSearchParams(input);
    } catch {
      return new URLSearchParams();
    }
  }
  const s = input;
  // If it looks like a URL, pull its query string out.
  const qIndex = s.indexOf('?');
  if (qIndex >= 0) {
    try {
      return new URLSearchParams(s.slice(qIndex + 1));
    } catch {
      return new URLSearchParams();
    }
  }
  try {
    return new URLSearchParams(s);
  } catch {
    return new URLSearchParams();
  }
}

/**
 * Decode a table's state from the URL.
 *
 * @param {string|URLSearchParams|null} input  query string, URL, or params.
 * @param {string} ns                          table namespace (e.g. 'assets').
 * @param {object} [defaults]                  per-table default overrides.
 * @returns {{sort:({field:string,dir:string}|null), status:string[], q:string,
 *            from:(string|null), to:(string|null), page:number,
 *            cursor:(string|null), size:number}}
 *
 * Tolerant: absent/malformed params degrade to defaults; never throws.
 */
function decodeTableState(input, ns, defaults) {
  const def = resolveDefaults(defaults);
  const params = toSearchParams(input);

  // sort
  const sortRaw = readParam(params, ns, PARAM_KEYS.sort);
  const sort = sortRaw != null ? parseSortToken(sortRaw) ?? def.sort : def.sort;

  // status (comma-separated set)
  const statusRaw = readParam(params, ns, PARAM_KEYS.status);
  const status = statusRaw != null ? normalizeStatusValue(statusRaw) : def.status;

  // free text
  const qRaw = readParam(params, ns, PARAM_KEYS.q);
  const q = qRaw != null ? qRaw : def.q;

  // structured asset filters (issue #914)
  const tagsRaw = readParam(params, ns, PARAM_KEYS.tags);
  const tags = tagsRaw != null ? normalizeStatusValue(tagsRaw) : def.tags;
  const metaRaw = readParam(params, ns, PARAM_KEYS.meta);
  const meta = metaRaw != null ? normalizeMetaValue(metaRaw) : def.meta;

  // date range
  const fromRaw = readParam(params, ns, PARAM_KEYS.from);
  const from = fromRaw != null ? normalizeDateValue(fromRaw) ?? def.from : def.from;
  const toRaw = readParam(params, ns, PARAM_KEYS.to);
  const to = toRaw != null ? normalizeDateValue(toRaw) ?? def.to : def.to;

  // paging
  const pageRaw = readParam(params, ns, PARAM_KEYS.page);
  const page = pageRaw != null ? clampInt(pageRaw, def.page, PAGE_MIN, PAGE_MAX) : def.page;

  const cursorRaw = readParam(params, ns, PARAM_KEYS.cursor);
  const cursor = cursorRaw != null ? cursorRaw : def.cursor;

  const sizeRaw = readParam(params, ns, PARAM_KEYS.size);
  const size = sizeRaw != null ? clampInt(sizeRaw, def.size, SIZE_MIN, SIZE_MAX) : def.size;

  // Visible column set (view state). A present-but-unusable value degrades to the
  // table's default set, exactly like every other param here.
  const colsRaw = readParam(params, ns, PARAM_KEYS.cols);
  const cols = colsRaw != null ? normalizeColumnsValue(colsRaw) ?? def.cols : def.cols;

  return { sort, status, q, tags, meta, from, to, page, cursor, size, cols };
}

// ─── Core: encode (state -> URL params) ──────────────────────────────────────

function shallowEqualStringArray(a, b) {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sortEqual(a, b) {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.field === b.field && a.dir === b.dir;
}

/**
 * Encode a table's state into URLSearchParams, writing ONLY the keys that
 * differ from that table's defaults. This keeps shared URLs short and readable
 * and means "no query params" is a valid canonical representation of "default
 * view". Callers get back a URLSearchParams they can merge into a URL.
 *
 * @param {object} state       partial or full table state (missing keys -> default).
 * @param {string} ns          table namespace.
 * @param {object} [defaults]  per-table default overrides.
 * @param {URLSearchParams} [into]  optional target to write into (e.g. to
 *        preserve OTHER tables' / unrelated params on the same URL). If given,
 *        this table's namespaced keys are first removed, then re-written.
 * @returns {URLSearchParams}
 */
function encodeTableState(state, ns, defaults, into) {
  const def = resolveDefaults(defaults);
  const s = normalizeState(state, def);
  const params = into instanceof URLSearchParams ? into : new URLSearchParams();

  // Clear any prior values for THIS namespace so re-encoding is idempotent and
  // never leaves stale keys behind (important when merging into a live URL).
  for (const key of Object.values(PARAM_KEYS)) {
    params.delete(ns ? ns + '.' + key : key);
  }

  const set = (key, value) => params.set(ns ? ns + '.' + key : key, value);

  if (!sortEqual(s.sort, def.sort)) {
    const token = serializeSortToken(s.sort);
    if (token) set(PARAM_KEYS.sort, token);
  }
  if (!shallowEqualStringArray(s.status, def.status) && s.status.length) {
    set(PARAM_KEYS.status, s.status.join(','));
  }
  if (s.q !== def.q && s.q.length) {
    set(PARAM_KEYS.q, s.q);
  }
  if (!shallowEqualStringArray(s.tags, def.tags) && s.tags.length) {
    set(PARAM_KEYS.tags, s.tags.join(','));
  }
  if (!shallowEqualStringArray(s.meta, def.meta) && s.meta.length) {
    set(PARAM_KEYS.meta, s.meta.join(','));
  }
  if (s.from !== def.from && s.from) {
    set(PARAM_KEYS.from, s.from);
  }
  if (s.to !== def.to && s.to) {
    set(PARAM_KEYS.to, s.to);
  }
  if (s.page !== def.page) {
    set(PARAM_KEYS.page, String(s.page));
  }
  if (s.cursor !== def.cursor && s.cursor) {
    set(PARAM_KEYS.cursor, s.cursor);
  }
  if (s.size !== def.size) {
    set(PARAM_KEYS.size, String(s.size));
  }
  // `cols` is written whenever a set is present AND differs from the table's
  // declared default. A table whose default is `null` (unspecified) therefore gets
  // a `cols` param as soon as the operator makes ANY explicit choice — including
  // "show everything". That is on purpose: the link has to describe the view it
  // came from, and "explicitly all columns" is a different intent from "whatever
  // this browser last stored", which is what an absent param falls back to.
  if (!shallowEqualStringArray(s.cols, def.cols) && s.cols && s.cols.length) {
    set(PARAM_KEYS.cols, s.cols.join(','));
  }

  return params;
}

/**
 * Normalize an arbitrary (possibly partial/hostile) state object into the full
 * canonical shape, filling gaps from `def`. Shared by encode and by public
 * normalizeTableState().
 */
function normalizeState(state, def) {
  const st = isPlainObject(state) ? state : {};
  return {
    sort: 'sort' in st ? normalizeSortValue(st.sort) : def.sort,
    status: 'status' in st ? normalizeStatusValue(st.status) : def.status,
    q: typeof st.q === 'string' ? st.q : def.q,
    tags: 'tags' in st ? normalizeStatusValue(st.tags) : def.tags,
    meta: 'meta' in st ? normalizeMetaValue(st.meta) : def.meta,
    from: 'from' in st ? normalizeDateValue(st.from) : def.from,
    to: 'to' in st ? normalizeDateValue(st.to) : def.to,
    page: 'page' in st ? clampInt(st.page, def.page, PAGE_MIN, PAGE_MAX) : def.page,
    cursor:
      'cursor' in st
        ? typeof st.cursor === 'string' && st.cursor.length
          ? st.cursor
          : null
        : def.cursor,
    size: 'size' in st ? clampInt(st.size, def.size, SIZE_MIN, SIZE_MAX) : def.size,
    cols: 'cols' in st ? normalizeColumnsValue(st.cols) : def.cols,
  };
}

/**
 * Public: normalize a raw/partial state object to the canonical, fully-defaulted
 * shape without touching the URL. Useful for consumers that hold state in
 * memory and want the same coercion rules encode/decode apply.
 */
function normalizeTableState(state, defaults) {
  return normalizeState(state, resolveDefaults(defaults));
}

/**
 * Encode a table's state directly to a query string (without a leading '?').
 * Convenience wrapper over encodeTableState for the common single-table case.
 */
function encodeTableStateToQuery(state, ns, defaults) {
  return encodeTableState(state, ns, defaults).toString();
}

// ─── Optional history sync helper (the only window-touching part) ────────────

/**
 * Push or replace the current URL so it reflects `state` for table `ns`,
 * WITHOUT a full page reload. Preserves the path, the hash, and any query
 * params that do not belong to this namespace (so sibling tables keep theirs).
 *
 * @param {object} state
 * @param {string} ns
 * @param {object} [options]
 * @param {object} [options.defaults]  per-table defaults.
 * @param {boolean} [options.replace]  true -> history.replaceState (default),
 *        false -> history.pushState. Use replace for programmatic/derived
 *        changes (initial normalization) and push for user-driven control
 *        changes that should be individually back-navigable.
 * @param {Window} [options.win]       injectable window (for tests / SSR-safety).
 * @returns {string} the new relative URL that was applied (path?search#hash).
 *
 * No-ops safely (returns '') when there is no window/history available.
 */
function applyTableState(state, ns, options) {
  const opts = isPlainObject(options) ? options : {};
  // If the caller explicitly provides `win` (even null/undefined) honour it —
  // this lets consumers/tests force the SSR-safe no-op path. Otherwise fall
  // back to the ambient global window.
  const win =
    'win' in opts ? opts.win : typeof window !== 'undefined' ? window : undefined;
  if (!win || !win.location || !win.history) return '';

  const loc = win.location;
  // Start from the CURRENT search so other namespaces' params survive, then
  // overwrite only this table's keys.
  const params = encodeTableState(state, ns, opts.defaults, toSearchParams(loc.search));

  const qs = params.toString();
  const path = loc.pathname || '';
  const hash = loc.hash || '';
  const relative = path + (qs ? '?' + qs : '') + hash;

  const useReplace = opts.replace === undefined ? true : !!opts.replace;
  try {
    if (useReplace) {
      win.history.replaceState(win.history.state ?? null, '', relative);
    } else {
      win.history.pushState(win.history.state ?? null, '', relative);
    }
  } catch {
    // In sandboxed/SSR contexts history mutation can throw; degrade to no-op.
    return '';
  }
  return relative;
}

/**
 * Read the current table state from the live window URL. Thin wrapper over
 * decodeTableState bound to window.location.search. SSR-safe (returns defaults
 * when no window is present).
 */
function readTableStateFromUrl(ns, defaults, win) {
  const w = win || (typeof window !== 'undefined' ? window : undefined);
  const search = w && w.location ? w.location.search : '';
  return decodeTableState(search, ns, defaults);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

export {
  PARAM_KEYS,
  SORT_DIR,
  BASE_DEFAULTS,
  decodeTableState,
  encodeTableState,
  encodeTableStateToQuery,
  normalizeTableState,
  applyTableState,
  readTableStateFromUrl,
};
