// Abandoned-upload settle sweep (issue #726).
//
// An asset document is created in `uploading` BEFORE its bytes arrive
// (initialHistory: `null -> uploading`, src/data/asset-repo.ts:989-991). If the
// upload never completes — a cancelled tab, a dropped connection, or a body
// rejected before the route handler runs — the record stays in `uploading`
// forever: none of the six existing background loops inspects `uploading`, so
// nothing ever settles it. The quota reservation is already released on an
// abandoned upload (src/routes/asset-upload.ts:203; src/data/storage-quota.ts:32),
// so there is no resource leak — the only cost is a permanent orphan in the
// asset list that can never become usable.
//
// This sweep closes that gap in the shape of the archived-asset retention sweep
// (src/pipeline/archived-asset-purge-sweep.ts, issue #327): a pure `deps`-driven
// function returning a small `{ scanned, settled }` summary, BEST-EFFORT per
// asset — one asset's failure is logged and skipped and never aborts the run.
//
// ELIGIBILITY (issue #726 acceptance criteria):
//   - Enumerate assets in `uploading` (list({ status: 'uploading' })), paged.
//   - Settle one whose liveness stamp (`updatedAt`) is older than a configurable
//     threshold. `updatedAt` is a GENUINE liveness signal on this branch: the
//     upload-liveness heartbeat (issue #731) refreshes `updatedAt` on a still-
//     `uploading` asset on a fixed cadence — via AssetRepository.touchUploadProgress
//     (src/data/asset-repo.ts:1553-1565; couch-asset-repo.ts touchUploadProgress)
//     driven from the upload routes (src/routes/asset-upload.ts). So a slow-but-
//     progressing upload keeps moving `updatedAt` forward and is never settled,
//     even the presigned single-part / multipart paths whose bytes bypass the API.
//     The threshold must EXCEED the heartbeat cadence (and the longest legitimate
//     gap between heartbeats), so it is configurable (never fixed) — see
//     abandoned-upload-loop.ts.
//   - An upload still in progress is NEVER settled, however long it takes: the
//     eligibility is re-checked against a FRESH read immediately before the
//     write (get() → still `uploading` AND still past the cutoff), so a record
//     that advanced between the page snapshot and the write is left alone.
//
// SETTLE TARGET: `failed` (the `uploading -> failed` transition is allowed —
// ALLOWED_TRANSITIONS.uploading includes 'failed', src/data/asset-repo.ts:35).
// `failed` (rather than straight to `archived`) is chosen so a user can SEE that
// the upload never completed: the appended statusHistory entry is specifically
// `uploading -> failed` (distinct from a transcode failure's `processing ->
// failed`), which is self-documenting evidence that the upload — not the
// processing — is what did not complete. `failed` is also non-destructive and
// reversible (ALLOWED_TRANSITIONS.failed includes 'uploading', line 38), and the
// existing archived-asset purge loop still reclaims it once an operator or a
// later policy archives it.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Result / best-effort-skip-never-abort shape + paged offset walk:
//     src/pipeline/archived-asset-purge-sweep.ts:109-215
//   - AssetStatus values incl. 'uploading'/'failed' + uploading->failed allowed:
//     src/data/asset-repo.ts:28-38
//   - Asset.status / Asset.updatedAt / Asset.statusHistory shapes:
//     src/data/asset-repo.ts:457,501,583
//   - AssetRepository.list({ status })/ListResult, get(), update(id,{status}):
//     src/data/asset-repo.ts:692-708,840,846,887; applyStatus appends the
//     `uploading -> failed` history entry: src/data/asset-repo.ts:1080-1098

import type { Asset, AssetRepository, ListResult } from '../data/asset-repo.js';

type Logger = {
  info?(...a: unknown[]): void;
  warn?(...a: unknown[]): void;
};

// How many uploading assets to enumerate per list call. list() paginates, so the
// sweep pages through every uploading asset (offset walk) until the page is
// short — this bounds each list call while still covering the whole set.
const SCAN_PAGE_SIZE = 200;

export type SettleAbandonedUploadsDeps = {
  // Read + write side: enumerate uploading assets (paged), re-read one before
  // settling, and transition it to `failed` via update(). All three are on the
  // shared AssetRepository interface (unlike the archived sweep's purgeToTombstone),
  // so no injected callback is needed.
  assets: AssetRepository;
  // Liveness threshold in ms. An uploading asset is settled once
  // now - Date.parse(updatedAt) > thresholdMs. 0 / negative / non-finite means
  // disabled (never settle); the caller (the loop) skips the sweep entirely when
  // unset, but this is also enforced here so a direct call is safe.
  thresholdMs: number;
  // Injectable clock so the expiry check is deterministic in tests.
  now?: () => number;
  logger?: Logger;
};

export type SettleAbandonedUploadsResult = {
  scanned: number;
  settled: number;
};

// Enumerate uploading assets and settle every one whose liveness stamp is older
// than the threshold to `failed`. Best-effort per asset: one asset's error is
// logged and skipped and never aborts the run.
export async function settleAbandonedUploads(
  deps: SettleAbandonedUploadsDeps
): Promise<SettleAbandonedUploadsResult> {
  const now = deps.now ?? (() => Date.now());

  // Disabled threshold -> never settle. Behaviourally identical to today.
  if (!Number.isFinite(deps.thresholdMs) || deps.thresholdMs <= 0) {
    return { scanned: 0, settled: 0 };
  }

  const cutoff = now() - deps.thresholdMs;

  // Enumerate every uploading asset, paged (list() paginates via limit/offset).
  const uploading = await listAllUploading(deps.assets);

  let scanned = 0;
  let settled = 0;

  for (const asset of uploading) {
    scanned += 1;

    // Page-snapshot eligibility: liveness stamp older than the cutoff. An
    // unparseable stamp is refused (never settled) rather than settled on a bad
    // date.
    const updatedAtMs = Date.parse(asset.updatedAt);
    if (Number.isNaN(updatedAtMs) || updatedAtMs > cutoff) {
      continue; // still within the window (or an unparseable stamp)
    }

    try {
      // Re-read immediately before the write so an upload that advanced between
      // the page snapshot and now is NEVER settled (acceptance: "an upload still
      // in progress is never settled"). Only a record that is STILL `uploading`
      // AND STILL past the cutoff is eligible.
      const fresh = await deps.assets.get(asset.id);
      if (!fresh || fresh.status !== 'uploading') {
        continue; // advanced out of `uploading` (or gone) — leave it alone
      }
      const freshUpdatedMs = Date.parse(fresh.updatedAt);
      if (Number.isNaN(freshUpdatedMs) || freshUpdatedMs > cutoff) {
        continue; // touched since the snapshot — no longer eligible
      }

      // Settle to `failed`. update() validates uploading -> failed against the
      // state machine and appends the `uploading -> failed` statusHistory entry
      // (applyStatus, src/data/asset-repo.ts:1080-1098), which is the durable
      // evidence that the upload did not complete.
      const result = await deps.assets.update(asset.id, { status: 'failed' });
      if (result === undefined) {
        deps.logger?.warn?.(
          '[abandoned-upload-sweep] asset %s vanished before settle',
          asset.id
        );
        continue;
      }
      settled += 1;
      deps.logger?.info?.(
        '[abandoned-upload-sweep] settled abandoned upload %s to failed',
        asset.id
      );
    } catch (err) {
      // Best-effort: one asset's failure never aborts the run.
      deps.logger?.warn?.(
        '[abandoned-upload-sweep] failed to settle asset %s: %o',
        asset.id,
        err
      );
    }
  }

  return { scanned, settled };
}

// Page through list({ status: 'uploading' }) until a short page, collecting every
// uploading asset. list() clamps limit and returns { items, total } (ListResult,
// src/data/asset-repo.ts:703-708), so the offset walk terminates.
async function listAllUploading(assets: AssetRepository): Promise<Asset[]> {
  const out: Asset[] = [];
  let offset = 0;
  // Bound the walk defensively against a repo that never shortens a page.
  for (;;) {
    const page: ListResult = await assets.list({
      status: 'uploading',
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
