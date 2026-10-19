// Provisioning the anonymous-read profiles bucket (issue #1208, ADR-026 D3).
//
// Stack provisioning must create the DEDICATED `openvideocore-profiles` bucket
// on the stack's own object store and apply the `GetObject`-only anonymous
// policy to it, so each Encore instance the scaler spawns can fetch
// `<minio>/openvideocore-profiles/index.yml` with the plain, tokenless GET that
// `profilesUrl` is (ADR-026 C1) — instead of depending on an auth-gate
// exemption no OSC contract can set, read or assert (ADR-026 C3).
//
// What these tests pin:
//   1. the bucket is created and the policy applied, and the policy document is
//      byte-identical to the publisher's `profilesBucketAnonymousReadPolicy()`
//      (one definition, not a hand-copied second one);
//   2. the policy is GetObject-only — no ListBucket, no write — so the bucket is
//      readable by exact key and not enumerable;
//   3. the SOURCE bucket stays private and the PACKAGED bucket's existing #199
//      policy is unchanged (changing either is out of scope, ADR-026 §6);
//   4. a re-provision is idempotent: an existing profiles bucket is not
//      re-created, and the policy is re-applied (it overwrites, so it converges);
//   5. the step is BEST-EFFORT: neither a bucket-creation failure nor a
//      policy failure fails the provision of an otherwise-healthy stack, because
//      the resolver keeps the app-route fallback tier (ADR-026 D2) and
//      `publishProfileIndex` reads a missing bucket as `bucket-missing`;
//   6. teardown needs no bucket-specific step: the bucket lives inside the
//      stack's `minio-minio` instance, which the teardown path removes.
//
// Contracts verified before writing the object-store calls under test
// (CLAUDE.md rule 7) — `minio` 8.0.7 type declarations,
// node_modules/minio/dist/esm/internal/client.d.mts:
//   `bucketExists(bucketName: string): Promise<boolean>`                 (:207)
//   `makeBucket(bucketName: string, region?: Region, makeOpts?: MakeBucketOpt): Promise<void>` (:203)
//   `setBucketPolicy(bucketName: string, policy: string): Promise<void>` (:321)
// and `@osaas/client-core` 0.24.0 `removeInstance(ctx, serviceId, name, token)`
// (lib/core.d.ts) for the teardown assertion.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';

const createInstance = vi.fn();
const getInstance = vi.fn();
const removeInstance = vi.fn(async () => undefined);
const saveSecret = vi.fn();
const getInstanceHealth = vi.fn(async (..._args: unknown[]) => 'running');
const getPortsForInstance = vi.fn(async () => []);

vi.mock('@osaas/client-core', () => ({
  createInstance: (...args: unknown[]) => createInstance(...(args as [])),
  getInstance: (...args: unknown[]) => getInstance(...(args as [])),
  removeInstance: (...args: unknown[]) => removeInstance(...(args as [])),
  getPortsForInstance: (...args: unknown[]) =>
    getPortsForInstance(...(args as [])),
  waitForInstanceReady: vi.fn(async () => undefined),
  getInstanceHealth: (...args: unknown[]) => getInstanceHealth(...(args as [])),
  saveSecret: (...args: unknown[]) => saveSecret(...(args as [])),
  Context: class {}
}));

// Recording object-store stub. Each test can make a specific call fail for a
// specific bucket, so a profiles-bucket failure is observed in isolation from
// the required source/packaged buckets.
type Recorded = {
  bucketExists: string[];
  makeBucket: string[];
  setBucketPolicy: { bucket: string; policy: string }[];
  cors: string[];
};
const recorded: Recorded = {
  bucketExists: [],
  makeBucket: [],
  setBucketPolicy: [],
  cors: []
};
// Buckets reported as already existing (drives the idempotency test).
const existingBuckets = new Set<string>();
// Per-bucket failure injection.
const failBucketExistsFor = new Set<string>();
const failSetPolicyFor = new Set<string>();

vi.mock('minio', () => ({
  Client: class {
    async bucketExists(bucket: string) {
      recorded.bucketExists.push(bucket);
      if (failBucketExistsFor.has(bucket)) {
        throw new Error(`S3 unavailable for ${bucket}`);
      }
      return existingBuckets.has(bucket);
    }
    async makeBucket(bucket: string) {
      recorded.makeBucket.push(bucket);
      existingBuckets.add(bucket);
      return undefined;
    }
    async setBucketPolicy(bucket: string, policy: string) {
      recorded.setBucketPolicy.push({ bucket, policy });
      if (failSetPolicyFor.has(bucket)) {
        throw new Error(`policy rejected for ${bucket}`);
      }
      return undefined;
    }
    async makeRequestAsync(opts: { bucketName: string }) {
      recorded.cors.push(opts.bucketName);
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

process.env['MINIO_ROOT_PASSWORD'] = 'test-minio-password-long-enough-seed';
process.env['COUCHDB_ADMIN_PASSWORD'] = 'test-couchdb-password';

import { provisionRouter } from './provision.js';
import {
  PROFILES_BUCKET,
  profilesBucketAnonymousReadPolicy
} from '../services/profile-index-publisher.js';
import type { ParamStore, StackConfig } from '../services/param-store.js';
import { OperationStore, type Operation } from '../services/operation-store.js';

const SOURCE_BUCKET = 'openvideocore-source';
const PACKAGED_BUCKET = 'openvideocore-packaged';

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
  } as unknown as ParamStore;
}

async function buildApp(paramStore?: ParamStore) {
  const app = Fastify({ logger: false });
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
  for (let i = 0; i < 20000; i++) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/provision/operations/${operationId}`
    });
    const op = res.json() as Operation;
    if (op.status === 'done' || op.status === 'failed') return op;
    await new Promise((r) => setTimeout(r, 2));
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

beforeEach(() => {
  recorded.bucketExists = [];
  recorded.makeBucket = [];
  recorded.setBucketPolicy = [];
  recorded.cors = [];
  existingBuckets.clear();
  failBucketExistsFor.clear();
  failSetPolicyFor.clear();
  createInstance.mockReset();
  getInstance.mockReset();
  saveSecret.mockReset();
  removeInstance.mockClear();
  createInstance.mockImplementation(async (_c, serviceId: string) =>
    instanceFor(serviceId)
  );
  getInstance.mockImplementation(async (_c, serviceId: string) =>
    instanceFor(serviceId)
  );
});

describe('provisioning the anonymous-read profiles bucket (issue #1208, ADR-026 D3)', () => {
  it('creates openvideocore-profiles and applies the publisher-owned anonymous-read policy', async () => {
    const app = await buildApp(makeStatefulParamStore());

    const op = await provisionAndWait(app);
    expect(op.status).toBe('done');

    // Created alongside the two required buckets.
    expect(recorded.makeBucket).toContain(PROFILES_BUCKET);

    const profilesPolicies = recorded.setBucketPolicy.filter(
      (c) => c.bucket === PROFILES_BUCKET
    );
    expect(profilesPolicies).toHaveLength(1);
    // Byte-identical to the publisher's document: ONE definition of this
    // bucket's policy, so provisioning and the publisher's re-assertion cannot
    // drift (ADR-026 D3).
    expect(profilesPolicies[0]!.policy).toBe(profilesBucketAnonymousReadPolicy());

    const parsed = JSON.parse(profilesPolicies[0]!.policy) as {
      Statement: {
        Effect: string;
        Principal: { AWS: string[] };
        Action: string[];
        Resource: string[];
      }[];
    };
    expect(parsed.Statement).toHaveLength(1);
    const stmt = parsed.Statement[0]!;
    expect(stmt.Effect).toBe('Allow');
    expect(stmt.Principal.AWS).toEqual(['*']);
    // GetObject ONLY: no ListBucket (not enumerable) and no write.
    expect(stmt.Action).toEqual(['s3:GetObject']);
    expect(stmt.Resource).toEqual([`arn:aws:s3:::${PROFILES_BUCKET}/*`]);
    expect(JSON.stringify(parsed)).not.toContain('ListBucket');
    expect(JSON.stringify(parsed)).not.toContain('PutObject');
  });

  it('leaves the source bucket private and the packaged bucket policy unchanged', async () => {
    const app = await buildApp(makeStatefulParamStore());

    const op = await provisionAndWait(app);
    expect(op.status).toBe('done');

    // The source bucket never receives a policy (ADR-026 §6: #199's source and
    // packaged policies are out of scope, and source MUST stay private).
    expect(
      recorded.setBucketPolicy.some((c) => c.bucket === SOURCE_BUCKET)
    ).toBe(false);

    // The packaged bucket keeps exactly its pre-existing #199 policy.
    const packaged = recorded.setBucketPolicy.filter(
      (c) => c.bucket === PACKAGED_BUCKET
    );
    expect(packaged).toHaveLength(1);
    expect(JSON.parse(packaged[0]!.policy)).toEqual({
      Version: '2012-10-17',
      Statement: [
        {
          Effect: 'Allow',
          Principal: { AWS: ['*'] },
          Action: ['s3:GetObject'],
          Resource: [`arn:aws:s3:::${PACKAGED_BUCKET}/*`]
        }
      ]
    });
  });

  it('does not set CORS on the profiles bucket (its only reader is Encore, server-side)', async () => {
    const app = await buildApp(makeStatefulParamStore());

    const op = await provisionAndWait(app);
    expect(op.status).toBe('done');

    expect(recorded.cors).toContain(SOURCE_BUCKET);
    expect(recorded.cors).toContain(PACKAGED_BUCKET);
    expect(recorded.cors).not.toContain(PROFILES_BUCKET);
  });

  it('is idempotent: an existing profiles bucket is not re-created, and the policy is re-applied', async () => {
    // A stack whose buckets already exist — e.g. a re-provision after a
    // partial failure, or a provision against a pre-existing object store.
    existingBuckets.add(SOURCE_BUCKET);
    existingBuckets.add(PACKAGED_BUCKET);
    existingBuckets.add(PROFILES_BUCKET);
    const app = await buildApp(makeStatefulParamStore());

    const op = await provisionAndWait(app);
    expect(op.status).toBe('done');

    expect(recorded.bucketExists).toContain(PROFILES_BUCKET);
    expect(recorded.makeBucket).not.toContain(PROFILES_BUCKET);
    // setBucketPolicy overwrites, so re-applying converges rather than
    // accumulating statements — and it repairs a bucket that lost its policy.
    expect(
      recorded.setBucketPolicy.filter((c) => c.bucket === PROFILES_BUCKET)
    ).toHaveLength(1);
  });

  it(
    'a profiles-bucket creation failure does not fail the provision (fallback tier stays)',
    async () => {
      failBucketExistsFor.add(PROFILES_BUCKET);
      const app = await buildApp(makeStatefulParamStore());

      const op = await provisionAndWait(app);
      // The stack is still provisioned: the resolver keeps the app-route
      // fallback (ADR-026 D2) and the publisher reads the absent bucket as
      // `bucket-missing`, i.e. pre-ADR-026 behaviour.
      expect(op.status).toBe('done');

      // The required buckets were still created...
      expect(recorded.makeBucket).toContain(SOURCE_BUCKET);
      expect(recorded.makeBucket).toContain(PACKAGED_BUCKET);
      // ...and no policy was attempted on a bucket that does not exist.
      expect(
        recorded.setBucketPolicy.some((c) => c.bucket === PROFILES_BUCKET)
      ).toBe(false);
      // The packaged bucket's policy is unaffected by the profiles failure.
      expect(
        recorded.setBucketPolicy.some((c) => c.bucket === PACKAGED_BUCKET)
      ).toBe(true);
    },
    40000
  );

  it(
    'a profiles-bucket policy failure does not fail the provision',
    async () => {
      failSetPolicyFor.add(PROFILES_BUCKET);
      const app = await buildApp(makeStatefulParamStore());

      const op = await provisionAndWait(app);
      expect(op.status).toBe('done');

      // Retried, then given up on — best-effort, like the packaged policy.
      expect(
        recorded.setBucketPolicy.filter((c) => c.bucket === PROFILES_BUCKET)
          .length
      ).toBeGreaterThan(1);
    },
    40000
  );

  it('teardown needs no profiles-bucket step: the bucket goes with the object-store instance', async () => {
    const paramStore = makeStatefulParamStore();
    const app = await buildApp(paramStore);
    expect((await provisionAndWait(app)).status).toBe('done');

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/provision/mystack'
    });
    expect(res.statusCode).toBe(202);
    const { operationId } = res.json();
    const op = await waitForOperation(app, operationId);
    expect(op.status).toBe('done');

    // The stack's own minio-minio instance — which the profiles bucket lives
    // inside — is removed, so the bucket and its published objects are
    // destroyed with the stack. No bucket-level teardown call is made (or
    // needed) for it.
    expect(
      removeInstance.mock.calls.some(
        (call) => (call as unknown[])[1] === 'minio-minio'
      )
    ).toBe(true);
  });
});
