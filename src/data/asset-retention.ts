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

import type { Asset } from './asset-repo.js';
import { archivedAtOf } from './asset-tombstone.js';

// The projected window served on the asset read contract.
export type AssetRetentionWindow = {
  // When the asset entered `archived` (ISO 8601) — archivedAtOf(asset).
  archivedAt: string;
  // Earliest instant the purge sweep may replace this asset with a tombstone
  // (ISO 8601), or `null` when it will never be purged: either retention is
  // disabled (retentionMs === 0) or `archivedAt` is unparseable, which the sweep
  // also refuses to purge on.
  purgeAfter: string | null;
  // The effective instance-global window at read time, in ms. 0 = never purge.
  retentionMs: number;
};

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

// `archivedAt + retentionMs`, the inverse of the sweep's eligibility test
// (`archivedAtMs > cutoff` where `cutoff = now - retentionMs`,
// archived-asset-purge-sweep.ts:128,146-150). `null` when retention is disabled,
// and `null` when the stamp cannot be parsed — the sweep refuses to purge on an
// unparseable stamp (:147-150), so claiming a purge instant would be a lie.
function purgeAfterOf(archivedAt: string, effectiveMs: number): string | null {
  if (effectiveMs <= 0) {
    return null;
  }
  const archivedAtMs = Date.parse(archivedAt);
  if (Number.isNaN(archivedAtMs)) {
    return null;
  }
  return new Date(archivedAtMs + effectiveMs).toISOString();
}
