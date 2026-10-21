// Rename -> search freshness regression (issue #929).
//
// The parent acceptance criteria require a renamed asset's new name to appear
// "in the list and in search". This file pins the answer to the open question
// behind #929: whether the search surface needs an explicit reindex after a
// PATCH rename.
//
// It does NOT. Search is a READ-THROUGH projection over the canonical document
// store, not a separately-maintained index:
//   - PATCH /api/v1/assets/:id      -> src/routes/assets.ts app.patch('/:id')
//                                   -> CouchAssetRepository.update (src/data/couch-asset-repo.ts:338)
//                                   -> toAssetDocument (descriptive.title, src/data/asset-document.ts:455)
//   - PATCH /api/v1/collections/:id -> src/routes/collections.ts app.patch('/:id')
//                                   -> CouchCollectionRepository.update (src/data/couch-collection-repo.ts:93)
//   - GET /api/v1/search            -> src/routes/search.ts app.get('/')
//                                   -> CouchSearchRepository.search (src/data/couch-search-repo.ts:44)
//                                      which reads the SAME documents back per
//                                      request (fromDoc -> fromAssetDocument,
//                                      src/data/asset-document.ts:634) and
//                                      applies matchesQuery in-process.
//
// So there is no index to fall behind and no reindex trigger to add. These tests
// guard that property: both routers and the search router are wired over ONE
// document store, the rename goes through the public PATCH, and the very next
// search request must already answer with the new name — with nothing called in
// between.

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
import { collectionsRouter } from '../src/routes/collections.js';
import { searchRouter } from '../src/routes/search.js';
import { CouchAssetRepository } from '../src/data/couch-asset-repo.js';
import { CouchCollectionRepository } from '../src/data/couch-collection-repo.js';
import { CouchSearchRepository } from '../src/data/couch-search-repo.js';
import type { StoredDoc, StackCouch } from '../src/data/couchdb.js';

const A = { authorization: 'Bearer token-a' };

// Minimal in-test StackCouch fake, identical in behaviour to the one in
// search-parity.test.ts: it stores whatever body is put (so the persisted
// four-namespace shape is reproduced faithfully) and implements the selector
// predicates the repositories push down.
class FakeCouch {
  private readonly docs = new Map<string, StoredDoc>();
  private rev = 0;

  async put(localId: string, body: Record<string, unknown>): Promise<{ id: string; rev: string }> {
    this.rev += 1;
    const rev = `${this.rev}-x`;
    this.docs.set(localId, {
      ...body,
      _id: localId,
      _rev: rev,
      resourceType: String(body['resourceType'] ?? 'asset')
    } as StoredDoc);
    return { id: localId, rev };
  }

  async get(localId: string): Promise<StoredDoc | undefined> {
    const d = this.docs.get(localId);
    return d ? { ...d } : undefined;
  }

  private matches(doc: StoredDoc, selector: Record<string, unknown>): boolean {
    for (const [key, cond] of Object.entries(selector)) {
      const actual = key.includes('.')
        ? key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], doc)
        : (doc as Record<string, unknown>)[key];
      if (cond !== null && typeof cond === 'object') {
        const c = cond as Record<string, unknown>;
        if ('$ne' in c && actual === c['$ne']) return false;
        if ('$eq' in c && actual !== c['$eq']) return false;
        if ('$all' in c) {
          const want = c['$all'] as unknown[];
          const have = Array.isArray(actual) ? (actual as unknown[]) : [];
          if (!want.every((w) => have.includes(w))) return false;
        }
        if ('$elemMatch' in c) {
          const em = c['$elemMatch'] as Record<string, unknown>;
          const have = Array.isArray(actual) ? (actual as unknown[]) : [];
          if ('$eq' in em && !have.includes(em['$eq'])) return false;
        }
      } else if (actual !== cond) {
        return false;
      }
    }
    return true;
  }

  async find(
    selector: Record<string, unknown>,
    opts: { limit?: number; skip?: number } = {}
  ): Promise<StoredDoc[]> {
    const all = [...this.docs.values()].filter((d) => this.matches(d, selector));
    const skip = opts.skip ?? 0;
    return all.slice(skip, skip + (opts.limit ?? all.length)).map((d) => ({ ...d }));
  }

  async count(selector: Record<string, unknown>): Promise<number> {
    return [...this.docs.values()].filter((d) => this.matches(d, selector)).length;
  }

  async remove(): Promise<void> {
    /* unused */
  }
}

type Harness = {
  app: FastifyInstance;
  couch: FakeCouch;
};

// Wire the asset, collection and search routers over ONE document store, using
// the CouchDB-backed repositories — the production persistence path — so the
// test exercises the real persisted document shape rather than a shortcut.
async function buildApp(): Promise<Harness> {
  const couch = new FakeCouch();
  const couchFor = () => couch as unknown as StackCouch;
  const assets = new CouchAssetRepository(couchFor);
  const collections = new CouchCollectionRepository(couchFor);
  const search = new CouchSearchRepository(couchFor, collections);

  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: assets });
  await app.register(collectionsRouter, {
    prefix: '/api/v1/collections',
    repository: collections,
    assetRepository: assets
  });
  await app.register(searchRouter, { prefix: '/api/v1/search', repository: search });
  await app.ready();
  return { app, couch };
}

async function searchFor(app: FastifyInstance, q: string): Promise<Record<string, never>> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/v1/search?q=${encodeURIComponent(q)}`,
    headers: A
  });
  expect(res.statusCode).toBe(200);
  return res.json();
}

describe('asset rename propagates to search with no reindex step (issue #929)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = await buildApp());
  });

  it('the very next search request returns the new name', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: A,
      payload: { name: 'Harbour sunrise' }
    });
    expect(created.statusCode).toBe(201);
    const id = created.json()['id'] as string;

    // Baseline: findable under the original name.
    expect((await searchFor(app, 'Harbour sunrise'))['total']).toBe(1);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/assets/${id}`,
      headers: A,
      payload: { name: 'Quayside dawn' }
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()['name']).toBe('Quayside dawn');

    // NOTHING is called between the PATCH above and the search below: no
    // reindex endpoint, no sweep, no repository method. The search request is
    // the next thing the app sees.
    const hits = await searchFor(app, 'Quayside dawn');
    expect(hits['total']).toBe(1);
    expect((hits['assets'] as unknown as Record<string, unknown>[])[0]['id']).toBe(id);
    expect((hits['assets'] as unknown as Record<string, unknown>[])[0]['name']).toBe(
      'Quayside dawn'
    );
  });

  it('the old name stops matching immediately (no stale index entry)', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: A,
      payload: { name: 'Harbour sunrise' }
    });
    const id = created.json()['id'] as string;

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/assets/${id}`,
      headers: A,
      payload: { name: 'Quayside dawn' }
    });

    const stale = await searchFor(app, 'Harbour sunrise');
    expect(stale['total']).toBe(0);
    expect(stale['assets']).toEqual([]);
  });

  it('the rename shows in the asset list on the same terms', async () => {
    // The parent criterion is "in the list AND in search": the list reads the
    // same document store, so both surfaces move together.
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: A,
      payload: { name: 'Harbour sunrise' }
    });
    const id = created.json()['id'] as string;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/assets/${id}`,
      headers: A,
      payload: { name: 'Quayside dawn' }
    });

    const list = await app.inject({ method: 'GET', url: '/api/v1/assets', headers: A });
    expect(list.statusCode).toBe(200);
    const listed = (list.json()['items'] as Record<string, unknown>[]).find((a) => a['id'] === id);
    expect(listed?.['name']).toBe('Quayside dawn');
  });

  it('a rename combined with a metadata edit is fully reflected in one step', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: A,
      payload: { name: 'Harbour sunrise', description: 'original note' }
    });
    const id = created.json()['id'] as string;

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/assets/${id}`,
      headers: A,
      payload: { name: 'Quayside dawn', description: 'edited note' }
    });

    // Both descriptive fields the free-text tier matches on (name, description)
    // are fresh on the next request.
    expect((await searchFor(app, 'Quayside'))['total']).toBe(1);
    expect((await searchFor(app, 'edited note'))['total']).toBe(1);
    expect((await searchFor(app, 'original note'))['total']).toBe(0);
  });
});

describe('collection rename propagates to search with no reindex step (issue #929)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = await buildApp());
  });

  it('the very next search request returns the new collection name', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: A,
      payload: { name: 'Winter reels' }
    });
    expect(created.statusCode).toBe(201);
    const id = created.json()['id'] as string;

    expect((await searchFor(app, 'Winter reels'))['collectionTotal']).toBe(1);

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${id}`,
      headers: A,
      payload: { name: 'Spring reels' }
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()['name']).toBe('Spring reels');

    const hits = await searchFor(app, 'Spring reels');
    expect(hits['collectionTotal']).toBe(1);
    const collections = hits['collections'] as unknown as Record<string, unknown>[];
    expect(collections[0]['id']).toBe(id);
    expect(collections[0]['name']).toBe('Spring reels');
    expect(collections[0]['type']).toBe('collection');
  });

  it('the old collection name stops matching immediately', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/collections',
      headers: A,
      payload: { name: 'Winter reels' }
    });
    const id = created.json()['id'] as string;

    await app.inject({
      method: 'PATCH',
      url: `/api/v1/collections/${id}`,
      headers: A,
      payload: { name: 'Spring reels' }
    });

    const stale = await searchFor(app, 'Winter reels');
    expect(stale['collectionTotal']).toBe(0);
    expect(stale['collections']).toEqual([]);
  });
});

describe('search holds no index state of its own (issue #929)', () => {
  it('a FRESH search repository over the same store answers identically after a rename', async () => {
    // The structural reason no reindex trigger is needed: CouchSearchRepository
    // keeps nothing between calls — it reads the documents back per request. A
    // brand-new instance constructed AFTER the rename therefore answers exactly
    // like the one the running app used, which is the same property that makes
    // the projection disposable/rebuildable.
    const { app, couch } = await buildApp();
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: A,
      payload: { name: 'Harbour sunrise' }
    });
    const id = created.json()['id'] as string;
    await app.inject({
      method: 'PATCH',
      url: `/api/v1/assets/${id}`,
      headers: A,
      payload: { name: 'Quayside dawn' }
    });

    const rebuilt = new CouchSearchRepository(() => couch as unknown as StackCouch);
    const viaRebuilt = await rebuilt.search({ q: 'Quayside dawn' });
    expect(viaRebuilt.total).toBe(1);
    expect(viaRebuilt.assets[0].id).toBe(id);
    expect(viaRebuilt.assets[0].name).toBe('Quayside dawn');

    const viaApp = await searchFor(app, 'Quayside dawn');
    expect(viaApp['total']).toBe(1);
  });
});
