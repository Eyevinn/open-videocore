/**
 * open-videocore ops dashboard — external-ids.js
 *
 * The "External identifiers" block on the asset detail view (issue #908, broken
 * out of #796): every `{ namespace, id }` correlation attached to the asset,
 * listed with its namespace and value visible, plus add / edit / remove controls
 * — each offered ONLY because the verified contract exposes a method that can
 * perform it.
 *
 * Every operator-visible string is written with `textContent` / `createElement`.
 * No server value ever reaches `innerHTML`, including a namespace this build has
 * never seen (the vocabulary is free text — see below), which is rendered
 * verbatim as text rather than guessed at, normalised or dropped.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's generated spec (`openapi.json`) and the route source on
 * this branch. Nothing is taken from the issue text. `openapi.json` declares no
 * `operationId` on any operation, so operations are named below by path +
 * method, exactly as the spec itself identifies them.
 *
 * THE METHODS THAT EXIST. `openapi.json .paths` carries exactly three operations
 * for this sub-resource — checked key by key, not assumed:
 *     `/api/v1/assets/{id}/external-ids`                        -> `get`, `post`
 *     `/api/v1/assets/{id}/external-ids/{namespace}/{externalId}` -> `delete`
 *   There is NO `put` and NO `patch` on either path. That single fact shapes this
 *   whole module: see "EDIT IS NOT A METHOD" below.
 *
 *   READ — `…/external-ids`.get  (src/routes/assets.ts:3315-3362)
 *     summary: "List an asset's upstream external identifiers".
 *     parameters: exactly one — path `id` (string, required). No query params.
 *     responses: exactly `200` and `404`.
 *     200 schema: `array` of
 *         `{ namespace: string, id: string }`,
 *         `required: ["namespace","id"]`, `additionalProperties: false`.
 *       Description, verbatim: "External identifiers attached to the asset, in
 *       persisted order. Empty when none are attached."
 *     404 schema: `{ error: string, message?: string }`, `required: ["error"]`
 *       (`errorSchema`, src/routes/assets.ts:533).
 *     Handler: `repo.get(request.params.id)` then
 *       `asset.externalIdentifiers ?? []` (src/routes/assets.ts:3353-3360), so an
 *       asset with none is `200 []` — an EMPTY SET, never a miss. 404 means the
 *       ASSET is unknown.
 *     ORDER AND CONTENTS ARE AS STORED — "no dedup, sort, or reformatting"
 *       (:3301-3303). This panel preserves that order and never de-duplicates.
 *
 *   ADD — `…/external-ids`.post  (src/routes/assets.ts:3173-3209)
 *     summary: "Attach an upstream external identifier to an asset".
 *     requestBody: `required: true`, `application/json`, schema
 *       `{ namespace: string (minLength 1, maxLength 256),
 *          id: string (minLength 1, maxLength 1024) }`,
 *       `required: ["namespace","id"]`, `additionalProperties: false`
 *       (`attachExternalIdBodySchema`, src/routes/assets.ts:501-518).
 *       The bounds in `validateExternalIdDraft` below are those four numbers.
 *     parameters: one path param `id` (string, required).
 *     responses: `200`, `400`, `404`, `409`.
 *       200 = the FULL asset (`assetSchema`) — see "THE 200 IS NOT A READ-BACK".
 *       400 = `errorSchema` (empty or oversized component, rejected by the body
 *             schema before the handler runs, :3169).
 *       404 = `errorSchema` (unknown asset id, :3205-3207).
 *       409 = `externalIdConflictSchema` (src/routes/assets.ts:524-531):
 *             `{ error: "external_id_conflict", message?: string,
 *                reason: "external_id_conflict", namespace: string,
 *                externalId: string, conflictingAssetId: string }`,
 *             every field but `message` `required`. Sent by the router error
 *             handler at src/routes/assets.ts:2696-2704 from
 *             `ExternalIdConflictError` (src/data/asset-repo.ts:805-820).
 *     IDEMPOTENT: attaching a pair the asset already carries is a no-op
 *       (`already` short-circuit, src/data/asset-repo.ts:1533-1537).
 *
 *   REMOVE — `…/external-ids/{namespace}/{externalId}`.delete
 *            (src/routes/assets.ts:3247-3294)
 *     summary: "Detach an upstream external identifier from an asset".
 *     parameters: three path params, all required —
 *       `id` (string), `namespace` (string, minLength 1),
 *       `externalId` (string, minLength 1). No body, no query params.
 *     responses: `204` (null), `400`, `404` (both `errorSchema`).
 *     The composite key is TWO PATH SEGMENTS so an upstream id containing a
 *       colon (e.g. a URN) stays unambiguous (:3225-3228); the second segment is
 *       `externalId`, not a second `id`, because find-my-way collapses duplicate
 *       parameter names (:3220-3224). `detachPath()` below therefore
 *       `encodeURIComponent`s each segment independently — verified against the
 *       live route with a namespace containing a space and an id containing both
 *       a colon and a `/` (encoded `%2F`): 204, pair removed.
 *     IDEMPOTENT BY CONTRACT: 204 whether or not the asset carried the pair
 *       (:3240-3243), so a retried or duplicated remove is never an error. 404 is
 *       returned ONLY when the asset itself is unknown.
 *     Removes EVERY entry equal to the pair (`remaining = before.filter(...)`,
 *       src/data/asset-repo.ts:1570), so one call clears a duplicate that an
 *       advisory-mode write accumulated.
 *
 * EDIT IS NOT A METHOD — and this module does not pretend otherwise. There is no
 *   PUT or PATCH on either path, and POST cannot stand in for one: it APPENDS to
 *   the set rather than replacing within a namespace
 *   (`externalIdentifiers: [...(existing.externalIdentifiers ?? []), {…}]`,
 *   src/data/asset-repo.ts:1546-1551), so posting a corrected value for a
 *   namespace leaves the stale pair in place alongside it.
 *   So an edit is performed as the only sequence the contract supports: POST the
 *   new pair, then DELETE the old one — two requests, NOT atomic. The order is
 *   deliberate: adding first means a failure between the two leaves the asset
 *   carrying BOTH pairs (visible on the next read, and removable), never
 *   neither. The copy deck says this out loud rather than presenting the edit as
 *   a single field update, and `EXTERNAL_IDS_COPY.editNote` is shown in the edit
 *   form itself.
 *
 * THE 200 IS NOT A READ-BACK. `POST …/external-ids` answers 200 with the full
 *   asset, but `assetSchema` declares NO `externalIdentifiers` property
 *   (confirmed against `openapi.json .paths["/api/v1/assets/{id}"].get` 200
 *   schema: `additionalProperties: false`, and the property is absent), so the
 *   fastify-zod serializer strips the very field the call just changed — the
 *   reason this sub-resource exists at all (:3293-3299). Every write path here
 *   therefore re-reads `GET …/external-ids` and rebuilds from that answer. The
 *   returned asset body is never parsed for identifiers.
 *
 * UNIQUENESS IS AN OPERATOR MODE, NOT A CLIENT RULE. Per-namespace uniqueness is
 *   enforced only when the operator sets `EXTERNAL_ID_UNIQUENESS=enforced`, read
 *   per request (src/routes/assets.ts:3198-3202). NOTHING in the API advertises
 *   which mode is active — no path, no field — so this panel cannot and does not
 *   pre-validate for it. A collision is handled where it is actually knowable:
 *   reactively, from the 409 envelope, naming `conflictingAssetId` so the
 *   operator can go resolve it (`classifyExternalIdError`).
 *
 * ROLE GATING mirrors ADR-018 decision 2, checked rather than assumed: `MATRIX`
 *   (src/auth/authorize.ts:54-58) grants `read` to every role but `write` and
 *   `delete` to `editor`/`admin` only, `methodToAction` (:79-93) maps GET->read,
 *   POST->write, DELETE->delete, and `resourceAuthorizationPreHandler('asset')`
 *   runs on every asset route (registered src/routes/assets.ts:1748). So a
 *   `viewer` can LIST identifiers and nothing else. The gate here is a
 *   client-side MIRROR only — a 403 that arrives anyway is still reported, and
 *   the control that earned it stops being offered.
 *
 * THE PATH TAKES A ULID. `GET`/`POST` resolve with `repo.get(request.params.id)`
 *   (src/routes/assets.ts:3353, 3195) — no slug fallback, unlike `GET /assets/{id}`
 *   (:3380-3410). Callers pass `asset.id`, which the detail pane holds even when
 *   it was opened by slug.
 *
 * NAMESPACE IS FREE TEXT, NOT AN ENUM. `namespace` is a bare bounded string in
 *   every one of the three operations — no `enum` in the spec, no `z.enum()` in
 *   the source (`attachExternalIdBodySchema` :501-518, `ExternalIdentifierSchema`
 *   src/data/asset-document.ts:173-186). `ingest-mam` / `rights-registry` appear
 *   only inside `.describe()` prose as examples. So the add/edit form offers a
 *   TEXT FIELD, never a picker, and the copy says the vocabulary is the
 *   operator's. No endpoint enumerates the namespaces in use either, so there is
 *   nothing to populate a suggestion list from beyond what this asset carries.
 */

// ─── Copy deck ───────────────────────────────────────────────────────────────

export const EXTERNAL_IDS_COPY = Object.freeze({
  heading: 'External identifiers',
  intro:
    'Correlations to upstream systems of record. Each entry pairs a namespace ' +
    '(which system) with the opaque identifier this asset has in that system.',

  /** Columns. "Namespace" and "Identifier" are the contract's own two fields. */
  colNamespace: 'Namespace',
  colIdentifier: 'Identifier',
  colActions: 'Actions',
  tableCaption: 'External identifiers attached to this asset, in stored order',

  empty: 'No external identifiers.',
  emptyDetail:
    'Nothing upstream has correlated an identifier to this asset yet. An empty ' +
    'set is a normal state, not a failed read.',

  /** The read failed — distinct from a known-empty set. */
  unavailable: 'External identifiers could not be read.',
  unavailableDetail:
    'The list is unknown, so no identifier is shown and no change is offered. ' +
    'Reload to try again.',

  addHeading: 'Add an identifier',
  addButton: 'Add identifier',
  addSubmit: 'Add',
  cancel: 'Cancel',
  editButton: 'Edit',
  editSubmit: 'Save',
  removeButton: 'Remove',

  namespaceLabel: 'Namespace',
  identifierLabel: 'Identifier',
  /** Says outright that the vocabulary is not fixed by the API. */
  namespaceHint:
    'Free text — the API fixes no list of namespaces. Use the label your ' +
    'upstream system is known by, e.g. a rights registry or an ingest tool.',
  identifierHint:
    'The opaque key this asset has in that system: a UUID, a numeric id, a slug ' +
    'or a URN. Stored and compared verbatim.',

  /**
   * Shown in the edit form. The API has no update method, so an edit is two
   * requests; the operator is told before they commit to it.
   */
  editNote:
    'The API has no update method for an identifier, so saving adds the new ' +
    'pair and then removes the old one. If the second step fails the asset ' +
    'briefly carries both — nothing is lost.',

  /** Read-only, because the role cannot write. */
  readOnly:
    'Your role can read external identifiers but not change them, so no add, ' +
    'edit or remove control is offered. The identifiers themselves stay fully ' +
    'visible.',

  removeConfirmTitle: 'Remove external identifier',
  removeConfirmAffected:
    'The correlation between this asset and that upstream identifier is removed.',
  removeConfirmAffectedLookup:
    'Resolving that identifier upstream will no longer find this asset.',
  removeConfirmUnaffected: 'The asset, its files and its other identifiers are untouched.',
  removeConfirmLabel: 'Remove identifier',

  busySuffix: '…',

  addedMessage: 'Identifier added.',
  editedMessage: 'Identifier updated.',
  removedMessage: 'Identifier removed.',
  unchangedMessage: 'Nothing changed — that is the identifier already stored.',

  errRefresh: 'Could not read the external identifiers for this asset.',
  errNotFound: 'This asset no longer exists.',
  errForbidden: 'Your role may not change external identifiers on this asset.',
  errInvalid: 'The API rejected that identifier.',
  errNamespaceRequired: 'Enter a namespace.',
  errNamespaceTooLong: 'A namespace may be at most 256 characters.',
  errIdentifierRequired: 'Enter an identifier.',
  errIdentifierTooLong: 'An identifier may be at most 1024 characters.',
  errDuplicate: 'This asset already carries that exact namespace and identifier.',
  /**
   * Partial edit: the add landed, the remove did not. Reported as such — the
   * operator must know the old pair survived.
   */
  errEditHalfDone:
    'The new identifier was added, but the old one could not be removed, so the ' +
    'asset now carries both. Remove the old one to finish.',
});

/** Bounds transcribed from `attachExternalIdBodySchema` (src/routes/assets.ts:501-518). */
export const NAMESPACE_MAX_LENGTH = 256;
export const IDENTIFIER_MAX_LENGTH = 1024;

/**
 * The 409 conflict message. Names `conflictingAssetId` from the envelope so the
 * operator can go and look at the asset that already holds the pair.
 *
 * @param {{namespace?: string, externalId?: string, conflictingAssetId?: string}} body
 * @returns {string}
 */
export function conflictMessage(body) {
  const b = body || {};
  const owner = b.conflictingAssetId ? String(b.conflictingAssetId) : null;
  const pair =
    b.namespace && b.externalId ? ' "' + String(b.namespace) + ' / ' + String(b.externalId) + '"' : '';
  if (owner) {
    return (
      'That identifier' +
      pair +
      ' is already attached to asset ' +
      owner +
      '. This stack enforces one asset per identifier, so it cannot be attached here too.'
    );
  }
  return 'That identifier' + pair + ' is already attached to another asset.';
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Normalise a `GET …/external-ids` 200 body into the list the panel renders.
 *
 * The response is an ARRAY (not an envelope) of `{ namespace, id }` with both
 * fields `required`. Order and contents are preserved exactly — the route
 * promises them "as stored … no dedup, sort, or reformatting"
 * (src/routes/assets.ts:3301-3303), so neither does this.
 *
 * Non-object entries are dropped (nothing the schema could produce). An entry
 * missing a `required` field is KEPT and rendered with `—` in that cell: a server
 * that answers oddly should be visible, not silently filtered.
 *
 * @param {unknown} payload  a `GET /api/v1/assets/{id}/external-ids` 200 body
 * @returns {{namespace: unknown, id: unknown}[]}
 */
export function normaliseExternalIds(payload) {
  if (!Array.isArray(payload)) return [];
  return payload.filter(function (e) {
    return e !== null && typeof e === 'object';
  });
}

/**
 * Whether two entries are the same pair, by the API's own equality: BOTH
 * components, compared verbatim (`e.namespace === ref.namespace && e.id === ref.id`,
 * src/data/asset-repo.ts:1570 and :1534-1536). No trimming, no case folding — the
 * API does none, and inventing either here would make the UI disagree with the
 * store about what "already attached" means.
 *
 * @param {{namespace?: unknown, id?: unknown}} a
 * @param {{namespace?: unknown, id?: unknown}} b
 * @returns {boolean}
 */
export function sameExternalId(a, b) {
  if (!a || !b) return false;
  return a.namespace === b.namespace && a.id === b.id;
}

/**
 * Validate a draft against `attachExternalIdBodySchema` (src/routes/assets.ts:501-518)
 * before spending a round-trip on a request the boundary would 400.
 *
 * Checks EXACTLY what the schema checks — non-empty, and the two maximum lengths
 * — and nothing more. No character class, no shape, no namespace vocabulary: the
 * API accepts any string within the bounds, so rejecting more here would be this
 * module inventing a contract. `duplicates` is a separate, local check against
 * the set currently on screen (the API would answer 200 as an idempotent no-op,
 * which is not what the operator asked for).
 *
 * @param {{namespace?: unknown, id?: unknown}} draft
 * @param {{existing?: object[], ignore?: object}} [opts]
 * @returns {{ok: boolean, errors: {namespace?: string, id?: string, form?: string}}}
 */
export function validateExternalIdDraft(draft, opts) {
  const d = draft || {};
  const o = opts || {};
  const errors = {};
  const namespace = typeof d.namespace === 'string' ? d.namespace : '';
  const id = typeof d.id === 'string' ? d.id : '';

  if (namespace.length === 0) {
    errors.namespace = EXTERNAL_IDS_COPY.errNamespaceRequired;
  } else if (namespace.length > NAMESPACE_MAX_LENGTH) {
    errors.namespace = EXTERNAL_IDS_COPY.errNamespaceTooLong;
  }
  if (id.length === 0) {
    errors.id = EXTERNAL_IDS_COPY.errIdentifierRequired;
  } else if (id.length > IDENTIFIER_MAX_LENGTH) {
    errors.id = EXTERNAL_IDS_COPY.errIdentifierTooLong;
  }

  if (!errors.namespace && !errors.id) {
    const candidate = { namespace: namespace, id: id };
    const clash = (Array.isArray(o.existing) ? o.existing : []).some(function (e) {
      if (o.ignore && sameExternalId(e, o.ignore)) return false;
      return sameExternalId(e, candidate);
    });
    if (clash) errors.form = EXTERNAL_IDS_COPY.errDuplicate;
  }

  return { ok: Object.keys(errors).length === 0, errors: errors };
}

/**
 * The `DELETE` path for one pair.
 *
 * Three segments, each `encodeURIComponent`-ed independently, because the route
 * declares the composite key as `/{namespace}/{externalId}` precisely so a value
 * containing a colon stays unambiguous (src/routes/assets.ts:3225-3228). Verified
 * against the live route: a namespace with a space and an id containing `:` and
 * `/` (encoded `%2F`) match and remove correctly.
 *
 * @param {string} assetId  the ULID (the route does not resolve slugs)
 * @param {{namespace: string, id: string}} ref
 * @returns {string} path relative to the API base, as `apiFetch` expects
 */
export function detachPath(assetId, ref) {
  return (
    '/assets/' +
    encodeURIComponent(String(assetId)) +
    '/external-ids/' +
    encodeURIComponent(String(ref.namespace)) +
    '/' +
    encodeURIComponent(String(ref.id))
  );
}

/** The collection path, used by both the read and the add. */
export function externalIdsPath(assetId) {
  return '/assets/' + encodeURIComponent(String(assetId)) + '/external-ids';
}

/**
 * Turn an `apiFetch` rejection into operator-facing copy plus a handling hint.
 *
 * Maps only statuses the three operations actually declare, plus the 403 the
 * ADR-018 router gate can add to any asset route:
 *   400 -> the boundary refused the pair (`errorSchema`).
 *   403 -> role gate (`forbidden_insufficient_role`, src/auth/authorize.ts:99);
 *          `revokeControls` so a control known to fail stops being offered.
 *   404 -> the ASSET is gone (never "the pair is gone" — a missing pair is a 204
 *          on DELETE and a 200 no-op on POST); `refresh`.
 *   409 -> `external_id_conflict`, enforced-uniqueness mode only.
 * Anything else falls back to the server's own message.
 *
 * @param {{status?: number, message?: string, body?: any}} err
 * @returns {{kind: string, message: string, refresh: boolean, revokeControls: boolean}}
 */
export function classifyExternalIdError(err) {
  const e = err || {};
  const status = e.status;
  if (status === 409) {
    return {
      kind: 'conflict',
      message: conflictMessage(e.body),
      refresh: true,
      revokeControls: false,
    };
  }
  if (status === 403) {
    return {
      kind: 'forbidden',
      message: EXTERNAL_IDS_COPY.errForbidden,
      refresh: false,
      revokeControls: true,
    };
  }
  if (status === 404) {
    return {
      kind: 'not-found',
      message: EXTERNAL_IDS_COPY.errNotFound,
      refresh: true,
      revokeControls: false,
    };
  }
  if (status === 400) {
    return {
      kind: 'invalid',
      message:
        e.message && String(e.message) !== 'HTTP 400'
          ? EXTERNAL_IDS_COPY.errInvalid + ' ' + String(e.message)
          : EXTERNAL_IDS_COPY.errInvalid,
      refresh: false,
      revokeControls: false,
    };
  }
  return {
    kind: 'error',
    message: e.message ? String(e.message) : EXTERNAL_IDS_COPY.errRefresh,
    refresh: false,
    revokeControls: false,
  };
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/** A value the server omitted. Matches the tracks panel's `—`. */
function cellText(value) {
  if (value === undefined || value === null || value === '') return '—';
  return String(value);
}

let fieldSeq = 0;

/**
 * One labelled text field with its own hint and error slot.
 *
 * The label is a real `<label for>`, the hint is wired through
 * `aria-describedby`, and an error is announced by pointing `aria-describedby`
 * at it too and setting `aria-invalid` (WCAG 2.1 AA: 1.3.1, 3.3.1, 3.3.2 — the
 * error is text next to the field, never colour alone).
 */
function buildField(spec) {
  const uid = 'extid-f' + ++fieldSeq;
  const wrap = el('div', 'external-id-field');

  const label = el('label', 'external-id-label', spec.label);
  label.setAttribute('for', uid);
  wrap.appendChild(label);

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'input external-id-input';
  input.id = uid;
  input.value = spec.value == null ? '' : String(spec.value);
  input.setAttribute('maxlength', String(spec.maxLength));
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('spellcheck', 'false');
  input.setAttribute('data-field', spec.name);
  wrap.appendChild(input);

  const hint = el('div', 'external-id-hint', spec.hint);
  hint.id = uid + '-hint';
  wrap.appendChild(hint);

  const error = el('div', 'external-id-error');
  error.id = uid + '-err';
  error.setAttribute('aria-live', 'polite');
  wrap.appendChild(error);

  input.setAttribute('aria-describedby', hint.id);

  return { wrap: wrap, input: input, error: error, hintId: hint.id, errorId: error.id };
}

/**
 * Paint (or clear) per-field validation errors from `validateExternalIdDraft`.
 * Exported so a test can assert the wiring without driving a submit.
 *
 * @param {{fields: object, formError: HTMLElement}} form
 * @param {{namespace?: string, id?: string, form?: string}} errors
 */
export function applyExternalIdFormErrors(form, errors) {
  const e = errors || {};
  ['namespace', 'id'].forEach(function (name) {
    const field = form.fields[name];
    if (!field) return;
    const message = e[name];
    field.error.textContent = message || '';
    if (message) {
      field.input.setAttribute('aria-invalid', 'true');
      field.input.setAttribute('aria-describedby', field.hintId + ' ' + field.errorId);
    } else {
      field.input.removeAttribute('aria-invalid');
      field.input.setAttribute('aria-describedby', field.hintId);
    }
  });
  if (form.formError) form.formError.textContent = e.form || '';
}

/**
 * The add/edit form. One shape for both, because both send the SAME body to the
 * SAME operation (`POST …/external-ids`) — the edit merely follows it with a
 * DELETE of the pair it replaced.
 *
 * @param {{mode: 'add'|'edit', value?: {namespace: string, id: string}}} spec
 */
function buildForm(spec) {
  const mode = spec.mode;
  const value = spec.value || { namespace: '', id: '' };

  const form = document.createElement('form');
  form.className = 'external-id-form external-id-form--' + mode;
  form.setAttribute('novalidate', 'novalidate');
  // A real <form> so Enter submits; the handler always preventDefault()s.
  form.id = mode === 'add' ? 'external-id-add-form' : 'external-id-edit-form';

  const legendText = mode === 'add' ? EXTERNAL_IDS_COPY.addHeading : EXTERNAL_IDS_COPY.editButton;
  const fieldset = document.createElement('fieldset');
  fieldset.className = 'external-id-fieldset';
  const legend = el('legend', 'external-id-legend', legendText);
  fieldset.appendChild(legend);

  if (mode === 'edit') {
    // Said before the operator commits, not after it half-fails.
    fieldset.appendChild(el('div', 'external-id-note', EXTERNAL_IDS_COPY.editNote));
  }

  const namespaceField = buildField({
    name: 'namespace',
    label: EXTERNAL_IDS_COPY.namespaceLabel,
    hint: EXTERNAL_IDS_COPY.namespaceHint,
    value: value.namespace,
    maxLength: NAMESPACE_MAX_LENGTH,
  });
  const idField = buildField({
    name: 'id',
    label: EXTERNAL_IDS_COPY.identifierLabel,
    hint: EXTERNAL_IDS_COPY.identifierHint,
    value: value.id,
    maxLength: IDENTIFIER_MAX_LENGTH,
  });
  fieldset.appendChild(namespaceField.wrap);
  fieldset.appendChild(idField.wrap);

  const formError = el('div', 'external-id-error external-id-form-error');
  formError.setAttribute('aria-live', 'polite');
  fieldset.appendChild(formError);

  const actions = el('div', 'mt8 flex-gap');
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.className = 'btn-ghost external-id-submit';
  submit.textContent = mode === 'add' ? EXTERNAL_IDS_COPY.addSubmit : EXTERNAL_IDS_COPY.editSubmit;
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'btn-ghost external-id-cancel';
  cancel.textContent = EXTERNAL_IDS_COPY.cancel;
  actions.appendChild(submit);
  actions.appendChild(cancel);
  fieldset.appendChild(actions);

  form.appendChild(fieldset);

  return {
    form: form,
    fields: { namespace: namespaceField, id: idField },
    formError: formError,
    submit: submit,
    cancel: cancel,
    draft: function () {
      return { namespace: namespaceField.input.value, id: idField.input.value };
    },
  };
}

// ─── Block ───────────────────────────────────────────────────────────────────

/**
 * Build the whole block for one read. PURE: no fetch, no listeners — the mount
 * wires every control this returns.
 *
 * `canChange` gates the add/edit/remove controls only. The LIST is rendered
 * identically either way, so a viewer sees every namespace and value (their role
 * holds `read`).
 *
 * @param {{entries: object[], usable: boolean}} state
 * @param {{canChange?: boolean, editing?: object|null, adding?: boolean}} [opts]
 */
export function renderExternalIdsBlock(state, opts) {
  const s = state || { entries: [], usable: false };
  const o = opts || {};
  const canChange = o.canChange !== false;
  const entries = Array.isArray(s.entries) ? s.entries : [];

  const block = el('div', 'mt12 external-ids-block');
  block.id = 'asset-external-ids';
  block.appendChild(el('div', 'section-title', EXTERNAL_IDS_COPY.heading));
  block.appendChild(el('div', 'external-id-note', EXTERNAL_IDS_COPY.intro));

  const msgHost = el('div', 'mt8 external-ids-msg');
  msgHost.id = 'external-ids-msg';
  msgHost.setAttribute('aria-live', 'polite');

  const rowControls = [];
  let addButton = null;
  let form = null;

  if (!s.usable) {
    // The read failed. An unknown set is not an empty one, and no change is
    // offered against a state the panel cannot see — the rule the review and lock
    // blocks apply to their own unknown preconditions.
    const box = el('div', 'empty', EXTERNAL_IDS_COPY.unavailable);
    box.setAttribute('data-empty', 'external-ids-unavailable');
    box.appendChild(el('div', 'external-id-note', EXTERNAL_IDS_COPY.unavailableDetail));
    block.appendChild(box);
    block.appendChild(msgHost);
    return { block, msgHost, rowControls, addButton, form };
  }

  if (entries.length === 0) {
    const box = el('div', 'empty', EXTERNAL_IDS_COPY.empty);
    box.setAttribute('data-empty', 'external-ids');
    box.appendChild(el('div', 'external-id-note', EXTERNAL_IDS_COPY.emptyDetail));
    block.appendChild(box);
  } else {
    const wrap = el('div', 'table-wrap');
    const table = document.createElement('table');
    table.appendChild(el('caption', 'visually-hidden', EXTERNAL_IDS_COPY.tableCaption));

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    const columns = canChange
      ? [EXTERNAL_IDS_COPY.colNamespace, EXTERNAL_IDS_COPY.colIdentifier, EXTERNAL_IDS_COPY.colActions]
      : [EXTERNAL_IDS_COPY.colNamespace, EXTERNAL_IDS_COPY.colIdentifier];
    columns.forEach(function (label) {
      const th = el('th', null, label);
      th.setAttribute('scope', 'col');
      headRow.appendChild(th);
    });
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    entries.forEach(function (entry, index) {
      const tr = document.createElement('tr');
      tr.className = 'external-id-row';
      // Index, not the pair: the route returns the set "as stored … no dedup"
      // (src/routes/assets.ts:3301-3303), so two identical rows are possible and
      // must stay individually addressable in the DOM.
      tr.setAttribute('data-row', String(index));

      // Namespace in its own cell with its own column header — the acceptance
      // criterion is that namespace AND value are both visible, so neither is
      // folded into a single "ns:id" string (which an id containing a colon
      // would make ambiguous anyway).
      const nsCell = el('td', 'external-id-namespace', cellText(entry.namespace));
      const idCell = el('td', 'cell-id external-id-value', cellText(entry.id));
      tr.appendChild(nsCell);
      tr.appendChild(idCell);

      if (canChange) {
        const actions = el('td', 'external-id-actions');
        const editBtn = el('button', 'btn-ghost external-id-edit', EXTERNAL_IDS_COPY.editButton);
        editBtn.type = 'button';
        editBtn.setAttribute('data-row', String(index));
        // Names the row's subject so the control is not a bare "Edit" to a
        // screen reader reading controls out of context (WCAG 2.4.6).
        editBtn.setAttribute(
          'aria-label',
          EXTERNAL_IDS_COPY.editButton + ' ' + cellText(entry.namespace) + ' ' + cellText(entry.id)
        );
        const removeBtn = el('button', 'btn-ghost external-id-remove', EXTERNAL_IDS_COPY.removeButton);
        removeBtn.type = 'button';
        removeBtn.setAttribute('data-row', String(index));
        removeBtn.setAttribute(
          'aria-label',
          EXTERNAL_IDS_COPY.removeButton + ' ' + cellText(entry.namespace) + ' ' + cellText(entry.id)
        );
        actions.appendChild(editBtn);
        actions.appendChild(removeBtn);
        tr.appendChild(actions);
        rowControls.push({ index: index, entry: entry, edit: editBtn, remove: removeBtn });
      }

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);
    block.appendChild(wrap);
  }

  if (!canChange) {
    // Explain the absence rather than render a control that is a guaranteed 403.
    const roleNote = el('div', 'external-id-note external-id-role-note', EXTERNAL_IDS_COPY.readOnly);
    roleNote.id = 'external-ids-role-note';
    block.appendChild(roleNote);
    block.appendChild(msgHost);
    return { block, msgHost, rowControls, addButton, form };
  }

  if (o.editing) {
    form = buildForm({ mode: 'edit', value: o.editing });
    block.appendChild(form.form);
  } else if (o.adding) {
    form = buildForm({ mode: 'add' });
    block.appendChild(form.form);
  } else {
    addButton = el('button', 'btn-ghost external-id-add', EXTERNAL_IDS_COPY.addButton);
    addButton.type = 'button';
    addButton.id = 'btn-external-id-add';
    const actions = el('div', 'mt8 flex-gap external-ids-actions');
    actions.appendChild(addButton);
    block.appendChild(actions);
  }

  block.appendChild(msgHost);
  return { block, msgHost, rowControls, addButton, form };
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Render the "External identifiers" block and wire its controls.
 *
 * Reads `GET /api/v1/assets/{id}/external-ids` — the ONLY operation that exposes
 * the set, because `assetSchema` carries no `externalIdentifiers` property (see
 * CONTRACT GROUNDING), so the asset body the detail pane already holds cannot
 * supply it. Every write re-reads the same operation rather than trusting the
 * POST's 200 asset, which has the field stripped.
 *
 * The block is inserted before `anchorEl` when given, else appended to `host`.
 *
 * @param {object} opts
 * @param {string}      opts.assetId    the ULID — GET/POST resolve with
 *                                      `repo.get` and no slug fallback
 *                                      (src/routes/assets.ts:3353, 3195)
 * @param {HTMLElement} [opts.host]
 * @param {HTMLElement} [opts.anchorEl]
 * @param {boolean}     [opts.canChange] client mirror of the ADR-018 write/delete
 *                                       gate (editor|admin)
 * @param {Function}    opts.apiFetch
 * @param {Function}    [opts.confirmModal] house destructive-confirm primitive
 * @param {Function}    [opts.showMsg]      house message renderer
 * @returns {Promise<{block: HTMLElement, refresh: Function, entries: Function}>}
 */
export async function mountAssetExternalIds(opts) {
  const o = opts || {};
  const apiFetch = o.apiFetch;
  const assetId = String(o.assetId);
  const listPath = externalIdsPath(assetId);

  // The single source of truth for what this block may send: the most recent
  // server answer. Never edited locally.
  let state = { entries: [], usable: false };
  let canChange = o.canChange !== false;
  let view = { adding: false, editing: null };
  let rendered = null;
  let placed = false;

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

  function draw() {
    const next = renderExternalIdsBlock(state, {
      canChange: canChange,
      adding: view.adding,
      editing: view.editing,
    });
    place(next.block);
    rendered = next;

    if (next.addButton) {
      next.addButton.addEventListener('click', function () {
        view = { adding: true, editing: null };
        draw();
        const field = rendered.form && rendered.form.fields.namespace;
        if (field) field.input.focus();
      });
    }

    next.rowControls.forEach(function (row) {
      row.edit.addEventListener('click', function () {
        view = {
          adding: false,
          // Snapshot, so the form edits a copy and `original` stays the pair the
          // DELETE must target.
          editing: { namespace: String(row.entry.namespace), id: String(row.entry.id) },
        };
        draw();
        const field = rendered.form && rendered.form.fields.namespace;
        if (field) field.input.focus();
      });
      row.remove.addEventListener('click', function () {
        remove(row.entry, row.remove);
      });
    });

    if (next.form) {
      const original = view.editing ? { namespace: view.editing.namespace, id: view.editing.id } : null;
      next.form.cancel.addEventListener('click', function () {
        view = { adding: false, editing: null };
        draw();
      });
      next.form.form.addEventListener('submit', function (event) {
        event.preventDefault();
        submit(next.form, original);
      });
    }
  }

  async function refresh(quiet) {
    let entries;
    try {
      entries = normaliseExternalIds(await apiFetch(listPath));
    } catch (err) {
      state = { entries: [], usable: false };
      view = { adding: false, editing: null };
      draw();
      if (!quiet) {
        const c = classifyExternalIdError(err);
        report(c.kind === 'not-found' ? EXTERNAL_IDS_COPY.errNotFound : EXTERNAL_IDS_COPY.errRefresh);
      }
      return;
    }
    state = { entries: entries, usable: true };
    draw();
  }

  /** Disable every control in the block while a write is in flight. */
  function setBusy(form, busy, label) {
    if (!rendered) return;
    if (form) {
      form.submit.disabled = busy;
      form.cancel.disabled = busy;
      form.submit.textContent = busy ? label + EXTERNAL_IDS_COPY.busySuffix : label;
    }
    rendered.rowControls.forEach(function (row) {
      row.edit.disabled = busy;
      row.remove.disabled = busy;
    });
  }

  /**
   * Add, or save an edit.
   *
   * `POST …/external-ids` is the only write that can put a pair on the asset. For
   * an edit it is followed by `DELETE …/{namespace}/{externalId}` on the pair it
   * replaced — two requests, not atomic, add FIRST so a failure between them
   * leaves both pairs rather than neither (see CONTRACT GROUNDING).
   */
  async function submit(form, original) {
    const raw = form.draft();
    const validation = validateExternalIdDraft(raw, {
      existing: state.entries,
      ignore: original,
    });
    applyExternalIdFormErrors(form, validation.errors);
    if (!validation.ok) {
      // Focus the first offending field so the error is not merely visible.
      const first = validation.errors.namespace ? form.fields.namespace : form.fields.id;
      if (validation.errors.namespace || validation.errors.id) first.input.focus();
      return;
    }

    const next = { namespace: raw.namespace, id: raw.id };
    if (original && sameExternalId(original, next)) {
      // Nothing to send. The API would answer 200 as an idempotent no-op, which
      // would read as a successful change it did not make.
      view = { adding: false, editing: null };
      draw();
      report(EXTERNAL_IDS_COPY.unchangedMessage, 'info');
      return;
    }

    const label = form.submit.textContent;
    setBusy(form, true, label);
    try {
      // Body is exactly the two declared properties. The 200 asset it answers
      // with is deliberately NOT parsed — `assetSchema` strips the field.
      await apiFetch(listPath, {
        method: 'POST',
        body: JSON.stringify(next),
      });
    } catch (err) {
      const c = classifyExternalIdError(err);
      setBusy(form, false, label);
      if (c.revokeControls) canChange = false;
      if (c.refresh || c.revokeControls) {
        view = { adding: false, editing: null };
        await refresh(true);
      }
      report(c.message);
      return;
    }

    if (original) {
      try {
        await apiFetch(detachPath(assetId, original), { method: 'DELETE' });
      } catch (err) {
        // The add landed; the removal did not. Both pairs are now attached, and
        // the operator is told exactly that — the half-done state is recoverable
        // (remove the old row) but only if it is visible.
        view = { adding: false, editing: null };
        await refresh(true);
        const c = classifyExternalIdError(err);
        report(EXTERNAL_IDS_COPY.errEditHalfDone + ' ' + c.message);
        return;
      }
    }

    view = { adding: false, editing: null };
    await refresh(true);
    report(original ? EXTERNAL_IDS_COPY.editedMessage : EXTERNAL_IDS_COPY.addedMessage, 'success');
  }

  /**
   * Remove one pair. Confirmed first through the house destructive-confirm
   * primitive (issue #919) — this detaches a correlation an upstream system may
   * be resolving by.
   */
  async function remove(entry, btn) {
    const ref = { namespace: String(entry.namespace), id: String(entry.id) };
    if (typeof o.confirmModal === 'function') {
      const confirmed = await o.confirmModal({
        title: EXTERNAL_IDS_COPY.removeConfirmTitle,
        // Named by the pair itself: the namespace and the value, which is what
        // the operator recognises. There is no other human-readable handle.
        subject: ref.namespace + ' / ' + ref.id,
        question: 'Remove external identifier "' + ref.namespace + ' / ' + ref.id + '"?',
        confirmLabel: EXTERNAL_IDS_COPY.removeConfirmLabel,
        affected: [
          EXTERNAL_IDS_COPY.removeConfirmAffected,
          EXTERNAL_IDS_COPY.removeConfirmAffectedLookup,
        ],
        unaffected: [EXTERNAL_IDS_COPY.removeConfirmUnaffected],
      });
      if (!confirmed) return;
    }

    const label = btn.textContent;
    setBusy(null, true);
    btn.textContent = label + EXTERNAL_IDS_COPY.busySuffix;
    try {
      // 204, idempotently, whether or not the pair was still attached
      // (src/routes/assets.ts:3240-3243) — so a double click is not an error.
      await apiFetch(detachPath(assetId, ref), { method: 'DELETE' });
    } catch (err) {
      const c = classifyExternalIdError(err);
      if (c.revokeControls) canChange = false;
      await refresh(true);
      report(c.message);
      return;
    }
    await refresh(true);
    report(EXTERNAL_IDS_COPY.removedMessage, 'success');
  }

  await refresh(true);
  return {
    get block() {
      return rendered ? rendered.block : null;
    },
    refresh: function () {
      return refresh(false);
    },
    entries: function () {
      return state.entries;
    },
  };
}
