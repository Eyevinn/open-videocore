/**
 * open-videocore ops dashboard — delete-blocked.js
 *
 * The ONE place a refused asset archive is turned into an explanation. Issue #896,
 * implementing docs/ux/asset-lock-state-spec.md §5 ("Surface C — protected
 * delete"). Third and last caller of the shared derivation in
 * public/lock-state.js, after the list (#894) and the detail view (#895).
 *
 * What it replaces: `alert('Error: ' + err.message)` on the archive path
 * (public/app.js, the `onDelete` handler). An `alert` showed the operator a bare
 * server sentence, offered no route to a fix, and was the opaque failure this
 * issue exists to remove.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — fetched before a line was written)
 *
 * Operation: `DELETE /api/v1/assets/{id}` — openapi.json
 *   .paths["/api/v1/assets/{id}"].delete. Source: src/routes/assets.ts:5474
 *   (`app.delete('/:id', …)`).
 *
 *   .parameters => exactly two:
 *       { in: 'query', name: 'force', required: false, schema: { type: 'boolean' } }
 *       { in: 'path',  name: 'id',    required: true,  schema: { type: 'string' } }
 *   .responses  => exactly `204`, `404`, `409`. There is no 200 and no 202.
 *       204 schema: `null`.
 *       404 schema: { error: string, message?: string }.
 *       409 schema: an `anyOf` of TWO arms —
 *         arm 1 (`deleteBlockedSchema`, src/routes/assets.ts:542-550):
 *           { error: 'delete_blocked' (literal),
 *             message?: string,
 *             reason: 'referenced_by_job' | 'member_of_collection' | 'delete_protected',
 *             blockedBy: { jobIds: string[], collectionIds: string[] } }
 *           required: ['error', 'reason', 'blockedBy']; additionalProperties: false.
 *         arm 2 (`errorSchema`): { error: string, message?: string } — the bare
 *           envelope that still serves the pre-existing `has_children` block
 *           (src/routes/assets.ts:2644-2646, `{ error: 'has_children', message }`).
 *       => a 409 body may legitimately carry NO `reason` and NO `blockedBy`.
 *          Every read below is guarded on `error === 'delete_blocked'` first
 *          (spec §5.4, §10 checklist).
 *
 *   The three `delete_blocked` bodies, from the error handler that emits them:
 *       delete_protected     src/routes/assets.ts:2666-2673 —
 *                            blockedBy { jobIds: [], collectionIds: [] } (ALWAYS
 *                            both empty; the block is intrinsic to the document,
 *                            not a foreign reference)
 *       member_of_collection src/routes/assets.ts:2678-2686 —
 *                            blockedBy.collectionIds populated, jobIds []
 *       referenced_by_job    src/routes/assets.ts:2691-2699 —
 *                            blockedBy.jobIds populated, collectionIds []
 *
 * FORCE vs THE LOCK — the precedence this module's copy depends on:
 *   `?force=true` is declared and IS genuinely honoured, but only for the soft
 *   member-of-collection block. It can never defeat the delete lock, because the
 *   lock guard runs FIRST and is unconditional:
 *       src/routes/assets.ts:5499-5502
 *           const existing = await repo.get(request.params.id);
 *           if (existing?.deleteLock?.locked) {
 *             throw new DeleteProtectedError(request.params.id);
 *           }
 *       src/routes/assets.ts:5533
 *           if (!request.query.force && opts.collectionRepository) {
 *   `request.query.force` is not read until :5533 — 31 lines after the throw —
 *   so a locked asset returns a byte-identical 409 with and without it
 *   (`DeleteProtectedError.statusCode = 409`, src/data/asset-repo.ts:801-807;
 *   asserted end-to-end by "does NOT let ?force=true bypass the lock",
 *   src/routes/assets.delete-lock.test.ts:79-93).
 *
 *   Consequence for the UI, and the reason this module offers no retry: for a
 *   locked asset there is NO request this client can send that archives it. The
 *   only resolution is `DELETE /api/v1/assets/{id}/lock` (the Unlock control
 *   shipped by #895 on the detail view). So no surface here says "force",
 *   "delete anyway", "override" or "try again" — offering a retry that is
 *   guaranteed to fail identically is worse than offering nothing (spec §5.3).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * ESCAPING
 *
 * Every asset-controlled string this module handles — the asset name, the
 * server `message`, and the job / collection ids in `blockedBy` — is passed to
 * confirmModal, which writes all of it through `textContent` (the prompt, the
 * detail line and `impactList`'s <li>s). Nothing in this file builds an HTML
 * string and nothing reaches `innerHTML`.
 */

import { LOCK_LOCKED, lockStateOf } from './lock-state.js';

// ─── Copy ────────────────────────────────────────────────────────────────────
//
// The `protected*` entries are VERBATIM from the spec's copy deck (§7, keys
// `blocked.title`, `blocked.question`, `blocked.detail`, `blocked.unaffected.1`,
// `blocked.unaffected.2`, `blocked.resolution`, `blocked.btn.close`,
// `blocked.btn.detail`). Do not paraphrase them: the deck exists so the three
// lock surfaces say one thing.
//
// The job / collection / generic entries are NOT in the deck — the deck covers
// the lock, and §5.4 only prescribes their SHAPE ("job wording, naming
// blockedBy.jobIds"). They are written to the same rules: sentence case, no
// promise the API has not made, no product names, and the same two "unaffected"
// sentences, which hold for every 409 because all four guards run before the
// archive itself (`repo.remove`, src/routes/assets.ts:5542).

export const DELETE_BLOCKED_COPY = Object.freeze({
  /** `blocked.title` */
  title: 'Archive blocked',
  /** `blocked.question` — `{name}` substituted by the caller. */
  protectedQuestion: 'is protected from deletion.',
  /** `blocked.detail` */
  protectedDetail:
    'A delete lock is set on this asset, so the API refuses to archive it. Nothing has changed.',
  /** `blocked.resolution` */
  protectedResolution:
    "To archive this asset, clear its delete lock from the asset's detail view first. " +
    'The lock cannot be forced.',

  /** reason `referenced_by_job` (§5.4 row 2). */
  jobQuestion: 'is in use by a job that is still running.',
  jobDetail:
    'An active job still references this asset as its source, so the API refuses to ' +
    'archive it. Nothing has changed.',
  jobIdsHeading: 'Jobs still referencing this asset',
  jobResolution:
    'To archive this asset, wait for those jobs to finish or cancel them, then try again.',

  /** reason `member_of_collection` (§5.4 row 3). */
  collectionQuestion: 'is still a member of a collection.',
  collectionDetail:
    'This asset still belongs to one or more collections, so the API refuses to ' +
    'archive it. Nothing has changed.',
  collectionIdsHeading: 'Collections this asset belongs to',
  collectionResolution:
    'To archive this asset, remove it from those collections first, then try again.',

  /** Unknown `reason`, or the bare `{ error, message? }` arm (§5.4 rows 4-5). */
  genericQuestion: 'could not be archived.',
  genericDetail: 'The API refused the archive. Nothing has changed.',

  /** `blocked.unaffected.1` / `blocked.unaffected.2` — true for every 409. */
  unaffected1: 'The asset, its files and its metadata are untouched.',
  unaffected2: 'No job was started and nothing was queued.',

  /** `blocked.btn.close` */
  btnClose: 'Close',
  /** `blocked.btn.detail` */
  btnDetail: 'Open detail',
});

// ─── Classification (spec §5.4) ──────────────────────────────────────────────

/**
 * Turn an apiFetch rejection into a blocked-delete descriptor, or `null` when it
 * is not a refusal this module explains (the caller then keeps its own error
 * handling — a 404, a 403, a network failure).
 *
 * Defensive by contract, not by habit: the declared 409 schema is an `anyOf`
 * whose second arm has neither `reason` nor `blockedBy`, so `error ===
 * 'delete_blocked'` is checked BEFORE either is read, and the id arrays are
 * normalised to real arrays before anything iterates them.
 *
 * @param {{ status?: number, body?: any, message?: string }} err
 *        an error thrown by apiFetch: `status` is the HTTP status and `body` the
 *        parsed JSON body (public/app.js apiFetch, which sets both).
 * @returns {null | {
 *   kind: 'protected'|'job'|'collection'|'generic',
 *   reason: string|null,
 *   message: string,
 *   jobIds: string[],
 *   collectionIds: string[]
 * }}
 */
export function classifyDeleteBlock(err) {
  if (!err || err.status !== 409) return null;

  const body = err.body && typeof err.body === 'object' ? err.body : {};
  const message = typeof body.message === 'string' ? body.message : '';

  // Arm 2 of the anyOf (e.g. `has_children`): no `reason`, no `blockedBy`.
  if (body.error !== 'delete_blocked') {
    return { kind: 'generic', reason: null, message, jobIds: [], collectionIds: [] };
  }

  const blockedBy = body.blockedBy && typeof body.blockedBy === 'object' ? body.blockedBy : {};
  const jobIds = Array.isArray(blockedBy.jobIds) ? blockedBy.jobIds.map(String) : [];
  const collectionIds = Array.isArray(blockedBy.collectionIds)
    ? blockedBy.collectionIds.map(String)
    : [];
  const reason = typeof body.reason === 'string' ? body.reason : null;

  // The enum is closed by ADR-020 §1, but a client must not crash on — or
  // silently mis-explain — a future member: anything unrecognised falls through
  // to the generic wording (spec §5.4 row 4).
  let kind = 'generic';
  if (reason === 'delete_protected') kind = 'protected';
  else if (reason === 'referenced_by_job') kind = 'job';
  else if (reason === 'member_of_collection') kind = 'collection';

  return { kind, reason, message, jobIds, collectionIds };
}

/**
 * The pre-flight descriptor for a row the client already knows is locked (spec
 * §5.1: "one code path for the pre-flight case (state known) and the post-flight
 * case (409 arrived)"). Byte-identical to what `classifyDeleteBlock` produces
 * for a real `delete_protected` 409, so the dialog cannot drift between the two.
 */
export function protectedBlock() {
  return { kind: 'protected', reason: 'delete_protected', message: '', jobIds: [], collectionIds: [] };
}

/**
 * Pre-flight predicate for the list's Archive control. A thin wrapper over the
 * shared derivation so this module never re-derives lock state (spec §2, §10).
 *
 * @param {object} asset
 * @param {{ projectionCarriesLock?: boolean }} [opts]
 */
export function isDeleteProtected(asset, opts) {
  return lockStateOf(asset, opts) === LOCK_LOCKED;
}

// ─── Dialog spec (spec §5.2) ─────────────────────────────────────────────────

/**
 * Build the confirmModal spec for a blocked archive.
 *
 * `blocked: true` selects confirmModal's blocked variant: no confirm button, the
 * dismiss button labelled `Close`, and the promise resolving `false`. There is
 * deliberately no confirm and no retry — see the FORCE vs THE LOCK note above.
 *
 * `affected` is EMPTY for every kind, and the variant omits the list rather than
 * rendering an empty one: all four guards run before `repo.remove`
 * (src/routes/assets.ts:5499-5542), so a 409 changed precisely nothing, and the
 * detail line says so in words.
 *
 * @param {{ kind: string, message?: string, jobIds?: string[], collectionIds?: string[] }} block
 * @param {string} name  human-readable asset label, already resolved by the
 *                       caller (never an opaque id — confirmModal's rule).
 */
export function deleteBlockedSpec(block, name) {
  const b = block || {};
  const label = String(name == null ? '' : name);
  const C = DELETE_BLOCKED_COPY;

  let tail = C.genericQuestion;
  let detail = C.genericDetail;
  let resolution = '';
  let blockedBy = null;

  if (b.kind === 'protected') {
    tail = C.protectedQuestion;
    detail = C.protectedDetail;
    resolution = C.protectedResolution;
    // blockedBy is `{ jobIds: [], collectionIds: [] }` here BY CONTRACT
    // (src/routes/assets.ts:2666-2673), so no "blocked by" list is rendered —
    // an empty one would imply a foreign reference that does not exist (§5.4).
  } else if (b.kind === 'job') {
    tail = C.jobQuestion;
    detail = C.jobDetail;
    resolution = C.jobResolution;
    const ids = Array.isArray(b.jobIds) ? b.jobIds : [];
    if (ids.length) blockedBy = { heading: C.jobIdsHeading, items: ids };
  } else if (b.kind === 'collection') {
    tail = C.collectionQuestion;
    detail = C.collectionDetail;
    resolution = C.collectionResolution;
    const ids = Array.isArray(b.collectionIds) ? b.collectionIds : [];
    if (ids.length) blockedBy = { heading: C.collectionIdsHeading, items: ids };
  } else if (b.message) {
    // Generic arm: prefer the server's own sentence when it sent one, rather
    // than inventing a cause the contract does not name. Rendered via
    // textContent like everything else.
    detail = b.message;
  }

  return {
    blocked: true,
    title: C.title,
    subject: label,
    question: '"' + label + '" ' + tail,
    detail,
    affected: [],
    unaffected: [C.unaffected1, C.unaffected2],
    blockedBy,
    resolution,
    closeLabel: C.btnClose,
  };
}

/**
 * Show the blocked dialog.
 *
 * Dependencies are injected rather than imported so this module stays free of a
 * cycle with public/app.js (which owns confirmModal) — the same pattern
 * public/lock-detail.js uses.
 *
 * @param {object}   opts
 * @param {object}   opts.block          from classifyDeleteBlock() / protectedBlock()
 * @param {string}   opts.name           human-readable asset label
 * @param {Function} opts.confirmModal   app.js confirmModal
 * @param {Function} [opts.onOpenDetail] when supplied, a secondary `Open detail`
 *                   button is offered; it is the route to the Unlock control on
 *                   the detail view (#895). Deliberately NOT an inline Unlock
 *                   button: unlocking mid-archive-flow would collapse two
 *                   deliberate decisions into one click (spec §5.2).
 * @returns {Promise<void>} resolves when the dialog closes.
 */
export async function showDeleteBlocked(opts) {
  const o = opts || {};
  const spec = deleteBlockedSpec(o.block, o.name);
  // `Open detail` is only meaningful for the lock: it is where the Unlock
  // control lives. A job or collection block has no such control to point at.
  if (typeof o.onOpenDetail === 'function' && spec.question && o.block && o.block.kind === 'protected') {
    spec.secondary = { label: DELETE_BLOCKED_COPY.btnDetail, onActivate: o.onOpenDetail };
  }
  await o.confirmModal(spec);
}
