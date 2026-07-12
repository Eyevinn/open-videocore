// Workspace-scoped search router (issue #10).
//
// GET /api/v1/search?q=&tags=&mimeType=&page=&pageSize= — full-text + metadata
// search over the caller's assets. Behind `authenticate`, so each handler runs
// with a validated request.workspaceId and the search repo scopes every query
// to that workspace. `tags` may be repeated or comma-separated.
//
// Free-form operator metadata (issue #12) is filtered with `metadata.<key>=<value>`
// query params (e.g. ?metadata.genre=documentary&metadata.language=sv). Each pair
// is an exact-match (string) filter; an asset matches when it carries all of them.

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
  id: z.string(),
  label: z.string(),
  width: z.number(),
  height: z.number(),
  objectKey: z.string(),
  codec: z.string().optional(),
  bitrateBps: z.number().optional()
});

const assetSchema = z.object({
  id: z.string(),
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
  metadata: z.record(z.unknown()).optional(),
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

const searchQuerySchema = z
  .object({
    q: z.string().min(1).max(512).optional(),
    tags: tagsSchema,
    mimeType: z.string().min(1).max(128).optional(),
    // TAMS addressing lookup (issue #168). Optional filters so an asset can be
    // found by its TAMS address (flow UUID / canonical TAI timerange string).
    tamsFlowId: z.string().min(1).max(128).optional(),
    tamsTimerange: z.string().min(1).max(128).optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).optional()
  })
  // Allow `metadata.<key>=<value>` filter params through (issue #12); extracted
  // from the raw query below since their key names are dynamic.
  .passthrough();

// Pull `metadata.<key>=<value>` pairs out of the raw query object into a flat
// metadata filter. Only the first value is used when a key is repeated.
function extractMetadataFilter(
  query: Record<string, unknown>
): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(query)) {
    if (!key.startsWith('metadata.')) {
      continue;
    }
    const field = key.slice('metadata.'.length);
    if (field.length === 0) {
      continue;
    }
    out[field] = Array.isArray(value) ? value[0] : value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

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
      schema: {
        querystring: searchQuerySchema,
        response: { 200: searchResultSchema, 400: errorSchema }
      }
    },
    async (request) => {
      const { q, tags, mimeType, tamsFlowId, tamsTimerange, page, pageSize } = request.query;
      const metadata = extractMetadataFilter(request.query as Record<string, unknown>);
      return repo.search({ q, tags, mimeType, tamsFlowId, tamsTimerange, metadata, page, pageSize });
    }
  );
};
