// Bounded readiness waits in POST /api/v1/provision (issue #1038).
//
// Every readiness wait in the provisioning flow used to call
// @osaas/client-core's waitForInstanceReady, which is
//
//   while (!instanceOk) {
//     await delay(1000);
//     const status = await getInstanceHealth(ctx, serviceId, name, sat);
//     if (status && status === 'running') { instanceOk = true; }
//   }
//
// (node_modules/@osaas/client-core/lib/core.js:343-353, v0.24.0) — no deadline,
// and no try around the probe. So:
//   1. ONE dropped poll out of several hundred (`fetch failed`) rejected the
//      wait and aborted the whole stack, even though the instance came up
//      moments later. Test 1 pins the new tolerance.
//   2. An instance that never reported `running` hung the provision forever.
//      Test 2 pins the deadline, the error text (service + last probe error)
//      and that it lands in the EXISTING rollback path (#736) rather than
//      surfacing a bare `fetch failed`.
//
// Contract sources verified before writing (CLAUDE.md rule 7),
// @osaas/client-core@0.24.0:
//   - lib/core.d.ts:86  getInstanceHealth(context: Context, serviceId: string,
//                         name: string, token: string): Promise<string>
//     => serviceId is argument 2 and the instance name argument 3, which is
//     what the per-service assertions below index into.
//   - lib/core.js:347-349  'running' is the exact ready state the SDK's own
//     helper gates on, so the bounded helper is behaviour-compatible.
//   - lib/core.d.ts:153 waitForInstanceReady(serviceId, name, ctx): Promise<void>
//     — the helper being replaced; provision.ts no longer imports it.
//   - lib/core.d.ts:32/46/51 createInstance / removeInstance / getInstance
//     signatures, as already relied on by src/services/deprovision.ts:69.
// Implementation under test: src/services/instance-readiness.ts
// (waitForInstanceReadyBounded) wired through provision.ts's awaitReady().

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
const getPortsForInstance = vi.fn(async () => []);
// The health probe the bounded wait owns. Default: ready on the first poll.
const getInstanceHealth = vi.fn(async (..._args: unknown[]) => 'running');

vi.mock('@osaas/client-core', () => ({
  createInstance: (...args: unknown[]) => createInstance(...(args as [])),
  getInstance: (...args: unknown[]) => getInstance(...(args as [])),
  removeInstance: (...args: unknown[]) => removeInstance(...(args as [])),
  getPortsForInstance: (...args: unknown[]) =>
    getPortsForInstance(...(args as [])),
  getInstanceHealth: (...args: unknown[]) => getInstanceHealth(...(args as [])),
  // Nothing under src/ imports the SDK's waitForInstanceReady any more (#1038
  // for provision.ts, #1055 for the packager and the config-queue bootstrap).
  // Kept on the mock so a future reintroduction fails loudly on assertions
  // rather than on a missing export.
  waitForInstanceReady: vi.fn(async () => undefined),
  saveSecret: (...args: unknown[]) => saveSecret(...(args as [])),
  Context: class {}
}));

// The flow talks S3 to the freshly created storage instance and HTTP to the
// document store. Both are stubbed so these tests exercise only the readiness
// wait and the failure/rollback path.
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

function instanceFor(serviceId: string) {
  const host =
    serviceId === 'minio-minio'
      ? 'https://storage.example.osaas.io'
      : serviceId === 'apache-couchdb'
        ? 'https://documents.example.osaas.io'
        : 'https://queue.example.osaas.io';
  return { name: 'mystack', url: host };
}

// A few milliseconds of budget so a genuinely-never-ready instance ends the
// wait inside the test rather than after the 5-minute production default
// (DEFAULT_INSTANCE_READY_TIMEOUT_MS).
const READY_TIMEOUT_MS = 40;
const READY_POLL_INTERVAL_MS = 2;

async function buildApp(paramStore?: ParamStore) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const operationStore = new OperationStore();
  await app.register(provisionRouter, {
    prefix: '/api/v1/provision',
    osc,
    paramStore,
    operationStore,
    readyTimeoutMs: READY_TIMEOUT_MS,
    readyPollIntervalMs: READY_POLL_INTERVAL_MS
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
    await new Promise((r) => setTimeout(r, 1));
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

function makeStatefulParamStore() {
  let stored: StackConfig | undefined;
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
  } as unknown as ParamStore;
}

// removeInstance(osc, serviceId, name, sat) — serviceId is argument 2
// (src/services/deprovision.ts:69).
function removedServiceIds(): string[] {
  return removeInstance.mock.calls.map((c) => c[1] as string);
}

// getInstanceHealth(context, serviceId, name, token) — lib/core.d.ts:86.
function probedServiceIds(): string[] {
  return getInstanceHealth.mock.calls.map((c) => c[1] as string);
}

beforeEach(() => {
  createInstance.mockReset();
  getInstance.mockReset();
  removeInstance.mockReset();
  saveSecret.mockReset();
  getInstanceHealth.mockReset();
  getServiceAccessToken.mockClear();
  createInstance.mockImplementation(async (_c, serviceId: string) =>
    instanceFor(serviceId)
  );
  getInstance.mockImplementation(async (_c, serviceId: string) =>
    instanceFor(serviceId)
  );
  removeInstance.mockResolvedValue(undefined);
  getInstanceHealth.mockResolvedValue('running');
});

describe('POST /api/v1/provision bounded readiness waits (issue #1038)', () => {
  // AC2: one dropped poll no longer aborts the stack. Under the SDK's
  // waitForInstanceReady this single rejection propagated straight out of the
  // wait (its getInstanceHealth call is not wrapped in a try,
  // lib/core.js:343-353) and failed the whole provision.
  it('survives a transient "fetch failed" health probe and provisions the stack', async () => {
    const paramStore = makeStatefulParamStore();
    // The storage instance's FIRST probe drops; the next one reports running.
    let storageProbes = 0;
    getInstanceHealth.mockImplementation(
      async (...args: unknown[]) => {
        // getInstanceHealth(context, serviceId, name, token) — lib/core.d.ts:86.
        if ((args[1] as string) === 'minio-minio') {
          storageProbes++;
          if (storageProbes === 1) {
            throw new Error('fetch failed');
          }
        }
        return 'running';
      }
    );

    const app = await buildApp(paramStore);
    const op = await provisionAndWait(app);

    // The provision of that service — and so the whole stack — succeeds.
    expect(op.error).toBeUndefined();
    expect(op.status).toBe('done');

    // It really did re-probe after the dropped poll rather than skipping the
    // wait, and nothing was rolled back.
    expect(storageProbes).toBeGreaterThanOrEqual(2);
    expect(probedServiceIds()).toContain('minio-minio');
    expect(removedServiceIds()).toEqual([]);

    // The stack persisted as ready.
    const stored = (await paramStore.loadStackConfig(
      'default',
      'mystack'
    )) as StackConfig;
    expect(stored.status).toBe('ready');
  });

  // AC3: an instance that never reports running ends the wait at the configured
  // deadline with an error naming the service and the last probe error, and the
  // existing rollback (#736) tears down what this run created.
  it('ends at the configured deadline, names the service + last probe error, and rolls back', async () => {
    const paramStore = makeStatefulParamStore();
    // The queue instance's health probe never succeeds. Storage and the
    // document store come up normally, so both are live when the wait expires.
    getInstanceHealth.mockImplementation(
      async (...args: unknown[]) => {
        // getInstanceHealth(context, serviceId, name, token) — lib/core.d.ts:86.
        if ((args[1] as string) === 'valkey-io-valkey') {
          throw new Error('fetch failed');
        }
        return 'running';
      }
    );

    const app = await buildApp(paramStore);
    const startedAt = Date.now();
    const op = await provisionAndWait(app);
    const elapsed = Date.now() - startedAt;

    expect(op.status).toBe('failed');

    // The wait ended at the deadline, not on the first dropped poll and not
    // never: it polled repeatedly for ~READY_TIMEOUT_MS. The upper bound is
    // generous (the flow also does non-wait work) but far below the unbounded
    // behaviour this replaces.
    expect(elapsed).toBeGreaterThanOrEqual(READY_TIMEOUT_MS);
    expect(elapsed).toBeLessThan(30_000);
    const queueProbes = probedServiceIds().filter(
      (s) => s === 'valkey-io-valkey'
    );
    expect(queueProbes.length).toBeGreaterThan(1);

    // The error names the failing service and folds in the last probe error,
    // instead of surfacing a bare `fetch failed` with no attribution.
    expect(op.error).toContain('valkey-io-valkey');
    expect(op.error).toContain(`timed out after ${READY_TIMEOUT_MS}ms`);
    expect(op.error).toContain('last health check error: fetch failed');

    // The EXISTING rollback path ran over everything this operation created,
    // including the instance whose readiness wait timed out.
    const removed = removedServiceIds();
    expect(removed).toContain('minio-minio');
    expect(removed).toContain('apache-couchdb');
    expect(removed).toContain('valkey-io-valkey');

    const result = op.result as {
      failedService: string;
      rollback: { status: string };
    };
    expect(result.failedService).toBe('valkey-io-valkey');
    expect(result.rollback.status).toBe('removed');
  });
});
