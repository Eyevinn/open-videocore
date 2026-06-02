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
  page?: number;
  pageSize?: number;
}

export interface SearchResult {
  assets: Asset[];
  total: number;
  page: number;
}

export interface SearchRepository {
  search(workspaceId: string, query: SearchQuery): Promise<SearchResult>;
}

// Tags are stored as an optional, loosely-typed field on the asset document.
// They are not part of the core Asset lifecycle, so we read them defensively.
export function assetTags(asset: Asset): string[] {
  const tags = (asset as { tags?: unknown }).tags;
  return Array.isArray(tags) ? tags.filter((t): t is string => typeof t === 'string') : [];
}

// The MIME / container type used for the mimeType filter. We expose the
// extracted containerFormat (issue #6) so callers can filter by, e.g., "mp4".
export function assetMimeType(asset: Asset): string | undefined {
  return asset.technicalMetadata?.containerFormat;
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
  return true;
}
