// Fast reachability preflight on the transcode path (issue #617, parent #602).
//
// Before enqueuing a transcode, the route probes the stack's dependencies
// (queue/Valkey via the shared IORedis ping, storage via the per-stack
// MinioClient bucketExists) under the SAME bounded deadline the submit writes
// use (#616). An unhealthy stack is rejected PROMPTLY with the SAME
// named-dependency 504 the submit-path catch already maps — turning a silent
// ~50s socket-drop into an up-front, actionable signal. These tests assert:
//   - a fully healthy stack (queue up, storage up) submits (202) — the guard
//     does not get in the way;
//   - an unreachable QUEUE yields a 504 naming dependency 'queue' + endpoint;
//   - an unreachable STORAGE yields a 504 naming dependency 'storage' + endpoint;
//   - when NO probe clients are wired (no queue, no storage on connections) the
//     guard is inert and the request submits exactly as before.
//
// Contract sources cited before writing:
//   - POST /:id/transcode guard + options (packagingRedis: ioredis Redis;
//     request.connections.storageClient/s3Config): src/routes/assets.ts.
//   - The 504 body shape (error/dependency/endpoint/message):
//     src/encore-scaler/dependency-timeout.ts DependencyUnreachableError.
//     toResponseBody().
//   - EncoreClient / EncoreSubmitInput: src/pipeline/encore-client.ts.
//   - request.connections (WorkspaceConnections) shape:
//     src/services/workspace-stack.ts.

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
      if (token === 'token-a') return 'workspace-a';
      throw new actual.AuthError('invalid token');
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { InMemoryProfileRepository } from '../src/data/inmemory-profile-repo.js';
import type { EncoreClient, EncoreSubmitInput } from '../src/pipeline/encore-client.js';

const A = { authorization: 'Bearer token-a' };

function fakeEncore(): { client: EncoreClient; submitted: EncoreSubmitInput[] } {
  const submitted: EncoreSubmitInput[] = [];
  const client: EncoreClient = {
    async submit(input) {
      submitted.push(input);
      return { encoreInternalId: 'encore-internal-1' };
    }
  } as unknown as EncoreClient;
  return { client, submitted };
}

// A Redis-shaped queue double exposing only what the guard reads: `options`
// (for the endpoint display) and `ping`. A down queue throws on ping.
function fakeRedis(up: boolean) {
  return {
    options: { host: 'valkey.stack.internal', port: 6379 },
    ping: async () => {
      if (!up) throw new Error('ECONNREFUSED');
      return 'PONG';
    }
  } as unknown as import('ioredis').Redis;
}

// A storage double on request.connections exposing s3Config + storageClient,
// matching the coordinates the guard reads. A down storage throws on
// bucketExists.
function connectionsWithStorage(up: boolean) {
  return {
    s3Config: { endpoint: 'https://minio.stack.internal:9000', accessKey: 'admin', secretKey: 'x' },
    storageClient: {
      bucketExists: async () => {
        if (!up) throw new Error('ENOTFOUND');
        return true;
      }
    }
  };
}

async function buildApp(opts: {
  packagingRedis?: import('ioredis').Redis;
  connectionsStorageUp?: boolean;
}): Promise<{ app: FastifyInstance; submitted: EncoreSubmitInput[]; assets: InMemoryAssetRepository }> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const profiles = new InMemoryProfileRepository();
  const { client, submitted } = fakeEncore();

  app.decorateRequest('connections', null);
  if (opts.connectionsStorageUp !== undefined) {
    const conn = connectionsWithStorage(opts.connectionsStorageUp);
    app.addHook('preHandler', async (request) => {
      request.connections = conn as unknown as NonNullable<typeof request.connections>;
    });
  }

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    jobRepository: jobs,
    encore: client,
    sourceBucket: 'src-bucket',
    outputBucket: 'out-bucket',
    profileRepository: profiles,
    ...(opts.packagingRedis ? { packagingRedis: opts.packagingRedis } : {})
  });
  await app.ready();
  return { app, submitted, assets };
}

async function makeReadySource(assets: InMemoryAssetRepository): Promise<string> {
  const asset = await assets.create({ name: 'src', objectKey: 'ingest/src' });
  await assets.update(asset.id, { status: 'processing' });
  await assets.update(asset.id, { status: 'ready' });
  return asset.id;
}

async function transcode(app: FastifyInstance, id: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/assets/${id}/transcode`,
    headers: A,
    payload: {}
  });
}

describe('transcode reachability preflight (issue #617)', () => {
  it('submits (202) when the stack is fully healthy (queue up, storage up)', async () => {
    const { app, submitted, assets } = await buildApp({
      packagingRedis: fakeRedis(true),
      connectionsStorageUp: true
    });
    const id = await makeReadySource(assets);
    const res = await transcode(app, id);
    expect(res.statusCode).toBe(202);
    expect(submitted).toHaveLength(1);
    await app.close();
  });

  it('rejects with 504 naming the queue when Valkey is unreachable', async () => {
    const { app, submitted, assets } = await buildApp({
      packagingRedis: fakeRedis(false),
      connectionsStorageUp: true
    });
    const id = await makeReadySource(assets);
    const res = await transcode(app, id);
    expect(res.statusCode).toBe(504);
    const body = res.json() as { error: string; dependency: string; endpoint: string };
    expect(body.error).toBe('dependency_unreachable');
    expect(body.dependency).toBe('queue');
    expect(body.endpoint).toBe('redis://valkey.stack.internal:6379');
    // Work was NOT enqueued.
    expect(submitted).toHaveLength(0);
    await app.close();
  });

  it('rejects with 504 naming storage when the storage endpoint is unreachable', async () => {
    const { app, submitted, assets } = await buildApp({
      packagingRedis: fakeRedis(true),
      connectionsStorageUp: false
    });
    const id = await makeReadySource(assets);
    const res = await transcode(app, id);
    expect(res.statusCode).toBe(504);
    const body = res.json() as { error: string; dependency: string; endpoint: string };
    expect(body.error).toBe('dependency_unreachable');
    expect(body.dependency).toBe('storage');
    expect(body.endpoint).toBe('https://minio.stack.internal:9000');
    expect(submitted).toHaveLength(0);
    await app.close();
  });

  it('is inert when no probe clients are wired: submits exactly as before', async () => {
    // No packagingRedis, no storage on connections -> both dependencies are
    // not_configured -> the guard never trips.
    const { app, submitted, assets } = await buildApp({});
    const id = await makeReadySource(assets);
    const res = await transcode(app, id);
    expect(res.statusCode).toBe(202);
    expect(submitted).toHaveLength(1);
    await app.close();
  });
});
