/**
 * open-videocore ops dashboard — key-value-rows.js
 *
 * The repeatable key/value row group first built for the Search tab's metadata
 * filter (issue #850, `renderSearchMetadataFilter` in public/app.js), lifted
 * into one reusable builder so the second surface that needs free-form pairs —
 * the collection `custom` editor (issue #862) — uses the SAME interaction rather
 * than a look-alike:
 *
 *   - a real <fieldset>/<legend>, so the pairs are announced as one control
 *     instead of a loose run of text boxes;
 *   - a hint wired with `aria-describedby`;
 *   - one row per pair, each input with a real <label for>, plus a
 *     visually-hidden ordinal so repeated short labels stay unique;
 *   - a per-row "Remove" with its own `aria-label`;
 *   - an "Add" control, and a visually-hidden `aria-live="polite"` status so the
 *     add/remove (a purely visual change) is announced;
 *   - the group is never left empty: removing the last row brings back a blank
 *     one, so the field stays discoverable.
 *
 * UI ONLY. No route, schema or response shape is involved — the caller decides
 * what the pairs mean and what goes on the wire.
 */

let rowSeq = 0;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Build one two-input row (or one-input, when `valueLabel` is absent — the tag
 * list case). PURE apart from the Remove listener it owns.
 *
 * @param {object} cfg
 * @param {string} cfg.prefix        id/class prefix, e.g. 'coll-custom'
 * @param {string} cfg.keyLabel
 * @param {string} [cfg.valueLabel]  omit for a single-field row
 * @param {string} [cfg.keyPlaceholder]
 * @param {string} [cfg.valuePlaceholder]
 * @param {string} cfg.itemNoun      e.g. 'custom field' — used in the a11y text
 * @param {string} cfg.removeLabel
 * @param {Function} [cfg.onRemove]  called with the row after it is detached
 * @returns {{row: HTMLElement, keyInput: HTMLInputElement, valueInput: HTMLInputElement|null, removeBtn: HTMLElement}}
 */
export function keyValueRow(cfg) {
  const c = cfg || {};
  const n = ++rowSeq;
  const row = el('div', 'form-row ' + c.prefix + '-row');

  function field(suffix, labelText, placeholder) {
    const id = c.prefix + '-' + suffix + '-' + n;
    const wrap = el('div', 'form-field grow');
    const label = el('label', null, labelText);
    label.setAttribute('for', id);
    const ordinal = el('span', 'visually-hidden', ' (' + c.itemNoun + ' ' + n + ')');
    label.appendChild(ordinal);
    const input = document.createElement('input');
    input.type = 'text';
    input.id = id;
    input.className = c.prefix + '-' + suffix;
    if (placeholder) input.placeholder = placeholder;
    wrap.appendChild(label);
    wrap.appendChild(input);
    return { wrap: wrap, input: input };
  }

  const keyField = field('key', c.keyLabel, c.keyPlaceholder);
  row.appendChild(keyField.wrap);

  let valueField = null;
  if (c.valueLabel) {
    valueField = field('value', c.valueLabel, c.valuePlaceholder);
    row.appendChild(valueField.wrap);
  }

  const removeWrap = el('div', 'form-field ' + c.prefix + '-remove-field');
  const remove = el('button', 'btn-sm ' + c.prefix + '-remove', c.removeLabel);
  remove.type = 'button';
  // "Remove" alone is ambiguous once there are three of them.
  remove.setAttribute('aria-label', 'Remove ' + c.itemNoun + ' ' + n);
  remove.addEventListener('click', function () {
    row.remove();
    if (typeof c.onRemove === 'function') c.onRemove(row);
  });
  removeWrap.appendChild(remove);
  row.appendChild(removeWrap);

  return { row: row, keyInput: keyField.input, valueInput: valueField ? valueField.input : null, removeBtn: remove };
}

/**
 * Build the whole group and append it to `host`.
 *
 * @param {HTMLElement} host
 * @param {object} cfg  as keyValueRow, plus:
 * @param {string} cfg.legend
 * @param {string} [cfg.hint]
 * @param {string} cfg.addLabel
 * @param {Array<{key?: string, value?: string}>} [cfg.initial]  rows to prefill
 * @returns {{fieldset: HTMLElement, rowsHost: HTMLElement, addBtn: HTMLElement, addRow: Function, read: () => Array<{key: string, value: string}>}}
 */
export function renderKeyValueRows(host, cfg) {
  const c = cfg || {};
  const fieldset = document.createElement('fieldset');
  fieldset.className = c.prefix + '-fieldset';
  fieldset.id = c.prefix;

  const legend = el('legend', c.prefix + '-legend', c.legend);
  fieldset.appendChild(legend);

  if (c.hint) {
    const hint = el('div', 'form-hint', c.hint);
    hint.id = c.prefix + '-hint';
    fieldset.appendChild(hint);
    fieldset.setAttribute('aria-describedby', hint.id);
  }

  const rowsHost = el('div', c.prefix + '-rows');
  rowsHost.id = c.prefix + '-rows';
  fieldset.appendChild(rowsHost);

  const status = el('div', 'visually-hidden');
  status.id = c.prefix + '-status';
  status.setAttribute('aria-live', 'polite');

  const addBtn = el('button', 'btn-sm ' + c.prefix + '-add', c.addLabel);
  addBtn.type = 'button';
  addBtn.id = c.prefix + '-add';

  function announce(text) {
    status.textContent = text + ' ' + rowsHost.children.length + ' ' + c.itemNoun + 's.';
  }

  function addRow(options) {
    const o = options || {};
    const built = keyValueRow({
      prefix: c.prefix,
      keyLabel: c.keyLabel,
      valueLabel: c.valueLabel,
      keyPlaceholder: c.keyPlaceholder,
      valuePlaceholder: c.valuePlaceholder,
      itemNoun: c.itemNoun,
      removeLabel: c.removeLabel,
      onRemove: function () {
        // Never leave the group empty: a removed last row comes back blank, so
        // the field stays discoverable and a blank row carries nothing.
        if (rowsHost.children.length === 0) {
          addRow({ focus: true, announce: false });
          announce('Cleared.');
          return;
        }
        const next = rowsHost.querySelector('.' + c.prefix + '-key');
        if (next && next.focus) next.focus();
        announce('Removed.');
      },
    });
    if (o.key != null) built.keyInput.value = String(o.key);
    if (built.valueInput && o.value != null) built.valueInput.value = String(o.value);
    // Carried on the element so a caller can tell an untouched prefilled row
    // from one that was retyped (the collection `custom` type-preservation rule).
    built.row.dataset.originalKey = o.key != null ? String(o.key) : '';
    built.row.dataset.originalValue = o.value != null ? String(o.value) : '';
    rowsHost.appendChild(built.row);
    if (o.focus && built.keyInput.focus) built.keyInput.focus();
    if (o.announce !== false) announce('Added.');
    return built;
  }

  addBtn.addEventListener('click', function () { addRow({ focus: true }); });

  (c.initial || []).forEach(function (pair) {
    addRow({ key: pair.key, value: pair.value, announce: false });
  });
  // One empty row up front, so the control is visible without a click.
  if (rowsHost.children.length === 0) addRow({ announce: false });

  fieldset.appendChild(addBtn);
  fieldset.appendChild(status);
  host.appendChild(fieldset);

  function read() {
    return [].map.call(rowsHost.querySelectorAll('.' + c.prefix + '-row'), function (row) {
      const keyInput = row.querySelector('.' + c.prefix + '-key');
      const valueInput = row.querySelector('.' + c.prefix + '-value');
      return {
        key: keyInput ? keyInput.value : '',
        value: valueInput ? valueInput.value : '',
        originalKey: row.dataset.originalKey || '',
        originalValue: row.dataset.originalValue || '',
      };
    });
  }

  return { fieldset: fieldset, rowsHost: rowsHost, addBtn: addBtn, addRow: addRow, read: read, status: status };
}
