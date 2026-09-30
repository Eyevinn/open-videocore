/**
 * open-videocore ops dashboard — column-chooser.js
 *
 * Issue #959 (broken out of #856): a table-agnostic column visibility chooser
 * for tables built on the shared primitive (public/ops-ui-table.js), plus the
 * two small pieces of state logic that go with it — the validity invariant and
 * the per-operator stored default.
 *
 * Like the primitive, this module is UI-only and CONTRACT-FREE: it makes no
 * network calls and knows nothing about any endpoint, request field or response
 * shape, so the "fetch the contract before writing any call" rule has nothing to
 * ground here — there is no call. Column visibility is presentation state and
 * never reaches a query; that separation is the whole point of the acceptance
 * criterion "sort, filter and pagination continue to operate correctly against a
 * reduced column set".
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHERE THE CHOICE LIVES (two sources, one precedence rule)
 *
 *   1. The URL, via the SHARED table-state contract in public/table-url-state.js
 *      — the `cols` key added for this issue, namespaced per table exactly like
 *      `sort` / `status` / `page`. A URL that carries `cols` wins, always. That
 *      is what makes a configured view shareable by pasting one link, the same
 *      way #368/#373 made sort/filter/paging shareable.
 *   2. Otherwise, a per-operator default in localStorage, written every time the
 *      operator changes the set. This is a personal preference, not a shared
 *      one: it must not leak into a link the operator sends to a colleague, and
 *      it must not override a link a colleague sends to them.
 *
 * Reading in that order (URL, else stored, else the table's own default set) is
 * the behaviour the issue asks for, and it needs no new persistence mechanism.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE INVARIANT
 *
 * A row must stay both identifiable and actionable: the actions column and the
 * identifying columns must never ALL be hidden at once, or the table degenerates
 * into rows an operator can neither recognise nor act on. Callers declare that
 * group as `anchorKeys`; at least one member must remain visible.
 *
 * It is enforced by CONSTRUCTION rather than by validation-after-the-fact: when
 * exactly one anchor column is still visible, its checkbox is disabled and
 * explains why. The operator never reaches an invalid state, so there is no
 * error message to write and nothing to roll back. resolveVisibleColumns()
 * applies the same rule to untrusted input (a hand-edited URL, a stale
 * localStorage value) by falling back to the table's default set.
 *
 * Security: every dynamic value here is written with DOM APIs (textContent,
 * setAttribute), never innerHTML — the same posture as the shared primitive.
 */

// ─── Storage (per-operator default) ──────────────────────────────────────────

// Namespaced per table, so the assets table's choice and a future jobs-table
// choice never collide. Prefix matches the app's existing `ovc_`-prefixed keys
// (`ovc_stack`, `ovc_role` in public/app.js).
export const COLUMN_STORAGE_PREFIX = 'ovc_cols_';

export function columnStorageKey(ns) {
  return COLUMN_STORAGE_PREFIX + String(ns || '');
}

function resolveStorage(storage) {
  if (storage) return storage;
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    // Some privacy modes throw on mere access to the property.
    return null;
  }
}

/**
 * Read the operator's stored column set for a table, as a string[] — or null
 * when there is nothing usable stored.
 *
 * Tolerant by design: storage can be absent (SSR, a worker), disabled (privacy
 * mode throws on read), or hold a stale/garbled value from an older build. None
 * of those is worth breaking a table over, so every failure degrades to null and
 * the caller falls back to its default set.
 */
export function readStoredColumns(ns, storage) {
  const store = resolveStorage(storage);
  if (!store) return null;
  let raw;
  try {
    raw = store.getItem(columnStorageKey(ns));
  } catch {
    return null;
  }
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const keys = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return keys.length ? keys : null;
}

/**
 * Write the operator's column set for a table. Never throws: a full or disabled
 * storage quietly loses the preference (the URL still carries the choice for
 * this session), which is strictly better than failing a click.
 */
export function writeStoredColumns(ns, keys, storage) {
  const store = resolveStorage(storage);
  if (!store) return false;
  try {
    if (!Array.isArray(keys) || !keys.length) {
      store.removeItem(columnStorageKey(ns));
      return true;
    }
    store.setItem(columnStorageKey(ns), keys.join(','));
    return true;
  } catch {
    return false;
  }
}

// ─── Selection logic (pure) ──────────────────────────────────────────────────

/**
 * Coerce an arbitrary selection into the table's own column order, dropping
 * unknown and duplicate keys. Column ORDER is the table's, not the operator's:
 * this chooser controls visibility only, so a reordered or hand-edited URL can
 * never produce a surprising layout.
 *
 * @param {string[]|null|undefined} selection
 * @param {string[]} allKeys  every column key the table defines, in order.
 * @returns {string[]}
 */
export function normalizeColumnSelection(selection, allKeys) {
  if (!Array.isArray(selection) || !Array.isArray(allKeys)) return [];
  const wanted = new Set(selection.filter((k) => typeof k === 'string').map((k) => k.trim()));
  return allKeys.filter((k) => wanted.has(k));
}

/**
 * Does this selection keep at least one anchor column visible?
 * Empty `anchorKeys` means the table declares no invariant.
 */
export function isSelectionValid(selection, anchorKeys) {
  if (!Array.isArray(selection) || !selection.length) return false;
  if (!Array.isArray(anchorKeys) || !anchorKeys.length) return true;
  return anchorKeys.some((k) => selection.includes(k));
}

/**
 * The keys whose checkbox must be LOCKED right now: exactly the case where a
 * single anchor column is all that stands between the current view and an
 * invalid one. With two or more anchors visible nothing is locked, because any
 * one of them can still be hidden safely.
 *
 * @returns {string[]}
 */
export function lockedColumnKeys(selection, anchorKeys) {
  if (!Array.isArray(selection) || !Array.isArray(anchorKeys) || !anchorKeys.length) return [];
  const visibleAnchors = anchorKeys.filter((k) => selection.includes(k));
  return visibleAnchors.length === 1 ? visibleAnchors : [];
}

/**
 * Resolve the column set a table should render, applying the precedence rule:
 * URL (when the param is present), else the operator's stored default, else the
 * table's own default set. Any candidate that normalizes to nothing, or that
 * breaks the anchor invariant, is rejected in favour of the next source — a
 * hand-edited `cols=nonsense` degrades to a working table, never to a blank one.
 *
 * @param {object} args
 * @param {string[]|null} [args.urlCols]     decoded `cols` (null when absent).
 * @param {string[]|null} [args.storedCols]  the operator's stored default.
 * @param {string[]} args.allKeys            every column key, in table order.
 * @param {string[]} [args.defaultKeys]      the table's default visible set.
 * @param {string[]} [args.anchorKeys]       the invariant group.
 * @returns {string[]}
 */
export function resolveVisibleColumns(args) {
  const a = args || {};
  const allKeys = Array.isArray(a.allKeys) ? a.allKeys : [];
  const defaultKeys = normalizeColumnSelection(
    Array.isArray(a.defaultKeys) && a.defaultKeys.length ? a.defaultKeys : allKeys,
    allKeys
  );
  const anchorKeys = Array.isArray(a.anchorKeys) ? a.anchorKeys : [];

  for (const candidate of [a.urlCols, a.storedCols]) {
    if (!Array.isArray(candidate)) continue;
    const normalized = normalizeColumnSelection(candidate, allKeys);
    if (normalized.length && isSelectionValid(normalized, anchorKeys)) return normalized;
  }
  return defaultKeys;
}

// ─── Chooser control (DOM) ───────────────────────────────────────────────────

/**
 * Build the chooser control.
 *
 * A native <details>/<summary> disclosure holding one checkbox per column: it
 * needs no popup library, no focus trap and no ARIA of its own beyond the
 * grouping, it is keyboard-operable out of the box, and it collapses to a
 * single unobtrusive "Columns" affordance when closed. Checkboxes (not a
 * multi-select) because the state being edited is a set of independent on/off
 * choices, and because a locked one can carry its own explanation.
 *
 * @param {object} config
 * @param {Array}  config.columns    the table's FULL column list
 *                                   ({ key, label, chooserLabel? }), in order.
 * @param {string[]} config.visible  currently visible keys.
 * @param {string[]} [config.anchorKeys]
 * @param {string}  [config.label]   summary text (default 'Columns').
 * @param {string}  [config.lockedHint] title/explanation on a locked checkbox.
 * @param {(keys: string[]) => void} config.onChange
 * @returns {{ el: HTMLElement, setVisible(keys: string[]): void, getVisible(): string[] }}
 */
export function createColumnChooser(config) {
  const cfg = config || {};
  const columns = Array.isArray(cfg.columns) ? cfg.columns : [];
  const allKeys = columns.map((c) => c.key);
  const anchorKeys = Array.isArray(cfg.anchorKeys) ? cfg.anchorKeys : [];
  const lockedHint =
    cfg.lockedHint ||
    'Keep at least one of these columns visible so every row stays identifiable and actionable.';
  let visible = normalizeColumnSelection(cfg.visible, allKeys);

  const el = document.createElement('details');
  el.className = 'ops-column-chooser';

  const summary = document.createElement('summary');
  summary.className = 'ops-column-chooser-summary';
  summary.textContent = cfg.label || 'Columns';
  el.appendChild(summary);

  const panel = document.createElement('div');
  panel.className = 'ops-column-chooser-panel';
  panel.setAttribute('role', 'group');
  panel.setAttribute('aria-label', cfg.label || 'Columns');
  el.appendChild(panel);

  const count = document.createElement('span');
  count.className = 'ops-column-chooser-count';
  summary.appendChild(count);

  // One checkbox per column, built once; only `checked`/`disabled` change later.
  const inputs = new Map();
  columns.forEach(function (col) {
    const row = document.createElement('label');
    row.className = 'ops-column-chooser-item';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = col.key;
    input.dataset.columnKey = col.key;
    const text = document.createElement('span');
    // `chooserLabel` exists for columns whose header is intentionally blank
    // (e.g. the thumbnail column) — a nameless checkbox is unusable.
    text.textContent = String(col.chooserLabel || col.label || col.key);
    row.appendChild(input);
    row.appendChild(text);
    panel.appendChild(row);
    inputs.set(col.key, { input, row });

    input.addEventListener('change', function () {
      const next = allKeys.filter(function (k) {
        const entry = inputs.get(k);
        return k === col.key ? input.checked : entry.input.checked;
      });
      // Belt and braces: the locked checkbox is already disabled, so this can
      // only fire for a safe change — but never emit an invalid set.
      if (!isSelectionValid(next, anchorKeys)) {
        sync();
        return;
      }
      visible = next;
      sync();
      if (typeof cfg.onChange === 'function') cfg.onChange(visible.slice());
    });
  });

  // Reflect `visible` into the checkboxes and re-apply the lock.
  function sync() {
    const locked = lockedColumnKeys(visible, anchorKeys);
    inputs.forEach(function (entry, key) {
      const isVisible = visible.includes(key);
      const isLocked = locked.includes(key);
      entry.input.checked = isVisible;
      entry.input.disabled = isLocked;
      entry.row.classList.toggle('is-locked', isLocked);
      if (isLocked) {
        entry.row.title = lockedHint;
        entry.input.setAttribute('aria-describedby', 'ops-column-chooser-hint');
      } else {
        entry.row.removeAttribute('title');
        entry.input.removeAttribute('aria-describedby');
      }
    });
    count.textContent = ' ' + visible.length + '/' + allKeys.length;
  }

  const hint = document.createElement('p');
  hint.className = 'ops-column-chooser-hint';
  hint.id = 'ops-column-chooser-hint';
  hint.textContent = lockedHint;
  panel.appendChild(hint);

  sync();

  return {
    el,
    setVisible: function (keys) {
      const next = normalizeColumnSelection(keys, allKeys);
      if (!isSelectionValid(next, anchorKeys)) return;
      visible = next;
      sync();
    },
    getVisible: function () {
      return visible.slice();
    },
  };
}
