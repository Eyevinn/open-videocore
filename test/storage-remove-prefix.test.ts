// WorkspaceStorage.removeObjectsUnderPrefix tests (issue #325).
//
// Exercises the bulk prefix-delete primitive against a fake MinIO client that
// mimics the real listObjectsV2 stream contract: it emits one 'data' event per
// object across every internal continuation page, then 'end'. This lets us prove
// the method drains ALL pages (no truncation) and deletes every matched object,
// and that an empty prefix is a no-op — without a live MinIO.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - listObjectsV2(bucket, prefix, recursive): BucketStream<BucketItem> emitting
//     { name } objects — minio client.d.ts:388; existing drain pattern
//     src/data/storage.ts:210-223 (WorkspaceStorage.list).
//   - removeObjects(bucket, ObjectName[]): Promise<RemoveObjectsResponse[]>,
//     RemoveObjectsResponse = null | undefined | { Error?: {...} } — minio
//     client.d.ts:349, type.d.ts:333-345.

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { Client as MinioClient } from 'minio';
import { WorkspaceStorage } from '../src/data/storage.js';

// Build a fake listObjectsV2 stream that emits the given keys as { name } objects
// (one 'data' per key, as the real client does across continuation pages) then
// 'end'. Emits asynchronously so listeners are attached before events fire.
function fakeListStream(keys: string[]): EventEmitter {
  const stream = new EventEmitter();
  queueMicrotask(() => {
    for (const name of keys) {
      stream.emit('data', { name });
    }
    stream.emit('end');
  });
  return stream;
}

describe('WorkspaceStorage.removeObjectsUnderPrefix (#325)', () => {
  it('deletes every object under a prefix across >1 page of listObjectsV2 results', async () => {
    // Simulate two pages worth of objects — the real client flattens pages into
    // successive 'data' events, so a single stream carrying all keys models the
    // "page through all results, no truncation" contract.
    const pageOne = Array.from({ length: 1000 }, (_, i) => `archive/ws-a/obj-${i}`);
    const pageTwo = Array.from({ length: 250 }, (_, i) => `archive/ws-a/obj-${1000 + i}`);
    const allKeys = [...pageOne, ...pageTwo];

    const listObjectsV2 = vi.fn(() => fakeListStream(allKeys));
    const removeObjects = vi.fn(async () => []);

    const client = { listObjectsV2, removeObjects } as unknown as MinioClient;
    const storage = new WorkspaceStorage(client, 'bucket');

    await storage.removeObjectsUnderPrefix('archive/ws-a/');

    // Listed under the scoped prefix, recursively.
    expect(listObjectsV2).toHaveBeenCalledWith('bucket', 'archive/ws-a/', true);
    // Every object across both pages was passed to a single bulk delete.
    expect(removeObjects).toHaveBeenCalledTimes(1);
    const [bucketArg, keysArg] = removeObjects.mock.calls[0]!;
    expect(bucketArg).toBe('bucket');
    expect(keysArg).toHaveLength(allKeys.length);
    expect(keysArg).toEqual(allKeys);
  });

  it('is a no-op when the prefix matches no objects (removeObjects never called)', async () => {
    const listObjectsV2 = vi.fn(() => fakeListStream([]));
    const removeObjects = vi.fn(async () => []);

    const client = { listObjectsV2, removeObjects } as unknown as MinioClient;
    const storage = new WorkspaceStorage(client, 'bucket');

    await expect(storage.removeObjectsUnderPrefix('archive/empty/')).resolves.toBeUndefined();

    expect(listObjectsV2).toHaveBeenCalledWith('bucket', 'archive/empty/', true);
    expect(removeObjects).not.toHaveBeenCalled();
  });

  it('throws when removeObjects reports a per-object failure', async () => {
    const listObjectsV2 = vi.fn(() => fakeListStream(['archive/ws-a/obj-0']));
    const removeObjects = vi.fn(async () => [
      { Error: { Code: 'AccessDenied', Key: 'archive/ws-a/obj-0' } }
    ]);

    const client = { listObjectsV2, removeObjects } as unknown as MinioClient;
    const storage = new WorkspaceStorage(client, 'bucket');

    await expect(storage.removeObjectsUnderPrefix('archive/ws-a/')).rejects.toThrow(
      /failed to delete 1 object/
    );
  });
});
