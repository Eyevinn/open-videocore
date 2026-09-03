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
    },
    // The minio listObjectsV2(bucket, prefix, recursive) -> stream of { name }
    // surface the lazy packaged-prefix resolver (resolvePackagedOutput, issue
    // #502/#503) uses for assets with no persisted `packagedOutput` prefix. It
    // lists the packaged bucket under `<assetId>/` to derive the newest job
    // prefix. Contract verified: src/pipeline/packaging.ts PackagedObjectLister /
    // src/data/storage.ts:226.
    listObjectsV2(_bucket: string, prefix: string, _recursive: boolean): Readable {
      const matched = [...objects.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((name) => ({ name }));
      return Readable.from(matched);
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

function asset(id: string, packagedOutput?: Asset['packagedOutput']): Asset {
  const now = new Date().toISOString();
  return {
    id,
    name: 'clip',
    status: 'ready',
    createdAt: now,
    updatedAt: now,
    ...(packagedOutput ? { packagedOutput } : {})
  } as Asset;
}

describe('GET /:id/stream/*', () => {
  it('returns 200 + the master manifest with the HLS content type and a rewritten variant URI', async () => {
    const id = 'asset-1';
    // A bare variant-playlist line in the master. Once rewritten it must resolve
    // back through the proxy prefix (issue #340), not stay a bare relative path
    // that a player would (correctly) resolve against the manifest URL anyway —
    // but which breaks the moment the packager emits a prefix-absolute path.
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
    // The variant URI now points back through the proxy stream prefix.
    expect(res.body).toContain(`/api/v1/assets/${id}/stream/v/playlist.m3u8`);
    // The original bare relative reference is gone (rewritten).
    expect(res.body).not.toMatch(/^v\/playlist\.m3u8$/m);
    // Manifests are rewritten in full, so Range is not advertised on them.
    expect(res.headers['accept-ranges']).toBeUndefined();
  });

  it('returns 200 for a nested child path (audio group playlist)', async () => {
    const id = 'asset-1';
    const body = Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:6\nseg-1.m4s\n');
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
    // A segment referenced relative to a nested variant resolves into that
    // variant's directory under the proxy prefix.
    expect(res.body).toContain(`/api/v1/assets/${id}/stream/audio/seg-1.m4s`);
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

// Issue #503: the packager writes every object of a package under a JOB-NESTED
// prefix (`<assetId>/<packagerJobId>/`), persisted as `packagedOutput.prefix`
// by issue #502 — NOT under the historical flat `packaged/<id>`. Before this
// fix, `/stream/index.m3u8` mapped to the flat path and 404ed. These tests lock
// in that the proxy resolves objects (master manifest, child playlists, media
// segments) under the REAL persisted prefix, and that relative references are
// rewritten to resolve back through the SAME `/stream/*` route.
describe('GET /:id/stream/* resolves the packaged prefix (issue #503)', () => {
  // The real packaged layout for `asset-9`: master HLS references a relative
  // child playlist (`video-0_3022.m3u8`) which references relative media
  // (`video-0_3022/init.mp4`, `video-0_3022/1.m4s`) — the exact shape called out
  // in the issue. All objects live under `<assetId>/<jobId>/`.
  const ID = 'asset-9';
  const JOB = '01JOBULIDXXXXXXXXXXXXXXXXX';
  const PREFIX = `${ID}/${JOB}/`;
  const packagedOutput = {
    bucket: 'openvideocore-packaged',
    prefix: PREFIX,
    masterHlsKey: `${PREFIX}index.m3u8`,
    masterDashKey: `${PREFIX}manifest.mpd`
  };
  const masterBody = Buffer.from(
    '#EXTM3U\n' +
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",URI="audio.m3u8"\n' +
      '#EXT-X-STREAM-INF:BANDWIDTH=3022000,AUDIO="aud"\n' +
      'video-0_3022.m3u8\n'
  );
  const childBody = Buffer.from(
    '#EXTM3U\n' +
      '#EXT-X-MAP:URI="video-0_3022/init.mp4"\n' +
      '#EXTINF:6.0,\n' +
      'video-0_3022/1.m4s\n'
  );

  function packagedObjects(): Map<string, StoredObject> {
    return new Map<string, StoredObject>([
      [`${PREFIX}index.m3u8`, { body: masterBody }],
      [`${PREFIX}audio.m3u8`, { body: Buffer.from('#EXTM3U\naudio/seg-1.m4s\n') }],
      [`${PREFIX}video-0_3022.m3u8`, { body: childBody }],
      [`${PREFIX}video-0_3022/init.mp4`, { body: Buffer.from([0, 1, 2, 3]) }],
      [`${PREFIX}video-0_3022/1.m4s`, { body: Buffer.from([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]) }]
    ]);
  }

  it('index.m3u8 returns 200 with the real master manifest from the persisted prefix', async () => {
    const app = await buildApp({
      assets: new Map([[ID, asset(ID, packagedOutput)]]),
      objects: packagedObjects()
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${ID}/stream/index.m3u8`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    // The relative child playlist + audio group are rewritten back through the
    // proxy, so a browser fetches them from `/stream/*` (never the bucket).
    expect(res.body).toContain(`/api/v1/assets/${ID}/stream/video-0_3022.m3u8`);
    expect(res.body).toContain(`URI="/api/v1/assets/${ID}/stream/audio.m3u8"`);
  });

  it('a relatively-referenced child playlist resolves 200 through /stream/*', async () => {
    const app = await buildApp({
      assets: new Map([[ID, asset(ID, packagedOutput)]]),
      objects: packagedObjects()
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${ID}/stream/video-0_3022.m3u8`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    // The child's relative media references resolve back through the proxy.
    expect(res.body).toContain(`URI="/api/v1/assets/${ID}/stream/video-0_3022/init.mp4"`);
    expect(res.body).toContain(`/api/v1/assets/${ID}/stream/video-0_3022/1.m4s`);
  });

  it('a relatively-referenced media segment resolves 200 with the ISO segment type', async () => {
    const app = await buildApp({
      assets: new Map([[ID, asset(ID, packagedOutput)]]),
      objects: packagedObjects()
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${ID}/stream/video-0_3022/1.m4s`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/iso.segment');
    expect(res.headers['accept-ranges']).toBe('bytes');
  });

  it('honors a Range request on a segment resolved from the persisted prefix', async () => {
    const app = await buildApp({
      assets: new Map([[ID, asset(ID, packagedOutput)]]),
      objects: packagedObjects()
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${ID}/stream/video-0_3022/1.m4s`,
      headers: { ...A, range: 'bytes=2-5' }
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe('bytes 2-5/10');
    expect(res.headers['content-length']).toBe('4');
    expect(res.rawPayload.equals(Buffer.from([7, 6, 5, 4]))).toBe(true);
  });

  it('the init segment (.mp4) resolves 200 with the MP4 content type', async () => {
    const app = await buildApp({
      assets: new Map([[ID, asset(ID, packagedOutput)]]),
      objects: packagedObjects()
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${ID}/stream/video-0_3022/init.mp4`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('video/mp4');
  });

  it('lazily resolves the newest job prefix for a pre-#502 asset (no persisted prefix)', async () => {
    // No `packagedOutput` on the asset — the resolver lists the packaged bucket
    // under `<assetId>/` and derives the newest job prefix. Two job folders exist;
    // the lexicographically greatest (`job-b`) is the newest package.
    const objects = new Map<string, StoredObject>([
      [`${ID}/job-a/index.m3u8`, { body: Buffer.from('#EXTM3U\nstale\n') }],
      [`${ID}/job-b/index.m3u8`, { body: masterBody }]
    ]);
    const app = await buildApp({
      assets: new Map([[ID, asset(ID)]]),
      objects
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${ID}/stream/index.m3u8`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/vnd.apple.mpegurl');
    // Served from the NEWEST job (`job-b`), not the stale one.
    expect(res.body).toContain('video-0_3022.m3u8');
    expect(res.body).not.toContain('stale');
  });
});
