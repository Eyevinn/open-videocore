// CouchDB-backed asset search (issue #10).
//
// Implements SearchRepository on top of WorkspaceCouch. Structured filters
// (mimeType, tags) are pushed down into a partitioned Mango query (/_find) so
// CouchDB does the work and never scans another workspace's partition. Free-text
// (`q`) is applied with the shared matchesQuery matcher over the candidate set:
// CouchDB's Lucene full-text index is optional and not guaranteed to be present
// on every deployment, so we degrade gracefully to substring matching rather
// than failing the request when no text index is available.

import { type Asset, type AssetStatus, MAX_LIMIT } from './asset-repo.js';
import type { StoredDoc, StackCouch } from './couchdb.js';
import {
  clampPage,
  clampPageSize,
  matchesQuery,
  type SearchQuery,
  type SearchRepository,
  type SearchResult
} from './search-repo.js';

const RESOURCE_TYPE = 'asset';

export type CouchFactory = () => StackCouch;

export class CouchSearchRepository implements SearchRepository {
  constructor(private readonly couchFor: CouchFactory) {}

  async search(query: SearchQuery): Promise<SearchResult> {
    const couch = this.couchFor();
    const page = clampPage(query.page);
    const pageSize = clampPageSize(query.pageSize);

    // Push structured filters into Mango; free-text is applied in-process.
    const selector = buildSelector(query);
    const docs = await couch.find(selector, { limit: MAX_LIMIT });
    const matched = docs
      .filter((d) => d.resourceType === RESOURCE_TYPE)
      .map(fromDoc)
      .filter((a) => matchesQuery(a, query))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));

    const start = (page - 1) * pageSize;
    return {
      assets: matched.slice(start, start + pageSize),
      total: matched.length,
      page
    };
  }
}

function buildSelector(query: SearchQuery): Record<string, unknown> {
  const selector: Record<string, unknown> = { resourceType: RESOURCE_TYPE };
  if (query.mimeType) {
    selector['technicalMetadata'] = { containerFormat: query.mimeType };
  }
  if (query.tags && query.tags.length > 0) {
    selector['tags'] = { $all: query.tags };
  }
  // TAMS addressing lookup (issue #168). Push the flow-id membership and the
  // exact timerange match down into Mango so CouchDB filters within the
  // workspace partition. `$elemMatch` on tamsFlowIds finds the requested UUID
  // among the projected array; timerange is an exact string match. Field names
  // mirror the flat projected doc shape read by fromDoc (asset.tamsFlowIds /
  // asset.tamsTimerange).
  if (query.tamsFlowId) {
    selector['tamsFlowIds'] = { $elemMatch: { $eq: query.tamsFlowId } };
  }
  if (query.tamsTimerange) {
    selector['tamsTimerange'] = { $eq: query.tamsTimerange };
  }
  // Metadata filters push down as `metadata.<key>: { $eq: value }` so CouchDB
  // matches exact top-level metadata values within the workspace partition
  // (issue #12). Dotted keys address nested document fields in Mango.
  if (query.metadata) {
    for (const [key, value] of Object.entries(query.metadata)) {
      selector[`metadata.${key}`] = { $eq: value };
    }
  }
  return selector;
}

function fromDoc(doc: StoredDoc): Asset {
  return {
    id: String(doc['localId'] ?? stripPartition(doc._id)),
    name: String(doc['name'] ?? ''),
    description: doc['description'] as string | undefined,
    status: doc['status'] as AssetStatus,
    parentId: doc['parentId'] as string | undefined,
    objectKey: doc['objectKey'] as string | undefined,
    statusHistory: (doc['statusHistory'] as Asset['statusHistory']) ?? [],
    technicalMetadata: (doc['technicalMetadata'] as Asset['technicalMetadata']) ?? null,
    technicalMetadataError: doc['technicalMetadataError'] as string | undefined,
    manifestUrls: (doc['manifestUrls'] as Asset['manifestUrls']) ?? undefined,
    packagingError: doc['packagingError'] as string | undefined,
    renditions: (doc['renditions'] as Asset['renditions']) ?? undefined,
    metadata: (doc['metadata'] as Asset['metadata']) ?? undefined,
    // TAMS addressing (issue #168). Projected verbatim from the stored doc so an
    // asset can be looked up by its TAMS address; absent on pre-#165 assets.
    tamsFlowIds: (doc['tamsFlowIds'] as string[] | undefined) ?? undefined,
    tamsTimerange: (doc['tamsTimerange'] as string | undefined) ?? undefined,
    createdAt: String(doc['createdAt'] ?? ''),
    updatedAt: String(doc['updatedAt'] ?? '')
  };
}

function stripPartition(id: string): string {
  const idx = id.indexOf(':');
  return idx >= 0 ? id.slice(idx + 1) : id;
}
