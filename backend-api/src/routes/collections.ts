// Workspace-scoped collections router (issue #11).
//
// A collection is a named, workspace-scoped group of asset ids — a lightweight
// way to organise assets into ad-hoc sets without changing the assets
// themselves. Every route is behind `authenticate`, so each handler runs with a
// validated request.workspaceId and the collection repo scopes every read/write
// to that workspace. A collection id from another workspace is treated as a
// miss (existence is not leaked).
//
//   POST   /api/v1/collections                       — create { name }
//   GET    /api/v1/collections                       — list this workspace's collections
//   GET    /api/v1/collections/:id                   — get one, with resolved asset list
//   DELETE /api/v1/collections/:id                   — delete a collection
//   PUT    /api/v1/collections/:id/assets/:assetId   — add an asset to a collection
//   DELETE /api/v1/collections/:id/assets/:assetId   — remove an asset from a collection
//
// Membership stores asset ids only; the GET /:id route resolves them to live
// assets at read time, silently dropping any id that no longer resolves in the
// workspace (e.g. a hard-deleted asset). Adding an asset id that does not refer
// to a live asset is rejected with 422 so callers cannot build dangling sets.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WorkspaceAccessError } from '../data/guard.js';
import {
  CollectionNotFoundError,
  type CollectionRepository
} from '../data/collection-repo.js';
import type { Asset, AssetRepository } from '../data/asset-repo.js';

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

const collectionSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  assetIds: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string()
});

// GET /:id returns the collection plus the resolved live assets. Assets are
// loosely typed here (passthrough) — the assets router owns the canonical asset
// schema; collections only need to surface them.
const collectionWithAssetsSchema = collectionSchema.extend({
  assets: z.array(z.record(z.unknown()))
});

const createBodySchema = z.object({
  name: z.string().min(1).max(256)
});

type CollectionsRouterOptions = {
  repository: CollectionRepository;
  // Asset repository, used to (a) validate an asset exists before adding it to a
  // collection and (b) resolve the membership list to live assets on GET /:id.
  assetRepository: AssetRepository;
};

export const collectionsRouter: FastifyPluginAsync<CollectionsRouterOptions> = async (
  fastify,
  opts
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const repo = opts.repository;
  const assets = opts.assetRepository;
  const guarded = { onRequest: app.authenticate };

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof WorkspaceAccessError) {
      return reply.code(err.statusCode).send({ error: 'forbidden', message: err.message });
    }
    if (err instanceof CollectionNotFoundError) {
      return reply.code(404).send({ error: 'not_found', message: err.message });
    }
    throw err;
  });

  app.post(
    '/',
    {
      ...guarded,
      schema: { body: createBodySchema, response: { 201: collectionSchema, 400: errorSchema } }
    },
    async (request, reply) => {
      const collection = await repo.create(request.workspaceId, request.body);
      return reply.code(201).send(collection);
    }
  );

  app.get(
    '/',
    {
      ...guarded,
      schema: { response: { 200: z.object({ collections: z.array(collectionSchema) }) } }
    },
    async (request, reply) => {
      const collections = await repo.list(request.workspaceId);
      return reply.code(200).send({ collections });
    }
  );

  app.get(
    '/:id',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: collectionWithAssetsSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const collection = await repo.get(request.workspaceId, request.params.id);
      if (!collection) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // Resolve membership to live assets, dropping ids that no longer resolve.
      const resolved = await Promise.all(
        collection.assetIds.map((assetId) => assets.get(request.workspaceId, assetId))
      );
      const liveAssets = resolved.filter((a): a is Asset => a !== undefined);
      return reply.code(200).send({ ...collection, assets: liveAssets });
    }
  );

  app.delete(
    '/:id',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 204: z.null(), 404: errorSchema }
      }
    },
    async (request, reply) => {
      // Delete is idempotent and never leaks existence across workspaces: an
      // unknown / foreign id is a silent no-op that still answers 204.
      await repo.delete(request.workspaceId, request.params.id);
      return reply.code(204).send(null);
    }
  );

  app.put(
    '/:id/assets/:assetId',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string(), assetId: z.string() }),
        response: { 200: collectionSchema, 404: errorSchema, 422: errorSchema }
      }
    },
    async (request, reply) => {
      // Reject membership for an asset that does not exist in this workspace so
      // collections never accumulate dangling ids. A foreign asset id resolves
      // to a miss here (existence not leaked) -> 422.
      const asset = await assets.get(request.workspaceId, request.params.assetId);
      if (!asset) {
        return reply.code(422).send({
          error: 'asset_not_found',
          message: `asset not found: ${request.params.assetId}`
        });
      }
      // mutate throws CollectionNotFoundError (-> 404) for an unknown collection.
      const collection = await repo.addAsset(
        request.workspaceId,
        request.params.id,
        request.params.assetId
      );
      return reply.code(200).send(collection);
    }
  );

  app.delete(
    '/:id/assets/:assetId',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string(), assetId: z.string() }),
        response: { 200: collectionSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      // Removing an absent asset id is a no-op (still 200). An unknown
      // collection id throws CollectionNotFoundError (-> 404).
      const collection = await repo.removeAsset(
        request.workspaceId,
        request.params.id,
        request.params.assetId
      );
      return reply.code(200).send(collection);
    }
  );
};
