/**
 * open-videocore ops dashboard — asset-clip.js
 *
 * The asset DETAIL view's "Clip" action (issue #793): an operator-facing
 * affordance for POST /api/v1/assets/{id}/clip, which the API has served since
 * issue #17 but which no control in this UI could ever reach.
 *
 * UI ONLY. No route, schema or response shape is changed by this module; it
 * sends the two fields the existing request body requires plus the one optional
 * field it declares.
 *
 * Everything operator-visible here is written with `textContent` or
 * `createElement`. A clip name and a server error message are both data this UI
 * does not control, so neither ever touches `innerHTML`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before any call was written)
 *
 * Read from this repo's route source and generated spec on this branch. Nothing
 * is taken from the issue text.
 *
 *   The write — `openapi.json .paths["/api/v1/assets/{id}/clip"].post`
 *     (the spec declares no `operationId` for any operation in this API, so the
 *     operation is identified by path + method throughout).
 *     parameters: exactly one — path `id` (string, required). No query params.
 *     requestBody: REQUIRED. properties:
 *       `startSeconds` number, minimum 0
 *       `endSeconds`   number, minimum 0 exclusive
 *       `outputName`   string, minLength 1, maxLength 256
 *       `asVersion`    boolean
 *       required: ["startSeconds", "endSeconds"]; additionalProperties: false.
 *     responses: exactly 201 / 400 / 404 / 409 / 501 / 502. The 201 body is the
 *       FULL asset (the same schema as GET /api/v1/assets/{id}); 400/404/409/
 *       501/502 are all `{ error: string, message?: string }`
 *       (`additionalProperties: false`, only `error` required).
 *     Source of truth: `clipBodySchema`, src/routes/assets.ts:734-746 —
 *       `startSeconds: z.number().min(0)` :736, `endSeconds: z.number().positive()`
 *       :737, `outputName: z.string().min(1).max(256).optional()` :738,
 *       `asVersion: z.boolean().optional()` :743, and
 *       `.refine((b) => b.endSeconds > b.startSeconds, …)` :744-746.
 *       Wired at `app.post('/:id/clip', …)` src/routes/assets.ts:5389-5404,
 *       `response: { 201: assetSchema, 400, 404, 409, 501, 502: errorSchema }`
 *       at :5395-5402, mounted under the `/api/v1/assets` prefix.
 *
 *   The RESPONSE is a child asset, not a job handle. The route AWAITS the
 *     extraction (src/routes/assets.ts:5433-5450) and sends the new asset with
 *     `reply.code(201)` at :5449. The child's linkage and naming are decided in
 *     the pipeline, verified there rather than assumed:
 *       `parentId: sourceAssetId` — src/pipeline/clip.ts:158-164 (`assets.create`)
 *       default name `clip-${startSeconds}-${endSeconds}` when `outputName` is
 *         absent — src/pipeline/clip.ts:162
 *     `parentId` is an optional property of the asset schema
 *     (src/routes/assets.ts:883), so the child this UI links to is identified by
 *     its own `id`, which the 201 always carries (`id` is in the 201 schema's
 *     `required` list).
 *
 *   FAILURE IS REAL FAILURE (issue #786, CLOSED — relied on here). The pipeline
 *     creates the child in `processing`, runs the job, then VERIFIES the written
 *     object exists and is non-empty before recording its `objectKey` and
 *     advancing it to `ready` (src/pipeline/clip.ts:166-209). On a runner error —
 *     or on a job that reports success while nothing landed — the child is set to
 *     `failed` and the error is rethrown (clip.ts:191-196), which the route maps
 *     to `502 { error: 'clip_failed', message }` (src/routes/assets.ts:5452-5461).
 *     So a 201 is the only outcome this module reports as a usable clip, and the
 *     `status` on the returned child is still read back rather than assumed —
 *     see `clipOutcome` below. The 502 `message` is the status-bearing sentence
 *     only; the ffmpeg log is deliberately logged SERVER-SIDE ONLY
 *     (src/routes/assets.ts:5452-5459), so there is no client-side log to show
 *     and this module does not pretend there is one.
 *
 *   Bounds come from the asset's OWN duration, and the field name was verified
 *     rather than guessed: `technicalMetadata.durationSeconds`
 *     (`technicalMetadataSchema`, src/routes/assets.ts:761-770, `durationSeconds:
 *     z.number()` at :765), reached through `assetSchema.technicalMetadata`,
 *     which is `.nullish()` (src/routes/assets.ts:434) — `null` until the first
 *     successful extraction. The same field is what the detail grid already
 *     renders as "Duration" (public/app.js:2595). THE API DOES NOT BOUND THE
 *     WINDOW ITSELF: `clipBodySchema` only requires `endSeconds > startSeconds`,
 *     so the duration check below is a client-side guard against asking for a
 *     window that cannot exist, not a mirror of a server rule.
 *
 *   No source object -> a guaranteed refusal. Every source-consuming operation
 *     resolves the source through `requireSourceObject`
 *     (src/routes/assets.ts:5409, src/pipeline/source-object.ts:57-67) and
 *     answers `409 { error: 'no_object', message: 'asset has no stored source
 *     object to process' }` (source-object.ts:31-36) when `Asset.objectKey` is
 *     absent. So the control is not offered for an asset with no `objectKey`
 *     (an optional property of the asset schema, src/routes/assets.ts:886) —
 *     the same rule the Restore control follows. The 409 is still handled, since
 *     the server is the authority.
 *
 *   Authorisation — `MATRIX` (src/auth/authorize.ts:54-58) grants `write` to
 *     `editor` and `admin` only; `methodToAction` (:79-93) maps POST -> write;
 *     `resourceAuthorizationPreHandler('asset')` (:126, registered
 *     src/routes/assets.ts:1718) applies it to this route. So a `viewer` gets a
 *     403 `forbidden_insufficient_role` (:99). The caller passes `canChange` as
 *     a client-side MIRROR of that rule; the 403 path below still runs.
 *
 *   Path parameter — the handler passes the raw param to `repo.get`
 *     (src/routes/assets.ts:5405) with no slug fallback, so this module always
 *     sends the ULID (`asset.id`), which the detail pane holds even when it was
 *     opened by slug.
 *
 *   DELIBERATELY NOT SENT: `asVersion`. It is a declared body field, but it
 *     rewrites the source asset's own version lineage (`resolveVersionLinkage`
 *     plus a write back to the SOURCE, src/pipeline/clip.ts:144-156) — a
 *     different decision from "cut this window out". `clipRequestBody` is the
 *     single place the body is built so no sibling field can be sent by
 *     accident.
 */

// ─── Copy deck ───────────────────────────────────────────────────────────────
//
// Frozen so a caller cannot drift the wording, and exported so a test asserts
// against the same sentences the operator sees.

export const CLIP_COPY = Object.freeze({
  /** `clip.btn` — the action-row control. */
  btn: 'Clip',
  /** `clip.dialog.title` */
  dialogTitle: 'Clip asset',
  /** `clip.dialog.intro` — what the action produces. */
  dialogIntro:
    'A clip cuts the window between the in and out points into a NEW asset. ' +
    'The source asset is not modified: nothing is trimmed in place, and the ' +
    'clip is linked back to this asset as its parent.',
  /** `clip.dialog.sync` — why the dialog sits there while it runs. */
  dialogSync:
    'The request runs the extraction and waits for it, so it can take a while ' +
    'on a long source. Keep this dialog open until it reports an outcome.',
  /** `clip.field.in.label` */
  inLabel: 'In point (seconds)',
  /** `clip.field.out.label` */
  outLabel: 'Out point (seconds)',
  /** `clip.field.name.label` */
  nameLabel: 'Output name (optional)',
  /** `clip.field.name.help` — the server-side default, read from the pipeline. */
  nameHelp:
    'Optional. Up to 256 characters. Left empty, the API names the clip ' +
    'clip-<in>-<out>.',
  /** `clip.field.duration.unknown` — no extracted duration to bound against. */
  durationUnknown:
    'This asset has no extracted duration yet, so the out point cannot be ' +
    'checked against it. Run Extract Metadata first if you want that check.',
  /** `clip.btn.submit` */
  btnSubmit: 'Create clip',
  /** `clip.btn.submitting` */
  busyLabel: 'Clipping…',
  /** `clip.btn.cancel` */
  btnCancel: 'Cancel',
  /** `clip.btn.open` — follow the produced clip. */
  btnOpen: 'Open clip',
  /** `clip.error.in.number` */
  errInNumber: 'Enter the in point as a number of seconds (for example 12.5).',
  /** `clip.error.out.number` */
  errOutNumber: 'Enter the out point as a number of seconds (for example 30).',
  /** `clip.error.in.negative` — `startSeconds: z.number().min(0)`. */
  errInNegative: 'The in point cannot be before 0 seconds.',
  /** `clip.error.out.positive` — `endSeconds: z.number().positive()`. */
  errOutPositive: 'The out point must be greater than 0 seconds.',
  /** `clip.error.order` — the schema's own refinement. */
  errOrder: 'The out point must be later than the in point.',
  /** `clip.error.name.long` */
  errNameTooLong: 'Output name is too long (maximum 256 characters).',
  /** `clip.error.forbidden` */
  errForbidden:
    'Your role cannot clip this asset. Ask an editor or administrator.',
  /** `clip.error.notFound` */
  errNotFound: 'This asset no longer exists. No clip was created.',
  /** `clip.error.noObject` */
  errNoObject:
    'This asset has no stored source file, so there is nothing to clip from.',
  /** `clip.error.notConfigured` */
  errNotConfigured:
    'Clip extraction is not configured on this deployment. No clip was created.',
  /** `clip.error.jobFailed` — the honest 502 (issue #786). */
  errJobFailed:
    'The clip job failed. No clip is available: the API marks the clip asset ' +
    'failed rather than handing back one that looks ready.',
  /** `clip.error.rejected` — a 400 the client-side rules did not catch. */
  errRejected: 'The API rejected these in and out points. No clip was created.',
  /** `clip.error.unknown` — transport failure: the outcome is genuinely unknown. */
  errNetwork:
    'Could not reach the API, so the outcome of this clip is unknown. Check ' +
    'the asset list before trying again.',
});

/** Server-enforced bound on `outputName`, from the body schema. */
export const OUTPUT_NAME_MAX = 256;

// ─── Pure helpers ────────────────────────────────────────────────────────────

/**
 * Format a number of seconds for display, e.g. `00:01:03.500`.
 * Display only — every value sent to the API is a plain number of seconds,
 * which is the unit the body schema declares.
 *
 * @param {unknown} n
 * @returns {string}
 */
export function formatSeconds(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '—';
  const whole = Math.floor(n);
  const millis = Math.min(999, Math.round((n - whole) * 1000));
  const pad = function (v, width) {
    return String(v).padStart(width || 2, '0');
  };
  const base =
    pad(Math.floor(whole / 3600)) +
    ':' +
    pad(Math.floor((whole % 3600) / 60)) +
    ':' +
    pad(whole % 60);
  return millis > 0 ? base + '.' + pad(millis, 3) : base;
}

/**
 * Read a seconds value out of an input.
 *
 * A `<input type="number">` already refuses non-numeric text (its `value` is
 * the empty string in that case), so this is the one place that turns "the
 * field holds nothing usable" into `null` for both that case and a
 * programmatic caller passing junk.
 *
 * @param {unknown} raw
 * @returns {number|null} the value in seconds, or null when it is not a number
 */
export function parseSeconds(raw) {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  if (!v) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * The sentence shown when a point falls outside the asset's known duration.
 * Built here rather than stored in the copy deck because it names the actual
 * duration — an operator cannot act on "outside the duration" without it.
 *
 * @param {number} durationSeconds
 * @returns {string}
 */
export function outsideDurationMessage(durationSeconds) {
  return (
    'The in and out points must fall inside this asset’s duration — 0 to ' +
    String(durationSeconds) +
    ' seconds (' +
    formatSeconds(durationSeconds) +
    ').'
  );
}

/**
 * Validate an in/out window before any request is made.
 *
 * Three of these rules mirror the body schema (`startSeconds >= 0`,
 * `endSeconds > 0`, `endSeconds > startSeconds`) so that a 400 is not the normal
 * way an operator learns them. The fourth — the duration bound — has NO
 * server-side equivalent (see CONTRACT GROUNDING): the API would accept an out
 * point past the end of the source and the ffmpeg job would simply cut short.
 * It is enforced here because asking for a window that cannot exist is a
 * mistake, not an intent.
 *
 * When the asset has no extracted duration there is no bound to apply, and this
 * does NOT invent one: the window is validated against the schema rules alone
 * and the dialog says plainly that the check could not be made.
 *
 * @param {object} input
 * @param {unknown} input.start            raw in-point field value
 * @param {unknown} input.end              raw out-point field value
 * @param {unknown} [input.durationSeconds] asset.technicalMetadata.durationSeconds
 * @returns {{ ok: boolean, startSeconds: number|null, endSeconds: number|null,
 *             reason: string|null, message: string|null }}
 */
export function validateClipRange(input) {
  const i = input || {};
  const startSeconds = parseSeconds(i.start);
  const endSeconds = parseSeconds(i.end);
  const duration =
    typeof i.durationSeconds === 'number' &&
    Number.isFinite(i.durationSeconds) &&
    i.durationSeconds > 0
      ? i.durationSeconds
      : null;

  const fail = function (reason, message) {
    return { ok: false, startSeconds, endSeconds, reason, message };
  };

  if (startSeconds === null) return fail('in-not-a-number', CLIP_COPY.errInNumber);
  if (endSeconds === null) return fail('out-not-a-number', CLIP_COPY.errOutNumber);
  if (startSeconds < 0) return fail('in-negative', CLIP_COPY.errInNegative);
  if (endSeconds <= 0) return fail('out-not-positive', CLIP_COPY.errOutPositive);
  if (endSeconds <= startSeconds) return fail('out-not-after-in', CLIP_COPY.errOrder);
  if (duration !== null && (startSeconds >= duration || endSeconds > duration)) {
    // An in point AT the duration leaves a zero-length window, so it is out of
    // range too; an out point exactly AT the duration is the whole tail and is
    // allowed.
    return fail('outside-duration', outsideDurationMessage(duration));
  }
  return { ok: true, startSeconds, endSeconds, reason: null, message: null };
}

/**
 * Validate the optional output name against the body schema's bound.
 * An empty field is valid — it means "let the API name it".
 *
 * @param {unknown} raw
 * @returns {{ ok: boolean, value: string|undefined, message: string|null }}
 */
export function normaliseOutputName(raw) {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (!value) return { ok: true, value: undefined, message: null };
  if (value.length > OUTPUT_NAME_MAX) {
    return { ok: false, value, message: CLIP_COPY.errNameTooLong };
  }
  return { ok: true, value, message: null };
}

/**
 * Build the JSON body for `POST /api/v1/assets/{id}/clip`.
 *
 * `startSeconds` and `endSeconds` always; `outputName` only when the operator
 * supplied one (the schema requires `minLength: 1`, so an empty string would be
 * a 400 and "no name" must be an ABSENT key, not an empty one). `asVersion` is
 * never sent — see CONTRACT GROUNDING.
 *
 * @param {number} startSeconds
 * @param {number} endSeconds
 * @param {string} [outputName]
 * @returns {{ startSeconds: number, endSeconds: number, outputName?: string }}
 */
export function clipRequestBody(startSeconds, endSeconds, outputName) {
  const body = { startSeconds: Number(startSeconds), endSeconds: Number(endSeconds) };
  const name = typeof outputName === 'string' ? outputName.trim() : '';
  if (name) body.outputName = name;
  return body;
}

/**
 * Classify a failed clip into operator-facing copy.
 *
 * Every status the operation declares is handled by name. 401/403 are NOT
 * declared on this operation but are reachable through the role gate, so they
 * are handled without assuming a modelled body.
 *
 * `dismiss: true` means the dialog cannot usefully be retried as it stands and
 * closes; the outcome is then reported in the detail pane's message area.
 *
 * @param {{status?: number, message?: string, body?: any}} err  an apiFetch rejection
 * @returns {{kind: string, message: string, detail: string|null, dismiss: boolean}}
 */
export function classifyClipError(err) {
  const e = err || {};
  // The server's own sentence, shown as a second line where it adds something.
  // `apiFetch` already prefers `body.message` over `body.error` for `message`
  // (public/app.js:296-299), so this is the human-readable half.
  const serverMessage = typeof e.message === 'string' && e.message ? e.message : null;
  switch (e.status) {
    case 401:
    case 403:
      return { kind: 'forbidden', message: CLIP_COPY.errForbidden, detail: null, dismiss: false };
    case 404:
      return { kind: 'not-found', message: CLIP_COPY.errNotFound, detail: null, dismiss: true };
    case 409:
      return { kind: 'no-object', message: CLIP_COPY.errNoObject, detail: null, dismiss: true };
    case 501:
      return {
        kind: 'not-configured',
        message: CLIP_COPY.errNotConfigured,
        detail: null,
        dismiss: true,
      };
    case 502:
      // The honest failure path (issue #786). The server sentence says WHICH
      // stage failed, which is the only diagnosis a client can be given.
      return {
        kind: 'job-failed',
        message: CLIP_COPY.errJobFailed,
        detail: serverMessage,
        dismiss: false,
      };
    case 400:
      return { kind: 'rejected', message: CLIP_COPY.errRejected, detail: serverMessage, dismiss: false };
    default:
      // Transport failure, 5xx, or anything else undeclared. The request may or
      // may not have reached the server, so nothing here claims it did not.
      return { kind: 'unknown', message: CLIP_COPY.errNetwork, detail: null, dismiss: false };
  }
}

/**
 * Read the outcome off the asset the 201 returned, instead of assuming a 201
 * means a usable clip.
 *
 * The pipeline only reaches `ready` after it has confirmed the written object
 * exists and is non-empty (src/pipeline/clip.ts:175-209), so in practice a 201
 * carries a `ready` child. This still checks, because "a child asset that looks
 * ready when it is not" is exactly the failure issue #786 fixed, and a UI that
 * re-states the server's own `status` cannot reintroduce it.
 *
 * @param {object|null|undefined} child  the asset from the 201
 * @returns {{ ok: boolean, id: string|null, name: string, status: string, message: string }}
 */
export function clipOutcome(child) {
  const c = child || {};
  const id = typeof c.id === 'string' && c.id ? c.id : null;
  const name = typeof c.name === 'string' && c.name ? c.name : id || 'clip';
  const status = typeof c.status === 'string' && c.status ? c.status : 'unknown';
  if (!id) {
    return {
      ok: false,
      id: null,
      name: name,
      status: status,
      message: 'The API reported success but returned no clip asset.',
    };
  }
  if (status !== 'ready') {
    return {
      ok: false,
      id: id,
      name: name,
      status: status,
      message: 'The clip asset “' + name + '” was created but its status is ' + status + ', not ready.',
    };
  }
  return {
    ok: true,
    id: id,
    name: name,
    status: status,
    message: 'Clip “' + name + '” created and ready.',
  };
}

// ─── DOM helpers ─────────────────────────────────────────────────────────────

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function secondsInput(id, labelText, opts) {
  const o = opts || {};
  const field = el('div', 'form-field grow');
  const label = el('label', null, labelText);
  label.setAttribute('for', id);

  const input = document.createElement('input');
  // A native number input is what BOUNDS the control: `min`/`max` are carried
  // to assistive technology as the field's range and are enforced by the
  // browser's own stepper, so the duration limit is not a JS-only rule.
  input.type = 'number';
  input.id = id;
  input.step = '0.001';
  input.min = '0';
  if (typeof o.max === 'number') input.max = String(o.max);
  if (o.value != null) input.value = String(o.value);

  const help = el('div', 'text-muted clip-field-help', o.help || '');
  help.id = id + '-help';
  input.setAttribute('aria-describedby', help.id);

  field.appendChild(label);
  field.appendChild(input);
  field.appendChild(help);
  return { field: field, input: input, help: help };
}

/**
 * Build the clip form. PURE: no fetch, no listeners beyond the ones the caller
 * attaches to the returned nodes.
 *
 * Reuses the house form furniture (`.form-field.grow`, `.modal-actions`,
 * `.msg.msg-error`) exactly as the rename and lock dialogs do — no new dialog
 * primitive is introduced for this action.
 *
 * @param {HTMLElement} body  the modal body element
 * @param {{ durationSeconds?: number|null }} opts
 * @returns {{ startInput: HTMLInputElement, endInput: HTMLInputElement,
 *             nameInput: HTMLInputElement, errorEl: HTMLElement,
 *             submitBtn: HTMLElement, cancelBtn: HTMLElement }}
 */
export function buildClipForm(body, opts) {
  const o = opts || {};
  const duration =
    typeof o.durationSeconds === 'number' &&
    Number.isFinite(o.durationSeconds) &&
    o.durationSeconds > 0
      ? o.durationSeconds
      : null;

  body.classList.add('clip-dialog');
  body.appendChild(el('p', 'clip-dialog-intro', CLIP_COPY.dialogIntro));
  body.appendChild(el('p', 'clip-dialog-sync', CLIP_COPY.dialogSync));

  if (duration !== null) {
    // The bound, stated once in prose as well as carried on the inputs.
    body.appendChild(
      el(
        'p',
        'clip-dialog-duration text-muted',
        'Source duration: ' +
          String(duration) +
          ' seconds (' +
          formatSeconds(duration) +
          '). In and out points must fall inside it.'
      )
    );
  } else {
    const warn = el('p', 'clip-dialog-duration-unknown text-muted', CLIP_COPY.durationUnknown);
    body.appendChild(warn);
  }

  const row = el('div', 'form-row mt12');
  const rangeHelp =
    duration !== null ? 'Between 0 and ' + String(duration) + '.' : 'In seconds.';
  const start = secondsInput('clip-start-seconds', CLIP_COPY.inLabel, {
    max: duration === null ? undefined : duration,
    value: '0',
    help: rangeHelp,
  });
  const end = secondsInput('clip-end-seconds', CLIP_COPY.outLabel, {
    max: duration === null ? undefined : duration,
    // Prefilled with the full tail when the duration is known, so the first
    // valid window needs one edit rather than two. Empty when it is not known —
    // the UI does not invent an out point it cannot justify.
    value: duration === null ? '' : String(duration),
    help: duration !== null ? 'Greater than the in point, up to ' + String(duration) + '.' : 'Greater than the in point.',
  });
  row.appendChild(start.field);
  row.appendChild(end.field);
  body.appendChild(row);

  const nameField = el('div', 'form-field grow mt12');
  const nameLabel = el('label', null, CLIP_COPY.nameLabel);
  nameLabel.setAttribute('for', 'clip-output-name');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.id = 'clip-output-name';
  nameInput.maxLength = OUTPUT_NAME_MAX;
  const nameHelp = el('div', 'text-muted clip-field-help', CLIP_COPY.nameHelp);
  nameHelp.id = 'clip-output-name-help';
  nameInput.setAttribute('aria-describedby', nameHelp.id);
  nameField.appendChild(nameLabel);
  nameField.appendChild(nameInput);
  nameField.appendChild(nameHelp);
  body.appendChild(nameField);

  // Inline error area — every refusal keeps the dialog OPEN and writes here, so
  // the operator does not lose the points they typed. Never an `alert()`.
  const errorEl = el('div', 'msg msg-error clip-dialog-error');
  errorEl.id = 'clip-dialog-error';
  errorEl.setAttribute('role', 'alert');
  errorEl.style.display = 'none';
  body.appendChild(errorEl);

  const actions = el('div', 'modal-actions');
  const cancelBtn = el('button', 'btn-sm clip-cancel', CLIP_COPY.btnCancel);
  cancelBtn.type = 'button';
  const submitBtn = el('button', 'btn-sm clip-submit', CLIP_COPY.btnSubmit);
  submitBtn.type = 'button';
  submitBtn.id = 'clip-submit';
  actions.appendChild(cancelBtn);
  actions.appendChild(submitBtn);
  body.appendChild(actions);

  return {
    startInput: start.input,
    endInput: end.input,
    nameInput: nameInput,
    errorEl: errorEl,
    submitBtn: submitBtn,
    cancelBtn: cancelBtn,
  };
}

/**
 * Build the persistent outcome block for a completed clip.
 *
 * Not `showMsg`: that renderer auto-removes after six seconds
 * (public/app.js:961-969), and the whole point of this block is the LINK to the
 * produced clip, which must not disappear while the operator is reading it.
 *
 * The link is a real anchor with an href whenever the caller can supply one, so
 * it can be opened in a new tab / copied like any other link; when the caller
 * can also navigate in place, the click is intercepted instead.
 *
 * @param {ReturnType<typeof clipOutcome>} outcome
 * @param {{ href?: string|null, onOpen?: ((id: string) => any)|null }} [opts]
 * @returns {HTMLElement}
 */
export function buildClipResult(outcome, opts) {
  const o = opts || {};
  const wrap = el('div', 'msg ' + (outcome.ok ? 'msg-success' : 'msg-error') + ' clip-result');
  wrap.id = 'clip-result';
  // Announced politely: the outcome arrives without moving focus.
  wrap.setAttribute('role', 'status');
  wrap.appendChild(el('span', 'clip-result-text', outcome.message));

  // A clip that is not `ready` still has an id, and inspecting it is exactly how
  // an operator finds out what happened — so the link is offered either way.
  if (outcome.id) {
    const link = document.createElement('a');
    link.className = 'clip-result-link';
    link.id = 'clip-result-link';
    link.textContent = CLIP_COPY.btnOpen;
    link.href = typeof o.href === 'string' && o.href ? o.href : '#';
    if (typeof o.onOpen === 'function') {
      link.addEventListener('click', function (e) {
        // Only intercept a plain click: a modified click (new tab/window) must
        // keep the browser's own behaviour.
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button) return;
        e.preventDefault();
        o.onOpen(outcome.id);
      });
    }
    wrap.appendChild(document.createTextNode(' '));
    wrap.appendChild(link);
  }
  return wrap;
}

// ─── Mount ───────────────────────────────────────────────────────────────────

/**
 * Add the "Clip" control to the asset detail action row and wire its dialog.
 *
 * The button joins the EXISTING action row rather than creating a block of its
 * own: the clip window is entered in the dialog and the result is reported in
 * the detail pane's message area, so there is no persistent state for a block
 * to display.
 *
 * No control is rendered when `canChange` is false (the role gate) or when the
 * asset has no `objectKey` (a guaranteed 409 — see CONTRACT GROUNDING).
 *
 * @param {object} opts
 * @param {object}      opts.asset       asset from GET /api/v1/assets/{id}
 * @param {HTMLElement} opts.actionsRow  the `.mt12.flex-gap` action row
 * @param {HTMLElement} [opts.beforeEl]  element in that row to insert before
 * @param {boolean}     opts.canChange   client-role mirror of the ADR-018 matrix
 * @param {Function}    opts.apiFetch
 * @param {Function}    opts.openModal
 * @param {() => HTMLElement} [opts.messageHost]  resolves the #action-msg element
 * @param {(id: string) => any} [opts.openAsset]
 *        navigate the current view to the produced clip. Called when the
 *        operator activates the "Open clip" link with a plain click; a modified
 *        click (new tab/window) falls through to `assetHref` instead.
 * @param {(id: string) => string} [opts.assetHref]
 *        href for the produced clip, used by that link.
 * @param {boolean} [opts.navigateOnSuccess]
 *        follow a ready clip immediately instead of waiting for the link to be
 *        clicked. For a host whose view re-renders on a timer and would discard
 *        the link (the standalone detail window).
 * @param {(child: object|null, outcome: object) => any} [opts.onClipped]
 *        called after every settled attempt so the caller can refresh lists.
 * @returns {{ button: HTMLElement|null, open: (() => void)|null }}
 */
export function mountAssetClip(opts) {
  const o = opts || {};
  const asset = o.asset || {};
  const actionsRow = o.actionsRow;

  if (!o.canChange) return { button: null, open: null };
  // No stored source object -> the route can only answer 409. Offering the
  // control would offer a guaranteed failure (the Restore control's rule).
  if (typeof asset.objectKey !== 'string' || !asset.objectKey) {
    return { button: null, open: null };
  }

  const btn = el('button', 'btn-ghost', CLIP_COPY.btn);
  btn.type = 'button';
  btn.id = 'btn-clip-asset';
  if (actionsRow) {
    if (o.beforeEl && o.beforeEl.parentNode === actionsRow) {
      actionsRow.insertBefore(btn, o.beforeEl);
    } else {
      actionsRow.appendChild(btn);
    }
  }

  // The ULID, never the slug: POST /:id/clip does not resolve slugs (see
  // CONTRACT GROUNDING).
  const path = '/assets/' + encodeURIComponent(String(asset.id)) + '/clip';
  const durationSeconds =
    asset.technicalMetadata && typeof asset.technicalMetadata.durationSeconds === 'number'
      ? asset.technicalMetadata.durationSeconds
      : null;

  function host() {
    return typeof o.messageHost === 'function' ? o.messageHost() : null;
  }

  function reportOutcome(outcome) {
    const target = host();
    if (!target) return;
    const existing = target.querySelector && target.querySelector('#clip-result');
    if (existing) existing.remove();
    target.appendChild(
      buildClipResult(outcome, {
        href: typeof o.assetHref === 'function' && outcome.id ? o.assetHref(outcome.id) : null,
        onOpen: typeof o.openAsset === 'function' ? o.openAsset : null,
      })
    );
  }

  function reportFailure(message, detail) {
    const target = host();
    if (!target) return;
    const existing = target.querySelector && target.querySelector('#clip-result');
    if (existing) existing.remove();
    const wrap = el('div', 'msg msg-error clip-result');
    wrap.id = 'clip-result';
    wrap.setAttribute('role', 'status');
    wrap.appendChild(el('span', 'clip-result-text', message));
    if (detail) wrap.appendChild(el('div', 'clip-result-detail', detail));
    target.appendChild(wrap);
  }

  function open() {
    // Held so the field can be focused AFTER openModal attaches the backdrop —
    // the body builder runs while the dialog is still detached, and focus() on a
    // detached element is a no-op (the lock dialog's rule).
    let firstField = null;
    o.openModal(CLIP_COPY.dialogTitle, function (body, closeDialog) {
      const form = buildClipForm(body, { durationSeconds: durationSeconds });
      firstField = form.startInput;

      function showError(message, detail) {
        form.errorEl.textContent = '';
        form.errorEl.appendChild(el('span', null, message));
        if (detail) form.errorEl.appendChild(el('div', 'clip-dialog-error-detail', detail));
        form.errorEl.style.display = '';
      }

      form.cancelBtn.addEventListener('click', function () {
        closeDialog();
      });

      form.submitBtn.addEventListener('click', async function () {
        form.errorEl.style.display = 'none';
        form.errorEl.textContent = '';

        // Client-side gate first: the three schema rules plus the duration
        // bound. A refusal here sends no request at all.
        const range = validateClipRange({
          start: form.startInput.value,
          end: form.endInput.value,
          durationSeconds: durationSeconds,
        });
        if (!range.ok) {
          showError(range.message, null);
          (range.reason === 'out-not-after-in' || range.reason === 'out-not-a-number'
            ? form.endInput
            : form.startInput
          ).focus();
          return;
        }
        const named = normaliseOutputName(form.nameInput.value);
        if (!named.ok) {
          showError(named.message, null);
          form.nameInput.focus();
          return;
        }

        const prev = form.submitBtn.textContent;
        form.submitBtn.disabled = true;
        form.cancelBtn.disabled = true;
        form.startInput.disabled = true;
        form.endInput.disabled = true;
        form.nameInput.disabled = true;
        form.submitBtn.textContent = CLIP_COPY.busyLabel;
        try {
          const child = await o.apiFetch(path, {
            method: 'POST',
            body: JSON.stringify(
              clipRequestBody(range.startSeconds, range.endSeconds, named.value)
            ),
          });
          closeDialog();
          // Read the outcome off the returned child rather than treating the
          // 201 itself as proof of a usable clip.
          const outcome = clipOutcome(child);
          if (typeof o.onClipped === 'function') await o.onClipped(child, outcome);
          // The produced clip is normally reached through an explicit link
          // rather than by yanking the view across to it: the operator stays on
          // the source asset (the usual next action is another cut from the
          // same source), and the link is a real anchor, so it is
          // keyboard-reachable and can be opened in a new tab. Clicking it
          // navigates the detail pane in place when the caller supports that.
          reportOutcome(outcome);
          // `navigateOnSuccess` is for a host that cannot KEEP that link — the
          // standalone detail window re-renders its whole body on a timer, so a
          // link left there would disappear underneath the operator. There,
          // following the clip immediately is the only way the navigation
          // survives.
          if (outcome.ok && o.navigateOnSuccess && typeof o.openAsset === 'function') {
            o.openAsset(outcome.id);
          }
          return;
        } catch (err) {
          const c = classifyClipError(err);
          if (typeof o.onClipped === 'function') await o.onClipped(null, c);
          if (c.dismiss) {
            closeDialog();
            reportFailure(c.message, c.detail);
            if (c.kind === 'forbidden' || c.kind === 'no-object' || c.kind === 'not-configured') {
              // A control known to fail stops being offered for the rest of
              // this view of the asset (the lock module's 403 rule).
              if (btn.parentNode) btn.parentNode.removeChild(btn);
            }
            return;
          }
          if (c.kind === 'forbidden' && btn.parentNode) {
            btn.parentNode.removeChild(btn);
          }
          showError(c.message, c.detail);
        } finally {
          // Never leave the dialog stuck in its pending state.
          form.submitBtn.disabled = false;
          form.cancelBtn.disabled = false;
          form.startInput.disabled = false;
          form.endInput.disabled = false;
          form.nameInput.disabled = false;
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
  return { button: btn, open: open };
}
