// CouchDB-backed asset repository (issue #3).
//
// Implements AssetRepository on top of WorkspaceCouch, which enforces the
// workspace partition and ownership re-check. This class adds the asset
// lifecycle state machine, the append-only statusHistory audit trail, and the
// parent/child rules on top of that storage layer.
//
// DELETE STRATEGY — SOFT DELETE (default):
//   DELETE /api/v1/assets/:id transitions the asset to `status = archived`
//   rather than destroying the CouchDB document or removing the MinIO payload.
//   Rationale:
//     - Renditions (children) may still reference a source asset; hard-deleting
//       the document would orphan them and lose the audit trail.
//     - MinIO payloads can be large and may be referenced by packaged outputs;
//       reclaiming storage is a separate lifecycle concern (retention policy /
//       garbage collection), not an interactive API call.
//     - Soft delete keeps the statusHistory intact for compliance/audit.
//   A future hard-delete (purge document + remove MinIO objects via
//   WorkspaceStorage.removeObject) is intentionally NOT wired here; see the
//   open questions in the issue report and the OSC friction log.

import {
  type Asset,
  type AssetRepository,
  type AssetStatus,
  type CreateAssetInput,
  type ListOptions,
  type ListResult,
  type UpdateAssetInput,
  applyStatus,
  clampLimit,
  initialHistory,
  MAX_LIMIT,
  ParentNotFoundError
} from './asset-repo.js';
import type { StoredDoc, WorkspaceCouch } from './couchdb.js';

const RESOURCE_TYPE = 'asset';

// A factory so the repo can build a WorkspaceCouch bound to the caller's
// workspace for each request, reusing one shared CouchDB connection (nano
// ServerScope). This keeps the repo stateless w.r.t. workspace identity.
export type CouchFactory = (workspaceId: string) => WorkspaceCouch;

export class CouchAssetRepository implements AssetRepository {
  constructor(private readonly couchFor: CouchFactory) {}

  async create(workspaceId: string, input: CreateAssetInput): Promise<Asset> {
    const couch = this.couchFor(workspaceId);
    if (input.parentId) {
      const parent = await couch.get(input.parentId);
      if (!parent || parent.resourceType !== RESOURCE_TYPE) {
        throw new ParentNotFoundError(input.parentId);
      }
    }
    const now = new Date().toISOString();
    const localId = `asset-${cryptoId()}`;
    const asset: Asset = {
      id: localId,
      workspaceId,
      name: input.name,
      description: input.description,
      status: 'uploading',
      parentId: input.parentId,
      objectKey: input.objectKey,
      statusHistory: initialHistory(now),
      createdAt: now,
      updatedAt: now
    };
    await couch.put(localId, toDoc(asset));
    return asset;
  }

  async get(workspaceId: string, id: string): Promise<Asset | undefined> {
    const couch = this.couchFor(workspaceId);
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return undefined;
    }
    return fromDoc(doc);
  }

  async list(workspaceId: string, opts: ListOptions = {}): Promise<ListResult> {
    const couch = this.couchFor(workspaceId);
    const limit = clampLimit(opts.limit);
    const offset = Math.max(0, opts.offset ?? 0);
    const selector = buildSelector(opts);
    const [docs, total] = await Promise.all([
      couch.find(selector, { limit, skip: offset }),
      couch.count(selector)
    ]);
    const items = docs
      .filter((d) => d.resourceType === RESOURCE_TYPE)
      .map(fromDoc)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { items, limit, offset, total };
  }

  async search(workspaceId: string, query: string): Promise<Asset[]> {
    // Substring match over name/description via Mango regex, scoped to the
    // workspace partition. Full-text search proper is delegated to the
    // PostgreSQL index in a later issue; this keeps parity with the in-memory
    // repo for now.
    const couch = this.couchFor(workspaceId);
    const docs = await couch.find({ resourceType: RESOURCE_TYPE }, { limit: MAX_LIMIT });
    const q = query.toLowerCase();
    return docs
      .map(fromDoc)
      .filter(
        (a) =>
          a.name.toLowerCase().includes(q) ||
          (a.description?.toLowerCase().includes(q) ?? false)
      );
  }

  async update(
    workspaceId: string,
    id: string,
    patch: UpdateAssetInput
  ): Promise<Asset | undefined> {
    const couch = this.couchFor(workspaceId);
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return undefined;
    }
    const existing = fromDoc(doc);
    const now = new Date().toISOString();
    const next: Asset = { ...existing, updatedAt: now };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.objectKey !== undefined) next.objectKey = patch.objectKey;
    if (patch.technicalMetadata !== undefined) {
      next.technicalMetadata = patch.technicalMetadata;
      if (patch.technicalMetadata !== null) {
        next.technicalMetadataError = undefined;
      }
    }
    if (patch.technicalMetadataError !== undefined) {
      next.technicalMetadataError = patch.technicalMetadataError;
    }
    if (patch.status !== undefined) {
      const applied = applyStatus(existing.status, patch.status, existing.statusHistory, now);
      next.status = applied.status;
      next.statusHistory = applied.statusHistory;
    }
    // Carry _rev so CouchDB accepts the update; put() forces the partition.
    await couch.put(id, { ...toDoc(next), _rev: doc._rev });
    return next;
  }

  async countChildren(workspaceId: string, id: string): Promise<number> {
    const couch = this.couchFor(workspaceId);
    return couch.count({ resourceType: RESOURCE_TYPE, parentId: id });
  }

  async remove(workspaceId: string, id: string): Promise<Asset | undefined> {
    // Soft delete (see file header): archive rather than destroy.
    return this.update(workspaceId, id, { status: 'archived' });
  }
}

function buildSelector(opts: ListOptions): Record<string, unknown> {
  const selector: Record<string, unknown> = { resourceType: RESOURCE_TYPE };
  if (opts.status) {
    selector['status'] = opts.status as AssetStatus;
  }
  if (opts.parentId !== undefined) {
    selector['parentId'] = opts.parentId;
  }
  return selector;
}

// Map an Asset to the persisted document body (excluding CouchDB-managed
// fields _id/_rev/workspaceId which WorkspaceCouch.put owns).
function toDoc(asset: Asset): Record<string, unknown> {
  return {
    resourceType: RESOURCE_TYPE,
    localId: asset.id,
    name: asset.name,
    description: asset.description,
    status: asset.status,
    parentId: asset.parentId,
    objectKey: asset.objectKey,
    statusHistory: asset.statusHistory,
    technicalMetadata: asset.technicalMetadata ?? null,
    technicalMetadataError: asset.technicalMetadataError,
    createdAt: asset.createdAt,
    updatedAt: asset.updatedAt
  };
}

function fromDoc(doc: StoredDoc): Asset {
  return {
    id: String(doc['localId'] ?? stripPartition(doc._id)),
    workspaceId: doc.workspaceId,
    name: String(doc['name'] ?? ''),
    description: doc['description'] as string | undefined,
    status: doc['status'] as AssetStatus,
    parentId: doc['parentId'] as string | undefined,
    objectKey: doc['objectKey'] as string | undefined,
    statusHistory: (doc['statusHistory'] as Asset['statusHistory']) ?? [],
    technicalMetadata: (doc['technicalMetadata'] as Asset['technicalMetadata']) ?? null,
    technicalMetadataError: doc['technicalMetadataError'] as string | undefined,
    createdAt: String(doc['createdAt'] ?? ''),
    updatedAt: String(doc['updatedAt'] ?? '')
  };
}

// `<workspaceId>:<localId>` -> `<localId>`.
function stripPartition(id: string): string {
  const idx = id.indexOf(':');
  return idx >= 0 ? id.slice(idx + 1) : id;
}

// Short, collision-resistant local id without pulling in a dependency.
function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
