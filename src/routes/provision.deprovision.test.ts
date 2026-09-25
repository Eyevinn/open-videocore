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
  name: string,
  // Optional raw query string (without the leading `?`), e.g.
  // 'skipServiceIds=minio-minio' for selective teardown (issue #738).
  query?: string
): Promise<{
  status: string;
  error?: string;
  result: { status: string; services?: unknown[] };
}> {
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/v1/provision/${name}${query ? `?${query}` : ''}`
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

// Opt-in selective teardown (issue #738): ?skipServiceIds=<id>[,<id>] preserves
// the named OSC service instances and tears down the rest of the stack.
describe('DELETE /api/v1/provision/:name — selective teardown (issue #738)', () => {
  type ServiceResult = { serviceId: string; role: string; status: string };

  // serviceIds passed to getInstance / removeInstance (arg index 1 in the
  // client-core signature getInstance(ctx, serviceId, name, token)).
  const probed = () => getInstance.mock.calls.map((c) => c[1] as string);
  const removed = () => removeInstance.mock.calls.map((c) => c[1] as string);

  it('preserves the named service, reports it skipped, and keeps the store entry', async () => {
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockResolvedValue(undefined);
    const paramStore = makeParamStore(STORED_CONFIG);

    const app = await buildApp(paramStore);
    const op = await deprovisionAndWait(
      app,
      'mystack',
      'skipServiceIds=minio-minio'
    );

    expect(op.status).toBe('done');
    // A deliberately preserved instance means the stack is not fully removed.
    expect(op.result.status).toBe('partial');
    const services = op.result.services as ServiceResult[];
    expect(services.find((s) => s.serviceId === 'minio-minio')?.status).toBe(
      'skipped'
    );
    // Preserved storage was never probed and never removed.
    expect(probed()).not.toContain('minio-minio');
    expect(removed()).not.toContain('minio-minio');
    // Every OTHER stored service was still torn down.
    expect(removed()).toHaveLength(STORED_CONFIG.services.length - 1);
    // The stored config is retained: deleting it would orphan the surviving
    // instance, and it lets a later unscoped DELETE finish the teardown.
    expect(paramStore.deleteStackConfig).not.toHaveBeenCalled();
  });

  it('accepts a comma-separated list', async () => {
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockResolvedValue(undefined);
    const paramStore = makeParamStore(STORED_CONFIG);

    const app = await buildApp(paramStore);
    const op = await deprovisionAndWait(
      app,
      'mystack',
      'skipServiceIds=minio-minio,apache-couchdb'
    );

    expect(op.result.status).toBe('partial');
    const skipped = (op.result.services as ServiceResult[])
      .filter((s) => s.status === 'skipped')
      .map((s) => s.serviceId);
    expect(skipped.sort()).toEqual(['apache-couchdb', 'minio-minio']);
    expect(removed()).toHaveLength(STORED_CONFIG.services.length - 2);
  });

  it('accepts repeated query params', async () => {
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockResolvedValue(undefined);
    const paramStore = makeParamStore(STORED_CONFIG);

    const app = await buildApp(paramStore);
    const op = await deprovisionAndWait(
      app,
      'mystack',
      'skipServiceIds=minio-minio&skipServiceIds=valkey-io-valkey'
    );

    const skipped = (op.result.services as ServiceResult[])
      .filter((s) => s.status === 'skipped')
      .map((s) => s.serviceId);
    expect(skipped.sort()).toEqual(['minio-minio', 'valkey-io-valkey']);
  });

  it('fails the operation without removing anything when a skip target is not part of the stack', async () => {
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockResolvedValue(undefined);
    const paramStore = makeParamStore(STORED_CONFIG);

    const app = await buildApp(paramStore);
    const op = await deprovisionAndWait(
      app,
      'mystack',
      'skipServiceIds=some-other-service'
    );

    // Loud, not inert: the request is rejected and the stack is untouched.
    expect(op.status).toBe('failed');
    expect(op.error).toContain('some-other-service');
    expect(removeInstance).not.toHaveBeenCalled();
    expect(paramStore.deleteStackConfig).not.toHaveBeenCalled();
  });

  it('rejects a malformed serviceId with 400 before creating an operation', async () => {
    const app = await buildApp(makeParamStore(STORED_CONFIG));
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/provision/mystack?skipServiceIds=Not_A_ServiceId'
    });

    expect(res.statusCode).toBe(400);
    expect(removeInstance).not.toHaveBeenCalled();
  });

  it('tears down the whole stack when the param is omitted (unchanged default)', async () => {
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockResolvedValue(undefined);
    const paramStore = makeParamStore(STORED_CONFIG);

    const app = await buildApp(paramStore);
    const op = await deprovisionAndWait(app, 'mystack');

    expect(op.result.status).toBe('removed');
    expect(
      (op.result.services as ServiceResult[]).some((s) => s.status === 'skipped')
    ).toBe(false);
    expect(paramStore.deleteStackConfig).toHaveBeenCalled();
  });

  it('preserves an on-demand packager that is not recorded in services[]', async () => {
    // Stack provisioned by the lazy-packager path: the packager is removed by
    // the introspection reconciliation, not by the stored-config teardown.
    const configWithoutPackager = {
      ...STORED_CONFIG,
      services: [
        { serviceId: 'minio-minio', instanceName: 'mystack' },
        { serviceId: 'apache-couchdb', instanceName: 'mystack' },
        { serviceId: 'valkey-io-valkey', instanceName: 'mystack' }
      ]
    };
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockResolvedValue(undefined);
    const paramStore = makeParamStore(configWithoutPackager);

    const app = await buildApp(paramStore);
    const op = await deprovisionAndWait(
      app,
      'mystack',
      'skipServiceIds=eyevinn-encore-packager'
    );

    // The reconciliation path must not remove the instance the caller kept.
    expect(removed()).not.toContain('eyevinn-encore-packager');
    // …and the preserved packager is reported even though nothing enumerated it.
    expect(op.result.status).toBe('partial');
    const packager = (op.result.services as ServiceResult[]).find(
      (s) => s.serviceId === 'eyevinn-encore-packager'
    );
    expect(packager?.status).toBe('skipped');
    expect(paramStore.deleteStackConfig).not.toHaveBeenCalled();
  });

  it('still reports failed (not partial) when another service fails alongside a skip', async () => {
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockImplementation(async (_c, serviceId: string) => {
      if (serviceId === 'apache-couchdb') throw new Error('boom');
      return undefined;
    });
    const paramStore = makeParamStore(STORED_CONFIG);

    const app = await buildApp(paramStore);
    const op = await deprovisionAndWait(
      app,
      'mystack',
      'skipServiceIds=minio-minio'
    );

    expect(op.result.status).toBe('failed');
    expect(paramStore.deleteStackConfig).not.toHaveBeenCalled();
  });

  it('works on the store-less legacy path and skips the packager reconciliation', async () => {
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockResolvedValue(undefined);

    const app = await buildApp();
    const op = await deprovisionAndWait(
      app,
      'mystack',
      'skipServiceIds=minio-minio,eyevinn-encore-packager'
    );

    expect(op.result.status).toBe('partial');
    const skipped = (op.result.services as ServiceResult[])
      .filter((s) => s.status === 'skipped')
      .map((s) => s.serviceId);
    expect(skipped.sort()).toEqual(['eyevinn-encore-packager', 'minio-minio']);
    expect(removed()).not.toContain('minio-minio');
    expect(removed()).not.toContain('eyevinn-encore-packager');
  });

  it('rejects an unknown skip target on the legacy path too', async () => {
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockResolvedValue(undefined);

    const app = await buildApp();
    const op = await deprovisionAndWait(
      app,
      'mystack',
      'skipServiceIds=not-in-this-stack'
    );

    expect(op.status).toBe('failed');
    expect(op.error).toContain('not-in-this-stack');
    expect(removeInstance).not.toHaveBeenCalled();
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
  // A fully capable stack: every core STACK_SERVICES role (storage, database,
  // queue) is present, so the on-demand packager can be provisioned and the
  // stack CAN complete the full ingest -> transcode -> package -> deliver flow.
  const storedConfig = {
    status: 'ready' as const,
    minioEndpoint: 'https://minio.example.osaas.io',
    couchdbUrl: 'https://couch.example.osaas.io',
    redisUrl: 'redis://valkey.svc.cluster.local:6379',
    sourceBucket: 'openvideocore-source',
    packagedBucket: 'openvideocore-packaged',
    services: [
      { serviceId: 'minio-minio', instanceName: 'mystack' },
      { serviceId: 'apache-couchdb', instanceName: 'mystack' },
      { serviceId: 'valkey-io-valkey', instanceName: 'mystack' }
    ]
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

  // Issue #338: readiness reflects packaging capability, not the raw stored
  // status. A fully capable stack still reports ready with no reason.
  it('reports ready (no reason) for a fully capable stack (#338)', async () => {
    const paramStore = {
      storeStackConfig: vi.fn(),
      loadStackConfig: vi.fn(async () => storedConfig)
    } as unknown as ParamStore;

    const app = await buildApp(paramStore);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/provision/mystack'
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ready');
    expect(body.reason).toBeUndefined();
  });

  // Issue #338: a stack whose inventory cannot package must NOT report ready.
  // Here the queue is absent, so the on-demand packager (which consumes the
  // shared Valkey queue) cannot be provisioned — the stack cannot package.
  it('reports non-ready with a machine-readable reason when the stack cannot package (#338)', async () => {
    const cannotPackage = {
      ...storedConfig,
      services: [
        { serviceId: 'minio-minio', instanceName: 'mystack' },
        { serviceId: 'apache-couchdb', instanceName: 'mystack' }
      ]
    };
    const paramStore = {
      storeStackConfig: vi.fn(),
      loadStackConfig: vi.fn(async () => cannotPackage)
    } as unknown as ParamStore;

    const app = await buildApp(paramStore);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/provision/mystack'
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).not.toBe('ready');
    // Machine-readable reason that names the missing capability. The queue is an
    // on-demand packager dependency, so its absence surfaces as the packaging
    // capability being unavailable.
    expect(body.reason).toBeDefined();
    expect(body.reason.code).toBe('packaging_capability_missing');
    expect(body.reason.capability).toBe('packaging');
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
