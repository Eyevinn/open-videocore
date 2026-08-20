import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';

// Mock the OSC SDK the same way provision.deprovision.test.ts does: swap each
// imported function for a spy so no real OSC call is made.
const createInstance = vi.fn();
const getInstance = vi.fn();
const removeInstance = vi.fn();
const saveSecret = vi.fn();

vi.mock('@osaas/client-core', () => ({
  createInstance: (...args: unknown[]) => createInstance(...args),
  getInstance: (...args: unknown[]) => getInstance(...args),
  removeInstance: (...args: unknown[]) => removeInstance(...args),
  saveSecret: (...args: unknown[]) => saveSecret(...args),
  Context: class {}
}));

import { optionalServicesRouter } from './optional-services.js';
import { OperationStore, type Operation } from '../services/operation-store.js';

const getServiceAccessToken = vi.fn(async () => 'test-sat');
const osc = { getServiceAccessToken } as never;

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const operationStore = new OperationStore();
  await app.register(optionalServicesRouter, {
    prefix: '/api/v1/optional-services',
    osc,
    operationStore
  });
  await app.ready();
  return { app, operationStore };
}

// Optional-service operations are async: the route returns 202 with an
// operationId and runs the real work in a setImmediate closure. Poll the shared
// operation store (the operations GET endpoints live on the provision router,
// not registered here) until the operation reaches a terminal state.
async function waitForOperation(
  store: OperationStore,
  operationId: string
): Promise<Operation> {
  for (let i = 0; i < 200; i++) {
    const op = store.get(operationId);
    if (op && (op.status === 'done' || op.status === 'failed')) return op;
    await new Promise((r) => setImmediate(r));
  }
  throw new Error('operation did not complete in time');
}

beforeEach(() => {
  createInstance.mockReset();
  getInstance.mockReset();
  removeInstance.mockReset();
  saveSecret.mockReset();
  getServiceAccessToken.mockClear();
  delete process.env['AUTO_SUBTITLES_INSTANCE_NAME'];
  delete process.env['SCENE_DETECT_INSTANCE_NAME'];
});

afterEach(() => {
  delete process.env['AUTO_SUBTITLES_INSTANCE_NAME'];
  delete process.env['SCENE_DETECT_INSTANCE_NAME'];
});

describe('GET /api/v1/optional-services (issue #195)', () => {
  it('lists every optional service and reports not-configured when the env var is unset', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/optional-services'
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { key: string; state: string }[];
    const keys = body.map((s) => s.key).sort();
    expect(keys).toEqual(['auto-subtitles', 'scene-detect']);
    // Env vars unset in beforeEach → every service is not-configured. Status
    // must NOT probe OSC in this case.
    for (const s of body) expect(s.state).toBe('not-configured');
    expect(getInstance).not.toHaveBeenCalled();
  });
});

describe('GET /api/v1/optional-services/:key', () => {
  it('returns not-configured (never throws) when the instance-name env var is unset', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/optional-services/auto-subtitles'
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { state: string; instanceName?: string };
    expect(body.state).toBe('not-configured');
    expect(body.instanceName).toBeUndefined();
    expect(getInstance).not.toHaveBeenCalled();
  });

  it('reports active + instance name + url when the env var is set and OSC has a live instance', async () => {
    process.env['AUTO_SUBTITLES_INSTANCE_NAME'] = 'subs1';
    getInstance.mockResolvedValue({
      name: 'subs1',
      url: 'https://subs1.example.osaas.io'
    });
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/optional-services/auto-subtitles'
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      state: string;
      instanceName?: string;
      url?: string;
    };
    expect(body.state).toBe('active');
    expect(body.instanceName).toBe('subs1');
    expect(body.url).toBe('https://subs1.example.osaas.io');
  });

  it('reports configured (not active) when the env var is set but no live instance exists', async () => {
    process.env['SCENE_DETECT_INSTANCE_NAME'] = 'scenes1';
    getInstance.mockResolvedValue(undefined);
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/optional-services/scene-detect'
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { state: string; instanceName?: string };
    expect(body.state).toBe('configured');
    expect(body.instanceName).toBe('scenes1');
  });

  it('returns configured (not throws) when the OSC lookup errors', async () => {
    process.env['AUTO_SUBTITLES_INSTANCE_NAME'] = 'subs1';
    getInstance.mockRejectedValue(new Error('OSC down'));
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/optional-services/auto-subtitles'
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { state: string }).state).toBe('configured');
  });

  it('returns 404 for an unknown key', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/optional-services/does-not-exist'
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('POST /api/v1/optional-services/:key/provision', () => {
  it('stores the openaikey as an OSC secret, references {{secrets.*}} in the body, and never echoes the secret', async () => {
    const SECRET = 'sk-super-secret-openai-key';
    createInstance.mockResolvedValue({
      name: 'subs1',
      url: 'https://subs1.example.osaas.io'
    });
    const { app, operationStore } = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/optional-services/auto-subtitles/provision',
      payload: { name: 'subs1', openaikey: SECRET }
    });
    expect(res.statusCode).toBe(202);
    const accepted = res.json() as { operationId: string; status: string };
    expect(accepted.status).toBe('pending');
    // The synchronous 202 envelope must not carry the secret.
    expect(res.body).not.toContain(SECRET);

    const op = await waitForOperation(operationStore, accepted.operationId);
    expect(op.status).toBe('done');

    // The secret was stored via saveSecret(serviceId, name, value, ctx).
    expect(saveSecret).toHaveBeenCalledWith(
      'eyevinn-auto-subtitles',
      'subs1.openaikey',
      SECRET,
      osc
    );

    // The createInstance body referenced {{secrets.*}}, NOT the raw secret.
    expect(createInstance).toHaveBeenCalledTimes(1);
    const createBody = createInstance.mock.calls[0]![3] as Record<string, unknown>;
    expect(createBody['name']).toBe('subs1');
    expect(createBody['openaikey']).toBe('{{secrets.subs1.openaikey}}');
    expect(JSON.stringify(createBody)).not.toContain(SECRET);

    // The operation result (polled by the caller) must not contain the secret.
    expect(JSON.stringify(op.result)).not.toContain(SECRET);
  });

  it('also stores awsSecretAccessKey as a secret when supplied', async () => {
    const AWS_SECRET = 'aws-secret-value';
    createInstance.mockResolvedValue({ name: 'subs2' });
    const { app, operationStore } = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/optional-services/auto-subtitles/provision',
      payload: {
        name: 'subs2',
        openaikey: 'sk-key',
        awsAccessKeyId: 'AKIA123',
        awsSecretAccessKey: AWS_SECRET,
        awsRegion: 'eu-north-1'
      }
    });
    const { operationId } = res.json() as { operationId: string };
    const op = await waitForOperation(operationStore, operationId);
    expect(op.status).toBe('done');

    const createBody = createInstance.mock.calls[0]![3] as Record<string, unknown>;
    // Non-secret pass-throughs are verbatim.
    expect(createBody['awsAccessKeyId']).toBe('AKIA123');
    expect(createBody['awsRegion']).toBe('eu-north-1');
    // Secret is referenced, not embedded.
    expect(createBody['awsSecretAccessKey']).toBe(
      '{{secrets.subs2.awsSecretAccessKey}}'
    );
    expect(JSON.stringify(createBody)).not.toContain(AWS_SECRET);
    expect(JSON.stringify(op.result)).not.toContain(AWS_SECRET);
  });

  it('provisions scene-detect (name only, no secret)', async () => {
    createInstance.mockResolvedValue({ name: 'scenes1' });
    const { app, operationStore } = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/optional-services/scene-detect/provision',
      payload: { name: 'scenes1' }
    });
    expect(res.statusCode).toBe(202);
    const { operationId } = res.json() as { operationId: string };
    const op = await waitForOperation(operationStore, operationId);
    expect(op.status).toBe('done');
    expect(saveSecret).not.toHaveBeenCalled();
    const createBody = createInstance.mock.calls[0]![3] as Record<string, unknown>;
    expect(createBody).toEqual({ name: 'scenes1' });
  });

  it('returns 400 when a required field (openaikey) is missing', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/optional-services/auto-subtitles/provision',
      payload: { name: 'subs1' }
    });
    expect(res.statusCode).toBe(400);
    // No OSC work should have started.
    expect(saveSecret).not.toHaveBeenCalled();
    expect(createInstance).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown key', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/optional-services/nope/provision',
      payload: { name: 'x', openaikey: 'k' }
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('DELETE /api/v1/optional-services/:key', () => {
  it('deprovisions the configured instance and returns an operationId (removed)', async () => {
    process.env['AUTO_SUBTITLES_INSTANCE_NAME'] = 'subs1';
    getInstance.mockResolvedValue({ name: 'subs1' });
    removeInstance.mockResolvedValue(undefined);
    const { app, operationStore } = await buildApp();

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/optional-services/auto-subtitles'
    });
    expect(res.statusCode).toBe(202);
    const { operationId, status } = res.json() as {
      operationId: string;
      status: string;
    };
    expect(status).toBe('pending');

    const op = await waitForOperation(operationStore, operationId);
    expect(op.status).toBe('done');
    expect((op.result as { status: string }).status).toBe('removed');
    expect(removeInstance).toHaveBeenCalledWith(
      osc,
      'eyevinn-auto-subtitles',
      'subs1',
      'test-sat'
    );
  });

  it('reports not_found (idempotent) when the instance is already gone', async () => {
    process.env['SCENE_DETECT_INSTANCE_NAME'] = 'scenes1';
    getInstance.mockResolvedValue(undefined);
    const { app, operationStore } = await buildApp();

    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/optional-services/scene-detect'
    });
    const { operationId } = res.json() as { operationId: string };
    const op = await waitForOperation(operationStore, operationId);
    expect(op.status).toBe('done');
    expect((op.result as { status: string }).status).toBe('not_found');
    expect(removeInstance).not.toHaveBeenCalled();
  });

  it('returns 400 (nothing to deprovision) when the env var is unset', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/optional-services/auto-subtitles'
    });
    expect(res.statusCode).toBe(400);
    expect(getInstance).not.toHaveBeenCalled();
    expect(removeInstance).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown key', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/optional-services/nope'
    });
    expect(res.statusCode).toBe(404);
  });
});
