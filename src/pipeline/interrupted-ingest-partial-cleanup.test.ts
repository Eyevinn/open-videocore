// Issue #1086: an interrupted URL pull leaves partial bytes in storage under a
// key whose job no longer exists, so they occupy the bucket indefinitely. When
// the boot reconciler settles such a job, those bytes must be reclaimed.
//
// Covers the issue's three acceptance criteria:
//   (1) the partial object is deleted when an interrupted job is settled;
//   (2) a storage deletion error is logged, and the job AND asset are still
//       settled;
//   (3) no deletion occurs for a job left alone because it is newer than
//       process start.
// Plus the guards that decide whether deleting here is SAFE at all: an asset
// that has already moved on keeps its (complete) object, an external-backend
// `s3://` key in someone else's bucket is never deleted, and a stack with no
// object storage is a silent no-op.
//
// Runs against the SAME InMemoryAssetRepository / InMemoryJobRepository the
// production paths use, so the state machine and the `objectKey` the pull route
// records behave exactly as in prod; only the storage client is a stub, because
// the real one needs a live MinIO.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - reconcileInterruptedIngests deps (`jobs`, `assets`, `storage`,
//     `processStartedAtMs`, `logger`) + `{ scanned, settled }` result:
//     src/pipeline/interrupted-ingest-reconciler.ts
//   - InterruptedPullCleanupStorage — the two methods cleanup calls — and the
//     real implementations it is structurally satisfied by:
//     WorkspaceStorage.removeObject(localKey): Promise<void>
//     (src/data/storage.ts:158-160) and
//     WorkspaceStorage.abortIncompleteMultipartUploads(localKey): Promise<number>
//     (src/data/storage.ts:260-272)
//   - The key cleanup resolves: Asset.objectKey (src/data/asset-repo.ts:559-560),
//     written as `ingest/<assetId>` by POST /ingest-url before the job is
//     created, and passed to the worker as PullParams.objectKey
//     (src/routes/assets.ts; src/pipeline/url-pull-worker.ts:93-106)
//   - The external-backend form that must NOT be deleted,
//     `s3://<bucket>/<key>`: src/routes/assets.ts POST /ingest-url sourceBackend branch
//   - INTERRUPTED_PULL_ERROR / INTERRUPTED_PULL_ASSET_REASON:
//     src/pipeline/interrupted-ingest-reconciler.ts
//   - InMemoryAssetRepository.create (starts `uploading`) / get / update and
//     CreateAssetInput.objectKey: src/data/asset-repo.ts
//   - InMemoryJobRepository.create/get/update and Job.type 'ingest-url' +
//     `pending -> running`: src/data/job-repo.ts
//   - Test shape (in-memory repos, relative liveness boundary, assert the record
//     and not just the summary): src/pipeline/interrupted-ingest-asset-settle.test.ts

import { describe, it, expect } from 'vitest';

import { InMemoryAssetRepository, type Asset, type AssetRepository } from '../data/asset-repo.js';
import { InMemoryJobRepository, type Job, type JobRepository } from '../data/job-repo.js';
import {
  reconcileInterruptedIngests,
  INTERRUPTED_PULL_ASSET_REASON,
  INTERRUPTED_PULL_ERROR,
  type InterruptedPullCleanupStorage
} from './interrupted-ingest-reconciler.js';

// A stub storage client that records what cleanup asked it to do. `removeFails`
// makes the delete throw the way an unreachable bucket would, without breaking
// the recording of the call itself.
function fakeStorage(opts: { removeFails?: Error; abortReturns?: number } = {}): {
  storage: InterruptedPullCleanupStorage;
  removed: string[];
  aborted: string[];
} {
  const removed: string[] = [];
  const aborted: string[] = [];
  return {
    removed,
    aborted,
    storage: {
      async abortIncompleteMultipartUploads(localKey: string): Promise<number> {
        aborted.push(localKey);
        return opts.abortReturns ?? 0;
      },
      async removeObject(localKey: string): Promise<void> {
        removed.push(localKey);
        if (opts.removeFails) throw opts.removeFails;
      }
    }
  };
}

// Build the shape issue #1086 describes: an asset created for a URL pull (so it
// starts `uploading`) carrying the `ingest/<assetId>` key the route records
// before the job exists, and its ingest-url job driven `pending -> running` by a
// worker whose process then died mid-stream.
async function interruptedPull(): Promise<{
  jobs: JobRepository;
  assets: AssetRepository;
  job: Job;
  asset: Asset;
  objectKey: string;
}> {
  const jobs = new InMemoryJobRepository();
  const assets = new InMemoryAssetRepository();

  const created = await assets.create({ name: 'pulled.mov' });
  // The route mints the key from the asset id and patches it on before creating
  // the job (src/routes/assets.ts POST /ingest-url).
  const objectKey = `ingest/${created.id}`;
  const asset = (await assets.update(created.id, { objectKey }))!;

  const createdJob = await jobs.create({
    type: 'ingest-url',
    assetId: asset.id,
    sourceUrl: 'https://example.com/source.mov'
  });
  const job = (await jobs.update(createdJob.id, { status: 'running' }))!;

  return { jobs, assets, job, asset, objectKey };
}

// The liveness boundary expressed relative to the job's own stamp, so nothing
// here depends on wall-clock timing.
function msAfter(job: Job, deltaMs: number): number {
  return Date.parse(job.updatedAt) + deltaMs;
}

describe('interrupted URL pull cleans up its partial bytes (issue #1086)', () => {
  // Acceptance 1: the partial object is deleted when an interrupted job is
  // settled — under the key the pull was writing, and with the staged parts of a
  // multipart transfer discarded too (those are not reachable as an object, so
  // the delete alone would leave them billing).
  it('deletes the partial object written for the interrupted pull', async () => {
    const { jobs, assets, job, asset, objectKey } = await interruptedPull();
    const { storage, removed, aborted } = fakeStorage({ abortReturns: 1 });

    const result = await reconcileInterruptedIngests({
      jobs,
      assets,
      storage: () => storage,
      // This process started a minute after the pull was last touched, so the
      // job cannot belong to a worker alive in it.
      processStartedAtMs: msAfter(job, 60_000)
    });

    expect(result).toEqual({ scanned: 1, settled: 1 });

    // The bytes: deleted under the pull's own key, exactly once.
    expect(removed).toEqual([objectKey]);
    // ...and the multipart upload a mid-stream death leaves open is discarded,
    // the same cleanup the in-process worker performs on terminal failure
    // (src/pipeline/url-pull-worker.ts discardOrphanedUpload, issue #1088).
    expect(aborted).toEqual([objectKey]);

    // The record halves (#1084/#1085) are unaffected by the cleanup.
    expect((await jobs.get(job.id))?.status).toBe('failed');
    expect((await jobs.get(job.id))?.error).toBe(INTERRUPTED_PULL_ERROR);
    const settled = (await assets.get(asset.id))!;
    expect(settled.status).toBe('failed');
    expect(settled.statusHistory[settled.statusHistory.length - 1].reason).toBe(
      INTERRUPTED_PULL_ASSET_REASON
    );
  });

  // Acceptance 2: a storage deletion error is LOGGED and the job and asset are
  // STILL settled. Cleanup runs after both durable writes and must never be able
  // to resurrect the "stuck running forever" defect #1084 fixed.
  it('logs a storage deletion error and still settles the job and the asset', async () => {
    const { jobs, assets, job, asset, objectKey } = await interruptedPull();
    const warnings: unknown[][] = [];
    const { storage, removed } = fakeStorage({ removeFails: new Error('minio unreachable') });

    const result = await reconcileInterruptedIngests({
      jobs,
      assets,
      storage: () => storage,
      processStartedAtMs: msAfter(job, 60_000),
      logger: { warn: (...a: unknown[]) => warnings.push(a) }
    });

    // The run does not throw and still reports the settle.
    expect(result).toEqual({ scanned: 1, settled: 1 });
    expect(removed).toEqual([objectKey]);

    // Both records are settled, exactly as if cleanup had succeeded.
    expect((await jobs.get(job.id))?.status).toBe('failed');
    expect((await jobs.get(job.id))?.error).toBe(INTERRUPTED_PULL_ERROR);
    expect((await assets.get(asset.id))?.status).toBe('failed');

    // The failure is reported, naming the key (so the bytes can be reclaimed by
    // hand) and carrying the thrown error itself — an Error does not survive
    // JSON.stringify, so assert on the value.
    expect(warnings).toHaveLength(1);
    const [format, loggedKey, loggedJobId, loggedAssetId, loggedErr] = warnings[0];
    expect(String(format)).toContain('failed to delete partial object');
    expect(loggedKey).toBe(objectKey);
    expect(loggedJobId).toBe(job.id);
    expect(loggedAssetId).toBe(asset.id);
    expect((loggedErr as Error).message).toBe('minio unreachable');
  });

  // A multipart abort that fails must not skip the object delete: the two
  // reclaim different bytes and neither depends on the other.
  it('still deletes the object when discarding the multipart upload fails', async () => {
    const { jobs, assets, job, objectKey } = await interruptedPull();
    const warnings: unknown[][] = [];
    const removed: string[] = [];

    const storage: InterruptedPullCleanupStorage = {
      async abortIncompleteMultipartUploads(): Promise<number> {
        throw new Error('list uploads denied');
      },
      async removeObject(localKey: string): Promise<void> {
        removed.push(localKey);
      }
    };

    const result = await reconcileInterruptedIngests({
      jobs,
      assets,
      storage: () => storage,
      processStartedAtMs: msAfter(job, 60_000),
      logger: { warn: (...a: unknown[]) => warnings.push(a) }
    });

    expect(result).toEqual({ scanned: 1, settled: 1 });
    expect(removed).toEqual([objectKey]);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toContain('failed to discard incomplete multipart upload');
  });

  // Acceptance 3: a job stamped AT OR AFTER process start may be a pull
  // streaming bytes right now. It is left alone — and so are its bytes, which is
  // the whole point: deleting the object under a live pull's key would corrupt a
  // transfer in progress.
  it('deletes nothing for a job left alone because it is newer than process start', async () => {
    const { jobs, assets, job, asset } = await interruptedPull();
    const { storage, removed, aborted } = fakeStorage();

    const result = await reconcileInterruptedIngests({
      jobs,
      assets,
      storage: () => storage,
      // Process started BEFORE the job's stamp, so the job may well be live.
      processStartedAtMs: msAfter(job, -60_000)
    });

    expect(result).toEqual({ scanned: 0, settled: 0 });
    expect(removed).toEqual([]);
    expect(aborted).toEqual([]);

    // Nothing was settled either — the job is still running and the asset still
    // uploading.
    expect((await jobs.get(job.id))?.status).toBe('running');
    expect((await assets.get(asset.id))?.status).toBe('uploading');
  });

  // An asset that has already moved on may be serving a COMPLETE object under
  // this key (a retried pull that succeeded, a later upload). The status guard
  // that protects the record must protect the bytes too.
  it('deletes nothing when the asset has already moved past uploading', async () => {
    const { jobs, assets, job, asset } = await interruptedPull();
    await assets.update(asset.id, { status: 'processing' });
    const { storage, removed, aborted } = fakeStorage();

    const result = await reconcileInterruptedIngests({
      jobs,
      assets,
      storage: () => storage,
      processStartedAtMs: msAfter(job, 60_000)
    });

    // The job is still settled (#1084 is not suppressed by the asset guard).
    expect(result).toEqual({ scanned: 1, settled: 1 });
    expect((await jobs.get(job.id))?.status).toBe('failed');
    // The bytes are untouched.
    expect(removed).toEqual([]);
    expect(aborted).toEqual([]);
    expect((await assets.get(asset.id))?.status).toBe('processing');
  });

  // An external-backend ingest records the source in place as
  // `s3://<bucket>/<key>` (src/routes/assets.ts). Those bytes live in the
  // customer's own bucket and were never written by a pull, so they must never
  // be deleted from here.
  it('never deletes an external-backend s3:// object', async () => {
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const created = await assets.create({ name: 'external.mov' });
    const asset = (await assets.update(created.id, {
      objectKey: 's3://customer-bucket/masters/external.mov'
    }))!;
    const createdJob = await jobs.create({
      type: 'ingest-url',
      assetId: asset.id,
      sourceUrl: 's3://customer-bucket/masters/external.mov'
    });
    const job = (await jobs.update(createdJob.id, { status: 'running' }))!;
    const { storage, removed, aborted } = fakeStorage();

    const result = await reconcileInterruptedIngests({
      jobs,
      assets,
      storage: () => storage,
      processStartedAtMs: msAfter(job, 60_000)
    });

    expect(result).toEqual({ scanned: 1, settled: 1 });
    expect(removed).toEqual([]);
    expect(aborted).toEqual([]);
  });

  // A stack with no object storage (bare local run / in-memory fallback) wrote
  // no bytes, so there is nothing to reclaim: the factory's undefined is a
  // silent no-op, and the settles still happen.
  it('settles without cleanup when the stack has no object storage', async () => {
    const { jobs, assets, job, asset } = await interruptedPull();
    const warnings: unknown[][] = [];

    const result = await reconcileInterruptedIngests({
      jobs,
      assets,
      storage: () => undefined,
      processStartedAtMs: msAfter(job, 60_000),
      logger: { warn: (...a: unknown[]) => warnings.push(a) }
    });

    expect(result).toEqual({ scanned: 1, settled: 1 });
    expect((await jobs.get(job.id))?.status).toBe('failed');
    expect((await assets.get(asset.id))?.status).toBe('failed');
    expect(warnings).toEqual([]);
  });

  // A storage factory that throws (connections could not be built for the
  // scanned stack) is logged and leaves both settles durable.
  it('logs and keeps both settles when storage cannot be resolved', async () => {
    const { jobs, assets, job, asset } = await interruptedPull();
    const warnings: unknown[][] = [];

    const result = await reconcileInterruptedIngests({
      jobs,
      assets,
      storage: async () => {
        throw new Error('stack connections unavailable');
      },
      processStartedAtMs: msAfter(job, 60_000),
      logger: { warn: (...a: unknown[]) => warnings.push(a) }
    });

    expect(result).toEqual({ scanned: 1, settled: 1 });
    expect((await jobs.get(job.id))?.status).toBe('failed');
    expect((await assets.get(asset.id))?.status).toBe('failed');
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toContain('could not resolve storage');
  });

  // Omitting the `storage` dependency keeps the exact pre-#1086 behaviour: the
  // records are settled and no storage call is attempted.
  it('makes no storage call when cleanup is not wired', async () => {
    const { jobs, assets, job, asset } = await interruptedPull();
    const warnings: unknown[][] = [];

    const result = await reconcileInterruptedIngests({
      jobs,
      assets,
      processStartedAtMs: msAfter(job, 60_000),
      logger: { warn: (...a: unknown[]) => warnings.push(a) }
    });

    expect(result).toEqual({ scanned: 1, settled: 1 });
    expect((await jobs.get(job.id))?.status).toBe('failed');
    expect((await assets.get(asset.id))?.status).toBe('failed');
    expect(warnings).toEqual([]);
  });

  // An asset with no recorded key cannot be cleaned up without guessing one,
  // which would risk deleting an unrelated object. Logged, never guessed.
  it('warns instead of guessing when the asset has no objectKey', async () => {
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'keyless.mov' });
    const createdJob = await jobs.create({
      type: 'ingest-url',
      assetId: asset.id,
      sourceUrl: 'https://example.com/source.mov'
    });
    const job = (await jobs.update(createdJob.id, { status: 'running' }))!;
    const warnings: unknown[][] = [];
    const { storage, removed, aborted } = fakeStorage();

    const result = await reconcileInterruptedIngests({
      jobs,
      assets,
      storage: () => storage,
      processStartedAtMs: msAfter(job, 60_000),
      logger: { warn: (...a: unknown[]) => warnings.push(a) }
    });

    expect(result).toEqual({ scanned: 1, settled: 1 });
    expect(removed).toEqual([]);
    expect(aborted).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0][0])).toContain('has no objectKey');
  });
});
