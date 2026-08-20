// Thin CLI entry for the TAMS backfill re-index (issue #173).
//
// Wires a real asset lister + a single-asset indexer into `backfillTamsIndex`
// (src/tams/tams-backfill.ts) and runs it once, printing the run summary.
//
// IMPORTANT — unmerged dependency (#170): the concrete single-asset index write
// path lives in issue #170, which is NOT on main yet. Importing its factory here
// would fail to typecheck. So this script:
//   - constructs the lister eagerly (the real repo enumeration contract is on
//     main), and
//   - constructs the indexer LAZILY behind a clearly-marked TODO. Until #170
//     lands, the default indexer throws with a pointer to where the real factory
//     plugs in. `backfillTamsIndex` isolates per-asset indexer failures, so even
//     the placeholder degrades gracefully (every ready asset is recorded in
//     `failed[]` rather than aborting the process) — but the intent is that #170's
//     factory replaces `makeIndexer` below.
//
// The backfill is a NO-OP when TAMS is not configured (TAMS_STORE_URL unset or
// blank), so running this script with the bridge disabled is safe and cheap.
//
// Run:  tsx scripts/tams-backfill.ts
// (or wire a package.json script, e.g. "tams:backfill": "tsx scripts/tams-backfill.ts")

import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import type { Asset } from '../src/data/asset-repo.js';
import {
  backfillTamsIndex,
  type AssetLister,
  type BackfillLogger,
  type SingleAssetIndexer
} from '../src/tams/tams-backfill.js';

// Structured logger. Uses console at the three levels the backfill emits; a
// deployment can swap this for the app logger.
const logger: BackfillLogger = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args)
};

// Build the asset lister (the enumeration source). The backfill only needs the
// `list` method (the verified `AssetRepository.list` contract), so any
// AssetRepository satisfies `AssetLister`.
//
// TODO(#170 wiring): in production this should be the request-independent, all-
// workspaces enumeration path (e.g. a PerWorkspaceAssetRepository resolved
// against the operator's stack, or a direct CouchAssetRepository). The in-memory
// repo here is a safe, runnable default that yields zero assets outside a live
// process; replace it when the operational enumeration entrypoint is decided.
function makeLister(): AssetLister {
  return new InMemoryAssetRepository();
}

// Build the single-asset indexer — the idempotent #170 write path.
//
// TODO(#170): replace this placeholder with #170's real indexer factory, e.g.
//   `import { createTamsIndexer } from '../src/tams/<#170 module>.js';`
//   `return createTamsIndexer({ gateway, ... });`
// That factory is not on main yet, so we return a placeholder that throws. The
// backfill isolates the throw per asset (records it in `failed[]` and continues),
// keeping the script from silently claiming success before #170 lands.
function makeIndexer(): SingleAssetIndexer {
  return async (_asset: Asset): Promise<void> => {
    throw new Error(
      'single-asset TAMS indexer not wired: plug in the #170 indexer factory in scripts/tams-backfill.ts (makeIndexer)'
    );
  };
}

async function main(): Promise<void> {
  const summary = await backfillTamsIndex({
    lister: makeLister(),
    indexer: makeIndexer(),
    logger
  });
  // Emit the machine-readable summary as the final line for scripting/CI.
  console.log(JSON.stringify(summary));
  // Non-zero exit if any asset failed to index, so a CI/cron invocation surfaces
  // partial failures without aborting the run itself.
  if (summary.failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('tams-backfill: fatal', err);
  process.exitCode = 1;
});
