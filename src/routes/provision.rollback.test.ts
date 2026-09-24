// Rollback-on-failure for POST /api/v1/provision (issue #736).
//
// A mid-stack provisioning failure previously left every companion instance it
// had already created running and billing, with cleanup left to a separate
// deprovision call the tenant was never told to make. The failure path in
// provision.ts (src/routes/provision.ts:1219-1333) now rolls back ONLY the
// instances THIS operation created, sparing any pre-existing instance it merely
// ADOPTED (provision() hitting "already taken" — src/routes/provision.ts:814-835),
// and reports the outcome on the operation so the caller knows what happened.
//
// These tests cover all three acceptance criteria:
//   1. A failure AFTER creating storage + database tears BOTH down
//      (deprovisionStackFromConfig over created[], src/routes/provision.ts:1239-1248)
//      and the op result reports the teardown (src/routes/provision.ts:1316-1321).
//   2. An ADOPTED pre-existing instance (provision() adopting on "already taken",
//      so `!adopted` is false at src/routes/provision.ts:835 and it never lands in
//      created[]) is EXCLUDED from teardown and never deleted — the highest-risk
//      guard, since its failure mode is deleting a tenant's existing instance.
//   3. A teardown that itself fails reports the leftovers + the exact
//      DELETE /api/v1/provision/{name} remediation call
//      (src/routes/provision.ts:1266-1268, 1322-1331).

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
  // deriveWorkspaceId() calls listSubscriptions and falls back to the default
  // namespace when it throws (src/services/workspace-stack.ts:403-415), so the
  // partial-config write below lands under the 'default' workspace here.
  Context: class {}
}));

// The provision flow talks S3 to the freshly created storage instance and HTTP
// to the document store. Mock both clients so the flow completes without a live
// backend — these tests only exercise the failure/rollback path.
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

// The stack name is the deterministic instance name for every companion
// (src/routes/provision.ts:810 createInstance(..., { name, ... })).
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

// A parameter store whose loadStackConfig returns whatever the last
// storeStackConfig wrote, so tests can observe the persisted partial state.
function makeStatefulParamStore(initial?: StackConfig) {
  let stored: StackConfig | undefined = initial;
  return {
    storeStackConfig: vi.fn(
      async (_ws: string, _name: string, cfg: StackConfig) => {
        stored = cfg;
      }
    ),
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

// serviceIds passed to removeInstance — the SDK signature is
// removeInstance(osc, serviceId, name, sat) (src/services/deprovision.ts:69),
// so the serviceId is the second positional argument.
function removedServiceIds(): string[] {
  return removeInstance.mock.calls.map((c) => c[1] as string);
}

beforeEach(() => {
  createInstance.mockReset();
  getInstance.mockReset();
  removeInstance.mockReset();
  saveSecret.mockReset();
  getServiceAccessToken.mockClear();
  // Default: every service provisions and the teardown probe finds a live
  // instance. Individual tests override to inject failures.
  createInstance.mockImplementation(async (_c, serviceId: string) =>
    instanceFor(serviceId)
  );
  getInstance.mockImplementation(async (_c, serviceId: string) =>
    instanceFor(serviceId)
  );
  removeInstance.mockResolvedValue(undefined);
});

describe('POST /api/v1/provision rollback on failure (issue #736)', () => {
  // AC1: a failure after storage + database are created tears BOTH down and the
  // operation result reports the teardown outcome.
  it('rolls back BOTH created companions when the stack fails mid-provision', async () => {
    const paramStore = makeStatefulParamStore();
    // Storage + database succeed; the queue create fails (non-transient, so no
    // retry/backoff — see src/routes/provision.ts:820-826).
    createInstance.mockImplementation(async (_c, serviceId: string) => {
      if (serviceId === 'valkey-io-valkey') {
        throw new Error('valkey provisioning boom');
      }
      return instanceFor(serviceId);
    });

    const app = await buildApp(paramStore);
    const op = await provisionAndWait(app);

    expect(op.status).toBe('failed');

    // Both created companions were torn down; the queue was never created so it
    // is not among the removals.
    const removed = removedServiceIds();
    expect(removed).toContain('minio-minio');
    expect(removed).toContain('apache-couchdb');
    expect(removed).not.toContain('valkey-io-valkey');

    // The operation result reports the rollback: a full teardown of both.
    const result = op.result as {
      failedService: string;
      rollback: {
        status: string;
        services: { serviceId: string; status: string }[];
      };
    };
    expect(result.failedService).toBe('valkey-io-valkey');
    expect(result.rollback.status).toBe('removed');
    expect(
      result.rollback.services.find((s) => s.serviceId === 'minio-minio')?.status
    ).toBe('removed');
    expect(
      result.rollback.services.find((s) => s.serviceId === 'apache-couchdb')
        ?.status
    ).toBe('removed');
  });

  // AC2: the highest-risk guard. An ADOPTED pre-existing instance is excluded
  // from created[] (src/routes/provision.ts:835) and MUST NOT be torn down —
  // its failure mode is deleting a tenant's existing instance.
  it('NEVER tears down an adopted pre-existing instance (tenant-data guard)', async () => {
    const paramStore = makeStatefulParamStore();
    // Storage already exists → provision() adopts it on "already taken"
    // (src/routes/provision.ts:814-816); database is freshly created; the queue
    // then fails, triggering rollback.
    createInstance.mockImplementation(async (_c, serviceId: string) => {
      if (serviceId === 'minio-minio') {
        throw new Error('Name is already taken');
      }
      if (serviceId === 'valkey-io-valkey') {
        throw new Error('valkey provisioning boom');
      }
      return instanceFor(serviceId);
    });

    const app = await buildApp(paramStore);
    const op = await provisionAndWait(app);

    expect(op.status).toBe('failed');

    // The adopted storage instance is NEVER deleted. The freshly-created
    // database companion IS rolled back.
    const removed = removedServiceIds();
    expect(removed).not.toContain('minio-minio');
    expect(removed).toContain('apache-couchdb');

    // The rollback only ran over created[] — the adopted instance was never
    // even passed to teardown, so it appears in no rollback service entry.
    const result = op.result as {
      rollback: { services: { serviceId: string }[] };
    };
    expect(
      result.rollback.services.some((s) => s.serviceId === 'minio-minio')
    ).toBe(false);

    // The persisted partial config still lists the adopted instance as STILL
    // RUNNING (src/routes/provision.ts:1274-1279) so the tenant/operator knows
    // it survives, while the torn-down database companion is omitted.
    const partial = (await paramStore.loadStackConfig(
      'default',
      'mystack'
    )) as StackConfig;
    expect(partial.status).toBe('failed');
    const storedIds = partial.services.map((s) => s.serviceId);
    expect(storedIds).toContain('minio-minio');
    expect(storedIds).not.toContain('apache-couchdb');
  });

  // AC3: when the teardown itself fails, the operation reports exactly which
  // instances are still running (leftovers) plus the exact remediation call.
  it('reports leftovers + the exact DELETE remediation when teardown itself fails', async () => {
    const paramStore = makeStatefulParamStore();
    createInstance.mockImplementation(async (_c, serviceId: string) => {
      if (serviceId === 'valkey-io-valkey') {
        throw new Error('valkey provisioning boom');
      }
      return instanceFor(serviceId);
    });
    // The storage teardown itself fails; the database teardown succeeds.
    removeInstance.mockImplementation(async (_c, serviceId: string) => {
      if (serviceId === 'minio-minio') {
        throw new Error('storage teardown boom');
      }
      return undefined;
    });

    const app = await buildApp(paramStore);
    const op = await provisionAndWait(app);

    expect(op.status).toBe('failed');

    const result = op.result as {
      rollback: { status: string };
      leftovers?: { serviceId: string; instanceName: string; error?: string }[];
      removeLeftoversWith?: string;
    };
    // A teardown failure surfaces as a failed rollback status.
    expect(result.rollback.status).toBe('failed');

    // The still-running instance is reported with the stack name and the error.
    expect(result.leftovers).toBeDefined();
    const leftover = result.leftovers?.find(
      (l) => l.serviceId === 'minio-minio'
    );
    expect(leftover).toBeDefined();
    expect(leftover?.instanceName).toBe('mystack');
    expect(leftover?.error).toContain('storage teardown boom');

    // The exact remediation call the caller must make to finish cleanup.
    expect(result.removeLeftoversWith).toBe('DELETE /api/v1/provision/mystack');
  });
});
