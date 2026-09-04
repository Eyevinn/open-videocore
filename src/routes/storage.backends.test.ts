// Tests for the external storage-backend registration surface (issue #547,
// ADR-017): POST/GET/DELETE /api/v1/storage/backends.
//
// Builds the storageRouter over a real StorageBackendRegistry backed by an
// InMemoryBackendRecordStore and a spy SecretStore, exactly as logs.test.ts
// builds logsRouter over a real LogStore and drives it with app.inject().
//
// Covers the acceptance criteria:
//   - a backend can be registered, listed (secret redacted), and removed;
//   - the raw secret is NEVER echoed on register or list;
//   - the secret is fanned out to OSC per-serviceId secrets (never the record);
//   - the OSC-managed default backend cannot be deleted (409) and always appears.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';
import { storageRouter } from './storage.js';
import {
  StorageBackendRegistry,
  InMemoryBackendRecordStore,
  DEFAULT_BACKEND_ID,
  REDACTED,
  type SecretStore
} from '../services/storage-backend-registry.js';
import type { WorkspaceStackResolver } from '../services/workspace-stack.js';

// The router only ever calls stackResolver on the /buckets routes, never on the
// /backends routes — a stub that throws if touched keeps the test honest.
const stackResolverStub = {
  resolve: () => {
    throw new Error('stackResolver.resolve must not be called by /backends routes');
  }
} as unknown as WorkspaceStackResolver;

// A raw secret value that MUST NOT appear anywhere in an API response.
const RAW_SECRET = 'super-secret-access-key-value';
const RAW_TOKEN = 'super-secret-session-token';

let saveSecret: ReturnType<typeof vi.fn>;

function makeSecretStore(): SecretStore {
  return { saveSecret: saveSecret as unknown as SecretStore['saveSecret'] };
}

async function buildApp(registry?: StorageBackendRegistry) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(storageRouter, {
    prefix: '/api/v1/storage',
    stackResolver: stackResolverStub,
    ...(registry ? { storageBackendRegistry: registry } : {})
  });
  await app.ready();
  return app;
}

function makeRegistry(secrets?: SecretStore): StorageBackendRegistry {
  return new StorageBackendRegistry(new InMemoryBackendRecordStore(), secrets);
}

type BackendView = {
  id: string;
  name: string;
  role: string;
  bucket: string;
  accessKeyId: string;
  deletable: boolean;
  hasSessionToken: boolean;
  credentials: {
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string;
  };
};

const VALID_BODY = {
  name: 'my-external-bucket',
  role: 'source',
  bucket: 'external-source',
  accessKeyId: 'AKIAEXAMPLE',
  secretAccessKey: RAW_SECRET,
  region: 'us-east-1',
  endpointUrl: 'https://s3.example.com'
};

beforeEach(() => {
  saveSecret = vi.fn(async () => {});
});

describe('POST /api/v1/storage/backends — register', () => {
  it('registers a backend and returns the secret REDACTED (never the raw value)', async () => {
    const app = await buildApp(makeRegistry(makeSecretStore()));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/storage/backends',
      payload: VALID_BODY
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as BackendView;

    // The record fields are echoed…
    expect(body).toMatchObject({
      name: 'my-external-bucket',
      role: 'source',
      backend: 'external',
      bucket: 'external-source',
      accessKeyId: 'AKIAEXAMPLE',
      deletable: true
    });
    // …but the secret is redacted, and the RAW secret never appears anywhere.
    expect(body.credentials.secretAccessKey).toBe(REDACTED);
    expect(JSON.stringify(body)).not.toContain(RAW_SECRET);

    await app.close();
  });

  it('fans the raw secret out to OSC per-serviceId secrets, never into the response', async () => {
    const app = await buildApp(makeRegistry(makeSecretStore()));
    await app.inject({
      method: 'POST',
      url: '/api/v1/storage/backends',
      payload: { ...VALID_BODY, sessionToken: RAW_TOKEN }
    });

    // The secret + token reached saveSecret (the OSC per-serviceId sink,
    // ADR-017 D1) with the literal values — that is the ONLY place they go.
    const savedValues = saveSecret.mock.calls.map((c) => c[2]);
    expect(savedValues).toContain(RAW_SECRET);
    expect(savedValues).toContain(RAW_TOKEN);
    // Source role fans to encore + eyevinn-ffmpeg-s3 (2 services), each getting
    // the secret access key + the session token = 4 saveSecret calls.
    const serviceIds = new Set(saveSecret.mock.calls.map((c) => c[0]));
    expect(serviceIds).toContain('encore');
    expect(serviceIds).toContain('eyevinn-ffmpeg-s3');

    await app.close();
  });

  it('responds 501 when no registry is configured', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/storage/backends',
      payload: VALID_BODY
    });
    expect(res.statusCode).toBe(501);
    await app.close();
  });

  it('responds 501 when the registry cannot store secrets (no SecretStore)', async () => {
    // A registry with no SecretStore cannot honour the ADR-017 credential
    // contract — it must refuse rather than drop the access key + secret.
    const app = await buildApp(makeRegistry(undefined));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/storage/backends',
      payload: VALID_BODY
    });
    expect(res.statusCode).toBe(501);
    expect(saveSecret).not.toHaveBeenCalled();
    await app.close();
  });

  it('rejects a body missing the required credentials', async () => {
    const app = await buildApp(makeRegistry(makeSecretStore()));
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/storage/backends',
      payload: { name: 'x', bucket: 'b' } // no accessKeyId / secretAccessKey
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('GET /api/v1/storage/backends — list (redacted)', () => {
  it('register -> list shows the backend with its secret redacted (never raw)', async () => {
    const registry = makeRegistry(makeSecretStore());
    const app = await buildApp(registry);

    await app.inject({
      method: 'POST',
      url: '/api/v1/storage/backends',
      payload: VALID_BODY
    });

    const res = await app.inject({ method: 'GET', url: '/api/v1/storage/backends' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { backends: BackendView[] };

    // The raw secret must appear NOWHERE in the listing.
    expect(JSON.stringify(body)).not.toContain(RAW_SECRET);

    const registered = body.backends.find((b) => b.name === 'my-external-bucket');
    expect(registered).toBeDefined();
    expect(registered!.credentials.secretAccessKey).toBe(REDACTED);
    // The non-secret access key id is echoed so the operator can identify it.
    expect(registered!.credentials.accessKeyId).toBe('AKIAEXAMPLE');

    await app.close();
  });

  it('always includes the implicit OSC-managed default, marked non-deletable', async () => {
    const app = await buildApp(makeRegistry(makeSecretStore()));
    const res = await app.inject({ method: 'GET', url: '/api/v1/storage/backends' });
    const body = res.json() as { backends: BackendView[] };
    const def = body.backends.find((b) => b.id === DEFAULT_BACKEND_ID);
    expect(def).toBeDefined();
    expect(def!.deletable).toBe(false);
    await app.close();
  });

  it('responds 501 when no registry is configured', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/v1/storage/backends' });
    expect(res.statusCode).toBe(501);
    await app.close();
  });
});

describe('DELETE /api/v1/storage/backends/:id — remove', () => {
  it('removes a registered backend so it no longer appears in the listing', async () => {
    const registry = makeRegistry(makeSecretStore());
    const app = await buildApp(registry);

    const created = (
      await app.inject({
        method: 'POST',
        url: '/api/v1/storage/backends',
        payload: VALID_BODY
      })
    ).json() as BackendView;

    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/storage/backends/${created.id}`
    });
    expect(del.statusCode).toBe(204);

    const listed = (
      await app.inject({ method: 'GET', url: '/api/v1/storage/backends' })
    ).json() as { backends: BackendView[] };
    expect(listed.backends.find((b) => b.id === created.id)).toBeUndefined();

    await app.close();
  });

  it('refuses to delete the OSC-managed default backend (409)', async () => {
    const app = await buildApp(makeRegistry(makeSecretStore()));
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/storage/backends/${DEFAULT_BACKEND_ID}`
    });
    expect(res.statusCode).toBe(409);

    // …and the default still appears in the listing afterwards.
    const listed = (
      await app.inject({ method: 'GET', url: '/api/v1/storage/backends' })
    ).json() as { backends: BackendView[] };
    expect(listed.backends.find((b) => b.id === DEFAULT_BACKEND_ID)).toBeDefined();

    await app.close();
  });

  it('is an idempotent no-op for an unknown id (204)', async () => {
    const app = await buildApp(makeRegistry(makeSecretStore()));
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/v1/storage/backends/does-not-exist'
    });
    expect(res.statusCode).toBe(204);
    await app.close();
  });
});
