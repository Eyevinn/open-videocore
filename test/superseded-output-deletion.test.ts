// Deleting the output a pipeline re-run superseded (issue #1044).
//
// Re-running a pipeline repoints the asset (`renditions`, `manifestUrls` /
// `packagedOutput`) at the new generation but used to leave the previous one in
// storage: unreferenced through the API and never deleted. Packaged output is
// written under a per-run subfolder (`<assetId>/<packagerJobId>/`) and transcode
// output under `transcode/<assetId>/<jobId>/`, so run 2 lands BESIDE run 1.
//
// These tests pin the rule #1044 chose (option 1, per the maintainer's note in
// #1243): once the replacement is CONFIRMED written, the superseded generation is
// deleted — and nothing is deleted before that, nothing that is still
// referenced, and nothing at all on a failed re-run.
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - `WorkspaceStorage.removeObject(localKey)` / `.removeObjectsUnderPrefix(prefix)`
//     — src/data/storage.ts:158, :378 (the removal primitives the fakes below
//     stand in for, same structural subset as `PurgeStorage`,
//     src/pipeline/archived-asset-purge-sweep.ts:64).
//   - `Rendition` `{ id, label, width, height, objectKey, codec?, bitrateBps? }`
//     and `PackagedOutput` `{ bucket?, prefix?, masterHlsKey?, masterDashKey? }`
//     — src/data/asset-repo.ts:438, :450.
//   - `completeTranscode(params, deps)` / `CallbackRendition` — src/pipeline/transcode.ts;
//     `transcodeOutputPrefix(assetId, jobId)` = `transcode/<assetId>/<jobId>` there.
//   - `PackagerSuccessPayload` `{ url, jobId, outputPath? }` (jobId = assetId) and
//     `PackagingService.handleSuccess` — src/pipeline/packaging.ts; the
//     `<assetId>/<packagerJobId>/` subfolder shape is ADR-011
//     (`OutputSubfolderTemplate` default `$INPUTNAME$/$JOBID$`).
//   - `parseS3Uri(uri) -> { bucket, key } | null` — src/routes/assets.ts:1738.

import { describe, it, expect, vi } from 'vitest';

import {
  deleteSupersededOutput,
  supersededPackagedPrefix,
  supersededRenditionObjects,
  type SupersededOutputStorage
} from '../src/pipeline/superseded-output.js';
import { completeTranscode, type CallbackRendition } from '../src/pipeline/transcode.js';
import {
  PackagingService,
  packagedBucket,
  type PackageQueue
} from '../src/pipeline/packaging.js';
import { InMemoryAssetRepository, type Rendition } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';

const noopPackageQueue: PackageQueue = { enqueue: vi.fn(async () => {}) };

// A storage double recording what a deletion asked it to remove, per bucket.
function recordingStorage() {
  const removedObjects: Array<{ bucket: string; key: string }> = [];
  const removedPrefixes: Array<{ bucket: string; prefix: string }> = [];
  const defaultBucket = 'openvideocore-packaged';
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

// A `running` transcode job over an existing asset — the state a job is in when
// the Encore success callback lands.
async function runningTranscodeJob(jobs: InMemoryJobRepository, assetId: string) {
  const job = await jobs.create({ type: 'transcode', assetId, profile: 'program' });
  await jobs.update(job.id, { status: 'queued' });
  await jobs.update(job.id, { status: 'running' });
  return job.id;
}

function callbackRendition(label: string, objectKey: string): CallbackRendition {
  return { label, width: 1920, height: 1080, objectKey };
}

describe('superseded packaged prefix selection (issue #1044)', () => {
  it('selects the previous per-run subfolder when the re-run wrote a different one', () => {
    const superseded = supersededPackagedPrefix(
      { bucket: 'openvideocore-packaged', prefix: 'asset-1/job-a/' },
      { bucket: 'openvideocore-packaged', prefix: 'asset-1/job-b/' }
    );
    expect(superseded).toEqual({ bucket: 'openvideocore-packaged', prefix: 'asset-1/job-a/' });
  });

  it('selects nothing when the re-run wrote the same subfolder (overwrite in place)', () => {
    expect(
      supersededPackagedPrefix(
        { bucket: 'openvideocore-packaged', prefix: 'asset-1/job-a/' },
        { bucket: 'openvideocore-packaged', prefix: 'asset-1/job-a' }
      )
    ).toBeUndefined();
  });

  it('selects nothing when the new subfolder sits UNDER the previous prefix', () => {
    // A legacy asset's lazily-resolved prefix is just `<assetId>/`; removing it
    // would take the replacement with it.
    expect(
      supersededPackagedPrefix(
        { bucket: 'openvideocore-packaged', prefix: 'asset-1/' },
        { bucket: 'openvideocore-packaged', prefix: 'asset-1/job-b/' }
      )
    ).toBeUndefined();
  });

  it('selects nothing when the new generation recorded no prefix', () => {
    // Nothing is confirmed written, so the previous output is still the only
    // output and must be kept.
    expect(
      supersededPackagedPrefix({ bucket: 'openvideocore-packaged', prefix: 'asset-1/job-a/' }, undefined)
    ).toBeUndefined();
  });

  it('selects nothing when there was no previous prefix (first package)', () => {
    expect(
      supersededPackagedPrefix(undefined, { bucket: 'openvideocore-packaged', prefix: 'asset-1/job-b/' })
    ).toBeUndefined();
  });
});

describe('superseded rendition selection (issue #1044)', () => {
  it('selects previous rendition keys the new generation no longer references', () => {
    const stale = supersededRenditionObjects(
      [rendition('r1', 'transcode/a/job1/1080.mp4'), rendition('r2', 'transcode/a/job1/720.mp4')],
      [rendition('r3', 'transcode/a/job2/1080.mp4')]
    );
    expect(stale).toEqual([
      { key: 'transcode/a/job1/1080.mp4' },
      { key: 'transcode/a/job1/720.mp4' }
    ]);
  });

  it('selects nothing when the re-run reused the same keys (same-profile overwrite)', () => {
    const keys = [rendition('r1', 'transcode/a/1080.mp4'), rendition('r2', 'transcode/a/720.mp4')];
    const stale = supersededRenditionObjects(keys, [
      rendition('new-1', 'transcode/a/1080.mp4'),
      rendition('new-2', 'transcode/a/720.mp4')
    ]);
    expect(stale).toEqual([]);
  });

  it('keeps a key that is still referenced and removes only the dropped rung', () => {
    const stale = supersededRenditionObjects(
      [rendition('r1', 'transcode/a/1080.mp4'), rendition('r2', 'transcode/a/720.mp4')],
      [rendition('new-1', 'transcode/a/1080.mp4')]
    );
    expect(stale).toEqual([{ key: 'transcode/a/720.mp4' }]);
  });

  it('resolves an s3:// rendition key to its own bucket, and matches across both spellings', () => {
    const stale = supersededRenditionObjects(
      [rendition('r1', 's3://other-bucket/transcode/a/1080.mp4')],
      [rendition('new-1', 's3://other-bucket/transcode/a/1080.mp4')]
    );
    expect(stale).toEqual([]);

    const dropped = supersededRenditionObjects(
      [rendition('r1', 's3://other-bucket/transcode/a/1080.mp4')],
      [rendition('new-1', 'transcode/a/other.mp4')]
    );
    expect(dropped).toEqual([{ bucket: 'other-bucket', key: 'transcode/a/1080.mp4' }]);
  });

  it('never selects the asset source object, even if a rendition pointed at it', () => {
    const stale = supersededRenditionObjects(
      [rendition('r1', 'uploads/a/master.mov')],
      [rendition('new-1', 'transcode/a/1080.mp4')],
      ['uploads/a/master.mov']
    );
    expect(stale).toEqual([]);
  });
});

describe('deleteSupersededOutput — the shared delete path (issue #1044)', () => {
  it('removes the packaged subfolder and the stale rendition objects', async () => {
    const storage = recordingStorage();
    const result = await deleteSupersededOutput(
      {
        packagedPrefix: { bucket: 'openvideocore-packaged', prefix: 'asset-1/job-a/' },
        renditionObjects: [{ key: 'transcode/asset-1/job1/1080.mp4' }, { bucket: 'other', key: 'x.mp4' }]
      },
      { resolveStorage: storage.resolveStorage }
    );
    expect(result.prefixRemoved).toBe('asset-1/job-a/');
    expect(result.objectsRemoved).toBe(2);
    expect(result.errors).toEqual([]);
    expect(storage.removedPrefixes).toEqual([
      { bucket: 'openvideocore-packaged', prefix: 'asset-1/job-a/' }
    ]);
    expect(storage.removedObjects).toEqual([
      { bucket: 'openvideocore-packaged', key: 'transcode/asset-1/job1/1080.mp4' },
      { bucket: 'other', key: 'x.mp4' }
    ]);
  });

  it('collects a storage failure instead of throwing, and still tries the rest', async () => {
    const logWarn = vi.fn();
    const result = await deleteSupersededOutput(
      {
        packagedPrefix: { prefix: 'asset-1/job-a/' },
        renditionObjects: [{ key: 'k1' }, { key: 'k2' }]
      },
      {
        resolveStorage: async () => ({
          removeObject: async (key: string) => {
            if (key === 'k1') throw new Error('object store refused');
          },
          removeObjectsUnderPrefix: async () => {
            throw new Error('prefix listing failed');
          }
        }),
        logWarn
      }
    );
    expect(result.prefixRemoved).toBeUndefined();
    expect(result.objectsRemoved).toBe(1);
    expect(result.errors).toHaveLength(2);
    expect(logWarn).toHaveBeenCalledTimes(1);
  });

  it('records a reason and removes nothing when object storage is not configured', async () => {
    const result = await deleteSupersededOutput(
      { packagedPrefix: { prefix: 'asset-1/job-a/' } },
      { resolveStorage: async () => undefined }
    );
    expect(result.prefixRemoved).toBeUndefined();
    expect(result.errors).toEqual(['object storage is not configured for this stack']);
  });

  it('resolves no storage at all when there is nothing to delete', async () => {
    const resolveStorage = vi.fn(async () => undefined);
    const result = await deleteSupersededOutput({}, { resolveStorage });
    expect(result).toEqual({ objectsRemoved: 0, errors: [] });
    expect(resolveStorage).not.toHaveBeenCalled();
  });
});

describe('a packaging re-run deletes the subfolder it superseded (issue #1044)', () => {
  it('removes the previous per-run subfolder after the asset points at the new one', async () => {
    const storage = recordingStorage();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip' });
    const svc = new PackagingService({
      assets,
      queue: noopPackageQueue,
      resolveStorage: storage.resolveStorage
    });

    await svc.handleSuccess({ url: 'https://encore/j1', jobId: asset.id, outputPath: `${asset.id}/job-a/` });
    // First package: nothing was superseded, so nothing is removed.
    expect(storage.removedPrefixes).toEqual([]);

    await svc.handleSuccess({ url: 'https://encore/j2', jobId: asset.id, outputPath: `${asset.id}/job-b/` });

    expect(storage.removedPrefixes).toEqual([
      { bucket: packagedBucket(), prefix: `${asset.id}/job-a/` }
    ]);
    // ...and the asset now points at the new generation only.
    const stored = await assets.get(asset.id);
    expect(stored?.packagedOutput?.prefix).toBe(`${asset.id}/job-b/`);
  });

  it('removes nothing when the re-run reported the same subfolder', async () => {
    const storage = recordingStorage();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip' });
    const svc = new PackagingService({
      assets,
      queue: noopPackageQueue,
      resolveStorage: storage.resolveStorage
    });

    await svc.handleSuccess({ url: 'https://encore/j1', jobId: asset.id, outputPath: `${asset.id}/job-a/` });
    await svc.handleSuccess({ url: 'https://encore/j1', jobId: asset.id, outputPath: `${asset.id}/job-a/` });

    expect(storage.removedPrefixes).toEqual([]);
  });

  it('removes nothing when the re-run reported no outputPath (no confirmed replacement)', async () => {
    const storage = recordingStorage();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip' });
    const svc = new PackagingService({
      assets,
      queue: noopPackageQueue,
      resolveStorage: storage.resolveStorage
    });

    await svc.handleSuccess({ url: 'https://encore/j1', jobId: asset.id, outputPath: `${asset.id}/job-a/` });
    await svc.handleSuccess({ url: 'https://encore/j2', jobId: asset.id });

    expect(storage.removedPrefixes).toEqual([]);
    const stored = await assets.get(asset.id);
    expect(stored?.packagedOutput?.prefix).toBe(`${asset.id}/job-a/`);
  });

  it('removes nothing on a packaging FAILURE callback', async () => {
    const storage = recordingStorage();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip' });
    const svc = new PackagingService({
      assets,
      queue: noopPackageQueue,
      resolveStorage: storage.resolveStorage
    });

    await svc.handleSuccess({ url: 'https://encore/j1', jobId: asset.id, outputPath: `${asset.id}/job-a/` });
    await svc.handleFailure(asset.id, 'packager exploded');

    expect(storage.removedPrefixes).toEqual([]);
    const stored = await assets.get(asset.id);
    expect(stored?.packagedOutput?.prefix).toBe(`${asset.id}/job-a/`);
  });
});

describe('a transcode re-run deletes the renditions it superseded (issue #1044)', () => {
  it('removes the previous run output after the new renditions are on the asset', async () => {
    const storage = recordingStorage();
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip' });

    // Run 1.
    await assets.update(asset.id, { status: 'processing' });
    const job1 = await runningTranscodeJob(jobs, asset.id);
    await completeTranscode(
      {
        jobId: job1,
        sourceAssetId: asset.id,
        success: true,
        renditions: [
          callbackRendition('rendition-1', `transcode/${asset.id}/${job1}/1080.mp4`),
          callbackRendition('rendition-2', `transcode/${asset.id}/${job1}/720.mp4`)
        ]
      },
      { jobs, assets, resolveSupersededStorage: storage.resolveStorage }
    );
    // First run supersedes nothing.
    expect(storage.removedObjects).toEqual([]);

    // Run 2 — a different profile, so new keys under a new job prefix.
    await assets.update(asset.id, { status: 'processing' });
    const job2 = await runningTranscodeJob(jobs, asset.id);
    await completeTranscode(
      {
        jobId: job2,
        sourceAssetId: asset.id,
        success: true,
        renditions: [callbackRendition('rendition-1', `transcode/${asset.id}/${job2}/2160.mp4`)]
      },
      { jobs, assets, resolveSupersededStorage: storage.resolveStorage }
    );

    expect(storage.removedObjects).toEqual([
      { bucket: storage.defaultBucket, key: `transcode/${asset.id}/${job1}/1080.mp4` },
      { bucket: storage.defaultBucket, key: `transcode/${asset.id}/${job1}/720.mp4` }
    ]);
    // The live generation is intact and is the only one referenced.
    const stored = await assets.get(asset.id);
    expect(stored?.renditions?.map((r) => r.objectKey)).toEqual([
      `transcode/${asset.id}/${job2}/2160.mp4`
    ]);
  });

  it('removes nothing when the re-run overwrote the same rendition keys in place', async () => {
    const storage = recordingStorage();
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip' });
    const sameKey = `transcode/${asset.id}/1080.mp4`;

    await assets.update(asset.id, { status: 'processing' });
    const job1 = await runningTranscodeJob(jobs, asset.id);
    await completeTranscode(
      { jobId: job1, sourceAssetId: asset.id, success: true, renditions: [callbackRendition('rendition-1', sameKey)] },
      { jobs, assets, resolveSupersededStorage: storage.resolveStorage }
    );

    await assets.update(asset.id, { status: 'processing' });
    const job2 = await runningTranscodeJob(jobs, asset.id);
    await completeTranscode(
      { jobId: job2, sourceAssetId: asset.id, success: true, renditions: [callbackRendition('rendition-1', sameKey)] },
      { jobs, assets, resolveSupersededStorage: storage.resolveStorage }
    );

    expect(storage.removedObjects).toEqual([]);
  });

  it('a FAILED re-run never destroys the working output', async () => {
    const storage = recordingStorage();
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip' });
    const liveKey = `transcode/${asset.id}/job1/1080.mp4`;

    await assets.update(asset.id, { status: 'processing' });
    const job1 = await runningTranscodeJob(jobs, asset.id);
    await completeTranscode(
      { jobId: job1, sourceAssetId: asset.id, success: true, renditions: [callbackRendition('rendition-1', liveKey)] },
      { jobs, assets, resolveSupersededStorage: storage.resolveStorage }
    );

    await assets.update(asset.id, { status: 'processing' });
    const job2 = await runningTranscodeJob(jobs, asset.id);
    await completeTranscode(
      { jobId: job2, sourceAssetId: asset.id, success: false, error: 'encode blew up', renditions: [] },
      { jobs, assets, resolveSupersededStorage: storage.resolveStorage }
    );

    expect(storage.removedObjects).toEqual([]);
    const stored = await assets.get(asset.id);
    expect(stored?.renditions?.map((r) => r.objectKey)).toEqual([liveKey]);
  });

  it('a duplicate completion for an already-done job removes nothing', async () => {
    const storage = recordingStorage();
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip' });
    const liveKey = `transcode/${asset.id}/job1/1080.mp4`;

    await assets.update(asset.id, { status: 'processing' });
    const job1 = await runningTranscodeJob(jobs, asset.id);
    const payload = {
      jobId: job1,
      sourceAssetId: asset.id,
      success: true,
      renditions: [callbackRendition('rendition-1', liveKey)]
    };
    await completeTranscode(payload, { jobs, assets, resolveSupersededStorage: storage.resolveStorage });
    const second = await completeTranscode(payload, {
      jobs,
      assets,
      resolveSupersededStorage: storage.resolveStorage
    });

    expect(second.applied).toBe(false);
    expect(storage.removedObjects).toEqual([]);
    const stored = await assets.get(asset.id);
    expect(stored?.renditions?.map((r) => r.objectKey)).toEqual([liveKey]);
  });

  it('leaves the superseded objects in place (no throw) when object storage is unavailable', async () => {
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip' });
    const logWarn = vi.fn();

    await assets.update(asset.id, { status: 'processing' });
    const job1 = await runningTranscodeJob(jobs, asset.id);
    await completeTranscode(
      {
        jobId: job1,
        sourceAssetId: asset.id,
        success: true,
        renditions: [callbackRendition('rendition-1', `transcode/${asset.id}/job1/1080.mp4`)]
      },
      { jobs, assets, resolveSupersededStorage: async () => undefined, logWarn }
    );

    await assets.update(asset.id, { status: 'processing' });
    const job2 = await runningTranscodeJob(jobs, asset.id);
    const result = await completeTranscode(
      {
        jobId: job2,
        sourceAssetId: asset.id,
        success: true,
        renditions: [callbackRendition('rendition-1', `transcode/${asset.id}/job2/1080.mp4`)]
      },
      { jobs, assets, resolveSupersededStorage: async () => undefined, logWarn }
    );

    // The completion still succeeds; only the cleanup degraded.
    expect(result.applied).toBe(true);
    expect(logWarn).toHaveBeenCalled();
  });

  it('removes nothing when no superseded-output storage resolver is wired', async () => {
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
        renditions: [callbackRendition('rendition-1', `transcode/${asset.id}/job1/1080.mp4`)]
      },
      { jobs, assets }
    );

    await assets.update(asset.id, { status: 'processing' });
    const job2 = await runningTranscodeJob(jobs, asset.id);
    const result = await completeTranscode(
      {
        jobId: job2,
        sourceAssetId: asset.id,
        success: true,
        renditions: [callbackRendition('rendition-1', `transcode/${asset.id}/job2/1080.mp4`)]
      },
      { jobs, assets }
    );
    expect(result.applied).toBe(true);
    const stored = await assets.get(asset.id);
    expect(stored?.renditions).toHaveLength(1);
  });
});
