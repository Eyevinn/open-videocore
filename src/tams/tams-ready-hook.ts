// TAMS indexing trigger on the asset "ready" lifecycle transition
// (issue #172, sub-task of #116).
//
// PURPOSE
// -------
// When an ingested asset reaches the `ready` lifecycle state it should become
// automatically addressable in a Time-addressable Media Store (TAMS). This
// module provides the SINGLE chokepoint that fires the indexer at exactly that
// moment, and nowhere else.
//
// TRIGGER MECHANISM (justified per acceptance criterion 2)
// --------------------------------------------------------
// An INLINE transition hook, NOT a CouchDB `_changes` projector. Issue #168's
// contract discovery established that the ADR-005 PostgreSQL `_changes`
// projector does not exist in this codebase, so there is no changes-feed to
// hook. The inline transition-to-`ready` hook is therefore the only real
// mechanism available.
//
// WHERE IT FIRES (single chokepoint)
// ----------------------------------
// An asset reaches `ready` via `AssetRepository.update(id, { status: 'ready' })`
// (see src/data/asset-repo.ts `ASSET_STATUSES` + the `processing -> ['ready',
// ...]` machine). Four pipeline call sites do this: metadata-extractor.ts,
// transcode.ts, clip.ts, rewrap.ts. Rather than edit all four, this module
// DECORATES the repository at the composition root: `withTamsReadyIndexing`
// wraps a single `AssetRepository` so every `update()` that transitions an
// asset INTO `ready` fires the indexer once. This is the least-invasive single
// wiring point — the pipeline code is untouched and the trigger lives in one
// place.
//
// GUARANTEES
// ----------
//   - Fires ONLY on a transition INTO `ready` (was-not-ready -> is-ready), not
//     on every update and not when an already-`ready` asset is updated again.
//   - Config-gated: when TAMS is not configured (see `isTamsConfigured`) the
//     hook does nothing — no indexer is ever called.
//   - Non-blocking + failure-tolerant: the indexer runs AFTER the underlying
//     `update()` has already persisted `ready`. An indexer error is caught and
//     logged as a structured retryable warning; it NEVER throws back into or
//     rolls back the asset lifecycle update. `update()`'s result is returned to
//     the caller unchanged whether or not indexing succeeds.
//
// DECOUPLING (issue design constraint)
// ------------------------------------
// The concrete index-write path (#170) and the shared config gate (#171) are
// not yet on main, so this module imports NEITHER. Instead:
//   - the indexer is INJECTED as an `AssetIndexer` function, and
//   - the config gate is a minimal inline check of `TAMS_STORE_URL` per ADR-009
//     (`typeof v === 'string' && v.trim().length > 0`). When #171 lands it will
//     supply the shared gate; this local check is the interim equivalent.

import type { Asset, AssetRepository, UpdateAssetInput } from '../data/asset-repo.js';

// The injected indexing function. Shape: `(asset) => Promise<void>`. Given a
// freshly-`ready` asset, it addresses the asset's media into TAMS. The concrete
// implementation is supplied by the single-asset index-write path (#170) and
// injected at the composition root; this module never imports it directly.
export type AssetIndexer = (asset: Asset) => Promise<void>;

// Minimal structured logger surface (a subset of the Fastify logger). Kept as a
// tiny local interface so the hook has no logger dependency and tests can pass a
// stub. `warn` is used for the retryable indexing-failure log.
export interface HookLogger {
  warn(obj: unknown, msg?: string): void;
  info?(obj: unknown, msg?: string): void;
}

// Config gate (ADR-009). TAMS is "configured" when `TAMS_STORE_URL` is a
// non-empty, non-whitespace string. Inlined here per the issue design
// constraint; the shared gate from #171 (`src/tams/tams-config.ts`) will
// supersede this once merged. Reads the current environment on each call so a
// test can flip `process.env.TAMS_STORE_URL` between transitions.
export function isTamsConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = env['TAMS_STORE_URL'];
  return typeof v === 'string' && v.trim().length > 0;
}

// Whether a given update should fire the indexer: the asset transitioned INTO
// `ready`. `before` is the asset's status prior to the update (or undefined if
// the asset did not exist before). We fire only when it was NOT already `ready`
// and is now `ready`, so re-running an update on an already-`ready` asset does
// not double-fire.
function isTransitionIntoReady(before: string | undefined, after: string): boolean {
  return after === 'ready' && before !== 'ready';
}

// Fire the injected indexer for a freshly-`ready` asset, swallowing any error.
// NEVER throws. On failure it logs a structured, retryable warning so an
// operator (or a future retry sweep) can act. Awaited by the decorator so the
// caller's `update()` promise only resolves after the (best-effort) indexing
// attempt settles — but a rejection here can never propagate.
async function fireIndexer(
  indexer: AssetIndexer,
  asset: Asset,
  log: HookLogger
): Promise<void> {
  try {
    await indexer(asset);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      {
        event: 'tams.index.failed',
        assetId: asset.id,
        retryable: true,
        err: message
      },
      'TAMS indexing failed for ready asset; lifecycle unaffected, retry pending'
    );
  }
}

export interface TamsReadyIndexingOptions {
  // The injected indexer (#170). Required — the decorator is only installed at
  // the composition root when an indexer exists.
  indexer: AssetIndexer;
  // Structured logger for the retryable failure warning.
  log: HookLogger;
  // Override the config gate (tests). Defaults to the ADR-009 `TAMS_STORE_URL`
  // check, re-read on every update.
  isConfigured?: () => boolean;
}

// Decorate an `AssetRepository` so every `update()` that transitions an asset
// INTO `ready` fires the injected indexer exactly once. Returns a new object
// that delegates every method to the wrapped repository and only augments
// `update`. The wrapped repo is the source of truth; the lifecycle write happens
// first and its result is returned unchanged.
//
// Non-blocking / failure-tolerant contract:
//   1. `base.update(...)` runs and persists the (possibly `ready`) status. If it
//      throws (e.g. an invalid transition), that error propagates as before —
//      the hook adds no new failure modes to the lifecycle write.
//   2. Only AFTER a successful update, if the asset just entered `ready` and
//      TAMS is configured, the indexer is invoked via `fireIndexer`, which can
//      never throw. Whatever the indexer does, the already-persisted `ready`
//      result is returned to the caller.
export function withTamsReadyIndexing(
  base: AssetRepository,
  opts: TamsReadyIndexingOptions
): AssetRepository {
  const isConfigured = opts.isConfigured ?? (() => isTamsConfigured());

  const update = async (
    id: string,
    patch: UpdateAssetInput
  ): Promise<Asset | undefined> => {
    // Snapshot the pre-update status so we can detect a genuine transition INTO
    // `ready` (vs an update on an already-`ready` asset). Read before the write.
    // A read failure must not affect the lifecycle write, so treat it as
    // "unknown prior status" and proceed.
    let before: string | undefined;
    try {
      before = (await base.get(id))?.status;
    } catch {
      before = undefined;
    }

    // The lifecycle write is authoritative and runs exactly as before. Any error
    // it raises propagates untouched — indexing never suppresses a real failure.
    const updated = await base.update(id, patch);

    // Fire the indexer only on a real transition into `ready`, and only when
    // TAMS is configured. Everything here is best-effort and cannot throw back
    // into the caller.
    if (updated && isTransitionIntoReady(before, updated.status) && isConfigured()) {
      await fireIndexer(opts.indexer, updated, opts.log);
    }

    return updated;
  };

  // Delegate every other method to the wrapped repo; only `update` is augmented.
  return new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === 'update') {
        return update;
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    }
  });
}
