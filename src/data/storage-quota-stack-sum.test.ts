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

// ---------------------------------------------------------------------------
// #1141 review finding 1 — the walk enumerates READY stacks only.
//
// `listStackNames()` applies no status filter, so the `status: 'provisioning'`
// record the provision route writes before creating services and the
// `status: 'failed'` record it writes on a failure path are both listed, and
// both persist on purpose so deprovision can still clean them up
// (src/services/param-store.ts:121-128, isReadyStack). `resolve()` refuses to
// connect them and yields the same no-storage shape as a degraded resolution,
// so before this fix one un-deprovisioned failed provision put the sweep
// permanently in the `stack-without-object-storage` branch and FROZE the
// deployment-wide counter. These cases pin both halves: with the readiness
// listing the sweep writes, without it the same inputs freeze.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - PerStackQuotaSumDeps.listReadyStackNames?(): Promise<string[]>, consumed
//     in place of resolver.listStackNames() by the sweep's internal
//     StackSweepResolver: src/data/storage-quota-stack-sum.ts:134, :233-237
//   - WorkspaceStackResolver.listReadyStackNames(), wired at src/main.ts:3082
//   - forEachStack() reads the stack list through
//     StackSweepResolver.listStackNames(): src/services/for-each-stack.ts:98-99
describe('makePerStackQuotaSum — only READY stacks are enumerated (#1141 finding 1)', () => {
  // `listStackNames()` returns the unfiltered listing (a ready stack plus a
  // failed provision record); `listReadyStackNames()` returns only the stack
  // the resolver would actually connect.
  function listings() {
    const listedCalls: string[] = [];
    const readyCalls: string[] = [];
    const resolver: StackSweepResolver = {
      listStackNames: async () => {
        listedCalls.push('listStackNames');
        return ['stack-a', 'stack-b-failed'];
      },
      resolve: async () => ({})
    };
    const listReadyStackNames = async () => {
      readyCalls.push('listReadyStackNames');
      return ['stack-a'];
    };
    return { resolver, listReadyStackNames, listedCalls, readyCalls };
  }

  // The failed provision record resolves to no object storage, exactly as the
  // resolver's non-ready fallback does.
  const plan = {
    'stack-a': { sizes: [100, 200] },
    'stack-b-failed': { sizes: [], noStorage: true }
  };

  it('(5) skips a non-ready stack and still WRITES the ready stacks total', async () => {
    const summed: string[] = [];
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 999 });
    const { resolver, listReadyStackNames, listedCalls, readyCalls } = listings();

    const total = await reconcileStorageQuota({
      store,
      buckets: [
        makePerStackQuotaSum({
          resolver,
          listReadyStackNames,
          bucketsForStack: bucketsFor(plan, summed)
        })
      ]
    });

    // stack-a's two buckets only; the failed record contributed nothing and
    // did NOT make the pass partial.
    expect(total).toBe(300);
    expect((await store.read()).consumedBytes).toBe(300);
    expect(summed).toEqual(['stack-a:0', 'stack-a:1']);
    // The readiness listing replaced the unfiltered one for the enumeration.
    expect(readyCalls).toEqual(['listReadyStackNames']);
    expect(listedCalls).toEqual([]);
  });

  it('(5b) the SAME inputs enumerated unfiltered freeze the counter — what finding 1 fixed', async () => {
    const summed: string[] = [];
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 999 });
    const { resolver } = listings();

    // No listReadyStackNames: the walk falls back to the unfiltered listing,
    // so the failed provision record looks like a ready stack that resolved
    // without object storage.
    const sum = makePerStackQuotaSum({
      resolver,
      bucketsForStack: bucketsFor(plan, summed)
    });

    await expect(reconcileStorageQuota({ store, buckets: [sum] })).rejects.toMatchObject({
      name: 'PerStackQuotaSumIncomplete',
      reason: 'stack-without-object-storage'
    });
    expect((await store.read()).consumedBytes).toBe(999);
  });

  it('(5c) a readiness read failure fails the sweep instead of reporting "no ready stacks"', async () => {
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 4242 });
    const { resolver } = listings();
    const sum = makePerStackQuotaSum({
      resolver,
      listReadyStackNames: async () => {
        throw new Error('parameter store unreachable');
      },
      bucketsForStack: bucketsFor(plan, [])
    });

    // "We don't know which stacks are live" must never be written as a total.
    await expect(reconcileStorageQuota({ store, buckets: [sum] })).rejects.toThrow(
      'parameter store unreachable'
    );
    expect((await store.read()).consumedBytes).toBe(4242);
  });
});

// ---------------------------------------------------------------------------
// #1141 review finding 2 — the resolution guards, exercised against resolver
// stubs that return real connection SHAPES (the shared `makeResolver` above
// returns `{}`, under which none of these guards can fire).
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - the three guards: alias check on `conns.stackName`
//     (src/data/storage-quota-stack-sum.ts:257-265), object-store identity
//     dedup on `endpoint|sourceBucket|packagedBucket` (:199-205, :267-278) and
//     the ready-stack-without-buckets check (:285-288, :323-329)
//   - WorkspaceConnections.stackName — "the stack identity these connections
//     were built from ... Undefined on the env-override and in-memory fallback
//     paths": src/services/workspace-stack.ts:190-198
//   - WorkspaceConnections.s3Config.endpoint / .sourceBucket / .packagedBucket:
//     src/services/workspace-stack.ts:362-375 (per-stack), :537-539 (MINIO_URL
//     env override), `s3Config: undefined` on the no-storage in-memory
//     fallback: :585-587
describe('makePerStackQuotaSum — resolution guards on real connection shapes (#1141 finding 2)', () => {
  // The subset of WorkspaceConnections the walk inspects (ResolvedConnectionsLike,
  // src/data/storage-quota-stack-sum.ts:171-176).
  type FakeConnections = {
    stackName?: string;
    sourceBucket?: string;
    packagedBucket?: string;
    s3Config?: { endpoint?: string };
  };

  // Every stack of a deployment carries the SAME literal bucket names
  // (workspace-stack.ts:291-295), which is why the endpoint is part of the
  // identity rather than the bucket names alone.
  const SOURCE = 'openvideocore-source';
  const PACKAGED = 'openvideocore-packaged';

  function connsFor(stackName: string): FakeConnections {
    return {
      stackName,
      sourceBucket: SOURCE,
      packagedBucket: PACKAGED,
      s3Config: { endpoint: `https://${stackName}-objectstore.example.test` }
    };
  }

  // A resolver stub that hands back a connection shape per name, so the guards
  // see what the real resolver would give them.
  function makeConnectionResolver(
    names: string[],
    byName: (stackName: string | undefined) => FakeConnections
  ): StackSweepResolver {
    return {
      listStackNames: async () => [...names],
      resolve: async (stackName) => byName(stackName)
    };
  }

  it('(a) two names resolving to ONE object store (env override) are summed once', async () => {
    const summed: string[] = [];
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 1 });
    // MINIO_URL-style override: identical connections for every name, and NO
    // stackName — so the alias guard cannot fire and the identity dedup is the
    // only thing standing between the sweep and N x the real bytes.
    const override: FakeConnections = {
      sourceBucket: SOURCE,
      packagedBucket: PACKAGED,
      s3Config: { endpoint: 'https://shared-objectstore.example.test' }
    };
    const resolver = makeConnectionResolver(['stack-a', 'stack-b'], () => override);

    const total = await reconcileStorageQuota({
      store,
      buckets: [
        makePerStackQuotaSum({
          resolver,
          listReadyStackNames: async () => ['stack-a', 'stack-b'],
          bucketsForStack: bucketsFor(
            { 'stack-a': { sizes: [100, 200] }, 'stack-b': { sizes: [100, 200] } },
            summed
          )
        })
      ]
    });

    // 300, not 600: one set of buckets counted once.
    expect(total).toBe(300);
    expect((await store.read()).consumedBytes).toBe(300);
    expect(summed).toEqual(['stack-a:0', 'stack-a:1']);
  });

  it('(b) a resolution naming ANOTHER stack declines the write and keeps the previous total', async () => {
    const summed: string[] = [];
    const warn = vi.fn();
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 5000 });
    // stack-b has no stored config, so the resolver aliases it to the first
    // listed stack (workspace-stack.ts:1054-1066) and returns stack-a's
    // connections under stack-b's name.
    const resolver = makeConnectionResolver(['stack-a', 'stack-b'], () => connsFor('stack-a'));

    const sum = makePerStackQuotaSum({
      resolver,
      listReadyStackNames: async () => ['stack-a', 'stack-b'],
      logger: { warn },
      bucketsForStack: bucketsFor(
        { 'stack-a': { sizes: [100] }, 'stack-b': { sizes: [7] } },
        summed
      )
    });

    await expect(reconcileStorageQuota({ store, buckets: [sum] })).rejects.toMatchObject({
      name: 'PerStackQuotaSumIncomplete',
      reason: 'stack-failures'
    });

    // stack-a was summed, stack-b was refused — and because the pass was
    // partial the counter is untouched at its previous value.
    expect(summed).toEqual(['stack-a:0']);
    expect((await store.read()).consumedBytes).toBe(5000);
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ stackName: 'stack-b', resolvedStackName: 'stack-a' }),
      expect.stringContaining('another stack')
    );
  });

  it('(c) a READY stack resolving without object storage rejects and keeps the previous total', async () => {
    const summed: string[] = [];
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 8080 });
    // stack-b degraded to the in-memory no-storage fallback: correct stackName,
    // no s3Config, no buckets — and it is READY, so it cannot be skipped.
    const resolver = makeConnectionResolver(['stack-a', 'stack-b'], (stackName) =>
      stackName === 'stack-b' ? { stackName: 'stack-b' } : connsFor('stack-a')
    );

    const sum = makePerStackQuotaSum({
      resolver,
      listReadyStackNames: async () => ['stack-a', 'stack-b'],
      bucketsForStack: bucketsFor(
        { 'stack-a': { sizes: [100, 200] }, 'stack-b': { sizes: [], noStorage: true } },
        summed
      )
    });

    await expect(reconcileStorageQuota({ store, buckets: [sum] })).rejects.toMatchObject({
      name: 'PerStackQuotaSumIncomplete',
      reason: 'stack-without-object-storage'
    });

    expect(summed).toEqual(['stack-a:0', 'stack-a:1']);
    expect((await store.read()).consumedBytes).toBe(8080);
  });

  it('(c2) distinct endpoints are NOT deduplicated: both stacks are summed', async () => {
    const summed: string[] = [];
    const store = new InMemoryStorageQuotaStore();
    const resolver = makeConnectionResolver(['stack-a', 'stack-b'], (stackName) =>
      connsFor(stackName ?? 'stack-a')
    );

    const total = await reconcileStorageQuota({
      store,
      buckets: [
        makePerStackQuotaSum({
          resolver,
          listReadyStackNames: async () => ['stack-a', 'stack-b'],
          bucketsForStack: bucketsFor(
            { 'stack-a': { sizes: [100, 200] }, 'stack-b': { sizes: [30, 4] } },
            summed
          )
        })
      ]
    });

    expect(total).toBe(334);
    expect((await store.read()).consumedBytes).toBe(334);
    expect(summed).toEqual(['stack-a:0', 'stack-a:1', 'stack-b:0', 'stack-b:1']);
  });
});
