// Comment repository (asset comments — issue #135).
//
// A Comment is a free-text note attached to a single asset. This first
// iteration stores a plain text body only; frame-accurate / time-based
// comments are a later iteration.
//
// This mirrors the in-memory pattern in src/data/pipeline-repo.ts: records are
// keyed by ULID (monotonic, so lexical id order matches insertion order),
// stored in an in-memory Map, and returned as defensive clones. Only an
// in-memory implementation is provided for this iteration — the interface is
// kept clean so a CouchDB-backed impl (see src/data/couch-*.ts) could follow.

import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

export type Comment = {
  id: string; // ULID
  assetId: string;
  body: string; // free-text
  createdAt: string; // ISO 8601
};

export type CreateCommentInput = {
  assetId: string;
  body: string;
};

export interface CommentRepository {
  create(input: CreateCommentInput): Promise<Comment>;
  // Comments for an asset in stable chronological order (oldest -> newest).
  listByAsset(assetId: string): Promise<Comment[]>;
}

export class InMemoryCommentRepository implements CommentRepository {
  private readonly store = new Map<string, Comment>();

  async create(input: CreateCommentInput): Promise<Comment> {
    const id = ulid();
    const comment: Comment = {
      id,
      assetId: input.assetId,
      body: input.body,
      createdAt: new Date().toISOString()
    };
    this.store.set(id, comment);
    return { ...comment };
  }

  async listByAsset(assetId: string): Promise<Comment[]> {
    return [...this.store.values()]
      .filter((c) => c.assetId === assetId)
      // Oldest first. createdAt is the primary key; the ULID id breaks ties for
      // comments created within the same millisecond (monotonic factory keeps
      // insertion order).
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((c) => ({ ...c }));
  }
}
