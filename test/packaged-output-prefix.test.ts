// Packaged-output prefix persistence + lazy resolution (issue #502).
//
// The packager writes CMAF output under a JOB-nested prefix in the packaged
// bucket (`<assetId>/<packagerJobId>/index.m3u8`, etc.), driven by the
// packager's instance `OutputFolder` + `OutputSubfolderTemplate` default
// `$INPUTNAME$/$JOBID$`. Delivery/stream previously assumed a FLAT per-asset
// prefix and 404ed. These tests lock in that the packager SUCCESS callback now
// durably persists the ACTUAL packaged location on the asset (bucket, full
// prefix, master HLS/DASH keys), and that assets packaged BEFORE this change are
// lazily resolved by listing the packaged bucket under `<assetId>/`.
//
// Contract verified (cited in the implementation note):
//   - Packager success callback body `{ url, jobId, outputPath? }`, jobId =
//     assetId, `outputPath` = the packager's CMAF output directory:
//     src/routes/internal.ts:47-51, src/pipeline/packaging.ts (PackagerSuccess-
//     Payload) and ADR-011 (docs/architecture/ADR-011...:192) +
//     docs/osc-feedback/incoming-per-job-packager-output.md:20-27.
//   - Object-store list surface `listObjectsV2(bucket, prefix, recursive) ->
//     stream of { name }`: src/pipeline/output-relocation.ts:29-40,
//     src/data/storage.ts:226.

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import {
  PackagingService,
  packagedOutputFromCallback,
  resolvePackagedOutput,
  packagedBucket,
  MASTER_HLS_FILENAME,
  MASTER_DASH_FILENAME,
  type PackageQueue,
  type PackagedObjectLister
} from '../src/pipeline/packaging.js';
import { InMemoryAssetRepository, type Asset } from '../src/data/asset-repo.js';
import { toAssetDocument, fromAssetDocument } from '../src/data/asset-document.js';

const noopQueue: PackageQueue = { enqueue: vi.fn(async () => {}) };

// A lister backed by a fixed key list, matching the minio listObjectsV2 stream
// contract (one `{ name }` per object, prefix-filtered, recursive).
function fakeLister(keys: string[]): PackagedObjectLister {
  return {
    listObjectsV2(_bucket: string, prefix: string, _recursive: boolean) {
      const matched = keys.filter((k) => k.startsWith(prefix)).map((name) => ({ name }));
      return Readable.from(matched);
    }
  };
}

describe('packaged-output prefix persistence (issue #502)', () => {
  describe('packagedOutputFromCallback', () => {
    it('captures the job-nested prefix and master keys from a plain path outputPath', () => {
      const out = packagedOutputFromCallback('asset-123/job-abc/', 'openvideocore-packaged');
      expect(out).toEqual({
        bucket: 'openvideocore-packaged',
        prefix: 'asset-123/job-abc/',
        masterHlsKey: `asset-123/job-abc/${MASTER_HLS_FILENAME}`,
        masterDashKey: `asset-123/job-abc/${MASTER_DASH_FILENAME}`
      });
    });

    it('strips an s3:// scheme + bucket segment from outputPath', () => {
      const out = packagedOutputFromCallback(
        's3://openvideocore-packaged/asset-123/job-abc/',
        'openvideocore-packaged'
      );
      expect(out?.prefix).toBe('asset-123/job-abc/');
      expect(out?.masterHlsKey).toBe(`asset-123/job-abc/${MASTER_HLS_FILENAME}`);
    });

    it('strips a leading /<bucket>/ from an absolute path outputPath', () => {
      const out = packagedOutputFromCallback(
        '/openvideocore-packaged/asset-123/job-abc',
        'openvideocore-packaged'
      );
      // trailing slash normalised on
      expect(out?.prefix).toBe('asset-123/job-abc/');
    });

    it('returns undefined when outputPath is absent (no guessed prefix persisted)', () => {
      expect(packagedOutputFromCallback(undefined, 'openvideocore-packaged')).toBeUndefined();
      expect(packagedOutputFromCallback('', 'openvideocore-packaged')).toBeUndefined();
    });
  });

  describe('PackagingService.handleSuccess persists packagedOutput', () => {
    it('stores the real job-nested prefix + master keys alongside manifestUrls', async () => {
      const repo = new InMemoryAssetRepository();
      const asset = await repo.create({ name: 'clip' });
      const svc = new PackagingService({
        assets: repo,
        queue: noopQueue,
        publicBaseUrl: 'https://cdn.example/packaged'
      });

      const applied = await svc.handleSuccess({
        url: 'https://encore/encoreJobs/uuid',
        jobId: asset.id,
        outputPath: `${asset.id}/job-abc/`
      });
      expect(applied).toBe(true);

      const stored = await repo.get(asset.id);
      expect(stored?.packagedOutput).toEqual({
        bucket: packagedBucket(),
        prefix: `${asset.id}/job-abc/`,
        masterHlsKey: `${asset.id}/job-abc/${MASTER_HLS_FILENAME}`,
        masterDashKey: `${asset.id}/job-abc/${MASTER_DASH_FILENAME}`
      });
      // manifestUrls is still written (existing behaviour preserved).
      expect(stored?.manifestUrls?.hls).toBeTruthy();
      // Packaging never changes lifecycle status.
      expect(stored?.status).toBe('uploading');
    });

    it('does not persist packagedOutput when the packager reports no outputPath', async () => {
      const repo = new InMemoryAssetRepository();
      const asset = await repo.create({ name: 'clip' });
      const svc = new PackagingService({ assets: repo, queue: noopQueue });

      await svc.handleSuccess({ url: 'https://encore/j', jobId: asset.id });

      const stored = await repo.get(asset.id);
      expect(stored?.packagedOutput).toBeUndefined();
      // Still records manifestUrls via the deterministic fallback.
      expect(stored?.manifestUrls).toBeDefined();
    });

    it('the persisted master keys point at objects that exist in the packaged bucket', async () => {
      const repo = new InMemoryAssetRepository();
      const asset = await repo.create({ name: 'clip' });
      const svc = new PackagingService({ assets: repo, queue: noopQueue });
      await svc.handleSuccess({
        url: 'https://encore/j',
        jobId: asset.id,
        outputPath: `${asset.id}/job-abc/`
      });
      const stored = await repo.get(asset.id);

      // The packaged bucket really holds these objects under the job prefix.
      const lister = fakeLister([
        `${asset.id}/job-abc/${MASTER_HLS_FILENAME}`,
        `${asset.id}/job-abc/${MASTER_DASH_FILENAME}`,
        `${asset.id}/job-abc/video-0_3022.m3u8`,
        `${asset.id}/job-abc/video-0_3022/1.m4s`
      ]);
      const keys = await new Promise<string[]>((resolve, reject) => {
        const out: string[] = [];
        const s = lister.listObjectsV2(packagedBucket(), `${asset.id}/`, true);
        s.on('data', (o: { name?: string }) => o.name && out.push(o.name));
        s.on('end', () => resolve(out));
        s.on('error', reject);
      });
      expect(keys).toContain(stored?.packagedOutput?.masterHlsKey);
      expect(keys).toContain(stored?.packagedOutput?.masterDashKey);
    });
  });

  describe('CouchDB document round-trip (issue #502)', () => {
    const base: Asset = {
      id: '01HZY000000000000000000000',
      name: 'clip',
      status: 'ready',
      statusHistory: [{ at: '2026-09-02T00:00:00.000Z', from: null, to: 'uploading' }],
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z'
    };

    it('persists and reads back packagedOutput through the four-namespace document', () => {
      const asset: Asset = {
        ...base,
        packagedOutput: {
          bucket: 'openvideocore-packaged',
          prefix: `${base.id}/job-abc/`,
          masterHlsKey: `${base.id}/job-abc/${MASTER_HLS_FILENAME}`,
          masterDashKey: `${base.id}/job-abc/${MASTER_DASH_FILENAME}`
        }
      };
      const doc = toAssetDocument(asset);
      expect(doc.structural.packagedOutput?.prefix).toBe(`${base.id}/job-abc/`);
      const roundTripped = fromAssetDocument(doc);
      expect(roundTripped.packagedOutput).toEqual(asset.packagedOutput);
    });

    it('back-compat: a document written before #502 (no packagedOutput) reads as undefined', () => {
      const doc = toAssetDocument(base);
      expect(doc.structural.packagedOutput).toBeUndefined();
      expect(fromAssetDocument(doc).packagedOutput).toBeUndefined();
    });
  });

  describe('resolvePackagedOutput lazy back-compat fallback', () => {
    it('prefers the persisted prefix without listing when present', async () => {
      const lister = fakeLister([]);
      const spy = vi.spyOn(lister, 'listObjectsV2');
      const out = await resolvePackagedOutput(
        {
          id: 'asset-123',
          packagedOutput: {
            bucket: 'openvideocore-packaged',
            prefix: 'asset-123/job-abc/',
            masterHlsKey: `asset-123/job-abc/${MASTER_HLS_FILENAME}`,
            masterDashKey: `asset-123/job-abc/${MASTER_DASH_FILENAME}`
          }
        },
        lister,
        'openvideocore-packaged'
      );
      expect(out?.prefix).toBe('asset-123/job-abc/');
      expect(spy).not.toHaveBeenCalled();
    });

    it('lists <assetId>/ and resolves the NEWEST job prefix for a legacy asset', async () => {
      const lister = fakeLister([
        'asset-123/job-aaa/index.m3u8',
        'asset-123/job-aaa/seg-1.m4s',
        'asset-123/job-zzz/index.m3u8',
        'asset-123/job-zzz/manifest.mpd'
      ]);
      const out = await resolvePackagedOutput(
        { id: 'asset-123' },
        lister,
        'openvideocore-packaged'
      );
      // job-zzz sorts after job-aaa -> newest package wins.
      expect(out).toEqual({
        bucket: 'openvideocore-packaged',
        prefix: 'asset-123/job-zzz/',
        masterHlsKey: `asset-123/job-zzz/${MASTER_HLS_FILENAME}`,
        masterDashKey: `asset-123/job-zzz/${MASTER_DASH_FILENAME}`
      });
    });

    it('resolves a legacy FLAT package (objects directly under <assetId>/)', async () => {
      const lister = fakeLister([
        'asset-123/index.m3u8',
        'asset-123/manifest.mpd',
        'asset-123/seg-1.m4s'
      ]);
      const out = await resolvePackagedOutput(
        { id: 'asset-123' },
        lister,
        'openvideocore-packaged'
      );
      expect(out?.prefix).toBe('asset-123/');
      expect(out?.masterHlsKey).toBe(`asset-123/${MASTER_HLS_FILENAME}`);
    });

    it('returns undefined when the packaged bucket has no objects for the asset', async () => {
      const lister = fakeLister(['other-asset/job-x/index.m3u8']);
      const out = await resolvePackagedOutput(
        { id: 'asset-123' },
        lister,
        'openvideocore-packaged'
      );
      expect(out).toBeUndefined();
    });
  });
});
