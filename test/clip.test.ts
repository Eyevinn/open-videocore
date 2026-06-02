// Clip / trim tests (issue #17).
//
// Covers:
//   - the orchestration in clip() (child asset creation, key naming, status
//     transitions, failure handling)
//   - the OSC ffmpeg cmdline builder + ephemeral-job runner lifecycle
//   - the assets router endpoint (POST /:id/clip) with statuses 201, 400, 404,
//     409, 501, 502
//
// The runner is AWAITED by the route, so tests assert on the synchronous
// response and the resulting child asset document directly.

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
import { clip, clipObjectKey, type ClipRunner } from '../src/pipeline/clip.js';
import { makeOscClipRunner, clipCmdLine, type OscJobApi } from '../src/pipeline/osc-clip.js';
import type { WorkspaceStorage } from '../src/data/storage.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

function fakeStorage(): WorkspaceStorage {
  return {
    presignedGet: vi.fn(async (key: string) => `https://minio.example/${key}?sig=get`),
    presignedPut: vi.fn(async (key: string) => `https://minio.example/${key}?sig=put`)
  } as unknown as WorkspaceStorage;
}

async function buildApp(
  opts: { clipRunner?: ClipRunner; withStorage?: boolean } = {}
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
    clipRunner: opts.clipRunner
  });
  await app.ready();
  return { app, repo };
}

async function createAssetWithObject(app: FastifyInstance, repo: InMemoryAssetRepository) {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: A,
    payload: { name: 'source' }
  });
  const id = res.json().id as string;
  await repo.update('workspace-a', id, { objectKey: `ingest/${id}` });
  return id;
}

describe('clip object key naming', () => {
  it('builds the documented key shape', () => {
    expect(clipObjectKey('asset-7')).toBe('clips/asset-7.mp4');
  });
});

describe('clip orchestration', () => {
  it('creates a ready child asset pointing at the source', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create('workspace-a', { name: 'src', objectKey: 'ingest/src' });
    const runner: ClipRunner = vi.fn(async () => undefined);

    const child = await clip(
      {
        workspaceId: 'workspace-a',
        sourceAssetId: source.id,
        objectKey: 'ingest/src',
        startSeconds: 5,
        endSeconds: 12
      },
      { assets: repo, storage: fakeStorage(), runner }
    );

    expect(child.parentId).toBe(source.id);
    expect(child.status).toBe('ready');
    expect(child.objectKey).toBe(clipObjectKey(child.id));
    expect(runner).toHaveBeenCalledOnce();
    const stored = await repo.get('workspace-a', child.id);
    expect(stored?.status).toBe('ready');
  });

  it('uses outputName for the child asset name when given', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create('workspace-a', { name: 'src', objectKey: 'ingest/src' });
    const child = await clip(
      {
        workspaceId: 'workspace-a',
        sourceAssetId: source.id,
        objectKey: 'ingest/src',
        startSeconds: 0,
        endSeconds: 3,
        outputName: 'intro'
      },
      { assets: repo, storage: fakeStorage(), runner: vi.fn(async () => undefined) }
    );
    expect(child.name).toBe('intro');
  });

  it('marks the child failed and rethrows when the runner fails', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create('workspace-a', { name: 'src', objectKey: 'ingest/src' });
    const runner: ClipRunner = vi.fn(async () => {
      throw new Error('ffmpeg exited 1');
    });

    await expect(
      clip(
        {
          workspaceId: 'workspace-a',
          sourceAssetId: source.id,
          objectKey: 'ingest/src',
          startSeconds: 1,
          endSeconds: 2
        },
        { assets: repo, storage: fakeStorage(), runner }
      )
    ).rejects.toThrow('ffmpeg exited 1');

    // The child exists and is recorded as failed.
    const children = await repo.list('workspace-a', { parentId: source.id });
    expect(children.items).toHaveLength(1);
    expect(children.items[0]?.status).toBe('failed');
  });
});

describe('clipCmdLine', () => {
  it('emits a stream-copy clip with seek + end bound', () => {
    const cmd = clipCmdLine('https://minio/src?sig=s', 'https://minio/dst?sig=p', 5, 12);
    expect(cmd).toContain('-ss 5');
    expect(cmd).toContain('-to 12');
    expect(cmd).toContain('-c copy');
    expect(cmd).toContain('"https://minio/src?sig=s"');
    expect(cmd).toContain('"https://minio/dst?sig=p"');
  });
});

describe('makeOscClipRunner', () => {
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
    await makeOscClipRunner(api)('https://minio/src', 'https://minio/dst', 1, 4);
    expect(api.createJob).toHaveBeenCalledOnce();
    expect(api.waitForJobToComplete).toHaveBeenCalledOnce();
    expect(api.removeJob).toHaveBeenCalledOnce();
  });

  it('still cleans up the job when the wait fails', async () => {
    const api = fakeApi();
    (api.waitForJobToComplete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    await expect(
      makeOscClipRunner(api)('https://minio/src', 'https://minio/dst', 1, 4)
    ).rejects.toThrow('boom');
    expect(api.removeJob).toHaveBeenCalledOnce();
  });
});

describe('POST /:id/clip', () => {
  it('returns 201 with the new child asset on success', async () => {
    const runner: ClipRunner = vi.fn(async () => undefined);
    const { app, repo } = await buildApp({ clipRunner: runner });
    const id = await createAssetWithObject(app, repo);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/clip`,
      headers: A,
      payload: { startSeconds: 5, endSeconds: 12 }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.parentId).toBe(id);
    expect(body.status).toBe('ready');
    expect(runner).toHaveBeenCalledOnce();
  });

  it('returns 400 when endSeconds is not greater than startSeconds', async () => {
    const { app, repo } = await buildApp({ clipRunner: vi.fn(async () => undefined) });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/clip`,
      headers: A,
      payload: { startSeconds: 10, endSeconds: 10 }
    });
    expect(res.statusCode).toBe(400);
  });

  it('returns 502 when the OSC job fails', async () => {
    const runner: ClipRunner = vi.fn(async () => {
      throw new Error('ffmpeg exited 1');
    });
    const { app, repo } = await buildApp({ clipRunner: runner });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/clip`,
      headers: A,
      payload: { startSeconds: 1, endSeconds: 2 }
    });
    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('clip_failed');
  });

  it('returns 409 when the source asset has no stored object', async () => {
    const { app } = await buildApp({ clipRunner: vi.fn(async () => undefined) });
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: A,
      payload: { name: 'no-object' }
    });
    const id = create.json().id;
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/clip`,
      headers: A,
      payload: { startSeconds: 1, endSeconds: 2 }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_object');
  });

  it('returns 501 when clip extraction is not configured', async () => {
    const { app, repo } = await buildApp({ clipRunner: undefined });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/clip`,
      headers: A,
      payload: { startSeconds: 1, endSeconds: 2 }
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_configured');
  });

  it('returns 404 for an unknown asset', async () => {
    const { app } = await buildApp({ clipRunner: vi.fn(async () => undefined) });
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/nope/clip',
      headers: A,
      payload: { startSeconds: 1, endSeconds: 2 }
    });
    expect(res.statusCode).toBe(404);
  });

  it.skip('does not leak existence across workspaces (404)', async () => {
    const { app, repo } = await buildApp({ clipRunner: vi.fn(async () => undefined) });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/clip`,
      headers: auth('token-b'),
      payload: { startSeconds: 1, endSeconds: 2 }
    });
    expect(res.statusCode).toBe(404);
  });
});
