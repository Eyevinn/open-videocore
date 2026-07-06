import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';

const getInstance = vi.fn();
const removeInstance = vi.fn();

// These routes are not caller-authenticated: the OSC SDK authenticates to OSC
// with the deployment's own OSC_ACCESS_TOKEN, and the parameter store is scoped
// by the deployment's own tenant id, derived via listSubscriptions.
vi.mock('@osaas/client-core', () => ({
  // createInstance/waitForInstanceReady are imported by provision.ts but the
  // DELETE path under test does not invoke them.
  createInstance: vi.fn(),
  getInstance: (...args: unknown[]) => getInstance(...args),
  removeInstance: (...args: unknown[]) => removeInstance(...args),
  getPortsForInstance: vi.fn(),
  listSubscriptions: vi.fn(async () => [
    { serviceId: 'minio-minio', tenantId: 'workspace-a' }
  ]),
  waitForInstanceReady: vi.fn(),
  saveSecret: vi.fn(),
  Context: class {}
}));

// Provisioning credentials are read from the environment at router
// registration time (ADR-002, issue #30); set them so the router can register.
process.env['MINIO_ROOT_PASSWORD'] = 'test-minio-password';
process.env['COUCHDB_ADMIN_PASSWORD'] = 'test-couchdb-password';

import { provisionRouter } from './provision.js';
import type { ParamStore } from '../services/param-store.js';
import { OperationStore, type Operation } from '../services/operation-store.js';

const getServiceAccessToken = vi.fn(async () => 'test-sat');
const osc = { getServiceAccessToken } as never;

async function buildApp(paramStore?: ParamStore) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const operationStore = new OperationStore();
  await app.register(provisionRouter, {
    prefix: '/api/v1/provision',
    osc,
    paramStore,
    operationStore
  });
  await app.ready();
  return app;
}

// Provision/deprovision are async: the route returns 202 with an operationId and
// runs the real work in a background setImmediate closure. Poll GET
// /operations/:id until the operation reaches a terminal state.
async function waitForOperation(
  app: Awaited<ReturnType<typeof buildApp>>,
  operationId: string
): Promise<Operation> {
  for (let i = 0; i < 200; i++) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/provision/operations/${operationId}`
    });
    const op = res.json() as Operation;
    if (op.status === 'done' || op.status === 'failed') return op;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('operation did not complete in time');
}

// Issue a DELETE, assert the 202 envelope, then poll the resulting operation to
// completion and return its final teardown result.
async function deprovisionAndWait(
  app: Awaited<ReturnType<typeof buildApp>>,
  name: string
): Promise<{ status: string; result: { status: string; services?: unknown[] } }> {
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/v1/provision/${name}`
  });
  expect(res.statusCode).toBe(202);
  const { operationId, status } = res.json();
  expect(status).toBe('pending');
  const op = await waitForOperation(app, operationId);
  return op as never;
}

beforeEach(() => {
  getInstance.mockReset();
  removeInstance.mockReset();
  getServiceAccessToken.mockClear();
});

// A StackConfig as it would be returned from the parameter store for a stack
// owned by workspace-a. The services[] list drives teardown (issue #29).
const STORED_CONFIG = {
  minioEndpoint: 'https://minio.example.osaas.io',
  couchdbUrl: 'https://couch.example.osaas.io',
  redisUrl: 'redis://valkey.svc.cluster.local:6379',
  encoreUrl: 'https://encore.example.osaas.io',
  encoreCallbackUrl: 'https://callback.example.osaas.io',
  sourceBucket: 'openvideocore-source',
  packagedBucket: 'openvideocore-packaged',
  services: [
    { serviceId: 'minio-minio', instanceName: 'mystack' },
    { serviceId: 'apache-couchdb', instanceName: 'mystack' },
    { serviceId: 'valkey-io-valkey', instanceName: 'mystack' },
    { serviceId: 'encore', instanceName: 'mystack' },
    { serviceId: 'eyevinn-encore-callback-listener', instanceName: 'mystack' },
    { serviceId: 'eyevinn-encore-packager', instanceName: 'mystack' }
  ]
};

function makeParamStore(loadResult: unknown) {
  return {
    storeStackConfig: vi.fn(),
    loadStackConfig: vi.fn(async () => loadResult),
    deleteStackConfig: vi.fn(async () => undefined)
  } as unknown as ParamStore & {
    loadStackConfig: ReturnType<typeof vi.fn>;
    deleteStackConfig: ReturnType<typeof vi.fn>;
  };
}

describe('DELETE /api/v1/provision/:name (param store, issue #29)', () => {
  it('reads services[] from the store, tears down, and deletes the entry', async () => {
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockResolvedValue(undefined);
    const paramStore = makeParamStore(STORED_CONFIG);

    const app = await buildApp(paramStore);
    const op = await deprovisionAndWait(app, 'mystack');

    expect(op.status).toBe('done');
    expect(op.result.status).toBe('removed');
    // Ownership scoping: looked up under the caller's workspace.
    expect(paramStore.loadStackConfig).toHaveBeenCalledWith(
      'workspace-a',
      'mystack'
    );
    // Param store entry removed on successful teardown.
    expect(paramStore.deleteStackConfig).toHaveBeenCalledWith(
      'workspace-a',
      'mystack'
    );
    // Teardown removed every stored service.
    expect(removeInstance).toHaveBeenCalledTimes(STORED_CONFIG.services.length);
  });

  it('returns 404 when the store has no entry for this workspace (ownership)', async () => {
    const paramStore = makeParamStore(undefined);

    const app = await buildApp(paramStore);
    const op = await deprovisionAndWait(app, 'notmine');

    expect(op.status).toBe('done');
    expect(op.result.status).toBe('not_found');
    // No OSC teardown attempted for a stack the workspace does not own.
    expect(getInstance).not.toHaveBeenCalled();
    expect(removeInstance).not.toHaveBeenCalled();
    expect(paramStore.deleteStackConfig).not.toHaveBeenCalled();
  });

  it('is idempotent: a retry after the entry is gone returns 404 not_found', async () => {
    const paramStore = makeParamStore(undefined);
    const app = await buildApp(paramStore);
    const op = await deprovisionAndWait(app, 'mystack');
    expect(op.status).toBe('done');
    expect(op.result.status).toBe('not_found');
  });

  it('returns 502 and keeps the store entry when a teardown fails', async () => {
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockImplementation(async (_c, serviceId: string) => {
      if (serviceId === 'minio-minio') throw new Error('boom');
      return undefined;
    });
    const paramStore = makeParamStore(STORED_CONFIG);

    const app = await buildApp(paramStore);
    const op = await deprovisionAndWait(app, 'mystack');

    expect(op.status).toBe('done');
    expect(op.result.status).toBe('failed');
    // Entry retained so a retry can re-read services[] and finish teardown.
    expect(paramStore.deleteStackConfig).not.toHaveBeenCalled();
  });
});

describe('DELETE /api/v1/provision/:name (no param store, legacy)', () => {
  it('returns 200 status=removed on full teardown', async () => {
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockResolvedValue(undefined);

    const app = await buildApp();
    const op = await deprovisionAndWait(app, 'mystack');

    expect(op.status).toBe('done');
    expect(op.result.status).toBe('removed');
  });

  it('returns not_found for an already-deleted stack', async () => {
    getInstance.mockResolvedValue(undefined);

    const app = await buildApp();
    const op = await deprovisionAndWait(app, 'ghoststack');

    expect(op.status).toBe('done');
    expect(op.result.status).toBe('not_found');
  });

  it('reports failed on partial failure', async () => {
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockImplementation(async (_c, serviceId: string) => {
      if (serviceId === 'minio-minio') throw new Error('boom');
      return undefined;
    });

    const app = await buildApp();
    const op = await deprovisionAndWait(app, 'mystack');

    expect(op.status).toBe('done');
    const result = op.result as { status: string; services: { serviceId: string; status: string }[] };
    expect(result.status).toBe('failed');
    expect(
      result.services.find((s) => s.serviceId === 'minio-minio')?.status
    ).toBe('failed');
  });

  it('rejects an invalid stack name (400)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/provision/Invalid_Name'
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /api/v1/provision/:name (issue #31)', () => {
  const storedConfig = {
    minioEndpoint: 'https://minio.example.osaas.io',
    couchdbUrl: 'https://couch.example.osaas.io',
    redisUrl: 'redis://valkey.svc.cluster.local:6379',
    encoreUrl: 'https://encore.example.osaas.io',
    encoreCallbackUrl: 'https://callback.example.osaas.io',
    sourceBucket: 'openvideocore-source',
    packagedBucket: 'openvideocore-packaged',
    services: [{ serviceId: 'minio-minio', instanceName: 'mystack' }]
  };

  it('returns 200 with stored coordinates, scoped to the workspace', async () => {
    const loadStackConfig = vi.fn(async () => storedConfig);
    const paramStore = {
      storeStackConfig: vi.fn(),
      loadStackConfig
    } as unknown as ParamStore;

    const app = await buildApp(paramStore);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/provision/mystack'
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(storedConfig);
    expect(loadStackConfig).toHaveBeenCalledWith('workspace-a', 'mystack');
  });

  it('returns 404 when no config is stored for the stack', async () => {
    const paramStore = {
      storeStackConfig: vi.fn(),
      loadStackConfig: vi.fn(async () => undefined)
    } as unknown as ParamStore;

    const app = await buildApp(paramStore);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/provision/ghoststack'
    });

    expect(res.statusCode).toBe(404);
  });

  it('returns 501 when the parameter store is not configured', async () => {
    const app = await buildApp(undefined);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/provision/mystack'
    });

    expect(res.statusCode).toBe(501);
  });
});
