// Backfill re-index of existing assets into the TAMS store (issue #173,
// sub-task of #116).
//
// Assets that already existed before the TAMS bridge was enabled were never
// written into the Time-addressable Media Store. This module provides a single
// exported FUNCTION, `backfillTamsIndex`, that enumerates existing ready assets
// and hands each one to an injected single-asset indexer so it lands in TAMS.
//
// Design (dependency injection): this function OWNS none of the collaborators it
// needs. The single-asset index write (#170) and the config gate (#171) are not
// on main yet, so instead of importing their concrete exports we accept them as
// injected dependencies:
//   - `lister`  : an asset enumerator (the real `AssetRepository`, or a subset
//                 of it) exposing `list(opts?) => Promise<ListResult>`.
//   - `indexer` : the idempotent single-asset write path (#170). We CALL it per
//                 ready asset; we do NOT re-implement its idempotency. Because
//                 #170 is an idempotent upsert, running this backfill twice is
//                 safe (re-index = no-op/upsert).
//   - `logger`  : structured progress + per-asset failure logging.
//   - `env`     : the config source for the TAMS gate (defaults to process.env).
//
// Contract sources (cited, verified against the local clone):
//   - src/data/asset-repo.ts:
//       * `AssetRepository.list(opts?: ListOptions): Promise<ListResult>`
//         (interface line ~512; InMemory impl line ~827).
//       * `ListOptions` (line ~425): `{ limit?, offset?, status?, parentId?,
//         versionGroupId? }` — supports a server-side `status` filter, so we
//         pass `status: 'ready'`.
//       * `ListResult` (line ~436): `{ items: Asset[]; limit; offset; total }`
//         — offset/limit paging, so we page with offset += limit until we have
//         consumed `total` (or a short page).
//       * `MAX_LIMIT` (line ~485, value 200) — page size cap.
//       * `Asset` (line ~230) and its `status: AssetStatus` where `'ready'` is a
//         member of `ASSET_STATUSES` (line ~28).
//   - TAMS config gate: `TAMS_STORE_URL` env var, "configured" iff
//     `typeof v === 'string' && v.trim().length > 0` (per ADR-009's gate
//     grammar; mirrors the #171 config-gate check without importing it).

import type { Asset, ListOptions, ListResult } from '../data/asset-repo.js';
import { MAX_LIMIT } from '../data/asset-repo.js';

// The status a ready-to-serve asset carries (src/data/asset-repo.ts,
// ASSET_STATUSES line ~28). Only assets in this state are backfilled — non-ready
// assets have no servable media to address into TAMS yet.
const READY_STATUS = 'ready' as const;

// Env var that gates the whole TAMS bridge (ADR-009). Backfill is a no-op unless
// this is set to a non-empty string.
const TAMS_STORE_URL_KEY = 'TAMS_STORE_URL';

// Minimal structured logger surface, matching the shape used elsewhere in the
// codebase (see src/pipeline/encore-callback-poller.ts `Logger`). Injected so
// tests can capture calls and a script can wire console/pino.
export type BackfillLogger = {
  info(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

// The enumeration surface this backfill needs — a structural subset of
// `AssetRepository` (src/data/asset-repo.ts line ~512) so the real repo, or a
// fake, satisfies it. We only ever call `list`.
export type AssetLister = {
  list(opts?: ListOptions): Promise<ListResult>;
};

// The injected single-asset index write (#170). Given one asset, index it into
// TAMS. MUST be idempotent (re-index = no-op/upsert) — this function relies on
// that so repeated runs are safe; it does not add its own idempotency.
export type SingleAssetIndexer = (asset: Asset) => Promise<void>;

// Dependencies for `backfillTamsIndex`. All collaborators are injected so this
// module typechecks and tests without importing the unmerged #170/#171 code.
export type BackfillDeps = {
  lister: AssetLister;
  indexer: SingleAssetIndexer;
  logger: BackfillLogger;
  // Config source for the TAMS gate. Defaults to `process.env`. Injectable so
  // tests can drive the gate without mutating global env.
  env?: Record<string, string | undefined>;
  // Optional page size override for enumeration. Defaults to MAX_LIMIT and is
  // clamped to (0, MAX_LIMIT]. Exposed mainly for tests.
  pageSize?: number;
};

// One per-asset failure record. Carries the asset id and a normalized message so
// a run summary can report exactly which assets did not index and why, without
// leaking a thrown Error object across the boundary.
export type BackfillFailure = {
  assetId: string;
  error: string;
};

// The summary a backfill run returns. `total` is the number of ready assets
// enumerated; `indexed` succeeded; `failed` lists the ones whose indexer threw.
// `skipped` is the number of ready assets not attempted — always 0 on a normal
// run, and equal to `total` is impossible here, but the field exists so callers
// (and the no-op path) have a stable shape. On the unconfigured no-op path every
// count is 0.
export type BackfillSummary = {
  configured: boolean;
  total: number;
  indexed: number;
  skipped: number;
  failed: BackfillFailure[];
};

// True iff the TAMS store URL is configured per the ADR-009 gate grammar:
// a string with non-whitespace content.
function isTamsConfigured(env: Record<string, string | undefined>): boolean {
  const v = env[TAMS_STORE_URL_KEY];
  return typeof v === 'string' && v.trim().length > 0;
}

// Normalize a thrown value into a stable string for the failure record.
function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

// Backfill re-index of existing ready assets into TAMS.
//
// Behaviour (acceptance criteria of #173):
//   1. NO-OP when TAMS is not configured. If `TAMS_STORE_URL` is unset/blank we
//      log one line, call the indexer ZERO times, and return an all-zero summary
//      with `configured: false`.
//   2. Enumerates existing READY assets via `lister.list({ status: 'ready' })`,
//      paging through the offset/limit `ListResult` until exhausted, and calls
//      the injected idempotent `indexer` for each. Running twice is safe because
//      the indexer (#170) is an idempotent upsert — this function relies on that
//      and does not re-implement it.
//   3. Logs progress (run start with the total, per-asset ok) and ISOLATES
//      per-asset failures: a throwing indexer is caught, recorded in
//      `failed[]` as a structured error, and the run CONTINUES to the next
//      asset. It never aborts the whole run for one bad asset.
export async function backfillTamsIndex(deps: BackfillDeps): Promise<BackfillSummary> {
  const env = deps.env ?? process.env;
  const { lister, indexer, logger } = deps;

  if (!isTamsConfigured(env)) {
    // No-op path: TAMS bridge disabled. Log once, index nothing.
    logger.info('tams-backfill: skipped (TAMS not configured)', {
      env: TAMS_STORE_URL_KEY
    });
    return { configured: false, total: 0, indexed: 0, skipped: 0, failed: [] };
  }

  // Clamp the page size into (0, MAX_LIMIT]. `list` also clamps internally
  // (clampLimit), but we bound it here so our paging loop is well-defined.
  const requested = deps.pageSize ?? MAX_LIMIT;
  const pageSize =
    Number.isFinite(requested) && requested > 0
      ? Math.min(MAX_LIMIT, Math.floor(requested))
      : MAX_LIMIT;

  const failed: BackfillFailure[] = [];
  let indexed = 0;
  let total = 0;
  let offset = 0;
  let started = false;

  // Page through ready assets. `ListResult.total` is the full count matching the
  // filter; we stop once we have consumed it or the server returns a short page.
  for (;;) {
    const page: ListResult = await lister.list({
      status: READY_STATUS,
      limit: pageSize,
      offset
    });

    if (!started) {
      // Log the run start once, with the enumerated total, so operators see the
      // scope up front.
      logger.info('tams-backfill: started', { total: page.total });
      started = true;
    }
    total = page.total;

    for (const asset of page.items) {
      // Defensive: `list` filters server-side, but guard client-side too so a
      // backend that ignores the status filter still only indexes ready assets.
      if (asset.status !== READY_STATUS) {
        continue;
      }
      try {
        await indexer(asset);
        indexed += 1;
        logger.info('tams-backfill: indexed', { assetId: asset.id });
      } catch (err) {
        // Per-asset failure isolation: record and CONTINUE, do not abort.
        const message = errorMessage(err);
        failed.push({ assetId: asset.id, error: message });
        logger.error('tams-backfill: index failed', {
          assetId: asset.id,
          error: message
        });
      }
    }

    // Advance. Stop when the page was short (fewer than requested) or we have
    // walked past the reported total — either signals the end of enumeration.
    offset += page.items.length;
    const consumedAll = offset >= page.total;
    const shortPage = page.items.length < pageSize;
    if (page.items.length === 0 || consumedAll || shortPage) {
      break;
    }
  }

  const summary: BackfillSummary = {
    configured: true,
    total,
    indexed,
    skipped: 0,
    failed
  };
  logger.info('tams-backfill: complete', {
    total: summary.total,
    indexed: summary.indexed,
    failed: summary.failed.length
  });
  return summary;
}
