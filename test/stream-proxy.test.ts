// Packaged-output stream proxy route tests (issue #339).
//
// GET /api/v1/assets/:id/stream/* streams packaged manifests + CMAF segments
// back through the authorized API using the stack's admin credentials, so the
// packaged bucket can stay private (OSC MinIO blocks anonymous/presigned GET —
// see docs/osc-feedback/incoming-minio-presigned-blocked.md). This route is the
// foundation of proxied delivery. These tests lock in:
//   - master manifest (index.m3u8) -> 200 with the manifest body + HLS type
//   - a nested child path (audio/audio.m3u8) -> 200 (wildcard captures the rest)
//   - a segment (.m4s / .ts) -> 200 with the segment content type
//   - HTTP Range on a segment -> 206 with Content-Range + the ranged bytes
//   - an object in another workspace -> 404 (never another tenant's bytes)
//   - a missing packaged object -> 404
//
// The object bytes are resolved under the asset's deterministic packaged prefix
// `packaged/<id>/<relative>` (src/pipeline/packaging.ts outputPrefix) inside the
// packaged bucket, via WorkspaceStorage.getObject / getPartialObject / statObject
// (src/data/storage.ts). request.connections supplies the admin storageClient +
// packagedBucket, mirroring the production preHandler in src/main.ts.

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      const map: Record<string, string> = {
        'token-a': 'workspace-a',
        'token-b': 'workspace-b'
      };
      const ws = token ? map[token] : undefined;
      if (!ws) throw new actual.AuthError('invalid token');
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import type { Asset } from '../src/data/asset-repo.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

// A fake MinIO client backing the WorkspaceStorage the route builds. Objects are
// keyed by their full object key (e.g. `packaged/<id>/index.m3u8`). getObject /
// getPartialObject / statObject mirror the minio.Client contract the route uses
// (getPartialObject(bucket, key, offset, length?) -> Readable of the slice).
type StoredObject = { body: Buffer };
function makeStorageClient(objects: Map<string, StoredObject>) {
  const notFound = () => Object.assign(new Error('missing'), { code: 'NoSuchKey' });
  return {
    async statObject(_bucket: string, key: string) {
      const obj = objects.get(key);
      if (!obj) throw notFound();
      return { size: obj.body.length, etag: 'etag' };
    },
    async getObject(_bucket: string, key: string): Promise<Readable> {
      const obj = objects.get(key);
      if (!obj) throw notFound();
      return Readable.from(obj.body);
    },
    async getPartialObject(
      _bucket: string,
      key: string,
      offset: number,
      length?: number
    ): Promise<Readable> {
      const obj = objects.get(key);
      if (!obj) throw notFound();
      const end = length === undefined ? obj.body.length : offset + length;
      return Readable.from(obj.body.subarray(offset, end));
    }
  };
}

// A workspace-scoped asset repository stub. Mirrors the production
// PerWorkspaceAssetRepository guard: get(id) only resolves an asset that belongs
// to THIS workspace's stack; a foreign asset resolves to undefined (-> 404),
// which is how the route enforces cross-tenant isolation.
function makeRepo(assets: Map<string, Asset>) {
  return {
    async get(id: string): Promise<Asset | undefined> {
      return assets.get(id);
    }
  };
}

async function buildApp(opts: {
  objects: Map<string, StoredObject>;
  assets: Map<string, Asset>;
  withStorage?: boolean;
}): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);

  const storageClient = makeStorageClient(opts.objects);
  app.decorateRequest('connections', null);
  app.addHook('preHandler', async (request) => {
    (request as unknown as { connections: unknown }).connections = {
      storageClient: opts.withStorage === false ? undefined : storageClient,
      packagedBucket: 'openvideocore-packaged'
    };
  });

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    // Cast: the route only calls repo.get(id); the stub implements just that,
    // matching the production workspace-scoped repository's guard behaviour.
    repository: makeRepo(opts.assets) as never,
    // storageFor is unrelated to this route (it uses request.connections), but a
    // truthy value keeps the router out of any storage-absent early paths.
    storageFor: (() => ({})) as never,
    outputBucket: 'openvideocore-packaged'
  });
  await app.ready();
  return app;
}

function asset(id: string): Asset {
  const now = new Date().toISOString();
  return {
    id,
    name: 'clip',
    status: 'ready',
    createdAt: now,
    updatedAt: now
  } as Asset;
}

describe('GET /:id/stream/*', () => {
  it('returns 200 + the master manifest body with the HLS content type', async () => {
    const id = 'asset-1';
    const body = Buffer.from('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1\nv/playlist.m3u8\n');
    const app = await buildApp({
      assets: new Map([[id, asset(id)]]),
      objects: new Map([[`packaged/${id}/index.m3u8`, { body }]])
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/stream/index.m3u8`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.rawPayload.equals(body)).toBe(true);
  });

  it('returns 200 for a nested child path (audio group playlist)', async () => {
    const id = 'asset-1';
    const body = Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:6\n');
    const app = await buildApp({
      assets: new Map([[id, asset(id)]]),
      objects: new Map([[`packaged/${id}/audio/audio.m3u8`, { body }]])
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/stream/audio/audio.m3u8`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    expect(res.rawPayload.equals(body)).toBe(true);
  });

  it('serves the DASH manifest with the DASH content type', async () => {
    const id = 'asset-1';
    const body = Buffer.from('<?xml version="1.0"?><MPD></MPD>');
    const app = await buildApp({
      assets: new Map([[id, asset(id)]]),
      objects: new Map([[`packaged/${id}/manifest.mpd`, { body }]])
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/stream/manifest.mpd`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/dash+xml');
  });

  it('serves a CMAF segment with the ISO segment content type', async () => {
    const id = 'asset-1';
    const body = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const app = await buildApp({
      assets: new Map([[id, asset(id)]]),
      objects: new Map([[`packaged/${id}/v/seg-00001.m4s`, { body }]])
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/stream/v/seg-00001.m4s`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/iso.segment');
  });

  it('serves a TS segment with the MPEG-TS content type', async () => {
    const id = 'asset-1';
    const body = Buffer.from([71, 0, 0, 0]);
    const app = await buildApp({
      assets: new Map([[id, asset(id)]]),
      objects: new Map([[`packaged/${id}/v/seg-1.ts`, { body }]])
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/stream/v/seg-1.ts`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp2t');
  });

  it('honors a Range request on a segment with 206 + Content-Range', async () => {
    const id = 'asset-1';
    const body = Buffer.from([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const app = await buildApp({
      assets: new Map([[id, asset(id)]]),
      objects: new Map([[`packaged/${id}/v/seg-00001.m4s`, { body }]])
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/stream/v/seg-00001.m4s`,
      headers: { ...A, range: 'bytes=2-5' }
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.headers['content-length']).toBe('4');
    expect(res.rawPayload.equals(Buffer.from([2, 3, 4, 5]))).toBe(true);
  });

  it('returns 416 for a range beyond the object size', async () => {
    const id = 'asset-1';
    const body = Buffer.from([0, 1, 2, 3]);
    const app = await buildApp({
      assets: new Map([[id, asset(id)]]),
      objects: new Map([[`packaged/${id}/v/seg-00001.m4s`, { body }]])
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/stream/v/seg-00001.m4s`,
      headers: { ...A, range: 'bytes=100-200' }
    });
    expect(res.statusCode).toBe(416);
    expect(res.headers['content-range']).toBe('bytes */4');
  });

  it('returns 404 for a missing packaged object', async () => {
    const id = 'asset-1';
    const app = await buildApp({
      assets: new Map([[id, asset(id)]]),
      objects: new Map()
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/stream/index.m3u8`,
      headers: A
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 404 for an asset in another workspace (never another tenant bytes)', async () => {
    const id = 'asset-1';
    // The object EXISTS in the packaged bucket, but the caller's workspace has no
    // such asset (the workspace-scoped repo returns undefined), so the route must
    // never open the object stream.
    const app = await buildApp({
      // Empty asset map models a foreign-workspace caller: get(id) -> undefined.
      assets: new Map(),
      objects: new Map([[`packaged/${id}/index.m3u8`, { body: Buffer.from('secret') }]])
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/stream/index.m3u8`,
      headers: auth('token-b')
    });
    expect(res.statusCode).toBe(404);
    expect(res.rawPayload.includes(Buffer.from('secret'))).toBe(false);
  });

  it('rejects a traversal path with 404', async () => {
    const id = 'asset-1';
    const app = await buildApp({
      assets: new Map([[id, asset(id)]]),
      objects: new Map()
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/stream/..%2f..%2fsecret`,
      headers: A
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 501 when object storage is not configured', async () => {
    const id = 'asset-1';
    const app = await buildApp({
      assets: new Map([[id, asset(id)]]),
      objects: new Map(),
      withStorage: false
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/stream/index.m3u8`,
      headers: A
    });
    expect(res.statusCode).toBe(501);
  });
});
