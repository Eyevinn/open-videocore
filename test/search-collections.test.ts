// Collection-metadata search projection tests (issue #561).
//
// Exercises the search router against the in-memory search repository wired
// with a collection repository, so collection hits are projected into the
// search surface alongside asset hits. The in-memory repo shares the
// matchesCollectionQuery semantics with the CouchDB backend, so the match rules
// under test here are backend-agnostic by construction.

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
import { searchRouter } from '../src/routes/search.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryCollectionRepository } from '../src/data/inmemory-collection-repo.js';
import { InMemorySearchRepository } from '../src/data/inmemory-search-repo.js';

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

async function buildApp(
  assets: InMemoryAssetRepository,
  collections: InMemoryCollectionRepository
): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  await app.register(searchRouter, {
    prefix: '/api/v1/search',
    repository: new InMemorySearchRepository(assets, collections)
  });
  await app.ready();
  return app;
}

describe('collection search projection (issue #561)', () => {
  let assets: InMemoryAssetRepository;
  let collections: InMemoryCollectionRepository;
  let app: FastifyInstance;

  beforeEach(async () => {
    // NOTE: the in-memory ASSET repo's list()/create() reconstruction is broken
    // on this `main` (returns malformed/null assets — the same pre-existing
    // baseline failure that breaks test/search.test.ts). This suite exercises
    // the COLLECTION projection (issue #561), so it deliberately seeds no assets
    // and asserts only on the `collections`/`collectionTotal` half of the
    // response plus the `type` discriminator — which is exactly the feature
    // under test and is independent of the broken asset path.
    assets = new InMemoryAssetRepository();

    collections = new InMemoryCollectionRepository();
    await collections.create({
      name: 'Nature documentaries',
      description: 'Curated wildlife films',
      tags: ['nature', 'documentary'],
      custom: { genre: 'documentary', language: 'sv' }
    });
    await collections.create({
      name: 'City timelapses',
      tags: ['urban'],
      custom: { genre: 'timelapse' }
    });

    app = await buildApp(assets, collections);
  });

  it('projects collections into the search surface with a type discriminator', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=wildlife', headers: A });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Collection matched on its description and is surfaced distinctly, with the
    // `type: 'collection'` discriminator (issue #561 acceptance criterion).
    expect(body.collectionTotal).toBe(1);
    expect(body.collections).toHaveLength(1);
    expect(body.collections[0].type).toBe('collection');
    expect(body.collections[0].name).toBe('Nature documentaries');
    // Collection hits live in their own array, separate from `assets`, so they
    // are unambiguously distinguishable from asset hits.
    expect(Array.isArray(body.assets)).toBe(true);
    expect(body).toHaveProperty('collectionTotal');
  });

  it('matches collections free-text over name', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?q=timelapses', headers: A });
    const body = res.json();
    expect(body.collections.map((c: { name: string }) => c.name)).toEqual(['City timelapses']);
  });

  it('filters collections by tags with AND semantics', async () => {
    const hit = await app.inject({
      method: 'GET',
      url: '/api/v1/search?tags=nature,documentary',
      headers: A
    });
    expect(hit.json().collections).toHaveLength(1);
    const miss = await app.inject({
      method: 'GET',
      url: '/api/v1/search?tags=nature,urban',
      headers: A
    });
    expect(miss.json().collections).toHaveLength(0);
  });

  it('filters collections by the open custom bag via metadata.<key>', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/search?metadata.genre=documentary&metadata.language=sv',
      headers: A
    });
    const body = res.json();
    expect(body.collections).toHaveLength(1);
    expect(body.collections[0].name).toBe('Nature documentaries');
    expect(body.collections[0].custom.genre).toBe('documentary');
  });

  it('excludes all collections when an asset-only filter is set (mimeType)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search?mimeType=mp4', headers: A });
    expect(res.json().collections).toHaveLength(0);
  });

  it('returns every collection when no filters are given', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/search', headers: A });
    const body = res.json();
    expect(body.collectionTotal).toBe(2);
    expect(body.collections).toHaveLength(2);
    for (const c of body.collections) {
      expect(c.type).toBe('collection');
    }
  });

  it('surfaces an empty collections array when the search repo has no collection source', async () => {
    const bare = Fastify();
    bare.setValidatorCompiler(validatorCompiler);
    bare.setSerializerCompiler(serializerCompiler);
    registerAuth(bare);
    await bare.register(searchRouter, {
      prefix: '/api/v1/search',
      repository: new InMemorySearchRepository(assets)
    });
    await bare.ready();
    const res = await bare.inject({ method: 'GET', url: '/api/v1/search', headers: A });
    const body = res.json();
    expect(body.collections).toEqual([]);
    expect(body.collectionTotal).toBe(0);
  });
});
