// Unit tests for the rehydrate-state write path (ADR-019 D4, issue #558):
// InMemoryAssetRepository.setRehydrateState + the pure beginRehydrate /
// completeRehydrate helpers. Asserts the restore lifecycle
// (archive -> in-flight -> hot) is driven on the `storageTiering` axis ONLY and
// that lifecycle status/statusHistory are NEVER touched (the D6 firewall).

import { describe, it, expect } from 'vitest';

import {
  InMemoryAssetRepository,
  beginRehydrate,
  completeRehydrate,
  defaultStorageTiering,
  type StorageTiering
} from './asset-repo.js';

const archivedSource: StorageTiering = {
  tiers: { source: 'archive', renditions: 'archive', packaged: 'hot' },
  rehydrating: []
};

describe('beginRehydrate (pure)', () => {
  it('marks a class in-flight without changing its tier', () => {
    const next = beginRehydrate(archivedSource, 'source', '2026-09-08T00:00:00.000Z');
    expect(next.tiers.source).toBe('archive'); // bytes still cold until copy done
    expect(next.rehydrating).toEqual([{ byteClass: 'source', startedAt: '2026-09-08T00:00:00.000Z' }]);
  });

  it('is idempotent: re-marking keeps the original startedAt', () => {
    const first = beginRehydrate(archivedSource, 'source', '2026-09-08T00:00:00.000Z');
    const second = beginRehydrate(first, 'source', '2026-09-08T09:00:00.000Z');
    expect(second.rehydrating).toHaveLength(1);
    expect(second.rehydrating[0]?.startedAt).toBe('2026-09-08T00:00:00.000Z');
  });

  it('defaults an absent tiering to all-hot before marking', () => {
    const next = beginRehydrate(undefined, 'source', '2026-09-08T00:00:00.000Z');
    expect(next.tiers.source).toBe('hot');
    expect(next.rehydrating).toHaveLength(1);
  });
});

describe('completeRehydrate (pure)', () => {
  it('flips the class to hot AND clears its in-flight marker atomically', () => {
    const inflight = beginRehydrate(archivedSource, 'source', '2026-09-08T00:00:00.000Z');
    const done = completeRehydrate(inflight, 'source');
    expect(done.tiers.source).toBe('hot');
    expect(done.rehydrating.some((r) => r.byteClass === 'source')).toBe(false);
    // Other archived classes are untouched.
    expect(done.tiers.renditions).toBe('archive');
  });

  it('is idempotent for a class that was never in flight', () => {
    const done = completeRehydrate(defaultStorageTiering(), 'source');
    expect(done.tiers.source).toBe('hot');
    expect(done.rehydrating).toEqual([]);
  });
});

describe('InMemoryAssetRepository.setRehydrateState', () => {
  it('drives archive -> in-flight -> hot without touching status/statusHistory', async () => {
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip', objectKey: 'k' });
    await assets.update(asset.id, { status: 'processing' });
    await assets.update(asset.id, { status: 'ready' });
    await assets.setStorageTier(asset.id, { source: 'archive' });
    const before = await assets.get(asset.id);

    const begun = await assets.setRehydrateState(asset.id, 'source', 'begin');
    expect(begun?.storageTiering?.tiers.source).toBe('archive');
    expect(begun?.storageTiering?.rehydrating.map((r) => r.byteClass)).toContain('source');
    expect(begun?.status).toBe('ready');

    const done = await assets.setRehydrateState(asset.id, 'source', 'complete');
    expect(done?.storageTiering?.tiers.source).toBe('hot');
    expect(done?.storageTiering?.rehydrating).toEqual([]);

    // D6 firewall: lifecycle status + history never moved.
    expect(done?.status).toBe('ready');
    expect(done?.status).toBe(before?.status);
    expect(done?.statusHistory).toEqual(before?.statusHistory);
  });

  it('returns undefined for an unknown id', async () => {
    const assets = new InMemoryAssetRepository();
    expect(await assets.setRehydrateState('NOPE', 'source', 'begin')).toBeUndefined();
  });
});
