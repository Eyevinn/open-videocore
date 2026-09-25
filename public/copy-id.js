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
 * rather than a visual-only flash. The visible word "Copy" is the start of the
 * accessible name, so the name still contains the label (SC 2.5.3).
 *
 * The accessible name also ends with the value itself, so a table of N rows
 * gives N distinguishable controls in a screen reader's control list rather
 * than N identical "Copy asset id" entries with no row context.
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
    'aria-label="' + escHtml(aria) + '">Copy</button>'
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
    // Capture the resting label ONCE, at wire time — NOT per click. Reading it
    // inside the handler meant a second click inside the feedback window
    // captured the transient "Copied" as the text to restore, so the button (and
    // its accessible name, since it is an aria-live region) stayed stranded on
    // "Copied" for good: no Copy affordance and a permanently stale name.
    const restingText = btn.textContent;
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
      const restore = function (text) {
        btn.textContent = text;
        if (restingLabel !== null) btn.setAttribute('aria-label', text);
        if (restoreTimer !== null) clearTimeout(restoreTimer);
        restoreTimer = setTimeout(function () {
          restoreTimer = null;
          btn.textContent = restingText;
          if (restingLabel !== null) btn.setAttribute('aria-label', restingLabel);
        }, FEEDBACK_MS);
      };
      if (value && nav && nav.clipboard && nav.clipboard.writeText) {
        nav.clipboard.writeText(value).then(
          function () {
            restore('Copied');
          },
          function () {
            restore('Copy failed');
          }
        );
      } else {
        // No clipboard API (insecure origin / old browser): the value is still
        // plain selectable text in the cell, so nothing is lost.
        restore('Select to copy');
      }
    });
  });
}
