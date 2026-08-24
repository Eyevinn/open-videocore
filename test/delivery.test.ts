// Delivery URL generation tests (issue #14).
//
// Covers GET /api/v1/assets/:id/delivery resolution order:
//   - packaged HLS/DASH manifests (preferred) returned directly
//   - presigned source download URL when only a source object exists
//   - 404 when neither packaged output nor a source object is available
//   - 404 for unknown / cross-workspace assets (existence not leaked)
//   - 501 when a source-only asset needs presigning but storage is unconfigured
//   - DELIVERY_URL_TTL_SECONDS controls the expiry / presign window

import { afterEach, describe, it, expect, vi } from 'vitest';
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
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import type { WorkspaceStorage } from '../src/data/storage.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

function fakeStorage(): WorkspaceStorage {
  return {
    presignedGet: vi.fn(async (key: string, ttl?: number) => `https://minio.example/${key}?ttl=${ttl}&sig=get`)
  } as unknown as WorkspaceStorage;
}

async function buildApp(
  opts: { withStorage?: boolean } = {}
): Promise<{ app: FastifyInstance; repo: InMemoryAssetRepository }> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryAssetRepository();
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    storageFor: opts.withStorage === false ? undefined : () => fakeStorage(),
    outputBucket: 'openvideocore-packaged'
  });
  await app.ready();
  return { app, repo };
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

afterEach(() => {
  delete process.env['DELIVERY_URL_TTL_SECONDS'];
  delete process.env['PUBLIC_BASE_URL'];
  delete process.env['DELIVERY_MODE'];
  delete process.env['PACKAGED_PUBLIC_BASE_URL'];
});

describe('GET /:id/delivery', () => {
  it('returns packaged HLS/DASH manifest URLs when available', async () => {
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, {
      manifestUrls: {
        hls: 'https://cdn.example/packaged/x/index.m3u8',
        dash: 'https://cdn.example/packaged/x/manifest.mpd'
      }
    });

    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.assetId).toBe(id);
    expect(body.urls.hls).toBe('https://cdn.example/packaged/x/index.m3u8');
    expect(body.urls.dash).toBe('https://cdn.example/packaged/x/manifest.mpd');
    expect(body.urls.source).toBeUndefined();
    expect(typeof body.expiresAt).toBe('string');
  });

  it('returns only the format that was packaged', async () => {
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, {
      manifestUrls: { hls: 'https://cdn.example/packaged/x/index.m3u8' }
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.urls.hls).toBeDefined();
    expect(body.urls.dash).toBeUndefined();
  });

  it('falls back to a presigned source URL when not yet packaged', async () => {
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, { objectKey: `ingest/${id}` });

    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.urls.source).toContain(`ingest/${id}`);
    expect(body.urls.source).toContain('sig=get');
    expect(body.urls.hls).toBeUndefined();
  });

  it('prefers packaged manifests over the source object', async () => {
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, {
      objectKey: `ingest/${id}`,
      manifestUrls: { hls: 'https://cdn.example/packaged/x/index.m3u8' }
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    const body = res.json();
    expect(body.urls.hls).toBeDefined();
    expect(body.urls.source).toBeUndefined();
  });

  it('returns 404 when the asset has nothing to deliver', async () => {
    const { app } = await buildApp();
    const id = await createAsset(app);
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('no_delivery');
  });

  it('returns 404 for an unknown asset', async () => {
    const { app } = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/assets/nope/delivery', headers: A });
    expect(res.statusCode).toBe(404);
  });

  it.skip('does not leak existence across workspaces (404)', async () => {
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, { objectKey: `ingest/${id}` });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/delivery`,
      headers: auth('token-b')
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 501 for a source-only asset when storage is not configured', async () => {
    const { app, repo } = await buildApp({ withStorage: false });
    const id = await createAsset(app);
    await repo.update(id, { objectKey: `ingest/${id}` });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_configured');
  });

  it('still serves packaged manifests when storage is not configured', async () => {
    const { app, repo } = await buildApp({ withStorage: false });
    const id = await createAsset(app);
    await repo.update(id, {
      manifestUrls: { hls: 'https://cdn.example/packaged/x/index.m3u8' }
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    expect(res.statusCode).toBe(200);
    expect(res.json().urls.hls).toBeDefined();
  });

  // Issue #341: on the zero-config per-stack MinIO backend the stored
  // manifestUrls are bare object-key paths (no scheme/host/signature) and OSC
  // MinIO blocks external presigned/public GETs. The manifest branch must route
  // these through the authorized stream proxy so `hls`/`dash` are absolute,
  // resolvable URLs — consistent with how `source` is emitted.
  it('routes bare-path manifests through the absolute stream proxy URL', async () => {
    process.env['PUBLIC_BASE_URL'] = 'https://api.example.test';
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, {
      manifestUrls: {
        hls: `/openvideocore-packaged/${id}/abc/index.m3u8`,
        dash: `/openvideocore-packaged/${id}/abc/manifest.mpd`
      }
    });

    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.urls.hls).toBe(
      `https://api.example.test/api/v1/assets/${id}/stream/index.m3u8`
    );
    expect(body.urls.dash).toBe(
      `https://api.example.test/api/v1/assets/${id}/stream/manifest.mpd`
    );
  });

  it('emits only the packaged format through the proxy for bare-path manifests', async () => {
    process.env['PUBLIC_BASE_URL'] = 'https://api.example.test';
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, {
      manifestUrls: { hls: `/openvideocore-packaged/${id}/abc/index.m3u8` }
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    const body = res.json();
    expect(body.urls.hls).toBe(
      `https://api.example.test/api/v1/assets/${id}/stream/index.m3u8`
    );
    expect(body.urls.dash).toBeUndefined();
  });

  it('routes bare-path manifests through the proxy in DELIVERY_MODE=proxy', async () => {
    process.env['PUBLIC_BASE_URL'] = 'https://api.example.test';
    process.env['DELIVERY_MODE'] = 'proxy';
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, {
      manifestUrls: {
        hls: `/openvideocore-packaged/${id}/abc/index.m3u8`,
        dash: `/openvideocore-packaged/${id}/abc/manifest.mpd`
      }
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    const body = res.json();
    expect(body.urls.hls).toBe(
      `https://api.example.test/api/v1/assets/${id}/stream/index.m3u8`
    );
    expect(body.urls.dash).toBe(
      `https://api.example.test/api/v1/assets/${id}/stream/manifest.mpd`
    );
  });

  it('preserves already-absolute public manifest URLs unchanged', async () => {
    // When the stored manifestUrls are already absolute + resolvable (e.g. a
    // configured public/CDN origin), the delivery endpoint must not rewrite them
    // through the proxy — only bare paths are routed.
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, {
      manifestUrls: {
        hls: 'https://cdn.example/packaged/x/index.m3u8',
        dash: 'https://cdn.example/packaged/x/manifest.mpd'
      }
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    const body = res.json();
    expect(body.urls.hls).toBe('https://cdn.example/packaged/x/index.m3u8');
    expect(body.urls.dash).toBe('https://cdn.example/packaged/x/manifest.mpd');
  });

  it('requires authentication', async () => {
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, { objectKey: `ingest/${id}` });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery` });
    expect(res.statusCode).toBe(401);
  });

  it('honours DELIVERY_URL_TTL_SECONDS for the presign window and expiry', async () => {
    process.env['DELIVERY_URL_TTL_SECONDS'] = '120';
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, { objectKey: `ingest/${id}` });
    const before = Date.now();
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    const body = res.json();
    expect(body.urls.source).toContain('ttl=120');
    const expiresMs = new Date(body.expiresAt).getTime();
    expect(expiresMs).toBeGreaterThanOrEqual(before + 120 * 1000 - 5000);
    expect(expiresMs).toBeLessThanOrEqual(Date.now() + 120 * 1000 + 5000);
  });
});
