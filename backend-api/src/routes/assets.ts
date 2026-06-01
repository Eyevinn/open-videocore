// Workspace-scoped assets router (issue #20 isolation + issue #3 lifecycle).
//
// Every route is protected by the `authenticate` preHandler, so each handler
// runs with a validated request.workspaceId. All repository calls pass that
// workspaceId, so a caller can only ever see or mutate their own workspace's
// assets. Cross-workspace ids resolve to 404 (existence is not leaked) and the
// guard layer rejects any forged ownership with 403.
//
// Lifecycle (issue #3): assets move uploading -> processing -> ready ->
// archived. Invalid transitions are rejected with 422. DELETE is a SOFT delete
// (status -> archived); deleting an asset that still has children returns 409.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  ASSET_STATUSES,
  HasChildrenError,
  InMemoryAssetRepository,
  InvalidStateTransitionError,
  ParentNotFoundError,
  type AssetRepository
} from '../data/asset-repo.js';
import { WorkspaceAccessError } from '../data/guard.js';
import { InMemoryJobRepository, type JobRepository } from '../data/job-repo.js';
import { SourceTooLargeError, type WorkspaceStorage } from '../data/storage.js';
import { parseSource, assertPublicHost, SourceValidationError } from '../pipeline/source.js';
import { runPull, type PullDeps } from '../pipeline/url-pull-worker.js';
import {
  extractTechnicalMetadata,
  type ExtractDeps,
  type ProbeRunner
} from '../pipeline/metadata-extractor.js';

const statusSchema = z.enum(ASSET_STATUSES);

const createSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(2048).optional(),
  parentId: z.string().min(1).optional(),
  objectKey: z.string().min(1).max(1024).optional()
});

// PATCH: all fields optional; at least one is required. `status` is checked
// against the state machine in the repository layer.
const updateSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    description: z.string().max(2048).optional(),
    objectKey: z.string().min(1).max(1024).optional(),
    status: statusSchema.optional()
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'no updatable fields provided' });

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: statusSchema.optional(),
  parentId: z.string().min(1).optional()
});

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

const transitionSchema = z.object({
  at: z.string(),
  from: statusSchema.nullable(),
  to: statusSchema
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

const assetSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  description: z.string().optional(),
  status: statusSchema,
  parentId: z.string().optional(),
  objectKey: z.string().optional(),
  statusHistory: z.array(transitionSchema),
  // Technical metadata (issue #6). `null` until the first successful extraction
  // (or after a failed one); `technicalMetadataError` carries the last failure.
  technicalMetadata: technicalMetadataSchema.nullish(),
  technicalMetadataError: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

const listSchema = z.object({
  items: z.array(assetSchema),
  limit: z.number(),
  offset: z.number(),
  total: z.number()
});

// A workspace-scoped MinIO wrapper factory, supplied by app wiring. Absent in a
// bare local run, in which case URL-pull ingest is disabled (501).
export type StorageFactory = (workspaceId: string) => WorkspaceStorage;

type AssetsRouterOptions = {
  // Injectable for tests; defaults to the in-memory repository.
  repository?: AssetRepository;
  // Job persistence for ingest jobs (issue #5). Defaults to in-memory.
  jobRepository?: JobRepository;
  // MinIO wrapper factory for the pull destination. When undefined, URL-pull
  // ingest responds 501.
  storageFor?: StorageFactory;
  // Injectable worker runner + deps (tests stub fetch/s3/backoff). Defaults to
  // the real in-process worker.
  runPull?: typeof runPull;
  pullDeps?: PullDeps;
  // Technical metadata extraction (issue #6). `probe` is the ffprobe runner
  // (eyevinn-ffmpeg-s3 in production, a stub in tests). When `probe` is absent
  // extraction is disabled and POST /:id/extract-metadata responds 501.
  probe?: ProbeRunner;
  // Injectable extractor runner + extra deps (tests stub the probe/TTL/onError).
  // Defaults to the real fire-and-forget extractor.
  extract?: typeof extractTechnicalMetadata;
  extractDeps?: Partial<ExtractDeps>;
};

const ingestUrlSchema = z.object({
  sourceUrl: z.string().min(1).max(4096),
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(2048).optional()
});

const ingestAcceptedSchema = z.object({
  assetId: z.string(),
  jobId: z.string()
});

export const assetsRouter: FastifyPluginAsync<AssetsRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const repo = opts.repository ?? new InMemoryAssetRepository();
  const jobs = opts.jobRepository ?? new InMemoryJobRepository();
  const runner = opts.runPull ?? runPull;
  const extractRunner = opts.extract ?? extractTechnicalMetadata;
  const storageFor = opts.storageFor;

  // Fire-and-forget technical metadata extraction (issue #6). Detached, never
  // blocks the caller, and the extractor itself never throws (records failures
  // on the asset). No-op when the probe runner or object storage is not
  // configured. Returns true when an extraction was actually kicked off.
  function triggerExtraction(workspaceId: string, assetId: string, objectKey: string): boolean {
    if (!opts.probe || !storageFor) {
      return false;
    }
    void extractRunner(
      { workspaceId, assetId, objectKey },
      {
        assets: repo,
        storage: storageFor(workspaceId),
        probe: opts.probe,
        ...opts.extractDeps
      }
    );
    return true;
  }

  // Map domain errors to HTTP status codes for this router.
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof WorkspaceAccessError) {
      return reply.code(err.statusCode).send({ error: 'forbidden', message: err.message });
    }
    if (err instanceof InvalidStateTransitionError) {
      return reply.code(422).send({ error: 'invalid_state_transition', message: err.message });
    }
    if (err instanceof ParentNotFoundError) {
      return reply.code(422).send({ error: 'parent_not_found', message: err.message });
    }
    if (err instanceof HasChildrenError) {
      return reply.code(409).send({ error: 'has_children', message: err.message });
    }
    if (err instanceof SourceValidationError) {
      return reply.code(400).send({ error: 'invalid_source', message: err.message });
    }
    if (err instanceof SourceTooLargeError) {
      return reply.code(413).send({ error: 'source_too_large', message: err.message });
    }
    throw err;
  });

  const guarded = { onRequest: app.authenticate };

  app.post(
    '/',
    { ...guarded, schema: { body: createSchema, response: { 201: assetSchema } } },
    async (request, reply) => {
      const asset = await repo.create(request.workspaceId, request.body);
      return reply.code(201).send(asset);
    }
  );

  // URL-pull ingest (issue #5). Validates the source (scheme + SSRF guard for
  // HTTP/S), creates an asset (uploading) + an ingest job (pending), and kicks
  // off the in-process pull worker. Returns both ids immediately; the caller
  // polls GET /api/v1/jobs/:id for progress. The asset advances to processing
  // on success or failed on terminal error — all handled by the worker.
  app.post(
    '/ingest-url',
    {
      ...guarded,
      schema: {
        body: ingestUrlSchema,
        response: { 202: ingestAcceptedSchema, 400: errorSchema, 413: errorSchema, 501: errorSchema }
      }
    },
    async (request, reply) => {
      if (!storageFor) {
        return reply
          .code(501)
          .send({ error: 'not_configured', message: 'object storage is not configured' });
      }
      const { sourceUrl, name, description } = request.body;

      // Validate synchronously so a bad URL is a 400, not a background failure.
      const parsed = parseSource(sourceUrl);
      if (parsed.scheme === 'http' || parsed.scheme === 'https') {
        await assertPublicHost(parsed.url.hostname);
      }

      // Derive a default asset name from the URL's last path segment.
      const fallbackName =
        decodeURIComponent(parsed.url.pathname.split('/').filter(Boolean).pop() ?? '') ||
        parsed.url.hostname;

      const asset = await repo.create(request.workspaceId, {
        name: name ?? fallbackName,
        description
      });
      // Destination object key inside the workspace prefix.
      const objectKey = `ingest/${asset.id}`;
      await repo.update(request.workspaceId, asset.id, { objectKey });

      const job = await jobs.create(request.workspaceId, {
        type: 'ingest-url',
        assetId: asset.id,
        sourceUrl
      });

      // Detached, non-blocking. runPull never throws (records failures on the
      // job), so an unhandled rejection cannot crash the process. Once the pull
      // reaches a terminal state we fire-and-forget technical metadata
      // extraction against the now-stored object (issue #6); we only extract if
      // the asset actually advanced to `processing` (pull succeeded).
      const ws = request.workspaceId;
      void runner(
        { workspaceId: ws, jobId: job.id, assetId: asset.id, objectKey, sourceUrl },
        { jobs, assets: repo, storage: storageFor(ws), ...opts.pullDeps }
      ).then(async () => {
        const settled = await repo.get(ws, asset.id);
        if (settled?.status === 'processing') {
          triggerExtraction(ws, asset.id, objectKey);
        }
      });

      return reply.code(202).send({ assetId: asset.id, jobId: job.id });
    }
  );

  app.get(
    '/',
    { ...guarded, schema: { querystring: listQuerySchema, response: { 200: listSchema } } },
    async (request) => {
      return repo.list(request.workspaceId, request.query);
    }
  );

  app.get(
    '/search',
    {
      ...guarded,
      schema: {
        querystring: z.object({ q: z.string().min(1) }),
        response: { 200: z.object({ items: z.array(assetSchema) }) }
      }
    },
    async (request) => {
      const items = await repo.search(request.workspaceId, request.query.q);
      return { items };
    }
  );

  app.get(
    '/:id',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: assetSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(asset);
    }
  );

  // On-demand re-extraction of technical metadata (issue #6). Workspace-scoped
  // and behind `authenticate`. Returns 202 Accepted immediately and runs the
  // ffprobe extraction fire-and-forget; the caller polls GET /:id to observe
  // `technicalMetadata` / `technicalMetadataError` once it settles.
  //   404 — unknown/foreign asset (existence not leaked)
  //   409 — the asset has no stored object yet (nothing to probe)
  //   501 — extraction is not configured on this deployment
  app.post(
    '/:id/extract-metadata',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        response: {
          202: z.object({ assetId: z.string(), status: z.string() }),
          404: errorSchema,
          409: errorSchema,
          501: errorSchema
        }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      if (!asset.objectKey) {
        return reply.code(409).send({
          error: 'no_object',
          message: 'asset has no stored object to extract metadata from'
        });
      }
      if (!opts.probe || !storageFor) {
        return reply.code(501).send({
          error: 'not_configured',
          message: 'technical metadata extraction is not configured'
        });
      }
      triggerExtraction(request.workspaceId, asset.id, asset.objectKey);
      return reply.code(202).send({ assetId: asset.id, status: 'extracting' });
    }
  );

  app.patch(
    '/:id',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        body: updateSchema,
        response: { 200: assetSchema, 404: errorSchema, 422: errorSchema }
      }
    },
    async (request, reply) => {
      const updated = await repo.update(request.workspaceId, request.params.id, request.body);
      if (!updated) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(updated);
    }
  );

  app.delete(
    '/:id',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 204: z.null(), 404: errorSchema, 409: errorSchema }
      }
    },
    async (request, reply) => {
      // Block deletion while children (renditions) still reference this asset.
      const childCount = await repo.countChildren(request.workspaceId, request.params.id);
      if (childCount > 0) {
        throw new HasChildrenError(request.params.id);
      }
      // Soft delete: archive rather than destroy (see asset-repo / couch-asset-repo).
      const removed = await repo.remove(request.workspaceId, request.params.id);
      if (!removed) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(204).send(null);
    }
  );
};
