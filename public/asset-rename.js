/**
 * open-videocore ops dashboard — asset-rename.js
 *
 * The asset DETAIL view's "Rename" action (issue #956): an operator-facing
 * affordance for the `name` field that PATCH /api/v1/assets/{id} has always
 * accepted but that no control in this UI could ever trigger.
 *
 * This module is now an ADAPTER over the shared rename affordance in
 * `public/rename-dialog.js` (extracted for issue #928, when collections needed
 * the same control). All of the behaviour — validation against the server
 * bounds, the body construction, the error classification, the dialog markup and
 * the mount — lives there and is shared; this file supplies the asset copy deck
 * and the asset path, and keeps this module's existing exports stable for its
 * callers (public/app.js) and its test suite.
 *
 * UI ONLY. No route, schema or response shape is changed by this module; it
 * sends the one field the existing PATCH body already declares.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's route source and generated spec. Nothing is taken from
 * the issue text.
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
 *       and nothing else — `renameRequestBody` (now shared, rename-dialog.js) is
 *       the single place the body is built, so no sibling field can be sent by
 *       accident.
 *
 *   Authorisation — `MATRIX` (src/auth/authorize.ts:54-58) grants `write` to
 *     `editor` and `admin` only; `methodToAction` (:79-93) maps PATCH -> write;
 *     `resourceAuthorizationPreHandler('asset')` (:126, registered
 *     src/routes/assets.ts:1718) applies it to this route. So a `viewer` gets a
 *     403 `forbidden_insufficient_role` (:99). The caller passes `canChange` as
 *     a client-side MIRROR of that rule; the 403 path still runs, because the
 *     server is the authority.
 *
 *   Path parameter — `app.patch('/:id')` passes the raw param straight to
 *     `repo.update` (src/routes/assets.ts:5551), which looks the document up by
 *     id (`this.store.get(key)` asset-repo.ts:1625 / `couch.get(id)`
 *     couch-asset-repo.ts:346). Unlike GET /:id there is NO slug fallback, so
 *     this module always sends the ULID (`asset.id`), which the detail pane
 *     holds even when it was opened by slug.
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

// Re-exported unchanged so existing importers keep one source for the bounds,
// the body builder and the success line.
export { NAME_MAX, NAME_MIN, renameRequestBody, renameResultMessage };

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

// ─── Asset-bound wrappers over the shared affordance ─────────────────────────

/**
 * Validate a typed asset name against the server's bounds. See
 * `normaliseName` (rename-dialog.js) for the rules; this binds the asset copy.
 *
 * @param {unknown} raw
 * @param {unknown} currentName
 * @returns {{ value: string, ok: boolean, reason: 'empty'|'too-long'|'unchanged'|null, message: string|null }}
 */
export function normaliseRenameInput(raw, currentName) {
  return normaliseName(raw, currentName, RENAME_COPY);
}

/**
 * Classify a failed asset rename into operator-facing copy. See
 * `classifyRenameFailure` (rename-dialog.js); this binds the asset copy.
 *
 * @param {{status?: number, message?: string, body?: any}} err
 * @returns {{kind: 'forbidden'|'not-found'|'rejected'|'other', message: string, dismiss: boolean}}
 */
export function classifyRenameError(err) {
  return classifyRenameFailure(err, RENAME_COPY);
}

/**
 * Build the asset rename form. PURE. See `buildRenameDialogBody`
 * (rename-dialog.js); this binds the asset copy.
 *
 * @param {HTMLElement} body
 * @param {{ currentName?: string }} opts
 * @returns {{ input: HTMLInputElement, errorEl: HTMLElement, submitBtn: HTMLElement, cancelBtn: HTMLElement }}
 */
export function buildRenameForm(body, opts) {
  const o = opts || {};
  return buildRenameDialogBody(body, { currentName: o.currentName, copy: RENAME_COPY });
}

/**
 * Add the "Rename" control to the asset detail action row and wire its dialog.
 *
 * @param {object} opts
 * @param {object}      opts.asset       asset from GET /api/v1/assets/{id}
 * @param {HTMLElement} opts.actionsRow  the `.mt12.flex-gap` action row
 * @param {HTMLElement} [opts.beforeEl]  element in that row to insert before
 * @param {boolean}     opts.canChange   client-role mirror of the ADR-018 matrix
 * @param {Function}    opts.apiFetch
 * @param {Function}    opts.openModal
 * @param {Function}    [opts.showMsg]
 * @param {() => HTMLElement} [opts.messageHost]
 * @param {(asset: object|null, message: string) => any} opts.onRenamed
 * @returns {{ button: HTMLElement|null, open: (() => void)|null }}
 */
export function mountAssetRename(opts) {
  const o = opts || {};
  const asset = o.asset || {};
  return mountRenameControl({
    copy: RENAME_COPY,
    // The ULID, never the slug: PATCH /:id does not resolve slugs (see CONTRACT
    // GROUNDING).
    path: '/assets/' + encodeURIComponent(String(asset.id)),
    buttonId: 'btn-rename-asset',
    currentName: asset.name,
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
