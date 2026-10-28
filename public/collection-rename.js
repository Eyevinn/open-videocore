/**
 * open-videocore ops dashboard — collection-rename.js
 *
 * The collection DETAIL view's "Rename" action (issue #928): the affordance for
 * a field `PATCH /api/v1/collections/{id}` already accepts (`name`, added to
 * that body in issue #926) but which nothing in this UI could trigger — a
 * collection could only ever be named once, at creation.
 *
 * Deliberately a THIN ADAPTER over `public/rename-dialog.js`, the same module
 * `public/asset-rename.js` adapts. Issue #928's second acceptance criterion is
 * that the interaction pattern matches the asset rename; sharing the component
 * rather than copying it is what makes that true by construction — the dialog
 * markup, the client-side bounds check, the no-op refusal, the busy state, the
 * 403/404 handling and the "report what the server stored" rule are one
 * implementation, not two that look alike today.
 *
 * UI ONLY. No route, schema or response shape is changed by this module.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's route source and generated spec on this branch; nothing
 * is taken from the issue text. Issue #928 lists the API change adding `name` to
 * this body as a dependency — it is PRESENT on `main` (issue #926), verified as
 * follows, which is why this control exists:
 *
 *   The write — `openapi.json .paths["/api/v1/collections/{id}"].patch`
 *     parameters: exactly one — path `id` (string, required). No query params.
 *     requestBody (`required: true`) schema properties: `name` (string,
 *       minLength 1, maxLength 256), `description` (string), `tags`
 *       (array<string>), `custom` (object); `additionalProperties: false`.
 *       Every property optional.
 *     responses: exactly `200` (the collection — `id`, `name`, `assetIds`,
 *       `createdAt`, `updatedAt` required, plus optional `description`, `tags`,
 *       `custom`, `deleteLock`), `400` and `404`.
 *     Source of truth: `updateBodySchema`, src/routes/collections.ts:216-229 —
 *       `name: z.string().min(1).max(256).optional()` at :224, the SAME
 *       type/length rule as the asset rename (that line's own comment pins it to
 *       `src/routes/assets.ts` `updateSchema`), inside a `.strict()` object at
 *       :229. Wired at `app.patch('/:id', …)` src/routes/collections.ts:389-410
 *       with `response: { 200: collectionSchema, 400: errorSchema,
 *       404: errorSchema }` at :395.
 *
 *   `assetIds` CANNOT be sent — acceptance criterion 3, and a property of the
 *     contract rather than of this module's good behaviour: the body is
 *     `.strict()`, so membership (and `deleteLock`) are rejected with a 400
 *     "so callers cannot smuggle a membership mutation through the metadata
 *     endpoint" (src/routes/collections.ts:207-215). Membership stays on
 *     PUT/DELETE /:id/assets/:assetId. On this side of the wire the body is
 *     built in exactly one place — `renameRequestBody`, rename-dialog.js, which
 *     returns `{ name }` and nothing else — so there is no code path that could
 *     add a key.
 *
 *   What a rename does NOT touch, verified in the repository layer rather than
 *   assumed: `applyCollectionUpdate` (src/data/collection-repo.ts:92-110) copies
 *     the existing collection, bumps `updatedAt`, and assigns ONLY the keys the
 *     patch carries (`if (patch.name !== undefined) next.name = patch.name;` at
 *     :96). It "never touches `assetIds` or `deleteLock`" (:90). Both backends
 *     route through it — `InMemoryCollectionRepository.update`
 *     (src/data/inmemory-collection-repo.ts:73-81) and
 *     `CouchCollectionRepository.update` (src/data/couch-collection-repo.ts:
 *     93-110, inside the `_rev` merge-retry wrapper `updateWithRetry`, so a
 *     racing membership add re-bases rather than clobbers). A collection id is
 *     also not derived from its name: `create` mints the id and there is no slug
 *     on a collection at all (`Collection`, src/data/collection-repo.ts:36-44).
 *
 *   Where the new name shows up — the collections list reads GET
 *     /api/v1/collections (`collectionSchema.name`), and collection search hits
 *     carry `name` too (`collectionHitSchema`, src/routes/search.ts). Both
 *     search backends project collection hits from LIVE collection documents via
 *     `collections.list()` (src/data/inmemory-search-repo.ts:45-51;
 *     src/data/couch-search-repo.ts:68-74), so there is no separate name index a
 *     rename could leave stale.
 *
 *   The 400 cases, so the copy does not claim to know the cause: the framework's
 *     own zod rejection (an empty or over-long `name`, or any unknown key), and
 *     `metadata_cap_exceeded` — which a name-only patch cannot trigger, because
 *     `checkCollectionMetadataCaps` (src/routes/collections.ts:148-190) inspects
 *     `description`/`tags`/`custom` only and has no `name` branch. The dialog
 *     validates client-side first so a 400 is not the normal way an operator
 *     learns the length rule.
 *
 *   Authorisation — `MATRIX` (src/auth/authorize.ts:54-58) grants `write` to
 *     `editor` and `admin` only; `methodToAction` (:79-93) maps PATCH -> write;
 *     `resourceAuthorizationPreHandler('collection')` is registered on this
 *     router (src/routes/collections.ts:267) behind the 401 presence gate
 *     (`authGate`, :266). ADR-018 decision 4: `collection` is authorised against
 *     the same role table as `asset`, with no membership cascade. A denied caller
 *     gets 403 `forbidden_insufficient_role` (authorize.ts:99).
 *
 *   Not claimed by any copy here: an audit entry. The PATCH handler
 *     (src/routes/collections.ts:398-409) does not call `emitAudit` — unlike the
 *     delete path (`collection.deleted`, :418-433) — so a rename is NOT in the
 *     audit log today and this module says nothing suggesting otherwise.
 */

import {
  NAME_MAX,
  NAME_MIN,
  buildRenameDialogBody,
  classifyRenameFailure,
  mountRenameControl,
  normaliseName,
  renameRequestBody,
  renameResultMessage,
} from './rename-dialog.js';

// Shared with the asset rename — one set of bounds, one body builder, one
// success line. Re-exported so a collection-side test can assert against the
// same symbols the module uses.
export { NAME_MAX, NAME_MIN, renameRequestBody, renameResultMessage };

// ─── Copy deck ───────────────────────────────────────────────────────────────
//
// Same slots as RENAME_COPY (asset-rename.js), same voice, each sentence naming
// its own resource. Frozen so a caller cannot drift the wording, and exported so
// a test asserts against the sentences the operator actually reads.

export const COLLECTION_RENAME_COPY = Object.freeze({
  /** `collection.rename.btn` — the action-row control. */
  btn: 'Rename',
  /** `collection.rename.dialog.title` */
  dialogTitle: 'Rename collection',
  /** `collection.rename.dialog.intro` — what a rename is, in one sentence. */
  dialogIntro:
    'The name is how this collection is identified in the collections list, ' +
    'in search results and on this panel.',
  /** `collection.rename.dialog.stability` — what a rename leaves alone. */
  dialogStability:
    'Its members are not affected: the assets in this collection, its id and ' +
    'its delete protection all stay as they are.',
  /** `collection.rename.field.label` */
  fieldLabel: 'Name',
  /** `collection.rename.field.help` */
  fieldHelp: 'Required. Up to 256 characters.',
  /** `collection.rename.btn.save` */
  btnSave: 'Save name',
  /** `collection.rename.btn.saving` */
  busyLabel: 'Saving…',
  /** `collection.rename.btn.cancel` */
  btnCancel: 'Cancel',
  /** `collection.rename.error.empty` */
  errEmpty: 'Enter a name. A collection cannot have an empty name.',
  /** `collection.rename.error.long` */
  errTooLong: 'Name is too long (maximum 256 characters).',
  /** `collection.rename.error.unchanged` */
  errUnchanged: 'That is already the collection’s name.',
  /** `collection.rename.error.forbidden` */
  errForbidden:
    'Your role cannot rename this collection. Ask an editor or administrator.',
  /** `collection.rename.error.notFound` */
  errNotFound: 'This collection no longer exists. The name was not changed.',
  /** `collection.rename.error.rejected` — a 400 the client-side rules missed. */
  errRejected: 'The API rejected this name. The collection was not renamed.',
  /** `collection.rename.error.network` */
  errNetwork: 'Could not reach the API. The collection was not renamed.',
});

// ─── Collection-bound wrappers over the shared affordance ────────────────────

/**
 * Validate a typed collection name against the server's bounds, before any
 * request is made. See `normaliseName` (rename-dialog.js) for the rules; this
 * binds the collection copy.
 *
 * @param {unknown} raw
 * @param {unknown} currentName
 * @returns {{ value: string, ok: boolean, reason: 'empty'|'too-long'|'unchanged'|null, message: string|null }}
 */
export function normaliseCollectionRenameInput(raw, currentName) {
  return normaliseName(raw, currentName, COLLECTION_RENAME_COPY);
}

/**
 * Classify a failed collection rename into operator-facing copy. See
 * `classifyRenameFailure` (rename-dialog.js); this binds the collection copy.
 *
 * @param {{status?: number, message?: string, body?: any}} err
 * @returns {{kind: 'forbidden'|'not-found'|'rejected'|'other', message: string, dismiss: boolean}}
 */
export function classifyCollectionRenameError(err) {
  return classifyRenameFailure(err, COLLECTION_RENAME_COPY);
}

/**
 * Build the collection rename form. PURE: no fetch, no listeners. Identical
 * markup to the asset rename form (same shared builder), with collection copy.
 *
 * @param {HTMLElement} body
 * @param {{ currentName?: string }} opts
 * @returns {{ input: HTMLInputElement, errorEl: HTMLElement, submitBtn: HTMLElement, cancelBtn: HTMLElement }}
 */
export function buildCollectionRenameForm(body, opts) {
  const o = opts || {};
  return buildRenameDialogBody(body, {
    currentName: o.currentName,
    copy: COLLECTION_RENAME_COPY,
  });
}

/**
 * Add the "Rename" control to the collection detail action row and wire its
 * dialog. Same placement rule as the asset side: the button joins the existing
 * action row, and is ABSENT (not disabled) for a role that cannot write.
 *
 * @param {object} opts
 * @param {object}      opts.collection  collection from GET /api/v1/collections/{id}
 * @param {HTMLElement} opts.actionsRow   the `.mt12.flex-gap` action row
 * @param {HTMLElement} [opts.beforeEl]   element in that row to insert before
 * @param {boolean}     opts.canChange    client-role mirror of the ADR-018 matrix
 * @param {Function}    opts.apiFetch
 * @param {Function}    opts.openModal
 * @param {Function}    [opts.showMsg]
 * @param {() => HTMLElement} [opts.messageHost]
 * @param {(collection: object|null, message: string) => any} opts.onRenamed
 *        called after a successful rename (or a 404) so the caller can re-render
 *        the panel and refresh the collections list. The 200 carries the updated
 *        collection, so the caller can report what the server actually stored.
 * @returns {{ button: HTMLElement|null, open: (() => void)|null }}
 */
export function mountCollectionRename(opts) {
  const o = opts || {};
  const collection = o.collection || {};
  return mountRenameControl({
    copy: COLLECTION_RENAME_COPY,
    // The collection id exactly as the API returned it. There is no slug on a
    // collection (`Collection`, src/data/collection-repo.ts:36-44), so the id is
    // the only accepted path value — and the GET that fed this panel used the
    // same one.
    path: '/collections/' + encodeURIComponent(String(collection.id)),
    buttonId: 'btn-rename-collection',
    currentName: collection.name,
    actionsRow: o.actionsRow,
    beforeEl: o.beforeEl,
    canChange: o.canChange,
    apiFetch: o.apiFetch,
    openModal: o.openModal,
    showMsg: o.showMsg,
    messageHost: o.messageHost,
    onRenamed: o.onRenamed,
  });
}
