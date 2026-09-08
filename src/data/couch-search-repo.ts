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

const RESOURCE_TYPE = 'asset';

export type CouchFactory = () => StackCouch;

export class CouchSearchRepository implements SearchRepository {
  constructor(
    private readonly couchFor: CouchFactory,
    // Collection projection source (issue #561). Optional so existing callers
    // that only search assets are unchanged; when absent no collection hits are
    // produced. Injected as the CollectionRepository (not re-implemented here)
    // so collections are reconstructed by the SAME authoritative mapping
    // couch-collection-repo.ts uses — the search and read projections cannot
    // drift, and the projection stays disposable/rebuildable from the document
    // store (couch-collection-repo.list()).
    private readonly collections?: CollectionRepository
  ) {}

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

    // Collection projection (issue #561). Reuse the collection repo's list()
    // (a Mango query over resourceType: 'collection'), then apply the shared
    // matchesCollectionQuery in-process — mirroring how the asset path filters
    // the reconstructed Asset with matchesQuery. This keeps the collection
    // projection derived purely from collection documents (rebuildable) and its
    // match rules in lockstep with the in-memory backend.
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

function buildSelector(query: SearchQuery): Record<string, unknown> {
  const selector: Record<string, unknown> = { resourceType: RESOURCE_TYPE };
  // NOTE (issue #345): `mimeType`, `tags`, and free-text `q` are NOT pushed down
  // as Mango selectors. The persisted four-namespace document (ADR-005,
  // asset-document.ts) stores these under `descriptive.tags` and
  // `technical.container` — there is NO top-level `tags` / `technicalMetadata`
  // mirror — so a top-level `{ tags: { $all } }` / `{ technicalMetadata: {...} }`
  // selector matched zero documents and the endpoint returned empty for every
  // tag / mimeType query (and any query combined with one). Instead we fetch the
  // workspace-partitioned asset set and let the shared in-process `matchesQuery`
  // filter on the RECONSTRUCTED Asset (fromDoc -> fromAssetDocument reads the
  // `descriptive` namespace), which is exactly how couch-asset-repo.search()
  // already resolves name/description — keeping the two search endpoints in
  // lockstep and the projection replayable from asset state alone.
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
  // Operator metadata (issue #12) is NOT pushed down either: it is persisted
  // under `descriptive.custom.<key>` (asset-document.ts -> fromAssetDocument maps
  // it to `asset.metadata`), so a top-level `metadata.<key>` selector matched
  // zero documents (same root cause as tags/mimeType, issue #345). The shared
  // `matchesQuery` re-checks `asset.metadata` in-process on the reconstructed
  // Asset, so metadata filtering stays correct without the broken push-down.
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
