/**
 * open-videocore ops dashboard — lock-state.js
 *
 * The ONE place the explicit delete-lock state is derived, and the one place the
 * list-surface lock markup and its operator-visible copy live.
 *
 * Required by the interaction spec (docs/ux/asset-lock-state-spec.md §2 and its
 * acceptance checklist §10: "`lockStateOf` lives in one module and all three
 * surfaces call it"). Issue #894 is the first caller (the asset list); #895
 * (asset detail) and #896 (protected delete) import from here rather than
 * re-deriving.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * CONTRACT GROUNDING (fetch-the-contract-before-writing-any-call rule)
 *
 * Every field name below was read out of this repo's generated spec and route
 * source on this branch. Nothing is taken from the issue text.
 *
 *   Lock object on the LIST payload — the projection this module's first caller
 *   renders:
 *     openapi.json
 *       .paths["/api/v1/assets/"].get.responses["200"]
 *        .content["application/json"].schema.properties.items.items
 *        .properties.deleteLock
 *     => { type: 'object',
 *          properties: { locked: boolean, reason: string,
 *                        lockedAt: string, lockedBy: string },
 *          required: ['locked', 'lockedAt'],
 *          additionalProperties: false }
 *     Source of truth: `deleteLockSchema`, src/routes/assets.ts:528-533, used at
 *     `assetSchema.deleteLock` :838 (`.optional()`); the TS type is `DeleteLock`,
 *     src/data/asset-repo.ts:441-446, on `Asset.deleteLock?` :470.
 *
 *   Lock object ABSENT from the canonical free-text search projection:
 *     openapi.json
 *       .paths["/api/v1/search/"].get.responses["200"]
 *        .content["application/json"].schema.properties.assets.items.properties
 *     => id, name, description, status, parentId, objectKey, statusHistory,
 *        technicalMetadata, technicalMetadataError, manifestUrls, packagingError,
 *        renditions, metadata, createdAt, updatedAt, type
 *        — there is NO `deleteLock` key.
 *     Source of truth: `assetSchema`, src/routes/search.ts:78-... (Fastify
 *     serializes the response against it, so the field cannot leak through).
 *
 * The four field names this module uses — `deleteLock`, `locked`, `lockedAt`,
 * `lockedBy` — all come from the rows above. `reason` is deliberately NOT read
 * here: it is free text up to 1024 characters and the spec keeps it off the list
 * (§3.3), so the list surface never has asset-controlled text to interpolate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * TWO TRAPS THIS DERIVATION CLOSES (spec §2, both verified in the repo)
 *
 *   1. Unlock leaves NO tombstone. `DELETE /api/v1/assets/{id}/lock` removes the
 *      field entirely — `applyDeleteLock` returns `deleteLock: undefined`
 *      (src/data/asset-repo.ts:1083-1086) — it does not write `locked: false`.
 *      So a check shaped `asset.deleteLock.locked === false` throws on an
 *      unlocked asset, and a check shaped `'deleteLock' in asset` reports a
 *      LOCKED asset after an unlock. Neither shape appears in this file.
 *   2. `locked` is a real boolean, not a marker. The schema permits
 *      `{ locked: false, lockedAt: … }`, so anything other than `true` is
 *      treated as unlocked and its lock metadata is not rendered.
 *
 * And the one it cannot close: a projection that does not carry the field at all
 * is UNKNOWN, never "unlocked". Absence of the field in a payload that HAS the
 * field means unlocked; absence of the field from the projection means the
 * client cannot know (spec §1 copy rule 3, §2 state L0, gap H1).
 */

// ─── State vocabulary (spec §2) ──────────────────────────────────────────────

/** L0 — the projection does not carry `deleteLock`; lock state is not knowable. */
export const LOCK_UNKNOWN = 'unknown';
/** L1 — the projection carries the field and the asset is not locked. */
export const LOCK_UNLOCKED = 'unlocked';
/** L2 — `deleteLock.locked === true`; archiving is refused until it is cleared. */
export const LOCK_LOCKED = 'locked';

/**
 * Derive the lock state of one asset object (spec §2).
 *
 * @param {object} asset  an asset as returned by whichever projection produced it
 * @param {{ projectionCarriesLock?: boolean }} [opts]
 *        `projectionCarriesLock` MUST be false for objects from a payload whose
 *        schema has no `deleteLock` property — today, the canonical search
 *        response (see CONTRACT GROUNDING above). It defaults to true because
 *        the asset list and asset detail projections both carry the field; the
 *        caller that opts out is the exception and states it explicitly.
 * @returns {'unknown'|'unlocked'|'locked'}
 */
export function lockStateOf(asset, opts) {
  const carries = !opts || opts.projectionCarriesLock !== false;
  if (!carries) return LOCK_UNKNOWN;
  if (asset && asset.deleteLock && asset.deleteLock.locked === true) return LOCK_LOCKED;
  return LOCK_UNLOCKED;
}

/** Convenience predicate for the render paths. Unknown is NOT locked. */
export function isAssetLocked(asset, opts) {
  return lockStateOf(asset, opts) === LOCK_LOCKED;
}

// ─── Copy deck (spec §7) ─────────────────────────────────────────────────────
//
// Exported so the sibling surfaces reuse the exact strings instead of retyping
// them. Sentence case, full stops on sentences, no product names.

export const LOCK_COPY = Object.freeze({
  /** `lock.badge` */
  badge: 'Locked',
  /** `lock.badge.title` */
  badgeTitle: 'Delete-locked. Archiving is refused until the lock is cleared.',
  /**
   * The `.visually-hidden` consequence clause appended inside the badge. A
   * `title` alone is not reliably exposed to assistive technology, and the word
   * "Locked" on its own does not say what the lock costs (spec §3.3, §8).
   */
  badgeSrSuffix: ': archiving is refused until the lock is cleared',
});

// ─── List markup (spec §3.2, §6) ─────────────────────────────────────────────
//
// Text and colour only. The UI has no icon set — `public/*.js` and `public/*.html`
// contain zero <svg>, no icon font and no emoji — and the spec (§6) is explicit
// that the lock must not be the feature that introduces one. The flag is the real
// word "Locked", so it is searchable, translatable and readable by assistive
// technology; the row accent added by the caller merely duplicates it and never
// carries meaning on its own (WCAG 1.4.1).

/**
 * The lock flag for one list row. Static markup by construction: every character
 * comes from module constants, so there is NO interpolation of asset-controlled
 * text on this path and nothing to escape. `deleteLock.reason` and
 * `deleteLock.lockedBy` are deliberately absent from the list (spec §3.3) — they
 * belong on the detail surface (#895), which escapes them there.
 *
 * Class `asset-lock-flag` is the hook the list uses to mirror the flag onto the
 * row accent, which is how the two can never disagree.
 *
 * @returns {string} an HTML string, in the cell-renderer convention used across
 *                   public/ (see public/ops-ui-table.js column `render`).
 */
export function lockBadgeHtml() {
  return (
    '<span class="badge badge-locked asset-lock-flag" title="' +
    LOCK_COPY.badgeTitle +
    '">' +
    LOCK_COPY.badge +
    '<span class="visually-hidden">' +
    LOCK_COPY.badgeSrSuffix +
    '</span></span>'
  );
}

/** Class applied to a locked row so the accent survives horizontal scrolling. */
export const ROW_LOCKED_CLASS = 'row-locked';
