// Archive-tier REHYDRATE (restore) execution engine (issue #558, ADR-019 D4).
//
// The inverse of the relocation engine (pipeline/archive-tier-relocation.ts,
// issue #557): it pulls a COLD asset's archived byte classes back from the
// registered `archive`-role backend (ADR-019 D5) to the hot source tier, so
// delivery / reprocessing can read them again. It drives the per-byte-class
// rehydrate lifecycle on the `storageTiering` axis through
//   queued (implicit) -> in-flight (rehydrating[]) -> hot
// and leaves the metadata document otherwise intact (ADR-019 D6 firewall: this
// NEVER touches lifecycle `status`, `statusHistory`, or the retention-purge
// clock; D6 rule #4 — rehydrate flips only the byte tier and can NEVER revive an
// `archived`-status asset).
//
// CONTRACT (ADR-019 D4): the baseline is an EXPLICIT restore request.
// Automatic-on-access is deferred in the ADR (packaged bytes stay hot, so
// playback never hits archive); processing jobs that need archived source
// request a restore and await it. This engine executes one such request.
//
// SCOPE (ADR-019 D3): only the source-side byte classes are tierable and thus
// rehydratable — `source` and `renditions`. `packaged` is pinned hot (never
// archived, so never rehydrated); `subtitles`/`thumbnails` are out of scope.
// This reuses ARCHIVABLE_BYTE_CLASSES / isArchivableByteClass from the
// relocation module so the two engines share one byte-class scope definition.
//
// BYTE MOVEMENT — REUSES the same server-side-copy primitive shape as relocation
// (ArchiveCopyClient: S3/MinIO CopyObject + statObject + removeObject), so bytes
// never transit this process and a fake is injectable in tests. Credentials are
// NEVER read or logged here; the copy client is wired with the archive backend's
// OSC-secret-backed creds by the caller (main.ts), exactly as relocation is.
//
// SAFETY / IDEMPOTENCY (mirrors issue #557's discipline, inverted):
//   - COPY-THEN-VERIFY-THEN-DELETE: an archive object is deleted ONLY after its
//     copy is confirmed present (statObject) at the hot source tier. A failed or
//     partial copy leaves every archive byte intact and does NOT flip the tier to
//     hot, so the cold bytes remain the source of truth and the restore can be
//     re-run.
//   - RE-RUNNABLE: a class already `hot` is a no-op. A class whose archive object
//     is already gone but whose hot copy is present was restored by a prior run —
//     it is completed. The in-flight marker is set before any byte move and
//     cleared (with the tier flip) only on full success, so a crash mid-restore
//     is healed by re-running.
//   - The tier flip + in-flight clear is the LAST step, via the repo's dedicated
//     rehydrate write path (asset-repo.ts setRehydrateState), and only for
//     classes fully restored.

import type { Asset, AssetRepository, StorageByteClass } from '../data/asset-repo.js';
import { parseS3Uri } from '../routes/assets.js';
import {
  ARCHIVABLE_BYTE_CLASSES,
  archiveKeyFor,
  isArchivableByteClass,
  NonArchivableByteClassError,
  type ArchivableByteClass,
  type ArchiveCopyClient,
  type ArchiveDestination
} from './archive-tier-relocation.js';

export { ARCHIVABLE_BYTE_CLASSES, isArchivableByteClass, NonArchivableByteClassError };

type Logger = {
  info?(...a: unknown[]): void;
  warn?(...a: unknown[]): void;
};

export type RehydrateFromArchiveDeps = {
  assets: AssetRepository;
  // Server-side-copy / stat / delete client wired with the archive backend's
  // credentials by the caller (creds NEVER logged or persisted to a job record).
  client: ArchiveCopyClient;
  // The hot source bucket bytes are restored INTO (bound to main.ts's
  // sourceBucket, same binding relocation uses as its move origin).
  sourceBucket: string;
  // The resolved `archive`-role destination the bytes currently live in
  // (ADR-019 D5). The same destination relocation moved them to; rehydrate maps
  // the hot-tier key back via archiveKeyFor(key, destination.prefix).
  destination: ArchiveDestination;
  logger?: Logger;
};

export type RehydrateFromArchiveResult = {
  assetId: string;
  // Byte classes that are now fully `hot` after this run (restored here, or were
  // already hot — an idempotent no-op counted as rehydrated).
  rehydrated: ArchivableByteClass[];
  // Objects copied archive -> hot in THIS run (0 on a pure re-run no-op).
  objectsCopied: number;
  // Archive-tier objects deleted in THIS run (after their hot copy is verified).
  objectsDeleted: number;
};

// The hot-tier object to restore and the archive-tier object it currently lives
// at. `hotBucket`/`hotKey` are where the bytes must end up (mirroring
// relocation's SourceObject resolution: a plain key -> the source bucket; an
// `s3://bucket/key` rendition -> that bucket). `archiveKey` is the key under the
// archive destination prefix the relocation engine wrote.
type RestoreObject = { hotBucket: string; hotKey: string; archiveKey: string };

function objectsForClass(
  asset: Asset,
  cls: ArchivableByteClass,
  sourceBucket: string,
  destPrefix: string
): RestoreObject[] {
  const hot: { bucket: string; key: string }[] = [];
  if (cls === 'source') {
    if (asset.objectKey) {
      hot.push({ bucket: sourceBucket, key: asset.objectKey });
    }
  } else {
    for (const r of asset.renditions ?? []) {
      const s3 = parseS3Uri(r.objectKey);
      hot.push(s3 ? { bucket: s3.bucket, key: s3.key } : { bucket: sourceBucket, key: r.objectKey });
    }
  }
  return hot.map((h) => ({
    hotBucket: h.bucket,
    hotKey: h.key,
    archiveKey: archiveKeyFor(h.key, destPrefix)
  }));
}

// Restore the requested archived byte classes of one asset to hot storage
// (ADR-019 D4). Idempotent and safe to re-run; a failed restore leaves every
// archive byte intact and does NOT flip the tier to hot. Refuses non-rehydratable
// classes (ADR-019 D3) BEFORE touching any bytes or marking anything in-flight.
export async function rehydrateAssetFromArchive(
  deps: RehydrateFromArchiveDeps,
  assetId: string,
  classes: readonly ArchivableByteClass[]
): Promise<RehydrateFromArchiveResult | undefined> {
  // Guard: refuse any non-rehydratable class up front (ADR-019 D3), so we never
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
  const rehydrated: ArchivableByteClass[] = [];
  let objectsCopied = 0;
  let objectsDeleted = 0;

  for (const cls of classes) {
    // Idempotent no-op: a class NOT on `archive` is already hot (or never
    // archived) — nothing to restore. Count it as rehydrated so the caller sees
    // the target state, and ensure no stale in-flight marker lingers.
    if (currentTiers[cls] !== 'archive') {
      rehydrated.push(cls);
      continue;
    }

    // Mark the class in-flight BEFORE moving any bytes so a concurrent reader /
    // the operator sees the restore is underway (queued -> in-flight). The tier
    // stays `archive` until the copy completes.
    await deps.assets.setRehydrateState(assetId, cls, 'begin');

    const objects = objectsForClass(asset, cls, deps.sourceBucket, deps.destination.prefix);
    let classFullyRehydrated = true;

    for (const obj of objects) {
      try {
        // Detect an already-completed restore on re-run: the hot copy is present
        // and the archive object is already gone -> this object was restored by a
        // prior run, skip it.
        const hotPresent = await statOrUndefined(deps.client, obj.hotBucket, obj.hotKey);
        const archivePresent = await statOrUndefined(deps.client, deps.destination.bucket, obj.archiveKey);

        if (hotPresent && !archivePresent) {
          continue;
        }
        if (!hotPresent && !archivePresent) {
          // Bytes gone from BOTH tiers — cannot restore; leave class archived so
          // the situation stays visible (do not fabricate a hot tier).
          deps.logger?.warn?.(
            '[archive-rehydrate] %s object gone from BOTH hot and archive: %s/%s — leaving class archived',
            assetId,
            obj.hotBucket,
            obj.hotKey
          );
          classFullyRehydrated = false;
          continue;
        }

        // COPY archive -> hot (server-side), then VERIFY before deleting the cold
        // copy. copyObject is idempotent, so a re-run after a crash-before-delete
        // re-copies harmlessly.
        await deps.client.copyObject(
          obj.hotBucket,
          obj.hotKey,
          `/${deps.destination.bucket}/${obj.archiveKey}`
        );
        objectsCopied += 1;

        const verified = await statOrUndefined(deps.client, obj.hotBucket, obj.hotKey);
        if (!verified) {
          // Copy did not land — DO NOT delete the archive copy. Cold bytes stay
          // the recoverable source of truth; the class stays archived.
          deps.logger?.warn?.(
            '[archive-rehydrate] %s copy of %s/%s to hot could not be verified — archive retained',
            assetId,
            obj.hotBucket,
            obj.hotKey
          );
          classFullyRehydrated = false;
          continue;
        }

        // Delete the cold archive copy ONLY after the hot copy is verified.
        await deps.client.removeObject(deps.destination.bucket, obj.archiveKey);
        objectsDeleted += 1;
      } catch (err) {
        // Any failure for this object: leave archive bytes intact, do not flip the
        // class to hot. A later re-run heals it (best-effort per object).
        deps.logger?.warn?.(
          '[archive-rehydrate] %s failed to restore %s/%s: %o',
          assetId,
          obj.hotBucket,
          obj.hotKey,
          err
        );
        classFullyRehydrated = false;
      }
    }

    if (classFullyRehydrated) {
      // LAST step for this class: flip `archive -> hot` AND clear the in-flight
      // marker atomically (ADR-019 D4), via the dedicated rehydrate write path.
      await deps.assets.setRehydrateState(assetId, cls, 'complete');
      rehydrated.push(cls);
    }
    // On partial failure the in-flight marker is deliberately LEFT set so the
    // restore is observably incomplete and a re-run resumes it.
  }

  return { assetId, rehydrated, objectsCopied, objectsDeleted };
}

// Whether an asset currently has archived bytes in the classes a caller needs
// hot (ADR-019 D4 gating). Used by delivery / reprocessing flows to decide
// whether to trigger/await a restore rather than read against cold bytes.
export function classesNeedingRehydrate(
  asset: Asset,
  needed: readonly ArchivableByteClass[]
): ArchivableByteClass[] {
  const tiers = asset.storageTiering?.tiers ?? {};
  return needed.filter((cls) => tiers[cls] === 'archive');
}

// stat that resolves to undefined on a NotFound rather than throwing (mirrors
// the relocation engine's statOrUndefined).
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
