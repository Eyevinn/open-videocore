// Workspace-scoped search router (issue #10).
//
// GET /api/v1/search?q=&tags=&mimeType=&page=&pageSize= — full-text + metadata
// search over the caller's assets. Behind `authenticate`, so each handler runs
// with a validated request.workspaceId and the search repo scopes every query
// to that workspace. `tags` may be repeated or comma-separated.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { WorkspaceAccessError } from '../data/guard.js';
import { MAX_PAGE_SIZE, type SearchRepository } from '../data/search-repo.js';

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

const transitionSchema = z.object({
  at: z.string(),
  from: z.string().nullable(),
  to: z.string()
});

const audioTrackSchema = z.object({
  index: z.number(),
  codec: z.string(),
  channels: z.number(),
  sampleRateHz: z.number()
});

const technicalMetadataSchema = z.object({
  codec: z.string(),
  width: z.number(),
  height: z.number(),
  durationSeconds: z.number(),
  bitrateBps: z.number(),
  containerFormat: z.string(),
  audioTracks: z.array(audioTrackSchema),
  extractedAt: z.string()
});

const manifestUrlsSchema = z.object({
  hls: z.string().optional(),
  dash: z.string().optional()
});

const renditionSchema = z.object({
  assetId: z.string(),
  label: z.string(),
  width: z.number(),
  height: z.number(),
  objectKey: z.string()
});

const assetSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  status: z.string(),
  parentId: z.string().optional(),
  objectKey: z.string().optional(),
  statusHistory: z.array(transitionSchema),
  technicalMetadata: technicalMetadataSchema.nullish(),
  technicalMetadataError: z.string().optional(),
  manifestUrls: manifestUrlsSchema.optional(),
  packagingError: z.string().optional(),
  renditions: z.array(renditionSchema).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const searchResultSchema = z.object({
  assets: z.array(assetSchema),
  total: z.number(),
  page: z.number()
});

// `tags` accepts repeated query params (?tags=a&tags=b) or a comma-separated
// list (?tags=a,b). Normalised to a trimmed, non-empty string array.
const tagsSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    const raw = Array.isArray(v) ? v : [v];
    const flattened = raw
      .flatMap((s) => s.split(','))
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return flattened.length > 0 ? flattened : undefined;
  });

const searchQuerySchema = z.object({
  q: z.string().min(1).max(512).optional(),
  tags: tagsSchema,
  mimeType: z.string().min(1).max(128).optional(),
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional()
});

type SearchRouterOptions = {
  repository: SearchRepository;
};

export const searchRouter: FastifyPluginAsync<SearchRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const repo = opts.repository;

  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof WorkspaceAccessError) {
      return reply.code(err.statusCode).send({ error: 'forbidden', message: err.message });
    }
    throw err;
  });

  app.get(
    '/',
    {
      onRequest: app.authenticate,
      schema: {
        querystring: searchQuerySchema,
        response: { 200: searchResultSchema, 400: errorSchema }
      }
    },
    async (request) => {
      const { q, tags, mimeType, page, pageSize } = request.query;
      return repo.search(request.workspaceId, { q, tags, mimeType, page, pageSize });
    }
  );
};
