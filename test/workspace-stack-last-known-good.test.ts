// Issue #420: serve last-known-good stack resolution on a failed param-store
// refresh instead of dropping to no-storage.
//
// Contract sources verified before writing (cite exact symbols):
//   - WorkspaceStackResolver.resolve() / resolveCached() / CacheEntry
//     src/services/workspace-stack.ts (cache is `Map<string, CacheEntry>`;
//     CACHE_TTL_MS = 5*60*1000; MAX_STALE_MS = 60*60*1000).
//   - buildInMemoryConnections() -> storageFor: undefined (no-storage state);
//     buildConnectionsFromStack() -> storageFor: StorageFactory (storage-enabled).
//   - isReadyStack(config) src/services/param-store.ts:102 — status undefined|'ready'.
//   - ParamStore.loadStackConfig / listStackNames interface
//     src/services/param-store.ts:108-125; loadStackConfig returns undefined for
//     a genuine 404 (src/services/param-store.ts:294).
//
// Architect staleness policy implemented (issue body sign-off): last-known-good
// is served only for a prior ready-stack resolution, only within MAX_STALE_MS
// from the original successful resolve, only when the refresh THREW (a
// successful undefined load still drops to no-storage), and never for a
// first-resolve-at-boot or an in-memory/env-override prior entry.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WorkspaceStackResolver,
  STACK_CONFIG_NAMESPACE
} from '../src/services/workspace-stack.js';
import type { ParamStore, StackConfig } from '../src/services/param-store.js';
import type { Context } from '@osaas/client-core';

// A valid, ready stack config with parseable absolute URLs so
// buildConnectionsFromStack returns real (storage-enabled) connections.
const readyConfig: StackConfig = {
  status: 'ready',
  minioEndpoint: 'https://minio.example.osaas.io',
  couchdbUrl: 'https://couch.example.osaas.io',
  redisUrl: 'redis://valkey.example.osaas.io:6379',
  sourceBucket: 'openvideocore-source',
  packagedBucket: 'openvideocore-packaged',
  services: [{ serviceId: 'minio-minio', instanceName: 'mystack' }]
};

const oscContext = {} as unknown as Context;

// The env-override path (buildEnvConnections) wins for ALL workspaces when
// COUCHDB_URL/MINIO_URL are set, so clear them to exercise the param-store path.
function clearEnvOverride() {
  delete process.env['COUCHDB_URL'];
  delete process.env['MINIO_URL'];
}

function makeResolver(store: ParamStore) {
  return new WorkspaceStackResolver({
    paramStore: store,
    oscContext,
    minioPassword: 'minio-pw',
    couchPassword: 'couch-pw'
  });
}

describe('WorkspaceStackResolver last-known-good on failed refresh (#420)', () => {
  beforeEach(() => {
    clearEnvOverride();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) refresh fails with a prior good resolution -> serves cached storage-enabled resolution (no 501)', async () => {
    const loadStackConfig = vi
      .fn<ParamStore['loadStackConfig']>()
      .mockResolvedValueOnce(readyConfig) // first (successful) resolve
      .mockRejectedValue(new Error('param store read failed: 503')); // later refresh throws
    const listStackNames = vi
      .fn<ParamStore['listStackNames']>()
      .mockResolvedValueOnce(['mystack']) // first resolve
      .mockRejectedValue(new Error('param store list failed: 503'));
    const store: ParamStore = {
      loadStackConfig,
      listStackNames,
      storeStackConfig: vi.fn(),
      deleteStackConfig: vi.fn()
    };
    const resolver = makeResolver(store);

    const first = await resolver.resolve();
    expect(first.storageFor).toBeTypeOf('function'); // storage-enabled

    // Advance past CACHE_TTL_MS (5 min) but within MAX_STALE_MS (1h) so the
    // next resolve is a cache-miss that re-fetches and the refresh throws.
    vi.advanceTimersByTime(6 * 60 * 1000);

    const second = await resolver.resolve();
    expect(second.storageFor).toBeTypeOf('function'); // last-known-good, NOT no-storage
    expect(second).toBe(first);
  });

  it('(a2) past MAX_STALE_MS a failed refresh drops to no-storage (no indefinite serving)', async () => {
    const loadStackConfig = vi
      .fn<ParamStore['loadStackConfig']>()
      .mockResolvedValueOnce(readyConfig)
      .mockRejectedValue(new Error('param store read failed: 503'));
    const listStackNames = vi
      .fn<ParamStore['listStackNames']>()
      .mockResolvedValueOnce(['mystack'])
      .mockRejectedValue(new Error('param store list failed: 503'));
    const store: ParamStore = {
      loadStackConfig,
      listStackNames,
      storeStackConfig: vi.fn(),
      deleteStackConfig: vi.fn()
    };
    const resolver = makeResolver(store);

    await resolver.resolve();
    // Advance beyond MAX_STALE_MS (1h) so last-known-good is no longer eligible.
    vi.advanceTimersByTime(61 * 60 * 1000);

    const stale = await resolver.resolve();
    expect(stale.storageFor).toBeUndefined(); // dropped to no-storage
  });

  it('(b) refresh fails with NO prior good resolution -> no-storage (first-resolve-at-boot)', async () => {
    const loadStackConfig = vi
      .fn<ParamStore['loadStackConfig']>()
      .mockRejectedValue(new Error('param store read failed: 503'));
    const listStackNames = vi
      .fn<ParamStore['listStackNames']>()
      .mockRejectedValue(new Error('param store list failed: 503'));
    const store: ParamStore = {
      loadStackConfig,
      listStackNames,
      storeStackConfig: vi.fn(),
      deleteStackConfig: vi.fn()
    };
    const resolver = makeResolver(store);

    const conns = await resolver.resolve();
    expect(conns.storageFor).toBeUndefined(); // no-storage
  });

  it('(b2) a successful load returning undefined (genuine 404) drops to no-storage even with a prior good entry', async () => {
    const loadStackConfig = vi
      .fn<ParamStore['loadStackConfig']>()
      .mockResolvedValueOnce(readyConfig) // first resolve: good
      .mockResolvedValue(undefined); // later: successful 404, stack genuinely gone
    const listStackNames = vi
      .fn<ParamStore['listStackNames']>()
      .mockResolvedValueOnce(['mystack'])
      .mockResolvedValue([]); // no stacks left
    const store: ParamStore = {
      loadStackConfig,
      listStackNames,
      storeStackConfig: vi.fn(),
      deleteStackConfig: vi.fn()
    };
    const resolver = makeResolver(store);

    const first = await resolver.resolve();
    expect(first.storageFor).toBeTypeOf('function');

    vi.advanceTimersByTime(6 * 60 * 1000);
    const second = await resolver.resolve();
    // NOT fabricated from the stale good entry: a successful undefined load
    // means the stack genuinely no longer exists -> no-storage.
    expect(second.storageFor).toBeUndefined();
  });

  it('(c) a successful refresh updates the cache with fresh connections', async () => {
    const secondConfig: StackConfig = {
      ...readyConfig,
      minioEndpoint: 'https://minio2.example.osaas.io'
    };
    const loadStackConfig = vi
      .fn<ParamStore['loadStackConfig']>()
      .mockResolvedValueOnce(readyConfig)
      .mockResolvedValue(secondConfig);
    const listStackNames = vi
      .fn<ParamStore['listStackNames']>()
      .mockResolvedValue(['mystack']);
    const store: ParamStore = {
      loadStackConfig,
      listStackNames,
      storeStackConfig: vi.fn(),
      deleteStackConfig: vi.fn()
    };
    const resolver = makeResolver(store);

    const first = await resolver.resolve();
    expect(first.s3Config?.endpoint).toBe('https://minio.example.osaas.io');

    vi.advanceTimersByTime(6 * 60 * 1000);
    const second = await resolver.resolve();
    expect(second.s3Config?.endpoint).toBe('https://minio2.example.osaas.io');
    expect(second).not.toBe(first);
    expect(loadStackConfig).toHaveBeenCalledTimes(2);
  });
});

// Silence unused import lint if STACK_CONFIG_NAMESPACE is referenced only for
// documentation; keep an explicit assertion so the symbol is exercised.
describe('STACK_CONFIG_NAMESPACE contract', () => {
  it('is the default namespace the resolver reads under', () => {
    expect(STACK_CONFIG_NAMESPACE).toBe('default');
  });
});
