// Repository-level per-namespace external-id uniqueness (issue #577), exercised
// against the in-memory backend, which is the canonical authority for that
// backend (asset-repo.ts:1379-1381).
//
// Contract under test (src/data/asset-repo.ts):
//   - InMemoryAssetRepository.attachExternalId(id, input) (asset-repo.ts:1382-1416):
//       * unknown or tombstoned id -> resolves to undefined (asset-repo.ts:1386-1389);
//       * idempotent no-op when the asset already carries the exact
//         `{ namespace, id }` pair, regardless of enforceUniqueness
//         (asset-repo.ts:1390-1396);
//       * when input.enforceUniqueness is true and the pair already resolves to a
//         DIFFERENT asset -> throws ExternalIdConflictError(namespace, id, ownerId)
//         (asset-repo.ts:1399-1403);
//       * advisory (enforceUniqueness falsey) allows the duplicate.
//   - AttachExternalIdInput = { namespace, id, enforceUniqueness? }
//     (asset-repo.ts:683-690).
//   - ExternalIdConflictError exposes `namespace`, `externalId`,
//     `conflictingAssetId` and statusCode 409 (asset-repo.ts:772-787).
//   - getByExternalId(namespace, id) returns the first carrying asset or undefined
//     (asset-repo.ts:1370-1377).

import { describe, it, expect } from 'vitest';

import {
  InMemoryAssetRepository,
  ExternalIdConflictError,
  type Asset
} from './asset-repo.js';

async function seed(): Promise<{
  repo: InMemoryAssetRepository;
  a: Asset;
  b: Asset;
}> {
  const repo = new InMemoryAssetRepository();
  const a = await repo.create({ name: 'asset-a' });
  const b = await repo.create({ name: 'asset-b' });
  return { repo, a, b };
}

describe('InMemoryAssetRepository.attachExternalId — advisory mode (issue #577)', () => {
  it('allows the same {namespace,id} on a DIFFERENT asset (duplicate permitted)', async () => {
    const { repo, a, b } = await seed();
    await repo.attachExternalId(a.id, { namespace: 'ingest-mam', id: 'X-1' });

    // Advisory default: enforceUniqueness omitted -> the duplicate is allowed.
    const updated = await repo.attachExternalId(b.id, { namespace: 'ingest-mam', id: 'X-1' });
    expect(updated).toBeDefined();
    expect(updated?.externalIdentifiers).toContainEqual({ namespace: 'ingest-mam', id: 'X-1' });

    // Both assets now carry the same pair.
    expect((await repo.get(a.id))?.externalIdentifiers).toContainEqual({
      namespace: 'ingest-mam',
      id: 'X-1'
    });
  });

  it('allows the duplicate even when enforceUniqueness is explicitly false', async () => {
    const { repo, a, b } = await seed();
    await repo.attachExternalId(a.id, { namespace: 'ns', id: 'dup', enforceUniqueness: false });
    await expect(
      repo.attachExternalId(b.id, { namespace: 'ns', id: 'dup', enforceUniqueness: false })
    ).resolves.toBeDefined();
  });
});

describe('InMemoryAssetRepository.attachExternalId — enforced mode (issue #577)', () => {
  it('throws ExternalIdConflictError naming conflictingAssetId for a same-pair on a different asset', async () => {
    const { repo, a, b } = await seed();
    await repo.attachExternalId(a.id, {
      namespace: 'ingest-mam',
      id: 'X-1',
      enforceUniqueness: true
    });

    let caught: unknown;
    try {
      await repo.attachExternalId(b.id, {
        namespace: 'ingest-mam',
        id: 'X-1',
        enforceUniqueness: true
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ExternalIdConflictError);

    // Assert the error carries the real field names (asset-repo.ts:774-786).
    const err = caught as ExternalIdConflictError;
    expect(err.conflictingAssetId).toBe(a.id);
    expect(err.namespace).toBe('ingest-mam');
    expect(err.externalId).toBe('X-1');
    expect(err.statusCode).toBe(409);

    // The write was rejected: asset b never gained the pair.
    expect((await repo.get(b.id))?.externalIdentifiers ?? []).not.toContainEqual({
      namespace: 'ingest-mam',
      id: 'X-1'
    });
  });

  it('is an idempotent no-op when the SAME asset re-attaches its own pair (no throw)', async () => {
    const { repo, a } = await seed();
    await repo.attachExternalId(a.id, { namespace: 'ns', id: 'same', enforceUniqueness: true });

    const again = await repo.attachExternalId(a.id, {
      namespace: 'ns',
      id: 'same',
      enforceUniqueness: true
    });
    expect(again).toBeDefined();
    // Not duplicated in the set — still exactly one entry for the pair.
    const matches = (again?.externalIdentifiers ?? []).filter(
      (e) => e.namespace === 'ns' && e.id === 'same'
    );
    expect(matches).toHaveLength(1);
  });

  it('does NOT conflict across namespaces sharing the same id', async () => {
    const { repo, a, b } = await seed();
    await repo.attachExternalId(a.id, {
      namespace: 'rights-registry',
      id: 'SHARED',
      enforceUniqueness: true
    });

    // Same `id`, DIFFERENT namespace -> not a conflict (uniqueness is per-namespace).
    const updated = await repo.attachExternalId(b.id, {
      namespace: 'ingest-mam',
      id: 'SHARED',
      enforceUniqueness: true
    });
    expect(updated?.externalIdentifiers).toContainEqual({
      namespace: 'ingest-mam',
      id: 'SHARED'
    });
  });
});

describe('InMemoryAssetRepository.attachExternalId — unknown / tombstoned ids (issue #577)', () => {
  it('returns undefined for an unknown asset id', async () => {
    const repo = new InMemoryAssetRepository();
    await expect(
      repo.attachExternalId('does-not-exist', { namespace: 'ns', id: 'x' })
    ).resolves.toBeUndefined();
  });

  it('returns undefined for a tombstoned asset id', async () => {
    const repo = new InMemoryAssetRepository();
    const a = await repo.create({ name: 'to-purge' });
    // Purge to a tombstone under the same id (asset-repo.ts:1342-1348).
    expect(repo.purgeToTombstone(a.id)).toBe(true);

    await expect(
      repo.attachExternalId(a.id, { namespace: 'ns', id: 'x', enforceUniqueness: true })
    ).resolves.toBeUndefined();
  });
});
