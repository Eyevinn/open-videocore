// Write-side coverage for the deterministic workspace namespace (issue #776).
//
// The other half of #776 lives in src/services/workspace-namespace-stability.test.ts
// and exercises resolveWorkspaceId directly. This file closes the loop through
// the ROUTE that actually writes: a real POST /api/v1/provision resolves its
// namespace through provision.ts' currentWorkspaceId (which pins it), persists
// the stack config under that namespace, and a FRESH WorkspaceStackResolver over
// the SAME two stores then resolves that stack on a later "boot" where
// listSubscriptions returns nothing at all.
//
// Contracts verified:
//   - services/param-store.ts:108-125 — ParamStore (storeStackConfig /
//     loadStackConfig / deleteStackConfig / listStackNames)
//   - services/param-store.ts:131-133 — stackConfigKey(workspaceId, name) =
//     `openvideocore/${workspaceId}/${name}`
//   - services/param-store.ts:602-608 — ConfigKvStore (get/set/delete/
//     listByPrefix), which structurally satisfies WorkspaceIdStore
//   - services/workspace-stack.ts — resolveWorkspaceId / WORKSPACE_ID_PIN_KEY /
//     WorkspaceStackResolver({ workspaceIdStore })
//   - @osaas/client-core admin.d.ts:2-5,42 — Subscription / listSubscriptions

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';

const createInstance = vi.fn();
const getInstance = vi.fn();
const saveSecret = vi.fn();
const waitForInstanceReady = vi.fn(async () => undefined);
const getPortsForInstance = vi.fn(async () => []);
const listSubscriptions = vi.fn(async () => [
  { serviceId: 'minio-minio', tenantId: 'workspace-tenant-a' }
]);

vi.mock('@osaas/client-core', () => ({
  createInstance: (...args: unknown[]) => createInstance(...(args as [])),
  getInstance: (...args: unknown[]) => getInstance(...(args as [])),
  removeInstance: vi.fn(),
  getPortsForInstance: (...args: unknown[]) => getPortsForInstance(...(args as [])),
  waitForInstanceReady: (...args: unknown[]) => waitForInstanceReady(...(args as [])),
  saveSecret: (...args: unknown[]) => saveSecret(...(args as [])),
  listSubscriptions: (...args: unknown[]) => listSubscriptions(...(args as [])),
  Context: class {}
}));

// The provision flow talks S3 to the freshly created object store and HTTP to
// the document store; mock both so the flow completes without a live backend.
vi.mock('minio', () => ({
  Client: class {
    async bucketExists() {
      return true;
    }
    async makeBucket() {
      return undefined;
    }
    async setBucketPolicy() {
      return undefined;
    }
    async makeRequestAsync() {
      return undefined;
    }
  }
}));

vi.mock('nano', () => ({
  default: () => ({
    db: {
      async create() {
        return undefined;
      }
    }
  })
}));

process.env['MINIO_ROOT_PASSWORD'] = 'test-minio-password';
process.env['COUCHDB_ADMIN_PASSWORD'] = 'test-couchdb-password';

import { provisionRouter } from './provision.js';
import {
  stackConfigKey,
  type ParamStore,
  type StackConfig
} from '../services/param-store.js';
import {
  WorkspaceStackResolver,
  WORKSPACE_ID_ENV_VAR,
  WORKSPACE_ID_PIN_KEY,
  type WorkspaceIdStore
} from '../services/workspace-stack.js';
import { OperationStore, type Operation } from '../services/operation-store.js';

const TENANT_A = 'workspace-tenant-a';

const getServiceAccessToken = vi.fn(async () => 'test-sat');
const osc = { getServiceAccessToken } as never;

function instanceFor(serviceId: string) {
  const host =
    serviceId === 'minio-minio'
      ? 'https://minio.example.osaas.io'
      : serviceId === 'apache-couchdb'
        ? 'https://couch.example.osaas.io'
        : 'https://valkey.example.osaas.io';
  return { name: 'mystack', url: host };
}

// ONE fake config-service instance behind both views, exactly as main.ts wires
// it: the same store backs the stack configs and the workspace-id pin.
function makeConfigService(): {
  paramStore: ParamStore;
  pinStore: WorkspaceIdStore;
  namespacesRead: string[];
  keys: () => string[];
} {
  const kv = new Map<string, string>();
  const namespacesRead: string[] = [];
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
      kv.set(key, value);
    },
    async listByPrefix(prefix) {
      return [...kv.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value }));
    }
  };
  return { paramStore, pinStore, namespacesRead, keys: () => [...kv.keys()] };
}

async function buildApp(paramStore: ParamStore, workspaceIdStore: WorkspaceIdStore) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(provisionRouter, {
    prefix: '/api/v1/provision',
    osc,
    paramStore,
    workspaceIdStore,
    operationStore: new OperationStore()
  });
  await app.ready();
  return app;
}

async function provisionAndWait(
  app: Awaited<ReturnType<typeof buildApp>>,
  name = 'mystack'
): Promise<Operation> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/provision',
    payload: { name }
  });
  expect(res.statusCode).toBe(202);
  const { operationId } = res.json();
  for (let i = 0; i < 500; i++) {
    const poll = await app.inject({
      method: 'GET',
      url: `/api/v1/provision/operations/${operationId}`
    });
    const op = poll.json() as Operation;
    if (op.status === 'done' || op.status === 'failed') return op;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('operation did not complete in time');
}

const SAVED_WORKSPACE_ID = process.env[WORKSPACE_ID_ENV_VAR];

afterAll(() => {
  if (SAVED_WORKSPACE_ID === undefined) delete process.env[WORKSPACE_ID_ENV_VAR];
  else process.env[WORKSPACE_ID_ENV_VAR] = SAVED_WORKSPACE_ID;
});

beforeEach(() => {
  // Force the pin/derive path rather than the explicit operator override.
  delete process.env[WORKSPACE_ID_ENV_VAR];
  createInstance.mockReset();
  getInstance.mockReset();
  saveSecret.mockReset();
  listSubscriptions.mockClear();
  listSubscriptions.mockImplementation(async () => [
    { serviceId: 'minio-minio', tenantId: TENANT_A }
  ]);
  createInstance.mockImplementation(async (_c, serviceId: string) =>
    instanceFor(serviceId)
  );
  getInstance.mockImplementation(async (_c, serviceId: string) =>
    instanceFor(serviceId)
  );
});

describe('provision write side pins the workspace namespace (issue #776)', () => {
  it('persists the stack under the pinned namespace, and a later boot with NO subscriptions still resolves it', async () => {
    const { paramStore, pinStore, namespacesRead, keys } = makeConfigService();
    const app = await buildApp(paramStore, pinStore);

    const op = await provisionAndWait(app);
    expect(op.status).toBe('done');

    // The route wrote under the tenant-scoped namespace AND pinned it, so the
    // write key and every later read key are the same string.
    expect(keys()).toContain(stackConfigKey(TENANT_A, 'mystack'));
    expect(await pinStore.get(WORKSPACE_ID_PIN_KEY)).toBe(TENANT_A);

    // A later boot: brand-new resolver over the SAME stores, and OSC now reports
    // no subscriptions at all (every instance torn down / list unavailable).
    // Pre-#776 this boot derived `default`, missed the tenant-scoped key and came
    // up with no storage.
    listSubscriptions.mockImplementation(async () => []);
    namespacesRead.length = 0;
    const resolver = new WorkspaceStackResolver({
      paramStore,
      oscContext: osc,
      minioPassword: 'test-minio-password',
      couchPassword: 'test-couchdb-password',
      workspaceIdStore: pinStore
    });

    expect(await resolver.resolveStackName(undefined)).toBe('mystack');
    expect(await resolver.resolveStackName('mystack')).toBe('mystack');
    // Every read addressed the namespace provisioning wrote under.
    expect(new Set(namespacesRead)).toEqual(new Set([TENANT_A]));
  });

  it('GET /api/v1/provision lists stacks under the pinned namespace, not a re-derived one', async () => {
    const { paramStore, pinStore } = makeConfigService();
    const app = await buildApp(paramStore, pinStore);

    expect((await provisionAndWait(app)).status).toBe('done');

    // A membership change between calls moves what the OSC derivation would
    // return (the live payload carries PUBLISHER tenant ids, not the
    // subscriber's). The pinned namespace must win.
    listSubscriptions.mockImplementation(async () => [
      { serviceId: 'aaa-some-service', tenantId: 'aaa-publisher' }
    ]);

    const app2 = await buildApp(paramStore, pinStore);
    const res = await app2.inject({ method: 'GET', url: '/api/v1/provision' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(['mystack']);
  });
});
