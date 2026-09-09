// Router-layer authorisation enforcement — integration matrix (ADR-018
// decisions 1, 2, 4, 5; issue #554).
//
// Builds the assets + collections routers behind the SAME principal onRequest
// hook (registerPrincipal) the real app wires (src/main.ts), then drives the
// endpoints with the `X-OVC-Role` header set to each role and asserts the
// fail-closed 403 (with the stable AUTHZ_FORBIDDEN_ERROR reason code) exactly
// where the decision-1 matrix denies, and success elsewhere. Covers:
//   - role × action × resourceType across assets and collections (decision 1),
//   - the collection→asset NO-cascade (decision 4): adding an asset to a
//     collection does not change how that asset is authorised, and a viewer
//     denied on assets is denied identically on collections,
//   - fail-closed 403 on an unrecognised role header (decision 5),
//   - the trust-boundary header-stripping / off-OSC fallback: with the header
//     UNtrusted, a client-supplied role is stripped ⇒ admin default (decision 5),
//     and with a MISSING principal decoration the gate defaults to admin
//     (backwards compatible).
//
// In-memory repositories are backend-agnostic by construction (see
// test/collections.test.ts), so these role rules hold identically on CouchDB.

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { registerPrincipal, ROLE_HEADER } from '../src/auth/principal.js';
import { AUTHZ_FORBIDDEN_ERROR } from '../src/auth/authorize.js';
import { assetsRouter } from '../src/routes/assets.js';
import { collectionsRouter } from '../src/routes/collections.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryCollectionRepository } from '../src/data/inmemory-collection-repo.js';

type Role = 'viewer' | 'editor' | 'admin';

// Build an app with the principal hook wired (trust the header so the test can
// drive distinct roles), mirroring the real app. `trustRoleHeader` defaults true
// here; the trust-boundary tests below build a second app with it false.
async function buildApp(trustRoleHeader = true): Promise<{
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
}> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerPrincipal(app, { trustRoleHeader });
  const assets = new InMemoryAssetRepository();
  const collections = new InMemoryCollectionRepository();
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: assets });
  await app.register(collectionsRouter, {
    prefix: '/api/v1/collections',
    repository: collections,
    assetRepository: assets
  });
  await app.ready();
  return { app, assets };
}

function roleHeader(role?: string): Record<string, string> {
  return role === undefined ? {} : { [ROLE_HEADER]: role };
}

// Seed one asset + one collection as admin so read/delete cases have a target.
async function seed(app: FastifyInstance): Promise<{ assetId: string; collectionId: string }> {
  const a = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: roleHeader('admin'),
    payload: { name: 'seed-asset' }
  });
  expect(a.statusCode).toBe(201);
  const assetId = a.json()['id'] as string;

  const c = await app.inject({
    method: 'POST',
    url: '/api/v1/collections',
    headers: roleHeader('admin'),
    payload: { name: 'seed-collection' }
  });
  expect(c.statusCode).toBe(201);
  const collectionId = c.json()['id'] as string;

  return { assetId, collectionId };
}

describe('router-layer authorisation matrix — assets (ADR-018 decisions 1 & 2)', () => {
  let app: FastifyInstance;
  let assetId: string;
  beforeEach(async () => {
    ({ app } = await buildApp());
    ({ assetId } = await seed(app));
  });

  // Expected: viewer read-only; editor/admin full. write=POST create, delete=DELETE.
  const cases: Array<{ role: Role; read: boolean; write: boolean; del: boolean }> = [
    { role: 'viewer', read: true, write: false, del: false },
    { role: 'editor', read: true, write: true, del: true },
    { role: 'admin', read: true, write: true, del: true }
  ];

  for (const c of cases) {
    it(`${c.role}: GET list ⇒ ${c.read ? 'allow' : '403'}`, async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/assets', headers: roleHeader(c.role) });
      if (c.read) expect(res.statusCode).not.toBe(403);
      else {
        expect(res.statusCode).toBe(403);
        expect(res.json()['error']).toBe(AUTHZ_FORBIDDEN_ERROR);
      }
    });

    it(`${c.role}: POST create ⇒ ${c.write ? 'allow' : '403'}`, async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assets',
        headers: roleHeader(c.role),
        payload: { name: 'x' }
      });
      if (c.write) expect(res.statusCode).not.toBe(403);
      else {
        expect(res.statusCode).toBe(403);
        expect(res.json()['error']).toBe(AUTHZ_FORBIDDEN_ERROR);
        expect(res.json()['action']).toBe('write');
        expect(res.json()['resourceType']).toBe('asset');
      }
    });

    it(`${c.role}: DELETE ⇒ ${c.del ? 'allow' : '403'}`, async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/assets/${assetId}`,
        headers: roleHeader(c.role)
      });
      if (c.del) expect(res.statusCode).not.toBe(403);
      else {
        expect(res.statusCode).toBe(403);
        expect(res.json()['error']).toBe(AUTHZ_FORBIDDEN_ERROR);
        expect(res.json()['action']).toBe('delete');
      }
    });
  }
});

describe('router-layer authorisation matrix — collections (ADR-018 decisions 1 & 2)', () => {
  let app: FastifyInstance;
  let collectionId: string;
  beforeEach(async () => {
    ({ app } = await buildApp());
    ({ collectionId } = await seed(app));
  });

  const cases: Array<{ role: Role; read: boolean; write: boolean; del: boolean }> = [
    { role: 'viewer', read: true, write: false, del: false },
    { role: 'editor', read: true, write: true, del: true },
    { role: 'admin', read: true, write: true, del: true }
  ];

  for (const c of cases) {
    it(`${c.role}: GET list ⇒ ${c.read ? 'allow' : '403'}`, async () => {
      const res = await app.inject({ method: 'GET', url: '/api/v1/collections', headers: roleHeader(c.role) });
      if (c.read) expect(res.statusCode).not.toBe(403);
      else {
        expect(res.statusCode).toBe(403);
        expect(res.json()['error']).toBe(AUTHZ_FORBIDDEN_ERROR);
        expect(res.json()['resourceType']).toBe('collection');
      }
    });

    it(`${c.role}: POST create ⇒ ${c.write ? 'allow' : '403'}`, async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/collections',
        headers: roleHeader(c.role),
        payload: { name: 'x' }
      });
      if (c.write) expect(res.statusCode).not.toBe(403);
      else expect(res.statusCode).toBe(403);
    });

    it(`${c.role}: DELETE ⇒ ${c.del ? 'allow' : '403'}`, async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/collections/${collectionId}`,
        headers: roleHeader(c.role)
      });
      if (c.del) expect(res.statusCode).not.toBe(403);
      else expect(res.statusCode).toBe(403);
    });
  }
});

describe('no collection→asset cascade (ADR-018 decision 4)', () => {
  it('adding an asset to a collection does not widen viewer access to that asset', async () => {
    const { app } = await buildApp();
    const { assetId, collectionId } = await seed(app);

    // Admin adds the asset to the collection (write on collection).
    const add = await app.inject({
      method: 'PUT',
      url: `/api/v1/collections/${collectionId}/assets/${assetId}`,
      headers: roleHeader('admin')
    });
    expect(add.statusCode).toBe(200);

    // A viewer still cannot DELETE the asset — membership conferred nothing.
    const del = await app.inject({
      method: 'DELETE',
      url: `/api/v1/assets/${assetId}`,
      headers: roleHeader('viewer')
    });
    expect(del.statusCode).toBe(403);
    expect(del.json()['error']).toBe(AUTHZ_FORBIDDEN_ERROR);

    // And a viewer reading the asset THROUGH the collection is authorised by the
    // same `read` action as reading it directly — both allowed, neither special.
    const throughCollection = await app.inject({
      method: 'GET',
      url: `/api/v1/collections/${collectionId}`,
      headers: roleHeader('viewer')
    });
    expect(throughCollection.statusCode).not.toBe(403);
    const direct = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${assetId}`,
      headers: roleHeader('viewer')
    });
    expect(direct.statusCode).not.toBe(403);
  });

  it('a viewer is denied write on a collection exactly as on an asset (uniform role)', async () => {
    const { app } = await buildApp();
    const { assetId, collectionId } = await seed(app);
    const onAsset = await app.inject({
      method: 'PATCH',
      url: `/api/v1/assets/${assetId}`,
      headers: roleHeader('viewer'),
      payload: { tags: ['x'] }
    });
    const onCollection = await app.inject({
      method: 'PUT',
      url: `/api/v1/collections/${collectionId}/assets/${assetId}`,
      headers: roleHeader('viewer')
    });
    expect(onAsset.statusCode).toBe(403);
    expect(onCollection.statusCode).toBe(403);
  });
});

describe('fail-closed on unrecognised role (ADR-018 decision 5)', () => {
  it('unrecognised X-OVC-Role ⇒ 403 with stable reason, role null, on both routers', async () => {
    const { app } = await buildApp();
    const asset = await app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: roleHeader('superuser')
    });
    expect(asset.statusCode).toBe(403);
    expect(asset.json()['error']).toBe(AUTHZ_FORBIDDEN_ERROR);
    expect(asset.json()['role']).toBeNull();

    const collection = await app.inject({
      method: 'GET',
      url: '/api/v1/collections',
      headers: roleHeader('superuser')
    });
    expect(collection.statusCode).toBe(403);
    expect(collection.json()['error']).toBe(AUTHZ_FORBIDDEN_ERROR);
  });

  it('a read (GET) with an unrecognised role is ALSO denied (never silently downgraded)', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: roleHeader('READONLY') // not one of viewer/editor/admin
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('trust boundary + off-OSC fallback (ADR-018 decisions 1 & 5)', () => {
  it('absent header ⇒ admin default: full access, backwards compatible', async () => {
    const { app } = await buildApp();
    const create = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: {}, // no X-OVC-Role
      payload: { name: 'default-admin' }
    });
    expect(create.statusCode).toBe(201);
  });

  it('UNtrusted header ⇒ client-supplied role is stripped ⇒ admin default (spoof is a no-op)', async () => {
    // trustRoleHeader: false ⇒ the trust boundary strips any client X-OVC-Role.
    const { app } = await buildApp(false);
    // A client tries to DOWNGRADE to viewer to... it does not matter: stripping
    // means the effective role is admin, so a would-be viewer-only caller still
    // gets admin (today's authenticated-⇒-full-access). Conversely a client
    // cannot ESCALATE either — there is nothing above admin. The point: the
    // header is not honoured at all when untrusted.
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: roleHeader('viewer'),
      payload: { name: 'stripped' }
    });
    // viewer would be 403 on write; stripped-to-admin is 201.
    expect(res.statusCode).toBe(201);
  });

  it('missing principal decoration ⇒ gate defaults to admin (backwards compatible)', async () => {
    // App WITHOUT registerPrincipal: request.principal is undefined. The gate
    // treats this as the single-operator default (admin), not a 403, so a
    // deployment that has not wired the resolver behaves exactly as before.
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const assets = new InMemoryAssetRepository();
    await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: assets });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: {},
      payload: { name: 'no-principal' }
    });
    expect(res.statusCode).toBe(201);
  });
});
