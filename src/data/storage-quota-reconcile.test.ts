// Unit tests for storage-quota reconciliation (issue #579, ADR-020 Decision 2):
// the off-hot-path listObjectsV2-sum sweep corrects counter drift and
// re-establishes the committed total after a crash.

import { describe, it, expect } from 'vitest';
import { InMemoryStorageQuotaStore } from './storage-quota.js';
import { reconcileStorageQuota, type ReconcileStorage } from './storage-quota-reconcile.js';

function fakeBucket(total: number): ReconcileStorage {
  return { sumObjectSizes: async () => total };
}

describe('reconcileStorageQuota', () => {
  it('sums source + packaged buckets and overwrites the committed total (corrects drift)', async () => {
    // Counter drifted to 5000 but ground truth is 300 (source) + 700 (packaged).
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 5000 });
    const total = await reconcileStorageQuota({
      store,
      buckets: [fakeBucket(300), fakeBucket(700)]
    });
    expect(total).toBe(1000);
    expect((await store.read()).consumedBytes).toBe(1000);
  });

  it('leaves reservedBytes untouched (in-flight uploads still pending)', async () => {
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 0, reservedBytes: 250 });
    await reconcileStorageQuota({ store, buckets: [fakeBucket(100)] });
    const c = await store.read();
    expect(c.consumedBytes).toBe(100);
    expect(c.reservedBytes).toBe(250);
  });

  it('re-establishes the total from zero after a crash (counter lost)', async () => {
    const store = new InMemoryStorageQuotaStore(); // fresh, as after a crash
    await reconcileStorageQuota({ store, buckets: [fakeBucket(4242)] });
    expect((await store.read()).consumedBytes).toBe(4242);
  });
});
