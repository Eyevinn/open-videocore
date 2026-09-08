// Archive-tier relocation policy engine (issue #557, ADR-019).
//
// Relocates a COLD asset's D3-tierable bytes from the hot (OSC-managed default)
// tier to a registered `archive`-role backend (ADR-019 D5), leaving the asset's
// metadata document fully intact and searchable (ADR-019 D6 firewall: this NEVER
// touches lifecycle `status`, `statusHistory`, or the retention-purge clock). On
// success it flips the per-byte-class `storageTiering` axis to `archive`
// (asset-repo.ts:123-195, the #556 representation).
//
// TRIGGER (ADR-019 D2): explicit operator action is the mandatory baseline. This
// module executes a relocation once selected; an OPTIONAL age gate (derivable
// today from `createdAt`, ADR-019 D2 policy #2) is offered via `isAgeEligible`.
// Last-access is NOT implemented — there is no `lastAccessedAt` signal in the
// data model yet (ADR-019 V6/D2 policy #3), logged as friction.
//
// SCOPE (ADR-019 D3): only the source-side byte classes may be archived —
// `source` (the mezzanine `objectKey`, primary candidate) and, at policy
// discretion, `renditions` (`renditions[].objectKey`). `packaged` MUST stay
// `hot` (it is on the live `/stream/*` read path, ADR-019 D3/V5) and is REFUSED
// here. `subtitles`/`thumbnails` are out of scope (default hot).
//
// BYTE MOVEMENT — REUSES the existing output-relocation primitive shape
// (pipeline/output-relocation.ts, ADR-011): S3/MinIO server-side CopyObject, so
// bytes never transit this process. The archive destination is resolved from the
// #547 registry (services/storage-backend-registry.ts) — NO parallel backend
// registry is introduced (ADR-019 D5). Credentials are NEVER read or logged here;
// the copy client is wired with the archive backend's OSC-secret-backed creds by
// the caller (main.ts), exactly as ADR-017 fans secrets out per serviceId.
//
// SAFETY / IDEMPOTENCY (issue #557 acceptance):
//   - COPY-THEN-VERIFY-THEN-DELETE: an object is deleted from the source tier
//     ONLY after its copy is confirmed present (statObject) at the archive
//     destination. A failed/partial copy leaves every source byte intact and does
//     NOT flip the tier, so bytes remain recoverable in the source tier.
//   - RE-RUNNABLE: a byte class already on `archive` is a no-op (nothing copied,
//     nothing deleted). A partially-relocated class is completed on re-run — a
//     source object already absent (copy done, delete done) is skipped; a source
//     object still present is (re-)copied and re-verified before deletion. So a
//     crash between copy and delete, or between delete and the tier-write, is
//     healed by simply running again.
//   - The tier-write is the LAST step and only records classes we FULLY relocated.

import type { Asset, AssetRepository, StorageByteClass, StorageTier } from '../data/asset-repo.js';
import { parseS3Uri } from '../routes/assets.js';

// The minimal MinIO/S3 client surface this engine uses. Declared structurally so
// the real MinioClient satisfies it and a fake is injectable in tests (mirrors
// RelocationClient in output-relocation.ts and the RedisLike precedent).
//   - copyObject: legacy 4-arg server-side copy (targetBucket, targetKey,
//     "/<sourceBucket>/<sourceKey>"), verified against minio ^8.x typings and
//     already used by output-relocation.ts:150.
//   - statObject: existence/size probe used to VERIFY a copy landed before any
//     source delete, and to detect an already-completed relocation on re-run
//     (storage.ts:92-102 uses the same call).
//   - removeObject: delete one source-tier object after its copy is verified
//     (storage.ts:104-106).
export interface ArchiveCopyClient {
  copyObject(
    targetBucketName: string,
    targetObjectName: string,
    sourceBucketNameAndObjectName: string
  ): Promise<unknown>;
  statObject(bucketName: string, objectName: string): Promise<{ size: number; etag: string }>;
  removeObject(bucketName: string, objectName: string): Promise<void>;
}

// The byte classes this engine will relocate (ADR-019 D3). `packaged`,
// `subtitles`, and `thumbnails` are deliberately excluded: `packaged` MUST stay
// hot, the other two are out of scope for the initial policy.
export const ARCHIVABLE_BYTE_CLASSES = ['source', 'renditions'] as const;
export type ArchivableByteClass = (typeof ARCHIVABLE_BYTE_CLASSES)[number];

export function isArchivableByteClass(cls: StorageByteClass): cls is ArchivableByteClass {
  return (ARCHIVABLE_BYTE_CLASSES as readonly string[]).includes(cls);
}

// Raised when a caller asks to archive a byte class that ADR-019 D3 pins to hot
// (only `packaged` today) or that is out of scope. Refusing here is the code-level
// expression of the D3 normative rule; the route maps this to 422.
export class NonArchivableByteClassError extends Error {
  readonly statusCode = 422;
  constructor(cls: StorageByteClass) {
    super(`byte class "${cls}" cannot be archived (ADR-019 D3): only source/renditions are tierable`);
    this.name = 'NonArchivableByteClassError';
  }
}

// A resolved archive destination — the coordinates of the registered
// `archive`-role backend (ADR-019 D5). The bucket comes from the #547 registry's
// StorageBackendRecord.bucket; `prefix` is an optional key namespace under which
// this instance lands archived objects so two tenants never collide in a shared
// archive bucket (mirrors the per-workspace namespacing throughout).
export type ArchiveDestination = {
  bucket: string;
  // Optional key prefix; '' means archive objects keep their source-tier key.
  prefix: string;
};

// Compose the archive-tier object key for a source-tier key. The source key is
// preserved under the destination prefix so a rehydrate (ADR-019 D4, future
// slice) can map back deterministically.
export function archiveKeyFor(sourceKey: string, destPrefix: string): string {
  const base = destPrefix.replace(/\/+$/, '');
  const rel = sourceKey.replace(/^\/+/, '');
  return base.length > 0 ? `${base}/${rel}` : rel;
}

// Resolve a byte class to the set of source-tier objects to relocate. Each object
// carries the bucket it currently lives in (a plain key -> the source bucket; an
// `s3://bucket/key` rendition -> that bucket, parseS3Uri, mirroring the
// cross-bucket handling in archived-asset-purge-sweep.ts:266-278) plus the key.
type SourceObject = { bucket: string; key: string };

function objectsForClass(
  asset: Asset,
  cls: ArchivableByteClass,
  sourceBucket: string
): SourceObject[] {
  if (cls === 'source') {
    return asset.objectKey ? [{ bucket: sourceBucket, key: asset.objectKey }] : [];
  }
  // renditions
  const out: SourceObject[] = [];
  for (const r of asset.renditions ?? []) {
    const s3 = parseS3Uri(r.objectKey);
    if (s3) {
      out.push({ bucket: s3.bucket, key: s3.key });
    } else {
      out.push({ bucket: sourceBucket, key: r.objectKey });
    }
  }
  return out;
}

type Logger = {
  info?(...a: unknown[]): void;
  warn?(...a: unknown[]): void;
};

export type RelocateToArchiveDeps = {
  assets: AssetRepository;
  // Server-side-copy / stat / delete client wired with the archive backend's
  // credentials by the caller (creds NEVER logged or persisted to a job record).
  client: ArchiveCopyClient;
  // The hot source bucket (bound to main.ts's sourceBucket, as the purge sweep is).
  sourceBucket: string;
  // The resolved `archive`-role destination from the #547 registry (ADR-019 D5).
  destination: ArchiveDestination;
  logger?: Logger;
};

export type RelocateToArchiveResult = {
  assetId: string;
  // Byte classes that were fully relocated (hot -> archive) by this run, or were
  // already fully on archive (idempotent no-op counted as relocated).
  relocated: ArchivableByteClass[];
  // Objects copied to the archive backend in THIS run (0 on a pure re-run no-op).
  objectsCopied: number;
  // Objects deleted from the source tier in THIS run.
  objectsDeleted: number;
};

// Age gate (ADR-019 D2 policy #2, opt-in): true when the asset is older than
// `minAgeMs`, derived from `createdAt` (no new data-model field needed, ADR-019
// V6). Callers opt in; the baseline trigger (explicit operator action) needs no
// gate. Returns false for an unparseable/absent timestamp (defensive: never
// archive on an ambiguous age).
export function isAgeEligible(asset: Asset, minAgeMs: number, now: number = Date.now()): boolean {
  if (!Number.isFinite(minAgeMs) || minAgeMs <= 0) {
    return true; // no age requirement
  }
  const created = Date.parse(asset.createdAt);
  if (Number.isNaN(created)) {
    return false;
  }
  return now - created >= minAgeMs;
}

// Relocate the requested cold byte classes of one asset to the archive backend.
// Idempotent and safe to re-run; a failed relocation leaves every source byte
// intact and does NOT flip the tier (issue #557). Refuses non-archivable classes
// (ADR-019 D3) BEFORE touching any bytes.
export async function relocateAssetToArchive(
  deps: RelocateToArchiveDeps,
  assetId: string,
  classes: readonly ArchivableByteClass[]
): Promise<RelocateToArchiveResult | undefined> {
  // Guard: refuse any non-archivable class up front (ADR-019 D3), so we never
  // partially process a request that includes e.g. `packaged`.
  for (const cls of classes) {
    if (!isArchivableByteClass(cls)) {
      throw new NonArchivableByteClassError(cls);
    }
  }

  const asset = await deps.assets.get(assetId);
  if (!asset) {
    return undefined;
  }

  const currentTiers = asset.storageTiering?.tiers ?? {};
  const relocated: ArchivableByteClass[] = [];
  const nextTiers: Partial<Record<StorageByteClass, StorageTier>> = { ...currentTiers };
  let objectsCopied = 0;
  let objectsDeleted = 0;

  for (const cls of classes) {
    // Idempotent no-op: a class already on `archive` needs nothing (ADR-019 —
    // safe to re-run). Count it as relocated so the caller sees the target state.
    if (currentTiers[cls] === 'archive') {
      relocated.push(cls);
      continue;
    }

    const objects = objectsForClass(asset, cls, deps.sourceBucket);
    // A class with no bytes (e.g. an asset with no renditions yet) is vacuously
    // relocated — nothing to move, and marking it archive is honest.
    let classFullyRelocated = true;

    for (const obj of objects) {
      const destKey = archiveKeyFor(obj.key, deps.destination.prefix);
      try {
        // Detect an already-completed relocation on re-run: if the source object
        // is already GONE but the archive copy is present, this object was
        // relocated by a prior run — skip it. If the source is gone AND the
        // archive copy is missing, the bytes are lost from BOTH tiers; refuse to
        // mark the class archived (leave it hot so the situation is visible).
        const sourcePresent = await statOrUndefined(deps.client, obj.bucket, obj.key);
        if (!sourcePresent) {
          const archivePresent = await statOrUndefined(
            deps.client,
            deps.destination.bucket,
            destKey
          );
          if (!archivePresent) {
            deps.logger?.warn?.(
              '[archive-tier] %s object gone from BOTH source and archive: %s/%s — leaving class hot',
              assetId,
              obj.bucket,
              obj.key
            );
            classFullyRelocated = false;
          }
          continue;
        }

        // COPY (server-side) then VERIFY before any delete. copyObject is
        // idempotent (overwrites an identical destination), so a re-run after a
        // crash-before-delete simply re-copies harmlessly.
        await deps.client.copyObject(
          deps.destination.bucket,
          destKey,
          `/${obj.bucket}/${obj.key}`
        );
        objectsCopied += 1;

        const verified = await statOrUndefined(deps.client, deps.destination.bucket, destKey);
        if (!verified) {
          // Copy did not land — DO NOT delete the source. Bytes stay recoverable.
          deps.logger?.warn?.(
            '[archive-tier] %s copy of %s/%s to archive could not be verified — source retained',
            assetId,
            obj.bucket,
            obj.key
          );
          classFullyRelocated = false;
          continue;
        }

        // Delete the source-tier object ONLY after the archive copy is verified.
        await deps.client.removeObject(obj.bucket, obj.key);
        objectsDeleted += 1;
      } catch (err) {
        // Any failure for this object: leave source bytes intact, do not flip the
        // class. A later re-run heals it. Best-effort per object, never abort the
        // whole asset (mirrors the purge sweep's per-object discipline).
        deps.logger?.warn?.(
          '[archive-tier] %s failed to relocate %s/%s: %o',
          assetId,
          obj.bucket,
          obj.key,
          err
        );
        classFullyRelocated = false;
      }
    }

    if (classFullyRelocated) {
      nextTiers[cls] = 'archive';
      relocated.push(cls);
    }
  }

  // Persist the tier flip ONLY for fully-relocated classes, LAST, and ONLY when
  // something actually changed — leaving the metadata document otherwise untouched
  // (ADR-019 D6: no status/statusHistory write). Uses the dedicated tiering write
  // path so the editorial update path is never involved.
  const changed = relocated.some((cls) => currentTiers[cls] !== 'archive');
  if (changed) {
    await deps.assets.setStorageTier(assetId, nextTiers);
  }

  return { assetId, relocated, objectsCopied, objectsDeleted };
}

// stat that resolves to undefined on a NotFound rather than throwing, so the
// engine can branch on presence without try/catch noise (mirrors
// WorkspaceStorage.statObject, storage.ts:92-102).
async function statOrUndefined(
  client: ArchiveCopyClient,
  bucket: string,
  key: string
): Promise<{ size: number; etag: string } | undefined> {
  try {
    return await client.statObject(bucket, key);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === 'NotFound' || code === 'NoSuchKey') {
      return undefined;
    }
    throw err;
  }
}
