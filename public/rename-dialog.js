/**
 * open-videocore ops dashboard — rename-dialog.js
 *
 * The SHARED rename affordance: one validation rule, one dialog, one mount, one
 * error classification, used by every resource whose `name` is editable through
 * a PATCH.
 *
 * Extracted verbatim from the asset rename (issue #956) when the same
 * affordance was needed for collections (issue #928). Nothing about the asset
 * behaviour changed in the extraction: `public/asset-rename.js` is now a thin
 * adapter that supplies the asset copy deck and the asset path, and
 * `public/collection-rename.js` does the same for collections. Keeping ONE
 * implementation is what makes "the collection rename behaves like the asset
 * rename" a property of the code rather than a promise in a review.
 *
 * UI ONLY. No route, schema or response shape is defined here; a caller passes
 * the path it verified and this module sends the one field — `name`.
 *
 * Everything operator-visible here is written with `textContent` or
 * `createElement`. A resource name is tenant data (up to 256 characters of
 * anything), so it never touches `innerHTML`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHAT IS GENERIC AND WHY (the two contracts this module is shaped by)
 *
 * Both callers were read off this repo's route source and generated spec
 * (CLAUDE.md rule 7) before this module was generalised, and the two agree on
 * every point the shared code depends on:
 *
 *   `name` bounds — identical on both resources, deliberately:
 *     asset:      `updateSchema.name = z.string().min(1).max(256).optional()`
 *                 (src/routes/assets.ts:411)
 *     collection: `updateBodySchema.name = z.string().min(1).max(256).optional()`
 *                 (src/routes/collections.ts:224 — whose own comment pins it to
 *                 the asset rule "so create/rename/asset-rename cannot drift")
 *     So NAME_MIN/NAME_MAX below are one pair of numbers for both, and the
 *     client-side gate is the server's own rule rather than a guess.
 *
 *   Body shape — exactly one key, `name`. Both PATCH bodies also accept sibling
 *     editorial fields, and the collection body is `.strict()`
 *     (src/routes/collections.ts:229) so an unknown key is a 400. Building the
 *     body in ONE exported function (`renameRequestBody`) is what makes "only
 *     allowed fields are ever sent" assertable for both resources at once.
 *
 *   Success response — the FULL updated resource (asset: `assetSchema`,
 *     src/routes/assets.ts:5539; collection: `collectionSchema`,
 *     src/routes/collections.ts:395). So the mount reports the name the SERVER
 *     returned and hands the resource back to the caller to re-render from.
 *
 *   Authorisation — the SAME matrix for both: `MATRIX`
 *     (src/auth/authorize.ts:54-58) grants `write` to `editor` and `admin`
 *     only, `methodToAction` (:79-93) maps PATCH -> write, and
 *     `resourceAuthorizationPreHandler` is registered on both routers
 *     (src/routes/assets.ts:1718, src/routes/collections.ts:267) — ADR-018
 *     decision 4: `asset` and `collection` are not distinguished by the table.
 *     A denied caller gets 403 `AUTHZ_FORBIDDEN_ERROR =
 *     'forbidden_insufficient_role'` (:99). `canChange` is a client-side MIRROR
 *     of that rule; the 403 path below still runs, because the server is the
 *     authority.
 *
 * What is NOT generic, and is therefore supplied by each adapter: the copy deck
 * (every sentence names its resource), the request path, and the button id.
 */

/** Server-enforced bounds, identical on both PATCH body schemas (see above). */
export const NAME_MIN = 1;
export const NAME_MAX = 256;

/**
 * The sentences a rename affordance needs. Each adapter freezes its own deck and
 * exports it so a test asserts against the same strings the operator reads.
 *
 * @typedef {object} RenameCopy
 * @property {string} btn             the action-row control
 * @property {string} dialogTitle
 * @property {string} dialogIntro     what a rename is, in one sentence
 * @property {string} dialogStability what a rename deliberately leaves alone
 * @property {string} fieldLabel
 * @property {string} fieldHelp
 * @property {string} btnSave
 * @property {string} busyLabel
 * @property {string} btnCancel
 * @property {string} errEmpty
 * @property {string} errTooLong
 * @property {string} errUnchanged
 * @property {string} errForbidden
 * @property {string} errNotFound
 * @property {string} errRejected
 * @property {string} errNetwork
 */

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Validate what the operator typed against the server's own bounds, before any
 * request is made.
 *
 * Leading/trailing whitespace is TRIMMED: the server would happily store
 * `"  promo  "`, and the difference is invisible in every list this name is
 * rendered into. A value that is only whitespace is therefore empty, which both
 * schemas (`min(1)`) refuse.
 *
 * An unchanged name is refused too — not because the API would fail (it would
 * return 200) but because it is a pointless write: both update paths bump
 * `updatedAt` for any patch at all (asset: src/data/asset-repo.ts:1620-1701;
 * collection: `applyCollectionUpdate`, src/data/collection-repo.ts:92-110).
 *
 * @param {unknown} raw          the raw input value
 * @param {unknown} currentName  the resource's current `name`
 * @param {RenameCopy} copy
 * @returns {{ value: string, ok: boolean, reason: 'empty'|'too-long'|'unchanged'|null, message: string|null }}
 */
export function normaliseName(raw, currentName, copy) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const current = typeof currentName === 'string' ? currentName.trim() : '';
  if (value.length < NAME_MIN) {
    return { value, ok: false, reason: 'empty', message: copy.errEmpty };
  }
  if (value.length > NAME_MAX) {
    return { value, ok: false, reason: 'too-long', message: copy.errTooLong };
  }
  if (value === current) {
    return { value, ok: false, reason: 'unchanged', message: copy.errUnchanged };
  }
  return { value, ok: true, reason: null, message: null };
}

/**
 * Build the JSON body for a rename PATCH.
 *
 * EXACTLY one key. Both schemas also accept sibling editorial fields — the asset
 * body takes `objectKey`, `status`, `description`, `metadata` and `tags`, the
 * collection body takes `description`, `tags` and `custom` — and a rename must
 * send none of them, because each one is a real write to a field this action
 * does not own.
 *
 * `assetIds` is not merely omitted here, it is UNSENDABLE: the collection PATCH
 * body is `.strict()` (src/routes/collections.ts:229) so membership cannot be
 * smuggled through the metadata endpoint, and this function is the single place
 * a rename body is constructed, so no caller can add a key to it by accident.
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
 * `403` (role gate) is reachable on both resources and is declared on NEITHER
 * operation in `openapi.json`, so nothing here assumes a modelled body — only
 * the status is read. The status set is otherwise:
 *   asset:      200 / 404 / 422 declared (422 is the lifecycle state machine,
 *               which a name-only patch cannot trigger); a schema violation is
 *               Fastify's own 400, undeclared.
 *   collection: 200 / 400 / 404 declared (400 covers both the framework's zod
 *               rejection and the `metadata_cap_exceeded` breach, which a
 *               name-only patch cannot trigger — `checkCollectionMetadataCaps`
 *               inspects description/tags/custom only,
 *               src/routes/collections.ts:148-190).
 * Either way a 400/422 reaching here means the client-side rules did not catch
 * something, so it is reported as a refusal rather than given copy that would
 * claim to know the cause.
 *
 * @param {{status?: number, message?: string, body?: any}} err  an apiFetch rejection
 * @param {RenameCopy} copy
 * @returns {{kind: 'forbidden'|'not-found'|'rejected'|'other', message: string, dismiss: boolean}}
 */
export function classifyRenameFailure(err, copy) {
  const e = err || {};
  switch (e.status) {
    case 403:
    case 401:
      return { kind: 'forbidden', message: copy.errForbidden, dismiss: false };
    case 404:
      // Terminal for this dialog: there is nothing left to rename.
      return { kind: 'not-found', message: copy.errNotFound, dismiss: true };
    case 400:
    case 422:
      return { kind: 'rejected', message: copy.errRejected, dismiss: false };
    default:
      // Transport failure, 5xx, or anything else undeclared: one honest
      // sentence that states the outcome (nothing changed).
      return { kind: 'other', message: copy.errNetwork, dismiss: false };
  }
}

/**
 * The one-line outcome reported after a successful rename. Resource-neutral on
 * purpose — it is rendered next to the thing that was renamed.
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
 * introduced for this action, and no second one for the second resource. The
 * element ids are shared because at most one rename dialog is open at a time
 * (openModal replaces the backdrop), so a test and a screen reader both find the
 * field at the same id whichever resource is being renamed.
 *
 * @param {HTMLElement} body        the modal body element
 * @param {{ currentName?: string, copy: RenameCopy }} opts
 * @returns {{ input: HTMLInputElement, errorEl: HTMLElement, submitBtn: HTMLElement, cancelBtn: HTMLElement }}
 */
export function buildRenameDialogBody(body, opts) {
  const o = opts || {};
  const copy = o.copy;
  body.classList.add('rename-dialog');

  body.appendChild(el('p', 'rename-dialog-intro', copy.dialogIntro));
  body.appendChild(el('p', 'rename-dialog-stability', copy.dialogStability));

  const field = el('div', 'form-field grow mt12');
  const label = el('label', null, copy.fieldLabel);
  label.setAttribute('for', 'rename-name');

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'rename-name';
  input.maxLength = NAME_MAX;
  // Prefill is tenant-controlled text assigned through `value`, never markup.
  input.value = typeof o.currentName === 'string' ? o.currentName : '';

  const help = el('div', 'text-muted rename-field-help', copy.fieldHelp);
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
  const cancelBtn = el('button', 'btn-sm rename-cancel', copy.btnCancel);
  cancelBtn.type = 'button';
  const submitBtn = el('button', 'btn-sm rename-submit', copy.btnSave);
  submitBtn.type = 'button';
  submitBtn.id = 'rename-submit';
  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  body.appendChild(actions);

  return { input, errorEl, submitBtn, cancelBtn };
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Add a "Rename" control to a detail view's action row and wire its dialog.
 *
 * The button joins the EXISTING action row rather than creating a block of its
 * own: renaming has no state to display — the current name is already on screen,
 * in the detail grid — so a heading + note block (the shape "Delete protection"
 * and "Editorial review" need) would be empty chrome.
 *
 * No control is rendered when `canChange` is false: absent, not "present but
 * disabled", so the UI never offers a guaranteed 403.
 *
 * @param {object} opts
 * @param {RenameCopy}  opts.copy        resource-specific sentences
 * @param {string}      opts.path        apiFetch path of the PATCH, e.g. '/collections/01J8…'
 * @param {string}      opts.buttonId    id for the control, e.g. 'btn-rename-collection'
 * @param {string}      [opts.currentName]  the resource's current `name` (prefill + no-op check)
 * @param {HTMLElement} opts.actionsRow  the `.mt12.flex-gap` action row
 * @param {HTMLElement} [opts.beforeEl]  element in that row to insert before
 * @param {boolean}     opts.canChange   client-role mirror of the ADR-018 matrix
 * @param {Function}    opts.apiFetch
 * @param {Function}    opts.openModal
 * @param {Function}    [opts.showMsg]   house message renderer (host, text, kind)
 * @param {() => HTMLElement} [opts.messageHost]  resolves the message host element
 * @param {(resource: object|null, message: string) => any} opts.onRenamed
 *        called after a successful rename (or a 404) so the caller can re-read
 *        and refresh its list. The updated resource is passed through because
 *        the 200 carries the FULL document — re-rendering from it is the only
 *        way the UI learns what the server actually stored.
 * @returns {{ button: HTMLElement|null, open: (() => void)|null }}
 */
export function mountRenameControl(opts) {
  const o = opts || {};
  const copy = o.copy;
  const actionsRow = o.actionsRow;

  if (!o.canChange) {
    return { button: null, open: null };
  }

  const btn = el('button', 'btn-ghost', copy.btn);
  btn.type = 'button';
  btn.id = o.buttonId;
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

  function open() {
    // Held so the field can be focused AFTER openModal attaches the backdrop —
    // the body builder runs while the dialog is still detached, and focus() on a
    // detached element is a no-op (the lock dialog's rule).
    let firstField = null;
    o.openModal(copy.dialogTitle, function (body, closeDialog) {
      const form = buildRenameDialogBody(body, { currentName: o.currentName, copy: copy });
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
        const check = normaliseName(form.input.value, o.currentName, copy);
        if (!check.ok) {
          showError(check.message);
          return;
        }

        const prev = form.submitBtn.textContent;
        form.submitBtn.disabled = true;
        form.cancelBtn.disabled = true;
        form.submitBtn.textContent = copy.busyLabel;
        try {
          const updated = await o.apiFetch(o.path, {
            method: 'PATCH',
            // Exactly `{ name }` — see renameRequestBody.
            body: JSON.stringify(renameRequestBody(check.value)),
          });
          closeDialog();
          // Report the name the SERVER returned, not the one that was typed.
          const stored = updated && typeof updated.name === 'string' ? updated.name : check.value;
          await o.onRenamed(updated, renameResultMessage(stored));
          return;
        } catch (err) {
          const c = classifyRenameFailure(err, copy);
          if (c.dismiss) {
            closeDialog();
            await o.onRenamed(null, c.message);
            return;
          }
          if (c.kind === 'forbidden' && btn.parentNode) {
            // A control known to fail stops being offered for the rest of this
            // view of the resource (the lock module's 403 rule).
            btn.parentNode.removeChild(btn);
            reportToActionArea(c.message, 'error');
          }
          showError(c.message);
        } finally {
          // Never leave the dialog stuck in its pending state.
          form.submitBtn.disabled = false;
          form.cancelBtn.disabled = false;
          form.submitBtn.textContent = prev;
        }
      });
    });
    if (firstField) {
      firstField.focus();
      firstField.select();
    }
  }

  btn.addEventListener('click', open);
  return { button: btn, open };
}
