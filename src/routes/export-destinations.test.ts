// Tests for the named export-destinations CRUD surface (issue #572, ADR-018):
// POST/GET/DELETE /api/v1/export-destinations.
//
// ADR-018 D1: a named export destination is a registered storage backend viewed
// in the OUTPUT role. This router is a thin VIEW over the SAME
// StorageBackendRegistry the /storage/backends surface uses, so these tests build
// exportDestinationsRouter over a real StorageBackendRegistry backed by an
// InMemoryBackendRecordStore + a spy SecretStore (mirroring storage.backends.test.ts).
//
// Covers the acceptance criteria (issue #572 "Done when"):
//   - a named destination can be created, listed, fetched by stable id, deleted;
//   - credentials are write-only: the raw secret is NEVER echoed on any response;
//   - the secret is fanned out to OSC per-serviceId secrets (never the record);
//   - source/archive-role backends are NOT surfaced as destinations (output-only);
//   - the OSC-managed default (output role) appears and is non-deletable (409);
//   - no registry wired -> 501.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { exportDestinationsRouter } from './export-destinations.js';
import {
  StorageBackendRegistry,
  InMemoryBackendRecordStore,
  DEFAULT_BACKEND_ID,
  REDACTED,
  type SecretStore
} from '../services/storage-backend-registry.js';

const RAW_SECRET = 'super-secret-access-key-value';
const RAW_TOKEN = 'super-secret-session-token';

let saveSecret: ReturnType<typeof vi.fn>;

function makeSecretStore(): SecretStore {
  return { saveSecret: saveSecret as unknown as SecretStore['saveSecret'] };
}

function makeRegistry(secrets?: SecretStore): StorageBackendRegistry {
  // No validate config -> no registration-time probe (ADR-018 D3); keeps tests
  // free of network I/O.
  return new StorageBackendRegistry(new InMemoryBackendRecordStore(), secrets);
}

async function buildApp(registry?: StorageBackendRegistry) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(exportDestinationsRouter, {
    prefix: '/api/v1/export-destinations',
    ...(registry ? { storageBackendRegistry: registry } : {})
  });
  await app.ready();
  return app;
}

type DestinationView = {
  id: string;
  name: string;
  role: string;
  bucket: string;
  accessKeyId: string;
  deletable: boolean;
  hasSessionToken: boolean;
  credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
};

const VALID_BODY = {
  name: 'delivery-cdn-origin',
  role: 'packaged',
  bucket: 'delivery-bucket',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: RAW_SECRET,
  region: 'us-east-1',
  endpointUrl: 'https://s3.example.com',
  publicBaseUrl: 'https://cdn.example.com'
};

beforeEach(() => {
  saveSecret = vi.fn(async () => {});
});

describe('POST /api/v1/export-destinations — register', () => {
  it('registers a destination and redacts the secret (never the raw value)', async () => {
    const app = await buildApp(makeRegistry(makeSecretStore()));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/export-destinations',
      payload: VALID_BODY
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as DestinationView;
    expect(body).toMatchObject({
      name: 'delivery-cdn-origin',
      role: 'packaged',
      bucket: 'delivery-bucket',
      accessKeyId: 'AKIAEXAMPLE',
      deletable: true
    });
    expect(body.credentials.secretAccessKey).toBe(REDACTED);
    expect(JSON.stringify(body)).not.toContain(RAW_SECRET);
    await app.close();
  });

  it('fans the secret out to OSC per-serviceId secrets, never into the response', async () => {
    const app = await buildApp(makeRegistry(makeSecretStore()));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/export-destinations',
      payload: { ...VALID_BODY, sessionToken: RAW_TOKEN }
    });
    expect(res.statusCode).toBe(201);
    // The raw secret + token reached the secret store, never the record/response.
    const savedValues = saveSecret.mock.calls.map((c) => c[2]);
    expect(savedValues).toContain(RAW_SECRET);
    expect(savedValues).toContain(RAW_TOKEN);
    expect(JSON.stringify(res.json())).not.toContain(RAW_SECRET);
    expect(JSON.stringify(res.json())).not.toContain(RAW_TOKEN);
    await app.close();
  });

  it('defaults role to packaged when omitted', async () => {
    const app = await buildApp(makeRegistry(makeSecretStore()));
    const { role, ...noRole } = VALID_BODY;
    void role;
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/export-destinations',
      payload: noRole
    });
    expect(res.statusCode).toBe(201);
    expect((res.json() as DestinationView).role).toBe('packaged');
    await app.close();
  });

  it('rejects a source-only role via this surface (400)', async () => {
    const app = await buildApp(makeRegistry(makeSecretStore()));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/export-destinations',
      payload: { ...VALID_BODY, role: 'source' }
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 501 when no registry is wired', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/export-destinations',
      payload: VALID_BODY
    });
    expect(res.statusCode).toBe(501);
    await app.close();
  });

  it('returns 501 when the registry cannot store secrets', async () => {
    const app = await buildApp(makeRegistry()); // no SecretStore
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/export-destinations',
      payload: VALID_BODY
    });
    expect(res.statusCode).toBe(501);
    await app.close();
  });
});

describe('GET /api/v1/export-destinations — list', () => {
  it('lists registered output-role destinations plus the non-deletable default', async () => {
    const registry = makeRegistry(makeSecretStore());
    const app = await buildApp(registry);
    await app.inject({ method: 'POST', url: '/api/v1/export-destinations', payload: VALID_BODY });

    const res = await app.inject({ method: 'GET', url: '/api/v1/export-destinations' });
    expect(res.statusCode).toBe(200);
    const { destinations } = res.json() as { destinations: DestinationView[] };
    // The implicit OSC-managed default (role 'both') is an output destination.
    const def = destinations.find((d) => d.id === DEFAULT_BACKEND_ID);
    expect(def).toBeTruthy();
    expect(def?.deletable).toBe(false);
    // The registered packaged destination appears, secret redacted.
    const mine = destinations.find((d) => d.name === 'delivery-cdn-origin');
    expect(mine?.role).toBe('packaged');
    expect(JSON.stringify(destinations)).not.toContain(RAW_SECRET);
    await app.close();
  });

  it('excludes source/archive-role backends from the destinations view', async () => {
    // Register a source and an archive backend DIRECTLY through the shared
    // registry (the /storage/backends path). Neither is a delivery destination,
    // so neither should appear in the export-destinations list.
    const registry = makeRegistry(makeSecretStore());
    await registry.register('default', {
      name: 'ingest-source',
      role: 'source',
      bucket: 'src-bucket',
      accessKeyId: 'AK',
      secretAccessKey: RAW_SECRET
    });
    await registry.register('default', {
      name: 'cold-archive',
      role: 'archive',
      bucket: 'arc-bucket',
      accessKeyId: 'AK',
      secretAccessKey: RAW_SECRET
    });
    const app = await buildApp(registry);
    const res = await app.inject({ method: 'GET', url: '/api/v1/export-destinations' });
    const { destinations } = res.json() as { destinations: DestinationView[] };
    expect(destinations.some((d) => d.name === 'ingest-source')).toBe(false);
    expect(destinations.some((d) => d.name === 'cold-archive')).toBe(false);
    await app.close();
  });

  it('returns 501 when no registry is wired', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/export-destinations' });
    expect(res.statusCode).toBe(501);
    await app.close();
  });
});

describe('GET /api/v1/export-destinations/:id — resolve by stable id', () => {
  it('resolves a registered destination by its id', async () => {
    const registry = makeRegistry(makeSecretStore());
    const app = await buildApp(registry);
    const created = (
      await app.inject({ method: 'POST', url: '/api/v1/export-destinations', payload: VALID_BODY })
    ).json() as DestinationView;

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/export-destinations/${created.id}`
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as DestinationView;
    expect(body.id).toBe(created.id);
    expect(body.name).toBe('delivery-cdn-origin');
    expect(body.credentials.secretAccessKey).toBe(REDACTED);
    await app.close();
  });

  it('resolves the OSC-managed default by id', async () => {
    const app = await buildApp(makeRegistry(makeSecretStore()));
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/export-destinations/${DEFAULT_BACKEND_ID}`
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as DestinationView).id).toBe(DEFAULT_BACKEND_ID);
    await app.close();
  });

  it('returns 404 for an unknown id', async () => {
    const app = await buildApp(makeRegistry(makeSecretStore()));
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/export-destinations/does-not-exist'
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('returns 404 for a non-output-role backend id (not a destination)', async () => {
    const registry = makeRegistry(makeSecretStore());
    const source = await registry.register('default', {
      name: 'ingest-source',
      role: 'source',
      bucket: 'src-bucket',
      accessKeyId: 'AK',
      secretAccessKey: RAW_SECRET
    });
    const app = await buildApp(registry);
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/export-destinations/${source.id}`
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('DELETE /api/v1/export-destinations/:id — remove', () => {
  it('removes a registered destination (204) and it no longer lists', async () => {
    const registry = makeRegistry(makeSecretStore());
    const app = await buildApp(registry);
    const created = (
      await app.inject({ method: 'POST', url: '/api/v1/export-destinations', payload: VALID_BODY })
    ).json() as DestinationView;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/export-destinations/${created.id}`
    });
    expect(del.statusCode).toBe(204);

    const list = await app.inject({ method: 'GET', url: '/api/v1/export-destinations' });
    const { destinations } = list.json() as { destinations: DestinationView[] };
    expect(destinations.some((d) => d.id === created.id)).toBe(false);
    await app.close();
  });

  it('is idempotent for an unknown id (204)', async () => {
    const app = await buildApp(makeRegistry(makeSecretStore()));
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/export-destinations/does-not-exist'
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });

  it('refuses to delete the OSC-managed default (409)', async () => {
    const app = await buildApp(makeRegistry(makeSecretStore()));
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/export-destinations/${DEFAULT_BACKEND_ID}`
    });
    expect(res.statusCode).toBe(409);
    await app.close();
  });

  it('returns 501 when no registry is wired', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/export-destinations/whatever'
    });
    expect(res.statusCode).toBe(501);
    await app.close();
  });
});
