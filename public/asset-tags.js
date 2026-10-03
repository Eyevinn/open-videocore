/**
 * open-videocore ops dashboard — asset-tags.js
 *
 * The asset DETAIL view's "Tags" panel (issue #934, broken out of #792): the
 * asset's current tag list, an add control, and a remove control per tag.
 *
 * Tags have been readable AND writable over the API since issue #11, but no
 * control in this UI could ever write one — the detail pane rendered them as a
 * read-only row in the key/value grid. This module is that missing control.
 *
 * UI ONLY. No route, schema or response shape changes for this: the panel sends
 * the two tag sub-resource operations exactly as they are already declared.
 *
 * Everything operator-visible here is written with `textContent` /
 * `createElement`. A tag is tenant data — up to 128 characters of ANY content,
 * `<script>` included (the API constrains length only, see below) — so no tag
 * ever reaches `innerHTML`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's route source and generated spec on this branch, and
 * confirmed by driving the real router with `app.inject` before the UI was
 * written. Nothing is taken from the issue text.
 *
 *   The list — there is NO `GET /assets/{id}/tags`.
 *     `openapi.json .paths["/api/v1/assets/{id}/tags"]` declares exactly ONE
 *     operation, `post`. The tag list is a field on the asset read:
 *     `openapi.json .paths["/api/v1/assets/{id}"].get` 200 →
 *     `tags: { type: 'array', items: { type: 'string' } }`, NOT in `required`.
 *     Source of truth: `assetSchema` — `tags: z.array(z.string()).optional()`,
 *     src/routes/assets.ts:919, commented "Absent until the first tag is set".
 *     So this panel reads the asset the detail renderer already fetched (no
 *     extra round trip) and treats absent and `[]` as the same thing: no tags.
 *     Both really occur — the CouchDB projection drops the key when the list is
 *     empty (`tags: doc.descriptive.tags && …length > 0 ? … : undefined`,
 *     src/data/asset-document.ts:692) while the in-memory repository returns
 *     `[]` (verified: after removing every tag, `GET /assets/{id}` answered
 *     `"tags": []`).
 *
 *   Add — `openapi.json .paths["/api/v1/assets/{id}/tags"].post`
 *     parameters: exactly one — path `id` (string, required). No query params.
 *     requestBody: `required: true`, `application/json`, schema
 *       `{ tags: { type: 'array', items: { type: 'string', minLength: 1,
 *       maxLength: 128 }, minItems: 1, maxItems: 128 } }`,
 *       `required: ['tags']`, `additionalProperties: false`.
 *     responses: exactly `200` (the FULL asset — the same schema as
 *       GET /api/v1/assets/{id}) and `404` (`{ error, message? }`).
 *     Source of truth: `app.post('/:id/tags', …)`, src/routes/assets.ts:5568 —
 *       body `z.object({ tags: z.array(tagSchema).min(1).max(128) })` (:5574),
 *       `response: { 200: assetSchema, 404: errorSchema }` (:5575).
 *     Semantics, from the handler itself (:5583-5584): APPEND, not replace —
 *       `normalizeTags([...(asset.tags ?? []), ...request.body.tags])`. The
 *       existing tags are kept and the result is DEDUPLICATED in first-seen
 *       order (`normalizeTags`, src/data/asset-repo.ts:1297-1308 — a Set pass,
 *       nothing else). Adding a tag that is already present is therefore an
 *       idempotent 200 that changes nothing.
 *
 *   Remove — `openapi.json .paths["/api/v1/assets/{id}/tags/{tag}"].delete`
 *     parameters: path `id` (string, required) and path `tag`
 *       (string, `minLength: 1`, required). No body, no query params.
 *     responses: exactly `200` (the FULL asset) and `404`.
 *     Source of truth: `app.delete('/:id/tags/:tag', …)`,
 *       src/routes/assets.ts:5595 — `params: z.object({ id: z.string(),
 *       tag: z.string().min(1) })`, filter at :5609
 *       `(asset.tags ?? []).filter((t) => t !== request.params.tag)`.
 *     Removing a tag the asset does not have is a no-op 200 (verified), so a
 *       remove that races another operator is not an error.
 *
 *   THE VALIDATION CONSTRAINTS this module mirrors client-side (issue #934's
 *   third acceptance criterion — "not just server-side 422s"). They come from
 *   `tagSchema = z.string().min(1).max(128)` (src/routes/assets.ts:398) and
 *   `tagsSchema = z.array(tagSchema).max(128)` (:399):
 *     - length 1..128 characters per tag. NOT bytes: zod's `.min`/`.max` on a
 *       string count UTF-16 code units, so a 128-character non-ASCII tag is
 *       accepted (verified: a 128-× `ü` tag round-tripped add AND remove).
 *     - ALLOWED CHARACTERS: all of them. There is no pattern, no charset and no
 *       case rule anywhere in the schema — verified end to end that
 *       `with/slash`, `with space`, `with#hash`, `with?q`, `with%25`, `ÅÄÖ-ünï`
 *       and `   ` are all accepted by POST and all removable by DELETE. This
 *       client therefore adds NO character rule of its own: refusing input the
 *       API accepts would be a client-side contract of its own invention.
 *     - at most 128 tags IN ONE REQUEST (`minItems: 1`, `maxItems: 128`). This
 *       panel adds one tag per request, so only `minItems` can bite — and an
 *       empty value is already refused by the length rule.
 *     - at most 128 tags IN THE LIST (`tagsSchema.max(128)`, the cap on the
 *       asset's own tag array). See TAGS_MAX_TOTAL below for why this one is
 *       enforced here even though the append route does not re-check it.
 *   A body that violates the schema is rejected by fastify-type-provider-zod
 *   with a **400** in Fastify's validation envelope (`FST_ERR_VALIDATION`,
 *   verified: `{"statusCode":400,…,"message":"body/tags/0 String must contain
 *   at most 128 character(s)"}`) BEFORE the handler runs. 400 is not declared
 *   on either operation, so nothing here assumes a modelled body for it — and
 *   the panel validates first, so a 400 is not how an operator learns the rule.
 *
 *   Whitespace is NOT trimmed by the API: a tag of three spaces is stored and
 *     returned verbatim (verified). This client trims what the operator typed
 *     and refuses a whitespace-only value, for the same reason the rename
 *     dialog does (`normaliseRenameInput`, public/asset-rename.js): the
 *     difference between `promo` and `promo ` is invisible in every rendering
 *     of a tag, so letting it through manufactures a duplicate nobody can see.
 *     Already-stored tags are never rewritten by this rule — they render and
 *     remove exactly as stored.
 *
 *   Authorisation — `MATRIX` (src/auth/authorize.ts:54-58): `viewer`
 *     { read: true, write: false, delete: false }, editor and admin all true.
 *     `methodToAction` (:79-93) maps POST → `write` and DELETE → `delete`,
 *     applied by `resourceAuthorizationPreHandler('asset')` registered for the
 *     whole assets router (src/routes/assets.ts:1773). So BOTH tag mutations are
 *     refused to a viewer with 403 `forbidden_insufficient_role`
 *     (AUTHZ_FORBIDDEN_ERROR, src/auth/authorize.ts:99) — verified against the
 *     real router with the `x-ovc-role` header (ROLE_HEADER,
 *     src/auth/principal.ts:36): viewer POST → 403 `write`, viewer DELETE → 403
 *     `delete`, editor → 200 for both. `canChange` below is the client-side
 *     MIRROR of that rule; the 403 path still runs, because the server is the
 *     authority.
 *
 *   Path parameter — the sub-resource takes the ULID, never the slug. Both
 *     handlers call `repo.get(request.params.id)` with the raw param and there
 *     is no slug fallback (unlike GET /:id), verified: POST to
 *     `/assets/<slug>/tags` answers 404. This module is handed `asset.id`,
 *     which the detail pane holds even when it was opened by slug.
 *     A tag goes into the path through `encodeURIComponent`, which is what
 *     makes `with/slash` (→ `with%2F…`) and `with%25` removable; the deployed
 *     app raises Fastify's `maxParamLength` to 500 (src/main.ts:185, default
 *     100), so a 128-character tag survives the round trip encoded.
 */

// ─── Server-enforced bounds (see CONTRACT GROUNDING) ─────────────────────────

/** `tagSchema.min(1)` — src/routes/assets.ts:398. */
export const TAG_MIN_LENGTH = 1;

/** `tagSchema.max(128)` — src/routes/assets.ts:398. Characters, not bytes. */
export const TAG_MAX_LENGTH = 128;

/** `z.array(tagSchema).min(1).max(128)` on the POST body — src/routes/assets.ts:5574. */
export const TAGS_MAX_PER_REQUEST = 128;

/**
 * `tagsSchema = z.array(tagSchema).max(128)` — src/routes/assets.ts:399: the
 * declared cap on an asset's tag LIST, applied by `POST /assets` and by
 * `PATCH /assets/{id}` (which replaces the list wholesale).
 *
 * The append route does NOT re-check it: it merges and stores whatever comes
 * out, and the persisted document schema has no cap
 * (`tags: z.array(z.string()).default([])`, src/data/asset-document.ts:288), so
 * repeated POSTs really do push a list past 128 — verified: a list of 131 tags
 * was accepted, after which `PATCH /assets/{id}` with that list was refused 400
 * by `tagsSchema`. That asymmetry is an API-side gap (reported in the
 * implementation note, not worked around here).
 *
 * This panel honours the DECLARED cap rather than the gap: it refuses to add the
 * 129th tag instead of quietly building an asset whose tag list the API's own
 * replace operation will no longer accept. Removal is never blocked, so a list
 * that is already over the cap can always be brought back under it.
 */
export const TAGS_MAX_TOTAL = 128;

// ─── Copy deck ───────────────────────────────────────────────────────────────
//
// Frozen so a caller cannot drift the wording, and exported so a test asserts
// against the same sentences the operator sees.

export const TAGS_COPY = Object.freeze({
  /** `tags.heading` — the detail-panel block title. */
  heading: 'Tags',
  /** `tags.intro` — what a tag is for, in one sentence. */
  intro:
    'Freeform labels for finding this asset again. Tags are matched exactly by ' +
    'the Tags filter in search.',
  /** `tags.empty` — no tags yet. Absent and empty are the same thing. */
  empty: 'No tags yet.',
  /** `tags.list.label` — accessible name of the tag list. */
  listLabel: 'Tags on this asset',
  /** `tags.remove.label` — per-tag button; the tag itself is appended. */
  removeLabel: 'Remove tag',
  /** `tags.field.label` */
  fieldLabel: 'Add a tag',
  /** `tags.field.help` — the server's own rule, in words. */
  fieldHelp:
    'Up to ' +
    TAG_MAX_LENGTH +
    ' characters. Any characters are allowed. One tag at a time; press Enter to add.',
  /** `tags.btn.add` */
  btnAdd: 'Add tag',
  /** `tags.btn.adding` */
  busyAdd: 'Adding…',
  /** `tags.readOnly` — role gate (pre-emptive mirror of the 403 below). */
  readOnly:
    'Your role can see this asset’s tags but cannot change them. Ask an editor ' +
    'or administrator.',
  /** `tags.error.empty` */
  errEmpty: 'Enter a tag. A tag cannot be empty or only spaces.',
  /** `tags.error.long` */
  errTooLong: 'Tag is too long (maximum ' + TAG_MAX_LENGTH + ' characters).',
  /** `tags.error.duplicate` */
  errDuplicate: 'This asset already has that tag.',
  /** `tags.error.listFull` */
  errListFull:
    'This asset already has ' +
    TAGS_MAX_TOTAL +
    ' tags, which is the maximum the API accepts for a tag list. Remove one first.',
  /** `tags.error.forbidden` */
  errForbidden:
    'Your role cannot change this asset’s tags. Ask an editor or administrator.',
  /** `tags.error.notFound` */
  errNotFound: 'This asset no longer exists. Its tags were not changed.',
  /** `tags.error.rejected` — a 400/422 the client-side rules did not catch. */
  errRejected: 'The API rejected that tag. The tag list was not changed.',
  /** `tags.error.network` */
  errNetwork: 'Could not reach the API. The tag list was not changed.',
  /** `tags.error.refresh` — the post-mutation re-read failed. */
  errRefresh: 'Could not re-read the tag list from the API.',
});

/**
 * The sentence announced after a successful add.
 * @param {string} tag
 * @returns {string}
 */
export function tagAddedMessage(tag) {
  return 'Added tag “' + String(tag) + '”.';
}

/**
 * The sentence announced after a successful remove.
 * @param {string} tag
 * @returns {string}
 */
export function tagRemovedMessage(tag) {
  return 'Removed tag “' + String(tag) + '”.';
}

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * The asset's tag list, read defensively off an asset body.
 *
 * `tags` is OPTIONAL in the contract and both shapes occur for "no tags"
 * (absent on the CouchDB projection, `[]` in memory — see CONTRACT GROUNDING),
 * so both collapse to `[]` here. Non-string entries are dropped: a value this
 * client could not send back to `DELETE /tags/{tag}` must not become a chip with
 * a remove button that cannot work.
 *
 * The server's ORDER is preserved — it is meaningful (`normalizeTags` keeps
 * first-seen order, src/data/asset-repo.ts:1297), so this never sorts.
 *
 * @param {unknown} asset
 * @returns {string[]}
 */
export function readTags(asset) {
  const a = asset && typeof asset === 'object' ? asset : {};
  if (!Array.isArray(a.tags)) return [];
  return a.tags.filter(function (t) {
    return typeof t === 'string' && t.length > 0;
  });
}

/**
 * Validate what the operator typed against the server's OWN bounds, before any
 * request is made (issue #934 AC3).
 *
 * The rules, in the order they are applied:
 *   `empty`     — nothing left after trimming. `tagSchema.min(1)` would reject
 *                 `''` with a 400; `'   '` the API would actually ACCEPT, and
 *                 this client refuses it anyway (see CONTRACT GROUNDING).
 *   `too-long`  — over `TAG_MAX_LENGTH` (`tagSchema.max(128)`).
 *   `duplicate` — already on the asset. The API answers 200 and changes nothing
 *                 (the append route deduplicates), so this is not an error the
 *                 server would report; refusing locally avoids a pointless write
 *                 that bumps `updatedAt` and appends a provenance entry.
 *   `list-full` — the list is already at `TAGS_MAX_TOTAL`.
 * NO character rule is applied, because the schema has none.
 *
 * @param {unknown} raw            the raw input value
 * @param {readonly string[]} [currentTags]  the asset's current tags
 * @returns {{ value: string, ok: boolean, reason: 'empty'|'too-long'|'duplicate'|'list-full'|null, message: string|null }}
 */
export function normaliseTagInput(raw, currentTags) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const current = Array.isArray(currentTags) ? currentTags : [];
  if (value.length < TAG_MIN_LENGTH) {
    return { value, ok: false, reason: 'empty', message: TAGS_COPY.errEmpty };
  }
  if (value.length > TAG_MAX_LENGTH) {
    return { value, ok: false, reason: 'too-long', message: TAGS_COPY.errTooLong };
  }
  // Exact match only: tags are matched exactly by the search filter and the
  // remove route, and the API treats case as significant, so `Promo` is a
  // different tag from `promo` here too.
  if (current.indexOf(value) !== -1) {
    return { value, ok: false, reason: 'duplicate', message: TAGS_COPY.errDuplicate };
  }
  if (current.length >= TAGS_MAX_TOTAL) {
    return { value, ok: false, reason: 'list-full', message: TAGS_COPY.errListFull };
  }
  return { value, ok: true, reason: null, message: null };
}

/**
 * The path for `POST /assets/{id}/tags`, relative to the API base.
 * @param {string} assetId  the ULID (the sub-resource does not resolve slugs)
 * @returns {string}
 */
export function tagsPath(assetId) {
  return '/assets/' + encodeURIComponent(String(assetId)) + '/tags';
}

/**
 * The path for `DELETE /assets/{id}/tags/{tag}`, relative to the API base.
 *
 * `encodeURIComponent` on the tag is what makes a tag containing `/`, `?`, `#`
 * or `%` removable — all of which the API accepts as tags (see CONTRACT
 * GROUNDING). Kept exported so the encoding is assertable.
 *
 * @param {string} assetId  the ULID
 * @param {string} tag
 * @returns {string}
 */
export function tagPath(assetId, tag) {
  return tagsPath(assetId) + '/' + encodeURIComponent(String(tag));
}

/**
 * Build the JSON body for `POST /assets/{id}/tags`.
 *
 * EXACTLY the one declared property, carrying exactly one tag: this panel adds
 * one tag per request, so a partial failure cannot leave the operator guessing
 * which of several tags landed. `additionalProperties: false`, so no sibling key
 * is ever sent. Keeping the body construction in one exported function is what
 * makes that assertable.
 *
 * @param {string} tag
 * @returns {{ tags: string[] }}
 */
export function addTagRequestBody(tag) {
  return { tags: [String(tag)] };
}

/**
 * Classify a failed tag mutation into operator-facing copy.
 *
 * `403` (role gate) and `400` (schema violation) are both reachable and NEITHER
 * is declared on these operations — only 200 and 404 are — so nothing here
 * assumes a modelled body. `404` means the ASSET is gone (both handlers 404 only
 * on an unknown asset; an unknown TAG is a 200 no-op), which is worth a re-read
 * so the panel stops claiming a list that no longer exists.
 *
 * @param {{status?: number, message?: string, body?: any}} err  an apiFetch rejection
 * @returns {{kind: 'forbidden'|'not-found'|'rejected'|'other', message: string, refresh: boolean}}
 */
export function classifyTagError(err) {
  const e = err || {};
  switch (e.status) {
    case 401:
    case 403:
      return { kind: 'forbidden', message: TAGS_COPY.errForbidden, refresh: false };
    case 404:
      return { kind: 'not-found', message: TAGS_COPY.errNotFound, refresh: true };
    case 400:
    case 422:
      // A rule the client-side validation did not catch. Re-read, because the
      // list on screen is no longer known to match the server.
      return { kind: 'rejected', message: TAGS_COPY.errRejected, refresh: true };
    default:
      // Transport failure, 5xx, or anything else undeclared: one honest
      // sentence that states the outcome (nothing changed).
      return { kind: 'other', message: TAGS_COPY.errNetwork, refresh: false };
  }
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * Render the tag list: one chip per tag, each with its own remove button.
 *
 * PURE: no fetch, no listeners — the caller wires the buttons it is handed.
 * Built as a real `<ul>` so the list has a length and a label in the
 * accessibility tree (WCAG 1.3.1), and each remove control is a real `<button>`
 * so it is reachable and operable from the keyboard (2.1.1). The tag text is its
 * own element so the button's accessible name names the tag it removes
 * ("Remove tag “promo”") rather than being a row of identical "Remove" buttons.
 *
 * @param {readonly string[]} tags
 * @param {{ canChange?: boolean }} [opts]
 * @returns {{ listEl: HTMLElement, removeButtons: HTMLButtonElement[] }}
 */
export function renderTagList(tags, opts) {
  const o = opts || {};
  const list = Array.isArray(tags) ? tags : [];
  const removeButtons = [];

  if (list.length === 0) {
    const emptyEl = el('div', 'text-muted tags-empty', TAGS_COPY.empty);
    return { listEl: emptyEl, removeButtons };
  }

  const ul = el('ul', 'tag-list');
  ul.setAttribute('aria-label', TAGS_COPY.listLabel);
  list.forEach(function (tag) {
    const li = el('li', 'tag-chip');
    // `.tag` is the house tag pill (used by the assets table and search
    // results), so a tag reads the same wherever it appears.
    li.appendChild(el('span', 'tag tag-chip-label', tag));
    if (o.canChange) {
      const btn = el('button', 'tag-remove', '×');
      btn.type = 'button';
      // The glyph is decorative; the accessible name carries the tag.
      btn.setAttribute('aria-label', TAGS_COPY.removeLabel + ' “' + tag + '”');
      btn.setAttribute('title', TAGS_COPY.removeLabel + ' “' + tag + '”');
      btn.setAttribute('data-tag', tag);
      li.appendChild(btn);
      removeButtons.push(btn);
    }
    ul.appendChild(li);
  });
  return { listEl: ul, removeButtons };
}

/**
 * Build the whole block. PURE: no fetch, no listeners.
 *
 * The add form is created ONCE and is never re-rendered by a mutation — only the
 * list host is — so a refresh cannot steal focus from the field or discard what
 * is half-typed.
 *
 * @param {readonly string[]} tags
 * @param {{ canChange?: boolean }} [opts]
 * @returns {{ block: HTMLElement, listHost: HTMLElement, input: HTMLInputElement|null,
 *            addBtn: HTMLButtonElement|null, errorEl: HTMLElement|null,
 *            msgHost: HTMLElement }}
 */
export function renderTagsBlock(tags, opts) {
  const o = opts || {};
  const canChange = o.canChange !== false;

  const block = el('div', 'mt12 tags-block');
  block.id = 'asset-tags';
  // `.section-title` is the house heading for a detail-panel block (cf. "Status
  // history" in public/app.js, "Editorial review" in public/review-state.js).
  block.appendChild(el('div', 'section-title', TAGS_COPY.heading));
  block.appendChild(el('div', 'text-muted tags-intro', TAGS_COPY.intro));

  const listHost = el('div', 'mt8 tags-list-host');
  listHost.id = 'asset-tags-list';
  const rendered = renderTagList(tags, { canChange: canChange });
  listHost.appendChild(rendered.listEl);
  block.appendChild(listHost);

  // Outcome announcements (added / removed / failed). A change that does not
  // move focus is still announced.
  const msgHost = el('div', 'mt8 tags-msg');
  msgHost.id = 'asset-tags-msg';
  msgHost.setAttribute('aria-live', 'polite');

  if (!canChange) {
    // Pre-emptive mirror of the ADR-018 matrix: a viewer holds `read` but
    // neither `write` nor `delete`, so both mutations are a guaranteed 403.
    // Explaining the absence beats offering controls that cannot work — and the
    // tags themselves stay fully visible.
    const roleNote = el('div', 'text-muted tags-role-note', TAGS_COPY.readOnly);
    roleNote.id = 'asset-tags-role-note';
    block.appendChild(roleNote);
    block.appendChild(msgHost);
    return { block, listHost, input: null, addBtn: null, errorEl: null, msgHost };
  }

  const row = el('div', 'mt8 flex-gap tags-add-row');
  const field = el('div', 'form-field tags-add-field');
  const label = el('label', null, TAGS_COPY.fieldLabel);
  label.setAttribute('for', 'asset-tag-input');

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'asset-tag-input';
  // Mirrors `tagSchema.max(128)` at the keyboard, so the bound is felt before
  // it is explained. The length check in `normaliseTagInput` still runs — a
  // paste or a scripted value can exceed `maxLength`.
  input.maxLength = TAG_MAX_LENGTH;
  input.setAttribute('autocomplete', 'off');

  const help = el('div', 'text-muted tags-field-help', TAGS_COPY.fieldHelp);
  help.id = 'asset-tag-help';

  const errorEl = el('div', 'msg msg-error tags-add-error');
  errorEl.id = 'asset-tag-error';
  // A validation refusal is announced immediately, not just coloured.
  errorEl.setAttribute('role', 'alert');
  errorEl.style.display = 'none';

  // The field is described by its rule and, when one is showing, by the refusal.
  input.setAttribute('aria-describedby', help.id + ' ' + errorEl.id);

  field.appendChild(label);
  field.appendChild(input);
  row.appendChild(field);

  const addBtn = el('button', 'btn-sm tags-add-submit', TAGS_COPY.btnAdd);
  addBtn.type = 'button';
  addBtn.id = 'asset-tag-add';
  row.appendChild(addBtn);

  block.appendChild(row);
  block.appendChild(help);
  block.appendChild(errorEl);
  block.appendChild(msgHost);

  return { block, listHost, input, addBtn, errorEl, msgHost };
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Render the "Tags" block on the asset detail view and wire its controls.
 *
 * SERVER STATE, ALWAYS (issue #934 AC2). The list on screen is only ever a
 * server answer:
 *   - at mount, the `tags` field of the asset the detail renderer already
 *     fetched (no extra round trip — there is no GET sub-resource anyway);
 *   - after an add or a remove, the `tags` field of the FULL asset that
 *     operation RETURNS — not a locally patched copy. So a dedupe, a
 *     normalisation or a concurrent change by someone else shows up
 *     immediately, and a failed mutation leaves the previous server answer
 *     standing.
 *   - after a 404 or an unexpected rejection, a fresh `GET /assets/{id}`.
 * Nothing in this module edits the list locally.
 *
 * The block is inserted before `anchorEl` when given, else appended to `host`.
 *
 * @param {object} opts
 * @param {object}      opts.asset     the asset body already read by the caller
 *                                     (`id` must be the ULID: the sub-resource
 *                                     does not resolve slugs)
 * @param {HTMLElement} [opts.host]     container to append to
 * @param {HTMLElement} [opts.anchorEl] element to insert before, inside its parent
 * @param {boolean}     [opts.canChange] client-role mirror of the ADR-018 matrix
 * @param {Function}    opts.apiFetch
 * @param {Function}    [opts.showMsg]  house message renderer (host, text, kind)
 * @param {(asset: object) => any} [opts.onChanged] called with the FULL asset a
 *        mutation returned, after the block has re-rendered from it
 * @returns {{ block: HTMLElement, refresh: () => Promise<void>, tags: () => string[] }}
 */
export function mountAssetTags(opts) {
  const o = opts || {};
  const apiFetch = o.apiFetch;
  const asset = o.asset && typeof o.asset === 'object' ? o.asset : {};
  const assetId = String(asset.id == null ? '' : asset.id);
  const canChange = o.canChange !== false;

  // The single source of truth for what is on screen: the most recent server
  // answer. Never edited locally.
  let current = readTags(asset);

  const rendered = renderTagsBlock(current, { canChange: canChange });

  if (o.anchorEl && o.anchorEl.parentNode) {
    o.anchorEl.parentNode.insertBefore(rendered.block, o.anchorEl);
  } else if (o.host) {
    o.host.appendChild(rendered.block);
  }

  function report(text, kind) {
    if (typeof o.showMsg === 'function') {
      o.showMsg(rendered.msgHost, text, kind || 'error');
      return;
    }
    rendered.msgHost.appendChild(el('div', 'msg msg-' + (kind || 'error'), text));
  }

  function showInputError(text) {
    if (!rendered.errorEl) return;
    rendered.errorEl.textContent = text;
    rendered.errorEl.style.display = '';
  }

  function clearInputError() {
    if (!rendered.errorEl) return;
    rendered.errorEl.textContent = '';
    rendered.errorEl.style.display = 'none';
  }

  /**
   * Re-render the list host from a server answer and re-wire the remove
   * buttons. `focusIndex` moves focus onto a surviving chip's remove button
   * after a removal, so keyboard operation continues where it left off
   * (WCAG 2.4.3); when no chip survives, focus goes to the add field.
   */
  function draw(tags, focusIndex) {
    current = tags;
    rendered.listHost.innerHTML = '';
    const next = renderTagList(current, { canChange: canChange });
    rendered.listHost.appendChild(next.listEl);
    next.removeButtons.forEach(function (btn) {
      btn.addEventListener('click', function () {
        remove(btn.getAttribute('data-tag'), btn);
      });
    });
    if (typeof focusIndex === 'number') {
      const target =
        next.removeButtons[Math.min(focusIndex, next.removeButtons.length - 1)] ||
        rendered.input;
      if (target && typeof target.focus === 'function') target.focus();
    }
  }

  // Wire the initial render through the same path, so there is exactly one
  // place that builds chips and binds their buttons.
  draw(current);

  /** Re-read the asset and redraw from it. */
  async function refresh(quiet) {
    try {
      const fresh = await apiFetch('/assets/' + encodeURIComponent(assetId));
      draw(readTags(fresh));
    } catch (err) {
      if (!quiet) {
        report(
          err && err.status === 404 ? TAGS_COPY.errNotFound : TAGS_COPY.errRefresh,
          'error'
        );
      }
    }
  }

  function setBusy(busy) {
    if (rendered.addBtn) {
      rendered.addBtn.disabled = busy;
      rendered.addBtn.textContent = busy ? TAGS_COPY.busyAdd : TAGS_COPY.btnAdd;
    }
    if (rendered.input) rendered.input.disabled = busy;
    rendered.listHost.querySelectorAll('.tag-remove').forEach(function (b) {
      b.disabled = busy;
    });
  }

  /** Both mutations answer with the FULL asset; redraw from THAT, never locally. */
  function adopt(updated, focusIndex) {
    draw(readTags(updated), focusIndex);
  }

  async function handleFailure(err) {
    const c = classifyTagError(err);
    if (c.refresh) await refresh(true);
    if (c.kind === 'forbidden') {
      // A control known to fail stops being offered for the rest of this view
      // of the asset (the lock/review blocks' 403 rule).
      const row = rendered.block.querySelector('.tags-add-row');
      if (row && row.parentNode) row.parentNode.removeChild(row);
      rendered.listHost.querySelectorAll('.tag-remove').forEach(function (b) {
        if (b.parentNode) b.parentNode.removeChild(b);
      });
    }
    report(c.message, 'error');
  }

  async function add() {
    if (!rendered.input) return;
    const check = normaliseTagInput(rendered.input.value, current);
    if (!check.ok) {
      // Client-side refusal (issue #934 AC3): no request is made, the field
      // keeps what was typed, and the rule is stated in words.
      showInputError(check.message);
      rendered.input.focus();
      return;
    }
    clearInputError();
    setBusy(true);
    try {
      const updated = await apiFetch(tagsPath(assetId), {
        method: 'POST',
        body: JSON.stringify(addTagRequestBody(check.value)),
      });
      setBusy(false);
      adopt(updated);
      rendered.input.value = '';
      rendered.input.focus();
      report(tagAddedMessage(check.value), 'success');
      if (typeof o.onChanged === 'function') await o.onChanged(updated);
    } catch (err) {
      setBusy(false);
      await handleFailure(err);
    }
  }

  async function remove(tag, btn) {
    if (typeof tag !== 'string' || tag === '') return;
    const index = current.indexOf(tag);
    setBusy(true);
    if (btn) btn.disabled = true;
    try {
      const updated = await apiFetch(tagPath(assetId, tag), { method: 'DELETE' });
      setBusy(false);
      adopt(updated, index < 0 ? 0 : index);
      report(tagRemovedMessage(tag), 'success');
      if (typeof o.onChanged === 'function') await o.onChanged(updated);
    } catch (err) {
      setBusy(false);
      await handleFailure(err);
    }
  }

  if (rendered.addBtn) {
    rendered.addBtn.addEventListener('click', function () {
      add();
    });
  }
  if (rendered.input) {
    rendered.input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') {
        // The panel is not inside a <form>; Enter is the expected way to commit
        // a single-field control, so bind it explicitly.
        ev.preventDefault();
        add();
      }
    });
    // Typing is an attempt to fix the refusal; stop shouting about the old one.
    rendered.input.addEventListener('input', function () {
      clearInputError();
    });
  }

  return {
    block: rendered.block,
    refresh: function () {
      return refresh(false);
    },
    tags: function () {
      return current.slice();
    },
  };
}
