// Archived-asset tombstone document (issue #326, part of the purge epic #323).
//
// When the retention sweep (a SEPARATE slice, #327) purges an `archived` asset,
// it REPLACES the CouchDB asset document in place with a tombstone: a small
// record that preserves provenance/lineage for audit and referential integrity
// but drops the heavy body (technical metadata, renditions, manifests, custom
// metadata, thumbnails). Consistent with ADR-005 the asset document is the
// aggregate root and is replaced doc-in-place (doc-replace), so the PostgreSQL
// search projection derived from the CouchDB `_changes` feed observes the
// replacement and drops the asset from the index.
//
// DISCRIMINATOR (marker) — issue constraint: NO new ASSET_STATUSES value is
// introduced. Documents in this codebase are already discriminated by the
// top-level `resourceType` mirror (couchdb.ts / couch-asset-repo.ts: every Mango
// selector is `{ resourceType: 'asset' }` and every read guards on
// `d.resourceType === 'asset'`). A tombstone therefore carries a DISTINCT
// `resourceType` value — `asset-tombstone` — plus a `purgedAt` timestamp. This
// choice means tombstones are excluded from BOTH query tiers with no query
// change: the Mango `list()`/`search()` selectors in couch-asset-repo.ts and the
// Mango `search()` selector in couch-search-repo.ts already pin
// `resourceType: 'asset'`, and the PG projection is fed from the same document
// shape. Read-by-id (`GET /:id`) detects the marker and returns 410 Gone.
//
// This slice defines the tombstone shape + the constructor only. The sweep loop
// (#327) that actually replaces documents and the restore endpoint (#328) are
// separate slices; they consume `toTombstoneDocument` / `ASSET_TOMBSTONE_TYPE`
// exported here rather than re-deriving the shape.

import { z } from 'zod';
import type { Asset, AssetSourceMethod, StatusTransition } from './asset-repo.js';

// The `resourceType` discriminator for a purged-asset tombstone. Distinct from
// the `'asset'` value (RESOURCE_TYPE in couch-asset-repo.ts / couch-search-repo.ts)
// so every existing `{ resourceType: 'asset' }` Mango selector and every
// `d.resourceType === 'asset'` read guard excludes tombstones automatically.
export const ASSET_TOMBSTONE_TYPE = 'asset-tombstone' as const;

// Cap on the retained statusHistory. The tombstone keeps a TRUNCATED tail of the
// lifecycle audit trail (the most recent transitions, which always include the
// `-> archived` step) rather than the full history, so the purge reclaims the
// bulk of the document while preserving the terminal context for audit.
export const TOMBSTONE_STATUS_HISTORY_LIMIT = 10;

// The persisted tombstone document body. Retains EXACTLY the fields the issue
// enumerates (slug, former parentId as `derivedFrom`, versionGroupId,
// versionOfAssetId, sourceMethod/originUri, createdAt, archivedAt) and ADDS
// `purgedAt`, plus the discriminator and a truncated statusHistory. No
// descriptive/technical/structural body is carried.
export const AssetTombstoneSchema = z.object({
  _id: z.string(), // the purged asset's local id (ULID) — reused so links resolve
  _rev: z.string().optional(), // CouchDB MVCC token (carried when replacing)
  resourceType: z.literal(ASSET_TOMBSTONE_TYPE),
  // Retained lineage / provenance (all optional: the source asset may lack any).
  slug: z.string().optional(),
  // Former parentId hierarchy link (persisted as `derivedFrom` on the live doc).
  derivedFrom: z.string().nullable().optional(),
  versionGroupId: z.string().nullable().optional(),
  versionOfAssetId: z.string().nullable().optional(),
  sourceMethod: z.string().optional(),
  originUri: z.string().optional(),
  // Original creation timestamp of the asset (ISO 8601).
  createdAt: z.string(),
  // When the asset entered the terminal `archived` state (ISO 8601). Derived
  // from the last `-> archived` transition in statusHistory; falls back to the
  // asset's updatedAt when no such transition is recorded.
  archivedAt: z.string(),
  // NEW: when the purge replaced the document with this tombstone (ISO 8601).
  purgedAt: z.string(),
  // Truncated tail of the lifecycle audit trail (see TOMBSTONE_STATUS_HISTORY_LIMIT).
  statusHistory: z
    .array(
      z.object({
        at: z.string(),
        from: z.string().nullable(),
        to: z.string()
      })
    )
    .default([])
});

export type AssetTombstone = z.infer<typeof AssetTombstoneSchema>;

// Derive the archived-at timestamp from an asset's statusHistory: the `at` of
// the most recent transition INTO `archived`. Falls back to `updatedAt` when the
// history carries no such transition (defensive — an archived asset should
// always have one, but a hand-forced record might not).
export function archivedAtOf(asset: Asset): string {
  const history: StatusTransition[] = asset.statusHistory ?? [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].to === 'archived') {
      return history[i].at;
    }
  }
  return asset.updatedAt;
}

// Build the tombstone document that REPLACES a purged asset's document. Retains
// exactly the enumerated lineage/provenance fields, derives `archivedAt`, and
// stamps `purgedAt` (defaults to now, injectable for deterministic tests). The
// caller (the sweep slice, #327) carries the live document's `_rev` so CouchDB
// accepts the in-place replacement; it is intentionally NOT set here so this
// function stays a pure value-builder.
export function toTombstoneDocument(
  asset: Asset,
  opts: { purgedAt?: string; statusHistoryLimit?: number } = {}
): AssetTombstone {
  const purgedAt = opts.purgedAt ?? new Date().toISOString();
  const limit = opts.statusHistoryLimit ?? TOMBSTONE_STATUS_HISTORY_LIMIT;
  const history = asset.statusHistory ?? [];
  const truncated = limit >= 0 ? history.slice(Math.max(0, history.length - limit)) : history;
  const tombstone: AssetTombstone = {
    _id: asset.id,
    resourceType: ASSET_TOMBSTONE_TYPE,
    slug: asset.slug,
    derivedFrom: asset.parentId ?? null,
    versionGroupId: asset.versionGroupId ?? null,
    versionOfAssetId: asset.versionOfAssetId ?? null,
    sourceMethod: asset.sourceMethod as AssetSourceMethod | undefined,
    originUri: asset.originUri,
    createdAt: asset.createdAt,
    archivedAt: archivedAtOf(asset),
    purgedAt,
    statusHistory: truncated.map((t) => ({ at: t.at, from: t.from, to: t.to }))
  };
  return tombstone;
}

// True when a raw stored CouchDB document is a purged-asset tombstone. Used by
// the read path (`GET /:id`) to distinguish a tombstone (-> 410 Gone) from a
// genuinely absent document (-> 404). Kept tolerant of `undefined` so callers
// can pass a raw `couch.get()` result straight through.
export function isTombstoneDoc(doc: { resourceType?: unknown } | undefined | null): boolean {
  return !!doc && doc.resourceType === ASSET_TOMBSTONE_TYPE;
}
