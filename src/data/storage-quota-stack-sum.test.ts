// Per-stack ground-truth sum for the storage-quota reconciliation sweep
// (issue #1098, closing the gap recorded as #1090).
//
// Covers:
//   (1) with two stacks provisioned, the sweep sums BOTH stacks' buckets and
//       overwrites the ONE deployment-wide counter with that total (ADR-020
//       Decision 1: one deployment is one tenant, a single counter);
//   (2) a failure on one stack does not stop the walk — the remaining stacks are
//       still visited — but the partial total is NOT written, so the cap is
//       never re-armed on a short number (the #1090 under-count);
//   (3) single-stack behaviour is unchanged: the same two buckets, the same
//       total, written once;
//   (4) a deployment with no object storage anywhere declines to write (it would
//       otherwise zero the counter) and says why.
//
// Only the resolver and the bucket listing are stubbed; reconcileStorageQuota,
// the counter store and forEachStack are production code.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - reconcileStorageQuota sums `buckets` then calls `store.reconcile(total)`:
//     src/data/storage-quota-reconcile.ts:35-42
//   - ReconcileStorage = { sumObjectSizes(): Promise<number> }:
//     src/data/storage-quota-reconcile.ts:23-25
//   - StorageQuotaReconciler.runOnce() catches and routes to onError:
//     src/data/storage-quota-reconcile.ts:81-88
//   - InMemoryStorageQuotaStore.reconcile/read + QuotaCounter:
//     src/data/storage-quota.ts:99-131
//   - WorkspaceStackResolver.listStackNames / resolve:
//     src/services/workspace-stack.ts:906,1186-1202

import { describe, it, expect, vi } from 'vitest';

import { InMemoryStorageQuotaStore } from './storage-quota.js';
import {
  reconcileStorageQuota,
  StorageQuotaReconciler,
  type ReconcileStorage
} from './storage-quota-reconcile.js';
import {
  makePerStackQuotaSum,
  PerStackQuotaSumIncomplete
} from './storage-quota-stack-sum.js';
import type { StackSweepResolver } from '../services/for-each-stack.js';

type StackBuckets = {
  // bucket bytes, in the order the sweep sums them (source, then packaged)
  sizes: number[];
  // when set, this stack's listing fails (unreachable object storage)
  fail?: boolean;
  // no object storage configured on this stack at all
  noStorage?: boolean;
};

// A resolver stub over a live stack list, faithful to the two symbols the walk
// uses: listStackNames() (re-read every sweep) and resolve(name).
function makeResolver(names: string[]): StackSweepResolver & { names: string[] } {
  const live = [...names];
  return {
    names: live,
    listStackNames: async () => [...live],
    resolve: async () => ({})
  };
}

function bucketsFor(
  plan: Record<string, StackBuckets>,
  summed: string[]
): (stackName: string | undefined) => Promise<ReconcileStorage[]> {
  return async (stackName) => {
    const entry = plan[stackName ?? '(default)'];
    if (!entry || entry.noStorage) return [];
    return entry.sizes.map((size, i) => ({
      sumObjectSizes: async () => {
        if (entry.fail) throw new Error(`listObjectsV2 failed on ${stackName}`);
        summed.push(`${stackName}:${i}`);
        return size;
      }
    }));
  };
}

describe('makePerStackQuotaSum — every provisioned stack, one deployment-wide total (#1098)', () => {
  it('(1) sums both stacks source + packaged buckets and writes ONE total', async () => {
    const summed: string[] = [];
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 999 });
    const total = await reconcileStorageQuota({
      store,
      buckets: [
        makePerStackQuotaSum({
          resolver: makeResolver(['stack-a', 'stack-b']),
          bucketsForStack: bucketsFor(
            {
              'stack-a': { sizes: [100, 200] },
              'stack-b': { sizes: [30, 4] }
            },
            summed
          )
        })
      ]
    });

    expect(total).toBe(334);
    // ONE counter, overwritten once with the deployment-wide total.
    expect((await store.read()).consumedBytes).toBe(334);
    // All four buckets were visited (pre-#1098 only stack-a's two were).
    expect(summed).toEqual(['stack-a:0', 'stack-a:1', 'stack-b:0', 'stack-b:1']);
  });

  it('(2) visits the remaining stacks after one fails, but does NOT write a partial total', async () => {
    const summed: string[] = [];
    const warn = vi.fn();
    // The counter holds a previously-good total; a short sum must not replace it.
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 5000 });
    const sum = makePerStackQuotaSum({
      resolver: makeResolver(['stack-a', 'stack-b', 'stack-c']),
      logger: { warn },
      bucketsForStack: bucketsFor(
        {
          'stack-a': { sizes: [100], fail: true },
          'stack-b': { sizes: [200] },
          'stack-c': { sizes: [300] }
        },
        summed
      )
    });

    await expect(reconcileStorageQuota({ store, buckets: [sum] })).rejects.toBeInstanceOf(
      PerStackQuotaSumIncomplete
    );

    // The stacks after the failing one were still summed...
    expect(summed).toEqual(['stack-b:0', 'stack-c:0']);
    // ...and the last good total is intact (no silent under-count).
    expect((await store.read()).consumedBytes).toBe(5000);
    expect(warn).toHaveBeenCalled();
  });

  it('(2b) the reconciler swallows an incomplete sweep: onError is told, the schedule survives', async () => {
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 5000 });
    const errors: unknown[] = [];
    const reconciler = new StorageQuotaReconciler({
      store,
      buckets: [
        makePerStackQuotaSum({
          resolver: makeResolver(['stack-a']),
          bucketsForStack: bucketsFor({ 'stack-a': { sizes: [1], fail: true } }, [])
        })
      ],
      onError: (err) => errors.push(err)
    });

    await reconciler.runOnce();

    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(PerStackQuotaSumIncomplete);
    expect((errors[0] as PerStackQuotaSumIncomplete).reason).toBe('stack-failures');
    expect((await store.read()).consumedBytes).toBe(5000);
  });

  it('(3) single-stack behaviour is unchanged: the same two buckets, written once', async () => {
    const summed: string[] = [];
    const store = new InMemoryStorageQuotaStore();
    const total = await reconcileStorageQuota({
      store,
      buckets: [
        makePerStackQuotaSum({
          resolver: makeResolver(['only']),
          bucketsForStack: bucketsFor({ only: { sizes: [300, 700] } }, summed)
        })
      ]
    });
    expect(total).toBe(1000);
    expect((await store.read()).consumedBytes).toBe(1000);
    expect(summed).toEqual(['only:0', 'only:1']);
  });

  it('(3b) no parameter store (no stack listed): the single default resolution is summed', async () => {
    const summed: string[] = [];
    const store = new InMemoryStorageQuotaStore();
    const total = await reconcileStorageQuota({
      store,
      buckets: [
        makePerStackQuotaSum({
          resolver: makeResolver([]),
          bucketsForStack: bucketsFor({ '(default)': { sizes: [42] } }, summed)
        })
      ]
    });
    expect(total).toBe(42);
    expect(summed).toEqual(['undefined:0']);
  });

  it('(4) declines to write when no stack has object storage, instead of zeroing the counter', async () => {
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 777 });
    const sum = makePerStackQuotaSum({
      resolver: makeResolver(['stack-a', 'stack-b']),
      bucketsForStack: bucketsFor(
        {
          'stack-a': { sizes: [], noStorage: true },
          'stack-b': { sizes: [], noStorage: true }
        },
        []
      )
    });

    await expect(reconcileStorageQuota({ store, buckets: [sum] })).rejects.toMatchObject({
      name: 'PerStackQuotaSumIncomplete',
      reason: 'no-object-storage'
    });
    expect((await store.read()).consumedBytes).toBe(777);
  });

  it('re-reads the stack list on every sweep, so a newly provisioned stack is counted', async () => {
    const summed: string[] = [];
    const resolver = makeResolver(['stack-a']);
    const store = new InMemoryStorageQuotaStore();
    const buckets = [
      makePerStackQuotaSum({
        resolver,
        bucketsForStack: bucketsFor(
          { 'stack-a': { sizes: [100] }, 'stack-b': { sizes: [50] } },
          summed
        )
      })
    ];

    expect(await reconcileStorageQuota({ store, buckets })).toBe(100);

    // A second stack is provisioned between sweeps — no restart.
    resolver.names.push('stack-b');

    expect(await reconcileStorageQuota({ store, buckets })).toBe(150);
    expect((await store.read()).consumedBytes).toBe(150);
  });
});
