/**
 * open-videocore ops dashboard — detail-sections.js
 *
 * Small, reusable building blocks shared by the detail views (job detail today,
 * pipeline-execution detail next — issue #964): a collapsed "Raw" disclosure for
 * the full server record, and a copyable field value for an identifier an
 * operator needs to paste somewhere else.
 *
 * WHY THESE LIVE HERE (issue #963)
 * The job detail panel used to end with `pre.textContent = JSON.stringify(job)`
 * — the whole record, always expanded, as the only place several fields were
 * visible at all. Curating the panel means the raw record stops being the
 * primary surface, but it must not disappear: it is the only view that is
 * guaranteed complete when the API grows a field this UI does not render yet.
 * So it stays, behind a disclosure, collapsed by default.
 *
 * Both primitives are deliberately data-free: they take a value and return a
 * detached element or an escaped HTML string, so a caller can compose them into
 * any panel and a unit test can exercise them without a network call.
 *
 * CONTRACT GROUNDING
 * Nothing here reads a named API field — these are presentation primitives, and
 * the value passed in is whatever the caller verified against the contract. The
 * per-field grounding for the job panel lives at renderJobDetailBody() in
 * public/app.js.
 *
 * SECURITY: every dynamic value is inserted with textContent, or through
 * escHtml()/copy-id.js's escaping helpers — no raw server string reaches
 * innerHTML. (The app.js convention; see that file's header.)
 *
 * ACCESSIBILITY (WCAG 2.1 AA)
 *  - The disclosure is a native <details>/<summary>, so it is focusable,
 *    operable from the keyboard, and exposes its expanded state to assistive
 *    technology with no ARIA of our own (SC 2.1.1, 4.1.2).
 *  - The copy control is reused wholesale from public/copy-id.js, which already
 *    carries the aria-live status feedback and a value-bearing accessible name
 *    (SC 4.1.3, 2.5.3).
 */

import { escHtml } from './ops-ui-table.js';
import { copyableIdCellHtml, wireCopyIdButtons } from './copy-id.js';

// Class + data attribute on the disclosure wrapper. Exported so callers, CSS
// and tests can find it without restating the string.
export const RAW_DISCLOSURE_CLASS = 'raw-disclosure';
export const RAW_DISCLOSURE_ATTR = 'data-raw-disclosure';

/**
 * A collapsed-by-default disclosure holding `value` pretty-printed as JSON.
 *
 * @param {unknown} value     the record to show (serialised with JSON.stringify)
 * @param {object} [opts]
 * @param {string} [opts.label='Raw'] the summary text / accessible name
 * @param {boolean} [opts.open=false] start expanded (used to carry an operator's
 *        own expansion across a re-render — see rawDisclosureOpen())
 * @param {string} [opts.className] extra classes for the <details> element
 * @returns {HTMLElement} detached <details>
 */
export function createRawDisclosure(value, opts) {
  const options = opts || {};
  const details = document.createElement('details');
  details.className =
    RAW_DISCLOSURE_CLASS + (options.className ? ' ' + options.className : '');
  details.setAttribute(RAW_DISCLOSURE_ATTR, '1');
  // Collapsed unless the caller explicitly asks otherwise. `open` is an HTML
  // boolean attribute: setting the property to false leaves it absent.
  details.open = options.open === true;

  const summary = document.createElement('summary');
  summary.className = 'raw-disclosure-summary';
  summary.textContent = options.label || 'Raw';
  details.appendChild(summary);

  const pre = document.createElement('pre');
  pre.className = 'code-block raw-disclosure-body';
  pre.textContent = serialiseForRaw(value);
  details.appendChild(pre);

  return details;
}

/**
 * Was the raw disclosure inside `root` expanded?
 *
 * The detail views re-render into the same container on a poll tick
 * (public/detail.js tick() -> renderJobDetailBody, every
 * DETAIL_POLL_INTERVAL_MS), which throws away the DOM. Without this, an
 * operator reading the raw record would have it slam shut under them every few
 * seconds. Callers read this BEFORE clearing the container and pass the result
 * back in as `opts.open`.
 *
 * @param {ParentNode|null|undefined} root
 * @returns {boolean} false when there is no disclosure (first render)
 */
export function rawDisclosureOpen(root) {
  if (!root || typeof root.querySelector !== 'function') return false;
  const existing = root.querySelector('[' + RAW_DISCLOSURE_ATTR + ']');
  return !!(existing && existing.open === true);
}

// JSON.stringify returns undefined for undefined/function inputs and throws on
// a circular structure. Neither should blank a detail panel, so both degrade to
// a readable placeholder.
function serialiseForRaw(value) {
  try {
    const text = JSON.stringify(value, null, 2);
    return text === undefined ? String(value) : text;
  } catch (_) {
    return 'Could not serialise this record.';
  }
}

/**
 * HTML for a detail-panel field value that must be copyable — an external
 * correlation id, typically, which an operator pastes into another tool.
 *
 * Delegates to copy-id.js's `copyableIdCellHtml` so there is exactly one
 * click-to-copy control in this UI (same markup, same feedback, same accessible
 * naming) rather than a second one that drifts. Wire it with
 * wireCopyableFields() after insertion.
 *
 * @param {string|number|null|undefined} value
 * @param {string} [label='Copy id'] accessible label prefix, e.g. 'Copy Encore job id'
 * @returns {string} escaped HTML
 */
export function copyableFieldHtml(value, label) {
  return copyableIdCellHtml(value == null ? '' : String(value), label);
}

/**
 * Bind the click-to-copy behaviour for every copyable field inside `root`.
 * Idempotent (copy-id.js skips already-wired buttons), so it is safe to call
 * after each re-render.
 *
 * @param {ParentNode} root
 * @param {object} [opts] forwarded to wireCopyIdButtons ({ nav } for tests)
 */
export function wireCopyableFields(root, opts) {
  wireCopyIdButtons(root, opts);
}

/**
 * A section heading matching the panels' existing `.section-title` treatment.
 * Exported so the sections this module composes are titled consistently.
 *
 * @param {string} text
 * @param {string} [className='mt12'] spacing utility classes
 * @returns {HTMLElement}
 */
export function sectionTitle(text, className) {
  const el = document.createElement('div');
  el.className = 'section-title' + (className === undefined ? ' mt12' : (className ? ' ' + className : ''));
  el.textContent = text;
  return el;
}

// Re-exported so a caller that already imports this module for the disclosure
// does not need a second import just to escape a string it interpolates.
export { escHtml };
