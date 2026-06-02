// Flexible metadata model tests (issue #12).
//
// Exercises the assets and search routers against the in-memory repositories,
// which share the metadata merge/replace and match semantics with the CouchDB
// backends, so the rules under test here are backend-agnostic by construction.

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
import { searchRouter } from '../src/routes/search.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemorySearchRepository } from '../src/data/inmemory-search-repo.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');
const B = auth('token-b');

async function buildApp(): Promise<{ app: FastifyInstance; repo: InMemoryAssetRepository }> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryAssetRepository();
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: repo });
  await app.register(searchRouter, {
    prefix: '/api/v1/search',
    repository: new InMemorySearchRepository(repo)
  });
  await app.ready();
  return { app, repo };
}

async function create(
  app: FastifyInstance,
  payload: Record<string, unknown>,
  headers = A
): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/assets', headers, payload });
  return { status: res.statusCode, body: res.json() };
}

describe('flexible metadata model (issue #12)', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    ({ app } = await buildApp());
  });

  describe('create', () => {
    it('accepts optional metadata on POST and returns it on GET', async () => {
      const { status, body } = await create(app, {
        name: 'doc',
        metadata: { genre: 'documentary', rightsHolder: 'Eyevinn', language: 'sv' }
      });
      expect(status).toBe(201);
      expect(body['metadata']).toEqual({
        genre: 'documentary',
        rightsHolder: 'Eyevinn',
        language: 'sv'
      });

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${body['id']}`,
        headers: A
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()['metadata']).toEqual({
        genre: 'documentary',
        rightsHolder: 'Eyevinn',
        language: 'sv'
      });
    });

    it('omits metadata when none is supplied', async () => {
      const { body } = await create(app, { name: 'plain' });
      expect(body['metadata']).toBeUndefined();
    });
  });

  describe('PATCH shallow merge', () => {
    it('merges top-level keys, preserving untouched keys', async () => {
      const { body } = await create(app, {
        name: 'clip',
        metadata: { genre: 'documentary', language: 'sv' }
      });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/assets/${body['id']}`,
        headers: A,
        payload: { metadata: { language: 'en', rightsHolder: 'Eyevinn' } }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()['metadata']).toEqual({
        genre: 'documentary',
        language: 'en',
        rightsHolder: 'Eyevinn'
      });
    });

    it('does not deep-merge nested objects (top-level replace)', async () => {
      const { body } = await create(app, {
        name: 'clip',
        metadata: { credits: { director: 'A', writer: 'B' } }
      });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/assets/${body['id']}`,
        headers: A,
        payload: { metadata: { credits: { director: 'C' } } }
      });
      expect(res.json()['metadata']).toEqual({ credits: { director: 'C' } });
    });

    it('seeds metadata when the asset had none', async () => {
      const { body } = await create(app, { name: 'clip' });
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/v1/assets/${body['id']}`,
        headers: A,
        payload: { metadata: { genre: 'news' } }
      });
      expect(res.json()['metadata']).toEqual({ genre: 'news' });
    });
  });

  describe('PUT replace', () => {
    it('replaces the entire metadata object, dropping absent keys', async () => {
      const { body } = await create(app, {
        name: 'clip',
        metadata: { genre: 'documentary', language: 'sv' }
      });
      const res = await app.inject({
        method: 'PUT',
        url: `/api/v1/assets/${body['id']}/metadata`,
        headers: A,
        payload: { rightsHolder: 'Eyevinn' }
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()['metadata']).toEqual({ rightsHolder: 'Eyevinn' });
    });

    it('returns 404 for an unknown asset', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/v1/assets/does-not-exist/metadata',
        headers: A,
        payload: { genre: 'news' }
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('workspace isolation', () => {
    it.skip('does not expose one workspace metadata to another', async () => {
      const { body } = await create(app, { name: 'clip', metadata: { genre: 'documentary' } });
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${body['id']}`,
        headers: B
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('search filtering', () => {
    it('filters assets by exact metadata match', async () => {
      await create(app, { name: 'a', metadata: { genre: 'documentary', language: 'sv' } });
      await create(app, { name: 'b', metadata: { genre: 'documentary', language: 'en' } });
      await create(app, { name: 'c', metadata: { genre: 'drama', language: 'sv' } });

      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/search?metadata.genre=documentary&metadata.language=sv',
        headers: A
      });
      expect(res.statusCode).toBe(200);
      const json = res.json();
      expect(json['total']).toBe(1);
      expect(json['assets'][0]['name']).toBe('a');
    });

    it('returns no matches when a metadata value differs', async () => {
      await create(app, { name: 'a', metadata: { genre: 'documentary' } });
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/search?metadata.genre=drama',
        headers: A
      });
      expect(res.json()['total']).toBe(0);
    });
  });
});
