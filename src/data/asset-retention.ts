// Per-asset retention window, derived for the asset READ contract (issue #1034).
//
// The instance-global retention policy lives in ONE place —
// `GET/PATCH /api/v1/retention/config` (`retentionMs`, src/routes/retention.ts)
// — and the archived-asset purge sweep is the ONE thing that acts on it. This
// module adds no policy and no second source of truth: it only PROJECTS the
// existing policy onto one asset so a read can answer "when is this archived
// asset eligible to be purged?" without the client re-implementing the sweep's
// arithmetic in a browser.
//
// Both inputs are reused, never re-derived:
//   - `archivedAt` is `archivedAtOf(asset)` (src/data/asset-tombstone.ts:87-95),
//     the SAME function the sweep uses for its eligibility test
//     (src/pipeline/archived-asset-purge-sweep.ts:146) and the same value the
//     post-purge tombstone records (asset-tombstone.ts:121).
//   - `retentionMs` is the caller-supplied effective window, read at request
//     time from the live instance global that PATCH /api/v1/retention/config
//     hot-swaps, so a read never reports a stale deadline.
//
// `purgeAfter` is the EARLIEST POSSIBLE purge time, not a guaranteed one. The
// sweep is timer-driven (DEFAULT_PURGE_INTERVAL_MS, 1 hour,
// src/pipeline/archived-asset-purge-loop.ts:31) and defers any parent that still
// has live children (archived-asset-purge-sweep.ts:155-172), so an asset usually
// stays restorable PAST this instant. Nothing here may be presented as a hard
// deadline.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - `Asset.status` / `Asset.statusHistory`: src/data/asset-repo.ts:474,484
//     (`status: AssetStatus`), ASSET_STATUSES incl. 'archived' at :29-30.
//   - `archivedAtOf(asset): string`: src/data/asset-tombstone.ts:87-95.
//   - Disabled-window semantics (`<= 0` => never purge): the sweep's early
//     return, src/pipeline/archived-asset-purge-sweep.ts:124-126, which cites
//     RETENTION_DISABLED_MS (src/routes/retention.ts:36).
//   - Unparseable-stamp refusal: archived-asset-purge-sweep.ts:146-150.

import { z } from 'zod';
import type { Asset } from './asset-repo.js';
import { archivedAtOf } from './asset-tombstone.js';

// The ONE wire contract for the projected window, declared here next to the
// projection that produces it so every surface that serializes an asset shares
// a single schema instead of re-declaring the shape. Imported by
// src/routes/assets.ts (GET /assets/:id, list, versions, the deprecated
// /assets/search alias, every mutation echo) and src/routes/search.ts
// (GET /api/v1/search/, which serves archived assets via `?status=archived`),
// so the deprecated alias and its successor-version endpoint cannot drift.
export const AssetRetentionWindowSchema = z
  .object({
    // When the asset entered `archived` (ISO 8601) — archivedAtOf(asset).
    archivedAt: z
      .string()
      .describe(
        'When the asset entered `archived` (ISO 8601): the `at` of the most ' +
          'recent `-> archived` transition in `statusHistory`, falling back to ' +
          '`updatedAt` when no such transition is recorded. Identical to the ' +
          'value the retention purge sweep measures the window from.'
      ),
    // Earliest instant the purge sweep may replace this asset with a tombstone
    // (ISO 8601), or `null` when it will never be purged: retention is disabled
    // (retentionMs === 0), `archivedAt` is unparseable (which the sweep also
    // refuses to purge on), or `archivedAt + retentionMs` falls outside the
    // representable Date range (see purgeAfterOf).
    purgeAfter: z
      .string()
      .nullable()
      .describe(
        'EARLIEST POSSIBLE purge time (ISO 8601) — `archivedAt + retentionMs` ' +
          '— NOT a guaranteed deadline: the purge sweep is timer-driven ' +
          '(default 1 hour, ARCHIVE_PURGE_INTERVAL_MS) and defers any asset ' +
          'that still has live child assets, so the asset commonly stays ' +
          'restorable past this instant. Reaching it does NOT mean the next ' +
          'restore returns 410. `null` means the asset will never be purged: ' +
          'either retention is disabled (`retentionMs` 0) or `archivedAt` ' +
          'cannot be parsed, which the sweep also refuses to purge on.'
      ),
    // The effective instance-global window at read time, in ms. 0 = never purge.
    retentionMs: z
      .number()
      .int()
      .min(0)
      .describe(
        'The effective instance-global archived-asset retention window in ' +
          'milliseconds at read time (the same value GET /api/v1/retention/' +
          'config reports). 0 means retention is disabled — never purge.'
      )
  })
  .describe(
    'Retention window for an archived asset (issue #1034). Present only while ' +
      '`status` is `archived`; absent on every other asset.'
  );

// The projected window served on the asset read contract. Derived from the
// schema above so the type and the published shape are one definition.
export type AssetRetentionWindow = z.infer<typeof AssetRetentionWindowSchema>;

// Project the retention policy onto one asset.
//
// Returns `undefined` for any asset that is NOT `archived`: the window only
// exists while an asset is in the terminal state the sweep scans
// (`list({ status: 'archived' })`, archived-asset-purge-sweep.ts:200-204), so a
// live asset carries no retention member at all rather than a meaningless one.
export function assetRetentionWindow(
  asset: Asset,
  retentionMs: number
): AssetRetentionWindow | undefined {
  if (asset.status !== 'archived') {
    return undefined;
  }

  // Same derivation as the sweep and the tombstone — not a parallel one.
  const archivedAt = archivedAtOf(asset);

  // Mirror the sweep's disabled check exactly: unset/non-finite/<= 0 all mean
  // "never purge" (archived-asset-purge-sweep.ts:124-126).
  const effectiveMs =
    Number.isFinite(retentionMs) && retentionMs > 0 ? Math.trunc(retentionMs) : 0;

  return {
    archivedAt,
    purgeAfter: purgeAfterOf(archivedAt, effectiveMs),
    retentionMs: effectiveMs
  };
}

// The widest instant a JS `Date` can represent: ±8,640,000,000,000,000 ms from
// the epoch (ECMA-262 "Time Values and Time Range"). A `Date` outside it is the
// invalid date, and `toISOString()` on it throws `RangeError: Invalid time value`.
const MAX_TIME_VALUE_MS = 8.64e15;

// `archivedAt + retentionMs`, the inverse of the sweep's eligibility test
// (`archivedAtMs > cutoff` where `cutoff = now - retentionMs`,
// archived-asset-purge-sweep.ts:128,146-150). `null` when retention is disabled,
// and `null` when the stamp cannot be parsed — the sweep refuses to purge on an
// unparseable stamp (:147-150), so claiming a purge instant would be a lie.
//
// TOTAL by construction: it must never throw. `withRetentionWindow`
// (src/routes/assets.ts:2036, src/routes/search.ts:289) calls this on every
// response that serializes an archived asset, so a throw here would turn the
// asset read, list, versions, search and every mutation echo into a 500 for any
// archived asset.
//
// Both inputs to the sum are now bounded, but neither bound makes the overflow
// check redundant:
//   - `effectiveMs` is the live instance-global window, which cannot exceed
//     MAX_RETENTION_MS (100 years): PATCH /api/v1/retention/config rejects a
//     larger `retentionMs` at the schema (src/routes/retention.ts
//     retentionConfigSchema) and `archiveRetentionMsFromEnv` clamps the boot
//     value. That is ~2,700x smaller than the ±8.64e15 ms Date range.
//   - `archivedAtMs`, however, is only required to PARSE. A stored stamp near
//     the end of representable time (e.g. a hand-written or imported
//     `+275760-09-13` date) parses fine and still overflows when the window is
//     added, and this module must not depend on a stamp-range invariant it does
//     not own.
// Out of range is therefore reported as `null`, reusing the SAME "never purged"
// semantics already used for a disabled window and an unparseable stamp: a
// window that ends beyond the end of representable time is a window the sweep
// can never act on.
function purgeAfterOf(archivedAt: string, effectiveMs: number): string | null {
  if (effectiveMs <= 0) {
    return null;
  }
  const archivedAtMs = Date.parse(archivedAt);
  if (Number.isNaN(archivedAtMs)) {
    return null;
  }
  const purgeAfterMs = archivedAtMs + effectiveMs;
  if (!Number.isFinite(purgeAfterMs) || Math.abs(purgeAfterMs) > MAX_TIME_VALUE_MS) {
    return null;
  }
  return new Date(purgeAfterMs).toISOString();
}
