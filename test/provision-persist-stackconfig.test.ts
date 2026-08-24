// Regression coverage for issue #416.
//
// After a stack is provisioned, storage-dependent endpoints must resolve a
// usable StackConfig — they no longer report "object storage is not configured
// for this stack". The defect was on the WRITE path: the StackConfig
// persistence ran inside a `setImmediate` after the 202 return and a throw was
// caught and only logged, so a silent write failure left nothing to read back.
//
// These tests exercise the persistence contract directly:
//   1. persistStackConfig awaits the write, retries transient failures, and
//      RE-THROWS (surfaces) when every attempt fails — no silent swallow.
//   2. provision -> persist -> read-back for the DEFAULT-stack path: a config
//      written under stackConfigKey(STACK_CONFIG_NAMESPACE, name) is read back
//      by WorkspaceStackResolver with no stack name (the default stack), and
//      storageFor() resolves — the acceptance criterion for #416.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { persistStackConfig } from '../src/routes/provision.js';
import {
  stackConfigKey,
  type ParamStore,
  type StackConfig
} from '../src/services/param-store.js';
import {
  WorkspaceStackResolver,
  STACK_CONFIG_NAMESPACE
} from '../src/services/workspace-stack.js';
import type { Context } from '@osaas/client-core';

// In-memory ParamStore keyed EXACTLY like the HTTP implementation
// (stackConfigKey), so a write and a subsequent read agree on the key — the
// same symmetry the real store relies on (param-store.ts:131).
function makeFakeParamStore(): ParamStore & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async storeStackConfig(workspaceId, name, config) {
      store.set(stackConfigKey(workspaceId, name), JSON.stringify(config));
    },
    async loadStackConfig(workspaceId, name) {
      const raw = store.get(stackConfigKey(workspaceId, name));
      return raw ? (JSON.parse(raw) as StackConfig) : undefined;
    },
    async deleteStackConfig(workspaceId, name) {
      store.delete(stackConfigKey(workspaceId, name));
    },
    async listStackNames(workspaceId) {
      const prefix = stackConfigKey(workspaceId, '');
      return [...store.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    }
  };
}

const readyConfig = (name: string): StackConfig => ({
  status: 'ready',
  minioEndpoint: 'https://minio.example.osaas.io',
  couchdbUrl: 'https://couch.example.osaas.io',
  redisUrl: 'redis://valkey.svc.cluster.local:6379',
  sourceBucket: 'openvideocore-source',
  packagedBucket: 'openvideocore-packaged',
  services: [{ serviceId: 'minio-minio', instanceName: name }]
});

// The resolver only touches oscContext on the (unused) encore path for a
// stored stack, so a stub Context is sufficient for the read-back assertions.
const stubContext = {
  getServiceAccessToken: async () => 'sat'
} as unknown as Context;

describe('persistStackConfig (write path, issue #416)', () => {
  it('persists on the first successful attempt', async () => {
    const ps = makeFakeParamStore();
    await persistStackConfig({
      paramStore: ps,
      workspaceId: STACK_CONFIG_NAMESPACE,
      name: 'mystack',
      config: readyConfig('mystack')
    });
    expect(
      ps.store.get(stackConfigKey(STACK_CONFIG_NAMESPACE, 'mystack'))
    ).toBeDefined();
  });

  it('retries a transient write failure and eventually persists', async () => {
    const ps = makeFakeParamStore();
    const realStore = ps.storeStackConfig.bind(ps);
    let calls = 0;
    ps.storeStackConfig = vi.fn(async (w, n, c) => {
      calls++;
      if (calls < 3) throw new Error('parameter store write failed: 503');
      return realStore(w, n, c);
    });

    await persistStackConfig({
      paramStore: ps,
      workspaceId: STACK_CONFIG_NAMESPACE,
      name: 'mystack',
      config: readyConfig('mystack'),
      delayMs: async () => {} // no real timers in tests
    });

    expect(calls).toBe(3);
    expect(
      ps.store.get(stackConfigKey(STACK_CONFIG_NAMESPACE, 'mystack'))
    ).toBeDefined();
  });

  it('re-throws (surfaces) when every attempt fails — never silently swallowed', async () => {
    const ps = makeFakeParamStore();
    ps.storeStackConfig = vi.fn(async () => {
      throw new Error('parameter store write failed: 500 boom');
    });

    await expect(
      persistStackConfig({
        paramStore: ps,
        workspaceId: STACK_CONFIG_NAMESPACE,
        name: 'mystack',
        config: readyConfig('mystack'),
        maxAttempts: 3,
        delayMs: async () => {}
      })
    ).rejects.toThrow(/failed to persist stack config for "mystack" after 3 attempt/);
    // Nothing was persisted, so a subsequent read-back finds nothing.
    expect(
      ps.store.get(stackConfigKey(STACK_CONFIG_NAMESPACE, 'mystack'))
    ).toBeUndefined();
  });
});

describe('provision -> persist -> read-back, default stack (issue #416)', () => {
  beforeEach(() => {
    // Ensure the env-override path is inactive so the resolver reads the
    // parameter store (the production stack path), not COUCHDB_URL/MINIO_URL.
    delete process.env['COUCHDB_URL'];
    delete process.env['MINIO_URL'];
  });

  afterEach(() => {
    delete process.env['COUCHDB_URL'];
    delete process.env['MINIO_URL'];
  });

  it('storageFor() resolves for the default stack after persistence', async () => {
    const ps = makeFakeParamStore();

    // Provision writes under the deployment's own workspace namespace
    // (deriveWorkspaceId === STACK_CONFIG_NAMESPACE, provision.ts + workspace-stack.ts:303).
    await persistStackConfig({
      paramStore: ps,
      workspaceId: STACK_CONFIG_NAMESPACE,
      name: 'mystack',
      config: readyConfig('mystack')
    });

    // The resolver reads back the DEFAULT stack (no X-Stack-Name) under the
    // SAME namespace, and must build real (non in-memory) storage connections.
    const resolver = new WorkspaceStackResolver({
      paramStore: ps,
      oscContext: stubContext,
      minioPassword: 'minio-pass',
      couchPassword: 'couch-pass'
    });

    const conns = await resolver.resolve();
    // The acceptance criterion: storageFor is defined (resolvable), so
    // storage-dependent endpoints no longer report the config missing.
    expect(conns.storageFor).toBeDefined();
    expect(conns.storageClient).toBeDefined();
    expect(conns.sourceBucket).toBe('openvideocore-source');
  });

  it('an unpersisted stack falls back to in-memory (no storageFor)', async () => {
    // Guards the regression from the other direction: when the write never
    // lands, the resolver has nothing to read back and storageFor is undefined
    // (the "object storage is not configured" symptom the fix prevents).
    const ps = makeFakeParamStore();
    const resolver = new WorkspaceStackResolver({
      paramStore: ps,
      oscContext: stubContext,
      minioPassword: 'minio-pass',
      couchPassword: 'couch-pass'
    });
    const conns = await resolver.resolve();
    expect(conns.storageFor).toBeUndefined();
  });
});
