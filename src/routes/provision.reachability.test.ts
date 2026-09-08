// Stack reachability diagnostics endpoint (issue #617, parent #602):
// GET /api/v1/provision/:name/reachability.
//
// A read-only operator surface that probes each configured dependency (queue/
// Valkey, storage) of a named stack and returns per-dependency reachable/
// unreachable + the CHECKED endpoint. These tests build provisionRouter with a
// stateful in-memory ParamStore pre-seeded with a ready StackConfig and an
// INJECTED reachabilityProbeFactory (no live network I/O), covering the issue
// #617 acceptance criteria for the diagnostics surface:
//   - a fully healthy stack -> 200, every dependency reachable + its endpoint;
//   - a stack with one unreachable dependency -> 200, that dependency
//     unreachable (named + endpoint), healthy === false;
//   - an unknown stack -> 404; no param store -> 501; no probe factory -> 501.
//
// Contract sources cited before writing:
//   - provisionRouter options (paramStore, reachabilityProbeFactory):
//     src/routes/provision.ts ProvisionRouterOptions.
//   - StackConfig coordinates (redisUrl / minioEndpoint / sourceBucket):
//     src/services/param-store.ts StackConfig.
//   - StackReachabilityDeps / QueueProbeClient / StorageProbeClient:
//     src/services/stack-reachability.ts.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('@osaas/client-core', () => ({
  createInstance: vi.fn(),
  getInstance: vi.fn(),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(async () => []),
  waitForInstanceReady: vi.fn(async () => undefined),
  saveSecret: vi.fn(),
  Context: class {}
}));

vi.mock('minio', () => ({ Client: class {} }));
vi.mock('nano', () => ({ default: () => ({ db: { async create() {} } }) }));

// provisionRouter requires these at registration (src/routes/provision.ts:507).
process.env['MINIO_ROOT_PASSWORD'] = 'test-minio-password';
process.env['COUCHDB_ADMIN_PASSWORD'] = 'test-couchdb-password';

import { provisionRouter } from './provision.js';
import type { ParamStore, StackConfig } from '../services/param-store.js';
import type { StackReachabilityDeps } from '../services/stack-reachability.js';
import { OperationStore } from '../services/operation-store.js';

const osc = { getServiceAccessToken: vi.fn(async () => 'test-sat') } as never;

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

function makeParamStore(config?: StackConfig): ParamStore {
  return {
    storeStackConfig: vi.fn(async () => {}),
    loadStackConfig: vi.fn(async () => config),
    deleteStackConfig: vi.fn(async () => {}),
    listStackNames: vi.fn(async () => (config ? ['mystack'] : []))
  } as unknown as ParamStore;
}

type DepView = {
  dependency: string;
  endpoint?: string;
  reachable: boolean;
  reason?: string;
  failure?: string;
};
type ReachabilityView = { stackName?: string; healthy: boolean; dependencies: DepView[] };

async function buildApp(opts: {
  paramStore?: ParamStore;
  reachabilityProbeFactory?: (config: StackConfig) => StackReachabilityDeps;
}) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(provisionRouter, {
    prefix: '/api/v1/provision',
    osc,
    operationStore: new OperationStore(),
    ...(opts.paramStore ? { paramStore: opts.paramStore } : {}),
    ...(opts.reachabilityProbeFactory
      ? { reachabilityProbeFactory: opts.reachabilityProbeFactory }
      : {})
  });
  await app.ready();
  return app;
}

// Probe-client factories injected in place of the real IORedis + MinioClient.
const healthyFactory = (): StackReachabilityDeps => ({
  queueClient: { ping: async () => 'PONG' },
  storageClient: { bucketExists: async () => true } as never,
  timeoutMs: 500
});
const queueDownFactory = (): StackReachabilityDeps => ({
  queueClient: {
    ping: async () => {
      throw new Error('ECONNREFUSED');
    }
  },
  storageClient: { bucketExists: async () => true } as never,
  timeoutMs: 500
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/v1/provision/:name/reachability — healthy stack', () => {
  it('returns 200 with every configured dependency reachable + its checked endpoint', async () => {
    const app = await buildApp({
      paramStore: makeParamStore(READY_CONFIG),
      reachabilityProbeFactory: healthyFactory
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/provision/mystack/reachability'
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ReachabilityView;
    expect(body.healthy).toBe(true);
    expect(body.stackName).toBe('mystack');
    const queue = body.dependencies.find((d) => d.dependency === 'queue');
    const storage = body.dependencies.find((d) => d.dependency === 'storage');
    expect(queue?.reachable).toBe(true);
    expect(queue?.endpoint).toBe('redis://valkey.svc.cluster.local:6379');
    expect(storage?.reachable).toBe(true);
    expect(storage?.endpoint).toBe('https://minio.example.osaas.io');
    await app.close();
  });
});

describe('GET /api/v1/provision/:name/reachability — one unreachable dependency', () => {
  it('returns 200, names the unreachable dependency + endpoint, healthy=false', async () => {
    const app = await buildApp({
      paramStore: makeParamStore(READY_CONFIG),
      reachabilityProbeFactory: queueDownFactory
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/provision/mystack/reachability'
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as ReachabilityView;
    expect(body.healthy).toBe(false);
    const queue = body.dependencies.find((d) => d.dependency === 'queue');
    const storage = body.dependencies.find((d) => d.dependency === 'storage');
    expect(queue?.reachable).toBe(false);
    expect(queue?.reason).toBe('unreachable');
    expect(queue?.endpoint).toBe('redis://valkey.svc.cluster.local:6379');
    expect(storage?.reachable).toBe(true);
    await app.close();
  });
});

describe('GET /api/v1/provision/:name/reachability — degraded wiring', () => {
  it('returns 404 for an unknown stack', async () => {
    const app = await buildApp({
      paramStore: makeParamStore(undefined),
      reachabilityProbeFactory: healthyFactory
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/provision/nope/reachability'
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 501 when no parameter store is configured', async () => {
    const app = await buildApp({ reachabilityProbeFactory: healthyFactory });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/provision/mystack/reachability'
    });
    expect(res.statusCode).toBe(501);
    await app.close();
  });

  it('returns 501 when no reachability probe factory is wired', async () => {
    const app = await buildApp({ paramStore: makeParamStore(READY_CONFIG) });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/provision/mystack/reachability'
    });
    expect(res.statusCode).toBe(501);
    await app.close();
  });
});
