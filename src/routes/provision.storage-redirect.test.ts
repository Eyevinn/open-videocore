// Fail-loud storage-redirection validation on the provision route (issue #640).
//
// The provision call historically accepted a `sourceStorage`/`packagedStorage`
// block requesting redirection to an external, non-default object-storage
// endpoint and returned success while the pipeline silently wrote to the default
// endpoint — the worst failure mode because it looks like success. These tests
// pin the new contract:
//   1. `validateStorageRedirection` (pure): flags `<role>.endpointUrl` as
//      unsupported for each role, and returns no findings for a bucket-only
//      redirection or an omitted block.
//   2. POST /api/v1/provision returns 400 (naming the offending field) for an
//      unsupported redirection — BEFORE any async operation is created — and
//      still returns 202 for a bucket-only (supported) redirection.

import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';

vi.mock('@osaas/client-core', () => ({
  createInstance: vi.fn(async () => ({ name: 'mystack', url: 'https://x.osaas.io' })),
  getInstance: vi.fn(async () => undefined),
  removeInstance: vi.fn(),
  getPortsForInstance: vi.fn(async () => []),
  waitForInstanceReady: vi.fn(async () => undefined),
  saveSecret: vi.fn(async () => undefined),
  Context: class {}
}));

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
  default: () => ({ db: { async create() { return undefined; } } })
}));

process.env['MINIO_ROOT_PASSWORD'] = 'test-minio-password';
process.env['COUCHDB_ADMIN_PASSWORD'] = 'test-couchdb-password';

import { provisionRouter, validateStorageRedirection } from './provision.js';
import { OperationStore } from '../services/operation-store.js';

const osc = { getServiceAccessToken: vi.fn(async () => 'test-sat') } as never;

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(provisionRouter, {
    prefix: '/api/v1/provision',
    osc,
    operationStore: new OperationStore()
  });
  await app.ready();
  return app;
}

const EXTERNAL_ENDPOINT_BLOCK = {
  bucket: 'my-external-bucket',
  accessKeyId: 'AKIA-test',
  secretAccessKey: 'secret-test',
  endpointUrl: 'https://s3.external.example.com'
};

const BUCKET_ONLY_BLOCK = {
  bucket: 'my-external-bucket',
  accessKeyId: 'AKIA-test',
  secretAccessKey: 'secret-test'
};

describe('validateStorageRedirection (issue #640)', () => {
  it('flags sourceStorage.endpointUrl as unsupported', () => {
    const errs = validateStorageRedirection({ sourceStorage: EXTERNAL_ENDPOINT_BLOCK });
    expect(errs).toHaveLength(1);
    expect(errs[0]?.field).toBe('sourceStorage.endpointUrl');
    expect(errs[0]?.message).toMatch(/endpoint/i);
  });

  it('flags packagedStorage.endpointUrl as unsupported', () => {
    const errs = validateStorageRedirection({ packagedStorage: EXTERNAL_ENDPOINT_BLOCK });
    expect(errs).toHaveLength(1);
    expect(errs[0]?.field).toBe('packagedStorage.endpointUrl');
  });

  it('flags both roles when both request an external endpoint', () => {
    const errs = validateStorageRedirection({
      sourceStorage: EXTERNAL_ENDPOINT_BLOCK,
      packagedStorage: EXTERNAL_ENDPOINT_BLOCK
    });
    expect(errs.map((e) => e.field).sort()).toEqual([
      'packagedStorage.endpointUrl',
      'sourceStorage.endpointUrl'
    ]);
  });

  it('accepts a bucket-only redirection (honoured per #638/#639)', () => {
    const errs = validateStorageRedirection({
      sourceStorage: BUCKET_ONLY_BLOCK,
      packagedStorage: BUCKET_ONLY_BLOCK
    });
    expect(errs).toEqual([]);
  });

  it('accepts an omitted block (zero-config default)', () => {
    expect(validateStorageRedirection({})).toEqual([]);
  });
});

describe('POST /api/v1/provision storage-redirection contract (issue #640)', () => {
  it('rejects an unsupported external endpoint with 400 naming the field', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/provision',
      payload: { name: 'mystack', sourceStorage: EXTERNAL_ENDPOINT_BLOCK }
    });
    expect(res.statusCode).toBe(400);
    const body = res.json() as {
      error: string;
      unsupported: Array<{ field: string; message: string }>;
    };
    expect(body.error).toContain('sourceStorage.endpointUrl');
    expect(body.unsupported).toHaveLength(1);
    expect(body.unsupported[0]?.field).toBe('sourceStorage.endpointUrl');
    await app.close();
  });

  it('accepts a bucket-only redirection with 202', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/provision',
      payload: { name: 'mystack', packagedStorage: BUCKET_ONLY_BLOCK }
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { status: string; operationId: string };
    expect(body.status).toBe('pending');
    expect(body.operationId).toBeTruthy();
    await app.close();
  });

  it('accepts a zero-config provision (no storage block) with 202', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/provision',
      payload: { name: 'mystack' }
    });
    expect(res.statusCode).toBe(202);
    await app.close();
  });
});
