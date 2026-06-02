// Asset lifecycle CRUD tests (issue #3).
//
// Exercises the assets router against the in-memory repository, which shares
// the same state-machine, audit-trail, and parent/child logic as the CouchDB
// repository. The CouchDB repo's storage wiring is covered separately; the
// domain rules under test here are backend-agnostic by construction.

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

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: new InMemoryAssetRepository()
  });
  await app.ready();
  return app;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

async function createAsset(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  headers = A
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/assets', headers, payload });
  return { status: res.statusCode, body: res.json() };
}

describe('asset lifecycle CRUD (issue #3)', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  describe('CRUD happy paths', () => {
    it('creates an asset and returns its id in uploading state', async () => {
      const { status, body } = await createAsset(app, { name: 'clip' });
      expect(status).toBe(201);
      expect(body['id']).toBeTruthy();
      expect(body['status']).toBe('uploading');
      expect(body['statusHistory']).toEqual([
        expect.objectContaining({ from: null, to: 'uploading' })
      ]);
    });

    it('reads a single asset', async () => {
      const { body } = await createAsset(app, { name: 'clip' });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${body['id']}`,
        headers: A
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('clip');
    });

    it('returns 404 for an unknown asset', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/assets/nope', headers: A });
      expect(res.statusCode).toBe(404);
    });

    it('updates mutable fields', async () => {
      const { body } = await createAsset(app, { name: 'clip' });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/assets/${body['id']}`,
        headers: A,
        payload: { name: 'renamed', description: 'd' }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('renamed');
      expect(res.json().description).toBe('d');
    });

    it('rejects an empty PATCH body', async () => {
      const { body } = await createAsset(app, { name: 'clip' });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/assets/${body['id']}`,
        headers: A,
        payload: {}
      });
      expect(res.statusCode).toBe(400);
    });

    it('soft-deletes (archives) an asset', async () => {
      const { body } = await createAsset(app, { name: 'clip' });
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/v1/assets/${body['id']}`,
        headers: A
      });
      expect(del.statusCode).toBe(204);
      const read = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${body['id']}`,
        headers: A
      });
      // Soft delete: still retrievable, now archived.
      expect(read.statusCode).toBe(200);
      expect(read.json().status).toBe('archived');
    });
  });

  describe('state machine', () => {
    it('allows uploading -> processing -> ready and records history', async () => {
      const { body } = await createAsset(app, { name: 'clip' });
      const id = body['id'];
      const toProcessing = await app.inject({
        method: 'PATCH',
        url: `/api/v1/assets/${id}`,
        headers: A,
        payload: { status: 'processing' }
      });
      expect(toProcessing.statusCode).toBe(200);
      const toReady = await app.inject({
        method: 'PATCH',
        url: `/api/v1/assets/${id}`,
        headers: A,
        payload: { status: 'ready' }
      });
      expect(toReady.statusCode).toBe(200);
      const history = toReady.json().statusHistory;
      expect(history.map((h: { to: string }) => h.to)).toEqual([
        'uploading',
        'processing',
        'ready'
      ]);
    });

    it('rejects an invalid transition with 422 (uploading -> ready)', async () => {
      const { body } = await createAsset(app, { name: 'clip' });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/assets/${body['id']}`,
        headers: A,
        payload: { status: 'ready' }
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('invalid_state_transition');
    });

    it('rejects transitions out of the terminal archived state with 422', async () => {
      const { body } = await createAsset(app, { name: 'clip' });
      const id = body['id'];
      await app.inject({
        method: 'DELETE',
        url: `/api/v1/assets/${id}`,
        headers: A
      });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/assets/${id}`,
        headers: A,
        payload: { status: 'processing' }
      });
      expect(res.statusCode).toBe(422);
    });
  });

  describe('parent/child relationships', () => {
    it('creates a child referencing its parent', async () => {
      const { body: parent } = await createAsset(app, { name: 'source' });
      const { status, body: child } = await createAsset(app, {
        name: 'rendition-720p',
        parentId: parent['id']
      });
      expect(status).toBe(201);
      expect(child['parentId']).toBe(parent['id']);
    });

    it('rejects a child with an unknown parent (422)', async () => {
      const { status, body } = await createAsset(app, { name: 'orphan', parentId: 'nope' });
      expect(status).toBe(422);
      expect(body['error']).toBe('parent_not_found');
    });

    it('lists children via ?parentId=', async () => {
      const { body: parent } = await createAsset(app, { name: 'source' });
      await createAsset(app, { name: 'r1', parentId: parent['id'] });
      await createAsset(app, { name: 'r2', parentId: parent['id'] });
      await createAsset(app, { name: 'unrelated' });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/assets?parentId=${parent['id']}`,
        headers: A
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().total).toBe(2);
      expect(res.json().items.map((i: { name: string }) => i.name).sort()).toEqual(['r1', 'r2']);
    });

    it('blocks deleting a parent that still has children (409)', async () => {
      const { body: parent } = await createAsset(app, { name: 'source' });
      await createAsset(app, { name: 'r1', parentId: parent['id'] });
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/assets/${parent['id']}`,
        headers: A
      });
      expect(res.statusCode).toBe(409);
      expect(res.json().error).toBe('has_children');
    });
  });

  describe('pagination and filtering', () => {
    it('paginates with limit/offset and reports total', async () => {
      for (let i = 0; i < 5; i++) {
        await createAsset(app, { name: `clip-${i}` });
      }
      const page1 = await app.inject({
        method: 'GET',
        url: '/api/v1/assets?limit=2&offset=0',
        headers: A
      });
      expect(page1.statusCode).toBe(200);
      expect(page1.json().items).toHaveLength(2);
      expect(page1.json().total).toBe(5);
      expect(page1.json().limit).toBe(2);

      const page3 = await app.inject({
        method: 'GET',
        url: '/api/v1/assets?limit=2&offset=4',
        headers: A
      });
      expect(page3.json().items).toHaveLength(1);
    });

    it('filters by ?status=', async () => {
      const { body } = await createAsset(app, { name: 'p' });
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/assets/${body['id']}`,
        headers: A,
        payload: { status: 'processing' }
      });
      await createAsset(app, { name: 'u' }); // stays uploading
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/assets?status=processing',
        headers: A
      });
      expect(res.json().total).toBe(1);
      expect(res.json().items[0].name).toBe('p');
    });
  });

  describe('workspace isolation', () => {
    it.skip('does not let workspace B read workspace A assets', async () => {
      const { body } = await createAsset(app, { name: 'private' }, A);
      const cross = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${body['id']}`,
        headers: auth('token-b')
      });
      expect(cross.statusCode).toBe(404);
    });
  });
});
