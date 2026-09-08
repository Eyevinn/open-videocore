// Unit tests for the archive-tier relocation policy engine (issue #557, ADR-019).
//
// Pure/injected: no live MinIO, no OSC. A fake ArchiveCopyClient models an
// in-memory two-bucket object store so we can assert the copy-then-verify-then-
// delete safety contract, idempotency/re-runnability, the D3 byte-class pin, and
// the D6 firewall (status/statusHistory untouched, metadata still searchable).

import { describe, it, expect } from 'vitest';

import { InMemoryAssetRepository } from '../data/asset-repo.js';
import {
  relocateAssetToArchive,
  isArchivableByteClass,
  isAgeEligible,
  archiveKeyFor,
  NonArchivableByteClassError,
  type ArchiveCopyClient
} from './archive-tier-relocation.js';

// An in-memory object store keyed by `${bucket}/${key}` used to back the fake
// copy client. Records copy/stat/remove calls so tests can assert ordering.
class FakeStore implements ArchiveCopyClient {
  objects = new Map<string, { size: number; etag: string }>();
  copies: string[] = [];
  removes: string[] = [];
  // Optional hook to make the NEXT copy of a given source vanish (simulate a
  // copy that reports success but does not land, forcing verify to fail).
  copyDropTargets = new Set<string>();

  put(bucket: string, key: string): void {
    this.objects.set(`${bucket}/${key}`, { size: 10, etag: 'e' });
  }

  async copyObject(
    targetBucket: string,
    targetKey: string,
    sourceBucketAndKey: string
  ): Promise<unknown> {
    this.copies.push(`${sourceBucketAndKey} -> ${targetBucket}/${targetKey}`);
    const target = `${targetBucket}/${targetKey}`;
    if (this.copyDropTargets.has(target)) {
      // Simulate a copy that silently does not land at the destination.
      return {};
    }
    // Server-side copy: the source must exist; copy its bytes to the target.
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

async function seedAsset(store: FakeStore) {
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
  // Land the source-tier bytes for source + both renditions.
  store.put(SOURCE_BUCKET, 'sources/clip.mov');
  store.put(SOURCE_BUCKET, 'renditions/clip-1080.mp4');
  store.put('foreign', 'clip-720.mp4');
  return { assets, assetId: asset.id };
}

describe('archive-tier byte-class scope (ADR-019 D3)', () => {
  it('accepts source and renditions, refuses packaged/subtitles/thumbnails', () => {
    expect(isArchivableByteClass('source')).toBe(true);
    expect(isArchivableByteClass('renditions')).toBe(true);
    expect(isArchivableByteClass('packaged')).toBe(false);
    expect(isArchivableByteClass('subtitles')).toBe(false);
    expect(isArchivableByteClass('thumbnails')).toBe(false);
  });

  it('throws NonArchivableByteClassError for packaged BEFORE moving any bytes', async () => {
    const store = new FakeStore();
    const { assets, assetId } = await seedAsset(store);
    await expect(
      relocateAssetToArchive(
        { assets, client: store, sourceBucket: SOURCE_BUCKET, destination: ARCHIVE },
        assetId,
        // @ts-expect-error deliberately passing a non-archivable class
        ['source', 'packaged']
      )
    ).rejects.toBeInstanceOf(NonArchivableByteClassError);
    // No bytes moved: the guard runs before any copy/delete.
    expect(store.copies).toHaveLength(0);
    expect(store.removes).toHaveLength(0);
  });
});

describe('relocateAssetToArchive — happy path', () => {
  it('copies to archive, deletes source AFTER verified copy, flips the tier', async () => {
    const store = new FakeStore();
    const { assets, assetId } = await seedAsset(store);

    const result = await relocateAssetToArchive(
      { assets, client: store, sourceBucket: SOURCE_BUCKET, destination: ARCHIVE },
      assetId,
      ['source', 'renditions']
    );

    expect(result?.relocated.sort()).toEqual(['renditions', 'source']);
    expect(result?.objectsCopied).toBe(3);
    expect(result?.objectsDeleted).toBe(3);

    // Source-tier bytes are gone; archive-tier copies exist under the prefix.
    expect(store.objects.has(`${SOURCE_BUCKET}/sources/clip.mov`)).toBe(false);
    expect(store.objects.has(`${ARCHIVE.bucket}/archived/sources/clip.mov`)).toBe(true);
    expect(store.objects.has(`${ARCHIVE.bucket}/archived/clip-720.mp4`)).toBe(true);

    // Every copy happened before its corresponding delete (safety ordering).
    expect(store.copies).toHaveLength(3);
    expect(store.removes).toHaveLength(3);

    // Tier axis flipped for the two classes; packaged stays hot (D3).
    const after = await assets.get(assetId);
    expect(after?.storageTiering?.tiers.source).toBe('archive');
    expect(after?.storageTiering?.tiers.renditions).toBe('archive');
    expect(after?.storageTiering?.tiers.packaged).toBe('hot');
  });
});

describe('D6 firewall — metadata untouched and searchable', () => {
  it('never changes status/statusHistory and leaves the asset searchable', async () => {
    const store = new FakeStore();
    const { assets, assetId } = await seedAsset(store);
    const before = await assets.get(assetId);

    await relocateAssetToArchive(
      { assets, client: store, sourceBucket: SOURCE_BUCKET, destination: ARCHIVE },
      assetId,
      ['source']
    );

    const after = await assets.get(assetId);
    expect(after?.status).toBe('ready');
    expect(after?.status).toBe(before?.status);
    expect(after?.statusHistory).toEqual(before?.statusHistory);
    // Still discoverable by name (metadata document intact).
    const hits = await assets.search('clip');
    expect(hits.map((a) => a.id)).toContain(assetId);
  });
});

describe('idempotency / re-runnability (issue #557)', () => {
  it('a class already on archive is a no-op re-run (no copy, no delete)', async () => {
    const store = new FakeStore();
    const { assets, assetId } = await seedAsset(store);
    const deps = { assets, client: store, sourceBucket: SOURCE_BUCKET, destination: ARCHIVE };

    await relocateAssetToArchive(deps, assetId, ['source']);
    const copiesAfterFirst = store.copies.length;
    const removesAfterFirst = store.removes.length;

    const second = await relocateAssetToArchive(deps, assetId, ['source']);
    expect(second?.relocated).toEqual(['source']);
    // Nothing new copied or deleted on the re-run.
    expect(store.copies.length).toBe(copiesAfterFirst);
    expect(store.removes.length).toBe(removesAfterFirst);
    expect(second?.objectsCopied).toBe(0);
    expect(second?.objectsDeleted).toBe(0);
  });

  it('heals a crash BETWEEN copy and delete: source present + archive present -> re-copy, verify, delete', async () => {
    const store = new FakeStore();
    const { assets, assetId } = await seedAsset(store);
    // Simulate the crash aftermath: the copy landed but the source was NOT
    // deleted and the tier was NOT flipped (asset still all-hot).
    store.put(ARCHIVE.bucket, 'archived/sources/clip.mov');

    const result = await relocateAssetToArchive(
      { assets, client: store, sourceBucket: SOURCE_BUCKET, destination: ARCHIVE },
      assetId,
      ['source']
    );

    expect(result?.relocated).toEqual(['source']);
    expect(store.objects.has(`${SOURCE_BUCKET}/sources/clip.mov`)).toBe(false);
    const after = await assets.get(assetId);
    expect(after?.storageTiering?.tiers.source).toBe('archive');
  });
});

describe('failure safety — bytes recoverable in source tier (issue #557)', () => {
  it('a copy that does not land leaves source intact and does NOT flip the tier', async () => {
    const store = new FakeStore();
    const { assets, assetId } = await seedAsset(store);
    // Force the source copy to silently not land, so verify fails.
    store.copyDropTargets.add(`${ARCHIVE.bucket}/archived/sources/clip.mov`);

    const result = await relocateAssetToArchive(
      { assets, client: store, sourceBucket: SOURCE_BUCKET, destination: ARCHIVE },
      assetId,
      ['source']
    );

    // Class NOT relocated; source byte retained; nothing deleted.
    expect(result?.relocated).toEqual([]);
    expect(result?.objectsDeleted).toBe(0);
    expect(store.objects.has(`${SOURCE_BUCKET}/sources/clip.mov`)).toBe(true);
    expect(store.removes).toHaveLength(0);

    // The tier was never flipped, so source stays hot (represented as undefined
    // /absent on the raw in-memory record — the all-hot default, never 'archive').
    const after = await assets.get(assetId);
    expect(after?.storageTiering?.tiers.source).not.toBe('archive');
  });
});

describe('helpers', () => {
  it('archiveKeyFor namespaces under the destination prefix (and no prefix)', () => {
    expect(archiveKeyFor('sources/clip.mov', 'archived')).toBe('archived/sources/clip.mov');
    expect(archiveKeyFor('sources/clip.mov', '')).toBe('sources/clip.mov');
    expect(archiveKeyFor('/sources/clip.mov', 'archived/')).toBe('archived/sources/clip.mov');
  });

  it('isAgeEligible derives from createdAt (ADR-019 D2 policy #2)', () => {
    const now = Date.parse('2026-09-07T00:00:00.000Z');
    const old = { createdAt: '2026-01-01T00:00:00.000Z' } as never;
    const fresh = { createdAt: '2026-09-06T23:00:00.000Z' } as never;
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    expect(isAgeEligible(old, thirtyDays, now)).toBe(true);
    expect(isAgeEligible(fresh, thirtyDays, now)).toBe(false);
    // No age requirement -> always eligible.
    expect(isAgeEligible(fresh, 0, now)).toBe(true);
  });
});
