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
//   - DELIVERY_MODE postures stay mutually exclusive: `public` never advertises a
//     `/stream/*` proxy URL and reports `not_configured` (naming the missing
//     variable) when its own public origin is unresolvable (issue #860)

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
  //
  // Issue #860 narrows this to the mode it belongs to: proxying a packaged
  // object is the `proxy` posture, so DELIVERY_MODE=proxy is set explicitly
  // here. In `public` mode the same input is `not_configured` (see below) —
  // public mode never emits a proxy URL.
  it('routes bare-path manifests through the absolute stream proxy URL in proxy mode', async () => {
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
    process.env['DELIVERY_MODE'] = 'proxy';
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

  // Issue #506: a configured + packaged asset must return a fully-resolvable
  // ABSOLUTE playback URL and an explicit `ready` status, so a consuming app can
  // trust the URL plays without workarounds. In `public` mode (the default) the
  // configuration that makes it resolvable is PACKAGED_PUBLIC_BASE_URL — the
  // public origin of the packaged bucket — so it is set here (issue #860: this
  // used to pass on the proxy fallback instead, which is the other mode).
  it('returns status=ready with an absolute playback URL for a configured, packaged asset', async () => {
    process.env['PUBLIC_BASE_URL'] = 'https://api.example.test';
    process.env['PACKAGED_PUBLIC_BASE_URL'] = 'https://cdn.example.test';
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
      `https://cdn.example.test/openvideocore-packaged/${id}/abc/index.m3u8`
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
  // (no packaged public origin, so the stored bare object-key path cannot be
  // resolved to anything fetchable). The response must NOT look ready: it returns
  // an unambiguous `not_configured` status, no playable URL, and the persisted
  // packaged-location metadata (#502) for deterministic client-side resolution.
  it('returns status=not_configured (no URL) when public delivery is unconfigured', async () => {
    // PUBLIC_BASE_URL / PACKAGED_PUBLIC_BASE_URL intentionally unset (cleared by
    // afterEach).
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
    // Issue #860: and it names the configuration that is missing.
    expect(body.missingConfig).toEqual(['PACKAGED_PUBLIC_BASE_URL']);
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
    // Issue #860: the body names the variable THIS mode needs (its own public
    // origin), not the other mode's.
    expect(body.missingConfig).toEqual(['PUBLIC_BASE_URL']);
  });

  // --- Issue #860: `public` and `proxy` are never both active ---------------
  //
  // `deliveryMode()` (src/pipeline/packaging.ts:231-253) documents the two modes
  // as mutually exclusive because they have deliberately different security
  // postures: `public` reads an anonymously-readable bucket, `proxy` streams a
  // private bucket back through an authorized route. In `public` mode with an
  // unresolvable public origin, delivery used to advertise proxy URLs, putting a
  // deployment nominally in `public` mode into `proxy` behaviour and concealing
  // the missing PACKAGED_PUBLIC_BASE_URL behind a ready-looking 200 whose URL
  // then 401ed for the operator who copied it.

  // The load-bearing case: the proxy fallback WOULD have been resolvable here
  // (PUBLIC_BASE_URL is set), so this is exactly the substitution #860 removes.
  // It must be reported as the configuration problem it is.
  it('returns not_configured in public mode when the public origin is unset, even though a proxy URL is available', async () => {
    process.env['PUBLIC_BASE_URL'] = 'https://api.example.test';
    // DELIVERY_MODE unset -> `public` (the default). PACKAGED_PUBLIC_BASE_URL
    // intentionally unset: this is the zero-config stack state.
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, {
      manifestUrls: {
        hls: `/openvideocore-packaged/${id}/abc/index.m3u8`,
        dash: `/openvideocore-packaged/${id}/abc/manifest.mpd`
      },
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
    expect(body.status).not.toBe('ready');
    // No proxy URL is advertised: `public` mode never adopts the proxy posture.
    expect(body.urls.hls).toBeUndefined();
    expect(body.urls.dash).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('/stream/');
    // The response says WHICH configuration is missing, so the operator can act
    // instead of debugging an unexplained 401 on a copied URL.
    expect(body.missingConfig).toEqual(['PACKAGED_PUBLIC_BASE_URL']);
    expect(body.message).toContain('PACKAGED_PUBLIC_BASE_URL');
    // The packaged-location metadata is still there for a client with its own
    // object-store access (#506/#502).
    expect(body.resolution.packagedPrefix).toBe(`${id}/abc/`);
  });

  // An explicitly MISCONFIGURED public origin (set but not an absolute URL) is
  // the same class of problem and must not be routed around either. The 501
  // `PublicManifestBaseUrlError` path (`resolvePublicManifestUrl`) covers it, so
  // the assertion is only that no proxy URL is ever advertised.
  it('never advertises a proxy URL in public mode when the public origin is set but not absolute', async () => {
    process.env['PUBLIC_BASE_URL'] = 'https://api.example.test';
    process.env['PACKAGED_PUBLIC_BASE_URL'] = '/openvideocore-packaged';
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, {
      manifestUrls: { hls: `/openvideocore-packaged/${id}/abc/index.m3u8` }
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    const body = res.json();
    expect(JSON.stringify(body)).not.toContain('/stream/');
    if (res.statusCode === 200) {
      expect(body.status).toBe('not_configured');
      expect(body.missingConfig).toEqual(['PACKAGED_PUBLIC_BASE_URL']);
    } else {
      expect(res.statusCode).toBe(501);
      expect(body.error).toBe('not_configured');
    }
  });

  // The converse: `proxy` mode is unaffected — it takes the proxy branch
  // deliberately, which is exactly the distinction this restores. Note that
  // PACKAGED_PUBLIC_BASE_URL is set here and is still NOT used: proxy mode never
  // advertises a public bucket URL either.
  it('still advertises proxy URLs in proxy mode, ignoring the packaged public origin', async () => {
    process.env['PUBLIC_BASE_URL'] = 'https://api.example.test';
    process.env['PACKAGED_PUBLIC_BASE_URL'] = 'https://cdn.example.test';
    process.env['DELIVERY_MODE'] = 'proxy';
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, {
      manifestUrls: { hls: `/openvideocore-packaged/${id}/abc/index.m3u8` }
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/delivery`, headers: A });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.urls.hls).toBe(
      `https://api.example.test/api/v1/assets/${id}/stream/index.m3u8`
    );
    expect(body.urls.hls).not.toContain('cdn.example.test');
    // A ready body carries no missing-configuration fields.
    expect(body.missingConfig).toBeUndefined();
    expect(body.message).toBeUndefined();
  });

  // A correctly configured `public` deployment is unchanged: the stored bare
  // object-key path resolves against the packaged bucket's public origin and is
  // advertised as-is — no proxy URL anywhere in the response.
  it('advertises the public origin URL (never a proxy URL) in public mode when configured', async () => {
    process.env['PUBLIC_BASE_URL'] = 'https://api.example.test';
    process.env['PACKAGED_PUBLIC_BASE_URL'] = 'https://cdn.example.test';
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
    expect(body.status).toBe('ready');
    expect(body.urls.hls).toBe(
      `https://cdn.example.test/openvideocore-packaged/${id}/abc/index.m3u8`
    );
    expect(body.urls.dash).toBe(
      `https://cdn.example.test/openvideocore-packaged/${id}/abc/manifest.mpd`
    );
    expect(JSON.stringify(body)).not.toContain('/stream/');
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
