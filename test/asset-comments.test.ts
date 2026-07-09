// Asset comments tests (issue #135).
//
// Exercises the comments sub-resource on the assets router against the
// in-memory repositories: POST/GET /api/v1/assets/:id/comments. Free-text body
// only for this iteration.

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
import { InMemoryCommentRepository } from '../src/data/comment-repo.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: new InMemoryAssetRepository(),
    commentRepository: new InMemoryCommentRepository()
  });
  await app.ready();
  return app;
}

const A = { authorization: 'Bearer token-a' };

async function createAsset(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: A,
    payload: { name: 'clip' }
  });
  expect(res.statusCode).toBe(201);
  return res.json()['id'] as string;
}

describe('asset comments (issue #135)', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('creates a comment and returns it with id, body, assetId and createdAt', async () => {
    const assetId = await createAsset(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/comments`,
      headers: A,
      payload: { body: 'looks good to me' }
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body['id']).toBeTruthy();
    expect(body['assetId']).toBe(assetId);
    expect(body['body']).toBe('looks good to me');
    expect(typeof body['createdAt']).toBe('string');
  });

  it('lists comments for an asset in chronological order (oldest first)', async () => {
    const assetId = await createAsset(app);
    for (const text of ['first', 'second', 'third']) {
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${assetId}/comments`,
        headers: A,
        payload: { body: text }
      });
      expect(res.statusCode).toBe(201);
    }
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${assetId}/comments`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    const items = res.json() as Array<{ body: string }>;
    expect(items.map((c) => c.body)).toEqual(['first', 'second', 'third']);
  });

  it('returns an empty list for an asset with no comments', async () => {
    const assetId = await createAsset(app);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${assetId}/comments`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('scopes comments to their own asset', async () => {
    const assetA = await createAsset(app);
    const assetB = await createAsset(app);
    await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetA}/comments`,
      headers: A,
      payload: { body: 'for A' }
    });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${assetB}/comments`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it('404s when POSTing a comment to a nonexistent asset', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/does-not-exist/comments',
      headers: A,
      payload: { body: 'ghost' }
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s when GETting comments for a nonexistent asset', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/does-not-exist/comments',
      headers: A
    });
    expect(res.statusCode).toBe(404);
  });

  it('rejects an empty body with 400', async () => {
    const assetId = await createAsset(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/comments`,
      headers: A,
      payload: { body: '' }
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a whitespace-only body with 400', async () => {
    const assetId = await createAsset(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/comments`,
      headers: A,
      payload: { body: '   ' }
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a missing body field with 400', async () => {
    const assetId = await createAsset(app);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${assetId}/comments`,
      headers: A,
      payload: {}
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('InMemoryCommentRepository (issue #135)', () => {
  it('returns comments oldest-first, scoped by assetId', async () => {
    const repo = new InMemoryCommentRepository();
    await repo.create({ assetId: 'a1', body: 'one' });
    await repo.create({ assetId: 'a2', body: 'other-asset' });
    await repo.create({ assetId: 'a1', body: 'two' });
    const items = await repo.listByAsset('a1');
    expect(items.map((c) => c.body)).toEqual(['one', 'two']);
    expect(items.every((c) => c.assetId === 'a1')).toBe(true);
  });

  it('returns defensive clones (mutating a result does not affect the store)', async () => {
    const repo = new InMemoryCommentRepository();
    const created = await repo.create({ assetId: 'a1', body: 'original' });
    created.body = 'mutated';
    const [fetched] = await repo.listByAsset('a1');
    expect(fetched.body).toBe('original');
  });
});
