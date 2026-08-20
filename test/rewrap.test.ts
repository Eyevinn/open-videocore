// Export / re-wrap (remux) tests (issue #19, issue #316).
//
// Covers:
//   - the orchestration in rewrap() (child asset creation, parentId, key
//     naming, lifecycle, source untouched, failure handling, and the issue #316
//     defense-in-depth output-existence check)
//   - the OSC ffmpeg `-c copy` cmdline builder + ephemeral-job runner lifecycle,
//     including the s3://bucket/key native output + AWS creds contract (#316)
//   - the assets router endpoint (POST /:id/export) with statuses 201, 400,
//     404, 409, 501, 502
//
// The runner is AWAITED by the route, so tests assert on the synchronous
// response and the resulting asset documents directly.

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
  rewrap,
  rewrapObjectKey,
  isRewrapFormat,
  UnsupportedFormatError,
  type RewrapRunner
} from '../src/pipeline/rewrap.js';
import { makeOscRewrapRunner, rewrapCmdLine, type OscJobApi } from '../src/pipeline/osc-rewrap.js';
import type { WorkspaceStorage } from '../src/data/storage.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

// Fake storage: presignedGet mints a source URL; statObject reports whether the
// re-wrapped OUTPUT object exists (issue #316 defense in depth). By default the
// output is present. Pass `{ objectExists: false }` to simulate ffmpeg reporting
// success while writing nothing (the exact #316 failure mode). presignedPut is
// retained but MUST NOT be called by the re-wrap path anymore.
function fakeStorage(opts: { objectExists?: boolean } = {}): WorkspaceStorage {
  const exists = opts.objectExists ?? true;
  return {
    presignedGet: vi.fn(async (key: string) => `https://minio.example/${key}?sig=get`),
    presignedPut: vi.fn(async (key: string) => `https://minio.example/${key}?sig=put`),
    statObject: vi.fn(async () => (exists ? { size: 1234, etag: 'etag-1' } : undefined))
  } as unknown as WorkspaceStorage;
}

async function buildApp(opts: {
  rewrapRunner?: RewrapRunner;
  withStorage?: boolean;
  objectExists?: boolean;
} = {}): Promise<{ app: FastifyInstance; repo: InMemoryAssetRepository }> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryAssetRepository();
  const storage = fakeStorage({ objectExists: opts.objectExists });
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    storageFor: opts.withStorage === false ? undefined : () => storage,
    rewrapRunner: opts.rewrapRunner
  });
  await app.ready();
  return { app, repo };
}

async function createAssetWithObject(app: FastifyInstance, repo: InMemoryAssetRepository) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: A,
    payload: { name: 'master' }
  });
  const id = res.json().id as string;
  await repo.update(id, { objectKey: `ingest/${id}` });
  return id;
}

describe('rewrap format guard + key naming', () => {
  it('accepts the supported containers and rejects others', () => {
    expect(isRewrapFormat('mp4')).toBe(true);
    expect(isRewrapFormat('mkv')).toBe(true);
    expect(isRewrapFormat('mov')).toBe(true);
    expect(isRewrapFormat('mxf')).toBe(true);
    expect(isRewrapFormat('ts')).toBe(true);
    expect(isRewrapFormat('avi')).toBe(false);
    expect(isRewrapFormat('webm')).toBe(false);
  });

  it('builds the documented output key shape', () => {
    expect(rewrapObjectKey('asset-2', 'mp4')).toBe('exports/asset-2.mp4');
  });
});

describe('rewrap orchestration', () => {
  it('creates a ready child asset linked to the source and leaves the source untouched', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create({ name: 'master', objectKey: 'ingest/x' });
    await repo.update(source.id, { status: 'processing' });
    await repo.update(source.id, { status: 'ready' });

    let seenSrc = '';
    let seenDst = '';
    const runner: RewrapRunner = vi.fn(async (src, dst) => {
      seenSrc = src;
      seenDst = dst;
    });

    const child = await rewrap(
      {
        sourceAssetId: source.id,
        objectKey: 'ingest/x',
        targetFormat: 'mp4'
      },
      { assets: repo, storage: fakeStorage(), runner }
    );

    expect(child.parentId).toBe(source.id);
    expect(child.status).toBe('ready');
    expect(child.objectKey).toBe(rewrapObjectKey(child.id, 'mp4'));
    expect(seenSrc).toContain('ingest/x');
    // The runner now receives the destination OBJECT KEY, not a presigned PUT URL.
    expect(seenDst).toBe(rewrapObjectKey(child.id, 'mp4'));
    expect(seenDst).not.toContain('http');

    // Source is unchanged by an export.
    const refreshedSource = await repo.get(source.id);
    expect(refreshedSource?.status).toBe('ready');
    expect(refreshedSource?.objectKey).toBe('ingest/x');
  });

  it('does not mint a presigned PUT URL for the output (issue #316)', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create({ name: 'master', objectKey: 'ingest/x' });
    const storage = fakeStorage();
    const runner: RewrapRunner = vi.fn(async () => undefined);
    await rewrap(
      { sourceAssetId: source.id, objectKey: 'ingest/x', targetFormat: 'mp4' },
      { assets: repo, storage, runner }
    );
    // The output is written natively to s3://bucket/key by the runner; the
    // orchestrator must never presign a PUT URL for it.
    expect(storage.presignedPut).not.toHaveBeenCalled();
    // It DOES verify the output object exists before flipping to ready.
    expect(storage.statObject).toHaveBeenCalledOnce();
  });

  it('uses a provided outputName for the child asset', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create({ name: 'master', objectKey: 'ingest/x' });
    const runner: RewrapRunner = vi.fn(async () => undefined);
    const child = await rewrap(
      {
        sourceAssetId: source.id,
        objectKey: 'ingest/x',
        targetFormat: 'mkv',
        outputName: 'my export'
      },
      { assets: repo, storage: fakeStorage(), runner }
    );
    expect(child.name).toBe('my export');
  });

  it('marks the child failed and rethrows when the runner fails', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create({ name: 'master', objectKey: 'ingest/x' });
    const runner: RewrapRunner = vi.fn(async () => {
      throw new Error('ffmpeg exited 1');
    });

    await expect(
      rewrap(
        { sourceAssetId: source.id, objectKey: 'ingest/x', targetFormat: 'mov' },
        { assets: repo, storage: fakeStorage(), runner }
      )
    ).rejects.toThrow('ffmpeg exited 1');

    // A failed child asset exists under the source.
    const children = await repo.list({ parentId: source.id });
    expect(children.items).toHaveLength(1);
    expect(children.items[0]?.status).toBe('failed');
  });

  // Regression for issue #316: the runner resolves "successfully" (ffmpeg-s3
  // reaches a terminal status the poller does not treat as a failure) but the
  // output object was never written. The child MUST end up `failed`, NOT `ready`
  // with an objectKey pointing at a nonexistent object.
  it('marks the child failed when the output object is absent despite a resolving runner', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create({ name: 'master', objectKey: 'ingest/x' });
    const storage = fakeStorage({ objectExists: false });
    const runner: RewrapRunner = vi.fn(async () => undefined); // resolves, writes nothing

    await expect(
      rewrap(
        { sourceAssetId: source.id, objectKey: 'ingest/x', targetFormat: 'mp4' },
        { assets: repo, storage, runner }
      )
    ).rejects.toThrow(/not found in storage/);

    const children = await repo.list({ parentId: source.id });
    expect(children.items).toHaveLength(1);
    const child = children.items[0]!;
    expect(child.status).toBe('failed');
    // Never expose an objectKey for an object that does not exist.
    expect(child.status).not.toBe('ready');
    expect(runner).toHaveBeenCalledOnce();
  });

  it('rejects an unsupported format defensively', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create({ name: 'master', objectKey: 'ingest/x' });
    const runner: RewrapRunner = vi.fn(async () => undefined);
    await expect(
      rewrap(
        // Bypass the type to simulate a non-HTTP caller.
        { sourceAssetId: source.id, objectKey: 'ingest/x', targetFormat: 'avi' as never },
        { assets: repo, storage: fakeStorage(), runner }
      )
    ).rejects.toBeInstanceOf(UnsupportedFormatError);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('rewrapCmdLine', () => {
  // issue #316: output must be a native s3://bucket/key URI so ffmpeg's muxer
  // can actually write it — NOT a presigned HTTPS PUT URL.
  it('emits an -i input and -c copy to an s3://bucket/key destination', () => {
    const cmd = rewrapCmdLine('https://minio/src?sig=s', 'exports/asset-2.mp4', 'source-bucket');
    expect(cmd).toContain('-i "https://minio/src?sig=s"');
    expect(cmd).toContain('-c copy');
    expect(cmd).toContain('"s3://source-bucket/exports/asset-2.mp4"');
    // Must not point ffmpeg at a presigned PUT URL.
    expect(cmd).not.toContain('sig=put');
    expect(cmd).not.toMatch(/-c copy "https?:/);
  });
});

describe('makeOscRewrapRunner', () => {
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
      s3Bucket: 'source-bucket'
    } as unknown as OscJobApi;
  }

  it('creates a job with S3 credentials + native s3://bucket/key output, waits, and cleans up', async () => {
    const api = fakeApi();
    await makeOscRewrapRunner(api)('https://minio/src', 'exports/child.mp4');
    expect(api.createJob).toHaveBeenCalledOnce();
    // AWS creds + endpoint must be in the job body so ffmpeg writes s3://bucket/key
    // natively (issue #316 — a presigned PUT URL does not work).
    const body = (api.createJob as ReturnType<typeof vi.fn>).mock.calls[0][3];
    expect(body.awsAccessKeyId).toBe('admin');
    expect(body.awsSecretAccessKey).toBe('secret');
    expect(body.s3EndpointUrl).toBe('https://minio.example');
    expect(body.cmdLineArgs).toContain('"s3://source-bucket/exports/child.mp4"');
    expect(api.getJob).toHaveBeenCalled();
    expect(api.removeJob).toHaveBeenCalledOnce();
  });

  it('still cleans up the job when the poll fails', async () => {
    const api = fakeApi();
    (api.getJob as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    await expect(
      makeOscRewrapRunner(api)('https://minio/src', 'exports/child.mp4')
    ).rejects.toThrow('boom');
    expect(api.removeJob).toHaveBeenCalledOnce();
  });
});

describe('POST /:id/export', () => {
  it('returns 201 with the new child asset on success', async () => {
    const runner: RewrapRunner = vi.fn(async () => undefined);
    const { app, repo } = await buildApp({ rewrapRunner: runner });
    const id = await createAssetWithObject(app, repo);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/export`,
      headers: A,
      payload: { targetFormat: 'mp4' }
    });
    expect(res.statusCode).toBe(201);
    const child = res.json();
    expect(child.parentId).toBe(id);
    expect(child.status).toBe('ready');
    expect(child.objectKey).toBe(rewrapObjectKey(child.id, 'mp4'));
    expect(runner).toHaveBeenCalledOnce();
  });

  it('returns 502 when the output object never landed (issue #316)', async () => {
    const runner: RewrapRunner = vi.fn(async () => undefined);
    const { app, repo } = await buildApp({ rewrapRunner: runner, objectExists: false });
    const id = await createAssetWithObject(app, repo);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/export`,
      headers: A,
      payload: { targetFormat: 'mp4' }
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('rewrap_failed');

    // The child under the source is failed, not ready.
    const children = await repo.list({ parentId: id });
    expect(children.items[0]?.status).toBe('failed');
  });

  it('returns 400 for an unsupported target format', async () => {
    const { app, repo } = await buildApp({ rewrapRunner: vi.fn(async () => undefined) });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/export`,
      headers: A,
      payload: { targetFormat: 'avi' }
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 502 when the OSC job fails', async () => {
    const runner: RewrapRunner = vi.fn(async () => {
      throw new Error('ffmpeg exited 1');
    });
    const { app, repo } = await buildApp({ rewrapRunner: runner });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/export`,
      headers: A,
      payload: { targetFormat: 'mkv' }
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('rewrap_failed');
  });

  it('returns 409 when the asset has no stored object', async () => {
    const { app } = await buildApp({ rewrapRunner: vi.fn(async () => undefined) });
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: A,
      payload: { name: 'no-object' }
    });
    const id = create.json().id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/export`,
      headers: A,
      payload: { targetFormat: 'mp4' }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_object');
  });

  it('returns 501 when export is not configured', async () => {
    const { app, repo } = await buildApp({ rewrapRunner: undefined });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/export`,
      headers: A,
      payload: { targetFormat: 'mp4' }
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_configured');
  });

  it('returns 404 for an unknown asset', async () => {
    const { app } = await buildApp({ rewrapRunner: vi.fn(async () => undefined) });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/nope/export',
      headers: A,
      payload: { targetFormat: 'mp4' }
    });
    expect(res.statusCode).toBe(404);
  });
});
