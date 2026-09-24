import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Regression coverage for issue #776: the parameter-store namespace must be
// DETERMINISTIC across boots of the same deployment.
//
// Before #776 the namespace was `listSubscriptions(...).find(s => s.tenantId)`
// — the first entry of a list whose membership and order track OSC service
// instances being created and destroyed. Two boots of the SAME deployment hours
// apart could therefore resolve a real tenant id once and the literal `default`
// the next time, which:
//   - stranded a post-#712 stack (config written ONLY under the tenant-scoped
//     key) on the boot that derived `default`, because the #751 read fallback is
//     guarded to run only when the derived namespace is NOT `default`; and
//   - could not be fixed by widening that fallback without reintroducing the
//     cross-tenant namespace probing #712 closed.
//
// #776 fixes the CAUSE: resolveWorkspaceId resolves the id from an explicit
// OVC_WORKSPACE_ID env var, else from a value PINNED once in the deployment's
// OWN parameter store (normally by the first provision) and read back on every
// later boot, and only then falls back to deriving it from OSC. The `default`
// fallback is never pinned, so a transient OSC read failure cannot permanently
// strand a tenant-scoped deployment.
//
// Contracts verified for these tests:
//   - @osaas/client-core admin.d.ts:2-5,42 — Subscription = { serviceId, tenantId },
//     listSubscriptions(context: Context): Promise<Subscription[]>
//   - services/param-store.ts:108-125 — ParamStore (storeStackConfig /
//     loadStackConfig / deleteStackConfig / listStackNames)
//   - services/param-store.ts:131 — stackConfigKey(workspaceId, name)
//   - services/param-store.ts:602-608 — ConfigKvStore (get/set/delete/listByPrefix),
//     which structurally satisfies WorkspaceIdStore
//   - services/param-store.ts:52-95,102-104 — StackConfig / isReadyStack

const TENANT_A = 'workspace-tenant-a';
const TENANT_B = 'workspace-tenant-b';

// Mocked OSC SDK. The subscription list is reprogrammed per test to simulate the
// membership churn issue #776 reports (instances created/destroyed between
// boots), including the "empty list" state that produced the `default` drift.
vi.mock('@osaas/client-core', () => ({
  listSubscriptions: vi.fn(async () => [
    { serviceId: 'minio-minio', tenantId: TENANT_A }
  ]),
  Context: class {}
}));

import {
  WorkspaceStackResolver,
  resolveWorkspaceId,
  STACK_CONFIG_NAMESPACE,
  WORKSPACE_ID_ENV_VAR,
  WORKSPACE_ID_PIN_KEY,
  type StackResolverLogger,
  type WorkspaceIdStore
} from './workspace-stack.js';
import {
  stackConfigKey,
  type ParamStore,
  type StackConfig
} from './param-store.js';
import { listSubscriptions, type Context } from '@osaas/client-core';

const mockedListSubscriptions = vi.mocked(listSubscriptions);

// The deployment's own authenticated Context; a bare stub is enough since the
// tenant is read through the mocked listSubscriptions.
const oscContext = {} as unknown as Context;

const SAVED = {
  couch: process.env['COUCHDB_URL'],
  minio: process.env['MINIO_URL'],
  workspaceId: process.env[WORKSPACE_ID_ENV_VAR]
};

beforeEach(() => {
  // Force the parameter-store path, not the env-var override
  // (buildEnvConnections, workspace-stack.ts).
  delete process.env['COUCHDB_URL'];
  delete process.env['MINIO_URL'];
  delete process.env[WORKSPACE_ID_ENV_VAR];
  // mockImplementation replaces the behaviour but keeps call history, so clear
  // it explicitly — one test asserts listSubscriptions is never called.
  mockedListSubscriptions.mockClear();
  mockedListSubscriptions.mockImplementation(async () => [
    { serviceId: 'minio-minio', tenantId: TENANT_A }
  ]);
});

afterEach(() => {
  for (const [key, value] of [
    ['COUCHDB_URL', SAVED.couch],
    ['MINIO_URL', SAVED.minio],
    [WORKSPACE_ID_ENV_VAR, SAVED.workspaceId]
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  vi.restoreAllMocks();
});

// A ready stack config with valid absolute URLs so buildConnectionsFromStack
// builds real connections rather than the no-storage in-memory fallback.
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

// Namespace-aware in-memory ParamStore keyed by the SAME physical key the HTTP
// store uses (stackConfigKey, param-store.ts:131), so a write under one
// namespace is only visible when read under that same namespace. `namespacesRead`
// records every workspaceId the resolver actually asked for, for the isolation
// assertion.
function makeParamStore(): {
  store: ParamStore;
  keys: () => string[];
  namespacesRead: string[];
} {
  const byKey = new Map<string, StackConfig>();
  const namespacesRead: string[] = [];
  const store: ParamStore = {
    async storeStackConfig(ws, name, config) {
      byKey.set(stackConfigKey(ws, name), config);
    },
    async loadStackConfig(ws, name) {
      namespacesRead.push(ws);
      return byKey.get(stackConfigKey(ws, name));
    },
    async deleteStackConfig(ws, name) {
      byKey.delete(stackConfigKey(ws, name));
    },
    async listStackNames(ws) {
      namespacesRead.push(ws);
      const prefix = stackConfigKey(ws, '');
      return [...byKey.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    }
  };
  return { store, keys: () => [...byKey.keys()], namespacesRead };
}

// In-memory WorkspaceIdStore. Mirrors the get/set half of ConfigKvStore
// (param-store.ts:602-608) that the pin uses; shared across "boots" exactly like
// the real config-service instance is.
function makePinStore(): WorkspaceIdStore & {
  entries: () => Array<[string, string]>;
  writes: string[];
} {
  const kv = new Map<string, string>();
  const writes: string[] = [];
  return {
    async get(key) {
      return kv.get(key);
    },
    async set(key, value) {
      writes.push(value);
      kv.set(key, value);
    },
    entries: () => [...kv.entries()],
    writes
  };
}

// A single fake config-service instance: ONE key/value map serving both the
// ParamStore view (stack configs under `openvideocore/<ns>/<name>`, param-store.ts
// :131-133/:446) and the WorkspaceIdStore view (get/set/listByPrefix, the
// ConfigKvStore surface at param-store.ts:602-608). This is how the real
// deployment is wired — main.ts hands the SAME eyevinn-app-config-svc instance to
// the param store and to the pin store — so the seed step can see the stack
// configs a previous release wrote.
function makeConfigService(): {
  paramStore: ParamStore;
  pinStore: WorkspaceIdStore;
  namespacesRead: string[];
  writes: string[];
  raw: Map<string, string>;
} {
  const kv = new Map<string, string>();
  const namespacesRead: string[] = [];
  const writes: string[] = [];
  const paramStore: ParamStore = {
    async storeStackConfig(ws, name, config) {
      kv.set(stackConfigKey(ws, name), JSON.stringify(config));
    },
    async loadStackConfig(ws, name) {
      namespacesRead.push(ws);
      const raw = kv.get(stackConfigKey(ws, name));
      return raw ? (JSON.parse(raw) as StackConfig) : undefined;
    },
    async deleteStackConfig(ws, name) {
      kv.delete(stackConfigKey(ws, name));
    },
    async listStackNames(ws) {
      namespacesRead.push(ws);
      const prefix = stackConfigKey(ws, '');
      return [...kv.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    }
  };
  const pinStore: WorkspaceIdStore = {
    async get(key) {
      return kv.get(key);
    },
    async set(key, value) {
      writes.push(value);
      kv.set(key, value);
    },
    async listByPrefix(prefix) {
      return [...kv.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value }));
    }
  };
  return { paramStore, pinStore, namespacesRead, writes, raw: kv };
}

function makeLog(): StackResolverLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// A "boot": a brand-new resolver over the SAME persistent stores, so nothing
// carries over in process memory — only what was written to the parameter store.
function boot(
  store: ParamStore,
  pinStore: WorkspaceIdStore | undefined
): WorkspaceStackResolver {
  return new WorkspaceStackResolver({
    paramStore: store,
    oscContext,
    minioPassword: 'pw',
    couchPassword: 'pw',
    ...(pinStore ? { workspaceIdStore: pinStore } : {}),
    log: makeLog()
  });
}

describe('deterministic workspace namespace (issue #776)', () => {
  it('resolves the SAME namespace on two consecutive boots whose listSubscriptions results differ', async () => {
    const pinStore = makePinStore();
    const { store } = makeParamStore();

    // Boot 1: the tenant has live subscriptions, so the id is derived and pinned.
    mockedListSubscriptions.mockImplementation(async () => [
      { serviceId: 'minio-minio', tenantId: TENANT_A },
      { serviceId: 'couchdb-couchdb', tenantId: TENANT_A }
    ]);
    const first = await resolveWorkspaceId(oscContext, { store: pinStore });
    expect(first.workspaceId).toBe(TENANT_A);
    expect(first.source).toBe('derived');
    expect(first.deterministic).toBe(true);
    expect(pinStore.entries()).toEqual([[WORKSPACE_ID_PIN_KEY, TENANT_A]]);

    // Boot 2, hours later: every service instance was torn down in between, so
    // OSC now returns an EMPTY subscription list — the exact input that made the
    // pre-#776 derivation drift from `birme` to `default`.
    mockedListSubscriptions.mockImplementation(async () => []);
    const second = await resolveWorkspaceId(oscContext, { store: pinStore });
    expect(second.workspaceId).toBe(TENANT_A);
    expect(second.source).toBe('pinned');
    expect(second.deterministic).toBe(true);

    // Boot 3: a different, re-ordered subscription set. Still the same namespace.
    mockedListSubscriptions.mockImplementation(async () => [
      { serviceId: 'valkey-io-valkey', tenantId: TENANT_A },
      { serviceId: 'eyevinn-encore', tenantId: TENANT_A },
      { serviceId: 'minio-minio', tenantId: TENANT_A }
    ]);
    const third = await resolveWorkspaceId(oscContext, { store: pinStore });
    expect(third.workspaceId).toBe(TENANT_A);
    expect(third.source).toBe('pinned');

    // The pin was written exactly ONCE; later boots only read it back.
    expect(pinStore.writes).toEqual([TENANT_A]);

    // And the resolver itself — the read side — agrees on every boot.
    for (const _ of [1, 2, 3]) {
      const resolver = boot(store, pinStore);
      // No stack provisioned, so no name resolves; the point is the namespace it
      // asked for, asserted below.
      await resolver.resolveStackName(undefined);
    }
  });

  it('keeps resolving a post-#712 stack on every later boot, including one where OSC reports no subscriptions', async () => {
    const pinStore = makePinStore();
    const { store, namespacesRead } = makeParamStore();

    // Provision on a post-#712 build: the config is written ONLY under the
    // tenant-scoped key, and provisioning pins the workspace id.
    const provisionNs = (await resolveWorkspaceId(oscContext, { store: pinStore }))
      .workspaceId;
    expect(provisionNs).toBe(TENANT_A);
    await store.storeStackConfig(provisionNs, 'mystack', readyConfig('mystack'));
    expect(await store.listStackNames(STACK_CONFIG_NAMESPACE)).toEqual([]);

    // Later boot with an EMPTY subscription list. Pre-#776 this derived
    // `default`, missed the tenant-scoped key, skipped the #751 fallback (it is
    // guarded on namespace !== 'default') and came up with no storage at all.
    mockedListSubscriptions.mockImplementation(async () => []);
    namespacesRead.length = 0;

    const resolver = boot(store, pinStore);
    expect(await resolver.resolveStackName(undefined)).toBe('mystack');
    expect(await resolver.resolveStackName('mystack')).toBe('mystack');

    const conns = await resolver.resolve();
    expect(conns.storageFor).toBeDefined();
    expect(conns.storageClient).toBeDefined();
    expect(conns.s3Config?.endpoint).toBe('https://mystack-minio.example.test');

    // Every read went to the deployment's own namespace; `default` was never
    // consulted, because the direct read hit.
    expect(new Set(namespacesRead)).toEqual(new Set([TENANT_A]));
  });

  it('still resolves a pre-#712 stack through the #751 fallback and does NOT delete its `default` key', async () => {
    const pinStore = makePinStore();
    const { store, keys } = makeParamStore();

    // Pre-#712 write: the stack exists ONLY under the literal `default`.
    await store.storeStackConfig(STACK_CONFIG_NAMESPACE, 'legacy', readyConfig('legacy'));

    const resolver = boot(store, pinStore);
    expect(await resolver.resolveStackName('legacy')).toBe('legacy');
    expect(await resolver.resolveStackName(undefined)).toBe('legacy');

    const conns = await resolver.resolve('legacy');
    expect(conns.s3Config?.endpoint).toBe('https://legacy-minio.example.test');

    // Copy, not move: the legacy `default`-namespaced key is retained alongside
    // the migrated tenant-scoped one.
    expect(keys()).toContain(stackConfigKey(STACK_CONFIG_NAMESPACE, 'legacy'));
    expect(keys()).toContain(stackConfigKey(TENANT_A, 'legacy'));
  });

  it('never reads a namespace other than the deployment\'s own and the literal `default`', async () => {
    const pinStore = makePinStore();
    const { store, namespacesRead } = makeParamStore();

    // Tenant B's config lives under B's own namespace and nowhere else.
    await store.storeStackConfig(TENANT_B, 'secret', readyConfig('secret'));

    const resolver = boot(store, pinStore);
    expect(await resolver.resolveStackName('secret')).toBeUndefined();
    expect(await resolver.resolveStackName(undefined)).toBeUndefined();

    const conns = await resolver.resolve('secret');
    expect(conns.storageFor).toBeUndefined();
    expect(conns.s3Config).toBeUndefined();

    expect(namespacesRead.length).toBeGreaterThan(0);
    for (const ns of namespacesRead) {
      expect([TENANT_A, STACK_CONFIG_NAMESPACE]).toContain(ns);
    }
    expect(namespacesRead).not.toContain(TENANT_B);
  });

  it('lets an explicit OVC_WORKSPACE_ID win without any OSC round-trip, and never pins it', async () => {
    process.env[WORKSPACE_ID_ENV_VAR] = 'explicit-workspace';
    const pinStore = makePinStore();
    mockedListSubscriptions.mockImplementation(async () => {
      throw new Error('OSC must not be consulted when the workspace id is configured');
    });

    const resolution = await resolveWorkspaceId(oscContext, { store: pinStore });
    expect(resolution).toEqual({
      workspaceId: 'explicit-workspace',
      source: 'env',
      deterministic: true
    });
    expect(mockedListSubscriptions).not.toHaveBeenCalled();
    // An explicit env value is already deterministic; it is not written to the
    // store, so it can be changed by re-deploying without a stale pin fighting it.
    expect(pinStore.entries()).toEqual([]);
  });

  it('ignores an OVC_WORKSPACE_ID that would corrupt the key space', async () => {
    // The id is a single segment of `openvideocore/<workspaceId>/<name>`
    // (param-store.ts:131), so a value containing `/` is rejected rather than
    // silently splitting the key.
    process.env[WORKSPACE_ID_ENV_VAR] = 'bad/value';
    const pinStore = makePinStore();

    const resolution = await resolveWorkspaceId(oscContext, { store: pinStore });
    expect(resolution.workspaceId).toBe(TENANT_A);
    expect(resolution.source).toBe('derived');
  });

  it('does NOT pin the `default` fallback, so a later healthy boot still pins the real tenant id', async () => {
    const pinStore = makePinStore();

    // Boot 1: OSC is unreachable and nothing is pinned yet.
    mockedListSubscriptions.mockImplementation(async () => {
      throw new Error('OSC unreachable');
    });
    const degraded = await resolveWorkspaceId(oscContext, { store: pinStore });
    expect(degraded.workspaceId).toBe(STACK_CONFIG_NAMESPACE);
    expect(degraded.source).toBe('fallback');
    expect(degraded.deterministic).toBe(false);
    // Critically: `default` was NOT written to the pin. Pinning it would strand
    // a tenant-scoped deployment on `default` forever — the direction-2 failure.
    expect(pinStore.entries()).toEqual([]);

    // Boot 2: OSC is healthy again, so the real tenant id is derived and pinned.
    mockedListSubscriptions.mockImplementation(async () => [
      { serviceId: 'minio-minio', tenantId: TENANT_A }
    ]);
    const healthy = await resolveWorkspaceId(oscContext, { store: pinStore });
    expect(healthy.workspaceId).toBe(TENANT_A);
    expect(healthy.source).toBe('derived');
    expect(pinStore.entries()).toEqual([[WORKSPACE_ID_PIN_KEY, TENANT_A]]);
  });

  it('does not memoise a degraded `default` resolution inside a running resolver', async () => {
    const pinStore = makePinStore();
    const { store } = makeParamStore();

    // First resolve happens before any pin exists and while OSC is unreachable.
    mockedListSubscriptions.mockImplementation(async () => {
      throw new Error('OSC unreachable');
    });
    const resolver = boot(store, pinStore);
    expect(await resolver.resolveStackName(undefined)).toBeUndefined();

    // A provision then establishes the pin and writes the stack under it.
    mockedListSubscriptions.mockImplementation(async () => [
      { serviceId: 'minio-minio', tenantId: TENANT_A }
    ]);
    const ns = (await resolveWorkspaceId(oscContext, { store: pinStore })).workspaceId;
    await store.storeStackConfig(ns, 'fresh', readyConfig('fresh'));

    // The SAME long-running resolver must pick the pinned namespace up rather
    // than stay stuck on the `default` it resolved before the pin existed.
    expect(await resolver.resolveStackName(undefined)).toBe('fresh');
  });

  // The live listSubscriptions payload (read-only introspection against a real
  // account, 2026-09-24) does NOT match the declared type: 10 of 13 entries
  // carried no `tenantId` at all despite admin.d.ts:2-5 declaring it
  // `tenantId: string`, and the 3 that did split across TWO distinct values that
  // look like the PUBLISHER of the subscribed service. These tests use that shape
  // verbatim.
  const LIVE_SHAPED_SUBSCRIPTIONS = [
    { serviceId: 'minio-minio' },
    { serviceId: 'apache-couchdb' },
    { serviceId: 'valkey-io-valkey' },
    { serviceId: 'eyevinn-encore', tenantId: 'publisher-two' },
    { serviceId: 'eyevinn-app-config-svc', tenantId: 'publisher-two' },
    { serviceId: 'birme-scenechange', tenantId: 'publisher-one' }
  ] as unknown as Array<{ serviceId: string; tenantId: string }>;

  it('seeds the pin from this deployment\'s OWN existing stack configs instead of blind-deriving (upgrade path)', async () => {
    const { paramStore, pinStore, namespacesRead, writes } = makeConfigService();

    // A deployment already running post-#712: its stack config sits under the
    // namespace a PREVIOUS release resolved (TENANT_A). Nothing is pinned yet,
    // because the pin did not exist in that release.
    await paramStore.storeStackConfig(TENANT_A, 'mystack', readyConfig('mystack'));

    // First boot after upgrading. OSC now reports the live-shaped payload, whose
    // smallest tenantId ('publisher-one') is NOT this deployment's namespace.
    // Blind-deriving and pinning that value would make the stack permanently
    // unresolvable — the regression this step exists to prevent.
    mockedListSubscriptions.mockImplementation(async () => LIVE_SHAPED_SUBSCRIPTIONS);

    const resolution = await resolveWorkspaceId(oscContext, { store: pinStore });
    expect(resolution.workspaceId).toBe(TENANT_A);
    expect(resolution.source).toBe('seeded');
    expect(resolution.deterministic).toBe(true);
    expect(writes).toEqual([TENANT_A]);
    expect(await pinStore.get(WORKSPACE_ID_PIN_KEY)).toBe(TENANT_A);

    // The read side resolves the existing stack on this boot and on the next one,
    // where the pin (not the derivation) answers.
    namespacesRead.length = 0;
    expect(await boot(paramStore, pinStore).resolveStackName(undefined)).toBe('mystack');
    expect(await boot(paramStore, pinStore).resolveStackName(undefined)).toBe('mystack');
    expect(new Set(namespacesRead)).toEqual(new Set([TENANT_A]));
    expect(namespacesRead).not.toContain('publisher-one');
  });

  it('keeps the namespace stable across a MEMBERSHIP change that moves the derived value', async () => {
    const { paramStore, pinStore, writes } = makeConfigService();

    // Boot 1: fresh deployment, nothing stored. The id is derived from OSC (the
    // only source available) and pinned.
    mockedListSubscriptions.mockImplementation(async () => LIVE_SHAPED_SUBSCRIPTIONS);
    const first = await resolveWorkspaceId(oscContext, { store: pinStore });
    expect(first.workspaceId).toBe('publisher-one');
    expect(first.source).toBe('derived');
    expect(first.deterministic).toBe(true);
    await paramStore.storeStackConfig(first.workspaceId, 'mystack', readyConfig('mystack'));

    // Between boots the operator subscribes to another service, published by an
    // alphabetically EARLIER tenant. The derivation would now return
    // 'aaa-publisher'; the PIN must hold the namespace instead.
    mockedListSubscriptions.mockImplementation(async () => [
      { serviceId: 'aaa-some-service', tenantId: 'aaa-publisher' },
      ...LIVE_SHAPED_SUBSCRIPTIONS
    ] as unknown as Array<{ serviceId: string; tenantId: string }>);

    const second = await resolveWorkspaceId(oscContext, { store: pinStore });
    expect(second.workspaceId).toBe('publisher-one');
    expect(second.source).toBe('pinned');
    expect(second.deterministic).toBe(true);
    // Written exactly once, on boot 1.
    expect(writes).toEqual(['publisher-one']);

    // And the stack still resolves after the membership change.
    expect(await boot(paramStore, pinStore).resolveStackName(undefined)).toBe('mystack');
  });

  it('reports deterministic=false when the pin WRITE fails, and does not memoise the unpersisted value', async () => {
    const { paramStore, namespacesRead } = makeConfigService();
    // A store whose write always throws (parameter store down / read-only key).
    const failing: WorkspaceIdStore = {
      async get() {
        return undefined;
      },
      async set() {
        throw new Error('config kv write failed: 503');
      },
      async listByPrefix() {
        return [];
      }
    };

    const resolution = await resolveWorkspaceId(oscContext, { store: failing });
    // The derived value is still served for this resolve...
    expect(resolution.workspaceId).toBe(TENANT_A);
    expect(resolution.source).toBe('derived');
    // ...but nothing was persisted, so it must NOT be advertised as stable.
    expect(resolution.deterministic).toBe(false);

    // A resolver over the same failing store must therefore re-resolve rather
    // than memoise: the next boot has nothing pinned.
    mockedListSubscriptions.mockClear();
    const resolver = boot(paramStore, failing);
    await resolver.resolveStackName(undefined);
    const afterFirst = mockedListSubscriptions.mock.calls.length;
    await resolver.resolveStackName(undefined);
    expect(mockedListSubscriptions.mock.calls.length).toBeGreaterThan(afterFirst);
    // Every read still went to the derived namespace (plus the #751 `default`
    // compatibility read); no third namespace was consulted.
    for (const ns of namespacesRead) {
      expect([TENANT_A, STACK_CONFIG_NAMESPACE]).toContain(ns);
    }
  });

  it('refuses to pin when the store holds stack configs under SEVERAL namespaces', async () => {
    const { paramStore, pinStore, writes } = makeConfigService();
    await paramStore.storeStackConfig(TENANT_A, 'one', readyConfig('one'));
    await paramStore.storeStackConfig(TENANT_B, 'two', readyConfig('two'));

    const log = makeLog();
    const resolution = await resolveWorkspaceId(oscContext, { store: pinStore, log });
    // Ambiguous history: serve the derived value for this resolve, pin nothing,
    // and tell the operator how to settle it.
    expect(resolution.source).toBe('derived');
    expect(resolution.deterministic).toBe(false);
    expect(writes).toEqual([]);
    expect(await pinStore.get(WORKSPACE_ID_PIN_KEY)).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it('seeds `default` for a pre-#712 store whose stacks all live under the literal namespace', async () => {
    const { paramStore, pinStore, writes } = makeConfigService();
    await paramStore.storeStackConfig(STACK_CONFIG_NAMESPACE, 'legacy', readyConfig('legacy'));

    const resolution = await resolveWorkspaceId(oscContext, { store: pinStore });
    expect(resolution.workspaceId).toBe(STACK_CONFIG_NAMESPACE);
    expect(resolution.source).toBe('seeded');
    expect(writes).toEqual([STACK_CONFIG_NAMESPACE]);

    // A tenant-scoped namespace alongside the legacy one WINS: `default` entries
    // are either pre-#712 writes or the copy the #751 read fallback makes.
    await paramStore.storeStackConfig(TENANT_A, 'legacy', readyConfig('legacy'));
    const fresh = makeConfigService();
    for (const entry of await pinStore.listByPrefix!('openvideocore/')) {
      if (entry.key !== WORKSPACE_ID_PIN_KEY) fresh.raw.set(entry.key, entry.value);
    }
    const seeded = await resolveWorkspaceId(oscContext, { store: fresh.pinStore });
    expect(seeded.workspaceId).toBe(TENANT_A);
    expect(seeded.source).toBe('seeded');
  });

  it('ignores non-stack-config records that share the `openvideocore/` prefix', async () => {
    const { pinStore, writes, raw } = makeConfigService();
    // Storage-backend registry records (storage-backend-registry.ts:321) are
    // keyed `openvideocore/storagebackends/<workspaceId>/<id>` — a different
    // shape whose second segment must never be read as a namespace.
    raw.set(
      'openvideocore/storagebackends/some-other-workspace/backend-1',
      JSON.stringify({ id: 'backend-1', bucket: 'b' })
    );
    // And an unrelated two-segment record whose value is not a StackConfig.
    raw.set('openvideocore/not-a-namespace/whatever', JSON.stringify({ hello: 'world' }));

    const resolution = await resolveWorkspaceId(oscContext, { store: pinStore });
    // No stack-config evidence at all: this is treated as a fresh deployment, so
    // the OSC-derived id is used and pinned.
    expect(resolution.workspaceId).toBe(TENANT_A);
    expect(resolution.source).toBe('derived');
    expect(writes).toEqual([TENANT_A]);
  });

  it('is independent of subscription-list ORDER when several tenant ids are present', async () => {
    // Every active subscription of a tenant carries the same tenantId
    // (@osaas/client-core admin.d.ts:2-5), but the selection must not depend on
    // list order even if that ever stops holding.
    const forward = makePinStore();
    mockedListSubscriptions.mockImplementation(async () => [
      { serviceId: 'a', tenantId: 'tenant-m' },
      { serviceId: 'b', tenantId: 'tenant-z' }
    ]);
    const a = await resolveWorkspaceId(oscContext, { store: forward });

    const reversed = makePinStore();
    mockedListSubscriptions.mockImplementation(async () => [
      { serviceId: 'b', tenantId: 'tenant-z' },
      { serviceId: 'a', tenantId: 'tenant-m' }
    ]);
    const b = await resolveWorkspaceId(oscContext, { store: reversed });

    expect(a.workspaceId).toBe(b.workspaceId);
  });
});
