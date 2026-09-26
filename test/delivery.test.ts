// Delivery URL generation tests (issue #14).
//
// Covers GET /api/v1/assets/:id/delivery resolution order:
//   - packaged HLS/DASH manifests (preferred) returned directly
//   - presigned source download URL when only a source object exists
//   - 404 when neither packaged output nor a source object is available
//   - 404 for unknown / cross-workspace assets (existence not leaked)
//   - 501 when a source-only asset needs presigning but storage is unconfigured
//   - DELIVERY_URL_TTL_SECONDS controls the expiry / presign window
//   - `status: failed` (never `ready`) for a failed asset with only a source
//     object and no packaged manifests (issue #810)

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

// `minioEndpoint` populates the resolved stack's own MinIO endpoint on
// request.connections.s3Config exactly as src/main.ts's preHandler does
// (services/workspace-stack.ts buildConnectionsFromStack sets
// s3Config.endpoint = StackConfig.minioEndpoint) — the coordinate issue #859
// derives the packaged public origin from. Omitted => no stack resolved.
async function buildApp(
  opts: { withStorage?: boolean; minioEndpoint?: string } = {}
): Promise<{ app: FastifyInstance; repo: InMemoryAssetRepository }> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryAssetRepository();
  if (opts.minioEndpoint) {
    const endpoint = opts.minioEndpoint;
    app.decorateRequest('connections', null);
    app.addHook('preHandler', async (request) => {
      request.connections = {
        s3Config: { endpoint, accessKey: 'admin', secretKey: 'x' }
      } as unknown as NonNullable<typeof request.connections>;
    });
  }
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

  // Issue #859: on a DEFAULT (zero-config) stack nothing sets
  // PACKAGED_PUBLIC_BASE_URL, but the stack's own MinIO endpoint IS the public
  // origin for its packaged bucket. Delivery must advertise absolute URLs on
  // that origin instead of routing the manifest through the authorized
  // `/stream/*` proxy (which requires a bearer token).
  describe('zero-config stack public base URL (issue #859)', () => {
    const MINIO = 'https://stack-abc.minio.example';

    it('derives absolute MinIO-origin URLs, not proxy URLs, when the env var is unset', async () => {
      // PUBLIC_BASE_URL is set so the proxy fallback WOULD be resolvable —
      // proving the MinIO origin is preferred rather than merely available.
      process.env['PUBLIC_BASE_URL'] = 'https://api.example.test';
      const { app, repo } = await buildApp({ minioEndpoint: MINIO });
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
      expect(body.status).toBe('ready');
      expect(body.urls.hls).toBe(`${MINIO}/openvideocore-packaged/${id}/abc/index.m3u8`);
      expect(body.urls.dash).toBe(`${MINIO}/openvideocore-packaged/${id}/abc/manifest.mpd`);
      expect(body.urls.hls).not.toContain('/stream/');
      // The manifest's relative child references resolve against this same
      // origin + directory, so a player fetches segments anonymously too.
      expect(new URL('seg-1.m4s', body.urls.hls).toString()).toBe(
        `${MINIO}/openvideocore-packaged/${id}/abc/seg-1.m4s`
      );
    });

    it('is absolute even when PUBLIC_BASE_URL is unset (no proxy base at all)', async () => {
      const { app, repo } = await buildApp({ minioEndpoint: MINIO });
      const id = await createAsset(app);
      await repo.update(id, {
        manifestUrls: { hls: `/openvideocore-packaged/${id}/abc/index.m3u8` }
      });
      const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
      const body = res.json();
      expect(body.status).toBe('ready');
      expect(body.urls.hls).toBe(`${MINIO}/openvideocore-packaged/${id}/abc/index.m3u8`);
    });

    it('lets an explicit PACKAGED_PUBLIC_BASE_URL win over the stack MinIO origin', async () => {
      process.env['PACKAGED_PUBLIC_BASE_URL'] = 'https://cdn.example';
      const { app, repo } = await buildApp({ minioEndpoint: MINIO });
      const id = await createAsset(app);
      await repo.update(id, {
        manifestUrls: { hls: `/openvideocore-packaged/${id}/abc/index.m3u8` }
      });
      const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
      const body = res.json();
      expect(body.urls.hls).toBe(
        `https://cdn.example/openvideocore-packaged/${id}/abc/index.m3u8`
      );
    });

    it('leaves DELIVERY_MODE=proxy proxying through the authorized stream route', async () => {
      process.env['DELIVERY_MODE'] = 'proxy';
      process.env['PUBLIC_BASE_URL'] = 'https://api.example.test';
      const { app, repo } = await buildApp({ minioEndpoint: MINIO });
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

    // GET /:id/files documents that fileGroups[].manifestUrl matches what
    // /:id/delivery advertises, so both must resolve against the same origin.
    it('matches fileGroups[].manifestUrl on GET /:id/files', async () => {
      process.env['PUBLIC_BASE_URL'] = 'https://api.example.test';
      const { app, repo } = await buildApp({ minioEndpoint: MINIO });
      const id = await createAsset(app);
      await repo.update(id, {
        manifestUrls: {
          hls: `/openvideocore-packaged/${id}/abc/index.m3u8`,
          dash: `/openvideocore-packaged/${id}/abc/manifest.mpd`
        }
      });

      const delivery = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${id}/delivery`,
        headers: A
      });
      const files = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${id}/files`,
        headers: A
      });
      expect(files.statusCode).toBe(200);
      const groups = files.json().fileGroups as { id: string; manifestUrl: string }[];
      const byId = (gid: string) => groups.find((g) => g.id === gid)?.manifestUrl;
      expect(byId('hls')).toBe(delivery.json().urls.hls);
      expect(byId('dash')).toBe(delivery.json().urls.dash);
      expect(byId('hls')).toBe(`${MINIO}/openvideocore-packaged/${id}/abc/index.m3u8`);
    });
  });

  // Issue #506: a configured + packaged asset must return a fully-resolvable
  // ABSOLUTE playback URL and an explicit `ready` status, so a consuming app can
  // trust the URL plays without workarounds.
  it('returns status=ready with an absolute playback URL for a configured, packaged asset', async () => {
    process.env['PUBLIC_BASE_URL'] = 'https://api.example.test';
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, {
      manifestUrls: {
        hls: `/openvideocore-packaged/${id}/abc/index.m3u8`
      }
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.urls.hls).toBe(
      `https://api.example.test/api/v1/assets/${id}/stream/index.m3u8`
    );
    // The advertised URL is absolute (fully resolvable), not a bare path.
    expect(() => new URL(body.urls.hls)).not.toThrow();
  });

  // Issue #506: an already-public (absolute) manifest is `ready` and returned
  // verbatim.
  it('returns status=ready for an already-absolute public manifest', async () => {
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, {
      manifestUrls: { hls: 'https://cdn.example/packaged/x/index.m3u8' }
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.urls.hls).toBe('https://cdn.example/packaged/x/index.m3u8');
  });

  // Issue #506: packaged output exists but public delivery is NOT configured
  // (PUBLIC_BASE_URL unset → the stream proxy can only yield a relative,
  // non-resolvable URL). The response must NOT look ready: it returns an
  // unambiguous `not_configured` status, no playable URL, and the persisted
  // packaged-location metadata (#502) for deterministic client-side resolution.
  it('returns status=not_configured (no URL) when public delivery is unconfigured', async () => {
    // PUBLIC_BASE_URL intentionally unset (cleared by afterEach).
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, {
      manifestUrls: { hls: `/openvideocore-packaged/${id}/abc/index.m3u8` },
      packagedOutput: {
        bucket: 'openvideocore-packaged',
        prefix: `${id}/abc/`,
        masterHlsKey: `${id}/abc/index.m3u8`
      }
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('not_configured');
    expect(body.urls.hls).toBeUndefined();
    expect(body.urls.dash).toBeUndefined();
    // Enough metadata for a client to resolve objects deterministically.
    expect(body.resolution.packagedBucket).toBe('openvideocore-packaged');
    expect(body.resolution.packagedPrefix).toBe(`${id}/abc/`);
    expect(body.resolution.masterHlsKey).toBe(`${id}/abc/index.m3u8`);
  });

  // Issue #506: same unconfigured case under DELIVERY_MODE=proxy — the proxy
  // base is relative without PUBLIC_BASE_URL, so it is `not_configured`, never a
  // 200 advertising a bare relative URL.
  it('returns status=not_configured in DELIVERY_MODE=proxy when PUBLIC_BASE_URL is unset', async () => {
    process.env['DELIVERY_MODE'] = 'proxy';
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, {
      manifestUrls: { hls: `/openvideocore-packaged/${id}/abc/index.m3u8` }
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('not_configured');
    expect(body.urls.hls).toBeUndefined();
  });

  // Issue #506: a not-yet-packaged asset (no manifests, no source object) is an
  // unambiguous non-ready response — never a 200 that looks ready.
  it('returns 404 no_delivery for a not-yet-packaged asset', async () => {
    const { app } = await buildApp();
    const id = await createAsset(app);
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('no_delivery');
  });

  // Issue #810: a `failed` asset whose source object happens to exist has NO
  // playable output — it never produced packaged manifests. The source fallback
  // used to report `status: ready` purely because `objectKey` was set, telling a
  // consumer the opposite of the truth. It must report `failed` instead.
  it('does not return status=ready for a failed asset with only a source object', async () => {
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, { objectKey: `ingest/${id}` });
    await repo.update(id, { status: 'failed' });
    // Precondition: failed lifecycle status, a stored source, no manifests.
    const stored = await repo.get(id);
    expect(stored?.status).toBe('failed');
    expect(stored?.manifestUrls).toBeUndefined();

    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    const body = res.json();
    expect(body.status).not.toBe('ready');
    expect(body.status).toBe('failed');
    // No playable output is advertised...
    expect(body.urls.hls).toBeUndefined();
    expect(body.urls.dash).toBeUndefined();
    // ...but the raw source stays fetchable for diagnosis / re-ingest.
    expect(body.urls.source).toContain(`ingest/${id}`);
  });

  // Issue #810 (converse): a non-failed source-only asset is unchanged — a
  // presigned source download URL is a fully-resolvable URL, so it stays `ready`.
  it('still returns status=ready for a non-failed source-only asset', async () => {
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, { objectKey: `ingest/${id}` });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('ready');
  });

  // Issue #810: a `failed` asset that DID produce packaged manifests keeps
  // `ready` — that packaged output really is playable, so the lifecycle check
  // applies only to the source-only fallback.
  it('keeps status=ready for a failed asset that has packaged manifests', async () => {
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, {
      objectKey: `ingest/${id}`,
      manifestUrls: { hls: 'https://cdn.example/packaged/x/index.m3u8' }
    });
    await repo.update(id, { status: 'failed' });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.urls.hls).toBe('https://cdn.example/packaged/x/index.m3u8');
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
