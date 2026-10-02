/**
 * open-videocore ops dashboard — action-failure-reasons.js
 *
 * The ONE place the API's machine-readable refusal `reason` is turned into
 * operator copy. Extracted from public/app.js by issue #921 so the SAME mapping
 * serves both directions of a refusal:
 *
 *   post-flight — a 409 already came back: reportActionFailure() / errorToast()
 *                 (issue #920, public/app.js).
 *   pre-flight  — the client can already see the action is blocked and must say
 *                 so BEFORE asking the operator to confirm it
 *                 (issue #921, public/preflight-delete.js).
 *
 * Keeping one mapping is the point of the extraction: the sentence an operator
 * reads for `member_of_collection` must not depend on whether the client noticed
 * the block before or after sending the request.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (CLAUDE.md rule 7 — read in the live tree, not assumed)
 *
 * The shared refusal envelope. Both routers declare the SAME closed enum:
 *     src/routes/assets.ts:572       deleteBlockedSchema
 *     src/routes/collections.ts:73   deleteBlockedSchema
 *         { error: 'delete_blocked', message?: string,
 *           reason: z.enum(['referenced_by_job', 'member_of_collection',
 *                           'delete_protected']),
 *           blockedBy: { jobIds: string[], collectionIds: string[] },
 *           memberCount?: number        // collections only, issue #922
 *         }
 *     Mirrored in the generated spec at openapi.json
 *     .paths["/api/v1/collections/{id}"].delete.responses["409"] — `reason` is
 *     an enum of exactly those three values, required alongside `error` and
 *     `blockedBy`; `memberCount` is optional.
 *
 * `reason` is OPTIONAL on the generic envelope (`reason: z.string().optional()`,
 * src/routes/collections.ts:46-50), so a body may carry none, or one this client
 * does not know. Every lookup below is guarded and returns null in that case, so
 * the caller falls back to the server's own `message`.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THE COPY IS SUBJECT-AWARE
 *
 * `member_of_collection` is emitted by BOTH routers, and it does not mean the
 * same thing on each:
 *     src/routes/assets.ts:2722-2728  — this ASSET is a member of collections
 *                                       (AssetMemberOfCollectionError)
 *     src/routes/collections.ts:298-306 — this COLLECTION still HOLDS members
 *                                       (CollectionInUseError)
 * One sentence cannot be true of both, so the default deck keeps the
 * item-centric wording issue #920 shipped and the `collection` subject overrides
 * the two reasons that router can actually emit. `delete_protected` is likewise
 * resolved differently per subject: an asset has an Unlock control on its detail
 * view (issue #895, public/lock-detail.js), a collection has none in this UI —
 * the only route that lifts its lock is DELETE /collections/{id}/lock
 * (src/routes/collections.ts:572-584), so the collection copy names that and
 * does not point at a control that is not there.
 *
 * Copy rules: sentence case, no promise the API has not made, no product names,
 * and never a "force"/"delete anyway" affordance — `?force=true` and
 * `?confirmMemberCount=` exist on the collection delete route
 * (src/routes/collections.ts:431-434) but this UI deliberately sends neither, so
 * the copy must not imply an override the client will not perform.
 */

// ─── The deck ────────────────────────────────────────────────────────────────
//
// Each reason is a `{ cause, resolution }` pair rather than one string: the
// pre-flight dialog renders them in two slots (confirmModal's `detail` and
// `resolution`), while the post-flight dialog renders one sentence. Joining them
// with a single space reproduces the issue-#920 strings EXACTLY — see
// ACTION_FAILURE_REASON_COPY below, which is what every existing caller reads.

const DEFAULT_REASONS = Object.freeze({
  delete_protected: Object.freeze({
    cause: 'A delete lock is set on it, so the API refuses the delete.',
    resolution:
      'Clear the lock from the item’s detail view first — the lock cannot be forced.',
  }),
  member_of_collection: Object.freeze({
    cause: 'It is still a member of one or more collections.',
    resolution: 'Remove it from those collections first, then try again.',
  }),
  referenced_by_job: Object.freeze({
    cause: 'A job that is still running references it.',
    resolution: 'Wait for that job to finish or cancel it, then try again.',
  }),
});

// Subject overrides. A subject only overrides the reasons its own router emits;
// anything else falls through to the default deck above.
const SUBJECT_REASONS = Object.freeze({
  collection: Object.freeze({
    delete_protected: Object.freeze({
      cause: 'A delete lock is set on this collection, so the API refuses the delete.',
      resolution:
        'The lock has to be cleared through DELETE /collections/{id}/lock before the ' +
        'collection can be deleted — it cannot be forced.',
    }),
    member_of_collection: Object.freeze({
      cause: 'This collection still holds member assets, so the API refuses the delete.',
      resolution: 'Remove its members first, then delete the collection.',
    }),
  }),
});

/**
 * The flat reason -> sentence map issue #920 shipped, kept as the public shape
 * every existing caller already reads (and the one a test asserts the enum
 * coverage of). Derived from the deck so the two cannot drift.
 */
export const ACTION_FAILURE_REASON_COPY = Object.freeze(
  Object.keys(DEFAULT_REASONS).reduce(function (acc, reason) {
    acc[reason] = DEFAULT_REASONS[reason].cause + ' ' + DEFAULT_REASONS[reason].resolution;
    return acc;
  }, {})
);

// ─── Lookup ──────────────────────────────────────────────────────────────────
//
// hasOwnProperty, not `in`: `reason` is server-controlled and `z.string()` on the
// generic envelope, so a value like `constructor` or `toString` must not resolve
// to an inherited property.

function own(map, key) {
  if (!map || typeof key !== 'string') return null;
  return Object.prototype.hasOwnProperty.call(map, key) ? map[key] : null;
}

/**
 * Resolve one reason to its `{ cause, resolution }` pair, or null when this
 * client does not recognise it.
 *
 * @param {string|null|undefined} reason  the API's `reason` value
 * @param {{ subject?: string }} [opts]   `subject` selects an override deck
 *                                        (today: 'collection')
 */
export function reasonExplanation(reason, opts) {
  if (typeof reason !== 'string' || reason === '') return null;
  const subject = opts && typeof opts.subject === 'string' ? opts.subject : null;
  const override = subject ? own(own(SUBJECT_REASONS, subject), reason) : null;
  return override || own(DEFAULT_REASONS, reason);
}

/**
 * The single operator-facing sentence for a reason (cause + resolution), or null
 * when the reason is absent/unrecognised. This is what the post-flight failure
 * dialog renders.
 *
 * @param {string|null|undefined} reason
 * @param {{ subject?: string }} [opts]
 */
export function actionFailureReasonCopy(reason, opts) {
  const explanation = reasonExplanation(reason, opts);
  return explanation ? explanation.cause + ' ' + explanation.resolution : null;
}

// ─── Short flag copy (issue #921) ────────────────────────────────────────────
//
// The terse label for an action the client ALREADY knows is blocked, shown beside
// the control itself so the operator reads why before clicking rather than after
// confirming. Text only: this UI has no icon set and a flag must never be carried
// by colour alone (WCAG 1.4.1 — the same rule public/lock-state.js follows).

const DEFAULT_FLAGS = Object.freeze({
  delete_protected: 'a delete lock is set',
  member_of_collection: 'it is still in a collection',
  referenced_by_job: 'a running job references it',
});

const SUBJECT_FLAGS = Object.freeze({
  collection: Object.freeze({
    member_of_collection: 'it still holds member assets',
  }),
});

/** Prefix shown ahead of the flag label, so "why" is never implied by styling. */
export const BLOCKED_FLAG_PREFIX = 'Delete blocked:';

/**
 * Short reason label for a pre-flight-known block, or null for a reason this
 * client does not recognise (in which case the caller shows no flag rather than
 * an empty one).
 *
 * `memberCount` is the collection's current member count — `assetIds.length`
 * from the list payload pre-flight (collectionSchema, src/routes/collections.ts:
 * 95) and the 409's own `memberCount` post-flight (collections.ts:81, :306) —
 * folded into the label when it is known, because "still holds 2 assets" tells
 * the operator how much work the resolution is.
 *
 * @param {{ reason?: string, subject?: string, memberCount?: number|null }} block
 */
export function blockedFlagLabel(block) {
  const b = block || {};
  const subject = typeof b.subject === 'string' ? b.subject : null;
  const label =
    (subject ? own(own(SUBJECT_FLAGS, subject), b.reason) : null) ||
    own(DEFAULT_FLAGS, b.reason);
  if (!label) return null;
  if (
    subject === 'collection' &&
    b.reason === 'member_of_collection' &&
    typeof b.memberCount === 'number' &&
    Number.isFinite(b.memberCount)
  ) {
    const n = Math.trunc(b.memberCount);
    return 'still holds ' + n + ' asset' + (n === 1 ? '' : 's');
  }
  return label;
}
