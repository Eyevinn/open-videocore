// Honouring `sourceStorage.bucket` / `packagedStorage.bucket` end to end
// (issue #1301, follow-up to #1299).
//
// With `HONOUR_CUSTOM_BUCKETS` on, the operator-named bucket must be the bucket
// that is CREATED on the stack's own object store, the bucket the public-read
// policy is applied to, and the bucket persisted as
// `StackConfig.sourceBucket` / `StackConfig.packagedBucket` — which is what
// every runtime binding resolves against (services/workspace-stack.ts binds
// `WorkspaceConnections.{sourceBucket,packagedBucket}` from those fields, and
// main.ts hands `stackCfg.packagedBucket` to the on-demand packager). The same
// stored config carries `storage.{source,packaged}.bucket`, which is what
// delivery-URL emission uses, so these tests assert the two agree: the pipeline
// and the emitted URLs name ONE bucket.
//
// With the flag off, the persisted buckets stay the stack defaults — the
// pre-#1301 behaviour.
//
// Contract verified before writing the bucket calls: minio@8
// `bucketExists(bucketName: string): Promise<boolean>` and
// `makeBucket(bucketName: string, region?, makeOpts?): Promise<void>`
// (node_modules/minio/dist/esm/internal/client.d.mts:203,207), plus
// `setBucketPolicy(bucketName: string, policy: string): Promise<void>` (:321).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';

const createInstance = vi.fn();
const getInstance = vi.fn();

vi.mock('@osaas/client-core', () => ({
  createInstance: (...args: unknown[]) => createInstance(...(args as [])),
  getInstance: (...args: unknown[]) => getInstance(...(args as [])),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(async () => []),
  waitForInstanceReady: vi.fn(async () => undefined),
  getInstanceHealth: vi.fn(async () => 'running'),
  saveSecret: vi.fn(async () => undefined),
  Context: class {}
}));

// Record every bucket the provision flow creates / policies, so the test can
// assert the custom bucket is the one actually provisioned on the stack's own
// endpoint rather than only the one reported.
const madeBuckets: string[] = [];
const policiedBuckets: string[] = [];
const existingBuckets = new Set<string>();

vi.mock('minio', () => ({
  Client: class {
    async bucketExists(bucket: string) {
      return existingBuckets.has(bucket);
    }
    async makeBucket(bucket: string) {
      madeBuckets.push(bucket);
      existingBuckets.add(bucket);
      return undefined;
    }
    async setBucketPolicy(bucket: string) {
      policiedBuckets.push(bucket);
      return undefined;
    }
    async makeRequestAsync() {
      return undefined;
    }
  }
}));

vi.mock('nano', () => ({
  default: () => ({ db: { async create() { return undefined; } } })
}));

process.env['MINIO_ROOT_PASSWORD'] = 'test-minio-password';
process.env['COUCHDB_ADMIN_PASSWORD'] = 'test-couchdb-password';

import { provisionRouter } from './provision.js';
import type { ParamStore, StackConfig } from '../services/param-store.js';
import { OperationStore, type Operation } from '../services/operation-store.js';
import {
  DEFAULT_PACKAGED_BUCKET,
  DEFAULT_SOURCE_BUCKET
} from '../services/custom-buckets.js';

const osc = { getServiceAccessToken: vi.fn(async () => 'test-sat') } as never;

const CUSTOM_SOURCE = 'acme-media-ingest';
const CUSTOM_PACKAGED = 'acme-streaming-output';

function instanceFor(serviceId: string) {
  const host =
    serviceId === 'minio-minio'
      ? 'https://minio.example.osaas.io'
      : serviceId === 'apache-couchdb'
        ? 'https://couch.example.osaas.io'
        : 'https://valkey.example.osaas.io';
  return { name: 'mystack', url: host };
}

// A parameter store that keeps the last written config, so the test can read
// back exactly what the provision flow persisted.
function makeStatefulParamStore(initial?: StackConfig) {
  let stored: StackConfig | undefined = initial;
  return {
    storeStackConfig: vi.fn(async (_ws: string, _n: string, cfg: StackConfig) => {
      stored = cfg;
    }),
    loadStackConfig: vi.fn(async () => stored),
    deleteStackConfig: vi.fn(async () => {
      stored = undefined;
    }),
    listStackNames: vi.fn(async () => (stored ? ['mystack'] : [])),
    current: () => stored
  } as unknown as ParamStore & {
    storeStackConfig: ReturnType<typeof vi.fn>;
    current: () => StackConfig | undefined;
  };
}

async function buildApp(paramStore?: ParamStore) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(provisionRouter, {
    prefix: '/api/v1/provision',
    osc,
    paramStore,
    operationStore: new OperationStore(),
    readyPollIntervalMs: 1
  });
  await app.ready();
  return app;
}

async function waitForOperation(
  app: Awaited<ReturnType<typeof buildApp>>,
  operationId: string
): Promise<Operation> {
  for (let i = 0; i < 2000; i++) {
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
  payload: Record<string, unknown>
): Promise<Operation> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/provision',
    payload
  });
  expect(res.statusCode).toBe(202);
  return waitForOperation(app, (res.json() as { operationId: string }).operationId);
}

const CREDS = {
  accessKeyId: 'AKIA-test',
  secretAccessKey: 'secret-test'
};

beforeEach(() => {
  madeBuckets.length = 0;
  policiedBuckets.length = 0;
  existingBuckets.clear();
  createInstance.mockReset();
  getInstance.mockReset();
  createInstance.mockImplementation(async (_c: unknown, serviceId: string) =>
    instanceFor(serviceId)
  );
  getInstance.mockImplementation(async (_c: unknown, serviceId: string) =>
    instanceFor(serviceId)
  );
  delete process.env['HONOUR_CUSTOM_BUCKETS'];
});

afterEach(() => {
  delete process.env['HONOUR_CUSTOM_BUCKETS'];
});

describe('POST /api/v1/provision with HONOUR_CUSTOM_BUCKETS=1 (issue #1301)', () => {
  it('creates the operator-named buckets and binds the stack to them', async () => {
    process.env['HONOUR_CUSTOM_BUCKETS'] = '1';
    const paramStore = makeStatefulParamStore();
    const app = await buildApp(paramStore);

    const op = await provisionAndWait(app, {
      name: 'mystack',
      sourceStorage: { bucket: CUSTOM_SOURCE, ...CREDS },
      packagedStorage: { bucket: CUSTOM_PACKAGED, ...CREDS }
    });
    expect(op.status).toBe('done');

    // Provisioned on the stack's OWN object-storage endpoint.
    expect(madeBuckets).toContain(CUSTOM_SOURCE);
    expect(madeBuckets).toContain(CUSTOM_PACKAGED);
    // And the anonymous-read policy follows the packaged bucket in use, not the
    // default name — otherwise players would 403 on the honoured bucket.
    expect(policiedBuckets).toContain(CUSTOM_PACKAGED);
    expect(policiedBuckets).not.toContain(DEFAULT_PACKAGED_BUCKET);

    const stored = paramStore.current();
    expect(stored?.status).toBe('ready');
    expect(stored?.sourceBucket).toBe(CUSTOM_SOURCE);
    expect(stored?.packagedBucket).toBe(CUSTOM_PACKAGED);
    await app.close();
  });

  it('keeps the pipeline bucket and the delivery-URL bucket identical', async () => {
    process.env['HONOUR_CUSTOM_BUCKETS'] = '1';
    const paramStore = makeStatefulParamStore();
    const app = await buildApp(paramStore);

    await provisionAndWait(app, {
      name: 'mystack',
      sourceStorage: { bucket: CUSTOM_SOURCE, ...CREDS },
      packagedStorage: { bucket: CUSTOM_PACKAGED, ...CREDS }
    });

    const stored = paramStore.current();
    // `StackConfig.{source,packaged}Bucket` is what jobs read and write;
    // `storage.{source,packaged}.bucket` is what delivery-URL emission uses
    // (pipeline/packaging.ts externalPublicBaseUrl, routes/assets.ts). #1299's
    // failure was these two disagreeing.
    expect(stored?.storage?.source.bucket).toBe(stored?.sourceBucket);
    expect(stored?.storage?.packaged.bucket).toBe(stored?.packagedBucket);
    await app.close();
  });

  it('honours one role while the omitted role keeps the stack default', async () => {
    process.env['HONOUR_CUSTOM_BUCKETS'] = '1';
    const paramStore = makeStatefulParamStore();
    const app = await buildApp(paramStore);

    await provisionAndWait(app, {
      name: 'mystack',
      packagedStorage: { bucket: CUSTOM_PACKAGED, ...CREDS }
    });

    const stored = paramStore.current();
    expect(stored?.sourceBucket).toBe(DEFAULT_SOURCE_BUCKET);
    expect(stored?.packagedBucket).toBe(CUSTOM_PACKAGED);
    expect(madeBuckets).toContain(DEFAULT_SOURCE_BUCKET);
    expect(madeBuckets).toContain(CUSTOM_PACKAGED);
    await app.close();
  });

  it('still rejects a custom endpointUrl — bucket-only, per ADR-021 C1/C2', async () => {
    process.env['HONOUR_CUSTOM_BUCKETS'] = '1';
    const app = await buildApp(makeStatefulParamStore());
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/provision',
      payload: {
        name: 'mystack',
        sourceStorage: {
          bucket: CUSTOM_SOURCE,
          ...CREDS,
          endpointUrl: 'https://s3.external.example.com'
        }
      }
    });
    expect(res.statusCode).toBe(400);
    expect(
      (res.json() as { unsupported: Array<{ field: string }> }).unsupported[0]
        ?.field
    ).toBe('sourceStorage.endpointUrl');
    await app.close();
  });
});

describe('re-provision with a CHANGED bucket (issue #1301 AC3)', () => {
  const readyWithCustomBuckets: StackConfig = {
    status: 'ready',
    createdAt: '2026-01-01T00:00:00.000Z',
    minioEndpoint: 'https://minio.example.osaas.io',
    couchdbUrl: 'https://couch.example.osaas.io',
    redisUrl: 'redis://valkey.svc.cluster.local:6379',
    sourceBucket: CUSTOM_SOURCE,
    packagedBucket: CUSTOM_PACKAGED,
    services: [{ serviceId: 'minio-minio', instanceName: 'mystack' }]
  };

  it('fails the operation and creates nothing when the bucket changes', async () => {
    process.env['HONOUR_CUSTOM_BUCKETS'] = '1';
    const paramStore = makeStatefulParamStore(readyWithCustomBuckets);
    const app = await buildApp(paramStore);

    const op = await provisionAndWait(app, {
      name: 'mystack',
      sourceStorage: { bucket: 'acme-media-ingest-v2', ...CREDS },
      packagedStorage: { bucket: CUSTOM_PACKAGED, ...CREDS }
    });

    expect(op.status).toBe('failed');
    expect(op.error).toContain('acme-media-ingest-v2');
    expect(op.error).toContain(CUSTOM_SOURCE);
    // Nothing provisioned and nothing rewritten: the stored binding survives.
    expect(madeBuckets).toEqual([]);
    expect(createInstance).not.toHaveBeenCalled();
    expect(paramStore.current()?.sourceBucket).toBe(CUSTOM_SOURCE);
    await app.close();
  });

  it('converges normally when the SAME buckets are re-supplied', async () => {
    process.env['HONOUR_CUSTOM_BUCKETS'] = '1';
    const paramStore = makeStatefulParamStore(readyWithCustomBuckets);
    const app = await buildApp(paramStore);

    const op = await provisionAndWait(app, {
      name: 'mystack',
      sourceStorage: { bucket: CUSTOM_SOURCE, ...CREDS },
      packagedStorage: { bucket: CUSTOM_PACKAGED, ...CREDS }
    });

    expect(op.status).toBe('done');
    expect(createInstance).not.toHaveBeenCalled();
    await app.close();
  });
});

describe('POST /api/v1/provision with the flag OFF (issue #1301)', () => {
  it('persists the stack defaults, leaving pre-#1301 behaviour unchanged', async () => {
    const paramStore = makeStatefulParamStore();
    const app = await buildApp(paramStore);

    const op = await provisionAndWait(app, {
      name: 'mystack',
      sourceStorage: { bucket: CUSTOM_SOURCE, ...CREDS },
      packagedStorage: { bucket: CUSTOM_PACKAGED, ...CREDS }
    });
    expect(op.status).toBe('done');

    const stored = paramStore.current();
    expect(stored?.sourceBucket).toBe(DEFAULT_SOURCE_BUCKET);
    expect(stored?.packagedBucket).toBe(DEFAULT_PACKAGED_BUCKET);
    // The custom bucket is NOT created: jobs never touch it.
    expect(madeBuckets).not.toContain(CUSTOM_SOURCE);
    expect(madeBuckets).not.toContain(CUSTOM_PACKAGED);
    expect(policiedBuckets).toContain(DEFAULT_PACKAGED_BUCKET);
    await app.close();
  });
});
