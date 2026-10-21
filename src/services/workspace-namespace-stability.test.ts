import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Regression coverage for the parameter-store NAMESPACE SEGMENT (issues #776,
// #804).
//
// #776 asked for the namespace to be *stable across boots* and answered it with
// machinery: a derived tenant id, a persisted pin, a seed step, an env-var
// override. #804 settles the question underneath it — there is nothing to
// derive, so deriving it correctly was machinery for a distinction that cannot
// exist. The namespace is now the literal CONSTANT `STACK_CONFIG_NAMESPACE`.
//
// Why the constant is not just "stable enough" but the only possible value:
//   - the parameter store is a SINGLE eyevinn-app-config-svc instance per
//     deployment (DEFAULT_PARAM_STORE_INSTANCE_NAME = 'ovcconfig',
//     src/services/param-store.ts:704), resolved through the deployment's own
//     authenticated Context (param-store.ts:759);
//   - one deployment serves exactly one tenant — ADR-018 "Interaction with
//     structural per-deployment tenant isolation": "One deployed stack == one
//     tenant's workspace ... DEPLOYMENT_CONTEXT = 'default' remains a fixed
//     deployment-wide constant, not a request-derived identifier"; ADR-020
//     Decision 1: "One deployed open-videocore instance is one tenant ... MUST
//     NOT introduce a per-request tenant/workspace dimension".
// So `<namespace>` in `openvideocore/<namespace>/<stackName>` can only ever hold
// ONE value inside any given store. It cannot discriminate between tenants.
//
// What this file therefore asserts, replacing the old deterministic-derivation
// guarantee:
//   (a) the namespace is the constant `default`, and is the SAME value on the
//       read side and the write side by construction;
//   (b) resolving it performs NO OSC round-trip and NO parameter-store read —
//       there is no subscription scan, no pin read, no pin write, and no
//       `_meta/workspace-id` key is ever created;
//   (c) it does not vary with the OSC Context, the environment, or the store's
//       contents — including a store that still holds a stale pre-#804 key;
//   (d) collapsing the middle segment does NOT collide stacks: they are keyed by
//       NAME in the LAST segment, which is already the discriminator;
//   (e) `invalidate()` has no namespace state to clear and the namespace is
//       unchanged across it.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - `export const STACK_CONFIG_NAMESPACE = "default"`
//     (src/services/workspace-stack.ts).
//   - WorkspaceStackResolver constructor options
//     { paramStore, oscContext, minioPassword, couchPassword,
//       staleNamespaceScanner?, log?, ... } and
//     resolveStackName(requestedStackName?): Promise<string | undefined>,
//     resolveStackConfig(stackName?): Promise<StackConfig | undefined>
//     (src/services/workspace-stack.ts).
//   - ParamStore interface + stackConfigKey(workspaceId, name) =
//     `openvideocore/{ws}/{name}` (src/services/param-store.ts:108-133).
//   - persistStackConfig({ paramStore, workspaceId, name, config, ... })
//     (src/routes/provision.ts).

// Mock @osaas/client-core so any accidental re-introduction of an OSC-derived
// namespace fails loudly rather than silently working in this suite.
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
import { listSubscriptions, type Context } from '@osaas/client-core';

const mockedListSubscriptions = vi.mocked(listSubscriptions);

const oscContext = {} as unknown as Context;

const SAVED = {
  couch: process.env['COUCHDB_URL'],
  minio: process.env['MINIO_URL']
};
beforeEach(() => {
  delete process.env['COUCHDB_URL'];
  delete process.env['MINIO_URL'];
  mockedListSubscriptions.mockClear();
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

// Namespace-aware in-memory ParamStore keyed by the real physical key
// (stackConfigKey, param-store.ts:131), so a write under one namespace is only
// visible when read under that SAME namespace.
function makeStore() {
  const byKey = new Map<string, StackConfig>();
  const namespacesListed: string[] = [];
  const namespacesRead: string[] = [];
  const namespacesWritten: string[] = [];
  const store: ParamStore = {
    async storeStackConfig(ws, name, config) {
      namespacesWritten.push(ws);
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
      namespacesListed.push(ws);
      const prefix = stackConfigKey(ws, '');
      return [...byKey.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    }
  };
  return {
    store,
    namespacesListed,
    namespacesRead,
    namespacesWritten,
    keys: () => [...byKey.keys()],
    raw: byKey
  };
}

function makeResolver(
  paramStore: ParamStore,
  scanner?: StackConfigKeyScanner
): WorkspaceStackResolver {
  return new WorkspaceStackResolver({
    paramStore,
    oscContext,
    minioPassword: 'not-used',
    couchPassword: 'not-used',
    ...(scanner ? { staleNamespaceScanner: scanner } : {})
  });
}

describe('parameter-store namespace segment is a constant (#804)', () => {
  it('is the literal "default"', () => {
    expect(STACK_CONFIG_NAMESPACE).toBe('default');
  });

  it('is the ONLY namespace the resolver reads, with no OSC round-trip', async () => {
    const { store, namespacesListed, namespacesRead } = makeStore();
    await store.storeStackConfig(STACK_CONFIG_NAMESPACE, 'mediastack', readyConfig('mediastack'));
    // Reset the bookkeeping the seeding write above produced.
    namespacesListed.length = 0;
    namespacesRead.length = 0;

    const resolver = makeResolver(store);
    expect(await resolver.resolveStackName()).toBe('mediastack');
    // resolveStackConfig also LOADS, so both the list and the read side are
    // exercised.
    expect(await resolver.resolveStackConfig()).toBeDefined();

    expect(new Set(namespacesListed)).toEqual(new Set([STACK_CONFIG_NAMESPACE]));
    expect(namespacesRead.length).toBeGreaterThan(0);
    expect(new Set(namespacesRead)).toEqual(new Set([STACK_CONFIG_NAMESPACE]));
    expect(mockedListSubscriptions).not.toHaveBeenCalled();
  });

  it('never writes a workspace-id pin or any other _meta key', async () => {
    const { store, keys } = makeStore();
    const scannerCalls: string[] = [];
    const scanner: StackConfigKeyScanner = {
      async listByPrefix(prefix) {
        scannerCalls.push(prefix);
        return [];
      }
    };
    await store.storeStackConfig(STACK_CONFIG_NAMESPACE, 'mediastack', readyConfig('mediastack'));

    const resolver = makeResolver(store, scanner);
    await resolver.resolveStackName();
    await resolver.resolveStackConfig();

    // #777's `openvideocore/_meta/workspace-id` pin is gone: nothing under
    // `_meta` is ever written, and on a hit the scanner is not even consulted.
    expect(keys().some((k) => k.includes('_meta'))).toBe(false);
    expect(scannerCalls).toEqual([]);
  });

  it('does not vary with the OSC Context (two different Contexts read the same key)', async () => {
    const { store, namespacesRead } = makeStore();
    await store.storeStackConfig(STACK_CONFIG_NAMESPACE, 'mediastack', readyConfig('mediastack'));
    namespacesRead.length = 0;

    const a = new WorkspaceStackResolver({
      paramStore: store,
      oscContext: { token: 'context-a' } as unknown as Context,
      minioPassword: 'x',
      couchPassword: 'y'
    });
    const b = new WorkspaceStackResolver({
      paramStore: store,
      oscContext: { token: 'context-b' } as unknown as Context,
      minioPassword: 'x',
      couchPassword: 'y'
    });

    expect(await a.resolveStackName()).toBe('mediastack');
    expect(await b.resolveStackName()).toBe('mediastack');
    expect((await a.resolveStackConfig())?.minioEndpoint).toBe(
      'https://mediastack-minio.example.test'
    );
    expect((await b.resolveStackConfig())?.minioEndpoint).toBe(
      'https://mediastack-minio.example.test'
    );
    expect(namespacesRead.length).toBeGreaterThan(0);
    expect(new Set(namespacesRead)).toEqual(new Set([STACK_CONFIG_NAMESPACE]));
  });

  it('is not influenced by a stale pre-#804 namespace already present in the store', async () => {
    const { store, namespacesListed } = makeStore();
    // Both a stale pre-#804 key AND the correct constant key exist. The constant
    // must win outright; the stale one must not "seed" anything.
    await store.storeStackConfig('workspace-tenant-a', 'mediastack', readyConfig('stale'));
    await store.storeStackConfig(STACK_CONFIG_NAMESPACE, 'mediastack', readyConfig('current'));
    namespacesListed.length = 0;

    const resolver = makeResolver(store);
    const config = await resolver.resolveStackConfig('mediastack');

    expect(config?.minioEndpoint).toBe('https://current-minio.example.test');
    expect(namespacesListed).not.toContain('workspace-tenant-a');
  });

  it('keeps many stacks in ONE store separated, because the LAST key segment is the discriminator', async () => {
    const { store, keys } = makeStore();
    await store.storeStackConfig(STACK_CONFIG_NAMESPACE, 'alpha', readyConfig('alpha'));
    await store.storeStackConfig(STACK_CONFIG_NAMESPACE, 'beta', readyConfig('beta'));

    expect(keys().sort()).toEqual([
      'openvideocore/default/alpha',
      'openvideocore/default/beta'
    ]);

    const resolver = makeResolver(store);
    expect((await resolver.resolveStackConfig('alpha'))?.minioEndpoint).toBe(
      'https://alpha-minio.example.test'
    );
    expect((await resolver.resolveStackConfig('beta'))?.minioEndpoint).toBe(
      'https://beta-minio.example.test'
    );
    // A named stack is returned verbatim and never silently rewritten to the
    // first-listed one (issue #615 invariant, unchanged by the collapse).
    expect(await resolver.resolveStackName('beta')).toBe('beta');
  });

  it('is unchanged across invalidate() (there is no namespace state to go stale)', async () => {
    const { store, namespacesListed } = makeStore();
    await store.storeStackConfig(STACK_CONFIG_NAMESPACE, 'mediastack', readyConfig('mediastack'));
    const resolver = makeResolver(store);

    expect(await resolver.resolveStackName()).toBe('mediastack');
    resolver.invalidate();
    namespacesListed.length = 0;
    expect(await resolver.resolveStackName()).toBe('mediastack');

    expect(new Set(namespacesListed)).toEqual(new Set([STACK_CONFIG_NAMESPACE]));
  });

  it('survives a boot where the parameter store is briefly unreachable: the namespace cannot degrade', async () => {
    // The #776 failure mode was a namespace that changed when an external read
    // failed. With a constant there is no such failure mode left: the read
    // throws, the namespace does not move, and the next attempt hits the SAME
    // key.
    const { store, namespacesListed } = makeStore();
    await store.storeStackConfig(STACK_CONFIG_NAMESPACE, 'mediastack', readyConfig('mediastack'));

    let fail = true;
    const flaky: ParamStore = {
      ...store,
      async listStackNames(ws) {
        if (fail) {
          fail = false;
          namespacesListed.push(ws);
          throw new Error('parameter store unreachable');
        }
        return store.listStackNames(ws);
      }
    };
    const resolver = makeResolver(flaky);

    expect(await resolver.resolveStackName()).toBeUndefined();
    expect(await resolver.resolveStackName()).toBe('mediastack');
    expect(new Set(namespacesListed)).toEqual(new Set([STACK_CONFIG_NAMESPACE]));
  });
});
