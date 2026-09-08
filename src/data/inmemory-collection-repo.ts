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
  applyCollectionUpdate,
  removeAssetId,
  type Collection,
  type CollectionRepository,
  type CreateCollectionInput,
  type SetDeleteLockInput,
  type UpdateCollectionInput
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
      // Descriptive metadata (issue #559). Optional/additive — omitted keys stay
      // undefined so a collection created with just { name } is unchanged.
      description: input.description,
      tags: input.tags,
      custom: input.custom,
      createdAt: now,
      updatedAt: now
    };
    this.store.set(localId, collection);
    return copy(collection);
  }

  async list(): Promise<Collection[]> {
    return [...this.store.values()]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(copy);
  }

  async get(id: string): Promise<Collection | undefined> {
    const collection = this.store.get(id);
    if (!collection) {
      return undefined;
    }
    return copy(collection);
  }

  // Partial editorial update of descriptive metadata (issue #560). Applies only
  // the present keys of `patch` (description/tags/custom) wholesale, leaving
  // membership, name, and the delete-lock untouched.
  async update(id: string, patch: UpdateCollectionInput): Promise<Collection> {
    const existing = this.store.get(id);
    if (!existing) {
      throw new CollectionNotFoundError(id);
    }
    const updated = applyCollectionUpdate(existing, patch, new Date().toISOString());
    this.store.set(id, updated);
    return copy(updated);
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
    return copy(updated);
  }
}

// Return a defensive copy of a stored collection so callers never mutate the
// backing store in place. Arrays and the open `custom` bag (issue #559) are
// shallow-copied alongside `assetIds`, matching the existing copy discipline.
function copy(c: Collection): Collection {
  return {
    ...c,
    assetIds: [...c.assetIds],
    tags: c.tags ? [...c.tags] : undefined,
    custom: c.custom ? { ...c.custom } : undefined
  };
}
