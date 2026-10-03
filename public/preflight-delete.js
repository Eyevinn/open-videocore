/**
 * open-videocore ops dashboard — preflight-delete.js
 *
 * Issue #921 (broken out of #853): where the client can already see that a
 * destructive action is blocked, it must say so INSTEAD of opening a
 * confirmation dialog. Confirming a delete and only then being told, through a
 * failure dialog, that it was never possible is the exact sequence this module
 * removes.
 *
 * It is the pre-flight counterpart to the post-flight reporting shipped by
 * issue #920 (reportActionFailure, public/app.js) and it reuses that issue's
 * structured-reason mapping verbatim — the deck now lives in
 * public/action-failure-reasons.js so both directions read one source. A block
 * the client predicts and the same block arriving as a 409 therefore produce the
 * same words.
 *
 * The asset archive path already works this way for the delete LOCK
 * (public/delete-blocked.js, issue #896, docs/ux/asset-lock-state-spec.md §5.1).
 * That module stays the owner of the asset surface and its spec-verbatim copy
 * deck; this one generalises the pattern over any subject whose block is
 * knowable from the list payload — today the collection delete.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — read in the live tree, not assumed)
 *
 * Operation: `DELETE /api/v1/collections/{id}`
 *   Handler: src/routes/collections.ts:412-530 (`app.delete('/:id', …)`).
 *   openapi.json .paths["/api/v1/collections/{id}"].delete
 *     .parameters => exactly three:
 *         { in: 'query', name: 'force',              required: false, boolean }
 *         { in: 'query', name: 'confirmMemberCount', required: false, integer }
 *         { in: 'path',  name: 'id',                 required: true,  string }
 *     .responses  => exactly `204`, `400`, `404`, `409`.
 *         409 schema: `delete_blocked` envelope — error (enum of the single
 *         literal), message?, reason (enum: referenced_by_job |
 *         member_of_collection | delete_protected), blockedBy { jobIds[],
 *         collectionIds[] }, memberCount? (integer >= 0);
 *         required: ['error', 'reason', 'blockedBy'].
 *
 *   The two guards that run BEFORE the delete, in this fixed order:
 *     1. `existing?.deleteLock?.locked` -> CollectionDeleteProtectedError
 *        (src/routes/collections.ts:453-455). HARD: the guard is unconditional
 *        and `request.query.force` is never consulted for it. Mapped to 409
 *        `delete_blocked` / reason `delete_protected`, blockedBy both-empty
 *        (collections.ts:278-285).
 *     2. `existing.assetIds.length > 0` -> CollectionInUseError
 *        (collections.ts:490-492), unless `?force=true` or a matching
 *        `?confirmMemberCount=`. Mapped to 409 `delete_blocked` / reason
 *        `member_of_collection`, `blockedBy.collectionIds = [collection id]`
 *        and `memberCount` = the real member count (collections.ts:298-307).
 *   `repo.delete(id)` is only reached after both (collections.ts:502), so a
 *   refusal changes nothing: no document is touched and no `collection.deleted`
 *   audit entry is written (the emit sits after the delete, :506-527).
 *
 *   THIS UI SENDS NEITHER OVERRIDE. The call site issues a bare
 *   `DELETE /collections/{id}` (public/app.js), so for a locked or a non-empty
 *   collection the outcome is known in advance and is always the 409. That is
 *   what makes the pre-flight check sound rather than a guess.
 *
 *   The state the prediction reads comes from the list payload itself:
 *     `GET /api/v1/collections` -> { collections: collectionSchema[] }
 *     (src/routes/collections.ts:343-353), and collectionSchema carries both
 *     `assetIds: string[]` (:95, required) and `deleteLock?` (:102) — confirmed
 *     in openapi.json .paths["/api/v1/collections/"].get.responses["200"],
 *     whose item properties are id, name, assetIds, description, tags, custom,
 *     createdAt, updatedAt, deleteLock (deleteLock requires `locked` +
 *     `lockedAt`). No extra request is needed to know the block.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE CONTROL IS NOT `disabled`
 *
 * A `disabled` button cannot be focused, carries no accessible name for WHY, and
 * drops out of the keyboard order — so the operator loses the explanation along
 * with the action (the reasoning docs/ux/asset-lock-state-spec.md §5.1 settled
 * for the asset surface, and the same conclusion holds here). Instead:
 *   - the row carries a text flag naming the block, so the reason is readable
 *     BEFORE the control is activated, and
 *   - activating the control opens the blocked variant of confirmModal — which
 *     has no confirm button at all — so there is nothing to confirm and no
 *     request is sent.
 * Both halves of the issue's acceptance criterion are therefore satisfied: the
 * state says why, and a blocked action never asks for confirmation first.
 *
 * ESCAPING: every subject-controlled string (the collection name) is handed to
 * confirmModal, which writes the prompt, the detail line and every list item
 * through `textContent`. Nothing here builds an HTML string and nothing reaches
 * `innerHTML`; the flag label is module copy plus an integer count.
 */

import {
  BLOCKED_FLAG_PREFIX,
  blockedFlagLabel,
  reasonExplanation,
} from './action-failure-reasons.js';

// ─── Copy ────────────────────────────────────────────────────────────────────
//
// Only the frame lives here: the cause and the resolution come from the shared
// reason deck, which is the whole point of the issue's "same structured-reason
// mapping" requirement.

export const PREFLIGHT_BLOCKED_COPY = Object.freeze({
  title: 'Delete blocked',
  /** Dismiss label for the blocked variant (there is no confirm button). */
  btnClose: 'Close',
  /** Tail of the question line, per subject. `{name}` is supplied by the caller. */
  questionProtected: 'is protected from deletion.',
  questionGeneric: 'cannot be deleted.',
  /** Secondary route-to-the-fix for a non-empty collection. */
  btnViewCollection: 'View collection',
});

// ─── Pre-flight derivation ───────────────────────────────────────────────────

/**
 * Decide, from a collection as the list returns it, whether a bare
 * `DELETE /collections/{id}` is already certain to be refused.
 *
 * Guard order mirrors the handler exactly (lock first, then emptiness), so the
 * reason this reports is the reason the API would report.
 *
 * @param {object} collection  one item of `GET /collections` -> `collections[]`
 * @returns {null | { subject: 'collection', reason: string, memberCount: number|null }}
 *          null when the delete is NOT predictably blocked. That is not a
 *          promise it will succeed — a membership change between this read and
 *          the click still lands as a 409, which the call site's post-flight
 *          handler reports with the same copy.
 */
export function collectionDeleteBlock(collection) {
  const c = collection && typeof collection === 'object' ? collection : {};
  // `deleteLock` is absent when unlocked — clearing the lock removes the field
  // rather than writing `locked: false` (repo.setDeleteLock, mirrored by the
  // asset-side trap documented in public/lock-state.js), so `locked === true`
  // is the only safe test.
  const locked = !!(c.deleteLock && c.deleteLock.locked === true);
  const memberCount = Array.isArray(c.assetIds) ? c.assetIds.length : null;
  if (locked) {
    return { subject: 'collection', reason: 'delete_protected', memberCount: memberCount };
  }
  // `assetIds` is REQUIRED on collectionSchema, but a proxied or partial payload
  // that omits it leaves membership unknown — and unknown is never treated as
  // blocked: the operator keeps the ordinary confirmation and the post-flight
  // 409 handler covers the refusal.
  if (typeof memberCount === 'number' && memberCount > 0) {
    return { subject: 'collection', reason: 'member_of_collection', memberCount: memberCount };
  }
  return null;
}

/**
 * The short, operator-visible flag for a block, rendered next to the control
 * (e.g. `Delete blocked: still holds 2 assets`). Null when there is nothing
 * recognised to say, so a caller renders no flag rather than an empty one.
 *
 * @param {object} block  from collectionDeleteBlock()
 */
export function blockedActionFlag(block) {
  const label = blockedFlagLabel(block);
  return label ? BLOCKED_FLAG_PREFIX + ' ' + label : null;
}

// ─── Dialog spec ─────────────────────────────────────────────────────────────

/**
 * Build the confirmModal spec for a pre-flight-blocked delete.
 *
 * `blocked: true` selects confirmModal's blocked variant: no confirm button, the
 * dismiss button labelled `Close`, and the promise resolving `false`
 * (public/app.js confirmModal). `affected` is empty and omitted by that variant:
 * the request is never sent, so nothing is affected and the detail line says so.
 *
 * @param {{ subject?: string, reason?: string, memberCount?: number|null }} block
 * @param {string} name  human-readable subject label, already resolved by the
 *                       caller through nameOrFallback() — never an opaque id.
 * @param {{ unaffected?: string[] }} [opts]
 *        `unaffected` lets the call site state what is demonstrably untouched in
 *        its own domain terms; it defaults to the one fact true of every
 *        pre-flight block, which is that nothing was sent at all.
 */
export function preflightBlockedSpec(block, name, opts) {
  const b = block || {};
  const o = opts || {};
  const label = String(name == null ? '' : name);
  const explanation = reasonExplanation(b.reason, { subject: b.subject });

  const tail =
    b.reason === 'delete_protected'
      ? PREFLIGHT_BLOCKED_COPY.questionProtected
      : PREFLIGHT_BLOCKED_COPY.questionGeneric;

  // The count belongs in the question line, not in the shared deck: it is live
  // data, and the deck's prose has to stay true for a caller that has no count.
  const countClause =
    b.subject === 'collection' &&
    b.reason === 'member_of_collection' &&
    typeof b.memberCount === 'number' &&
    Number.isFinite(b.memberCount)
      ? ' It still holds ' +
        Math.trunc(b.memberCount) +
        ' asset' +
        (Math.trunc(b.memberCount) === 1 ? '' : 's') +
        '.'
      : '';

  return {
    blocked: true,
    title: PREFLIGHT_BLOCKED_COPY.title,
    subject: label,
    question: '"' + label + '" ' + tail + countClause,
    // Nothing was sent, so there is no server `message` to fall back to here;
    // an unrecognised reason cannot occur on a client-derived block (the client
    // only derives reasons it knows) but the guard keeps the dialog honest if a
    // future caller passes one through.
    detail: explanation
      ? explanation.cause
      : 'The API refuses this delete, so it was not attempted. Nothing has changed.',
    affected: [],
    unaffected: Array.isArray(o.unaffected) ? o.unaffected : ['No request was sent, so nothing has changed.'],
    resolution: explanation ? explanation.resolution : '',
    closeLabel: PREFLIGHT_BLOCKED_COPY.btnClose,
  };
}

/**
 * Show the blocked dialog for a pre-flight-blocked delete.
 *
 * confirmModal is injected rather than imported so this module stays free of an
 * import cycle with public/app.js, which owns the primitive — the same pattern
 * public/delete-blocked.js and public/lock-detail.js use.
 *
 * @param {object}   opts
 * @param {object}   opts.block         from collectionDeleteBlock()
 * @param {string}   opts.name          human-readable subject label
 * @param {Function} opts.confirmModal  app.js confirmModal
 * @param {string[]} [opts.unaffected]  see preflightBlockedSpec
 * @param {{ label: string, onActivate: Function }} [opts.secondary]
 *        optional non-destructive route to where the block can be resolved.
 *        Offered only where such a place exists in this UI — never a "force" or
 *        "delete anyway" control, which the API would answer identically.
 * @returns {Promise<void>} resolves when the dialog closes.
 */
export async function showPreflightBlocked(opts) {
  const o = opts || {};
  const spec = preflightBlockedSpec(o.block, o.name, { unaffected: o.unaffected });
  if (o.secondary && o.secondary.label && typeof o.secondary.onActivate === 'function') {
    spec.secondary = { label: String(o.secondary.label), onActivate: o.secondary.onActivate };
  }
  await o.confirmModal(spec);
}
