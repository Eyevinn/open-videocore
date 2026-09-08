// Tests for backfillStrandedObjectKeys (issue #614).
//
// The function is tested against a FAKE lister (implementing the verified
// `AssetLister.list(opts?) => Promise<ListResult>` subset of AssetRepository,
// src/data/asset-repo.ts line 709), a FAKE probe (the verified
// `WorkspaceStorage.statObject` shape, src/data/storage.ts line 92), and a FAKE
// updater (the verified `AssetRepository.update` subset, line 711). We assert:
//   - backfill of a stranded asset with a present source object,
//   - skip of an asset with no underlying object (no key fabricated),
//   - idempotent re-run is a no-op for already-fixed assets.

import { describe, expect, it, vi } from 'vitest';
import {
  backfillStrandedObjectKeys,
  type AssetKeyUpdater,
  type AssetLister,
  type BackfillLogger,
  type SourceObjectProbe
} from './objectkey-backfill.js';
import { sourceObjectKey } from '../routes/asset-upload.js';
import type { Asset, ListOptions, ListResult } from './asset-repo.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

// Minimal Asset builder — only `id` and `objectKey` are load-bearing for the
// backfill; the rest satisfy the `Asset` type.
function makeAsset(id: string, objectKey?: string): Asset {
  const now = '2026-09-07T00:00:00.000Z';
  return {
    id,
    name: `asset-${id}`,
    status: 'processing',
    objectKey,
    statusHistory: [{ at: now, from: null, to: 'uploading' }],
    createdAt: now,
    updatedAt: now
  };
}

// A fake lister backed by a fixed asset array, honouring limit/offset paging
// exactly like InMemoryAssetRepository.list (src/data/asset-repo.ts line 1157).
function makeLister(assets: Asset[]): AssetLister {
  return {
    async list(opts: ListOptions = {}): Promise<ListResult> {
      const limit = opts.limit ?? 50;
      const offset = opts.offset ?? 0;
      const items = assets.slice(offset, offset + limit);
      return { items, limit, offset, total: assets.length };
    }
  };
}

// A fake source-bucket probe: `present` is the set of object keys that exist.
function makeProbe(present: Set<string>): SourceObjectProbe {
  return {
    async statObject(localKey: string) {
      if (present.has(localKey)) {
        return { size: 1234, etag: 'etag-' + localKey };
      }
      return undefined;
    }
  };
}

// A fake updater that mutates an id->Asset map, mirroring InMemory.update's
// objectKey write (src/data/asset-repo.ts line 1198). Records every call.
function makeUpdater(store: Map<string, Asset>): AssetKeyUpdater & { calls: Array<{ id: string; objectKey: string }> } {
  const calls: Array<{ id: string; objectKey: string }> = [];
  return {
    calls,
    async update(id: string, patch: { objectKey: string }): Promise<Asset | undefined> {
      calls.push({ id, objectKey: patch.objectKey });
      const existing = store.get(id);
      if (!existing) {
        return undefined;
      }
      const next = { ...existing, objectKey: patch.objectKey };
      store.set(id, next);
      return next;
    }
  };
}

function silentLogger(): BackfillLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('backfillStrandedObjectKeys (issue #614)', () => {
  it('backfills a stranded asset whose source object is present', async () => {
    const stranded = makeAsset('AAAAAAAAAAAAAAAAAAAAAAAAAA'); // no objectKey
    const store = new Map<string, Asset>([[stranded.id, stranded]]);
    const key = sourceObjectKey(stranded.id);
    const updater = makeUpdater(store);

    const summary = await backfillStrandedObjectKeys({
      lister: makeLister([...store.values()]),
      updater,
      probe: makeProbe(new Set([key])),
      logger: silentLogger()
    });

    expect(summary.scanned).toBe(1);
    expect(summary.repaired).toBe(1);
    expect(summary.skipped).toEqual([]);
    expect(summary.failed).toEqual([]);
    // The key was derived deterministically and written verbatim.
    expect(updater.calls).toEqual([{ id: stranded.id, objectKey: key }]);
    expect(store.get(stranded.id)?.objectKey).toBe(key);
  });

  it('skips a stranded asset with no underlying object and never fabricates a key', async () => {
    const stranded = makeAsset('BBBBBBBBBBBBBBBBBBBBBBBBBB'); // no objectKey
    const store = new Map<string, Asset>([[stranded.id, stranded]]);
    const updater = makeUpdater(store);

    const summary = await backfillStrandedObjectKeys({
      lister: makeLister([...store.values()]),
      updater,
      probe: makeProbe(new Set()), // no object present anywhere
      logger: silentLogger()
    });

    expect(summary.scanned).toBe(1);
    expect(summary.repaired).toBe(0);
    expect(summary.skipped).toEqual([{ assetId: stranded.id, reason: 'no-object' }]);
    expect(summary.failed).toEqual([]);
    // No key fabricated: the updater was never called and the asset stays empty.
    expect(updater.calls).toEqual([]);
    expect(store.get(stranded.id)?.objectKey).toBeUndefined();
  });

  it('is a no-op re-run for already-fixed assets (idempotent)', async () => {
    const key = sourceObjectKey('CCCCCCCCCCCCCCCCCCCCCCCCCC');
    const healthy = makeAsset('CCCCCCCCCCCCCCCCCCCCCCCCCC', key); // already has objectKey
    const store = new Map<string, Asset>([[healthy.id, healthy]]);
    const updater = makeUpdater(store);

    const summary = await backfillStrandedObjectKeys({
      lister: makeLister([...store.values()]),
      updater,
      // Object exists too, but the asset already carries the key, so it must be
      // left untouched regardless.
      probe: makeProbe(new Set([key])),
      logger: silentLogger()
    });

    expect(summary.scanned).toBe(1);
    expect(summary.repaired).toBe(0);
    expect(summary.skipped).toEqual([{ assetId: healthy.id, reason: 'already-set' }]);
    expect(summary.failed).toEqual([]);
    expect(updater.calls).toEqual([]);
  });

  it('running the full remediation twice makes the second run a pure no-op', async () => {
    const stranded = makeAsset('DDDDDDDDDDDDDDDDDDDDDDDDDD');
    const store = new Map<string, Asset>([[stranded.id, stranded]]);
    const key = sourceObjectKey(stranded.id);
    const probe = makeProbe(new Set([key]));

    // First run repairs it.
    const updater1 = makeUpdater(store);
    const first = await backfillStrandedObjectKeys({
      lister: makeLister([...store.values()]),
      updater: updater1,
      probe,
      logger: silentLogger()
    });
    expect(first.repaired).toBe(1);
    expect(store.get(stranded.id)?.objectKey).toBe(key);

    // Second run over the now-fixed store: nothing to repair, no writes.
    const updater2 = makeUpdater(store);
    const second = await backfillStrandedObjectKeys({
      lister: makeLister([...store.values()]),
      updater: updater2,
      probe,
      logger: silentLogger()
    });
    expect(second.repaired).toBe(0);
    expect(second.skipped).toEqual([{ assetId: stranded.id, reason: 'already-set' }]);
    expect(updater2.calls).toEqual([]);
  });

  it('mixed batch: repairs present-object strays, skips missing-object and healthy assets', async () => {
    const strandedPresent = makeAsset('E0000000000000000000000000');
    const strandedMissing = makeAsset('E1111111111111111111111111');
    const healthyKey = sourceObjectKey('E2222222222222222222222222');
    const healthy = makeAsset('E2222222222222222222222222', healthyKey);
    const store = new Map<string, Asset>([
      [strandedPresent.id, strandedPresent],
      [strandedMissing.id, strandedMissing],
      [healthy.id, healthy]
    ]);
    const presentKey = sourceObjectKey(strandedPresent.id);
    const updater = makeUpdater(store);

    const summary = await backfillStrandedObjectKeys({
      lister: makeLister([...store.values()]),
      updater,
      probe: makeProbe(new Set([presentKey, healthyKey])),
      logger: silentLogger(),
      pageSize: 2 // force multi-page enumeration
    });

    expect(summary.scanned).toBe(3);
    expect(summary.repaired).toBe(1);
    expect(summary.failed).toEqual([]);
    expect(summary.skipped).toContainEqual({ assetId: strandedMissing.id, reason: 'no-object' });
    expect(summary.skipped).toContainEqual({ assetId: healthy.id, reason: 'already-set' });
    expect(updater.calls).toEqual([{ id: strandedPresent.id, objectKey: presentKey }]);
  });

  it('dry run reports repairs without writing any objectKey', async () => {
    const stranded = makeAsset('F0000000000000000000000000');
    const store = new Map<string, Asset>([[stranded.id, stranded]]);
    const key = sourceObjectKey(stranded.id);
    const updater = makeUpdater(store);

    const summary = await backfillStrandedObjectKeys({
      lister: makeLister([...store.values()]),
      updater,
      probe: makeProbe(new Set([key])),
      logger: silentLogger(),
      dryRun: true
    });

    expect(summary.dryRun).toBe(true);
    expect(summary.repaired).toBe(1);
    expect(updater.calls).toEqual([]); // nothing written
    expect(store.get(stranded.id)?.objectKey).toBeUndefined();
  });
});
