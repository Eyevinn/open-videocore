// CouchDB-backed collection repository (issue #11).
//
// Implements CollectionRepository on top of WorkspaceCouch, reusing the same
// workspace partition + ownership re-check as the asset and webhook
// repositories. Collections are stored as documents with resourceType
// 'collection' inside the caller's partition, so an id from another workspace
// resolves to undefined (existence is not leaked) and is never read or mutated
// cross-workspace.

import type { StoredDoc, StackCouch } from './couchdb.js';
import {
  CollectionNotFoundError,
  addAssetId,
  applyCollectionDeleteLock,
  removeAssetId,
  type Collection,
  type CollectionRepository,
  type CreateCollectionInput,
  type DeleteLock,
  type SetDeleteLockInput
} from './collection-repo.js';

const RESOURCE_TYPE = 'collection';

export type CouchFactory = () => StackCouch;

export class CouchCollectionRepository implements CollectionRepository {
  constructor(private readonly couchFor: CouchFactory) {}

  async create(input: CreateCollectionInput): Promise<Collection> {
    const couch = this.couchFor();
    const now = new Date().toISOString();
    const localId = `collection-${cryptoId()}`;
    const collection: Collection = {
      id: localId,
      name: input.name,
      assetIds: [],
      createdAt: now,
      updatedAt: now
    };
    await couch.put(localId, toDoc(collection));
    return collection;
  }

  async list(): Promise<Collection[]> {
    const couch = this.couchFor();
    const docs = await couch.find({ resourceType: RESOURCE_TYPE }, { limit: 1000 });
    return docs
      .filter((d) => d.resourceType === RESOURCE_TYPE)
      .map(fromDoc)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<Collection | undefined> {
    const couch = this.couchFor();
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return undefined;
    }
    return fromDoc(doc);
  }

  async addAsset(id: string, assetId: string): Promise<Collection> {
    return this.mutate(id, (c) => addAssetId(c.assetIds, assetId));
  }

  async removeAsset(id: string, assetId: string): Promise<Collection> {
    return this.mutate(id, (c) => removeAssetId(c.assetIds, assetId));
  }

  // Dedicated delete-lock write path (ADR-020 decision 3, issue #568). Distinct
  // from addAsset/removeAsset so the top-level `deleteLock` flag can only be
  // set/cleared here. Reuses the same read-modify-write + _rev carry as mutate().
  async setDeleteLock(id: string, input: SetDeleteLockInput): Promise<Collection> {
    const couch = this.couchFor();
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      throw new CollectionNotFoundError(id);
    }
    const existing = fromDoc(doc);
    const now = new Date().toISOString();
    const updated: Collection = {
      ...existing,
      deleteLock: applyCollectionDeleteLock(input, now),
      updatedAt: now
    };
    await couch.put(id, { ...toDoc(updated), _rev: doc._rev });
    return updated;
  }

  async delete(id: string): Promise<void> {
    const couch = this.couchFor();
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return;
    }
    await couch.remove(id);
  }

  private async mutate(
    id: string,
    next: (c: Collection) => string[]
  ): Promise<Collection> {
    const couch = this.couchFor();
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      throw new CollectionNotFoundError(id);
    }
    const existing = fromDoc(doc);
    const updated: Collection = {
      ...existing,
      assetIds: next(existing),
      updatedAt: new Date().toISOString()
    };
    // Carry _rev so CouchDB accepts the update; put() forces the partition.
    await couch.put(id, { ...toDoc(updated), _rev: doc._rev });
    return updated;
  }
}

function toDoc(collection: Collection): Record<string, unknown> {
  return {
    resourceType: RESOURCE_TYPE,
    localId: collection.id,
    name: collection.name,
    assetIds: collection.assetIds,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt,
    // Explicit delete-lock (ADR-020 decision 3, issue #568). Only persisted when
    // present, so pre-#568 collections round-trip with the field absent.
    ...(collection.deleteLock ? { deleteLock: collection.deleteLock } : {})
  };
}

function fromDoc(doc: StoredDoc): Collection {
  // Explicit delete-lock (ADR-020 decision 3, issue #568). Absent maps to
  // undefined so pre-#568 collections read as unlocked.
  const deleteLock = doc['deleteLock'] as DeleteLock | undefined;
  return {
    id: String(doc['localId'] ?? stripPartition(doc._id)),
    name: String(doc['name'] ?? ''),
    assetIds: (doc['assetIds'] as string[] | undefined) ?? [],
    createdAt: String(doc['createdAt'] ?? ''),
    updatedAt: String(doc['updatedAt'] ?? ''),
    ...(deleteLock ? { deleteLock } : {})
  };
}

function stripPartition(id: string): string {
  const idx = id.indexOf(':');
  return idx >= 0 ? id.slice(idx + 1) : id;
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
