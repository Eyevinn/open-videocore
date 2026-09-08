// Explicit delete-lock on collections (issue #568, contract ADR-020).
//
// Mirrors the asset delete-lock coverage against the collections router:
//   - PUT /:id/lock protects a collection; DELETE /:id then returns 409 with the
//     shared `delete_blocked` envelope (reason `delete_protected`, empty
//     blockedBy arrays), and keeps blocking until the lock is cleared.
//   - `?force=true` does NOT bypass the lock (ADR-020 decision 2: hard block).
//   - DELETE /:id/lock clears the lock; DELETE /:id then succeeds (204).
//   - The lock's `lockedAt`/`lockedBy` are the traceable administrative record
//     of the change (collections carry no separate provenance array; ADR-020
//     pins the lock's own fields as that record for collections).
//   - The field is optional: an unlocked/absent-lock collection deletes as today.

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { collectionsRouter } from './collections.js';
import { InMemoryCollectionRepository } from '../data/inmemory-collection-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import type { Collection } from '../data/collection-repo.js';

async function buildApp(repo: InMemoryCollectionRepository) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(collectionsRouter, {
    prefix: '/api/v1/collections',
    repository: repo,
    // The lock paths never touch the asset repo; a bare in-memory one satisfies
    // the router's required option.
    assetRepository: new InMemoryAssetRepository()
  });
  await app.ready();
  return app;
}

describe('explicit delete-lock on collections (issue #568)', () => {
  it('blocks DELETE with 409 delete_protected while locked, then succeeds once cleared', async () => {
    const repo = new InMemoryCollectionRepository();
    const collection = await repo.create({ name: 'protected-set' });
    const app = await buildApp(repo);

    const lockRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/collections/${collection.id}/lock`,
      payload: { reason: 'campaign live', lockedBy: 'operator-2' }
    });
    expect(lockRes.statusCode).toBe(200);
    expect((lockRes.json() as Collection).deleteLock).toEqual({
      locked: true,
      reason: 'campaign live',
      lockedAt: expect.any(String),
      lockedBy: 'operator-2'
    });

    const blocked = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collection.id}`
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({
      error: 'delete_blocked',
      message: expect.any(String),
      reason: 'delete_protected',
      blockedBy: { jobIds: [], collectionIds: [] }
    });

    // Still present (the block prevented the delete).
    expect(await repo.get(collection.id)).toBeDefined();

    const unlockRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collection.id}/lock`
    });
    expect(unlockRes.statusCode).toBe(200);
    expect((unlockRes.json() as Collection).deleteLock).toBeUndefined();

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collection.id}`
    });
    expect(delRes.statusCode).toBe(204);
    expect(await repo.get(collection.id)).toBeUndefined();
  });

  it('does NOT let ?force=true bypass the lock', async () => {
    const repo = new InMemoryCollectionRepository();
    const collection = await repo.create({ name: 'protected-set' });
    const app = await buildApp(repo);
    await app.inject({
      method: 'PUT',
      url: `/api/v1/collections/${collection.id}/lock`,
      payload: {}
    });

    const forced = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collection.id}?force=true`
    });
    expect(forced.statusCode).toBe(409);
    expect((forced.json() as { reason: string }).reason).toBe('delete_protected');
    expect(await repo.get(collection.id)).toBeDefined();
  });

  it('records the change via the lock object (lockedAt / lockedBy)', async () => {
    const repo = new InMemoryCollectionRepository();
    const collection = await repo.create({ name: 'protected-set' });
    const app = await buildApp(repo);

    await app.inject({
      method: 'PUT',
      url: `/api/v1/collections/${collection.id}/lock`,
      payload: { lockedBy: 'operator-3' }
    });
    const locked = await repo.get(collection.id);
    expect(locked?.deleteLock?.locked).toBe(true);
    expect(locked?.deleteLock?.lockedBy).toBe('operator-3');
    expect(locked?.deleteLock?.lockedAt).toEqual(expect.any(String));
  });

  it('is optional: a collection with no lock deletes as today', async () => {
    const repo = new InMemoryCollectionRepository();
    const collection = await repo.create({ name: 'ordinary-set' });
    const app = await buildApp(repo);

    expect((await repo.get(collection.id))?.deleteLock).toBeUndefined();

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/collections/${collection.id}`
    });
    expect(delRes.statusCode).toBe(204);
    expect(await repo.get(collection.id)).toBeUndefined();
  });

  it('returns 404 when locking an unknown collection', async () => {
    const repo = new InMemoryCollectionRepository();
    const app = await buildApp(repo);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/collections/collection-does-not-exist/lock',
      payload: {}
    });
    expect(res.statusCode).toBe(404);
  });
});
