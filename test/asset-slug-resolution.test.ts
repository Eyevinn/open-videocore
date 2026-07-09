// Slug resolution for /:id routes (issue #132, sub-task of #112).
//
// Two layers under test:
//   1. Repository: getBySlug() resolves an asset by its human-readable slug and
//      is workspace-scoped (each InMemoryAssetRepository instance is one tenant's
//      isolated store, mirroring the CouchDB per-tenant database in production).
//   2. Route: GET /api/v1/assets/:id accepts BOTH the ULID id and the slug, and
//      the serialized asset exposes `slug`. 404 is preserved when neither matches.
//
// The in-memory repo shares the slug-generation and lookup logic with the
// CouchDB repo by construction (both call generateUniqueSlug / query the same
// top-level slug mirror), so the domain behaviour under test is backend-agnostic.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      const map: Record<string, string> = { 'token-a': 'workspace-a', 'token-b': 'workspace-b' };
      const ws = token ? map[token] : undefined;
      if (!ws) throw new actual.AuthError('invalid token');
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository, isUlid } from '../src/data/asset-repo.js';

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: new InMemoryAssetRepository()
  });
  await app.ready();
  return app;
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

describe('repository slug lookup (issue #132)', () => {
  it('resolves an asset by its slug', async () => {
    const repo = new InMemoryAssetRepository();
    const created = await repo.create({ name: 'clip', slug: 'my-clip' });
    const found = await repo.getBySlug('my-clip');
    expect(found).toBeDefined();
    expect(found?.id).toBe(created.id);
    expect(found?.slug).toBe('my-clip');
  });

  it('returns undefined for an unknown slug', async () => {
    const repo = new InMemoryAssetRepository();
    await repo.create({ name: 'clip', slug: 'my-clip' });
    expect(await repo.getBySlug('does-not-exist')).toBeUndefined();
  });

  it('is workspace-scoped: a slug in one store is invisible to another', async () => {
    // Distinct repositories model distinct (structurally isolated) tenants.
    const tenantA = new InMemoryAssetRepository();
    const tenantB = new InMemoryAssetRepository();
    const a = await tenantA.create({ name: 'clip', slug: 'shared-slug' });
    await tenantB.create({ name: 'other', slug: 'shared-slug' });

    const fromA = await tenantA.getBySlug('shared-slug');
    expect(fromA?.id).toBe(a.id);
    // Tenant B has its OWN asset under the same slug — not tenant A's.
    const fromB = await tenantB.getBySlug('shared-slug');
    expect(fromB?.id).not.toBe(a.id);
  });
});

describe('isUlid helper (issue #132)', () => {
  it('accepts a minted ULID and rejects a slug', async () => {
    const repo = new InMemoryAssetRepository();
    const created = await repo.create({ name: 'clip', slug: 'brave-river-042' });
    expect(created.id).toMatch(ULID_RE);
    expect(isUlid(created.id)).toBe(true);
    expect(isUlid('brave-river-042')).toBe(false);
    // Wrong length / lowercase / hyphenated values are not ULIDs.
    expect(isUlid('nope')).toBe(false);
    expect(isUlid(created.id.toLowerCase())).toBe(false);
  });
});

describe('GET /api/v1/assets/:id by ULID and slug (issue #132)', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  async function createAsset(payload: Record<string, unknown>) {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: A,
      payload
    });
    return res.json() as Record<string, unknown>;
  }

  it('resolves by ULID id and exposes slug in the response', async () => {
    const created = await createAsset({ name: 'clip', slug: 'my-clip' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${created['id']}`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(created['id']);
    expect(res.json().slug).toBe('my-clip');
  });

  it('resolves the same asset by its slug', async () => {
    const created = await createAsset({ name: 'clip', slug: 'my-clip' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/my-clip`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(created['id']);
    expect(res.json().slug).toBe('my-clip');
  });

  it('404s for an unknown id that is neither a ULID nor a known slug', async () => {
    await createAsset({ name: 'clip', slug: 'my-clip' });
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/unknown-slug',
      headers: A
    });
    expect(res.statusCode).toBe(404);
  });

  it('404s for a ULID-shaped id that does not exist', async () => {
    await createAsset({ name: 'clip' });
    const res = await app.inject({
      method: 'GET',
      // A well-formed but non-existent ULID.
      url: '/api/v1/assets/00000000000000000000000000',
      headers: A
    });
    expect(res.statusCode).toBe(404);
  });
});
