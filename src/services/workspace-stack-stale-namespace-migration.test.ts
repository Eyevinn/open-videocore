import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Coverage for the BOUNDED ONE-SHOT MIGRATION of pre-#804 stack configs
// (issue #804), which replaces the #733/#751 legacy fallback.
//
// The direction is inverted from #733/#751. Those read a DERIVED namespace first
// and fell back to the literal `default`. #804 collapses the middle key segment
// to the constant `default` on BOTH sides, so `default` is now the primary and
// the stale DERIVED namespace a pre-#804 build wrote under is what needs
// adopting — exactly once, then never again.
//
// Why this is bounded rather than an open-ended bridge: the parameter store is a
// single eyevinn-app-config-svc instance per deployment
// (DEFAULT_PARAM_STORE_INSTANCE_NAME = 'ovcconfig', param-store.ts:704) resolved
// through the deployment's own Context (param-store.ts:759), and one deployment
// serves exactly one tenant (ADR-018 "One deployed stack == one tenant's
// workspace"; ADR-020 Decision 1). Each affected store therefore contains
// exactly ONE stale namespace value, never an unbounded set. The removal
// condition is stated in full above `scanStaleNamespacedStacks` in
// src/services/workspace-stack.ts.
//
// Cases:
//   (a) a config present under `default` is a DIRECT hit — the scanner is never
//       consulted, so a post-#804 deployment pays nothing for this fallback;
//   (b) a config present ONLY under a single stale namespace is adopted AND
//       rewritten under `default`, so the fallback is taken at most once;
//   (c) after the rewrite, the next resolve is a direct hit with no scan;
//   (d) SEVERAL stale namespaces => refuses to guess, behaves as a genuine miss,
//       and rewrites nothing;
//   (e) a failing scan is a genuine miss, never a throw on the read path;
//   (f) a failed rewrite still serves the adopted config for this call;
//   (g) keys that merely share the `openvideocore/` prefix but are not stack
//       configs (storage-backend records, `_meta`, non-JSON values) are never
//       mistaken for a stale stack.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - `export const STACK_CONFIG_NAMESPACE = "default"` and
//     `export type StackConfigKeyScanner = { listByPrefix(prefix: string):
//     Promise<Array<{ key: string; value: string }>> }`
//     (src/services/workspace-stack.ts), the latter structurally satisfied by
//     ConfigKvStore.listByPrefix (src/services/param-store.ts:602-608).
//   - WorkspaceStackResolver constructor option `staleNamespaceScanner?` and
//     resolveStackConfig / resolveStackName (src/services/workspace-stack.ts).
//   - ParamStore + stackConfigKey(workspaceId, name) =
//     `openvideocore/{ws}/{name}` (src/services/param-store.ts:108-133).
//   - backendRecordKey layout `openvideocore/storagebackends/{ws}/{id}`
//     (src/services/storage-backend-registry.ts:321) — four segments, which is
//     why the scan requires exactly two after the shared prefix.

vi.mock('@osaas/client-core', () => ({
  listSubscriptions: vi.fn(async () => {
    throw new Error('listSubscriptions must never be called for namespace resolution (#804)');
  }),
  Context: class {}
}));

import {
  WorkspaceStackResolver,
  STACK_CONFIG_NAMESPACE,
  type StackConfigKeyScanner
} from './workspace-stack.js';
import {
  stackConfigKey,
  type ParamStore,
  type StackConfig
} from './param-store.js';
import type { Context } from '@osaas/client-core';
import type { StackResolverLogger } from './workspace-stack.js';

// A namespace value a PRE-#804 build could have derived and written under.
const STALE_NAMESPACE = 'workspace-tenant-a';

const oscContext = {} as unknown as Context;

const SAVED = {
  couch: process.env['COUCHDB_URL'],
  minio: process.env['MINIO_URL']
};
beforeEach(() => {
  delete process.env['COUCHDB_URL'];
  delete process.env['MINIO_URL'];
});
afterEach(() => {
  if (SAVED.couch === undefined) delete process.env['COUCHDB_URL'];
  else process.env['COUCHDB_URL'] = SAVED.couch;
  if (SAVED.minio === undefined) delete process.env['MINIO_URL'];
  else process.env['MINIO_URL'] = SAVED.minio;
  vi.restoreAllMocks();
});

function readyConfig(name: string): StackConfig {
  return {
    status: 'ready',
    minioEndpoint: `https://${name}-minio.example.test`,
    couchdbUrl: `https://${name}-couch.example.test`,
    redisUrl: `redis://${name}-valkey.example.test:6379`,
    sourceBucket: 'openvideocore-source',
    packagedBucket: 'openvideocore-packaged',
    services: []
  };
}

function makeStore() {
  // `extra` carries raw (non-StackConfig) keys so the scan's shape/value guards
  // can be exercised against realistic neighbours in the same key space.
  const byKey = new Map<string, StackConfig>();
  const extra = new Map<string, string>();
  const scanCalls: string[] = [];
  const store: ParamStore = {
    async storeStackConfig(ws, name, config) {
      byKey.set(stackConfigKey(ws, name), config);
    },
    async loadStackConfig(ws, name) {
      return byKey.get(stackConfigKey(ws, name));
    },
    async deleteStackConfig(ws, name) {
      byKey.delete(stackConfigKey(ws, name));
    },
    async listStackNames(ws) {
      const prefix = stackConfigKey(ws, '');
      return [...byKey.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    }
  };
  const scanner: StackConfigKeyScanner = {
    async listByPrefix(prefix) {
      scanCalls.push(prefix);
      const fromConfigs = [...byKey.entries()].map(
        ([key, value]) => ({ key, value: JSON.stringify(value) })
      );
      const fromExtra = [...extra.entries()].map(([key, value]) => ({ key, value }));
      return [...fromConfigs, ...fromExtra].filter((e) => e.key.startsWith(prefix));
    }
  };
  return { store, scanner, scanCalls, extra, keys: () => [...byKey.keys()] };
}

function makeResolver(
  paramStore: ParamStore,
  scanner?: StackConfigKeyScanner,
  log?: StackResolverLogger
): WorkspaceStackResolver {
  return new WorkspaceStackResolver({
    paramStore,
    oscContext,
    minioPassword: 'not-used',
    couchPassword: 'not-used',
    ...(scanner ? { staleNamespaceScanner: scanner } : {}),
    ...(log ? { log } : {})
  });
}

describe('pre-#804 stale-namespace migration', () => {
  it('takes NO scan at all when the config is already under the constant namespace', async () => {
    const { store, scanner, scanCalls } = makeStore();
    await store.storeStackConfig(STACK_CONFIG_NAMESPACE, 'mediastack', readyConfig('current'));

    const resolver = makeResolver(store, scanner);
    const config = await resolver.resolveStackConfig('mediastack');

    expect(config?.minioEndpoint).toBe('https://current-minio.example.test');
    expect(scanCalls).toEqual([]);
  });

  it('adopts a config that exists ONLY under a single stale namespace and rewrites it under the constant', async () => {
    const { store, scanner, keys } = makeStore();
    await store.storeStackConfig(STALE_NAMESPACE, 'mediastack', readyConfig('adopted'));
    expect(STALE_NAMESPACE).not.toBe(STACK_CONFIG_NAMESPACE);

    const resolver = makeResolver(store, scanner);
    const config = await resolver.resolveStackConfig('mediastack');

    expect(config?.minioEndpoint).toBe('https://adopted-minio.example.test');
    // The rewrite landed under the constant. The stale key is left in place —
    // the migration converges reads, it does not delete history.
    expect(keys()).toContain(stackConfigKey(STACK_CONFIG_NAMESPACE, 'mediastack'));
    expect(keys()).toContain(stackConfigKey(STALE_NAMESPACE, 'mediastack'));
  });

  it('is ONE-SHOT: the next resolve is a direct hit and does not scan again', async () => {
    const { store, scanner, scanCalls } = makeStore();
    await store.storeStackConfig(STALE_NAMESPACE, 'mediastack', readyConfig('adopted'));

    const resolver = makeResolver(store, scanner);
    await resolver.resolveStackConfig('mediastack');
    const scansAfterFirst = scanCalls.length;
    expect(scansAfterFirst).toBeGreaterThan(0);

    await resolver.resolveStackConfig('mediastack');
    expect(scanCalls.length).toBe(scansAfterFirst);
  });

  it('finds a stale stack via the LIST path too (no stack name requested)', async () => {
    const { store, scanner, keys } = makeStore();
    await store.storeStackConfig(STALE_NAMESPACE, 'mediastack', readyConfig('adopted'));

    const resolver = makeResolver(store, scanner);
    expect(await resolver.resolveStackName()).toBe('mediastack');
    expect(keys()).toContain(stackConfigKey(STACK_CONFIG_NAMESPACE, 'mediastack'));
  });

  it('refuses to guess when SEVERAL stale namespaces hold the same stack name', async () => {
    const { store, scanner, keys } = makeStore();
    await store.storeStackConfig('tenant-one', 'mediastack', readyConfig('one'));
    await store.storeStackConfig('tenant-two', 'mediastack', readyConfig('two'));

    const warn = vi.fn();
    const resolver = makeResolver(store, scanner, {
      info: vi.fn(),
      warn,
      error: vi.fn()
    });

    expect(await resolver.resolveStackConfig('mediastack')).toBeUndefined();
    expect(keys()).not.toContain(stackConfigKey(STACK_CONFIG_NAMESPACE, 'mediastack'));
    // Ambiguity is surfaced, not swallowed.
    expect(warn).toHaveBeenCalled();
  });

  it('treats a failing scan as a genuine miss rather than throwing on the read path', async () => {
    const { store } = makeStore();
    const failingScanner: StackConfigKeyScanner = {
      async listByPrefix() {
        throw new Error('config service unreachable');
      }
    };

    const warn = vi.fn();
    const resolver = makeResolver(store, failingScanner, {
      info: vi.fn(),
      warn,
      error: vi.fn()
    });

    await expect(resolver.resolveStackConfig('mediastack')).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
  });

  it('still serves the adopted config for this call when the rewrite fails', async () => {
    const { store, scanner } = makeStore();
    await store.storeStackConfig(STALE_NAMESPACE, 'mediastack', readyConfig('adopted'));
    const writeFails: ParamStore = {
      ...store,
      async storeStackConfig() {
        throw new Error('parameter store write rejected');
      }
    };

    const warn = vi.fn();
    const resolver = makeResolver(writeFails, scanner, {
      info: vi.fn(),
      warn,
      error: vi.fn()
    });

    const config = await resolver.resolveStackConfig('mediastack');
    expect(config?.minioEndpoint).toBe('https://adopted-minio.example.test');
    expect(warn).toHaveBeenCalled();
  });

  it('never mistakes a non-stack key sharing the openvideocore/ prefix for a stale namespace', async () => {
    const { store, scanner, extra, keys } = makeStore();
    // Four-segment storage-backend record (storage-backend-registry.ts:321).
    extra.set(
      'openvideocore/storagebackends/workspace-tenant-a/backend-1',
      JSON.stringify({ id: 'backend-1', bucket: 'b' })
    );
    // Reserved metadata segment.
    extra.set('openvideocore/_meta/something', 'anything');
    // Right shape, wrong value: not a StackConfig.
    extra.set('openvideocore/tenant-x/notastack', JSON.stringify({ hello: 'world' }));
    // Right shape, not even JSON.
    extra.set('openvideocore/tenant-y/garbage', 'not json at all');

    const resolver = makeResolver(store, scanner);

    expect(await resolver.resolveStackName()).toBeUndefined();
    expect(await resolver.resolveStackConfig('notastack')).toBeUndefined();
    expect(keys()).toEqual([]);
  });

  it('does nothing at all when no scanner is wired (a miss stays a miss)', async () => {
    const { store } = makeStore();
    await store.storeStackConfig(STALE_NAMESPACE, 'mediastack', readyConfig('adopted'));

    const resolver = makeResolver(store);
    expect(await resolver.resolveStackConfig('mediastack')).toBeUndefined();
    expect(await resolver.resolveStackName()).toBeUndefined();
  });
});
