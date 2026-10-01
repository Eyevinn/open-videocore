/**
 * open-videocore ops dashboard — comments-panel.js
 *
 * The "Comments" block in the asset editorial view (issue #900): the comments
 * already attached to an asset, plus one control to add another. ADD + READ
 * ONLY — this module creates no edit and no delete affordance, because the API
 * exposes neither (see CONTRACT GROUNDING).
 *
 * A failed call never leaves the panel lying: the error is written inline, into
 * the block itself, and the list keeps showing the last answer the server gave.
 * A successful add re-reads the list in place — no page reload, no local
 * splice of an optimistic row (the server mints `id` and `createdAt`, so the
 * only honest list is the one it returns).
 *
 * Every operator-visible string is written with `textContent` /
 * `createElement`. No comment body ever reaches `innerHTML`: a comment is
 * free text typed by a human and is the most obviously attacker-influenced
 * value on this view.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's generated spec and route source on this branch. Nothing
 * is taken from the issue text — in particular the issue calls the endpoint
 * `/comments`, which does not exist: the comments collection is a SUB-RESOURCE
 * of one asset and the real path is `/api/v1/assets/{id}/comments`.
 * `openapi.json` declares no `operationId` on any operation, so operations are
 * identified below by path + method, as the spec itself does.
 *
 *   Read — `openapi.json .paths["/api/v1/assets/{id}/comments"].get`
 *     parameters: exactly one — path `id` (string, required). No query params:
 *       there is no `limit`, `offset`, `cursor` or `order`, so the list is
 *       unpaged and this panel renders every comment the server sends.
 *     responses: exactly `200` and `404`.
 *     200 schema: `type: array`, items
 *       `{ id: string, assetId: string, body: string, createdAt: string }`,
 *       `required: ["id","assetId","body","createdAt"]`,
 *       `additionalProperties: false`. An empty array is a valid 200.
 *     404 schema: `{ error: string, message?: string }`, required `["error"]`.
 *     Source of truth: `app.get('/:id/comments', …)`,
 *       src/routes/assets.ts:4798-4814 — `response: { 200: z.array(commentSchema),
 *       404: errorSchema }` (:4803); the handler resolves the parent asset first
 *       and 404s on an unknown/foreign one (:4807-4810) before sending
 *       `comments.listByAsset(asset.id)` (:4811-4812).
 *     ORDER IS THE SERVER'S. `listByAsset` returns oldest → newest, sorted on
 *       `createdAt` with the ULID `id` breaking same-millisecond ties
 *       (`InMemoryCommentRepository.listByAsset`, src/data/comment-repo.ts:50-58;
 *       interface comment :31). This panel does not re-sort or reverse: it
 *       renders the sequence it was handed, oldest first, and says so on screen.
 *
 *   Write — `openapi.json .paths["/api/v1/assets/{id}/comments"].post`
 *     requestBody: `required: true`, `application/json`, schema
 *       `{ body: string, minLength: 1, maxLength: 4096 }`,
 *       `required: ["body"]`, `additionalProperties: false`. `body` is the ONLY
 *       property the request may carry — there is no author, no timecode, no
 *       parent/thread id and no visibility flag, so this panel offers no field
 *       for any of them.
 *     parameters: one path param `id` (string, required). No query params.
 *     responses: exactly `201` (the created comment, same four-field object as
 *       a list item) and `404` (`{ error, message? }`).
 *     Source of truth: `app.post('/:id/comments', …)`,
 *       src/routes/assets.ts:4776-4793 — `body: commentBodySchema` (:4781),
 *       `response: { 201: commentSchema, 404: errorSchema }` (:4782); the
 *       handler passes `request.body.body` straight through (:4790).
 *     `commentBodySchema`: `z.object({ body: z.string().trim().min(1).max(4096) })`,
 *       src/routes/assets.ts:1174-1176. The `.trim()` runs BEFORE `.min(1)`, so a
 *       whitespace-only body is a 400, not an empty comment
 *       (test/asset-comments.test.ts:160-168) — hence the client-side mirror in
 *       `validateDraft` below trims before measuring.
 *     `commentSchema`: src/routes/assets.ts:1177-1182.
 *     400 IS UNDECLARED IN THE SPEC. The response map lists only 201 and 404,
 *       but the body schema still rejects an empty / whitespace-only / missing
 *       `body` with 400 at the validation layer (asserted three times:
 *       test/asset-comments.test.ts:149-179). It is handled below as a real
 *       outcome rather than as "unexpected".
 *
 *   Record shape — `Comment`, src/data/comment-repo.ts:17-22:
 *     `id` is a ULID, `createdAt` an ISO 8601 string, both SERVER-MINTED
 *     (`InMemoryCommentRepository.create`, :38-48). The client cannot supply or
 *     predict either, which is why an added comment is re-read rather than
 *     guessed into the list.
 *
 *   Authorisation — the ADR-018 role×action matrix `MATRIX`
 *     (src/auth/authorize.ts:54-58: `viewer { read: true, write: false }`,
 *     editor/admin all true), applied by `resourceAuthorizationPreHandler('asset')`
 *     (src/auth/authorize.ts:126, registered src/routes/assets.ts:1748) with the
 *     action derived by `methodToAction` (src/auth/authorize.ts:79-93): GET →
 *     `read`, POST → `write`. So a `viewer` may READ every comment but is
 *     refused the POST with 403 `AUTHZ_FORBIDDEN_ERROR =
 *     'forbidden_insufficient_role'` (src/auth/authorize.ts:99). `canAdd` is the
 *     caller's client-role mirror of that rule; the 403 path below runs
 *     regardless, because the server is the authority.
 *
 * WHAT THE API DOES NOT EXPOSE (checked, not assumed):
 *   - NO EDIT AND NO DELETE. `openapi.json .paths["/api/v1/assets/{id}/comments"]`
 *     carries exactly two operations — `post` and `get` — and there is no
 *     `…/comments/{commentId}` path at all. `CommentRepository` declares only
 *     `create` and `listByAsset` (src/data/comment-repo.ts:29-33). So the MVP's
 *     add-and-read scope is not a UI choice to revisit: an edit or delete
 *     control here would have nothing to call.
 *   - NO AUTHOR. `Comment` has no `author`/`createdBy` field
 *     (src/data/comment-repo.ts:17-22) and the API has no per-user identity to
 *     fill one with — every authenticated caller is the same deployment-wide
 *     operator principal (src/auth/principal.ts:11-16), and there is no whoami
 *     endpoint. This panel therefore attributes nothing to anyone and says why,
 *     rather than printing a role name as if it were a byline.
 *   - NO SERVER-SIDE PAGING, ORDERING OR SEARCH over comments: the GET takes no
 *     query parameters. The list is rendered whole.
 *   - NOT DURABLE ACROSS A RESTART in this iteration. The deployment wires the
 *     in-memory implementation (`new InMemoryCommentRepository()`,
 *     src/main.ts:979, passed at :1881) — a `Map` in the API process
 *     (src/data/comment-repo.ts:36), with a CouchDB-backed impl noted as a later
 *     step (:11). The panel states this plainly instead of implying an archive.
 */

// ─── Copy deck ───────────────────────────────────────────────────────────────

export const COMMENTS_COPY = Object.freeze({
  heading: 'Comments',
  /** Says what the block is and, in the same breath, what it cannot do. */
  intro:
    'Free-text notes on this asset, oldest first. Comments can be added and ' +
    'read here — the API has no edit or delete operation for them, so neither ' +
    'is offered.',
  /** No `author` field exists and no per-user identity exists to fill one. */
  attributionNote:
    'The API stores no author for a comment, so none is shown.',
  /** The repository wired in this deployment is in-memory (src/main.ts:979). */
  durabilityNote:
    'This iteration keeps comments in the API process, so they do not survive ' +
    'an API restart.',

  /** The add control. */
  formLabel: 'Add a comment',
  placeholder: 'Write a note about this asset…',
  submit: 'Add comment',
  submitBusy: 'Adding…',
  /** Mirrors `commentBodySchema`: trimmed, 1–4096 characters. */
  lengthHint: 'Up to 4096 characters. Plain text only.',
  counterSuffix: ' characters left',
  overLimit: 'Too long — remove ',
  overLimitSuffix: ' characters.',

  /** Read states. */
  loading: 'Loading comments…',
  empty: 'No comments on this asset yet.',
  emptyAdd: 'Be the first to add one.',
  emptyReadOnly: 'Your role can read comments but cannot add one.',
  /** The list read failed: do not claim the asset has no comments. */
  unavailable: 'Comments unavailable.',
  unavailableDetail:
    'The API did not return the comments for this asset, so the list below is ' +
    'not shown. This does not mean the asset has none.',
  countLabel: function (n) {
    return n === 1 ? '1 comment' : n + ' comments';
  },
  /** A `createdAt` the browser cannot parse is shown verbatim, never dropped. */
  unknownTime: 'Time not reported',

  /** Role gate (pre-emptive mirror of the 403 below). */
  readOnly:
    'Your role can read comments but cannot add one. Ask an editor or ' +
    'administrator.',

  /** Outcomes. */
  added: 'Comment added.',
  errEmpty: 'Write something first — an empty comment is rejected by the API.',
  errTooLong: 'That comment is longer than the 4096 characters the API accepts.',
  errInvalid:
    'The API rejected that comment as invalid. It must be 1 to 4096 characters ' +
    'of text.',
  errForbidden:
    'Your role cannot add comments to this asset. Ask an editor or ' +
    'administrator.',
  errNotFound: 'This asset no longer exists, so the comment was not added.',
  errNetwork: 'Could not reach the API. The comment was not added.',
  /** The LIST read failed — says nothing about an add, which was not attempted. */
  errRead: 'Could not read the comments for this asset from the API.',
  errReadNotFound: 'This asset no longer exists, so its comments could not be read.',
  /** The add succeeded but the re-read did not — say exactly that. */
  errRefreshAfterAdd:
    'The comment was added, but the list could not be re-read from the API.',
});

/** The server's own ceiling on a comment body (src/routes/assets.ts:1174-1176). */
export const COMMENT_MAX_LENGTH = 4096;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Read a `GET /:id/comments` 200 body defensively.
 *
 * The response is a plain array (no envelope, no paging keys), so `usable` is
 * false only when the payload is not an array at all — which is the failed-read
 * state, NOT the same thing as an empty array. An empty array is usable and
 * means "this asset has no comments", which the block renders as its explicit
 * empty state.
 *
 * Entries that are not objects are dropped (nothing the schema could produce).
 * An entry missing a `required` field is KEPT and rendered as the server sent
 * it, with a placeholder in the missing slot, rather than being silently hidden.
 *
 * Order is preserved exactly — see CONTRACT GROUNDING.
 *
 * @param {unknown} payload
 * @returns {{ items: object[], usable: boolean }}
 */
export function normaliseCommentList(payload) {
  if (!Array.isArray(payload)) return { items: [], usable: false };
  const items = payload.filter(function (c) {
    return c !== null && typeof c === 'object';
  });
  return { items: items, usable: true };
}

/**
 * Client-side mirror of `commentBodySchema`
 * (`z.string().trim().min(1).max(4096)`, src/routes/assets.ts:1174-1176).
 *
 * Trims first, exactly as the schema does, so trailing whitespace neither makes
 * an empty comment sendable nor pushes a borderline one over the limit. This
 * only decides whether the local button is enabled; the server re-validates and
 * its 400 is still handled.
 *
 * @param {unknown} raw  the raw textarea value
 * @returns {{ value: string, length: number, remaining: number, empty: boolean,
 *             tooLong: boolean, valid: boolean }}
 */
export function validateDraft(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  const length = value.length;
  const empty = length === 0;
  const tooLong = length > COMMENT_MAX_LENGTH;
  return {
    value: value,
    length: length,
    remaining: COMMENT_MAX_LENGTH - length,
    empty: empty,
    tooLong: tooLong,
    valid: !empty && !tooLong,
  };
}

/**
 * Classify a failed `POST /:id/comments`.
 *
 * Declared failures are 404 (and 201 on success); 400 is produced by the body
 * validation without being declared in the response map, and 401/403 come from
 * the auth gate — all three are real and all three are named here (see CONTRACT
 * GROUNDING). Anything else, including a network failure, reports as "could not
 * reach the API", because that is all the client actually knows.
 *
 * @param {{status?: number, message?: string, body?: any}} err  an apiFetch rejection
 * @returns {{kind: 'invalid'|'forbidden'|'not-found'|'other', message: string}}
 */
export function classifyCommentError(err) {
  const e = err || {};
  if (e.status === 400 || e.status === 422) {
    return { kind: 'invalid', message: COMMENTS_COPY.errInvalid };
  }
  if (e.status === 401 || e.status === 403) {
    return { kind: 'forbidden', message: COMMENTS_COPY.errForbidden };
  }
  if (e.status === 404) {
    return { kind: 'not-found', message: COMMENTS_COPY.errNotFound };
  }
  return { kind: 'other', message: COMMENTS_COPY.errNetwork };
}

/**
 * Render `createdAt` for display.
 *
 * `createdAt` is `required` and ISO 8601 (src/data/comment-repo.ts:21, minted at
 * :44), but a value this browser cannot parse is reported honestly — verbatim
 * when it is a non-empty string, and as `unknownTime` when it is absent —
 * never as a fabricated date.
 *
 * @param {unknown} createdAt
 * @param {(v: unknown) => string} [fmtDate]  the house date formatter
 * @returns {string}
 */
export function commentTimeLabel(createdAt, fmtDate) {
  if (typeof createdAt !== 'string' || createdAt === '') return COMMENTS_COPY.unknownTime;
  const parsed = Date.parse(createdAt);
  if (isNaN(parsed)) return createdAt;
  if (typeof fmtDate === 'function') {
    const out = fmtDate(createdAt);
    if (typeof out === 'string' && out !== '' && out !== '—') return out;
  }
  return new Date(parsed).toLocaleString();
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/**
 * One comment. Body text is set with `textContent` on a `white-space:pre-wrap`
 * element, so an operator's line breaks survive and their markup does not.
 *
 * @param {object} comment  a list item / 201 body
 * @param {(v: unknown) => string} [fmtDate]
 * @returns {HTMLElement}
 */
export function renderComment(comment, fmtDate) {
  const c = comment || {};
  const item = el('li', 'comment-item');
  if (typeof c.id === 'string') item.setAttribute('data-comment-id', c.id);

  const meta = el('div', 'comment-meta');
  const label = commentTimeLabel(c.createdAt, fmtDate);
  const time = el('time', 'comment-time', label);
  // Machine-readable only when the server's value really is a parseable
  // timestamp; never invented.
  if (typeof c.createdAt === 'string' && !isNaN(Date.parse(c.createdAt))) {
    time.setAttribute('datetime', c.createdAt);
  }
  meta.appendChild(time);
  item.appendChild(meta);

  const bodyText = typeof c.body === 'string' ? c.body : '';
  item.appendChild(el('div', 'comment-body', bodyText));
  return item;
}

// ─── Block ───────────────────────────────────────────────────────────────────

/**
 * Build the whole block for one read. PURE: no fetch, no listeners —
 * `mountAssetComments` wires the controls it returns.
 *
 * The add form exists only when `canAdd` is true; the list is rendered
 * regardless, because `read` is a right a viewer holds.
 *
 * Three distinct unloaded/empty states, never collapsed into one: `loading`
 * (the request is in flight — claims nothing), `!usable` (the read failed —
 * "unavailable", which is NOT "none"), and a usable empty array (the asset
 * genuinely has no comments).
 *
 * @param {{items: object[], usable: boolean}} read
 * @param {{canAdd?: boolean, draft?: string, loading?: boolean, fmtDate?: Function}} [opts]
 * @returns {{ block: HTMLElement, listEl: HTMLElement|null, textarea: HTMLElement|null,
 *             submitBtn: HTMLElement|null, counter: HTMLElement|null, msgHost: HTMLElement }}
 */
export function renderCommentsBlock(read, opts) {
  const o = opts || {};
  const r = read && typeof read === 'object' ? read : { items: [], usable: false };
  const items = Array.isArray(r.items) ? r.items : [];
  const canAdd = o.canAdd !== false;

  const block = el('div', 'mt12 comments-block');
  block.id = 'asset-comments';

  // `.section-title` is the house heading for a detail-panel block (cf.
  // "Status history", public/app.js; "Tracks", public/tracks-panel.js).
  const heading = r.usable
    ? COMMENTS_COPY.heading + ' (' + items.length + ')'
    : COMMENTS_COPY.heading;
  block.appendChild(el('div', 'section-title', heading));
  block.appendChild(el('div', 'comments-note', COMMENTS_COPY.intro));

  // The inline message host. Lives directly under the heading so a failure is
  // read before the (possibly stale) list below it, and is announced without
  // moving focus.
  const msgHost = el('div', 'mt8 comments-msg');
  msgHost.id = 'comments-msg';
  msgHost.setAttribute('aria-live', 'polite');
  block.appendChild(msgHost);

  let listEl = null;
  if (o.loading) {
    // In flight. Says nothing about how many comments exist — the first paint
    // must not read as either "none" or "unavailable".
    const box = el('div', 'empty', COMMENTS_COPY.loading);
    box.setAttribute('data-empty', 'comments-loading');
    block.appendChild(box);
  } else if (!r.usable) {
    // The read failed. Do NOT render an empty list — "we could not ask" and
    // "there are none" are different answers and must not look alike.
    const box = el('div', 'empty', COMMENTS_COPY.unavailable);
    box.setAttribute('data-empty', 'comments-unavailable');
    box.appendChild(el('div', 'comments-note', COMMENTS_COPY.unavailableDetail));
    block.appendChild(box);
  } else if (items.length === 0) {
    const box = el('div', 'empty', COMMENTS_COPY.empty);
    box.setAttribute('data-empty', 'comments');
    box.appendChild(
      el('div', 'comments-note', canAdd ? COMMENTS_COPY.emptyAdd : COMMENTS_COPY.emptyReadOnly)
    );
    block.appendChild(box);
  } else {
    // An ordered list, because the order is meaningful (oldest first, the
    // server's own sequence) and assistive technology should say so.
    listEl = el('ol', 'comment-list');
    listEl.id = 'comment-list';
    listEl.setAttribute('aria-label', COMMENTS_COPY.countLabel(items.length) + ', oldest first');
    items.forEach(function (c) {
      listEl.appendChild(renderComment(c, o.fmtDate));
    });
    block.appendChild(listEl);
    block.appendChild(el('div', 'comments-note', COMMENTS_COPY.attributionNote));
  }

  block.appendChild(el('div', 'comments-note', COMMENTS_COPY.durabilityNote));

  let textarea = null;
  let submitBtn = null;
  let counter = null;

  if (!canAdd) {
    // Pre-emptive mirror of the ADR-018 matrix: a viewer holds `read` but not
    // `write`, so the POST would be a guaranteed 403. Explain the absence
    // instead of offering a control that cannot work — the list stays fully
    // visible.
    const roleNote = el('div', 'comments-role-note', COMMENTS_COPY.readOnly);
    roleNote.id = 'comments-role-note';
    block.appendChild(roleNote);
    return { block, listEl, textarea, submitBtn, counter, msgHost };
  }

  const form = el('div', 'mt8 form-field comment-form');
  form.id = 'comment-form';

  const label = el('label', null, COMMENTS_COPY.formLabel);
  label.setAttribute('for', 'comment-body-input');
  form.appendChild(label);

  textarea = el('textarea', 'comment-input');
  textarea.id = 'comment-body-input';
  textarea.setAttribute('rows', '3');
  // The server's own ceiling, enforced by the control as well as by the panel:
  // `maxLength: 4096` (src/routes/assets.ts:1174-1176).
  textarea.setAttribute('maxlength', String(COMMENT_MAX_LENGTH));
  textarea.setAttribute('placeholder', COMMENTS_COPY.placeholder);
  textarea.setAttribute('aria-describedby', 'comment-length-hint');
  if (typeof o.draft === 'string') textarea.value = o.draft;
  form.appendChild(textarea);

  const hint = el('div', 'comments-note', COMMENTS_COPY.lengthHint);
  hint.id = 'comment-length-hint';
  form.appendChild(hint);

  counter = el('div', 'comments-counter');
  counter.id = 'comment-counter';
  counter.setAttribute('aria-live', 'polite');
  form.appendChild(counter);

  const actions = el('div', 'mt8 flex-gap comment-actions');
  submitBtn = el('button', 'btn-primary comment-submit', COMMENTS_COPY.submit);
  submitBtn.type = 'button';
  submitBtn.id = 'btn-add-comment';
  actions.appendChild(submitBtn);
  form.appendChild(actions);

  block.appendChild(form);
  return { block, listEl, textarea, submitBtn, counter, msgHost };
}

// ─── Draft preservation ──────────────────────────────────────────────────────
//
// The asset detail body is wiped and rebuilt on every render — the detached
// detail window self-polls at DETAIL_POLL_INTERVAL_MS (public/detail.js) and
// sibling actions re-render it too. A half-typed comment must not be destroyed
// by a poll that has nothing to do with it, so the text, the caret and whether
// the field was focused are held per asset id in the module realm and restored
// on re-mount. Memory only: never localStorage/sessionStorage (a comment draft
// is user content, and this UI persists nothing to browser storage beyond the
// stack/role selectors), and dropped the moment the comment is accepted.

const drafts = new Map();

function draftRecord(assetKey) {
  return drafts.get(assetKey) || { text: '', selStart: null, selEnd: null, focused: false };
}

/** The pending draft text for an asset, or '' when there is none. */
export function peekDraft(assetId) {
  return draftRecord(String(assetId)).text;
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Render the "Comments" block and wire the add control.
 *
 * Reads `GET /api/v1/assets/{id}/comments` once on mount. A successful add
 * re-reads the same list and rebuilds the block in place: the server mints `id`
 * and `createdAt`, so re-reading is the only way the list is truthful, and it
 * costs one request instead of a full detail re-render.
 *
 * The block is inserted before `anchorEl` when given, else appended to `host`.
 *
 * @param {object} opts
 * @param {string}      opts.assetId    the ULID (sub-resource routes do not
 *                                      resolve slugs — `repo.get(request.params.id)`,
 *                                      src/routes/assets.ts:4786/:4807 — and
 *                                      `asset.id` is the ULID even when the pane
 *                                      was opened by slug)
 * @param {HTMLElement} [opts.host]     container to append to
 * @param {HTMLElement} [opts.anchorEl] element to insert before, inside its parent
 * @param {boolean}     [opts.canAdd]   client-role mirror of the ADR-018 matrix
 * @param {Function}    opts.apiFetch
 * @param {Function}    [opts.showMsg]  house message renderer (host, text, kind)
 * @param {Function}    [opts.fmtDate]  house date formatter
 * @param {(comment: object) => any} [opts.onAdded] called with the 201 body
 * @returns {Promise<{ block: HTMLElement, refresh: () => Promise<void>, read: () => object }>}
 */
export async function mountAssetComments(opts) {
  const o = opts || {};
  const apiFetch = o.apiFetch;
  const assetKey = String(o.assetId);
  const path = '/assets/' + encodeURIComponent(assetKey) + '/comments';

  // The last answer the server gave. Never edited locally.
  let current = { items: [], usable: false };
  let rendered = null;
  let placed = false;
  let submitting = false;

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
    rendered.msgHost.innerHTML = '';
    if (typeof o.showMsg === 'function') {
      o.showMsg(rendered.msgHost, text, kind || 'error');
      return;
    }
    rendered.msgHost.appendChild(el('div', 'msg msg-' + (kind || 'error'), text));
  }

  /** Remember the draft, the caret and whether the field is focused. */
  function saveDraft() {
    if (!rendered || !rendered.textarea) return;
    const ta = rendered.textarea;
    drafts.set(assetKey, {
      text: ta.value,
      selStart: typeof ta.selectionStart === 'number' ? ta.selectionStart : null,
      selEnd: typeof ta.selectionEnd === 'number' ? ta.selectionEnd : null,
      focused: document.activeElement === ta,
    });
  }

  /** Reflect the local mirror of `commentBodySchema` onto the control. */
  function syncDraftState() {
    if (!rendered || !rendered.textarea) return;
    const state = validateDraft(rendered.textarea.value);
    saveDraft();
    if (rendered.counter) {
      rendered.counter.textContent = state.tooLong
        ? COMMENTS_COPY.overLimit + -state.remaining + COMMENTS_COPY.overLimitSuffix
        : state.remaining + COMMENTS_COPY.counterSuffix;
      rendered.counter.className = state.tooLong
        ? 'comments-counter comments-counter--over'
        : 'comments-counter';
    }
    if (rendered.submitBtn) {
      // Disabled for an empty/whitespace-only or over-long draft — the two
      // things the server answers 400 to. Not a substitute for that 400, which
      // is still handled.
      rendered.submitBtn.disabled = submitting || !state.valid;
    }
  }

  function draw(read, loading) {
    current = read;
    const saved = draftRecord(assetKey);
    const next = renderCommentsBlock(read, {
      canAdd: o.canAdd !== false,
      draft: saved.text,
      loading: loading === true,
      fmtDate: o.fmtDate,
    });
    place(next.block);
    rendered = next;
    if (next.textarea) {
      next.textarea.addEventListener('input', syncDraftState);
      next.textarea.addEventListener('blur', saveDraft);
      next.textarea.addEventListener('focus', saveDraft);
      next.textarea.addEventListener('keyup', saveDraft);
      next.textarea.addEventListener('mouseup', saveDraft);
      // Ctrl/Cmd+Enter submits, matching the house convention for a multi-line
      // field; a bare Enter stays a newline.
      next.textarea.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
          ev.preventDefault();
          submit();
        }
      });
      // Put the operator back where the re-render found them. Only ever after
      // they had typed AND had the field focused, so a poll that interrupts
      // typing is invisible and a poll that does not never steals focus.
      if (saved.focused && saved.text !== '') {
        try {
          next.textarea.focus({ preventScroll: true });
          if (typeof saved.selStart === 'number' && typeof saved.selEnd === 'number') {
            next.textarea.setSelectionRange(saved.selStart, saved.selEnd);
          }
        } catch (_) {
          /* focus/selection restore is a nicety, never a failure path */
        }
      }
    }
    if (next.submitBtn) {
      next.submitBtn.addEventListener('click', function () {
        submit();
      });
    }
    syncDraftState();
  }

  async function refresh(quiet) {
    let read;
    try {
      read = normaliseCommentList(await apiFetch(path));
    } catch (err) {
      // Keep the panel honest: an unusable read renders the "unavailable" box,
      // never an empty list.
      draw({ items: [], usable: false });
      if (!quiet) {
        report(
          err && err.status === 404 ? COMMENTS_COPY.errReadNotFound : COMMENTS_COPY.errRead,
          'error'
        );
      }
      return false;
    }
    draw(read);
    return true;
  }

  async function submit() {
    if (submitting || !rendered || !rendered.textarea) return;
    const state = validateDraft(rendered.textarea.value);
    if (!state.valid) {
      report(state.empty ? COMMENTS_COPY.errEmpty : COMMENTS_COPY.errTooLong, 'error');
      return;
    }
    submitting = true;
    const btn = rendered.submitBtn;
    const label = btn ? btn.textContent : COMMENTS_COPY.submit;
    // Ctrl/Cmd+Enter submits from inside the field; a keyboard operator should
    // land back in it, ready for the next note.
    const keyboardSubmit = document.activeElement === rendered.textarea;
    if (btn) {
      btn.disabled = true;
      btn.textContent = COMMENTS_COPY.submitBusy;
    }
    rendered.textarea.disabled = true;
    try {
      // The body carries EXACTLY the one declared property, with the trimmed
      // value the server would have trimmed anyway (see CONTRACT GROUNDING).
      const created = await apiFetch(path, {
        method: 'POST',
        body: JSON.stringify({ body: state.value }),
      });
      // Accepted: drop the draft before the re-render so the cleared textarea
      // is not immediately repopulated from it.
      drafts.delete(assetKey);
      submitting = false;
      // Re-read rather than appending `created` locally. One extra request buys
      // the server's own list — which is the only place the ordering, and any
      // comment another operator added meanwhile, actually lives.
      const ok = await refresh(true);
      report(ok ? COMMENTS_COPY.added : COMMENTS_COPY.errRefreshAfterAdd, ok ? 'success' : 'error');
      if (keyboardSubmit && rendered && rendered.textarea) {
        try {
          rendered.textarea.focus({ preventScroll: true });
        } catch (_) {
          /* nicety only */
        }
      }
      if (typeof o.onAdded === 'function') {
        await o.onAdded(created);
      }
    } catch (err) {
      // Failed: the draft is still in the textarea and still in `drafts`, so
      // nothing the operator typed is lost. The error is inline.
      submitting = false;
      rendered.textarea.disabled = false;
      if (btn) btn.textContent = label;
      const c = classifyCommentError(err);
      if (c.kind === 'forbidden' && rendered) {
        // A control known to fail stops being offered for the rest of this view
        // of the asset (the review/lock blocks' 403 rule).
        const form = rendered.block.querySelector('#comment-form');
        if (form && form.parentNode) form.parentNode.removeChild(form);
        rendered.textarea = null;
        rendered.submitBtn = null;
        rendered.counter = null;
      }
      syncDraftState();
      report(c.message, 'error');
    }
  }

  // First paint: the loading state (which claims nothing about how many
  // comments exist), then the real block once the read resolves. The add form
  // is already usable at this point — composing a comment does not depend on
  // the list having arrived.
  draw({ items: [], usable: false }, true);
  await refresh(false);

  return {
    get block() {
      return rendered ? rendered.block : null;
    },
    refresh: function () {
      return refresh(false);
    },
    read: function () {
      return current;
    },
  };
}
