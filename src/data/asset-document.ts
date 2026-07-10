// ADR-005 asset document model (issues #52 + #53).
//
// This is the PERSISTED CouchDB shape of an asset, distinct from the flat
// `Asset` domain/API type in asset-repo.ts. A single asset document is the
// aggregate root, partitioned into four provenance namespaces so writers of
// different provenance never share a field (ADR-005):
//
//   descriptive    — user / editorial (title, description, tags, language, custom)
//   technical      — machine (ffprobe): container, duration, tracks, checksum
//   administrative — system: timestamps, source method, storage refs, provenance
//   structural     — pipeline: renditions, manifests, thumbnails, collections
//
// Document key design (ADR-005 / issue #53):
//   _id           — a ULID (time-sortable, URL-safe) minted in the repo layer
//   schemaVersion — explicit integer for forward migration (1 at v1)
//   type          — discriminator over asset | rendition | job | webhook | schema
//
// There is intentionally NO `workspaceId` field in this contract (ADR-003): the
// workspace partition lives on the CouchDB storage envelope, not the model.
//
// `toAssetDocument` / `fromAssetDocument` map between the flat domain `Asset`
// and this namespaced document so the existing routes and pipeline keep working
// against the flat type while persistence conforms to ADR-005.

import { z } from 'zod';
import {
  ASSET_REVIEW_STATES,
  ASSET_SOURCE_METHODS,
  PROVENANCE_ACTORS,
  SUBTITLE_FORMATS,
  type Asset,
  type AssetReviewState,
  type AssetSourceMethod,
  type AssetStatus,
  type ProvenanceEntry
} from './asset-repo.js';

export const ASSET_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Sub-schemas
// ---------------------------------------------------------------------------

export const VideoTrackSchema = z.object({
  index: z.number().optional(),
  codec: z.string(),
  width: z.number(),
  height: z.number(),
  bitrateBps: z.number().optional(),
  frameRate: z.number().optional()
});
export type VideoTrack = z.infer<typeof VideoTrackSchema>;

export const AudioTrackSchema = z.object({
  index: z.number(),
  codec: z.string(),
  channels: z.number(),
  sampleRateHz: z.number()
});
export type DocAudioTrack = z.infer<typeof AudioTrackSchema>;

export const RenditionSchema = z.object({
  // `id` was added in the #79 redesign; old documents lack it — default to a
  // deterministic placeholder so they can be read without error. The next write
  // (re-transcode) will replace these with real ULIDs.
  id: z.string().default('legacy'),
  label: z.string(),
  width: z.number(),
  height: z.number(),
  objectKey: z.string(),
  codec: z.string().optional(),
  bitrateBps: z.number().optional()
});
export type DocRendition = z.infer<typeof RenditionSchema>;

export const ThumbnailSchema = z.object({
  objectKey: z.string(),
  timecodeSeconds: z.number().optional()
});
export type DocThumbnail = z.infer<typeof ThumbnailSchema>;

export const ProvenanceEntrySchema = z.object({
  at: z.string(),
  by: z.enum(PROVENANCE_ACTORS),
  op: z.string(),
  detail: z.string().optional()
});

// Editorial audio/subtitle track descriptors (issue #18) kept under the
// structural namespace so the flat type round-trips.
const EditorialAudioTrackSchema = z.object({
  id: z.string(),
  language: z.string(),
  codec: z.string().optional(),
  channels: z.number().optional(),
  label: z.string().optional(),
  default: z.boolean().optional()
});

const EditorialSubtitleTrackSchema = z.object({
  id: z.string(),
  language: z.string(),
  format: z.enum(SUBTITLE_FORMATS),
  objectKey: z.string().optional(),
  label: z.string().optional(),
  default: z.boolean().optional()
});

// Scene/shot-detection boundary (issue #115), persisted under the structural
// namespace. All fields optional/permissive because the runtime wire shape of
// eyevinn-function-scenes is NOT contract-verified (see pipeline/scene-detector.ts).
const SceneBoundarySchema = z.object({
  startSeconds: z.number().optional(),
  endSeconds: z.number().optional(),
  keyframeSeconds: z.number().optional()
});

// Scene-detection metadata (issue #115). Held under the structural namespace and
// optional so documents written before #115 (field absent) still deserialize — no
// schemaVersion bump required. The failure of the LAST attempt is carried in a
// separate structural `sceneDetectionError` field (mirroring `packagingError` /
// `subtitlesError`), so a failed detection records the error without a metadata
// object, exactly like the flat domain type.
const SceneDetectionSchema = z.object({
  boundaries: z.array(SceneBoundarySchema).default([]),
  sceneCount: z.number().default(0),
  detectedAt: z.string()
});

const StatusTransitionSchema = z.object({
  at: z.string(),
  from: z.string().nullable(),
  to: z.string()
});

// ---------------------------------------------------------------------------
// TAMS addressing (issue #165, sub-task of the #116 TAMS bridge epic).
//
// flowId + timerange are the pipeline/machine-derived addressing of an asset's
// media into a Time-addressable Media Store (TAMS). They are NOT editorial, so
// they live under the machine-owned `structural` namespace (next to renditions,
// manifests, derivedFrom, versionOf) — never under user-writable `descriptive`.
// Both are optional and additive: documents written before #165 (fields absent)
// still deserialize, so no schemaVersion bump is required.
//
// Grammar is pinned 1:1 to ADR-008 "Time-addressing model"
// (docs/architecture/ADR-008-tams-gateway-contract.md, lines 100-114): a TAMS
// timerange is `[<seconds>:<nanoseconds>_<seconds>:<nanoseconds>)` on the TAI
// timescale (e.g. `[0:0_10:0)`), where `[`/`]` are inclusive and `(`/`)` are
// exclusive bounds, and open-ended ranges are permitted. flowId is a TAMS flow
// UUID; a source can carry many flows (ADR-008 line 114), so the field is
// modelled as an OPTIONAL ARRAY of UUIDs (many-per-source cardinality).

// A single TAI point: `<seconds>:<nanoseconds>` (both non-negative integers).
const TAI_POINT = String.raw`\d+:\d+`;

// TAMS timerange grammar (ADR-008). Accepted forms; bracketing must be BALANCED
// (both an inclusive `[`/`]` or exclusive `(`/`)` bound, or neither):
//   - bounded closed range:   `[start_end)`  e.g. `[0:0_10:0)`
//   - open-start range:       `[_end)`       (all time up to `end`)
//   - open-end range:         `[start_)`     (from `start` onwards)
//   - fully open range:       `[_)` / `_`    (all time)
//   - single instant:         `[start]`      (a single TAI point)
// Bare (unbracketed) `start_end` / `start` are also accepted; the gateway
// echoes the canonical bracketed form back. This is a syntactic guard, not a
// semantic one (it does not assert start <= end).
export const TAMS_TIMERANGE_REGEX = new RegExp(
  '^' +
    '(?:' +
    // bracketed forms: an open bound `[`/`(`, the body, then a close `]`/`)`.
    `[\\[(](?:(?:${TAI_POINT})?_(?:${TAI_POINT})?|${TAI_POINT})[\\])]` +
    // bare (unbracketed) forms: a range body or a lone point.
    `|(?:${TAI_POINT})?_(?:${TAI_POINT})?` +
    `|${TAI_POINT}` +
    ')' +
    '$'
);

export const TamsTimerangeSchema = z
  .string()
  .regex(TAMS_TIMERANGE_REGEX, 'must be a TAMS TAI timerange, e.g. [0:0_10:0) (ADR-008)');
export type TamsTimerange = z.infer<typeof TamsTimerangeSchema>;

// TAMS flow ids are UUIDs. A source can carry many flows, so this is an array.
export const TamsFlowIdSchema = z.string().uuid();

// The structural TAMS addressing block. Both fields optional/additive.
export const TamsAddressingSchema = z.object({
  // Many-per-source: an asset's media may be represented by multiple TAMS flows
  // (ADR-008 line 114). Optional array of flow UUIDs.
  flowIds: z.array(TamsFlowIdSchema).optional(),
  // Canonical timerange of the asset's media in TAMS (validated grammar).
  timerange: TamsTimerangeSchema.optional()
});
export type TamsAddressing = z.infer<typeof TamsAddressingSchema>;

// ---------------------------------------------------------------------------
// Asset document (the four-namespace aggregate root)
// ---------------------------------------------------------------------------

export const AssetDocumentSchema = z.object({
  _id: z.string(), // ULID
  _rev: z.string().optional(), // CouchDB MVCC token
  type: z.literal('asset'),
  schemaVersion: z.literal(ASSET_SCHEMA_VERSION),
  state: z.string(), // AssetState; #54 will tighten this to an enum

  descriptive: z.object({
    title: z.string(),
    // Human-readable URL-safe handle (issue #131). Optional so documents written
    // before slugs existed still deserialize (field simply absent).
    slug: z.string().optional(),
    description: z.string().optional(),
    tags: z.array(z.string()).default([]),
    language: z.string().optional(),
    custom: z.record(z.unknown()).default({})
  }),

  technical: z
    .object({
      container: z.string().optional(),
      durationMs: z.number().optional(),
      video: z.array(VideoTrackSchema).optional(),
      audio: z.array(AudioTrackSchema).optional(),
      checksum: z.object({ algo: z.string(), value: z.string() }).optional(),
      probe: z.object({ source: z.string(), probedAt: z.string() }).optional(),
      error: z.string().optional()
    })
    .default({}),

  administrative: z.object({
    createdAt: z.string(),
    updatedAt: z.string(),
    source: z.object({
      method: z.enum(ASSET_SOURCE_METHODS),
      originUri: z.string().optional()
    }),
    storage: z.object({ bucket: z.string(), key: z.string(), sizeBytes: z.number() }).optional(),
    rights: z
      .object({ license: z.string().optional(), expiresAt: z.string().nullable().optional() })
      .optional(),
    provenance: z.array(ProvenanceEntrySchema).default([]),
    statusHistory: z.array(StatusTransitionSchema).default([]),
    // Editorial review state (issue #134), DISTINCT from lifecycle `state`.
    // `.default('draft')` means documents written before reviewState existed
    // (the field simply absent) deserialize as `draft` — no schemaVersion bump
    // is required, so all v1 documents remain valid.
    reviewState: z.enum(ASSET_REVIEW_STATES).default('draft')
  }),

  structural: z
    .object({
      renditions: z.array(RenditionSchema).default([]),
      manifests: z.object({ hls: z.string().optional(), dash: z.string().optional() }).optional(),
      thumbnails: z.array(ThumbnailSchema).optional(),
      collections: z.array(z.string()).default([]),
      derivedFrom: z.string().nullable().optional(),
      // Version-chain linkage (issue #118), DISTINCT from `derivedFrom` (which
      // persists the parentId hierarchy). Both optional so documents written
      // before #118 (field simply absent) still deserialize — no schemaVersion
      // bump is required, all v1 documents remain valid.
      versionOf: z.string().nullable().optional(),
      versionGroupId: z.string().nullable().optional(),
      packagingError: z.string().optional(),
      // Last auto-subtitles generation failure (issue #114). Optional so
      // documents written before #114 (field absent) still deserialize — no
      // schemaVersion bump required.
      subtitlesError: z.string().optional(),
      // Scene/shot-detection metadata (issue #115) and the last detection
      // failure. Both optional so documents written before #115 (fields absent)
      // still deserialize — no schemaVersion bump required.
      sceneDetection: SceneDetectionSchema.optional(),
      sceneDetectionError: z.string().optional(),
      editorialAudio: z.array(EditorialAudioTrackSchema).optional(),
      editorialSubtitles: z.array(EditorialSubtitleTrackSchema).optional(),
      // TAMS time-addressable bridge addressing (issue #165). Machine/pipeline
      // -derived (flow UUIDs + validated TAI timerange grammar, ADR-008), so it
      // lives here under `structural` — NOT under user-writable `descriptive`.
      // Optional so documents written before #165 (field absent) still parse.
      tams: TamsAddressingSchema.optional()
    })
    .default({ renditions: [], collections: [] })
});

export type AssetDocument = z.infer<typeof AssetDocumentSchema>;

// ---------------------------------------------------------------------------
// Mappers: flat domain Asset  <->  four-namespace document
// ---------------------------------------------------------------------------

function technicalFromAsset(asset: Asset): AssetDocument['technical'] {
  const tm = asset.technicalMetadata;
  const technical: AssetDocument['technical'] = {};
  if (tm) {
    technical.container = tm.containerFormat;
    technical.durationMs = Math.round(tm.durationSeconds * 1000);
    technical.video = [
      { codec: tm.codec, width: tm.width, height: tm.height, bitrateBps: tm.bitrateBps }
    ];
    technical.audio = tm.audioTracks?.map((a) => ({
      index: a.index,
      codec: a.codec,
      channels: a.channels,
      sampleRateHz: a.sampleRateHz
    }));
    technical.probe = { source: 'eyevinn-ffmpeg-s3', probedAt: tm.extractedAt };
  }
  if (asset.technicalMetadataError) {
    technical.error = asset.technicalMetadataError;
  }
  return technical;
}

function technicalToAsset(
  technical: AssetDocument['technical']
): Pick<Asset, 'technicalMetadata' | 'technicalMetadataError'> {
  const v = technical.video?.[0];
  let technicalMetadata: Asset['technicalMetadata'] = null;
  if (v && technical.probe) {
    technicalMetadata = {
      codec: v.codec,
      width: v.width,
      height: v.height,
      durationSeconds: technical.durationMs !== undefined ? technical.durationMs / 1000 : 0,
      bitrateBps: v.bitrateBps ?? 0,
      containerFormat: technical.container ?? '',
      audioTracks: (technical.audio ?? []).map((a) => ({
        index: a.index,
        codec: a.codec,
        channels: a.channels,
        sampleRateHz: a.sampleRateHz
      })),
      extractedAt: technical.probe.probedAt
    };
  }
  return { technicalMetadata, technicalMetadataError: technical.error };
}

// Map a flat domain Asset to its persisted four-namespace document body.
export function toAssetDocument(
  asset: Asset,
  opts: { rev?: string; storageBucket?: string; storageSizeBytes?: number } = {}
): AssetDocument {
  const doc: AssetDocument = {
    _id: asset.id,
    type: 'asset',
    schemaVersion: ASSET_SCHEMA_VERSION,
    state: asset.status,
    descriptive: {
      title: asset.name,
      slug: asset.slug,
      description: asset.description,
      tags: asset.tags ?? [],
      custom: (asset.metadata as Record<string, unknown>) ?? {}
    },
    technical: technicalFromAsset(asset),
    administrative: {
      createdAt: asset.createdAt,
      updatedAt: asset.updatedAt,
      source: {
        method: (asset.sourceMethod ?? 'upload') as AssetSourceMethod,
        originUri: asset.originUri
      },
      provenance: asset.provenance ?? [],
      statusHistory: asset.statusHistory,
      // Editorial review state (issue #134). Absent on the flat asset means the
      // asset has never been moved out of draft; persist the default explicitly.
      reviewState: asset.reviewState ?? 'draft'
    },
    structural: {
      renditions: asset.renditions ?? [],
      collections: asset.collections ?? [],
      derivedFrom: asset.parentId ?? null,
      // Version-chain linkage (issue #118). Persisted next to derivedFrom but
      // semantically independent of the parentId hierarchy.
      versionOf: asset.versionOfAssetId ?? null,
      versionGroupId: asset.versionGroupId ?? null
    }
  };
  if (opts.rev) {
    doc._rev = opts.rev;
  }
  if (asset.objectKey) {
    doc.administrative.storage = {
      bucket: opts.storageBucket ?? '',
      key: asset.objectKey,
      sizeBytes: opts.storageSizeBytes ?? 0
    };
  }
  if (asset.manifestUrls && (asset.manifestUrls.hls || asset.manifestUrls.dash)) {
    doc.structural.manifests = { hls: asset.manifestUrls.hls, dash: asset.manifestUrls.dash };
  }
  if (asset.packagingError) {
    doc.structural.packagingError = asset.packagingError;
  }
  if (asset.subtitlesError) {
    doc.structural.subtitlesError = asset.subtitlesError;
  }
  if (asset.sceneMetadata) {
    doc.structural.sceneDetection = {
      boundaries: asset.sceneMetadata.boundaries,
      sceneCount: asset.sceneMetadata.sceneCount,
      detectedAt: asset.sceneMetadata.detectedAt
    };
  }
  if (asset.sceneDetectionError) {
    doc.structural.sceneDetectionError = asset.sceneDetectionError;
  }
  if (asset.thumbnails && asset.thumbnails.length > 0) {
    doc.structural.thumbnails = asset.thumbnails.map((objectKey) => ({ objectKey }));
  }
  if (asset.audioTracks && asset.audioTracks.length > 0) {
    doc.structural.editorialAudio = asset.audioTracks;
  }
  if (asset.subtitleTracks && asset.subtitleTracks.length > 0) {
    doc.structural.editorialSubtitles = asset.subtitleTracks;
  }
  // TAMS addressing (issue #165). Only persist the block when the asset actually
  // carries flow ids and/or a timerange, so pre-#165 assets round-trip with the
  // field absent (back-compat).
  const hasTamsFlowIds = asset.tamsFlowIds && asset.tamsFlowIds.length > 0;
  if (hasTamsFlowIds || asset.tamsTimerange) {
    doc.structural.tams = {};
    if (hasTamsFlowIds) {
      doc.structural.tams.flowIds = asset.tamsFlowIds;
    }
    if (asset.tamsTimerange) {
      doc.structural.tams.timerange = asset.tamsTimerange;
    }
  }
  return doc;
}

// Map a persisted four-namespace document back to the flat domain Asset.
export function fromAssetDocument(doc: AssetDocument): Asset {
  const technical = technicalToAsset(doc.technical ?? {});
  const manifestUrls =
    doc.structural?.manifests && (doc.structural.manifests.hls || doc.structural.manifests.dash)
      ? { hls: doc.structural.manifests.hls, dash: doc.structural.manifests.dash }
      : undefined;
  const thumbnails = doc.structural?.thumbnails?.map((t) => t.objectKey);
  const renditions = doc.structural?.renditions;
  const collections = doc.structural?.collections;
  const derivedFrom = doc.structural?.derivedFrom ?? undefined;
  const versionOfAssetId = doc.structural?.versionOf ?? undefined;
  const versionGroupId = doc.structural?.versionGroupId ?? undefined;

  return {
    id: doc._id,
    name: doc.descriptive.title,
    slug: doc.descriptive.slug,
    description: doc.descriptive.description,
    status: doc.state as AssetStatus,
    // Editorial review state (issue #134). The schema defaults absent values to
    // `draft`, so legacy documents round-trip to `draft` rather than undefined.
    reviewState: doc.administrative.reviewState as AssetReviewState,
    parentId: derivedFrom ?? undefined,
    versionOfAssetId,
    versionGroupId,
    objectKey: doc.administrative.storage?.key,
    statusHistory: (doc.administrative.statusHistory ?? []).map((t) => ({
      at: t.at,
      from: t.from as AssetStatus | null,
      to: t.to as AssetStatus
    })),
    technicalMetadata: technical.technicalMetadata,
    technicalMetadataError: technical.technicalMetadataError,
    manifestUrls,
    packagingError: doc.structural?.packagingError,
    subtitlesError: doc.structural?.subtitlesError,
    // Scene-detection metadata (issue #115). Absent structural.sceneDetection
    // maps to `undefined` (never detected) rather than `null`; the flat type
    // treats both as "no metadata yet". The last failure round-trips separately.
    sceneMetadata: doc.structural?.sceneDetection
      ? {
          boundaries: doc.structural.sceneDetection.boundaries,
          sceneCount: doc.structural.sceneDetection.sceneCount,
          detectedAt: doc.structural.sceneDetection.detectedAt
        }
      : undefined,
    sceneDetectionError: doc.structural?.sceneDetectionError,
    renditions: renditions && renditions.length > 0 ? renditions : undefined,
    thumbnails: thumbnails && thumbnails.length > 0 ? thumbnails : undefined,
    metadata:
      doc.descriptive.custom && Object.keys(doc.descriptive.custom).length > 0
        ? doc.descriptive.custom
        : undefined,
    tags: doc.descriptive.tags && doc.descriptive.tags.length > 0 ? doc.descriptive.tags : undefined,
    audioTracks: doc.structural?.editorialAudio,
    subtitleTracks: doc.structural?.editorialSubtitles,
    // TAMS addressing (issue #165). Absent block / empty arrays map back to
    // undefined so the flat type stays clean for pre-#165 assets.
    tamsFlowIds:
      doc.structural?.tams?.flowIds && doc.structural.tams.flowIds.length > 0
        ? doc.structural.tams.flowIds
        : undefined,
    tamsTimerange: doc.structural?.tams?.timerange,
    sourceMethod: doc.administrative.source.method,
    originUri: doc.administrative.source.originUri,
    provenance: doc.administrative.provenance ?? [],
    collections: collections && collections.length > 0 ? collections : undefined,
    createdAt: doc.administrative.createdAt,
    updatedAt: doc.administrative.updatedAt
  };
}

export type { ProvenanceEntry };
