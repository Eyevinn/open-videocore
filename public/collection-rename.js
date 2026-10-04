/**
 * open-videocore ops dashboard — collection-rename.js
 *
 * The collection DETAIL view's "Rename" action (issue #958): an operator-facing
 * affordance for the `name` field that PATCH /api/v1/collections/{id} accepts,
 * mirroring the asset rename interaction (public/asset-rename.js, issue #956).
 *
 * UI ONLY. No route, schema or response shape is changed by this module; it
 * sends the one field the existing PATCH body already declares.
 *
 * Everything operator-visible here is written with `textContent` or
 * `createElement`. A collection name is tenant data (up to 256 characters of
 * anything), so it never touches `innerHTML`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's route source and generated spec on this branch. Nothing
 * is taken from the issue text.
 *
 *   The write — `openapi.json .paths["/api/v1/collections/{id}"].patch`
 *     parameters: exactly one — path `id` (string, required). No query params.
 *     requestBody schema properties: `name` (string, minLength 1, maxLength 256),
 *       `description`, `tags`, `custom`; `additionalProperties: false`. Every
 *       property optional.
 *     responses: exactly `200` (the collection — `collectionSchema`, WITHOUT the
 *       resolved `assets` array), `400` and `404`. Note there is NO `422` on this
 *       operation (unlike the asset rename, which also declares one).
 *     Source of truth: `updateBodySchema`, src/routes/collections.ts:216-229 —
 *       `name: z.string().min(1).max(256).optional()` at :224, inside a
 *       `.strict()` object (so an unknown key, e.g. `assetIds`, is a 400). Wired
 *       at `app.patch('/:id', …)` src/routes/collections.ts:389-410,
 *       `response: { 200: collectionSchema, 400: errorSchema, 404: errorSchema }`
 *       at :395. The handler passes `request.body` straight to `repo.update`
 *       (:407), which applies `name` via `applyCollectionUpdate`
 *       (src/data/collection-repo.ts:97-98: `if (patch.name !== undefined)
 *       next.name = patch.name;`). The `name` type/length rule is deliberately
 *       the SAME as the asset rename (`updateSchema.name`, src/routes/assets.ts)
 *       and this router's own create `name`, so the three cannot drift.
 *     A body that violates the schema (empty or over-long `name`) is rejected by
 *       fastify-type-provider-zod with a 400 in Fastify's own validation
 *       envelope. That 400 serializes against the permissive `errorSchema`
 *       (src/routes/collections.ts:46-50 `{ error, message?, reason? }`; the
 *       comment there notes the framework's own validation 400 carries no
 *       `reason` and still serializes against it). The dialog validates
 *       client-side first so a 400 is not the normal way an operator learns the
 *       rule, but the server's own message is surfaced verbatim if one arrives
 *       (issue #958 AC2 — "the same validation error the API returns").
 *
 *   What `name` IS — a collection's `name` is projected from the live collection
 *     document into GET /api/v1/collections/ (list) and into collection hits on
 *     GET /api/v1/search/ (both read the same stored documents — the search tier
 *     has no separately-maintained name index). So renaming through this one
 *     field is what makes the new name appear in the list and in search
 *     (issue #958 AC1). The caller reloads the list after a rename; the detail
 *     pane re-renders its Name row from the collection the 200 returns.
 *
 *   What a rename does NOT touch: `id` is the store key and is never rewritten;
 *     membership (`assetIds`) is NOT accepted on this body (the `.strict()`
 *     object rejects it with a 400 — membership stays on PUT/DELETE
 *     /:id/assets/:assetId), so a rename cannot disturb a collection's members.
 *     `renameRequestBody` below is the single place the body is built, so no
 *     sibling field can be sent by accident.
 *
 *   Authorisation — `MATRIX` (src/auth/authorize.ts:54-58) grants `write` to
 *     `editor` and `admin` only; `methodToAction` (:79-93) maps PATCH -> write;
 *     `resourceAuthorizationPreHandler('collection')` (registered
 *     src/routes/collections.ts:267) applies it to this route. So a `viewer`
 *     gets a 403 `forbidden_insufficient_role`. The caller passes `canChange` as
 *     a client-side MIRROR of that rule; the 403 path below still runs, because
 *     the server is the authority.
 */

// ─── Copy deck ───────────────────────────────────────────────────────────────
//
// Frozen so a caller cannot drift the wording, and exported so a test asserts
// against the same sentences the operator sees.

export const COLLECTION_RENAME_COPY = Object.freeze({
  /** `rename.btn` — the action-row control. */
  btn: 'Rename',
  /** `rename.dialog.title` */
  dialogTitle: 'Rename collection',
  /** `rename.dialog.intro` — what a rename is, in one sentence. */
  dialogIntro:
    'The name is the collection’s title. Changing it updates the title shown ' +
    'in the collections list, in search results and on this panel.',
  /** `rename.dialog.stability` — what a rename deliberately leaves alone. */
  dialogStability:
    'The collection id and its member assets are not affected: the assets in ' +
    'this collection, and their own files and links, keep working.',
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
  errEmpty: 'Enter a name. A collection cannot have an empty name.',
  /** `rename.error.long` */
  errTooLong: 'Name is too long (maximum 256 characters).',
  /** `rename.error.unchanged` */
  errUnchanged: 'That is already the collection’s name.',
  /** `rename.error.forbidden` */
  errForbidden:
    'Your role cannot rename this collection. Ask an editor or administrator.',
  /** `rename.error.notFound` */
  errNotFound: 'This collection no longer exists. The name was not changed.',
  /** `rename.error.rejected` — a 400 the client-side rules did not catch and the
   *  API gave no message for. */
  errRejected: 'The API rejected this name. The collection was not renamed.',
  /** `rename.error.network` */
  errNetwork: 'Could not reach the API. The collection was not renamed.',
});

/** Server-enforced bounds, from the PATCH body schema (see CONTRACT GROUNDING). */
export const NAME_MIN = 1;
export const NAME_MAX = 256;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Validate what the operator typed against the server's own bounds, before any
 * request is made.
 *
 * Leading/trailing whitespace is TRIMMED: the server would store `"  promo  "`
 * as given, and the difference is invisible in every list this name is rendered
 * into. A value that is only whitespace is therefore empty, which the schema
 * (`min(1)`) refuses.
 *
 * An unchanged name is refused too — not because the API would fail (it returns
 * 200) but because it is a pointless write that bumps `updatedAt`.
 *
 * @param {unknown} raw          the raw input value
 * @param {unknown} currentName  the collection's current `name`
 * @returns {{ value: string, ok: boolean, reason: 'empty'|'too-long'|'unchanged'|null, message: string|null }}
 */
export function normaliseRenameInput(raw, currentName) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const current = typeof currentName === 'string' ? currentName.trim() : '';
  if (value.length < NAME_MIN) {
    return { value, ok: false, reason: 'empty', message: COLLECTION_RENAME_COPY.errEmpty };
  }
  if (value.length > NAME_MAX) {
    return { value, ok: false, reason: 'too-long', message: COLLECTION_RENAME_COPY.errTooLong };
  }
  if (value === current) {
    return { value, ok: false, reason: 'unchanged', message: COLLECTION_RENAME_COPY.errUnchanged };
  }
  return { value, ok: true, reason: null, message: null };
}

/**
 * Build the JSON body for `PATCH /api/v1/collections/{id}`.
 *
 * EXACTLY one key. The schema also accepts `description`, `tags` and `custom`; a
 * rename must send none of them, because each one is a real write to a field
 * this action does not own. Membership (`assetIds`) is not even accepted — the
 * body is `.strict()`. Keeping the body construction in one exported function is
 * what makes that assertable.
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
 * `400` (schema violation) and `403` (role gate) are both reachable. `400` is
 * declared on this operation; its body serializes against the permissive
 * `errorSchema` and may carry a human `message` (which `apiFetch` surfaces as
 * `err.message`). Issue #958 AC2 asks that "the same validation error the API
 * returns" reach the operator, so when the API supplied a message for a 400 it
 * is shown verbatim; only a message-less 400 falls back to house copy. `422` is
 * NOT declared on this operation but is handled defensively alongside 400.
 *
 * @param {{status?: number, message?: string, body?: any}} err  an apiFetch rejection
 * @returns {{kind: 'forbidden'|'not-found'|'rejected'|'other', message: string, dismiss: boolean}}
 */
export function classifyRenameError(err) {
  const e = err || {};
  switch (e.status) {
    case 403:
    case 401:
      return { kind: 'forbidden', message: COLLECTION_RENAME_COPY.errForbidden, dismiss: false };
    case 404:
      // Terminal for this dialog: there is nothing left to rename.
      return { kind: 'not-found', message: COLLECTION_RENAME_COPY.errNotFound, dismiss: true };
    case 400:
    case 422: {
      // Surface the API's own validation message when it gave one (AC2); fall
      // back to house copy only when the body carried none.
      const apiMsg =
        (e.body && typeof e.body.message === 'string' && e.body.message) ||
        (typeof e.message === 'string' && e.message) ||
        '';
      const message = apiMsg && !/^HTTP\s/.test(apiMsg) ? apiMsg : COLLECTION_RENAME_COPY.errRejected;
      return { kind: 'rejected', message, dismiss: false };
    }
    default:
      // Transport failure, 5xx, or anything else undeclared: one honest
      // sentence that states the outcome (nothing changed).
      return { kind: 'other', message: COLLECTION_RENAME_COPY.errNetwork, dismiss: false };
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
 * `.msg.msg-error`) exactly as the asset rename dialog does — no new dialog
 * primitive is introduced for this action.
 *
 * @param {HTMLElement} body        the modal body element
 * @param {{ currentName?: string }} opts
 * @returns {{ input: HTMLInputElement, errorEl: HTMLElement, submitBtn: HTMLElement, cancelBtn: HTMLElement }}
 */
export function buildRenameForm(body, opts) {
  const o = opts || {};
  body.classList.add('rename-dialog');

  body.appendChild(el('p', 'rename-dialog-intro', COLLECTION_RENAME_COPY.dialogIntro));
  body.appendChild(el('p', 'rename-dialog-stability', COLLECTION_RENAME_COPY.dialogStability));

  const field = el('div', 'form-field grow mt12');
  const label = el('label', null, COLLECTION_RENAME_COPY.fieldLabel);
  label.setAttribute('for', 'coll-rename-name');

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'coll-rename-name';
  input.maxLength = NAME_MAX;
  // Prefill is collection-controlled text assigned through `value`, never markup.
  input.value = typeof o.currentName === 'string' ? o.currentName : '';

  const help = el('div', 'text-muted rename-field-help', COLLECTION_RENAME_COPY.fieldHelp);
  help.id = 'coll-rename-name-help';
  input.setAttribute('aria-describedby', help.id);

  field.appendChild(label);
  field.appendChild(input);
  field.appendChild(help);
  body.appendChild(field);

  // Inline error area — every refusal keeps the dialog OPEN and writes here,
  // so the operator does not lose what they typed. Never an `alert()`.
  const errorEl = el('div', 'msg msg-error rename-dialog-error');
  errorEl.id = 'coll-rename-dialog-error';
  errorEl.setAttribute('role', 'alert');
  errorEl.style.display = 'none';
  body.appendChild(errorEl);

  const actions = el('div', 'modal-actions');
  const cancelBtn = el('button', 'btn-sm rename-cancel', COLLECTION_RENAME_COPY.btnCancel);
  cancelBtn.type = 'button';
  const submitBtn = el('button', 'btn-sm rename-submit', COLLECTION_RENAME_COPY.btnSave);
  submitBtn.type = 'button';
  submitBtn.id = 'coll-rename-submit';
  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  body.appendChild(actions);

  return { input, errorEl, submitBtn, cancelBtn };
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Add the "Rename" control to the collection detail action row and wire its
 * dialog.
 *
 * No control is rendered when `canChange` is false (a viewer), mirroring the
 * asset rename.
 *
 * @param {object} opts
 * @param {object}      opts.collection  collection from GET /api/v1/collections/{id}
 * @param {HTMLElement} opts.actionsRow  the `.flex-gap` action row to join
 * @param {HTMLElement} [opts.beforeEl]  element in that row to insert before
 * @param {boolean}     opts.canChange   client-role mirror of the ADR-018 matrix
 * @param {Function}    opts.apiFetch
 * @param {Function}    opts.openModal
 * @param {Function}    [opts.showMsg]   house message renderer (host, text, kind)
 * @param {() => HTMLElement} [opts.messageHost]  resolves the message element
 * @param {(collection: object|null, message: string) => any} opts.onRenamed
 *        called after a successful rename (or a 404). The updated collection is
 *        passed through because the 200 carries the stored document — the pane
 *        re-renders its Name from it rather than from what was typed.
 * @returns {{ button: HTMLElement|null, open: (() => void)|null }}
 */
export function mountCollectionRename(opts) {
  const o = opts || {};
  const collection = o.collection || {};
  const actionsRow = o.actionsRow;

  if (!o.canChange) {
    return { button: null, open: null };
  }

  const btn = el('button', 'btn-ghost', COLLECTION_RENAME_COPY.btn);
  btn.type = 'button';
  btn.id = 'btn-rename-collection';
  if (actionsRow) {
    if (o.beforeEl && o.beforeEl.parentNode === actionsRow) {
      actionsRow.insertBefore(btn, o.beforeEl);
    } else {
      actionsRow.appendChild(btn);
    }
  }

  const path = '/collections/' + encodeURIComponent(String(collection.id));

  function reportToActionArea(text, kind) {
    if (typeof o.showMsg !== 'function') return;
    const host = typeof o.messageHost === 'function' ? o.messageHost() : null;
    if (host) o.showMsg(host, text, kind || 'error');
  }

  function open() {
    // Held so the field can be focused AFTER openModal attaches the backdrop —
    // the body builder runs while the dialog is still detached, and focus() on a
    // detached element is a no-op (the asset rename dialog's rule).
    let firstField = null;
    o.openModal(COLLECTION_RENAME_COPY.dialogTitle, function (body, closeDialog) {
      const form = buildRenameForm(body, { currentName: collection.name });
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
        const check = normaliseRenameInput(form.input.value, collection.name);
        if (!check.ok) {
          showError(check.message);
          return;
        }

        const prev = form.submitBtn.textContent;
        form.submitBtn.disabled = true;
        form.cancelBtn.disabled = true;
        form.submitBtn.textContent = COLLECTION_RENAME_COPY.busyLabel;
        try {
          const updated = await o.apiFetch(path, {
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
          const c = classifyRenameError(err);
          if (c.dismiss) {
            closeDialog();
            await o.onRenamed(null, c.message);
            return;
          }
          if (c.kind === 'forbidden' && btn.parentNode) {
            // A control known to fail stops being offered for the rest of this
            // view of the collection (the asset rename's 403 rule).
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
