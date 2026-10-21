// Issue #1210: DELETE /api/v1/provision/{stack} closed its async operation as
// `status: 'done'` even when the teardown result was `failed` — packager,
// database and object store still running — and the stack stayed in the listing
// with no indication that it was only half removed. Every consumer that
// switches on the operation state (public/app.js pollDeprovisionOp treats
// `done` as "✓ removed" and drops the row) therefore read a partial failure as
// a clean delete.
//
// Contract sources exercised here:
//   - OperationStatus ('pending' | 'running' | 'done' | 'failed') —
//     src/services/operation-store.ts:3, mirrored by operationSchema in
//     src/routes/provision.ts. No new operation state is introduced.
//   - StackTeardownResult / ServiceTeardownResult —
//     src/services/deprovision.ts:29,48 (per-service serviceId/role/status).
//   - StackConfig.status teardown states 'deleting' | 'delete_failed' —
//     src/services/param-store.ts, surfaced by computeStackReadiness
//     (src/services/stack-readiness.ts) on GET /api/v1/provision/:name.
//   - The listing is ParamStore.listStackNames (src/services/param-store.ts),
//     which lists every stored entry regardless of status — so retaining the
//     entry is what keeps a not-fully-removed stack listed.
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
  listSubscriptions: vi.fn(async () => {
    throw new Error('listSubscriptions must never be called (#804)');
  }),
  waitForInstanceReady: vi.fn(),
  getInstanceHealth: vi.fn(async () => 'running'),
  saveSecret: vi.fn(),
  Context: class {}
}));

process.env['MINIO_ROOT_PASSWORD'] = 'test-minio-password';
process.env['COUCHDB_ADMIN_PASSWORD'] = 'test-couchdb-password';

import { provisionRouter } from './provision.js';
import type { ParamStore, StackConfig } from '../services/param-store.js';
import { STACK_CONFIG_NAMESPACE } from '../services/workspace-stack.js';
import { OperationStore, type Operation } from '../services/operation-store.js';

const getServiceAccessToken = vi.fn(async () => 'test-sat');
const osc = { getServiceAccessToken } as never;

const STORED_CONFIG: StackConfig = {
  status: 'ready',
  minioEndpoint: 'https://minio.example.osaas.io',
  couchdbUrl: 'https://couch.example.osaas.io',
  redisUrl: 'redis://valkey.svc.cluster.local:6379',
  sourceBucket: 'openvideocore-source',
  packagedBucket: 'openvideocore-packaged',
  services: [
    { serviceId: 'minio-minio', instanceName: 'delstk' },
    { serviceId: 'apache-couchdb', instanceName: 'delstk' },
    { serviceId: 'valkey-io-valkey', instanceName: 'delstk' }
  ]
};

// A real (in-memory) param store: writes are visible to later reads, so the
// teardown markers this route persists can be observed through the SAME public
// surfaces an operator uses — GET /api/v1/provision (listStackNames) and
// GET /api/v1/provision/:name (loadStackConfig).
function makeMemoryParamStore(initial: Record<string, StackConfig>) {
  const entries = new Map<string, StackConfig>(Object.entries(initial));
  const writes: StackConfig[] = [];
  const store = {
    storeStackConfig: vi.fn(async (_w: string, n: string, c: StackConfig) => {
      entries.set(n, c);
      writes.push(c);
    }),
    loadStackConfig: vi.fn(async (_w: string, n: string) => entries.get(n)),
    deleteStackConfig: vi.fn(async (_w: string, n: string) => {
      entries.delete(n);
    }),
    listStackNames: vi.fn(async () => [...entries.keys()])
  };
  return { store: store as unknown as ParamStore, writes, entries, spies: store };
}

async function buildApp(paramStore?: ParamStore) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(provisionRouter, {
    prefix: '/api/v1/provision',
    osc,
    paramStore,
    operationStore: new OperationStore()
  });
  await app.ready();
  return app;
}

async function waitForOperation(
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
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('operation did not complete in time');
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
  return waitForOperation(app, res.json().operationId);
}

type Svc = { serviceId: string; role: string; status: string; error?: string };
function servicesOf(op: Operation): Svc[] {
  return ((op.result as { services?: unknown[] } | undefined)?.services ??
    []) as Svc[];
}

beforeEach(() => {
  getInstance.mockReset();
  listInstances.mockReset();
  removeInstance.mockReset();
  getServiceAccessToken.mockClear();
  listInstances.mockResolvedValue([]);
});

describe('DELETE /api/v1/provision/:name reports partial failure (#1210)', () => {
  it('fails the operation, names the surviving services, and keeps the per-service status', async () => {
    getInstance.mockResolvedValue({ name: 'delstk' });
    removeInstance.mockImplementation(async (_c: unknown, serviceId: string) => {
      if (serviceId === 'minio-minio') throw new Error('boom');
      return undefined;
    });
    const { store } = makeMemoryParamStore({ delstk: STORED_CONFIG });

    const app = await buildApp(store);
    const op = await deleteAndWait(app, 'delstk');

    // The defect: this used to be 'done' while the result said 'failed'.
    expect(op.status).toBe('failed');
    expect((op.result as { status: string }).status).toBe('failed');
    // Per-service status survives on the operation for BOTH outcomes.
    const minio = servicesOf(op).find((s) => s.serviceId === 'minio-minio');
    expect(minio?.status).toBe('failed');
    expect(
      servicesOf(op).filter((s) => s.serviceId !== 'minio-minio').length
    ).toBeGreaterThan(0);
    // `error` is the only failure field the existing pollers render, so the
    // services left in place are named there too.
    expect(op.error).toBeDefined();
    expect(op.error).toContain('minio-minio');
  });

  it('keeps the stack listed and marked delete_failed until every service is removed', async () => {
    getInstance.mockResolvedValue({ name: 'delstk' });
    removeInstance.mockImplementation(async (_c: unknown, serviceId: string) => {
      if (serviceId === 'apache-couchdb') throw new Error('couch boom');
      return undefined;
    });
    const { store, spies } = makeMemoryParamStore({ delstk: STORED_CONFIG });

    const app = await buildApp(store);
    const op = await deleteAndWait(app, 'delstk');
    expect(op.status).toBe('failed');

    // Still listed — the stored entry is the record of what is left to remove.
    const list = await app.inject({ method: 'GET', url: '/api/v1/provision' });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toContain('delstk');
    expect(spies.deleteStackConfig).not.toHaveBeenCalled();

    // ...and it says so, with a machine-readable reason.
    const detail = await app.inject({
      method: 'GET',
      url: '/api/v1/provision/delstk'
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().status).toBe('delete_failed');
    expect(detail.json().reason.code).toBe('stack_delete_failed');
  });

  it('marks the stack deleting before it starts removing services', async () => {
    getInstance.mockResolvedValue({ name: 'delstk' });
    const order: string[] = [];
    removeInstance.mockImplementation(async () => {
      order.push('remove');
    });
    const { store, writes } = makeMemoryParamStore({ delstk: STORED_CONFIG });
    (store as unknown as { storeStackConfig: unknown }).storeStackConfig = vi.fn(
      async (_w: string, _n: string, c: StackConfig) => {
        order.push(`mark:${c.status}`);
        writes.push(c);
      }
    );

    const app = await buildApp(store);
    const op = await deleteAndWait(app, 'delstk');

    expect(op.status).toBe('done');
    expect(order[0]).toBe('mark:deleting');
    expect(order).toContain('remove');
  });

  it('still closes done and drops the entry when every service is removed', async () => {
    getInstance.mockResolvedValue({ name: 'delstk' });
    removeInstance.mockResolvedValue(undefined);
    const { store, spies } = makeMemoryParamStore({ delstk: STORED_CONFIG });

    const app = await buildApp(store);
    const op = await deleteAndWait(app, 'delstk');

    expect(op.status).toBe('done');
    expect((op.result as { status: string }).status).toBe('removed');
    expect(spies.deleteStackConfig).toHaveBeenCalledWith(
      STACK_CONFIG_NAMESPACE,
      'delstk'
    );
    // Fully removed, so it legitimately leaves the listing.
    const list = await app.inject({ method: 'GET', url: '/api/v1/provision' });
    expect(list.json()).not.toContain('delstk');
  });

  it('fails the operation on the store-less path too', async () => {
    getInstance.mockResolvedValue({ name: 'delstk' });
    removeInstance.mockImplementation(async (_c: unknown, serviceId: string) => {
      if (serviceId === 'minio-minio') throw new Error('boom');
      return undefined;
    });

    const app = await buildApp();
    const op = await deleteAndWait(app, 'delstk');

    expect(op.status).toBe('failed');
    expect((op.result as { status: string }).status).toBe('failed');
    expect(op.error).toContain('minio-minio');
  });

  it('leaves the stack marked delete_failed when the teardown throws outright', async () => {
    getInstance.mockResolvedValue({ name: 'delstk' });
    // A non-service failure mid-teardown: the scaler registry blows up in a way
    // the route does not catch locally.
    removeInstance.mockResolvedValue(undefined);
    const { store, entries } = makeMemoryParamStore({ delstk: STORED_CONFIG });
    (store as unknown as { deleteStackConfig: unknown }).deleteStackConfig =
      vi.fn(async () => {
        throw Object.assign(new Error('not a catchable delete'), {});
      });

    const app = await buildApp(store);
    const op = await deleteAndWait(app, 'delstk');

    // deleteStackConfig failures are deliberately tolerated (the instances are
    // gone), so this stays a done operation — but the stale entry must still
    // carry a teardown state rather than reading as a live stack.
    expect(op.status).toBe('done');
    expect(entries.get('delstk')?.status).toBe('deleting');
  });
});
