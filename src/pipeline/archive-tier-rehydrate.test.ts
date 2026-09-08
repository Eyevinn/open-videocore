// Unit tests for the archive-tier REHYDRATE engine (issue #558, ADR-019 D4).
//
// Pure/injected: no live MinIO, no OSC. A fake ArchiveCopyClient models an
// in-memory two-bucket object store so we can assert the copy-then-verify-then-
// delete safety contract (inverted: archive -> hot), idempotency, the D3 byte-
// class pin, the D6 firewall, and that the rehydrate lifecycle
// (archive -> in-flight -> hot) is driven correctly.

import { describe, it, expect } from 'vitest';

import { InMemoryAssetRepository } from '../data/asset-repo.js';
import {
  rehydrateAssetFromArchive,
  classesNeedingRehydrate,
  NonArchivableByteClassError,
  type RehydrateFromArchiveDeps
} from './archive-tier-rehydrate.js';
import type { ArchiveCopyClient } from './archive-tier-relocation.js';

class FakeStore implements ArchiveCopyClient {
  objects = new Map<string, { size: number; etag: string }>();
  copies: string[] = [];
  removes: string[] = [];
  // Make the NEXT copy to a given target silently not land (verify fails).
  copyDropTargets = new Set<string>();

  put(bucket: string, key: string): void {
    this.objects.set(`${bucket}/${key}`, { size: 10, etag: 'e' });
  }

  async copyObject(targetBucket: string, targetKey: string, sourceBucketAndKey: string): Promise<unknown> {
    this.copies.push(`${sourceBucketAndKey} -> ${targetBucket}/${targetKey}`);
    const target = `${targetBucket}/${targetKey}`;
    if (this.copyDropTargets.has(target)) {
      return {};
    }
    const src = sourceBucketAndKey.replace(/^\//, '');
    const bytes = this.objects.get(src);
    if (!bytes) {
      const err = new Error('NoSuchKey') as Error & { code?: string };
      err.code = 'NoSuchKey';
      throw err;
    }
    this.objects.set(target, { ...bytes });
    return {};
  }

  async statObject(bucket: string, key: string): Promise<{ size: number; etag: string }> {
    const found = this.objects.get(`${bucket}/${key}`);
    if (!found) {
      const err = new Error('NotFound') as Error & { code?: string };
      err.code = 'NotFound';
      throw err;
    }
    return found;
  }

  async removeObject(bucket: string, key: string): Promise<void> {
    this.removes.push(`${bucket}/${key}`);
    this.objects.delete(`${bucket}/${key}`);
  }
}

const SOURCE_BUCKET = 'hot-source';
const ARCHIVE = { bucket: 'cold-archive', prefix: 'archived' };

// Seed an asset whose source + both renditions are ALREADY archived (the state
// the relocation engine would have left), with the cold bytes in the archive
// bucket under the prefix and the hot bytes gone.
async function seedArchivedAsset(store: FakeStore) {
  const assets = new InMemoryAssetRepository();
  const asset = await assets.create({ name: 'clip', objectKey: 'sources/clip.mov' });
  await assets.update(asset.id, { status: 'processing' as const });
  await assets.update(asset.id, {
    status: 'ready' as const,
    renditions: [
      { id: 'r1', label: '1080p', width: 1920, height: 1080, objectKey: 'renditions/clip-1080.mp4' },
      { id: 'r2', label: '720p', width: 1280, height: 720, objectKey: 's3://foreign/clip-720.mp4' }
    ]
  });
  await assets.setStorageTier(asset.id, { source: 'archive', renditions: 'archive' });
  // Cold bytes live in the archive bucket under the prefix (hot copies gone).
  store.put(ARCHIVE.bucket, 'archived/sources/clip.mov');
  store.put(ARCHIVE.bucket, 'archived/renditions/clip-1080.mp4');
  store.put(ARCHIVE.bucket, 'archived/clip-720.mp4');
  return { assets, assetId: asset.id };
}

function deps(assets: InMemoryAssetRepository, store: FakeStore): RehydrateFromArchiveDeps {
  return { assets, client: store, sourceBucket: SOURCE_BUCKET, destination: ARCHIVE };
}

describe('rehydrateAssetFromArchive — happy path', () => {
  it('copies archive -> hot, deletes archive AFTER verify, flips tier to hot, clears in-flight', async () => {
    const store = new FakeStore();
    const { assets, assetId } = await seedArchivedAsset(store);

    const result = await rehydrateAssetFromArchive(deps(assets, store), assetId, ['source', 'renditions']);

    expect(result?.rehydrated.sort()).toEqual(['renditions', 'source']);
    expect(result?.objectsCopied).toBe(3);
    expect(result?.objectsDeleted).toBe(3);

    // Hot bytes restored to their original keys; cold copies removed.
    expect(store.objects.has(`${SOURCE_BUCKET}/sources/clip.mov`)).toBe(true);
    expect(store.objects.has('foreign/clip-720.mp4')).toBe(true);
    expect(store.objects.has(`${ARCHIVE.bucket}/archived/sources/clip.mov`)).toBe(false);

    // Tier flipped back to hot; no rehydrate left in flight.
    const after = await assets.get(assetId);
    expect(after?.storageTiering?.tiers.source).toBe('hot');
    expect(after?.storageTiering?.tiers.renditions).toBe('hot');
    expect(after?.storageTiering?.rehydrating).toEqual([]);
  });
});

describe('byte-class scope (ADR-019 D3)', () => {
  it('refuses packaged BEFORE moving any bytes or marking in-flight', async () => {
    const store = new FakeStore();
    const { assets, assetId } = await seedArchivedAsset(store);
    await expect(
      // @ts-expect-error deliberately passing a non-rehydratable class
      rehydrateAssetFromArchive(deps(assets, store), assetId, ['source', 'packaged'])
    ).rejects.toBeInstanceOf(NonArchivableByteClassError);
    expect(store.copies).toHaveLength(0);
    const after = await assets.get(assetId);
    expect(after?.storageTiering?.rehydrating).toEqual([]);
  });
});

describe('idempotency / re-runnability (issue #558)', () => {
  it('a class already hot is a no-op (no copy, no delete)', async () => {
    const store = new FakeStore();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip', objectKey: 'sources/clip.mov' });
    await assets.update(asset.id, { status: 'processing' as const });
    await assets.update(asset.id, { status: 'ready' as const });
    // source is hot (default); ask to rehydrate it anyway.
    const result = await rehydrateAssetFromArchive(deps(assets, store), asset.id, ['source']);
    expect(result?.rehydrated).toEqual(['source']);
    expect(store.copies).toHaveLength(0);
    expect(store.removes).toHaveLength(0);
  });

  it('heals a crash BETWEEN copy and delete: hot present + archive present -> verify, delete', async () => {
    const store = new FakeStore();
    const { assets, assetId } = await seedArchivedAsset(store);
    // Simulate crash aftermath for `source`: the hot copy landed but the archive
    // copy was NOT deleted and the tier was NOT flipped.
    store.put(SOURCE_BUCKET, 'sources/clip.mov');

    const result = await rehydrateAssetFromArchive(deps(assets, store), assetId, ['source']);

    expect(result?.rehydrated).toEqual(['source']);
    // Archive copy now cleaned up; tier hot.
    expect(store.objects.has(`${ARCHIVE.bucket}/archived/sources/clip.mov`)).toBe(false);
    const after = await assets.get(assetId);
    expect(after?.storageTiering?.tiers.source).toBe('hot');
  });
});

describe('failure safety — archive bytes recoverable, stays in-flight (issue #558)', () => {
  it('a copy that does not land retains the archive copy and leaves the class archived + in-flight', async () => {
    const store = new FakeStore();
    const { assets, assetId } = await seedArchivedAsset(store);
    store.copyDropTargets.add(`${SOURCE_BUCKET}/sources/clip.mov`);

    const result = await rehydrateAssetFromArchive(deps(assets, store), assetId, ['source']);

    expect(result?.rehydrated).toEqual([]);
    expect(result?.objectsDeleted).toBe(0);
    // Archive byte retained; class NOT flipped to hot.
    expect(store.objects.has(`${ARCHIVE.bucket}/archived/sources/clip.mov`)).toBe(true);
    expect(store.removes).toHaveLength(0);
    const after = await assets.get(assetId);
    expect(after?.storageTiering?.tiers.source).toBe('archive');
    // In-flight marker LEFT set so the incomplete restore is observable / resumable.
    expect(after?.storageTiering?.rehydrating.map((r) => r.byteClass)).toContain('source');
  });
});

describe('D6 firewall — status untouched, and gating helper', () => {
  it('never changes status/statusHistory', async () => {
    const store = new FakeStore();
    const { assets, assetId } = await seedArchivedAsset(store);
    const before = await assets.get(assetId);

    await rehydrateAssetFromArchive(deps(assets, store), assetId, ['source']);

    const after = await assets.get(assetId);
    expect(after?.status).toBe('ready');
    expect(after?.status).toBe(before?.status);
    expect(after?.statusHistory).toEqual(before?.statusHistory);
  });

  it('classesNeedingRehydrate reports only archived classes a caller needs hot', async () => {
    const store = new FakeStore();
    const { assets, assetId } = await seedArchivedAsset(store);
    const asset = await assets.get(assetId);
    expect(classesNeedingRehydrate(asset!, ['source', 'renditions']).sort()).toEqual([
      'renditions',
      'source'
    ]);
    // After restore, nothing is needed.
    await rehydrateAssetFromArchive(deps(assets, store), assetId, ['source', 'renditions']);
    const restored = await assets.get(assetId);
    expect(classesNeedingRehydrate(restored!, ['source', 'renditions'])).toEqual([]);
  });
});
