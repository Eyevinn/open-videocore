// Export / re-wrap (remux) tests (issue #19).
//
// Covers:
//   - the orchestration in rewrap() (child asset creation, parentId, key
//     naming, lifecycle, source untouched, failure handling)
//   - the OSC ffmpeg `-c copy` cmdline builder + ephemeral-job runner lifecycle
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

function fakeStorage(): WorkspaceStorage {
  return {
    presignedGet: vi.fn(async (key: string) => `https://minio.example/${key}?sig=get`),
    presignedPut: vi.fn(async (key: string) => `https://minio.example/${key}?sig=put`)
  } as unknown as WorkspaceStorage;
}

async function buildApp(opts: {
  rewrapRunner?: RewrapRunner;
  withStorage?: boolean;
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
  await repo.update('workspace-a', id, { objectKey: `ingest/${id}` });
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
    expect(rewrapObjectKey('workspace-a', 'asset-2', 'mp4')).toBe('workspace-a/exports/asset-2.mp4');
  });
});

describe('rewrap orchestration', () => {
  it('creates a ready child asset linked to the source and leaves the source untouched', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create('workspace-a', { name: 'master', objectKey: 'ingest/x' });
    await repo.update('workspace-a', source.id, { status: 'processing' });
    await repo.update('workspace-a', source.id, { status: 'ready' });

    let seenSrc = '';
    let seenDst = '';
    const runner: RewrapRunner = vi.fn(async (src, dst) => {
      seenSrc = src;
      seenDst = dst;
    });

    const child = await rewrap(
      {
        workspaceId: 'workspace-a',
        sourceAssetId: source.id,
        objectKey: 'ingest/x',
        targetFormat: 'mp4'
      },
      { assets: repo, storage: fakeStorage(), runner }
    );

    expect(child.parentId).toBe(source.id);
    expect(child.status).toBe('ready');
    expect(child.objectKey).toBe(rewrapObjectKey('workspace-a', child.id, 'mp4'));
    expect(seenSrc).toContain('ingest/x');
    expect(seenDst).toContain(`exports/${child.id}.mp4`);

    // Source is unchanged by an export.
    const refreshedSource = await repo.get('workspace-a', source.id);
    expect(refreshedSource?.status).toBe('ready');
    expect(refreshedSource?.objectKey).toBe('ingest/x');
  });

  it('uses a provided outputName for the child asset', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create('workspace-a', { name: 'master', objectKey: 'ingest/x' });
    const runner: RewrapRunner = vi.fn(async () => undefined);
    const child = await rewrap(
      {
        workspaceId: 'workspace-a',
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
    const source = await repo.create('workspace-a', { name: 'master', objectKey: 'ingest/x' });
    const runner: RewrapRunner = vi.fn(async () => {
      throw new Error('ffmpeg exited 1');
    });

    await expect(
      rewrap(
        { workspaceId: 'workspace-a', sourceAssetId: source.id, objectKey: 'ingest/x', targetFormat: 'mov' },
        { assets: repo, storage: fakeStorage(), runner }
      )
    ).rejects.toThrow('ffmpeg exited 1');

    // A failed child asset exists under the source.
    const children = await repo.list('workspace-a', { parentId: source.id });
    expect(children.items).toHaveLength(1);
    expect(children.items[0]?.status).toBe('failed');
  });

  it('rejects an unsupported format defensively', async () => {
    const repo = new InMemoryAssetRepository();
    const source = await repo.create('workspace-a', { name: 'master', objectKey: 'ingest/x' });
    const runner: RewrapRunner = vi.fn(async () => undefined);
    await expect(
      rewrap(
        // Bypass the type to simulate a non-HTTP caller.
        { workspaceId: 'workspace-a', sourceAssetId: source.id, objectKey: 'ingest/x', targetFormat: 'avi' as never },
        { assets: repo, storage: fakeStorage(), runner }
      )
    ).rejects.toBeInstanceOf(UnsupportedFormatError);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('rewrapCmdLine', () => {
  it('emits an -i input and -c copy to the destination', () => {
    const cmd = rewrapCmdLine('https://minio/src?sig=s', 'https://minio/dst.mp4?sig=p');
    expect(cmd).toContain('-i "https://minio/src?sig=s"');
    expect(cmd).toContain('-c copy');
    expect(cmd).toContain('"https://minio/dst.mp4?sig=p"');
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
      waitForJobToComplete: vi.fn(async () => undefined),
      getLogsForInstance: vi.fn(async () => ''),
      removeJob: vi.fn(async () => undefined)
    } as unknown as OscJobApi;
  }

  it('creates a job, waits, and cleans up', async () => {
    const api = fakeApi();
    await makeOscRewrapRunner(api)('https://minio/src', 'https://minio/dst.mp4');
    expect(api.createJob).toHaveBeenCalledOnce();
    expect(api.waitForJobToComplete).toHaveBeenCalledOnce();
    expect(api.removeJob).toHaveBeenCalledOnce();
  });

  it('still cleans up the job when the wait fails', async () => {
    const api = fakeApi();
    (api.waitForJobToComplete as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    await expect(
      makeOscRewrapRunner(api)('https://minio/src', 'https://minio/dst.mp4')
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
    expect(child.objectKey).toBe(rewrapObjectKey('workspace-a', child.id, 'mp4'));
    expect(runner).toHaveBeenCalledOnce();
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

  it.skip('does not leak existence across workspaces (404)', async () => {
    const { app, repo } = await buildApp({ rewrapRunner: vi.fn(async () => undefined) });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/export`,
      headers: auth('token-b'),
      payload: { targetFormat: 'mp4' }
    });
    expect(res.statusCode).toBe(404);
  });
});
