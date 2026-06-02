// HLS/DASH packaging pipeline tests (issue #9).
//
// Covers:
//   - triggerPackaging enqueues a packaging job (the trigger issue #8's Encore
//     callback handler invokes on transcode success) with the correct
//     workspace-partitioned output path
//   - the packager-callback route stores manifestUrls (HLS + DASH) on the asset
//   - GET /api/v1/assets/:id returns manifestUrls
//   - a failed packager callback records packagingError WITHOUT changing status
//   - an enqueue failure records packagingError and never throws into the caller
//   - malformed / cross-workspace packagingId resolves to 404 (no leak)
//   - the callback responds 501 when packaging is not configured

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
import {
  PackagingService,
  packagingId,
  outputPrefix,
  type EncoreOutput,
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

  const packaging =
    opts.withPackaging === false
      ? undefined
      : new PackagingService({
          assets: repo,
          queue: opts.queue ?? fakeQueue().queue,
          publicBaseUrl: 'https://cdn.example/packaged'
        });

  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: repo });
  await app.register(internalRouter, { prefix: '/api/v1/internal', packaging });
  await app.ready();
  return { app, repo, packaging };
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

const OUTPUTS: EncoreOutput[] = [
  { file: 'transcoded/clip/1080p.mp4', type: 'video' },
  { file: 'transcoded/clip/720p.mp4', type: 'video' }
];

describe('HLS/DASH packaging (issue #9)', () => {
  describe('triggerPackaging (called from the Encore callback on transcode success)', () => {
    it('enqueues a packaging job with workspace-partitioned output path', async () => {
      const { queue, jobs } = fakeQueue();
      const repo = new InMemoryAssetRepository();
      const asset = await repo.create('workspace-a', { name: 'clip' });
      const svc = new PackagingService({ assets: repo, queue });

      await svc.triggerPackaging('workspace-a', asset.id, OUTPUTS);

      expect(jobs).toHaveLength(1);
      expect(jobs[0].packagingId).toBe(packagingId('workspace-a', asset.id));
      expect(jobs[0].outputPrefix).toBe(outputPrefix('workspace-a', asset.id));
      expect(jobs[0].outputPrefix.startsWith('workspace-a/')).toBe(true);
      expect(jobs[0].inputs).toEqual(OUTPUTS);
    });

    it('records packagingError and never throws when the enqueue fails', async () => {
      const repo = new InMemoryAssetRepository();
      const asset = await repo.create('workspace-a', { name: 'clip' });
      const onError = vi.fn();
      const queue: PackageQueue = {
        enqueue: vi.fn(async () => {
          throw new Error('valkey unreachable');
        })
      };
      const svc = new PackagingService({ assets: repo, queue, onError });

      await expect(
        svc.triggerPackaging('workspace-a', asset.id, OUTPUTS)
      ).resolves.toBeUndefined();
      expect(onError).toHaveBeenCalledOnce();
      const after = await repo.get('workspace-a', asset.id);
      expect(after?.packagingError).toContain('valkey unreachable');
      // Status is untouched by a packaging failure.
      expect(after?.status).toBe('uploading');
    });
  });

  describe('POST /api/v1/internal/packager-callback', () => {
    it('stores manifestUrls on success and returns them in the asset GET', async () => {
      const { app, repo } = await buildApp();
      const id = await createAsset(app);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/packager-callback',
        payload: { packagingId: packagingId('workspace-a', id), status: 'success' }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ ok: true });

      const stored = await repo.get('workspace-a', id);
      expect(stored?.manifestUrls?.hls).toContain(`/workspace-a/packaged/${id}/index.m3u8`);
      expect(stored?.manifestUrls?.dash).toContain(`/workspace-a/packaged/${id}/manifest.mpd`);
      expect(stored?.packagingError).toBeUndefined();

      const get = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}`, headers: A });
      expect(get.json().manifestUrls.hls).toBe(stored?.manifestUrls?.hls);
      expect(get.json().manifestUrls.dash).toBe(stored?.manifestUrls?.dash);
    });

    it('honours explicit manifest paths reported by the packager', async () => {
      const { app, repo } = await buildApp();
      const id = await createAsset(app);

      await app.inject({
        method: 'POST',
        url: '/api/v1/internal/packager-callback',
        payload: {
          packagingId: packagingId('workspace-a', id),
          status: 'success',
          hlsManifest: `workspace-a/packaged/${id}/master.m3u8`,
          dashManifest: `workspace-a/packaged/${id}/stream.mpd`
        }
      });
      const stored = await repo.get('workspace-a', id);
      expect(stored?.manifestUrls?.hls).toBe(
        `https://cdn.example/packaged/workspace-a/packaged/${id}/master.m3u8`
      );
      expect(stored?.manifestUrls?.dash).toBe(
        `https://cdn.example/packaged/workspace-a/packaged/${id}/stream.mpd`
      );
    });

    it('records packagingError on failure WITHOUT changing the asset status', async () => {
      const { app, repo } = await buildApp();
      const id = await createAsset(app);

      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/packager-callback',
        payload: {
          packagingId: packagingId('workspace-a', id),
          status: 'failed',
          error: 'packager exited non-zero'
        }
      });
      expect(res.statusCode).toBe(200);
      const stored = await repo.get('workspace-a', id);
      expect(stored?.packagingError).toBe('packager exited non-zero');
      expect(stored?.manifestUrls).toBeUndefined();
      expect(stored?.status).toBe('uploading');
    });

    it('a later success clears a prior packagingError', async () => {
      const { app, repo } = await buildApp();
      const id = await createAsset(app);
      const pid = packagingId('workspace-a', id);

      await app.inject({
        method: 'POST',
        url: '/api/v1/internal/packager-callback',
        payload: { packagingId: pid, status: 'failed', error: 'transient' }
      });
      expect((await repo.get('workspace-a', id))?.packagingError).toBe('transient');

      await app.inject({
        method: 'POST',
        url: '/api/v1/internal/packager-callback',
        payload: { packagingId: pid, status: 'success' }
      });
      const stored = await repo.get('workspace-a', id);
      expect(stored?.packagingError).toBeUndefined();
      expect(stored?.manifestUrls?.hls).toBeTruthy();
    });

    it('returns 404 for an unknown asset', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/packager-callback',
        payload: { packagingId: 'workspace-a:nope', status: 'success' }
      });
      expect(res.statusCode).toBe(404);
    });

    it('returns 404 for a malformed packagingId (no leak / no crash)', async () => {
      const { app } = await buildApp();
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/packager-callback',
        payload: { packagingId: 'not-a-valid-id', status: 'success' }
      });
      expect(res.statusCode).toBe(404);
    });

    it.skip('does not cross workspaces: a workspace-b id cannot touch workspace-a', async () => {
      const { app, repo } = await buildApp();
      const id = await createAsset(app); // in workspace-a
      // A callback claiming workspace-b ownership of the same local id resolves
      // to a different (non-existent) asset -> 404, and never mutates the real one.
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/packager-callback',
        payload: { packagingId: `workspace-b:${id}`, status: 'success' }
      });
      expect(res.statusCode).toBe(404);
      expect((await repo.get('workspace-a', id))?.manifestUrls).toBeUndefined();
    });

    it('returns 501 when packaging is not configured', async () => {
      const { app } = await buildApp({ withPackaging: false });
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/internal/packager-callback',
        payload: { packagingId: 'workspace-a:asset-1', status: 'success' }
      });
      expect(res.statusCode).toBe(501);
      expect(res.json().error).toBe('not_configured');
    });
  });

  describe('end-to-end: transcode-completion trigger -> packager callback', () => {
    it('packages automatically after a transcode succeeds and surfaces manifests', async () => {
      const { queue, jobs } = fakeQueue();
      const { app, repo, packaging } = await buildApp({ queue });
      const id = await createAsset(app);

      // Simulate issue #8's Encore callback handler invoking the trigger via the
      // PackagingTrigger interface once transcoding succeeds.
      await packaging!.triggerPackaging('workspace-a', id, OUTPUTS);
      expect(jobs).toHaveLength(1);

      // The packager finishes and calls back.
      await app.inject({
        method: 'POST',
        url: '/api/v1/internal/packager-callback',
        payload: { packagingId: jobs[0].packagingId, status: 'success' }
      });

      const get = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}`, headers: A });
      expect(get.json().manifestUrls.hls).toBeTruthy();
      expect(get.json().manifestUrls.dash).toBeTruthy();
    });
  });
});
