// Asset search repository (issue #10).
//
// Abstracts full-text + metadata search behind a workspace-scoped interface,
// mirroring the AssetRepository split: an in-memory implementation for tests /
// local dev (filters the InMemoryAssetRepository) and a CouchDB implementation
// using Mango queries (see couch-search-repo.ts). Both apply the workspace
// partition so a query can only ever reach the caller's own assets.

import type { Asset } from './asset-repo.js';
import type { Collection } from './collection-repo.js';

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
  // TAMS address lookup (issue #168, TAMS bridge epic #116). The index projects
  // the asset's machine-derived TAMS addressing (structural.tams, asset-
  // document.ts) so an asset can be looked up by its TAMS address. Both are
  // single-valued QUERY fields, matching the ADR-010 query contract:
  //   - tamsFlowId: a SINGLE flow UUID; an asset matches when this id is a
  //     MEMBER of its tamsFlowIds[] set (a source carries many flows, ADR-008,
  //     but a query addresses one flow at a time — ADR-010).
  //   - tamsTimerange: the canonical TAI timerange string, matched by EQUALITY.
  // The match is derived purely from the asset document, so the index stays
  // disposable/replayable: it can be rebuilt from asset state with no side
  // channel (issue #168 acceptance criterion).
  tamsFlowId?: string;
  tamsTimerange?: string;
  page?: number;
  pageSize?: number;
}

// A collection projected into the search surface (issue #561). Mirrors the
// asset-hit shape but carries only the descriptive projection (name +
// description/tags/custom from issue #559) — collections have no technical or
// TAMS metadata. The projection is derived purely from the collection document,
// so it stays disposable/rebuildable from the document store exactly like the
// asset projection (couch-search-repo.ts): there is no side-channel state.
export interface CollectionHit {
  // Discriminator so collection hits are unambiguously distinguishable from
  // asset hits in the combined response (issue #561 acceptance criterion).
  type: 'collection';
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  custom?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface SearchResult {
  assets: Asset[];
  // Collection hits, surfaced distinctly from asset hits (issue #561). Present
  // as an empty array when nothing matches, so the field is always shaped the
  // same way regardless of backend or query.
  collections: CollectionHit[];
  total: number;
  page: number;
  // Count of matching COLLECTIONS (issue #561). `total` continues to count
  // matching ASSETS so the pre-existing asset pagination contract is unchanged;
  // collection paging is reported separately here.
  collectionTotal: number;
}

export interface SearchRepository {
  search(query: SearchQuery): Promise<SearchResult>;
}

// Project a stored collection into a search hit (issue #561). Pure and derived
// only from the collection document, so the collection projection is disposable
// and rebuildable from the document store — the same property the asset
// projection guarantees (couch-search-repo.ts fromDoc). The `type` discriminator
// is stamped here so every collection hit is distinguishable from an asset hit.
export function toCollectionHit(collection: Collection): CollectionHit {
  return {
    type: 'collection',
    id: collection.id,
    name: collection.name,
    description: collection.description,
    tags: collection.tags,
    custom: collection.custom,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt
  };
}

// Collection tags (issue #559/#561). Read defensively — `tags` is optional and
// additive on the Collection type (collection-repo.ts), mirroring assetTags().
export function collectionTags(collection: Collection): string[] {
  const tags = collection.tags;
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
}

// Match a collection against the shared SearchQuery (issue #561), mirroring
// matchesQuery() for assets so collection and asset search rules stay in
// lockstep:
//   - `q` matches case-insensitively over the collection name and description.
//   - `tags` requires ALL requested tags (AND semantics), like assets.
//   - `metadata.<key>=<value>` matches against the open `custom` bag (issue #559
//     ADR-005 typed-core + open-`custom`), the collection analogue of the asset
//     `descriptive.custom` -> `asset.metadata` projection.
//   - Asset-only filters (mimeType, tamsFlowId, tamsTimerange) can never match a
//     collection (collections carry no technical/TAMS metadata), so any of those
//     being set excludes all collections — a query that addresses assets by
//     container/TAMS is not asking for collections.
export function matchesCollectionQuery(collection: Collection, query: SearchQuery): boolean {
  if (query.mimeType || query.tamsFlowId || query.tamsTimerange) {
    return false;
  }
  if (query.q) {
    const q = query.q.toLowerCase();
    const inName = collection.name.toLowerCase().includes(q);
    const inDescription = collection.description?.toLowerCase().includes(q) ?? false;
    if (!inName && !inDescription) {
      return false;
    }
  }
  if (query.tags && query.tags.length > 0) {
    const tags = collectionTags(collection);
    if (!query.tags.every((t) => tags.includes(t))) {
      return false;
    }
  }
  if (query.metadata) {
    const custom = collection.custom ?? {};
    for (const [key, value] of Object.entries(query.metadata)) {
      if (custom[key] !== value) {
        return false;
      }
    }
  }
  return true;
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

// TAMS flow ids projected onto the asset for address lookup (issue #168). Read
// defensively — the field is optional/additive (present only on assets bridged
// into a TAMS, epic #116) and predates by no schema bump (asset-repo.ts).
export function assetTamsFlowIds(asset: Asset): string[] {
  const ids = asset.tamsFlowIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
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
  // TAMS address lookup (issue #168). A query addresses one flow by a single
  // UUID; the asset matches when that id is a MEMBER of its projected flow set.
  if (query.tamsFlowId) {
    if (!assetTamsFlowIds(asset).includes(query.tamsFlowId)) {
      return false;
    }
  }
  // Canonical timerange is matched by exact equality (ADR-010).
  if (query.tamsTimerange) {
    if (asset.tamsTimerange !== query.tamsTimerange) {
      return false;
    }
  }
  return true;
}
