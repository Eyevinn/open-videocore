// Storage-tier + rehydrate state representation (ADR-019, issue #556).
//
// Covers the REPRESENTATION-ONLY storage-tier axis added to the asset:
//   - a new asset defaults to every byte class `hot` with no rehydrate in flight;
//   - the tier/rehydrate state round-trips through the ADR-005 document mappers;
//   - the state surfaces on GET /api/v1/assets/:id and the list response;
//   - a `rehydrating` state serialises with its byte class + started-at.
//
// The axis is orthogonal to lifecycle `status` (ADR-019 D1/D6) — no test here
// mutates bytes, executes a rehydrate, or triggers tiering; this slice only adds
// the fields, their persistence, their API exposure, and defaulting.

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
      const map: Record<string, string> = { 'token-a': 'workspace-a' };
      const ws = token ? map[token] : undefined;
      if (!ws) throw new actual.AuthError('invalid token');
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import {
  InMemoryAssetRepository,
  defaultStorageTiering,
  type Asset,
  type StorageTiering
} from '../src/data/asset-repo.js';
import {
  AssetDocumentSchema,
  toAssetDocument,
  fromAssetDocument
} from '../src/data/asset-document.js';

const A = { authorization: 'Bearer token-a' };

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

async function createAsset(app: FastifyInstance, name: string): Promise<Record<string, unknown>> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: A,
    payload: { name }
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe('storage-tier + rehydrate representation (ADR-019, issue #556)', () => {
  describe('defaulting (new/existing assets default to hot, no rehydrate)', () => {
    it('a freshly created asset defaults every byte class to hot with nothing rehydrating', async () => {
      const app = await buildApp();
      const body = await createAsset(app, 'clip');
      const tiering = body['storageTiering'] as StorageTiering;
      expect(tiering).toEqual({
        tiers: {
          source: 'hot',
          renditions: 'hot',
          packaged: 'hot',
          subtitles: 'hot',
          thumbnails: 'hot'
        },
        rehydrating: []
      });
    });

    it('never uses the string "archived" as a tier value (that is the lifecycle status)', async () => {
      const app = await buildApp();
      const body = await createAsset(app, 'clip');
      const tiering = body['storageTiering'] as StorageTiering;
      for (const tier of Object.values(tiering.tiers)) {
        expect(tier).not.toBe('archived');
      }
    });

    it('surfaces the all-hot default on GET /:id for an asset stored without tier state', async () => {
      // A pre-#556 asset persists with no storageTiering block; reading it back
      // must still report a concrete all-hot state, never undefined.
      const repo = new InMemoryAssetRepository();
      const app = Fastify();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      registerAuth(app);
      await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: repo });
      await app.ready();

      const created = await repo.create({ name: 'legacy' });
      // Simulate a legacy record: no storageTiering field on the stored asset.
      expect(created.storageTiering).toBeUndefined();

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${created.id}`,
        headers: A
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().storageTiering).toEqual(defaultStorageTiering());
    });
  });

  describe('API exposure (GET /:id and list)', () => {
    it('exposes storageTiering on the list response items', async () => {
      const app = await buildApp();
      await createAsset(app, 'a');
      await createAsset(app, 'b');
      const res = await app.inject({ method: 'GET', url: '/api/v1/assets', headers: A });
      expect(res.statusCode).toBe(200);
      const items = res.json().items as Array<Record<string, unknown>>;
      expect(items.length).toBeGreaterThan(0);
      for (const item of items) {
        expect(item['storageTiering']).toEqual(defaultStorageTiering());
      }
    });

    it('a rehydrating state serialises on GET /:id with its byte class and started-at', async () => {
      // Build a repo whose stored asset carries an in-flight rehydrate and an
      // archived source, then read it back through the route. Representation
      // only — nothing here runs a restore.
      const repo = new InMemoryAssetRepository();
      const app = Fastify();
      app.setValidatorCompiler(validatorCompiler);
      app.setSerializerCompiler(serializerCompiler);
      registerAuth(app);
      await app.register(assetsRouter, { prefix: '/api/v1/assets', repository: repo });
      await app.ready();

      const created = await repo.create({ name: 'cold' });
      const startedAt = '2026-09-04T12:00:00.000Z';
      const withTiering: Asset = {
        ...(await repo.get(created.id))!,
        storageTiering: {
          tiers: { ...defaultStorageTiering().tiers, source: 'archive' },
          rehydrating: [{ byteClass: 'source', startedAt }]
        }
      };
      // Reach into the in-memory store via a raw put so we exercise the read path
      // with an asset that carries explicit tier state (no mutation route exists,
      // by design — this slice is representation only).
      (repo as unknown as { store: Map<string, Asset> }).store.set(created.id, withTiering);

      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${created.id}`,
        headers: A
      });
      expect(res.statusCode).toBe(200);
      const tiering = res.json().storageTiering as StorageTiering;
      expect(tiering.tiers.source).toBe('archive');
      expect(tiering.tiers.packaged).toBe('hot');
      expect(tiering.rehydrating).toEqual([{ byteClass: 'source', startedAt }]);
    });
  });

  describe('persistence round-trip (ADR-005 document mappers)', () => {
    it('an all-hot default asset round-trips with the block absent, reading back as all-hot', async () => {
      const repo = new InMemoryAssetRepository();
      const created = await repo.create({ name: 'clip' });
      const asset: Asset = { ...created, storageTiering: defaultStorageTiering() };

      const doc = AssetDocumentSchema.parse(toAssetDocument(asset));
      // The all-hot default is NOT persisted (back-compat: the block stays absent).
      expect(doc.structural.storageTiering).toBeUndefined();

      const back = fromAssetDocument(doc);
      expect(back.storageTiering).toEqual(defaultStorageTiering());
    });

    it('an archived byte class + in-flight rehydrate round-trips through the mappers', async () => {
      const repo = new InMemoryAssetRepository();
      const created = await repo.create({ name: 'clip' });
      const startedAt = '2026-09-04T09:30:00.000Z';
      const tiering: StorageTiering = {
        tiers: { ...defaultStorageTiering().tiers, source: 'archive', renditions: 'archive' },
        rehydrating: [{ byteClass: 'source', startedAt }]
      };
      const asset: Asset = { ...created, storageTiering: tiering };

      const doc = AssetDocumentSchema.parse(toAssetDocument(asset));
      // Non-default state IS persisted, and lives under the structural namespace.
      expect(doc.structural.storageTiering).toBeDefined();
      expect(doc.structural.storageTiering?.tiers.source).toBe('archive');
      expect(doc.structural.storageTiering?.tiers.renditions).toBe('archive');
      // packaged stays hot -> not persisted as an archived class (implicit default).
      expect(doc.structural.storageTiering?.tiers.packaged).toBeUndefined();
      expect(doc.structural.storageTiering?.rehydrating).toEqual([{ byteClass: 'source', startedAt }]);

      const back = fromAssetDocument(doc);
      expect(back.storageTiering).toEqual({
        tiers: {
          source: 'archive',
          renditions: 'archive',
          packaged: 'hot',
          subtitles: 'hot',
          thumbnails: 'hot'
        },
        rehydrating: [{ byteClass: 'source', startedAt }]
      });
    });

    it('the tier axis never touches the lifecycle state on the document (ADR-019 D6 firewall)', async () => {
      const repo = new InMemoryAssetRepository();
      const created = await repo.create({ name: 'clip' });
      const asset: Asset = {
        ...created,
        storageTiering: {
          tiers: { ...defaultStorageTiering().tiers, source: 'archive' },
          rehydrating: []
        }
      };
      const doc = AssetDocumentSchema.parse(toAssetDocument(asset));
      // Tiering source bytes to `archive` must NOT move lifecycle state to
      // `archived` (or anything else) — the axes are independent.
      expect(doc.state).toBe(created.status);
      expect(doc.state).not.toBe('archived');
    });
  });
});
