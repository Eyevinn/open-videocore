/**
 * open-videocore ops dashboard — asset-rename.js
 *
 * The "Rename" action (issues #956, #927): an operator-facing affordance for the
 * `name` field that PATCH /api/v1/assets/{id} has always accepted but that no
 * control in this UI could ever trigger.
 *
 * TWO surfaces offer it, ONE implementation behind them:
 *   - the asset DETAIL view's action row — `mountAssetRename` (issue #956);
 *   - a per-row control in the assets LIST — the "inline-in-list" affordance from
 *     issue #927, which calls `openRenameDialog` straight from the table's
 *     Actions cell (wired in public/app.js, rendered by public/assets-table.js).
 * Both go through `openRenameDialog`, so validation, the wire body, the copy and
 * the error handling cannot drift between where an operator happens to start.
 *
 * UI ONLY. No route, schema or response shape is changed by this module; it
 * sends the one field the existing PATCH body already declares.
 *
 * Everything operator-visible here is written with `textContent` or
 * `createElement`. An asset name is tenant data (up to 256 characters of
 * anything), so it never touches `innerHTML`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's route source and generated spec on this branch. Nothing
 * is taken from the issue text.
 *
 *   The write — `openapi.json .paths["/api/v1/assets/{id}"].patch`
 *     parameters: exactly one — path `id` (string, required). No query params.
 *     requestBody schema properties: `name` (string, minLength 1, maxLength 256),
 *       `description`, `objectKey`, `status`, `metadata`, `tags`;
 *       `additionalProperties: false`. Every property optional.
 *     responses: exactly `200` (the FULL asset — the same schema as
 *       GET /api/v1/assets/{id}), `404` and `422`.
 *     Source of truth: `updateSchema`, src/routes/assets.ts:409-419 —
 *       `name: z.string().min(1).max(256).optional()` at :411, with
 *       `.refine((b) => Object.keys(b).length > 0)` at :419 (so a body must
 *       carry at least one field); wired at `app.patch('/:id', …)`
 *       src/routes/assets.ts:5532-5541, `response: { 200: assetSchema,
 *       404: errorSchema, 422: errorSchema }` at :5539.
 *     A body that violates the schema (empty or over-long `name`) is rejected by
 *       fastify-type-provider-zod with a 400 in Fastify's own validation
 *       envelope BEFORE the handler runs — 400 is not declared on this
 *       operation, so nothing here assumes a modelled body for it. The dialog
 *       validates client-side first so that 400 is not the normal way an
 *       operator learns the rule.
 *
 *   What `name` IS — `openapi.json …get.responses["200"] … properties.name`:
 *     "Canonical editorial title of the asset. … this is the single documented
 *     location for title across GET, list, and search responses. There is no
 *     separate top-level `title` field." So renaming through this one field is
 *     what makes the new name appear in the asset list (GET /api/v1/assets/) and
 *     in search results (GET /api/v1/search/) — both project the same field, and
 *     both are served from the live asset documents (InMemorySearchRepository
 *     reads `assets.list()`, src/data/inmemory-search-repo.ts:38;
 *     CouchSearchRepository reads the partition with `couch.find`,
 *     src/data/couch-search-repo.ts:50-56). There is no separately-maintained
 *     name index that could go stale after a rename.
 *
 *   What a rename does NOT touch (issue #956 AC2, verified in the repository
 *   layer rather than assumed):
 *     - `slug` — minted ONCE at creation by `generateUniqueSlug`
 *       (src/data/asset-repo.ts:1424, inside `create`). Neither update path
 *       assigns `slug`: `InMemoryAssetRepository.update`
 *       (src/data/asset-repo.ts:1620-1701) and `CouchAssetRepository.applyPatch`
 *       (src/data/couch-asset-repo.ts:376-447) copy the existing asset and then
 *       assign ONLY the keys present on the patch — `if (patch.name !== undefined)
 *       next.name = patch.name;` (asset-repo.ts:1631 / couch-asset-repo.ts:379).
 *       No `slug` derivation appears in either function.
 *     - `id` — the ULID is the store key on both paths and is never rewritten.
 *     - stored object keys — `objectKey` changes only when the patch itself
 *       carries one (asset-repo.ts:1633 / couch-asset-repo.ts:381), and the key
 *       is derived from the ASSET ID, never from the name:
 *       `sourceObjectKey(assetId) => \`sources/${assetId}\``
 *       (src/routes/asset-upload.ts:96-98). This module therefore sends `name`
 *       and nothing else — `renameRequestBody` below is the single place the
 *       body is built, so no sibling field can be sent by accident.
 *
 *   Authorisation — `MATRIX` (src/auth/authorize.ts:54-58) grants `write` to
 *     `editor` and `admin` only; `methodToAction` (:79-93) maps PATCH -> write;
 *     `resourceAuthorizationPreHandler('asset')` (:126, registered
 *     src/routes/assets.ts:1718) applies it to this route. So a `viewer` gets a
 *     403 `forbidden_insufficient_role` (:99). The caller passes `canChange` as
 *     a client-side MIRROR of that rule; the 403 path below still runs, because
 *     the server is the authority.
 *
 *   Path parameter — `app.patch('/:id')` passes the raw param straight to
 *     `repo.update` (src/routes/assets.ts:5551), which looks the document up by
 *     id (`this.store.get(key)` asset-repo.ts:1625 / `couch.get(id)`
 *     couch-asset-repo.ts:346). Unlike GET /:id there is NO slug fallback, so
 *     this module always sends the ULID (`asset.id`), which the detail pane
 *     holds even when it was opened by slug.
 */

// ─── Copy deck ───────────────────────────────────────────────────────────────
//
// Frozen so a caller cannot drift the wording, and exported so a test asserts
// against the same sentences the operator sees.

export const RENAME_COPY = Object.freeze({
  /** `rename.btn` — the action-row control. */
  btn: 'Rename',
  /** `rename.dialog.title` */
  dialogTitle: 'Rename asset',
  /** `rename.dialog.intro` — what a rename is, in one sentence. */
  dialogIntro:
    'The name is the asset’s editorial title. Changing it updates the title ' +
    'shown in the asset list, in search results and on this panel.',
  /** `rename.dialog.stability` — what a rename deliberately leaves alone. */
  dialogStability:
    'The asset id, its slug and its stored files are not affected: links, ' +
    'download URLs and running jobs keep working.',
  /** `rename.field.label` */
  fieldLabel: 'Name',
  /** `rename.field.help` */
  fieldHelp: 'Required. Up to 256 characters.',
  /** `rename.btn.save` */
  btnSave: 'Save name',
  /** `rename.btn.saving` */
  busyLabel: 'Saving…',
  /** `rename.btn.cancel` */
  btnCancel: 'Cancel',
  /** `rename.error.empty` */
  errEmpty: 'Enter a name. An asset cannot have an empty name.',
  /** `rename.error.long` */
  errTooLong: 'Name is too long (maximum 256 characters).',
  /** `rename.error.unchanged` */
  errUnchanged: 'That is already the asset’s name.',
  /** `rename.error.forbidden` */
  errForbidden:
    'Your role cannot rename this asset. Ask an editor or administrator.',
  /** `rename.error.notFound` */
  errNotFound: 'This asset no longer exists. The name was not changed.',
  /** `rename.error.rejected` — a 400/422 the client-side rules did not catch. */
  errRejected: 'The API rejected this name. The asset was not renamed.',
  /** `rename.error.network` */
  errNetwork: 'Could not reach the API. The asset was not renamed.',
});

/** Server-enforced bounds, from the PATCH body schema (see CONTRACT GROUNDING). */
export const NAME_MIN = 1;
export const NAME_MAX = 256;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Validate what the operator typed against the server's own bounds, before any
 * request is made.
 *
 * Leading/trailing whitespace is TRIMMED: the server would happily store
 * `"  promo  "`, and the difference is invisible in every list this name is
 * rendered into. A value that is only whitespace is therefore empty, which the
 * schema (`min(1)`) refuses.
 *
 * An unchanged name is refused too — not because the API would fail (it would
 * return 200) but because it is a pointless write: `update` bumps `updatedAt`
 * and `provenanceForPatch` appends a `descriptive` provenance entry for any
 * patch carrying `name` (src/data/asset-repo.ts:1136-1145).
 *
 * @param {unknown} raw          the raw input value
 * @param {unknown} currentName  the asset's current `name`
 * @returns {{ value: string, ok: boolean, reason: 'empty'|'too-long'|'unchanged'|null, message: string|null }}
 */
export function normaliseRenameInput(raw, currentName) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const current = typeof currentName === 'string' ? currentName.trim() : '';
  if (value.length < NAME_MIN) {
    return { value, ok: false, reason: 'empty', message: RENAME_COPY.errEmpty };
  }
  if (value.length > NAME_MAX) {
    return { value, ok: false, reason: 'too-long', message: RENAME_COPY.errTooLong };
  }
  if (value === current) {
    return { value, ok: false, reason: 'unchanged', message: RENAME_COPY.errUnchanged };
  }
  return { value, ok: true, reason: null, message: null };
}

/**
 * Build the JSON body for `PATCH /api/v1/assets/{id}`.
 *
 * EXACTLY one key. The schema also accepts `objectKey`, `status`, `description`,
 * `metadata` and `tags`; a rename must send none of them, because each one is a
 * real write to a field this action does not own — `objectKey` in particular is
 * the stored-file pointer that issue #956's second acceptance criterion requires
 * to stay put. Keeping the body construction in one exported function is what
 * makes that assertable.
 *
 * @param {string} name
 * @returns {{ name: string }}
 */
export function renameRequestBody(name) {
  return { name: String(name) };
}

/**
 * Classify a failed rename into operator-facing copy.
 *
 * `400` (schema violation) and `403` (role gate) are both reachable and NEITHER
 * is declared on this operation in `openapi.json` — only 200/404/422 are — so
 * nothing here assumes a modelled body. `422` is declared, and on this route it
 * comes from the lifecycle state machine, which a name-only patch cannot
 * trigger; it is treated as a plain rejection rather than given copy that would
 * claim to know the cause.
 *
 * @param {{status?: number, message?: string, body?: any}} err  an apiFetch rejection
 * @returns {{kind: 'forbidden'|'not-found'|'rejected'|'other', message: string, dismiss: boolean}}
 */
export function classifyRenameError(err) {
  const e = err || {};
  switch (e.status) {
    case 403:
    case 401:
      return { kind: 'forbidden', message: RENAME_COPY.errForbidden, dismiss: false };
    case 404:
      // Terminal for this dialog: there is nothing left to rename.
      return { kind: 'not-found', message: RENAME_COPY.errNotFound, dismiss: true };
    case 400:
    case 422:
      return { kind: 'rejected', message: RENAME_COPY.errRejected, dismiss: false };
    default:
      // Transport failure, 5xx, or anything else undeclared: one honest
      // sentence that states the outcome (nothing changed).
      return { kind: 'other', message: RENAME_COPY.errNetwork, dismiss: false };
  }
}

/**
 * The one-line outcome reported after a successful rename.
 * @param {string} name
 * @returns {string}
 */
export function renameResultMessage(name) {
  return 'Renamed to “' + String(name) + '”.';
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Build the rename form. PURE: no fetch, no listeners beyond the ones the caller
 * attaches to the returned nodes.
 *
 * Reuses the house form furniture (`.form-field.grow`, `.modal-actions`,
 * `.msg.msg-error`) exactly as the lock dialog does — no new dialog primitive is
 * introduced for this action.
 *
 * @param {HTMLElement} body        the modal body element
 * @param {{ currentName?: string }} opts
 * @returns {{ input: HTMLInputElement, errorEl: HTMLElement, submitBtn: HTMLElement, cancelBtn: HTMLElement }}
 */
export function buildRenameForm(body, opts) {
  const o = opts || {};
  body.classList.add('rename-dialog');

  body.appendChild(el('p', 'rename-dialog-intro', RENAME_COPY.dialogIntro));
  body.appendChild(el('p', 'rename-dialog-stability', RENAME_COPY.dialogStability));

  const field = el('div', 'form-field grow mt12');
  const label = el('label', null, RENAME_COPY.fieldLabel);
  label.setAttribute('for', 'rename-name');

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'rename-name';
  input.maxLength = NAME_MAX;
  // Prefill is asset-controlled text assigned through `value`, never markup.
  input.value = typeof o.currentName === 'string' ? o.currentName : '';

  const help = el('div', 'text-muted rename-field-help', RENAME_COPY.fieldHelp);
  help.id = 'rename-name-help';
  input.setAttribute('aria-describedby', help.id);

  field.appendChild(label);
  field.appendChild(input);
  field.appendChild(help);
  body.appendChild(field);

  // Inline error area — every refusal keeps the dialog OPEN and writes here,
  // so the operator does not lose what they typed. Never an `alert()`.
  const errorEl = el('div', 'msg msg-error rename-dialog-error');
  errorEl.id = 'rename-dialog-error';
  errorEl.setAttribute('role', 'alert');
  errorEl.style.display = 'none';
  body.appendChild(errorEl);

  const actions = el('div', 'modal-actions');
  const cancelBtn = el('button', 'btn-sm rename-cancel', RENAME_COPY.btnCancel);
  cancelBtn.type = 'button';
  const submitBtn = el('button', 'btn-sm rename-submit', RENAME_COPY.btnSave);
  submitBtn.type = 'button';
  submitBtn.id = 'rename-submit';
  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  body.appendChild(actions);

  return { input, errorEl, submitBtn, cancelBtn };
}

// ─── Dialog ──────────────────────────────────────────────────────────────────

/**
 * Open the rename dialog for one asset and resolve with what happened.
 *
 * This is the ONE implementation of the rename interaction. Both surfaces that
 * offer the action use it — the detail view (via `mountAssetRename` below) and
 * the per-row control in the assets list (issue #927) — so the two cannot drift
 * on validation, wire shape, copy or error handling. Adding the list affordance
 * added no second request path.
 *
 * The returned promise settles from `openModal`'s own `onClose`, so EVERY close
 * route settles it exactly once: Save, Cancel, the header ×, Escape and a
 * backdrop click. A caller that awaits it to decide whether to refresh (the list
 * row does) can never be left hanging on a dismissed dialog.
 *
 * @param {object} opts
 * @param {object}   opts.asset      asset (or list row) carrying `id` and `name`
 * @param {Function} opts.apiFetch
 * @param {Function} opts.openModal  `(title, buildBody, { onClose }) => close`
 * @param {(asset: object|null, message: string) => any} [opts.onRenamed]
 *        notified on a successful rename (with the FULL asset the 200 carries)
 *        and on a 404 (with `null`), for callers that re-render from it. Callers
 *        that only need the outcome can read the resolved value instead.
 * @param {(message: string) => any} [opts.onForbidden]
 *        notified when the server refuses the write with a 403, so the caller can
 *        retire a control that is now known not to work.
 * @returns {Promise<{renamed: boolean, asset: object|null, message: string|null,
 *                    forbidden?: boolean, gone?: boolean}>}
 */
export function openRenameDialog(opts) {
  const o = opts || {};
  const asset = o.asset || {};

  // The ULID, never the slug: PATCH /:id does not resolve slugs (see CONTRACT
  // GROUNDING).
  const path = '/assets/' + encodeURIComponent(String(asset.id));

  return new Promise(function (resolve) {
    // Recorded before the dialog is closed and resolved from onClose, so the
    // outcome of a dismissal and the outcome of a save travel the same route.
    let outcome = { renamed: false, asset: null, message: null };
    let settled = false;
    function settle() {
      if (settled) return;
      settled = true;
      resolve(outcome);
    }

    // Held so the field can be focused AFTER openModal attaches the backdrop —
    // the body builder runs while the dialog is still detached, and focus() on a
    // detached element is a no-op (the lock dialog's rule).
    let firstField = null;

    o.openModal(
      RENAME_COPY.dialogTitle,
      function (body, closeDialog) {
        const form = buildRenameForm(body, { currentName: asset.name });
        firstField = form.input;

        function showError(message) {
          form.errorEl.textContent = message;
          form.errorEl.style.display = '';
          form.input.focus();
        }

        form.cancelBtn.addEventListener('click', function () {
          closeDialog();
        });

        form.submitBtn.addEventListener('click', async function () {
          form.errorEl.style.display = 'none';
          form.errorEl.textContent = '';

          // Client-side gate first, against the SERVER's bounds. A refusal here
          // sends no request at all.
          const check = normaliseRenameInput(form.input.value, asset.name);
          if (!check.ok) {
            showError(check.message);
            return;
          }

          const prev = form.submitBtn.textContent;
          form.submitBtn.disabled = true;
          form.cancelBtn.disabled = true;
          form.submitBtn.textContent = RENAME_COPY.busyLabel;
          try {
            const updated = await o.apiFetch(path, {
              method: 'PATCH',
              // Exactly `{ name }` — see renameRequestBody.
              body: JSON.stringify(renameRequestBody(check.value)),
            });
            // Report the name the SERVER returned, not the one that was typed.
            const stored =
              updated && typeof updated.name === 'string' ? updated.name : check.value;
            outcome = { renamed: true, asset: updated, message: renameResultMessage(stored) };
            closeDialog();
            if (typeof o.onRenamed === 'function') await o.onRenamed(updated, outcome.message);
            return;
          } catch (err) {
            const c = classifyRenameError(err);
            if (c.dismiss) {
              outcome = { renamed: false, asset: null, message: c.message, gone: true };
              closeDialog();
              if (typeof o.onRenamed === 'function') await o.onRenamed(null, c.message);
              return;
            }
            if (c.kind === 'forbidden') {
              // A control known to fail stops being offered for the rest of this
              // view of the asset (the lock module's 403 rule). Which control
              // that is belongs to the caller, so it is told rather than guessed.
              outcome = { renamed: false, asset: null, message: c.message, forbidden: true };
              if (typeof o.onForbidden === 'function') o.onForbidden(c.message);
            }
            showError(c.message);
          } finally {
            // Never leave the dialog stuck in its pending state.
            form.submitBtn.disabled = false;
            form.cancelBtn.disabled = false;
            form.submitBtn.textContent = prev;
          }
        });
      },
      { onClose: settle }
    );

    if (firstField) {
      firstField.focus();
      firstField.select();
    }
  });
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Add the "Rename" control to the asset detail action row and wire its dialog.
 *
 * The button joins the EXISTING action row rather than creating a block of its
 * own: renaming has no state to display — the current name is already on screen,
 * in the "Title" row of the detail grid — so a heading + note block (the shape
 * "Delete protection" and "Editorial review" need) would be empty chrome.
 *
 * No control is rendered when `canChange` is false. There is no accompanying
 * "your role cannot do this" line here: unlike the lock and review blocks, this
 * action has no always-present block to hang one on, and the detail pane already
 * states the role limitation once for the lock.
 *
 * @param {object} opts
 * @param {object}      opts.asset       asset from GET /api/v1/assets/{id}
 * @param {HTMLElement} opts.actionsRow  the `.mt12.flex-gap` action row
 * @param {HTMLElement} [opts.beforeEl]  element in that row to insert before
 * @param {boolean}     opts.canChange   client-role mirror of the ADR-018 matrix
 * @param {Function}    opts.apiFetch
 * @param {Function}    opts.openModal
 * @param {Function}    [opts.showMsg]   house message renderer (host, text, kind)
 * @param {() => HTMLElement} [opts.messageHost]  resolves the #action-msg element
 * @param {(asset: object|null, message: string) => any} opts.onRenamed
 *        called after a successful rename (or a 404) so the caller can re-read
 *        the asset and refresh the table. The updated asset is passed through
 *        because the 200 carries the FULL asset — re-rendering from it is the
 *        only way the UI learns what the server actually stored.
 * @returns {{ button: HTMLElement|null, open: (() => void)|null }}
 */
export function mountAssetRename(opts) {
  const o = opts || {};
  const asset = o.asset || {};
  const actionsRow = o.actionsRow;

  if (!o.canChange) {
    return { button: null, open: null };
  }

  const btn = el('button', 'btn-ghost', RENAME_COPY.btn);
  btn.type = 'button';
  btn.id = 'btn-rename-asset';
  if (actionsRow) {
    if (o.beforeEl && o.beforeEl.parentNode === actionsRow) {
      actionsRow.insertBefore(btn, o.beforeEl);
    } else {
      actionsRow.appendChild(btn);
    }
  }

  function reportToActionArea(text, kind) {
    if (typeof o.showMsg !== 'function') return;
    const host = typeof o.messageHost === 'function' ? o.messageHost() : null;
    if (host) o.showMsg(host, text, kind || 'error');
  }

  // The dialog itself lives in openRenameDialog, shared with the assets list's
  // per-row control (issue #927). All this surface adds is its own button and
  // what a 403 should do to it.
  function open() {
    void openRenameDialog({
      asset: asset,
      apiFetch: o.apiFetch,
      openModal: o.openModal,
      onRenamed: o.onRenamed,
      onForbidden: function (message) {
        if (!btn.parentNode) return;
        btn.parentNode.removeChild(btn);
        reportToActionArea(message, 'error');
      },
    });
  }

  btn.addEventListener('click', open);
  return { button: btn, open };
}
