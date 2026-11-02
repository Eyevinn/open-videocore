/**
 * open-videocore ops dashboard — collection-edit.js
 *
 * The collection DETAIL view's "Edit metadata" action (issue #862): the
 * affordance for the three descriptive fields `PATCH /api/v1/collections/{id}`
 * has accepted since issue #560 but which nothing in this UI could ever set —
 * the Collections tab could only Create (name only), View, Delete and add or
 * remove members, so a collection's `description`, `tags` and `custom` were
 * write-once-at-create-time at best, and in practice unreachable from the UI.
 *
 * UI ONLY. No route, schema or response shape is changed by this module.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's route source and generated spec on this branch; nothing
 * is taken from the issue text.
 *
 *   The write — `openapi.json .paths["/api/v1/collections/{id}"].patch`
 *     parameters: exactly one — path `id` (string, required). No query params.
 *     requestBody (`required: true`) schema properties: `name` (string,
 *       minLength 1, maxLength 256), `description` (string), `tags`
 *       (array<string>), `custom` (object, `additionalProperties: {}`);
 *       `additionalProperties: false`. Every property optional.
 *     responses: exactly `200` (the collection — `id`, `name`, `assetIds`,
 *       `createdAt`, `updatedAt` required, plus optional `description`, `tags`,
 *       `custom`, `deleteLock`), `400` and `404`.
 *     Source of truth: `updateBodySchema`, src/routes/collections.ts:250-263 —
 *       `description: z.string().optional()` (:259),
 *       `tags: z.array(z.string()).optional()` (:260),
 *       `custom: z.record(z.unknown()).optional()` (:261), inside `.strict()`
 *       (:263). Wired at `app.patch('/:id', …)` src/routes/collections.ts:423-444
 *       with `response: { 200: collectionSchema, 400: errorSchema,
 *       404: errorSchema }` (:429).
 *
 *   Replace-wholesale semantics, stated by the schema comment and enforced by the
 *     repository: "every present key is applied wholesale, an absent key leaves
 *     the current value untouched, and an explicit empty value (`''`/`[]`/`{}`)
 *     clears an optional field" (src/routes/collections.ts:241-249).
 *     `applyCollectionUpdate` (src/data/collection-repo.ts) assigns only the keys
 *     the patch carries and never touches `assetIds` or `deleteLock`. So `tags`
 *     is NOT append-only on this endpoint: the array sent IS the new array, which
 *     is why this form edits the whole list and a removal is just a shorter array.
 *
 *   `assetIds` CANNOT be sent, and this module never builds it: the body is
 *     `.strict()`, so membership (and `deleteLock`) are rejected with a 400 "so
 *     callers cannot smuggle a membership mutation through the metadata endpoint"
 *     (src/routes/collections.ts:245-249). Membership stays on
 *     PUT/DELETE /:id/assets/:assetId — the existing add/remove controls. On this
 *     side of the wire the body is built in exactly ONE place,
 *     `collectionEditPatchBody` below, which only ever writes the three keys
 *     `description`, `tags` and `custom`.
 *
 *   `name` is deliberately NOT in this form. The route does accept it, and the
 *     UI already edits it through the separate "Rename" control
 *     (public/collection-rename.js, issue #928) which PATCHes exactly
 *     `{ name }`. Two controls, two bodies, no overlap.
 *
 *   Caps, mirrored client-side so an over-long value is refused before a request
 *     rather than coming back as a 400 — `checkCollectionMetadataCaps`
 *     (src/routes/collections.ts:184-227) with the exported constants
 *     (:160-163): description ≤ 2048 chars (`description_too_long`), ≤ 128 tags
 *     (`too_many_tags`), each tag ≤ 128 chars (`tag_too_long`), `custom` ≤ 16384
 *     serialized UTF-8 bytes (`custom_too_large`). The same check runs on create
 *     and update, so these are the real bounds on this path.
 *
 *   `custom` values are `z.unknown()` — any JSON value, not just strings. A text
 *     box can only produce a string, so a row the operator did not retype sends
 *     back the ORIGINAL typed value (number, boolean, object, …) verbatim; only a
 *     row whose text actually changed is sent as the typed string. Without that
 *     rule, opening the dialog and saving an unrelated field would silently
 *     stringify every non-string value in the bag.
 *
 *   Authorisation — `MATRIX` (src/auth/authorize.ts) grants `write` to `editor`
 *     and `admin` only; `methodToAction` maps PATCH -> write;
 *     `resourceAuthorizationPreHandler('collection')` is registered on this
 *     router (src/routes/collections.ts:301) behind the 401 presence gate. A
 *     denied caller gets 403 `forbidden_insufficient_role`. Same gate as the
 *     rename, so this control is mounted on the same client-side predicate.
 *
 *   Where the edits show up — collection search hits carry `description`, `tags`
 *     and `custom` (`collectionHitSchema`, src/routes/search.ts, issue #561) and
 *     both search backends project them from LIVE collection documents via
 *     `collections.list()`, so there is no separate index an edit could leave
 *     stale.
 *
 *   Not claimed by any copy here: an audit entry. The PATCH handler
 *     (src/routes/collections.ts:423-444) does not call `emitAudit` — unlike the
 *     delete path — so a metadata edit is NOT in the audit log today.
 */

import { renderKeyValueRows } from './key-value-rows.js';

// Server caps, mirrored from the exported constants in src/routes/collections.ts
// (:160-163). Mirrored, not guessed — and the server still has the last word.
export const COLLECTION_DESCRIPTION_MAX = 2048;
export const COLLECTION_TAGS_MAX = 128;
export const COLLECTION_TAG_MAX = 128;
export const COLLECTION_CUSTOM_MAX_BYTES = 16 * 1024;

// ─── Copy deck ───────────────────────────────────────────────────────────────

export const COLLECTION_EDIT_COPY = Object.freeze({
  /** `collection.edit.btn` — the action-row control. */
  btn: 'Edit metadata',
  /** `collection.edit.dialog.title` */
  dialogTitle: 'Edit collection metadata',
  /** `collection.edit.dialog.intro` */
  dialogIntro:
    'Description, tags and custom fields are saved together in one update. ' +
    'Each list is saved exactly as it stands here, so a tag or field you remove ' +
    'is removed from the collection.',
  /** `collection.edit.dialog.stability` — what this edit leaves alone. */
  dialogStability:
    'Its members are not affected: the assets in this collection, its name, its ' +
    'id and its delete protection all stay as they are. Add or remove assets ' +
    'with the member controls on the panel behind this dialog.',
  /** `collection.edit.description.label` */
  descriptionLabel: 'Description',
  /** `collection.edit.description.help` */
  descriptionHelp: 'Free text, up to 2048 characters. Leave empty to clear it.',
  /** `collection.edit.tags.legend` */
  tagsLegend: 'Tags',
  /** `collection.edit.tags.hint` */
  tagsHint:
    'One tag per row, up to 128 tags of 128 characters each. Remove a row to ' +
    'drop that tag — the list is saved as a whole, not added to.',
  /** `collection.edit.tags.label` */
  tagLabel: 'Tag',
  /** `collection.edit.tags.add` */
  tagsAddLabel: 'Add tag',
  /** `collection.edit.custom.legend` */
  customLegend: 'Custom fields',
  /** `collection.edit.custom.hint` */
  customHint:
    'Free-form key and value pairs, the same key/value editing as the metadata ' +
    'filter on the Search tab. A row with an empty key is ignored; remove a row ' +
    'to drop that field. Up to 16 KB in total.',
  /** `collection.edit.custom.key` */
  customKeyLabel: 'Key',
  /** `collection.edit.custom.value` */
  customValueLabel: 'Value',
  /** `collection.edit.custom.add` */
  customAddLabel: 'Add custom field',
  /** `collection.edit.row.remove` */
  removeLabel: 'Remove',
  /** `collection.edit.btn.save` */
  btnSave: 'Save metadata',
  /** `collection.edit.btn.saving` */
  busyLabel: 'Saving…',
  /** `collection.edit.btn.cancel` */
  btnCancel: 'Cancel',
  /** `collection.edit.error.unchanged` */
  errUnchanged: 'Nothing changed, so nothing was saved.',
  /** `collection.edit.error.descriptionLong` */
  errDescriptionLong: 'Description is too long (maximum 2048 characters).',
  /** `collection.edit.error.tooManyTags` */
  errTooManyTags: 'Too many tags (maximum 128).',
  /** `collection.edit.error.tagLong` */
  errTagLong: 'A tag is too long (maximum 128 characters).',
  /** `collection.edit.error.customLarge` */
  errCustomLarge: 'The custom fields are too large (maximum 16 KB in total).',
  /** `collection.edit.error.duplicateKey` */
  errDuplicateCustomKey: 'Two custom fields have the same key. Keys must be unique.',
  /** `collection.edit.error.forbidden` */
  errForbidden:
    'Your role cannot edit this collection. Ask an editor or administrator.',
  /** `collection.edit.error.notFound` */
  errNotFound: 'This collection no longer exists. Nothing was saved.',
  /** `collection.edit.error.rejected` */
  errRejected: 'The API rejected this update. The collection was not changed.',
  /** `collection.edit.error.network` */
  errNetwork: 'Could not reach the API. The collection was not changed.',
});

// ─── Reading the current values off a collection ─────────────────────────────

/** Current tags, as a plain array of strings. Absent field => empty list. */
export function readCollectionTags(collection) {
  const tags = collection && collection.tags;
  return Array.isArray(tags) ? tags.map(function (t) { return String(t); }) : [];
}

/**
 * Current `custom` bag as ordered editable rows. A non-string value is shown as
 * its JSON text (`custom` is `z.record(z.unknown())`), and preserved verbatim on
 * save unless the operator retypes it — see `customPairsToObject`.
 */
export function readCollectionCustomPairs(collection) {
  const custom = collection && collection.custom;
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) return [];
  return Object.keys(custom).map(function (key) {
    const value = custom[key];
    return { key: key, value: typeof value === 'string' ? value : JSON.stringify(value) };
  });
}

/** Current description, as a string. Absent field => empty string. */
export function readCollectionDescription(collection) {
  const d = collection && collection.description;
  return typeof d === 'string' ? d : '';
}

// ─── Draft normalisation ─────────────────────────────────────────────────────

/**
 * Normalise the tag rows into the array that would go on the wire. Each row is
 * trimmed, blank rows are dropped (a blank row is an unused row, not an empty
 * tag — `z.array(z.string())` would accept `''`, but no UI gesture means "add
 * the empty tag"), and duplicates collapse to the first occurrence while order
 * is preserved.
 *
 * @param {Array<string|{key?: string}>} rows
 * @returns {string[]}
 */
export function normaliseTagRows(rows) {
  const out = [];
  const seen = Object.create(null);
  (rows || []).forEach(function (row) {
    const raw = row && typeof row === 'object' ? row.key : row;
    const tag = raw == null ? '' : String(raw).trim();
    if (!tag) return;
    if (seen[tag]) return;
    seen[tag] = true;
    out.push(tag);
  });
  return out;
}

/**
 * Turn the custom rows into the `custom` object. Keys are trimmed; a row with an
 * empty key is ignored (there is no field to name). A row the operator did not
 * retype keeps the ORIGINAL typed value from `currentCustom` — the bag is
 * `z.record(z.unknown())`, so a number or object must not be stringified just
 * because it passed through a text box. A duplicate key is reported rather than
 * silently collapsed, so the operator is never told "saved" about a field that
 * was dropped.
 *
 * @param {Array<{key?: string, value?: string, originalKey?: string, originalValue?: string}>} rows
 * @param {Record<string, unknown>} [currentCustom]
 * @returns {{ custom: Record<string, unknown>, duplicateKey: string|null }}
 */
export function customPairsToObject(rows, currentCustom) {
  const current = currentCustom && typeof currentCustom === 'object' ? currentCustom : {};
  const custom = {};
  let duplicateKey = null;
  (rows || []).forEach(function (row) {
    const r = row || {};
    const key = r.key == null ? '' : String(r.key).trim();
    if (!key) return;
    if (Object.prototype.hasOwnProperty.call(custom, key) && duplicateKey === null) {
      duplicateKey = key;
    }
    const text = r.value == null ? '' : String(r.value);
    const untouched =
      String(r.originalKey == null ? '' : r.originalKey).trim() === key &&
      String(r.originalValue == null ? '' : r.originalValue) === text;
    const original = Object.prototype.hasOwnProperty.call(current, key) ? current[key] : undefined;
    custom[key] = untouched && typeof original !== 'string' && original !== undefined
      ? original
      : text;
  });
  return { custom: custom, duplicateKey: duplicateKey };
}

// ─── The request body ────────────────────────────────────────────────────────

function sameStringArray(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function sameObject(a, b) {
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (!sameStringArray(ka, kb)) return false;
  for (const k of ka) {
    if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) return false;
  }
  return true;
}

/**
 * Build the PATCH body for a metadata edit. The ONLY place a collection-edit
 * body is constructed.
 *
 * Carries only the fields that actually changed, and only ever the three keys
 * `description`, `tags` and `custom`. `assetIds` (and `name`, and `deleteLock`)
 * are not merely omitted — there is no code path here that could write them, so
 * the `.strict()` body cannot be made to 400 by this form, and membership can
 * never be mutated through it.
 *
 * An emptied field is sent as its explicit empty value (`''`/`[]`/`{}`), which
 * is how the route clears an optional field; an untouched field is ABSENT, which
 * is how the route leaves it alone.
 *
 * @param {object} current  the collection as the API returned it
 * @param {{description?: string, tags?: string[], custom?: Record<string, unknown>}} draft
 * @returns {Record<string, unknown>}
 */
export function collectionEditPatchBody(current, draft) {
  const coll = current || {};
  const d = draft || {};
  const body = {};

  if (d.description !== undefined) {
    const next = String(d.description);
    if (next !== readCollectionDescription(coll)) body.description = next;
  }
  if (d.tags !== undefined) {
    const next = normaliseTagRows(d.tags);
    if (!sameStringArray(next, readCollectionTags(coll))) body.tags = next;
  }
  if (d.custom !== undefined) {
    const next = d.custom && typeof d.custom === 'object' ? d.custom : {};
    const currentCustom =
      coll.custom && typeof coll.custom === 'object' && !Array.isArray(coll.custom)
        ? coll.custom
        : {};
    if (!sameObject(next, currentCustom)) body.custom = next;
  }
  return body;
}

/**
 * Client-side mirror of `checkCollectionMetadataCaps`
 * (src/routes/collections.ts:184-227), run against the body that is about to be
 * sent so an over-long value is refused without a request. Returns null when
 * every present field is within its cap.
 *
 * @param {Record<string, unknown>} body
 * @returns {{reason: string, message: string}|null}
 */
export function checkEditCaps(body) {
  const b = body || {};
  if (typeof b.description === 'string' && b.description.length > COLLECTION_DESCRIPTION_MAX) {
    return { reason: 'description_too_long', message: COLLECTION_EDIT_COPY.errDescriptionLong };
  }
  if (Array.isArray(b.tags)) {
    if (b.tags.length > COLLECTION_TAGS_MAX) {
      return { reason: 'too_many_tags', message: COLLECTION_EDIT_COPY.errTooManyTags };
    }
    for (const tag of b.tags) {
      if (String(tag).length > COLLECTION_TAG_MAX) {
        return { reason: 'tag_too_long', message: COLLECTION_EDIT_COPY.errTagLong };
      }
    }
  }
  if (b.custom && typeof b.custom === 'object') {
    // The server bounds the SERIALIZED size in UTF-8 bytes; measure the same way.
    const serialized = JSON.stringify(b.custom);
    const bytes = typeof TextEncoder === 'function'
      ? new TextEncoder().encode(serialized).length
      : serialized.length;
    if (bytes > COLLECTION_CUSTOM_MAX_BYTES) {
      return { reason: 'custom_too_large', message: COLLECTION_EDIT_COPY.errCustomLarge };
    }
  }
  return null;
}

/**
 * Classify a failed edit into operator-facing copy. Same status mapping as the
 * rename dialog (public/rename-dialog.js `classifyRenameFailure`): the two
 * statuses this operation declares besides the gate are 400 and 404.
 *
 * @param {{status?: number}} err
 * @returns {{kind: string, message: string, dismiss: boolean}}
 */
export function classifyCollectionEditError(err) {
  const e = err || {};
  switch (e.status) {
    case 401:
    case 403:
      return { kind: 'forbidden', message: COLLECTION_EDIT_COPY.errForbidden, dismiss: false };
    case 404:
      return { kind: 'not-found', message: COLLECTION_EDIT_COPY.errNotFound, dismiss: true };
    case 400:
    case 422:
      return { kind: 'rejected', message: COLLECTION_EDIT_COPY.errRejected, dismiss: false };
    default:
      return { kind: 'other', message: COLLECTION_EDIT_COPY.errNetwork, dismiss: false };
  }
}

/**
 * The one-line outcome reported after a successful edit — it names the fields
 * that were actually sent, so the operator can see that removing the last tag
 * did save something.
 *
 * @param {Record<string, unknown>} body  the body that was sent
 * @returns {string}
 */
export function collectionEditResultMessage(body) {
  const labels = { description: 'description', tags: 'tags', custom: 'custom fields' };
  const changed = ['description', 'tags', 'custom']
    .filter(function (k) { return body && Object.prototype.hasOwnProperty.call(body, k); })
    .map(function (k) { return labels[k]; });
  if (changed.length === 0) return COLLECTION_EDIT_COPY.errUnchanged;
  const list = changed.length === 1
    ? changed[0]
    : changed.slice(0, -1).join(', ') + ' and ' + changed[changed.length - 1];
  return 'Saved ' + list + '.';
}

// ─── The form ────────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Build the edit form. PURE: no fetch, no listeners beyond the ones the row
 * group owns. Uses the house form furniture (`.form-field.grow`,
 * `.modal-actions`, `.msg.msg-error`) exactly as the rename dialog does, and the
 * shared key/value row group (public/key-value-rows.js) for tags and custom.
 *
 * @param {HTMLElement} host
 * @param {{collection?: object}} opts
 * @returns {{descriptionInput: HTMLTextAreaElement, tags: object, custom: object, errorEl: HTMLElement, submitBtn: HTMLElement, cancelBtn: HTMLElement, readDraft: Function}}
 */
export function buildCollectionEditForm(host, opts) {
  const o = opts || {};
  const collection = o.collection || {};
  host.className = 'collection-edit-dialog';

  host.appendChild(el('p', 'text-muted', COLLECTION_EDIT_COPY.dialogIntro));
  host.appendChild(el('p', 'text-muted', COLLECTION_EDIT_COPY.dialogStability));

  // Description
  const descField = el('div', 'form-field grow');
  const descLabel = el('label', null, COLLECTION_EDIT_COPY.descriptionLabel);
  descLabel.setAttribute('for', 'coll-edit-description');
  const desc = document.createElement('textarea');
  desc.id = 'coll-edit-description';
  desc.rows = 4;
  desc.maxLength = COLLECTION_DESCRIPTION_MAX;
  desc.value = readCollectionDescription(collection);
  desc.setAttribute('aria-describedby', 'coll-edit-description-help');
  const descHelp = el('div', 'form-hint', COLLECTION_EDIT_COPY.descriptionHelp);
  descHelp.id = 'coll-edit-description-help';
  descField.appendChild(descLabel);
  descField.appendChild(desc);
  descField.appendChild(descHelp);
  host.appendChild(descField);

  // Tags — an editable LIST, because `tags` replaces wholesale on PATCH.
  const tags = renderKeyValueRows(host, {
    prefix: 'coll-edit-tag',
    legend: COLLECTION_EDIT_COPY.tagsLegend,
    hint: COLLECTION_EDIT_COPY.tagsHint,
    keyLabel: COLLECTION_EDIT_COPY.tagLabel,
    keyPlaceholder: 'news',
    itemNoun: 'tag',
    removeLabel: COLLECTION_EDIT_COPY.removeLabel,
    addLabel: COLLECTION_EDIT_COPY.tagsAddLabel,
    initial: readCollectionTags(collection).map(function (t) { return { key: t }; }),
  });

  // Custom — the same key/value pair editing as the Search tab's metadata filter.
  const custom = renderKeyValueRows(host, {
    prefix: 'coll-edit-custom',
    legend: COLLECTION_EDIT_COPY.customLegend,
    hint: COLLECTION_EDIT_COPY.customHint,
    keyLabel: COLLECTION_EDIT_COPY.customKeyLabel,
    valueLabel: COLLECTION_EDIT_COPY.customValueLabel,
    keyPlaceholder: 'rightsWindow',
    valuePlaceholder: '2026-12-31',
    itemNoun: 'custom field',
    removeLabel: COLLECTION_EDIT_COPY.removeLabel,
    addLabel: COLLECTION_EDIT_COPY.customAddLabel,
    initial: readCollectionCustomPairs(collection),
  });

  const errorEl = el('div', 'msg msg-error');
  errorEl.id = 'coll-edit-error';
  errorEl.setAttribute('role', 'alert');
  errorEl.style.display = 'none';
  host.appendChild(errorEl);

  const actions = el('div', 'modal-actions');
  const submitBtn = el('button', null, COLLECTION_EDIT_COPY.btnSave);
  submitBtn.type = 'button';
  submitBtn.id = 'coll-edit-submit';
  const cancelBtn = el('button', 'btn-ghost', COLLECTION_EDIT_COPY.btnCancel);
  cancelBtn.type = 'button';
  cancelBtn.id = 'coll-edit-cancel';
  actions.appendChild(submitBtn);
  actions.appendChild(cancelBtn);
  host.appendChild(actions);

  // Read the whole form into a draft. All three fields are always present in the
  // draft; `collectionEditPatchBody` is what decides which ones are CHANGED and
  // therefore sent.
  function readDraft() {
    const converted = customPairsToObject(custom.read(), collection.custom);
    return {
      description: desc.value,
      tags: normaliseTagRows(tags.read()),
      custom: converted.custom,
      duplicateKey: converted.duplicateKey,
    };
  }

  return {
    descriptionInput: desc,
    tags: tags,
    custom: custom,
    errorEl: errorEl,
    submitBtn: submitBtn,
    cancelBtn: cancelBtn,
    readDraft: readDraft,
  };
}

/**
 * Open the edit dialog and wire its submit. Resolves with the outcome once the
 * dialog closes.
 *
 * @param {object} opts
 * @param {object}   opts.collection
 * @param {Function} opts.apiFetch
 * @param {Function} opts.openModal
 * @param {Function} [opts.onSaved]       (updated|null, message) after a save or a 404
 * @param {Function} [opts.onForbidden]   (message) on a 403/401
 * @returns {Promise<{saved: boolean, resource: object|null, message: string|null}>}
 */
export function openCollectionEditDialog(opts) {
  const o = opts || {};
  const collection = o.collection || {};

  return new Promise(function (resolve) {
    let outcome = { saved: false, resource: null, message: null };
    let settled = false;
    function settle() {
      if (settled) return;
      settled = true;
      resolve(outcome);
    }

    let firstField = null;

    o.openModal(
      COLLECTION_EDIT_COPY.dialogTitle,
      function (body, closeDialog) {
        const form = buildCollectionEditForm(body, { collection: collection });
        firstField = form.descriptionInput;

        function showError(message) {
          form.errorEl.textContent = message;
          form.errorEl.style.display = '';
        }

        form.cancelBtn.addEventListener('click', function () { closeDialog(); });

        form.submitBtn.addEventListener('click', async function () {
          form.errorEl.style.display = 'none';
          form.errorEl.textContent = '';

          const draft = form.readDraft();
          if (draft.duplicateKey) {
            showError(COLLECTION_EDIT_COPY.errDuplicateCustomKey);
            return;
          }

          // Exactly description/tags/custom, only where changed. Never assetIds.
          const patch = collectionEditPatchBody(collection, draft);
          if (Object.keys(patch).length === 0) {
            showError(COLLECTION_EDIT_COPY.errUnchanged);
            return;
          }
          const cap = checkEditCaps(patch);
          if (cap) {
            showError(cap.message);
            return;
          }

          const prev = form.submitBtn.textContent;
          form.submitBtn.disabled = true;
          form.cancelBtn.disabled = true;
          form.submitBtn.textContent = COLLECTION_EDIT_COPY.busyLabel;
          try {
            const updated = await o.apiFetch(
              '/collections/' + encodeURIComponent(String(collection.id)),
              { method: 'PATCH', body: JSON.stringify(patch) }
            );
            outcome = {
              saved: true,
              resource: updated,
              message: collectionEditResultMessage(patch),
            };
            closeDialog();
            if (typeof o.onSaved === 'function') await o.onSaved(updated, outcome.message);
            return;
          } catch (err) {
            const c = classifyCollectionEditError(err);
            if (c.dismiss) {
              outcome = { saved: false, resource: null, message: c.message, gone: true };
              closeDialog();
              if (typeof o.onSaved === 'function') await o.onSaved(null, c.message);
              return;
            }
            if (c.kind === 'forbidden' && typeof o.onForbidden === 'function') {
              outcome = { saved: false, resource: null, message: c.message, forbidden: true };
              o.onForbidden(c.message);
            }
            showError(c.message);
          } finally {
            form.submitBtn.disabled = false;
            form.cancelBtn.disabled = false;
            form.submitBtn.textContent = prev;
          }
        });
      },
      { onClose: settle }
    );

    if (firstField && firstField.focus) firstField.focus();
  });
}

/**
 * Add the "Edit metadata" control to the collection detail action row and wire
 * its dialog. Same placement rule as the rename control: the button joins the
 * existing action row, and is ABSENT (not disabled) for a role that cannot write.
 *
 * @param {object} opts
 * @param {object}      opts.collection  from GET /api/v1/collections/{id}
 * @param {HTMLElement} opts.actionsRow
 * @param {HTMLElement} [opts.beforeEl]
 * @param {boolean}     opts.canChange
 * @param {Function}    opts.apiFetch
 * @param {Function}    opts.openModal
 * @param {Function}    [opts.showMsg]
 * @param {Function}    [opts.messageHost]
 * @param {Function}    [opts.onSaved]
 * @returns {{button: HTMLElement|null, open: Function|null}}
 */
export function mountCollectionEdit(opts) {
  const o = opts || {};
  if (!o.canChange) return { button: null, open: null };

  const btn = el('button', 'btn-ghost', COLLECTION_EDIT_COPY.btn);
  btn.type = 'button';
  btn.id = 'btn-edit-collection-metadata';
  const row = o.actionsRow;
  if (row) {
    if (o.beforeEl && o.beforeEl.parentNode === row) row.insertBefore(btn, o.beforeEl);
    else row.appendChild(btn);
  }

  function reportToActionArea(text, kind) {
    if (typeof o.showMsg !== 'function') return;
    const host = typeof o.messageHost === 'function' ? o.messageHost() : null;
    if (host) o.showMsg(host, text, kind || 'error');
  }

  function open() {
    return openCollectionEditDialog({
      collection: o.collection,
      apiFetch: o.apiFetch,
      openModal: o.openModal,
      onSaved: o.onSaved,
      onForbidden: function (message) {
        // A control known to fail stops being offered for the rest of this view.
        if (btn.parentNode) btn.parentNode.removeChild(btn);
        reportToActionArea(message, 'error');
      },
    });
  }

  btn.addEventListener('click', open);
  return { button: btn, open: open };
}
