// Thumbnail / poster-frame extraction tests (issue #7, #332).
//
// Covers:
//   - the orchestration in extractThumbnails (dedupe, key naming, per-frame
//     verification, record-only-stored)
//   - the OSC ffmpeg per-frame cmdline builder + ephemeral-job runner lifecycle
//   - the assets router endpoints (POST/GET /:id/thumbnails) with statuses
//     200, 404, 409, 501, 502
//   - the #332 regression: several timecodes each land at their OWN key, and the
//     asset document never lists a key whose image was not stored.
//
// The extractor is AWAITED by the route, so tests assert on the synchronous
// response and the resulting asset document directly.
//
// Contract sources verified:
//   - extractThumbnails / ExtractThumbnailsDeps / FrameExtractor / FrameTarget
//     (src/pipeline/thumbnail.ts) — the orchestrator under test.
//   - thumbnailFrameCmdLine / makeOscThumbnailExtractor / OscJobApi
//     (src/pipeline/osc-thumbnail.ts) — the OSC ffmpeg-s3 per-frame runner.
//   - AssetRepository.create/get/update (two-arg) + WorkspaceStorage.statObject
//     (src/data/asset-repo.ts, src/data/storage.ts).
//   - assetsRouter options thumbnailExtractor / storageFor (src/routes/assets.ts).

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
  thumbnailFrameCmdLine,
  type OscJobApi
} from '../src/pipeline/osc-thumbnail.js';
import type { WorkspaceStorage } from '../src/data/storage.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

// A WorkspaceStorage double whose statObject reports EXACTLY the keys the
// extractor is deemed to have written. `writes` starts as "write every key it is
// asked to PUT"; individual tests narrow it to simulate partial/total failure.
// This is the seam that lets the orchestrator's record-only-stored logic be
// tested without a real MinIO (issue #332).
function fakeStorage(opts: { written?: Set<string> } = {}): {
  storage: WorkspaceStorage;
  written: Set<string>;
} {
  const written = opts.written ?? new Set<string>();
  const storage = {
    presignedGet: vi.fn(async (key: string) => `https://minio.example/${key}?sig=get`),
    presignedPut: vi.fn(async (key: string) => `https://minio.example/${key}?sig=put`),
    statObject: vi.fn(async (key: string) =>
      written.has(key) ? { size: 1024, etag: 'etag' } : undefined
    )
  } as unknown as WorkspaceStorage;
  return { storage, written };
}

// A FrameExtractor that marks each frame's key as written in `written`. Optional
// `fail` set: any frame whose objectKey is in `fail` is NOT written (simulating a
// per-frame ffmpeg job failure) — the others still land, so partial success is
// exercised. Mirrors makeOscThumbnailExtractor's per-frame independence (#332).
function writingExtractor(written: Set<string>, fail: Set<string> = new Set()): FrameExtractor {
  return vi.fn(async (_url: string, frames: FrameTarget[]) => {
    for (const f of frames) {
      if (!fail.has(f.objectKey)) written.add(f.objectKey);
    }
  });
}

async function buildApp(opts: {
  thumbnailExtractor?: FrameExtractor;
  withStorage?: boolean;
  written?: Set<string>;
} = {}): Promise<{ app: FastifyInstance; repo: InMemoryAssetRepository; written: Set<string> }> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryAssetRepository();
  const { storage, written } = fakeStorage({ written: opts.written });
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    storageFor: opts.withStorage === false ? undefined : () => storage,
    thumbnailExtractor: opts.thumbnailExtractor
  });
  await app.ready();
  return { app, repo, written };
}

async function createAssetWithObject(app: FastifyInstance, repo: InMemoryAssetRepository) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: A,
    payload: { name: 'clip' }
  });
  const id = res.json().id as string;
  await repo.update(id, { objectKey: `ingest/${id}` });
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

  it('gives every timecode a DISTINCT key (issue #332 — no last-write-wins)', () => {
    const keys = [3, 42, 80].map((t) => thumbnailObjectKey('asset-1', t));
    expect(new Set(keys).size).toBe(3);
    expect(keys).toEqual([
      'thumbnails/asset-1/thumb_3s.jpg',
      'thumbnails/asset-1/thumb_42s.jpg',
      'thumbnails/asset-1/thumb_80s.jpg'
    ]);
  });
});

describe('extractThumbnails orchestration', () => {
  it('dedupes, sorts, stores keys, and records them on the asset', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'x', objectKey: 'ingest/x' });
    const { storage, written } = fakeStorage();
    const extractor = writingExtractor(written);

    const result = await extractThumbnails(
      { assetId: asset.id, objectKey: 'ingest/x', timecodes: [10, 5, 10.2] },
      { assets: repo, storage, extractor }
    );

    expect(result).toEqual([
      thumbnailObjectKey(asset.id, 5),
      thumbnailObjectKey(asset.id, 10)
    ]);
    const stored = await repo.get(asset.id);
    expect(stored?.thumbnails).toEqual(result);
  });

  it('does not overwrite prior thumbnails when extraction fails', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'x', objectKey: 'ingest/x' });
    await repo.update(asset.id, { thumbnails: ['old/key.jpg'] });
    const { storage } = fakeStorage(); // nothing lands in storage
    const extractor: FrameExtractor = vi.fn(async () => {
      throw new Error('ffmpeg exited 1');
    });

    await expect(
      extractThumbnails(
        { assetId: asset.id, objectKey: 'ingest/x', timecodes: [1] },
        { assets: repo, storage, extractor }
      )
    ).rejects.toThrow('ffmpeg exited 1');

    const stored = await repo.get(asset.id);
    expect(stored?.thumbnails).toEqual(['old/key.jpg']);
  });

  // ---- issue #332 regression ----------------------------------------------

  it('writes every requested timecode to its OWN key and records all of them', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'multi', objectKey: 'ingest/multi' });
    const { storage, written } = fakeStorage();
    const extractor = writingExtractor(written);

    const result = await extractThumbnails(
      { assetId: asset.id, objectKey: 'ingest/multi', timecodes: [3, 42, 80] },
      { assets: repo, storage, extractor }
    );

    const expected = [
      thumbnailObjectKey(asset.id, 3),
      thumbnailObjectKey(asset.id, 42),
      thumbnailObjectKey(asset.id, 80)
    ];
    // Every timecode is written and recorded — not just the last one.
    expect(result).toEqual(expected);
    expect(written).toEqual(new Set(expected));
    const stored = await repo.get(asset.id);
    expect(stored?.thumbnails).toEqual(expected);
  });

  it('records ONLY keys confirmed in storage — never a key whose image was not stored', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'partial', objectKey: 'ingest/partial' });
    const { storage, written } = fakeStorage();
    // Simulate the historical bug's *effect*: only the last frame's object
    // actually lands; the earlier two are not written by the extractor.
    const lastKey = thumbnailObjectKey(asset.id, 80);
    const failKeys = new Set([thumbnailObjectKey(asset.id, 3), thumbnailObjectKey(asset.id, 42)]);
    const extractor = writingExtractor(written, failKeys);

    const result = await extractThumbnails(
      { assetId: asset.id, objectKey: 'ingest/partial', timecodes: [3, 42, 80] },
      { assets: repo, storage, extractor }
    );

    // Only the stored key is returned AND recorded — the two that were never
    // written are absent, so a follow-up read can never 500 on a NoSuchKey.
    expect(result).toEqual([lastKey]);
    const stored = await repo.get(asset.id);
    expect(stored?.thumbnails).toEqual([lastKey]);
    expect(stored?.thumbnails).not.toContain(thumbnailObjectKey(asset.id, 3));
    expect(stored?.thumbnails).not.toContain(thumbnailObjectKey(asset.id, 42));
  });

  it('throws and records nothing when NONE of the frames land in storage', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'none', objectKey: 'ingest/none' });
    const { storage, written } = fakeStorage();
    const allKeys = new Set([1, 2, 3].map((t) => thumbnailObjectKey(asset.id, t)));
    const extractor = writingExtractor(written, allKeys); // extractor writes nothing

    await expect(
      extractThumbnails(
        { assetId: asset.id, objectKey: 'ingest/none', timecodes: [1, 2, 3] },
        { assets: repo, storage, extractor }
      )
    ).rejects.toThrow();

    const stored = await repo.get(asset.id);
    expect(stored?.thumbnails).toBeUndefined();
  });
});

describe('thumbnailFrameCmdLine', () => {
  it('emits one seek + single-frame output for the frame, written to s3://bucket/key', () => {
    const frame: FrameTarget = { timecodeSeconds: 5, objectKey: 'k1', putUrl: 'https://minio/k1?sig=a' };
    const cmd = thumbnailFrameCmdLine('https://minio/src?sig=s', frame, 'thumbs-bucket');
    expect(cmd).toContain('-ss 5');
    expect(cmd).toContain('-frames:v 1');
    // Output goes to the native S3 URI, NOT the presigned PUT URL: the image2
    // muxer cannot write to an HTTP PUT endpoint (issue #92).
    expect(cmd).toContain('"s3://thumbs-bucket/k1"');
    expect(cmd).not.toContain('https://minio/k1?sig=a');
  });

  it('references exactly ONE output object per frame (issue #332)', () => {
    const frame: FrameTarget = { timecodeSeconds: 30, objectKey: 'k2', putUrl: 'https://minio/k2' };
    const cmd = thumbnailFrameCmdLine('https://minio/src', frame, 'thumbs-bucket');
    const outputs = [...cmd.matchAll(/s3:\/\//g)];
    expect(outputs).toHaveLength(1);
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
      // The runner polls getJob (via pollOscJobUntilDone); 'SuccessCriteriaMet'
      // is the ffmpeg-s3 terminal success status.
      getJob: vi.fn(async () => ({ status: 'SuccessCriteriaMet' })),
      getLogsForInstance: vi.fn(async () => ''),
      removeJob: vi.fn(async () => undefined),
      s3Endpoint: 'https://minio.example',
      s3AccessKey: 'admin',
      s3SecretKey: 'secret',
      s3Bucket: 'thumbs-bucket'
    } as unknown as OscJobApi;
  }

  it('creates a job with S3 credentials, waits, and cleans up', async () => {
    const api = fakeApi();
    await makeOscThumbnailExtractor(api)('https://minio/src', [
      { timecodeSeconds: 1, objectKey: 'k', putUrl: 'https://minio/k' }
    ]);
    expect(api.createJob).toHaveBeenCalledOnce();
    // S3 credentials + endpoint must be in the job body so ffmpeg can write
    // s3://bucket/key natively (issue #92).
    const body = (api.createJob as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(body.awsAccessKeyId).toBe('admin');
    expect(body.awsSecretAccessKey).toBe('secret');
    expect(body.s3EndpointUrl).toBe('https://minio.example');
    expect(body.cmdLineArgs).toContain('"s3://thumbs-bucket/k"');
    expect(api.getJob).toHaveBeenCalled();
    expect(api.removeJob).toHaveBeenCalledOnce();
  });

  it('runs ONE job per frame so each timecode lands at its own key (issue #332)', async () => {
    const api = fakeApi();
    await makeOscThumbnailExtractor(api)('https://minio/src', [
      { timecodeSeconds: 3, objectKey: 'thumb_3s.jpg', putUrl: 'https://minio/3' },
      { timecodeSeconds: 42, objectKey: 'thumb_42s.jpg', putUrl: 'https://minio/42' },
      { timecodeSeconds: 80, objectKey: 'thumb_80s.jpg', putUrl: 'https://minio/80' }
    ]);
    // One createJob per frame, each writing to its OWN distinct object key.
    expect(api.createJob).toHaveBeenCalledTimes(3);
    const bodies = (api.createJob as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[3]);
    expect(bodies[0].cmdLineArgs).toContain('"s3://thumbs-bucket/thumb_3s.jpg"');
    expect(bodies[1].cmdLineArgs).toContain('"s3://thumbs-bucket/thumb_42s.jpg"');
    expect(bodies[2].cmdLineArgs).toContain('"s3://thumbs-bucket/thumb_80s.jpg"');
    // Each job's command references exactly one output (no bundling).
    for (const b of bodies) {
      expect([...String(b.cmdLineArgs).matchAll(/s3:\/\//g)]).toHaveLength(1);
    }
    // Every ephemeral job is cleaned up.
    expect(api.removeJob).toHaveBeenCalledTimes(3);
  });

  it('a single failing frame does not abort the others (partial success)', async () => {
    const api = fakeApi();
    // Fail the job whose command targets thumb_42s.jpg; the others succeed.
    (api.getJob as ReturnType<typeof vi.fn>).mockResolvedValue({ status: 'SuccessCriteriaMet' });
    let call = 0;
    (api.createJob as ReturnType<typeof vi.fn>).mockImplementation(async (_c, _s, _t, body) => {
      call += 1;
      if (String(body.cmdLineArgs).includes('thumb_42s.jpg')) {
        throw new Error(`create failed on call ${call}`);
      }
      return { name: 'x' };
    });

    // Two of three succeed, so the extractor resolves (does not throw): the
    // orchestrator's storage verification decides what is recorded.
    await expect(
      makeOscThumbnailExtractor(api)('https://minio/src', [
        { timecodeSeconds: 3, objectKey: 'thumb_3s.jpg', putUrl: 'https://minio/3' },
        { timecodeSeconds: 42, objectKey: 'thumb_42s.jpg', putUrl: 'https://minio/42' },
        { timecodeSeconds: 80, objectKey: 'thumb_80s.jpg', putUrl: 'https://minio/80' }
      ])
    ).resolves.toBeUndefined();
  });

  it('throws when EVERY frame job fails', async () => {
    const api = fakeApi();
    (api.createJob as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    await expect(
      makeOscThumbnailExtractor(api)('https://minio/src', [
        { timecodeSeconds: 1, objectKey: 'k1', putUrl: 'https://minio/k1' },
        { timecodeSeconds: 2, objectKey: 'k2', putUrl: 'https://minio/k2' }
      ])
    ).rejects.toThrow(/failed/);
  });

  it('still cleans up the job when the poll fails', async () => {
    const api = fakeApi();
    (api.getJob as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    // A single-frame batch whose only job fails -> the whole batch fails.
    await expect(
      makeOscThumbnailExtractor(api)('https://minio/src', [
        { timecodeSeconds: 1, objectKey: 'k', putUrl: 'https://minio/k' }
      ])
    ).rejects.toThrow();
    expect(api.removeJob).toHaveBeenCalledOnce();
  });
});

describe('POST /:id/thumbnails', () => {
  it('returns 200 with every stored key on success (multi-timecode)', async () => {
    const written = new Set<string>();
    const extractor = writingExtractor(written);
    const { app, repo } = await buildApp({ thumbnailExtractor: extractor, written });
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
    const asset = await repo.get(id);
    expect(asset?.thumbnails).toHaveLength(2);
  });

  it('does not record keys for images that were not stored (issue #332)', async () => {
    // Reproduces the report end-to-end through the route: the extractor writes
    // only the thumb_60s object (the historical last-write-wins effect); the two
    // earlier timecodes never land. The response and the asset document must list
    // ONLY the stored key so a follow-up read cannot 500 on a NoSuchKey.
    const written = new Set<string>();
    const extractor: FrameExtractor = vi.fn(async (_url, frames) => {
      for (const f of frames) {
        if (f.timecodeSeconds === 60) written.add(f.objectKey);
      }
    });
    const { app, repo } = await buildApp({ thumbnailExtractor: extractor, written });
    const id = await createAssetWithObject(app, repo);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/thumbnails`,
      headers: A,
      payload: { timecodes: [5, 20, 60] }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().thumbnails).toEqual([thumbnailObjectKey(id, 60)]);
    const asset = await repo.get(id);
    expect(asset?.thumbnails).toEqual([thumbnailObjectKey(id, 60)]);
    expect(asset?.thumbnails).not.toContain(thumbnailObjectKey(id, 5));
    expect(asset?.thumbnails).not.toContain(thumbnailObjectKey(id, 20));
  });

  it('returns 502 when the OSC job fails (nothing stored)', async () => {
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
  it('returns API proxy URLs, one per recorded key', async () => {
    const written = new Set<string>();
    const extractor = writingExtractor(written);
    const { app, repo } = await buildApp({ thumbnailExtractor: extractor, written });
    const id = await createAssetWithObject(app, repo);
    await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/thumbnails`,
      headers: A,
      payload: { timecodes: [10, 20] }
    });
    const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/thumbnails`, headers: A });
    expect(res.statusCode).toBe(200);
    expect(res.json().thumbnails).toEqual([
      `/api/v1/assets/${id}/thumbnails/0`,
      `/api/v1/assets/${id}/thumbnails/1`
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
