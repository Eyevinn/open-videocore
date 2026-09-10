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
  DeleteProtectedError,
  HasChildrenError,
  InMemoryAssetRepository,
  InvalidReviewTransitionError,
  InvalidStateTransitionError,
  MAX_LIMIT,
  ParentNotFoundError,
  ReferencedByJobError,
  STORAGE_BYTE_CLASSES,
  STORAGE_TIERS,
  defaultStorageTiering,
  isUlid,
  normalizeTags,
  SUBTITLE_FORMATS,
  type Asset,
  type AssetAudioTrack,
  type AssetRepository,
  type PackagedOutput,
  type SubtitleTrack
} from '../data/asset-repo.js';
// Collection membership (issue #570). The asset DELETE route blocks archiving an
// asset that is still a member of one or more collections; the collection repo
// owns the authoritative membership representation (the flat `assetIds` list,
// collection-repo.ts) and the error shape that maps to the shared ADR-020
// `delete_blocked` envelope with reason `member_of_collection`.
import {
  AssetMemberOfCollectionError,
  type CollectionRepository
} from '../data/collection-repo.js';
// TAMS validation primitives (ADR-008, issue #165). Reused, NOT re-declared, so
// the lookup query grammar stays 1:1 with the persisted asset-document grammar.
import { TamsFlowIdSchema, TamsTimerangeSchema } from '../data/asset-document.js';
// TAMS-address query contract (ADR-010, issue #174). #175 is the handler the
// contract module was written for — it consumes the contract's mode resolver
// and error taxonomy rather than re-deriving them, so ADR-010 stays the single
// source of truth for the addressing grammar and the error->status map.
import {
  resolveTamsQueryMode,
  TamsQueryError,
  type TamsQueryAddress
} from '../tams/tams-query-contract.js';
import { WorkspaceAccessError } from '../data/guard.js';
import { resourceAuthorizationPreHandler } from '../auth/authorize.js';
import { DEPLOYMENT_CONTEXT } from '../auth/workspace.js';
import { InMemoryJobRepository, type JobRepository } from '../data/job-repo.js';
import { emitAudit, originActor, type AuditEmitter } from '../data/audit-emit.js';
import {
  SourceTooLargeError,
  WorkspaceStorage,
  deliveryUrlTtlSeconds,
} from '../data/storage.js';
import { parseSource, assertPublicHost, SourceValidationError } from '../pipeline/source.js';
import {
  resolvePublicManifestUrl,
  PublicManifestBaseUrlError
} from '../pipeline/packaging.js';
import { runPull, type PullDeps } from '../pipeline/url-pull-worker.js';
import { type StorageQuotaGuard } from '../data/storage-quota.js';
import {
  extractTechnicalMetadata,
  type ExtractDeps,
  type ExternalProbeSource,
  type ProbeRunner
} from '../pipeline/metadata-extractor.js';
import {
  UnknownSourceBackendError,
  UnknownDestinationBackendError,
  type StorageBackendRegistry
} from '../services/storage-backend-registry.js';
import { InvalidPathTemplateError } from '../services/destination-path-template.js';
import { STACK_CONFIG_NAMESPACE } from '../services/workspace-stack.js';
import { submitTranscode } from '../pipeline/transcode.js';
import { validateProfileParams } from '../pipeline/profile-params.js';
import { resolveProfileYaml } from '../pipeline/resolve-profile-yaml.js';
import {
  resolveBurnInSource,
  buildSubtitlesFilter,
  checkBurnInObjectAvailable,
  validateForceStyle,
  BURN_IN_FORCE_STYLE_MAX_LENGTH
} from '../pipeline/burn-in.js';
import type { ProfileRepository } from '../data/profile-repo.js';
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
import { parseDestination } from '../pipeline/output-relocation.js';
import { requireSourceObject, tryResolveSourceObject } from '../pipeline/source-object.js';
import {
  backendOutputDestination,
  DEFAULT_BACKEND_ID
} from '../services/storage-backend-registry.js';
import {
  deliveryMode,
  manifestUrlsForLocation,
  outputPrefix,
  packagedBucket,
  packagedRelocationOrigin,
  proxyManifestUrlsFor,
  resolvePackagedOutput,
  type PackagedObjectLister
} from '../pipeline/packaging.js';
import {
  isManifestPath,
  rewriteManifest,
  type ManifestRewriteContext
} from '../pipeline/manifest-rewrite.js';
import type { EncoreClient } from '../pipeline/encore-client.js';
import { isProfileRunnable } from '../services/profile-runnability.js';
import { validateProfileColourSignalling } from '../pipeline/profile-colour-guard.js';
import { decodeEncoreJobId } from '../data/job-repo.js';
import { keys, type EncoreInstanceRecord } from '../encore-scaler/types.js';
import { isDependencyUnreachableError } from '../encore-scaler/dependency-timeout.js';
import {
  checkStackReachability,
  firstUnreachable
} from '../services/stack-reachability.js';
import { isJobThroughputCapExceededError } from '../encore-scaler/job-throughput-cap.js';
import type { EncoreProfile } from '../pipeline/encode-presets.js';
import {
  rewrap,
  REWRAP_FORMATS,
  UnsupportedFormatError,
  type RewrapDeps,
  type RewrapRunner
} from '../pipeline/rewrap.js';
import {
  externalPublicBaseUrl,
  externalObjectUrl
} from '../pipeline/packaging.js';

const statusSchema = z.enum(ASSET_STATUSES);

// Editorial review state (issue #134), distinct from lifecycle `status`.
const reviewStateSchema = z.enum(ASSET_REVIEW_STATES);

// Storage-tier state (ADR-019, issue #556), distinct from lifecycle `status`.
// The physical byte-location axis (`hot` | `archive`) tracked per byte class,
// plus any in-flight rehydrate. REPRESENTATION ONLY — no relocation/restore
// execution here. `archive` is the tier value; the string `archived` is the
// lifecycle status and is NEVER used as a tier (ADR-019 D1/D6).
const storageTierSchema = z.enum(STORAGE_TIERS);
const storageByteClassSchema = z.enum(STORAGE_BYTE_CLASSES);
const rehydrateStateSchema = z.object({
  byteClass: storageByteClassSchema.describe('The byte class being restored from archive back to hot.'),
  startedAt: z.string().describe('ISO timestamp the restore was requested/started.')
});
const storageTieringSchema = z.object({
  // Tier per byte class (ADR-019 D3). Every class is present with a concrete
  // value; a fresh/existing asset defaults every class to `hot`.
  tiers: z
    .record(storageByteClassSchema, storageTierSchema)
    .describe(
      'Physical storage tier (`hot` | `archive`) per byte class (source, ' +
        'renditions, packaged, subtitles, thumbnails). Orthogonal to lifecycle ' +
        '`status`; `archive` is a byte location, never the `archived` status ' +
        '(ADR-019 D1/D3/D6). Defaults to every class `hot`.'
    ),
  // In-flight rehydrate indicator (ADR-019 D4). Empty when no restore is running.
  rehydrating: z
    .array(rehydrateStateSchema)
    .describe(
      'Byte classes with an archive->hot restore currently in flight, each with ' +
        'its started-at timestamp. Empty when nothing is rehydrating (ADR-019 D4). ' +
        'Representation only — this API does not execute the restore.'
    )
});

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

// profileParams (issue #287): a flat string map forwarded verbatim into the
// Encore job document's `profileParams` object, which Encore evaluates as SpEL
// expression properties within the named server-side profile (e.g. crf, preset,
// height, keyframes for `x264-crf-parametrized`). Verified against the SVT
// Encore EncoreJob model — `profileParams: Map<String, Any?>` defaulting to
// `{}` (github.com/svt/encore, encore-common/.../model/EncoreJob.kt). We
// constrain our contract to string values: Encore accepts them with no coercion
// and each value lands as a single token in the ffmpeg argument list (no new
// injection surface). Values omitted -> unchanged default output.
const profileParamsSchema = z.record(z.string(), z.string());

// Burn-in caption source (issue #388, ADR-014 D2; styling contract hardened by
// issue #390). Optional + additive: absent => no burn-in, today's transcodes
// unchanged. `source` is a discriminated union on `type`. Format gating (srt/vtt
// only, ttml rejected) and objectKey resolution happen in the handler
// (resolveBurnInSource) so the not-ready/not-found/unsupported cases map to
// descriptive 4xx responses rather than opaque schema errors.
//
// STYLING CONTRACT (issue #390): the default on-screen appearance is WHATEVER THE
// SIDECAR CARRIES — a vtt sidecar's cue settings convey position/styling; an srt
// sidecar conveys none, so the burn-in renderer's defaults apply. `forceStyle` is
// an OPTIONAL, EXPLICIT, VALIDATED override — NOT a free-form ffmpeg filter
// string. It is a comma-separated list of `Key=Value` libass style directives
// where every Key is allowlisted (validateForceStyle / BURN_IN_ALLOWED_STYLE_KEYS
// in ../pipeline/burn-in.ts) and every Value uses a strict safe charset. Any value
// containing quotes, commas (outside the separator), colons, semicolons,
// backslashes or newlines — i.e. anything that could escape `force_style='...'`
// and inject filtergraph content — is REJECTED with a 422 (see the handler). The
// schema bounds length; the exact allowlist/charset check runs in the handler so
// the rejection carries a specific, actionable message.
const burnInSchema = z.object({
  source: z
    .discriminatedUnion('type', [
      z.object({ type: z.literal('sidecarKey'), objectKey: z.string().min(1).max(1024) }),
      z.object({ type: z.literal('subtitleTrack'), trackId: z.string().min(1) })
    ])
    .describe(
      'Caption source, resolved to one workspace-local sidecar object key. Burn-in supports srt and vtt only; a ttml source (or track) is rejected with 422 (ADR-014 D4).'
    ),
  forceStyle: z
    .string()
    .max(BURN_IN_FORCE_STYLE_MAX_LENGTH)
    .optional()
    .describe(
      "Optional styling/positioning override. Default styling is whatever the sidecar carries (vtt cue settings convey position/styling; srt conveys none, so the renderer defaults apply). This is NOT a free-form ffmpeg filter string: it is a comma-separated list of 'Key=Value' libass style directives drawn from an allowlist (FontName, FontSize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, Outline, Shadow, Spacing, Alignment, MarginL, MarginR, MarginV, BorderStyle). Positioning is expressed via Alignment (numpad 1-9) and MarginV. Values may only use letters, digits and the limited set '&#.+%- '; any quote, comma (outside the separator), colon, semicolon, backslash or newline is rejected with 422. Example: \"FontName=Sans,FontSize=24,Alignment=2,MarginV=40\"."
    )
});

const transcodeBodySchema = z
  .object({
    profile: z.string().min(1).optional(),
    customProfile: customProfileSchema.optional(),
    profileParams: profileParamsSchema.optional(),
    burnIn: burnInSchema.optional()
  })
  .refine((b) => !(b.profile && b.customProfile), {
    message: 'specify either profile or customProfile, not both'
  });

const transcodeAcceptedSchema = z.object({
  jobId: z.string(),
  encoreJobId: z.string(),
  // Non-fatal notice (issue #394). Present ONLY when profileParams validation
  // could not be performed because the profile YAML was unresolvable — either a
  // custom profile that is not in the operator profile store, or the profile
  // store was unreachable. The request was still accepted (202) and the
  // profileParams keys were forwarded to Encore UNCHECKED. Absent when the keys
  // were validated against the profile's declared params, or when the request
  // carried no profileParams at all.
  warning: z
    .object({
      code: z
        .literal('profile_params_unvalidated')
        .describe('Stable machine-readable warning code.'),
      message: z
        .string()
        .describe('Human-readable explanation naming the profile and the unvalidated keys.'),
      profile: z
        .string()
        .describe('The profile name whose declared params could not be resolved.'),
      unvalidatedKeys: z
        .array(z.string())
        .describe('The profileParams keys that were forwarded to Encore without validation.')
    })
    .describe(
      'Present only when profileParams validation could not be performed because the ' +
        'profile YAML was unresolvable (a custom profile not in the store, or the profile ' +
        'store was unreachable). The request was still accepted and the keys were forwarded ' +
        'to Encore unchecked.'
    )
    .optional()
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

// TAMS-addressed lookup query params (issue #175, sub-task of #116; contract
// ADR-010 / #174). The v1 addressing surface has exactly two modes, both keyed
// on a TAMS flow id:
//   (1) flowId            -> `?tamsFlowId=<uuid>`
//   (2) flowId + timerange -> `?tamsFlowId=<uuid>&tamsTimerange=<tai>`
// No other v1 modes (source-id / segment-ref / bare-timerange are deferred).
// The two field schemas are REUSED from asset-document.ts (TamsFlowIdSchema is a
// UUID; TamsTimerangeSchema is the ADR-008 TAI grammar) so this route's accepted
// grammar is identical to the persisted grammar — no regex is re-declared here.
// A malformed value fails validation at the boundary and Fastify returns 400,
// which satisfies the contract's "malformed param -> 400" case.
//
// WIRE NAMES vs CONTRACT NAMES: the wire params are `tamsFlowId` / `tamsTimerange`
// (the `tams`-prefixed names that match the #168 search-index fields and the
// OpenAPI surface in #176). The ADR-010 contract (`tams-query-contract.ts`)
// names the same values `flowId` / `timerange`. The handler maps wire -> contract
// before calling `resolveTamsQueryMode`, so the contract stays authoritative for
// mode selection and the error taxonomy while the public wire surface keeps its
// `tams`-prefixed names. (Unifying the two spellings would require editing either
// this route's test or the merged #174 contract test — deferred, see PR note.)
const tamsLookupQuerySchema = z.object({
  tamsFlowId: TamsFlowIdSchema.describe(
    'TAMS flow id (UUID) to resolve. Addressing mode (1): supplying only ' +
      'tamsFlowId resolves the ready asset carrying this flow. Required.'
  ),
  tamsTimerange: TamsTimerangeSchema.optional().describe(
    'TAMS TAI timerange (ADR-008 grammar, e.g. [0:0_10:0)). Addressing mode ' +
      '(2): supplying tamsFlowId + tamsTimerange additionally requires an exact ' +
      'stored-timerange match. Optional.'
  )
});

// External-identifier resolver path params (issue #576, ADR-019). The lookup key
// is the `{ namespace, id }` pair modelled by #575 and persisted under
// `administrative.externalIdentifiers[]` (asset-document.ts). Both components are
// REQUIRED and non-empty, matching the persisted `ExternalIdentifierSchema`
// grammar (`namespace`/`id` are each `z.string().min(1)`), so the resolver's
// accepted grammar is 1:1 with the stored grammar. An empty component is
// rejected at the boundary with 400 before the handler runs. `id` is an opaque
// upstream foreign key (UUID / numeric / slug), so it stays a free-form string.
const externalIdParamsSchema = z.object({
  namespace: z
    .string()
    .min(1)
    .describe(
      'Upstream system-of-record label the external id belongs to (e.g. ' +
        '`ingest-mam`, `rights-registry`). Required, non-empty.'
    ),
  id: z
    .string()
    .min(1)
    .describe(
      'Opaque foreign-key value in that system (UUID / numeric id / slug). ' +
        'Required, non-empty.'
    )
});

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

// Machine-readable body for a 504 when a required stack dependency (queue/
// Valkey, Encore, storage) is unreachable or times out on the transcode path
// (issue #616). Names the failing dependency and its endpoint so a caller can
// branch on `dependency` without string-matching the message.
const dependencyUnreachableSchema = z.object({
  error: z.literal('dependency_unreachable'),
  dependency: z.enum(['queue', 'encore', 'storage']),
  endpoint: z.string(),
  message: z.string()
});

// Machine-readable body for a 429 when the operator-configured job-throughput
// cap is exceeded on the transcode submit path (issue #580). Names the configured
// ceiling and observed outstanding-job count so a caller can back off and retry.
const jobThroughputCapSchema = z.object({
  error: z.literal('job_throughput_cap_exceeded'),
  cap: z.number(),
  outstanding: z.number(),
  message: z.string()
});

// Explicit delete-lock (ADR-020 decision 3, issue #568) as surfaced on the API.
// Field names/types mirror ADR-020 exactly: locked, reason?, lockedAt, lockedBy?.
const deleteLockSchema = z.object({
  locked: z.boolean(),
  reason: z.string().optional(),
  lockedAt: z.string(),
  lockedBy: z.string().optional()
});

// The shared blocked-delete envelope (ADR-020 decision 1, issue #568). EXTENDS
// the existing `{ error, message? }` shape rather than diverging: adds the
// required `reason` enum and the required `blockedBy` object. For the explicit
// -lock case `reason` is `delete_protected` and both id arrays are empty (the
// block is intrinsic to the document, not a foreign reference). The other two
// reason members are reserved by ADR-020 for sibling sub-issues (OUT OF SCOPE
// here) but declared so the response schema is the single shared contract.
const deleteBlockedSchema = z.object({
  error: z.literal('delete_blocked'),
  message: z.string().optional(),
  reason: z.enum(['referenced_by_job', 'member_of_collection', 'delete_protected']),
  blockedBy: z.object({
    jobIds: z.array(z.string()),
    collectionIds: z.array(z.string())
  })
});

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

// Deterministic-resolution metadata (issue #506). When public delivery is not
// configured (so no fully-resolvable playback URL can be advertised), the
// response still carries enough of the persisted packaged-output location
// (issue #502) for a client to locate the master manifest objects itself
// against its own object-store access. All fields are optional/additive: a
// pre-#502 asset (no persisted `packagedOutput`) simply omits them.
const deliveryResolutionSchema = z.object({
  packagedBucket: z.string().optional(),
  packagedPrefix: z.string().optional(),
  masterHlsKey: z.string().optional(),
  masterDashKey: z.string().optional()
});

// `status` (issue #506) is the unambiguous readiness signal a consuming
// application keys off, so it never advertises an unplayable URL as ready:
//   - `ready`          — `urls` holds a fully-resolvable (absolute) playback or
//                        download URL that plays without workarounds.
//   - `not_configured` — packaged output exists but public delivery is not
//                        configured on this deployment, so no resolvable
//                        playback URL can be built. `urls.hls`/`urls.dash` are
//                        omitted; `resolution` carries the packaged prefix and
//                        master manifest keys for deterministic client-side
//                        resolution instead.
const deliverySchema = z.object({
  assetId: z.string(),
  status: z.enum(['ready', 'not_configured']),
  urls: deliveryUrlsSchema,
  resolution: deliveryResolutionSchema.optional(),
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
  // Canonical editorial title of the asset (issue #347). This is the ONE
  // documented location for title on every response — GET /assets/:id, list,
  // and search all expose title here as `name`. There is no separate top-level
  // `title` field on responses; on ingest the `title` (or legacy `name`) input
  // persists to `descriptive.title` (asset-document.ts) and surfaces here.
  name: z
    .string()
    .describe(
      'Canonical editorial title of the asset. Set on ingest via `title` (or ' +
        'the legacy `name` alias) and persisted to `descriptive.title`; this ' +
        'is the single documented location for title across GET, list, and ' +
        'search responses. There is no separate top-level `title` field.'
    ),
  // Human-readable, URL-safe slug (issue #131). Present on assets created after
  // slugs were introduced; absent/undefined for pre-existing slug-less assets.
  slug: z.string().optional(),
  description: z.string().optional(),
  status: statusSchema,
  // Editorial review state (issue #134), INDEPENDENT of `status`. Optional so
  // pre-existing assets serialized before reviewState existed still validate.
  reviewState: reviewStateSchema.optional(),
  // Explicit delete-lock (ADR-020 decision 3, issue #568). Absent = unlocked;
  // when present with `locked: true` the asset is delete-protected. Set/cleared
  // only via PUT/DELETE /:id/lock (the dedicated system path), never the
  // editorial update path.
  deleteLock: deleteLockSchema.optional(),
  // Storage-tier state (ADR-019, issue #556), INDEPENDENT of `status` and
  // `reviewState`: the physical byte-location axis (`hot` | `archive`) per byte
  // class plus any in-flight rehydrate. Always present on responses: the response
  // serializer `.default()`s it to every class `hot` with nothing rehydrating for
  // any asset lacking explicit tier state (new/existing/pre-#556 assets), so the
  // axis surfaces concretely without back-filling persistence. This is
  // representation only — the API exposes the state but does not relocate bytes
  // or run rehydrates.
  storageTiering: storageTieringSchema.default(() => defaultStorageTiering()),
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
  // Operator-configured total storage cap (issue #579, ADR-020). When provided,
  // URL-pull ingest is admitted through the running-total counter inside the
  // worker (reserve on remote Content-Length, commit true size on success). An
  // over-cap pull fails the job with a quota_exceeded error. Absent => no cap,
  // behaviour unchanged (opt-in).
  quota?: StorageQuotaGuard;
  // Technical metadata extraction (issue #6). `probe` is the ffprobe runner
  // (eyevinn-ffmpeg-s3 in production, a stub in tests). When `probe` is absent
  // extraction is disabled and POST /:id/extract-metadata responds 501.
  probe?: ProbeRunner;
  // Injectable extractor runner + extra deps (tests stub the probe/TTL/onError).
  // Defaults to the real fire-and-forget extractor.
  extract?: typeof extractTechnicalMetadata;
  extractDeps?: Partial<ExtractDeps>;
  // External storage-backend registry (issue #547/#548, ADR-017). When present,
  // POST /ingest-url may reference a registered external backend by id or name
  // via `sourceBackend`: the ingest sources bytes from that bucket (the
  // probe/transcode jobs read `s3://bucket/key` in place using the registered
  // endpoint + credential references) instead of pulling into OSC-managed
  // storage. When absent, `sourceBackend` is rejected (registry not configured)
  // and ingest behaves exactly as before (OSC-managed default source).
  storageBackendRegistry?: StorageBackendRegistry;
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
  // Resolve the EFFECTIVE stack identity a transcode request routes to (issue
  // #615). Given the request's X-Stack-Name header (or undefined for the
  // workspace default), returns the stack name to KEY the Encore auto-scaler
  // pool / Valkey queue / MinIO endpoint by, so a request against a healthy
  // named stack is never routed to whichever stack was provisioned first in the
  // process. When absent (tests, env-override single-stack deployments) or when
  // it resolves undefined (no provisioned stack / store unconfigured), the
  // transcode path falls back to the fixed DEPLOYMENT_CONTEXT — unchanged
  // pre-#615 behaviour.
  resolveStackContext?: (requestedStackName?: string) => Promise<string | undefined>;
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
  // job (eyevinn-ffmpeg-s3 in production, a stub in tests). Like the thumbnail
  // extractor it may be a factory that receives the workspace's s3Config so the
  // OSC job can write the output directly to the right MinIO bucket via
  // `s3://bucket/key` (a presigned PUT URL does NOT work — issue #316). When
  // absent (or no object storage), POST /:id/export responds 501.
  rewrapRunner?: RewrapRunner | ((s3Config: { endpoint: string; accessKey: string; secretKey: string; bucket: string }) => RewrapRunner);
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
  // Operator-managed Encore transcoding profile store (issue #84). Used by POST
  // /:id/transcode for two validations before submission:
  //  - profileParams keys are validated against the SpEL params the chosen
  //    profile actually declares (issue #290); and
  //  - a GPU-only (NVENC/CUDA) profile that cannot run on this platform tier is
  //    rejected 422 rather than submitted to an Encore instance that cannot
  //    execute it (issue #286).
  // When absent (e.g. deployments/tests that do not wire the profile store or do
  // not exercise named profiles), both checks are skipped (permissive) and the
  // profile name is forwarded as before.
  profileRepository?: ProfileRepository;
  // Collection membership lookup (issue #570). Used ONLY by DELETE /:id to
  // detect whether the asset is still a member of one or more collections
  // (ADR-020 reason `member_of_collection`) before archiving it. Read-only from
  // the route's side (`collectionsContainingAsset`). When absent (e.g. tests
  // that do not exercise collection membership), the membership check is skipped
  // and DELETE behaves exactly as before.
  collectionRepository?: CollectionRepository;
  // Best-effort audit emission (issue #564). Wired to the append-only audit
  // store's `record()` write primitive. When absent, mutations proceed
  // un-audited (no-op). Emission is fire-and-forget: a failed audit write is
  // logged, never propagated — no route becomes newly failable.
  audit?: AuditEmitter;
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
  // Per-execution destination override actually used (issue #207). Absent when
  // the caller relied on the provisioned instance-level default.
  destinationBucket: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

// Optional per-execution destination override (issue #207).
//
// Accepts either an `s3://bucket/prefix/` URI or a plain `bucket/prefix/` path
// identifier — #208 later consumes it as the packager's OutputFolder for
// post-package relocation. The packager produces malformed S3 URIs when the
// output folder lacks a trailing slash (OSC packager contract, finding #3), so
// this schema NORMALIZES a trailing slash on and validates the shape at the
// edge, rejecting malformed values with a 400 before anything is persisted.
//
// Rejected: empty / whitespace, values with control characters, wildcards, `..`
// path traversal, backslashes, or a `scheme://` other than `s3://`.
const destinationBucketSchema = z
  .string()
  .trim()
  .min(1, 'destinationBucket must not be empty')
  .max(1024, 'destinationBucket is too long')
  .refine((v) => !/\s/.test(v), {
    message: 'destinationBucket must not contain whitespace'
  })
  .refine((v) => ![...v].some((ch) => ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f), {
    message: 'destinationBucket must not contain control characters'
  })
  .refine((v) => !v.includes('\\') && !v.includes('*') && !v.includes('?'), {
    message: 'destinationBucket must not contain backslashes or wildcards'
  })
  .refine((v) => !/(^|\/)\.\.(\/|$)/.test(v), {
    message: 'destinationBucket must not contain path traversal segments'
  })
  .refine((v) => !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(v) || v.startsWith('s3://'), {
    message: 'destinationBucket must be a plain path or an s3:// URI'
  })
  .refine((v) => (v.startsWith('s3://') ? v.length > 's3://'.length : true), {
    message: 'destinationBucket s3:// URI must include a bucket'
  })
  // Normalize: collapse duplicate trailing slashes to exactly one so the
  // packager always receives a well-formed folder (never a bare object key).
  .transform((v) => v.replace(/\/+$/, '') + '/');

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

// URL-pull ingest request body (issue #5). `.strict()` (issue #344): unknown /
// non-actionable properties are REJECTED with a 400 rather than silently
// accepted and discarded — a silently-dropped field previously made a
// dropped-metadata bug expensive to discover. The accepted set is exactly the
// fields the handler acts on: `sourceUrl`, `name`, `description`, plus `title`
// and `tags`. `title`/`tags` are persisted to the user-writable `descriptive`
// namespace (issue #343): the repository maps `name`/`title` -> descriptive.title
// (asset-document.ts) and `tags` -> descriptive.tags, landing in the same place a
// later PUT /:id/metadata or POST /:id/tags would set them. `title` wins over
// `name` when both appear.
const ingestUrlSchema = z
  .object({
    sourceUrl: z.string().min(1).max(4096),
    name: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        'Legacy alias for `title` (issue #347). The editorial title of the ' +
          'asset. `title` and `name` are two input spellings of the SAME ' +
          'canonical field: both persist to `descriptive.title` and are read ' +
          'back as the `name` property on GET /assets/:id, list, and search ' +
          'responses. Prefer `title`; `title` wins when both are supplied.'
      ),
    description: z.string().max(2048).optional(),
    title: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        'The editorial title of the asset (issue #347). This is the ' +
          'canonical write path for title: it persists to `descriptive.title` ' +
          'and is read back as the `name` property on GET /assets/:id, list, ' +
          'and search responses (there is NO separate top-level `title` field ' +
          'on responses). Accepted as an alias of `name`; `title` wins when ' +
          'both are supplied.'
      ),
    tags: tagsSchema.optional(),
    sourceBackend: z
      .string()
      .min(1)
      .max(256)
      .optional()
      .describe(
        'Reference (id or name) to a registered external storage backend ' +
          '(issue #548, ADR-017) to source the asset bytes from, instead of the ' +
          'OSC-managed default storage. The backend must be registered (POST ' +
          '/storage/backends) and serve the `source` (or `both`) role. When set, ' +
          '`sourceUrl` addresses the object WITHIN that backend as ' +
          '`s3://<bucket>/<key>` (bucket may be omitted to use the registered ' +
          "backend's bucket, i.e. `s3:///<key>` or a bare `<key>`). No external " +
          'credentials are ever supplied inline: the registered endpoint + ' +
          'credentials are reused server-side. Omit for the default source.'
      )
  })
  .strict();

const ingestAcceptedSchema = z.object({
  assetId: z.string(),
  jobId: z.string()
});

// Derive the object key WITHIN a registered external backend's bucket from the
// ingest `sourceUrl` (issue #548). Three accepted forms, all credential-free:
//   - `s3://<bucket>/<key>` — the bucket must match the registered backend's
//     bucket (a mismatch is rejected so a caller cannot redirect a registered
//     credential at an arbitrary bucket);
//   - `s3:///<key>` — empty authority, uses the registered bucket;
//   - a bare `<key>` (no scheme) — uses the registered bucket.
// Returns the leading-slash-stripped key. Throws SourceValidationError (-> 400)
// on an empty key or a bucket mismatch.
export function externalObjectKeyFromSourceUrl(
  sourceUrl: string,
  registeredBucket: string
): string {
  let raw = sourceUrl.trim();
  if (/^s3:\/\//i.test(raw)) {
    const withoutScheme = raw.replace(/^s3:\/\//i, '');
    const slash = withoutScheme.indexOf('/');
    const bucket = slash === -1 ? withoutScheme : withoutScheme.slice(0, slash);
    const key = slash === -1 ? '' : withoutScheme.slice(slash + 1);
    if (bucket && bucket !== registeredBucket) {
      throw new SourceValidationError(
        `s3 bucket "${bucket}" does not match the registered backend bucket`
      );
    }
    raw = key;
  }
  const key = raw.replace(/^\/+/, '');
  if (!key) {
    throw new SourceValidationError('sourceUrl must address an object key within the backend bucket');
  }
  return key;
}

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
export function parseS3Uri(uri: string): { bucket: string; key: string } | null {
  const match = /^s3:\/\/([^/]+)\/(.+)$/.exec(uri);
  if (!match) return null;
  return { bucket: match[1], key: match[2] };
}

// The publicly reachable origin of THIS API up to (and including) the assets
// router mount point, e.g. `https://api.example/api/v1/assets`. Used to build
// proxy delivery URLs (issue #201). Prefers the configured PUBLIC_BASE_URL
// (12-factor, mirrors how main.ts reads it) joined to the router's own request
// prefix; falls back to a same-origin relative path derived from the incoming
// request when PUBLIC_BASE_URL is unset (local dev without a tunnel). In both
// cases the returned value is the base that `<assetId>/stream/...` is appended
// to, so a manifest's relative segment references resolve back through the proxy.
function assetsBaseUrl(requestUrl: string): string {
  // requestUrl is the full mounted path, e.g. `/api/v1/assets/<id>/delivery`.
  // Strip the query and the trailing `/<id>/delivery` (or any `/<id>/...`) to
  // recover the router prefix (`/api/v1/assets`).
  const pathOnly = requestUrl.split('?')[0];
  const prefix = pathOnly.replace(/\/[^/]+\/[^/]+\/?$/, '');
  const configured = process.env['PUBLIC_BASE_URL']?.replace(/\/+$/, '');
  if (configured) {
    return `${configured}${prefix}`;
  }
  return prefix;
}

// True when `value` is an absolute URL (has a scheme + host a player can fetch),
// false for a bare path like `/openvideocore-packaged/<id>/index.m3u8`. Used by
// the delivery endpoint (issue #341) to decide whether a resolved manifest URL
// is already externally resolvable or must be routed through the stream proxy.
function isAbsoluteUrl(value: string): boolean {
  try {
    // The URL constructor throws on a relative/bare path (no base), so a
    // successful parse means the value carries a scheme + authority.
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

// The absolute-or-relative URL prefix, up to and INCLUDING the `<id>/stream`
// segment (no trailing slash), that a proxied manifest's child references must
// be rewritten against so they resolve back through this route (issue #340).
// `requestUrl` is the full mounted request path, e.g.
// `/api/v1/assets/<id>/stream/v0/playlist.m3u8`; `wildcard` is the object path
// captured by `*` (e.g. `v0/playlist.m3u8`). We strip the wildcard (and its
// leading slash) off the path to recover `.../assets/<id>/stream`, then prefix
// the configured PUBLIC_BASE_URL when set (12-factor; mirrors assetsBaseUrl) so
// the rewritten URLs share the origin the delivery endpoint advertises. Falls
// back to the same-origin relative path when PUBLIC_BASE_URL is unset.
function streamProxyBaseUrl(requestUrl: string, wildcard: string): string {
  const pathOnly = requestUrl.split('?')[0];
  const suffix = wildcard.replace(/^\/+/, '');
  // Remove the wildcard tail (and the slash separating it from `stream`).
  let base = pathOnly;
  if (suffix.length > 0 && base.endsWith(suffix)) {
    base = base.slice(0, base.length - suffix.length);
  }
  base = base.replace(/\/+$/, '');
  const configured = process.env['PUBLIC_BASE_URL']?.replace(/\/+$/, '');
  return configured ? `${configured}${base}` : base;
}

// The real packaged-output prefix (bucket-excluded, NO trailing slash) that the
// `/:id/stream/*` proxy resolves objects under, for issue #503. The packager
// writes every object of a package under a job-nested prefix
// `<assetId>/<packagerJobId>/` (persisted as `packagedOutput.prefix` by issue
// #502), NOT under the historical flat `packaged/<id>` that `outputPrefix`
// returns. This resolves, in order of preference:
//   1. the durable `packagedOutput.prefix` persisted on the asset (#502) —
//      used verbatim (no object-store round-trip);
//   2. the lazy fallback (`resolvePackagedOutput`) for assets packaged BEFORE
//      #502 (no persisted prefix): lists the packaged bucket under `<assetId>/`
//      and derives the newest job prefix. The stack `storageClient` is a
//      `minio.Client` and satisfies the `PackagedObjectLister` surface
//      (listObjectsV2) `resolvePackagedOutput` needs (src/pipeline/packaging.ts);
//   3. the historical flat `outputPrefix(assetId)` (`packaged/<id>`) when the
//      asset has no packaged objects under `<assetId>/` at all — preserves the
//      pre-#502/#503 flat-package layout unchanged.
// `resolvePackagedOutput` returns a trailing-slash prefix; a trailing slash is
// stripped so the returned value composes as `<prefix>/<relative>` like
// `outputPrefix`. Lister errors are swallowed to the flat fallback so a listing
// hiccup degrades to the old behaviour rather than a 500.
async function resolveStreamPrefix(
  asset: { id: string; packagedOutput?: PackagedOutput },
  lister: PackagedObjectLister,
  bucket: string
): Promise<string> {
  try {
    const resolved = await resolvePackagedOutput(asset, lister, bucket);
    if (resolved?.prefix) {
      return resolved.prefix.replace(/\/+$/, '');
    }
  } catch {
    // fall through to the flat prefix below
  }
  return outputPrefix(asset.id);
}

// Deterministic-resolution metadata for the `/delivery` `not_configured` variant
// (issue #506). Surfaces the durable packaged-output location persisted by the
// packager callback (#502) — the packaged bucket, the job-nested prefix the
// packager actually wrote under, and the master HLS/DASH object keys — so a
// client can locate the manifest objects itself when this deployment cannot
// advertise a resolvable playback URL. Returns undefined when the asset has no
// persisted `packagedOutput` block (pre-#502) so the field is simply omitted
// rather than emitting an empty object. NEVER round-trips to object storage: it
// only reflects the verified location already recorded on the asset.
function deliveryResolutionFor(
  asset: { packagedOutput?: PackagedOutput }
): z.infer<typeof deliveryResolutionSchema> | undefined {
  const out = asset.packagedOutput;
  if (!out || !(out.bucket || out.prefix || out.masterHlsKey || out.masterDashKey)) {
    return undefined;
  }
  return {
    ...(out.bucket ? { packagedBucket: out.bucket } : {}),
    ...(out.prefix ? { packagedPrefix: out.prefix } : {}),
    ...(out.masterHlsKey ? { masterHlsKey: out.masterHlsKey } : {}),
    ...(out.masterDashKey ? { masterDashKey: out.masterDashKey } : {})
  };
}

// The `not_configured` delivery body (issue #506): the asset HAS packaged
// output but this deployment cannot advertise a fully-resolvable playback URL
// (public delivery not configured — no PUBLIC_BASE_URL / public origin). The
// response carries NO playable `urls.hls`/`urls.dash` so a consuming
// application never treats it as ready; `resolution` carries the persisted
// packaged prefix + master manifest keys (#502) so a client with its own
// object-store access can resolve the manifest objects deterministically.
function notConfiguredDelivery(
  asset: { id: string; packagedOutput?: PackagedOutput },
  expiresAt: string
): z.infer<typeof deliverySchema> {
  const resolution = deliveryResolutionFor(asset);
  return {
    assetId: asset.id,
    status: 'not_configured',
    urls: {},
    ...(resolution ? { resolution } : {}),
    expiresAt
  };
}

// Content-Type for a packaged object served through the proxy route (issue
// #201), inferred from its extension. Covers the CMAF/HLS/DASH file types the
// packager emits; unknown types fall back to a generic binary stream so the
// player still receives the bytes.
function contentTypeForPackagedObject(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
  if (lower.endsWith('.mpd')) return 'application/dash+xml';
  // CMAF media segments (fragmented .m4s / .cmf*) use the ISO segment media type
  // (RFC 8216 / ISO BMFF); a whole `.mp4` (e.g. a single-file init or the DASH
  // init segment) is served as a plain MP4 container.
  if (
    lower.endsWith('.m4s') ||
    lower.endsWith('.cmfv') ||
    lower.endsWith('.cmfa') ||
    lower.endsWith('.cmft')
  ) {
    return 'video/iso.segment';
  }
  if (lower.endsWith('.mp4') || lower.endsWith('.m4v')) return 'video/mp4';
  if (lower.endsWith('.m4a')) return 'audio/mp4';
  if (lower.endsWith('.ts')) return 'video/mp2t';
  if (lower.endsWith('.vtt')) return 'text/vtt';
  return 'application/octet-stream';
}

// Buffer a Readable object body into a UTF-8 string. Used only for manifests
// (small text files) served through the proxy delivery route, which are rewritten
// before sending (issue #340). Segment bodies are NEVER buffered — they stream
// through untouched — so this stays bounded to manifest-sized payloads.
async function readStreamToString(
  stream: import('stream').Readable
): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// Parse a single-range HTTP `Range` header of the form `bytes=<start>-<end>`
// against a known object `size`, returning the resolved inclusive byte offsets.
// Supports the three RFC 7233 single-range forms the players emit for CMAF
// segment fetches:
//   - `bytes=START-END`  -> [START, END]
//   - `bytes=START-`     -> [START, size-1] (open-ended tail)
//   - `bytes=-SUFFIX`    -> last SUFFIX bytes -> [size-SUFFIX, size-1]
// Returns { unsatisfiable: true } when the range is well-formed but lies outside
// the object (the route maps this to 416). Returns undefined when the header is
// absent or not a single byte-range we can honor, so the caller streams the
// whole object with 200 (a correct, if unoptimised, response).
function parseByteRange(
  rangeHeader: string | undefined,
  size: number
): { start: number; end: number } | { unsatisfiable: true } | undefined {
  if (!rangeHeader) return undefined;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return undefined;
  const [, rawStart, rawEnd] = match;
  if (rawStart === '' && rawEnd === '') return undefined;

  let start: number;
  let end: number;
  if (rawStart === '') {
    // Suffix range: final N bytes.
    const suffix = Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(suffix) || suffix <= 0) return undefined;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number.parseInt(rawStart, 10);
    end = rawEnd === '' ? size - 1 : Number.parseInt(rawEnd, 10);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return undefined;
  }

  if (start > end || start >= size) {
    return { unsatisfiable: true };
  }
  // Clamp the end to the last byte so an over-long range still resolves.
  return { start, end: Math.min(end, size - 1) };
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

// Find the resolved output location of the most recent pipeline execution that
// relocated this asset's packaged output to a per-execution destination override
// (issue #208/#210). Reuses the same `listByAsset` lookup the pipeline routes
// use (assets.ts /:id/executions), which returns executions ascending by
// createdAt; we scan from newest to oldest and return the first
// `resolvedOutputLocation` we find. Returns undefined when no execution
// relocated (no override was used), in which case delivery falls back to the
// instance-default manifest URLs (existing behaviour unchanged).
async function latestRelocatedLocation(
  pipelineRepository: PipelineRepository,
  assetId: string
): Promise<{ bucket: string; prefix: string } | undefined> {
  const executions = await pipelineRepository.listByAsset(assetId);
  for (let i = executions.length - 1; i >= 0; i--) {
    const loc = executions[i].resolvedOutputLocation;
    if (loc) {
      return loc;
    }
  }
  return undefined;
}

// Normalize an object-key or key-prefix so it NEVER embeds the bucket name as
// its first path segment (issue #342). Object keys in open-videocore follow a
// single convention: the bucket is carried SEPARATELY (as the storage binding),
// never inside the key. Rendition `objectKey` (exposed as `s3Uri.key`) and the
// proxy `/:id/stream/*` route (`outputPrefix(id)/...`) already obey this, but
// packaged `objectKeyPrefix` — derived from a stored manifest URL whose path is
// `/<packagedBucket>/packaged/<id>/index.m3u8` — historically kept the bucket as
// its leading segment, causing off-by-one path errors when the proxy/delivery
// handlers construct keys.
//
// This is also the BACK-COMPAT read shim: assets packaged before #342 persisted
// the bucket-embedded prefix, so we strip a leading `<bucket>/` here at read time
// (in ADDITION to normalizing new writes) so already-packaged assets keep
// resolving. Stripping is guarded on the KNOWN packaged bucket only — an
// unrelated leading segment that merely resembles a bucket is left untouched.
function stripBucketPrefix(key: string, bucket: string): string {
  const clean = key.replace(/^\/+/, '');
  if (!bucket) return clean;
  const prefix = `${bucket.replace(/^\/+|\/+$/g, '')}/`;
  return clean.startsWith(prefix) ? clean.slice(prefix.length) : clean;
}

// Derive the object-key prefix backing a streaming package from its manifest
// URL — the manifest's parent "directory" (e.g.
// `https://minio/packaged/<id>/hls/master.m3u8` -> `packaged/<id>/hls/`). The
// URL path is used when parseable; otherwise the raw string is treated as a
// path. Segment objects live under this prefix. The bucket, if present as the
// leading path segment, is stripped so the returned prefix follows the
// bucket-excluded convention (issue #342); pass the effective packaged bucket.
function objectKeyPrefixFromManifest(manifestUrl: string, bucket: string): string {
  let path = manifestUrl;
  try {
    path = new URL(manifestUrl).pathname;
  } catch {
    // Not an absolute URL; treat the value itself as a path.
  }
  path = stripBucketPrefix(path, bucket);
  const lastSlash = path.lastIndexOf('/');
  return lastSlash >= 0 ? path.slice(0, lastSlash + 1) : '';
}

// Derive the full object KEY (path + manifest filename, no leading slash) from a
// stored manifest URL — e.g. `https://minio/packaged/<id>/index.m3u8` ->
// `packaged/<id>/index.m3u8`. Used to re-host a stored (proxied/MinIO) manifest
// URL against an external object-store / CDN origin (issue #213) while keeping
// the deterministic manifest name. A query string, if any, is dropped: delivery
// URLs must never carry signed/credential query params. The internal packaged
// bucket, if present as the leading path segment, is stripped so the returned
// key follows the bucket-excluded convention (issue #342) — the external origin
// (`packagedBase`) already carries its own bucket, so leaving the internal
// bucket in would double it (`<endpoint>/<extBucket>/<packagedBucket>/...`).
function objectKeyFromManifest(manifestUrl: string, bucket: string): string {
  let path = manifestUrl;
  try {
    path = new URL(manifestUrl).pathname;
  } catch {
    // Not an absolute URL; treat the value itself as a path (strip any query).
    const q = path.indexOf('?');
    if (q >= 0) path = path.slice(0, q);
  }
  return stripBucketPrefix(path, bucket);
}

export const assetsRouter: FastifyPluginAsync<AssetsRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();

  // Router-layer method→action authorisation gate (ADR-018 decision 2, seam 1;
  // issue #554). Registered plugin-scoped so it runs on EVERY asset route
  // (Fastify encapsulation) before the handler: it derives the action from the
  // HTTP method (GET/HEAD→read, POST/PUT/PATCH→write, DELETE→delete) and calls
  // authorize(role, 'asset'). Denials are a fail-closed 403 with the stable
  // AUTHZ_FORBIDDEN_ERROR reason code, distinct from the 401 presence gate
  // (decision 5). Per ADR-018 decision 4 each asset is authorised independently
  // against the caller's workspace role — no cascade from any collection.
  app.addHook('preHandler', resourceAuthorizationPreHandler('asset'));

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
  // Best-effort audit emitter (issue #564). Undefined => mutations run un-audited.
  const audit = opts.audit;

  // Resolve the scaler/Encore context key for a transcode request (issue #615).
  // The scaler auto-scaler partitions its Encore pool, Valkey queue keys, and
  // MinIO S3-endpoint resolution by this context string (encodeEncoreJobId's
  // contextId — see pipeline/transcode.ts). Pre-#615 this was the fixed
  // DEPLOYMENT_CONTEXT, so every transcode routed to whichever stack was
  // provisioned first. We now key by the EFFECTIVE stack identity the per-stack
  // resolver reports for THIS request's X-Stack-Name, so a request against a
  // healthy named stack reaches that stack regardless of provisioning order.
  // Falls back to DEPLOYMENT_CONTEXT when no resolver is wired (tests /
  // env-override) or when it resolves undefined (no provisioned stack), leaving
  // single-stack behaviour byte-identical.
  async function transcodeContext(request: import('fastify').FastifyRequest): Promise<string> {
    if (!opts.resolveStackContext) return DEPLOYMENT_CONTEXT;
    const header = request.headers['x-stack-name'];
    const requested = typeof header === 'string' && header.length > 0 ? header : undefined;
    const resolved = await opts.resolveStackContext(requested);
    return resolved ?? DEPLOYMENT_CONTEXT;
  }

  // Resolve whether a named transcode profile can execute on this platform tier
  // (issue #286). Returns a human message when the profile is a stored GPU-only
  // (NVENC/CUDA) profile that cannot run on OSC's CPU-only Encore instances, so
  // the caller can reject with a clear 422 instead of submitting an unrunnable
  // job. Returns undefined (allow) when: no profile store is wired; no profile
  // name was given (preset defaults handle it); the named profile is unknown to
  // the store (forwarded verbatim as before — Encore resolves or rejects it); or
  // the named profile is runnable.
  async function unrunnableProfileReason(profileName: string | undefined): Promise<string | undefined> {
    if (!profileName || !opts.profileRepository) return undefined;
    const stored = await opts.profileRepository.get(profileName);
    if (!stored) return undefined;
    if (isProfileRunnable(stored.yaml)) return undefined;
    return `profile "${profileName}" requires GPU (NVENC/CUDA) hardware encoding, which is not available on this platform — choose a CPU-encoded profile`;
  }

  // Resolve whether a named transcode profile declares colour signalling that is
  // not carriable at its pixel format (issue #377): e.g. an 8-bit stream tagged
  // PQ/HLG or BT.2020, HDR10 mastering metadata on a non-PQ output, or mastering
  // metadata on an HLG output. Returns a human message naming both offending
  // values so the caller can reject with a clear 422 BEFORE an encode is paid
  // for, rather than shipping a mistagged output. Returns undefined (allow) when
  // no profile store is wired, no profile name was given, the named profile is
  // unknown to the store (forwarded verbatim — Encore resolves or rejects it),
  // or the profile's colour signalling is carriable (including legitimate 10-bit
  // SDR and genuine HDR10/HLG profiles).
  async function uncarriableColourReason(profileName: string | undefined): Promise<string | undefined> {
    if (!profileName || !opts.profileRepository) return undefined;
    const stored = await opts.profileRepository.get(profileName);
    if (!stored) return undefined;
    const check = validateProfileColourSignalling(stored.yaml);
    if (check.ok) return undefined;
    return `profile "${profileName}" declares colour signalling that is not carriable at its pixel format — ${check.reason}`;
  }

  // Fire-and-forget technical metadata extraction (issue #6). Detached, never
  // blocks the caller, and the extractor itself never throws (records failures
  // on the asset). No-op when the probe runner or object storage is not
  // configured. Returns true when an extraction was actually kicked off.
  function triggerExtraction(
    assetId: string,
    objectKey: string,
    externalSource?: ExternalProbeSource
  ): boolean {
    if (!opts.probe || !storageFor) {
      return false;
    }
    void extractRunner(
      { assetId, objectKey, ...(externalSource ? { externalSource } : {}) },
      {
        assets: repo,
        storage: storageFor(),
        probe: opts.probe,
        ...opts.extractDeps
      }
    );
    return true;
  }

  // Synchronous re-drive of technical metadata extraction (issue #281). Unlike
  // triggerExtraction (fire-and-forget), this AWAITS the extractor so the caller
  // observes the settled outcome. Used by the re-drive path of
  // POST /:id/extract-metadata to recover an asset wedged in `processing` with a
  // `technicalMetadataError`: on success the extractor clears the error,
  // populates `technicalMetadata`, and advances `processing -> ready`. The
  // extractor never throws (it records failures on the asset), so callers read
  // back the asset to learn whether recovery succeeded. Assumes probe + storage
  // are configured (the route checks this before calling).
  async function runExtractionSync(assetId: string, objectKey: string): Promise<void> {
    if (!opts.probe || !storageFor) {
      return;
    }
    await extractRunner(
      { assetId, objectKey },
      {
        assets: repo,
        storage: storageFor(),
        probe: opts.probe,
        ...opts.extractDeps
      }
    );
  }

  // Fire-and-forget auto-subtitle generation for a pipeline step (issue #114).
  // Detached, never blocks the caller, and the generator itself never throws
  // (records failures on the asset as `subtitlesError`). No-op when the OSC
  // auto-subtitles service or object storage is not configured — consistent with
  // the OPTIONAL, opt-in nature of the step. Returns true when a generation was
  // actually kicked off (false = skipped gracefully).
  function triggerSubtitles(assetId: string, objectKey: string, request: import('fastify').FastifyRequest): boolean {
    // Activation is derived from the ACTIVE stack record (issue #217): the
    // resolver builds the generator from StackConfig.autoSubtitlesInstanceName
    // and exposes it on request.connections, so a freshly provisioned service is
    // picked up on the next run with no restart. An injected opts.subtitle
    // Generator (tests) still wins. Absent => skip gracefully (fire-and-forget).
    const generate = opts.subtitleGenerator ?? request.connections?.subtitleGenerator;
    if (!generate || !storageFor) {
      return false;
    }
    void subtitleRunner(
      { assetId, objectKey },
      {
        assets: repo,
        storage: storageFor(),
        generate,
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
  function triggerSceneDetect(assetId: string, objectKey: string, request: import('fastify').FastifyRequest): boolean {
    // Activation is derived from the ACTIVE stack record (issue #217): the
    // resolver builds the detector from StackConfig.sceneDetectInstanceName and
    // exposes it on request.connections, so a freshly provisioned service is
    // picked up on the next run with no restart. An injected opts.sceneDetector
    // (tests) still wins. Absent => skip gracefully (fire-and-forget).
    const detect = opts.sceneDetector ?? request.connections?.sceneDetector;
    if (!detect || !storageFor) {
      return false;
    }
    void sceneDetectRunner(
      { assetId, objectKey },
      {
        assets: repo,
        storage: storageFor(),
        detect,
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

  // Resolve a package/publish job's requested output destination into the single
  // per-execution `destinationBucket` string the ADR-011 relocation path already
  // consumes. Accepts AT MOST ONE of three mutually-exclusive output-destination
  // expressions, then reduces it to the single bucket string the downstream
  // pipeline consumes:
  //   1. `destination` — a named export-destination reference (issue #573), the
  //      stable id OR name of a registered output-role backend, resolved through
  //      the SAME StorageBackendRegistry the /api/v1/export-destinations surface
  //      uses (resolveDestinationBucket).
  //   2. `externalBackend` — a reference (id OR name) to a registered external
  //      storage backend (issue #549, ADR-017 D4), resolved through
  //      resolveForOutput to the backend's NON-SECRET output coordinates
  //      (credentials stay in OSC secrets).
  //   3. `destinationBucket` — an inline ad-hoc override (unchanged ADR-011
  //      path), already validated + trailing-slash-normalised at the edge.
  //
  // PRECEDENCE / MUTUAL EXCLUSION: supplying more than one of the three on the
  // same job is AMBIGUOUS and rejected with a clear 400 rather than silently
  // preferring one — the caller must pick exactly one destination expression.
  // Each named path preserves its own resolution error semantics: #573's
  // `destination` yields the registry's 400 (bad_request) / 501 (not_configured);
  // #549's `externalBackend` yields 501 (not_configured) / 422 (unknown_backend
  // or backend_role). When none is supplied the job uses the provisioned default
  // (fully backwards compatible).
  //
  // Returns:
  //   { ok: true, destinationBucket } — the resolved override string (or
  //     undefined when none was supplied: the job uses the provisioned default).
  //   { ok: false } — an error response has already been sent via `reply`;
  //     callers must not send again.
  async function resolveJobDestination(
    args: {
      destination?: string;
      externalBackend?: string;
      destinationBucket?: string;
      // Job-time context for issue #574 per-destination path templating: the
      // asset id the job runs against, substituted for {assetId} when the named
      // `destination` carries a template. Ignored on the inline-override and
      // externalBackend paths (which are not templated).
      assetId?: string;
    },
    reply: import('fastify').FastifyReply
  ): Promise<{ ok: true; destinationBucket?: string } | { ok: false }> {
    const { destination, externalBackend, destinationBucket, assetId } = args;
    // Mutual exclusion across all three output-destination expressions: at most
    // ONE may be supplied. More than one is ambiguous -> 400 (issue #573 / #549).
    // Each feature keeps its own pre-existing 400 error shape rather than a new
    // invented code: a collision INVOLVING `externalBackend` uses #549's
    // `invalid_request` shape; a `destination`/`destinationBucket` collision uses
    // #573's `ambiguous_destination` shape.
    const suppliedCount =
      (destination !== undefined ? 1 : 0) +
      (externalBackend !== undefined ? 1 : 0) +
      (destinationBucket !== undefined ? 1 : 0);
    if (suppliedCount > 1) {
      if (externalBackend !== undefined) {
        reply.code(400).send({
          error: 'invalid_request',
          message:
            'externalBackend and destinationBucket are mutually exclusive; specify only one output destination'
        });
      } else {
        reply.code(400).send({
          error: 'ambiguous_destination',
          message:
            'supply either a named "destination" reference or an inline "destinationBucket" override, not both'
        });
      }
      return { ok: false };
    }

    // #549 external-backend reference path: resolve through the registry's
    // output resolver, preserving its 501 (not_configured) / 422 (unknown_backend
    // / backend_role) semantics.
    if (externalBackend !== undefined) {
      if (!opts.storageBackendRegistry) {
        reply.code(501).send({
          error: 'not_configured',
          message: 'external storage backends are not configured on this deployment'
        });
        return { ok: false };
      }
      const record = await opts.storageBackendRegistry.resolveForOutput(
        DEPLOYMENT_CONTEXT,
        externalBackend
      );
      // Explicitly referencing the implicit OSC-managed default (id 'default')
      // means "use the default output path" — resolveForOutput returns undefined
      // for it (ADR-017 D3, it is not an external backend), so we leave the
      // destination unset and fall through rather than 422. Any OTHER unresolved
      // reference is a dangling backend -> 422.
      if (!record) {
        if (externalBackend !== DEFAULT_BACKEND_ID) {
          reply.code(422).send({
            error: 'unknown_backend',
            message: `no registered external storage backend matches "${externalBackend}"`
          });
          return { ok: false };
        }
        // 'default' -> no override, default output path (field omitted).
        return { ok: true };
      }
      // Only write-capable roles can receive packaged output (ADR-017 D4:
      // 'packaged'/'both' fan their credential to the packager; 'source' is
      // read-only for ingest and 'archive' fans only to source-reader consumers
      // — see mappingsForRole, storage-backend-registry.ts). Any non-write role
      // is rejected via this allowlist.
      if (record.role !== 'packaged' && record.role !== 'both') {
        reply.code(422).send({
          error: 'backend_role',
          message: `storage backend "${externalBackend}" is registered for the "${record.role}" role and cannot receive output; register it with role "packaged" or "both"`
        });
        return { ok: false };
      }
      return { ok: true, destinationBucket: backendOutputDestination(record) };
    }

    // Inline override path: unchanged ADR-011 behaviour (already validated +
    // trailing-slash-normalised at the edge by destinationBucketSchema).
    if (destination === undefined) {
      return destinationBucket !== undefined
        ? { ok: true, destinationBucket }
        : { ok: true };
    }
    // #573 named-reference path: resolve through the registry to the SAME
    // `destinationBucket` string the relocation consumes.
    if (!opts.storageBackendRegistry) {
      reply.code(501).send({
        error: 'not_configured',
        message: 'storage-backend registry is not configured'
      });
      return { ok: false };
    }
    try {
      const resolved = await opts.storageBackendRegistry.resolveDestinationBucket(
        STACK_CONFIG_NAMESPACE,
        destination,
        // Issue #574: pass the job-time context so a destination carrying a path
        // template keys output under the bucket (e.g. {date}/{assetId}). A
        // template-less destination ignores this and yields the bare `<bucket>/`.
        { ...(assetId !== undefined ? { assetId } : {}) }
      );
      return { ok: true, destinationBucket: resolved };
    } catch (err) {
      if (err instanceof UnknownDestinationBackendError) {
        reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
        return { ok: false };
      }
      // Issue #574: a persisted template referenced a token with no value in this
      // job's context (e.g. {assetId} with no asset). Surface a clear 400 rather
      // than dispatching a job that would write to a mis-keyed path.
      if (err instanceof InvalidPathTemplateError) {
        reply
          .code(err.statusCode)
          .send({ error: 'invalid_path_template', message: err.message });
        return { ok: false };
      }
      throw err;
    }
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
    encodeOpts?: { profile?: string; customProfile?: EncoreProfile; profileParams?: Record<string, string> },
    // Optional per-execution destination override (issue #207). Already
    // validated + trailing-slash-normalized by the edge schema. Persisted on the
    // execution record so #208 (packager relocation) and #210 (delivery) can
    // resolve the destination actually used. When undefined, later stages fall
    // back to the provisioned instance-level default (backwards compatible).
    destinationBucket?: string
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
    }
    // Unified source-object resolution (issue #612): every first step below
    // consumes the asset's source object, so gate them all through the ONE
    // shared resolver. A source-less asset now fails identically here and in the
    // single-operation routes (POST /:id/{transcode,package,thumbnails,clip,
    // export,extract-metadata}) — a consistent 409 no_object.
    if (
      firstStep === 'transcode' ||
      firstStep === 'package' ||
      firstStep === 'extract-metadata' ||
      firstStep === 'thumbnail' ||
      firstStep === 'subtitles' ||
      firstStep === 'scene-detect'
    ) {
      if (!requireSourceObject(asset, reply)) {
        return undefined;
      }
    }

    void firstStep; // pre-flight above used firstStep; execution drives the loop

    // Reject a named GPU-only (NVENC/CUDA) profile the platform cannot execute
    // (issue #286) up front, when the pipeline includes a transcode step, so no
    // dangling running execution is created for a job Encore cannot run.
    if (steps.includes('transcode')) {
      const unrunnable = await unrunnableProfileReason(encodeOpts?.profile);
      if (unrunnable) {
        reply.code(422).send({ error: 'profile_unrunnable', message: unrunnable });
        return undefined;
      }
      // Reject a profile whose colour signalling is not carriable at its pixel
      // format (issue #377) before a running execution is created, so a
      // mistagged (e.g. 8-bit-tagged-PQ) output is never produced.
      const uncarriable = await uncarriableColourReason(encodeOpts?.profile);
      if (uncarriable) {
        reply.code(422).send({ error: 'profile_colour_uncarriable', message: uncarriable });
        return undefined;
      }
    }

    // Pre-flight the per-execution destination override against the configured
    // storage credentials (issue #209). A caller can supply a destination whose
    // bucket is not reachable with the configured MinIO/S3 credentials; without
    // this check the packager (or the #208 relocation copy) fails opaquely on a
    // callback later. We reject up front, BEFORE creating/dispatching the
    // execution, so the caller gets a clear, synchronous error naming the
    // unreachable bucket.
    //
    // Scope: only destinations that resolve to the configured storage endpoint
    // are probed. A plain `bucket/prefix/` path names a bucket on the configured
    // client, so `bucketExists` is authoritative. An `s3://…` URI may target an
    // external endpoint this API holds no credentials for and cannot probe;
    // rather than hard-fail a destination we cannot verify, we let it through —
    // if it later fails, the packager failure callback surfaces a clear,
    // attributable error on the execution record (see internal.ts). Executions
    // with no override are completely unaffected (this block is skipped).
    if (destinationBucket !== undefined) {
      const isExternalS3Uri = destinationBucket.startsWith('s3://');
      const storageClient = request.connections?.storageClient;
      if (!isExternalS3Uri && storageClient) {
        const parsed = parseDestination(destinationBucket);
        if (parsed) {
          let reachable = false;
          try {
            reachable = await storageClient.bucketExists(parsed.bucket);
          } catch (err) {
            // A probe failure (network/credential error) is treated as
            // unreachable: we cannot confirm the destination is usable, so we
            // refuse to dispatch a job that would fail opaquely later.
            request.log.warn(
              { err, bucket: parsed.bucket },
              'destination bucket reachability probe failed'
            );
            reachable = false;
          }
          if (!reachable) {
            reply.code(422).send({
              error: 'destination_unreachable',
              message: `destination bucket "${parsed.bucket}" is not reachable with the configured storage credentials`
            });
            return undefined;
          }
        }
      }
    }

    const execution = await pipelineRepo.create({
      assetId: asset.id,
      pipelineName,
      steps,
      ...(destinationBucket !== undefined ? { destinationBucket } : {})
    });
    const now = () => new Date().toISOString();
    const stepsCopy: StepExecution[] = execution.steps.map((s) => ({ ...s }));

    // Unified source-object resolution (issue #612): every source-consuming step
    // below reads the SAME resolved location. Pre-flight above already 409'd a
    // source-less asset whose first step needs the source; resolving once here
    // means the loop can never diverge from the single-operation routes.
    const resolvedSource = tryResolveSourceObject(asset);
    const sourceObjectKey = resolvedSource?.objectKey ?? '';

    // Execute steps synchronously until we hit an asynchronous step (transcode/
    // package) which completes via an OSC callback, or run out of steps. The
    // fire-and-forget steps (extract-metadata, thumbnail) settle immediately.
    try {
      for (let i = 0; i < stepsCopy.length; i++) {
        const step = stepsCopy[i];
        if (step.name === 'extract-metadata') {
          triggerExtraction(asset.id, sourceObjectKey);
          stepsCopy[i] = { ...step, status: 'done', startedAt: now(), completedAt: now() };
          continue;
        }
        if (step.name === 'thumbnail') {
          triggerThumbnail(asset.id, sourceObjectKey, request);
          stepsCopy[i] = { ...step, status: 'done', startedAt: now(), completedAt: now() };
          continue;
        }
        if (step.name === 'subtitles') {
          // Fire-and-forget, exactly like extract-metadata: kick off (or skip
          // gracefully when unconfigured) and settle the step immediately. The
          // generator records its own success/failure on the asset and never
          // throws into this loop, so the step never fails the pipeline.
          triggerSubtitles(asset.id, sourceObjectKey, request);
          stepsCopy[i] = { ...step, status: 'done', startedAt: now(), completedAt: now() };
          continue;
        }
        if (step.name === 'scene-detect') {
          // Fire-and-forget, exactly like extract-metadata/subtitles: kick off (or
          // skip gracefully when unconfigured) and settle the step immediately. The
          // detector records its own success/failure on the asset and never throws
          // into this loop, so the step never fails the pipeline.
          triggerSceneDetect(asset.id, sourceObjectKey, request);
          stepsCopy[i] = { ...step, status: 'done', startedAt: now(), completedAt: now() };
          continue;
        }
        if (step.name === 'transcode') {
          // Resolve the transcode output bucket from the caller's per-stack
          // packaged bucket (issue #638). request.connections.packagedBucket is
          // the stack's persisted `packagedStorage.bucket` (workspace-stack.ts
          // config.packagedBucket, sourced from the parameter store at provision
          // time per ADR-002). Fall back to opts.outputBucket — the deployment-
          // wide MINIO_PACKAGED_BUCKET default — only when no per-stack value
          // exists (e.g. the env-override path). The output PATH template
          // (transcode/<assetId>/<jobId>/) is unchanged; only the bucket changes.
          const resolvedOutputBucket =
            request.connections?.packagedBucket ?? (opts.outputBucket as string);
          const result = await submitTranscode(
            {
              // Key the scaler pool/queue/S3 endpoint by the EFFECTIVE stack
              // this request routes to (issue #615), not the fixed deployment
              // context, so a pipeline execution against a healthy named stack
              // is not pinned to whichever stack was provisioned first.
              workspaceId: await transcodeContext(request),
              sourceAssetId: asset.id,
              sourceObjectKey,
              // Read the transcode INPUT from the resolved stack's per-stack
              // source bucket (StackConfig.sourceBucket, param-store key
              // `sourceBucket` per ADR-002; carried on WorkspaceConnections.
              // sourceBucket) rather than the deployment-wide boot default
              // (opts.sourceBucket from MINIO_SOURCE_BUCKET) — issue #639. The
              // fallback preserves the env-override / single-stack deployments
              // where request.connections is absent. Mirrors the existing
              // per-stack resolution used by the thumbnail/rewrap paths
              // (request.connections?.sourceBucket ?? …). Output/packaged
              // resolution (resolvedOutputBucket) is issue #638.
              sourceBucket: request.connections?.sourceBucket ?? (opts.sourceBucket as string),
              outputBucket: resolvedOutputBucket,
              preset: encodeOpts?.profile,
              customProfile: encodeOpts?.customProfile,
              // profileParams (issue #288): forwarded verbatim into the same
              // transcode submission path as POST /:id/transcode so SpEL-
              // parametrised profiles work from execute too. Undefined leaves
              // execute behaviour unchanged.
              profileParams: encodeOpts?.profileParams
            },
            { jobs, assets: repo, encore: opts.encore!, audit, auditLog: request.log }
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
    // Explicit delete-lock (ADR-020 decision 1, issue #568): the shared
    // `delete_blocked` envelope with reason `delete_protected` and EMPTY
    // blockedBy arrays (the block is intrinsic to the document, not a foreign
    // reference).
    if (err instanceof DeleteProtectedError) {
      return reply.code(409).send({
        error: 'delete_blocked',
        message: err.message,
        reason: 'delete_protected',
        blockedBy: { jobIds: [], collectionIds: [] }
      });
    }
    // Member-of-collection block (issue #570): the SAME shared `delete_blocked`
    // envelope (ADR-020 decision 1), reason `member_of_collection`, with the
    // blocking collection ids in `blockedBy.collectionIds`. Soft/overridable via
    // `?force=true` (handled at the route before this throws).
    if (err instanceof AssetMemberOfCollectionError) {
      return reply.code(409).send({
        error: 'delete_blocked',
        message: err.message,
        reason: 'member_of_collection',
        blockedBy: { jobIds: [], collectionIds: [...err.collectionIds] }
      });
    }
    // In-flight job reference (ADR-020 decision 1, issue #569): the same shared
    // `delete_blocked` envelope, reason `referenced_by_job`, with the
    // referencing job ids named in `blockedBy.jobIds` so the caller can wait
    // for or cancel them. An active reference is a hard block (decision 2), so
    // `?force=true` never reaches this branch as a bypass.
    if (err instanceof ReferencedByJobError) {
      return reply.code(409).send({
        error: 'delete_blocked',
        message: err.message,
        reason: 'referenced_by_job',
        blockedBy: { jobIds: err.jobIds, collectionIds: [] }
      });
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
      // Audit: asset created (issue #564). One entry, targetId = new asset id.
      emitAudit(
        audit,
        {
          actor: originActor('user'),
          action: 'asset.created',
          targetType: 'asset',
          targetId: asset.id,
          detail: { name: asset.name, status: asset.status }
        },
        request.log
      );
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
      const { sourceUrl, name, title, description, tags, sourceBackend } = request.body;

      // --- External-backend source (issue #548, ADR-017 D4) --------------
      // When the request references a registered external backend, we source the
      // bytes FROM that bucket instead of the OSC-managed default. Rather than
      // pulling into OSC-managed storage (which would need the literal secret the
      // registry never returns — see osc-feedback/incoming-issue548-…), the
      // downstream probe/transcode jobs read `s3://<bucket>/<key>` in place using
      // the registered endpoint + `{{secrets.<name>}}` references (ADR-017 C3).
      // No external credential is ever placed inline in the request or in the
      // stored job record (the job's sourceUrl is `s3://bucket/key`, credential-
      // free) — issue #548 acceptance.
      if (sourceBackend !== undefined) {
        if (!opts.storageBackendRegistry) {
          return reply.code(501).send({
            error: 'not_configured',
            message: 'storage-backend registry is not configured'
          });
        }
        let source: ExternalProbeSource;
        try {
          const creds = await opts.storageBackendRegistry.resolveSourceCredentials(
            STACK_CONFIG_NAMESPACE,
            sourceBackend
          );
          const objectKeyInBucket = externalObjectKeyFromSourceUrl(sourceUrl, creds.bucket);
          source = {
            bucket: creds.bucket,
            objectKey: objectKeyInBucket,
            awsAccessKeyId: creds.awsAccessKeyId,
            awsSecretAccessKey: creds.awsSecretAccessKey,
            ...(creds.s3EndpointUrl ? { s3EndpointUrl: creds.s3EndpointUrl } : {}),
            ...(creds.awsRegion ? { awsRegion: creds.awsRegion } : {}),
            ...(creds.awsSessionToken ? { awsSessionToken: creds.awsSessionToken } : {})
          };
        } catch (err) {
          if (err instanceof UnknownSourceBackendError) {
            return reply.code(err.statusCode).send({ error: 'bad_request', message: err.message });
          }
          throw err;
        }

        const extFallbackName =
          decodeURIComponent(source.objectKey.split('/').filter(Boolean).pop() ?? '') ||
          source.bucket;
        const extAsset = await repo.create({
          name: title ?? name ?? extFallbackName,
          description,
          tags
        });
        // The recorded source is the credential-free `s3://bucket/key` locator;
        // the object already lives in the external bucket, so no byte-pull runs
        // and the asset advances straight to `processing`.
        const extObjectKey = `s3://${source.bucket}/${source.objectKey}`;
        await repo.update(extAsset.id, { objectKey: extObjectKey, status: 'processing' });
        const extJob = await jobs.create({
          type: 'ingest-url',
          assetId: extAsset.id,
          sourceUrl: extObjectKey
        });
        await jobs.update(extJob.id, { status: 'running' });
        await jobs.update(extJob.id, { status: 'done', progress: 100 });
        // Fire-and-forget probe against the external source (job reads in place).
        triggerExtraction(extAsset.id, extObjectKey, source);
        return reply.code(202).send({ assetId: extAsset.id, jobId: extJob.id });
      }

      // Validate synchronously so a bad URL is a 400, not a background failure.
      const parsed = parseSource(sourceUrl);
      if (parsed.scheme === 'http' || parsed.scheme === 'https') {
        await assertPublicHost(parsed.url.hostname);
      }

      // Derive a default asset name from the URL's last path segment.
      const fallbackName =
        decodeURIComponent(parsed.url.pathname.split('/').filter(Boolean).pop() ?? '') ||
        parsed.url.hostname;

      // Persist editorial title + tags to the user-writable `descriptive`
      // namespace at creation time (issue #343). `title` (preferred) or the
      // legacy `name` alias becomes `descriptive.title`; `tags` becomes
      // `descriptive.tags` — the repository normalizes tags identically to
      // POST /:id/tags, so a later GET returns the submitted values verbatim.
      const asset = await repo.create({
        name: title ?? name ?? fallbackName,
        description,
        tags
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
        { jobs, assets: repo, storage: storageFor(), quota: opts.quota, ...opts.pullDeps }
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

  // DEPRECATED free-text alias (issue #346). The canonical, fully-featured search
  // contract is `GET /api/v1/search/` (routes/search.ts) — it exposes the tiered
  // exact-filter + free-text surface (`q`, `tags`, `mimeType`, `metadata.<key>`,
  // TAMS address lookup, pagination) over the wired search projection (#345).
  //
  // This endpoint predates that contract and only ever accepted `q` (a free-text
  // term matched over name/description via AssetRepository.search). Its match
  // semantics are IDENTICAL to the canonical endpoint's `q` tier (proven by the
  // #345 parity regression, test/search-parity.test.ts), so it answers the same
  // asset set for the same query and never returns silently-empty where the
  // canonical one would answer. It is retained as a backward-compatible alias and
  // marked `deprecated` in the OpenAPI spec; callers should migrate to
  // `GET /api/v1/search/?q=<term>`, which additionally returns `{ total, page }`.
  app.get(
    '/search',
    {
      schema: {
        tags: ['search'],
        summary: 'DEPRECATED — use GET /api/v1/search/',
        description:
          'Deprecated free-text alias. Use the canonical `GET /api/v1/search/?q=<term>` ' +
          'endpoint instead, which serves the same free-text results plus tag, mimeType, ' +
          'metadata, and TAMS filters with `total`/`page` pagination. This alias only ' +
          'accepts `q` and returns `{ items }`; it is retained for backward compatibility ' +
          'and will be removed in a future major version.',
        deprecated: true,
        querystring: z.object({
          q: z
            .string()
            .min(1)
            .describe(
              'Case-insensitive free-text query matched against the asset ' +
                'title (the canonical `name` field, persisted at ' +
                '`descriptive.title`) and description — regardless of whether ' +
                'the client set the title through the ingest `title` field or ' +
                'the legacy `name` alias (issue #347).'
            )
        }),
        response: { 200: z.object({ items: z.array(assetSchema) }) }
      }
    },
    async (request, reply) => {
      // Advertise the canonical replacement on every response (RFC 8594 style),
      // so clients can discover the migration target without reading the spec.
      reply.header('deprecation', 'true');
      reply.header('link', '</api/v1/search/>; rel="successor-version"');
      const items = await repo.search(request.query.q);
      return { items };
    }
  );

  // TAMS-addressed lookup resolution (issue #175). Resolves a TAMS flow id (and,
  // optionally, a TAI timerange) to AT MOST ONE ready asset, per the ADR-010 /
  // #174 contract cardinality:
  //   - flowId            -> the single asset whose `tamsFlowIds` INCLUDES it.
  //   - flowId + timerange -> that same asset, additionally requiring its stored
  //     `tamsTimerange` to equal the requested one (v1: exact match; overlap /
  //     containment slicing is deferred).
  //
  // RESOLUTION SOURCE (temporary): the #168 TAMS search index is not on main yet,
  // so this scans the asset REPOSITORY client-side — it pages through the READY
  // assets via `repo.list` (limit/offset up to `total`) and selects the match.
  // -------------------------------------------------------------------------
  // TODO(#168): when the TAMS search index lands, replace this client-side scan
  // with the indexed `tamsFlowId` search query for efficiency (O(1) index hit
  // instead of a full ready-asset page walk). Do NOT widen `ListOptions` here —
  // that field belongs to #168 and adding it now would collide.
  // -------------------------------------------------------------------------
  // Returns:
  //   - the resolved asset when exactly one matches,
  //   - undefined when none matches (unknown / not-yet-indexed / timerange miss),
  //   - the sentinel 'ambiguous' when more than one ready asset carries the flow
  //     (unreachable in v1 since a flow id is deterministic per asset, but the
  //     contract reserves 409 for it, so it is mapped rather than swallowed).
  async function resolveByTamsAddress(
    tamsFlowId: string,
    tamsTimerange: string | undefined
  ): Promise<Asset | undefined | 'ambiguous'> {
    const matches: Asset[] = [];
    // Only READY assets are addressable (uploading/processing/failed/archived are
    // not resolvable media). Page through them with the shared list contract.
    let offset = 0;
    // Guard against an unbounded loop if `total` ever misbehaves.
    for (;;) {
      const page = await repo.list({ status: 'ready', limit: MAX_LIMIT, offset });
      for (const asset of page.items) {
        if (!asset.tamsFlowIds?.includes(tamsFlowId)) {
          continue;
        }
        // flowId + timerange mode: additionally require an exact stored-timerange
        // match (v1 keeps it simple — no partial/overlap slicing yet).
        if (tamsTimerange !== undefined && asset.tamsTimerange !== tamsTimerange) {
          continue;
        }
        matches.push(asset);
        if (matches.length > 1) {
          return 'ambiguous';
        }
      }
      offset += page.limit;
      if (offset >= page.total || page.items.length === 0) {
        break;
      }
    }
    return matches[0];
  }

  // TAMS-addressed lookup route (issue #175, contract ADR-010 / #174).
  //
  // A DEDICATED route (not an overload of `GET /`), because its single-match,
  // 404-on-unknown semantics differ from list semantics. Registered BEFORE the
  // `/:id` param route so the static `/by-tams-address` segment is never shadowed
  // by the param (Fastify's radix router prefers the static segment, and the
  // registration order makes that explicit).
  //
  // Cardinality/pagination: returns a `ListResult`-shaped envelope
  // (`{ items, limit, offset, total }`) for forward-compatibility even though v1
  // resolves to at most one asset.
  //
  // Error -> status mapping (per contract):
  //   - malformed `tamsFlowId` (bad UUID) / `tamsTimerange` (bad TAI) -> 400
  //     (enforced by `tamsLookupQuerySchema` validation before the handler runs).
  //   - unknown address (well-formed but no ready asset carries the flow) -> 404.
  //   - not-yet-indexed -> collapses to 404 (indistinguishable from unknown here).
  //   - ambiguous -> 409 (reserved; unreachable in v1 but mapped, not swallowed).
  app.get(
    '/by-tams-address',
    {
      schema: {
        querystring: tamsLookupQuerySchema,
        response: { 200: listSchema, 400: errorSchema, 404: errorSchema, 409: errorSchema }
      }
    },
    async (request, reply) => {
      const { tamsFlowId, tamsTimerange } = request.query;
      // Resolve the addressing MODE through the ADR-010 contract rather than
      // re-deriving it here. Map the wire params onto the contract's grammar and
      // let `resolveTamsQueryMode` narrow to a typed `flowId` / `flowIdWithTimerange`
      // address. Fastify's querystring validation already rejects malformed input
      // with 400 before this runs, so the catch is defensive (kept so the contract
      // grammar stays authoritative even if the wire schema and contract drift).
      let addr: TamsQueryAddress;
      try {
        addr = resolveTamsQueryMode({ flowId: tamsFlowId, timerange: tamsTimerange });
      } catch {
        const err = new TamsQueryError('malformed');
        return reply.code(err.status as 400 | 404 | 409).send({ error: 'invalid_tams_address' });
      }
      const timerange = addr.mode === 'flowIdWithTimerange' ? addr.timerange : undefined;
      const resolved = await resolveByTamsAddress(addr.flowId, timerange);
      if (resolved === 'ambiguous') {
        // Contract reserves 409 for ambiguity (unreachable in v1); status comes
        // from the contract's error->status map via TamsQueryError.
        const err = new TamsQueryError('ambiguous');
        return reply.code(err.status as 400 | 404 | 409).send({
          error: 'ambiguous_tams_address',
          message: `TAMS flow ${addr.flowId} resolves to more than one asset`
        });
      }
      if (!resolved) {
        // unknown OR not-yet-indexed OR timerange miss all collapse to 404 per
        // the contract taxonomy (both `unknown` and `notYetIndexed` map to 404).
        const err = new TamsQueryError('unknown');
        return reply.code(err.status as 400 | 404 | 409).send({ error: 'not_found' });
      }
      // Forward-compat paginated envelope even though v1 is single-match.
      return reply.code(200).send({ items: [resolved], limit: MAX_LIMIT, offset: 0, total: 1 });
    }
  );

  // External-identifier resolver route (issue #576, ADR-019). Resolves an
  // upstream `{ namespace, id }` correlation to AT MOST ONE asset, so a Media
  // Developer round-tripping with an upstream system of record can fetch the
  // open-videocore asset by their own foreign key.
  //
  // A DEDICATED resolver PATH (not a `GET /?externalId=…` query filter on the
  // list endpoint), mirroring the `/by-tams-address` precedent above: its
  // single-match, 404-on-unknown semantics differ from list semantics, and the
  // two-part composite key expresses cleanly as `/{namespace}/{id}` without the
  // colon-delimited `externalId=ns:id` ambiguity (an upstream id may itself
  // contain a colon, e.g. a URN). Registered BEFORE the `/:id` param route so the
  // static `/by-external-id` segment is never shadowed by the param (Fastify's
  // radix router prefers the static segment; the registration order makes it
  // explicit).
  //
  // Index-backed, NOT a linear scan: the resolution delegates to
  // AssetRepository.getByExternalId, which the CouchDB backend serves with a
  // Mango `$elemMatch` push-down over `administrative.externalIdentifiers`
  // (couch-asset-repo.ts) — the same array-index push-down as the TAMS flow
  // lookup — so CouchDB filters within the tenant database rather than the route
  // paging the whole asset set.
  //
  // Error -> status mapping:
  //   - empty `namespace` / `id` -> 400 (enforced by externalIdParamsSchema
  //     before the handler runs).
  //   - well-formed pair with no matching asset -> 404 (existence not leaked).
  app.get(
    '/by-external-id/:namespace/:id',
    {
      schema: {
        summary: 'Resolve an asset by an upstream external identifier',
        description:
          'Resolve a single asset by the `{ namespace, id }` external identifier ' +
          'correlated to it (ADR-019). `namespace` labels the upstream system of ' +
          'record; `id` is the opaque foreign key in that system. Returns the asset ' +
          'when exactly one carries the pair, or 404 when none does.',
        params: externalIdParamsSchema,
        response: { 200: assetSchema, 400: errorSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const { namespace, id } = request.params;
      const asset = await repo.getByExternalId(namespace, id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(asset);
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
        response: { 200: assetSchema, 404: errorSchema, 410: errorSchema }
      }
    },
    async (request, reply) => {
      const idOrSlug = request.params.id;
      // Tombstone semantics (issue #326): a purged archived asset's document is
      // replaced in place by a tombstone. A read by its former id must return
      // 410 Gone (the resource existed and was intentionally removed), NOT 404.
      // getState() surfaces that distinction only for the ULID id path; slugs
      // fall through to the ordinary slug lookup (a purged asset drops out of the
      // slug index, so a former slug resolves to 404 as before).
      if (isUlid(idOrSlug)) {
        const state = await repo.getState(idOrSlug);
        if (state.kind === 'tombstone') {
          return reply.code(410).send({ error: 'gone', message: 'asset has been purged' });
        }
        if (state.kind === 'asset') {
          return reply.code(200).send(state.asset);
        }
        return reply.code(404).send({ error: 'not_found' });
      }
      const asset = await resolveAsset(idOrSlug);
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

      // Resolve the per-role storage backend metadata for this asset's stack
      // (issue #211/#213), carried on the resolved connections so no extra
      // parameter-store read is needed here. When absent (stack predates #211,
      // env-override path, or in-memory) both roles behave as the default
      // per-stack MinIO backend and delivery keeps its proxied behaviour.
      const stackStorage = request.connections?.storage;
      // For 'external' backends we emit URLs against the operator's public/CDN
      // origin (publicBaseUrl) or an endpointUrl-derived object URL. For 'minio'
      // (or unset) these resolve to undefined and the MinIO delivery-mode path
      // (proxy/public, #200/#201) is kept unchanged — OSC MinIO blocks external
      // presigned/public GETs.
      const packagedBase = externalPublicBaseUrl(stackStorage?.packaged);
      const sourceBase = externalPublicBaseUrl(stackStorage?.source);

      // Preferred: packaged streaming manifests (issue #9 / #200 / #201 / #213).
      if (asset.manifestUrls && (asset.manifestUrls.hls || asset.manifestUrls.dash)) {
        // Destination-aware URLs (issue #210). With a per-execution destination
        // override (#207), the packager's output is relocated (#208) to a
        // different bucket/prefix and the resolved location is recorded on the
        // execution as `resolvedOutputLocation`. When present, the delivery URLs
        // must point at THAT location, not the instance-default one baked into
        // `asset.manifestUrls`. We reuse the same execution lookup the pipeline
        // routes use (`listByAsset`) and pick the most recent execution that
        // actually relocated (has a `resolvedOutputLocation`). This is the most
        // caller-explicit signal, so it takes precedence over the backend-derived
        // delivery paths below. When none relocated, fall through to those.
        const relocated = opts.pipelineRepository
          ? await latestRelocatedLocation(opts.pipelineRepository, asset.id)
          : undefined;
        if (relocated) {
          const urls = manifestUrlsForLocation(relocated, packagedRelocationOrigin());
          return reply.code(200).send({
            assetId: asset.id,
            status: 'ready',
            // Keep the same per-manifest presence as the default output: only
            // advertise the manifests the packaged output actually produced.
            urls: {
              ...(asset.manifestUrls.hls ? { hls: urls.hls } : {}),
              ...(asset.manifestUrls.dash ? { dash: urls.dash } : {})
            },
            expiresAt
          });
        }
        // External storage backend (#213): the object store / CDN is itself the
        // public origin, so re-host the stored manifest object-key path against
        // it (deterministic manifest names — index.m3u8 / manifest.mpd — are
        // preserved by reusing the stored path). This supersedes the MinIO
        // proxy/public delivery modes below, which only apply to the per-stack
        // MinIO backend that blocks external GETs.
        if (packagedBase) {
          const rehostBucket = request.connections?.packagedBucket ?? packagedBucket();
          const rehost = (manifestUrl: string | undefined): string | undefined => {
            if (!manifestUrl) return undefined;
            return externalObjectUrl(packagedBase, objectKeyFromManifest(manifestUrl, rehostBucket));
          };
          return reply.code(200).send({
            assetId: asset.id,
            status: 'ready',
            urls: { hls: rehost(asset.manifestUrls.hls), dash: rehost(asset.manifestUrls.dash) },
            expiresAt
          });
        }
        // Default per-stack MinIO backend — apply the delivery-mode logic (#201).
        // PRECEDENCE (issue #201): the delivery mode is a single mutually-exclusive
        // config flag (DELIVERY_MODE), never both at once:
        //   - proxy  -> advertise proxy URLs that stream packaged objects back
        //               through the authorized `/:id/stream/*` route below. The
        //               packaged bucket stays private (no anonymous read).
        //   - public -> advertise the CMAF manifest URLs recorded on the asset,
        //               resolved to the public-facing MinIO/CDN origin at read
        //               time (issue #200); a missing/invalid public origin is
        //               surfaced as an explicit 501, not a relative/internal path.
        if (deliveryMode() === 'proxy') {
          const proxyBase = assetsBaseUrl(request.url);
          // A proxy URL is only fully resolvable when the API's public origin is
          // configured (PUBLIC_BASE_URL). Without it `assetsBaseUrl` yields a
          // relative path, so `proxyManifestUrlsFor` would produce a bare,
          // non-resolvable URL — exactly what issue #506 forbids advertising as
          // ready. In that case public delivery is NOT configured: return an
          // unambiguous `not_configured` response (no playback URL) plus the
          // packaged-location metadata for deterministic client-side resolution.
          if (!isAbsoluteUrl(proxyBase)) {
            return reply.code(200).send(
              notConfiguredDelivery(asset, expiresAt)
            );
          }
          const proxied = proxyManifestUrlsFor(asset.id, proxyBase);
          return reply.code(200).send({
            assetId: asset.id,
            status: 'ready',
            // Only advertise a proxy URL for a format the asset actually produced.
            urls: {
              hls: asset.manifestUrls.hls ? proxied.hls : undefined,
              dash: asset.manifestUrls.dash ? proxied.dash : undefined
            },
            expiresAt
          });
        }
        try {
          // In the default `public` mode, `resolvePublicManifestUrl` returns a
          // genuinely public absolute URL only when PACKAGED_PUBLIC_BASE_URL is
          // configured. On the zero-config per-stack MinIO backend it hands back
          // the stored value verbatim (issue #320), which is a bare object-key
          // path (e.g. `/openvideocore-packaged/<id>/<uuid>/index.m3u8`) with no
          // scheme/host and no signature — not fetchable by a player, and OSC
          // MinIO blocks external presigned/public GETs. When the resolved value
          // is still non-absolute, route the manifest through the authorized
          // stream proxy instead (issue #341), mirroring the DELIVERY_MODE=proxy
          // branch above so `delivery.hls`/`delivery.dash` are always absolute,
          // resolvable URLs — consistent with how `source` is emitted. The proxy
          // base is derived from PUBLIC_BASE_URL / request context via
          // `assetsBaseUrl`, never hardcoded.
          const proxyBase = assetsBaseUrl(request.url);
          const proxied = proxyManifestUrlsFor(asset.id, proxyBase);
          // Whether the stream-proxy fallback can yield a fully-resolvable
          // (absolute) URL — only when the API's public origin is configured
          // (PUBLIC_BASE_URL). See the DELIVERY_MODE=proxy branch above.
          const proxyResolvable = isAbsoluteUrl(proxyBase);
          const toAbsolute = (
            stored: string | undefined,
            proxyUrl: string | undefined
          ): string | undefined => {
            if (!stored) return undefined;
            const resolved = resolvePublicManifestUrl(stored);
            if (isAbsoluteUrl(resolved)) return resolved;
            // The stored value is a bare object-key path (zero-config MinIO). It
            // is only resolvable through the proxy when the proxy base itself is
            // absolute; otherwise there is no resolvable URL to advertise.
            return proxyResolvable ? proxyUrl : undefined;
          };
          const hls = toAbsolute(asset.manifestUrls.hls, proxied.hls);
          const dash = toAbsolute(asset.manifestUrls.dash, proxied.dash);
          // Neither format resolved to a playable URL although packaged output
          // exists → public delivery is not configured. Never advertise a 200
          // that looks ready with no resolvable URL (issue #506): emit the
          // explicit `not_configured` signal + resolution metadata instead.
          if (!hls && !dash) {
            return reply.code(200).send(notConfiguredDelivery(asset, expiresAt));
          }
          return reply.code(200).send({
            assetId: asset.id,
            status: 'ready',
            urls: { hls, dash },
            expiresAt
          });
        } catch (err) {
          if (err instanceof PublicManifestBaseUrlError) {
            return reply.code(501).send({
              error: 'not_configured',
              message: err.message
            });
          }
          throw err;
        }
      }

      // Fallback: the raw source object. For an external source backend emit a
      // public/derived object URL (never credential-bearing) against the source
      // public base. For the MinIO backend keep the presigned-GET proxy path,
      // which requires object storage to be configured.
      if (asset.objectKey) {
        if (sourceBase) {
          const source = externalObjectUrl(sourceBase, asset.objectKey);
          return reply
            .code(200)
            .send({ assetId: asset.id, status: 'ready', urls: { source }, expiresAt });
        }
        if (!storageFor) {
          return reply.code(501).send({
            error: 'not_configured',
            message: 'object storage is not configured'
          });
        }
        const source = await storageFor().presignedGet(asset.objectKey, ttl);
        return reply
          .code(200)
          .send({ assetId: asset.id, status: 'ready', urls: { source }, expiresAt });
      }

      // Nothing to deliver yet (no packaged output and no stored source object).
      return reply.code(404).send({
        error: 'no_delivery',
        message: 'asset has no packaged output or stored source object to deliver'
      });
    }
  );

  // Proxy delivery of packaged output (issue #201). The alternative to the
  // anonymous-public bucket: instead of exposing the packaged bucket for
  // anonymous GET, packaged objects (manifests + CMAF segments) are streamed
  // back through THIS authorized route, so the bucket stays private (desirable
  // for multi-tenant deployments). `GET /:id/delivery` advertises these URLs
  // when DELIVERY_MODE=proxy; a player fetches the manifest here and, because
  // manifest segment references are relative, resolves each segment back through
  // this same prefix (`.../:id/stream/<relative>`).
  //
  // The wildcard `*` is the object path RELATIVE to the asset's packaged prefix
  // (e.g. `index.m3u8`, `manifest.mpd`, `seg-00001.m4s`). It maps to the key
  // `outputPrefix(assetId)/<relative>` inside the PACKAGED bucket. The SOURCE
  // bucket is never touched here — only packaged output is proxied.
  //   200 — object stream
  //   404 — unknown asset, or the packaged object does not exist
  //   501 — object storage is not configured here
  app.get(
    '/:id/stream/*',
    {
      schema: { params: z.object({ id: z.string(), '*': z.string() }) }
    },
    async (request, reply) => {
      const asset = await repo.get(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }

      const storageClient = request.connections?.storageClient;
      if (!storageClient) {
        return reply.code(501).send({
          error: 'not_configured',
          message: 'object storage is not configured'
        });
      }

      // Reject empty / traversal paths early; WorkspaceStorage.scopedKey also
      // rejects `..`, but returning a clean 404 avoids leaking a 500.
      const relative = request.params['*'].replace(/^\/+/, '');
      if (relative.length === 0 || relative.includes('..')) {
        return reply.code(404).send({ error: 'not_found' });
      }

      // Bind storage to the private PACKAGED bucket (mirrors the /:id/files
      // rendition handling, which builds a WorkspaceStorage per target bucket).
      const bucket = request.connections?.packagedBucket ?? packagedBucket();
      const packagedStorage = new WorkspaceStorage(storageClient, bucket);
      // Resolve the REAL packaged prefix the packager wrote under (issue #503):
      // the persisted job-nested `<assetId>/<packagerJobId>` (#502), or the lazy
      // list fallback, or the historical flat `packaged/<id>`. The master
      // manifests (`index.m3u8`/`manifest.mpd`) and every relatively-referenced
      // child playlist/segment all live under this prefix, so the SAME prefix is
      // used both for the object key AND the manifest-rewrite context — keeping
      // the rewritten child references (which resolve back through this route)
      // consistent with the objects they map to.
      const streamPrefix = await resolveStreamPrefix(asset, storageClient, bucket);
      const objectKey = `${streamPrefix}/${relative}`;
      const contentType = contentTypeForPackagedObject(relative);

      // stat first so we can (a) return a clean 404 for a missing object without
      // opening a body stream, (b) advertise Accept-Ranges + Content-Length, and
      // (c) resolve a Range header against the real object size. statObject
      // returns undefined for a missing key (mapped to 404 below).
      let stat: Awaited<ReturnType<WorkspaceStorage['statObject']>>;
      try {
        stat = await packagedStorage.statObject(objectKey);
      } catch (err) {
        if (
          (err as { code?: string }).code === 'NoSuchKey' ||
          (err as { code?: string }).code === 'NotFound'
        ) {
          return reply.code(404).send({ error: 'not_found' });
        }
        throw err;
      }
      if (!stat) {
        return reply.code(404).send({ error: 'not_found' });
      }

      // Honor a single HTTP Range request for segment fetches. Manifests are
      // small and typically fetched whole, but players routinely issue ranged
      // GETs for CMAF media segments; supporting them keeps byte-range addressed
      // playback working through the proxy (issue #339). A malformed/multi-range
      // header falls through to a full 200 response (a valid outcome per RFC 7233).
      const parsed = parseByteRange(request.headers['range'], stat.size);
      if (parsed && 'unsatisfiable' in parsed) {
        return reply
          .code(416)
          .header('Content-Range', `bytes */${stat.size}`)
          .send({ error: 'range_not_satisfiable' });
      }

      // Manifests (.m3u8/.mpd) are rewritten so their child references — variant
      // playlists, the audio group, CMAF init + media segments, DASH
      // BaseURL/SegmentTemplate — resolve back through THIS proxy prefix instead
      // of escaping to a bare object-store host or an unsigned URL (issue #340,
      // building on #333). The rewrite is a text transform applied ONLY to the
      // proxied response: the stored bytes are never mutated. Because the
      // transform changes the body length, a manifest is served whole (200) and
      // never as a Range slice — Range remains for the (untouched) segment bytes.
      if (isManifestPath(relative)) {
        let manifestBody: string;
        try {
          const stream = await packagedStorage.getObject(objectKey);
          manifestBody = await readStreamToString(stream);
        } catch (err) {
          if (
            (err as { code?: string }).code === 'NoSuchKey' ||
            (err as { code?: string }).code === 'NotFound'
          ) {
            return reply.code(404).send({ error: 'not_found' });
          }
          throw err;
        }

        // Proxy base up to and including `<id>/stream` (no trailing slash), so
        // `<proxyBase>/<relative>` is a proxy URL for a packaged object. Derived
        // from the request path (minus the wildcard tail), PUBLIC_BASE_URL-aware
        // so the rewritten URLs share the origin the delivery endpoint advertises.
        const proxyBase = streamProxyBaseUrl(request.url, request.params['*']);
        const rewriteCtx: ManifestRewriteContext = {
          proxyBase,
          manifestRelativePath: relative,
          packagedPrefix: streamPrefix,
          packagedBucket: bucket
        };
        const rewritten = rewriteManifest(relative, manifestBody, rewriteCtx);

        return reply
          .header('Content-Type', contentType)
          .header('Cache-Control', 'no-cache')
          .send(rewritten);
      }

      // Segments are immutable so may be cached; manifests handled above. Keep it
      // conservative and let a fronting CDN/proxy override if desired.
      // Accept-Ranges advertises range support so a player knows it can issue
      // ranged segment GETs.
      reply
        .header('Content-Type', contentType)
        .header('Cache-Control', 'no-cache')
        .header('Accept-Ranges', 'bytes');

      try {
        if (parsed) {
          const length = parsed.end - parsed.start + 1;
          const stream = await packagedStorage.getPartialObject(
            objectKey,
            parsed.start,
            length
          );
          return reply
            .code(206)
            .header('Content-Range', `bytes ${parsed.start}-${parsed.end}/${stat.size}`)
            .header('Content-Length', String(length))
            .send(stream);
        }
        const stream = await packagedStorage.getObject(objectKey);
        return reply
          .header('Content-Length', String(stat.size))
          .send(stream);
      } catch (err) {
        // A key that vanished between stat and read (or a backend NoSuchKey) is a
        // 404 rather than a 500 so a racing purge does not leak an error.
        if (
          (err as { code?: string }).code === 'NoSuchKey' ||
          (err as { code?: string }).code === 'NotFound'
        ) {
          return reply.code(404).send({ error: 'not_found' });
        }
        throw err;
      }
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
      // objectKeyPrefix is derived from the manifest's path and normalized to
      // EXCLUDE the packaged bucket (issue #342) so it follows the same
      // bucket-excluded convention as rendition objectKey and the proxy route —
      // callers construct segment keys without special-casing an embedded bucket.
      // Passing the effective packaged bucket also strips the bucket from prefixes
      // persisted before #342 (back-compat on read).
      const packagedBucketName = request.connections?.packagedBucket ?? packagedBucket();
      const fileGroups: z.infer<typeof assetFileGroupSchema>[] = [];
      const manifests = asset.manifestUrls;

      // Resolve each manifest to an absolute, fetchable URL the same way
      // /:id/delivery does (issue #341 fix, previously applied only there): on
      // the zero-config MinIO backend `manifestUrls.hls`/`.dash` is stored as a
      // bare bucket-relative object-key path (e.g.
      // `/openvideocore-packaged/<id>/<uuid>/index.m3u8`) with no scheme/host,
      // so the ops UI's "Open" link (public/app.js) was unclickable. Route
      // through the authorized stream proxy when the stored value doesn't
      // already resolve to something absolute.
      const proxied = proxyManifestUrlsFor(asset.id, assetsBaseUrl(request.url));
      const toAbsoluteManifestUrl = (stored: string, proxyUrl: string | undefined): string => {
        const resolved = resolvePublicManifestUrl(stored);
        return isAbsoluteUrl(resolved) ? resolved : proxyUrl ?? resolved;
      };

      try {
        if (manifests?.hls) {
          fileGroups.push({
            id: 'hls',
            type: 'hls-package',
            name: 'HLS',
            manifestUrl: toAbsoluteManifestUrl(manifests.hls, proxied.hls),
            objectKeyPrefix: objectKeyPrefixFromManifest(manifests.hls, packagedBucketName)
          });
        }
        if (manifests?.dash) {
          fileGroups.push({
            id: 'dash',
            type: 'dash-package',
            name: 'DASH',
            manifestUrl: toAbsoluteManifestUrl(manifests.dash, proxied.dash),
            objectKeyPrefix: objectKeyPrefixFromManifest(manifests.dash, packagedBucketName)
          });
        }
      } catch (err) {
        if (err instanceof PublicManifestBaseUrlError) {
          return reply.code(501).send({
            error: 'not_configured',
            message: err.message
          });
        }
        throw err;
      }

      return reply.code(200).send({ files, fileGroups });
    }
  );

  // On-demand (re-)extraction of technical metadata (issues #6, #281).
  // Workspace-scoped and behind `authenticate`. Two modes:
  //
  //   RE-DRIVE (issue #281): when the asset is WEDGED — stuck in `processing`
  //   with a `technicalMetadataError` set (typically after a prior conflict or
  //   probe failure) — this runs the extraction SYNCHRONOUSLY and reports the
  //   settled outcome (200). On success the extractor clears
  //   `technicalMetadataError`, populates `technicalMetadata`, and advances the
  //   lifecycle `processing -> ready`. This gives an operator a reliable, single
  //   call to recover a wedged asset. Idempotent: re-driving an already-`ready`
  //   asset simply re-runs extraction and stays `ready` (safe no-op). The
  //   extractor never throws (it records failures on the asset); the resolved
  //   status is read back and returned so a persistent failure is observable.
  //
  //   FIRE-AND-FORGET (issue #6): for a non-wedged asset the extraction is kicked
  //   off detached and the route returns 202 immediately; the caller polls
  //   GET /:id to observe `technicalMetadata` / `technicalMetadataError`.
  //
  //   200 — re-drive completed synchronously; body reports the resolved status
  //   202 — extraction accepted (fire-and-forget)
  //   404 — unknown/foreign asset (existence not leaked)
  //   409 — the asset has no stored object yet (nothing to probe)
  //   501 — extraction is not configured on this deployment
  app.post(
    '/:id/extract-metadata',
    {

      schema: {
        params: z.object({ id: z.string() }),
        response: {
          200: z.object({ assetId: z.string(), status: z.string() }),
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
      // Unified source-object resolution (issue #612): every source-consuming
      // operation resolves the source through this ONE code path so a missing
      // source fails identically (409 no_object) everywhere.
      const source = requireSourceObject(asset, reply);
      if (!source) return reply;
      if (!opts.probe || !storageFor) {
        return reply.code(501).send({
          error: 'not_configured',
          message: 'technical metadata extraction is not configured'
        });
      }
      // A wedged asset (issue #281): stuck in `processing` with a recorded
      // extraction error. Re-drive synchronously so the caller learns whether
      // the asset recovered to `ready`.
      const wedged = asset.status === 'processing' && asset.technicalMetadataError !== undefined;
      if (wedged) {
        await runExtractionSync(asset.id, source.objectKey);
        const settled = await repo.get(asset.id);
        return reply.code(200).send({
          assetId: asset.id,
          status: settled?.status ?? asset.status
        });
      }
      triggerExtraction(asset.id, source.objectKey);
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
          400: errorSchema,
          404: errorSchema,
          409: errorSchema,
          422: errorSchema,
          429: jobThroughputCapSchema,
          501: errorSchema,
          502: errorSchema,
          504: dependencyUnreachableSchema
        }
      }
    },
    async (request, reply) => {
      const asset = await repo.get(request.params.id);
      if (!asset) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // Unified source-object resolution (issue #612).
      const source = requireSourceObject(asset, reply);
      if (!source) return reply;
      if (!opts.encore || !opts.sourceBucket || !opts.outputBucket) {
        return reply.code(501).send({
          error: 'not_configured',
          message: 'transcoding is not configured'
        });
      }
      // Non-fatal warning surfaced in the 202 response when profileParams
      // validation was SKIPPED (profile YAML unresolvable) — issue #394. Set
      // inside the skipped branch below; spread into the accepted response only
      // when present. Undefined when validation ran (passed) or there were no
      // profileParams.
      let profileParamsWarning:
        | { code: 'profile_params_unvalidated'; message: string; profile: string; unvalidatedKeys: string[] }
        | undefined;
      // Reject a named GPU-only (NVENC/CUDA) profile that cannot execute on this
      // platform tier (issue #286) before submitting to Encore.
      const unrunnable = await unrunnableProfileReason(request.body.profile);
      if (unrunnable) {
        return reply.code(422).send({ error: 'profile_unrunnable', message: unrunnable });
      }
      // Reject a profile whose colour signalling is not carriable at its pixel
      // format (issue #377) before submitting to Encore, so a mistagged output
      // (e.g. an 8-bit stream tagged PQ) is never encoded and paid for.
      const uncarriable = await uncarriableColourReason(request.body.profile);
      if (uncarriable) {
        return reply.code(422).send({ error: 'profile_colour_uncarriable', message: uncarriable });
      }
      // Validate profileParams keys against the SpEL params the chosen profile
      // actually declares (issue #290). We resolve the profile YAML from the
      // operator-managed profile store — the same profiles GET /api/v1/profiles
      // serves and Encore loads — and reject keys that profile does not declare
      // with a descriptive 400, so a mistyped SpEL param name is an actionable
      // error rather than a silently-ignored value. Degrades gracefully: a
      // custom profile (not in the store) or an unresolvable profile is treated
      // permissively (validateProfileParams passes an undefined YAML through), so
      // custom/operator profiles are never falsely rejected. An empty/absent map
      // always passes.
      if (request.body.profileParams && !request.body.customProfile) {
        const profileName = request.body.profile ?? 'program';
        // Resolve the profile YAML while distinguishing a genuine not-found from
        // an unreachable profile store (issue #392). A store outage makes
        // ProfileRepository.get() THROW (couch-profile-repo does not catch); the
        // resolver captures that so a store outage no longer turns a transcode
        // submit into an uncaught 500. Behaviour stays PERMISSIVE: in BOTH the
        // not-found and store-unreachable cases we pass an undefined YAML into
        // validateProfileParams exactly as before, so the request still submits.
        const resolution = await resolveProfileYaml(opts.profileRepository, profileName);
        // The resolved status is kept as a local so the sibling issues can
        // consume the distinction: #393 (logging the store-unreachable case) and
        // #394 (a response warning field). Neither is implemented here.
        const check = validateProfileParams({
          profileName,
          profileYaml: resolution.status === 'found' ? resolution.yaml : undefined,
          profileParams: request.body.profileParams
        });
        // When validation was SKIPPED (the profile YAML could not be resolved),
        // the request still succeeds permissively — but a mistyped profile name
        // plus a mistyped param name would otherwise pass silently, and a store
        // outage would silently skip validation for its whole duration. Emit ONE
        // log line so an operator gets feedback (issue #393). No behavioural
        // change: the request is still accepted regardless. The same skipped
        // signal will be surfaced in the response by #394. We distinguish a
        // store outage (warn — an operator should notice; carry the captured
        // error) from an ordinary profile-not-found / custom-profile use (info)
        // via a machine-readable `reason` field.
        if (check.ok && !check.validated) {
          const skipped = {
            profileName: check.profileName,
            unvalidatedKeys: check.unvalidatedKeys
          };
          // Surface the skipped validation as a non-fatal warning in the 202
          // response (issue #394). The request is still accepted; these keys
          // were forwarded to Encore unchecked.
          profileParamsWarning = {
            code: 'profile_params_unvalidated',
            message:
              `profileParams validation was skipped: profile '${check.profileName}' could not be ` +
              `resolved, so the following keys were forwarded to Encore unchecked: ` +
              `${check.unvalidatedKeys.join(', ')}.`,
            profile: check.profileName,
            unvalidatedKeys: check.unvalidatedKeys
          };
          if (resolution.status === 'store-unreachable') {
            request.log.warn(
              { ...skipped, reason: 'store-unreachable' as const, err: resolution.error },
              'profileParams validation skipped: profile store unreachable'
            );
          } else {
            request.log.info(
              { ...skipped, reason: 'profile-not-found' as const },
              'profileParams validation skipped: profile not found'
            );
          }
        }
        // Only a hard reject (`ok: false`) turns into a 400. Both a genuine
        // pass and the explicit skipped/permissive result (`validated: false`,
        // profile YAML unresolvable) keep `ok: true` and are request-accepted;
        // richer handling of the skipped result (logging, response warning) is
        // deferred to sibling issues #392/#393/#394. (issue #391)
        if (!check.ok) {
          return reply.code(400).send({
            error: 'unknown_profile_params',
            message: check.message
          });
        }
      }
      // Burn-in caption source (issue #388, ADR-014). Optional + additive:
      // resolve the requested source to ONE concrete workspace-local S3 object
      // key and build the FFmpeg `subtitles=` filter that gets threaded into the
      // selected profile's VideoEncode filters via profileParams (D3). Format
      // gating (srt/vtt only) rejects ttml at request time (D4); a referenced
      // track with no stored file yet is a distinct "not ready" outcome whose
      // wait/queue policy #389 owns — here we surface it as a 409 so the caller
      // learns the source is not yet burnable (this issue does not implement the
      // wait). Absent `burnIn` => no filter, clean rendition (unchanged).
      let burnInSubtitlesFilter: string | undefined;
      if (request.body.burnIn) {
        // Styling override (issue #390): validate the caller's `forceStyle` against
        // the allowlist + safe charset BEFORE resolving/dispatching. This CLOSES
        // the filter-injection hole #388 left (raw forwarding into
        // force_style='...'): a quote/comma/colon/backslash/newline — anything that
        // could escape the quoting and inject filtergraph content — is rejected
        // here with a 422 and never reaches buildSubtitlesFilter. Only the
        // canonical, allowlisted string is composed into the filter.
        let canonicalForceStyle: string | undefined;
        if (request.body.burnIn.forceStyle !== undefined && request.body.burnIn.forceStyle.trim() !== '') {
          const styleCheck = validateForceStyle(request.body.burnIn.forceStyle);
          if (!styleCheck.ok) {
            return reply.code(422).send({ error: 'burn_in_invalid_force_style', message: styleCheck.message });
          }
          canonicalForceStyle = styleCheck.canonical;
        }
        const resolved = resolveBurnInSource(
          request.body.burnIn.source,
          asset.subtitleTracks
        );
        if (!resolved.ok) {
          if (resolved.reason === 'track_not_found') {
            return reply.code(404).send({ error: 'subtitle_track_not_found', message: resolved.message });
          }
          if (resolved.reason === 'unsupported_format') {
            return reply.code(422).send({ error: 'burn_in_unsupported_format', message: resolved.message });
          }
          // not_ready: the referenced track exists but its objectKey is still
          // undefined (asset-repo says the file has not landed). Distinct from
          // the object-existence race below (#389) — here we have no key at all.
          return reply.code(409).send({ error: 'burn_in_source_not_ready', message: resolved.message });
        }
        // #389: CLOSE the generation race. `resolveBurnInSource` proved the
        // request NAMES a concrete key; now verify the key's BYTES have actually
        // landed in the workspace object store BEFORE dispatch. Subtitle
        // generation is fire-and-forget (subtitle-generator.ts), so a resolved
        // key — a caller-supplied `sidecarKey`, or a `subtitleTrack.objectKey`
        // set before the generation callback landed — can point at an object that
        // does not yet exist or is still zero-length. Either would silently burn
        // NO captions, so we FAIL the submission with a specific 409
        // (`burn_in_source_not_available`, distinct from #388's
        // `burn_in_source_not_ready` no-objectKey case) and never dispatch. The
        // check reuses WorkspaceStorage.statObject (src/data/storage.ts:92-102),
        // the same presence plumbing the rest of the routes use, against the
        // workspace/source bucket where generated sidecars land
        // (subtitle-generator.ts:101-103 destinationKey). ADR-014 D1/D2 chose the
        // explicit-source model, so a clear error at submit time is the natural
        // guarantee (no open-ended wait).
        if (!storageFor) {
          // No object store wired on this deployment — we cannot verify the
          // sidecar exists, so we MUST NOT dispatch a possibly-captionless burn.
          return reply.code(501).send({
            error: 'burn_in_storage_unavailable',
            message: 'burn-in requires object storage to verify the caption source exists, but object storage is not configured on this deployment'
          });
        }
        const availability = await checkBurnInObjectAvailable(resolved.objectKey, storageFor());
        if (!availability.available) {
          return reply.code(409).send({
            error: 'burn_in_source_not_available',
            message: availability.message
          });
        }
        burnInSubtitlesFilter = buildSubtitlesFilter(resolved.objectKey, canonicalForceStyle);
      }
      // Resolve the transcode output bucket from the caller's per-stack packaged
      // bucket (issue #638). request.connections.packagedBucket is the stack's
      // persisted `packagedStorage.bucket` (workspace-stack.ts config.packagedBucket,
      // from the parameter store at provision time per ADR-002); fall back to the
      // deployment-wide opts.outputBucket (MINIO_PACKAGED_BUCKET) only when no
      // per-stack value exists. Output PATH template is unchanged.
      const resolvedOutputBucket =
        request.connections?.packagedBucket ?? opts.outputBucket;
      try {
        // FAST reachability preflight (issue #617): before enqueuing work, probe
        // the stack's dependencies (queue/Valkey via the shared IORedis ping,
        // storage via the per-stack MinioClient bucketExists) under the SAME
        // bounded deadline the submit writes use (#616). An unhealthy stack is
        // rejected promptly with the SAME named-dependency 504 the submit-path
        // catch below already maps — turning a silent ~50s socket-drop into an
        // up-front, actionable signal. Coordinates are per-stack (redis client
        // options + request.connections), never process-global. The guard is
        // opt-in: a dependency with no wired probe client is reported
        // not_configured and does NOT trip the guard, so deployments/tests
        // without a live queue/storage submit exactly as before.
        const queueEndpoint = opts.packagingRedis
          ? `redis://${opts.packagingRedis.options.host ?? 'localhost'}:${
              opts.packagingRedis.options.port ?? 6379
            }`
          : undefined;
        const preflight = await checkStackReachability(
          {
            stackName: DEPLOYMENT_CONTEXT,
            ...(queueEndpoint ? { redisUrl: queueEndpoint } : {}),
            ...(request.connections?.s3Config
              ? { minioEndpoint: request.connections.s3Config.endpoint }
              : {}),
            bucket: opts.sourceBucket
          },
          {
            ...(opts.packagingRedis ? { queueClient: opts.packagingRedis } : {}),
            ...(request.connections?.storageClient
              ? { storageClient: request.connections.storageClient }
              : {})
          }
        );
        const unreachable = firstUnreachable(preflight);
        if (unreachable) throw unreachable;

        const result = await submitTranscode(
          {
            // Key the scaler pool/queue/S3 endpoint by the EFFECTIVE stack this
            // request routes to (issue #615), resolved from X-Stack-Name, not
            // the fixed deployment context — so a transcode against a healthy
            // named stack reaches that stack regardless of provisioning order.
            workspaceId: await transcodeContext(request),
            sourceAssetId: asset.id,
            sourceObjectKey: source.objectKey,
            preset: request.body.profile,
            customProfile: request.body.customProfile as EncoreProfile | undefined,
            profileParams: request.body.profileParams,
            burnInSubtitlesFilter,
            // Read the transcode INPUT from the resolved stack's per-stack
            // source bucket (StackConfig.sourceBucket, param-store key
            // `sourceBucket` per ADR-002; carried on WorkspaceConnections.
            // sourceBucket) rather than the deployment-wide boot default
            // (opts.sourceBucket from MINIO_SOURCE_BUCKET) — issue #639. The
            // fallback preserves the env-override / single-stack deployments
            // where request.connections is absent. Output/packaged resolution
            // (resolvedOutputBucket) is issue #638.
            sourceBucket: request.connections?.sourceBucket ?? opts.sourceBucket,
            outputBucket: resolvedOutputBucket
          },
          { jobs, assets: repo, encore: opts.encore, audit, auditLog: request.log }
        );
        return reply
          .code(202)
          .send({ ...result, ...(profileParamsWarning ? { warning: profileParamsWarning } : {}) });
      } catch (err) {
        // A stack dependency (queue/Valkey, Encore, storage) was unreachable or
        // did not respond within the bounded deadline (#616). Fail fast with a
        // 504 that NAMES the dependency + endpoint, and log server-side with
        // enough detail (stack, dependency, endpoint, cause) to diagnose without
        // a live repro — never let the connection drop silently.
        if (isDependencyUnreachableError(err)) {
          request.log.error(
            {
              err,
              dependency: err.dependency,
              endpoint: err.endpoint,
              stackName: err.stackName,
              operation: err.operation,
              reason: err.reason,
              timeoutMs: err.timeoutMs
            },
            'transcode submit failed: stack dependency unreachable'
          );
          return reply.code(504).send(err.toResponseBody());
        }
        // Optional operator-configured job-throughput cap exceeded (issue #580):
        // accepting this job would push the deployment past its outstanding-job
        // ceiling. Return the documented machine-readable 429 + reason code so a
        // client can back off, rather than silently queueing unboundedly.
        if (isJobThroughputCapExceededError(err)) {
          return reply.code(err.statusCode).send(err.toResponseBody());
        }
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
        body: z.object({
          encoreJobId: z.string().min(1).optional(),
          // Per-execution destination override (issue #207/#208), pipeline-mode
          // only (ignored when an explicit encoreJobId is enqueued directly).
          // Validated + trailing-slash-normalized at the edge.
          destinationBucket: destinationBucketSchema.optional(),
          // Named export-destination reference (issue #573): the stable id OR
          // name of a registered output-role destination. Resolved server-side
          // to the SAME `destinationBucket` the relocation consumes. Mutually
          // exclusive with the inline `destinationBucket` override.
          destination: z.string().min(1).max(256).optional()
        }),
        response: {
          202: z.object({ ok: z.literal(true), jobId: z.string().optional(), pipelineMode: z.boolean().optional() }),
          400: z.object({ error: z.string(), message: z.string() }),
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
        // Resolve a named export-destination reference OR the inline override
        // into the single `destinationBucket` string the relocation consumes
        // (issue #573). Rejects an ambiguous both-supplied request with 400.
        const resolvedDestination = await resolveJobDestination(
          {
            destination: request.body.destination,
            destinationBucket: request.body.destinationBucket,
            assetId: asset.id
          },
          reply
        );
        if (!resolvedDestination.ok) return reply; // error already sent
        const started = await startPipelineExecution(
          asset,
          'abr-vod',
          request,
          reply,
          undefined,
          resolvedDestination.destinationBucket
        );
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
          customProfile: customProfileSchema.optional(),
          // profileParams (issue #288): reuses the same flat string map validated
          // on POST /:id/transcode (profileParamsSchema, issue #287) and forwards
          // it into the shared transcode submission path so SpEL-parametrised
          // profiles (x264-crf-parametrized, program-kf) work from execute too.
          // Omitted -> execute behaviour unchanged.
          profileParams: profileParamsSchema.optional(),
          // Optional per-execution destination override (issue #207). Validated
          // and trailing-slash-normalized at the edge; persisted on the
          // execution record for #208 (packager relocation) / #210 (delivery).
          destinationBucket: destinationBucketSchema.optional(),
          // Optional named export-destination reference (issue #573): the stable
          // id OR name of a registered output-role destination
          // (/api/v1/export-destinations). Resolved server-side to the SAME
          // `destinationBucket` the relocation consumes. Mutually exclusive with
          // both `externalBackend` and the inline `destinationBucket` override
          // (more than one output destination -> 400).
          destination: z.string().min(1).max(256).optional(),
          // Optional reference (id OR name) to a registered external storage
          // backend (issue #549, ADR-017 D4). When set, this execution's
          // transcode/package OUTPUT is written to that backend's bucket instead
          // of OSC-managed default storage, resolved to the backend's NON-SECRET
          // coordinates at job time (credentials stay in OSC secrets). Mutually
          // exclusive with `destination` and the inline `destinationBucket`
          // override (all name an output destination).
          externalBackend: z.string().trim().min(1).max(256).optional()
        }),
        response: {
          202: pipelineExecutionSchema,
          400: errorSchema,
          404: z.object({ error: z.string() }),
          409: errorSchema,
          422: errorSchema,
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
      // Resolve the requested output destination (at most one of the named
      // export-destination reference #573, the external-backend reference #549,
      // or the inline override) into the single `destinationBucket` string the
      // relocation consumes. Done here (before startPipelineExecution) so a
      // dangling/unconfigured/ambiguous reference is a clean synchronous error and
      // the downstream path stays destination-only. Each path keeps its own error
      // semantics (#573: 400/501; #549: 400/501/422).
      const resolvedDestination = await resolveJobDestination(
        {
          destination: request.body.destination,
          externalBackend: request.body.externalBackend,
          destinationBucket: request.body.destinationBucket,
          assetId: asset.id
        },
        reply
      );
      if (!resolvedDestination.ok) return reply; // error already sent
      const started = await startPipelineExecution(
        asset,
        request.body.pipeline as keyof typeof BUILT_IN_PIPELINES,
        request,
        reply,
        {
          profile: request.body.profile,
          customProfile: request.body.customProfile as EncoreProfile | undefined,
          profileParams: request.body.profileParams
        },
        resolvedDestination.destinationBucket
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
      // Unified source-object resolution (issue #612).
      const source = requireSourceObject(asset, reply);
      if (!source) return reply;
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
            objectKey: source.objectKey,
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
      // Unified source-object resolution (issue #612).
      const source = requireSourceObject(asset, reply);
      if (!source) return reply;
      if (!opts.rewrapRunner || !storageFor) {
        return reply.code(501).send({
          error: 'not_configured',
          message: 'export / re-wrap is not configured'
        });
      }
      // Resolve the injected runner. In production it is a factory that needs
      // the workspace's s3Config + bucket so the OSC ffmpeg job writes the
      // output to `s3://bucket/key` natively (issue #316); tests inject a plain
      // RewrapRunner and no s3Config, so fall back to using it directly. Mirrors
      // the thumbnail extractor resolution above.
      const s3Cfg = request.connections?.s3Config;
      const resolvedRewrapRunner =
        typeof opts.rewrapRunner === 'function' && s3Cfg
          ? (opts.rewrapRunner as (s3: { endpoint: string; accessKey: string; secretKey: string; bucket: string }) => RewrapRunner)({
              ...s3Cfg,
              bucket: request.connections?.sourceBucket ?? 'openvideocore-source'
            })
          : (opts.rewrapRunner as RewrapRunner);
      try {
        const child = await rewrapRunner(
          {
            sourceAssetId: asset.id,
            objectKey: source.objectKey,
            targetFormat: request.body.targetFormat,
            outputName: request.body.outputName,
            asVersion: request.body.asVersion
          },
          {
            assets: repo,
            storage: storageFor(),
            runner: resolvedRewrapRunner,
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
      // Unified source-object resolution (issue #612).
      const source = requireSourceObject(asset, reply);
      if (!source) return reply;
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
            objectKey: source.objectKey,
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
  //
  // Title is NOT part of this free-form `metadata`/`custom` bag (issue #347):
  // the canonical editorial title lives at `descriptive.title` and is exposed on
  // every response — including the full asset returned here — as the top-level
  // `name` property. This endpoint never reads or writes title; a `title` key
  // placed inside the `metadata` body is stored as free-form custom metadata and
  // has NO effect on the asset's title. Set title via the ingest `title` field.
  //   200 — metadata replaced, full asset returned (title is the `name` field)
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
      // Audit: asset metadata edited (issue #564). Emitted only on a real edit
      // (the asset resolved); a 404 is not a mutation and produces no entry.
      emitAudit(
        audit,
        {
          actor: originActor('user'),
          action: 'asset.metadata_updated',
          targetType: 'asset',
          targetId: updated.id,
          detail: { keys: Object.keys(request.body ?? {}) }
        },
        request.log
      );
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
      // Capture the pre-patch status so a lifecycle transition can be audited
      // with an accurate `from` and only when the status actually changed. Read
      // ONCE here (before the write) so no extra read is added on the hot path
      // when no status field is present.
      const priorStatus =
        request.body.status !== undefined
          ? (await repo.get(request.params.id))?.status
          : undefined;
      const updated = await repo.update(request.params.id, request.body);
      if (!updated) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // Audit: lifecycle/status transition (issue #564). Exactly one entry, and
      // ONLY when the PATCH carried a `status` that moved the asset to a new
      // lifecycle state (a no-op same-status PATCH is not a transition).
      if (
        request.body.status !== undefined &&
        priorStatus !== undefined &&
        priorStatus !== updated.status
      ) {
        emitAudit(
          audit,
          {
            actor: originActor('user'),
            action: 'asset.status_changed',
            targetType: 'asset',
            targetId: updated.id,
            detail: { from: priorStatus, to: updated.status }
          },
          request.log
        );
      }
      return reply.code(200).send(updated);
    }
  );

  app.delete(
    '/:id',
    {

      schema: {
        params: z.object({ id: z.string() }),
        // `?force=true` (ADR-020 decision 2) overrides the SOFT
        // member_of_collection block. It never defeats the HARD explicit lock or
        // the pre-existing has_children integrity block. `z.coerce.boolean()`
        // matches the established force convention (cf. profiles.ts POST /seed).
        querystring: z.object({ force: z.coerce.boolean().optional() }),
        // 409 covers BOTH the pre-existing `has_children` block (the base
        // `{ error, message? }` envelope) and the new explicit-lock
        // `delete_blocked` envelope (ADR-020). A union keeps the has_children
        // serialization unchanged while adding the richer lock shape.
        response: { 204: z.null(), 404: errorSchema, 409: z.union([deleteBlockedSchema, errorSchema]) }
      }
    },
    async (request, reply) => {
      // Explicit delete-lock (ADR-020 decisions 1 & 2, issue #568). A locked
      // asset is a HARD block: this guard is unconditional and runs BEFORE the
      // archive, so `?force=true` cannot bypass it (force is never consulted
      // here). Cleared only via DELETE /:id/lock. Surfaces the shared
      // `delete_blocked` envelope with reason `delete_protected` (empty
      // blockedBy) via DeleteProtectedError in the error handler.
      const existing = await repo.get(request.params.id);
      if (existing?.deleteLock?.locked) {
        throw new DeleteProtectedError(request.params.id);
      }
      // In-flight job reference (ADR-020 decision 1, issue #569). Block deletion
      // while any active (pending/queued/running) transcode or ingest job still
      // references this asset as its source `assetId` — deleting it would
      // corrupt an in-flight pipeline. This is a HARD block: it runs before the
      // archive and force is never consulted (ADR-020 decision 2 — only settled
      // jobs are forceable, and those are excluded by findActiveByAssetId). The
      // richer `delete_blocked` envelope names the blocking job ids so the
      // caller can wait for or cancel them. Ordered after the explicit lock per
      // the fixed reason precedence delete_protected > referenced_by_job.
      const activeJobs = await jobs.findActiveByAssetId(request.params.id);
      if (activeJobs.length > 0) {
        throw new ReferencedByJobError(
          request.params.id,
          activeJobs.map((j) => j.id)
        );
      }
      // Block deletion while children (renditions) still reference this asset.
      const childCount = await repo.countChildren(request.params.id);
      if (childCount > 0) {
        throw new HasChildrenError(request.params.id);
      }
      // Member-of-collection block (issue #570). If the asset is still a member
      // of one or more collections, block the archive with the shared
      // `delete_blocked` envelope (reason `member_of_collection`) rather than
      // silently orphaning the collection grouping. This is a SOFT block:
      // `?force=true` proceeds (ADR-020 decision 2 — membership is a loose,
      // non-authoritative grouping). Checked LAST (lowest ADR-020 precedence,
      // below delete_protected and has_children) and only when a collection
      // repo is wired; membership is queried non-mutatingly via
      // `collectionsContainingAsset`.
      if (!request.query.force && opts.collectionRepository) {
        const collectionIds = await opts.collectionRepository.collectionsContainingAsset(
          request.params.id
        );
        if (collectionIds.length > 0) {
          throw new AssetMemberOfCollectionError(request.params.id, collectionIds);
        }
      }
      // Soft delete: archive rather than destroy (see asset-repo / couch-asset-repo).
      const removed = await repo.remove(request.params.id);
      if (!removed) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // Audit: asset deleted/archived (issue #564). One entry on a real archive;
      // a blocked (409) or unknown (404) delete never reaches here, so no entry.
      emitAudit(
        audit,
        {
          actor: originActor('user'),
          action: 'asset.archived',
          targetType: 'asset',
          targetId: removed.id,
          detail: { status: removed.status }
        },
        request.log
      );
      return reply.code(204).send(null);
    }
  );

  // Explicit delete-lock set/clear (ADR-020 decision 3, issue #568). A DEDICATED
  // system write path for the `administrative.deleteLock` flag — chosen as a
  // `/:id/lock` sub-resource with PUT (set) / DELETE (clear), mirroring the
  // existing action-endpoint conventions in this router (cf. the `/:id/lock`
  // sibling to `/:id/review-state`, `/:id/restore`, and the PUT/DELETE
  // `/:id/audio-tracks` pattern). It is INTENTIONALLY separate from the
  // editorial PATCH `/:id` and PUT `/:id/metadata` paths so the system-owned
  // lock can never be set/cleared through ordinary metadata edits (ADR-005:
  // `administrative` is not user-writable). The repo appends a `lock`/`unlock`
  // provenance entry so the change is traceable.
  //   200 — lock set, full asset returned (deleteLock present + locked)
  //   404 — unknown/foreign asset (existence not leaked)
  app.put(
    '/:id/lock',
    {
      schema: {
        params: z.object({ id: z.string() }),
        // `reason` (operator note) and `lockedBy` (actor) are optional, matching
        // ADR-020 decision 3's optional sub-fields.
        body: z
          .object({
            reason: z.string().max(1024).optional(),
            lockedBy: z.string().max(256).optional()
          })
          .default({}),
        response: { 200: assetSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const updated = await repo.setDeleteLock(request.params.id, {
        locked: true,
        reason: request.body.reason,
        lockedBy: request.body.lockedBy
      });
      if (!updated) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(updated);
    }
  );

  // Clear the explicit delete-lock (ADR-020 decision 3, issue #568). The ONLY
  // way to lift protection — `?force=true` on DELETE /:id does NOT (ADR-020
  // decision 2). Appends an `unlock` provenance entry.
  //   200 — lock cleared, full asset returned (deleteLock absent)
  //   404 — unknown/foreign asset
  app.delete(
    '/:id/lock',
    {
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: assetSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const updated = await repo.setDeleteLock(request.params.id, { locked: false });
      if (!updated) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(updated);
    }
  );

  // Undo an archive within the retention window (issue #328, part of the purge
  // epic #323). Lets an operator revive a soft-deleted asset BEFORE the retention
  // sweep purges it. The repo's `restore(id)` (sibling to `remove(id)`) bypasses
  // the state machine — `archived` is otherwise terminal (ALLOWED_TRANSITIONS.
  // archived stays `[]`) so no ordinary PATCH can revive it — and appends an
  // audited `archived -> <target>` statusHistory entry (ADR-005: append, never
  // rewrite). Target status is the pre-archive status when it was `ready`,
  // otherwise `failed` (see restoreTargetStatus).
  //   200 — restored asset (now `ready` or `failed`)
  //   404 — unknown id, OR not currently `archived` (nothing to restore)
  //   410 — the asset was already purged (its document is now a tombstone)
  app.post(
    '/:id/restore',
    {
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: assetSchema, 404: errorSchema, 410: errorSchema }
      }
    },
    async (request, reply) => {
      const id = request.params.id;
      // Tombstone semantics (issue #326): a purged archived asset's document is
      // replaced in place by a tombstone. Restoring one must return 410 Gone (the
      // resource existed and was intentionally purged), NOT 404. getState()
      // surfaces that distinction for the ULID id path.
      if (isUlid(id)) {
        const state = await repo.getState(id);
        if (state.kind === 'tombstone') {
          return reply.code(410).send({ error: 'gone', message: 'asset has been purged' });
        }
      }
      const restored = await repo.restore(id);
      if (!restored) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(restored);
    }
  );
};
