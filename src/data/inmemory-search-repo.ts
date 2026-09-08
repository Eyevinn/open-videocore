// In-memory asset + collection search (issue #10, #561).
//
// Filters the InMemoryAssetRepository for tests / local dev. Applies the same
// match semantics (matchesQuery) as the CouchDB fallback path, so behaviour is
// identical regardless of backend.
//
// Collection projection (issue #561): when a CollectionRepository is supplied,
// collections are projected into the search surface using the same shared
// matcher family (matchesCollectionQuery). Collection hits are returned in a
// separate `collections` array carrying a `type: 'collection'` discriminator so
// they are unambiguously distinct from asset hits. The projection is derived
// purely from collection documents, so it stays disposable/rebuildable.

import { MAX_LIMIT, type AssetRepository } from './asset-repo.js';
import type { CollectionRepository } from './collection-repo.js';
import {
  clampPage,
  clampPageSize,
  matchesCollectionQuery,
  matchesQuery,
  toCollectionHit,
  type CollectionHit,
  type SearchQuery,
  type SearchRepository,
  type SearchResult
} from './search-repo.js';

export class InMemorySearchRepository implements SearchRepository {
  constructor(
    private readonly assets: AssetRepository,
    // Optional so existing callers/tests that only search assets are unchanged.
    // When absent, no collection hits are produced (empty `collections`).
    private readonly collections?: CollectionRepository
  ) {}

  async search(query: SearchQuery): Promise<SearchResult> {
    const page = clampPage(query.page);
    const pageSize = clampPageSize(query.pageSize);
    const { items } = await this.assets.list({ limit: MAX_LIMIT });
    const matched = items.filter((a) => matchesQuery(a, query));
    const start = (page - 1) * pageSize;

    let collectionHits: CollectionHit[] = [];
    let collectionTotal = 0;
    if (this.collections) {
      const all = await this.collections.list();
      const matchedCollections = all
        .filter((c) => matchesCollectionQuery(c, query))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      collectionTotal = matchedCollections.length;
      collectionHits = matchedCollections.slice(start, start + pageSize).map(toCollectionHit);
    }

    return {
      assets: matched.slice(start, start + pageSize),
      collections: collectionHits,
      total: matched.length,
      collectionTotal,
      page
    };
  }
}
