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
//
// Explicit member-count confirmation (issue #922, design decision for #854
// option 1) layers onto the same route: `?confirmMemberCount=N` deletes a
// non-empty collection in one call when N matches the current member count,
// unlinking the members only — the member ASSETS are never touched. Omitting the
// param keeps the safe default (409), and a stale N is refused rather than
// silently honoured.

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { collectionsRouter } from './collections.js';
import { InMemoryCollectionRepository } from '../data/inmemory-collection-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';

async function buildApp(
  repo: InMemoryCollectionRepository,
  assets: InMemoryAssetRepository = new InMemoryAssetRepository()
) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(collectionsRouter, {
    prefix: '/api/v1/collections',
    repository: repo,
    assetRepository: assets
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
      blockedBy: { jobIds: [], collectionIds: [collection.id] },
      // Additive since #922: the count a caller echoes back to confirm.
      memberCount: 1
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

describe('explicit member-count confirmation on collection delete (issue #922)', () => {
  // (a) Safe default preserved: no confirmation param => the unchanged 409,
  // now reporting the member count the caller has to confirm.
  it('still 409s an unconfirmed delete on a non-empty collection, reporting the member count', async () => {
    const assets = new InMemoryAssetRepository();
    const repo = new InMemoryCollectionRepository();
    const a1 = await assets.create({ name: 'member-one' });
    const a2 = await assets.create({ name: 'member-two' });
    const collection = await repo.create({ name: 'busy-set' });
    await repo.addAsset(collection.id, a1.id);
    await repo.addAsset(collection.id, a2.id);
    const app = await buildApp(repo, assets);

    const blocked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collection.id}`
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({
      error: 'delete_blocked',
      message: expect.any(String),
      reason: 'member_of_collection',
      blockedBy: { jobIds: [], collectionIds: [collection.id] },
      memberCount: 2
    });
    expect(await repo.get(collection.id)).toBeDefined();
  });

  // (b) A confirmation matching the current count deletes in that same call,
  // and unlinks the members ONLY — both member assets still resolve afterwards.
  it('deletes the collection when confirmMemberCount matches, leaving the member assets intact', async () => {
    const assets = new InMemoryAssetRepository();
    const repo = new InMemoryCollectionRepository();
    const a1 = await assets.create({ name: 'member-one' });
    const a2 = await assets.create({ name: 'member-two' });
    const collection = await repo.create({ name: 'busy-set' });
    await repo.addAsset(collection.id, a1.id);
    await repo.addAsset(collection.id, a2.id);
    const app = await buildApp(repo, assets);

    const confirmed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collection.id}?confirmMemberCount=2`
    });
    expect(confirmed.statusCode).toBe(204);
    expect(await repo.get(collection.id)).toBeUndefined();

    // Membership dropped with the collection; the asset resources survive.
    expect(await assets.get(a1.id)).toBeDefined();
    expect(await assets.get(a2.id)).toBeDefined();
  });

  // (c) A stale/mismatched confirmation is refused — never a silent delete —
  // and the 409 carries the authoritative current count to re-confirm with.
  it('rejects a stale confirmMemberCount with 409 instead of deleting', async () => {
    const assets = new InMemoryAssetRepository();
    const repo = new InMemoryCollectionRepository();
    const a1 = await assets.create({ name: 'member-one' });
    const a2 = await assets.create({ name: 'member-two' });
    const a3 = await assets.create({ name: 'member-three' });
    const collection = await repo.create({ name: 'busy-set' });
    await repo.addAsset(collection.id, a1.id);
    await repo.addAsset(collection.id, a2.id);
    // Raced membership add after the caller read the collection at 2 members.
    await repo.addAsset(collection.id, a3.id);
    const app = await buildApp(repo, assets);

    const stale = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collection.id}?confirmMemberCount=2`
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toEqual({
      error: 'delete_blocked',
      message: expect.any(String),
      reason: 'member_of_collection',
      blockedBy: { jobIds: [], collectionIds: [collection.id] },
      memberCount: 3
    });
    expect(await repo.get(collection.id)).toBeDefined();

    // Re-confirming with the count from that 409 succeeds.
    const retry = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collection.id}?confirmMemberCount=3`
    });
    expect(retry.statusCode).toBe(204);
    expect(await repo.get(collection.id)).toBeUndefined();
  });

  // Precedence guard (ADR-020): the HARD explicit lock still wins over the new
  // confirmation path — a matching count must NOT delete a locked collection.
  it('keeps delete_protected precedence over a matching confirmMemberCount', async () => {
    const repo = new InMemoryCollectionRepository();
    const collection = await repo.create({ name: 'locked-set' });
    await repo.addAsset(collection.id, 'asset-1');
    await repo.setDeleteLock(collection.id, { locked: true });
    const app = await buildApp(repo);

    const attempt = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collection.id}?confirmMemberCount=1`
    });
    expect(attempt.statusCode).toBe(409);
    expect((attempt.json() as { reason: string }).reason).toBe('delete_protected');
    expect(await repo.get(collection.id)).toBeDefined();
  });
});
