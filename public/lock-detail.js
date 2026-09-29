/**
 * open-videocore ops dashboard — lock-detail.js
 *
 * Surface B of the delete-lock feature: the asset DETAIL view's "Delete
 * protection" block and its two write actions (issue #895, implementing
 * docs/ux/asset-lock-state-spec.md §4 and §7).
 *
 * State derivation and the shared copy constants are NOT re-derived here — they
 * are imported from public/lock-state.js (issue #894), which the spec's §10
 * acceptance checklist requires to be the single home for `lockStateOf`.
 *
 * Everything operator-visible in this module is written with `textContent` or
 * `createElement`. `deleteLock.reason` and `deleteLock.lockedBy` are free text
 * chosen by whoever set the lock (up to 1024 / 256 characters), so they never
 * touch `innerHTML`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's generated spec and route source on this branch. Nothing
 * is taken from the issue text.
 *
 *   Set the lock — `openapi.json .paths["/api/v1/assets/{id}/lock"].put`
 *     requestBody: `required: true`, `application/json`, schema
 *       { reason?: string (maxLength 1024), lockedBy?: string (maxLength 256) },
 *       `additionalProperties: false`, `default: {}`
 *     parameters: exactly one — path `id` (string, required). No query params.
 *     responses: exactly `200` (the FULL asset) and `404`
 *       (`{ error: string, message?: string }`, required `error`).
 *     Source of truth: `app.put('/:id/lock', …)`, src/routes/assets.ts:5575-5601
 *       — body `z.object({ reason: z.string().max(1024).optional(),
 *         lockedBy: z.string().max(256).optional() }).default({})`,
 *         `response: { 200: assetSchema, 404: errorSchema }`.
 *
 *   Clear the lock — `openapi.json .paths["/api/v1/assets/{id}/lock"].delete`
 *     No requestBody, no query params, one path parameter `id`.
 *     responses: exactly `200` (the FULL asset) and `404`.
 *     Source of truth: `app.delete('/:id/lock', …)`, src/routes/assets.ts:5609-5623.
 *
 *   The lock object both responses carry —
 *     `…put.responses["200"].content["application/json"].schema.properties.deleteLock`
 *     = { locked: boolean, reason?: string, lockedAt: string, lockedBy?: string },
 *       `required: ["locked", "lockedAt"]`, `additionalProperties: false`.
 *     Identical on `paths["/api/v1/assets/{id}"].get` (the detail read this block
 *     renders from), whose declared responses are `200`, `404`, `410`.
 *     Source of truth: `deleteLockSchema` src/routes/assets.ts:528-533, used at
 *     `assetSchema.deleteLock` :838; TS type `DeleteLock`
 *     src/data/asset-repo.ts:441-446 on `Asset.deleteLock?` :470.
 *
 *   Re-lock is an OVERWRITE, not a patch — `applyDeleteLock`,
 *     src/data/asset-repo.ts:1062-1087, builds a fresh lock unconditionally,
 *     refreshes `lockedAt` to now and replaces `reason`/`lockedBy`. Hence the
 *     explicit warning line on the edit dialog (spec §4.3).
 *
 *   Unlock REMOVES the field — same function, :1083-1086, returns
 *     `deleteLock: undefined`. Never `locked: false`. This module therefore only
 *     ever asks lock-state.js for the state; it never inspects the field itself.
 *
 *   Authorisation — there is no scope/claim model in this codebase and no
 *     capability endpoint (a scan of `openapi.json` for `/me`, `auth`, `role`,
 *     `capabilities`, `session` finds nothing). Authorisation is the ADR-018
 *     role×action matrix, `MATRIX` in src/auth/authorize.ts:54-58
 *     (`viewer: { read, write: false, delete: false }`,
 *      `editor`/`admin`: all true), applied by
 *     `resourceAuthorizationPreHandler('asset')` (src/auth/authorize.ts:126,
 *     registered src/routes/assets.ts:1718) with the action derived from the
 *     HTTP method by `methodToAction` (:79-93): PUT → `write`, DELETE →
 *     `delete`. So both operations below require `editor` or `admin`; a
 *     `viewer` is refused with 403 `AUTHZ_FORBIDDEN_ERROR` =
 *     `'forbidden_insufficient_role'` (src/auth/authorize.ts:99). The caller
 *     passes `canChange` (the UI's client-role mirror) and this module ALSO
 *     handles the 403 when it arrives anyway — the mirror is advisory, the
 *     server is authoritative.
 *
 *   PROVENANCE — the issue's acceptance criterion asks each action to "record
 *     the provenance entry format confirmed in the contract sub-issue". No such
 *     client-supplied format exists in the contract:
 *       * `applyDeleteLock` appends the provenance entry itself, server-side and
 *         unconditionally — `{ at: now, by: 'user', op: 'lock',
 *         detail: input.reason }` (src/data/asset-repo.ts:1076-1080) and
 *         `{ at: now, by: 'user', op: 'unlock' }` (:1085). The client cannot
 *         shape, name or address it; the only part it influences is `detail`,
 *         which is exactly the optional `reason` this module sends.
 *       * Nothing reads it back: `assetSchema` (src/routes/assets.ts:811-887)
 *         has NO `provenance` property, and `provenance` is absent from the
 *         `GET /api/v1/assets/{id}` 200 properties in `openapi.json`
 *         (verified key list: audioTracks, createdAt, deleteLock, description,
 *         id, manifestUrls, metadata, name, objectKey, packagingError, parentId,
 *         renditions, reviewState, sceneDetectionError, sceneMetadata, slug,
 *         status, statusHistory, storageTiering, subtitleTracks, tags,
 *         technicalMetadata, technicalMetadataError, thumbnails, updatedAt,
 *         versionGroupId, versionOfAssetId).
 *       * Neither lock handler emits an audit entry (src/routes/assets.ts:5591-5601,
 *         :5617-5623), unlike restore (:5677).
 *     These are gaps H4/H5 in the spec §9. This module therefore renders the
 *     CURRENT lock only, never a history timeline, and its copy never claims an
 *     audit trail (spec §1 copy rule 2).
 */

import { LOCK_LOCKED, LOCK_UNKNOWN, lockStateOf } from './lock-state.js';

// ─── Copy deck (spec §7, detail rows) ────────────────────────────────────────
//
// Verbatim from docs/ux/asset-lock-state-spec.md §7. Frozen so a caller cannot
// drift the wording, and exported so #896's blocked-delete flow can reuse the
// same sentences instead of retyping them.

export const LOCK_DETAIL_COPY = Object.freeze({
  /** `lock.detail.heading` */
  heading: 'Delete protection',
  /** `lock.detail.unlocked` */
  unlocked:
    'Not locked. This asset can be archived, subject to the other checks ' +
    '(running jobs, child assets, collection membership).',
  /** `lock.detail.reason.none` */
  reasonNone: 'No reason recorded.',
  /** `lock.detail.consequence` */
  consequence:
    'Archiving this asset is refused while the lock is set. The lock cannot be forced.',
  /** `lock.detail.unavailable` */
  unavailable: 'Lock state unavailable.',
  /** `lock.btn.lock` */
  btnLock: 'Lock',
  /** `lock.btn.unlock` */
  btnUnlock: 'Unlock',
  /** `lock.btn.edit` */
  btnEdit: 'Edit lock note',
  /** `lock.dialog.lock.title` */
  dialogLockTitle: 'Lock asset',
  /** `lock.dialog.lock.intro` */
  dialogLockIntro:
    "Locking prevents this asset from being archived until the lock is cleared. " +
    "It does not change the asset's status and does not move or delete any files.",
  /** `lock.field.reason.label` */
  reasonLabel: 'Reason (optional)',
  /** `lock.field.reason.placeholder` */
  reasonPlaceholder: 'Why this asset must not be deleted',
  /** `lock.field.reason.help` */
  reasonHelp: 'Up to 1024 characters.',
  /** `lock.field.lockedBy.label` */
  lockedByLabel: 'Locked by (optional)',
  /** `lock.field.lockedBy.placeholder` */
  lockedByPlaceholder: 'Who or what is asking for the lock',
  /** `lock.field.lockedBy.help` */
  lockedByHelp:
    'A free-text label, up to 256 characters. It is not verified against your identity.',
  /** `lock.dialog.edit.warning` */
  dialogEditWarning:
    'Saving replaces the current reason and "locked by" label, and resets the lock timestamp to now.',
  /** `lock.dialog.unlock.title` */
  dialogUnlockTitle: 'Clear delete lock',
  /** `lock.dialog.unlock.affected.1` */
  unlockAffected1:
    'This asset becomes archivable again. Anyone who can archive an asset can then archive it.',
  /** `lock.dialog.unlock.affected.2` */
  unlockAffected2:
    'The reason and "locked by" label recorded with the lock are discarded, not kept as history.',
  /** `lock.dialog.unlock.unaffected.1` */
  unlockUnaffected1:
    "Nothing is deleted or moved. The asset's status, files, renditions and metadata are untouched.",
  /** `lock.dialog.unlock.unaffected.2` */
  unlockUnaffected2: 'Other assets and collections keep their own locks.',
  /** `lock.result.locked` */
  resultLocked: 'Asset locked.',
  /** `lock.result.unlocked` */
  resultUnlocked: 'Delete lock cleared.',
  /** `lock.error.forbidden` — also reused as the pre-emptive role-gate note. */
  errForbidden:
    'Your role cannot change the delete lock on this asset. Ask an editor or administrator.',
  /** `lock.error.reason.long` */
  errReasonLong: 'Reason is too long (maximum 1024 characters).',
  /** `lock.error.lockedBy.long` */
  errLockedByLong: '"Locked by" is too long (maximum 256 characters).',
  /** `lock.error.notFound` */
  errNotFound: 'This asset no longer exists.',
  /** `lock.error.network` */
  errNetwork: 'Could not reach the API. The lock was not changed.',
});

/** Server-enforced caps, from the PUT body schema (see CONTRACT GROUNDING). */
export const REASON_MAX = 1024;
export const LOCKED_BY_MAX = 256;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * The status line(s) for a locked asset (spec §4.2 table). Returns raw strings —
 * the caller renders them with `textContent`, never `innerHTML`.
 *
 * `lockedAt` is `required` on the lock schema, so it is always formatted;
 * `lockedBy` and `reason` are each independently optional and each has its own
 * sentence. There is deliberately no placeholder actor: `lockedBy` is a
 * free-text label the caller chose, not a resolved identity, so a missing value
 * is silence rather than "unknown user".
 *
 * @param {{locked?: boolean, reason?: string, lockedAt?: string, lockedBy?: string}} deleteLock
 * @param {(v: string) => string} fmtDate  the app's date formatter (spec §1 rule 4)
 * @returns {{ statusLine: string, reasonLine: string, reasonIsValue: boolean }}
 */
export function lockStatusLines(deleteLock, fmtDate) {
  const lock = deleteLock || {};
  const when = typeof fmtDate === 'function' ? fmtDate(lock.lockedAt) : String(lock.lockedAt);
  const by = typeof lock.lockedBy === 'string' && lock.lockedBy !== '' ? lock.lockedBy : null;
  const reason = typeof lock.reason === 'string' && lock.reason !== '' ? lock.reason : null;
  return {
    statusLine: by ? 'Locked by ' + by + ' on ' + when + '.' : 'Locked on ' + when + '.',
    reasonLine: reason ? 'Reason: ' + reason : LOCK_DETAIL_COPY.reasonNone,
    reasonIsValue: reason !== null,
  };
}

/**
 * Build the JSON body for `PUT /:id/lock`.
 *
 * ALWAYS an object, `{}` when both fields are blank: `requestBody.required` is
 * `true` on this operation even though every property is optional, so a
 * body-less PUT is rejected with a 400 before the handler runs (spec gap H7).
 * Blank fields are omitted rather than sent as `""` — the schema strips unknown
 * keys but happily stores an empty string as a "reason".
 *
 * @param {{reason?: string, lockedBy?: string}} input
 * @returns {{reason?: string, lockedBy?: string}}
 */
export function lockRequestBody(input) {
  const src = input || {};
  const body = {};
  const reason = typeof src.reason === 'string' ? src.reason.trim() : '';
  const lockedBy = typeof src.lockedBy === 'string' ? src.lockedBy.trim() : '';
  if (reason !== '') body.reason = reason;
  if (lockedBy !== '') body.lockedBy = lockedBy;
  return body;
}

/**
 * Classify a failed lock/unlock request into the treatments of spec §4.4.
 *
 * `400` and `403` are BOTH reachable on these routes and NEITHER is declared in
 * `openapi.json` (only `200` and `404` are — gap H3), so nothing here may assume
 * a modelled body. The 400 arrives in Fastify's own validation envelope
 * `{ statusCode, code: 'FST_ERR_VALIDATION', error, message }` — not the API's
 * `{ error, message? }` — so the field is identified from the message text and
 * falls back to a whole-form error when it cannot be read.
 *
 * @param {{status?: number, message?: string, body?: any}} err  an apiFetch rejection
 * @returns {{kind: 'forbidden'|'too-long'|'not-found'|'other', field: 'reason'|'lockedBy'|null, message: string}}
 */
export function classifyLockError(err) {
  const e = err || {};
  const status = e.status;
  if (status === 403) {
    return { kind: 'forbidden', field: null, message: LOCK_DETAIL_COPY.errForbidden };
  }
  if (status === 404) {
    return { kind: 'not-found', field: null, message: LOCK_DETAIL_COPY.errNotFound };
  }
  if (status === 400) {
    const text = String((e.body && e.body.message) || e.message || '');
    if (/lockedby/i.test(text)) {
      return { kind: 'too-long', field: 'lockedBy', message: LOCK_DETAIL_COPY.errLockedByLong };
    }
    if (/reason/i.test(text)) {
      return { kind: 'too-long', field: 'reason', message: LOCK_DETAIL_COPY.errReasonLong };
    }
    // A 400 we cannot attribute to a field: report it, do not guess a field.
    return { kind: 'other', field: null, message: LOCK_DETAIL_COPY.errNetwork };
  }
  // Transport failure, 5xx, or anything else undeclared: one honest sentence
  // that states the outcome (nothing changed) rather than a status line.
  return { kind: 'other', field: null, message: LOCK_DETAIL_COPY.errNetwork };
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * The "Delete protection" block (spec §4.1, §4.2). Text only — the UI has no
 * icon set and the lock must not introduce one (spec §6).
 *
 * Renders in BOTH states: unlike Restore (hidden unless archived), lock state is
 * always meaningful, and an always-present block is where an operator learns the
 * feature exists.
 *
 * @param {object} asset      the asset as returned by GET /api/v1/assets/{id}
 * @param {object} opts
 * @param {(v: string) => string} opts.fmtDate
 * @param {boolean} [opts.projectionCarriesLock]  forwarded to lockStateOf
 * @returns {{ block: HTMLElement, noteId: string, state: string }}
 */
export function renderLockBlock(asset, opts) {
  const o = opts || {};
  const state = lockStateOf(asset, { projectionCarriesLock: o.projectionCarriesLock !== false });

  const block = el('div', 'mt12 lock-block');
  block.id = 'delete-protection';
  // `.section-title` is the house heading for a detail-panel block (cf. "Status
  // history", public/app.js:1996). A text heading, no glyph (spec §6).
  const heading = el('div', 'section-title', LOCK_DETAIL_COPY.heading);
  block.appendChild(heading);

  const note = el('div', 'mt8 text-muted lock-state-note');
  note.id = 'lock-state-note';
  note.style.fontSize = '12px';

  if (state === LOCK_UNKNOWN) {
    // Only reachable if a caller hands this block an asset from a projection
    // that does not carry `deleteLock`. GET /assets/{id} does carry it, so on
    // the detail surface this means a contract regression — say so rather than
    // guessing a state (spec §4.2, copy rule 3).
    note.appendChild(el('div', null, LOCK_DETAIL_COPY.unavailable));
    block.appendChild(note);
    return { block, noteId: note.id, state };
  }

  if (state === LOCK_LOCKED) {
    const lines = lockStatusLines(asset.deleteLock, o.fmtDate);
    note.appendChild(el('div', 'lock-status-line', lines.statusLine));
    const reasonEl = el('div', 'lock-reason', lines.reasonLine);
    // Free operator text, clamped to three lines in CSS with the full value in
    // the tooltip. `title` is set as an attribute value through the DOM API, so
    // it is never parsed as markup.
    if (lines.reasonIsValue) reasonEl.title = String(asset.deleteLock.reason);
    note.appendChild(reasonEl);
    note.appendChild(el('div', 'lock-consequence', LOCK_DETAIL_COPY.consequence));
  } else {
    note.appendChild(el('div', null, LOCK_DETAIL_COPY.unlocked));
  }

  block.appendChild(note);
  return { block, noteId: note.id, state };
}

// ─── The lock form (spec §4.3) ───────────────────────────────────────────────
//
// `confirmModal` takes no inputs, so the lock and edit dialogs use `openModal`
// directly. The unlock dialog DOES use `confirmModal`, because it is the house
// destructive-confirmation primitive and its affected/unaffected structure is
// exactly what the spec asks for.

function buildLockForm(body, opts) {
  const o = opts || {};
  body.appendChild(el('p', 'lock-dialog-intro', LOCK_DETAIL_COPY.dialogLockIntro));

  if (o.editWarning) {
    const warn = el('p', 'lock-dialog-warning', LOCK_DETAIL_COPY.dialogEditWarning);
    warn.id = 'lock-edit-warning';
    body.appendChild(warn);
  }

  const reasonField = el('div', 'form-field grow mt12');
  const reasonLabel = el('label', null, LOCK_DETAIL_COPY.reasonLabel);
  reasonLabel.setAttribute('for', 'lock-reason');
  const reason = document.createElement('textarea');
  reason.id = 'lock-reason';
  reason.rows = 3;
  reason.maxLength = REASON_MAX;
  reason.placeholder = LOCK_DETAIL_COPY.reasonPlaceholder;
  // Prefill is asset-controlled text assigned through `value`, never markup.
  reason.value = o.reason || '';
  const reasonHelp = el('div', 'text-muted lock-field-help', LOCK_DETAIL_COPY.reasonHelp);
  reasonHelp.id = 'lock-reason-help';
  reason.setAttribute('aria-describedby', reasonHelp.id);
  reasonField.appendChild(reasonLabel);
  reasonField.appendChild(reason);
  reasonField.appendChild(reasonHelp);
  body.appendChild(reasonField);

  const byField = el('div', 'form-field grow mt8');
  const byLabel = el('label', null, LOCK_DETAIL_COPY.lockedByLabel);
  byLabel.setAttribute('for', 'lock-locked-by');
  const by = document.createElement('input');
  by.type = 'text';
  by.id = 'lock-locked-by';
  by.maxLength = LOCKED_BY_MAX;
  by.placeholder = LOCK_DETAIL_COPY.lockedByPlaceholder;
  by.value = o.lockedBy || '';
  const byHelp = el('div', 'text-muted lock-field-help', LOCK_DETAIL_COPY.lockedByHelp);
  byHelp.id = 'lock-locked-by-help';
  by.setAttribute('aria-describedby', byHelp.id);
  byField.appendChild(byLabel);
  byField.appendChild(by);
  byField.appendChild(byHelp);
  body.appendChild(byField);

  // Inline error area — the 400 and 403 paths keep the dialog OPEN and write
  // here (spec §4.4); neither is ever an `alert()`.
  const errorEl = el('div', 'msg msg-error lock-dialog-error');
  errorEl.id = 'lock-dialog-error';
  errorEl.setAttribute('role', 'alert');
  errorEl.style.display = 'none';
  body.appendChild(errorEl);

  const actions = el('div', 'modal-actions');
  const cancelBtn = el('button', 'btn-sm lock-cancel', 'Cancel');
  cancelBtn.type = 'button';
  const submitBtn = el('button', 'btn-sm lock-submit', LOCK_DETAIL_COPY.btnLock);
  submitBtn.type = 'button';
  submitBtn.id = 'lock-submit';
  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  body.appendChild(actions);

  return { reason, lockedBy: by, errorEl, submitBtn, cancelBtn };
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Render the "Delete protection" block and wire its controls.
 *
 * The block is inserted immediately before the detail view's action row, and
 * the buttons join that row so every asset action stays on one line — Lock
 * first among the always-present actions, because it gates the destructive one
 * (spec §4.1).
 *
 * @param {object} opts
 * @param {object}      opts.asset       asset from GET /api/v1/assets/{id}
 * @param {HTMLElement} opts.actionsRow  the `.mt12.flex-gap` action row
 * @param {HTMLElement} [opts.beforeEl]  element in that row to insert before
 * @param {boolean}     opts.canChange   client-role mirror of the ADR-018 matrix
 * @param {(v:string)=>string} opts.fmtDate
 * @param {Function}    opts.apiFetch
 * @param {Function}    opts.openModal
 * @param {Function}    opts.confirmModal
 * @param {Function}    opts.showMsg
 * @param {() => HTMLElement} opts.messageHost  resolves the #action-msg element
 * @param {(asset: object|null, message: string) => any} opts.onChanged
 *        called after a successful write (or a 404) so the caller can re-read
 *        the asset and report the outcome. The updated asset is passed through
 *        because BOTH operations return the full asset on 200 and re-rendering
 *        from it is the only way the UI learns the server-generated `lockedAt`
 *        and notices a silently dropped body key (spec §4.4, gap H6).
 * @returns {{ block: HTMLElement, state: string, buttons: HTMLElement[] }}
 */
export function mountDeleteProtection(opts) {
  const o = opts || {};
  const asset = o.asset || {};
  const rendered = renderLockBlock(asset, {
    fmtDate: o.fmtDate,
    projectionCarriesLock: o.projectionCarriesLock,
  });
  const actionsRow = o.actionsRow;

  if (actionsRow && actionsRow.parentNode) {
    actionsRow.parentNode.insertBefore(rendered.block, actionsRow);
  }

  const buttons = [];
  // L0 offers no controls at all: an action whose precondition is unknown must
  // not be offered (spec §4.2).
  if (rendered.state === LOCK_UNKNOWN) {
    return { block: rendered.block, state: rendered.state, buttons };
  }

  const locked = rendered.state === LOCK_LOCKED;

  if (!o.canChange) {
    // Pre-emptive gate on the ADR-018 role matrix mirrored client-side
    // (src/auth/authorize.ts:54-58: only editor and admin hold `write` and
    // `delete`). The server is still the authority — the 403 path below runs
    // regardless — but offering a control that is known to fail is worse than
    // explaining why it is absent. Reuses the §7 403 sentence rather than
    // inventing new copy.
    const gate = el('div', 'text-muted lock-role-note', LOCK_DETAIL_COPY.errForbidden);
    gate.id = 'lock-role-note';
    gate.style.fontSize = '12px';
    rendered.block.querySelector('#lock-state-note').appendChild(gate);
    return { block: rendered.block, state: rendered.state, buttons };
  }

  function makeBtn(id, label) {
    const btn = el('button', 'btn-ghost', label);
    btn.type = 'button';
    btn.id = id;
    // Points at the state text above, following the existing restore-note
    // pattern, so the control announces what it acts on (spec §8).
    btn.setAttribute('aria-describedby', rendered.noteId);
    if (actionsRow) {
      if (o.beforeEl && o.beforeEl.parentNode === actionsRow) {
        actionsRow.insertBefore(btn, o.beforeEl);
      } else {
        actionsRow.appendChild(btn);
      }
    }
    buttons.push(btn);
    return btn;
  }

  const primaryBtn = makeBtn(
    locked ? 'btn-unlock-asset' : 'btn-lock-asset',
    locked ? LOCK_DETAIL_COPY.btnUnlock : LOCK_DETAIL_COPY.btnLock
  );
  const editBtn = locked ? makeBtn('btn-edit-lock-note', LOCK_DETAIL_COPY.btnEdit) : null;

  function retireControls() {
    // A control known to fail stops being offered for the rest of this view of
    // the asset (spec §4.4, 403 row).
    buttons.forEach(function (b) {
      if (b.parentNode) b.parentNode.removeChild(b);
    });
  }

  function reportToActionArea(text, kind) {
    if (typeof o.showMsg !== 'function') return;
    const host = typeof o.messageHost === 'function' ? o.messageHost() : null;
    if (host) o.showMsg(host, text, kind || 'error');
  }

  const lockPath = '/assets/' + encodeURIComponent(asset.id) + '/lock';

  function openLockForm(mode) {
    // Held so the first field can be focused AFTER openModal attaches the
    // backdrop — the body builder runs while the dialog is still detached, and
    // focus() on a detached element is a no-op.
    let firstField = null;
    o.openModal(
      mode === 'edit' ? LOCK_DETAIL_COPY.btnEdit : LOCK_DETAIL_COPY.dialogLockTitle,
      function (body, closeDialog) {
        const lock = (mode === 'edit' && asset.deleteLock) || {};
        const form = buildLockForm(body, {
          editWarning: mode === 'edit',
          reason: lock.reason,
          lockedBy: lock.lockedBy,
        });
        firstField = form.reason;

        form.cancelBtn.addEventListener('click', function () {
          closeDialog();
        });

        form.submitBtn.addEventListener('click', async function () {
          form.errorEl.style.display = 'none';
          form.errorEl.textContent = '';
          const prev = form.submitBtn.textContent;
          form.submitBtn.disabled = true;
          form.submitBtn.textContent = 'Saving…';
          try {
            const updated = await o.apiFetch(lockPath, {
              method: 'PUT',
              // Always a body, `{}` when both fields are blank (gap H7).
              body: JSON.stringify(
                lockRequestBody({ reason: form.reason.value, lockedBy: form.lockedBy.value })
              ),
            });
            closeDialog();
            await o.onChanged(updated, LOCK_DETAIL_COPY.resultLocked);
            return;
          } catch (err) {
            const c = classifyLockError(err);
            if (c.kind === 'not-found') {
              closeDialog();
              await o.onChanged(null, c.message);
              return;
            }
            if (c.kind === 'forbidden') retireControls();
            form.errorEl.textContent = c.message;
            form.errorEl.style.display = '';
            if (c.field === 'reason') form.reason.focus();
            if (c.field === 'lockedBy') form.lockedBy.focus();
          } finally {
            // Never leave the button in its pending state (spec §4.4).
            form.submitBtn.disabled = false;
            form.submitBtn.textContent = prev;
          }
        });
      }
    );
    if (firstField) firstField.focus();
  }

  if (locked) {
    primaryBtn.addEventListener('click', async function () {
      const ok = await o.confirmModal({
        title: LOCK_DETAIL_COPY.dialogUnlockTitle,
        subject: asset.name || asset.slug || asset.id,
        question:
          'Clear the delete lock on "' + (asset.name || asset.slug || asset.id) + '"?',
        confirmLabel: LOCK_DETAIL_COPY.btnUnlock,
        affected: [LOCK_DETAIL_COPY.unlockAffected1, LOCK_DETAIL_COPY.unlockAffected2],
        unaffected: [LOCK_DETAIL_COPY.unlockUnaffected1, LOCK_DETAIL_COPY.unlockUnaffected2],
      });
      if (!ok) return;
      const prev = primaryBtn.textContent;
      primaryBtn.disabled = true;
      primaryBtn.textContent = 'Unlocking…';
      try {
        // No body and no query parameters on this operation (see CONTRACT
        // GROUNDING); `?force=…` is a DELETE /assets/{id} parameter and has no
        // meaning here.
        const updated = await o.apiFetch(lockPath, { method: 'DELETE' });
        await o.onChanged(updated, LOCK_DETAIL_COPY.resultUnlocked);
        return;
      } catch (err) {
        const c = classifyLockError(err);
        if (c.kind === 'not-found') {
          await o.onChanged(null, c.message);
          return;
        }
        if (c.kind === 'forbidden') retireControls();
        reportToActionArea(c.message, 'error');
      } finally {
        if (primaryBtn.parentNode) {
          primaryBtn.disabled = false;
          primaryBtn.textContent = prev;
        }
      }
    });
    if (editBtn) {
      editBtn.addEventListener('click', function () {
        openLockForm('edit');
      });
    }
  } else {
    primaryBtn.addEventListener('click', function () {
      openLockForm('lock');
    });
  }

  return { block: rendered.block, state: rendered.state, buttons };
}
