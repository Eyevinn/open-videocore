import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Unit coverage for issue #733: the read-side legacy-namespace fallback in
// WorkspaceStackResolver.
//
// Before #712 every stack was written under the fixed literal `default`
// namespace. #712 moved BOTH sides of the read/write contract onto the
// tenant-scoped namespace derived from deriveWorkspaceId -> listSubscriptions.
// A stack provisioned before #712 therefore lives only under `default/` and
// would be invisible to a resolver that now derives a real tenant id. #733 adds
// a ONE-SHOT read-side fallback (loadStackConfigWithLegacyFallback /
// listStackNamesWithLegacyFallback) that reads the literal `default` namespace
// when the tenant-scoped read misses, and migrates the hit onto the tenant key.
//
// These are the four #733 acceptance cases:
//   (a) a config written under the legacy `default` namespace resolves when read
//       under a tenant id (fallback),
//   (b) it is migrated to the tenant key on read,
//   (c) tenant A cannot read tenant B's config via the fallback (the fallback
//       reads ONLY the literal `default` namespace),
//   (d) a post-#712 stack (namespace === STACK_CONFIG_NAMESPACE) takes NO
//       fallback read.
//
// The two fallback helpers are private, so — matching the existing convention in
// provision-resolver-namespace.integration.test.ts and
// workspace-stack-resolver-logging.test.ts — they are exercised through the
// public resolve()/resolveStackName() surface that calls them.

const TENANT_A = 'workspace-tenant-a';
const TENANT_B = 'workspace-tenant-b';

// Mock @osaas/client-core so deriveWorkspaceId derives a controllable tenant id
// from the Context. Subscription = { serviceId, tenantId } per
// @osaas/client-core admin.d.ts:2-5 (cited in workspace-stack.ts:395-397). The
// implementation is reprogrammed per test to switch the derived namespace
// between a real tenant (TENANT_A) and the literal `default` fallback (empty
// subscription list -> deriveWorkspaceId returns STACK_CONFIG_NAMESPACE,
// workspace-stack.ts:411).
vi.mock('@osaas/client-core', () => ({
  listSubscriptions: vi.fn(async () => [
    { serviceId: 'minio-minio', tenantId: TENANT_A }
  ]),
  Context: class {}
}));

import {
  WorkspaceStackResolver,
  deriveWorkspaceId,
  STACK_CONFIG_NAMESPACE,
  type StackResolverLogger
} from './workspace-stack.js';
import {
  stackConfigKey,
  isReadyStack,
  type ParamStore,
  type StackConfig
} from './param-store.js';
import { listSubscriptions, type Context } from '@osaas/client-core';

const mockedListSubscriptions = vi.mocked(listSubscriptions);

// The deployment's own authenticated Context. deriveWorkspaceId reads its tenant
// via the mocked listSubscriptions above; a bare stub is sufficient.
const oscContext = {} as unknown as Context;

// Ensure the resolver takes the parameter-store path (not the env override,
// buildEnvConnections, workspace-stack.ts:264-267).
const SAVED = {
  couch: process.env['COUCHDB_URL'],
  minio: process.env['MINIO_URL']
};
beforeEach(() => {
  delete process.env['COUCHDB_URL'];
  delete process.env['MINIO_URL'];
  // Default: a real, non-'default' tenant on both reads.
  mockedListSubscriptions.mockImplementation(async () => [
    { serviceId: 'minio-minio', tenantId: TENANT_A }
  ]);
});
afterEach(() => {
  if (SAVED.couch === undefined) delete process.env['COUCHDB_URL'];
  else process.env['COUCHDB_URL'] = SAVED.couch;
  if (SAVED.minio === undefined) delete process.env['MINIO_URL'];
  else process.env['MINIO_URL'] = SAVED.minio;
  vi.restoreAllMocks();
});

// A ready stack config (StackConfig, param-store.ts:52-95) with valid absolute
// URLs so buildConnectionsFromStack builds real connections (isValidUrl /
// isReadyStack gates, workspace-stack.ts:156-165,178,677-680).
function readyConfig(host: string): StackConfig {
  return {
    status: 'ready',
    minioEndpoint: `https://${host}-minio.example.test`,
    couchdbUrl: `https://${host}-couch.example.test`,
    redisUrl: `redis://${host}-valkey.example.test:6379`,
    sourceBucket: 'openvideocore-source',
    packagedBucket: 'openvideocore-packaged',
    services: []
  };
}

// Namespace-AWARE in-memory ParamStore keyed by the SAME physical key the real
// store uses (stackConfigKey(workspaceId, name), param-store.ts:131), so a
// write under one namespace is only listed/loaded when read under that SAME
// namespace — exactly like the HTTP store. Insertion order is preserved so
// listStackNames returns first-provisioned first.
function makeNamespacedParamStore(): {
  store: ParamStore;
  keys: () => string[];
} {
  const byKey = new Map<string, StackConfig>();
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
  return { store, keys: () => [...byKey.keys()] };
}

function makeLog(): StackResolverLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// Read a logger method back as a vitest Mock for call assertions — mirrors the
// cast convention in workspace-stack-resolver-logging.test.ts.
function asMock(fn: StackResolverLogger['info']): ReturnType<typeof vi.fn> {
  return fn as unknown as ReturnType<typeof vi.fn>;
}

describe('WorkspaceStackResolver legacy-namespace fallback (issue #733)', () => {
  it('(a) resolves a config written under the legacy `default` namespace when read under a tenant id', async () => {
    const { store } = makeNamespacedParamStore();
    // Pre-#712 write: the stack lives ONLY under the literal `default` namespace.
    await store.storeStackConfig(STACK_CONFIG_NAMESPACE, 'legacy', readyConfig('legacy'));

    // Sanity: the resolver derives the real tenant, NOT 'default'
    // (workspace-stack.ts:403-415), so the direct tenant-scoped read misses.
    expect(await deriveWorkspaceId(oscContext)).toBe(TENANT_A);

    const resolver = new WorkspaceStackResolver({
      paramStore: store,
      oscContext,
      minioPassword: 'pw',
      couchPassword: 'pw',
      log: makeLog()
    });

    // resolveStackName('legacy') -> loadStackConfigWithLegacyFallback: tenant
    // miss then `default` hit (workspace-stack.ts:486-513). The requested name
    // resolves verbatim (workspace-stack.ts:730-744).
    expect(await resolver.resolveStackName('legacy')).toBe('legacy');
    // The workspace-default path (no X-Stack-Name) reaches the same stack via
    // listStackNamesWithLegacyFallback -> `default` listing
    // (workspace-stack.ts:524-532).
    expect(await resolver.resolveStackName(undefined)).toBe('legacy');

    // resolve() builds REAL connections from the legacy-namespaced config, not
    // the no-storage in-memory fallback (workspace-stack.ts:677-692).
    const conns = await resolver.resolve('legacy');
    expect(isReadyStack(readyConfig('legacy'))).toBe(true);
    expect(conns.storageFor).toBeDefined();
    expect(conns.storageClient).toBeDefined();
    expect(conns.s3Config?.endpoint).toBe('https://legacy-minio.example.test');
  });

  it('(b) migrates the legacy config onto the tenant-scoped key on read (migrate-on-read)', async () => {
    const { store, keys } = makeNamespacedParamStore();
    await store.storeStackConfig(STACK_CONFIG_NAMESPACE, 'legacy', readyConfig('legacy'));
    // Before the read the config exists ONLY under `default`.
    expect(keys()).toEqual([stackConfigKey(STACK_CONFIG_NAMESPACE, 'legacy')]);

    const log = makeLog();
    const resolver = new WorkspaceStackResolver({
      paramStore: store,
      oscContext,
      minioPassword: 'pw',
      couchPassword: 'pw',
      log
    });

    await resolver.resolveStackName('legacy');

    // Migrate-on-read wrote the config to the tenant-scoped key
    // (workspace-stack.ts:495) and logged the migration at info
    // (workspace-stack.ts:496-499).
    expect(keys()).toContain(stackConfigKey(TENANT_A, 'legacy'));
    expect(asMock(log.info)).toHaveBeenCalledWith(
      expect.objectContaining({
        op: 'migrateStackConfig',
        from: STACK_CONFIG_NAMESPACE,
        to: TENANT_A,
        name: 'legacy'
      }),
      expect.any(String)
    );
    // The legacy `default` copy is left in place (only storeStackConfig(namespace,...)
    // is issued), so both keys resolve after migration (reviewer note; robust to
    // deriveWorkspaceId instability).
    expect(keys()).toContain(stackConfigKey(STACK_CONFIG_NAMESPACE, 'legacy'));

    // Re-read: it is now a DIRECT tenant-scoped hit, so the fallback branch is
    // not taken again (no second migrate log).
    asMock(log.info).mockClear();
    const raw = await store.loadStackConfig(TENANT_A, 'legacy');
    expect(raw).toBeDefined();
    expect(await resolver.resolveStackName('legacy')).toBe('legacy');
    expect(asMock(log.info)).not.toHaveBeenCalledWith(
      expect.objectContaining({ op: 'migrateStackConfig' }),
      expect.any(String)
    );
  });

  it('(c) tenant A cannot read tenant B\'s config via the fallback — fallback reads ONLY the literal `default` namespace', async () => {
    const { store } = makeNamespacedParamStore();
    // Tenant B's config lives under B's OWN namespace, never under `default`.
    await store.storeStackConfig(TENANT_B, 'secret', readyConfig('secret'));

    // The resolver derives tenant A.
    expect(await deriveWorkspaceId(oscContext)).toBe(TENANT_A);

    const resolver = new WorkspaceStackResolver({
      paramStore: store,
      oscContext,
      minioPassword: 'pw',
      couchPassword: 'pw',
      log: makeLog()
    });

    // The fallback only ever re-reads STACK_CONFIG_NAMESPACE (`default`,
    // workspace-stack.ts:492,531), so tenant A's read never sees tenant B's
    // config: the requested name does not resolve, the default path lists
    // nothing, and no cross-tenant coordinates leak into the connections.
    expect(await resolver.resolveStackName('secret')).toBeUndefined();
    expect(await resolver.resolveStackName(undefined)).toBeUndefined();

    const conns = await resolver.resolve('secret');
    expect(conns.storageFor).toBeUndefined();
    expect(conns.storageClient).toBeUndefined();
    expect(conns.s3Config).toBeUndefined();
  });

  it('(d) a post-#712 stack (namespace === default) takes NO fallback read', async () => {
    // Empty subscription list -> deriveWorkspaceId falls back to
    // STACK_CONFIG_NAMESPACE (workspace-stack.ts:406-411), so the derived
    // namespace IS the literal `default` — a post-#712 stack whose own namespace
    // equals the legacy one.
    mockedListSubscriptions.mockImplementation(async () => []);
    expect(await deriveWorkspaceId(oscContext)).toBe(STACK_CONFIG_NAMESPACE);

    const { store } = makeNamespacedParamStore();
    await store.storeStackConfig(STACK_CONFIG_NAMESPACE, 'native', readyConfig('native'));

    const loadSpy = vi.spyOn(store, 'loadStackConfig');
    const listSpy = vi.spyOn(store, 'listStackNames');

    const resolver = new WorkspaceStackResolver({
      paramStore: store,
      oscContext,
      minioPassword: 'pw',
      couchPassword: 'pw',
      log: makeLog()
    });

    // HIT path: the direct read under `default` hits and returns immediately
    // (workspace-stack.ts:486-487); because namespace === STACK_CONFIG_NAMESPACE
    // there is nothing to fall back to (workspace-stack.ts:491). Exactly ONE
    // loadStackConfig call, and it was under `default`.
    expect(await resolver.resolveStackName('native')).toBe('native');
    expect(loadSpy).toHaveBeenCalledTimes(1);
    expect(loadSpy).toHaveBeenCalledWith(STACK_CONFIG_NAMESPACE, 'native');

    // MISS path: a direct miss under `default` returns undefined with NO second
    // read, because namespace === STACK_CONFIG_NAMESPACE
    // (workspace-stack.ts:491). Likewise an empty `default` listing issues NO
    // fallback listing (workspace-stack.ts:530).
    loadSpy.mockClear();
    listSpy.mockClear();
    const { store: empty } = makeNamespacedParamStore();
    const emptyLoadSpy = vi.spyOn(empty, 'loadStackConfig');
    const emptyListSpy = vi.spyOn(empty, 'listStackNames');
    const emptyResolver = new WorkspaceStackResolver({
      paramStore: empty,
      oscContext,
      minioPassword: 'pw',
      couchPassword: 'pw',
      log: makeLog()
    });
    expect(await emptyResolver.resolveStackName('ghost')).toBeUndefined();
    // One direct load for the missing name (no fallback second load) and one
    // direct list (no fallback second list).
    expect(emptyLoadSpy).toHaveBeenCalledTimes(1);
    expect(emptyLoadSpy).toHaveBeenCalledWith(STACK_CONFIG_NAMESPACE, 'ghost');
    expect(emptyListSpy).toHaveBeenCalledTimes(1);
    expect(emptyListSpy).toHaveBeenCalledWith(STACK_CONFIG_NAMESPACE);
  });
});
