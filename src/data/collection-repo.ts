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

export interface CollectionRepository {
  create(input: CreateCollectionInput): Promise<Collection>;
  list(): Promise<Collection[]>;
  get(id: string): Promise<Collection | undefined>;
  addAsset(id: string, assetId: string): Promise<Collection>;
  removeAsset(id: string, assetId: string): Promise<Collection>;
  delete(id: string): Promise<void>;
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
