// Per-stack watch-folder wiring tests (issue #1099).
//
// Contract under test: services/watch-folder-wiring.ts `reconcileWatchFolders`,
// driven with stub `listStackNames` / `resolveStack` callbacks shaped after
// WorkspaceStackResolver.listStackNames() (services/workspace-stack.ts:1186) and
// WorkspaceStackResolver.resolve(stackName) (same file, `resolve()`), so no
// MinIO/CouchDB client is constructed.
//
// Acceptance criteria covered:
//   - a two-stack installation gets ONE watcher per stack, each on its own
//     client + bucket (the bug: only the first listed stack was ever wired)
//   - single-stack behaviour is unchanged (one watcher, keyed to that stack)
//   - no stacks listed at all -> one default-context watcher (pre-#1099 path)

import { describe, it, expect, vi } from 'vitest';
import type { Client as MinioClient } from 'minio';
import {
  reconcileWatchFolders,
  stackRegistryKey,
  DEFAULT_STACK_KEY,
  type StackStorageConnections,
  type WatchFolderHandle
} from './watch-folder-wiring.js';

const silentLog = { info: () => {}, warn: () => {}, error: () => {} };

// A watcher double recording the client + bucket it was built against and its
// start/stop lifecycle.
type FakeWatcher = WatchFolderHandle & {
  stackName: string | undefined;
  client: MinioClient;
  bucket: string;
  starts: number;
  stops: number;
};

function fakeWatcherFactory() {
  const created: FakeWatcher[] = [];
  const create = (stack: {
    stackName?: string | undefined;
    client: MinioClient;
    bucket: string;
  }): FakeWatcher => {
    const watcher: FakeWatcher = {
      stackName: stack.stackName,
      client: stack.client,
      bucket: stack.bucket,
      starts: 0,
      stops: 0,
      currentBucket: () => watcher.bucket,
      isRunning: () => watcher.starts > watcher.stops,
      start: () => {
        watcher.starts += 1;
      },
      stop: () => {
        if (watcher.starts > watcher.stops) watcher.stops += 1;
      }
    };
    created.push(watcher);
    return watcher;
  };
  return { create, created };
}

// A distinct MinioClient identity per stack: on OSC every stack has its OWN
// object-storage instance, while every stack's source bucket carries the SAME
// literal name (workspace-stack.ts `sourceBucket` default), which is exactly why
// the pre-#1099 "same bucket => already wired" check could not notice the
// missing stacks.
function stackConns(tag: string, bucket = 'openvideocore-source'): StackStorageConnections {
  return {
    storageClient: { tag } as unknown as MinioClient,
    sourceBucket: bucket
  };
}

describe('reconcileWatchFolders', () => {
  it('wires one watcher per provisioned stack, each on its own stack client', async () => {
    const registry = new Map<string, FakeWatcher>();
    const { create, created } = fakeWatcherFactory();
    const resolveStack = vi.fn(async (name?: string) => stackConns(`client-${name}`));

    const result = await reconcileWatchFolders({
      listStackNames: async () => ['stack-a', 'stack-b'],
      resolveStack,
      createWatchFolder: create,
      registry,
      log: silentLog
    });

    expect([...registry.keys()]).toEqual(['stack-a', 'stack-b']);
    expect(created.map((w) => w.stackName)).toEqual(['stack-a', 'stack-b']);
    expect(created.every((w) => w.isRunning())).toBe(true);
    // Resolved BY NAME, never with the no-name default that returns the first
    // listed stack.
    expect(resolveStack.mock.calls).toEqual([['stack-a'], ['stack-b']]);
    expect(created[0]!.client).not.toBe(created[1]!.client);
    // The default binding main.ts keeps for the admin/storage routers is the
    // first listed stack's watcher.
    expect(result.defaultWatchFolder).toBe(created[0]);
    expect(result.stackKeys).toEqual(['stack-a', 'stack-b']);
  });

  it('is idempotent: a second reconcile creates no new watchers', async () => {
    const registry = new Map<string, FakeWatcher>();
    const { create, created } = fakeWatcherFactory();
    const opts = {
      listStackNames: async () => ['stack-a', 'stack-b'],
      resolveStack: async (name?: string) => stackConns(`client-${name}`),
      createWatchFolder: create,
      registry,
      log: silentLog
    };

    await reconcileWatchFolders(opts);
    await reconcileWatchFolders(opts);

    expect(created).toHaveLength(2);
    expect(created.map((w) => w.starts)).toEqual([1, 1]);
  });

  it('single stack: one watcher keyed to that stack, started once', async () => {
    const registry = new Map<string, FakeWatcher>();
    const { create, created } = fakeWatcherFactory();

    const result = await reconcileWatchFolders({
      listStackNames: async () => ['mystack'],
      resolveStack: async () => stackConns('client-mystack'),
      createWatchFolder: create,
      registry,
      log: silentLog
    });

    expect([...registry.keys()]).toEqual(['mystack']);
    expect(created).toHaveLength(1);
    expect(created[0]!.starts).toBe(1);
    expect(result.defaultWatchFolder).toBe(created[0]);
  });

  it('no stacks listed: falls back to a single default-context watcher', async () => {
    const registry = new Map<string, FakeWatcher>();
    const { create, created } = fakeWatcherFactory();

    const result = await reconcileWatchFolders({
      listStackNames: async () => [],
      resolveStack: async (name?: string) => {
        expect(name).toBeUndefined();
        return stackConns('env-client');
      },
      createWatchFolder: create,
      registry,
      log: silentLog
    });

    expect([...registry.keys()]).toEqual([DEFAULT_STACK_KEY]);
    expect(created[0]!.stackName).toBeUndefined();
    expect(result.defaultWatchFolder).toBe(created[0]);
  });

  it('rewires a stack whose source bucket changed, leaving the others alone', async () => {
    const registry = new Map<string, FakeWatcher>();
    const { create, created } = fakeWatcherFactory();
    let bucketB = 'bucket-b';
    const opts = {
      listStackNames: async () => ['stack-a', 'stack-b'],
      resolveStack: async (name?: string) =>
        stackConns(`client-${name}`, name === 'stack-b' ? bucketB : 'bucket-a'),
      createWatchFolder: create,
      registry,
      log: silentLog
    };

    await reconcileWatchFolders(opts);
    bucketB = 'bucket-b2';
    await reconcileWatchFolders(opts);

    expect(created).toHaveLength(3);
    // stack-a untouched, stack-b stopped and replaced.
    expect(created[0]!.stops).toBe(0);
    expect(created[1]!.stops).toBe(1);
    expect(registry.get('stack-b')).toBe(created[2]);
    expect(created[2]!.bucket).toBe('bucket-b2');
  });

  it('stops and drops the watcher for a stack that was torn down', async () => {
    const registry = new Map<string, FakeWatcher>();
    const { create, created } = fakeWatcherFactory();
    let names = ['stack-a', 'stack-b'];

    await reconcileWatchFolders({
      listStackNames: async () => names,
      resolveStack: async (name?: string) => stackConns(`client-${name}`),
      createWatchFolder: create,
      registry,
      log: silentLog
    });
    names = ['stack-a'];
    await reconcileWatchFolders({
      listStackNames: async () => names,
      resolveStack: async (name?: string) => stackConns(`client-${name}`),
      createWatchFolder: create,
      registry,
      log: silentLog
    });

    expect([...registry.keys()]).toEqual(['stack-a']);
    expect(created[1]!.stops).toBe(1);
    expect(created[1]!.isRunning()).toBe(false);
    expect(created[0]!.isRunning()).toBe(true);
  });

  it('keeps existing watchers when the stack list comes back empty', async () => {
    // listStackNames() reports a parameter-store READ FAILURE as [] rather than
    // throwing (workspace-stack.ts:1186), so an empty list must not be read as
    // "every stack was torn down" once watchers exist.
    const registry = new Map<string, FakeWatcher>();
    const { create, created } = fakeWatcherFactory();
    let names = ['stack-a', 'stack-b'];

    await reconcileWatchFolders({
      listStackNames: async () => names,
      resolveStack: async (name?: string) => stackConns(`client-${name}`),
      createWatchFolder: create,
      registry,
      log: silentLog
    });
    names = [];
    const result = await reconcileWatchFolders({
      listStackNames: async () => names,
      resolveStack: async (name?: string) => stackConns(`client-${name}`),
      createWatchFolder: create,
      registry,
      log: silentLog
    });

    expect([...registry.keys()]).toEqual(['stack-a', 'stack-b']);
    expect(created).toHaveLength(2);
    expect(created.every((w) => w.isRunning())).toBe(true);
    expect(result.defaultWatchFolder).toBeUndefined();
  });

  it('one stack failing to resolve does not stop the others being wired', async () => {
    const registry = new Map<string, FakeWatcher>();
    const { create, created } = fakeWatcherFactory();

    await reconcileWatchFolders({
      listStackNames: async () => ['stack-a', 'stack-b'],
      resolveStack: async (name?: string) => {
        if (name === 'stack-a') throw new Error('parameter store unreachable');
        return stackConns('client-b');
      },
      createWatchFolder: create,
      registry,
      log: silentLog
    });

    expect([...registry.keys()]).toEqual(['stack-b']);
    expect(created).toHaveLength(1);
    expect(created[0]!.stackName).toBe('stack-b');
  });

  it('skips a stack with no object storage yet', async () => {
    const registry = new Map<string, FakeWatcher>();
    const { create, created } = fakeWatcherFactory();

    await reconcileWatchFolders({
      listStackNames: async () => ['stack-a', 'stack-b'],
      resolveStack: async (name?: string) =>
        name === 'stack-a'
          ? { storageClient: undefined, sourceBucket: 'openvideocore-source' }
          : stackConns('client-b'),
      createWatchFolder: create,
      registry,
      log: silentLog
    });

    expect([...registry.keys()]).toEqual(['stack-b']);
    expect(created).toHaveLength(1);
  });

  it('keys the default (unnamed) resolution under the resolver cache key', () => {
    expect(stackRegistryKey(undefined)).toBe('');
    expect(stackRegistryKey('stack-a')).toBe('stack-a');
    expect(DEFAULT_STACK_KEY).toBe('');
  });
});
