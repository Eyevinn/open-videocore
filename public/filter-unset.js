/**
 * open-videocore ops dashboard — filter-unset.js
 *
 * ONE implementation of "this filter control is empty" for every filter bar in
 * the ops UI (issues #984, #983 AC2).
 *
 * WHY A CLASS AND NOT CSS
 * An unset filter control must READ as unset: the operator answers "is anything
 * filtered right now?" by looking at the bar, not by opening each control. The
 * search boxes get that for free — they have a native `placeholder`, muted by
 * `.ops-filter-search::placeholder` / `.ops-table-filters input[type='search']
 * ::placeholder` in public/style.css. Selects and date inputs have no
 * placeholder: "All statuses" / "All origins" is a real `<option>` and
 * `yyyy-mm-dd` is the UA's own format hint, so both otherwise paint at full
 * `var(--text)` and an empty bar looks like a filtered one.
 *
 * Pure CSS cannot cover the date case: an empty `input[type="date"]` matches
 * neither `:placeholder-shown` (date inputs have no placeholder) nor
 * `:not(:valid)` (an empty optional date IS valid). So the empty state is marked
 * with one explicit class, and these paint it `var(--text-muted)`:
 *   .ops-filter-select.is-unset, .ops-filter-date.is-unset                  (Jobs/Audit)
 *   .ops-table-filters select.is-unset, .ops-table-filters input[type='date'].is-unset
 *                                                                          (Assets/Logs)
 * Both sets live in one block in public/style.css — search for `is-unset`.
 *
 * WHY IT IS SHARED
 * Four bars need it and the class name is a CSS contract, so a per-file copy is
 * four chances to spell it differently. Jobs (public/jobs-table.js) and Audit
 * (public/audit-table.js) each carried an identical private copy; #983 brought
 * the Assets (public/assets-table.js) and Logs (public/logs-table.js) controls
 * onto the same colour system, which made a fifth and sixth copy the alternative
 * to this module.
 *
 * The DOM seam is asserted for the Jobs bar in test/jobs-table.test.ts
 * (`is-unset` on empty vs. filled select/from/to) and for the Audit bar in
 * test/audit-tab.test.ts:342,370. Those two cover this helper's behaviour; the
 * Assets/Logs call sites still need the same seam assertions — see the PR for
 * #983.
 *
 * Contract note (CLAUDE.md rule 7): nothing here touches the HTTP API. The
 * contracts consumed are the DOM primitives in this directory — the slot factory
 * shape in public/ops-ui-table.js (`control(state, onChange) -> HTMLElement`, see
 * createOpsTable) and the `is-unset` / `.ops-filter-*` class names authored in
 * public/style.css. Both were read on this branch before writing.
 */

/** The class the stylesheet keys the muted empty state off. */
export const UNSET_CLASS = 'is-unset';

/**
 * Toggle the muted empty state to match the control's current value.
 *
 * Call it once at construction (so a control that starts empty starts muted) and
 * again on every event that can change the value.
 *
 * @param {HTMLSelectElement|HTMLInputElement} control
 */
export function markUnset(control) {
  control.classList.toggle(UNSET_CLASS, control.value === '');
}

/**
 * markUnset() now, plus keep it in step for the life of the control.
 *
 * `change` is the event a `<select>` and a date picker fire on commit. `input`
 * is listened to as well because a date field can also be cleared from the
 * keyboard, which fires `input` without a `change` in some engines — without it
 * a cleared date box stays at full `var(--text)` until the next commit.
 *
 * Added as its own listeners rather than folded into each caller's handler so a
 * control whose value-change wiring lives elsewhere (the Assets table hands its
 * `{ input, event, read }` descriptor to the primitive, which owns the
 * listener — see asSlot() in public/assets-table.js) still stays in step.
 *
 * @param {HTMLSelectElement|HTMLInputElement} control
 * @returns {HTMLSelectElement|HTMLInputElement} the same control, for chaining
 */
export function wireUnset(control) {
  markUnset(control);
  const sync = () => markUnset(control);
  control.addEventListener('change', sync);
  control.addEventListener('input', sync);
  return control;
}
