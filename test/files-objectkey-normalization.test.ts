// Regression tests for issue #342: objectKeyPrefix / objectKey are normalized so
// the bucket name is handled consistently (object keys NEVER embed the bucket;
// the bucket is carried separately).
//
// Verified contract — GET /api/v1/assets/{id}/files
//   Source: src/routes/assets.ts `/:id/files` handler + assetFileGroupSchema
//   (objectKeyPrefix: string) and assetFileSchema (objectKey: string).
//   Renditions expose `s3Uri.key` (bucket already excluded via parseS3Uri).
//   fileGroups' objectKeyPrefix is derived from the stored manifest URL and
//   normalized by objectKeyPrefixFromManifest(manifest, packagedBucket).
//
// These tests assert:
//   1. NEW-shape manifests (no bucket in path) keep their bucket-excluded prefix.
//   2. OLD-shape manifests (bucket embedded as leading segment — the pre-#342
//      persisted shape) still resolve: the leading packaged-bucket segment is
//      stripped on read so the prefix matches the rendition/proxy convention.

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
      const map: Record<string, string> = { 'token-a': 'workspace-a' };
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

const A = { authorization: 'Bearer token-a' } as const;
const PACKAGED_BUCKET = 'openvideocore-packaged';

function fakeStorage(): WorkspaceStorage {
  return {
    presignedGet: vi.fn(
      async (key: string, ttl?: number) => `https://minio.example/${key}?ttl=${ttl}&sig=get`
    )
  } as unknown as WorkspaceStorage;
}

async function buildApp(): Promise<{ app: FastifyInstance; repo: InMemoryAssetRepository }> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryAssetRepository();
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    storageFor: () => fakeStorage(),
    outputBucket: PACKAGED_BUCKET
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

async function filesOf(app: FastifyInstance, id: string) {
  const res = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}/files`, headers: A });
  expect(res.statusCode).toBe(200);
  return res.json();
}

afterEach(() => {
  delete process.env['MINIO_PACKAGED_BUCKET'];
  vi.restoreAllMocks();
});

describe('GET /:id/files — objectKeyPrefix follows the bucket-excluded convention (#342)', () => {
  it('keeps a bucket-excluded prefix for NEW-shape manifest paths (no bucket embedded)', async () => {
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    // New convention: the packaged bucket is NOT part of the manifest path.
    await repo.update(id, {
      manifestUrls: {
        hls: `https://cdn.example/packaged/${id}/index.m3u8`,
        dash: `https://cdn.example/packaged/${id}/manifest.mpd`
      }
    });

    const body = await filesOf(app, id);
    const hls = body.fileGroups.find((g: { id: string }) => g.id === 'hls');
    const dash = body.fileGroups.find((g: { id: string }) => g.id === 'dash');
    expect(hls.objectKeyPrefix).toBe(`packaged/${id}/`);
    expect(dash.objectKeyPrefix).toBe(`packaged/${id}/`);
    // The prefix must not begin with the bucket name.
    expect(hls.objectKeyPrefix.startsWith(`${PACKAGED_BUCKET}/`)).toBe(false);
  });

  it('strips the embedded packaged bucket from OLD-shape prefixes (back-compat on read)', async () => {
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    // Pre-#342 persisted shape: the packaged bucket is the leading path segment.
    await repo.update(id, {
      manifestUrls: {
        hls: `https://minio.example/${PACKAGED_BUCKET}/packaged/${id}/index.m3u8`,
        dash: `https://minio.example/${PACKAGED_BUCKET}/packaged/${id}/manifest.mpd`
      }
    });

    const body = await filesOf(app, id);
    const hls = body.fileGroups.find((g: { id: string }) => g.id === 'hls');
    const dash = body.fileGroups.find((g: { id: string }) => g.id === 'dash');
    // Back-compat: the bucket-embedded prefix now resolves to the SAME shape as
    // a freshly-packaged asset, so proxy/delivery key construction never has to
    // special-case an embedded bucket.
    expect(hls.objectKeyPrefix).toBe(`packaged/${id}/`);
    expect(dash.objectKeyPrefix).toBe(`packaged/${id}/`);
    expect(hls.objectKeyPrefix.startsWith(`${PACKAGED_BUCKET}/`)).toBe(false);
  });

  it('respects a custom MINIO_PACKAGED_BUCKET when stripping the embedded bucket', async () => {
    process.env['MINIO_PACKAGED_BUCKET'] = 'custom-packaged';
    const { app, repo } = await buildApp();
    const id = await createAsset(app);
    await repo.update(id, {
      manifestUrls: {
        hls: `https://minio.example/custom-packaged/packaged/${id}/index.m3u8`
      }
    });

    const body = await filesOf(app, id);
    const hls = body.fileGroups.find((g: { id: string }) => g.id === 'hls');
    expect(hls.objectKeyPrefix).toBe(`packaged/${id}/`);
  });
});
