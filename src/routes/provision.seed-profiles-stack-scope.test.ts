// The provision-boundary profile seed must run against the stack being
// provisioned, not the first-listed one (issue #1164).
//
// Why this is part of #1164. The seed goes through the
// PerWorkspaceProfileRepository, which resolves the stack of the in-flight
// request and falls back to the FIRST listed stack when the request named none
// (src/data/per-workspace-repos.ts:362-366 ->
// src/services/workspace-stack.ts `resolve()`, no-stackName branch). A provision
// request names the new stack in its BODY, not in `X-Stack-Name`, so on an
// install that already has a stack this seed re-seeded stack 1 (idempotently: a
// no-op) and left the stack it had just provisioned with an EMPTY profile store.
// That was invisible while every stack's Encore read the first stack's index;
// once each stack's Encore reads its OWN index (the #1164 fix), an unseeded
// second stack would fail every transcode with "Could not find location for
// profile program!". So the seed has to re-enter the new stack.
//
// Oracle: what the seed callback observes as the AMBIENT stack. Pre-fix it is
// `undefined` (the first-listed-stack fallback); post-fix it is the stack name
// the provision request asked for.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - src/routes/provision.ts — `provisionRouter` options { osc, paramStore,
//     operationStore, seedProfiles?, readyPollIntervalMs? }; `POST /` body
//     { name } -> 202 { operationId }; `GET /operations/:id` -> Operation.
//   - src/services/request-stack-context.ts — `currentRequestStackName()`,
//     `runWithRequestStack`.
//   - src/services/param-store.ts — `ParamStore.storeStackConfig /
//     loadStackConfig / deleteStackConfig / listStackNames`, `StackConfig`.
// Harness copied from src/routes/provision.idempotency.test.ts (same OSC/minio/
// nano mocks), so the flow completes with no live backing service.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

const createInstance = vi.fn();
const getInstance = vi.fn();
const saveSecret = vi.fn();
const waitForInstanceReady = vi.fn(async () => undefined);
const getInstanceHealth = vi.fn(async (..._args: unknown[]) => 'running');
const getPortsForInstance = vi.fn(async () => []);

vi.mock('@osaas/client-core', () => ({
  createInstance: (...args: unknown[]) => createInstance(...(args as [])),
  getInstance: (...args: unknown[]) => getInstance(...(args as [])),
  removeInstance: vi.fn(),
  getPortsForInstance: (...args: unknown[]) => getPortsForInstance(...(args as [])),
  waitForInstanceReady: (...args: unknown[]) => waitForInstanceReady(...(args as [])),
  getInstanceHealth: (...args: unknown[]) => getInstanceHealth(...(args as [])),
  saveSecret: (...args: unknown[]) => saveSecret(...(args as [])),
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
import { currentRequestStackName } from '../services/request-stack-context.js';

// The stack this install already has (first in the listing) and the one being
// provisioned second — the position the issue is about.
const FIRST_STACK = 'firststack';
const NEW_STACK = 'secondstack';

function instanceFor(serviceId: string) {
  const host =
    serviceId === 'minio-minio'
      ? 'https://minio.example.osaas.io'
      : serviceId === 'apache-couchdb'
        ? 'https://couch.example.osaas.io'
        : 'https://valkey.example.osaas.io';
  return { name: NEW_STACK, url: host };
}

// A parameter store that ALREADY lists a first stack, so a fallback resolution
// has somewhere wrong to land. listStackNames returns the first stack first.
function makeParamStore() {
  const stored = new Map<string, StackConfig>([
    [
      FIRST_STACK,
      {
        status: 'ready',
        minioEndpoint: 'https://minio.first.example.osaas.io',
        couchdbUrl: 'https://couch.first.example.osaas.io',
        redisUrl: 'redis://valkey-first.svc.cluster.local:6379',
        sourceBucket: 'openvideocore-source',
        packagedBucket: 'openvideocore-packaged',
        services: []
      } as StackConfig
    ]
  ]);
  return {
    storeStackConfig: vi.fn(async (_ws: string, name: string, cfg: StackConfig) => {
      stored.set(name, cfg);
    }),
    loadStackConfig: vi.fn(async (_ws: string, name: string) => stored.get(name)),
    deleteStackConfig: vi.fn(async (_ws: string, name: string) => {
      stored.delete(name);
    }),
    listStackNames: vi.fn(async () => [...stored.keys()])
  } as unknown as ParamStore;
}

async function waitForOperation(
  app: ReturnType<typeof Fastify>,
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

beforeEach(() => {
  createInstance.mockReset();
  getInstance.mockReset();
  saveSecret.mockReset();
  createInstance.mockImplementation(async (_c, serviceId: string) =>
    instanceFor(serviceId)
  );
  getInstance.mockImplementation(async (_c, serviceId: string) =>
    instanceFor(serviceId)
  );
});

describe('provision seeds the profile store of the stack it provisioned (issue #1164)', () => {
  it('runs seedProfiles in the NEW stack\'s context, not the first-listed one', async () => {
    // What the seed callback sees as the ambient stack, captured per call.
    const seenStacks: (string | undefined)[] = [];

    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(provisionRouter, {
      prefix: '/api/v1/provision',
      osc: { getServiceAccessToken: vi.fn(async () => 'test-sat') } as never,
      paramStore: makeParamStore(),
      operationStore: new OperationStore(),
      seedProfiles: async () => {
        seenStacks.push(currentRequestStackName());
      },
      readyPollIntervalMs: 1
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/provision',
      payload: { name: NEW_STACK }
    });
    expect(res.statusCode).toBe(202);
    const op = await waitForOperation(app, res.json().operationId);
    expect(op.status).toBe('done');

    // The seed ran, and it ran against the stack just provisioned. `undefined`
    // here is the bug: the profile repository would then resolve the FIRST
    // listed stack and the new stack's store would stay empty.
    expect(seenStacks).toEqual([NEW_STACK]);
  });
});
