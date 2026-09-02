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

import { ulid } from 'ulid';
import {
  type Asset,
  type AssetReadState,
  type AssetRepository,
  type AssetReviewState,
  type AssetStatus,
  type CreateAssetInput,
  type ListOptions,
  type ListResult,
  type UpdateAssetInput,
  applyMetadata,
  applyRestore,
  applyReviewState,
  applyStatus,
  clampLimit,
  generateUniqueSlug,
  initialHistory,
  initialProvenance,
  normalizeTags,
  provenanceForPatch,
  MAX_LIMIT,
  ParentNotFoundError
} from './asset-repo.js';
import {
  AssetDocumentSchema,
  fromAssetDocument,
  toAssetDocument,
  type AssetDocument
} from './asset-document.js';
import {
  ASSET_TOMBSTONE_TYPE,
  AssetTombstoneSchema,
  isTombstoneDoc,
  toTombstoneDocument
} from './asset-tombstone.js';
import { updateWithRetry, type StoredDoc, type StackCouch } from './couchdb.js';

const RESOURCE_TYPE = 'asset';

// A factory returning the stack's StackCouch, reusing one shared CouchDB
// connection (nano ServerScope).
export type CouchFactory = () => StackCouch;

export class CouchAssetRepository implements AssetRepository {
  constructor(private readonly couchFor: CouchFactory) {}

  async create(input: CreateAssetInput): Promise<Asset> {
    const couch = this.couchFor();
    if (input.parentId) {
      const parent = await couch.get(input.parentId);
      if (!parent || parent.resourceType !== RESOURCE_TYPE) {
        throw new ParentNotFoundError(input.parentId);
      }
    }
    const now = new Date().toISOString();
    // ULID local id (ADR-005 / issue #53): time-sortable + URL-safe.
    const localId = ulid();
    const method = input.sourceMethod ?? 'upload';
    // Human-readable slug (issue #131), unique within this stack's database.
    // OSC provisions one CouchDB instance per tenant (ADR-003), so a slug
    // existence check against this database is inherently workspace-scoped.
    const slug = await generateUniqueSlug(
      (s) => this.slugTaken(couch, s),
      input.slug
    );
    const asset: Asset = {
      id: localId,
      name: input.name,
      slug,
      description: input.description,
      status: 'uploading',
      parentId: input.parentId,
      versionOfAssetId: input.versionOfAssetId,
      versionGroupId: input.versionGroupId,
      objectKey: input.objectKey,
      statusHistory: initialHistory(now),
      metadata: input.metadata,
      tags: input.tags ? normalizeTags(input.tags) : undefined,
      sourceMethod: method,
      originUri: input.originUri,
      provenance: initialProvenance(now, method),
      createdAt: now,
      updatedAt: now
    };
    await couch.put(localId, toDoc(asset));
    return asset;
  }

  async get(id: string): Promise<Asset | undefined> {
    const couch = this.couchFor();
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      // A tombstone (resourceType === ASSET_TOMBSTONE_TYPE) is NOT an asset, so
      // it reads as `undefined` here — every non-410 caller (delivery, files,
      // pipeline) sees a purged asset as not-found, which is the safe default.
      // The 410-aware read path uses getState() below instead.
      return undefined;
    }
    return fromDoc(doc);
  }

  async getState(id: string): Promise<AssetReadState> {
    const couch = this.couchFor();
    const doc = await couch.get(id);
    if (!doc) {
      return { kind: 'not-found' };
    }
    if (isTombstoneDoc(doc)) {
      return { kind: 'tombstone' };
    }
    if (doc.resourceType !== RESOURCE_TYPE) {
      // Some other resource sharing the id space (should not happen for asset
      // ids) — treat as not-found rather than leaking a foreign document.
      return { kind: 'not-found' };
    }
    return { kind: 'asset', asset: fromDoc(doc) };
  }

  // Resolve by slug (issue #132). Queries the top-level `slug` mirror emitted by
  // toDoc() with the same Mango selector style as slugTaken(). OSC provisions one
  // CouchDB instance per tenant (ADR-003), so the lookup is inherently
  // workspace-scoped. Slugs are unique within the database (generateUniqueSlug),
  // so at most one document matches.
  async getBySlug(slug: string): Promise<Asset | undefined> {
    const couch = this.couchFor();
    const matches = await couch.find({ resourceType: RESOURCE_TYPE, slug }, { limit: 1 });
    const doc = matches.find((d) => d.resourceType === RESOURCE_TYPE);
    if (!doc) {
      return undefined;
    }
    return fromDoc(doc);
  }

  async list(opts: ListOptions = {}): Promise<ListResult> {
    const couch = this.couchFor();
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

  async search(query: string): Promise<Asset[]> {
    // Substring match over name/description via Mango regex. Full-text search
    // proper is delegated to the PostgreSQL index in a later issue; this keeps
    // parity with the in-memory repo for now.
    const couch = this.couchFor();
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
    id: string,
    patch: UpdateAssetInput
  ): Promise<Asset | undefined> {
    const couch = this.couchFor();
    // Not-found / wrong-resource-type guard, preserved exactly (returns
    // undefined). Done before the retry loop so a genuinely absent (or
    // non-asset) document never enters the read-modify-write path.
    const preflight = await couch.get(id);
    if (!preflight || preflight.resourceType !== RESOURCE_TYPE) {
      return undefined;
    }
    // Concurrent-write safety (issues #278/#279/#281): route the read-modify-write
    // through the shared conflict-retry wrapper (updateWithRetry, src/data/couchdb.ts).
    // A `Document update conflict.` (HTTP 409) from a concurrent writer racing on
    // the same _rev — e.g. a thumbnail write landing between this method's read
    // and put, or the re-drive path of issue #281 racing an in-flight
    // extraction — is refetched and re-applied rather than surfacing as a
    // terminal failure. Patch application is extracted into `applyPatch` (issue
    // #278), which is pure (no writes) so it is safe to re-run per attempt,
    // exactly as updateWithRetry requires.
    let updated: Asset | undefined;
    const written = await updateWithRetry(couch, id, (current) => {
      const next = this.applyPatch(fromDoc(current), patch);
      // Capture the in-memory result to return; updateWithRetry carries _rev and
      // performs the put (put() forces the partition).
      updated = next;
      return toDoc(next);
    });
    // updateWithRetry returns undefined only when the document vanished between
    // the preflight read and the loop (a concurrent delete); patchFn never ran,
    // so `updated` is still undefined too. Preserve the not-found contract.
    return written ? updated : undefined;
  }

  // Pure patch application (issue #278/#281): given the current asset and a
  // patch, compute the next asset. NO writes and NO side effects, so it is safe
  // to run more than once inside updateWithRetry's retry loop.
  private applyPatch(existing: Asset, patch: UpdateAssetInput): Asset {
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
    if (patch.manifestUrls !== undefined) {
      next.manifestUrls = patch.manifestUrls;
      next.packagingError = undefined;
    }
    if (patch.packagingError !== undefined) {
      next.packagingError = patch.packagingError;
    }
    if (patch.packagedOutput !== undefined) {
      next.packagedOutput = patch.packagedOutput;
    }
    if (patch.renditions !== undefined) {
      next.renditions = patch.renditions;
    }
    if (patch.thumbnails !== undefined) {
      next.thumbnails = patch.thumbnails;
    }
    if (patch.metadata !== undefined) {
      next.metadata = applyMetadata(existing.metadata, patch.metadata, patch.replaceMetadata ?? false);
    }
    if (patch.tags !== undefined) {
      next.tags = normalizeTags(patch.tags);
    }
    if (patch.audioTracks !== undefined) {
      next.audioTracks = patch.audioTracks;
    }
    if (patch.subtitleTracks !== undefined) {
      next.subtitleTracks = patch.subtitleTracks;
    }
    if (patch.subtitlesError !== undefined) {
      // `null` clears the error (successful attach); a string records a failure.
      next.subtitlesError = patch.subtitlesError ?? undefined;
    }
    if (patch.sceneMetadata !== undefined) {
      next.sceneMetadata = patch.sceneMetadata;
      // A successful detection clears any stale error.
      if (patch.sceneMetadata !== null) {
        next.sceneDetectionError = undefined;
      }
    }
    if (patch.sceneDetectionError !== undefined) {
      next.sceneDetectionError = patch.sceneDetectionError;
    }
    if (patch.versionGroupId !== undefined) {
      next.versionGroupId = patch.versionGroupId;
    }
    if (patch.status !== undefined) {
      const applied = applyStatus(existing.status, patch.status, existing.statusHistory, now);
      next.status = applied.status;
      next.statusHistory = applied.statusHistory;
    }
    // Append provenance for whichever namespaces this patch touched (issue #53).
    const entries = provenanceForPatch(patch, now);
    if (entries.length > 0) {
      next.provenance = [...(existing.provenance ?? []), ...entries];
    }
    return next;
  }

  async transitionReviewState(
    id: string,
    to: AssetReviewState
  ): Promise<Asset | undefined> {
    const couch = this.couchFor();
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return undefined;
    }
    const existing = fromDoc(doc);
    const applied = applyReviewState(existing.reviewState, to);
    const now = new Date().toISOString();
    const next: Asset = { ...existing, reviewState: applied.reviewState, updatedAt: now };
    // Carry _rev so CouchDB accepts the update; put() forces the partition.
    await couch.put(id, { ...toDoc(next), _rev: doc._rev });
    return next;
  }

  // Workspace-scoped slug existence check (issue #131). Queries the top-level
  // `slug` mirror emitted by toDoc() so the lookup is a simple Mango selector.
  private async slugTaken(couch: StackCouch, slug: string): Promise<boolean> {
    const matches = await couch.find({ resourceType: RESOURCE_TYPE, slug }, { limit: 1 });
    return matches.length > 0;
  }

  async countChildren(id: string): Promise<number> {
    const couch = this.couchFor();
    // Archived children no longer block deletion — they are already soft-deleted.
    return couch.count({ resourceType: RESOURCE_TYPE, derivedFrom: id, state: { $ne: 'archived' } });
  }

  async listVersions(id: string): Promise<Asset[] | undefined> {
    const couch = this.couchFor();
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return undefined;
    }
    const asset = fromDoc(doc);
    // No lineage yet: the asset is its own (single-member) chain.
    if (!asset.versionGroupId) {
      return [asset];
    }
    const docs = await couch.find(
      { resourceType: RESOURCE_TYPE, versionGroupId: asset.versionGroupId },
      { limit: MAX_LIMIT }
    );
    return docs
      .filter((d) => d.resourceType === RESOURCE_TYPE)
      .map(fromDoc)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  }

  async remove(id: string): Promise<Asset | undefined> {
    // Soft delete (see file header): archive rather than destroy.
    return this.update(id, { status: 'archived' });
  }

  // Undo an archive within the retention window (issue #328, part of #323).
  // Sibling to remove(): moves an already-`archived` asset back to a live status
  // (`ready` when the pre-archive status was `ready`, otherwise `failed`) and
  // appends an audited `archived -> <target>` statusHistory entry. Deliberately
  // BYPASSES the state machine — the ordinary PATCH path cannot leave `archived`
  // (ALLOWED_TRANSITIONS.archived stays `[]`) so this is the one sanctioned exit,
  // consistent with ADR-005 (append the audit entry, never rewrite history).
  //
  // Routed through updateWithRetry for the same conflict-retry safety the rest of
  // the read-modify-write paths use (issues #278/#279/#281): the patchFn is pure
  // and re-runnable per attempt. A tombstone (purged) doc carries a non-asset
  // resourceType and so fails the preflight guard, reading as undefined here — the
  // route maps that to 410 via getState(). Returns undefined when the id is
  // unknown, purged, or not currently `archived` (nothing to restore).
  async restore(id: string): Promise<Asset | undefined> {
    const couch = this.couchFor();
    const preflight = await couch.get(id);
    if (!preflight || preflight.resourceType !== RESOURCE_TYPE) {
      return undefined;
    }
    if (fromDoc(preflight).status !== 'archived') {
      return undefined;
    }
    let restored: Asset | undefined;
    const written = await updateWithRetry(couch, id, (current) => {
      const existing = fromDoc(current);
      // Guard again inside the retry: a concurrent writer could have moved the
      // asset out of `archived` between the preflight read and this attempt.
      if (existing.status !== 'archived') {
        restored = undefined;
        return toDoc(existing);
      }
      const now = new Date().toISOString();
      const applied = applyRestore(existing.statusHistory, now);
      const next: Asset = {
        ...existing,
        status: applied.status,
        statusHistory: applied.statusHistory,
        updatedAt: now,
        provenance: [
          ...(existing.provenance ?? []),
          { at: now, by: 'user', op: 'restore', detail: applied.status }
        ]
      };
      restored = next;
      return toDoc(next);
    });
    return written ? restored : undefined;
  }

  // Purge an archived asset by REPLACING its document in place with a tombstone
  // (issue #326, doc-replace per ADR-005). Exposed so the retention sweep slice
  // (#327) constructs and writes the tombstone through this one path rather than
  // re-deriving the shape; this slice does not call it on any request route. The
  // asset's `_rev` is carried so CouchDB accepts the replacement and the
  // `_changes` feed emits the tombstone body, which drops the asset from the PG
  // search projection. Returns the tombstone's id, or undefined when the id is
  // absent or not a live asset (already purged / never existed).
  async purgeToTombstone(
    id: string,
    opts: { purgedAt?: string } = {}
  ): Promise<string | undefined> {
    const couch = this.couchFor();
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return undefined;
    }
    const asset = fromDoc(doc);
    const tombstone = toTombstoneDocument(asset, { purgedAt: opts.purgedAt });
    // Validate the replacement body, then strip the id/rev envelope fields the
    // storage layer owns and carry the live `_rev` so the write is an in-place
    // replacement (not a branch/conflict).
    const validated = AssetTombstoneSchema.parse(tombstone);
    const { _id: _ignoredId, _rev: _ignoredRev, ...body } = validated;
    await couch.put(id, { ...body, resourceType: ASSET_TOMBSTONE_TYPE, _rev: doc._rev });
    return id;
  }
}

function buildSelector(opts: ListOptions): Record<string, unknown> {
  const selector: Record<string, unknown> = { resourceType: RESOURCE_TYPE };
  if (opts.status) {
    // Mirror of `state` for indexable Mango filtering (ADR-005).
    selector['state'] = opts.status as AssetStatus;
  }
  if (opts.parentId !== undefined) {
    // Mirror of structural.derivedFrom for indexable Mango filtering.
    selector['derivedFrom'] = opts.parentId;
  }
  if (opts.versionGroupId !== undefined) {
    // Mirror of structural.versionGroupId for indexable Mango filtering (#118).
    selector['versionGroupId'] = opts.versionGroupId;
  }
  return selector;
}

// Map an Asset to the persisted four-namespace document body (ADR-005). The
// CouchDB-managed envelope fields (_id/_rev/workspaceId) are owned by
// WorkspaceCouch.put; here we emit the namespaced model plus a small set of
// top-level mirrors (`resourceType`, `state`, `derivedFrom`) so Mango selectors
// stay simple and indexable. Validated against AssetDocumentSchema before write.
function toDoc(asset: Asset): Record<string, unknown> {
  const document: AssetDocument = toAssetDocument(asset);
  const validated = AssetDocumentSchema.parse(document);
  const { _id: _ignoredId, _rev: _ignoredRev, ...body } = validated;
  return {
    ...body,
    resourceType: RESOURCE_TYPE,
    localId: asset.id,
    state: asset.status,
    derivedFrom: asset.parentId ?? null,
    // Top-level mirror of structural.versionGroupId (issue #118) so enumerating
    // a version lineage is a simple, indexable Mango selector. Omitted for
    // assets not in any version chain.
    ...(asset.versionGroupId ? { versionGroupId: asset.versionGroupId } : {}),
    // Top-level mirror of descriptive.slug (issue #131) so the workspace-scoped
    // uniqueness check is a simple, indexable Mango selector. Omitted for
    // legacy/slug-less assets.
    ...(asset.slug ? { slug: asset.slug } : {})
  };
}

// schemaVersion read rule (issue #166, TAMS bridge epic #116).
//
// The TAMS addressing fields (structural.tams.flowIds / .timerange, issue #165)
// are ADDITIVE within schemaVersion 1: they are `.optional()` on
// AssetDocumentSchema, so this is NOT a schemaVersion bump — ASSET_SCHEMA_VERSION
// stays 1 (asset-document.ts) and every pre-#165 document remains a valid v1
// document. There is no ADR-005 file in this clone's docs/architecture/ (only
// ADR-001/007/008); the in-code schemaVersion contract above is the source of
// truth, and it treats new optional fields as additive with a documented default
// of ABSENT (mapped to `undefined` by fromAssetDocument), never a back-filled
// write.
//
// READ RULE: schemaVersion is INJECTED, not read from the stored body. We parse
// with a forced `schemaVersion: 1`, so a legacy document that predates the
// explicit field (absent, or an older integer) still deserializes — the loader
// normalises it to the current v1 shape in memory. Because `get()` only reads
// (this function is pure and never calls couch.put), reading a legacy document
// does NOT mutate it, back-fill the TAMS fields, or churn its CouchDB `_rev`.
function fromDoc(doc: StoredDoc): Asset {
  const localId = String(doc['localId'] ?? stripPartition(doc._id));
  const document = AssetDocumentSchema.parse({
    ...doc,
    _id: localId,
    type: 'asset',
    schemaVersion: 1
  });
  return fromAssetDocument(document);
}

// `<workspaceId>:<localId>` -> `<localId>`.
function stripPartition(id: string): string {
  const idx = id.indexOf(':');
  return idx >= 0 ? id.slice(idx + 1) : id;
}
