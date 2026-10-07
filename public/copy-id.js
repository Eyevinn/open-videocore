/**
 * open-videocore ops dashboard — copy-id.js
 *
 * Issue #851: a table column headed "ID" must carry the value the API accepts
 * as an asset id, and that value must be copyable without hovering for a
 * `title` tooltip.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (fetch-the-contract-before-writing-any-call rule)
 *
 * What the API accepts as an asset id, verified against the route source in
 * this repo (not guessed):
 *   - `PUT /api/v1/collections/:id/assets/:assetId` (openapi.json path key
 *     "/api/v1/collections/{id}/assets/{assetId}") resolves the member with
 *     `assets.get(request.params.assetId)` — src/routes/collections.ts:493-510.
 *     That is the plain ULID repository read (`AssetRepository.get`,
 *     src/data/asset-repo.ts:841); there is NO slug fallback on this path, so a
 *     slug entered here 422s with `asset_not_found`.
 *   - `DELETE /api/v1/collections/:id/assets/:assetId` does NOT resolve the
 *     asset at all: it removes by exact id via `repo.removeAsset()` and a value
 *     that is not in the membership list (a slug, say) is a silent 200 no-op —
 *     src/routes/collections.ts:533-547. So a slug is not rejected there, it is
 *     simply ignored, which is if anything a stronger reason to put the ULID in
 *     front of the operator.
 *   - Only `GET /api/v1/assets/:id` is slug-tolerant, via `resolveAsset()` /
 *     `isUlid()` — src/routes/assets.ts:2807-2814 and src/data/asset-repo.ts:834.
 * The ULID `id` is therefore the one value accepted everywhere an asset id is
 * taken, and it is what a column headed "ID" must show.
 *
 * The asset list item carries both fields: `id` (string, always present —
 * openapi.json .paths["/api/v1/assets/"].get 200 items.required includes `id`)
 * and `slug` (string, OPTIONAL — present as a property, absent from `required`;
 * pre-slug assets have none, see src/data/asset-document.ts:286 and the
 * `slug?: string` field on `Asset`, src/data/asset-repo.ts:455). So the slug
 * cell must tolerate an absent slug.
 *
 * SECURITY: every dynamic value written into an HTML string passes through
 * escHtml (the app.js/ops-ui-table.js convention).
 */

import { escHtml } from './ops-ui-table.js';

// Placeholder shown where a value is absent (matches the app's existing em-dash
// convention for empty cells).
const EMPTY = '—';

// Marker class the wiring below binds to. Exported so tests and callers can
// query for the button without restating the string.
export const COPY_ID_BTN_CLASS = 'copy-id-btn';

// The button's text label (issue #990). Still the real words "Copy" / "Copied" /
// "Copy failed" — it is both the live-region payload and the value the resting
// restore writes back — but visually hidden, with an icon carrying the meaning
// for sighted users. Exported so the wiring, the CSS and tests all name one
// string.
export const COPY_ID_LABEL_CLASS = 'copy-id-btn-label';

// The icon box. Empty by construction: the glyph is drawn in CSS from
// `::before`/`::after` on this span (see `.copy-id-btn-icon` in
// public/style.css), so it inherits `currentColor` from `.copy-id-btn` and its
// `:hover`/state rules.
export const COPY_ID_ICON_CLASS = 'copy-id-btn-icon';

// Outcome classes toggled on the BUTTON for the sighted half of the feedback.
// Once the word is hidden the visible text can no longer carry the result, so
// the icon swaps shape — tick for copied, cross for not-copied — and takes a
// success/danger colour with it. Shape, not hue alone, is what distinguishes the
// two outcomes (WCAG 1.4.1 Use of Colour).
export const COPY_ID_OK_CLASS = 'is-copied';
export const COPY_ID_FAIL_CLASS = 'is-copy-failed';

// How long the transient "Copied" / "Copy failed" feedback stays on the button
// before it returns to its resting label. Exported so tests assert the real
// window instead of a duplicated magic number.
export const FEEDBACK_MS = 1500;

/**
 * HTML for an identifier cell: the full value as selectable text plus an
 * always-visible click-to-copy button. No hover-only `title` carries the value
 * — the text IS the value.
 *
 * ACCESSIBILITY: the button carries `aria-live="polite"` so the transient
 * "Copied" / "Copy failed" feedback written into it by wireCopyIdButtons() is a
 * programmatically determinable status message (WCAG 2.1 SC 4.1.3, level AA)
 * rather than a visual-only flash.
 *
 * The accessible name ends with the value itself, so a table of N rows gives N
 * distinguishable controls in a screen reader's control list rather than N
 * identical "Copy asset id" entries with no row context.
 *
 * ICON BUTTON (issue #990). The control is a square icon button, not the word
 * "Copy". What did NOT change: the words are still in the DOM, inside
 * `.copy-id-btn-label`, because that text is three things at once — the
 * live-region payload wireCopyIdButtons() writes the outcome into, the string the
 * resting-text restore puts back, and a non-visual label. Hiding it with the
 * existing `.visually-hidden` utility (public/style.css:194) keeps all three and
 * removes only the pixels. SC 2.5.3 (label in name) stops applying because there
 * is no longer any visible text label to match against.
 *
 * Two children, in this order and with NO whitespace between them, so
 * `button.textContent` is exactly the label and nothing else:
 *   1. the icon box — `aria-hidden`, so the glyph is never announced and never
 *      lands in the live-region payload;
 *   2. the visually-hidden label.
 *
 * The glyph is drawn in CSS, not as an inline `<svg>`: `public/` carries no icon
 * set, no icon font and no SVG (the magnifier at `.ops-search-icon`,
 * public/style.css:2081, is drawn the same way), and
 * test/asset-list-lock-indicator.test.ts:413 asserts that no SVG appears
 * anywhere in an assets-table row — this button included. CSS geometry gets the
 * same properties an inline SVG was wanted for: `currentColor` theming off
 * `.copy-id-btn`, no new dependency, nothing for a CSP to allow.
 *
 * @param {string} value  the identifier to display and copy (e.g. an asset ULID)
 * @param {string} [label] accessible label prefix ("Copy asset id")
 * @returns {string} escaped HTML
 */
export function copyableIdCellHtml(value, label) {
  const v = value == null ? '' : String(value);
  if (!v) return '<span class="cell-id">' + EMPTY + '</span>';
  const aria = (label || 'Copy id') + ' ' + v;
  return (
    '<span class="cell-id cell-id-value">' +
    escHtml(v) +
    '</span>' +
    '<button type="button" class="' + COPY_ID_BTN_CLASS + '" ' +
    'data-copy-id="' + escHtml(v) + '" ' +
    'aria-live="polite" ' +
    'aria-label="' + escHtml(aria) + '">' +
    '<span class="' + COPY_ID_ICON_CLASS + '" aria-hidden="true"></span>' +
    '<span class="visually-hidden ' + COPY_ID_LABEL_CLASS + '">Copy</span>' +
    '</button>'
  );
}

/**
 * HTML for a slug cell — the human-readable handle, labelled as the slug by its
 * column header, never as "ID". Falls back to an em-dash for slug-less assets.
 *
 * @param {string|undefined} slug
 * @returns {string} escaped HTML
 */
export function slugCellHtml(slug) {
  const s = slug == null ? '' : String(slug);
  return '<span class="cell-id">' + (s ? escHtml(s) : EMPTY) + '</span>';
}

/**
 * Bind the click-to-copy behaviour for every copy button inside `root`.
 *
 * Idempotent: a button already wired is skipped, so this is safe to call after
 * every re-render (rows are rebuilt on each table load).
 *
 * The click is stopped from propagating so copying inside a clickable table row
 * does not also open that row's detail panel.
 *
 * Mirrors the existing copy-to-clipboard affordance in app.js (the manifest-URL
 * "Copy URL" button): navigator.clipboard when available, transient button-label
 * feedback either way, never a thrown error into the render path.
 *
 * The outcome goes to BOTH halves of the audience on every click (issue #990):
 * the words go into the visually-hidden `.copy-id-btn-label` inside the
 * aria-live button, and an outcome class on the button swaps the CSS-drawn icon
 * so a sighted operator — who can no longer read the result, the word being
 * hidden — sees a tick or a cross instead.
 *
 * @param {ParentNode} root
 * @param {object} [opts]
 * @param {Navigator} [opts.nav] injectable navigator (tests)
 */
export function wireCopyIdButtons(root, opts) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  const options = opts || {};
  const nav =
    options.nav || (typeof navigator !== 'undefined' ? navigator : undefined);

  root.querySelectorAll('.' + COPY_ID_BTN_CLASS).forEach(function (btn) {
    if (btn.dataset.copyIdWired === '1') return;
    btn.dataset.copyIdWired = '1';
    // Where the words live. Since #990 that is the visually-hidden span inside
    // the icon button, not the button itself — the button's own text would now be
    // the icon's neighbour rather than a label. Falls back to the button for any
    // caller-authored markup that has no label span, which keeps the pre-#990
    // behaviour exactly.
    const textNode = btn.querySelector('.' + COPY_ID_LABEL_CLASS) || btn;
    // Capture the resting label ONCE, at wire time — NOT per click. Reading it
    // inside the handler meant a second click inside the feedback window
    // captured the transient "Copied" as the text to restore, so the button (and
    // its accessible name, since it is an aria-live region) stayed stranded on
    // "Copied" for good: no Copy affordance and a permanently stale name.
    const restingText = textNode.textContent;
    const restingLabel = btn.getAttribute('aria-label');
    // One pending restore per button. Tracked so a rapid second click cancels
    // the first timer instead of queueing a second one that fires later.
    let restoreTimer = null;
    btn.addEventListener('click', function (event) {
      if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
      const value = btn.dataset.copyId || '';
      // Report the outcome on the button and move its accessible name with the
      // visible text, so a screen reader never reads a stale "Copy asset id"
      // while the button says "Copied". The button is an aria-live region
      // (markup above), which is what makes this feedback a status message
      // instead of a sighted-only flash.
      // `state` is the sighted half: the icon swaps to a tick or a cross and the
      // button takes the matching colour for the same window the words are up
      // for. Both halves are cleared by the one restore timer, so the visible
      // icon and the announced text can never disagree.
      const restore = function (text, state) {
        textNode.textContent = text;
        if (restingLabel !== null) btn.setAttribute('aria-label', text);
        btn.classList.remove(COPY_ID_OK_CLASS, COPY_ID_FAIL_CLASS);
        if (state) btn.classList.add(state);
        if (restoreTimer !== null) clearTimeout(restoreTimer);
        restoreTimer = setTimeout(function () {
          restoreTimer = null;
          textNode.textContent = restingText;
          if (restingLabel !== null) btn.setAttribute('aria-label', restingLabel);
          btn.classList.remove(COPY_ID_OK_CLASS, COPY_ID_FAIL_CLASS);
        }, FEEDBACK_MS);
      };
      if (value && nav && nav.clipboard && nav.clipboard.writeText) {
        nav.clipboard.writeText(value).then(
          function () {
            restore('Copied', COPY_ID_OK_CLASS);
          },
          function () {
            restore('Copy failed', COPY_ID_FAIL_CLASS);
          }
        );
      } else {
        // No clipboard API (insecure origin / old browser): the value is still
        // plain selectable text in the cell, so nothing is lost. Visually this is
        // the not-copied icon, because that is the truth — the clipboard never
        // received the value — and the instruction in the words ("Select to
        // copy") is what the screen-reader half gets.
        restore('Select to copy', COPY_ID_FAIL_CLASS);
      }
    });
  });
}
