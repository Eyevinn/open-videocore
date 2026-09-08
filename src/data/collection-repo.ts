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
  // Descriptive metadata (issue #559), mirroring the asset `descriptive`
  // namespace (ADR-005: typed-core + open-`custom`) at a smaller scale. All
  // three are OPTIONAL and additive: a collection created without them behaves
  // exactly as before, and documents written before #559 (fields absent) still
  // round-trip. `description` is a free-form string, `tags` a first-class string
  // label list, and `custom` an open key/value bag (`Record<string, unknown>`).
  description?: string;
  tags?: string[];
  custom?: Record<string, unknown>;
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
  // Optional descriptive metadata accepted at create time (issue #559). Mirrors
  // the asset `descriptive` namespace fields; all optional so create({ name })
  // stays valid and unchanged.
  description?: string;
  tags?: string[];
  custom?: Record<string, unknown>;
};

// Partial editorial update of a collection's descriptive metadata (issue #560).
// PATCH semantics: only the keys PRESENT here are written; an ABSENT key leaves
// the current value untouched. Membership (`assetIds`) is deliberately NOT part
// of this shape — it stays on the dedicated PUT/DELETE /:id/assets/:assetId
// endpoints — nor are `name`, `deleteLock`, or timestamps, which have their own
// paths. `description`, `tags`, and `custom` are each replaced WHOLESALE when
// present (mirroring the asset editorial PATCH for `tags`/`description`, which
// replace rather than merge — see UpdateAssetInput in asset-repo.ts). To clear a
// field, pass an explicit empty value (`''`, `[]`, or `{}`); omit the key to
// leave it unchanged.
export type UpdateCollectionInput = {
  description?: string;
  tags?: string[];
  custom?: Record<string, unknown>;
};

// Pure computation of a descriptive-metadata PATCH (issue #560). Given the
// current collection and a partial patch, produce the next collection with only
// the present keys applied (wholesale per field) and `updatedAt` bumped. No side
// effects, so it is safe to re-run inside the CouchDB conflict-retry loop
// (updateWithRetry) exactly as the asset editorial write does. Never touches
// `assetIds`, `name`, or `deleteLock`.
export function applyCollectionUpdate(
  existing: Collection,
  patch: UpdateCollectionInput,
  now: string
): Collection {
  const next: Collection = { ...existing, updatedAt: now };
  if (patch.description !== undefined) {
    next.description = patch.description;
  }
  if (patch.tags !== undefined) {
    next.tags = patch.tags;
  }
  if (patch.custom !== undefined) {
    next.custom = patch.custom;
  }
  return next;
}

export interface CollectionRepository {
  create(input: CreateCollectionInput): Promise<Collection>;
  list(): Promise<Collection[]>;
  get(id: string): Promise<Collection | undefined>;
  // Partial editorial update of descriptive metadata (issue #560). Applies the
  // present keys of `patch` (description/tags/custom) wholesale and returns the
  // updated collection. Throws CollectionNotFoundError (-> 404) for an
  // unknown/foreign id. Deliberately CANNOT mutate membership (`assetIds`) — that
  // stays on addAsset/removeAsset — nor the delete-lock (setDeleteLock).
  update(id: string, patch: UpdateCollectionInput): Promise<Collection>;
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
