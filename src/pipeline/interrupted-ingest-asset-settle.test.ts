// Issue #1085: an interrupted URL pull must move its ASSET out of `uploading`
// when the boot reconciler settles the pull's job, under a reason that is
// distinct from the 24h abandoned-upload sweep's.
//
// Covers the issue's three acceptance criteria:
//   (1) after boot reconciliation the asset is `failed` and the LATEST
//       statusHistory entry carries the pull-interrupted reason;
//   (2) the abandoned-upload sweep still settles client uploads under its OWN,
//       different reason;
//   (3) an asset that is no longer `uploading` is left completely unchanged.
// Plus the half-write cases that decide whether this is safe in a store with no
// cross-document transaction: an asset write that throws must not undo or hide
// the job settle, and a second boot must not append a second history entry.
//
// Both settles run against the SAME InMemoryAssetRepository / InMemoryJobRepository
// the production code paths use, so the state machine, the appended history
// entry, and the `uploading -> failed` validation behave exactly as in prod.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - reconcileInterruptedIngests deps (`jobs`, `assets`, `processStartedAtMs`,
//     `assetReason`, `logger`) + `{ scanned, settled }` result + the per-job
//     fresh-read guard: src/pipeline/interrupted-ingest-reconciler.ts
//   - INTERRUPTED_PULL_ASSET_REASON (asset statusHistory reason) and
//     INTERRUPTED_PULL_ERROR (Job.error): same file
//   - ABANDONED_UPLOAD_REASON + settleAbandonedUploads deps
//     (`assets`, `thresholdMs`, `now`): src/pipeline/abandoned-upload-sweep.ts
//   - StatusTransition { at, from, to, reason? } and applyStatus() appending it
//     only on a real move: src/data/asset-repo.ts
//   - uploading -> failed allowed; processing/ready/archived are NOT settled by
//     either path (ALLOWED_TRANSITIONS): src/data/asset-repo.ts:28-38
//   - InMemoryAssetRepository.create (starts `uploading` with a `null -> uploading`
//     entry) / get / update: src/data/asset-repo.ts
//   - InMemoryJobRepository.create/get/update and Job.type 'ingest-url' +
//     `pending -> running`: src/data/job-repo.ts
//   - Test shape (in-memory repos, relative liveness boundary, assert the record
//     not just the summary): src/pipeline/interrupted-ingest-reconciler.test.ts

import { describe, it, expect } from 'vitest';

import {
  InMemoryAssetRepository,
  type Asset,
  type AssetRepository,
  type AssetStatus,
  type StatusTransition
} from '../data/asset-repo.js';
import { InMemoryJobRepository, type Job, type JobRepository } from '../data/job-repo.js';
import {
  reconcileInterruptedIngests,
  INTERRUPTED_PULL_ASSET_REASON,
  INTERRUPTED_PULL_ERROR
} from './interrupted-ingest-reconciler.js';
import {
  settleAbandonedUploads,
  ABANDONED_UPLOAD_REASON
} from './abandoned-upload-sweep.js';

// Build the exact shape issue #1085 describes: an asset created for a URL pull
// (so it starts in `uploading`, bytes not yet arrived) and its ingest-url job
// driven `pending -> running` by a worker whose process then died.
async function interruptedPull(): Promise<{
  jobs: JobRepository;
  assets: AssetRepository;
  job: Job;
  asset: Asset;
}> {
  const jobs = new InMemoryJobRepository();
  const assets = new InMemoryAssetRepository();

  const asset = await assets.create({ name: 'pulled.mov' });
  const created = await jobs.create({
    type: 'ingest-url',
    assetId: asset.id,
    sourceUrl: 'https://example.com/source.mov'
  });
  const job = (await jobs.update(created.id, { status: 'running' }))!;

  return { jobs, assets, job, asset };
}

// The liveness boundary expressed relative to the job's own stamp, so nothing
// here depends on wall-clock timing.
function msAfter(job: Job, deltaMs: number): number {
  return Date.parse(job.updatedAt) + deltaMs;
}

function latest(asset: Asset): StatusTransition {
  return asset.statusHistory[asset.statusHistory.length - 1];
}

describe('interrupted URL pull settles its asset (issue #1085)', () => {
  // Acceptance 1: after boot reconciliation the asset is `failed` and its newest
  // statusHistory entry names the interrupted pull.
  it('moves the pulled asset from uploading to failed with the pull-interrupted reason', async () => {
    const { jobs, assets, job, asset } = await interruptedPull();
    expect(asset.status).toBe('uploading');

    const result = await reconcileInterruptedIngests({
      jobs,
      assets,
      // This process started a minute after the pull was last touched, so the
      // job cannot belong to a worker alive in it.
      processStartedAtMs: msAfter(job, 60_000)
    });

    expect(result).toEqual({ scanned: 1, settled: 1 });

    // The job half (#1084) is unchanged by #1085.
    expect((await jobs.get(job.id))?.status).toBe('failed');
    expect((await jobs.get(job.id))?.error).toBe(INTERRUPTED_PULL_ERROR);

    // The asset half (#1085): settled in the same pass, not 24h later.
    const settled = (await assets.get(asset.id))!;
    expect(settled.status).toBe('failed');

    const entry = latest(settled);
    expect(entry.from).toBe('uploading');
    expect(entry.to).toBe('failed');
    expect(entry.reason).toBe(INTERRUPTED_PULL_ASSET_REASON);
    // The reason has to say WHY, not merely be non-empty.
    expect(entry.reason).toContain('interrupted');
    // ...and it must NOT be the sweep's reason, or the whole distinction this
    // issue exists for is lost.
    expect(entry.reason).not.toBe(ABANDONED_UPLOAD_REASON);

    // The creation entry survives (ADR-005: append, never rewrite).
    expect(settled.statusHistory).toHaveLength(2);
    expect(settled.statusHistory[0]).toMatchObject({ from: null, to: 'uploading' });
  });

  // Acceptance 2: the 24h client-upload sweep is untouched by this change — it
  // still settles an abandoned upload, under its OWN distinct reason.
  it('leaves the abandoned-upload sweep recording its own distinct reason', async () => {
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'client-upload.mov' });

    // Stamp the upload as abandoned: last touched well before the cutoff that a
    // 24h threshold implies (the #731 heartbeat is what would otherwise keep
    // `updatedAt` moving).
    const now = Date.parse('2026-06-01T00:00:00.000Z');
    const thresholdMs = 24 * 60 * 60 * 1000;
    await stampUpdatedAt(assets, asset.id, '2026-05-01T00:00:00.000Z');

    const result = await settleAbandonedUploads({
      assets,
      thresholdMs,
      now: () => now
    });

    expect(result).toEqual({ scanned: 1, settled: 1 });

    const settled = (await assets.get(asset.id))!;
    expect(settled.status).toBe('failed');

    const entry = latest(settled);
    expect(entry.from).toBe('uploading');
    expect(entry.to).toBe('failed');
    expect(entry.reason).toBe(ABANDONED_UPLOAD_REASON);
    // The two settles share the identical from/to pair, so the reason is the
    // ONLY thing distinguishing them — assert they really differ.
    expect(entry.reason).not.toBe(INTERRUPTED_PULL_ASSET_REASON);
    expect(ABANDONED_UPLOAD_REASON).not.toBe(INTERRUPTED_PULL_ASSET_REASON);
  });

  // Acceptance 3: an asset that has already moved on is NEVER overwritten. A
  // retried pull may have carried it to `processing`/`ready`, or an operator may
  // have archived it; the reconciler must not drag it back to `failed` or append
  // a history entry on top of someone else's state.
  it.each<AssetStatus>(['processing', 'ready', 'archived'])(
    'leaves an asset already in %s completely unchanged',
    async (status) => {
      const { jobs, assets, job, asset } = await interruptedPull();

      // Walk it out of `uploading` through legal transitions only.
      await assets.update(asset.id, { status: 'processing' });
      if (status !== 'processing') {
        await assets.update(asset.id, { status: status === 'ready' ? 'ready' : 'archived' });
      }
      const before = (await assets.get(asset.id))!;
      expect(before.status).toBe(status);

      const result = await reconcileInterruptedIngests({
        jobs,
        assets,
        processStartedAtMs: msAfter(job, 60_000)
      });

      // The JOB is still settled — the asset guard must not suppress #1084.
      expect(result).toEqual({ scanned: 1, settled: 1 });
      expect((await jobs.get(job.id))?.status).toBe('failed');

      // The ASSET is byte-identical: same status, same history (no appended
      // entry), same updatedAt (no write happened at all).
      const after = (await assets.get(asset.id))!;
      expect(after.status).toBe(status);
      expect(after.statusHistory).toEqual(before.statusHistory);
      expect(after.updatedAt).toBe(before.updatedAt);
      expect(after.statusHistory.some((t) => t.reason === INTERRUPTED_PULL_ASSET_REASON)).toBe(
        false
      );
    }
  );

  // A second boot must not append a second `uploading -> failed` entry: the job
  // is already terminal, so it is not a candidate, and even if it were the asset
  // is no longer `uploading`.
  it('is idempotent across repeated boots', async () => {
    const { jobs, assets, job, asset } = await interruptedPull();

    const first = await reconcileInterruptedIngests({
      jobs,
      assets,
      processStartedAtMs: msAfter(job, 60_000)
    });
    const afterFirst = (await assets.get(asset.id))!;

    const second = await reconcileInterruptedIngests({
      jobs,
      assets,
      processStartedAtMs: msAfter(job, 120_000)
    });

    expect(first).toEqual({ scanned: 1, settled: 1 });
    expect(second).toEqual({ scanned: 0, settled: 0 });

    const afterSecond = (await assets.get(asset.id))!;
    expect(afterSecond.statusHistory).toEqual(afterFirst.statusHistory);
    expect(afterSecond.statusHistory.filter((t) => t.to === 'failed')).toHaveLength(1);
  });

  // No cross-document transaction exists (CouchDB), so the asset write can fail
  // on its own. The job settle is already durable and must stay that way, the
  // run must not throw, and the failure must be logged — the asset then keeps
  // today's behaviour and the 24h sweep is its backstop.
  it('keeps the job settled and does not throw when the asset write fails', async () => {
    const { jobs, assets, job, asset } = await interruptedPull();
    const warnings: unknown[][] = [];

    // Break only the write, on the real repository, so get() still reports the
    // asset's genuine (unchanged) state afterwards.
    (assets as unknown as { update: () => Promise<Asset> }).update = async () => {
      throw new Error('couch unreachable');
    };

    const result = await reconcileInterruptedIngests({
      jobs,
      assets,
      processStartedAtMs: msAfter(job, 60_000),
      logger: { warn: (...a: unknown[]) => warnings.push(a) }
    });

    expect(result).toEqual({ scanned: 1, settled: 1 });
    expect((await jobs.get(job.id))?.status).toBe('failed');
    // Asset untouched, still awaiting the 24h sweep.
    expect((await assets.get(asset.id))?.status).toBe('uploading');
    // The failure is reported, carrying the thrown error itself (an Error does
    // not survive JSON.stringify, so assert on the value) and naming both
    // records so an operator can find them.
    expect(warnings).toHaveLength(1);
    const [format, loggedJobId, loggedAssetId, loggedErr] = warnings[0];
    expect(String(format)).toContain('failed to settle asset');
    expect(loggedJobId).toBe(job.id);
    expect(loggedAssetId).toBe(asset.id);
    expect((loggedErr as Error).message).toBe('couch unreachable');
  });

  // Omitting the `assets` dependency keeps the pre-#1085 behaviour exactly: the
  // job is settled and no asset is read or written.
  it('settles the job only when no asset repository is supplied', async () => {
    const { jobs, assets, job, asset } = await interruptedPull();

    const result = await reconcileInterruptedIngests({
      jobs,
      processStartedAtMs: msAfter(job, 60_000)
    });

    expect(result).toEqual({ scanned: 1, settled: 1 });
    expect((await jobs.get(job.id))?.status).toBe('failed');
    expect((await assets.get(asset.id))?.status).toBe('uploading');
  });
});

// Stamp `updatedAt` deterministically by reaching into the in-memory store, the
// same technique the existing sweep tests use (test/abandoned-upload-sweep.test.ts):
// create() stamps real time, and the sweep's eligibility is a function of that
// stamp. Does not touch status or history.
async function stampUpdatedAt(
  assets: AssetRepository,
  id: string,
  updatedAt: string
): Promise<void> {
  const store = (assets as unknown as { store: Map<string, Asset> }).store;
  const existing = store.get(id)!;
  store.set(id, { ...existing, updatedAt });
}
