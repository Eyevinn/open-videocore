// Explicit delete-lock on assets (issue #568, contract ADR-020).
//
// Verifies the explicit-lock mechanism end to end against the assets router:
//   - PUT /:id/lock protects an asset; DELETE /:id then returns 409 with the
//     shared `delete_blocked` envelope (reason `delete_protected`, empty
//     blockedBy arrays), and keeps blocking until the lock is cleared.
//   - `?force=true` does NOT bypass the lock (ADR-020 decision 2: hard block).
//   - DELETE /:id/lock clears the lock; DELETE /:id then succeeds (204).
//   - The lock set/clear is recorded in the asset's administrative provenance
//     trail (ADR-005 append-only `provenance`), so the change is traceable.
//   - The field is optional: an unlocked/absent-lock asset deletes as today.

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetsRouter } from './assets.js';
import { InMemoryAssetRepository, type Asset } from '../data/asset-repo.js';

async function buildApp(repo: InMemoryAssetRepository) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: repo });
  await app.ready();
  return app;
}

// Create a ready asset (a fresh asset starts `uploading`; the lock guard is
// independent of status, so `uploading` is fine for these tests).
async function createAsset(repo: InMemoryAssetRepository): Promise<Asset> {
  return repo.create({ name: 'locked-me' });
}

describe('explicit delete-lock on assets (issue #568)', () => {
  it('blocks DELETE with 409 delete_protected while locked, then succeeds once cleared', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await createAsset(repo);
    const app = await buildApp(repo);

    // Set the lock via the dedicated system path.
    const lockRes = await app.inject({
      method: 'PUT',
      url: `/api/v1/assets/${asset.id}/lock`,
      payload: { reason: 'legal hold', lockedBy: 'operator-1' }
    });
    expect(lockRes.statusCode).toBe(200);
    const locked = lockRes.json() as Asset;
    expect(locked.deleteLock).toEqual({
      locked: true,
      reason: 'legal hold',
      lockedAt: expect.any(String),
      lockedBy: 'operator-1'
    });

    // DELETE is now hard-blocked with the shared envelope.
    const blocked = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${asset.id}` });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({
      error: 'delete_blocked',
      message: expect.any(String),
      reason: 'delete_protected',
      blockedBy: { jobIds: [], collectionIds: [] }
    });

    // The asset is untouched (still present, not archived).
    expect((await repo.get(asset.id))?.status).not.toBe('archived');

    // Clear the lock, then DELETE succeeds.
    const unlockRes = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${asset.id}/lock` });
    expect(unlockRes.statusCode).toBe(200);
    expect((unlockRes.json() as Asset).deleteLock).toBeUndefined();

    const delRes = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${asset.id}` });
    expect(delRes.statusCode).toBe(204);
    expect((await repo.get(asset.id))?.status).toBe('archived');
  });

  it('does NOT let ?force=true bypass the lock', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await createAsset(repo);
    const app = await buildApp(repo);
    await app.inject({ method: 'PUT', url: `/api/v1/assets/${asset.id}/lock`, payload: {} });

    const forced = await app.inject({
      method: 'DELETE',
      url: `/api/v1/assets/${asset.id}?force=true`
    });
    expect(forced.statusCode).toBe(409);
    expect((forced.json() as { reason: string }).reason).toBe('delete_protected');
    // Still not archived — force did not clear or bypass the lock.
    expect((await repo.get(asset.id))?.status).not.toBe('archived');
  });

  it('records lock/unlock in the administrative provenance trail', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await createAsset(repo);
    const app = await buildApp(repo);

    await app.inject({
      method: 'PUT',
      url: `/api/v1/assets/${asset.id}/lock`,
      payload: { reason: 'audit' }
    });
    const afterLock = await repo.get(asset.id);
    const lockEntry = afterLock?.provenance?.find((p) => p.op === 'lock');
    expect(lockEntry).toBeDefined();
    expect(lockEntry?.by).toBe('user');
    expect(lockEntry?.detail).toBe('audit');

    await app.inject({ method: 'DELETE', url: `/api/v1/assets/${asset.id}/lock` });
    const afterUnlock = await repo.get(asset.id);
    expect(afterUnlock?.provenance?.some((p) => p.op === 'unlock')).toBe(true);
  });

  it('is optional: an asset with no lock deletes as today', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await createAsset(repo);
    const app = await buildApp(repo);

    // No lock set — deleteLock is absent.
    expect((await repo.get(asset.id))?.deleteLock).toBeUndefined();

    const delRes = await app.inject({ method: 'DELETE', url: `/api/v1/assets/${asset.id}` });
    expect(delRes.statusCode).toBe(204);
    expect((await repo.get(asset.id))?.status).toBe('archived');
  });

  it('returns 404 when locking an unknown asset', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/assets/01HZZZZZZZZZZZZZZZZZZZZZZZ/lock',
      payload: {}
    });
    expect(res.statusCode).toBe(404);
  });
});
