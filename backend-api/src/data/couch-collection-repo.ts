// CouchDB-backed collection repository (issue #11).
//
// Implements CollectionRepository on top of WorkspaceCouch, reusing the same
// workspace partition + ownership re-check as the asset and webhook
// repositories. Collections are stored as documents with resourceType
// 'collection' inside the caller's partition, so an id from another workspace
// resolves to undefined (existence is not leaked) and is never read or mutated
// cross-workspace.

import type { StoredDoc, WorkspaceCouch } from './couchdb.js';
import {
  CollectionNotFoundError,
  addAssetId,
  removeAssetId,
  type Collection,
  type CollectionRepository,
  type CreateCollectionInput
} from './collection-repo.js';

const RESOURCE_TYPE = 'collection';

export type CouchFactory = (workspaceId: string) => WorkspaceCouch;

export class CouchCollectionRepository implements CollectionRepository {
  constructor(private readonly couchFor: CouchFactory) {}

  async create(workspaceId: string, input: CreateCollectionInput): Promise<Collection> {
    const couch = this.couchFor(workspaceId);
    const now = new Date().toISOString();
    const localId = `collection-${cryptoId()}`;
    const collection: Collection = {
      id: localId,
      workspaceId,
      name: input.name,
      assetIds: [],
      createdAt: now,
      updatedAt: now
    };
    await couch.put(localId, toDoc(collection));
    return collection;
  }

  async list(workspaceId: string): Promise<Collection[]> {
    const couch = this.couchFor(workspaceId);
    const docs = await couch.find({ resourceType: RESOURCE_TYPE }, { limit: 1000 });
    return docs
      .filter((d) => d.resourceType === RESOURCE_TYPE)
      .map(fromDoc)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async get(workspaceId: string, id: string): Promise<Collection | undefined> {
    const couch = this.couchFor(workspaceId);
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return undefined;
    }
    return fromDoc(doc);
  }

  async addAsset(workspaceId: string, id: string, assetId: string): Promise<Collection> {
    return this.mutate(workspaceId, id, (c) => addAssetId(c.assetIds, assetId));
  }

  async removeAsset(workspaceId: string, id: string, assetId: string): Promise<Collection> {
    return this.mutate(workspaceId, id, (c) => removeAssetId(c.assetIds, assetId));
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    const couch = this.couchFor(workspaceId);
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return;
    }
    await couch.remove(id);
  }

  private async mutate(
    workspaceId: string,
    id: string,
    next: (c: Collection) => string[]
  ): Promise<Collection> {
    const couch = this.couchFor(workspaceId);
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
    updatedAt: collection.updatedAt
  };
}

function fromDoc(doc: StoredDoc): Collection {
  return {
    id: String(doc['localId'] ?? stripPartition(doc._id)),
    workspaceId: doc.workspaceId,
    name: String(doc['name'] ?? ''),
    assetIds: (doc['assetIds'] as string[] | undefined) ?? [],
    createdAt: String(doc['createdAt'] ?? ''),
    updatedAt: String(doc['updatedAt'] ?? '')
  };
}

function stripPartition(id: string): string {
  const idx = id.indexOf(':');
  return idx >= 0 ? id.slice(idx + 1) : id;
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
