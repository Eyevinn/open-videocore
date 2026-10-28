// Object/location identity and stale-run guards in the superseded-output
// cleanup (issue #1044, review round 2).
//
// ADDITIVE to test/superseded-output-deletion.test.ts, which pins the RULE
// (confirm the replacement, then delete what it replaced). These tests pin the
// three things that rule rested on and that review proved wrong:
//
//   1. A record that omits `bucket` addresses the DELETE PATH'S DEFAULT bucket,
//      not "a different bucket". Compared as different, the equality/ancestor
//      KEEP guards were skipped and the legacy `{ prefix: '<assetId>/' }` case
//      would have deleted the replacement that sits under it.
//   2. The same physical object recorded as `transcode/a/j1/720p.mp4` and as
//      `s3://<bucket>/transcode/a/j1/720p.mp4` is ONE object. Compared
//      verbatim, the live rendition classified as superseded.
//   3. A LATE/redelivered callback for an OLDER run must not repoint the asset
//      backwards and then delete the newest generation.
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - `PackagedOutput` `{ bucket?, prefix?, masterHlsKey?, masterDashKey? }` —
//     src/data/asset-repo.ts:438 (every field optional, so a persisted record
//     may legitimately carry no bucket) and `Rendition.objectKey: string` —
//     src/data/asset-repo.ts:450.
//   - `objectKey` is recorded VERBATIM from the encoder callback
//     (`objectKey: o.file ?? ...` in `normaliseRenditions`, src/routes/internal.ts
//     and src/pipeline/encore-callback-poller.ts), hence both spellings.
//   - The delete path's default bucket: `resolveStorage(undefined)` ->
//     `new WorkspaceStorage(conns.storageClient, bucket ?? conns.packagedBucket)`
//     — src/main.ts (`resolveStackObjectStorage`).
//   - `Job.createdAt: string` — src/data/job-repo.ts:248 (set at create time by
//     both backends); `transcodeOutputPrefix(assetId, jobId)` =
//     `transcode/<assetId>/<jobId>` — src/pipeline/transcode.ts.
//   - `PackagerSuccessPayload` `{ url, jobId, outputPath? }` with jobId = assetId
//     (`packagingId(assetId) = assetId`) — src/pipeline/packaging.ts, which is
//     exactly why packaging has no run identity of its own and the guard reads
//     the `package` Job record instead.
//   - `WorkspaceStorage.removeObject` / `.removeObjectsUnderPrefix` —
//     src/data/storage.ts:158, :378 (what the fakes below stand in for).

import { describe, it, expect, vi } from 'vitest';

import {
  samePackagedLocation,
  supersededPackagedPrefix,
  supersededRenditionObjects,
  type SupersededOutputStorage
} from '../src/pipeline/superseded-output.js';
import {
  completeTranscode,
  transcodeRunIdFromObjectKey,
  type CallbackRendition
} from '../src/pipeline/transcode.js';
import {
  PackagingService,
  packagedBucket,
  packagedCallbackSupersededRun,
  type PackageQueue
} from '../src/pipeline/packaging.js';
import { InMemoryAssetRepository, type Rendition } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import {
  DEFAULT_PACKAGE_STALL_TIMEOUT_MS,
  reconcileStalledPackages
} from '../src/pipeline/stalled-package-reconciler.js';

const noopPackageQueue: PackageQueue = { enqueue: vi.fn(async () => {}) };

function recordingStorage() {
  const removedObjects: Array<{ bucket: string; key: string }> = [];
  const removedPrefixes: Array<{ bucket: string; prefix: string }> = [];
  const defaultBucket = packagedBucket();
  const resolveStorage = async (bucket?: string): Promise<SupersededOutputStorage> => {
    const target = bucket ?? defaultBucket;
    return {
      async removeObject(key: string) {
        removedObjects.push({ bucket: target, key });
      },
      async removeObjectsUnderPrefix(prefix: string) {
        removedPrefixes.push({ bucket: target, prefix });
      }
    };
  };
  return { removedObjects, removedPrefixes, resolveStorage, defaultBucket };
}

function rendition(id: string, objectKey: string): Rendition {
  return { id, label: id, width: 1920, height: 1080, objectKey };
}

function callbackRendition(label: string, objectKey: string): CallbackRendition {
  return { label, width: 1920, height: 1080, objectKey };
}

async function runningTranscodeJob(jobs: InMemoryJobRepository, assetId: string) {
  const job = await jobs.create({ type: 'transcode', assetId, profile: 'program' });
  await jobs.update(job.id, { status: 'queued' });
  await jobs.update(job.id, { status: 'running' });
  return job.id;
}

async function runningPackageJob(jobs: InMemoryJobRepository, assetId: string) {
  const job = await jobs.create({ type: 'package', assetId });
  await jobs.update(job.id, { status: 'running' });
  return job.id;
}

describe('a missing bucket is the delete path default, not a different bucket (#1044 review)', () => {
  it('keeps a bucket-less ANCESTOR prefix when the replacement sits under it', () => {
    // The proven failure: the legacy record carries no bucket (the schema makes
    // it optional) while the new one always does, so a raw string compare said
    // "different bucket", skipped the ancestor guard, and would have removed
    // `<assetId>/` — taking the new `<assetId>/<jobId>/` replacement with it.
    expect(
      supersededPackagedPrefix(
        { prefix: 'a1/' },
        { bucket: packagedBucket(), prefix: 'a1/j2/' },
        packagedBucket()
      )
    ).toBeUndefined();
  });

  it('keeps a bucket-less ancestor prefix even when the default bucket is unknown', () => {
    // No default to resolve against: an unnamed bucket could be any bucket, so
    // the guards must still fire rather than assume a difference.
    expect(
      supersededPackagedPrefix({ prefix: 'a1/' }, { bucket: 'pkg', prefix: 'a1/j2/' })
    ).toBeUndefined();
  });

  it('keeps a bucket-less prefix that EQUALS the replacement (overwrite in place)', () => {
    expect(
      supersededPackagedPrefix(
        { prefix: 'a1/j1/' },
        { bucket: packagedBucket(), prefix: 'a1/j1/' },
        packagedBucket()
      )
    ).toBeUndefined();
  });

  it('still selects the previous subfolder when the two buckets are PROVABLY different', () => {
    // Both buckets are named and disagree: the old location cannot contain the
    // new one, so the previous generation is genuinely orphaned.
    expect(
      supersededPackagedPrefix(
        { bucket: 'retired-bucket', prefix: 'a1/' },
        { bucket: packagedBucket(), prefix: 'a1/j2/' },
        packagedBucket()
      )
    ).toEqual({ bucket: 'retired-bucket', prefix: 'a1/' });
  });

  it('strips an s3:// scheme+bucket off a recorded prefix before comparing', () => {
    expect(
      supersededPackagedPrefix(
        { prefix: 's3://pkg/a1/' },
        { bucket: 'pkg', prefix: 'a1/j2/' },
        'pkg'
      )
    ).toBeUndefined();
    // ...and when it IS superseded, the delete target is the scheme-free prefix
    // in the bucket the URI named.
    expect(
      supersededPackagedPrefix({ prefix: 's3://pkg/a1/j1/' }, { bucket: 'pkg', prefix: 'a1/j2/' }, 'pkg')
    ).toEqual({ bucket: 'pkg', prefix: 'a1/j1/' });
  });

  it('compares packaged locations across spellings (samePackagedLocation)', () => {
    expect(samePackagedLocation({ prefix: 'a1/j1/' }, { bucket: 'pkg', prefix: 'a1/j1' }, 'pkg')).toBe(
      true
    );
    expect(
      samePackagedLocation({ bucket: 'pkg', prefix: 'a1/j1/' }, { bucket: 'pkg', prefix: 'a1/j2/' }, 'pkg')
    ).toBe(false);
    expect(samePackagedLocation(undefined, { bucket: 'pkg', prefix: 'a1/j1/' }, 'pkg')).toBe(false);
  });
});

describe('rendition identity is the resolved object, not its spelling (#1044 review)', () => {
  it('keeps a live rendition recorded scheme-qualified on one side and bare on the other', () => {
    // Same physical object, two spellings, both produced by the same callback
    // field. Classified as superseded it would have been DELETED while live.
    expect(
      supersededRenditionObjects(
        [rendition('r1', 'transcode/a/j1/720p.mp4')],
        [rendition('new-1', 's3://pkg/transcode/a/j1/720p.mp4')]
      )
    ).toEqual([]);
    expect(
      supersededRenditionObjects(
        [rendition('r1', 's3://pkg/transcode/a/j1/720p.mp4')],
        [rendition('new-1', 'transcode/a/j1/720p.mp4')]
      )
    ).toEqual([]);
  });

  it('keeps it when the bare key resolves to the named bucket via the default', () => {
    expect(
      supersededRenditionObjects(
        [rendition('r1', 'transcode/a/j1/720p.mp4')],
        [rendition('new-1', 's3://pkg/transcode/a/j1/720p.mp4')],
        [],
        'pkg'
      )
    ).toEqual([]);
  });

  it('keeps the asset source object across spellings too', () => {
    expect(
      supersededRenditionObjects(
        [rendition('r1', 's3://src/uploads/a/master.mov')],
        [rendition('new-1', 'transcode/a/j2/1080.mp4')],
        ['uploads/a/master.mov']
      )
    ).toEqual([]);
  });

  it('still selects a key in a PROVABLY different bucket', () => {
    // Both buckets known and different: not the same object, so the previous
    // generation's key is genuinely unreferenced and is removed from ITS bucket.
    expect(
      supersededRenditionObjects(
        [rendition('r1', 's3://retired/transcode/a/j1/720p.mp4')],
        [rendition('new-1', 'transcode/a/j1/720p.mp4')],
        [],
        'pkg'
      )
    ).toEqual([{ bucket: 'retired', key: 'transcode/a/j1/720p.mp4' }]);
  });

  it('de-duplicates two spellings of the same superseded object into one removal', () => {
    expect(
      supersededRenditionObjects(
        [
          rendition('r1', 'transcode/a/j1/720p.mp4'),
          rendition('r2', 's3://pkg/transcode/a/j1/720p.mp4')
        ],
        [rendition('new-1', 'transcode/a/j2/720p.mp4')],
        [],
        'pkg'
      )
    ).toEqual([{ key: 'transcode/a/j1/720p.mp4' }]);
  });
});

describe('a packaging re-run over a legacy bucket-less record deletes nothing (#1044 review)', () => {
  it('leaves the ancestor subfolder in place, so the new output survives', async () => {
    const storage = recordingStorage();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip' });
    // A legacy asset: the lazily-resolved prefix is just `<assetId>/`, with no
    // bucket recorded.
    await assets.update(asset.id, { packagedOutput: { prefix: `${asset.id}/` } });
    const svc = new PackagingService({
      assets,
      queue: noopPackageQueue,
      resolveStorage: storage.resolveStorage
    });

    await svc.handleSuccess({
      url: 'https://encore/j2',
      jobId: asset.id,
      outputPath: `${asset.id}/job-b/`
    });

    expect(storage.removedPrefixes).toEqual([]);
    const stored = await assets.get(asset.id);
    expect(stored?.packagedOutput?.prefix).toBe(`${asset.id}/job-b/`);
  });
});

describe('a packager callback for a superseded run is ignored (#1044 review)', () => {
  it('neither repoints the asset backwards nor deletes the newest generation', async () => {
    const storage = recordingStorage();
    const assets = new InMemoryAssetRepository();
    const jobs = new InMemoryJobRepository();
    const logWarn = vi.fn();
    const asset = await assets.create({ name: 'clip' });
    const svc = new PackagingService({
      assets,
      queue: noopPackageQueue,
      jobs,
      resolveStorage: storage.resolveStorage,
      logWarn
    });

    // Run 1 — enqueued, callback lands, job settles.
    await runningPackageJob(jobs, asset.id);
    await svc.handleSuccess({
      url: 'https://encore/j1',
      jobId: asset.id,
      outputPath: `${asset.id}/job-a/`
    });

    // Run 2 — a re-run: its callback supersedes run 1 and removes its subfolder.
    await runningPackageJob(jobs, asset.id);
    await svc.handleSuccess({
      url: 'https://encore/j2',
      jobId: asset.id,
      outputPath: `${asset.id}/job-b/`
    });
    expect(storage.removedPrefixes).toEqual([
      { bucket: packagedBucket(), prefix: `${asset.id}/job-a/` }
    ]);

    // Run 1's callback is REDELIVERED (the packager queue is at-least-once).
    // Nothing is in flight and the asset points elsewhere, so it is discarded.
    const handled = await svc.handleSuccess({
      url: 'https://encore/j1',
      jobId: asset.id,
      outputPath: `${asset.id}/job-a/`
    });

    expect(handled).toBe(true);
    // Run 2's subfolder — the newest generation — was NOT deleted.
    expect(storage.removedPrefixes).toEqual([
      { bucket: packagedBucket(), prefix: `${asset.id}/job-a/` }
    ]);
    // ...and the asset still points at it, not back at the deleted run 1.
    const stored = await assets.get(asset.id);
    expect(stored?.packagedOutput?.prefix).toBe(`${asset.id}/job-b/`);
    expect(logWarn).toHaveBeenCalled();
  });

  it('still handles a callback for the generation the asset already points at', async () => {
    // Same liveness ('settled'), same generation: an ordinary at-least-once
    // redelivery of the CURRENT run, which must stay idempotent rather than be
    // treated as stale.
    const storage = recordingStorage();
    const assets = new InMemoryAssetRepository();
    const jobs = new InMemoryJobRepository();
    const asset = await assets.create({ name: 'clip' });
    const svc = new PackagingService({
      assets,
      queue: noopPackageQueue,
      jobs,
      resolveStorage: storage.resolveStorage
    });

    await runningPackageJob(jobs, asset.id);
    await svc.handleSuccess({ url: 'https://encore/j1', jobId: asset.id, outputPath: `${asset.id}/job-a/` });
    const handled = await svc.handleSuccess({
      url: 'https://encore/j1',
      jobId: asset.id,
      outputPath: `${asset.id}/job-a/`
    });

    expect(handled).toBe(true);
    expect(storage.removedPrefixes).toEqual([]);
    const stored = await assets.get(asset.id);
    expect(stored?.packagedOutput?.prefix).toBe(`${asset.id}/job-a/`);
  });

  it('is evidence-based: no verdict without run liveness or a recorded generation', () => {
    const recorded = { bucket: 'pkg', prefix: 'a1/job-a/' };
    const incoming = { bucket: 'pkg', prefix: 'a1/job-b/' };
    expect(
      packagedCallbackSupersededRun({ recorded, incoming, liveness: 'settled', defaultBucket: 'pkg' })
    ).toBeTruthy();
    // A run IS in flight: the callback is plausibly its own.
    expect(
      packagedCallbackSupersededRun({ recorded, incoming, liveness: 'in-flight', defaultBucket: 'pkg' })
    ).toBeUndefined();
    // No job repository wired / lookup failed: no evidence, handle as before.
    expect(
      packagedCallbackSupersededRun({ recorded, incoming, liveness: 'unknown', defaultBucket: 'pkg' })
    ).toBeUndefined();
    // First package: nothing recorded to go backwards from.
    expect(
      packagedCallbackSupersededRun({
        recorded: undefined,
        incoming,
        liveness: 'settled',
        defaultBucket: 'pkg'
      })
    ).toBeUndefined();
    // Same location in a different spelling is NOT a different generation.
    expect(
      packagedCallbackSupersededRun({
        recorded: { prefix: 'a1/job-a/' },
        incoming: { bucket: 'pkg', prefix: 'a1/job-a/' },
        liveness: 'settled',
        defaultBucket: 'pkg'
      })
    ).toBeUndefined();
  });
});

describe('a late packager callback after the stall sweep is still applied (#1044 review, BLOCKING 5)', () => {
  // The sweep's `failed` means "we stopped waiting for the callback", not "the
  // run failed" — it fires after DEFAULT_PACKAGE_STALL_TIMEOUT_MS precisely for
  // lost/slow callbacks (src/pipeline/stalled-package-reconciler.ts). Read as
  // proof that a NEWER run had superseded this one, it discarded the genuine
  // late success whole: the asset stayed on the previous generation and the
  // fresh output was orphaned in the bucket.
  //
  // Contracts verified for this case (CLAUDE.md rule 7):
  //   - `PipelineRepository.create/update/listByAsset` and
  //     `StepExecution { name, status, jobId?, error?, startedAt? }` —
  //     src/data/pipeline-repo.ts (`update` patches `steps`; the sweep ages a
  //     step from `startedAt`).
  //   - `DEFAULT_PACKAGE_STALL_TIMEOUT_MS` (15 min) and
  //     `ReconcileStalledPackagesDeps { pipeline, jobs?, now?, stallTimeoutMs? }`
  //     — src/pipeline/stalled-package-reconciler.ts.
  //   - `JobRepository.findActiveByAssetId` returns the NON-TERMINAL set only
  //     (ACTIVE_JOB_STATUSES) — src/data/job-repo.ts, which is why a swept job
  //     disappears from the in-flight lookup.
  it('repoints the asset at the new output instead of orphaning it', async () => {
    const storage = recordingStorage();
    const assets = new InMemoryAssetRepository();
    const jobs = new InMemoryJobRepository();
    const pipeline = new InMemoryPipelineRepository();
    const asset = await assets.create({ name: 'clip' });
    const svc = new PackagingService({
      assets,
      queue: noopPackageQueue,
      jobs,
      pipeline,
      resolveStorage: storage.resolveStorage
    });

    // An earlier run packaged successfully: the asset points at job-a.
    await runningPackageJob(jobs, asset.id);
    await svc.handleSuccess({
      url: 'https://encore/j1',
      jobId: asset.id,
      outputPath: `${asset.id}/job-a/`
    });

    // The re-package is enqueued: a running `package` step carrying its job id,
    // started longer ago than the stall bound.
    const execution = await pipeline.create({
      assetId: asset.id,
      pipelineName: 'package',
      steps: ['package']
    });
    const stalledJobId = await runningPackageJob(jobs, asset.id);
    await pipeline.update(execution.id, {
      steps: [
        {
          name: 'package',
          status: 'running',
          jobId: stalledJobId,
          startedAt: new Date(Date.now() - DEFAULT_PACKAGE_STALL_TIMEOUT_MS - 60_000).toISOString()
        }
      ]
    });

    // The sweep gives up on it: step and job both settle `failed`.
    const swept = await reconcileStalledPackages({ pipeline, jobs });
    expect(swept.failed).toBe(1);
    expect((await jobs.get(stalledJobId))?.status).toBe('failed');

    // The packager finishes anyway and its SUCCESS callback arrives late.
    const handled = await svc.handleSuccess({
      url: 'https://encore/j2',
      jobId: asset.id,
      outputPath: `${asset.id}/job-b/`
    });

    expect(handled).toBe(true);
    // The asset now points at the output that was actually produced...
    const stored = await assets.get(asset.id);
    expect(stored?.packagedOutput?.prefix).toBe(`${asset.id}/job-b/`);
    expect(stored?.manifestUrls?.hls).toContain(`${asset.id}/job-b/index.m3u8`);
    // ...the fresh output was NOT deleted, and the generation it really did
    // supersede was reclaimed.
    expect(storage.removedPrefixes).toEqual([
      { bucket: packagedBucket(), prefix: `${asset.id}/job-a/` }
    ]);
  });

  it('treats an abandoned run as handleable, not as a superseded one', () => {
    const recorded = { bucket: 'pkg', prefix: 'a1/job-a/' };
    const incoming = { bucket: 'pkg', prefix: 'a1/job-b/' };
    expect(
      packagedCallbackSupersededRun({
        recorded,
        incoming,
        liveness: 'abandoned',
        defaultBucket: 'pkg'
      })
    ).toBeUndefined();
  });
});

describe('a transcode completion for a superseded run is ignored (#1044 review)', () => {
  it('reads the run id out of a recorded output key, in either spelling', () => {
    expect(transcodeRunIdFromObjectKey('a1', 'transcode/a1/job-7/1080.mp4')).toBe('job-7');
    expect(transcodeRunIdFromObjectKey('a1', 's3://pkg/transcode/a1/job-7/1080.mp4')).toBe('job-7');
    // Legacy/flat key: no per-run segment, so no run identity (and no evidence).
    expect(transcodeRunIdFromObjectKey('a1', 'transcode/a1/1080.mp4')).toBeUndefined();
    expect(transcodeRunIdFromObjectKey('a1', 'uploads/a1/master.mov')).toBeUndefined();
  });

  it('does not repoint the asset backwards or delete the newer run output', async () => {
    const storage = recordingStorage();
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const logWarn = vi.fn();
    const asset = await assets.create({ name: 'clip' });

    // Run 1 is submitted first and its callback is DELAYED.
    await assets.update(asset.id, { status: 'processing' });
    const job1 = await runningTranscodeJob(jobs, asset.id);
    // Distinct createdAt: the guard only fires on a STRICTLY newer referenced run.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const job2 = await runningTranscodeJob(jobs, asset.id);

    // Run 2 completes first and the asset now points at its output.
    await completeTranscode(
      {
        jobId: job2,
        sourceAssetId: asset.id,
        success: true,
        renditions: [callbackRendition('rendition-1', `transcode/${asset.id}/${job2}/2160.mp4`)]
      },
      { jobs, assets, resolveSupersededStorage: storage.resolveStorage, logWarn }
    );

    // Run 1's completion arrives LATE. Its job is still `running`, so the
    // per-jobId terminal guards do not stop it.
    const result = await completeTranscode(
      {
        jobId: job1,
        sourceAssetId: asset.id,
        success: true,
        renditions: [callbackRendition('rendition-1', `transcode/${asset.id}/${job1}/1080.mp4`)]
      },
      { jobs, assets, resolveSupersededStorage: storage.resolveStorage, logWarn }
    );

    expect(result.applied).toBe(false);
    expect(result.renditionCount).toBe(0);
    // The newest generation is untouched...
    expect(storage.removedObjects).toEqual([]);
    const stored = await assets.get(asset.id);
    expect(stored?.renditions?.map((r) => r.objectKey)).toEqual([
      `transcode/${asset.id}/${job2}/2160.mp4`
    ]);
    // ...and nothing was persisted for the superseded run.
    const staleJob = await jobs.get(job1);
    expect(staleJob?.status).toBe('running');
    expect(logWarn).toHaveBeenCalled();
  });

  it('applies a late completion when the asset references an OLDER run', async () => {
    // The ordinary re-run: run 2's completion lands while the asset still points
    // at run 1, so it is applied and run 1's objects are removed.
    const storage = recordingStorage();
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip' });

    await assets.update(asset.id, { status: 'processing' });
    const job1 = await runningTranscodeJob(jobs, asset.id);
    await completeTranscode(
      {
        jobId: job1,
        sourceAssetId: asset.id,
        success: true,
        renditions: [callbackRendition('rendition-1', `transcode/${asset.id}/${job1}/1080.mp4`)]
      },
      { jobs, assets, resolveSupersededStorage: storage.resolveStorage }
    );

    await new Promise((resolve) => setTimeout(resolve, 10));
    await assets.update(asset.id, { status: 'processing' });
    const job2 = await runningTranscodeJob(jobs, asset.id);
    const result = await completeTranscode(
      {
        jobId: job2,
        sourceAssetId: asset.id,
        success: true,
        renditions: [callbackRendition('rendition-1', `transcode/${asset.id}/${job2}/2160.mp4`)]
      },
      { jobs, assets, resolveSupersededStorage: storage.resolveStorage }
    );

    expect(result.applied).toBe(true);
    expect(storage.removedObjects).toEqual([
      { bucket: storage.defaultBucket, key: `transcode/${asset.id}/${job1}/1080.mp4` }
    ]);
  });
});
