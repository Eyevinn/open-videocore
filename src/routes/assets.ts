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
  ASSET_REVIEW_STATES,
  ASSET_STATUSES,
  HasChildrenError,
  InMemoryAssetRepository,
  InvalidReviewTransitionError,
  InvalidStateTransitionError,
  ParentNotFoundError,
  isUlid,
  normalizeTags,
  SUBTITLE_FORMATS,
  type AssetAudioTrack,
  type AssetRepository,
  type SubtitleTrack
} from '../data/asset-repo.js';
import { WorkspaceAccessError } from '../data/guard.js';
import { DEPLOYMENT_CONTEXT } from '../auth/workspace.js';
import { InMemoryJobRepository, type JobRepository } from '../data/job-repo.js';
import {
  SourceTooLargeError,
  WorkspaceStorage,
  deliveryUrlTtlSeconds,
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
  generateSubtitles,
  type GenerateSubtitlesDeps,
  type SubtitleGenerator
} from '../pipeline/subtitle-generator.js';
import {
  detectScenes,
  type DetectScenesDeps,
  type SceneDetector
} from '../pipeline/scene-detector.js';
import {
  BUILT_IN_PIPELINES,
  PIPELINE_NAMES,
  type PipelineStepName
} from '../pipeline/pipelines.js';
import type { PipelineRepository, StepExecution } from '../data/pipeline-repo.js';
import { InMemoryCommentRepository, type CommentRepository } from '../data/comment-repo.js';
import {
  extractThumbnails,
  type ExtractThumbnailsDeps,
  type FrameExtractor
} from '../pipeline/thumbnail.js';
import { clip as runClip, type ClipDeps, type ClipRunner } from '../pipeline/clip.js';
import type { EncoreClient } from '../pipeline/encore-client.js';
import { decodeEncoreJobId } from '../data/job-repo.js';
import { keys, type EncoreInstanceRecord } from '../encore-scaler/types.js';
import type { EncoreProfile } from '../pipeline/encode-presets.js';
import {
  rewrap,
  REWRAP_FORMATS,
  UnsupportedFormatError,
  type RewrapDeps,
  type RewrapRunner
} from '../pipeline/rewrap.js';

const statusSchema = z.enum(ASSET_STATUSES);

// Editorial review state (issue #134), distinct from lifecycle `status`.
const reviewStateSchema = z.enum(ASSET_REVIEW_STATES);

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
    profile: z.string().min(1).optional(),
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
  // Optional caller-supplied slug (issue #131). Bounded; the repository
  // normalizes it and appends a numeric suffix on collision. When omitted a
  // unique human-readable slug is generated server-side.
  slug: z.string().min(1).max(256).optional(),
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

// Unified files view (issue #119). A DERIVED / projection read model over the
// asset's existing storage fields — it does NOT change how assets are stored.
// A `file` is a single downloadable object; its `url` is a presigned GET so a
// caller can download without MinIO credentials. `objectKey` is retained so the
// caller can correlate the presigned URL back to the underlying storage key.
// A `fileGroup` is a multi-file streaming package (HLS/DASH) addressed by a
// single manifest URL rather than a per-segment presigned URL.
const assetFileSchema = z.object({
  id: z.string(),
  type: z.enum(['source', 'rendition', 'export']),
  name: z.string(),
  format: z.string(),
  objectKey: z.string(),
  url: z.string(),
  sizeBytes: z.number().optional(),
  label: z.string().optional(),
  width: z.number().optional(),
  height: z.number().optional(),
  bitrateBps: z.number().optional(),
  codec: z.string().optional()
});

const assetFileGroupSchema = z.object({
  id: z.string(),
  type: z.enum(['hls-package', 'dash-package']),
  name: z.string(),
  manifestUrl: z.string(),
  segmentCount: z.number().optional(),
  objectKeyPrefix: z.string()
});

const assetFilesSchema = z.object({
  files: z.array(assetFileSchema),
  fileGroups: z.array(assetFileGroupSchema)
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
  outputName: z.string().min(1).max(256).optional(),
  // Version-chain linkage (issue #118). Optional; defaults to false so existing
  // callers get today's behavior (a disconnected parentId child). When true the
  // export is additionally recorded as a version of the source asset.
  asVersion: z.boolean().optional()
});
// Clip / trim request (issue #17): a time window in seconds. `endSeconds` must
// be strictly greater than `startSeconds`. Optional `outputName` names the new
// child asset.
const clipBodySchema = z
  .object({
    startSeconds: z.number().min(0),
    endSeconds: z.number().positive(),
    outputName: z.string().min(1).max(256).optional(),
    // Version-chain linkage (issue #118). Optional; defaults to false so
    // existing callers get today's behavior (a disconnected parentId child).
    // When true the clip is additionally recorded as a version of the source.
    asVersion: z.boolean().optional()
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

// Scene/shot-detection metadata (issue #115). Boundary fields are all optional
// because the eyevinn-function-scenes runtime wire shape is not contract-verified
// (see pipeline/scene-detector.ts), so a boundary may carry only a subset.
const sceneBoundarySchema = z.object({
  startSeconds: z.number().optional(),
  endSeconds: z.number().optional(),
  keyframeSeconds: z.number().optional()
});
const sceneMetadataSchema = z.object({
  boundaries: z.array(sceneBoundarySchema),
  sceneCount: z.number(),
  detectedAt: z.string()
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
  name: z.string(),
  // Human-readable, URL-safe slug (issue #131). Present on assets created after
  // slugs were introduced; absent/undefined for pre-existing slug-less assets.
  slug: z.string().optional(),
  description: z.string().optional(),
  status: statusSchema,
  // Editorial review state (issue #134), INDEPENDENT of `status`. Optional so
  // pre-existing assets serialized before reviewState existed still validate.
  reviewState: reviewStateSchema.optional(),
  parentId: z.string().optional(),
  // Version-chain linkage (issue #118), DISTINCT from `parentId`. Present only
  // on outputs produced by a clip/export/rewrap run with `asVersion`. Absent on
  // originals and on pre-existing assets serialized before #118.
  versionOfAssetId: z.string().optional(),
  versionGroupId: z.string().optional(),
  objectKey: z.string().optional(),
  statusHistory: z.array(transitionSchema),
  // Technical metadata (issue #6). `null` until the first successful extraction
  // (or after a failed one); `technicalMetadataError` carries the last failure.
  technicalMetadata: technicalMetadataSchema.nullish(),
  technicalMetadataError: z.string().optional(),
  // Scene/shot-detection metadata (issue #115). `null` until the first successful
  // detection (or after a failed one); `sceneDetectionError` carries the last
  // failure. Surfaced here so clip/trim clients read the cut points from GET /:id.
  sceneMetadata: sceneMetadataSchema.nullish(),
  sceneDetectionError: z.string().optional(),
  // Streaming manifest URLs from the packaging pipeline (issue #9). Absent until
  // packaging completes; `packagingError` carries the last packaging failure.
  manifestUrls: manifestUrlsSchema.optional(),
  packagingError: z.string().optional(),
  // ABR renditions produced by transcoding (issue #8, redesigned #79). Absent
  // until a transcode job completes; each entry is an embedded variant of this
  // single asset (no child assets).
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

// A MinIO wrapper factory, supplied by app wiring. Absent in a bare local run,
// in which case URL-pull ingest is disabled (501).
export type StorageFactory = () => WorkspaceStorage;

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
  // Auto-subtitles (issue #114). `subtitleGenerator` calls the OSC
  // eyevinn-auto-subtitles (Whisper) service (a stub in tests). When absent (or
  // no object storage), the OPTIONAL `subtitles` pipeline step skips gracefully —
  // it is fire-and-forget and never throws into the ingest path.
  subtitleGenerator?: SubtitleGenerator;
  // Injectable orchestrator runner + extra deps (tests stub the generator/TTL).
  // Defaults to the real fire-and-forget generator.
  generateSubtitles?: typeof generateSubtitles;
  subtitleDeps?: Partial<GenerateSubtitlesDeps>;
  // Scene detection (issue #115). `sceneDetector` calls the OSC
  // eyevinn-function-scenes media function (a stub in tests). When absent (or no
  // object storage), the OPTIONAL `scene-detect` pipeline step skips gracefully —
  // it is fire-and-forget and never throws into the ingest/pipeline path.
  sceneDetector?: SceneDetector;
  // Injectable orchestrator runner + extra deps (tests stub the detector/TTL).
  // Defaults to the real fire-and-forget detector.
  detectScenes?: typeof detectScenes;
  sceneDetectDeps?: Partial<DetectScenesDeps>;
  // Encore transcode client (issue #8). When absent, POST /:id/transcode
  // responds 501 (Encore not configured on this deployment).
  encore?: EncoreClient;
  // S3 bucket names Encore reads the source from / writes renditions to.
  sourceBucket?: string;
  outputBucket?: string;
  // Thumbnail / poster-frame extraction (issue #7). Factory receives the
  // workspace's s3Config so the OSC ffmpeg job can write directly to the right
  // MinIO bucket. When absent (or no object storage), the thumbnail routes respond 501.
  thumbnailExtractor?: FrameExtractor | ((s3Config: { endpoint: string; accessKey: string; secretKey: string; bucket: string }) => FrameExtractor);
  // Injectable extractor runner + extra deps (tests stub the extractor/TTL).
  // Defaults to the real awaited extractor.
  extractThumbnails?: typeof extractThumbnails;
  thumbnailDeps?: Partial<ExtractThumbnailsDeps>;
  // Deprecated (issue #113): thumbnail listing now always returns API proxy
  // URLs (/api/v1/assets/:id/thumbnails/:index), so this option is inert and no
  // longer read by the GET handler. Retained only so existing callers/tests
  // that still pass it continue to type-check.
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
  // HLS/DASH packaging (issue #9). When present, POST /:id/package is enabled.
  packaging?: import('../pipeline/packaging.js').PackagingService;
  // Redis for resolving Encore instance URL at packaging time.
  packagingRedis?: import('ioredis').Redis;
  // On-demand packager provisioning (epic #226, issue #244). Invoked the first
  // time a pipeline reaches a `package` step: it provisions + wires the Encore
  // packager to the shared queue and output storage if absent, waits for
  // readiness, then resolves — so the packaging job is only enqueued once the
  // packager is live. Idempotent + concurrency-safe (issue #245): subsequent
  // executions reuse the running instance. When absent (e.g. the stack Valkey is
  // not active, or in tests that pre-wire packaging), packaging proceeds without
  // an ensure step. Throwing rejects the pipeline's package step with a 502.
  ensurePackaging?: () => Promise<void>;
  // PipelineExecution tracking (POST /:id/execute). When absent, the execute
  // route and pipeline-mode packaging respond 501.
  pipelineRepository?: PipelineRepository;
  // Asset comments (issue #135). Injectable for tests; defaults to an in-memory
  // repository so the comments sub-resource always works.
  commentRepository?: CommentRepository;
};

// PipelineExecution response schemas (POST /:id/execute, GET /:id/executions).
const stepStatusSchema = z.enum(['pending', 'running', 'done', 'failed']);
const stepExecutionSchema = z.object({
  name: z.enum(['extract-metadata', 'thumbnail', 'subtitles', 'scene-detect', 'transcode', 'package']),
  status: stepStatusSchema,
  jobId: z.string().optional(),
  encoreJobId: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  progress: z.number().optional()
});
const pipelineExecutionSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  pipelineName: z.string(),
  status: z.enum(['running', 'done', 'failed']),
  steps: z.array(stepExecutionSchema),
  createdAt: z.string(),
  updatedAt: z.string()
});

// Asset comments (issue #135). Free-text `body` only for this iteration; the
// naming mirrors the Comment model in src/data/comment-repo.ts. The trailing
// trim + min(1) rejects empty / whitespace-only bodies with 400.
const commentBodySchema = z.object({
  body: z.string().trim().min(1).max(4096)
});
const commentSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  body: z.string(),
  createdAt: z.string()
});

const ingestUrlSchema = z.object({
  sourceUrl: z.string().min(1).max(4096),
  name: z.string().min(1).max(256).optional(),
  description: z.string().max(2048).optional()
});

const ingestAcceptedSchema = z.object({
  assetId: z.string(),
  jobId: z.string()
});

// Resolve the Encore job URL for packaging by looking up the instance URL from
// the Redis pool using the encoreJobId → instanceId → EncoreInstanceRecord chain.
// Returns undefined when the instance is no longer in the pool.
async function resolveEncoreJobUrlForPackaging(
  encoreJobId: string,
  redis: import('ioredis').Redis | undefined
): Promise<string | undefined> {
  if (!redis) return undefined;
  const decoded = decodeEncoreJobId(encoreJobId);
  if (!decoded) return undefined;
  const instanceId = await redis.hget(keys.jobInstance(decoded.workspaceId), encoreJobId);
  if (!instanceId) return undefined;
  const [instanceJson, encoreUuid] = await Promise.all([
    redis.hget(keys.pool(decoded.workspaceId), instanceId),
    redis.get(keys.jobUuid(encoreJobId))
  ]);
  if (!instanceJson || !encoreUuid) return undefined;
  try {
    const record = JSON.parse(instanceJson) as EncoreInstanceRecord;
    return `${record.url.replace(/\/+$/, '')}/encoreJobs/${encoreUuid}`;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Files-view helpers (issue #119). Pure, derive display fields from object keys
// and manifest URLs. None of these mutate the asset — the endpoint is a read
// projection only.
// ---------------------------------------------------------------------------

// The last path segment of a MinIO object key, used as a human file name (e.g.
// `sources/<id>/master.mp4` -> `master.mp4`). Falls back to the whole key.
// Parse an `s3://bucket/key` URI into its parts. Renditions written by Encore
// carry this format because Encore writes to a configurable S3 output bucket
// that may differ from the source bucket (ADR-001). Returns null for plain
// object keys (no scheme prefix) so callers can use the source-bucket storage.
function parseS3Uri(uri: string): { bucket: string; key: string } | null {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) return null;
  return { bucket: match[1], key: match[2] };
}

function fileNameFromKey(key: string): string {
  const trimmed = key.replace(/\/+$/, '');
  const segment = trimmed.slice(trimmed.lastIndexOf('/') + 1);
  return segment || key;
}

// Container format inferred from an object key's file extension (e.g.
// `.../master.mp4` -> `mp4`). Asset renditions and source keys do not carry an
// explicit format field, so it is derived from the stored key. Returns an empty
// string when the key has no extension (schema `format` stays a plain string).
function formatFromKey(key: string): string {
  const name = fileNameFromKey(key);
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) {
    return '';
  }
  return name.slice(dot + 1).toLowerCase();
}

// Derive the object-key prefix backing a streaming package from its manifest
// URL — the manifest's parent "directory" (e.g.
// `https://minio/packaged/<id>/hls/master.m3u8` -> `packaged/<id>/hls/`). The
// URL path is used when parseable; otherwise the raw string is treated as a
// path. Segment objects live under this prefix.
function objectKeyPrefixFromManifest(manifestUrl: string): string {
  let path = manifestUrl;
  try {
    path = new URL(manifestUrl).pathname;
  } catch {
    // Not an absolute URL; treat the value itself as a path.
  }
  path = path.replace(/^\/+/, '');
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '';
}

export const assetsRouter: FastifyPluginAsync<AssetsRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const repo = opts.repository ?? new InMemoryAssetRepository();
  const jobs = opts.jobRepository ?? new InMemoryJobRepository();
  const comments = opts.commentRepository ?? new InMemoryCommentRepository();
  const runner = opts.runPull ?? runPull;
  const extractRunner = opts.extract ?? extractTechnicalMetadata;
  const subtitleRunner = opts.generateSubtitles ?? generateSubtitles;
  const sceneDetectRunner = opts.detectScenes ?? detectScenes;
  const thumbnailRunner = opts.extractThumbnails ?? extractThumbnails;
  const rewrapRunner = opts.rewrap ?? rewrap;
  const clipRunnerOrchestrator = opts.clip ?? runClip;
  const storageFor = opts.storageFor;

  // Fire-and-forget technical metadata extraction (issue #6). Detached, never
  // blocks the caller, and the extractor itself never throws (records failures
  // on the asset). No-op when the probe runner or object storage is not
  // configured. Returns true when an extraction was actually kicked off.
  function triggerExtraction(assetId: string, objectKey: string): boolean {
    if (!opts.probe || !storageFor) {
      return false;
    }
    void extractRunner(
      { assetId, objectKey },
      {
        assets: repo,
        storage: storageFor(),
        probe: opts.probe,
        ...opts.extractDeps
      }
    );
    return true;
  }

  // Fire-and-forget auto-subtitle generation for a pipeline step (issue #114).
  // Detached, never blocks the caller, and the generator itself never throws
  // (records failures on the asset as `subtitlesError`). No-op when the OSC
  // auto-subtitles service or object storage is not configured — consistent with
  // the OPTIONAL, opt-in nature of the step. Returns true when a generation was
  // actually kicked off (false = skipped gracefully).
  function triggerSubtitles(assetId: string, objectKey: string): boolean {
    if (!opts.subtitleGenerator || !storageFor) {
      return false;
    }
    void subtitleRunner(
      { assetId, objectKey },
      {
        assets: repo,
        storage: storageFor(),
        generate: opts.subtitleGenerator,
        ...opts.subtitleDeps
      }
    );
    return true;
  }

  // Fire-and-forget scene/shot detection for a pipeline step (issue #115).
  // Detached, never blocks the caller, and the detector itself never throws
  // (records failures on the asset as `sceneDetectionError`). No-op when the OSC
  // eyevinn-function-scenes service or object storage is not configured —
  // consistent with the OPTIONAL, opt-in nature of the step. Returns true when a
  // detection was actually kicked off (false = skipped gracefully).
  function triggerSceneDetect(assetId: string, objectKey: string): boolean {
    if (!opts.sceneDetector || !storageFor) {
      return false;
    }
    void sceneDetectRunner(
      { assetId, objectKey },
      {
        assets: repo,
        storage: storageFor(),
        detect: opts.sceneDetector,
        ...opts.sceneDetectDeps
      }
    );
    return true;
  }

  // Fire-and-forget thumbnail extraction for a pipeline step. Uses a default
  // poster-frame timecode (1s in). No-op when thumbnails are not configured.
  function triggerThumbnail(assetId: string, objectKey: string, request: import('fastify').FastifyRequest): boolean {
    if (!opts.thumbnailExtractor || !storageFor) {
      return false;
    }
    const s3Cfg = request.connections?.s3Config;
    const resolvedExtractor =
      typeof opts.thumbnailExtractor === 'function' && s3Cfg
        ? (opts.thumbnailExtractor as (s3: { endpoint: string; accessKey: string; secretKey: string; bucket: string }) => FrameExtractor)({
            ...s3Cfg,
            bucket: request.connections?.sourceBucket ?? 'openvideocore-source'
          })
        : (opts.thumbnailExtractor as FrameExtractor);
    void thumbnailRunner(
      { assetId, objectKey, timecodes: [1] },
      { assets: repo, storage: storageFor(), extractor: resolvedExtractor, ...opts.thumbnailDeps }
    ).catch(() => {
      /* thumbnail failures are recorded on the asset by the runner */
    });
    return true;
  }

  // Start a named built-in pipeline against an asset, executing the first step
  // immediately. Returns the created PipelineExecution, or undefined after
  // having sent an error response via `reply`. Callers must not send again when
  // undefined is returned.
  //
  // Shared by POST /:id/execute and pipeline-mode POST /:id/package.
  async function startPipelineExecution(
    asset: NonNullable<Awaited<ReturnType<AssetRepository['get']>>>,
    pipelineName: keyof typeof BUILT_IN_PIPELINES,
    request: import('fastify').FastifyRequest,
    reply: import('fastify').FastifyReply,
    encodeOpts?: { profile?: string; customProfile?: EncoreProfile }
  ): Promise<import('../data/pipeline-repo.js').PipelineExecution | undefined> {
    const pipelineRepo = opts.pipelineRepository;
    if (!pipelineRepo) {
      reply.code(501).send({ error: 'not_configured', message: 'pipeline execution not configured' });
      return undefined;
    }
    const steps = BUILT_IN_PIPELINES[pipelineName];

    // Reject if a pipeline is already running for this asset.
    const existing = await pipelineRepo.listByAsset(asset.id);
    if (existing.some((e) => e.status === 'running')) {
      reply.code(409).send({ error: 'pipeline_running', message: 'a pipeline is already running for this asset' });
      return undefined;
    }

    const firstStep = steps[0];

    // Pre-flight the first step's requirements before creating the execution so
    // an un-runnable pipeline never leaves a dangling running execution.
    if (firstStep === 'transcode' || firstStep === 'package') {
      if (firstStep === 'transcode' && (!opts.encore || !opts.sourceBucket || !opts.outputBucket)) {
        reply.code(501).send({ error: 'not_configured', message: 'transcoding is not configured' });
        return undefined;
      }
      if (firstStep === 'package' && !opts.packaging) {
        reply.code(501).send({ error: 'not_configured', message: 'packaging is not configured' });
        return undefined;
      }
      if (!asset.objectKey) {
        reply.code(409).send({ error: 'no_object', message: 'asset has no stored object to process' });
        return undefined;
      }
    }
    if (
      (firstStep === 'extract-metadata' ||
        firstStep === 'thumbnail' ||
        firstStep === 'subtitles' ||
        firstStep === 'scene-detect') &&
      !asset.objectKey
    ) {
      reply.code(409).send({ error: 'no_object', message: 'asset has no stored object to process' });
      return undefined;
    }

    void firstStep; // pre-flight above used firstStep; execution drives the loop
    const execution = await pipelineRepo.create({ assetId: asset.id, pipelineName, steps });
    const now = () => new Date().toISOString();
    const stepsCopy: StepExecution[] = execution.steps.map((s) => ({ ...s }));

    // Execute steps synchronously until we hit an asynchronous step (transcode/
    // package) which completes via an OSC callback, or run out of steps. The
    // fire-and-forget steps (extract-metadata, thumbnail) settle immediately.
    try {
      for (let i = 0; i < stepsCopy.length; i++) {
        const step = stepsCopy[i];
        if (step.name === 'extract-metadata') {
          triggerExtraction(asset.id, asset.objectKey as string);
          stepsCopy[i] = { ...step, status: 'done', startedAt: now(), completedAt: now() };
          continue;
        }
        if (step.name === 'thumbnail') {
          triggerThumbnail(asset.id, asset.objectKey as string, request);
          stepsCopy[i] = { ...step, status: 'done', startedAt: now(), completedAt: now() };
          continue;
        }
        if (step.name === 'subtitles') {
          // Fire-and-forget, exactly like extract-metadata: kick off (or skip
          // gracefully when unconfigured) and settle the step immediately. The
          // generator records its own success/failure on the asset and never
          // throws into this loop, so the step never fails the pipeline.
          triggerSubtitles(asset.id, asset.objectKey as string);
          stepsCopy[i] = { ...step, status: 'done', startedAt: now(), completedAt: now() };
          continue;
        }
        if (step.name === 'scene-detect') {
          // Fire-and-forget, exactly like extract-metadata/subtitles: kick off (or
          // skip gracefully when unconfigured) and settle the step immediately. The
          // detector records its own success/failure on the asset and never throws
          // into this loop, so the step never fails the pipeline.
          triggerSceneDetect(asset.id, asset.objectKey as string);
          stepsCopy[i] = { ...step, status: 'done', startedAt: now(), completedAt: now() };
          continue;
        }
        if (step.name === 'transcode') {
          const result = await submitTranscode(
            {
              workspaceId: DEPLOYMENT_CONTEXT,
              sourceAssetId: asset.id,
              sourceObjectKey: asset.objectKey as string,
              sourceBucket: opts.sourceBucket as string,
              outputBucket: opts.outputBucket as string,
              preset: encodeOpts?.profile,
              customProfile: encodeOpts?.customProfile
            },
            { jobs, assets: repo, encore: opts.encore! }
          );
          stepsCopy[i] = {
            ...step,
            status: 'running',
            jobId: result.jobId,
            encoreJobId: result.encoreJobId,
            startedAt: now()
          };
          break; // async — advanced by encore-callback
        }
        if (step.name === 'package') {
          // On-demand packager provisioning (epic #226, issue #244): ensure the
          // Encore packager is provisioned + wired + ready BEFORE enqueueing the
          // packaging job, so the job is never dropped onto a queue no consumer
          // is reading. Idempotent/concurrency-safe (issue #245): a reused
          // running instance returns immediately. When no ensure hook is wired
          // (the queue stack isn't active, or a test pre-wires packaging) this is
          // skipped and packaging proceeds as before. A provisioning failure
          // throws into the surrounding try/catch and fails the package step.
          if (opts.ensurePackaging) {
            await opts.ensurePackaging();
          }
          void opts.packaging!.triggerPackaging(asset.id, '');
          stepsCopy[i] = { ...step, status: 'running', startedAt: now() };
          break; // async — advanced by packager callback
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const idx = stepsCopy.findIndex((s) => s.status === 'pending');
      const failIdx = idx >= 0 ? idx : stepsCopy.length - 1;
      stepsCopy[failIdx] = { ...stepsCopy[failIdx], status: 'failed', error: message, startedAt: now(), completedAt: now() };
      await pipelineRepo.update(execution.id, { steps: stepsCopy, status: 'failed' });
      reply.code(502).send({ error: 'pipeline_step_failed', message });
      return undefined;
    }

    // All steps settled synchronously with none running/pending -> done.
    const allDone = stepsCopy.every((s) => s.status === 'done');
    const updated = await pipelineRepo.update(execution.id, {
      steps: stepsCopy,
      status: allDone ? 'done' : 'running'
    });
    return updated ?? { ...execution, steps: stepsCopy };
  }

  // Map domain errors to HTTP status codes for this router.
  app.setErrorHandler((err, _request, reply) => {
    if (err instanceof WorkspaceAccessError) {
      return reply.code(err.statusCode).send({ error: 'forbidden', message: err.message });
    }
    if (err instanceof InvalidStateTransitionError) {
      return reply.code(422).send({ error: 'invalid_state_transition', message: err.message });
    }
    if (err instanceof InvalidReviewTransitionError) {
      return reply.code(422).send({ error: 'invalid_review_transition', message: err.message });
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


  app.post(
    '/',
    { schema: { body: createSchema, response: { 201: assetSchema } } },
    async (request, reply) => {
      const asset = await repo.create(request.body);
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

      const asset = await repo.create({
        name: name ?? fallbackName,
        description
      });
      const objectKey = `ingest/${asset.id}`;
      await repo.update(asset.id, { objectKey });

      const job = await jobs.create({
        type: 'ingest-url',
        assetId: asset.id,
        sourceUrl
      });

      // Detached, non-blocking. runPull never throws (records failures on the
      // job), so an unhandled rejection cannot crash the process. Once the pull
      // reaches a terminal state we fire-and-forget technical metadata
      // extraction against the now-stored object (issue #6); we only extract if
      // the asset actually advanced to `processing` (pull succeeded).
      void runner(
        { jobId: job.id, assetId: asset.id, objectKey, sourceUrl },
        { jobs, assets: repo, storage: storageFor(), ...opts.pullDeps }
      ).then(async () => {
        const settled = await repo.get(asset.id);
        if (settled?.status === 'processing') {
          triggerExtraction(asset.id, objectKey);
        }
      });

      return reply.code(202).send({ assetId: asset.id, jobId: job.id });
    }
  );

  app.get(
    '/',
    { schema: { querystring: listQuerySchema, response: { 200: listSchema } } },
    async (request) => {
      return repo.list(request.query);
    }
  );

  app.get(
    '/search',
    {
      
      schema: {
        querystring: z.object({ q: z.string().min(1) }),
        response: { 200: z.object({ items: z.array(assetSchema) }) }
      }
    },
    async (request) => {
      const items = await repo.search(request.query.q);
      return { items };
    }
  );

  // Resolve a path `:id` that may be either the ULID id or the human-readable
  // slug (issue #132), scoped to the caller's workspace. A value shaped like a
  // ULID resolves by id; otherwise (or when the id lookup misses) it falls back
  // to a slug lookup. Both lookups go through the workspace-scoped repository, so
  // the 404 semantics are preserved when neither matches. Slugs and ULIDs use
  // disjoint character sets (lowercase-hyphen vs. Crockford base32), so there is
  // no ambiguity between the two.
  async function resolveAsset(
    idOrSlug: string
  ): Promise<Awaited<ReturnType<AssetRepository['get']>>> {
    if (isUlid(idOrSlug)) {
      return repo.get(idOrSlug);
    }
    return repo.getBySlug(idOrSlug);
  }

  app.get(
    '/:id',
    {

      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: assetSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await resolveAsset(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(asset);
    }
  );

  // Enumerate every version in an asset's version chain (issue #118).
  // Workspace-scoped and behind `authenticate`. Returns all assets sharing the
  // target's `versionGroupId`, oldest first, so a client can "show all versions
  // of this asset", compare, or roll back. An asset that has never participated
  // in a clip/export/rewrap version chain returns just itself (single-member
  // chain). DISTINCT from ?parentId= listing, which enumerates rendition/child
  // hierarchy, not edit versions.
  //   200 — the version chain (always includes the target); 404 — unknown asset
  app.get(
    '/:id/versions',
    {
      schema: {
        params: z.object({ id: z.string() }),
        response: {
          200: z.object({ assetId: z.string(), versions: z.array(assetSchema) }),
          404: errorSchema
        }
      }
    },
    async (request, reply) => {
      const versions = await repo.listVersions(request.params.id);
      if (!versions) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send({ assetId: request.params.id, versions });
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
      
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: deliverySchema, 404: errorSchema, 501: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.params.id);
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
        const source = await storageFor().presignedGet(asset.objectKey, ttl);
        return reply.code(200).send({ assetId: asset.id, urls: { source }, expiresAt });
      }

      // Nothing to deliver yet (no packaged output and no stored source object).
      return reply.code(404).send({
        error: 'no_delivery',
        message: 'asset has no packaged output or stored source object to deliver'
      });
    }
  );

  // Unified files view (issue #119). A DERIVED / additive read model that folds
  // the asset's three separate storage fields into one shape callers can consume
  // without reassembling it themselves:
  //   - `objectKey`   (the stored source)      -> one `file` of type `source`
  //   - each `renditions[]` entry (issue #8)   -> a `file` of type `rendition`
  //   - `manifestUrls` (HLS/DASH, issue #9)    -> `fileGroups`
  // The legacy fields on the asset are UNCHANGED — this endpoint never writes.
  // Each `file` carries a PRESIGNED GET `url` (minted the same way as the
  // /:id/delivery source fallback above) so a caller downloads without MinIO
  // creds. Package manifests are already public CMAF URLs, so `fileGroups` carry
  // the manifest URL directly (no per-segment signing).
  //   200 — the projection (files / fileGroups may each be empty)
  //   404 — unknown/foreign asset (existence not leaked; matches sibling routes)
  //   501 — one or more files need presigning but object storage is not
  //         configured here (same not_configured convention as /:id/delivery)
  app.get(
    '/:id/files',
    {
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: assetFilesSchema, 404: errorSchema, 501: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }

      // Collect the object keys that must be presigned (source + renditions).
      // Groups (manifests) are already-public URLs and need no signing.
      const sourceKey = asset.objectKey;
      const renditions = asset.renditions ?? [];
      const needsPresign = Boolean(sourceKey) || renditions.length > 0;

      // Match /:id/delivery: only 501 when we actually have a key to sign and no
      // storage is configured to sign it. An asset with only manifests (or no
      // files at all) still returns 200 with an empty/group-only projection.
      if (needsPresign && !storageFor) {
        return reply.code(501).send({
          error: 'not_configured',
          message: 'object storage is not configured'
        });
      }

      const ttl = deliveryUrlTtlSeconds();
      const storage = storageFor ? storageFor() : undefined;

      const files: z.infer<typeof assetFileSchema>[] = [];

      // Source object -> one `source` file. `id` is the fixed literal "source"
      // (an asset has at most one source object), giving a stable, addressable id.
      if (sourceKey) {
        files.push({
          id: 'source',
          type: 'source',
          name: fileNameFromKey(sourceKey),
          format: formatFromKey(sourceKey),
          objectKey: sourceKey,
          // storage is defined here: needsPresign is true so the 501 guard above
          // already returned if storageFor was absent.
          url: await storage!.presignedGet(sourceKey, ttl)
        });
      }

      // Each rendition -> a `rendition` file. The rendition already carries a
      // stable ULID `id` (asset-repo Rendition.id), so the file id is derived
      // deterministically as `rendition:<renditionId>` — stable across calls and
      // unique even if two rungs share a label.
      //
      // Renditions from Encore store their objectKey as an S3 URI
      // (s3://openvideocore-packaged/transcode/<id>/rendition.mp4) because Encore
      // writes to a separate packaged bucket. Parse the URI to get the actual
      // bucket + key and presign from the right storage.
      const storageClient = request.connections?.storageClient;
      for (const r of renditions) {
        const s3Uri = parseS3Uri(r.objectKey);
        let url: string;
        let exposedKey: string;
        if (s3Uri && storageClient) {
          const rendStorage = new WorkspaceStorage(storageClient, s3Uri.bucket);
          url = await rendStorage.presignedGet(s3Uri.key, ttl);
          exposedKey = s3Uri.key;
        } else {
          url = await storage!.presignedGet(r.objectKey, ttl);
          exposedKey = r.objectKey;
        }
        files.push({
          id: `rendition:${r.id}`,
          type: 'rendition',
          name: fileNameFromKey(exposedKey),
          format: formatFromKey(exposedKey),
          objectKey: exposedKey,
          url,
          label: r.label,
          width: r.width,
          height: r.height,
          bitrateBps: r.bitrateBps,
          codec: r.codec
        });
      }

      // manifestUrls -> streaming fileGroups. `id` is the fixed package type so
      // each format yields at most one stable group id ("hls"/"dash"). The
      // objectKeyPrefix is derived from the manifest's path so callers can locate
      // the segment objects that back the package.
      const fileGroups: z.infer<typeof assetFileGroupSchema>[] = [];
      const manifests = asset.manifestUrls;
      if (manifests?.hls) {
        fileGroups.push({
          id: 'hls',
          type: 'hls-package',
          name: 'HLS',
          manifestUrl: manifests.hls,
          objectKeyPrefix: objectKeyPrefixFromManifest(manifests.hls)
        });
      }
      if (manifests?.dash) {
        fileGroups.push({
          id: 'dash',
          type: 'dash-package',
          name: 'DASH',
          manifestUrl: manifests.dash,
          objectKeyPrefix: objectKeyPrefixFromManifest(manifests.dash)
        });
      }

      return reply.code(200).send({ files, fileGroups });
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
      const asset = await repo.get(request.params.id);
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
      triggerExtraction(asset.id, asset.objectKey);
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
      const asset = await repo.get(request.params.id);
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
            workspaceId: DEPLOYMENT_CONTEXT,
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

  // HLS/DASH packaging (issue #9). Workspace-scoped and behind `authenticate`.
  // `encoreJobId` is optional:
  //   - Provided: enqueues that specific Encore job for CMAF packaging directly.
  //   - Omitted: "pipeline mode" — starts an abr-vod PipelineExecution
  //     (transcode then package) and tracks progress there. Equivalent to
  //     POST /:id/execute { pipeline: 'abr-vod' }.
  //
  //   202 — packaging enqueued (or pipeline started)
  //   404 — unknown/foreign asset (existence not leaked)
  //   409 — pipeline already running / job not found / instance unavailable
  //   501 — required service not configured on this deployment
  //   502 — Encore submission failed
  app.post(
    '/:id/package',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ encoreJobId: z.string().min(1).optional() }),
        response: {
          202: z.object({ ok: z.literal(true), jobId: z.string().optional(), pipelineMode: z.boolean().optional() }),
          404: z.object({ error: z.string() }),
          409: z.object({ error: z.string(), message: z.string() }),
          501: z.object({ error: z.string(), message: z.string() }),
          502: z.object({ error: z.string(), message: z.string() })
        }
      }
    },
    async (request, reply) => {
      if (!opts.packaging) {
        return reply.code(501).send({ error: 'not_configured', message: 'packaging is not configured' });
      }
      const asset = await repo.get((request.params as { id: string }).id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }

      const { encoreJobId } = request.body;

      // Pipeline mode: auto-transcode then package. Tracked as a first-class
      // PipelineExecution (abr-vod = [transcode, package]) rather than ad-hoc
      // fields on the asset.
      if (!encoreJobId) {
        if (!opts.encore) {
          return reply.code(501).send({ error: 'not_configured', message: 'transcode not configured — cannot start pipeline' });
        }
        if (!opts.pipelineRepository) {
          return reply.code(501).send({ error: 'not_configured', message: 'pipeline execution not configured' });
        }
        const started = await startPipelineExecution(asset, 'abr-vod', request, reply);
        if (!started) return reply; // startPipelineExecution already sent the error
        return reply.code(202).send({ ok: true, jobId: started.steps.find((s) => s.name === 'transcode')?.jobId, pipelineMode: true });
      }

      // Explicit encoreJobId: enqueue for packaging immediately.
      const found = await jobs.findByEncoreJobId(encoreJobId);
      if (!found || found.job.assetId !== asset.id) {
        return reply.code(409).send({ error: 'job_not_found', message: 'encoreJobId not found for this asset' });
      }
      // Resolve the Encore instance URL + UUID from Redis. Both must be present
      // (stored at dispatch time). If the instance has been scaled down, packaging
      // cannot proceed — the Encore job data is only accessible while the instance runs.
      const encoreJobUrl = await resolveEncoreJobUrlForPackaging(encoreJobId, opts.packagingRedis);
      if (!encoreJobUrl) {
        return reply.code(409).send({ error: 'instance_not_found', message: 'Encore instance no longer in pool — cannot resolve job URL for packaging' });
      }
      // On-demand packager provisioning (epic #226, issue #244): the direct
      // package path also ensures the packager is live before enqueueing, so a
      // job is never dropped onto an unconsumed queue. Idempotent/concurrency-
      // safe (#245). A provisioning failure surfaces as 502.
      if (opts.ensurePackaging) {
        try {
          await opts.ensurePackaging();
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return reply.code(502).send({ error: 'packager_provisioning_failed', message });
        }
      }
      void opts.packaging.triggerPackaging(asset.id, encoreJobUrl);
      return reply.code(202).send({ ok: true });
    }
  );

  // Execute a named built-in pipeline against an asset (PipelineExecution).
  // The primary way to process an asset: runs the pipeline's steps, tracking
  // progress as a first-class PipelineExecution. The first step runs immediately;
  // asynchronous steps (transcode/package) advance via OSC callbacks.
  //   202 — pipeline execution created
  //   404 — unknown asset
  //   409 — a pipeline is already running / asset has no stored object
  //   501 — pipeline execution or the required OSC service is not configured
  //   502 — the first step's submission failed
  app.post(
    '/:id/execute',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({
          pipeline: z.enum(PIPELINE_NAMES as [string, ...string[]]),
          profile: z.string().min(1).optional(),
          customProfile: customProfileSchema.optional()
        }),
        response: {
          202: pipelineExecutionSchema,
          404: z.object({ error: z.string() }),
          409: errorSchema,
          501: errorSchema,
          502: errorSchema
        }
      }
    },
    async (request, reply) => {
      if (!opts.pipelineRepository) {
        return reply.code(501).send({ error: 'not_configured', message: 'pipeline execution is not configured' });
      }
      const asset = await repo.get(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const started = await startPipelineExecution(
        asset,
        request.body.pipeline as keyof typeof BUILT_IN_PIPELINES,
        request,
        reply,
        { profile: request.body.profile, customProfile: request.body.customProfile as EncoreProfile | undefined }
      );
      if (!started) return reply; // error already sent
      return reply.code(202).send(started);
    }
  );

  // List all pipeline executions for an asset.
  //   200 — array of executions (possibly empty); 404 — unknown asset
  app.get(
    '/:id/executions',
    {
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.array(pipelineExecutionSchema), 404: z.object({ error: z.string() }) }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const executions = opts.pipelineRepository ? await opts.pipelineRepository.listByAsset(asset.id) : [];
      return reply.code(200).send(executions);
    }
  );

  // Get a single pipeline execution.
  //   200 — the execution; 404 — unknown asset or execution
  app.get(
    '/:id/executions/:execId',
    {
      schema: {
        params: z.object({ id: z.string(), execId: z.string() }),
        response: { 200: pipelineExecutionSchema, 404: z.object({ error: z.string() }) }
      }
    },
    async (request, reply) => {
      if (!opts.pipelineRepository) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const execution = await opts.pipelineRepository.get(request.params.execId);
      if (!execution || execution.assetId !== request.params.id) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(execution);
    }
  );

  // GET /:id/pipelines — alias for /:id/executions (issue #161).
  app.get(
    '/:id/pipelines',
    {
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.array(pipelineExecutionSchema), 404: z.object({ error: z.string() }) }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const executions = opts.pipelineRepository ? await opts.pipelineRepository.listByAsset(asset.id) : [];
      return reply.code(200).send(executions);
    }
  );

  // Asset comments (issue #135). Workspace-scoped and behind `authenticate`.
  // Free-text notes attached to an asset; frame-accurate / time-based comments
  // are a later iteration. Matches sibling sub-resources: the parent asset is
  // resolved first and an unknown/foreign asset returns 404 (existence not
  // leaked).
  //
  // POST /:id/comments — create a comment.
  //   201 — the created comment
  //   400 — empty / invalid body (rejected by commentBodySchema)
  //   404 — unknown/foreign asset
  app.post(
    '/:id/comments',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: commentBodySchema,
        response: { 201: commentSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const comment = await comments.create({ assetId: asset.id, body: request.body.body });
      return reply.code(201).send(comment);
    }
  );

  // GET /:id/comments — list comments for an asset, oldest first.
  //   200 — array of comments (possibly empty)
  //   404 — unknown/foreign asset
  app.get(
    '/:id/comments',
    {
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: z.array(commentSchema), 404: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const items = await comments.listByAsset(asset.id);
      return reply.code(200).send(items);
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
      const asset = await repo.get(request.params.id);
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
      // Resolve the extractor: if it's a factory, call it with the workspace's
      // s3Config so the ffmpeg job can write to the right MinIO bucket.
      const s3Cfg = request.connections?.s3Config;
      const resolvedExtractor = typeof opts.thumbnailExtractor === 'function' && s3Cfg
        ? (opts.thumbnailExtractor as (s3: { endpoint: string; accessKey: string; secretKey: string; bucket: string }) => FrameExtractor)({
            ...s3Cfg,
            bucket: request.connections?.sourceBucket ?? 'openvideocore-source'
          })
        : opts.thumbnailExtractor as FrameExtractor;
      try {
        const thumbnails = await thumbnailRunner(
          {
            assetId: asset.id,
            objectKey: asset.objectKey,
            timecodes: request.body.timecodes
          },
          {
            assets: repo,
            storage: storageFor(),
            extractor: resolvedExtractor,
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
      const asset = await repo.get(request.params.id);
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
            sourceAssetId: asset.id,
            objectKey: asset.objectKey,
            targetFormat: request.body.targetFormat,
            outputName: request.body.outputName,
            asVersion: request.body.asVersion
          },
          {
            assets: repo,
            storage: storageFor(),
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
      const asset = await repo.get(request.params.id);
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
            sourceAssetId: asset.id,
            objectKey: asset.objectKey,
            startSeconds: request.body.startSeconds,
            endSeconds: request.body.endSeconds,
            outputName: request.body.outputName,
            asVersion: request.body.asVersion
          },
          {
            assets: repo,
            storage: storageFor(),
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

  // List an asset's thumbnail URLs (issue #7, #113). Returns API proxy URLs of
  // the form /api/v1/assets/:id/thumbnails/:index keyed by array position. The
  // proxy route below streams the object from MinIO using admin credentials, so
  // these URLs work without a public/presigned MinIO URL and match how the asset
  // list card renders thumbnails (public/app.js).
  //   200 — list of thumbnail proxy URLs (possibly empty)
  //   404 — unknown/foreign asset (existence not leaked)
  app.get(
    '/:id/thumbnails',
    {

      schema: {
        params: z.object({ id: z.string() }),
        response: {
          200: z.object({ assetId: z.string(), thumbnails: z.array(z.string()) }),
          404: errorSchema
        }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const keys = asset.thumbnails ?? [];
      const thumbnails = keys.map(
        (_k, i) => `/api/v1/assets/${asset.id}/thumbnails/${i}`
      );
      return reply.code(200).send({ assetId: asset.id, thumbnails });
    }
  );

  // Proxy a single thumbnail image through the API. OSC MinIO blocks anonymous
  // presigned URL access, so the browser cannot load MinIO URLs directly.
  // This endpoint fetches the object using admin credentials and streams it.
  //   200 — image/jpeg stream
  //   404 — unknown asset or out-of-range index
  //   501 — storage not configured
  app.get(
    '/:id/thumbnails/:index',
    {
      
      schema: { params: z.object({ id: z.string(), index: z.string() }) }
    },
    async (request, reply) => {
      if (!storageFor) return reply.code(501).send({ error: 'not_configured' });
      const asset = await repo.get(request.params.id);
      if (!asset) return reply.code(404).send({ error: 'not_found' });
      const keys = asset.thumbnails ?? [];
      const idx = parseInt(request.params.index, 10);
      if (isNaN(idx) || idx < 0 || idx >= keys.length) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const storage = storageFor();
      const stream = await storage.getObject(keys[idx]);
      return reply
        .header('Content-Type', 'image/jpeg')
        .header('Cache-Control', 'public, max-age=86400')
        .send(stream);
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
      
      schema: {
        params: z.object({ id: z.string() }),
        body: metadataSchema,
        response: { 200: assetSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const updated = await repo.update(request.params.id, {
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
      
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: tracksSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.params.id);
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
      const asset = await repo.get(request.params.id);
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
      await repo.update(asset.id, { audioTracks });
      return reply.code(201).send({ audioTracks });
    }
  );

  // Remove an audio track by id.
  //   204 — removed
  //   404 — unknown/foreign asset, or no track with that id
  app.delete(
    '/:id/audio-tracks/:trackId',
    {
      
      schema: {
        params: z.object({ id: z.string(), trackId: z.string() }),
        response: { 204: z.null(), 404: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const existing = asset.audioTracks ?? [];
      const audioTracks = existing.filter((t) => t.id !== request.params.trackId);
      if (audioTracks.length === existing.length) {
        return reply.code(404).send({ error: 'not_found', message: 'audio track not found' });
      }
      await repo.update(asset.id, { audioTracks });
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
      const asset = await repo.get(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const trackId = randomUUID();
      // Workspace-local object key (the storage layer namespaces by workspace,
      // so we do NOT prefix the workspaceId here — it is added on signing).
      const objectKey = `subtitles/${asset.id}/${trackId}.${request.body.format}`;

      let uploadUrl: string | undefined;
      if (storageFor) {
        uploadUrl = await storageFor().presignedPut(objectKey);
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
      await repo.update(asset.id, { subtitleTracks });
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
      
      schema: {
        params: z.object({ id: z.string(), trackId: z.string() }),
        response: { 204: z.null(), 404: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const existing = asset.subtitleTracks ?? [];
      const subtitleTracks = existing.filter((t) => t.id !== request.params.trackId);
      if (subtitleTracks.length === existing.length) {
        return reply.code(404).send({ error: 'not_found', message: 'subtitle track not found' });
      }
      await repo.update(asset.id, { subtitleTracks });
      return reply.code(204).send(null);
    }
  );

  // Append one or more tags to an asset (issue #11). Existing tags are kept and
  // the resulting list is deduplicated (first-seen order). Idempotent.
  //   200 — full asset with the updated tag list; 404 — unknown/foreign asset
  app.post(
    '/:id/tags',
    {
      
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ tags: z.array(tagSchema).min(1).max(128) }),
        response: { 200: assetSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const merged = normalizeTags([...(asset.tags ?? []), ...request.body.tags]);
      const updated = await repo.update(request.params.id, { tags: merged });
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
      
      schema: {
        params: z.object({ id: z.string(), tag: z.string().min(1) }),
        response: { 200: assetSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const remaining = (asset.tags ?? []).filter((t) => t !== request.params.tag);
      const updated = await repo.update(request.params.id, {
        tags: remaining
      });
      if (!updated) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(updated);
    }
  );

  // Transition an asset's editorial review state (issue #134, sub-task of #117).
  // DISTINCT from the lifecycle `status`: this drives a human approval workflow
  // (draft -> in-review -> approved | rejected, with re-review paths) and never
  // touches `status`. Forward-only transitions are validated by the review state
  // machine; an illegal move returns 422 (same mapping as the status machine).
  //   200 — review state transitioned, full asset returned
  //   404 — unknown/foreign asset (existence not leaked)
  //   422 — invalid review-state transition
  app.post(
    '/:id/review-state',
    {
      schema: {
        params: z.object({ id: z.string() }),
        body: z.object({ reviewState: reviewStateSchema }),
        response: { 200: assetSchema, 404: errorSchema, 422: errorSchema }
      }
    },
    async (request, reply) => {
      const updated = await repo.transitionReviewState(request.params.id, request.body.reviewState);
      if (!updated) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(updated);
    }
  );

  app.patch(
    '/:id',
    {

      schema: {
        params: z.object({ id: z.string() }),
        body: updateSchema,
        response: { 200: assetSchema, 404: errorSchema, 422: errorSchema }
      }
    },
    async (request, reply) => {
      const updated = await repo.update(request.params.id, request.body);
      if (!updated) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(updated);
    }
  );

  app.delete(
    '/:id',
    {
      
      schema: {
        params: z.object({ id: z.string() }),
        response: { 204: z.null(), 404: errorSchema, 409: errorSchema }
      }
    },
    async (request, reply) => {
      // Block deletion while children (renditions) still reference this asset.
      const childCount = await repo.countChildren(request.params.id);
      if (childCount > 0) {
        throw new HasChildrenError(request.params.id);
      }
      // Soft delete: archive rather than destroy (see asset-repo / couch-asset-repo).
      const removed = await repo.remove(request.params.id);
      if (!removed) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(204).send(null);
    }
  );
};
