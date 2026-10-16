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
//   4. With the post-teardown reconcile wired, a failed teardown that DID
//      remove the Valkey (and then failed on a later service, so the stored
//      config is kept) leaves no poller running: the reconcile must not re-arm
//      one against a store this run has already removed.
//   5. ...and the complementary case still re-arms: a failed teardown whose
//      Valkey removal itself failed leaves the store alive, so the reconcile
//      brings its poller back rather than leaving completions undrained.
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
//     StackCallbackPollerRegistry.sync / .stopForStack / .size and
//     RemovedStackQueues.record / .isRemoved / .forgetUnlisted — the real
//     registry and the real removed-queue bookkeeping main.ts uses are
//     exercised here, not stand-ins.
//   - src/routes/provision.ts ProvisionRouterOptions.onStackQueuePresence —
//     `(name: string, present: boolean) => void`, reported before
//     onStackChange on the terminal paths that KEEP the stored config.
//   - src/services/stack.ts TEARDOWN_ORDER — packager -> queue (Valkey) ->
//     database -> storage, so a database/storage failure happens AFTER the
//     Valkey has already been removed. That ordering is what makes case 4
//     reachable at all.
//   - src/services/deprovision.ts TeardownStatus — 'removed' | 'not_found' |
//     'failed'; 'not_found' is CONFIRMED absence, 'failed' is the only status
//     that leaves an instance possibly still there.
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
import {
  RemovedStackQueues,
  StackCallbackPollerRegistry
} from '../pipeline/stack-callback-poller-registry.js';

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

// main.ts's post-teardown reconcile, reduced to the part that matters here
// (syncStackCallbackPollers): enumerate the stacks that still have a stored
// config, SKIP the ones a teardown reported as having lost their Valkey, sync
// the poller fleet over the rest, then forget the records of stacks that are no
// longer enumerated at all. The gate and the registry are the real ones.
function makeReconcile(fleet: {
  registry: StackCallbackPollerRegistry;
  pollers: FakePoller[];
  events: string[];
  removedQueues: RemovedStackQueues;
  listedStacks: () => Array<{ stackKey: string; connectionId: string }>;
}): { reconcile: () => void; runs: () => number } {
  let runs = 0;
  return {
    runs: () => runs,
    reconcile: () => {
      runs += 1;
      const listed = fleet.listedStacks();
      const pollable = listed.filter(
        (connection) => !fleet.removedQueues.isRemoved(connection.stackKey)
      );
      fleet.registry.sync(pollable, (connection) => {
        const poller: FakePoller = {
          connectionId: connection.connectionId,
          running: true,
          stops: 0
        };
        fleet.pollers.push(poller);
        fleet.events.push(`start:${poller.connectionId}`);
        return () => {
          poller.running = false;
          poller.stops += 1;
          fleet.events.push(`stop:${poller.connectionId}`);
        };
      });
      fleet.removedQueues.forgetUnlisted(listed.map((c) => c.stackKey));
    }
  };
}

async function buildApp(options: {
  paramStore?: ParamStore;
  onStackTeardownStart?: (name: string) => void | Promise<void>;
  onStackQueuePresence?: (name: string, present: boolean) => void;
  onStackChange?: (workspaceId: string) => void;
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
    ...(options.onStackQueuePresence
      ? { onStackQueuePresence: options.onStackQueuePresence }
      : {}),
    ...(options.onStackChange ? { onStackChange: options.onStackChange } : {}),
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

  // The complementary case to the test above it: there the VALKEY removal was
  // what failed, so the store survived. Here the Valkey is removed
  // successfully and a LATER service fails — which TEARDOWN_ORDER (packager ->
  // queue -> database -> storage) makes the normal shape of a partial failure.
  // The stored config is kept for the retry, so the stack is still fully
  // enumerable with a `redisUrl` pointing at a Valkey that no longer exists,
  // and the reconcile this path triggers would re-arm a poller straight onto
  // it if nothing said otherwise.
  it('does not re-arm the poller when a failed teardown already removed the Valkey', async () => {
    const { registry, pollers, events } = makePollerFleet();
    const removedQueues = new RemovedStackQueues();

    removeInstance.mockImplementation(async (_ctx, serviceId: string) => {
      events.push(`removeInstance:${serviceId}`);
      // The Valkey goes away cleanly; the database removal then fails
      // permanently, so the run reports `failed` and keeps the stored config.
      if (serviceId === 'apache-couchdb') {
        throw Object.assign(new Error('instance is busy'), { httpCode: 409 });
      }
    });

    // Both stacks still have a stored config after this run — mystack's is
    // deliberately KEPT because the teardown failed.
    const { reconcile, runs } = makeReconcile({
      registry,
      pollers,
      events,
      removedQueues,
      listedStacks: () => [
        { stackKey: 'mystack', connectionId: 'valkey.example.osaas.io:6379' },
        { stackKey: 'otherstack', connectionId: 'other.example.osaas.io:6379' }
      ]
    });

    const app = await buildApp({
      paramStore: makeParamStore(STORED_CONFIG),
      onStackTeardownStart: (name) => {
        registry.stopForStack(name);
      },
      onStackQueuePresence: (name, present) => {
        removedQueues.record(name, present);
      },
      onStackChange: () => reconcile()
    });

    const op = await deleteAndWait(app, 'mystack');
    expect(op.status).toBe('done');
    expect((op.result as { status: string }).status).toBe('failed');
    // The Valkey really was removed by this run, and reported as such.
    expect(events).toContain(`removeInstance:${VALKEY_SERVICE_ID}`);
    const queueResult = (
      op.result as { services: Array<{ serviceId: string; status: string }> }
    ).services.find((s) => s.serviceId === VALKEY_SERVICE_ID);
    expect(queueResult?.status).toBe('removed');
    // The reconcile did run on this path (that is the whole risk).
    expect(runs()).toBeGreaterThan(0);
    // And it left NO poller on the removed store: not the original one, and no
    // replacement started in its place.
    expect(
      pollers.filter(
        (p) => p.connectionId === 'valkey.example.osaas.io:6379' && p.running
      )
    ).toEqual([]);
    expect(events).not.toContain('start:valkey.example.osaas.io:6379');
    expect(registry.has('valkey.example.osaas.io:6379')).toBe(false);
    expect(removedQueues.isRemoved('mystack')).toBe(true);
    // The other stack is untouched: the gate is per stack, not global.
    const otherPoller = pollers.find(
      (p) => p.connectionId === 'other.example.osaas.io:6379'
    )!;
    expect(otherPoller.running).toBe(true);
  });

  it('re-arms the poller when a failed teardown left the Valkey in place', async () => {
    const { registry, pollers, events } = makePollerFleet();
    const removedQueues = new RemovedStackQueues();

    // This time the Valkey removal itself is what fails, so the store is still
    // there and its completions still need draining.
    removeInstance.mockImplementation(async (_ctx, serviceId: string) => {
      events.push(`removeInstance:${serviceId}`);
      if (serviceId === VALKEY_SERVICE_ID) {
        throw Object.assign(new Error('instance is busy'), { httpCode: 409 });
      }
    });

    const { reconcile } = makeReconcile({
      registry,
      pollers,
      events,
      removedQueues,
      listedStacks: () => [
        { stackKey: 'mystack', connectionId: 'valkey.example.osaas.io:6379' },
        { stackKey: 'otherstack', connectionId: 'other.example.osaas.io:6379' }
      ]
    });

    const app = await buildApp({
      paramStore: makeParamStore(STORED_CONFIG),
      onStackTeardownStart: (name) => {
        registry.stopForStack(name);
      },
      onStackQueuePresence: (name, present) => {
        removedQueues.record(name, present);
      },
      onStackChange: () => reconcile()
    });

    const op = await deleteAndWait(app, 'mystack');
    expect(op.status).toBe('done');
    expect((op.result as { status: string }).status).toBe('failed');
    expect(removedQueues.isRemoved('mystack')).toBe(false);
    // Stopped for the teardown, then brought back by the reconcile because the
    // store survived it.
    expect(events.indexOf('stop:valkey.example.osaas.io:6379')).toBeLessThan(
      events.indexOf('start:valkey.example.osaas.io:6379')
    );
    expect(registry.has('valkey.example.osaas.io:6379')).toBe(true);
    const live = pollers.filter(
      (p) => p.connectionId === 'valkey.example.osaas.io:6379' && p.running
    );
    expect(live).toHaveLength(1);
  });
});
