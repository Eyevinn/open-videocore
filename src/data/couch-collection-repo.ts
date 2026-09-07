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
  removeAssetId,
  type Collection,
  type CollectionRepository,
  type CreateCollectionInput
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
      // Descriptive metadata (issue #559). Optional/additive — omitted keys stay
      // undefined so a collection created with just { name } is unchanged.
      description: input.description,
      tags: input.tags,
      custom: input.custom,
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
  const doc: Record<string, unknown> = {
    resourceType: RESOURCE_TYPE,
    localId: collection.id,
    name: collection.name,
    assetIds: collection.assetIds,
    createdAt: collection.createdAt,
    updatedAt: collection.updatedAt
  };
  // Descriptive metadata (issue #559), mirroring the asset `descriptive`
  // namespace (ADR-005 typed-core + open-`custom`). Only persisted when set so
  // collections created without them round-trip with the fields absent
  // (back-compat) — no on-disk shape change for legacy documents.
  if (collection.description !== undefined) {
    doc['description'] = collection.description;
  }
  if (collection.tags !== undefined) {
    doc['tags'] = collection.tags;
  }
  if (collection.custom !== undefined) {
    doc['custom'] = collection.custom;
  }
  return doc;
}

function fromDoc(doc: StoredDoc): Collection {
  const collection: Collection = {
    id: String(doc['localId'] ?? stripPartition(doc._id)),
    name: String(doc['name'] ?? ''),
    assetIds: (doc['assetIds'] as string[] | undefined) ?? [],
    createdAt: String(doc['createdAt'] ?? ''),
    updatedAt: String(doc['updatedAt'] ?? '')
  };
  // Descriptive metadata (issue #559). Absent fields map back to undefined so
  // pre-#559 documents stay clean (fields simply not present on the resource).
  if (doc['description'] !== undefined) {
    collection.description = String(doc['description']);
  }
  if (doc['tags'] !== undefined) {
    collection.tags = doc['tags'] as string[];
  }
  if (doc['custom'] !== undefined) {
    collection.custom = doc['custom'] as Record<string, unknown>;
  }
  return collection;
}

function stripPartition(id: string): string {
  const idx = id.indexOf(':');
  return idx >= 0 ? id.slice(idx + 1) : id;
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
