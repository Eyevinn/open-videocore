// Integration test for the total storage cap on WATCH-FOLDER ingest (issue #579,
// ADR-020). Watch-folder bytes are dropped DIRECTLY into the bucket by an
// operator/other system, bypassing the API — there is nothing to reject at
// admission. So for this path the cap is maintained by ACCOUNTING: an ingested
// direct-drop object's statObject size is recorded as a committed delta on the
// running total, reducing headroom for subsequent API ingests. No cap / no guard
// => no accounting, behaviour unchanged.

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { WatchFolderService } from './watch-folder.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryStorageQuotaStore, StorageQuotaGuard } from '../data/storage-quota.js';

// A minimal fake MinIO client: listObjectsV2 streams the configured keys;
// statObject returns the configured per-key size. listenBucketNotification is
// absent so the service uses the polling path only.
function fakeClient(objects: { name: string; size: number }[]) {
  return {
    listObjectsV2() {
      const em = new EventEmitter();
      setImmediate(() => {
        for (const o of objects) em.emit('data', { name: o.name, size: o.size });
        em.emit('end');
      });
      return em as unknown as ReturnType<
        import('minio').Client['listObjectsV2']
      >;
    },
    async statObject(_bucket: string, key: string) {
      const o = objects.find((x) => x.name === key);
      return { size: o?.size ?? 0, etag: 'e' } as never;
    }
  } as unknown as import('minio').Client;
}

const silentLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('watch-folder ingest — storage cap accounting (issue #579)', () => {
  it('records the direct-drop object size as a committed delta on the running total', async () => {
    const store = new InMemoryStorageQuotaStore();
    const guard = new StorageQuotaGuard({ store, capBytes: () => 1000 });
    const repo = new InMemoryAssetRepository();
    const svc = new WatchFolderService({
      client: fakeClient([{ name: 'drop/clip.mp4', size: 250 }]),
      bucket: 'src',
      repository: repo,
      log: silentLog,
      quota: guard,
      // Disable the periodic timer; we drive poll() directly.
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => undefined
    });

    await svc.ingestKey('drop/clip.mp4');

    expect((await store.read()).consumedBytes).toBe(250);
    expect(svc.processedCount()).toBe(1);
  });

  it('no guard wired => no accounting, ingest still creates the asset (unchanged)', async () => {
    const repo = new InMemoryAssetRepository();
    const svc = new WatchFolderService({
      client: fakeClient([{ name: 'drop/clip.mp4', size: 250 }]),
      bucket: 'src',
      repository: repo,
      log: silentLog,
      setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
      clearIntervalFn: () => undefined
    });

    await svc.ingestKey('drop/clip.mp4');
    expect(svc.processedCount()).toBe(1);
    const list = await repo.list();
    expect(list.items.length).toBe(1);
  });
});
