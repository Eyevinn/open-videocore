// Route contract for POST /:id/external-ids (issue #577, ADR-019), exercised
// end to end against the assets router with the in-memory backend.
//
// Contract under test (src/routes/assets.ts):
//   - POST '/:id/external-ids' (assets.ts:2599-2635):
//       * 200 with the updated asset on a successful attach;
//       * 404 `{ error: 'not_found' }` when the asset id is unknown
//         (assets.ts:2630-2632);
//       * enforceUniqueness is read PER REQUEST from EXTERNAL_ID_UNIQUENESS via
//         externalIdUniquenessEnforced() (assets.ts:2628).
//   - Body validation: namespace min 1/max 256, id min 1/max 1024 -> 400 on an
//     empty or oversized component (attachExternalIdBodySchema, assets.ts:429-446).
//   - 409 conflict envelope (assets.ts:2133-2141): the REAL field names are
//     `error`, `message`, `reason` (both literal `external_id_conflict`),
//     `namespace`, `externalId`, `conflictingAssetId`. birme's shorthand of
//     `error`/`reason`/`conflictingAssetId` maps onto these actual fields.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetsRouter } from './assets.js';
import { InMemoryAssetRepository, type Asset } from '../data/asset-repo.js';
import { InMemoryJobRepository } from '../data/job-repo.js';
import { EXTERNAL_ID_UNIQUENESS_ENV } from '../data/external-id-uniqueness.js';

async function buildApp(repo: InMemoryAssetRepository) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    jobRepository: new InMemoryJobRepository()
  });
  await app.ready();
  return app;
}

// The route reads the mode from process.env at request time (12-factor), so the
// env var is restored around every test to keep the advisory default elsewhere.
let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env[EXTERNAL_ID_UNIQUENESS_ENV];
  delete process.env[EXTERNAL_ID_UNIQUENESS_ENV];
});
afterEach(() => {
  if (savedEnv === undefined) {
    delete process.env[EXTERNAL_ID_UNIQUENESS_ENV];
  } else {
    process.env[EXTERNAL_ID_UNIQUENESS_ENV] = savedEnv;
  }
});

describe('POST /api/v1/assets/:id/external-ids (issue #577)', () => {
  it('200: attaches an external id and persists it on the asset', async () => {
    const repo = new InMemoryAssetRepository();
    const asset: Asset = await repo.create({ name: 'src' });
    const app = await buildApp(repo);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/external-ids`,
      payload: { namespace: 'ingest-mam', id: 'X-1' }
    });
    expect(res.statusCode).toBe(200);
    // The 200 body is the asset serialized through `assetSchema` (assets.ts:2614),
    // which returns the same asset id. NOTE: `assetSchema` (assets.ts:724-800)
    // does NOT declare `externalIdentifiers`, so the fastify-zod serializer STRIPS
    // it from the HTTP response envelope — the field is not observable on the 200
    // body. The attach itself is verified against the repository below.
    expect((res.json() as Asset).id).toBe(asset.id);
    expect((await repo.get(asset.id))?.externalIdentifiers).toContainEqual({
      namespace: 'ingest-mam',
      id: 'X-1'
    });
  });

  it('404: unknown asset id returns not_found', async () => {
    const repo = new InMemoryAssetRepository();
    const app = await buildApp(repo);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/does-not-exist/external-ids`,
      payload: { namespace: 'ingest-mam', id: 'X-1' }
    });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: 'not_found' });
  });

  it('400: empty namespace component is rejected at the boundary', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'src' });
    const app = await buildApp(repo);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/external-ids`,
      payload: { namespace: '', id: 'X-1' }
    });
    expect(res.statusCode).toBe(400);
  });

  it('400: oversized id component (> 1024 chars) is rejected', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'src' });
    const app = await buildApp(repo);

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/external-ids`,
      payload: { namespace: 'ns', id: 'x'.repeat(1025) }
    });
    expect(res.statusCode).toBe(400);
  });

  it('enforced mode: duplicate pair on a different asset returns the 409 conflict envelope', async () => {
    process.env[EXTERNAL_ID_UNIQUENESS_ENV] = 'enforced';
    const repo = new InMemoryAssetRepository();
    const a = await repo.create({ name: 'asset-a' });
    const b = await repo.create({ name: 'asset-b' });
    const app = await buildApp(repo);

    // a claims the pair first.
    const first = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${a.id}/external-ids`,
      payload: { namespace: 'ingest-mam', id: 'X-1' }
    });
    expect(first.statusCode).toBe(200);

    // b attempts the same pair -> 409 with the machine-readable envelope.
    const conflict = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${b.id}/external-ids`,
      payload: { namespace: 'ingest-mam', id: 'X-1' }
    });
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json()).toEqual({
      error: 'external_id_conflict',
      message: expect.any(String),
      reason: 'external_id_conflict',
      namespace: 'ingest-mam',
      externalId: 'X-1',
      conflictingAssetId: a.id
    });
  });

  it('advisory default (env unset): duplicate pair on a different asset is allowed (200, no 409)', async () => {
    // Env deleted in beforeEach -> advisory. This proves the same request that
    // 409s under enforcement succeeds under the backward-compatible default.
    const repo = new InMemoryAssetRepository();
    const a = await repo.create({ name: 'asset-a' });
    const b = await repo.create({ name: 'asset-b' });
    const app = await buildApp(repo);

    await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${a.id}/external-ids`,
      payload: { namespace: 'ingest-mam', id: 'X-1' }
    });
    const dup = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${b.id}/external-ids`,
      payload: { namespace: 'ingest-mam', id: 'X-1' }
    });
    expect(dup.statusCode).toBe(200);
  });
});
