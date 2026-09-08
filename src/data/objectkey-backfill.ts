// Backfill `objectKey` for assets stranded by the single-part upload bug
// (issue #614).
//
// On affected deployments (e.g. a cluster running v1.3.1) the single-part
// completion flow did not persist `objectKey` onto the asset, so the source
// bytes landed in the source bucket under the deterministic key
// `sources/<assetId>` (asset-upload.ts `sourceObjectKey`) but the asset document
// carries an EMPTY `objectKey`. Every source-consuming operation
// (transcode/package/thumbnails/clip/export) reads `asset.objectKey`, so those
// assets are unusable. The finalize fix stops NEW assets stranding; it cannot
// repair the ones already created. This module is the one-off, idempotent
// remediation for the already-stranded assets.
//
// Design (dependency injection, mirroring src/tams/tams-backfill.ts): this
// function owns NONE of its collaborators. It accepts a `lister` (asset
// enumerator), a `probe` (source-object existence check), and an `updater`
// (the idempotent objectKey write), so it typechecks and tests without wiring a
// live MinIO client or CouchDB repo.
//
// SAFETY (issue #614 scope):
//   - Only assets whose `objectKey` is MISSING are candidates — an asset that
//     already carries an objectKey is left untouched (this is what makes a
//     re-run a no-op for already-fixed assets).
//   - A candidate is repaired ONLY when the source object is VERIFIABLY PRESENT
//     in the source bucket (probe returns a stat, not undefined). We never
//     fabricate a key for an asset with no underlying object — those are
//     reported as `skipped`, not touched.
//   - Every asset touched is logged (info per repair, per skip reason, and a
//     final summary), so an operator has a full audit of the run.
//
// Contract sources (cited, verified against this worktree):
//   - src/data/asset-repo.ts:
//       * `AssetRepository.list(opts?: ListOptions): Promise<ListResult>`
//         (interface line 709; InMemory impl line 1157).
//       * `AssetRepository.update(id, patch: UpdateAssetInput): Promise<Asset |
//         undefined>` (interface line 711; InMemory impl line 1185). `UpdateAssetInput`
//         (line 527) declares `objectKey?: string`, and InMemory.update writes it
//         verbatim (line 1198: `if (patch.objectKey !== undefined) next.objectKey = ...`).
//       * `ListOptions` (line 590) `{ limit?, offset?, status?, parentId?,
//         versionGroupId? }` and `ListResult` (line 601) `{ items: Asset[]; limit;
//         offset; total }` — offset/limit paging.
//       * `Asset.objectKey?: string` (line 420) — the field being backfilled.
//       * `MAX_LIMIT` (line 677, value 200) — page-size cap.
//   - src/routes/asset-upload.ts:
//       * `sourceObjectKey(assetId: string): string` (line 58) => `sources/<assetId>`
//         — the deterministic source-object key derivation the upload routes use.
//   - src/data/storage.ts:
//       * `WorkspaceStorage.statObject(localKey): Promise<{ size: number; etag:
//         string } | undefined>` (line 92) — returns undefined for a NotFound
//         object, a stat otherwise. This is the verified source-bucket presence
//         check; `undefined` => object absent.

import type { Asset, ListOptions, ListResult } from './asset-repo.js';
import { MAX_LIMIT } from './asset-repo.js';
import { sourceObjectKey } from '../routes/asset-upload.js';

// Minimal structured logger surface, matching src/tams/tams-backfill.ts. Injected
// so tests capture calls and the CLI wires console.
export type BackfillLogger = {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

// The enumeration surface — a structural subset of `AssetRepository`
// (src/data/asset-repo.ts line 709) so the real repo or a fake satisfies it.
export type AssetLister = {
  list(opts?: ListOptions): Promise<ListResult>;
};

// The objectKey write surface — a structural subset of `AssetRepository.update`
// (src/data/asset-repo.ts line 711). We only ever pass `{ objectKey }`.
export type AssetKeyUpdater = {
  update(id: string, patch: { objectKey: string }): Promise<Asset | undefined>;
};

// The source-object presence check — a structural subset of
// `WorkspaceStorage.statObject` (src/data/storage.ts line 92). Returns a stat
// when the object exists in the source bucket, or `undefined` when it does not.
// The remediation repairs a candidate ONLY when this resolves to a stat.
export type SourceObjectProbe = {
  statObject(localKey: string): Promise<{ size: number; etag: string } | undefined>;
};

export type ObjectKeyBackfillDeps = {
  lister: AssetLister;
  updater: AssetKeyUpdater;
  probe: SourceObjectProbe;
  logger: BackfillLogger;
  // Optional page-size override for enumeration. Defaults to MAX_LIMIT and is
  // clamped to (0, MAX_LIMIT]. Exposed mainly for tests.
  pageSize?: number;
  // When true (default false), enumerate + report what WOULD be repaired without
  // writing any objectKey. Lets an operator preview the blast radius on an
  // affected deployment before committing.
  dryRun?: boolean;
};

// Reason a candidate asset was NOT repaired. `no-object` — the source object is
// not present in the source bucket, so we refuse to fabricate a key (issue #614
// scope). `already-set` — the asset already carries an objectKey, so a re-run
// leaves it untouched (idempotency).
export type SkipReason = 'no-object' | 'already-set';

export type BackfillSkip = {
  assetId: string;
  reason: SkipReason;
};

export type BackfillFailure = {
  assetId: string;
  error: string;
};

// The summary a backfill run returns.
//   scanned  — assets enumerated across all pages.
//   repaired — stranded assets whose objectKey was backfilled from a confirmed
//              source object (0 on a dry run — nothing is written).
//   skipped  — assets not repaired, each with a reason (already-set / no-object).
//   failed   — assets whose update threw; the run continues past them.
//   dryRun   — echoes the mode so a summary is self-describing.
export type ObjectKeyBackfillSummary = {
  scanned: number;
  repaired: number;
  skipped: BackfillSkip[];
  failed: BackfillFailure[];
  dryRun: boolean;
};

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

// Backfill `objectKey` for assets stranded by the single-part upload bug.
//
// For each enumerated asset:
//   1. If it already has a non-empty `objectKey` -> skip `already-set`
//      (idempotent: a re-run touches nothing already fixed).
//   2. Otherwise derive the deterministic source key `sources/<assetId>` and
//      probe the source bucket. If the object is ABSENT -> skip `no-object`
//      (never fabricate a key). If PRESENT -> backfill `objectKey` (unless
//      dryRun) and count it repaired.
// Per-asset update failures are caught, recorded in `failed[]`, and the run
// continues — one bad asset never aborts the remediation.
export async function backfillStrandedObjectKeys(
  deps: ObjectKeyBackfillDeps
): Promise<ObjectKeyBackfillSummary> {
  const { lister, updater, probe, logger } = deps;
  const dryRun = deps.dryRun ?? false;

  const requested = deps.pageSize ?? MAX_LIMIT;
  const pageSize =
    Number.isFinite(requested) && requested > 0
      ? Math.min(MAX_LIMIT, Math.floor(requested))
      : MAX_LIMIT;

  const skipped: BackfillSkip[] = [];
  const failed: BackfillFailure[] = [];
  let scanned = 0;
  let repaired = 0;
  let offset = 0;
  let started = false;

  for (;;) {
    const page: ListResult = await lister.list({ limit: pageSize, offset });

    if (!started) {
      logger.info('objectkey-backfill: started', { total: page.total, dryRun });
      started = true;
    }

    for (const asset of page.items) {
      scanned += 1;

      // (1) Idempotency guard: an asset that already carries a source key is
      // healthy — leave it untouched so re-runs are a no-op for fixed assets.
      if (asset.objectKey && asset.objectKey.length > 0) {
        skipped.push({ assetId: asset.id, reason: 'already-set' });
        continue;
      }

      // (2) Verify the source object is actually present before backfilling.
      const key = sourceObjectKey(asset.id);
      let present: { size: number; etag: string } | undefined;
      try {
        present = await probe.statObject(key);
      } catch (err) {
        // A probe error is a per-asset failure, not a reason to fabricate a key
        // or to abort the run. Record it and move on.
        const message = errorMessage(err);
        failed.push({ assetId: asset.id, error: message });
        logger.error('objectkey-backfill: probe failed', {
          assetId: asset.id,
          objectKey: key,
          error: message
        });
        continue;
      }

      if (!present) {
        // No underlying object — do NOT fabricate a key (issue #614 scope).
        skipped.push({ assetId: asset.id, reason: 'no-object' });
        logger.info('objectkey-backfill: skipped (no source object)', {
          assetId: asset.id,
          objectKey: key
        });
        continue;
      }

      if (dryRun) {
        // Preview mode: report what would be repaired, write nothing.
        repaired += 1;
        logger.info('objectkey-backfill: would repair (dry run)', {
          assetId: asset.id,
          objectKey: key,
          sizeBytes: present.size
        });
        continue;
      }

      try {
        const updated = await updater.update(asset.id, { objectKey: key });
        if (!updated) {
          // The asset vanished between enumeration and write (e.g. purged).
          // Treat as a per-asset failure rather than a silent success.
          failed.push({ assetId: asset.id, error: 'asset not found on update' });
          logger.error('objectkey-backfill: update returned no asset', {
            assetId: asset.id
          });
          continue;
        }
        repaired += 1;
        logger.info('objectkey-backfill: repaired', {
          assetId: asset.id,
          objectKey: key,
          sizeBytes: present.size
        });
      } catch (err) {
        const message = errorMessage(err);
        failed.push({ assetId: asset.id, error: message });
        logger.error('objectkey-backfill: update failed', {
          assetId: asset.id,
          objectKey: key,
          error: message
        });
      }
    }

    offset += page.items.length;
    const consumedAll = offset >= page.total;
    const shortPage = page.items.length < pageSize;
    if (page.items.length === 0 || consumedAll || shortPage) {
      break;
    }
  }

  const summary: ObjectKeyBackfillSummary = {
    scanned,
    repaired,
    skipped,
    failed,
    dryRun
  };
  logger.info('objectkey-backfill: complete', {
    scanned: summary.scanned,
    repaired: summary.repaired,
    skipped: summary.skipped.length,
    failed: summary.failed.length,
    dryRun
  });
  return summary;
}
