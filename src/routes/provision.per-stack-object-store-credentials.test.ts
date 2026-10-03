// Per-stack object-store credentials, end to end through the provision route
// (issue #1094, core fix from #1089).
//
// Acceptance criteria exercised here:
//   1. Two provisioned stacks have DIFFERENT credentials — different root user
//      on the created object-store instance and a different secret saved as
//      their OSC secret.
//   2. A credential from stack A does not authenticate against stack B: each
//      stack's object store is created with ITS OWN root user, so A's key is
//      not a key B has (the live 403). Asserted on what reaches the create
//      body, which is what the object store enforces.
//   3. No secret value appears in a log line, in the operation result, or in
//      the GET /:name response — nor in anything written to the parameter store.
//   4. Secret lifecycle: created on provision (saved under each consuming
//      serviceId, with only a {{secrets.*}} REFERENCE in the create body) and
//      torn down on deprovision (the stored access key id — the only persisted
//      part of the credential — is deleted, so the credential is no longer
//      resolvable by any read path).
//
// Contract sources (CLAUDE.md rule 7):
//   - saveSecret(serviceId, name, value, ctx): Promise<void> — @osaas/
//     client-core lib/core.d.ts:154 (impl lib/core.js:355-369, a write-only
//     POST /mysecrets/<serviceId>; the SDK exposes no read-back and no delete).
//   - createInstance(ctx, serviceId, token, body) / getInstance(ctx, serviceId,
//     name, token) / removeInstance(ctx, serviceId, name, token) —
//     lib/core.d.ts.
//   - The #212 precedent for persisting credentials as OSC secrets:
//     routes/provision.ts `secretRef`/`applyCredentialMapping` over
//     services/external-storage-credentials.ts encoreCredentialMapping /
//     ffmpegS3CredentialMapping (purposes `<role>.s3secretaccesskey` /
//     `<role>.awssecretaccesskey`, names `<stackName>.<purpose>`).
//   - The object store's create fields RootUser / RootPassword — the exact pair
//     the pre-#1094 provision path used (routes/provision.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';

const createInstance = vi.fn();
const getInstance = vi.fn();
const removeInstance = vi.fn();
const saveSecret = vi.fn();
const waitForInstanceReady = vi.fn(async () => undefined);
const getPortsForInstance = vi.fn(async () => []);

vi.mock('@osaas/client-core', () => ({
  createInstance: (...args: unknown[]) => createInstance(...(args as [])),
  getInstance: (...args: unknown[]) => getInstance(...(args as [])),
  removeInstance: (...args: unknown[]) => removeInstance(...(args as [])),
  getPortsForInstance: (...args: unknown[]) =>
    getPortsForInstance(...(args as [])),
  waitForInstanceReady: (...args: unknown[]) =>
    waitForInstanceReady(...(args as [])),
  saveSecret: (...args: unknown[]) => saveSecret(...(args as [])),
  Context: class {}
}));

// The provision flow talks S3 to the freshly created object store and HTTP to
// the document store. Record the credential each S3 client is constructed with
// so the test can assert the route's OWN client uses the per-stack credential
// (and never the deployment-wide one).
const s3ClientCredentials: { accessKey: string; secretKey: string }[] = [];

vi.mock('minio', () => ({
  Client: class {
    constructor(opts: { accessKey: string; secretKey: string }) {
      s3ClientCredentials.push({
        accessKey: opts.accessKey,
        secretKey: opts.secretKey
      });
    }
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

// The deployment-wide credential material (ADR-002). Since #1094 this value is
// the DERIVATION SEED; it is no longer itself a stack's credential.
const DEPLOYMENT_SEED = 'test-deployment-object-store-password';
process.env['MINIO_ROOT_PASSWORD'] = DEPLOYMENT_SEED;
process.env['COUCHDB_ADMIN_PASSWORD'] = 'test-couchdb-password';

import { provisionRouter } from './provision.js';
import type { ParamStore, StackConfig } from '../services/param-store.js';
import { STACK_CONFIG_NAMESPACE } from '../services/workspace-stack.js';
import { OBJECT_STORE_SERVICE_ID } from '../services/stack.js';
import {
  LEGACY_OBJECT_STORE_ACCESS_KEY_ID,
  deriveObjectStoreCredential,
  resolveObjectStoreCredential
} from '../services/object-store-credentials.js';
import { OperationStore, type Operation } from '../services/operation-store.js';

const getServiceAccessToken = vi.fn(async () => 'test-sat');
const osc = { getServiceAccessToken } as never;

function instanceFor(serviceId: string, name: string) {
  const host =
    serviceId === OBJECT_STORE_SERVICE_ID
      ? `https://${name}-objectstore.example.osaas.io`
      : serviceId === 'apache-couchdb'
        ? `https://${name}-documents.example.osaas.io`
        : `https://${name}-queue.example.osaas.io`;
  return { name, url: host };
}

// Captured log output for the "no secret in logs" assertion. Every line the
// route emits (app.log and request.log) goes through this stream.
let logOutput: string[];

// A multi-stack stateful parameter store.
function makeParamStore() {
  const stored = new Map<string, StackConfig>();
  const written: StackConfig[] = [];
  return {
    store: {
      storeStackConfig: vi.fn(async (ws: string, name: string, cfg: StackConfig) => {
        stored.set(`${ws}/${name}`, cfg);
        written.push(cfg);
      }),
      loadStackConfig: vi.fn(async (ws: string, name: string) =>
        stored.get(`${ws}/${name}`)
      ),
      deleteStackConfig: vi.fn(async (ws: string, name: string) => {
        stored.delete(`${ws}/${name}`);
      }),
      listStackNames: vi.fn(async () => [...stored.keys()].map((k) => k.split('/')[1]!))
    } as unknown as ParamStore & {
      deleteStackConfig: ReturnType<typeof vi.fn>;
    },
    // Every config blob ever written, for the "no secret at rest" assertion.
    written,
    current: (name: string) => stored.get(`${STACK_CONFIG_NAMESPACE}/${name}`)
  };
}

async function buildApp(paramStore: ParamStore) {
  const app = Fastify({
    logger: {
      level: 'trace',
      stream: {
        write: (line: string) => {
          logOutput.push(line);
        }
      }
    }
  });
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
  name: string
): Promise<Operation> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/provision',
    payload: { name }
  });
  expect(res.statusCode).toBe(202);
  return waitForOperation(app, res.json().operationId);
}

async function deprovisionAndWait(
  app: Awaited<ReturnType<typeof buildApp>>,
  name: string
): Promise<Operation> {
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/v1/provision/${name}`
  });
  expect(res.statusCode).toBe(202);
  return waitForOperation(app, res.json().operationId);
}

// The create body the route passed for one serviceId.
function createBodyFor(serviceId: string, name: string): Record<string, unknown> {
  const call = createInstance.mock.calls.find(
    ([, sid, , body]) =>
      sid === serviceId && (body as { name?: string }).name === name
  );
  if (!call) throw new Error(`no createInstance call for ${serviceId}/${name}`);
  return call[3] as Record<string, unknown>;
}

// The value saved for one (serviceId, secretName) pair.
function savedSecret(serviceId: string, secretName: string): string | undefined {
  const call = saveSecret.mock.calls.find(
    ([sid, sname]) => sid === serviceId && sname === secretName
  );
  return call?.[2] as string | undefined;
}

// getInstance answers both the #1094 pre-create existence probe for the object
// store AND the queue's cluster-DNS lookup (redisUrlFrom), so it must always
// return an instance for the non-object-store services. `objectStoreExists`
// controls only the probe's answer: false = a stack being provisioned for the
// first time (gets its own credential), true = an object store that is already
// live (keeps the legacy credential, since adoption cannot rewrite its root
// user).
function setObjectStoreExists(objectStoreExists: boolean) {
  getInstance.mockImplementation(async (_c, serviceId: string, name: string) =>
    serviceId === OBJECT_STORE_SERVICE_ID && !objectStoreExists
      ? undefined
      : instanceFor(serviceId, name)
  );
}

beforeEach(() => {
  createInstance.mockReset();
  getInstance.mockReset();
  removeInstance.mockReset();
  saveSecret.mockReset();
  getServiceAccessToken.mockClear();
  s3ClientCredentials.length = 0;
  logOutput = [];
  createInstance.mockImplementation(
    async (_c, serviceId: string, _t: string, body: { name: string }) =>
      instanceFor(serviceId, body.name)
  );
  setObjectStoreExists(false);
});

describe('POST /api/v1/provision issues a per-stack object-store credential (issue #1094)', () => {
  it('gives two provisioned stacks different credentials', async () => {
    const { store, current } = makeParamStore();
    const app = await buildApp(store);

    await provisionAndWait(app, 'stacka');
    await provisionAndWait(app, 'stackb');

    const expectedA = deriveObjectStoreCredential(DEPLOYMENT_SEED, 'stacka');
    const expectedB = deriveObjectStoreCredential(DEPLOYMENT_SEED, 'stackb');

    // 1. The created object stores have different root users — neither is the
    //    former process-global one.
    const rootUserA = createBodyFor(OBJECT_STORE_SERVICE_ID, 'stacka')['RootUser'];
    const rootUserB = createBodyFor(OBJECT_STORE_SERVICE_ID, 'stackb')['RootUser'];
    expect(rootUserA).toBe(expectedA.accessKeyId);
    expect(rootUserB).toBe(expectedB.accessKeyId);
    expect(rootUserA).not.toBe(rootUserB);
    expect(rootUserA).not.toBe(LEGACY_OBJECT_STORE_ACCESS_KEY_ID);
    expect(rootUserB).not.toBe(LEGACY_OBJECT_STORE_ACCESS_KEY_ID);

    // 2. And different secrets, neither of which is the deployment-wide value.
    const secretA = savedSecret(OBJECT_STORE_SERVICE_ID, 'stacka.rootpassword');
    const secretB = savedSecret(OBJECT_STORE_SERVICE_ID, 'stackb.rootpassword');
    expect(secretA).toBe(expectedA.secretAccessKey);
    expect(secretB).toBe(expectedB.secretAccessKey);
    expect(secretA).not.toBe(secretB);
    expect(secretA).not.toBe(DEPLOYMENT_SEED);
    expect(secretB).not.toBe(DEPLOYMENT_SEED);

    // 3. Each stack's stored config records its OWN access key id, so the read
    //    paths resolve stack A to A's credential and stack B to B's.
    expect(current('stacka')?.objectStoreAccessKeyId).toBe(expectedA.accessKeyId);
    expect(current('stackb')?.objectStoreAccessKeyId).toBe(expectedB.accessKeyId);

    const resolvedA = resolveObjectStoreCredential({
      storedAccessKeyId: current('stacka')?.objectStoreAccessKeyId,
      seed: DEPLOYMENT_SEED,
      legacySecretAccessKey: DEPLOYMENT_SEED
    });
    const resolvedB = resolveObjectStoreCredential({
      storedAccessKeyId: current('stackb')?.objectStoreAccessKeyId,
      seed: DEPLOYMENT_SEED,
      legacySecretAccessKey: DEPLOYMENT_SEED
    });
    expect(resolvedA).toEqual(expectedA);
    expect(resolvedB).toEqual(expectedB);
    // Stack A's resolved credential is NOT a credential stack B's object store
    // was created with — the pre-condition for the cross-stack 403.
    expect(resolvedA.accessKeyId).not.toBe(rootUserB);
    expect(resolvedA.secretAccessKey).not.toBe(resolvedB.secretAccessKey);
  });

  it("builds the route's own S3 client with the stack's credential, not the deployment-wide one", async () => {
    const { store } = makeParamStore();
    const app = await buildApp(store);

    await provisionAndWait(app, 'stacka');

    const expected = deriveObjectStoreCredential(DEPLOYMENT_SEED, 'stacka');
    expect(s3ClientCredentials).toContainEqual({
      accessKey: expected.accessKeyId,
      secretKey: expected.secretAccessKey
    });
    expect(
      s3ClientCredentials.some((c) => c.secretKey === DEPLOYMENT_SEED)
    ).toBe(false);
  });

  it('puts only a {{secrets.*}} reference in the create body — never the literal secret', async () => {
    const { store } = makeParamStore();
    const app = await buildApp(store);

    await provisionAndWait(app, 'stacka');

    const expected = deriveObjectStoreCredential(DEPLOYMENT_SEED, 'stacka');
    const body = createBodyFor(OBJECT_STORE_SERVICE_ID, 'stacka');
    expect(body['RootPassword']).toBe('{{secrets.stacka.rootpassword}}');
    expect(JSON.stringify(body)).not.toContain(expected.secretAccessKey);
  });

  it('persists the credential as OSC secrets for the source-reading services, per #212', async () => {
    const { store } = makeParamStore();
    const app = await buildApp(store);

    await provisionAndWait(app, 'stacka');

    const expected = deriveObjectStoreCredential(DEPLOYMENT_SEED, 'stacka');
    // Same mechanism as the #212 external-backend credentials: one secret per
    // consuming serviceId, named <stackName>.<purpose>, value handed straight
    // to saveSecret.
    expect(savedSecret('encore', 'stacka.objectstore.s3secretaccesskey')).toBe(
      expected.secretAccessKey
    );
    expect(
      savedSecret('eyevinn-ffmpeg-s3', 'stacka.objectstore.awssecretaccesskey')
    ).toBe(expected.secretAccessKey);
    // Every secret is scoped to a serviceId, never saved globally.
    for (const [serviceId] of saveSecret.mock.calls) {
      expect(typeof serviceId).toBe('string');
      expect(serviceId).not.toBe('');
    }
  });
});

describe('no object-store secret is logged, returned or stored (issue #1094)', () => {
  it('keeps the secret out of logs, the operation result, the GET response and the parameter store', async () => {
    const { store, written } = makeParamStore();
    const app = await buildApp(store);

    const op = await provisionAndWait(app, 'stacka');
    expect(op.status).toBe('done');

    const expected = deriveObjectStoreCredential(DEPLOYMENT_SEED, 'stacka');

    // Logs: nothing the route emitted carries the secret (or the seed).
    const logs = logOutput.join('\n');
    expect(logs).not.toContain(expected.secretAccessKey);
    expect(logs).not.toContain(DEPLOYMENT_SEED);

    // Operation result (the provision API response surface).
    expect(JSON.stringify(op)).not.toContain(expected.secretAccessKey);

    // GET /:name — the stored-coordinates read surface.
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/provision/stacka'
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(expected.secretAccessKey);
    // The non-secret access key id is not surfaced either: storedConfigSchema
    // declares the response shape and the zod serializer drops anything not in
    // it, so adding the field to StackConfig did not widen this API surface.
    expect(res.body).not.toContain(expected.accessKeyId);

    // At rest: every blob written to the parameter store (the 'provisioning'
    // marker and the final 'ready' config) carries the non-secret id only.
    expect(written.length).toBeGreaterThan(0);
    for (const cfg of written) {
      expect(JSON.stringify(cfg)).not.toContain(expected.secretAccessKey);
    }
    expect(
      written.some((c) => c.objectStoreAccessKeyId === expected.accessKeyId)
    ).toBe(true);
  });
});

describe('object-store credential lifecycle (issue #1094)', () => {
  it('creates the secret on provision and makes it unresolvable on teardown', async () => {
    const { store, current } = makeParamStore();
    const app = await buildApp(store);

    // CREATE on provision.
    await provisionAndWait(app, 'stacka');
    const expected = deriveObjectStoreCredential(DEPLOYMENT_SEED, 'stacka');
    expect(savedSecret(OBJECT_STORE_SERVICE_ID, 'stacka.rootpassword')).toBe(
      expected.secretAccessKey
    );
    expect(current('stacka')?.objectStoreAccessKeyId).toBe(expected.accessKeyId);

    // DELETE on teardown. The object store that honoured the credential is
    // removed, and the stored access key id — the only persisted part of the
    // credential — is deleted with the stack config.
    setObjectStoreExists(true);
    const teardown = await deprovisionAndWait(app, 'stacka');
    expect(teardown.status).toBe('done');

    expect(
      removeInstance.mock.calls.some(
        ([, serviceId, name]) =>
          serviceId === OBJECT_STORE_SERVICE_ID && name === 'stacka'
      )
    ).toBe(true);
    expect(store.deleteStackConfig).toHaveBeenCalledWith(
      STACK_CONFIG_NAMESPACE,
      'stacka'
    );
    expect(current('stacka')).toBeUndefined();

    // With the record gone, no read path can resolve the per-stack credential
    // any more — resolution degrades to the legacy pair, which the (now
    // removed) object store never accepted.
    const afterTeardown = resolveObjectStoreCredential({
      storedAccessKeyId: current('stacka')?.objectStoreAccessKeyId,
      seed: DEPLOYMENT_SEED,
      legacySecretAccessKey: DEPLOYMENT_SEED
    });
    expect(afterTeardown.accessKeyId).toBe(LEGACY_OBJECT_STORE_ACCESS_KEY_ID);
    expect(afterTeardown.secretAccessKey).not.toBe(expected.secretAccessKey);
  });

  it('a retried provision reuses the recorded credential instead of minting a second generation', async () => {
    const { store, current } = makeParamStore();
    const app = await buildApp(store);

    await provisionAndWait(app, 'stacka');
    const expected = deriveObjectStoreCredential(DEPLOYMENT_SEED, 'stacka');

    // The object store now exists (adopted on the retry) and the stored config
    // records the per-stack id: the retry must stay on that exact credential.
    setObjectStoreExists(true);
    await provisionAndWait(app, 'stacka');

    expect(current('stacka')?.objectStoreAccessKeyId).toBe(expected.accessKeyId);
    const rootUsers = createInstance.mock.calls
      .filter(([, sid]) => sid === OBJECT_STORE_SERVICE_ID)
      .map(([, , , body]) => (body as { RootUser?: string }).RootUser);
    for (const rootUser of rootUsers) {
      expect(rootUser).toBe(expected.accessKeyId);
    }
  });

  it('keeps the legacy credential for a stack whose object store already exists without one', async () => {
    // A stack provisioned BEFORE #1094: its object store is live with the
    // former process-global root user, and adopting it cannot change that. The
    // compatible fallback keeps it working until #1096 migrates it.
    const { store, current } = makeParamStore();
    const app = await buildApp(store);

    setObjectStoreExists(true);

    await provisionAndWait(app, 'legacystack');

    expect(createBodyFor(OBJECT_STORE_SERVICE_ID, 'legacystack')['RootUser']).toBe(
      LEGACY_OBJECT_STORE_ACCESS_KEY_ID
    );
    expect(
      savedSecret(OBJECT_STORE_SERVICE_ID, 'legacystack.rootpassword')
    ).toBe(DEPLOYMENT_SEED);
    expect(current('legacystack')?.objectStoreAccessKeyId).toBeUndefined();
  });
});
