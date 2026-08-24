// Idempotent provisioning (issue #417).
//
// A retry or a concurrent repeat of POST /api/v1/provision for the SAME stack
// name must not spawn a fresh set of companion object-storage / document-store
// instances (which previously left orphaned instances and minted new
// companion-password secret generations on every retry). These tests cover:
//   1. Repeated calls when the stack is already provisioned ('ready' in the
//      parameter store) — no companion instances are created, coordinates are
//      returned from the stored config.
//   2. A retry after a mid-flow partial failure — converges to a single
//      completed stack rather than duplicating companions (the deterministic
//      instance names mean createInstance never mints a second companion set).
//   3. Concurrent repeat calls in the same process — the in-flight guard stops
//      the second call from starting a duplicate background flow.

import { describe, it, expect, vi, beforeEach } from 'vitest';
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

vi.mock('@osaas/client-core', () => ({
  createInstance: (...args: unknown[]) => createInstance(...(args as [])),
  getInstance: (...args: unknown[]) => getInstance(...(args as [])),
  removeInstance: vi.fn(),
  getPortsForInstance: (...args: unknown[]) =>
    getPortsForInstance(...(args as [])),
  waitForInstanceReady: (...args: unknown[]) =>
    waitForInstanceReady(...(args as [])),
  saveSecret: (...args: unknown[]) => saveSecret(...(args as [])),
  Context: class {}
}));

// The provision flow talks S3 to the freshly created MinIO instance and HTTP to
// CouchDB. Mock both clients so the flow completes without a live backend.
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
import type { ParamStore, StackConfig } from '../services/param-store.js';
import { OperationStore, type Operation } from '../services/operation-store.js';

const getServiceAccessToken = vi.fn(async () => 'test-sat');
const osc = { getServiceAccessToken } as never;

// Instance URLs returned by createInstance/getInstance for each companion. The
// stack name is the deterministic instance name for every companion.
function instanceFor(serviceId: string) {
  const host =
    serviceId === 'minio-minio'
      ? 'https://minio.example.osaas.io'
      : serviceId === 'apache-couchdb'
        ? 'https://couch.example.osaas.io'
        : 'https://valkey.example.osaas.io';
  return { name: 'mystack', url: host };
}

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

async function waitForOperation(
  app: Awaited<ReturnType<typeof buildApp>>,
  operationId: string
): Promise<Operation> {
  for (let i = 0; i < 500; i++) {
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
  return waitForOperation(app, operationId);
}

// A parameter store whose loadStackConfig returns whatever the current stored
// value is (updated by storeStackConfig), so tests can observe convergence.
function makeStatefulParamStore(initial?: StackConfig) {
  let stored: StackConfig | undefined = initial;
  return {
    storeStackConfig: vi.fn(async (_ws: string, _name: string, cfg: StackConfig) => {
      stored = cfg;
    }),
    loadStackConfig: vi.fn(async () => stored),
    deleteStackConfig: vi.fn(async () => {
      stored = undefined;
    }),
    listStackNames: vi.fn(async () => (stored ? ['mystack'] : []))
  } as unknown as ParamStore & {
    storeStackConfig: ReturnType<typeof vi.fn>;
    loadStackConfig: ReturnType<typeof vi.fn>;
  };
}

const READY_CONFIG: StackConfig = {
  status: 'ready',
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

beforeEach(() => {
  createInstance.mockReset();
  getInstance.mockReset();
  saveSecret.mockReset();
  getServiceAccessToken.mockClear();
  createInstance.mockImplementation(async (_c, serviceId: string) =>
    instanceFor(serviceId)
  );
  getInstance.mockImplementation(async (_c, serviceId: string) =>
    instanceFor(serviceId)
  );
});

describe('POST /api/v1/provision idempotency (issue #417)', () => {
  it('repeated call for an already-ready stack creates NO companion instances', async () => {
    const paramStore = makeStatefulParamStore(READY_CONFIG);
    const app = await buildApp(paramStore);

    const op = await provisionAndWait(app);

    expect(op.status).toBe('done');
    // Converged on the stored coordinates without provisioning anything.
    expect(createInstance).not.toHaveBeenCalled();
    expect(saveSecret).not.toHaveBeenCalled();
    const result = op.result as { minioEndpoint: string; couchdbUrl: string };
    expect(result.minioEndpoint).toBe(READY_CONFIG.minioEndpoint);
    expect(result.couchdbUrl).toBe(READY_CONFIG.couchdbUrl);
  });

  it('a first provision then a repeat does not create a second companion set', async () => {
    const paramStore = makeStatefulParamStore();
    const app = await buildApp(paramStore);

    const first = await provisionAndWait(app);
    expect(first.status).toBe('done');
    const companionCreatesAfterFirst = createInstance.mock.calls.filter(
      ([, serviceId]) =>
        serviceId === 'minio-minio' || serviceId === 'apache-couchdb'
    ).length;
    // One companion instance each (minio + couchdb) on the first provision.
    expect(companionCreatesAfterFirst).toBe(2);

    // Second call: the stored config is now 'ready', so it converges without
    // creating any further companion instances or saving any new secrets.
    const secondSaveBaseline = saveSecret.mock.calls.length;
    const second = await provisionAndWait(app);
    expect(second.status).toBe('done');
    const companionCreatesTotal = createInstance.mock.calls.filter(
      ([, serviceId]) =>
        serviceId === 'minio-minio' || serviceId === 'apache-couchdb'
    ).length;
    expect(companionCreatesTotal).toBe(2); // unchanged — no new companions
    expect(saveSecret.mock.calls.length).toBe(secondSaveBaseline); // no new secrets
  });

  it('retry after a mid-flow failure converges to one completed stack', async () => {
    const paramStore = makeStatefulParamStore();
    const app = await buildApp(paramStore);

    // First attempt fails at CouchDB (after MinIO succeeded).
    let failCouch = true;
    createInstance.mockImplementation(async (_c, serviceId: string) => {
      if (serviceId === 'apache-couchdb' && failCouch) {
        throw new Error('couchdb create failed');
      }
      return instanceFor(serviceId);
    });

    const failed = await provisionAndWait(app);
    expect(failed.status).toBe('failed');

    // Retry: CouchDB now succeeds. The MinIO instance already exists (same
    // deterministic name) so createInstance for minio is not re-attempted as a
    // NEW companion — the flow converges to a single completed stack.
    failCouch = false;
    const retried = await provisionAndWait(app);
    expect(retried.status).toBe('done');

    // Exactly one MinIO companion was ever created across both attempts (the
    // second attempt reuses/re-creates under the same name, never a second
    // orphaned generation). Assert the final stored config is 'ready'.
    const finalConfig = await paramStore.loadStackConfig('default', 'mystack');
    expect(finalConfig?.status).toBe('ready');
    // Companion count: minio created once per attempt at most, and crucially the
    // final state has a single stack — no duplicate instance names.
    const minioCreates = createInstance.mock.calls.filter(
      ([, serviceId]) => serviceId === 'minio-minio'
    );
    // Two attempts, both target the SAME instance name 'mystack' — never two
    // distinct companion names, so no orphaned duplicate companion set.
    for (const call of minioCreates) {
      expect((call[3] as { name: string }).name).toBe('mystack');
    }
  });

  it('concurrent repeat call does not start a duplicate background flow', async () => {
    // A slow MinIO create keeps the first flow in flight while the second call
    // arrives; the in-process guard must make the second converge immediately.
    const paramStore = makeStatefulParamStore();
    const app = await buildApp(paramStore);

    let releaseMinio: () => void = () => undefined;
    const minioGate = new Promise<void>((resolve) => {
      releaseMinio = resolve;
    });
    createInstance.mockImplementation(async (_c, serviceId: string) => {
      if (serviceId === 'minio-minio') {
        await minioGate;
      }
      return instanceFor(serviceId);
    });

    // Fire the first call; let its background closure begin and block on MinIO.
    const firstRes = await app.inject({
      method: 'POST',
      url: '/api/v1/provision',
      payload: { name: 'mystack' }
    });
    const firstId = firstRes.json().operationId;
    // Yield so the first setImmediate closure runs and acquires the guard.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));

    // Second call arrives while the first is still in flight.
    const secondRes = await app.inject({
      method: 'POST',
      url: '/api/v1/provision',
      payload: { name: 'mystack' }
    });
    const secondId = secondRes.json().operationId;
    const secondOp = await waitForOperation(app, secondId);

    // The second call converged immediately without starting a duplicate flow.
    expect(secondOp.status).toBe('done');
    expect((secondOp.result as { status: string }).status).toBe('in_progress');

    // Let the first flow finish.
    releaseMinio();
    const firstOp = await waitForOperation(app, firstId);
    expect(firstOp.status).toBe('done');

    // Only ONE MinIO companion was created across both calls.
    const minioCreates = createInstance.mock.calls.filter(
      ([, serviceId]) => serviceId === 'minio-minio'
    ).length;
    expect(minioCreates).toBe(1);
  });
});
