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
import { randomUUID } from 'node:crypto';
import {
  ASSET_STATUSES,
  HasChildrenError,
  InMemoryAssetRepository,
  InvalidStateTransitionError,
  ParentNotFoundError,
  normalizeTags,
  SUBTITLE_FORMATS,
  type AssetAudioTrack,
  type AssetRepository,
  type SubtitleTrack
} from '../data/asset-repo.js';
import { WorkspaceAccessError } from '../data/guard.js';
import { InMemoryJobRepository, type JobRepository } from '../data/job-repo.js';
import {
  SourceTooLargeError,
  deliveryUrlTtlSeconds,
  type WorkspaceStorage
} from '../data/storage.js';
import { parseSource, assertPublicHost, SourceValidationError } from '../pipeline/source.js';
import { runPull, type PullDeps } from '../pipeline/url-pull-worker.js';
import {
  extractTechnicalMetadata,
  type ExtractDeps,
  type ProbeRunner
} from '../pipeline/metadata-extractor.js';
import { submitTranscode } from '../pipeline/transcode.js';
import {
  extractThumbnails,
  type ExtractThumbnailsDeps,
  type FrameExtractor
} from '../pipeline/thumbnail.js';
import { clip as runClip, type ClipDeps, type ClipRunner } from '../pipeline/clip.js';
import type { EncoreClient } from '../pipeline/encore-client.js';
import { PRESET_NAMES, type EncoreProfile } from '../pipeline/encode-presets.js';
import {
  rewrap,
  REWRAP_FORMATS,
  UnsupportedFormatError,
  type RewrapDeps,
  type RewrapRunner
} from '../pipeline/rewrap.js';

const statusSchema = z.enum(ASSET_STATUSES);

// A custom Encore profile a caller may supply instead of a named preset. Kept
// permissive (forwarded to Encore) but bounded so it cannot be abused.
const encoreOutputSchema = z.object({
  label: z.string().min(1).max(64),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  videoBitrateBps: z.number().int().positive(),
  audioBitrateBps: z.number().int().positive(),
  format: z.string().min(1).max(32)
});

const customProfileSchema = z.object({
  name: z.string().min(1).max(128),
  outputs: z.array(encoreOutputSchema).min(1).max(16)
});

const transcodeBodySchema = z
  .object({
    profile: z.enum(PRESET_NAMES).optional(),
    customProfile: customProfileSchema.optional()
  })
  .refine((b) => !(b.profile && b.customProfile), {
    message: 'specify either profile or customProfile, not both'
  });

const transcodeAcceptedSchema = z.object({
  jobId: z.string(),
  encoreJobId: z.string()
});

// Free-form, operator-defined metadata (issue #12). Values must be
// JSON-serializable; the object is otherwise opaque to the API.
const metadataSchema = z.record(z.unknown());

// First-class tags (issue #11). Each tag is a non-empty, bounded string; the
// repository deduplicates the list (first-seen order preserved).
const tagSchema = z.string().min(1).max(128);
const tagsSchema = z.array(tagSchema).max(128);

const createSchema = z.object({
  name: z.string().min(1).max(256),
  description: z.string().max(2048).optional(),
  parentId: z.string().min(1).optional(),
  objectKey: z.string().min(1).max(1024).optional(),
  metadata: metadataSchema.optional(),
  tags: tagsSchema.optional()
});

// PATCH: all fields optional; at least one is required. `status` is checked
// against the state machine in the repository layer. `metadata` here is
// SHALLOW-MERGED into the asset's existing metadata (issue #12) — to replace
// the whole object use PUT /:id/metadata instead.
const updateSchema = z
  .object({
    name: z.string().min(1).max(256).optional(),
    description: z.string().max(2048).optional(),
    objectKey: z.string().min(1).max(1024).optional(),
    status: statusSchema.optional(),
    metadata: metadataSchema.optional(),
    // First-class tags (issue #11). On PATCH this REPLACES the tag list wholesale.
    tags: tagsSchema.optional()
  })
  .refine((b) => Object.keys(b).length > 0, { message: 'no updatable fields provided' });

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
  status: statusSchema.optional(),
  parentId: z.string().min(1).optional()
});

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

// Delivery URL response (issue #14). Closes the pipeline loop: a client asks for
// playback/download URLs for an asset and gets back whatever delivery surface is
// available — packaged HLS/DASH manifests (preferred) and/or a presigned source
// download. `expiresAt` is the ISO instant the presigned URLs stop working; for
// already-public manifest URLs it bounds the advertised validity window.
const deliveryUrlsSchema = z.object({
  hls: z.string().optional(),
  dash: z.string().optional(),
  source: z.string().optional()
});

const deliverySchema = z.object({
  assetId: z.string(),
  urls: deliveryUrlsSchema,
  expiresAt: z.string()
});

// Thumbnail extraction request (issue #7): one or more timecodes in seconds.
const thumbnailsBodySchema = z.object({
  timecodes: z.array(z.number().min(0)).min(1).max(50)
});

const thumbnailsResultSchema = z.object({
  assetId: z.string(),
  thumbnails: z.array(z.string())
});

// Export / re-wrap request (issue #19): the target container format and an
// optional name for the new child asset. The supported formats are validated
// with a Zod enum so an unsupported container is a 400 at the boundary.
const exportBodySchema = z.object({
  targetFormat: z.enum(REWRAP_FORMATS),
  outputName: z.string().min(1).max(256).optional()
});
// Clip / trim request (issue #17): a time window in seconds. `endSeconds` must
// be strictly greater than `startSeconds`. Optional `outputName` names the new
// child asset.
const clipBodySchema = z
  .object({
    startSeconds: z.number().min(0),
    endSeconds: z.number().positive(),
    outputName: z.string().min(1).max(256).optional()
  })
  .refine((b) => b.endSeconds > b.startSeconds, {
    message: 'endSeconds must be greater than startSeconds'
  });

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

// Multi-language audio/subtitle tracks (issue #18). `language` is a free-form
// BCP-47 string (non-empty, no strict enum); subtitle `format` is constrained
// to the formats we know how to package. Track `id` is server-generated.
const audioTrackOutSchema = z.object({
  id: z.string(),
  language: z.string(),
  codec: z.string().optional(),
  channels: z.number().optional(),
  label: z.string().optional(),
  default: z.boolean().optional()
});

const subtitleFormatSchema = z.enum(SUBTITLE_FORMATS);

const subtitleTrackOutSchema = z.object({
  id: z.string(),
  language: z.string(),
  format: subtitleFormatSchema,
  objectKey: z.string().optional(),
  label: z.string().optional(),
  default: z.boolean().optional()
});

// Request bodies for adding tracks. The server assigns the id, so it is not
// accepted from the client.
const addAudioTrackSchema = z.object({
  language: z.string().min(1).max(64),
  codec: z.string().min(1).max(64).optional(),
  channels: z.number().int().min(1).max(64).optional(),
  label: z.string().min(1).max(128).optional(),
  default: z.boolean().optional()
});

const addSubtitleTrackSchema = z.object({
  language: z.string().min(1).max(64),
  format: subtitleFormatSchema,
  label: z.string().min(1).max(128).optional(),
  default: z.boolean().optional()
});

const tracksSchema = z.object({
  audioTracks: z.array(audioTrackOutSchema),
  subtitleTracks: z.array(subtitleTrackOutSchema)
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
  // Streaming manifest URLs from the packaging pipeline (issue #9). Absent until
  // packaging completes; `packagingError` carries the last packaging failure.
  manifestUrls: manifestUrlsSchema.optional(),
  packagingError: z.string().optional(),
  // ABR renditions produced by transcoding (issue #8). Absent until a transcode
  // job completes; each entry links to a child asset via its assetId.
  renditions: z.array(renditionSchema).optional(),
  // Thumbnail / poster-frame object keys (issue #7). Absent until the first
  // successful extraction; replaced wholesale by a later extraction.
  thumbnails: z.array(z.string()).optional(),
  // Free-form operator metadata (issue #12). Absent until the operator sets any
  // metadata; a JSON object of JSON-serializable values.
  metadata: metadataSchema.optional(),
  // Multi-language audio/subtitle tracks (issue #18). Absent until the first
  // track of the respective kind is added.
  audioTracks: z.array(audioTrackOutSchema).optional(),
  subtitleTracks: z.array(subtitleTrackOutSchema).optional(),
  // First-class tags (issue #11). Absent until the first tag is set.
  tags: z.array(z.string()).optional(),
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
  // Encore transcode client (issue #8). When absent, POST /:id/transcode
  // responds 501 (Encore not configured on this deployment).
  encore?: EncoreClient;
  // S3 bucket names Encore reads the source from / writes renditions to.
  sourceBucket?: string;
  outputBucket?: string;
  // Thumbnail / poster-frame extraction (issue #7). `thumbnailExtractor` runs
  // the OSC ffmpeg job (eyevinn-ffmpeg-s3 in production, a stub in tests). When
  // absent (or no object storage), the thumbnail routes respond 501.
  thumbnailExtractor?: FrameExtractor;
  // Injectable extractor runner + extra deps (tests stub the extractor/TTL).
  // Defaults to the real awaited extractor.
  extractThumbnails?: typeof extractThumbnails;
  thumbnailDeps?: Partial<ExtractThumbnailsDeps>;
  // Public base URL for building thumbnail URLs in GET responses. When unset,
  // GET returns workspace-local object keys instead of absolute URLs.
  thumbnailPublicBaseUrl?: string;
  // Export / re-wrap (issue #19). `rewrapRunner` runs the OSC ffmpeg `-c copy`
  // job (eyevinn-ffmpeg-s3 in production, a stub in tests). When absent (or no
  // object storage), POST /:id/export responds 501.
  rewrapRunner?: RewrapRunner;
  rewrap?: typeof rewrap;
  rewrapDeps?: Partial<RewrapDeps>;
  // Clip / trim (issue #17). `clipRunner` runs the OSC ffmpeg job
  // (eyevinn-ffmpeg-s3 in production, a stub in tests). When absent (or no
  // object storage), POST /:id/clip responds 501.
  clipRunner?: ClipRunner;
  clip?: typeof runClip;
  clipDeps?: Partial<ClipDeps>;
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
  const thumbnailRunner = opts.extractThumbnails ?? extractThumbnails;
  const rewrapRunner = opts.rewrap ?? rewrap;
  const clipRunnerOrchestrator = opts.clip ?? runClip;
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
    if (err instanceof UnsupportedFormatError) {
      return reply.code(400).send({ error: 'unsupported_format', message: err.message });
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

  // Delivery URL generation (issue #14). Closes the pipeline loop: ingest ->
  // transcode -> package -> deliver. Workspace-scoped and behind `authenticate`.
  // Resolution order:
  //   - If the asset has packaged HLS/DASH output (`manifestUrls` from issue #9)
  //     those URLs are returned directly (they are already public CMAF
  //     manifests served from the packaged bucket / CDN).
  //   - Otherwise, if the asset has a stored source object (`objectKey`) we mint
  //     a presigned GET URL so the raw source can be downloaded/played.
  //   - If neither is available the asset has nothing to deliver -> 404.
  // Presigned source URLs expire after DELIVERY_URL_TTL_SECONDS (default 1h).
  //   200 — delivery URLs returned
  //   404 — unknown/foreign asset, or asset has no deliverable output
  //   501 — a source-only asset but object storage is not configured here
  app.get(
    '/:id/delivery',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: deliverySchema, 404: errorSchema, 501: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }

      const ttl = deliveryUrlTtlSeconds();
      const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();

      // Preferred: packaged streaming manifests (issue #9). Already public URLs.
      if (asset.manifestUrls && (asset.manifestUrls.hls || asset.manifestUrls.dash)) {
        return reply.code(200).send({
          assetId: asset.id,
          urls: { hls: asset.manifestUrls.hls, dash: asset.manifestUrls.dash },
          expiresAt
        });
      }

      // Fallback: presigned download of the raw source object.
      if (asset.objectKey) {
        if (!storageFor) {
          return reply.code(501).send({
            error: 'not_configured',
            message: 'object storage is not configured'
          });
        }
        const source = await storageFor(request.workspaceId).presignedGet(asset.objectKey, ttl);
        return reply.code(200).send({ assetId: asset.id, urls: { source }, expiresAt });
      }

      // Nothing to deliver yet (no packaged output and no stored source object).
      return reply.code(404).send({
        error: 'no_delivery',
        message: 'asset has no packaged output or stored source object to deliver'
      });
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

  // Submit an ABR transcoding job to Encore (issue #8). Workspace-scoped and
  // behind `authenticate`. Resolves a preset (default 1080p) or a custom
  // profile, creates a TranscodeJob, advances the source asset to `processing`,
  // and submits to Encore. Returns the job id + Encore job id immediately; the
  // caller polls GET /api/v1/jobs/:id and the Encore callback finishes the work.
  //   202 — accepted, transcode submitted
  //   404 — unknown/foreign source asset (existence not leaked)
  //   409 — the source asset has no stored object to transcode
  //   501 — transcoding is not configured on this deployment
  //   502 — Encore rejected the submission
  app.post(
    '/:id/transcode',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        body: transcodeBodySchema,
        response: {
          202: transcodeAcceptedSchema,
          404: errorSchema,
          409: errorSchema,
          501: errorSchema,
          502: errorSchema
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
          message: 'asset has no stored object to transcode'
        });
      }
      if (!opts.encore || !opts.sourceBucket || !opts.outputBucket) {
        return reply.code(501).send({
          error: 'not_configured',
          message: 'transcoding is not configured'
        });
      }
      try {
        const result = await submitTranscode(
          {
            workspaceId: request.workspaceId,
            sourceAssetId: asset.id,
            sourceObjectKey: asset.objectKey,
            preset: request.body.profile,
            customProfile: request.body.customProfile as EncoreProfile | undefined,
            sourceBucket: opts.sourceBucket,
            outputBucket: opts.outputBucket
          },
          { jobs, assets: repo, encore: opts.encore }
        );
        return reply.code(202).send(result);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: 'encore_submit_failed', message });
      }
    }
  );

  // Thumbnail / poster-frame extraction (issue #7). Workspace-scoped and behind
  // `authenticate`. Unlike metadata extraction this is AWAITED: the caller gets
  // back the stored thumbnail keys (or an error) synchronously. Re-running for
  // the same timecodes overwrites the same keys (idempotent).
  //   200 — frames extracted, thumbnail keys returned
  //   404 — unknown/foreign asset (existence not leaked)
  //   409 — the asset has no stored object to extract frames from
  //   501 — thumbnail extraction is not configured on this deployment
  //   502 — the OSC ffmpeg job failed
  app.post(
    '/:id/thumbnails',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        body: thumbnailsBodySchema,
        response: {
          200: thumbnailsResultSchema,
          404: errorSchema,
          409: errorSchema,
          501: errorSchema,
          502: errorSchema
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
          message: 'asset has no stored object to extract thumbnails from'
        });
      }
      if (!opts.thumbnailExtractor || !storageFor) {
        return reply.code(501).send({
          error: 'not_configured',
          message: 'thumbnail extraction is not configured'
        });
      }
      try {
        const thumbnails = await thumbnailRunner(
          {
            workspaceId: request.workspaceId,
            assetId: asset.id,
            objectKey: asset.objectKey,
            timecodes: request.body.timecodes
          },
          {
            assets: repo,
            storage: storageFor(request.workspaceId),
            extractor: opts.thumbnailExtractor,
            ...opts.thumbnailDeps
          }
        );
        return reply.code(200).send({ assetId: asset.id, thumbnails });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: 'thumbnail_extraction_failed', message });
      }
    }
  );

// Export / re-wrap (remux) an asset into a different container (issue #19).
  // Workspace-scoped and behind `authenticate`. Copies every stream verbatim
  // (`-c copy`) into a new container chosen by `targetFormat`, producing a NEW
  // child asset (parentId = source). Like thumbnails this is AWAITED: the caller
  // gets back the new child asset synchronously (201). The source is unchanged.
  //   201 — re-wrapped, the new child asset returned
  //   400 — unsupported target format (validated by the enum / pipeline guard)
  //   404 — unknown/foreign source asset (existence not leaked)
  //   409 — the source asset has no stored object to re-wrap
  //   501 — export / re-wrap is not configured on this deployment
  //   502 — the OSC ffmpeg job failed
  app.post(
    '/:id/export',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        body: exportBodySchema,
        response: {
          201: assetSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          501: errorSchema,
          502: errorSchema
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
          message: 'asset has no stored object to re-wrap'
        });
      }
      if (!opts.rewrapRunner || !storageFor) {
        return reply.code(501).send({
          error: 'not_configured',
          message: 'export / re-wrap is not configured'
        });
      }
      try {
        const child = await rewrapRunner(
          {
            workspaceId: request.workspaceId,
            sourceAssetId: asset.id,
            objectKey: asset.objectKey,
            targetFormat: request.body.targetFormat,
            outputName: request.body.outputName
          },
          {
            assets: repo,
            storage: storageFor(request.workspaceId),
            runner: opts.rewrapRunner,
            ...opts.rewrapDeps
          }
        );
        return reply.code(201).send(child);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: 'rewrap_failed', message });
      }
    }
  );

  app.post(
    '/:id/clip',
    {
      onRequest: app.authenticate,
      schema: {
        params: z.object({ id: z.string() }),
        body: clipBodySchema,
        response: {
          201: assetSchema,
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          501: errorSchema,
          502: errorSchema
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
          message: 'asset has no stored object to clip'
        });
      }
      if (!opts.clipRunner || !storageFor) {
        return reply.code(501).send({
          error: 'not_configured',
          message: 'clip extraction is not configured'
        });
      }
      try {
        const child = await clipRunnerOrchestrator(
          {
            workspaceId: request.workspaceId,
            sourceAssetId: asset.id,
            objectKey: asset.objectKey,
            startSeconds: request.body.startSeconds,
            endSeconds: request.body.endSeconds,
            outputName: request.body.outputName
          },
          {
            assets: repo,
            storage: storageFor(request.workspaceId),
            runner: opts.clipRunner,
            ...opts.clipDeps
          }
        );
        return reply.code(201).send(child);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.code(502).send({ error: 'clip_failed', message });
      }
    }
  );

  // List an asset's thumbnail URLs (issue #7). Returns absolute URLs when a
  // public base URL is configured, otherwise the workspace-local object keys.
  //   200 — list of thumbnail URLs (possibly empty)
  //   404 — unknown/foreign asset (existence not leaked)
  app.get(
    '/:id/thumbnails',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        response: {
          200: z.object({ assetId: z.string(), thumbnails: z.array(z.string()) }),
          404: errorSchema
        }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const keys = asset.thumbnails ?? [];
      const base = opts.thumbnailPublicBaseUrl;
      let thumbnails: string[];
      if (base) {
        thumbnails = keys.map((k) => `${base.replace(/\/+$/, '')}/${k}`);
      } else if (storageFor && keys.length > 0) {
        const storage = storageFor(request.workspaceId);
        thumbnails = await Promise.all(keys.map((k) => storage.presignedGet(k, 3600)));
      } else {
        thumbnails = keys;
      }
      return reply.code(200).send({ assetId: asset.id, thumbnails });
    }
  );

  // Replace an asset's free-form metadata wholesale (issue #12). Unlike PATCH
  // (which shallow-merges), this sets the entire metadata object to the request
  // body, dropping any keys not present. Workspace-scoped and behind
  // `authenticate`.
  //   200 — metadata replaced, full asset returned
  //   404 — unknown/foreign asset (existence not leaked)
  app.put(
    '/:id/metadata',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        body: metadataSchema,
        response: { 200: assetSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const updated = await repo.update(request.workspaceId, request.params.id, {
        metadata: request.body,
        replaceMetadata: true
      });
      if (!updated) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(updated);
    }
  );

  // -------------------------------------------------------------------------
  // Multi-language audio & subtitle tracks (issue #18).
  //
  // Tracks are EDITORIAL metadata stored as structured arrays on the asset, not
  // a processing-pipeline feature. All routes are workspace-scoped and behind
  // `authenticate`; a foreign/unknown asset resolves to 404 (existence is not
  // leaked). Track ids are server-generated (randomUUID) and used to address a
  // single track for removal. `language` is a free-form BCP-47 string.
  //
  // Subtitle files live in object storage at
  //   {workspaceId}/subtitles/{assetId}/{trackId}.{format}
  // When MinIO is configured, adding a subtitle track returns a short-lived
  // presigned PUT URL the client uploads the subtitle file to; the object key is
  // recorded on the track immediately so a later upload resolves to it. When
  // storage is not configured the track is still created but `uploadUrl` is
  // omitted from the response.
  // -------------------------------------------------------------------------

  // List an asset's audio + subtitle tracks.
  //   200 — { audioTracks, subtitleTracks } (each possibly empty)
  //   404 — unknown/foreign asset
  app.get(
    '/:id/tracks',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: tracksSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send({
        audioTracks: asset.audioTracks ?? [],
        subtitleTracks: asset.subtitleTracks ?? []
      });
    }
  );

  // Add an audio track. Returns the updated full audio track list.
  //   201 — track added, updated list returned
  //   404 — unknown/foreign asset
  app.post(
    '/:id/audio-tracks',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        body: addAudioTrackSchema,
        response: {
          201: z.object({ audioTracks: z.array(audioTrackOutSchema) }),
          404: errorSchema
        }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const track: AssetAudioTrack = {
        id: randomUUID(),
        language: request.body.language,
        codec: request.body.codec,
        channels: request.body.channels,
        label: request.body.label,
        default: request.body.default
      };
      const audioTracks = [...(asset.audioTracks ?? []), track];
      await repo.update(request.workspaceId, asset.id, { audioTracks });
      return reply.code(201).send({ audioTracks });
    }
  );

  // Remove an audio track by id.
  //   204 — removed
  //   404 — unknown/foreign asset, or no track with that id
  app.delete(
    '/:id/audio-tracks/:trackId',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string(), trackId: z.string() }),
        response: { 204: z.null(), 404: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const existing = asset.audioTracks ?? [];
      const audioTracks = existing.filter((t) => t.id !== request.params.trackId);
      if (audioTracks.length === existing.length) {
        return reply.code(404).send({ error: 'not_found', message: 'audio track not found' });
      }
      await repo.update(request.workspaceId, asset.id, { audioTracks });
      return reply.code(204).send(null);
    }
  );

  // Add a subtitle track. When object storage is configured the response also
  // carries a presigned PUT `uploadUrl` for the subtitle file at
  // {workspaceId}/subtitles/{assetId}/{trackId}.{format}; the object key is
  // recorded on the track immediately.
  //   201 — track added; { track, uploadUrl? }
  //   404 — unknown/foreign asset
  app.post(
    '/:id/subtitle-tracks',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        body: addSubtitleTrackSchema,
        response: {
          201: z.object({ track: subtitleTrackOutSchema, uploadUrl: z.string().optional() }),
          404: errorSchema
        }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const trackId = randomUUID();
      // Workspace-local object key (the storage layer namespaces by workspace,
      // so we do NOT prefix the workspaceId here — it is added on signing).
      const objectKey = `subtitles/${asset.id}/${trackId}.${request.body.format}`;

      let uploadUrl: string | undefined;
      if (storageFor) {
        uploadUrl = await storageFor(request.workspaceId).presignedPut(objectKey);
      }

      const track: SubtitleTrack = {
        id: trackId,
        language: request.body.language,
        format: request.body.format,
        // Record the key even before upload so a GET resolves it; the key is
        // only meaningful once the client PUTs the file to `uploadUrl`.
        objectKey: storageFor ? objectKey : undefined,
        label: request.body.label,
        default: request.body.default
      };
      const subtitleTracks = [...(asset.subtitleTracks ?? []), track];
      await repo.update(request.workspaceId, asset.id, { subtitleTracks });
      return reply.code(201).send(uploadUrl ? { track, uploadUrl } : { track });
    }
  );

  // Remove a subtitle track by id. Leaves the subtitle object (if any) in
  // storage; storage reclamation is a separate lifecycle concern.
  //   204 — removed
  //   404 — unknown/foreign asset, or no track with that id
  app.delete(
    '/:id/subtitle-tracks/:trackId',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string(), trackId: z.string() }),
        response: { 204: z.null(), 404: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const existing = asset.subtitleTracks ?? [];
      const subtitleTracks = existing.filter((t) => t.id !== request.params.trackId);
      if (subtitleTracks.length === existing.length) {
        return reply.code(404).send({ error: 'not_found', message: 'subtitle track not found' });
      }
      await repo.update(request.workspaceId, asset.id, { subtitleTracks });
      return reply.code(204).send(null);
    }
  );

  // Append one or more tags to an asset (issue #11). Existing tags are kept and
  // the resulting list is deduplicated (first-seen order). Idempotent.
  //   200 — full asset with the updated tag list; 404 — unknown/foreign asset
  app.post(
    '/:id/tags',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ tags: z.array(tagSchema).min(1).max(128) }),
        response: { 200: assetSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const merged = normalizeTags([...(asset.tags ?? []), ...request.body.tags]);
      const updated = await repo.update(request.workspaceId, request.params.id, { tags: merged });
      if (!updated) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(updated);
    }
  );

  // Remove a single tag from an asset (issue #11). Removing an absent tag is a
  // no-op (still 200).
  //   200 — full asset with the updated tag list; 404 — unknown/foreign asset
  app.delete(
    '/:id/tags/:tag',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string(), tag: z.string().min(1) }),
        response: { 200: assetSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.workspaceId, request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const remaining = (asset.tags ?? []).filter((t) => t !== request.params.tag);
      const updated = await repo.update(request.workspaceId, request.params.id, {
        tags: remaining
      });
      if (!updated) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(updated);
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
