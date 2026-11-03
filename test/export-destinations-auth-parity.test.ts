// Issue #1282: two routes that surface the SAME storage records disagreed on
// authentication. `GET`/`POST /api/v1/export-destinations` answered anonymously
// while `GET /api/v1/storage/backends` — the other view of the identical
// StorageBackendRegistry records — correctly refused with
// `401 {"error":"unauthorized","message":"missing access token"}`.
//
// exportDestinationsRouter now attaches the shared 401 presence gate `authGate`
// (src/auth/middleware.ts) as its first preHandler, the same hook storageRouter
// attaches (src/routes/storage.ts). These cases pin the parity: both surfaces
// are driven through ONE app with registerAuth wired, anonymously and with a
// bearer token, and their gate behaviour is asserted to match.

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { registerAuth } from '../src/auth/middleware.js';
import { exportDestinationsRouter } from '../src/routes/export-destinations.js';
import { storageRouter } from '../src/routes/storage.js';
import {
  StorageBackendRegistry,
  InMemoryBackendRecordStore,
  REDACTED,
  type SecretStore
} from '../src/services/storage-backend-registry.js';
import type { WorkspaceStackResolver } from '../src/services/workspace-stack.js';

// Neither surface's /backends or /export-destinations routes resolve a stack, so
// a resolver that throws if touched keeps the harness honest.
const stackResolverStub = {
  resolve: () => {
    throw new Error('stackResolver.resolve must not be called by these routes');
  }
} as unknown as WorkspaceStackResolver;

const RAW_SECRET = 'super-secret-access-key-value';

const VALID_BODY = {
  name: 'parity-delivery-origin',
  role: 'packaged' as const,
  bucket: 'delivery-bucket',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: RAW_SECRET,
  region: 'eu-north-1',
  endpointUrl: 'https://s3.example.com'
};

const secretStore: SecretStore = {
  saveSecret: (async () => {}) as unknown as SecretStore['saveSecret']
};

// One registry instance behind BOTH routers, mirroring src/main.ts (the same
// `storageBackendRegistry` is passed to storageRouter and
// exportDestinationsRouter), so the two surfaces really are two views of one set
// of records.
async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const registry = new StorageBackendRegistry(new InMemoryBackendRecordStore(), secretStore);
  await app.register(storageRouter, {
    prefix: '/api/v1/storage',
    stackResolver: stackResolverStub,
    storageBackendRegistry: registry
  });
  await app.register(exportDestinationsRouter, {
    prefix: '/api/v1/export-destinations',
    storageBackendRegistry: registry
  });
  await app.ready();
  return app;
}

const UNAUTHORIZED = { error: 'unauthorized', message: 'missing access token' };
const TOKEN = { authorization: 'Bearer parity-test-token' };

describe('export-destinations / storage-backends auth parity (issue #1282)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  it('refuses an anonymous GET /api/v1/export-destinations with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/export-destinations' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject(UNAUTHORIZED);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    await app.close();
  });

  it('refuses an anonymous POST /api/v1/export-destinations with 401 and registers nothing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/export-destinations',
      payload: VALID_BODY
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject(UNAUTHORIZED);

    // The rejected registration must not have reached the registry.
    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/export-destinations',
      headers: TOKEN
    });
    expect(listed.statusCode).toBe(200);
    const names = (listed.json().destinations as Array<{ name: string }>).map((d) => d.name);
    expect(names).not.toContain(VALID_BODY.name);
    await app.close();
  });

  it('refuses an anonymous GET /api/v1/export-destinations/:id with 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/export-destinations/default' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject(UNAUTHORIZED);
    await app.close();
  });

  it('refuses an anonymous DELETE /api/v1/export-destinations/:id with 401', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/v1/export-destinations/default' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject(UNAUTHORIZED);
    await app.close();
  });

  it('answers the export-destinations routes exactly as before when a bearer token is sent', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/export-destinations',
      headers: TOKEN,
      payload: VALID_BODY
    });
    expect(created.statusCode).toBe(201);
    const view = created.json() as {
      id: string;
      name: string;
      credentials: { secretAccessKey: string };
    };
    expect(view.name).toBe(VALID_BODY.name);
    // The gate does not change the redaction contract (ADR-018 D1).
    expect(view.credentials.secretAccessKey).toBe(REDACTED);
    expect(created.payload).not.toContain(RAW_SECRET);

    const listed = await app.inject({
      method: 'GET',
      url: '/api/v1/export-destinations',
      headers: TOKEN
    });
    expect(listed.statusCode).toBe(200);
    expect(
      (listed.json().destinations as Array<{ id: string }>).some((d) => d.id === view.id)
    ).toBe(true);

    const fetched = await app.inject({
      method: 'GET',
      url: `/api/v1/export-destinations/${view.id}`,
      headers: TOKEN
    });
    expect(fetched.statusCode).toBe(200);
    expect((fetched.json() as { id: string }).id).toBe(view.id);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/v1/export-destinations/${view.id}`,
      headers: TOKEN
    });
    expect(removed.statusCode).toBe(204);
    await app.close();
  });

  it('applies the identical gate to both views of the same storage records', async () => {
    // Anonymous: both surfaces reject with the same envelope.
    const anonDestinations = await app.inject({
      method: 'GET',
      url: '/api/v1/export-destinations'
    });
    const anonBackends = await app.inject({ method: 'GET', url: '/api/v1/storage/backends' });
    expect(anonDestinations.statusCode).toBe(anonBackends.statusCode);
    expect(anonDestinations.statusCode).toBe(401);
    expect(anonDestinations.json()).toMatchObject(anonBackends.json());

    // Authenticated: both surfaces serve the records.
    const authDestinations = await app.inject({
      method: 'GET',
      url: '/api/v1/export-destinations',
      headers: TOKEN
    });
    const authBackends = await app.inject({
      method: 'GET',
      url: '/api/v1/storage/backends',
      headers: TOKEN
    });
    expect(authDestinations.statusCode).toBe(200);
    expect(authBackends.statusCode).toBe(200);
    await app.close();
  });

  it('rejects a malformed Authorization value on export-destinations with 401', async () => {
    for (const value of ['', 'parity-test-token', 'Basic parity-test-token', 'Bearer']) {
      const res = await app.inject({
        method: 'GET',
        url: '/api/v1/export-destinations',
        headers: { authorization: value }
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject(UNAUTHORIZED);
    }
    await app.close();
  });

  it('admits export-destinations traffic carrying only x-jwt: Bearer <token> (issue #1256 parity)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/export-destinations',
      headers: { 'x-jwt': 'Bearer platform-token' }
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
