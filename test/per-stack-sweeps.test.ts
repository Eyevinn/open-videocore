// Per-stack background sweeps (issue #1098).
//
// The four sweeps wired in src/main.ts — archived-asset purge, audit-retention
// purge, abandoned-upload settle, storage-quota reconcile — resolved the stack
// with NO name, so on a multi-stack installation they only ever saw the FIRST
// listed stack (`WorkspaceStackResolver.resolve()`, no-stackName branch).
//
// Covers exactly the acceptance criteria of #1098:
//   (1) with two stacks provisioned, each sweep acts on BOTH stacks' data;
//   (2) a failure in one stack does not stop the sweep for the other;
//   (3) single-stack behaviour is unchanged (exactly one sweep per tick), and
//       the no-parameter-store path still runs the single default resolution;
//   plus: listStackNames() is re-read on EVERY tick, so a stack provisioned
//   after boot is swept from its next tick.
//
// The quota sweep's per-stack sum is covered in
// src/data/storage-quota-stack-sum.test.ts (it writes ONE deployment-wide total,
// per ADR-020 Decision 1, so it needs its own assertions).
//
// Only the resolver boundary is stubbed — the loops, the sweeps, the
// PerWorkspace* repositories, the in-memory repos and the AsyncLocalStorage
// stack context are production code. The sweep dependency closures are wired
// here exactly as src/main.ts wires them (same `resolve(currentRequestStackName())`
// / `resolveCached(currentRequestStackName())` reads), so the test exercises the
// production wiring shape rather than a parallel one.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - forEachStack / perStackSweepRunner / ForEachStackResult:
//     src/services/for-each-stack.ts
//   - WorkspaceStackResolver.listStackNames / resolve(stackName?) /
//     resolveCached(stackName?): src/services/workspace-stack.ts:906,1186-1213
//   - runWithRequestStack / currentRequestStackName:
//     src/services/request-stack-context.ts:46-53
//   - Loop `forEachStack` option + tick(): src/pipeline/archived-asset-purge-loop.ts,
//     src/pipeline/audit-retention-purge-loop.ts, src/pipeline/abandoned-upload-loop.ts
//   - Sweep deps: src/pipeline/archived-asset-purge-sweep.ts (PurgeStorage,
//     sourceBucket, purge), src/pipeline/audit-retention-purge-sweep.ts
//     (AuditRetentionStore), src/pipeline/abandoned-upload-sweep.ts (assets)
//   - InMemoryAssetRepository.purgeToTombstone / statusHistory;
//     InMemoryAuditRepository.record / listOldestPage / purgeEntry:
//     src/data/asset-repo.ts, src/data/audit-repo.ts
//   - PerWorkspaceAssetRepository resolves the ambient stack:
//     src/data/per-workspace-repos.ts:99-103

import { describe, it, expect, vi } from 'vitest';

import { InMemoryAssetRepository, type Asset } from '../src/data/asset-repo.js';
import { InMemoryAuditRepository } from '../src/data/audit-repo.js';
import { PerWorkspaceAssetRepository } from '../src/data/per-workspace-repos.js';
import {
  currentRequestStackName
} from '../src/services/request-stack-context.js';
import {
  forEachStack,
  perStackSweepRunner
} from '../src/services/for-each-stack.js';
import type { WorkspaceConnections, WorkspaceStackResolver } from '../src/services/workspace-stack.js';
import type { PurgeStorage } from '../src/pipeline/archived-asset-purge-sweep.js';
import { ArchivedAssetPurgeLoop } from '../src/pipeline/archived-asset-purge-loop.js';
import { AuditRetentionPurgeLoop } from '../src/pipeline/audit-retention-purge-loop.js';
import { AbandonedUploadSweepLoop } from '../src/pipeline/abandoned-upload-loop.js';

const SOURCE_BUCKET = 'openvideocore-source';
const NOW = Date.parse('2026-06-01T00:00:00.000Z');
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24h
const LONG_AGO = '2026-01-01T00:00:00.000Z'; // well past both windows

// Records removals per bucket so a test can assert that a stack's objects were
// reaped through THAT stack's own storage client. Implements the minimal
// PurgeStorage surface the archived sweep depends on.
class FakeStorage implements PurgeStorage {
  readonly removed: string[] = [];
  readonly removedPrefixes: string[] = [];
  async removeObject(localKey: string): Promise<void> {
    this.removed.push(localKey);
  }
  async removeObjectsUnderPrefix(prefix: string): Promise<void> {
    this.removedPrefixes.push(prefix);
  }
}

type Stack = {
  name: string;
  assets: InMemoryAssetRepository;
  audit: InMemoryAuditRepository;
  // bucket name -> the storage fake standing in for this stack's MinIO client.
  buckets: Map<string, FakeStorage>;
  connections: WorkspaceConnections;
};

function makeStack(name: string): Stack {
  const assets = new InMemoryAssetRepository();
  const audit = new InMemoryAuditRepository();
  const stack: Stack = {
    name,
    assets,
    audit,
    buckets: new Map(),
    connections: {
      assets,
      audit,
      // Stands in for the per-stack MinIO client: the production
      // `storageForBucket` only checks it is present before building a
      // WorkspaceStorage from it.
      storageClient: { stack: name },
      sourceBucket: SOURCE_BUCKET,
      packagedBucket: 'openvideocore-packaged',
      stackName: name
    } as unknown as WorkspaceConnections
  };
  return stack;
}

function storageFor(stack: Stack, bucket: string): FakeStorage {
  const existing = stack.buckets.get(bucket);
  if (existing) return existing;
  const created = new FakeStorage();
  stack.buckets.set(bucket, created);
  return created;
}

type ResolverStub = {
  resolver: WorkspaceStackResolver;
  resolvedWith: Array<string | undefined>;
  stackOf(conns: WorkspaceConnections | undefined): Stack | undefined;
  // Provision a stack AFTER construction, as POST /api/v1/provision does: the
  // name appears in the parameter-store listing the resolver re-reads.
  provision(stack: Stack): void;
};

// A resolver stub faithful to the three symbols the sweeps use:
//   - listStackNames() -> the live list (re-read on every call);
//   - resolve(name) -> that stack's connections, and WARMS the cache entry;
//   - resolveCached(name) -> only returns connections once warmed, exactly as
//     the real cache does (so a sweep that failed to warm the right key sees
//     undefined, as it would in production).
function makeResolver(
  initialStacks: Stack[],
  opts: { failResolveFor?: string[]; failListNames?: boolean } = {}
): ResolverStub {
  // Live list, mutated by provision() so every listStackNames() call re-reads it.
  const stacks = [...initialStacks];
  const warmed = new Set<string>();
  const resolvedWith: Array<string | undefined> = [];
  const pick = (stackName?: string): Stack => {
    const target = stackName ?? stacks[0]?.name;
    const found = stacks.find((s) => s.name === target);
    if (!found) throw new Error(`no such stack: ${stackName}`);
    return found;
  };
  const resolver = {
    listStackNames: async () => {
      if (opts.failListNames) return []; // the real resolver reports "no stacks"
      return stacks.map((s) => s.name);
    },
    resolve: async (stackName?: string) => {
      resolvedWith.push(stackName);
      if (stackName && opts.failResolveFor?.includes(stackName)) {
        throw new Error(`parameter store unreachable for ${stackName}`);
      }
      const stack = pick(stackName);
      warmed.add(stackName ?? '');
      return stack.connections;
    },
    resolveCached: (stackName?: string) => {
      if (!warmed.has(stackName ?? '')) return undefined;
      return pick(stackName).connections;
    }
  } as unknown as WorkspaceStackResolver;
  return {
    resolver,
    resolvedWith,
    stackOf: (conns) => stacks.find((s) => s.connections === conns),
    provision: (stack: Stack) => {
      stacks.push(stack);
    }
  };
}

// Drive an asset to `archived` and stamp the `-> archived` transition at
// `archivedAt`, so the window is measured from statusHistory (archivedAtOf) as
// in test/archived-asset-purge-sweep.test.ts.
async function makeArchived(
  repo: InMemoryAssetRepository,
  name: string,
  objectKey: string,
  archivedAt: string
): Promise<Asset> {
  const created = await repo.create({ name, objectKey });
  await repo.update(created.id, { status: 'processing' });
  await repo.update(created.id, { status: 'ready' });
  await repo.update(created.id, { status: 'archived' });
  const current = (await repo.get(created.id))!;
  const history = current.statusHistory.map((t) =>
    t.to === 'archived' ? { ...t, at: archivedAt } : t
  );
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (repo as any).store.set(created.id, { ...current, statusHistory: history });
  return (await repo.get(created.id))!;
}

// Create an asset (starts in `uploading`) with a controlled liveness stamp.
async function makeUploading(
  repo: InMemoryAssetRepository,
  name: string,
  updatedAt: string
): Promise<Asset> {
  const created = await repo.create({ name, objectKey: `sources/${name}` });
  const current = (await repo.get(created.id))!;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (repo as any).store.set(created.id, { ...current, updatedAt });
  return (await repo.get(created.id))!;
}

// ---------------------------------------------------------------------------
// forEachStack itself
// ---------------------------------------------------------------------------

describe('forEachStack — iteration, context, isolation (#1098)', () => {
  it('runs the body once per listed stack, inside that stack ambient context, after warming it', async () => {
    const stacks = [makeStack('stack-a'), makeStack('stack-b')];
    const { resolver, resolvedWith } = makeResolver(stacks);
    const seen: Array<string | undefined> = [];

    const result = await forEachStack({ resolver, label: 'test-sweep' }, async () => {
      // The ambient name IS the stack the body is running for, so every
      // repository/storage resolution inside it keys on this stack.
      seen.push(currentRequestStackName());
    });

    expect(seen).toEqual(['stack-a', 'stack-b']);
    // Warmed before the body ran, as the request preHandler does per request.
    expect(resolvedWith).toEqual(['stack-a', 'stack-b']);
    expect(result).toEqual({ stacks: 2, failed: 0 });
  });

  it('runs exactly ONCE with no ambient stack when no stack is listed (no parameter store)', async () => {
    const stacks = [makeStack('only')];
    const { resolver } = makeResolver(stacks, { failListNames: true });
    const seen: Array<string | undefined> = [];

    const result = await forEachStack({ resolver, label: 'test-sweep' }, async () => {
      seen.push(currentRequestStackName());
    });

    // Byte-identical to the pre-#1098 behaviour: one default resolution.
    expect(seen).toEqual([undefined]);
    expect(result).toEqual({ stacks: 1, failed: 0 });
  });

  it('runs exactly ONCE on a single-stack deployment', async () => {
    const { resolver } = makeResolver([makeStack('only')]);
    const body = vi.fn(async () => {});
    const result = await forEachStack({ resolver, label: 'test-sweep' }, body);
    expect(body).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ stacks: 1, failed: 0 });
  });

  it('isolates a failing stack: the remaining stacks still run, and the failure is logged', async () => {
    const stacks = [makeStack('stack-a'), makeStack('stack-b'), makeStack('stack-c')];
    const { resolver } = makeResolver(stacks);
    const warn = vi.fn();
    const seen: Array<string | undefined> = [];

    const result = await forEachStack(
      { resolver, label: 'test-sweep', logger: { warn } },
      async (stackName) => {
        seen.push(stackName);
        if (stackName === 'stack-a') throw new Error('boom on a');
      }
    );

    expect(seen).toEqual(['stack-a', 'stack-b', 'stack-c']);
    expect(result).toEqual({ stacks: 3, failed: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toContain('test-sweep');
  });

  it('isolates a stack whose resolve() throws (parameter store unreachable)', async () => {
    const stacks = [makeStack('stack-a'), makeStack('stack-b')];
    const { resolver } = makeResolver(stacks, { failResolveFor: ['stack-a'] });
    const warn = vi.fn();
    const seen: Array<string | undefined> = [];

    const result = await forEachStack(
      { resolver, label: 'test-sweep', logger: { warn } },
      async (stackName) => {
        seen.push(stackName);
      }
    );

    // stack-a never reached the body; stack-b was still swept.
    expect(seen).toEqual(['stack-b']);
    expect(result).toEqual({ stacks: 2, failed: 1 });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('re-reads listStackNames() on every pass, so a newly provisioned stack is picked up', async () => {
    const stacks = [makeStack('stack-a'), makeStack('stack-b')];
    const stub = makeResolver(stacks);
    const first: Array<string | undefined> = [];
    await forEachStack({ resolver: stub.resolver, label: 'test-sweep' }, async (n) => {
      first.push(n);
    });
    expect(first).toEqual(['stack-a', 'stack-b']);

    // A stack is provisioned after the first pass (POST /provision persists a
    // new stack config; the resolver lists it from the parameter store).
    stub.provision(makeStack('stack-c'));

    const second: Array<string | undefined> = [];
    await forEachStack({ resolver: stub.resolver, label: 'test-sweep' }, async (n) => {
      second.push(n);
    });
    expect(second).toEqual(['stack-a', 'stack-b', 'stack-c']);
  });
});

// ---------------------------------------------------------------------------
// Archived-asset purge sweep, wired as main.ts wires it
// ---------------------------------------------------------------------------

// Build the loop with EXACTLY the dependency closures src/main.ts uses.
function buildArchivedPurgeLoop(
  stub: ResolverStub,
  opts: { perStack: boolean }
): ArchivedAssetPurgeLoop {
  const assetRepository = new PerWorkspaceAssetRepository(stub.resolver);
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return new ArchivedAssetPurgeLoop({
    retentionMs: () => RETENTION_MS,
    logger,
    forEachStack: opts.perStack
      ? perStackSweepRunner({
          resolver: stub.resolver,
          label: 'archived-asset-purge',
          logger
        })
      : undefined,
    sweepDeps: {
      assets: assetRepository,
      purge: async (assetId: string) => {
        const conns = await stub.resolver.resolve(currentRequestStackName());
        const concrete = conns.assets as unknown as {
          purgeToTombstone?: (id: string) => Promise<string | undefined> | boolean;
        };
        if (typeof concrete.purgeToTombstone !== 'function') {
          throw new Error('resolved asset repository does not support purgeToTombstone');
        }
        return concrete.purgeToTombstone(assetId);
      },
      storageForBucket: (bucket: string): PurgeStorage | undefined => {
        const conns = stub.resolver.resolveCached(currentRequestStackName());
        if (!conns?.storageClient) return undefined;
        const stack = stub.stackOf(conns);
        if (!stack) return undefined;
        return storageFor(stack, bucket);
      },
      sourceBucket: SOURCE_BUCKET,
      now: () => NOW
    }
  });
}

describe('archived-asset purge runs once per provisioned stack (#1098)', () => {
  it('(1) purges expired archived assets on BOTH stacks, each through its own storage', async () => {
    const a = makeStack('stack-a');
    const b = makeStack('stack-b');
    const stub = makeResolver([a, b]);
    const assetA = await makeArchived(a.assets, 'clip-a', 'sources/clip-a', LONG_AGO);
    const assetB = await makeArchived(b.assets, 'clip-b', 'sources/clip-b', LONG_AGO);

    await buildArchivedPurgeLoop(stub, { perStack: true }).tick();

    // Both documents replaced with a tombstone.
    expect(await a.assets.getState(assetA.id)).toEqual({ kind: 'tombstone' });
    expect(await b.assets.getState(assetB.id)).toEqual({ kind: 'tombstone' });
    // And each stack's object was removed through THAT stack's storage.
    expect(storageFor(a, SOURCE_BUCKET).removed).toContain('sources/clip-a');
    expect(storageFor(b, SOURCE_BUCKET).removed).toContain('sources/clip-b');
    // No cross-stack leakage.
    expect(storageFor(a, SOURCE_BUCKET).removed).not.toContain('sources/clip-b');
  });

  it('(2) one stack failing does not stop the purge on the other', async () => {
    const a = makeStack('stack-a');
    const b = makeStack('stack-b');
    const stub = makeResolver([a, b]);
    await makeArchived(a.assets, 'clip-a', 'sources/clip-a', LONG_AGO);
    const assetB = await makeArchived(b.assets, 'clip-b', 'sources/clip-b', LONG_AGO);
    // stack-a's enumeration blows up mid-sweep (an unreachable CouchDB).
    vi.spyOn(a.assets, 'list').mockRejectedValue(new Error('couch unreachable'));

    await buildArchivedPurgeLoop(stub, { perStack: true }).tick();

    // stack-b was still swept to completion.
    expect(await b.assets.getState(assetB.id)).toEqual({ kind: 'tombstone' });
    expect(storageFor(b, SOURCE_BUCKET).removed).toContain('sources/clip-b');
    vi.restoreAllMocks();
  });

  it('(3) single-stack behaviour is unchanged: one sweep per tick', async () => {
    const only = makeStack('only');
    const stub = makeResolver([only]);
    const asset = await makeArchived(only.assets, 'clip', 'sources/clip', LONG_AGO);
    const listSpy = vi.spyOn(only.assets, 'list');

    await buildArchivedPurgeLoop(stub, { perStack: true }).tick();

    expect(await only.assets.getState(asset.id)).toEqual({ kind: 'tombstone' });
    // The sweep enumerated the archived set exactly once (one page, one stack):
    // the per-stack wrapper adds no extra pass on a single-stack deployment.
    expect(listSpy.mock.calls.filter((c) => c[0]?.status === 'archived')).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('un-wired (no forEachStack) the loop sweeps exactly once, as before', async () => {
    const a = makeStack('stack-a');
    const b = makeStack('stack-b');
    const stub = makeResolver([a, b]);
    const assetA = await makeArchived(a.assets, 'clip-a', 'sources/clip-a', LONG_AGO);
    const assetB = await makeArchived(b.assets, 'clip-b', 'sources/clip-b', LONG_AGO);

    await buildArchivedPurgeLoop(stub, { perStack: false }).tick();

    // Pre-#1098 behaviour, retained for a direct/unwired caller: only the
    // default (first listed) stack is touched.
    expect(await a.assets.getState(assetA.id)).toEqual({ kind: 'tombstone' });
    expect(await b.assets.getState(assetB.id)).toMatchObject({ kind: 'asset' });
  });
});

// ---------------------------------------------------------------------------
// Audit-retention purge sweep, wired as main.ts wires it
// ---------------------------------------------------------------------------

function buildAuditPurgeLoop(stub: ResolverStub, perStack: boolean): AuditRetentionPurgeLoop {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return new AuditRetentionPurgeLoop({
    retentionMs: () => RETENTION_MS,
    logger,
    forEachStack: perStack
      ? perStackSweepRunner({ resolver: stub.resolver, label: 'audit-retention-purge', logger })
      : undefined,
    sweepDeps: {
      audit: {
        listOldestPage: async (opts: { limit: number; offset?: number }) => {
          const conns = await stub.resolver.resolve(currentRequestStackName());
          return conns.audit.listOldestPage(opts);
        },
        purgeEntry: async (id: string) => {
          const conns = await stub.resolver.resolve(currentRequestStackName());
          return conns.audit.purgeEntry(id);
        }
      },
      now: () => NOW
    }
  });
}

describe('audit-retention purge runs once per provisioned stack (#1098)', () => {
  it('(1) expires aged entries in BOTH stacks own audit logs', async () => {
    const a = makeStack('stack-a');
    const b = makeStack('stack-b');
    const stub = makeResolver([a, b]);
    const aged = { actor: { principalId: null, origin: 'system' as const }, action: 'x', targetType: 'asset' as const, targetId: 'asset-1' };
    await a.audit.record({ ...aged, at: LONG_AGO });
    await b.audit.record({ ...aged, at: LONG_AGO });
    // One fresh entry per stack must survive the sweep.
    await a.audit.record({ ...aged, at: new Date(NOW).toISOString() });
    await b.audit.record({ ...aged, at: new Date(NOW).toISOString() });

    await buildAuditPurgeLoop(stub, true).tick();

    const liveA = await a.audit.listOldestPage({ limit: 10 });
    const liveB = await b.audit.listOldestPage({ limit: 10 });
    expect(liveA).toHaveLength(1);
    expect(liveB).toHaveLength(1);
    expect(liveA[0]?.at).toBe(new Date(NOW).toISOString());
    expect(liveB[0]?.at).toBe(new Date(NOW).toISOString());
  });

  it('(2) one stack failing does not stop the expiry on the other', async () => {
    const a = makeStack('stack-a');
    const b = makeStack('stack-b');
    const stub = makeResolver([a, b]);
    const aged = { actor: { principalId: null, origin: 'system' as const }, action: 'x', targetType: 'asset' as const, targetId: 'asset-1', at: LONG_AGO };
    await a.audit.record(aged);
    await b.audit.record(aged);
    vi.spyOn(a.audit, 'listOldestPage').mockRejectedValue(new Error('couch unreachable'));

    await buildAuditPurgeLoop(stub, true).tick();

    expect(await b.audit.listOldestPage({ limit: 10 })).toHaveLength(0);
    vi.restoreAllMocks();
  });

  it('(3) single-stack behaviour is unchanged: the aged tail is expired exactly once', async () => {
    const only = makeStack('only');
    const stub = makeResolver([only]);
    const aged = { actor: { principalId: null, origin: 'system' as const }, action: 'x', targetType: 'asset' as const, targetId: 'asset-1', at: LONG_AGO };
    await only.audit.record(aged);
    const purgeSpy = vi.spyOn(only.audit, 'purgeEntry');

    await buildAuditPurgeLoop(stub, true).tick();

    expect(purgeSpy).toHaveBeenCalledTimes(1);
    expect(await only.audit.listOldestPage({ limit: 10 })).toHaveLength(0);
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------
// Abandoned-upload settle sweep, wired as main.ts wires it
// ---------------------------------------------------------------------------

function buildAbandonedUploadLoop(stub: ResolverStub, perStack: boolean): AbandonedUploadSweepLoop {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return new AbandonedUploadSweepLoop({
    thresholdMs: () => THRESHOLD_MS,
    logger,
    forEachStack: perStack
      ? perStackSweepRunner({ resolver: stub.resolver, label: 'abandoned-upload-sweep', logger })
      : undefined,
    sweepDeps: {
      assets: new PerWorkspaceAssetRepository(stub.resolver),
      now: () => NOW
    }
  });
}

describe('abandoned-upload settle runs once per provisioned stack (#1098)', () => {
  it('(1) settles wedged uploads on BOTH stacks', async () => {
    const a = makeStack('stack-a');
    const b = makeStack('stack-b');
    const stub = makeResolver([a, b]);
    const wedgedA = await makeUploading(a.assets, 'up-a', LONG_AGO);
    const wedgedB = await makeUploading(b.assets, 'up-b', LONG_AGO);
    // A still-progressing upload on stack-b must be left alone.
    const liveB = await makeUploading(b.assets, 'live-b', new Date(NOW).toISOString());

    await buildAbandonedUploadLoop(stub, true).tick();

    expect((await a.assets.get(wedgedA.id))?.status).toBe('failed');
    expect((await b.assets.get(wedgedB.id))?.status).toBe('failed');
    expect((await b.assets.get(liveB.id))?.status).toBe('uploading');
  });

  it('(2) one stack failing does not stop the settle on the other', async () => {
    const a = makeStack('stack-a');
    const b = makeStack('stack-b');
    const stub = makeResolver([a, b]);
    await makeUploading(a.assets, 'up-a', LONG_AGO);
    const wedgedB = await makeUploading(b.assets, 'up-b', LONG_AGO);
    vi.spyOn(a.assets, 'list').mockRejectedValue(new Error('couch unreachable'));

    await buildAbandonedUploadLoop(stub, true).tick();

    expect((await b.assets.get(wedgedB.id))?.status).toBe('failed');
    vi.restoreAllMocks();
  });

  it('(3) single-stack behaviour is unchanged: one settle pass per tick', async () => {
    const only = makeStack('only');
    const stub = makeResolver([only]);
    const wedged = await makeUploading(only.assets, 'up', LONG_AGO);
    const listSpy = vi.spyOn(only.assets, 'list');

    await buildAbandonedUploadLoop(stub, true).tick();

    expect((await only.assets.get(wedged.id))?.status).toBe('failed');
    expect(listSpy.mock.calls.filter((c) => c[0]?.status === 'uploading')).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it('picks up a stack provisioned after the first tick (list re-read every tick)', async () => {
    const a = makeStack('stack-a');
    const stub = makeResolver([a]);
    const loop = buildAbandonedUploadLoop(stub, true);
    await loop.tick();

    // A second stack is provisioned between ticks — no restart, no re-wiring.
    const b = makeStack('stack-b');
    const wedgedB = await makeUploading(b.assets, 'up-b', LONG_AGO);
    stub.provision(b);

    // The SAME loop instance, next tick: it re-reads the stack list and settles
    // the new stack's wedged upload.
    await loop.tick();

    expect((await b.assets.get(wedgedB.id))?.status).toBe('failed');
  });
});
