// Unit tests for the dedicated storage-tier write path (ADR-019 D1/D3/D6,
// issue #557): InMemoryAssetRepository.setStorageTier + the pure applyStorageTier
// helper. Asserts the byte-location axis is merged per byte class, in-flight
// rehydrate state is preserved, and the lifecycle status/statusHistory are NEVER
// touched (the D6 tier/status firewall).

import { describe, it, expect } from 'vitest';

import {
  InMemoryAssetRepository,
  applyStorageTier,
  defaultStorageTiering
} from './asset-repo.js';

describe('applyStorageTier (pure)', () => {
  it('merges overrides onto the all-hot default, leaving other classes hot', () => {
    const next = applyStorageTier(undefined, { source: 'archive' });
    expect(next.tiers.source).toBe('archive');
    expect(next.tiers.packaged).toBe('hot');
    expect(next.rehydrating).toEqual([]);
  });

  it('preserves existing rehydrate state and non-overridden classes', () => {
    const existing = {
      ...defaultStorageTiering(),
      tiers: { source: 'archive' as const, packaged: 'hot' as const },
      rehydrating: [{ byteClass: 'source' as const, startedAt: '2026-09-01T00:00:00.000Z' }]
    };
    const next = applyStorageTier(existing, { renditions: 'archive' });
    expect(next.tiers.source).toBe('archive');
    expect(next.tiers.renditions).toBe('archive');
    expect(next.rehydrating).toHaveLength(1);
  });
});

describe('InMemoryAssetRepository.setStorageTier', () => {
  it('persists the tier flip without touching status or statusHistory', async () => {
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip', objectKey: 'k' });
    await assets.update(asset.id, { status: 'processing' });
    await assets.update(asset.id, { status: 'ready' });
    const before = await assets.get(asset.id);

    const updated = await assets.setStorageTier(asset.id, { source: 'archive' });

    expect(updated?.storageTiering?.tiers.source).toBe('archive');
    expect(updated?.status).toBe('ready');
    expect(updated?.status).toBe(before?.status);
    expect(updated?.statusHistory).toEqual(before?.statusHistory);
  });

  it('returns undefined for an unknown id', async () => {
    const assets = new InMemoryAssetRepository();
    expect(await assets.setStorageTier('NOPE', { source: 'archive' })).toBeUndefined();
  });
});
