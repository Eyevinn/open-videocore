// Watch-folder ingest per provisioned stack (issue #1099).
//
// Reproduces the reported bug on a two-stack installation: the boot wiring built
// ONE WatchFolderService from `WorkspaceStackResolver.resolve()` called with no
// stack name, which resolves the FIRST listed stack
// (src/services/workspace-stack.ts `resolve()`, no-stackName branch). So stack
// B's source bucket was never watched at all, and anything the single watcher
// did ingest was written with no ambient stack identity — i.e. into stack A, the
// same control-plane/data-plane split issue #1058 fixed for requests.
//
// The harness stubs ONLY the stack-resolver boundary (one in-memory asset
// repository + one fake MinIO client per stack). Everything under test is
// production code, wired exactly as src/main.ts wires it:
//   - src/services/watch-folder-wiring.ts  reconcileWatchFolders
//   - src/pipeline/watch-folder.ts         WatchFolderService (+ runInStackContext)
//   - src/services/request-stack-context.ts runWithRequestStack /
//                                           makeRequestScopedStorageFactory
//   - src/data/per-workspace-repos.ts      PerWorkspaceAssetRepository
//
// Asset/job STACK PERSISTENCE note: stack identity is STRUCTURAL in this
// codebase — each stack has its own CouchDB, and PerWorkspaceAssetRepository
// picks the backing repository from the ambient stack name
// (per-workspace-repos.ts `repo()` -> resolver.resolve(currentRequestStackName())).
// There is no `stackName` field on an asset or job document, so "the asset
// carries the stack" means "the asset was written to that stack's store", which
// is what these tests assert.

import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { PerWorkspaceAssetRepository } from '../src/data/per-workspace-repos.js';
import { WatchFolderService } from '../src/pipeline/watch-folder.js';
import { reconcileWatchFolders } from '../src/services/watch-folder-wiring.js';
import {
  makeRequestScopedStorageFactory,
  runWithRequestStack,
  currentRequestStackName
} from '../src/services/request-stack-context.js';
import type {
  WorkspaceConnections,
  WorkspaceStackResolver
} from '../src/services/workspace-stack.js';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

// Every provisioned stack's source bucket carries the SAME literal name
// (src/routes/provision.ts), which is what made the mis-wiring silent.
const SOURCE_BUCKET = 'openvideocore-source';

// Minimal fake MinIO client for one stack's bucket contents.
function fakeClient(stack: string, objects: string[]) {
  return {
    stack,
    listObjectsV2: () => {
      const stream = new EventEmitter();
      queueMicrotask(() => {
        for (const name of objects) stream.emit('data', { name });
        stream.emit('end');
      });
      return stream;
    }
  } as unknown as import('minio').Client;
}

type Stack = {
  name: string;
  assets: InMemoryAssetRepository;
  storage: { stack: string };
  client: import('minio').Client;
  connections: WorkspaceConnections;
};

function makeStack(name: string, objects: string[]): Stack {
  const assets = new InMemoryAssetRepository();
  const storage = { stack: name };
  const client = fakeClient(name, objects);
  const connections = {
    assets,
    storageFor: () => storage,
    storageClient: client,
    sourceBucket: SOURCE_BUCKET,
    packagedBucket: 'openvideocore-packaged',
    stackName: name
  } as unknown as WorkspaceConnections;
  return { name, assets, storage, client, connections };
}

type Harness = {
  stacks: Record<string, Stack>;
  // Watchers reconciled into the registry, keyed exactly as main.ts keys them.
  registry: Map<string, WatchFolderService>;
  // Every onObjectStored call, with the stack identity ambient at the time and
  // the storage handle the request-scoped factory resolved for it.
  ingested: Array<{ assetId: string; objectKey: string; stack?: string; storage: unknown }>;
  resolveCalls: Array<string | undefined>;
};

// Wire one watcher per stack, exactly as src/main.ts wireWatchFolderFromStack
// does (same reconciler, same runInStackContext closure, same repository and
// onObjectStored wiring).
async function wire(bucketsByStack: Record<string, string[]>): Promise<Harness> {
  const names = Object.keys(bucketsByStack);
  const stacks: Record<string, Stack> = {};
  for (const n of names) stacks[n] = makeStack(n, bucketsByStack[n]!);

  // Resolver stub keyed exactly like WorkspaceStackResolver: a known name wins
  // verbatim; no name (or an unknown one) falls back to the FIRST listed stack.
  const pick = (requested?: string): Stack =>
    (requested && stacks[requested]) || stacks[names[0]!]!;
  const resolveCalls: Array<string | undefined> = [];
  const resolver = {
    listStackNames: async () => names,
    resolve: async (stackName?: string) => {
      resolveCalls.push(stackName);
      return pick(stackName).connections;
    },
    resolveCached: (stackName?: string) => pick(stackName).connections
  } as unknown as WorkspaceStackResolver;

  const storageFor = makeRequestScopedStorageFactory(resolver);
  const ingested: Harness['ingested'] = [];
  const onObjectStored = (assetId: string, objectKey: string) => {
    const stack = currentRequestStackName();
    ingested.push({
      assetId,
      objectKey,
      ...(stack !== undefined ? { stack } : {}),
      storage: storageFor()
    });
  };

  const assetRepository = new PerWorkspaceAssetRepository(resolver);
  const registry = new Map<string, WatchFolderService>();

  await reconcileWatchFolders({
    listStackNames: () => resolver.listStackNames(),
    resolveStack: (stackName) => resolver.resolve(stackName),
    registry,
    log: silentLog,
    createWatchFolder: ({ stackName, client, bucket }) =>
      new WatchFolderService({
        client,
        bucket,
        repository: assetRepository,
        log: silentLog,
        onObjectStored,
        runInStackContext: (fn) =>
          runWithRequestStack(stackName, async () => {
            await resolver.resolve(stackName);
            return fn();
          }),
        // Polling is driven by start()'s initial scan only; the periodic timer
        // is stubbed out so the test is deterministic.
        setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
        clearIntervalFn: () => {}
      })
  });

  return { stacks, registry, ingested, resolveCalls };
}

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('condition not met in time');
}

describe('watch-folder ingest per provisioned stack (issue #1099)', () => {
  it('ingests a file dropped for stack B into stack B, not the first-listed stack', async () => {
    const h = await wire({ a: ['from-a.mp4'], b: ['from-b.mp4'] });

    await waitFor(() => h.ingested.length === 2);

    const a = await h.stacks['a']!.assets.list();
    const b = await h.stacks['b']!.assets.list();

    expect(a.items.map((i) => i.objectKey)).toEqual(['from-a.mp4']);
    // The bug: this landed in stack 'a' (or was never ingested at all).
    expect(b.items.map((i) => i.objectKey)).toEqual(['from-b.mp4']);

    // Both assets reached `processing` in their own stack's store, so the
    // follow-up update() also resolved the right stack.
    expect(b.items[0]!.status).toBe('processing');
  });

  it('runs each ingest inside its own stack context, so the follow-on work uses that stack', async () => {
    const h = await wire({ a: ['from-a.mp4'], b: ['from-b.mp4'] });
    await waitFor(() => h.ingested.length === 2);

    const forB = h.ingested.find((i) => i.objectKey === 'from-b.mp4');
    expect(forB?.stack).toBe('b');
    // The fire-and-forget continuation (ffprobe/thumbnails in main.ts) resolves
    // storage through the request-scoped factory, so it must get stack B's
    // object store — not the default stack's.
    expect(forB?.storage).toBe(h.stacks['b']!.storage);

    const forA = h.ingested.find((i) => i.objectKey === 'from-a.mp4');
    expect(forA?.stack).toBe('a');
    expect(forA?.storage).toBe(h.stacks['a']!.storage);
  });

  it('wires one watcher per stack, each against that stack own storage client (resolved by name)', async () => {
    const h = await wire({ a: ['from-a.mp4'], b: ['from-b.mp4'] });

    expect([...h.registry.keys()]).toEqual(['a', 'b']);
    expect(h.registry.get('a')!.isRunning()).toBe(true);
    expect(h.registry.get('b')!.isRunning()).toBe(true);
    // Resolved by NAME for both stacks — the no-name resolve() that only ever
    // reached the first listed stack is gone.
    expect(h.resolveCalls).toContain('a');
    expect(h.resolveCalls).toContain('b');
    expect(h.resolveCalls).not.toContain(undefined);
  });

  it('single-stack install: one watcher, ingest lands in that stack', async () => {
    const h = await wire({ mystack: ['drop.mp4'] });
    await waitFor(() => h.ingested.length === 1);

    expect([...h.registry.keys()]).toEqual(['mystack']);
    const { items } = await h.stacks['mystack']!.assets.list();
    expect(items.map((i) => i.objectKey)).toEqual(['drop.mp4']);
    expect(h.ingested[0]!.stack).toBe('mystack');
  });

  it('does not double-ingest: each stack watcher only sees its own bucket', async () => {
    // Both stacks' buckets contain a key with the SAME name — the realistic
    // case, since both buckets are literally named `openvideocore-source`. Each
    // watcher must create exactly one asset, in its own stack.
    const h = await wire({ a: ['clip.mp4'], b: ['clip.mp4'] });
    await waitFor(() => h.ingested.length === 2);

    const a = await h.stacks['a']!.assets.list();
    const b = await h.stacks['b']!.assets.list();
    expect(a.items).toHaveLength(1);
    expect(b.items).toHaveLength(1);
    expect(a.items[0]!.id).not.toBe(b.items[0]!.id);
  });

  it('a second reconcile keeps the running watchers and re-ingests nothing', async () => {
    const h = await wire({ a: ['from-a.mp4'], b: ['from-b.mp4'] });
    await waitFor(() => h.ingested.length === 2);

    const before = [h.registry.get('a'), h.registry.get('b')];
    await reconcileWatchFolders({
      listStackNames: async () => ['a', 'b'],
      resolveStack: async (stackName) =>
        h.stacks[stackName ?? 'a']!.connections,
      registry: h.registry,
      log: silentLog,
      createWatchFolder: () => {
        throw new Error('must not rebuild a healthy watcher');
      }
    });

    expect([h.registry.get('a'), h.registry.get('b')]).toEqual(before);
    expect(h.ingested).toHaveLength(2);
  });

  it('leaves the pre-#1099 default-stack behaviour intact when no stacks are listed', async () => {
    // No parameter store / env-override run: listStackNames() is empty, so a
    // single watcher is wired on the DEFAULT resolution with no ambient stack
    // name — byte-for-byte the old behaviour.
    const assets = new InMemoryAssetRepository();
    const storage = { stack: 'default' };
    const connections = {
      assets,
      storageFor: () => storage,
      storageClient: fakeClient('default', ['drop.mp4']),
      sourceBucket: SOURCE_BUCKET,
      packagedBucket: 'openvideocore-packaged',
      stackName: undefined
    } as unknown as WorkspaceConnections;
    const resolve = vi.fn(async () => connections);
    const resolver = {
      listStackNames: async () => [],
      resolve,
      resolveCached: () => connections
    } as unknown as WorkspaceStackResolver;

    const seen: Array<string | undefined> = [];
    const registry = new Map<string, WatchFolderService>();
    await reconcileWatchFolders({
      listStackNames: () => resolver.listStackNames(),
      resolveStack: (stackName) => resolver.resolve(stackName),
      registry,
      log: silentLog,
      createWatchFolder: ({ stackName, client, bucket }) =>
        new WatchFolderService({
          client,
          bucket,
          repository: new PerWorkspaceAssetRepository(resolver),
          log: silentLog,
          onObjectStored: () => seen.push(currentRequestStackName()),
          runInStackContext: (fn) =>
            runWithRequestStack(stackName, async () => {
              await resolver.resolve(stackName);
              return fn();
            }),
          setIntervalFn: () => 0 as unknown as ReturnType<typeof setInterval>,
          clearIntervalFn: () => {}
        })
    });

    await waitFor(() => seen.length === 1);
    expect([...registry.keys()]).toEqual(['']);
    expect(seen).toEqual([undefined]);
    expect(resolve).toHaveBeenCalledWith(undefined);
    const { items } = await assets.list();
    expect(items.map((i) => i.objectKey)).toEqual(['drop.mp4']);
  });
});
