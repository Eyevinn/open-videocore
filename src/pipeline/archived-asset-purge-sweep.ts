// Archived-asset retention purge sweep (issue #327, part of the purge epic #323).
//
// An INDEPENDENT background sweep that purges archived assets past the retention
// window and REPLACES each with a tombstone. It is deliberately decoupled from
// the Encore auto-scaler tick (they own different concerns and cadences): the
// sweep is repo + storage driven and is wired as its own unref'd, overlap-
// guarded interval in main.ts, mirroring EncoreScalerLoop.start()
// (src/encore-scaler/scaler-loop.ts:41-59).
//
// SHAPE — this module mirrors reconcileFailedTranscodes
// (src/pipeline/failed-transcode-reconciler.ts): a pure `deps`-driven function
// returning a small `{ scanned, purged }` summary, BEST-EFFORT per asset — one
// asset's failure is logged and skipped and never aborts the run.
//
// ELIGIBILITY (issue constraints):
//   - Window: the timestamp of the LAST `-> archived` transition in
//     `statusHistory` (archivedAtOf, src/data/asset-tombstone.ts) — NOT
//     `updatedAt`. An asset is expired when now - archivedAt > retentionMs.
//   - Child ordering: an archived asset is eligible only if EVERY asset whose
//     `parentId` points at it is already a tombstone OR is purging earlier in
//     THIS same run. A parent with any live child is skipped and re-evaluated on
//     the next tick (children purge first; parents drain on later ticks).
//
// PER-ASSET PURGE STEPS (cross-bucket) — all removals are best-effort per object
// and never abort the asset's purge; the document replacement (tombstone) is the
// last step so a partial object removal still records the purge and lets a later
// tick (or an operator) reclaim any straggler:
//   1. source `objectKey` — source bucket.
//   2. each `renditions[].objectKey` — a plain key lives in the source bucket;
//      an `s3://bucket/key` URI (parseS3Uri, src/routes/assets.ts) may live in a
//      DIFFERENT bucket, so a WorkspaceStorage is built per target bucket exactly
//      as `GET /:id/files` does (src/routes/assets.ts).
//   3. EVERY object under `outputPrefix(assetId)` (src/pipeline/packaging.ts) in
//      `packagedBucket()` via `removeObjectsUnderPrefix` (src/data/storage.ts) —
//      the whole packaged-output prefix (segments + manifests).
//   4. each `subtitleTracks[].objectKey` and each `thumbnails[]` object — source
//      bucket.
//   5. REPLACE the CouchDB document with the tombstone via the injected `purge`
//      (the concrete repo's purgeToTombstone, which builds the tombstone from the
//      tombstone slice symbols toTombstoneDocument / ASSET_TOMBSTONE_TYPE).
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Result/skip-never-abort shape:   src/pipeline/failed-transcode-reconciler.ts:82-145
//   - Asset.statusHistory / renditions / subtitleTracks / thumbnails / parentId /
//     objectKey shapes + list({status})/ListResult: src/data/asset-repo.ts:183-338,425-549
//   - archivedAtOf (last `-> archived` at): src/data/asset-tombstone.ts:87-95
//   - parseS3Uri (s3://bucket/key parse):   src/routes/assets.ts:723-727
//   - WorkspaceStorage per-bucket construction + removeObject/removeObjectsUnderPrefix:
//     src/data/storage.ts:64-68,104-106,250-267; per-bucket build in GET /:id/files:
//     src/routes/assets.ts:1862-1864
//   - outputPrefix(assetId) / packagedBucket(): src/pipeline/packaging.ts:38-40,62-64
//   - purgeToTombstone (doc-replace to tombstone): src/data/couch-asset-repo.ts:360-378
//     (Couch) and src/data/asset-repo.ts:857-864 (in-memory)

import type { Asset, AssetRepository, ListResult } from '../data/asset-repo.js';
import { archivedAtOf } from '../data/asset-tombstone.js';
import { parseS3Uri } from '../routes/assets.js';
import { outputPrefix, packagedBucket } from './packaging.js';

// The minimal storage surface the sweep needs — a subset of WorkspaceStorage
// (src/data/storage.ts). Injected per bucket so the sweep can remove objects
// across the source bucket, an s3:// rendition's foreign bucket, and the
// packaged bucket without depending on a live MinIO client in tests.
export type PurgeStorage = {
  removeObject(localKey: string): Promise<void>;
  removeObjectsUnderPrefix(prefix: string): Promise<void>;
};

type Logger = {
  info?(...a: unknown[]): void;
  warn?(...a: unknown[]): void;
};

// How many archived assets to enumerate per sweep. list() paginates, so the
// sweep pages through every archived asset (offset walk) until the page is
// short — this bounds each list call while still covering the whole set.
const SCAN_PAGE_SIZE = 200;

export type PurgeExpiredArchivedAssetsDeps = {
  // Read side: enumerate archived assets (paged) and resolve child sets. Only
  // `list` is used here — the enumerate + child-ordering guard are both driven
  // by `list({ status })` / `list({ parentId })`.
  assets: AssetRepository;
  // Replace an archived asset's document with a tombstone (doc-replace). Returns
  // truthy on success. Bound in main.ts to the concrete repo's purgeToTombstone
  // (CouchAssetRepository.purgeToTombstone -> Promise<string | undefined>;
  // InMemoryAssetRepository.purgeToTombstone -> boolean), both of which build the
  // tombstone via toTombstoneDocument / ASSET_TOMBSTONE_TYPE. Kept as an injected
  // callback because purgeToTombstone is NOT on the AssetRepository interface.
  purge(assetId: string): Promise<string | boolean | undefined> | string | boolean | undefined;
  // Resolve a WorkspaceStorage-like handle for a bucket name. Bound in main.ts
  // to `(bucket) => new WorkspaceStorage(storageClient, bucket)`, mirroring the
  // per-bucket construction in GET /:id/files. Returns undefined when object
  // storage is not configured; the sweep then skips object removal (a tombstone
  // is still recorded so the read-path/exclusion semantics apply).
  storageForBucket(bucket: string): PurgeStorage | undefined;
  // The source bucket archived objectKeys (source, subtitles, thumbnails, and
  // plain-key renditions) live in. Bound to main.ts's `sourceBucket`.
  sourceBucket: string;
  // Retention window in ms. 0 / negative means disabled (never purge); the
  // caller (the loop) skips the sweep entirely when unset, but this is also
  // enforced here so a direct call is safe.
  retentionMs: number;
  // Injectable clock so the expiry check is deterministic in tests.
  now?: () => number;
  logger?: Logger;
};

export type PurgeExpiredArchivedAssetsResult = {
  scanned: number;
  purged: number;
};

// Enumerate archived assets and purge every one past its retention window,
// honouring the child-ordering guard. Best-effort per asset: one asset's error
// is logged and skipped and never aborts the run.
export async function purgeExpiredArchivedAssets(
  deps: PurgeExpiredArchivedAssetsDeps
): Promise<PurgeExpiredArchivedAssetsResult> {
  const now = deps.now ?? (() => Date.now());

  // Disabled window -> never purge. Behaviourally identical to today (matches
  // RETENTION_DISABLED_MS in src/routes/retention.ts).
  if (!Number.isFinite(deps.retentionMs) || deps.retentionMs <= 0) {
    return { scanned: 0, purged: 0 };
  }

  const cutoff = now() - deps.retentionMs;

  // Enumerate every archived asset, paged (list() paginates via limit/offset).
  const archived = await listAllArchived(deps.assets);

  // Track ids purged in THIS run so the child-ordering guard treats a child that
  // is purging earlier in the same run as already-gone (issue: "already a
  // tombstone OR is purging earlier in the same run").
  const purgedThisRun = new Set<string>();

  let scanned = 0;
  let purged = 0;

  for (const asset of archived) {
    scanned += 1;

    // Expiry: window measured from the LAST `-> archived` transition, not
    // updatedAt (archivedAtOf, src/data/asset-tombstone.ts).
    const archivedAtMs = Date.parse(archivedAtOf(asset));
    if (Number.isNaN(archivedAtMs) || archivedAtMs > cutoff) {
      // Not yet expired (or an unparseable stamp we refuse to purge on).
      continue;
    }

    // Child-ordering guard: skip a parent with any LIVE child (a child that is
    // neither already a tombstone nor purging earlier in this run). Such a
    // parent is left for a later tick, by which point its children have drained.
    let hasLiveChild: boolean;
    try {
      hasLiveChild = await anyLiveChild(deps.assets, asset.id, purgedThisRun);
    } catch (err) {
      deps.logger?.warn?.(
        '[archived-asset-purge] child-check failed for asset %s: %o',
        asset.id,
        err
      );
      continue;
    }
    if (hasLiveChild) {
      deps.logger?.info?.(
        '[archived-asset-purge] asset %s has live child assets — deferring purge',
        asset.id
      );
      continue;
    }

    try {
      await purgeOne(deps, asset);
      purgedThisRun.add(asset.id);
      purged += 1;
      deps.logger?.info?.('[archived-asset-purge] purged expired asset %s', asset.id);
    } catch (err) {
      // Best-effort: one asset's failure never aborts the run.
      deps.logger?.warn?.(
        '[archived-asset-purge] failed to purge asset %s: %o',
        asset.id,
        err
      );
    }
  }

  return { scanned, purged };
}

// Page through list({ status: 'archived' }) until a short page, collecting every
// archived asset. list() clamps limit and returns { items, total } (ListResult,
// src/data/asset-repo.ts), so the offset walk terminates.
async function listAllArchived(assets: AssetRepository): Promise<Asset[]> {
  const out: Asset[] = [];
  let offset = 0;
  // Bound the walk defensively against a repo that never shortens a page.
  for (;;) {
    const page: ListResult = await assets.list({
      status: 'archived',
      limit: SCAN_PAGE_SIZE,
      offset
    });
    out.push(...page.items);
    if (page.items.length < SCAN_PAGE_SIZE) {
      break;
    }
    offset += page.items.length;
    if (offset >= page.total) {
      break;
    }
  }
  return out;
}

// True when `parentId` has at least one LIVE child — an asset whose parentId is
// `parentId` that is NOT already a tombstone and NOT purging earlier in this run.
// A tombstoned former-child is excluded from list() by construction (its
// resourceType is no longer 'asset'), so it never appears here; a child purging
// earlier in this run is filtered via purgedThisRun.
async function anyLiveChild(
  assets: AssetRepository,
  parentId: string,
  purgedThisRun: Set<string>
): Promise<boolean> {
  let offset = 0;
  for (;;) {
    const page = await assets.list({
      parentId,
      limit: SCAN_PAGE_SIZE,
      offset
    });
    for (const child of page.items) {
      if (!purgedThisRun.has(child.id)) {
        return true; // a still-live child blocks the parent's purge
      }
    }
    if (page.items.length < SCAN_PAGE_SIZE) {
      break;
    }
    offset += page.items.length;
    if (offset >= page.total) {
      break;
    }
  }
  return false;
}

// Purge one archived asset across its buckets, then replace its document with a
// tombstone. Object removals are best-effort per object (a missing/blocked
// object is logged and skipped) so a partial storage state never blocks the
// document replacement — the sweep is idempotent and a later tick can re-reap
// stragglers.
async function purgeOne(
  deps: PurgeExpiredArchivedAssetsDeps,
  asset: Asset
): Promise<void> {
  const sourceStorage = deps.storageForBucket(deps.sourceBucket);

  // 1. Source object (source bucket).
  if (asset.objectKey && sourceStorage) {
    await removeObjectBestEffort(deps, sourceStorage, asset.objectKey, `source object of ${asset.id}`);
  }

  // 2. Renditions — plain key -> source bucket; s3://bucket/key -> that bucket
  //    (parseS3Uri + a WorkspaceStorage per target bucket, as GET /:id/files).
  for (const rendition of asset.renditions ?? []) {
    const s3 = parseS3Uri(rendition.objectKey);
    if (s3) {
      const rendStorage = deps.storageForBucket(s3.bucket);
      if (rendStorage) {
        await removeObjectBestEffort(deps, rendStorage, s3.key, `rendition ${rendition.id} of ${asset.id} (bucket ${s3.bucket})`);
      }
    } else if (sourceStorage) {
      await removeObjectBestEffort(deps, sourceStorage, rendition.objectKey, `rendition ${rendition.id} of ${asset.id}`);
    }
  }

  // 3. The WHOLE packaged-output prefix (segments + manifests) in the packaged
  //    bucket via removeObjectsUnderPrefix.
  const packaged = deps.storageForBucket(packagedBucket());
  if (packaged) {
    try {
      await packaged.removeObjectsUnderPrefix(outputPrefix(asset.id));
    } catch (err) {
      deps.logger?.warn?.(
        '[archived-asset-purge] failed to remove packaged prefix for asset %s: %o',
        asset.id,
        err
      );
    }
  }

  // 4. Subtitle tracks + thumbnails (source bucket).
  if (sourceStorage) {
    for (const track of asset.subtitleTracks ?? []) {
      if (track.objectKey) {
        await removeObjectBestEffort(deps, sourceStorage, track.objectKey, `subtitle ${track.id} of ${asset.id}`);
      }
    }
    for (const thumb of asset.thumbnails ?? []) {
      await removeObjectBestEffort(deps, sourceStorage, thumb, `thumbnail of ${asset.id}`);
    }
  }

  // 5. Replace the document with a tombstone (doc-replace). This is the LAST
  //    step and is NOT best-effort: a failure here throws so the asset is
  //    counted as not-purged and retried on the next tick.
  const result = await deps.purge(asset.id);
  if (result === false || result === undefined) {
    throw new Error(`purgeToTombstone reported no live asset for ${asset.id}`);
  }
}

// Remove one object, swallowing (logging) any failure so a single missing or
// blocked object never aborts the asset's purge.
async function removeObjectBestEffort(
  deps: PurgeExpiredArchivedAssetsDeps,
  storage: PurgeStorage,
  key: string,
  label: string
): Promise<void> {
  try {
    await storage.removeObject(key);
  } catch (err) {
    deps.logger?.warn?.(
      '[archived-asset-purge] failed to remove %s: %o',
      label,
      err
    );
  }
}
