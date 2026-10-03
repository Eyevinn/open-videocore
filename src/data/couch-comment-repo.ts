// CouchDB-backed asset-comment repository (issue #1046, feature from #135).
//
// Implements CommentRepository (src/data/comment-repo.ts:29) on top of
// StackCouch so review comments survive a process restart — the in-memory Map
// in InMemoryCommentRepository lost every comment on restart.
//
// Follows couch-pipeline-repo.ts / couch-collection-repo.ts exactly: documents
// carry a `resourceType` discriminator, are written under their flat local id
// (OSC provides structural tenant isolation per ADR-003, so there is no
// workspace partitioning and no workspaceId predicate), and reads filter on
// resourceType before mapping. The local id IS the ULID, as in
// couch-pipeline-repo.ts:41,54 — the published Comment contract defines `id` as
// a ULID (comment-repo.ts:18) and listByAsset's tie-break depends on it.
//
// No API or schema change: the persisted document maps 1:1 onto the published
// `{id, assetId, body, createdAt}` resource (openapi.json
// /api/v1/assets/{id}/comments 201 response).

import { monotonicFactory } from 'ulid';

import type { StoredDoc, StackCouch } from './couchdb.js';
import type { Comment, CommentRepository, CreateCommentInput } from './comment-repo.js';

const ulid = monotonicFactory();

const RESOURCE_TYPE = 'comment';

// StackCouch.find() defaults to limit 50 (src/data/couchdb.ts:66-76), which
// would silently truncate a busy asset's comment thread. listByAsset pages
// through with an explicit limit/skip instead, bounded so a pathological
// thread can never turn one GET into an unbounded scan.
const PAGE_SIZE = 500;
const MAX_PAGES = 20;

export type CouchFactory = () => StackCouch;

export class CouchCommentRepository implements CommentRepository {
  constructor(private readonly couchFor: CouchFactory) {}

  async create(input: CreateCommentInput): Promise<Comment> {
    const couch = this.couchFor();
    const id = ulid();
    const comment: Comment = {
      id,
      assetId: input.assetId,
      body: input.body,
      createdAt: new Date().toISOString()
    };
    await couch.put(id, toDoc(comment));
    return comment;
  }

  // Comments for an asset, oldest first. createdAt is the primary key; the ULID
  // id breaks ties for comments created within the same millisecond — the same
  // comparator InMemoryCommentRepository uses (comment-repo.ts:56), so ordering
  // is identical on either side of the persistence boundary.
  async listByAsset(assetId: string): Promise<Comment[]> {
    const couch = this.couchFor();
    const docs: StoredDoc[] = [];
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = await couch.find(
        { resourceType: RESOURCE_TYPE, assetId },
        { limit: PAGE_SIZE, skip: page * PAGE_SIZE }
      );
      docs.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return docs
      .filter((d) => d.resourceType === RESOURCE_TYPE)
      .map(fromDoc)
      .filter((c) => c.assetId === assetId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }
}

function toDoc(comment: Comment): Record<string, unknown> {
  return {
    resourceType: RESOURCE_TYPE,
    localId: comment.id,
    assetId: comment.assetId,
    body: comment.body,
    createdAt: comment.createdAt
  };
}

function fromDoc(doc: StoredDoc): Comment {
  return {
    id: String(doc['localId'] ?? stripPartition(doc._id)),
    assetId: String(doc['assetId'] ?? ''),
    body: String(doc['body'] ?? ''),
    createdAt: String(doc['createdAt'] ?? '')
  };
}

function stripPartition(id: string): string {
  const idx = id.indexOf(':');
  return idx >= 0 ? id.slice(idx + 1) : id;
}
