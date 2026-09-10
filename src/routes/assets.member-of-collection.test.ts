// Block asset deletion while a member of a collection (issue #570, contract
// ADR-020).
//
// Verifies the member-of-collection detection end to end against the assets
// router:
//   - When the asset is a member of >=1 collection, DELETE /:id returns 409 with
//     the shared `delete_blocked` envelope, reason `member_of_collection`, and
//     the blocking collection ids in `blockedBy.collectionIds`. The block does
//     NOT auto-remove the membership (the collection is untouched).
//   - `?force=true` overrides the SOFT block (ADR-020 decision 2) and archives.
//   - An asset in no collection deletes as today (204).

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetsRouter } from './assets.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryCollectionRepository } from '../data/inmemory-collection-repo.js';

async function buildApp(
  repo: InMemoryAssetRepository,
  collections: InMemoryCollectionRepository
) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    collectionRepository: collections
  });
  await app.ready();
  return app;
}

describe('block asset deletion while a member of a collection (issue #570)', () => {
  it('blocks DELETE with 409 member_of_collection and names the collection ids', async () => {
    const repo = new InMemoryAssetRepository();
    const collections = new InMemoryCollectionRepository();
    const asset = await repo.create({ name: 'in-a-set' });
    const c1 = await collections.create({ name: 'set-one' });
    const c2 = await collections.create({ name: 'set-two' });
    await collections.addAsset(c1.id, asset.id);
    await collections.addAsset(c2.id, asset.id);
    const app = await buildApp(repo, collections);

    const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${asset.id}` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({
      error: 'delete_blocked',
      message: expect.any(String),
      reason: 'member_of_collection',
      blockedBy: { jobIds: [], collectionIds: [c1.id, c2.id] }
    });

    // The block does NOT auto-remove membership; the collections are untouched.
    expect((await collections.get(c1.id))?.assetIds).toContain(asset.id);
    expect((await collections.get(c2.id))?.assetIds).toContain(asset.id);
    // The asset is not archived.
    expect((await repo.get(asset.id))?.status).not.toBe('archived');
  });

  it('lets ?force=true override the soft member_of_collection block', async () => {
    const repo = new InMemoryAssetRepository();
    const collections = new InMemoryCollectionRepository();
    const asset = await repo.create({ name: 'forced' });
    const c1 = await collections.create({ name: 'set-one' });
    await collections.addAsset(c1.id, asset.id);
    const app = await buildApp(repo, collections);

    const forced = await app.inject({
      method: 'DELETE',
      url: `/api/v1/assets/${asset.id}?force=true`
    });
    expect(forced.statusCode).toBe(204);
    expect((await repo.get(asset.id))?.status).toBe('archived');
  });

  it('is a no-op when the asset is a member of no collection (204)', async () => {
    const repo = new InMemoryAssetRepository();
    const collections = new InMemoryCollectionRepository();
    const asset = await repo.create({ name: 'lonely' });
    await collections.create({ name: 'unrelated' });
    const app = await buildApp(repo, collections);

    const delRes = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${asset.id}` });
    expect(delRes.statusCode).toBe(204);
    expect((await repo.get(asset.id))?.status).toBe('archived');
  });

  it('deletes as today when no collection repo is wired', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'no-collection-repo' });
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: repo });
    await app.ready();

    const delRes = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${asset.id}` });
    expect(delRes.statusCode).toBe(204);
    expect((await repo.get(asset.id))?.status).toBe('archived');
  });
});
