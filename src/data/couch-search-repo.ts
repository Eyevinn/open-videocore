// CouchDB-backed asset search (issue #10).
//
// Implements SearchRepository on top of WorkspaceCouch. Structured filters
// (mimeType, tags) are pushed down into a partitioned Mango query (/_find) so
// CouchDB does the work and never scans another workspace's partition. Free-text
// (`q`) is applied with the shared matchesQuery matcher over the candidate set:
// CouchDB's Lucene full-text index is optional and not guaranteed to be present
// on every deployment, so we degrade gracefully to substring matching rather
// than failing the request when no text index is available.

import { type Asset, MAX_LIMIT } from './asset-repo.js';
import { AssetDocumentSchema, fromAssetDocument } from './asset-document.js';
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
  // TAMS address lookup (issue #168, epic #116). The persisted document carries
  // the machine-derived addressing under the four-namespace `structural.tams`
  // block (asset-document.ts: structural.tams.flowIds[] / .timerange). Push both
  // down as dotted Mango selectors so CouchDB filters within the workspace
  // partition. `$elemMatch $eq` matches a single flow UUID against the flowIds
  // array (a source carries many flows, ADR-008, but a query addresses one flow
  // — ADR-010); the timerange is an exact-equality match. The in-process
  // matchesQuery pass re-checks both, so behaviour is identical across backends
  // and the projection stays disposable/replayable (derived only from the doc).
  if (query.tamsFlowId) {
    selector['structural.tams.flowIds'] = { $elemMatch: { $eq: query.tamsFlowId } };
  }
  if (query.tamsTimerange) {
    selector['structural.tams.timerange'] = { $eq: query.tamsTimerange };
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

// Rebuild the Asset from the persisted four-namespace document by parsing it
// through AssetDocumentSchema and delegating to fromAssetDocument — the same
// path couch-asset-repo.ts uses (issue #168). This populates every projected
// field (including the flat tamsFlowIds / tamsTimerange derived from the
// `structural.tams` block) from one authoritative mapping, so search and read
// stay in lockstep rather than maintaining a second, divergent projection.
function fromDoc(doc: StoredDoc): Asset {
  const localId = String(doc['localId'] ?? stripPartition(doc._id));
  const document = AssetDocumentSchema.parse({
    ...doc,
    _id: localId,
    type: 'asset',
    schemaVersion: 1
  });
  return fromAssetDocument(document);
}

function stripPartition(id: string): string {
  const idx = id.indexOf(':');
  return idx >= 0 ? id.slice(idx + 1) : id;
}
