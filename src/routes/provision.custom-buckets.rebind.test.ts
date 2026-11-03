// `POST /api/v1/provision` — one-bucket-for-both-roles rejection and
// re-provision/resume convergence (issue #1301, review findings 1 and 2).
//
// FINDING 1. The provision flow makes the PACKAGED bucket anonymously readable
// (`s3:GetObject` for principal `*`, issue #199) so players can fetch manifests
// and segments without a token, and `requiredBucketsFor` de-duplicates the
// bucket pair. A request naming the SAME bucket for both roles therefore used
// to end up with that public-read policy applied to the bucket holding the
// ingested source masters, on an endpoint whose provision route is not caller
// authenticated. It must be rejected before any bucket is created or policied.
//
// FINDING 2. The rebind guard must compare against what the CALLER supplied.
// A re-provision that omits the storage blocks (the zero-config call in the
// docs) or re-supplies the identical buckets is not a rebind: it keeps the
// stack's existing binding, so idempotent re-provision converges and a
// partially failed custom-bucket provision — whose 'provisioning' marker
// already records the bound buckets — can be resumed.
//
// Contract verified before writing these tests:
//   - `src/routes/provision.ts` request schema: `sourceStorage`/`packagedStorage`
//     are `externalStorageSchema.optional()` with a REQUIRED `bucket` plus
//     `accessKeyId`/`secretAccessKey` (provision.ts:149-176, :251-253); the 400
//     body is `redirectionErrorSchema` = `{ error, unsupported: [{ field,
//     message }] }` (provision.ts:287-295, :962).
//   - `src/services/param-store.ts`: `StackConfig.sourceBucket` /
//     `.packagedBucket` are required strings, `storage.{source,packaged}` is
//     `StorageBackendConfig = { backend: 'minio' | 'external'; bucket: string;
//     ... }` (param-store.ts:41-47, :120-121, :169-172).
//   - `src/services/custom-buckets.ts`: `bindStackBuckets(input, existing,
//     opts)`, `identicalBucketRejections(input, buckets)`,
//     `bucketRebindRejections(existing, desired)`.
//   - minio@8 `bucketExists(bucketName: string): Promise<boolean>` (:207),
//     `makeBucket(bucketName, region?, makeOpts?): Promise<void>` (:203),
//     `setBucketPolicy(bucketName: string, policy: string): Promise<void>`
//     (:321) — node_modules/minio/dist/esm/internal/client.d.mts.

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

const CREDS = {
  accessKeyId: 'AKIA-test',
  secretAccessKey: 'secret-test'
};

function instanceFor(serviceId: string) {
  const host =
    serviceId === 'minio-minio'
      ? 'https://minio.example.osaas.io'
      : serviceId === 'apache-couchdb'
        ? 'https://couch.example.osaas.io'
        : 'https://valkey.example.osaas.io';
  return { name: 'mystack', url: host };
}

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

describe('one bucket for BOTH roles is rejected (issue #1301, finding 1)', () => {
  const SHARED = 'acme-one-bucket';

  it('returns 400 naming both supplied fields and provisions nothing', async () => {
    process.env['HONOUR_CUSTOM_BUCKETS'] = '1';
    const paramStore = makeStatefulParamStore();
    const app = await buildApp(paramStore);

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/provision',
      payload: {
        name: 'mystack',
        sourceStorage: { bucket: SHARED, ...CREDS },
        packagedStorage: { bucket: SHARED, ...CREDS }
      }
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as {
      error: string;
      unsupported: Array<{ field: string; message: string }>;
    };
    expect(body.unsupported.map((u) => u.field)).toEqual([
      'sourceStorage.bucket',
      'packagedStorage.bucket'
    ]);
    expect(body.unsupported[0]?.message).toContain(SHARED);
    // Rejected BEFORE any binding or policy application: the public-read
    // packaged policy never reaches a bucket holding source masters.
    expect(madeBuckets).toEqual([]);
    expect(policiedBuckets).toEqual([]);
    expect(createInstance).not.toHaveBeenCalled();
    expect(paramStore.current()).toBeUndefined();
    await app.close();
  });

  it('rejects a source bucket that collides with the OMITTED packaged default', async () => {
    process.env['HONOUR_CUSTOM_BUCKETS'] = '1';
    const app = await buildApp(makeStatefulParamStore());

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/provision',
      payload: {
        name: 'mystack',
        sourceStorage: { bucket: DEFAULT_PACKAGED_BUCKET, ...CREDS }
      }
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as {
      unsupported: Array<{ field: string }>;
    };
    // Only the role the caller actually sent is named.
    expect(body.unsupported.map((u) => u.field)).toEqual(['sourceStorage.bucket']);
    expect(policiedBuckets).toEqual([]);
    await app.close();
  });

  it('accepts two different buckets — the guard is not over-eager', async () => {
    process.env['HONOUR_CUSTOM_BUCKETS'] = '1';
    const app = await buildApp(makeStatefulParamStore());

    const op = await provisionAndWait(app, {
      name: 'mystack',
      sourceStorage: { bucket: CUSTOM_SOURCE, ...CREDS },
      packagedStorage: { bucket: CUSTOM_PACKAGED, ...CREDS }
    });

    expect(op.status).toBe('done');
    expect(policiedBuckets).toContain(CUSTOM_PACKAGED);
    expect(policiedBuckets).not.toContain(CUSTOM_SOURCE);
    await app.close();
  });
});

describe('re-provision of a custom-bound stack (issue #1301, finding 2)', () => {
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

  it('converges on the ZERO-CONFIG call and keeps the binding (flag on)', async () => {
    process.env['HONOUR_CUSTOM_BUCKETS'] = '1';
    const paramStore = makeStatefulParamStore(readyWithCustomBuckets);
    const app = await buildApp(paramStore);

    const op = await provisionAndWait(app, { name: 'mystack' });

    expect(op.status).toBe('done');
    const stored = paramStore.current();
    expect(stored?.sourceBucket).toBe(CUSTOM_SOURCE);
    expect(stored?.packagedBucket).toBe(CUSTOM_PACKAGED);
    await app.close();
  });

  it('converges on the ZERO-CONFIG call with the flag OFF too', async () => {
    const paramStore = makeStatefulParamStore(readyWithCustomBuckets);
    const app = await buildApp(paramStore);

    const op = await provisionAndWait(app, { name: 'mystack' });

    expect(op.status).toBe('done');
    expect(paramStore.current()?.sourceBucket).toBe(CUSTOM_SOURCE);
    await app.close();
  });

  it('converges when the IDENTICAL buckets are re-supplied with the flag OFF', async () => {
    const paramStore = makeStatefulParamStore(readyWithCustomBuckets);
    const app = await buildApp(paramStore);

    const op = await provisionAndWait(app, {
      name: 'mystack',
      sourceStorage: { bucket: CUSTOM_SOURCE, ...CREDS },
      packagedStorage: { bucket: CUSTOM_PACKAGED, ...CREDS }
    });

    expect(op.status).toBe('done');
    expect(paramStore.current()?.sourceBucket).toBe(CUSTOM_SOURCE);
    expect(paramStore.current()?.packagedBucket).toBe(CUSTOM_PACKAGED);
    await app.close();
  });

  it('still rejects a CHANGED bucket on re-provision (AC3 intact)', async () => {
    process.env['HONOUR_CUSTOM_BUCKETS'] = '1';
    const paramStore = makeStatefulParamStore(readyWithCustomBuckets);
    const app = await buildApp(paramStore);

    const op = await provisionAndWait(app, {
      name: 'mystack',
      packagedStorage: { bucket: 'acme-streaming-output-v2', ...CREDS }
    });

    expect(op.status).toBe('failed');
    expect(op.error).toContain('acme-streaming-output-v2');
    expect(madeBuckets).toEqual([]);
    expect(paramStore.current()?.packagedBucket).toBe(CUSTOM_PACKAGED);
    await app.close();
  });
});

describe('resuming a partially failed custom-bucket provision (issue #1301)', () => {
  // The 'provisioning' marker the route writes mid-flight: endpoints still
  // empty, but the BOUND buckets already recorded (provision.ts marker write).
  const inFlightMarker: StackConfig = {
    status: 'provisioning',
    createdAt: '2026-01-01T00:00:00.000Z',
    minioEndpoint: '',
    couchdbUrl: '',
    redisUrl: '',
    sourceBucket: CUSTOM_SOURCE,
    packagedBucket: CUSTOM_PACKAGED,
    storage: {
      source: { backend: 'external', bucket: CUSTOM_SOURCE },
      packaged: { backend: 'external', bucket: CUSTOM_PACKAGED }
    },
    services: []
  };

  it('resumes on a zero-config retry and finishes on the SAME buckets', async () => {
    process.env['HONOUR_CUSTOM_BUCKETS'] = '1';
    const paramStore = makeStatefulParamStore(inFlightMarker);
    const app = await buildApp(paramStore);

    const op = await provisionAndWait(app, { name: 'mystack' });

    expect(op.status).toBe('done');
    // The retry provisioned the bound buckets, not the defaults.
    expect(madeBuckets).toContain(CUSTOM_SOURCE);
    expect(madeBuckets).toContain(CUSTOM_PACKAGED);
    expect(madeBuckets).not.toContain(DEFAULT_SOURCE_BUCKET);
    expect(madeBuckets).not.toContain(DEFAULT_PACKAGED_BUCKET);
    // The anonymous-read policy follows the bound packaged bucket only.
    expect(policiedBuckets).toContain(CUSTOM_PACKAGED);
    expect(policiedBuckets).not.toContain(CUSTOM_SOURCE);

    const stored = paramStore.current();
    expect(stored?.status).toBe('ready');
    expect(stored?.sourceBucket).toBe(CUSTOM_SOURCE);
    expect(stored?.packagedBucket).toBe(CUSTOM_PACKAGED);
    // The non-secret delivery coordinates name the bucket jobs use, so a
    // resumed provision cannot emit URLs for a bucket nothing writes to.
    expect(stored?.storage?.source.bucket).toBe(CUSTOM_SOURCE);
    expect(stored?.storage?.packaged.bucket).toBe(CUSTOM_PACKAGED);
    await app.close();
  });
});
