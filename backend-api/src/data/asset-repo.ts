// Asset repository.
//
// Abstracts asset persistence behind a workspace-scoped interface. Two
// implementations are provided:
//   - InMemoryAssetRepository: local dev / tests. Applies the SAME workspace
//     namespacing, ownership guards, state machine, and parent/child rules as
//     the CouchDB layer so behaviour is identical regardless of backend.
//   - CouchAssetRepository (see couch-asset-repo.ts): production, backed by
//     WorkspaceCouch (partitioned, ownership-aware) per ADR-001.
//
// This module also owns the asset lifecycle state machine and the audit trail
// so both backends share one definition (issue #3).

import { assertOwned, assertValidWorkspaceId, namespacedId } from './guard.js';

// ---------------------------------------------------------------------------
// Asset model + lifecycle
// ---------------------------------------------------------------------------

// Lifecycle states. An asset is created in `uploading` (payload not yet in
// MinIO), advances to `processing` once a transcode/analysis job is running,
// `ready` when it can be served, and `archived` as a terminal soft-deleted /
// retired state.
// `failed` is a non-terminal error state for an asset whose ingest could not
// complete (issue #5 URL-pull). From `failed` a caller may retry (back to
// `uploading`/`processing`) or archive it.
export const ASSET_STATUSES = ['uploading', 'processing', 'ready', 'failed', 'archived'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

// Allowed forward transitions. Anything not listed is rejected with 422.
// `archived` is terminal. We allow `ready -> processing` so a ready asset can
// be re-processed (e.g. a new rendition pass) before going back to ready.
const ALLOWED_TRANSITIONS: Record<AssetStatus, readonly AssetStatus[]> = {
  uploading: ['processing', 'failed', 'archived'],
  processing: ['ready', 'failed', 'archived'],
  ready: ['processing', 'archived'],
  failed: ['uploading', 'processing', 'archived'],
  archived: []
};

export function isValidTransition(from: AssetStatus, to: AssetStatus): boolean {
  if (from === to) {
    return true; // idempotent no-op transitions are allowed
  }
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export type StatusTransition = {
  at: string; // ISO timestamp
  from: AssetStatus | null; // null for the initial creation entry
  to: AssetStatus;
};

// One audio track within a container, as reported by ffprobe (issue #6). A
// container can carry multiple audio tracks (e.g. multi-language), so this is
// surfaced as an array on TechnicalMetadata.
export type AudioTrack = {
  index: number;
  codec: string;
  channels: number;
  sampleRateHz: number;
};

// Technical metadata extracted from the stored object by an ephemeral ffprobe
// job (issue #6). Populated asynchronously after ingest; null until the first
// successful extraction (or after a failed extraction — see
// `technicalMetadataError`).
export type TechnicalMetadata = {
  codec: string;
  width: number;
  height: number;
  durationSeconds: number;
  bitrateBps: number;
  containerFormat: string;
  audioTracks: AudioTrack[];
  extractedAt: string; // ISO timestamp of when extraction completed
};

// Streaming manifest URLs produced by the HLS/DASH packaging pipeline (issue
// #9). Populated asynchronously after transcoding completes and the
// eyevinn-encore-packager finishes packaging. Both are MinIO-hosted manifest
// URLs (CMAF: HLS and DASH share the same underlying media segments). Either
// field may be absent if only one format was produced; `packagingError`
// carries the reason when the last packaging attempt failed.
export type ManifestUrls = {
  hls?: string;
  dash?: string;
};

// One ABR rendition produced by a transcode job (issue #8). Recorded on the
// SOURCE asset so a client can discover the produced renditions and their child
// asset ids in a single read. Each entry mirrors a child asset created with
// parentId = the source asset id.
export type Rendition = {
  // The child asset id holding this rendition's stored object.
  assetId: string;
  // Rung label from the encode profile (e.g. "1080p", "720p").
  label: string;
  width: number;
  height: number;
  // MinIO object key (workspace-local) of the produced file.
  objectKey: string;
};

export type Asset = {
  id: string;
  workspaceId: string;
  name: string;
  description?: string;
  status: AssetStatus;
  // Source asset id for renditions/children; undefined for top-level sources.
  parentId?: string;
  // MinIO object key (workspace-local) for the asset payload, if any.
  objectKey?: string;
  // Append-only audit trail of every status change (issue #3 deliverable 5).
  statusHistory: StatusTransition[];
  // Technical metadata from the ffprobe extraction pipeline (issue #6).
  // `null` means extraction has not yet succeeded; an accompanying
  // `technicalMetadataError` carries the reason when the last attempt failed.
  // Extraction never blocks the asset record, so both fields are optional.
  technicalMetadata?: TechnicalMetadata | null;
  technicalMetadataError?: string;
  // Streaming manifest URLs from the packaging pipeline (issue #9). Undefined
  // until packaging completes successfully; `packagingError` is set instead
  // when the last packaging attempt failed. Packaging never changes the
  // asset's lifecycle status — it only annotates the record.
  manifestUrls?: ManifestUrls;
  packagingError?: string;
  // ABR renditions produced by transcoding (issue #8). Populated on the SOURCE
  // asset when a transcode job completes; undefined until then.
  renditions?: Rendition[];
  createdAt: string;
  updatedAt: string;
};

export type CreateAssetInput = {
  name: string;
  description?: string;
  parentId?: string;
  objectKey?: string;
};

// Mutable fields accepted by PATCH. `status` is validated against the state
// machine; `parentId`/`id`/`workspaceId`/timestamps are immutable.
export type UpdateAssetInput = {
  name?: string;
  description?: string;
  objectKey?: string;
  status?: AssetStatus;
  // Set by the metadata extractor (issue #6). Writing `technicalMetadata` to a
  // value clears any prior error; writing `technicalMetadataError` records a
  // failure and leaves `technicalMetadata` null. `null` is an accepted value
  // for `technicalMetadata` (distinct from "not provided").
  technicalMetadata?: TechnicalMetadata | null;
  technicalMetadataError?: string;
  // Set by the packaging pipeline (issue #9). Writing `manifestUrls` clears any
  // prior `packagingError`; writing `packagingError` records a failure and
  // leaves `manifestUrls` untouched. Neither field changes `status`.
  manifestUrls?: ManifestUrls;
  packagingError?: string;
  // Set by the transcode pipeline (issue #8) on the source asset when a
  // transcode job completes. Does not change `status`.
  renditions?: Rendition[];
};

export type ListOptions = {
  limit?: number;
  offset?: number;
  status?: AssetStatus;
  parentId?: string;
};

export type ListResult = {
  items: Asset[];
  limit: number;
  offset: number;
  total: number;
};

// ---------------------------------------------------------------------------
// Domain errors. Routes map these to HTTP status codes.
// ---------------------------------------------------------------------------

// Raised when a status change violates the lifecycle state machine -> 422.
export class InvalidStateTransitionError extends Error {
  readonly statusCode = 422;
  constructor(from: AssetStatus, to: AssetStatus) {
    super(`invalid status transition: ${from} -> ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

// Raised when a referenced parent asset does not exist in the workspace -> 422.
export class ParentNotFoundError extends Error {
  readonly statusCode = 422;
  constructor(parentId: string) {
    super(`parent asset not found: ${parentId}`);
    this.name = 'ParentNotFoundError';
  }
}

// Raised when deleting a parent that still has children -> 409.
export class HasChildrenError extends Error {
  readonly statusCode = 409;
  constructor(id: string) {
    super(`asset ${id} has child assets and cannot be deleted`);
    this.name = 'HasChildrenError';
  }
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface AssetRepository {
  create(workspaceId: string, input: CreateAssetInput): Promise<Asset>;
  get(workspaceId: string, id: string): Promise<Asset | undefined>;
  list(workspaceId: string, opts?: ListOptions): Promise<ListResult>;
  search(workspaceId: string, query: string): Promise<Asset[]>;
  update(workspaceId: string, id: string, patch: UpdateAssetInput): Promise<Asset | undefined>;
  // Returns the count of direct children of an asset (for delete-blocking).
  countChildren(workspaceId: string, id: string): Promise<number>;
  // Soft-delete: transitions the asset to `archived`. Returns the archived
  // asset, or undefined if it does not exist in this workspace.
  remove(workspaceId: string, id: string): Promise<Asset | undefined>;
}

// Build the initial status history entry for a freshly created asset.
export function initialHistory(now: string): StatusTransition[] {
  return [{ at: now, from: null, to: 'uploading' }];
}

// Apply a status change, validating the transition and appending to history.
// Mutates and returns the passed-in arrays/values via a new object the caller
// can persist. Throws InvalidStateTransitionError on an illegal move.
export function applyStatus(
  current: AssetStatus,
  next: AssetStatus,
  history: StatusTransition[],
  now: string
): { status: AssetStatus; statusHistory: StatusTransition[] } {
  if (!isValidTransition(current, next)) {
    throw new InvalidStateTransitionError(current, next);
  }
  if (current === next) {
    return { status: current, statusHistory: history };
  }
  return {
    status: next,
    statusHistory: [...history, { at: now, from: current, to: next }]
  };
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export class InMemoryAssetRepository implements AssetRepository {
  // Keyed by fully namespaced id `<workspaceId>:<localId>`.
  private readonly store = new Map<string, Asset>();
  private counter = 0;

  async create(workspaceId: string, input: CreateAssetInput): Promise<Asset> {
    assertValidWorkspaceId(workspaceId);
    if (input.parentId) {
      const parent = await this.get(workspaceId, input.parentId);
      if (!parent) {
        throw new ParentNotFoundError(input.parentId);
      }
    }
    const now = new Date().toISOString();
    const localId = `asset-${++this.counter}`;
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
    this.store.set(namespacedId(workspaceId, localId), asset);
    return { ...asset };
  }

  async get(workspaceId: string, id: string): Promise<Asset | undefined> {
    assertValidWorkspaceId(workspaceId);
    const asset = this.store.get(namespacedId(workspaceId, id));
    if (!asset) {
      // Existence is not leaked: a foreign id is indistinguishable from a miss.
      return undefined;
    }
    // Defence in depth: re-check ownership even though the key is namespaced.
    assertOwned(workspaceId, asset.workspaceId);
    return { ...asset };
  }

  async list(workspaceId: string, opts: ListOptions = {}): Promise<ListResult> {
    assertValidWorkspaceId(workspaceId);
    const limit = clampLimit(opts.limit);
    const offset = Math.max(0, opts.offset ?? 0);
    let all = [...this.store.values()].filter((a) => a.workspaceId === workspaceId);
    if (opts.status) {
      all = all.filter((a) => a.status === opts.status);
    }
    if (opts.parentId !== undefined) {
      all = all.filter((a) => a.parentId === opts.parentId);
    }
    all.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const items = all.slice(offset, offset + limit).map((a) => ({ ...a }));
    return { items, limit, offset, total: all.length };
  }

  async search(workspaceId: string, query: string): Promise<Asset[]> {
    const q = query.toLowerCase();
    const { items } = await this.list(workspaceId, { limit: MAX_LIMIT });
    return items.filter(
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
    assertValidWorkspaceId(workspaceId);
    const key = namespacedId(workspaceId, id);
    const existing = this.store.get(key);
    if (!existing || existing.workspaceId !== workspaceId) {
      return undefined;
    }
    const now = new Date().toISOString();
    const next: Asset = { ...existing, updatedAt: now };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.objectKey !== undefined) next.objectKey = patch.objectKey;
    if (patch.technicalMetadata !== undefined) {
      next.technicalMetadata = patch.technicalMetadata;
      // A successful extraction clears any stale error.
      if (patch.technicalMetadata !== null) {
        next.technicalMetadataError = undefined;
      }
    }
    if (patch.technicalMetadataError !== undefined) {
      next.technicalMetadataError = patch.technicalMetadataError;
    }
    if (patch.manifestUrls !== undefined) {
      next.manifestUrls = patch.manifestUrls;
      // A successful packaging result clears any stale error.
      next.packagingError = undefined;
    }
    if (patch.packagingError !== undefined) {
      next.packagingError = patch.packagingError;
    }
    if (patch.renditions !== undefined) {
      next.renditions = patch.renditions;
    }
    if (patch.status !== undefined) {
      const applied = applyStatus(existing.status, patch.status, existing.statusHistory, now);
      next.status = applied.status;
      next.statusHistory = applied.statusHistory;
    }
    this.store.set(key, next);
    return { ...next };
  }

  async countChildren(workspaceId: string, id: string): Promise<number> {
    assertValidWorkspaceId(workspaceId);
    return [...this.store.values()].filter(
      (a) => a.workspaceId === workspaceId && a.parentId === id
    ).length;
  }

  async remove(workspaceId: string, id: string): Promise<Asset | undefined> {
    // Soft delete: transition to `archived` (see couch-asset-repo.ts for the
    // delete-strategy rationale). The route blocks if children exist.
    return this.update(workspaceId, id, { status: 'archived' });
  }
}

export function clampLimit(limit?: number): number {
  if (limit === undefined || Number.isNaN(limit)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}
