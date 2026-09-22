// HLS/DASH packaging pipeline tests (issue #9).
//
// Rewritten for the current post-ADR-003 (#64) single-tenant contract and the
// current packaging surface (verified 2026-09-22 against src/pipeline/packaging.ts
// and src/routes/internal.ts):
//   - PackagingService.triggerPackaging(assetId, encoreJobUrl) enqueues a
//     PackagingJob { jobId, url } (packaging.ts:171-192,388-401) and, on an
//     enqueue failure, records packagingError on the asset without throwing
//     (packaging.ts:412-421).
//   - POST /api/v1/internal/packagerCallback/success with { url, jobId, outputPath? }
//     stores manifestUrls on the asset (internal.ts:55-59,285-299 ->
//     PackagingService.handleSuccess, packaging.ts:429-472). 404 for an unknown
//     asset, 501 when packaging is not configured.
//   - POST /api/v1/internal/packagerCallback/failure with { message } ONLY —
//     the packager does not echo a jobId, so the route correlates by pipeline
//     execution state (any running `package` step) and records the failure on the
//     execution (internal.ts:61-63,420-476).
//   - the packagingId / outputPrefix / manifestUrlsFor helpers are single-arg
//     (assetId) — no workspace partitioning (packaging.ts:46-77).

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
      const map: Record<string, string> = { 'token-a': 'workspace-a', 'token-b': 'workspace-b' };
      const ws = token ? map[token] : undefined;
      if (!ws) throw new actual.AuthError('invalid token');
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { internalRouter } from '../src/routes/internal.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import {
  PackagingService,
  packagingId,
  outputPrefix,
  manifestUrlsFor,
  type PackageQueue,
  type PackagingJob
} from '../src/pipeline/packaging.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

function fakeQueue(): { queue: PackageQueue; jobs: PackagingJob[] } {
  const jobs: PackagingJob[] = [];
  return {
    jobs,
    queue: {
      enqueue: vi.fn(async (job: PackagingJob) => {
        jobs.push(job);
      })
    }
  };
}

async function buildApp(opts: { withPackaging?: boolean; queue?: PackageQueue } = {}) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryAssetRepository();
  const pipelines = new InMemoryPipelineRepository();

  const packaging =
    opts.withPackaging === false
      ? undefined
      : new PackagingService({
          assets: repo,
          queue: opts.queue ?? fakeQueue().queue,
          publicBaseUrl: 'https://cdn.example/packaged'
        });

  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: repo });
  await app.register(internalRouter, {
    prefix: '/api/v1/internal',
    packaging,
    repository: repo,
    pipelineRepository: pipelines
  });
  await app.ready();
  return { app, repo, pipelines, packaging };
}

async function createAsset(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: A,
    payload: { name: 'clip' }
  });
  return res.json().id as string;
}

// Seed a pipeline execution stalled on a RUNNING `package` step — the state the
// packager-failure callback correlates against (src/routes/internal.ts:433-445).
async function seedRunningPackage(pipelines: InMemoryPipelineRepository, assetId: string) {
  const exec = await pipelines.create({ assetId, steps: ['package'] });
  await pipelines.update(exec.id, {
    steps: exec.steps.map((s) => (s.name === 'package' ? { ...s, status: 'running' } : s))
  });
  return exec;
}

describe('HLS/DASH packaging (issue #9)', () => {
  describe('packaging id / path helpers', () => {
    it('packagingId is the assetId (no workspace partitioning, post-#64)', () => {
      expect(packagingId('asset-7')).toBe('asset-7');
    });

    it('outputPrefix places the asset under the packaged prefix', () => {
      expect(outputPrefix('asset-7')).toBe('packaged/asset-7');
    });

    it('manifestUrlsFor builds HLS + DASH URLs under the deterministic prefix', () => {
      const urls = manifestUrlsFor('asset-7', 'https://cdn.example/packaged');
      expect(urls.hls).toBe('https://cdn.example/packaged/packaged/asset-7/index.m3u8');
      expect(urls.dash).toBe('https://cdn.example/packaged/packaged/asset-7/manifest.mpd');
    });
  });

  describe('triggerPackaging (called from the Encore callback on transcode success)', () => {
    it('enqueues a PackagingJob keyed by the assetId and the Encore job URL', async () => {
      const { queue, jobs } = fakeQueue();
      const repo = new InMemoryAssetRepository();
      const asset = await repo.create({ name: 'clip' });
      const svc = new PackagingService({ assets: repo, queue });

      await svc.triggerPackaging(asset.id, 'https://encore.example/job/1');

      expect(jobs).toHaveLength(1);
      // Current PackagingJob shape is { jobId, url } (packaging.ts:171-174); jobId
      // === assetId so the success callback can resolve the asset (packaging.ts:433).
      expect(jobs[0].jobId).toBe(asset.id);
      expect(jobs[0].url).toBe('https://encore.example/job/1');
    });

    it('records packagingError and never throws when the enqueue fails', async () => {
      const repo = new InMemoryAssetRepository();
      const asset = await repo.create({ name: 'clip' });
      const onError = vi.fn();
      const queue: PackageQueue = {
        enqueue: vi.fn(async () => {
          throw new Error('valkey unreachable');
        })
      };
      const svc = new PackagingService({ assets: repo, queue, onError });

      await expect(
        svc.triggerPackaging(asset.id, 'https://encore.example/job/1')
      ).resolves.toBeUndefined();
      expect(onError).toHaveBeenCalledOnce();
      const after = await repo.get(asset.id);
      expect(after?.packagingError).toContain('valkey unreachable');
      // Status is untouched by a packaging failure.
      expect(after?.status).toBe('uploading');
    });
  });

  describe('POST /api/v1/internal/packagerCallback/success', () => {
    it('stores manifestUrls on success and returns them in the asset GET', async () => {
      const { app, repo } = await buildApp();
      const id = await createAsset(app);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/packagerCallback/success',
        // jobId === the assetId we enqueued (packaging.ts:433).
        payload: { url: 'https://encore.example/job/1', jobId: id }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      const stored = await repo.get(id);
      // No outputPath reported -> deterministic packaged/<id> manifest names.
      expect(stored?.manifestUrls?.hls).toBe(
        `https://cdn.example/packaged/packaged/${id}/index.m3u8`
      );
      expect(stored?.manifestUrls?.dash).toBe(
        `https://cdn.example/packaged/packaged/${id}/manifest.mpd`
      );
      expect(stored?.packagingError).toBeUndefined();

      const get = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}`, headers: A });
      expect(get.json().manifestUrls.hls).toBe(stored?.manifestUrls?.hls);
      expect(get.json().manifestUrls.dash).toBe(stored?.manifestUrls?.dash);
    });

    it('honours the packager-reported outputPath directory', async () => {
      const { app, repo } = await buildApp();
      const id = await createAsset(app);

      await app.inject({
        method: 'POST',
        url: '/api/v1/internal/packagerCallback/success',
        payload: {
          url: 'https://encore.example/job/1',
          jobId: id,
          outputPath: `/rendition_x264_3100/${id}`
        }
      });
      const stored = await repo.get(id);
      // outputPath is appended to the public origin with the known manifest names
      // (outputPathToManifestUrls, packaging.ts:664-678).
      expect(stored?.manifestUrls?.hls).toBe(
        `https://cdn.example/packaged/rendition_x264_3100/${id}/index.m3u8`
      );
      expect(stored?.manifestUrls?.dash).toBe(
        `https://cdn.example/packaged/rendition_x264_3100/${id}/manifest.mpd`
      );
    });

    it('returns 404 for an unknown asset', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/packagerCallback/success',
        payload: { url: 'https://encore.example/job/1', jobId: 'nope' }
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 501 when packaging is not configured', async () => {
      const { app } = await buildApp({ withPackaging: false });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/packagerCallback/success',
        payload: { url: 'https://encore.example/job/1', jobId: 'asset-1' }
      });
      expect(res.statusCode).toBe(501);
      expect(res.json().error).toBe('not_configured');
    });
  });

  describe('POST /api/v1/internal/packagerCallback/failure', () => {
    it('records the failure on the running package execution WITHOUT changing asset status', async () => {
      const { app, repo, pipelines } = await buildApp();
      const id = await createAsset(app);
      const exec = await seedRunningPackage(pipelines, id);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/packagerCallback/failure',
        // The packager does NOT echo a jobId on failure — body is { message } only.
        payload: { message: 'packager exited non-zero' }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      // The correlated execution (its running `package` step) is marked failed and
      // carries the packager's message.
      const after = await pipelines.get(exec.id);
      expect(after?.status).toBe('failed');
      const pkg = after?.steps.find((s) => s.name === 'package');
      expect(pkg?.status).toBe('failed');
      expect(pkg?.error).toContain('packager exited non-zero');

      // The asset's lifecycle status is untouched by a packaging failure.
      const asset = await repo.get(id);
      expect(asset?.status).toBe('uploading');
      expect(asset?.manifestUrls).toBeUndefined();
    });

    it('acknowledges (200) even when no execution is awaiting packaging', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/packagerCallback/failure',
        payload: { message: 'orphan failure' }
      });
      // Best-effort: the callback is always acknowledged (internal.ts:419,475).
      expect(res.statusCode).toBe(200);
    });
  });

  describe('end-to-end: transcode-completion trigger -> packager success callback', () => {
    it('packages automatically after a transcode succeeds and surfaces manifests', async () => {
      const { queue, jobs } = fakeQueue();
      const { app, packaging } = await buildApp({ queue });
      const id = await createAsset(app);

      // Simulate issue #8's Encore callback handler invoking the trigger once
      // transcoding succeeds (triggerPackaging(assetId, encoreJobUrl)).
      await packaging!.triggerPackaging(id, 'https://encore.example/job/1');
      expect(jobs).toHaveLength(1);
      expect(jobs[0].jobId).toBe(id);

      // The packager finishes and calls back with the echoed jobId.
      await app.inject({
        method: 'POST',
        url: '/api/v1/internal/packagerCallback/success',
        payload: { url: jobs[0].url, jobId: jobs[0].jobId }
      });

      const get = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}`, headers: A });
      expect(get.json().manifestUrls.hls).toBeTruthy();
      expect(get.json().manifestUrls.dash).toBeTruthy();
    });
  });
});
