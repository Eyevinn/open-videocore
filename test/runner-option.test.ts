// Discriminated runner-or-factory options (issue #838).
//
// The thumbnail, re-wrap and clip routes each accept EITHER a ready runner OR a
// factory that builds one from the workspace's MinIO credentials. Before #838
// the two were told apart with `typeof opts.x === 'function' && s3Config`, which
// cannot actually distinguish them (both arms are functions) — so on a stack
// that resolved without an s3Config the FACTORY was invoked as the RUNNER, it
// returned a function, `await` resolved it, and no OSC job was ever dispatched.
//
// Covers:
//   - the pure helper: plain runners pass through, tagged factories are built,
//     a factory with no s3Config throws RunnerFactoryUnresolvedError
//   - all three routes: a factory + no resolvable s3Config is an explicit 501,
//     not a silent no-op dispatch
//   - all three routes: a factory + an s3Config receives the stack's
//     credentials + source bucket and its runner is the one actually called
//   - backward compatibility: a plain injected runner still runs, with or
//     without an s3Config on the request
//
// Contract sources verified:
//   - RunnerOption / RunnerFactory / runnerFactory / resolveRunnerOption /
//     runnerS3Config / RunnerFactoryUnresolvedError (src/pipeline/runner-option.ts).
//   - FrameExtractor (src/pipeline/thumbnail.ts:64) = (sourceUrl, frames) => Promise<void>;
//     RewrapRunner (src/pipeline/rewrap.ts:73) = (sourceUrl, outputKey) => Promise<void>;
//     ClipRunner (src/pipeline/clip.ts:40) = (sourceUrl, putUrl, start, end) => Promise<void>.
//   - assetsRouter options thumbnailExtractor / rewrapRunner / clipRunner /
//     storageFor (src/routes/assets.ts).
//   - WorkspaceConnections.s3Config ({endpoint, accessKey, secretKey} | undefined)
//     and .sourceBucket (string) — src/services/workspace-stack.ts:118/116. The
//     in-memory connections set s3Config: undefined (same file, :371), which is
//     exactly the "stack resolves without s3Config" case under test.
//   - AssetRepository.create/get/update + WorkspaceStorage.presignedGet/
//     presignedPut/statObject (src/data/asset-repo.ts, src/data/storage.ts).

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
      if (token !== 'token-a') throw new actual.AuthError('invalid token');
      return 'workspace-a';
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import {
  runnerFactory,
  resolveRunnerOption,
  runnerS3Config,
  isRunnerFactory,
  RunnerFactoryUnresolvedError,
  type RunnerS3Config
} from '../src/pipeline/runner-option.js';
import type { FrameExtractor, FrameTarget } from '../src/pipeline/thumbnail.js';
import type { RewrapRunner } from '../src/pipeline/rewrap.js';
import type { ClipRunner } from '../src/pipeline/clip.js';
import type { WorkspaceStorage } from '../src/data/storage.js';

const A = { authorization: 'Bearer token-a' };

const S3: RunnerS3Config = {
  endpoint: 'https://minio.example',
  accessKey: 'admin',
  secretKey: 'secret',
  bucket: 'openvideocore-source'
};

// Storage double. statObject unconditionally reports the output object as
// present so the post-run output-existence verification (#316 for re-wrap, #786
// for clip) succeeds — these tests are about WHICH runner the route resolves,
// not about output verification, which rewrap.test.ts / clip.test.ts already
// cover. Mirrors the default double in those suites. Note re-wrap writes to
// s3://bucket/key natively and never calls presignedPut (#316).
function fakeStorage(): WorkspaceStorage {
  return {
    presignedGet: vi.fn(async (key: string) => `https://minio.example/${key}?sig=get`),
    presignedPut: vi.fn(async (key: string) => `https://minio.example/${key}?sig=put`),
    statObject: vi.fn(async () => ({ size: 1234, etag: 'etag-1' }))
  } as unknown as WorkspaceStorage;
}

type RouterOpts = Parameters<typeof assetsRouter>[1];

async function buildApp(
  routerOpts: Partial<RouterOpts>,
  // undefined => the request resolves a stack with NO s3Config, the
  // workspace-stack.ts:371 in-memory case.
  s3Config?: { endpoint: string; accessKey: string; secretKey: string }
): Promise<{ app: FastifyInstance; repo: InMemoryAssetRepository }> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryAssetRepository();
  const storage = fakeStorage();
  app.decorateRequest('connections', null);
  app.addHook('preHandler', async (request) => {
    (request as unknown as { connections: unknown }).connections = {
      s3Config,
      sourceBucket: 'openvideocore-source'
    };
  });
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    storageFor: () => storage,
    ...routerOpts
  } as RouterOpts);
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
  await repo.update(id, { objectKey: `ingest/${id}` });
  return id;
}

describe('resolveRunnerOption', () => {
  it('passes a plain runner through untouched, with or without an s3Config', () => {
    const runner: FrameExtractor = vi.fn(async () => undefined);
    expect(resolveRunnerOption(runner, S3, 'thumbnailExtractor')).toBe(runner);
    expect(resolveRunnerOption(runner, undefined, 'thumbnailExtractor')).toBe(runner);
  });

  it('builds a tagged factory with the supplied credentials', () => {
    const built: FrameExtractor = vi.fn(async () => undefined);
    const make = vi.fn(() => built);
    const resolved = resolveRunnerOption(runnerFactory(make), S3, 'thumbnailExtractor');
    expect(resolved).toBe(built);
    expect(make).toHaveBeenCalledWith(S3);
  });

  it('throws RunnerFactoryUnresolvedError for a factory with no s3Config — never calls it as the runner', () => {
    const make = vi.fn((): FrameExtractor => vi.fn(async () => undefined));
    expect(() => resolveRunnerOption(runnerFactory(make), undefined, 'thumbnailExtractor')).toThrow(
      RunnerFactoryUnresolvedError
    );
    expect(make).not.toHaveBeenCalled();
  });

  it('names the offending option on the error so the log/501 is actionable', () => {
    try {
      resolveRunnerOption(runnerFactory((): RewrapRunner => vi.fn()), undefined, 'rewrapRunner');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RunnerFactoryUnresolvedError);
      expect((err as RunnerFactoryUnresolvedError).optionName).toBe('rewrapRunner');
    }
  });

  it('discriminates on the tag, not on typeof — a runner function is never mistaken for a factory', () => {
    const runner: FrameExtractor = vi.fn(async () => undefined);
    expect(isRunnerFactory(runner)).toBe(false);
    expect(isRunnerFactory(runnerFactory(() => runner))).toBe(true);
  });

  it('runnerS3Config folds the bucket in, and is undefined when the stack has none', () => {
    expect(runnerS3Config({ endpoint: 'e', accessKey: 'a', secretKey: 's' }, 'b')).toEqual({
      endpoint: 'e',
      accessKey: 'a',
      secretKey: 's',
      bucket: 'b'
    });
    expect(runnerS3Config(undefined, 'b')).toBeUndefined();
  });
});

describe('POST /:id/thumbnails runner resolution', () => {
  it('501s when the extractor is a factory and the stack has no s3Config', async () => {
    const make = vi.fn((): FrameExtractor => vi.fn(async () => undefined));
    const { app, repo } = await buildApp({ thumbnailExtractor: runnerFactory(make) });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/thumbnails`,
      headers: A,
      payload: { timecodes: [1] }
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_configured');
    // The pre-#838 bug: the factory was called AS the extractor.
    expect(make).not.toHaveBeenCalled();
  });

  it('builds the factory from the stack s3Config + source bucket and runs the result', async () => {
    const extractor: FrameExtractor = vi.fn(async (_url: string, frames: FrameTarget[]) => {
      expect(frames.length).toBe(1);
    });
    const make = vi.fn(() => extractor);
    const { app, repo } = await buildApp({ thumbnailExtractor: runnerFactory(make) }, S3);
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/thumbnails`,
      headers: A,
      payload: { timecodes: [1] }
    });
    expect(res.statusCode).toBe(200);
    expect(make).toHaveBeenCalledWith(S3);
    expect(extractor).toHaveBeenCalledOnce();
  });

  it('still accepts a plain extractor on a stack with no s3Config (backward compatible)', async () => {
    const extractor: FrameExtractor = vi.fn(async () => undefined);
    const { app, repo } = await buildApp({ thumbnailExtractor: extractor });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/thumbnails`,
      headers: A,
      payload: { timecodes: [1] }
    });
    expect(res.statusCode).toBe(200);
    expect(extractor).toHaveBeenCalledOnce();
  });
});

describe('POST /:id/export runner resolution', () => {
  it('501s when the re-wrap runner is a factory and the stack has no s3Config', async () => {
    const make = vi.fn((): RewrapRunner => vi.fn(async () => undefined));
    const { app, repo } = await buildApp({ rewrapRunner: runnerFactory(make) });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/export`,
      headers: A,
      payload: { targetFormat: 'mp4' }
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_configured');
    expect(make).not.toHaveBeenCalled();
  });

  it('builds the factory from the stack s3Config and runs the result', async () => {
    const runner: RewrapRunner = vi.fn(async () => undefined);
    const make = vi.fn(() => runner);
    const { app, repo } = await buildApp({ rewrapRunner: runnerFactory(make) }, S3);
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/export`,
      headers: A,
      payload: { targetFormat: 'mp4' }
    });
    expect(res.statusCode).toBe(201);
    expect(make).toHaveBeenCalledWith(S3);
    expect(runner).toHaveBeenCalledOnce();
  });

  it('still accepts a plain re-wrap runner on a stack with no s3Config (backward compatible)', async () => {
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
    expect(runner).toHaveBeenCalledOnce();
  });
});

describe('POST /:id/clip runner resolution', () => {
  it('501s when the clip runner is a factory and the stack has no s3Config', async () => {
    const make = vi.fn((): ClipRunner => vi.fn(async () => undefined));
    const { app, repo } = await buildApp({ clipRunner: runnerFactory(make) });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/clip`,
      headers: A,
      payload: { startSeconds: 0, endSeconds: 5 }
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('not_configured');
    expect(make).not.toHaveBeenCalled();
  });

  it('builds the factory from the stack s3Config and runs the result', async () => {
    const runner: ClipRunner = vi.fn(async () => undefined);
    const make = vi.fn(() => runner);
    const { app, repo } = await buildApp({ clipRunner: runnerFactory(make) }, S3);
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/clip`,
      headers: A,
      payload: { startSeconds: 0, endSeconds: 5 }
    });
    expect(res.statusCode).toBe(201);
    expect(make).toHaveBeenCalledWith(S3);
    expect(runner).toHaveBeenCalledOnce();
  });

  it('still accepts a plain clip runner on a stack with no s3Config (backward compatible)', async () => {
    const runner: ClipRunner = vi.fn(async () => undefined);
    const { app, repo } = await buildApp({ clipRunner: runner });
    const id = await createAssetWithObject(app, repo);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/clip`,
      headers: A,
      payload: { startSeconds: 0, endSeconds: 5 }
    });
    expect(res.statusCode).toBe(201);
    expect(runner).toHaveBeenCalledOnce();
  });
});
