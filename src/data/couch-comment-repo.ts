// CouchDB-backed asset-comment repository (issue #1046, feature from #135).
//
// Implements CommentRepository (src/data/comment-repo.ts:29) on top of
// StackCouch so review comments survive a process restart — the in-memory Map
// in InMemoryCommentRepository lost every comment on restart.
//
// Follows couch-pipeline-repo.ts / couch-collection-repo.ts exactly: documents
// carry a `resourceType` discriminator, there is no workspace partitioning and
// no workspaceId predicate (OSC provides structural tenant isolation per
// ADR-003), and reads filter on resourceType before mapping. The document id is
// the ULID under a `comment-` prefix, the same namespacing
// couch-profile-repo.ts:26-28 uses, so a comment document can never collide with
// another resource's flat id in the shared database. The PUBLISHED id stays the
// bare ULID (carried on `localId`): the Comment contract defines `id` as a ULID
// (comment-repo.ts:18) and listByAsset's tie-break depends on its lexical order.
//
// No API or schema change: the persisted document maps 1:1 onto the published
// `{id, assetId, body, createdAt}` resource (openapi.json
// /api/v1/assets/{id}/comments 201 response).

import { monotonicFactory } from 'ulid';

import type { StoredDoc, StackCouch } from './couchdb.js';
import type { Comment, CommentRepository, CreateCommentInput } from './comment-repo.js';

const ulid = monotonicFactory();

const RESOURCE_TYPE = 'comment';

// Document-id namespace (see the header note). Only ever applied to `_id`; the
// published `id` is the bare ULID stored on `localId`.
const DOC_ID_PREFIX = 'comment-';

function docId(id: string): string {
  return `${DOC_ID_PREFIX}${id}`;
}

// StackCouch.find() defaults to limit 50 (src/data/couchdb.ts:66-76), which
// would silently truncate a busy asset's comment thread. listByAsset pages
// through with an explicit limit/skip instead, bounded so a pathological
// thread can never turn one GET into an unbounded scan.
const PAGE_SIZE = 500;
const MAX_PAGES = 20;

export type CouchFactory = () => StackCouch;

// Minimal logger surface, structurally satisfied by Fastify's logger. Optional:
// used only to make the page-cap truncation below observable instead of
// silently returning a short thread.
export type CommentRepoLogger = {
  warn: (obj: unknown, msg?: string) => void;
};

export class CouchCommentRepository implements CommentRepository {
  constructor(
    private readonly couchFor: CouchFactory,
    private readonly log?: CommentRepoLogger
  ) {}

  async create(input: CreateCommentInput): Promise<Comment> {
    const couch = this.couchFor();
    const id = ulid();
    const comment: Comment = {
      id,
      assetId: input.assetId,
      body: input.body,
      createdAt: new Date().toISOString()
    };
    await couch.put(docId(id), toDoc(comment));
    return comment;
  }

  // Comments for an asset, oldest first. createdAt is the primary key; the ULID
  // id breaks ties for comments created within the same millisecond — the same
  // comparator InMemoryCommentRepository uses (comment-repo.ts:56), so ordering
  // is identical on either side of the persistence boundary.
  async listByAsset(assetId: string): Promise<Comment[]> {
    const couch = this.couchFor();
    const docs: StoredDoc[] = [];
    // `complete` stays false only if the last allowed page came back FULL, i.e.
    // there may be further comments we did not read. A truncated thread is
    // indistinguishable from a short one in the response, so say so in the log
    // rather than returning a silently partial list.
    let complete = false;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const batch = await couch.find(
        { resourceType: RESOURCE_TYPE, assetId },
        { limit: PAGE_SIZE, skip: page * PAGE_SIZE }
      );
      docs.push(...batch);
      if (batch.length < PAGE_SIZE) {
        complete = true;
        break;
      }
    }
    if (!complete) {
      this.log?.warn(
        { assetId, returned: docs.length, pageSize: PAGE_SIZE, maxPages: MAX_PAGES },
        'comment thread hit the page cap: this asset has more comments than one ' +
          'listByAsset read returns, so the response is TRUNCATED (oldest comments only)'
      );
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
    // `localId` is written by toDoc on every document this repository creates, so
    // it is the normal source of the published ULID. The `_id` fallback only
    // covers a document written by something other than toDoc; it strips the
    // DOC_ID_PREFIX because `_id` is namespaced and the published id is not.
    id: String(doc['localId'] ?? stripDocIdPrefix(doc._id)),
    assetId: String(doc['assetId'] ?? ''),
    body: String(doc['body'] ?? ''),
    createdAt: String(doc['createdAt'] ?? '')
  };
}

function stripDocIdPrefix(id: string): string {
  return id.startsWith(DOC_ID_PREFIX) ? id.slice(DOC_ID_PREFIX.length) : id;
}
