// Member assets survive a confirmed collection delete (issue #924, broken out
// of #854).
//
// `DELETE /api/v1/collections/:id?confirmMemberCount=N` (src/routes/collections.ts:412-530)
// is the explicit, one-call way to tear down a NON-EMPTY collection. The route
// comment pins the intended blast radius: membership lives INSIDE the collection
// document as the flat `assetIds` list (src/data/collection-repo.ts:31,
// `Collection.assetIds`), and `repo.delete()` removes only that document —
// nothing on this path calls into the asset repository
// (src/routes/collections.ts:493-502).
//
// This file is the coverage for that claim, asserted end to end over BOTH
// routers (assets + collections) against one shared pair of in-memory repos. For
// every former member asset of a deleted collection it verifies:
//
//   1. The asset still EXISTS and is retrievable via its OWN endpoint —
//      `GET /api/v1/assets/:id` still answers 200 with a body byte-identical to
//      the pre-delete one (schema: `assetSchema`, src/routes/assets.ts:841;
//      route: src/routes/assets.ts:3378-3390). An untouched `updatedAt` is the
//      proof the delete never wrote to the asset document.
//   2. The asset still appears in every OTHER collection it belonged to —
//      `GET /api/v1/collections/:id` keeps it in both `assetIds` and the
//      resolved `assets` array (`collectionWithAssetsSchema`,
//      src/routes/collections.ts:108-110).
//   3. The asset no longer references the DELETED collection — the membership
//      lookup the asset-delete block consults
//      (`CollectionRepository.collectionsContainingAsset`,
//      src/data/collection-repo.ts:119) no longer reports the deleted id, and
//      the ADR-020 `member_of_collection` block on `DELETE /api/v1/assets/:id`
//      (src/routes/assets.ts:5685-5691) names only the surviving collections.
//
// Nothing else is removed: the asset list is unchanged, the surviving collection
// is unchanged, and only the deleted collection's own resource 404s afterwards.
//
// Read-only coverage of existing behaviour — no production change is implied.

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetsRouter } from './assets.js';
import { collectionsRouter } from './collections.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryCollectionRepository } from '../data/inmemory-collection-repo.js';

type Json = Record<string, unknown>;

// Both routers over the SAME repositories, mirroring the production wiring in
// src/main.ts: the collections router resolves membership through the asset repo
// (`assetRepository`) and the assets router consults the collection repo for the
// member_of_collection delete block (`collectionRepository`).
async function buildApp(): Promise<{
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  collections: InMemoryCollectionRepository;
}> {
  const assets = new InMemoryAssetRepository();
  const collections = new InMemoryCollectionRepository();
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    collectionRepository: collections
  });
  await app.register(collectionsRouter, {
    prefix: '/api/v1/collections',
    repository: collections,
    assetRepository: assets
  });
  await app.ready();
  return { app, assets, collections };
}

async function createAsset(app: FastifyInstance, name: string): Promise<Json> {
  const res = await app.inject({ method: 'POST', url: '/api/v1/assets', payload: { name } });
  expect(res.statusCode).toBe(201);
  return res.json() as Json;
}

async function createCollection(app: FastifyInstance, name: string): Promise<Json> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/collections',
    payload: { name }
  });
  expect(res.statusCode).toBe(201);
  return res.json() as Json;
}

async function addMember(
  app: FastifyInstance,
  collectionId: string,
  assetId: string
): Promise<void> {
  const res = await app.inject({
    method: 'PUT',
    url: `/api/v1/collections/${collectionId}/assets/${assetId}`
  });
  expect(res.statusCode).toBe(200);
}

async function getAsset(app: FastifyInstance, assetId: string) {
  return app.inject({ method: 'GET', url: `/api/v1/assets/${assetId}` });
}

// Fixture shared by the cases below:
//   doomed    = [a1, a2]   — deleted with a matching confirmMemberCount
//   surviving = [a2, a3]   — untouched; a2 is deliberately in BOTH
// a1 exercises "last collection gone", a2 "still in another collection", and a3
// "never a member of the deleted collection".
async function fixture() {
  const { app, assets, collections } = await buildApp();
  const a1 = await createAsset(app, 'member-only-in-doomed');
  const a2 = await createAsset(app, 'member-in-both');
  const a3 = await createAsset(app, 'member-only-in-surviving');
  const doomed = await createCollection(app, 'doomed-set');
  const surviving = await createCollection(app, 'surviving-set');
  await addMember(app, doomed['id'] as string, a1['id'] as string);
  await addMember(app, doomed['id'] as string, a2['id'] as string);
  await addMember(app, surviving['id'] as string, a2['id'] as string);
  await addMember(app, surviving['id'] as string, a3['id'] as string);
  return {
    app,
    assets,
    collections,
    a1: a1['id'] as string,
    a2: a2['id'] as string,
    a3: a3['id'] as string,
    doomed: doomed['id'] as string,
    surviving: surviving['id'] as string
  };
}

describe('member assets survive a confirmed collection delete (issue #924)', () => {
  it('keeps every former member asset retrievable via its own endpoint, unchanged', async () => {
    const { app, a1, a2, doomed } = await fixture();

    // Snapshot the exact pre-delete representations to compare against.
    const before1 = (await getAsset(app, a1)).json() as Json;
    const before2 = (await getAsset(app, a2)).json() as Json;

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${doomed}?confirmMemberCount=2`
    });
    expect(deleted.statusCode).toBe(204);

    // Invariant 1: each former member still resolves on its own asset endpoint,
    // byte-identical to before — same id, name, status, statusHistory, and an
    // UNTOUCHED `updatedAt` (the collection delete never wrote to the asset).
    for (const [assetId, before] of [
      [a1, before1],
      [a2, before2]
    ] as const) {
      const after = await getAsset(app, assetId);
      expect(after.statusCode).toBe(200);
      const body = after.json() as Json;
      expect(body['id']).toBe(assetId);
      expect(body['status']).not.toBe('archived');
      expect(body).toEqual(before);
    }
  });

  it('keeps a former member listed in the other collections it belonged to', async () => {
    const { app, a2, a3, doomed, surviving } = await fixture();

    const survivingBefore = (
      await app.inject({ method: 'GET', url: `/api/v1/collections/${surviving}` })
    ).json() as Json;

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${doomed}?confirmMemberCount=2`
    });
    expect(deleted.statusCode).toBe(204);

    // Invariant 2: the OTHER collection is untouched — same membership list, and
    // GET still resolves both member ids to live assets.
    const res = await app.inject({ method: 'GET', url: `/api/v1/collections/${surviving}` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Json;
    expect(body['assetIds']).toEqual([a2, a3]);
    expect((body['assets'] as Json[]).map((a) => a['id'])).toEqual([a2, a3]);
    // Not even `updatedAt` moved: the delete touched one document only.
    expect(body).toEqual(survivingBefore);

    // ...and it is still the only collection the workspace lists.
    const list = await app.inject({ method: 'GET', url: '/api/v1/collections' });
    expect((list.json()['collections'] as Json[]).map((c) => c['id'])).toEqual([surviving]);
  });

  it('drops every reference from the former members to the deleted collection', async () => {
    const { app, collections, a1, a2, a3, doomed, surviving } = await fixture();

    // Pre-delete baseline from the authoritative membership lookup.
    expect(await collections.collectionsContainingAsset(a1)).toEqual([doomed]);
    expect(await collections.collectionsContainingAsset(a2)).toEqual([doomed, surviving]);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${doomed}?confirmMemberCount=2`
    });
    expect(deleted.statusCode).toBe(204);

    // Invariant 3: no former member still references the deleted collection —
    // a1 (its only collection) is now in none, a2 keeps the surviving one only.
    expect(await collections.collectionsContainingAsset(a1)).toEqual([]);
    expect(await collections.collectionsContainingAsset(a2)).toEqual([surviving]);
    expect(await collections.collectionsContainingAsset(a3)).toEqual([surviving]);

    // The deleted collection resource itself is the only thing gone.
    const gone = await app.inject({ method: 'GET', url: `/api/v1/collections/${doomed}` });
    expect(gone.statusCode).toBe(404);

    // The dropped reference is observable on the asset surface too: the ADR-020
    // member_of_collection block on asset delete now names ONLY the surviving
    // collection for a2, and no longer blocks a1 at all.
    const stillBlocked = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${a2}` });
    expect(stillBlocked.statusCode).toBe(409);
    expect(stillBlocked.json()).toEqual({
      error: 'delete_blocked',
      message: expect.any(String),
      reason: 'member_of_collection',
      blockedBy: { jobIds: [], collectionIds: [surviving] }
    });

    const noLongerBlocked = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${a1}` });
    expect(noLongerBlocked.statusCode).toBe(204);
  });

  it('removes nothing from the asset collection beyond the memberships', async () => {
    const { app, a1, a2, a3, doomed } = await fixture();

    const before = (await app.inject({ method: 'GET', url: '/api/v1/assets' })).json() as Json;

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${doomed}?confirmMemberCount=2`
    });
    expect(deleted.statusCode).toBe(204);

    // All three assets — the two former members and the non-member — are still
    // listed, with the same total. Compared as a SET: `list()` orders by
    // `createdAt` then id (src/data/asset-repo.ts:1605), and three assets created
    // in the same millisecond tie on `createdAt`, so the id tiebreak (a random
    // ULID suffix) is not the creation order. The page itself is compared whole
    // below, which covers ordering stability across the delete.
    const after = (await app.inject({ method: 'GET', url: '/api/v1/assets' })).json() as Json;
    expect((after['items'] as Json[]).map((a) => a['id']).sort()).toEqual([a1, a2, a3].sort());
    expect(after['total']).toBe(3);
    expect(after).toEqual(before);
  });

  // The sibling override on the same route (`?force=true`, ADR-020 decision 2)
  // reaches the identical delete call, so it must honour the identical blast
  // radius. Guards against a future force-only teardown path cascading into the
  // member assets.
  it('holds the same invariants when the delete is forced instead of confirmed', async () => {
    const { app, collections, a1, a2, a3, doomed, surviving } = await fixture();

    const forced = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${doomed}?force=true`
    });
    expect(forced.statusCode).toBe(204);

    for (const assetId of [a1, a2, a3]) {
      const res = await getAsset(app, assetId);
      expect(res.statusCode).toBe(200);
      expect((res.json() as Json)['status']).not.toBe('archived');
    }
    expect(await collections.collectionsContainingAsset(a1)).toEqual([]);
    expect(await collections.collectionsContainingAsset(a2)).toEqual([surviving]);
    expect(
      (await app.inject({ method: 'GET', url: `/api/v1/collections/${surviving}` })).json()[
        'assetIds'
      ]
    ).toEqual([a2, a3]);
  });
});
