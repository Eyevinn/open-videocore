// Reference/usage check on collection delete (issue #570, contract ADR-020).
//
// The collection DELETE route previously only guarded the explicit lock. This
// adds the missing reference check so a collection that still holds member asset
// ids is not silently torn down:
//   - DELETE /:id on a non-empty collection returns 409 with the shared
//     `delete_blocked` envelope, reason `member_of_collection`, and the
//     collection's own id in `blockedBy.collectionIds`.
//   - `?force=true` overrides the SOFT block (ADR-020 decision 2) and deletes.
//   - An empty collection deletes as today (204).

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { collectionsRouter } from './collections.js';
import { InMemoryCollectionRepository } from '../data/inmemory-collection-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';

async function buildApp(repo: InMemoryCollectionRepository) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(collectionsRouter, {
    prefix: '/api/v1/collections',
    repository: repo,
    assetRepository: new InMemoryAssetRepository()
  });
  await app.ready();
  return app;
}

describe('collection-in-use reference check on delete (issue #570)', () => {
  it('blocks DELETE with 409 member_of_collection while the collection has members', async () => {
    const repo = new InMemoryCollectionRepository();
    const collection = await repo.create({ name: 'busy-set' });
    await repo.addAsset(collection.id, 'asset-1');
    const app = await buildApp(repo);

    const blocked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collection.id}`
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({
      error: 'delete_blocked',
      message: expect.any(String),
      reason: 'member_of_collection',
      blockedBy: { jobIds: [], collectionIds: [collection.id] }
    });

    // Still present — the block prevented the delete.
    expect(await repo.get(collection.id)).toBeDefined();
  });

  it('lets ?force=true override the soft in-use block', async () => {
    const repo = new InMemoryCollectionRepository();
    const collection = await repo.create({ name: 'busy-set' });
    await repo.addAsset(collection.id, 'asset-1');
    const app = await buildApp(repo);

    const forced = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collection.id}?force=true`
    });
    expect(forced.statusCode).toBe(204);
    expect(await repo.get(collection.id)).toBeUndefined();
  });

  it('deletes an empty collection as today (204)', async () => {
    const repo = new InMemoryCollectionRepository();
    const collection = await repo.create({ name: 'empty-set' });
    const app = await buildApp(repo);

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collection.id}`
    });
    expect(delRes.statusCode).toBe(204);
    expect(await repo.get(collection.id)).toBeUndefined();
  });
});
