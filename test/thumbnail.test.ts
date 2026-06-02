// Thumbnail / poster-frame extraction tests (issue #7).
//
// Covers:
//   - the orchestration in extractThumbnails (dedupe, key naming, repo write)
//   - the OSC ffmpeg cmdline builder + ephemeral-job runner lifecycle
//   - the assets router endpoints (POST/GET /:id/thumbnails) with statuses
//     200, 404, 409, 501, 502
//
// The extractor is AWAITED by the route, so tests assert on the synchronous
// response and the resulting asset document directly.

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
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import {
  extractThumbnails,
  frameKeySuffix,
  thumbnailObjectKey,
  type FrameExtractor,
  type FrameTarget
} from '../src/pipeline/thumbnail.js';
import {
  makeOscThumbnailExtractor,
  thumbnailCmdLine,
  type OscJobApi
} from '../src/pipeline/osc-thumbnail.js';
import type { WorkspaceStorage } from '../src/data/storage.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

function fakeStorage(): WorkspaceStorage {
  return {
    presignedGet: vi.fn(async (key: string) => `https://minio.example/${key}?sig=get`),
    presignedPut: vi.fn(async (key: string) => `https://minio.example/${key}?sig=put`)
  } as unknown as WorkspaceStorage;
}

async function buildApp(opts: {
  thumbnailExtractor?: FrameExtractor;
  withStorage?: boolean;
  thumbnailPublicBaseUrl?: string;
} = {}): Promise<{ app: FastifyInstance; repo: InMemoryAssetRepository }> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryAssetRepository();
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    storageFor: opts.withStorage === false ? undefined : () => fakeStorage(),
    thumbnailExtractor: opts.thumbnailExtractor,
    thumbnailPublicBaseUrl: opts.thumbnailPublicBaseUrl
  });
  await app.ready();
  return { app, repo };
}

async function createAssetWithObject(app: FastifyInstance, repo: InMemoryAssetRepository) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: A,
    payload: { name: 'clip' }
  });
  const id = res.json().id as string;
  await repo.update('workspace-a', id, { objectKey: `ingest/${id}` });
  return id;
}

describe('thumbnail object key naming', () => {
  it('rounds timecodes to integer seconds', () => {
    expect(frameKeySuffix(12.4)).toBe('12s');
    expect(frameKeySuffix(12.6)).toBe('13s');
    expect(frameKeySuffix(-5)).toBe('0s');
  });

  it('builds the documented key shape', () => {
    expect(thumbnailObjectKey('asset-1', 30)).toBe('thumbnails/asset-1/thumb_30s.jpg');
  });
});

describe('extractThumbnails orchestration', () => {
  it('dedupes, sorts, stores keys, and records them on the asset', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create('workspace-a', { name: 'x', objectKey: 'ingest/x' });
    const seen: FrameTarget[] = [];
    const extractor: FrameExtractor = vi.fn(async (_url, frames) => {
      seen.push(...frames);
    });

    const result = await extractThumbnails(
      {
        workspaceId: 'workspace-a',
        assetId: asset.id,
        objectKey: 'ingest/x',
        timecodes: [10, 5, 10.2]
      },
      { assets: repo, storage: fakeStorage(), extractor }
    );

    expect(result).toEqual([
      thumbnailObjectKey(asset.id, 5),
      thumbnailObjectKey(asset.id, 10)
    ]);
    expect(seen).toHaveLength(2);
    const stored = await repo.get('workspace-a', asset.id);
    expect(stored?.thumbnails).toEqual(result);
  });

  it('does not overwrite prior thumbnails when extraction fails', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create('workspace-a', { name: 'x', objectKey: 'ingest/x' });
    await repo.update('workspace-a', asset.id, { thumbnails: ['old/key.jpg'] });
    const extractor: FrameExtractor = vi.fn(async () => {
      throw new Error('ffmpeg exited 1');
    });

    await expect(
      extractThumbnails(
        { workspaceId: 'workspace-a', assetId: asset.id, objectKey: 'ingest/x', timecodes: [1] },
        { assets: repo, storage: fakeStorage(), extractor }
      )
    ).rejects.toThrow('ffmpeg exited 1');

    const stored = await repo.get('workspace-a', asset.id);
    expect(stored?.thumbnails).toEqual(['old/key.jpg']);
  });
});

describe('thumbnailCmdLine', () => {
  it('emits one seek + single-frame output per frame', () => {
    const frames: FrameTarget[] = [
      { timecodeSeconds: 5, objectKey: 'k1', putUrl: 'https://minio/k1?sig=a' },
      { timecodeSeconds: 30, objectKey: 'k2', putUrl: 'https://minio/k2?sig=b' }
    ];
    const cmd = thumbnailCmdLine('https://minio/src?sig=s', frames);
    expect(cmd).toContain('-ss 5');
    expect(cmd).toContain('-ss 30');
    expect(cmd).toContain('-frames:v 1');
    expect(cmd).toContain('"https://minio/k1?sig=a"');
    expect(cmd).toContain('"https://minio/k2?sig=b"');
  });

  it('throws when no frames are requested', () => {
    expect(() => thumbnailCmdLine('https://minio/src', [])).toThrow(/no frames/);
  });
});

describe('makeOscThumbnailExtractor', () => {
  function fakeApi(): OscJobApi {
    const context = {
      getServiceAccessToken: vi.fn(async () => 'sat-token')
    } as unknown as OscJobApi['context'];
    return {
      context,
      createJob: vi.fn(async () => ({ name: 'x' })),
      waitForJobToComplete: vi.fn(async () => undefined),
      getLogsForInstance: vi.fn(async () => ''),
      removeJob: vi.fn(async () => undefined)
    } as unknown as OscJobApi;
  }

  it('creates a job, waits, and cleans up', async () => {
    const api = fakeApi();
    await makeOscThumbnailExtractor(api)('https://minio/src', [
      { timecodeSeconds: 1, objectKey: 'k', putUrl: 'https://minio/k' }
    ]);
    expect(api.createJob).toHaveBeenCalledOnce();
    expect(api.waitForJobToComplete).toHaveBeenCalledOnce();
    expect(api.removeJob).toHaveBeenCalledOnce();
  });

  it('still cleans up the job when the wait fails', async () => {
    const api = fakeApi();
    (api.waitForJobToComplete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    await expect(
      makeOscThumbnailExtractor(api)('https://minio/src', [
        { timecodeSeconds: 1, objectKey: 'k', putUrl: 'https://minio/k' }
      ])
    ).rejects.toThrow('boom');
    expect(api.removeJob).toHaveBeenCalledOnce();
  });
});

describe('POST /:id/thumbnails', () => {
  it('returns 200 with stored keys on success', async () => {
    const extractor: FrameExtractor = vi.fn(async () => undefined);
    const { app, repo } = await buildApp({ thumbnailExtractor: extractor });
    const id = await createAssetWithObject(app, repo);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/thumbnails`,
      headers: A,
      payload: { timecodes: [0, 15] }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().thumbnails).toEqual([
      thumbnailObjectKey(id, 0),
      thumbnailObjectKey(id, 15)
    ]);
    expect(extractor).toHaveBeenCalledOnce();
    const asset = await repo.get('workspace-a', id);
    expect(asset?.thumbnails).toHaveLength(2);
  });

  it('returns 502 when the OSC job fails', async () => {
    const extractor: FrameExtractor = vi.fn(async () => {
      throw new Error('ffmpeg exited 1');
    });
    const { app, repo } = await buildApp({ thumbnailExtractor: extractor });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/thumbnails`,
      headers: A,
      payload: { timecodes: [1] }
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('thumbnail_extraction_failed');
  });

  it('returns 409 when the asset has no stored object', async () => {
    const { app } = await buildApp({ thumbnailExtractor: vi.fn(async () => undefined) });
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: A,
      payload: { name: 'no-object' }
    });
    const id = create.json().id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/thumbnails`,
      headers: A,
      payload: { timecodes: [1] }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_object');
  });

  it('returns 501 when extraction is not configured', async () => {
    const { app, repo } = await buildApp({ thumbnailExtractor: undefined });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/thumbnails`,
      headers: A,
      payload: { timecodes: [1] }
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_configured');
  });

  it('returns 404 for an unknown asset', async () => {
    const { app } = await buildApp({ thumbnailExtractor: vi.fn(async () => undefined) });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/nope/thumbnails',
      headers: A,
      payload: { timecodes: [1] }
    });
    expect(res.statusCode).toBe(404);
  });

  it.skip('does not leak existence across workspaces (404)', async () => {
    const { app, repo } = await buildApp({ thumbnailExtractor: vi.fn(async () => undefined) });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/thumbnails`,
      headers: auth('token-b'),
      payload: { timecodes: [1] }
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an empty timecode list (400)', async () => {
    const { app, repo } = await buildApp({ thumbnailExtractor: vi.fn(async () => undefined) });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/thumbnails`,
      headers: A,
      payload: { timecodes: [] }
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /:id/thumbnails', () => {
  it('returns workspace-local keys when no public base url is set', async () => {
    const extractor: FrameExtractor = vi.fn(async () => undefined);
    const { app, repo } = await buildApp({ thumbnailExtractor: extractor });
    const id = await createAssetWithObject(app, repo);
    await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/thumbnails`,
      headers: A,
      payload: { timecodes: [10] }
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/thumbnails`, headers: A });
    expect(res.statusCode).toBe(200);
    expect(res.json().thumbnails).toEqual([thumbnailObjectKey(id, 10)]);
  });

  it('builds absolute URLs when a public base url is configured', async () => {
    const extractor: FrameExtractor = vi.fn(async () => undefined);
    const { app, repo } = await buildApp({
      thumbnailExtractor: extractor,
      thumbnailPublicBaseUrl: 'https://cdn.example/'
    });
    const id = await createAssetWithObject(app, repo);
    await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/thumbnails`,
      headers: A,
      payload: { timecodes: [10] }
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/thumbnails`, headers: A });
    expect(res.json().thumbnails).toEqual([
      `https://cdn.example/${thumbnailObjectKey(id, 10)}`
    ]);
  });

  it('returns an empty list when no thumbnails exist yet', async () => {
    const { app, repo } = await buildApp({ thumbnailExtractor: vi.fn(async () => undefined) });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/thumbnails`, headers: A });
    expect(res.statusCode).toBe(200);
    expect(res.json().thumbnails).toEqual([]);
  });

  it('returns 404 for an unknown asset', async () => {
    const { app } = await buildApp({ thumbnailExtractor: vi.fn(async () => undefined) });
    const res = await app.inject({ method: 'GET', url: '/api/v1/assets/nope/thumbnails', headers: A });
    expect(res.statusCode).toBe(404);
  });
});
