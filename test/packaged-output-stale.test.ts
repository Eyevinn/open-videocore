// Packaged-output staleness marker (issue #1290).
//
// A re-encode with no packaging step (`POST /api/v1/assets/:id/transcode` with
// no pipeline) rewrites only `renditions`; `manifestUrls` is written solely by
// the packager success callback, so after such a re-encode the packaged
// manifests keep describing the PREVIOUS encode while `renditions` describes the
// new one — and nothing on the record said so.
//
// The chosen fix (issue #1290 decision, option C) MARKS the disagreement instead
// of clearing `manifestUrls`: playback over the previous package keeps working
// and `/delivery` resolution is untouched. These tests lock in both halves of
// the marker's lifecycle plus its persistence and its exposure on GET /:id.
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - `Asset.packagedOutputStale?: boolean` and
//     `UpdateAssetInput.packagedOutputStale?: boolean` — src/data/asset-repo.ts
//     (declared beside `packagedOutput` / `manifestUrls`).
//   - Persisted slot `structural.packagedOutputStale` on `AssetDocumentSchema`,
//     written by `toAssetDocument` and read by `fromAssetDocument` —
//     src/data/asset-document.ts.
//   - `completeTranscode(params, deps)` / `CompleteTranscodeResult` —
//     src/pipeline/transcode.ts.
//   - `PackagingService.handleSuccess({ url, jobId, outputPath? })` and
//     `handleFailure(assetId, message)` — src/pipeline/packaging.ts (the
//     packager callback body contract is documented at src/routes/internal.ts
//     `/packagerCallback/success`).
//   - Response field on `assetSchema` for GET /api/v1/assets/{id} —
//     src/routes/assets.ts (`response: { 200: assetSchema }` on `app.get('/:id')`).

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      if (token !== 'token-a') throw new actual.AuthError('invalid token');
      return 'workspace-a';
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { completeTranscode, type CallbackRendition } from '../src/pipeline/transcode.js';
import { PackagingService, type PackageQueue } from '../src/pipeline/packaging.js';
import { toAssetDocument, fromAssetDocument } from '../src/data/asset-document.js';

const noopQueue: PackageQueue = { enqueue: vi.fn(async () => {}) };

const newRendition: CallbackRendition = {
  label: 'rendition-1',
  width: 1920,
  height: 1080,
  objectKey: 'transcode/asset/job-2/1080.mp4',
  codec: 'h264',
  bitrateBps: 5_000_000
};

// An asset that has ALREADY been packaged (manifests + durable packaged
// location), with a `running` transcode job over it — the state a re-encode's
// Encore success callback lands in.
async function alreadyPackagedWithRunningEncode() {
  const jobs = new InMemoryJobRepository();
  const assets = new InMemoryAssetRepository();
  const asset = await assets.create({ name: 'clip' });
  await assets.update(asset.id, {
    renditions: [
      {
        id: 'r-old',
        label: 'rendition-1',
        width: 1280,
        height: 720,
        objectKey: 'transcode/asset/job-1/720.mp4'
      }
    ],
    manifestUrls: {
      hls: `https://cdn.example/packaged/${asset.id}/job-1/index.m3u8`,
      dash: `https://cdn.example/packaged/${asset.id}/job-1/manifest.mpd`
    },
    packagedOutput: {
      bucket: 'openvideocore-packaged',
      prefix: `${asset.id}/job-1/`,
      masterHlsKey: `${asset.id}/job-1/index.m3u8`,
      masterDashKey: `${asset.id}/job-1/manifest.mpd`
    }
  });
  await assets.update(asset.id, { status: 'processing' });
  const job = await jobs.create({ type: 'transcode', assetId: asset.id, profile: 'program' });
  await jobs.update(job.id, { status: 'queued' });
  await jobs.update(job.id, { status: 'running' });
  return { jobs, assets, jobId: job.id, assetId: asset.id };
}

describe('packaged-output staleness after a re-encode (issue #1290)', () => {
  it('marks the packaged output stale when a re-encode completes and no new package follows', async () => {
    const { jobs, assets, jobId, assetId } = await alreadyPackagedWithRunningEncode();
    const before = await assets.get(assetId);
    expect(before?.packagedOutputStale).toBeUndefined();

    const result = await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: [newRendition] },
      { jobs, assets }
    );

    expect(result.applied).toBe(true);
    const after = await assets.get(assetId);
    // The marker is set: manifests and renditions now describe different encodes.
    expect(after?.packagedOutputStale).toBe(true);
    // ...and the decision for #1290 was to MARK, not clear: the previous
    // package's URLs are untouched so playback keeps working.
    expect(after?.manifestUrls?.hls).toBe(before?.manifestUrls?.hls);
    expect(after?.manifestUrls?.dash).toBe(before?.manifestUrls?.dash);
    expect(after?.packagedOutput?.prefix).toBe(before?.packagedOutput?.prefix);
    // The renditions are the new encode's.
    expect(after?.renditions?.[0]?.objectKey).toBe(newRendition.objectKey);
  });

  it('does not mark a first-ever encode stale (there is no packaged output yet)', async () => {
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip' });
    await assets.update(asset.id, { status: 'processing' });
    const job = await jobs.create({ type: 'transcode', assetId: asset.id, profile: 'program' });
    await jobs.update(job.id, { status: 'queued' });
    await jobs.update(job.id, { status: 'running' });

    await completeTranscode(
      { jobId: job.id, sourceAssetId: asset.id, success: true, renditions: [newRendition] },
      { jobs, assets }
    );

    const after = await assets.get(asset.id);
    expect(after?.renditions).toHaveLength(1);
    expect(after?.packagedOutputStale).toBeUndefined();
  });

  it('does not mark anything stale when the re-encode FAILED', async () => {
    const { jobs, assets, jobId, assetId } = await alreadyPackagedWithRunningEncode();

    await completeTranscode(
      { jobId, sourceAssetId: assetId, success: false, error: 'encore blew up', renditions: [] },
      { jobs, assets }
    );

    const after = await assets.get(assetId);
    // Nothing superseded the package, so it is not stale.
    expect(after?.packagedOutputStale).toBeUndefined();
  });

  it('clears the marker when a subsequent package completes and repoints manifestUrls', async () => {
    const { jobs, assets, jobId, assetId } = await alreadyPackagedWithRunningEncode();
    await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: [newRendition] },
      { jobs, assets }
    );
    expect((await assets.get(assetId))?.packagedOutputStale).toBe(true);

    const svc = new PackagingService({
      assets,
      queue: noopQueue,
      publicBaseUrl: 'https://cdn.example/packaged'
    });
    const applied = await svc.handleSuccess({
      url: 'https://encore/encoreJobs/uuid',
      jobId: assetId,
      outputPath: `${assetId}/job-2/`
    });
    expect(applied).toBe(true);

    const after = await assets.get(assetId);
    // Marker gone...
    expect(after?.packagedOutputStale).toBeUndefined();
    // ...and the manifests + durable location point at the NEW package.
    expect(after?.manifestUrls?.hls).toContain(`${assetId}/job-2/`);
    expect(after?.packagedOutput?.prefix).toBe(`${assetId}/job-2/`);
  });

  it('leaves the marker standing when the follow-up package FAILS', async () => {
    const { jobs, assets, jobId, assetId } = await alreadyPackagedWithRunningEncode();
    await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: [newRendition] },
      { jobs, assets }
    );

    const svc = new PackagingService({ assets, queue: noopQueue });
    await svc.handleFailure(assetId, 'packager exited 1');

    const after = await assets.get(assetId);
    expect(after?.packagedOutputStale).toBe(true);
    expect(after?.packagingError).toBe('packager exited 1');
  });

  it('clears the marker on ANY manifestUrls write, whoever makes it', async () => {
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip' });
    await assets.update(asset.id, { packagedOutputStale: true });
    expect((await assets.get(asset.id))?.packagedOutputStale).toBe(true);

    await assets.update(asset.id, { manifestUrls: { hls: 'https://cdn.example/new/index.m3u8' } });

    expect((await assets.get(asset.id))?.packagedOutputStale).toBeUndefined();
  });

  it('stores `false` as absence rather than an explicit false', async () => {
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip' });
    await assets.update(asset.id, { packagedOutputStale: true });
    await assets.update(asset.id, { packagedOutputStale: false });

    expect((await assets.get(asset.id))?.packagedOutputStale).toBeUndefined();
  });
});

describe('packaged-output staleness persistence (issue #1290)', () => {
  it('round-trips through the four-namespace document under structural', async () => {
    const assets = new InMemoryAssetRepository();
    const base = await assets.create({ name: 'clip' });

    const doc = toAssetDocument({ ...base, packagedOutputStale: true });
    expect(doc.structural.packagedOutputStale).toBe(true);
    expect(fromAssetDocument(doc).packagedOutputStale).toBe(true);
  });

  it('omits the field for a not-stale asset, and reads a pre-#1290 document as not stale', async () => {
    const assets = new InMemoryAssetRepository();
    const base = await assets.create({ name: 'clip' });

    const doc = toAssetDocument(base);
    expect(doc.structural.packagedOutputStale).toBeUndefined();
    // A document written before #1290 simply lacks the field.
    expect(fromAssetDocument(doc).packagedOutputStale).toBeUndefined();
  });
});

describe('GET /api/v1/assets/:id exposes packagedOutputStale (issue #1290)', () => {
  async function buildApp(): Promise<{ app: FastifyInstance; repo: InMemoryAssetRepository }> {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    registerAuth(app);
    const repo = new InMemoryAssetRepository();
    await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: repo });
    await app.ready();
    return { app, repo };
  }

  it('returns `true` for a stale asset and omits the field otherwise', async () => {
    const { app, repo } = await buildApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: { authorization: 'Bearer token-a' },
      payload: { name: 'clip' }
    });
    const id = created.json().id as string;

    const fresh = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}`,
      headers: { authorization: 'Bearer token-a' }
    });
    expect(fresh.statusCode).toBe(200);
    expect(fresh.json()).not.toHaveProperty('packagedOutputStale');

    await repo.update(id, { packagedOutputStale: true });
    const stale = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}`,
      headers: { authorization: 'Bearer token-a' }
    });
    expect(stale.statusCode).toBe(200);
    expect(stale.json().packagedOutputStale).toBe(true);
  });
});
