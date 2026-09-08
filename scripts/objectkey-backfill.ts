// Thin CLI entry for the stranded-objectKey backfill (issue #614).
//
// Wires an asset lister, a source-bucket probe, and an objectKey updater into
// `backfillStrandedObjectKeys` (src/data/objectkey-backfill.ts) and runs it once,
// printing the machine-readable run summary as the final line.
//
// The remediation identifies assets whose `objectKey` is missing but whose source
// object (`sources/<assetId>`) is verifiably present in the source bucket, and
// backfills the confirmed key. It never fabricates a key for an asset with no
// underlying object, and re-running it is a no-op for already-fixed assets
// (idempotent) — see the core module for the full contract.
//
// OPERATIONAL WIRING (mirrors scripts/tams-backfill.ts): the request-independent,
// all-workspaces enumeration path and the shared MinIO source-bucket client are
// resolved per-request in the running app (WorkspaceStackResolver /
// createWorkspaceStorage), and there is no committed stand-alone operator
// enumeration entrypoint on main yet. So this script constructs SAFE, runnable
// defaults (an empty in-memory repo lister + a probe that reports every object
// absent), which make the run a well-defined no-op outside a live process. An
// operator runs the real remediation by replacing `makeLister` / `makeProbe` /
// `makeUpdater` below with the deployment's concrete repo + storage (the same
// PerWorkspaceAssetRepository + WorkspaceStorage the API wires in src/main.ts),
// pointed at the affected cluster. Every collaborator is injected precisely so
// that swap is a one-line change and the core logic stays fully tested.
//
// Run (dry run — preview, writes nothing):
//   tsx scripts/objectkey-backfill.ts --dry-run
// Run (apply):
//   tsx scripts/objectkey-backfill.ts

import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import type { Asset } from '../src/data/asset-repo.js';
import {
  backfillStrandedObjectKeys,
  type AssetKeyUpdater,
  type AssetLister,
  type BackfillLogger,
  type SourceObjectProbe
} from '../src/data/objectkey-backfill.js';

const logger: BackfillLogger = {
  info: (...args) => console.log(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args)
};

// The asset enumerator. The backfill only needs the verified
// `AssetRepository.list` contract (src/data/asset-repo.ts line 709), so any
// AssetRepository satisfies `AssetLister`.
//
// TODO(operator wiring): replace with the deployment's all-workspaces enumeration
// path (the PerWorkspaceAssetRepository / CouchAssetRepository the API wires),
// pointed at the affected cluster. The in-memory repo here yields zero assets, so
// the default run is a safe no-op.
function makeLister(): AssetLister {
  return new InMemoryAssetRepository();
}

// The objectKey updater. Same repo satisfies the verified
// `AssetRepository.update` contract (src/data/asset-repo.ts line 711); the
// backfill only ever writes `{ objectKey }`.
//
// TODO(operator wiring): use the SAME repo instance as the lister so the write
// lands in the real store.
function makeUpdater(): AssetKeyUpdater {
  return new InMemoryAssetRepository();
}

// The source-bucket presence probe. Must expose the verified
// `WorkspaceStorage.statObject` shape (src/data/storage.ts line 92): a stat when
// the object exists, `undefined` when it does not.
//
// TODO(operator wiring): replace with the deployment's source-bucket
// WorkspaceStorage (createWorkspaceStorage bound to the source bucket). The
// default here reports every object absent, so no key is ever fabricated on a
// misconfigured run.
function makeProbe(): SourceObjectProbe {
  return {
    async statObject(_localKey: string): Promise<{ size: number; etag: string } | undefined> {
      return undefined;
    }
  };
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const summary = await backfillStrandedObjectKeys({
    lister: makeLister(),
    updater: makeUpdater(),
    probe: makeProbe(),
    logger,
    dryRun
  });
  // Machine-readable summary as the final line for scripting/CI.
  console.log(JSON.stringify(summary));
  // Non-zero exit if any asset failed to repair, so a cron/CI invocation surfaces
  // partial failures without aborting the run itself.
  if (summary.failed.length > 0) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('objectkey-backfill: fatal', err);
  process.exitCode = 1;
});

// Silence unused-symbol noise for the type-only import kept for operator wiring.
export type { Asset };
