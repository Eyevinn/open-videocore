import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Integration coverage for issue #712: the resolver's READ namespace must
// provably equal the provision route's WRITE namespace for the SAME deployment.
//
// Both sides derive the parameter-store namespace from the deployment's own OSC
// Context via the shared deriveWorkspaceId -> listSubscriptions. We mock
// listSubscriptions to return a NON-'default' tenant so a fixed-literal read
// namespace (the pre-fix bug) would read under 'default' and never find the
// stack provision wrote under the real tenant id. This test provisions with a
// mocked non-'default' tenant and then asserts the resolver resolves THAT SAME
// stack — read key == write key end-to-end.

const TENANT_ID = 'workspace-tenant-42';

// Mock @osaas/client-core so BOTH sides (persistStackConfig's write namespace
// and the resolver's read namespace) derive the SAME non-'default' tenant from
// the same Context. Subscription = { serviceId, tenantId } per admin.d.ts:2-5.
vi.mock('@osaas/client-core', () => ({
  listSubscriptions: vi.fn(async () => [
    { serviceId: 'minio-minio', tenantId: TENANT_ID }
  ]),
  Context: class {}
}));

import {
  WorkspaceStackResolver,
  deriveWorkspaceId,
  STACK_CONFIG_NAMESPACE
} from './workspace-stack.js';
import { persistStackConfig } from '../routes/provision.js';
import {
  stackConfigKey,
  type ParamStore,
  type StackConfig
} from './param-store.js';
import type { Context } from '@osaas/client-core';

// The deployment's own authenticated Context. Both provision and the resolver
// receive this same shape; deriveWorkspaceId reads its tenant via the mocked
// listSubscriptions above.
const oscContext = {} as unknown as Context;

// Ensure the resolver takes the parameter-store path (not the env override).
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
});

// A ready stack config with distinct per-stack coordinates so a mis-resolution
// (reading the wrong namespace) is observable as a missing stack.
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
// store uses (stackConfigKey(workspaceId, name), param-store.ts:131). This makes
// the write namespace and the read namespace observable: a stack written under
// <tenant> is only listed/loaded when read under <tenant>, exactly like the HTTP
// store. Insertion order is preserved so listStackNames returns first-provisioned
// first.
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

describe('provision write namespace equals resolver read namespace (issue #712)', () => {
  it('derives the non-default tenant on both sides from the same Context', async () => {
    const ws = await deriveWorkspaceId(oscContext);
    expect(ws).toBe(TENANT_ID);
    expect(ws).not.toBe(STACK_CONFIG_NAMESPACE);
  });

  it('resolver resolves the SAME stack provision wrote under the real tenant', async () => {
    const { store, keys } = makeNamespacedParamStore();

    // WRITE side: provision persists the stack under the deployment's derived
    // workspace id (deriveWorkspaceId -> non-'default' tenant), exactly as the
    // provision route does as its final step.
    const workspaceId = await deriveWorkspaceId(oscContext);
    await persistStackConfig({
      paramStore: store,
      workspaceId,
      name: 'primary',
      config: readyConfig('primary')
    });

    // The physical key must carry the real tenant, NOT 'default': proves the
    // write landed under the workspace namespace.
    expect(keys()).toEqual([stackConfigKey(TENANT_ID, 'primary')]);

    // READ side: the resolver derives the SAME namespace from the SAME Context.
    const resolver = new WorkspaceStackResolver({
      paramStore: store,
      oscContext,
      minioPassword: 'pw',
      couchPassword: 'pw'
    });

    // resolveStackName reads listStackNames under the derived namespace; it must
    // find the provisioned stack (read key == write key). A fixed-literal read
    // namespace ('default') would return undefined here.
    expect(await resolver.resolveStackName('primary')).toBe('primary');
    expect(await resolver.resolveStackName(undefined)).toBe('primary');

    // resolve() builds real connections from that same stack: proves the read
    // namespace resolves the provisioned coordinates, not the no-storage
    // in-memory fallback the pre-fix divergence produced.
    const connections = await resolver.resolve('primary');
    expect(connections.storageFor).toBeDefined();
    expect(connections.s3Config?.endpoint).toBe(
      'https://primary-minio.example.test'
    );
  });
});
