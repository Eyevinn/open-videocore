// Collection repository (issue #11).
//
// A collection is a workspace-scoped, named group of asset ids. It lets a user
// organise assets into ad-hoc sets (playlists, projects, review queues, …)
// without changing the assets themselves. Membership is stored as a flat,
// deduplicated list of asset ids; an id may belong to many collections.
//
// Two implementations are provided and share identical workspace namespacing
// and ownership semantics (mirroring the asset/webhook repos):
//   - InMemoryCollectionRepository (inmemory-collection-repo.ts): local / tests.
//   - CouchCollectionRepository (couch-collection-repo.ts): production, backed
//     by WorkspaceCouch (partitioned, ownership-aware) per ADR-001.
//
// NOTE: collections store asset ids only; they do not validate that each id
// refers to a live asset, and they are not cascade-updated when an asset is
// archived. The collections GET route resolves the live assets at read time and
// silently drops any id that no longer resolves in the workspace.

// Explicit delete-lock (ADR-020 decision 3, issue #568). Collections have NO
// namespace model — the document is flat — so the lock is a top-level optional
// field that mirrors the asset sub-shape (administrative.deleteLock) for
// cross-mechanism consistency. Reused from the asset repo so the two shapes
// cannot drift. Field names/types match ADR-020 exactly: locked, reason?,
// lockedAt, lockedBy?.
export type { DeleteLock, SetDeleteLockInput } from './asset-repo.js';
import type { DeleteLock, SetDeleteLockInput } from './asset-repo.js';

export type Collection = {
  id: string;
  name: string;
  assetIds: string[];
  createdAt: string;
  updatedAt: string;
  // Explicit delete-lock (ADR-020 decision 3, issue #568). Absent = unlocked.
  // When present with `locked: true` the collection is delete-protected: DELETE
  // /:id is hard-blocked with 409 `delete_protected` and `?force=true` does NOT
  // override it. Set/cleared ONLY via the dedicated system path (PUT/DELETE
  // /:id/lock), never a general edit. Its `lockedAt`/`lockedBy` are the
  // traceable administrative record of the change (collections carry no separate
  // provenance array — ADR-020 pins the lock's own fields as that record).
  deleteLock?: DeleteLock;
};

export type CreateCollectionInput = {
  name: string;
};

export interface CollectionRepository {
  create(input: CreateCollectionInput): Promise<Collection>;
  list(): Promise<Collection[]>;
  get(id: string): Promise<Collection | undefined>;
  addAsset(id: string, assetId: string): Promise<Collection>;
  removeAsset(id: string, assetId: string): Promise<Collection>;
  // Set or clear the explicit delete-lock (ADR-020 decision 3, issue #568). This
  // is the DEDICATED system write path for the top-level `deleteLock` flag —
  // separate from `addAsset`/`removeAsset` and any general edit — so the lock
  // cannot be set/cleared through ordinary collection mutations. `input.locked`
  // true = protect, false = clear. Throws CollectionNotFoundError (-> 404) for
  // an unknown/foreign collection id.
  setDeleteLock(id: string, input: SetDeleteLockInput): Promise<Collection>;
  delete(id: string): Promise<void>;
}

// Raised when deleting a collection blocked by an explicit delete-lock (ADR-020
// issue #568) -> 409. The route maps this to the shared `delete_blocked`
// envelope with reason `delete_protected` and empty blockedBy arrays.
// `?force=true` does NOT override it (ADR-020 decision 2).
export class CollectionDeleteProtectedError extends Error {
  readonly statusCode = 409;
  constructor(id: string) {
    super(`collection ${id} is protected from deletion by an explicit lock`);
    this.name = 'CollectionDeleteProtectedError';
  }
}

// Pure computation of the collection delete-lock write (ADR-020 decision 3,
// issue #568). Given the current collection and the lock input, produce the next
// `deleteLock` value. locked=true -> a fresh lock { locked, reason?, lockedAt:
// now, lockedBy? }; locked=false -> undefined (cleared). No side effects.
export function applyCollectionDeleteLock(
  input: SetDeleteLockInput,
  now: string
): DeleteLock | undefined {
  if (input.locked) {
    return { locked: true, reason: input.reason, lockedAt: now, lockedBy: input.lockedBy };
  }
  return undefined;
}

// Raised when a collection id does not exist in the caller's workspace and the
// operation requires it to (addAsset/removeAsset) -> 404. A foreign id is
// indistinguishable from a miss so existence is not leaked across workspaces.
export class CollectionNotFoundError extends Error {
  readonly statusCode = 404;
  constructor(id: string) {
    super(`collection not found: ${id}`);
    this.name = 'CollectionNotFoundError';
  }
}

// Append an asset id to a membership list, deduplicating (order preserved).
export function addAssetId(assetIds: readonly string[], assetId: string): string[] {
  return assetIds.includes(assetId) ? [...assetIds] : [...assetIds, assetId];
}

// Remove an asset id from a membership list. Removing an absent id is a no-op.
export function removeAssetId(assetIds: readonly string[], assetId: string): string[] {
  return assetIds.filter((id) => id !== assetId);
}
