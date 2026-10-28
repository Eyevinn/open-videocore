// DELETE /api/v1/provision/:name must always reach a terminal state, and a
// retry must converge (issue #1212).
//
// Observed: a second DELETE on a partially deleted stack stayed `running` for
// more than seven minutes and removed nothing more. The operation is driven by
// a background closure, so anything that stalls inside it — an OSC call with no
// bound, a registry teardown that never returns — used to leave the caller
// polling `running` forever with no verdict and no leftovers named.
//
// CONTRACT SOURCES (verified before writing, CLAUDE.md rule 7):
//   - @osaas/client-core@0.24.0 lib/core.d.ts:46/56/65 — removeInstance /
//     getInstance / listInstances positional signatures, mocked below in the
//     same shape as the existing deprovision route tests. getInstance resolves
//     undefined for a 404 and for every other non-401 error (lib/core.js:127);
//     listInstances rejects on error (lib/core.js:160), which is what makes it
//     the confirming read.
//   - src/services/operation-store.ts — Operation.status is
//     'pending' | 'running' | 'done' | 'failed'; only done/failed are terminal.
//   - src/services/teardown-bounds.ts — the injected bounds
//     (operationTimeoutMs / serviceTimeoutMs / backoffMs / sleep) this route
//     accepts via ProvisionRouterOptions.teardownBounds.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';

const getInstance = vi.fn();
const listInstances = vi.fn();
const removeInstance = vi.fn();

vi.mock('@osaas/client-core', () => ({
  createInstance: vi.fn(),
  getInstance: (...args: unknown[]) => getInstance(...args),
  listInstances: (...args: unknown[]) => listInstances(...args),
  removeInstance: (...args: unknown[]) => removeInstance(...args),
  getPortsForInstance: vi.fn(),
  listSubscriptions: vi.fn(),
  waitForInstanceReady: vi.fn(),
  getInstanceHealth: vi.fn(async () => 'running'),
  saveSecret: vi.fn(),
  Context: class {}
}));

process.env['MINIO_ROOT_PASSWORD'] = 'test-minio-password';
process.env['COUCHDB_ADMIN_PASSWORD'] = 'test-couchdb-password';

import { provisionRouter } from './provision.js';
import type { ParamStore } from '../services/param-store.js';
import { OperationStore, type Operation } from '../services/operation-store.js';
import type { TeardownBoundsOverrides } from '../services/teardown-bounds.js';

const osc = { getServiceAccessToken: vi.fn(async () => 'test-sat') } as never;

const STORED_CONFIG = {
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

async function buildApp(options: {
  paramStore?: ParamStore;
  teardownBounds?: TeardownBoundsOverrides;
  getScalerRegistry?: () => unknown;
}) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(provisionRouter, {
    prefix: '/api/v1/provision',
    osc,
    paramStore: options.paramStore,
    operationStore: new OperationStore(),
    ...(options.teardownBounds ? { teardownBounds: options.teardownBounds } : {}),
    ...(options.getScalerRegistry
      ? { getScalerRegistry: options.getScalerRegistry as never }
      : {})
  });
  await app.ready();
  return app;
}

// Poll with a real (small) wait between reads so an operation that has to wait
// out an injected deadline is still observed reaching a terminal state.
async function waitForTerminal(
  app: Awaited<ReturnType<typeof buildApp>>,
  operationId: string
): Promise<Operation> {
  for (let i = 0; i < 400; i++) {
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/provision/operations/${operationId}`
    });
    const op = res.json() as Operation;
    if (op.status === 'done' || op.status === 'failed') return op;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('operation never reached a terminal state');
}

async function deleteAndWait(
  app: Awaited<ReturnType<typeof buildApp>>,
  name: string
): Promise<Operation> {
  const res = await app.inject({
    method: 'DELETE',
    url: `/api/v1/provision/${name}`
  });
  expect(res.statusCode).toBe(202);
  return waitForTerminal(app, res.json().operationId as string);
}

beforeEach(() => {
  getInstance.mockReset();
  listInstances.mockReset();
  removeInstance.mockReset();
  listInstances.mockResolvedValue([]);
});

describe('DELETE /api/v1/provision/:name always reaches a terminal state (#1212)', () => {
  it('fails the operation instead of staying `running` when a teardown step hangs', async () => {
    // The scaler registry teardown never returns — the stall that is outside
    // the stored-service teardown's own per-service budget.
    const paramStore = makeParamStore(STORED_CONFIG);
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockResolvedValue(undefined);

    const app = await buildApp({
      paramStore,
      getScalerRegistry: () => ({ teardown: () => new Promise(() => {}) }),
      teardownBounds: {
        operationTimeoutMs: 200,
        serviceTimeoutMs: 1000,
        sleep: async () => {}
      }
    });

    const op = await deleteAndWait(app, 'mystack');

    expect(op.status).toBe('failed');
    expect(op.error).toContain('stack teardown "mystack"');
    expect(op.error).toContain('timed out');
    // The record of what still needs removing survives the timeout.
    expect(paramStore.deleteStackConfig).not.toHaveBeenCalled();
  });

  it('bounds a hung step without failing the whole operation when the step is optional', async () => {
    // Same hang, but the per-service bound fires first: the scaler teardown is
    // logged-and-continued, so the static services are still removed and the
    // operation completes.
    const paramStore = makeParamStore(STORED_CONFIG);
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockResolvedValue(undefined);

    const app = await buildApp({
      paramStore,
      getScalerRegistry: () => ({ teardown: () => new Promise(() => {}) }),
      teardownBounds: {
        operationTimeoutMs: 5_000,
        serviceTimeoutMs: 30,
        sleep: async () => {}
      }
    });

    const op = await deleteAndWait(app, 'mystack');

    expect(op.status).toBe('done');
    expect((op.result as { status: string }).status).toBe('removed');
    expect(paramStore.deleteStackConfig).toHaveBeenCalled();
  });

  it('a second DELETE skips the services already gone and removes the rest', async () => {
    // The first DELETE removed storage; the queue and database survived it, so
    // the stored config was kept and the operator re-issued the DELETE.
    const paramStore = makeParamStore(STORED_CONFIG);
    getInstance.mockImplementation(async (_c: unknown, serviceId: string) =>
      serviceId === 'minio-minio' ? undefined : { name: 'mystack' }
    );
    listInstances.mockImplementation(async (_c: unknown, serviceId: string) =>
      serviceId === 'minio-minio' ? [] : [{ name: 'mystack' }]
    );
    removeInstance.mockResolvedValue(undefined);

    const app = await buildApp({
      paramStore,
      teardownBounds: { sleep: async () => {} }
    });

    const op = await deleteAndWait(app, 'mystack');

    expect(op.status).toBe('done');
    const result = op.result as {
      status: string;
      services: { serviceId: string; status: string }[];
    };
    expect(result.status).toBe('partial');
    expect(
      result.services.find((s) => s.serviceId === 'minio-minio')?.status
    ).toBe('not_found');
    // No second DELETE for the instance that was already gone...
    expect(removeInstance.mock.calls.some((c) => c[1] === 'minio-minio')).toBe(
      false
    );
    // ...and the two stored services that were left are gone now, so the stack
    // converged and the stored coordinates were removed. (The on-demand
    // packager is reconciled separately and is removed too, issue #1056.)
    const removedIds = removeInstance.mock.calls.map((c) => c[1] as string);
    expect(removedIds).toContain('apache-couchdb');
    expect(removedIds).toContain('valkey-io-valkey');
    expect(paramStore.deleteStackConfig).toHaveBeenCalled();
  });

  it('reports a transient OSC failure clearly and keeps the config for the next retry', async () => {
    const paramStore = makeParamStore(STORED_CONFIG);
    getInstance.mockResolvedValue({ name: 'mystack' });
    removeInstance.mockImplementation(async (_c: unknown, serviceId: string) => {
      if (serviceId === 'valkey-io-valkey') {
        throw new Error('ORCHESTRATOR_UNAVAILABLE');
      }
      return undefined;
    });

    const app = await buildApp({
      paramStore,
      teardownBounds: {
        removeAttempts: 2,
        backoffMs: [5],
        sleep: async () => {}
      }
    });

    const op = await deleteAndWait(app, 'mystack');

    expect(op.status).toBe('failed');
    const result = op.result as {
      status: string;
      services: { serviceId: string; status: string; failure?: string; error?: string }[];
    };
    expect(result.status).toBe('failed');
    const queue = result.services.find(
      (s) => s.serviceId === 'valkey-io-valkey'
    );
    expect(queue?.failure).toBe('transient');
    expect(queue?.error).toContain('ORCHESTRATOR_UNAVAILABLE');
    expect(queue?.error).toContain('2 attempts');
    expect(paramStore.deleteStackConfig).not.toHaveBeenCalled();
    // The transient service was retried; the healthy ones were still removed.
    expect(
      removeInstance.mock.calls.filter((c) => c[1] === 'valkey-io-valkey')
    ).toHaveLength(2);
  });
});
