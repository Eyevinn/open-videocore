// Asset search repository (issue #10).
//
// Abstracts full-text + metadata search behind a workspace-scoped interface,
// mirroring the AssetRepository split: an in-memory implementation for tests /
// local dev (filters the InMemoryAssetRepository) and a CouchDB implementation
// using Mango queries (see couch-search-repo.ts). Both apply the workspace
// partition so a query can only ever reach the caller's own assets.

import type { Asset } from './asset-repo.js';

export const DEFAULT_PAGE_SIZE = 20;
export const MAX_PAGE_SIZE = 100;

export interface SearchQuery {
  // Free-text query matched against name/description (case-insensitive).
  q?: string;
  // Asset tags; an asset matches when it carries all requested tags.
  tags?: string[];
  // Container/MIME type, matched against the extracted containerFormat.
  mimeType?: string;
  // Free-form metadata filter (issue #12). An asset matches when, for every
  // key/value pair given here, its `metadata` carries that exact value
  // (strict equality on top-level keys).
  metadata?: Record<string, unknown>;
  // TAMS addressing lookup (issue #168, sub-task of the #116 TAMS bridge epic).
  // These project the machine-derived TAMS fields (asset.tamsFlowIds /
  // asset.tamsTimerange, ADR-005 `structural.tams`) into the search index so an
  // asset can be found by its TAMS address. `tamsFlowId` matches when the asset
  // carries that flow UUID among its `tamsFlowIds`; `tamsTimerange` is an exact
  // (canonical-string) match against `asset.tamsTimerange`. Sibling issue #175
  // consumes these on the assets API. Both are pure derivations of the asset
  // record, so re-projection is idempotent (no state added).
  tamsFlowId?: string;
  tamsTimerange?: string;
  page?: number;
  pageSize?: number;
}

export interface SearchResult {
  assets: Asset[];
  total: number;
  page: number;
}

export interface SearchRepository {
  search(query: SearchQuery): Promise<SearchResult>;
}

// Tags are stored as an optional, loosely-typed field on the asset document.
// They are not part of the core Asset lifecycle, so we read them defensively.
export function assetTags(asset: Asset): string[] {
  const tags = asset.tags;
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
}

// The MIME / container type used for the mimeType filter. We expose the
// extracted containerFormat (issue #6) so callers can filter by, e.g., "mp4".
export function assetMimeType(asset: Asset): string | undefined {
  return asset.technicalMetadata?.containerFormat;
}

// TAMS flow ids projected for lookup (issue #168). Read defensively: the field
// is optional/additive (assets written before #165 lack it entirely), and only
// string UUIDs are kept so a malformed legacy value cannot break projection.
export function assetTamsFlowIds(asset: Asset): string[] {
  const ids = asset.tamsFlowIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}

// TAMS timerange projected for lookup (issue #168). Optional/additive; absent on
// pre-#165 assets. Returned verbatim so the exact canonical TAI string is what
// #175's lookup compares against.
export function assetTamsTimerange(asset: Asset): string | undefined {
  return typeof asset.tamsTimerange === 'string' ? asset.tamsTimerange : undefined;
}

export function clampPage(page?: number): number {
  if (page === undefined || Number.isNaN(page)) {
    return 1;
  }
  return Math.max(1, Math.floor(page));
}

export function clampPageSize(pageSize?: number): number {
  if (pageSize === undefined || Number.isNaN(pageSize)) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
}

// Shared in-memory matcher used by the in-memory repo and as the CouchDB
// fallback when the text index is unavailable. Keeps match semantics identical
// across backends.
export function matchesQuery(asset: Asset, query: SearchQuery): boolean {
  if (query.q) {
    const q = query.q.toLowerCase();
    const inName = asset.name.toLowerCase().includes(q);
    const inDescription = asset.description?.toLowerCase().includes(q) ?? false;
    if (!inName && !inDescription) {
      return false;
    }
  }
  if (query.tags && query.tags.length > 0) {
    const tags = assetTags(asset);
    if (!query.tags.every((t) => tags.includes(t))) {
      return false;
    }
  }
  if (query.mimeType) {
    if (assetMimeType(asset) !== query.mimeType) {
      return false;
    }
  }
  if (query.metadata) {
    const md = asset.metadata ?? {};
    for (const [key, value] of Object.entries(query.metadata)) {
      if (md[key] !== value) {
        return false;
      }
    }
  }
  // TAMS addressing lookup (issue #168). An asset matches when it carries the
  // requested flow UUID among its projected flow ids, and/or its timerange
  // equals the requested canonical string exactly. Pure over the asset, so the
  // predicate is idempotent under re-projection from sequence 0.
  if (query.tamsFlowId) {
    if (!assetTamsFlowIds(asset).includes(query.tamsFlowId)) {
      return false;
    }
  }
  if (query.tamsTimerange) {
    if (assetTamsTimerange(asset) !== query.tamsTimerange) {
      return false;
    }
  }
  return true;
}
