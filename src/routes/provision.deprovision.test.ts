import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';

const getInstance = vi.fn();
// Teardown confirms an empty getInstance probe against listInstances before it
// believes the instance is gone (issue #1039) — getInstance returns `undefined`
// for ANY non-401 error (@osaas/client-core lib/core.js:127-150), while
// listInstances (lib/core.js:160-170) rejects on error instead of swallowing it.
const listInstances = vi.fn();
const removeInstance = vi.fn();

// These routes are not caller-authenticated: the OSC SDK authenticates to OSC
// with the deployment's own OSC_ACCESS_TOKEN. Parameter-store keys use the
// CONSTANT namespace segment STACK_CONFIG_NAMESPACE (issue #804) — one
// deployment is one tenant (ADR-018/ADR-020), so there is no tenant id to derive
// and listSubscriptions is never consulted for it.
vi.mock('@osaas/client-core', () => ({
  // createInstance/waitForInstanceReady are imported by provision.ts but the
  // DELETE path under test does not invoke them.
  createInstance: vi.fn(),
  getInstance: (...args: unknown[]) => getInstance(...args),
  listInstances: (...args: unknown[]) => listInstances(...args),
  removeInstance: (...args: unknown[]) => removeInstance(...args),
  getPortsForInstance: vi.fn(),
  listSubscriptions: vi.fn(async () => {
    throw new Error('listSubscriptions must never be called for namespace resolution (#804)');
  }),
  waitForInstanceReady: vi.fn(),
  // Readiness waits go through the bounded helper, which polls
  // getInstanceHealth (src/services/instance-readiness.ts, issue #1038). The
  // DELETE path under test never reaches it.
  getInstanceHealth: vi.fn(async () => 'running'),
  saveSecret: vi.fn(),
  Context: class {}
}));

// Provisioning credentials are read from the environment at router
// registration time (ADR-002, issue #30); set them so the router can register.
process.env['MINIO_ROOT_PASSWORD'] = 'test-minio-password';
process.env['COUCHDB_ADMIN_PASSWORD'] = 'test-couchdb-password';

import { provisionRouter } from './provision.js';
import { PACKAGER_SERVICE_ID } from '../services/stack.js';
import type { ParamStore } from '../services/param-store.js';
import { STACK_CONFIG_NAMESPACE } from '../services/workspace-stack.js';
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
  listInstances.mockReset();
  removeInstance.mockReset();
  getServiceAccessToken.mockClear();
  // Default: the confirming read succeeds and shows nothing, so an empty probe
  // means the instance really is gone.
  listInstances.mockResolvedValue([]);
});

// A StackConfig as it would be returned from the parameter store. The
// services[] list drives teardown (issue #29).
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
    // Key shape (issue #804): looked up under the CONSTANT namespace segment —
    // the same one the runtime resolver reads — with the stack NAME as the
    // discriminator.
    expect(paramStore.loadStackConfig).toHaveBeenCalledWith(
      STACK_CONFIG_NAMESPACE,
      'mystack'
    );
    // Param store entry removed on successful teardown.
    expect(paramStore.deleteStackConfig).toHaveBeenCalledWith(
      STACK_CONFIG_NAMESPACE,
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

  // Issue #1039: the probe used to read ANY fault as "already gone", so a DELETE
  // during a network fault reported success, removed nothing, and deleted the
  // stored config — the only record of what was left to clean up.
  it('keeps the store entry when the teardown probe cannot be verified', async () => {
    // getInstance resolves undefined because its request errored, not because
    // the instance is gone; the confirming read fails for the same reason.
    getInstance.mockResolvedValue(undefined);
    listInstances.mockRejectedValue(new Error('fetch failed'));
    const paramStore = makeParamStore(STORED_CONFIG);

    const app = await buildApp(paramStore);
    const op = await deprovisionAndWait(app, 'mystack');

    expect(op.status).toBe('done');
    // Unverifiable, therefore failed — NOT the old silent not_found success.
    expect(op.result.status).toBe('failed');
    const services = (op.result.services ?? []) as { status: string }[];
    expect(services).toHaveLength(STORED_CONFIG.services.length);
    expect(services.every((s) => s.status === 'failed')).toBe(true);
    // The record of what still needs removing survives, so a retry can finish.
    expect(paramStore.deleteStackConfig).not.toHaveBeenCalled();
    // And nothing was deleted on the strength of an unverified probe.
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

// Issue #1056: the on-demand packager is torn down OUTSIDE the stored-config
// teardown (it is normally absent from services[]), and its outcome used to live
// only in a log line. The stack status was therefore computed without it, so a
// packager that survived teardown was reported as a clean removal, the stored
// config — the only record of what was left — was deleted, and the instance kept
// running and billing with nothing naming it.
describe('DELETE /api/v1/provision/:name folds the on-demand packager outcome into the result (#1056)', () => {
  // The normal case since packaging became on-demand (#243/#267): the packager
  // is NOT in services[], so the route reconciles it against OSC separately.
  const CONFIG_WITHOUT_PACKAGER = {
    ...STORED_CONFIG,
    services: STORED_CONFIG.services.filter(
      (s) => s.serviceId !== PACKAGER_SERVICE_ID
    )
  };

  function servicesOf(result: {
    services?: unknown[];
  }): { serviceId: string; role: string; status: string; error?: string }[] {
    return (result.services ?? []) as never;
  }

  // Acceptance: static services return removed and the packager returns failed.
  // The parameter-store entry is kept and the op result names the packager.
  it('keeps the store entry and names the packager when only the packager fails', async () => {
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockImplementation(async (_c, serviceId: string) => {
      if (serviceId === PACKAGER_SERVICE_ID) {
        throw new Error('packager removal rejected');
      }
      return undefined;
    });
    const paramStore = makeParamStore(CONFIG_WITHOUT_PACKAGER);

    const app = await buildApp(paramStore);
    const op = await deprovisionAndWait(app, 'mystack');

    expect(op.status).toBe('done');
    // Previously 'removed': the packager outcome was not in the aggregate.
    expect(op.result.status).toBe('failed');

    const services = servicesOf(op.result);
    const packager = services.find((s) => s.serviceId === PACKAGER_SERVICE_ID);
    expect(packager).toBeDefined();
    expect(packager?.status).toBe('failed');
    expect(packager?.error).toContain('packager removal rejected');
    // Every stored service still reports its own successful removal.
    expect(
      CONFIG_WITHOUT_PACKAGER.services.every(
        (stored) =>
          services.find((s) => s.serviceId === stored.serviceId)?.status ===
          'removed'
      )
    ).toBe(true);

    // The record of what still needs removing survives, so a retry can finish.
    expect(paramStore.deleteStackConfig).not.toHaveBeenCalled();
  });

  // Regression guard on the happy path: a stack that never packaged has no
  // packager, and that must NOT degrade the reported status or strand the entry.
  it('still reports removed and deletes the entry when no packager was ever provisioned', async () => {
    getInstance.mockImplementation(async (_c, serviceId: string) =>
      serviceId === PACKAGER_SERVICE_ID ? undefined : { name: 'mystack' }
    );
    // Confirmed absent: the list read succeeds and shows no packager.
    listInstances.mockResolvedValue([]);
    removeInstance.mockResolvedValue(undefined);
    const paramStore = makeParamStore(CONFIG_WITHOUT_PACKAGER);

    const app = await buildApp(paramStore);
    const op = await deprovisionAndWait(app, 'mystack');

    expect(op.status).toBe('done');
    expect(op.result.status).toBe('removed');
    // A confirmed-absent packager contributes no entry, exactly as before.
    expect(
      servicesOf(op.result).some((s) => s.serviceId === PACKAGER_SERVICE_ID)
    ).toBe(false);
    expect(paramStore.deleteStackConfig).toHaveBeenCalled();
  });

  // Acceptance: an UNCONFIRMABLE packager probe must not read as "already gone".
  // This is the #1039 defect in its third copy — the one PR #1047 did not reach.
  it('keeps the store entry when the packager probe cannot be verified', async () => {
    // Static services are fine; only the packager's reads fault.
    getInstance.mockImplementation(async (_c, serviceId: string) =>
      serviceId === PACKAGER_SERVICE_ID ? undefined : { name: 'mystack' }
    );
    listInstances.mockImplementation(async (_c, serviceId: string) => {
      if (serviceId === PACKAGER_SERVICE_ID) {
        throw new TypeError('fetch failed');
      }
      return [];
    });
    removeInstance.mockResolvedValue(undefined);
    const paramStore = makeParamStore(CONFIG_WITHOUT_PACKAGER);

    const app = await buildApp(paramStore);
    const op = await deprovisionAndWait(app, 'mystack');

    expect(op.status).toBe('done');
    expect(op.result.status).toBe('failed');
    expect(
      servicesOf(op.result).find((s) => s.serviceId === PACKAGER_SERVICE_ID)
        ?.status
    ).toBe('failed');
    expect(paramStore.deleteStackConfig).not.toHaveBeenCalled();
    // Nothing was deleted for the packager on an unverified probe.
    expect(
      removeInstance.mock.calls.some((c) => c[1] === PACKAGER_SERVICE_ID)
    ).toBe(false);
  });

  // Acceptance: the store-less DELETE path reports the packager outcome too. It
  // has no config to keep, but the result must not read as clean.
  it('reports the packager outcome on the store-less path, exactly once', async () => {
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockImplementation(async (_c, serviceId: string) => {
      if (serviceId === PACKAGER_SERVICE_ID) {
        throw new Error('packager removal rejected');
      }
      return undefined;
    });

    const app = await buildApp();
    const op = await deprovisionAndWait(app, 'mystack');

    expect(op.status).toBe('done');
    expect(op.result.status).toBe('failed');

    const services = servicesOf(op.result);
    // The static TEARDOWN_ORDER also covers the packager, so the two attempts
    // must merge into ONE reported packager rather than double-counting it.
    const packagerEntries = services.filter(
      (s) => s.serviceId === PACKAGER_SERVICE_ID
    );
    expect(packagerEntries).toHaveLength(1);
    expect(packagerEntries[0]?.status).toBe('failed');
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

  it('returns 200 with stored coordinates, read under the constant namespace', async () => {
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
    expect(loadStackConfig).toHaveBeenCalledWith(STACK_CONFIG_NAMESPACE, 'mystack');
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
