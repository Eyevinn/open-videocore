/**
 * open-videocore ops dashboard — external-ids.js
 *
 * The "External identifiers" block on the asset detail view (issue #943, broken
 * out of #796): every `{ namespace, id }` correlation an integration has written
 * onto this asset, listed with its namespace and correctable in place.
 *
 * Until now these pairs were write-only over HTTP from a human's point of view:
 * an integration could attach them, nothing in the UI could show them, and a
 * mistyped namespace or upstream key was invisible. This block makes them
 * visible and editable.
 *
 * Every operator-visible string is written with `textContent` / `createElement`
 * and every prefilled field through `input.value` — no server value ever reaches
 * `innerHTML`. Namespaces and ids are opaque upstream strings (a URN, a path, a
 * slug), so they are rendered verbatim as text, never parsed or interpreted.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's generated spec (`openapi.json`), the route source and
 * the repository implementation on this branch. Nothing is taken from the issue
 * text — in particular the issue says "namespace and value"; the wire field is
 * `id`, not `value`, and this module sends `id` (see "Field names" below).
 * `openapi.json` declares no `operationId` on ANY operation, so the three
 * operations below are identified by path + method, as the spec itself does.
 *
 *   READ — `openapi.json .paths["/api/v1/assets/{id}/external-ids"].get`
 *     parameters: exactly one — path `id` (string, required). No query params.
 *     responses: exactly `200` and `404`.
 *     200 schema: `type: array`, items
 *       `{ namespace: string, id: string }`, `required: ["namespace","id"]`,
 *       `additionalProperties: false`. Described as "External identifiers
 *       attached to the asset, in persisted order. Empty when none are attached."
 *     404 schema: `{ error: string, message?: string }`, required `["error"]`.
 *     Source of truth: `app.get('/:id/external-ids', …)`,
 *       src/routes/assets.ts:3555-3602 — handler sends
 *       `asset.externalIdentifiers ?? []` (:3602) after `repo.get` (:3595).
 *     An EMPTY ARRAY IS A STATE, NOT A MISS: the persisted field is optional and
 *       `docToAsset` collapses an empty stored array to `undefined`
 *       (src/data/asset-document.ts:712-715), so "none attached" and "pre-#575
 *       document" both arrive as `[]` (src/routes/assets.ts:3598-3601).
 *
 *   ATTACH — `openapi.json .paths["/api/v1/assets/{id}/external-ids"].post`
 *     requestBody: `application/json`, schema
 *       `{ namespace: string (minLength 1, maxLength 256),
 *          id: string (minLength 1, maxLength 1024) }`,
 *       `required: ["namespace","id"]`, `additionalProperties: false`.
 *       Source: `attachExternalIdBodySchema`, src/routes/assets.ts:500-523;
 *       route src/routes/assets.ts:3416-3451.
 *     responses: exactly `200` (the FULL asset — same schema as
 *       `GET /api/v1/assets/{id}`), `400`, `404` and `409`.
 *     409 body: `{ error: "external_id_conflict", message?: string,
 *       reason: "external_id_conflict", namespace: string, externalId: string,
 *       conflictingAssetId: string }`, `required: ["error","reason","namespace",
 *       "externalId","conflictingAssetId"]` (`externalIdConflictSchema`,
 *       src/routes/assets.ts:529-536; thrown as `ExternalIdConflictError` and
 *       mapped at :2853-2866). Returned ONLY when the operator has set
 *       `EXTERNAL_ID_UNIQUENESS=enforced` (read per request,
 *       `externalIdUniquenessEnforced()`, :3444); the advisory default allows a
 *       duplicate across assets. This client cannot know which mode is active,
 *       so it handles the 409 whenever it arrives and never predicts it.
 *
 *   DETACH — `openapi.json
 *     .paths["/api/v1/assets/{id}/external-ids/{namespace}/{externalId}"].delete`
 *     parameters: path `id`, `namespace` (minLength 1), `externalId`
 *       (minLength 1) — the second segment is named `externalId`, NOT a second
 *       `id`, because find-my-way collapses duplicate param names
 *       (src/routes/assets.ts:3464-3470). The wire path is
 *       `/api/v1/assets/{id}/external-ids/{namespace}/{externalId}`.
 *     responses: exactly `204` (null body), `400` and `404`.
 *     IDEMPOTENT BY CONTRACT: 204 whether or not the asset carried the pair;
 *       404 means the ASSET is unknown and is the only not-found case
 *       (src/routes/assets.ts:3472-3480, handler :3519-3531).
 *     Source: `app.delete('/:id/external-ids/:namespace/:externalId', …)`,
 *       src/routes/assets.ts:3487-3532.
 *
 *   FIELD NAMES — `namespace` and `id`. Both the stored shape
 *     (`ExternalIdentifierSchema`, src/data/asset-document.ts:173-186, persisted
 *     at `administrative.externalIdentifiers[]`, :329), the `ExternalIdentifier`
 *     type (src/data/asset-repo.ts:281-286) and all three operations above use
 *     the SAME pair of names. There is no `value` field anywhere in the
 *     contract. The column is labelled "Identifier" for readers, but the wire
 *     key this module sends and reads is `id`.
 *
 *   WHY AN EDIT IS attach-then-detach, NOT an update —
 *     THE API HAS NO UPDATE. The route prose says "Attach (or change)", but the
 *     repository seam appends and never replaces: `attachExternalId` returns the
 *     asset untouched when the exact pair is already present, and otherwise
 *     pushes onto `[...(existing.externalIdentifiers ?? []), { namespace, id }]`
 *     (src/data/asset-repo.ts:1524-1557; CouchDB mirror
 *     src/data/couch-asset-repo.ts:228-252). It does NOT replace the entry that
 *     shares a namespace. So POSTing a corrected pair ADDS a second row; the old
 *     one has to be detached explicitly. There is no PATCH/PUT on the
 *     sub-resource — `/{id}/external-ids` carries only `get` and `post` in
 *     `openapi.json`, and `…/{namespace}/{externalId}` only `delete` — and
 *     `PATCH /assets/{id}` cannot reach the set either (`UpdateAssetInput`
 *     carries no `externalIdentifiers` field, src/data/asset-repo.ts:920-921).
 *     ORDER IS ATTACH FIRST, THEN DETACH. If the second call fails the asset
 *     carries BOTH pairs — visible on the next read and correctable. The
 *     opposite order would, on the same failure, leave the asset carrying
 *     NEITHER: a correlation to an upstream system of record, destroyed by a
 *     half-finished edit. The two calls are not a transaction and this module
 *     does not pretend they are — the intermediate state is reported in plain
 *     words when it happens.
 *
 *   AUTHORISATION — the ADR-018 role×action matrix `MATRIX`
 *     (src/auth/authorize.ts:54-58: `viewer { read: true, write: false,
 *     delete: false }`, editor/admin all true), applied by
 *     `resourceAuthorizationPreHandler('asset')` (src/auth/authorize.ts:126,
 *     registered src/routes/assets.ts:1773) with the action from
 *     `methodToAction` (:79-93): GET → `read`, POST → `write`, DELETE →
 *     `delete`. So a viewer may LIST the identifiers but is refused both halves
 *     of an edit with 403 `AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role'`
 *     (:99). `canEdit` is the caller's client-role mirror; the 403 path below
 *     runs regardless, because the server is the authority.
 *
 *   NOT IMPLEMENTED, deliberately — attach-a-new-pair and detach-a-pair as
 *     standalone actions. #943's acceptance criteria are view + edit; the DELETE
 *     operation is used here only as the second half of an edit. Export actions
 *     and destination configuration are explicitly out of scope on the issue and
 *     nothing here touches them.
 */

// ─── Contract limits ─────────────────────────────────────────────────────────
//
// Mirrored from `attachExternalIdBodySchema` (src/routes/assets.ts:500-523) so
// the field cannot be typed past what the POST will accept. The server
// re-validates; this only saves a guaranteed 400 round-trip.

export const EXTERNAL_ID_LIMITS = Object.freeze({
  namespaceMax: 256,
  idMax: 1024,
});

// ─── Copy deck ───────────────────────────────────────────────────────────────

export const EXTERNAL_IDS_COPY = Object.freeze({
  heading: 'External identifiers',
  /** What these are, in one line, for someone who has not read ADR-019. */
  intro:
    'Identifiers linking this asset to systems outside open-videocore. Written ' +
    'by integrations; correct one here if it is wrong.',

  colNamespace: 'Namespace',
  colIdentifier: 'Identifier',
  colActions: 'Actions',
  tableCaption: 'External identifiers attached to this asset',

  /** 200 with `[]` — a real state, not a failed read. */
  empty: 'No external identifiers are attached to this asset.',
  emptyDetail:
    'Integrations attach these through the API. None has been attached to this ' +
    'asset yet.',

  /** The read failed or returned something unusable. */
  unavailable: 'External identifiers unavailable.',
  unavailableDetail:
    'The API did not return a usable list for this asset, so none can be shown ' +
    'or edited.',

  /** Role gate — pre-emptive mirror of the 403 both halves of an edit would hit. */
  readOnly:
    'Your role can see these identifiers but cannot change them. Ask an editor ' +
    'or administrator.',

  btnEdit: 'Edit',
  btnSave: 'Save',
  btnCancel: 'Cancel',
  busySuffix: '…',

  /** Said on screen, because the two-call edit is not atomic. */
  editNote:
    'Saving attaches the corrected identifier and then removes the old one — ' +
    'the API has no single update call for this.',

  /** Client-side mirrors of the POST body schema. */
  errNamespaceEmpty: 'Namespace is required.',
  errIdEmpty: 'Identifier is required.',
  errNamespaceTooLong:
    'Namespace is too long — the API accepts at most ' +
    EXTERNAL_ID_LIMITS.namespaceMax +
    ' characters.',
  errIdTooLong:
    'Identifier is too long — the API accepts at most ' +
    EXTERNAL_ID_LIMITS.idMax +
    ' characters.',
  /** Both fields unchanged: sending would attach a no-op and then DELETE it. */
  errUnchanged: 'Nothing changed, so nothing was sent.',
  /** The edited pair is already on this asset under another row. */
  errDuplicate:
    'This asset already carries that namespace and identifier, so saving would ' +
    'merge the two entries into one. Change one of them, or leave this entry as ' +
    'it is.',

  errForbidden:
    'Your role cannot change the external identifiers of this asset. Ask an ' +
    'editor or administrator.',
  errNotFound: 'This asset no longer exists.',
  errRejected:
    'The API rejected that namespace or identifier. Check both values and try ' +
    'again.',
  errNetwork: 'Could not reach the API. Nothing was changed.',
  errRefresh: 'Could not re-read the external identifiers from the API.',
});

/**
 * The 409 message, naming the asset that already holds the pair so the operator
 * can go and look at it. Only reachable when the operator runs the deployment
 * with `EXTERNAL_ID_UNIQUENESS=enforced` (src/routes/assets.ts:3444).
 *
 * @param {string} namespace
 * @param {string} externalId
 * @param {string} conflictingAssetId
 * @returns {string}
 */
export function conflictMessage(namespace, externalId, conflictingAssetId) {
  return (
    'Asset ' +
    String(conflictingAssetId) +
    ' already carries “' +
    String(namespace) +
    ' / ' +
    String(externalId) +
    '”, and this deployment enforces one owner per identifier. Nothing was ' +
    'changed.'
  );
}

/**
 * Reported when the attach succeeded but the detach did not: the asset now
 * carries BOTH pairs. Says so outright rather than claiming a clean edit or a
 * clean failure.
 *
 * @param {{namespace: string, id: string}} before
 * @param {{namespace: string, id: string}} after
 * @returns {string}
 */
export function partialEditMessage(before, after) {
  return (
    '“' +
    after.namespace +
    ' / ' +
    after.id +
    '” was attached, but “' +
    before.namespace +
    ' / ' +
    before.id +
    '” could not be removed, so this asset now carries both. Edit the old entry ' +
    'again to remove it.'
  );
}

/**
 * The one-line outcome of a completed edit.
 *
 * @param {{namespace: string, id: string}} after
 * @returns {string}
 */
export function editResultMessage(after) {
  return 'External identifier is now “' + after.namespace + ' / ' + after.id + '”.';
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Read the `GET /:id/external-ids` 200 body defensively.
 *
 * The body is an ARRAY at the top level (not an envelope). `usable` is false
 * only when the payload is not an array at all — an empty array IS usable and
 * means the asset carries none (see CONTRACT GROUNDING).
 *
 * Order is the server's, preserved: the route documents the list as "in
 * persisted order … no dedup, sort, or reformatting" (src/routes/assets.ts:
 * 3543-3545), and re-sorting here would hide the order an integration wrote.
 * Entries that are not objects with two non-empty strings are dropped — nothing
 * the schema could have produced, and a half-read pair has no editable identity
 * (the DELETE path needs both components).
 *
 * @param {unknown} payload
 * @returns {{ items: {namespace: string, id: string}[], usable: boolean }}
 */
export function normaliseExternalIds(payload) {
  if (!Array.isArray(payload)) return { items: [], usable: false };
  const items = [];
  payload.forEach(function (entry) {
    if (!entry || typeof entry !== 'object') return;
    const ns = entry.namespace;
    const id = entry.id;
    if (typeof ns !== 'string' || ns === '') return;
    if (typeof id !== 'string' || id === '') return;
    items.push({ namespace: ns, id: id });
  });
  return { items: items, usable: true };
}

/**
 * Identity of a pair, for comparing rows. Both components are opaque strings
 * that may contain any character, so they are joined on a separator no wire
 * value can contain (`\u0000` is not producible by a JSON string the server
 * sends through `z.string()` in practice, and even if it were, the join is only
 * used for equality — never parsed back apart).
 *
 * @param {{namespace?: unknown, id?: unknown}} pair
 * @returns {string}
 */
export function externalIdKey(pair) {
  const p = pair || {};
  return String(p.namespace) + '\u0000' + String(p.id);
}

/**
 * Decide what a submitted inline edit should do, BEFORE anything is sent.
 *
 * Values are NOT trimmed. Both components are opaque upstream keys the API
 * treats as free-form strings (min 1 / max 256 or 1024 — no pattern, no
 * normalisation, src/routes/assets.ts:500-523), so silently rewriting what was
 * typed could produce a correlation that does not match the upstream system.
 * Only the server's own bounds are mirrored.
 *
 * Four outcomes:
 *   - `invalid`   — fails a bound the POST declares; refused without a call.
 *   - `unchanged` — both components equal the original. Critical: the API has no
 *                   update, so applying this would POST an idempotent no-op and
 *                   then DELETE the very pair it just confirmed, removing the
 *                   identifier. Refused.
 *   - `duplicate` — the edited pair is already attached to THIS asset on another
 *                   row. Attach would be a no-op and the detach would still
 *                   fire, silently collapsing two entries into one. Refused.
 *   - `apply`     — carries the exact attach body and the exact detach target.
 *
 * @param {{namespace: string, id: string}} before   the pair as the API returned it
 * @param {{namespace: string, id: string}} after    what the operator typed
 * @param {{namespace: string, id: string}[]} [current] the whole list on screen
 * @returns {{kind: 'invalid'|'unchanged'|'duplicate'|'apply', message?: string,
 *            attach?: {namespace: string, id: string},
 *            detach?: {namespace: string, id: string}}}
 */
export function planExternalIdEdit(before, after, current) {
  const b = before || {};
  const a = after || {};
  const ns = typeof a.namespace === 'string' ? a.namespace : '';
  const id = typeof a.id === 'string' ? a.id : '';

  if (ns === '') return { kind: 'invalid', message: EXTERNAL_IDS_COPY.errNamespaceEmpty };
  if (id === '') return { kind: 'invalid', message: EXTERNAL_IDS_COPY.errIdEmpty };
  if (ns.length > EXTERNAL_ID_LIMITS.namespaceMax) {
    return { kind: 'invalid', message: EXTERNAL_IDS_COPY.errNamespaceTooLong };
  }
  if (id.length > EXTERNAL_ID_LIMITS.idMax) {
    return { kind: 'invalid', message: EXTERNAL_IDS_COPY.errIdTooLong };
  }

  const next = { namespace: ns, id: id };
  if (externalIdKey(next) === externalIdKey(b)) {
    return { kind: 'unchanged', message: EXTERNAL_IDS_COPY.errUnchanged };
  }

  const list = Array.isArray(current) ? current : [];
  const clashes = list.some(function (entry) {
    return externalIdKey(entry) !== externalIdKey(b) && externalIdKey(entry) === externalIdKey(next);
  });
  if (clashes) {
    return { kind: 'duplicate', message: EXTERNAL_IDS_COPY.errDuplicate };
  }

  return { kind: 'apply', attach: next, detach: { namespace: b.namespace, id: b.id } };
}

/**
 * Classify a failed attach (`POST /:id/external-ids`).
 *
 * 400, 404 and 409 are declared on the operation; 401/403 come from the ADR-018
 * gate and are not declared (the same undeclared-status class as the lock and
 * review routes), so they are handled without assuming a modelled body. The 409
 * body IS modelled and its fields are read by name — `namespace`, `externalId`,
 * `conflictingAssetId` (src/routes/assets.ts:529-536).
 *
 * @param {{status?: number, message?: string, body?: any}} err  an apiFetch rejection
 * @returns {{kind: 'forbidden'|'not-found'|'conflict'|'rejected'|'other', message: string}}
 */
export function classifyAttachError(err) {
  const e = err || {};
  switch (e.status) {
    case 401:
    case 403:
      return { kind: 'forbidden', message: EXTERNAL_IDS_COPY.errForbidden };
    case 404:
      return { kind: 'not-found', message: EXTERNAL_IDS_COPY.errNotFound };
    case 409: {
      const b = e.body && typeof e.body === 'object' ? e.body : {};
      if (typeof b.conflictingAssetId === 'string' && b.conflictingAssetId !== '') {
        return {
          kind: 'conflict',
          message: conflictMessage(b.namespace, b.externalId, b.conflictingAssetId),
        };
      }
      // A 409 whose declared fields did not arrive: report the server's own
      // sentence rather than inventing one.
      return {
        kind: 'conflict',
        message:
          typeof e.message === 'string' && e.message !== ''
            ? e.message
            : EXTERNAL_IDS_COPY.errRejected,
      };
    }
    case 400:
      return { kind: 'rejected', message: EXTERNAL_IDS_COPY.errRejected };
    default:
      return { kind: 'other', message: EXTERNAL_IDS_COPY.errNetwork };
  }
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** Human label for a pair, used in accessible names and messages. */
function pairLabel(pair) {
  return pair.namespace + ' / ' + pair.id;
}

/**
 * Build the whole block for one read of the sub-resource. PURE: no fetch, no
 * listeners — `mountAssetExternalIds` wires the buttons it returns.
 *
 * Accessibility: the table is named by a visually-hidden caption (the sighted
 * reader has the section heading), every header cell carries `scope="col"`
 * including the actions column — whose header is visually hidden rather than
 * absent, so the column is announced — and each Edit button's accessible name
 * names the row it acts on. The visible word "Edit" is the first word of that
 * accessible name (WCAG 2.5.3 Label in Name).
 *
 * @param {{items: {namespace: string, id: string}[], usable: boolean}} read
 * @param {{canEdit?: boolean}} [opts]
 * @returns {{ block: HTMLElement, rows: {pair: object, tr: HTMLElement,
 *             namespaceCell: HTMLElement, idCell: HTMLElement,
 *             actionsCell: HTMLElement, editBtn: HTMLElement|null}[],
 *             msgHost: HTMLElement }}
 */
export function renderExternalIdsBlock(read, opts) {
  const o = opts || {};
  const r = read && typeof read === 'object' ? read : { items: [], usable: false };
  const items = Array.isArray(r.items) ? r.items : [];
  const canEdit = o.canEdit !== false;

  const block = el('div', 'mt12 external-ids-block');
  block.id = 'external-ids';
  // `.section-title` is the house heading for a detail-panel block (cf. "Status
  // history", public/app.js; "Tracks", public/tracks-panel.js).
  block.appendChild(el('div', 'section-title', EXTERNAL_IDS_COPY.heading));
  block.appendChild(el('div', 'external-ids-note', EXTERNAL_IDS_COPY.intro));

  const msgHost = el('div', 'mt8 external-ids-msg');
  msgHost.id = 'external-ids-msg';
  // Outcomes are announced without moving focus.
  msgHost.setAttribute('aria-live', 'polite');

  const rows = [];

  if (!r.usable) {
    const box = el('div', 'empty', EXTERNAL_IDS_COPY.unavailable);
    box.setAttribute('data-empty', 'external-ids-unavailable');
    box.appendChild(el('div', 'external-ids-note', EXTERNAL_IDS_COPY.unavailableDetail));
    block.appendChild(box);
    block.appendChild(msgHost);
    return { block: block, rows: rows, msgHost: msgHost };
  }

  if (items.length === 0) {
    const box = el('div', 'empty', EXTERNAL_IDS_COPY.empty);
    box.setAttribute('data-empty', 'external-ids');
    box.appendChild(el('div', 'external-ids-note', EXTERNAL_IDS_COPY.emptyDetail));
    block.appendChild(box);
    block.appendChild(msgHost);
    return { block: block, rows: rows, msgHost: msgHost };
  }

  const wrap = el('div', 'table-wrap');
  const table = document.createElement('table');
  table.className = 'external-ids-table';
  table.appendChild(el('caption', 'visually-hidden', EXTERNAL_IDS_COPY.tableCaption));

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  [EXTERNAL_IDS_COPY.colNamespace, EXTERNAL_IDS_COPY.colIdentifier].forEach(function (label) {
    const th = el('th', null, label);
    th.setAttribute('scope', 'col');
    headRow.appendChild(th);
  });
  if (canEdit) {
    const actionsTh = el('th', null, null);
    actionsTh.setAttribute('scope', 'col');
    actionsTh.appendChild(el('span', 'visually-hidden', EXTERNAL_IDS_COPY.colActions));
    headRow.appendChild(actionsTh);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  items.forEach(function (pair, index) {
    const tr = document.createElement('tr');
    tr.className = 'external-id-row';
    // Row identity for the wiring and for tests. Both are opaque strings set as
    // attribute VALUES (never interpolated into markup).
    tr.setAttribute('data-namespace', pair.namespace);
    tr.setAttribute('data-external-id', pair.id);

    // `.cell-id` is the house monospace treatment for opaque identifiers
    // (public/copy-id.js, public/tracks-panel.js).
    const namespaceCell = el('td', 'cell-id external-id-namespace', pair.namespace);
    const idCell = el('td', 'cell-id external-id-value', pair.id);
    tr.appendChild(namespaceCell);
    tr.appendChild(idCell);

    let editBtn = null;
    let actionsCell = null;
    if (canEdit) {
      actionsCell = el('td', 'external-id-actions');
      editBtn = el('button', 'btn-ghost external-id-edit', EXTERNAL_IDS_COPY.btnEdit);
      editBtn.type = 'button';
      editBtn.id = 'btn-external-id-edit-' + index;
      editBtn.setAttribute(
        'aria-label',
        EXTERNAL_IDS_COPY.btnEdit + ' external identifier ' + pairLabel(pair)
      );
      actionsCell.appendChild(editBtn);
      tr.appendChild(actionsCell);
    }

    tbody.appendChild(tr);
    rows.push({
      pair: pair,
      tr: tr,
      namespaceCell: namespaceCell,
      idCell: idCell,
      actionsCell: actionsCell,
      editBtn: editBtn,
    });
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  block.appendChild(wrap);

  if (canEdit) {
    // The two-call edit is stated on screen, not just in the source.
    block.appendChild(el('div', 'external-ids-note', EXTERNAL_IDS_COPY.editNote));
  } else {
    const roleNote = el('div', 'external-ids-note', EXTERNAL_IDS_COPY.readOnly);
    roleNote.id = 'external-ids-role-note';
    block.appendChild(roleNote);
  }

  block.appendChild(msgHost);
  return { block: block, rows: rows, msgHost: msgHost };
}

/**
 * Turn one rendered row into its editing state: a text input per component,
 * plus Save / Cancel. Returns the controls so the caller can wire them.
 *
 * The inputs are bounded by the POST schema (`maxLength`) and labelled for
 * assistive technology against the row they came from — a table cell gives a
 * sighted reader the column header, but an input inside it needs its own name.
 *
 * @param {{pair: object, tr: HTMLElement, namespaceCell: HTMLElement,
 *          idCell: HTMLElement, actionsCell: HTMLElement}} row
 * @returns {{namespaceInput: HTMLInputElement, idInput: HTMLInputElement,
 *            saveBtn: HTMLElement, cancelBtn: HTMLElement, errorEl: HTMLElement}}
 */
export function enterRowEdit(row) {
  const label = pairLabel(row.pair);

  function field(cell, value, max, name, className) {
    cell.textContent = '';
    cell.classList.remove('cell-id');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'input ' + className;
    input.maxLength = max;
    // Prefilled through `value` — asset-controlled text, never markup.
    input.value = value;
    input.setAttribute('aria-label', name + ' for external identifier ' + label);
    cell.appendChild(input);
    return input;
  }

  const namespaceInput = field(
    row.namespaceCell,
    row.pair.namespace,
    EXTERNAL_ID_LIMITS.namespaceMax,
    EXTERNAL_IDS_COPY.colNamespace,
    'external-id-namespace-input'
  );
  const idInput = field(
    row.idCell,
    row.pair.id,
    EXTERNAL_ID_LIMITS.idMax,
    EXTERNAL_IDS_COPY.colIdentifier,
    'external-id-value-input'
  );

  row.actionsCell.textContent = '';
  const saveBtn = el('button', 'btn-ghost external-id-save', EXTERNAL_IDS_COPY.btnSave);
  saveBtn.type = 'button';
  saveBtn.setAttribute('aria-label', EXTERNAL_IDS_COPY.btnSave + ' external identifier ' + label);
  const cancelBtn = el('button', 'btn-ghost external-id-cancel', EXTERNAL_IDS_COPY.btnCancel);
  cancelBtn.type = 'button';
  cancelBtn.setAttribute(
    'aria-label',
    EXTERNAL_IDS_COPY.btnCancel + ' editing external identifier ' + label
  );
  row.actionsCell.appendChild(saveBtn);
  row.actionsCell.appendChild(document.createTextNode(' '));
  row.actionsCell.appendChild(cancelBtn);

  // A refusal keeps the row OPEN and writes here, next to the fields, so the
  // operator never loses what they typed. `role="alert"` so it is announced.
  const errorEl = el('div', 'msg msg-error external-id-row-error');
  errorEl.setAttribute('role', 'alert');
  errorEl.style.display = 'none';
  row.actionsCell.appendChild(errorEl);

  row.tr.classList.add('external-id-row--editing');
  return {
    namespaceInput: namespaceInput,
    idInput: idInput,
    saveBtn: saveBtn,
    cancelBtn: cancelBtn,
    errorEl: errorEl,
  };
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Render the "External identifiers" block and wire its inline editors.
 *
 * Reads `GET /api/v1/assets/{id}/external-ids` — the asset read model carries
 * NOTHING to list from: `assetSchema` declares no `externalIdentifiers`
 * property, so the fastify-zod serializer strips the field out of every asset
 * body (src/routes/assets.ts:3536-3539). The dedicated sub-resource is the only
 * way to see them, so this block costs one extra round-trip and there is no way
 * to avoid it.
 *
 * After a completed edit the sub-resource is re-read and the block rebuilt from
 * that answer — never patched locally, because the attach returns the asset
 * (which does not carry the set) and the detach returns no body at all.
 *
 * The block is inserted before `anchorEl` when given, else appended to `host`.
 *
 * @param {object} opts
 * @param {string}      opts.assetId    the ULID. Both write routes and this read
 *                                      resolve the param with a plain `repo.get`
 *                                      (src/routes/assets.ts:3595) — no slug
 *                                      fallback — so a slug would 404.
 *                                      `asset.id` is the ULID even when the pane
 *                                      was opened by slug.
 * @param {HTMLElement} [opts.host]     container to append to
 * @param {HTMLElement} [opts.anchorEl] element to insert before, inside its parent
 * @param {boolean}     [opts.canEdit]  client-role mirror of the ADR-018 matrix
 * @param {Function}    opts.apiFetch
 * @param {Function}    [opts.showMsg]  house message renderer (host, text, kind)
 * @returns {Promise<{ block: HTMLElement, refresh: () => Promise<void>,
 *                     read: () => object }>}
 */
export async function mountAssetExternalIds(opts) {
  const o = opts || {};
  const apiFetch = o.apiFetch;
  const base = '/assets/' + encodeURIComponent(String(o.assetId)) + '/external-ids';

  // The most recent server answer. Never edited locally.
  let current = { items: [], usable: false };
  let rendered = null;
  let placed = false;
  let editing = null;

  /**
   * The detach URL for one pair. Both components are encoded: a namespace or an
   * upstream id may contain `/`, `?`, `#` or a colon (the route is two path
   * segments precisely so a colon-bearing URN stays unambiguous,
   * src/routes/assets.ts:3461-3463), and an unencoded one would address a
   * different resource.
   */
  function detachUrl(pair) {
    return (
      base +
      '/' +
      encodeURIComponent(pair.namespace) +
      '/' +
      encodeURIComponent(pair.id)
    );
  }

  function place(block) {
    if (!placed) {
      if (o.anchorEl && o.anchorEl.parentNode) {
        o.anchorEl.parentNode.insertBefore(block, o.anchorEl);
      } else if (o.host) {
        o.host.appendChild(block);
      }
      placed = true;
      return;
    }
    if (rendered && rendered.block && rendered.block.parentNode) {
      rendered.block.parentNode.replaceChild(block, rendered.block);
    }
  }

  function report(text, kind) {
    if (!rendered) return;
    if (typeof o.showMsg === 'function') {
      o.showMsg(rendered.msgHost, text, kind || 'error');
      return;
    }
    rendered.msgHost.appendChild(el('div', 'msg msg-' + (kind || 'error'), text));
  }

  /** Only one row is editable at a time — two half-finished edits over a
   *  non-atomic two-call write is a state nobody can reason about. */
  function setOtherEditButtons(disabled) {
    if (!rendered) return;
    rendered.rows.forEach(function (row) {
      if (row.editBtn && row !== editing) row.editBtn.disabled = disabled;
    });
  }

  /**
   * Replace the block with a render of `read`.
   *
   * `focusKey` restores keyboard focus to the Edit button of the named pair
   * after the rebuild. Closing an editor destroys the control that had focus,
   * which would otherwise drop the keyboard user back to the top of the
   * document; this puts them on the row they were working on. When the pair no
   * longer exists (an edit changed it) the caller passes the NEW key, and when
   * neither is present focus is simply left alone.
   */
  function draw(read, focusKey) {
    current = read;
    editing = null;
    const next = renderExternalIdsBlock(read, { canEdit: o.canEdit !== false });
    place(next.block);
    rendered = next;
    next.rows.forEach(function (row) {
      if (!row.editBtn) return;
      row.editBtn.addEventListener('click', function () {
        beginEdit(row);
      });
      if (focusKey !== undefined && externalIdKey(row.pair) === focusKey) {
        row.editBtn.focus();
      }
    });
  }

  function beginEdit(row) {
    if (editing) return;
    editing = row;
    setOtherEditButtons(true);
    const controls = enterRowEdit(row);
    controls.cancelBtn.addEventListener('click', function () {
      // Discard: re-render from the last server answer, so the row returns to
      // exactly what the API said — never to a locally remembered value.
      draw(current, externalIdKey(row.pair));
    });
    controls.saveBtn.addEventListener('click', function () {
      save(row, controls);
    });
    controls.namespaceInput.focus();
  }

  function rowError(controls, text) {
    controls.errorEl.textContent = text;
    controls.errorEl.style.display = '';
  }

  async function save(row, controls) {
    const plan = planExternalIdEdit(
      row.pair,
      { namespace: controls.namespaceInput.value, id: controls.idInput.value },
      current.items
    );
    if (plan.kind === 'unchanged') {
      // Nothing to send — and critically, NOT an attach followed by a detach of
      // the same pair, which would delete the identifier (see CONTRACT
      // GROUNDING). Close the editor quietly.
      draw(current, externalIdKey(row.pair));
      report(EXTERNAL_IDS_COPY.errUnchanged, 'info');
      return;
    }
    if (plan.kind !== 'apply') {
      rowError(controls, plan.message);
      return;
    }

    const busy = [controls.saveBtn, controls.cancelBtn];
    busy.forEach(function (b) {
      b.disabled = true;
    });
    controls.saveBtn.textContent = EXTERNAL_IDS_COPY.btnSave + EXTERNAL_IDS_COPY.busySuffix;
    controls.errorEl.style.display = 'none';

    // 1. ATTACH the corrected pair. Body is exactly the two declared properties
    //    (`additionalProperties: false`).
    try {
      await apiFetch(base, {
        method: 'POST',
        body: JSON.stringify({ namespace: plan.attach.namespace, id: plan.attach.id }),
      });
    } catch (err) {
      const c = classifyAttachError(err);
      busy.forEach(function (b) {
        b.disabled = false;
      });
      controls.saveBtn.textContent = EXTERNAL_IDS_COPY.btnSave;
      if (c.kind === 'not-found') {
        // The asset is gone; the row is meaningless. Re-read so the block says
        // so rather than offering an editor onto nothing.
        await refresh(true);
        report(c.message, 'error');
        return;
      }
      rowError(controls, c.message);
      return;
    }

    // 2. DETACH the pair being replaced. 204 whether or not it was carried, so
    //    only a transport/authorisation failure lands here — and when it does,
    //    the asset legitimately carries both pairs and the message says so.
    let detached = true;
    try {
      await apiFetch(detachUrl(plan.detach), { method: 'DELETE' });
    } catch (_) {
      detached = false;
    }

    // 3. Re-read. Neither write returns the identifier set (the attach returns
    //    the asset, which omits it; the detach returns no body), so the server
    //    is the only source for what the row should now show. Focus lands on
    //    the corrected row, which is where the operator was.
    await refresh(true, externalIdKey(plan.attach));
    if (detached) {
      report(editResultMessage(plan.attach), 'success');
    } else {
      report(partialEditMessage(plan.detach, plan.attach), 'error');
    }
  }

  async function refresh(quiet, focusKey) {
    let read;
    try {
      read = normaliseExternalIds(await apiFetch(base));
    } catch (err) {
      read = { items: [], usable: false };
      draw(read);
      if (!quiet) {
        report(
          err && err.status === 404 ? EXTERNAL_IDS_COPY.errNotFound : EXTERNAL_IDS_COPY.errRefresh,
          'error'
        );
      }
      return;
    }
    draw(read, focusKey);
  }

  await refresh(false);

  return {
    get block() {
      return rendered && rendered.block;
    },
    refresh: function () {
      return refresh(true);
    },
    read: function () {
      return current;
    },
  };
}
