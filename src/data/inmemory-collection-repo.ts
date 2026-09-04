// In-memory collection repository (issue #11).
//
// Local dev / test backend. Applies the SAME workspace namespacing and
// ownership guards as the CouchDB layer so behaviour is identical regardless of
// backend: collections are keyed by `<workspaceId>:<localId>` and reads/lists
// are confined to the caller's workspace.

// ADR-003/#59: workspace guard removed (structural OSC isolation).
import {
  CollectionNotFoundError,
  addAssetId,
  applyCollectionDeleteLock,
  removeAssetId,
  type Collection,
  type CollectionRepository,
  type CreateCollectionInput,
  type SetDeleteLockInput
} from './collection-repo.js';

export class InMemoryCollectionRepository implements CollectionRepository {
  private readonly store = new Map<string, Collection>();
  private counter = 0;

  async create(input: CreateCollectionInput): Promise<Collection> {
    const now = new Date().toISOString();
    const localId = `collection-${++this.counter}`;
    const collection: Collection = {
      id: localId,
      name: input.name,
      assetIds: [],
      createdAt: now,
      updatedAt: now
    };
    this.store.set(localId, collection);
    return { ...collection, assetIds: [...collection.assetIds] };
  }

  async list(): Promise<Collection[]> {
    return [...this.store.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((c) => ({ ...c, assetIds: [...c.assetIds] }));
  }

  async get(id: string): Promise<Collection | undefined> {
    const collection = this.store.get(id);
    if (!collection) {
      return undefined;
    }
    return { ...collection, assetIds: [...collection.assetIds] };
  }

  async addAsset(id: string, assetId: string): Promise<Collection> {
    return this.mutate(id, (c) => addAssetId(c.assetIds, assetId));
  }

  async removeAsset(id: string, assetId: string): Promise<Collection> {
    return this.mutate(id, (c) => removeAssetId(c.assetIds, assetId));
  }

  // Dedicated delete-lock write path (ADR-020 decision 3, issue #568). Separate
  // from addAsset/removeAsset so the top-level `deleteLock` flag is only ever
  // set/cleared here. Throws CollectionNotFoundError (-> 404) for an unknown id.
  async setDeleteLock(id: string, input: SetDeleteLockInput): Promise<Collection> {
    const existing = this.store.get(id);
    if (!existing) {
      throw new CollectionNotFoundError(id);
    }
    const now = new Date().toISOString();
    const updated: Collection = {
      ...existing,
      deleteLock: applyCollectionDeleteLock(input, now),
      updatedAt: now
    };
    this.store.set(id, updated);
    return { ...updated, assetIds: [...updated.assetIds] };
  }

  async delete(id: string): Promise<void> {
    this.store.delete(id);
  }

  private async mutate(
    id: string,
    next: (c: Collection) => string[]
  ): Promise<Collection> {
    const key = id;
    const existing = this.store.get(key);
    if (!existing) {
      throw new CollectionNotFoundError(id);
    }
    const updated: Collection = {
      ...existing,
      assetIds: next(existing),
      updatedAt: new Date().toISOString()
    };
    this.store.set(key, updated);
    return { ...updated, assetIds: [...updated.assetIds] };
  }
}
