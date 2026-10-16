// DELETE /api/v1/provision/:name must leave no callback poller running against
// the stack it just removed (issue #1213).
//
// Observed: after the stack's Valkey instance was removed, the
// encore-callback-poller bound to it kept retrying with ECONNREFUSED about once
// a second. The only thing that ever stopped a stack's poller was the reconcile
// at the END of a SUCCESSFUL teardown, so the poller polled a dead store for
// the whole teardown — and for the lifetime of the process when the teardown
// reported failures, because that path never reached the reconcile at all.
//
// Pinned here:
//   1. The pollers bound to the stack are stopped BEFORE its Valkey instance is
//      removed, and none is left running after the delete.
//   2. The same holds when the teardown reports failures.
//   3. The same holds for a stack whose stored config is already gone (the
//      retry-after-teardown path), which removes nothing at all.
//
// CONTRACT SOURCES (verified before writing, CLAUDE.md rule 7):
//   - @osaas/client-core@0.24.0 lib/core.d.ts:46/56/65 — removeInstance(context,
//     serviceId, name, token) / getInstance(context, serviceId, name, token) /
//     listInstances(context, serviceId, token); mocked below in exactly those
//     positional shapes, as the existing deprovision route tests do.
//   - src/routes/provision.ts ProvisionRouterOptions.onStackTeardownStart —
//     `(name: string) => void | Promise<void>`, invoked with the STACK NAME at
//     the start of the DELETE teardown.
//   - src/pipeline/stack-callback-poller-registry.ts
//     StackCallbackPollerRegistry.sync / .stopForStack / .size — the real
//     registry main.ts uses is exercised here, not a stand-in.
//   - src/services/operation-store.ts — Operation.status is
//     'pending' | 'running' | 'done' | 'failed'; only done/failed are terminal.

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
import { StackCallbackPollerRegistry } from '../pipeline/stack-callback-poller-registry.js';

const osc = { getServiceAccessToken: vi.fn(async () => 'test-sat') } as never;

const VALKEY_SERVICE_ID = 'valkey-io-valkey';

const STORED_CONFIG = {
  minioEndpoint: 'https://minio.example.osaas.io',
  couchdbUrl: 'https://couch.example.osaas.io',
  redisUrl: 'redis://valkey.example.osaas.io:6379',
  sourceBucket: 'openvideocore-source',
  packagedBucket: 'openvideocore-packaged',
  services: [
    { serviceId: 'minio-minio', instanceName: 'mystack' },
    { serviceId: 'apache-couchdb', instanceName: 'mystack' },
    { serviceId: VALKEY_SERVICE_ID, instanceName: 'mystack' }
  ]
};

// A stand-in for startEncoreCallbackPoller: records that it is running and
// flips to stopped when the stop function the registry holds is called.
type FakePoller = { connectionId: string; running: boolean; stops: number };

function makePollerFleet(): {
  registry: StackCallbackPollerRegistry;
  pollers: FakePoller[];
  events: string[];
} {
  const registry = new StackCallbackPollerRegistry();
  const pollers: FakePoller[] = [];
  const events: string[] = [];
  registry.sync(
    [
      { stackKey: 'mystack', connectionId: 'valkey.example.osaas.io:6379' },
      { stackKey: 'otherstack', connectionId: 'other.example.osaas.io:6379' }
    ],
    (connection) => {
      const poller: FakePoller = {
        connectionId: connection.connectionId,
        running: true,
        stops: 0
      };
      pollers.push(poller);
      return () => {
        poller.running = false;
        poller.stops += 1;
        events.push(`stop:${poller.connectionId}`);
      };
    }
  );
  return { registry, pollers, events };
}

function makeParamStore(loadResult: unknown) {
  return {
    storeStackConfig: vi.fn(),
    loadStackConfig: vi.fn(async () => loadResult),
    deleteStackConfig: vi.fn(async () => undefined)
  } as unknown as ParamStore;
}

async function buildApp(options: {
  paramStore?: ParamStore;
  onStackTeardownStart?: (name: string) => void | Promise<void>;
}) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(provisionRouter, {
    prefix: '/api/v1/provision',
    osc,
    paramStore: options.paramStore,
    operationStore: new OperationStore(),
    ...(options.onStackTeardownStart
      ? { onStackTeardownStart: options.onStackTeardownStart }
      : {}),
    // Millisecond budgets and a no-op sleep so a failing removal exhausts its
    // bounded retries immediately instead of waiting out the real backoff.
    teardownBounds: {
      operationTimeoutMs: 5_000,
      serviceTimeoutMs: 2_000,
      backoffMs: [0, 0],
      sleep: async () => undefined
    }
  });
  await app.ready();
  return app;
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
  const operationId = res.json().operationId as string;
  for (let i = 0; i < 400; i++) {
    const poll = await app.inject({
      method: 'GET',
      url: `/api/v1/provision/operations/${operationId}`
    });
    const op = poll.json() as Operation;
    if (op.status === 'done' || op.status === 'failed') return op;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('operation never reached a terminal state');
}

beforeEach(() => {
  getInstance.mockReset();
  listInstances.mockReset();
  removeInstance.mockReset();
  // Every stored instance exists, so each one is really removed.
  getInstance.mockResolvedValue({ name: 'mystack' });
  listInstances.mockResolvedValue([{ name: 'mystack' }]);
  removeInstance.mockResolvedValue(undefined);
});

describe('DELETE /api/v1/provision/:name releases the stack-bound callback pollers (#1213)', () => {
  it('stops the stack poller before removing its Valkey, and leaves none running', async () => {
    const { registry, pollers, events } = makePollerFleet();
    expect(pollers.map((p) => p.running)).toEqual([true, true]);

    removeInstance.mockImplementation(async (_ctx, serviceId: string) => {
      events.push(`removeInstance:${serviceId}`);
    });

    const app = await buildApp({
      paramStore: makeParamStore(STORED_CONFIG),
      onStackTeardownStart: (name) => {
        registry.stopForStack(name);
      }
    });

    const op = await deleteAndWait(app, 'mystack');
    expect(op.status).toBe('done');

    const stackPoller = pollers.find(
      (p) => p.connectionId === 'valkey.example.osaas.io:6379'
    )!;
    // 1. The poller for the deleted stack is stopped...
    expect(stackPoller.running).toBe(false);
    // ...exactly once, and BEFORE the Valkey instance it drains was removed.
    expect(stackPoller.stops).toBe(1);
    expect(events.indexOf('stop:valkey.example.osaas.io:6379')).toBeLessThan(
      events.indexOf(`removeInstance:${VALKEY_SERVICE_ID}`)
    );
    // 2. No poller is left registered for the deleted stack.
    expect(registry.has('valkey.example.osaas.io:6379')).toBe(false);
    expect(registry.stackKeysFor('valkey.example.osaas.io:6379')).toEqual([]);
    // 3. Another stack's poller is untouched — only this stack was deleted.
    const otherPoller = pollers.find(
      (p) => p.connectionId === 'other.example.osaas.io:6379'
    )!;
    expect(otherPoller.running).toBe(true);
    expect(registry.connectionIds()).toEqual(['other.example.osaas.io:6379']);
  });

  it('leaves no poller running when the teardown reports failures', async () => {
    const { registry, pollers } = makePollerFleet();
    // The Valkey removal fails permanently, so the operation reports `failed`
    // services — the path that never reached the post-teardown reconcile.
    removeInstance.mockImplementation(async (_ctx, serviceId: string) => {
      if (serviceId === VALKEY_SERVICE_ID) {
        throw Object.assign(new Error('instance is busy'), { httpCode: 409 });
      }
    });

    const app = await buildApp({
      paramStore: makeParamStore(STORED_CONFIG),
      onStackTeardownStart: (name) => {
        registry.stopForStack(name);
      }
    });

    const op = await deleteAndWait(app, 'mystack');
    expect(op.status).toBe('done');
    expect((op.result as { status: string }).status).toBe('failed');

    const stackPoller = pollers.find(
      (p) => p.connectionId === 'valkey.example.osaas.io:6379'
    )!;
    expect(stackPoller.running).toBe(false);
    expect(registry.has('valkey.example.osaas.io:6379')).toBe(false);
  });

  it('releases the pollers even when the stack config is already gone', async () => {
    const { registry, pollers } = makePollerFleet();

    const app = await buildApp({
      paramStore: makeParamStore(undefined),
      onStackTeardownStart: (name) => {
        registry.stopForStack(name);
      }
    });

    const op = await deleteAndWait(app, 'mystack');
    expect(op.status).toBe('done');
    expect((op.result as { status: string }).status).toBe('not_found');

    const stackPoller = pollers.find(
      (p) => p.connectionId === 'valkey.example.osaas.io:6379'
    )!;
    expect(stackPoller.running).toBe(false);
    expect(removeInstance).not.toHaveBeenCalled();
  });
});
