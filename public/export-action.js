/**
 * open-videocore ops dashboard — export-action.js
 *
 * The "Export" block on the asset detail view (issue #945, broken out of #796):
 * pick a container format, optionally name the output, trigger the export, and
 * read the outcome truthfully.
 *
 * Copy and visual treatment for the four states below are NOT invented here.
 * They are taken from the interaction spec written for the prerequisite design
 * ticket #911 — `docs/design/export-action-states.md` (§1 vocabulary, §2 in
 * progress, §3 succeeded, §4 failed, §5 not available). Where this module
 * departs from the letter of that spec it says so inline, with the reason.
 *
 * Everything operator-visible is written with `textContent` / `createElement`.
 * No server string ever reaches `innerHTML` — including the 502 `message`,
 * which is third-party-derived text.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's generated spec and route source on this branch, plus the
 * contract note written for the outcome-honesty prerequisite (#944). Nothing is
 * taken from issue text.
 *
 *   Write — `openapi.json .paths["/api/v1/assets/{id}/export"].post`
 *     parameters: exactly one — path `id` (string, required). No query params.
 *     requestBody: `required: true`, `application/json`, schema
 *       `{ targetFormat: 'mp4'|'mkv'|'mov'|'mxf'|'ts'` (the ONLY required
 *       property)`, outputName?: string(minLength 1, maxLength 256),
 *       asVersion?: boolean }`, `additionalProperties: false`.
 *       Source of truth: `exportBodySchema`, src/routes/assets.ts:723-730.
 *     responses: exactly `201, 400, 404, 409, 501, 502`
 *       (src/routes/assets.ts:5204-5211).
 *       201 = `assetSchema` — the NEW CHILD asset (`src/routes/assets.ts:5255`,
 *         `return reply.code(201).send(child)`). Fields this module reads:
 *         `id`, `name`, `status` (`'ready'` on a 201), `objectKey`.
 *       400 = `errorSchema` `{ error, message? }` — unsupported `targetFormat`
 *         (Zod enum at the edge; `UnsupportedFormatError` defensively in
 *         src/pipeline/rewrap.ts).
 *       404 = `{ error: 'not_found' }` (src/routes/assets.ts:5215-5217).
 *         Existence is deliberately not distinguished from "not yours".
 *       409 = `{ error: 'no_object', message: 'asset has no stored source
 *         object to process' }` — `NO_SOURCE_OBJECT_ERROR` /
 *         `NO_SOURCE_OBJECT_MESSAGE`, src/pipeline/source-object.ts:31/37, sent
 *         by the shared `requireSourceObject` (:96-104) called at
 *         src/routes/assets.ts:5220-5221.
 *       501 = `{ error: 'not_configured', message: 'export / re-wrap is not
 *         configured' }` (src/routes/assets.ts:5222-5227, fired when
 *         `!opts.rewrapRunner || !storageFor`). The SAME `error` code is sent by
 *         `resolveConfiguredRunner` (src/routes/assets.ts:2053-2069, the 501 at
 *         :2064) when the stack cannot supply the runner's S3 config, carrying
 *         the factory's own `message` — both are the one condition this module
 *         calls "not available on this deployment".
 *       502 = `{ error: 'rewrap_failed', message: <single sentence> }`
 *         (src/routes/assets.ts:5268-5269). The ffmpeg log is logged
 *         SERVER-SIDE ONLY (`oscJobLog(err)` at :5262-5265) and is NEVER in
 *         `message` — a deliberate security position, so there is no extra
 *         failure detail for this UI to fetch or offer.
 *
 *   Format vocabulary — `REWRAP_FORMATS = ['mp4','mkv','mov','mxf','ts']`,
 *     src/pipeline/rewrap.ts:30, consumed by `exportBodySchema` via
 *     `z.enum(REWRAP_FORMATS)` (src/routes/assets.ts:724). `EXPORT_FORMATS`
 *     below mirrors that list and nothing else; the picker can therefore only
 *     ever submit a value the enum accepts.
 *
 *   Synchronous, so there is nothing to poll — the route AWAITS the runner
 *     (src/routes/assets.ts:5238-5255) and the response IS the outcome. No job
 *     id, no callback, no `processing` child to follow. Hence §2's indeterminate
 *     busy state and no progress bar.
 *
 *   `201` is falsifiable (docs/findings/export-truthful-status-944.md §6):
 *     a job-status allow-list (`SUCCESS_STATUSES`, src/pipeline/osc-rewrap.ts:85),
 *     an object HEAD + non-empty check (src/pipeline/rewrap.ts:171-176), and only
 *     then the `ready` transition. A 201 therefore means the output object has been
 *     confirmed present and non-empty, so the success copy may name it. A failed
 *     export leaves the child `failed` with NO `objectKey`, so it can never
 *     serve a plausible-looking link to bytes that do not exist — which is why
 *     the failure state links to nothing.
 *
 *   Authorisation — the role×action matrix `MATRIX` (src/auth/authorize.ts:54-58:
 *     `viewer { read: true, write: false }`, editor/admin all true) with the
 *     action derived by `methodToAction` (:79-92: POST -> `write`), applied by
 *     `resourceAuthorizationPreHandler('asset')` (:126, registered
 *     src/routes/assets.ts:1773). A `viewer` is refused the POST with 403
 *     `AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role'` (:99). `canExport`
 *     is the caller's client-role mirror; the 403 path below runs regardless,
 *     because the server is the authority. (403 is not in the route's declared
 *     response map because the preHandler sends it ahead of the handler.)
 *
 *   NOT rendered, because the contract does not support it:
 *
 *   1. A DESTINATION PICKER. `exportBodySchema` has NO destination field of any
 *      kind (see above). The named export-destinations registry
 *      (`GET /api/v1/export-destinations`, src/routes/export-destinations.ts) is
 *      consumed EXCLUSIVELY by `POST /:id/package` and `POST /:id/execute` via
 *      their optional `destination` body property, resolved by
 *      `resolveJobDestination` / `StorageBackendRegistry.resolveDestinationBucket`
 *      (src/routes/assets.ts:2137-2266). `POST /:id/export` never consults that
 *      registry and cannot be gated by it: it always writes to the workspace's
 *      own provisioned storage (`storageFor()`), at
 *      `exports/<newAssetId>.<format>` (`rewrapObjectKey`,
 *      src/pipeline/rewrap.ts:62). Offering destinations here would present a
 *      choice the request cannot carry. `docs/design/export-action-states.md`
 *      §0 ("Named export destinations are a different contract — do not
 *      conflate them") establishes this and maps the issue's
 *      "no destinations configured" criterion onto the condition this endpoint
 *      can actually produce: its own `501 not_configured` (§5).
 *   2. A PROGRESS BAR OR ELAPSED-TIME ESTIMATE. No partial-progress signal
 *      exists (see "Synchronous" above).
 *   3. AN IMMEDIATE DOWNLOAD LINK. `assetFileSchema.type` declares an `'export'`
 *      member (src/routes/assets.ts:665) that NO code path ever assigns — the
 *      files handler (:4210 onwards) only pushes `'source'` or `'rendition'` — so a
 *      `.filter(f => f.type === 'export')` would silently match nothing. This
 *      module reads `id`/`name`/`objectKey` straight off the 201 body instead
 *      and links to the child's detail view, which needs no second request.
 *   4. THE FFMPEG REASON for a 502. Server-side only, by design.
 */

// ─── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * The container formats the endpoint accepts, mirroring `REWRAP_FORMATS`
 * (src/pipeline/rewrap.ts:30) in order. The picker is built from this list and
 * from nothing else, so the client cannot submit a value the `z.enum` rejects.
 */
export const EXPORT_FORMATS = Object.freeze(['mp4', 'mkv', 'mov', 'mxf', 'ts']);

/**
 * Operator-visible copy, fixed by `docs/design/export-action-states.md`.
 *
 * §1 pins the vocabulary: the action is "Export" (never "re-wrap" — that is the
 * pipeline's internal name), what `targetFormat` picks is a "container format"
 * (never a "codec": a rewrap copies streams, nothing is re-encoded), and the
 * asset being exported is the "source" (never "original"/"parent").
 */
export const EXPORT_COPY = Object.freeze({
  heading: 'Export',
  /** Explains what the action does and where the output goes. */
  intro:
    'Export copies this asset’s source into another container format without ' +
    're-encoding it. The result is saved as a new asset in this deployment’s ' +
    'own storage.',
  formatLabel: 'Container format',
  nameLabel: 'Export name (optional)',
  nameHint:
    'Leave blank to name the export after its source and the chosen format.',
  submit: 'Export',
  busy: 'Exporting…',
  /** §2 — in progress. */
  inProgress: function (format) {
    return 'Exporting to ' + formatLabel(format) + '…';
  },
  /** §3 — succeeded (201). The child's name follows, as a link. */
  succeeded: function (format) {
    return 'Exported to ' + formatLabel(format) + '.';
  },
  /** §4 — failed (502). The server's own sentence follows, verbatim. */
  failed: function (format) {
    return 'Export to ' + formatLabel(format) + ' failed:';
  },
  /** §4 table — 400. Defensive: the picker only offers accepted values. */
  errUnsupportedFormat: 'Unsupported export format.',
  /** §4 table — 404. Does not narrow which of "gone" or "not yours". */
  errNotFound: 'This asset no longer exists.',
  /** §4 table — 409. Prefers naming the asset over the generic server sentence. */
  errNoObject: function (sourceName) {
    return (sourceName && String(sourceName).trim()
      ? String(sourceName).trim()
      : 'This asset') + ' has no stored file to export.';
  },
  /**
   * Transport failure — no HTTP status at all. Mirrors the house wording used
   * for the same case by the review-state block (`REVIEW_COPY.errNetwork`,
   * public/review-state.js), which is the convention for "the request never
   * landed, so nothing changed".
   */
  errNetwork: 'Could not reach the API. Nothing was exported.',
  /**
   * 403 from `resourceAuthorizationPreHandler` (see CONTRACT GROUNDING). Not a
   * state the design spec covers, because it is not an export outcome — the
   * request never reached the handler. Wording mirrors the house precedent for
   * the identical gate on the review-state and lock blocks.
   */
  errForbidden:
    'Your role cannot export this asset. Ask an editor or administrator.',
  /** Pre-emptive mirror of the same gate, so a doomed control is not offered. */
  readOnly:
    'Your role can see this asset but cannot export it. Ask an editor or ' +
    'administrator.',
  /** §5 — not available on this deployment (501). */
  notConfiguredLabel: 'Export not available',
  notConfiguredTitle: 'Export is not available on this deployment',
  notConfiguredBody:
    'This deployment has not configured an export service. Ask an operator to ' +
    'provision export before this action can be used here.',
  /** Prefix for the server's own 501 sentence, when it carries one. */
  notConfiguredDetailPrefix: 'The API reported: ',
});

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * The display rendering of a container format: the wire value, uppercased.
 *
 * §2/§3 of the spec: uppercase for display only — never a longer, invented
 * format name the contract does not carry. A value this build has not heard of
 * still renders (uppercased) rather than becoming "unknown": the API is the
 * authority on the vocabulary.
 *
 * @param {unknown} format
 * @returns {string}
 */
export function formatLabel(format) {
  if (typeof format !== 'string' || format === '') return '';
  return format.toUpperCase();
}

/**
 * Normalise the optional `outputName` for the request body.
 *
 * `outputName` is `string().min(1).max(256)` (src/routes/assets.ts:725), so an
 * empty or whitespace-only field must be OMITTED rather than sent as `''` —
 * sending `''` would be a 400 for a field the operator left blank on purpose.
 * Over-long input is NOT silently truncated (that would export under a name the
 * operator did not choose); it is reported as invalid so the field can be
 * corrected.
 *
 * @param {unknown} raw
 * @returns {{ ok: true, value?: string } | { ok: false, reason: 'too-long' }}
 */
export function normaliseOutputName(raw) {
  if (raw == null) return { ok: true };
  const trimmed = String(raw).trim();
  if (trimmed === '') return { ok: true };
  if (trimmed.length > 256) return { ok: false, reason: 'too-long' };
  return { ok: true, value: trimmed };
}

/**
 * Build the request body for `POST /api/v1/assets/{id}/export`.
 *
 * Exactly the declared properties and no others — the schema is
 * `additionalProperties: false`. `asVersion` is deliberately not offered by this
 * block: it changes how the export is LINKED to its source (version chain,
 * issue #118) rather than what is exported, and is the version-chain surface's
 * concern, not this action's. Omitting it takes the documented default
 * (`false`).
 *
 * @param {string} format
 * @param {string} [outputName] already normalised by `normaliseOutputName`
 * @returns {{ targetFormat: string, outputName?: string }}
 */
export function buildExportBody(format, outputName) {
  const body = { targetFormat: format };
  if (outputName) body.outputName = outputName;
  return body;
}

/**
 * Classify a thrown `apiFetch` error into the state this block should enter.
 *
 * `apiFetch` (public/app.js) attaches `err.status` and the parsed `err.body`,
 * and sets `err.message` to `body.message || body.error || 'HTTP <status>'` —
 * so for a 502 `err.message` IS the server's `message` field verbatim, which is
 * what §4 requires the UI to print.
 *
 * `notConfigured` is keyed on the status AND on the `error` code, because the
 * same 501 condition is reachable from two call sites with different `message`
 * text (see CONTRACT GROUNDING).
 *
 * @param {{status?: number, body?: {error?: string, message?: string}, message?: string}} err
 * @param {{format?: string, sourceName?: string}} [ctx]
 * @returns {{ kind: string, message: string, detail?: string, notConfigured: boolean, forbidden: boolean }}
 */
export function classifyExportError(err, ctx) {
  const e = err || {};
  const c = ctx || {};
  const status = typeof e.status === 'number' ? e.status : undefined;
  const code = e.body && typeof e.body.error === 'string' ? e.body.error : '';
  const serverMessage = typeof e.message === 'string' ? e.message : '';

  if (status === 501 || code === 'not_configured') {
    return {
      kind: 'not-configured',
      message: EXPORT_COPY.notConfiguredTitle,
      // The server's own sentence, shown as supporting detail rather than as
      // the headline: the headline must name the condition (acceptance
      // criterion), and 'export / re-wrap is not configured' leaks the
      // pipeline's internal name, which §1 keeps out of primary copy.
      detail: serverMessage,
      notConfigured: true,
      forbidden: false,
    };
  }
  if (status === 403) {
    return {
      kind: 'forbidden',
      message: EXPORT_COPY.errForbidden,
      notConfigured: false,
      forbidden: true,
    };
  }
  if (status === 400) {
    return {
      kind: 'bad-format',
      message: EXPORT_COPY.errUnsupportedFormat,
      notConfigured: false,
      forbidden: false,
    };
  }
  if (status === 404) {
    return {
      kind: 'not-found',
      message: EXPORT_COPY.errNotFound,
      notConfigured: false,
      forbidden: false,
    };
  }
  if (status === 409 || code === 'no_object') {
    return {
      kind: 'no-object',
      message: EXPORT_COPY.errNoObject(c.sourceName),
      notConfigured: false,
      forbidden: false,
    };
  }
  if (status === 502 || code === 'rewrap_failed') {
    // §4: print the server's sentence, never a generic "Export failed".
    return {
      kind: 'failed',
      message: EXPORT_COPY.failed(c.format) + ' ' + serverMessage,
      notConfigured: false,
      forbidden: false,
    };
  }
  if (status === undefined) {
    return {
      kind: 'network',
      message: EXPORT_COPY.errNetwork,
      notConfigured: false,
      forbidden: false,
    };
  }
  // Any other status: report what the API said rather than inventing a cause.
  return {
    kind: 'other',
    message: EXPORT_COPY.failed(c.format) + ' ' + (serverMessage || 'HTTP ' + status),
    notConfigured: false,
    forbidden: false,
  };
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ─── Rendering ───────────────────────────────────────────────────────────────

/**
 * The §5 "export is not available on this deployment" block.
 *
 * PURE: no fetch, no listeners. Deliberately NOT a `.msg-error` (this is the
 * deployment's standing state, not something that just failed and might work on
 * retry) and NOT `.msg-unrecoverable` (that component's copy and
 * `data-outcome="unrecoverable"` semantics belong to the 410 tombstone and talk
 * about purging, which does not apply). It borrows that component's SHAPE — a
 * heavy left rule and an uppercase label row — through its own
 * `.msg-not-configured` class, and carries `data-outcome="not-configured"` so a
 * test or a future view can tell the two apart without matching on prose.
 *
 * No format picker, no name field and no submit button are rendered in this
 * state: greying out live inputs would imply "temporarily disabled", which
 * contradicts the explanation.
 *
 * @param {string} [serverMessage] the 501 body's `message`, if one was seen
 * @returns {HTMLElement}
 */
export function renderExportNotConfigured(serverMessage) {
  const block = el('div', 'msg msg-not-configured');
  block.setAttribute('data-outcome', 'not-configured');
  // Programmatically focusable WITHOUT entering the tab order, so the mount can
  // move focus here when this state replaces a form the operator had just
  // submitted — otherwise the control they activated disappears and the
  // explanation is never announced. Nothing inside it is interactive, so it is
  // not a tab stop (WCAG 2.4.3).
  block.setAttribute('tabindex', '-1');
  block.setAttribute('role', 'status');
  block.appendChild(
    el('span', 'not-configured-label', EXPORT_COPY.notConfiguredLabel)
  );
  block.appendChild(
    el('span', 'not-configured-title', EXPORT_COPY.notConfiguredTitle)
  );
  block.appendChild(
    el('span', 'not-configured-body', EXPORT_COPY.notConfiguredBody)
  );
  const detail = serverMessage == null ? '' : String(serverMessage).trim();
  if (detail) {
    block.appendChild(
      el(
        'span',
        'not-configured-detail',
        EXPORT_COPY.notConfiguredDetailPrefix + detail
      )
    );
  }
  return block;
}

/**
 * Build the whole Export block for one render.
 *
 * PURE: no fetch, no listeners — `mountExportAction` wires the form it returns.
 *
 * THE GATE on `targetFormat`: one `<option>` per entry of `EXPORT_FORMATS` and
 * by no other route — no free-text field, no "other format" affordance — so a
 * value the endpoint's `z.enum` would reject has no control to originate from.
 *
 * ACCESSIBILITY: a real `<form>` (so Enter submits), every control bound to a
 * visible `<label for>`, the message host an `aria-live="polite"` region so an
 * outcome that does not move focus is still announced (WCAG 2.1 AA 4.1.3), and
 * the submit control described by the intro text so it announces what it does.
 *
 * @param {{ canExport?: boolean, notConfigured?: boolean, notConfiguredMessage?: string }} [opts]
 * @returns {{ block: HTMLElement, form: HTMLElement|null, formatSelect: HTMLElement|null,
 *             nameInput: HTMLElement|null, submitBtn: HTMLElement|null, msgHost: HTMLElement }}
 */
export function renderExportBlock(opts) {
  const o = opts || {};

  const block = el('div', 'mt12 export-block');
  block.id = 'export-action';
  // `.section-title` is the house heading for a detail-panel block (cf. "Status
  // history" in public/app.js and "Editorial review" in public/review-state.js).
  block.appendChild(el('div', 'section-title', EXPORT_COPY.heading));

  const intro = el('div', 'mt8 text-muted export-intro', EXPORT_COPY.intro);
  intro.id = 'export-intro';
  intro.style.fontSize = '12px';
  block.appendChild(intro);

  const msgHost = el('div', 'mt8 export-msg');
  msgHost.id = 'export-msg';
  msgHost.setAttribute('aria-live', 'polite');

  if (o.notConfigured) {
    // §5: the form is not rendered at all in this state.
    block.appendChild(renderExportNotConfigured(o.notConfiguredMessage));
    block.appendChild(msgHost);
    return {
      block,
      form: null,
      formatSelect: null,
      nameInput: null,
      submitBtn: null,
      msgHost,
    };
  }

  if (o.canExport === false) {
    // Pre-emptive mirror of the ADR-018 role matrix: a `viewer` holds `read`
    // but not `write`, so the POST would be a guaranteed 403. Explaining the
    // absence beats offering a control that cannot work.
    const roleNote = el('div', 'mt8 export-role-note', EXPORT_COPY.readOnly);
    roleNote.id = 'export-role-note';
    roleNote.style.fontSize = '12px';
    block.appendChild(roleNote);
    block.appendChild(msgHost);
    return {
      block,
      form: null,
      formatSelect: null,
      nameInput: null,
      submitBtn: null,
      msgHost,
    };
  }

  const form = el('form', 'mt8 export-form');
  form.id = 'export-form';
  // Nothing here navigates; the handler always preventDefault()s. `novalidate`
  // keeps the browser's own bubble out of the way so every refusal is reported
  // in the one aria-live region.
  form.setAttribute('novalidate', 'novalidate');

  const formatRow = el('div', 'export-field');
  const formatLabelEl = el('label', 'export-field-label', EXPORT_COPY.formatLabel);
  formatLabelEl.setAttribute('for', 'export-format');
  const formatSelect = el('select', 'export-format-select');
  formatSelect.id = 'export-format';
  formatSelect.name = 'targetFormat';
  EXPORT_FORMATS.forEach(function (fmt) {
    const option = el('option', null, formatLabel(fmt));
    option.value = fmt;
    formatSelect.appendChild(option);
  });
  formatRow.appendChild(formatLabelEl);
  formatRow.appendChild(formatSelect);
  form.appendChild(formatRow);

  const nameRow = el('div', 'mt8 export-field');
  const nameLabelEl = el('label', 'export-field-label', EXPORT_COPY.nameLabel);
  nameLabelEl.setAttribute('for', 'export-output-name');
  const nameInput = el('input', 'export-name-input');
  nameInput.id = 'export-output-name';
  nameInput.name = 'outputName';
  nameInput.type = 'text';
  // The schema's own bound (src/routes/assets.ts:725), so the field cannot hold
  // a value the API would reject for length.
  nameInput.setAttribute('maxlength', '256');
  const nameHint = el('div', 'export-field-hint', EXPORT_COPY.nameHint);
  nameHint.id = 'export-name-hint';
  nameInput.setAttribute('aria-describedby', nameHint.id);
  nameRow.appendChild(nameLabelEl);
  nameRow.appendChild(nameInput);
  nameRow.appendChild(nameHint);
  form.appendChild(nameRow);

  const submitBtn = el('button', 'btn-ghost export-submit', EXPORT_COPY.submit);
  submitBtn.id = 'btn-export-asset';
  submitBtn.type = 'submit';
  submitBtn.setAttribute('aria-describedby', intro.id);
  const actions = el('div', 'mt8 flex-gap export-actions');
  actions.appendChild(submitBtn);
  form.appendChild(actions);

  block.appendChild(form);
  block.appendChild(msgHost);
  return { block, form, formatSelect, nameInput, submitBtn, msgHost };
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Whether a 501 has already been seen in this page session.
 *
 * §5 asks for the unavailable state to be detected "ahead of the click, not
 * after". The API exposes NO capability probe for export (there is no
 * capabilities endpoint, and the only way to ask `/export` is to perform one,
 * which would create a child asset), so a pre-flight probe cannot be built
 * without fabricating a request. §5 explicitly permits lazy detection on first
 * submit, with the same wording. This memo makes that detection stick: the
 * first 501 anywhere in the session means every later render of this block
 * opens in the §5 state instead of offering the form again — which is the
 * "once per session" timing §5 asks for, reached by the only honest route the
 * contract leaves open.
 */
let notConfiguredSeen = false;
let notConfiguredMessage = '';

/**
 * Test seam: forget the session-level 501 memo above.
 *
 * Module state would otherwise leak between test cases in one module registry.
 * Not called by the application.
 */
export function resetExportAvailability() {
  notConfiguredSeen = false;
  notConfiguredMessage = '';
}

/**
 * Render the "Export" block and wire its form.
 *
 * The block is inserted before `anchorEl` when given, else appended to `host`.
 *
 * @param {object} opts
 * @param {string}      opts.assetId   the ULID. Sub-resource routes do not
 *                                     resolve slugs, and `asset.id` is the ULID
 *                                     even when the pane was opened by slug
 * @param {string}      [opts.sourceName] the source asset's `name`, used by the
 *                                     409 copy
 * @param {HTMLElement} [opts.host]    container to append to
 * @param {HTMLElement} [opts.anchorEl] element to insert before, inside its parent
 * @param {boolean}     [opts.canExport] client-role mirror of the role matrix
 * @param {Function}    opts.apiFetch
 * @param {(root: ParentNode) => void} [opts.wireCopyIds] house click-to-copy wiring
 * @param {(assetId: string) => any}   [opts.onOpenAsset] open the new child's detail
 * @param {(child: object) => any}     [opts.onExported] called with the 201 body
 * @returns {{ block: HTMLElement }}
 */
export function mountExportAction(opts) {
  const o = opts || {};
  const apiFetch = o.apiFetch;
  const path = '/assets/' + encodeURIComponent(String(o.assetId)) + '/export';

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

  /**
   * Replace — not append to — the message region. §2/§3/§4 all say the outcome
   * REPLACES the in-progress message, so a stale "Exporting…" can never sit
   * next to the result that contradicts it. This is also why the house
   * `showMsg` helper is not used here: it appends and self-removes after 6s,
   * and it writes `textContent` only, so it cannot carry §3's link to the new
   * asset. The `.msg .msg-<kind>` classes it applies ARE reused, so the visual
   * treatment is the house one.
   */
  function setMsg(kind) {
    const host = rendered ? rendered.msgHost : null;
    if (!host) return null;
    while (host.firstChild) host.removeChild(host.firstChild);
    const msg = el('div', 'msg msg-' + kind);
    host.appendChild(msg);
    return msg;
  }

  function draw() {
    const next = renderExportBlock({
      canExport: o.canExport !== false,
      notConfigured: notConfiguredSeen,
      notConfiguredMessage: notConfiguredMessage,
    });
    place(next.block);
    rendered = next;
    if (next.form) {
      next.form.addEventListener('submit', function (event) {
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        void submit();
      });
    }
  }

  /** §3 — the success block: the outcome sentence, the child's name as a link,
   *  and its ULID as click-to-copy monospace text. */
  function reportSuccess(format, child) {
    const msg = setMsg('success');
    if (!msg) return;
    msg.appendChild(document.createTextNode(EXPORT_COPY.succeeded(format) + ' '));
    const id = child && child.id != null ? String(child.id) : '';
    const name = child && child.name != null && String(child.name).trim()
      ? String(child.name)
      : id;
    if (name) {
      const link = el('a', 'export-result-link', name);
      link.href = '#';
      link.setAttribute('data-asset-id', id);
      if (typeof o.onOpenAsset === 'function' && id) {
        link.addEventListener('click', function (event) {
          if (event && typeof event.preventDefault === 'function') event.preventDefault();
          o.onOpenAsset(id);
        });
      }
      msg.appendChild(link);
    }
    if (id) {
      // Same click-to-copy id convention the rest of the UI uses
      // (public/copy-id.js). Built with DOM rather than that module's HTML
      // helper so no string concatenation reaches innerHTML here.
      const idRow = el('div', 'export-result-id');
      idRow.appendChild(el('span', 'cell-id cell-id-value text-mono', id));
      const copyBtn = el('button', 'copy-id-btn', 'Copy');
      copyBtn.type = 'button';
      copyBtn.setAttribute('data-copy-id', id);
      copyBtn.setAttribute('aria-live', 'polite');
      copyBtn.setAttribute('aria-label', 'Copy export asset id ' + id);
      idRow.appendChild(copyBtn);
      msg.appendChild(idRow);
      if (typeof o.wireCopyIds === 'function') o.wireCopyIds(idRow);
    }
  }

  function reportError(text, kind) {
    const msg = setMsg(kind || 'error');
    if (msg) msg.textContent = text;
  }

  async function submit() {
    if (!rendered || !rendered.form) return;
    const format = rendered.formatSelect.value;
    const name = normaliseOutputName(rendered.nameInput.value);
    if (!name.ok) {
      // Refused locally against the schema's own bound, so an over-long name is
      // never silently truncated into an export nobody asked for.
      reportError(
        'Export name must be 256 characters or fewer. Shorten it and try again.'
      );
      rendered.nameInput.focus();
      return;
    }

    const controls = [rendered.submitBtn, rendered.formatSelect, rendered.nameInput];
    const prevLabel = rendered.submitBtn.textContent;
    // §2: disable the submit control AND the inputs for the duration. There is
    // nothing to interrupt (no job id, no cancel contract), and a second submit
    // in flight would create a second, unrelated child asset.
    controls.forEach(function (c) { c.disabled = true; });
    rendered.submitBtn.textContent = EXPORT_COPY.busy;
    reportError(EXPORT_COPY.inProgress(format), 'info');

    let child;
    try {
      child = await apiFetch(path, {
        method: 'POST',
        body: JSON.stringify(buildExportBody(format, name.value)),
      });
    } catch (err) {
      const c = classifyExportError(err, { format: format, sourceName: o.sourceName });
      if (c.notConfigured) {
        // §5: this is the deployment's standing state, so the form stops being
        // offered for the rest of the session rather than being re-enabled.
        notConfiguredSeen = true;
        notConfiguredMessage = c.detail || '';
        draw();
        // The control the operator just activated no longer exists. Move focus
        // to the explanation that replaced it, so the reason is announced and
        // focus is not stranded on a removed element (WCAG 2.4.3 / 4.1.3).
        const notice = rendered && rendered.block
          ? rendered.block.querySelector('[data-outcome="not-configured"]')
          : null;
        if (notice && typeof notice.focus === 'function') notice.focus();
        return;
      }
      // §4: the inputs stay as the operator left them — nothing about a 502
      // says they were wrong — and the action stays retryable.
      controls.forEach(function (ctl) { ctl.disabled = false; });
      rendered.submitBtn.textContent = prevLabel;
      if (c.forbidden) {
        // A control known to fail stops being offered for the rest of this view
        // of the asset (the lock and review blocks' 403 rule).
        if (rendered.form && rendered.form.parentNode) {
          rendered.form.parentNode.removeChild(rendered.form);
        }
        // Focus moves to the explanation, because the control that had focus is
        // gone (WCAG 2.4.3). The message is in the aria-live region either way.
        const msg = setMsg('error');
        if (msg) {
          msg.textContent = c.message;
          msg.setAttribute('tabindex', '-1');
          if (typeof msg.focus === 'function') msg.focus();
        }
        return;
      }
      reportError(c.message);
      return;
    }

    controls.forEach(function (c) { c.disabled = false; });
    rendered.submitBtn.textContent = prevLabel;
    // The name field is cleared because the export it named now exists; keeping
    // it would invite a second export under a name already taken.
    rendered.nameInput.value = '';
    reportSuccess(format, child);
    if (typeof o.onExported === 'function') await o.onExported(child);
  }

  draw();
  return {
    get block() {
      return rendered ? rendered.block : null;
    },
  };
}
