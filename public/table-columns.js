/**
 * open-videocore ops dashboard — table-columns.js
 *
 * Column visibility for ops-UI tables (issues #959/#960, broken out of #856): the
 * model, the per-operator persistence, the load-time precedence rule, and the
 * chooser control. Table-agnostic from the start, and shared by the assets, jobs
 * and logs tables since #960 — every table-specific decision (the column set, the
 * "cannot hide" rules, the namespace) is an input, never a constant in here.
 *
 * WHAT THIS IS
 *   One table-agnostic answer to "which of this table's declared columns are
 *   rendered right now?", in three separable pieces:
 *     1. a MODEL that turns a requested key set into a legal visible set, and
 *        says which toggles must be locked to keep it legal;
 *     2. PERSISTENCE of a per-operator default in localStorage;
 *     3. a CHOOSER control (plain DOM) that an operator drives.
 *
 * WHAT THIS IS NOT
 *   - It makes NO network calls and knows NOTHING about any endpoint, request
 *     param, or response shape. Column visibility is VIEW state: it decides what
 *     is painted, never what is requested. (Per the "fetch the contract before
 *     writing any call" rule there is no call here to ground — the shared URL
 *     contract this pairs with is public/table-url-state.js, whose `cols` param
 *     is documented in that file's PARAM SCHEMA block.)
 *   - It does not own the table. public/ops-ui-table.js mounts the chooser and
 *     applies the visible set to its header/body; this module has no dependency
 *     on the primitive and is unit-testable on its own.
 *
 * PERSISTENCE MODEL (the issue's explicit requirement)
 *   Precedence on load is URL -> stored default -> the table's declared set:
 *     - a `cols` param in the URL wins, so a shared link reproduces the sender's
 *       view exactly (same rule the rest of the table's state already follows);
 *     - with no param, the operator's own stored default applies, so their
 *       preferred shape survives a fresh visit to a bare URL;
 *     - with neither, every declared column is shown.
 *   A toggle writes BOTH: the stored default (so it persists) and the URL (so the
 *   view stays shareable). Storage is best-effort — private-mode and quota errors
 *   are swallowed, because losing a column preference must never break the table.
 *
 *   RESET (issue #962) is the exact inverse, and has to clear BOTH writes: a reset
 *   that forgot only the stored default would be undone by the `cols` still in the
 *   address bar, and one that forgot only the URL would come back on the next bare
 *   visit. Because only the consumer knows its namespace and its URL contract, the
 *   chooser does not clear either itself — it offers the ACTION (`onReset`) and the
 *   consumer performs both clears, with clearStoredColumns() for the stored half.
 *
 * THE LEGALITY RULE
 *   A table that renders nothing identifiable and offers no actions is not a
 *   view, it is a dead end you cannot navigate out of. So a consumer declares
 *   `requireAtLeastOne` groups — each group must keep at least one visible
 *   member — and the chooser DISABLES the last surviving member of a group
 *   rather than letting the operator reach an illegal state and then scolding
 *   them for it. normalizeVisibleColumns() additionally REPAIRS an illegal set
 *   (hand-edited URL, stale stored value, renamed column) instead of throwing.
 *
 * SECURITY: mirrors the primitive's XSS posture. Every dynamic value is written
 * via textContent / DOM APIs — this module inserts no strings into innerHTML.
 */

// ─── Persistence ─────────────────────────────────────────────────────────────

// One key per table namespace, reusing the app's `ovc`-prefixed localStorage
// convention (cf. `ovc_stack` / `ovc_role` / `ovc-active-tab` in public/app.js).
// The namespace is the SAME one the table passes to table-url-state.js, so a
// table's URL params and its stored preference cannot drift onto different names.
export const COLUMN_PREF_PREFIX = 'ovc-table-columns.';

export function columnPrefKey(ns) {
  return COLUMN_PREF_PREFIX + (ns || 'table');
}

function storageOf(win) {
  const w = win || (typeof window !== 'undefined' ? window : undefined);
  if (!w) return null;
  try {
    // Touching localStorage itself can throw when storage is blocked by policy.
    return w.localStorage || null;
  } catch {
    return null;
  }
}

/**
 * Read a stored visible-column set for `ns`. Returns string[] or null when
 * absent/unusable. Never throws: an unreadable or corrupt preference is simply
 * "no preference".
 *
 * Accepts either a JSON array (what writeStoredColumns emits) or a bare
 * comma-separated string, so a value hand-set to the same shape the URL uses
 * still works.
 */
export function readStoredColumns(ns, win) {
  const store = storageOf(win);
  if (!store) return null;
  let raw;
  try {
    raw = store.getItem(columnPrefKey(ns));
  } catch {
    return null;
  }
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const s = raw.trim();
  if (s.startsWith('[')) {
    try {
      const parsed = JSON.parse(s);
      return cleanKeyList(parsed);
    } catch {
      return null;
    }
  }
  return cleanKeyList(s.split(','));
}

/**
 * Persist the operator's chosen set as this browser's default for `ns`.
 * Returns true when it was stored. Best-effort by design.
 */
export function writeStoredColumns(ns, keys, win) {
  const store = storageOf(win);
  if (!store) return false;
  const clean = cleanKeyList(keys);
  try {
    if (!clean) {
      store.removeItem(columnPrefKey(ns));
      return true;
    }
    store.setItem(columnPrefKey(ns), JSON.stringify(clean));
    return true;
  } catch {
    return false;
  }
}

/** Forget this browser's default for `ns` (back to the table's declared set). */
export function clearStoredColumns(ns, win) {
  const store = storageOf(win);
  if (!store) return false;
  try {
    store.removeItem(columnPrefKey(ns));
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide a table's INITIAL visible set, and whether that set is an EXPLICIT
 * operator choice. This is the persistence precedence rule stated once, for every
 * table (issue #960): it was written per-table for the assets table in #959, and
 * jobs/logs must not each re-derive it or they will drift.
 *
 * Precedence, highest first:
 *   1. the `cols` param already decoded from the URL — a shared link must
 *      reproduce the sender's view, the same rule sort/filter/page follow. It
 *      beats storage so that opening a colleague's link does not silently apply
 *      your own preference.
 *   2. this browser's stored default for `ns` — an operator who shaped the table
 *      once should not have to reshape it on every bare visit.
 *   3. every declared column.
 *
 * `explicit` is what decides whether the set is mirrored back into the URL: cases
 * 1 and 2 are real choices worth encoding, case 3 is the absence of one and stays
 * out of the query string so a default view still has a clean URL.
 *
 * Every candidate goes through normalizeVisibleColumns(), so a hand-edited param,
 * a set stored before a column was renamed, or one that would empty a required
 * group is REPAIRED rather than honoured or rejected.
 *
 * @param {object} options
 * @param {string[]|null} [options.urlCols]  decoded `<ns>.cols` (null = absent).
 * @param {string} options.ns                storage/URL namespace for this table.
 * @param {Array} options.columns            the table's declared columns.
 * @param {string[][]} [options.requireAtLeastOne]
 * @param {Window} [options.win]             injectable window (tests).
 * @param {string[]|null} [options.stored]   pre-read stored set; when `undefined`
 *        it is read from storage for `ns`. Lets a caller/test supply one directly,
 *        or pass `null` to opt out of storage entirely.
 * @returns {{keys:string[], explicit:boolean, source:'url'|'stored'|'default'}}
 */
export function resolveInitialColumns(options) {
  const o = options || {};
  const columns = Array.isArray(o.columns) ? o.columns : [];
  const opts = { requireAtLeastOne: o.requireAtLeastOne };

  const urlCols = cleanKeyList(o.urlCols);
  if (urlCols) {
    return { keys: normalizeVisibleColumns(urlCols, columns, opts), explicit: true, source: 'url' };
  }

  // `undefined` (including the key simply being absent) means "read storage";
  // anything else — a list, or an explicit null — is taken at face value.
  const stored = o.stored !== undefined ? cleanKeyList(o.stored) : readStoredColumns(o.ns, o.win);
  if (stored && stored.length) {
    return {
      keys: normalizeVisibleColumns(stored, columns, opts),
      explicit: true,
      source: 'stored',
    };
  }

  return {
    keys: normalizeVisibleColumns(null, columns, opts),
    explicit: false,
    source: 'default',
  };
}

// De-dupe / trim an arbitrary key list. Returns null for "nothing usable" so the
// empty list can never be mistaken for a deliberate "show no columns".
function cleanKeyList(v) {
  if (!Array.isArray(v)) return null;
  const out = [];
  const seen = new Set();
  for (const k of v) {
    if (typeof k !== 'string') continue;
    const t = k.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out.length ? out : null;
}

// ─── Model ───────────────────────────────────────────────────────────────────

function declaredKeys(columns) {
  return (Array.isArray(columns) ? columns : [])
    .map((c) => c && c.key)
    .filter((k) => typeof k === 'string' && k.length > 0);
}

/** A column is hideable unless it opts out with `hideable: false`. */
export function isHideable(col) {
  return !(col && col.hideable === false);
}

function groupsOf(options) {
  const raw = options && options.requireAtLeastOne;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((g) => Array.isArray(g))
    .map((g) => g.filter((k) => typeof k === 'string' && k.length > 0))
    .filter((g) => g.length > 0);
}

/**
 * Turn a REQUESTED key set into a LEGAL visible set.
 *
 * @param {string[]|null} requested  keys the URL / storage / operator asked for;
 *        null or unusable means "no request" -> every declared column.
 * @param {Array<{key:string,hideable?:boolean}>} columns  declared columns.
 * @param {{requireAtLeastOne?:string[][]}} [options]
 * @returns {string[]} keys in DECLARED order (the order the table paints in).
 *
 * Repairs rather than rejects:
 *   - keys the table does not declare are dropped (a stale stored preference
 *     from before a column was renamed must not resurrect a phantom column);
 *   - `hideable: false` columns are always re-added;
 *   - a group with no surviving member gets its first declared member back;
 *   - an empty outcome falls all the way back to every declared column, so no
 *     input can produce a headerless table.
 */
export function normalizeVisibleColumns(requested, columns, options) {
  const declared = declaredKeys(columns);
  if (!declared.length) return [];
  const all = () => declared.slice();

  const asked = cleanKeyList(requested);
  if (!asked) return all();

  const askedSet = new Set(asked);
  const byKey = new Map((Array.isArray(columns) ? columns : []).map((c) => [c && c.key, c]));

  // Declared order, not requested order: the table paints in the order it
  // declared, and honouring a URL's ordering here would silently reorder a
  // shared view in a way the chooser has no control to express.
  const visible = declared.filter(
    (k) => askedSet.has(k) || !isHideable(byKey.get(k))
  );
  const visibleSet = new Set(visible);

  // Repair any group the request would have emptied.
  for (const group of groupsOf(options)) {
    const present = group.filter((k) => visibleSet.has(k));
    if (present.length) continue;
    const fallback = declared.find((k) => group.includes(k));
    if (fallback) visibleSet.add(fallback);
  }

  const out = declared.filter((k) => visibleSet.has(k));
  return out.length ? out : all();
}

/**
 * The keys whose toggle must be DISABLED in the chooser, because hiding them
 * would produce an illegal set. Two reasons, and the chooser explains both:
 *   - the column opted out of hiding (`hideable: false`);
 *   - it is the last visible member of a `requireAtLeastOne` group.
 */
export function lockedColumnKeys(visible, columns, options) {
  const visibleSet = new Set(cleanKeyList(visible) || []);
  const locked = new Set();
  for (const col of Array.isArray(columns) ? columns : []) {
    if (col && typeof col.key === 'string' && !isHideable(col)) locked.add(col.key);
  }
  for (const group of groupsOf(options)) {
    const present = group.filter((k) => visibleSet.has(k));
    if (present.length === 1) locked.add(present[0]);
  }
  return locked;
}

/** The label the chooser shows for a column. Header labels can be empty (a
 *  thumbnail column has no caption), so a column may name itself for the list
 *  via `chooserLabel`; the key is the last resort so no entry is ever blank. */
export function columnChooserLabel(col) {
  if (!col) return '';
  if (typeof col.chooserLabel === 'string' && col.chooserLabel.trim()) {
    return col.chooserLabel.trim();
  }
  if (col.label != null && String(col.label).trim()) return String(col.label).trim();
  return String(col.key || '');
}

// ─── Chooser control ─────────────────────────────────────────────────────────

// Per-page id counter so two tables on one route never share element ids.
let chooserUid = 0;

/**
 * Build the column chooser: a disclosure button plus a checkbox list.
 *
 * @param {object} options
 * @param {Array} options.columns              the table's declared columns.
 * @param {() => string[]} options.getVisible  current visible keys.
 * @param {(keys: string[]) => void} options.onChange  called with the new LEGAL
 *        set after an operator toggle. The consumer applies + persists it.
 * @param {string[][]} [options.requireAtLeastOne]
 * @param {() => (string|null)} [options.getActiveSortKey]  lets the list flag a
 *        column that is hidden while the table is still sorted by it.
 * @param {(keys: string[]) => void} [options.onReset]  called with the table's
 *        DECLARED default set when the operator resets (issue #962). The consumer
 *        both applies it and CLEARS every place it remembered a choice — its
 *        stored default (clearStoredColumns) and its URL state. Defaults to
 *        `onChange`, which restores the right view but leaves the remembered
 *        choice in place, so a consumer that persists anything should wire this.
 * @param {() => boolean} [options.getIsCustomized]  whether there is anything to
 *        reset (a stored default or a column param in the URL). Only the consumer
 *        can answer that, so when it is omitted the reset action stays enabled.
 * @param {string} [options.label]  button caption (default 'Columns').
 * @param {Document} [options.doc]  injectable document (tests / detached panes).
 * @returns {{el:HTMLElement, refresh:function, reset:function, close:function,
 *            destroy:function, isOpen:function}}
 *
 * A non-modal popover, deliberately: choosing columns is a light, repeated
 * adjustment made WHILE reading the table, and a modal would hide the very rows
 * the operator is adjusting for.
 */
export function createColumnChooser(options) {
  const opts = options || {};
  const doc = opts.doc || (typeof document !== 'undefined' ? document : null);
  if (!doc) throw new Error('createColumnChooser requires a document');

  const columns = Array.isArray(opts.columns) ? opts.columns : [];
  const getVisible = typeof opts.getVisible === 'function' ? opts.getVisible : () => [];
  const onChange = typeof opts.onChange === 'function' ? opts.onChange : () => {};
  const getActiveSortKey =
    typeof opts.getActiveSortKey === 'function' ? opts.getActiveSortKey : () => null;
  const onReset = typeof opts.onReset === 'function' ? opts.onReset : onChange;
  const getIsCustomized =
    typeof opts.getIsCustomized === 'function' ? opts.getIsCustomized : () => true;
  const groups = groupsOf(opts);

  const uid = ++chooserUid;
  const panelId = 'ops-columns-panel-' + uid;
  const hintId = 'ops-columns-hint-' + uid;

  const el = doc.createElement('div');
  el.className = 'ops-columns';

  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'ops-columns-btn btn-ghost';
  btn.setAttribute('aria-expanded', 'false');
  btn.setAttribute('aria-controls', panelId);
  const btnLabel = doc.createElement('span');
  btnLabel.textContent = typeof opts.label === 'string' && opts.label ? opts.label : 'Columns';
  // The count rides INSIDE the button so "how many columns am I hiding?" is
  // answerable without opening the panel, and is part of the accessible name.
  const btnCount = doc.createElement('span');
  btnCount.className = 'ops-columns-count';
  btn.appendChild(btnLabel);
  btn.appendChild(btnCount);
  el.appendChild(btn);

  const panel = doc.createElement('div');
  panel.id = panelId;
  panel.className = 'ops-columns-panel';
  panel.hidden = true;
  // A group, not a dialog: focus is not trapped and the table stays readable.
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', 'Visible columns');

  const list = doc.createElement('div');
  list.className = 'ops-columns-list';
  panel.appendChild(list);

  // The legality rule, stated once, up front — not as an error after the fact.
  const hint = doc.createElement('p');
  hint.className = 'ops-columns-hint';
  hint.id = hintId;
  hint.textContent = lockHintText(columns, groups);
  if (!hint.textContent) hint.hidden = true;
  panel.appendChild(hint);

  // Two actions, deliberately side by side in the SAME panel the toggles live in
  // (issue #962): the control that let an operator customize the table is the only
  // place they will look to undo it, and a reset parked anywhere else is a reset
  // nobody finds. They are NOT redundant even for a table whose declared default
  // happens to be "every column", so each says what it writes, not just what it
  // shows: "Show all" is a choice (remembered like any other toggle), "Reset to
  // defaults" is the withdrawal of one.
  const actions = doc.createElement('div');
  actions.className = 'ops-columns-actions';
  const showAll = doc.createElement('button');
  showAll.type = 'button';
  showAll.className = 'ops-columns-showall btn-ghost';
  showAll.textContent = 'Show all';
  showAll.title = 'Show every column, and remember that as your preference.';
  actions.appendChild(showAll);
  const resetBtn = doc.createElement('button');
  resetBtn.type = 'button';
  resetBtn.className = 'ops-columns-reset btn-ghost';
  resetBtn.textContent = 'Reset to defaults';
  resetBtn.title =
    'Forget your saved column preference and this link’s columns, and go back to the default columns.';
  actions.appendChild(resetBtn);
  panel.appendChild(actions);

  el.appendChild(panel);

  showAll.addEventListener('click', function () {
    commit(declaredKeys(columns));
  });

  resetBtn.addEventListener('click', function () {
    reset();
  });

  // The ONE path a toggle takes. It normalizes first, so `onChange` only ever
  // sees a legal set, then re-reads the model via refresh(). The re-read is
  // deliberate rather than redundant: the model is the source of truth for the
  // checkboxes, so if a consumer declines to apply a change the control snaps
  // back to what is actually rendered instead of lying about it.
  function commit(requestedKeys) {
    const next = normalizeVisibleColumns(requestedKeys, columns, { requireAtLeastOne: groups });
    onChange(next);
    refresh();
  }

  /**
   * Reset to the table's DECLARED default set (issue #962).
   *
   * Routed through `onReset` rather than `commit` on purpose: committing would
   * persist the default set as a fresh preference, which is the opposite of what
   * reset means. The default set is derived the same way a first load derives it —
   * normalizeVisibleColumns() with no request — so there is one definition of
   * "default", not a second copy that can drift from the declared columns.
   */
  function reset() {
    const defaults = normalizeVisibleColumns(null, columns, { requireAtLeastOne: groups });
    onReset(defaults);
    refresh();
    return defaults;
  }

  /** Rebuild the checkbox list from the current visible set. */
  function refresh() {
    const visible = normalizeVisibleColumns(getVisible(), columns, {
      requireAtLeastOne: groups,
    });
    const visibleSet = new Set(visible);
    const locked = lockedColumnKeys(visible, columns, { requireAtLeastOne: groups });
    const activeSort = getActiveSortKey();
    const declared = declaredKeys(columns);

    btnCount.textContent = ' ' + visible.length + ' of ' + declared.length;
    showAll.disabled = visible.length === declared.length;
    // Reset is NOT disabled just because the view already looks default: the
    // state it clears is invisible (a stored default, a `cols` still in the URL)
    // and can describe the default set exactly. Only the consumer can say whether
    // any of it is there, which is what getIsCustomized() answers.
    resetBtn.disabled = !getIsCustomized();

    list.innerHTML = '';
    for (const col of columns) {
      if (!col || typeof col.key !== 'string' || !col.key) continue;
      const item = doc.createElement('label');
      item.className = 'ops-columns-item';
      item.dataset.column = col.key;

      const cb = doc.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'ops-columns-toggle';
      cb.value = col.key;
      cb.checked = visibleSet.has(col.key);
      if (locked.has(col.key)) {
        cb.disabled = true;
        item.classList.add('is-locked');
        // The checkbox, not just the row, points at the explanation: a screen
        // reader announcing a disabled control is exactly when the reason is
        // wanted.
        if (hint.textContent) cb.setAttribute('aria-describedby', hintId);
        item.title = lockReasonFor(col, groups);
      }
      cb.addEventListener('change', function () {
        const next = new Set(visibleSet);
        if (cb.checked) next.add(col.key);
        else next.delete(col.key);
        commit(Array.from(next));
      });

      const text = doc.createElement('span');
      text.className = 'ops-columns-item-label';
      text.textContent = columnChooserLabel(col);

      item.appendChild(cb);
      item.appendChild(text);

      // A column can be hidden while the table is still sorted by it — sort is
      // deliberately NOT coupled to visibility (the query must not change when
      // you hide a column). Flag it here so an active sort is never invisible
      // AND unreachable: this list is where the operator can bring it back.
      const sortKey = col.sortKey || col.key;
      if (activeSort && sortKey === activeSort && !visibleSet.has(col.key)) {
        const note = doc.createElement('span');
        note.className = 'ops-columns-note';
        note.textContent = 'sorted';
        note.title = 'Hidden, but the table is still sorted by this column.';
        item.appendChild(note);
      }

      list.appendChild(item);
    }
  }

  function isOpen() {
    return !panel.hidden;
  }

  function open() {
    if (isOpen()) return;
    refresh();
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
  }

  function close(focusButton) {
    if (!isOpen()) return;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (focusButton && typeof btn.focus === 'function') btn.focus();
  }

  btn.addEventListener('click', function (ev) {
    ev.stopPropagation();
    if (isOpen()) close(false);
    else open();
  });

  // Clicks inside the panel must not reach the outside-click closer below.
  panel.addEventListener('click', function (ev) {
    ev.stopPropagation();
  });

  function onDocClick(ev) {
    if (!isOpen()) return;
    const t = ev && ev.target;
    if (t && typeof el.contains === 'function' && el.contains(t)) return;
    close(false);
  }

  function onKeyDown(ev) {
    if (!isOpen() || !ev || ev.key !== 'Escape') return;
    // Escape returns focus to the button it came from, so keyboard use does not
    // dump the caret at the top of the document.
    close(true);
  }

  doc.addEventListener('click', onDocClick);
  el.addEventListener('keydown', onKeyDown);

  function destroy() {
    doc.removeEventListener('click', onDocClick);
    el.removeEventListener('keydown', onKeyDown);
    if (el.parentNode) el.parentNode.removeChild(el);
  }

  refresh();

  return { el, refresh, reset, open, close, isOpen, destroy, _button: btn, _panel: panel };
}

/** Human sentence for the panel hint, naming the columns that are protected. */
function lockHintText(columns, groups) {
  const byKey = new Map((Array.isArray(columns) ? columns : []).map((c) => [c && c.key, c]));
  const sentences = [];
  for (const group of groups) {
    const names = group
      .filter((k) => byKey.has(k))
      .map((k) => columnChooserLabel(byKey.get(k)))
      .filter(Boolean);
    if (names.length < 2) continue;
    sentences.push('Keep at least one of ' + joinList(names) + ' visible.');
  }
  const pinned = (Array.isArray(columns) ? columns : [])
    .filter((c) => c && c.key && !isHideable(c))
    .map((c) => columnChooserLabel(c));
  if (pinned.length) {
    sentences.push(joinList(pinned) + ' cannot be hidden.');
  }
  return sentences.join(' ');
}

function lockReasonFor(col, groups) {
  if (!isHideable(col)) return 'This column cannot be hidden.';
  const inGroup = groups.some((g) => g.includes(col.key));
  if (inGroup) return 'The last one of these columns has to stay visible.';
  return '';
}

function joinList(items) {
  if (items.length <= 1) return items.join('');
  if (items.length === 2) return items[0] + ' or ' + items[1];
  return items.slice(0, -1).join(', ') + ' or ' + items[items.length - 1];
}
