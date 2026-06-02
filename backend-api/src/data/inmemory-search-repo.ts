// In-memory asset search (issue #10).
//
// Filters the InMemoryAssetRepository for tests / local dev. Applies the same
// match semantics (matchesQuery) as the CouchDB fallback path, so behaviour is
// identical regardless of backend.

import { MAX_LIMIT, type AssetRepository } from './asset-repo.js';
import {
  clampPage,
  clampPageSize,
  matchesQuery,
  type SearchQuery,
  type SearchRepository,
  type SearchResult
} from './search-repo.js';

export class InMemorySearchRepository implements SearchRepository {
  constructor(private readonly assets: AssetRepository) {}

  async search(workspaceId: string, query: SearchQuery): Promise<SearchResult> {
    const page = clampPage(query.page);
    const pageSize = clampPageSize(query.pageSize);
    const { items } = await this.assets.list(workspaceId, { limit: MAX_LIMIT });
    const matched = items.filter((a) => matchesQuery(a, query));
    const start = (page - 1) * pageSize;
    return {
      assets: matched.slice(start, start + pageSize),
      total: matched.length,
      page
    };
  }
}
