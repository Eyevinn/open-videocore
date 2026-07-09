// Asset repository.
//
// Abstracts asset persistence behind a workspace-scoped interface. Two
// implementations are provided:
//   - InMemoryAssetRepository: local dev / tests. Applies the SAME workspace
//     namespacing, ownership guards, state machine, and parent/child rules as
//     the CouchDB layer so behaviour is identical regardless of backend.
//   - CouchAssetRepository (see couch-asset-repo.ts): production, backed by
//     WorkspaceCouch (partitioned, ownership-aware) per ADR-001.
//
// This module also owns the asset lifecycle state machine and the audit trail
// so both backends share one definition (issue #3).

// ADR-003/#59: workspace guard removed (structural OSC isolation).
import { ulid } from 'ulid';

// ---------------------------------------------------------------------------
// Asset model + lifecycle
// ---------------------------------------------------------------------------

// Lifecycle states. An asset is created in `uploading` (payload not yet in
// MinIO), advances to `processing` once a transcode/analysis job is running,
// `ready` when it can be served, and `archived` as a terminal soft-deleted /
// retired state.
// `failed` is a non-terminal error state for an asset whose ingest could not
// complete (issue #5 URL-pull). From `failed` a caller may retry (back to
// `uploading`/`processing`) or archive it.
export const ASSET_STATUSES = ['uploading', 'processing', 'ready', 'failed', 'archived'] as const;
export type AssetStatus = (typeof ASSET_STATUSES)[number];

// Allowed forward transitions. Anything not listed is rejected with 422.
// `archived` is terminal. We allow `ready -> processing` so a ready asset can
// be re-processed (e.g. a new rendition pass) before going back to ready.
const ALLOWED_TRANSITIONS: Record<AssetStatus, readonly AssetStatus[]> = {
  uploading: ['processing', 'failed', 'archived'],
  processing: ['ready', 'failed', 'archived'],
  ready: ['processing', 'archived'],
  failed: ['uploading', 'processing', 'archived'],
  archived: []
};

export function isValidTransition(from: AssetStatus, to: AssetStatus): boolean {
  if (from === to) {
    return true; // idempotent no-op transitions are allowed
  }
  return ALLOWED_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Review state (issue #134, sub-task of #117)
// ---------------------------------------------------------------------------

// Editorial review state, DISTINCT from the lifecycle `status` above. Where
// `status` tracks the technical/ingest lifecycle (uploading -> ... -> archived),
// `reviewState` tracks a human approval workflow layered on top of it. The two
// are INDEPENDENT: a `ready` asset can be `draft`, `in-review`, `approved`, or
// `rejected`, and moving one never moves the other.
//
// An asset starts in `draft`. Absent/legacy assets and documents are treated as
// `draft` (see asset-document.ts) so backward compatibility is preserved.
export const ASSET_REVIEW_STATES = ['draft', 'in-review', 'approved', 'rejected'] as const;
export type AssetReviewState = (typeof ASSET_REVIEW_STATES)[number];

// Allowed forward transitions for the review workflow. Anything not listed is
// rejected with 422 (same mapping as the lifecycle machine).
//   draft      -> in-review                submit for review
//   in-review  -> approved | rejected      reviewer decision
//   rejected   -> in-review                resubmit after changes (re-review)
//   approved   -> in-review                re-open an approved asset for
//                                          re-review (e.g. a later edit needs
//                                          fresh sign-off). `approved` is NOT
//                                          terminal so content can always be
//                                          pulled back into review — a common
//                                          editorial need — while still barring
//                                          direct approved -> rejected without a
//                                          re-review step.
const ALLOWED_REVIEW_TRANSITIONS: Record<AssetReviewState, readonly AssetReviewState[]> = {
  draft: ['in-review'],
  'in-review': ['approved', 'rejected'],
  approved: ['in-review'],
  rejected: ['in-review']
};

export function isValidReviewTransition(from: AssetReviewState, to: AssetReviewState): boolean {
  if (from === to) {
    return true; // idempotent no-op transitions are allowed
  }
  return ALLOWED_REVIEW_TRANSITIONS[from].includes(to);
}

export type StatusTransition = {
  at: string; // ISO timestamp
  from: AssetStatus | null; // null for the initial creation entry
  to: AssetStatus;
};

// Provenance log entry (ADR-005, issue #53). Append-only audit of who/what
// mutated which namespace.
export const PROVENANCE_ACTORS = ['user', 'system', 'ai'] as const;
export type ProvenanceActor = (typeof PROVENANCE_ACTORS)[number];

export type ProvenanceEntry = {
  at: string;
  by: ProvenanceActor;
  op: string;
  detail?: string;
};

// How an asset entered the system (ADR-005 administrative.source.method).
export const ASSET_SOURCE_METHODS = ['upload', 'url-pull', 'watch-folder'] as const;
export type AssetSourceMethod = (typeof ASSET_SOURCE_METHODS)[number];

// One audio track within a container, as reported by ffprobe (issue #6). A
// container can carry multiple audio tracks (e.g. multi-language), so this is
// surfaced as an array on TechnicalMetadata.
export type AudioTrack = {
  index: number;
  codec: string;
  channels: number;
  sampleRateHz: number;
};

// Technical metadata extracted from the stored object by an ephemeral ffprobe
// job (issue #6). Populated asynchronously after ingest; null until the first
// successful extraction (or after a failed extraction — see
// `technicalMetadataError`).
export type TechnicalMetadata = {
  codec: string;
  width: number;
  height: number;
  durationSeconds: number;
  bitrateBps: number;
  containerFormat: string;
  audioTracks: AudioTrack[];
  extractedAt: string; // ISO timestamp of when extraction completed
};

// Streaming manifest URLs produced by the HLS/DASH packaging pipeline (issue
// #9). Populated asynchronously after transcoding completes and the
// eyevinn-encore-packager finishes packaging. Both are MinIO-hosted manifest
// URLs (CMAF: HLS and DASH share the same underlying media segments). Either
// field may be absent if only one format was produced; `packagingError`
// carries the reason when the last packaging attempt failed.
export type ManifestUrls = {
  hls?: string;
  dash?: string;
};

// One ABR rendition produced by a transcode job (issue #8, redesigned #79).
// Renditions are EMBEDDED variants of a single asset, not separate child
// assets. An asset represents a piece of content; all of its transcoded
// variants live on the one asset record so a client discovers them in a single
// read. Each entry is self-contained (no child asset id).
export type Rendition = {
  // ULID — stable identifier for this variant.
  id: string;
  // Rung label from the encode profile (e.g. "1080p", "720p").
  label: string;
  width: number;
  height: number;
  // MinIO object key (workspace-local) of the produced file.
  objectKey: string;
  codec?: string;
  bitrateBps?: number;
};

// Multi-language audio and subtitle tracks (issue #18). These are EDITORIAL /
// metadata-level track descriptors managed directly via the API — distinct from
// the machine-extracted `TechnicalMetadata.audioTracks` (ffprobe-derived stream
// info on the container). An asset carries zero or more of each as structured
// arrays; track ids are generated server-side and used to address single tracks
// for removal. `language` is a free-form BCP-47 string (e.g. "en", "sv",
// "pt-BR"); no strict enum is enforced.
//
// NOTE on naming: the ffprobe stream type above is also called `AudioTrack`, so
// the editorial descriptor is named `AssetAudioTrack` to avoid a clash while the
// asset field is `audioTracks` per the issue spec.
export type AssetAudioTrack = {
  id: string;
  language: string;
  codec?: string;
  channels?: number;
  label?: string;
  default?: boolean;
};

export const SUBTITLE_FORMATS = ['vtt', 'srt', 'ttml'] as const;
export type SubtitleFormat = (typeof SUBTITLE_FORMATS)[number];

export type SubtitleTrack = {
  id: string;
  language: string;
  format: SubtitleFormat;
  // Workspace-local MinIO object key of the subtitle file. Undefined until the
  // file is uploaded (the add route mints a presigned PUT URL the client uses).
  objectKey?: string;
  label?: string;
  default?: boolean;
};

export type Asset = {
  id: string;
  name: string;
  // URL-safe, human-readable handle (issue #131). Generated at create time,
  // lowercase words joined by hyphens plus a numeric suffix (e.g.
  // `brave-river-042`), unique within the (structurally isolated) workspace.
  // The ULID `id` remains the internal primary key; `slug` is a friendly alias.
  // Optional so pre-existing slug-less assets remain valid on read/validation.
  slug?: string;
  description?: string;
  status: AssetStatus;
  // Editorial review state (issue #134), INDEPENDENT of `status`. Optional so
  // pre-existing assets/documents without it remain valid; absent is treated as
  // the initial state `draft` throughout (get/list/document round-trip).
  reviewState?: AssetReviewState;
  // Source asset id for renditions/children; undefined for top-level sources.
  parentId?: string;
  // MinIO object key (workspace-local) for the asset payload, if any.
  objectKey?: string;
  // Append-only audit trail of every status change (issue #3 deliverable 5).
  statusHistory: StatusTransition[];
  // Technical metadata from the ffprobe extraction pipeline (issue #6).
  // `null` means extraction has not yet succeeded; an accompanying
  // `technicalMetadataError` carries the reason when the last attempt failed.
  // Extraction never blocks the asset record, so both fields are optional.
  technicalMetadata?: TechnicalMetadata | null;
  technicalMetadataError?: string;
  // Streaming manifest URLs from the packaging pipeline (issue #9). Undefined
  // until packaging completes successfully; `packagingError` is set instead
  // when the last packaging attempt failed. Packaging never changes the
  // asset's lifecycle status — it only annotates the record.
  manifestUrls?: ManifestUrls;
  packagingError?: string;
  // ABR renditions produced by transcoding (issue #8). Populated on the SOURCE
  // asset when a transcode job completes; undefined until then.
  renditions?: Rendition[];
  // Thumbnail / poster-frame object keys produced by the extraction pipeline
  // (issue #7). Workspace-local MinIO keys; undefined until the first
  // successful extraction. A later extraction replaces the list wholesale.
  thumbnails?: string[];
  // Free-form, operator-defined key-value metadata (issue #12). A JSON object
  // stored alongside the fixed schema fields; values must be JSON-serializable.
  // Undefined until the operator sets any metadata. Distinct from
  // `technicalMetadata` (machine-extracted) — this is editorial/business data
  // such as genre, rightsHolder, or language.
  metadata?: Record<string, unknown>;
  // First-class, free-form string labels (issue #11). Deduplicated, order
  // preserved. Matched by SearchQuery.tags. Undefined until the first tag is set.
  tags?: string[];
  // Multi-language audio tracks (issue #18). Editorial descriptors managed via
  // the dedicated /:id/audio-tracks routes. Undefined until the first track is
  // added.
  audioTracks?: AssetAudioTrack[];
  // Multi-language subtitle / caption tracks (issue #18). Managed via the
  // dedicated /:id/subtitle-tracks routes. Undefined until the first track is
  // added.
  subtitleTracks?: SubtitleTrack[];
  // How the asset entered the system (ADR-005 administrative.source.method).
  sourceMethod?: AssetSourceMethod;
  // Origin URI for url-pull / watch-folder ingest.
  originUri?: string;
  // Append-only provenance log (ADR-005 / issue #53).
  provenance?: ProvenanceEntry[];
  // Collection memberships projected onto the asset (ADR-005 structural).
  collections?: string[];
  createdAt: string;
  updatedAt: string;
};

export type CreateAssetInput = {
  name: string;
  // Optional caller-supplied slug (issue #131). When omitted the repository
  // generates a unique, human-readable slug per workspace. When supplied it is
  // normalized and, on collision within the workspace, a numeric suffix is
  // appended to make it unique.
  slug?: string;
  description?: string;
  parentId?: string;
  objectKey?: string;
  // Optional free-form metadata supplied at creation time (issue #12).
  metadata?: Record<string, unknown>;
  // Optional first-class tags supplied at creation time (issue #11).
  tags?: string[];
  // How the asset is entering the system (ADR-005). Defaults to 'upload'.
  sourceMethod?: AssetSourceMethod;
  originUri?: string;
};

// Mutable fields accepted by PATCH. `status` is validated against the state
// machine; `parentId`/`id`/`workspaceId`/timestamps are immutable.
export type UpdateAssetInput = {
  name?: string;
  description?: string;
  objectKey?: string;
  status?: AssetStatus;
  // Set by the metadata extractor (issue #6). Writing `technicalMetadata` to a
  // value clears any prior error; writing `technicalMetadataError` records a
  // failure and leaves `technicalMetadata` null. `null` is an accepted value
  // for `technicalMetadata` (distinct from "not provided").
  technicalMetadata?: TechnicalMetadata | null;
  technicalMetadataError?: string;
  // Set by the packaging pipeline (issue #9). Writing `manifestUrls` clears any
  // prior `packagingError`; writing `packagingError` records a failure and
  // leaves `manifestUrls` untouched. Neither field changes `status`.
  manifestUrls?: ManifestUrls;
  packagingError?: string;
  // Set by the transcode pipeline (issue #8) on the source asset when a
  // transcode job completes. Does not change `status`.
  renditions?: Rendition[];
  // Set by the thumbnail pipeline (issue #7). Replaces the asset's thumbnail
  // key list wholesale. Does not change `status`.
  thumbnails?: string[];
  // Free-form operator metadata (issue #12). On PATCH this is SHALLOW-MERGED
  // into any existing metadata: top-level keys present here override existing
  // keys, all other existing keys are preserved. To replace the whole object
  // wholesale use the dedicated PUT /:id/metadata route (see metadata field).
  metadata?: Record<string, unknown>;
  // When true, `metadata` replaces the existing object wholesale instead of
  // being shallow-merged. Used by PUT /:id/metadata; PATCH leaves it false.
  replaceMetadata?: boolean;
  // First-class tags (issue #11). On PATCH this REPLACES the asset's tag list
  // wholesale (deduplicated). Append/remove-one live behind POST/DELETE /:id/tags.
  tags?: string[];
  // Multi-language tracks (issue #18). On update these REPLACE the asset's
  // respective track list wholesale; the add/remove-one semantics live behind
  // the dedicated /:id/audio-tracks and /:id/subtitle-tracks routes.
  audioTracks?: AssetAudioTrack[];
  subtitleTracks?: SubtitleTrack[];
};

export type ListOptions = {
  limit?: number;
  offset?: number;
  status?: AssetStatus;
  parentId?: string;
};

export type ListResult = {
  items: Asset[];
  limit: number;
  offset: number;
  total: number;
};

// ---------------------------------------------------------------------------
// Domain errors. Routes map these to HTTP status codes.
// ---------------------------------------------------------------------------

// Raised when a status change violates the lifecycle state machine -> 422.
export class InvalidStateTransitionError extends Error {
  readonly statusCode = 422;
  constructor(from: AssetStatus, to: AssetStatus) {
    super(`invalid status transition: ${from} -> ${to}`);
    this.name = 'InvalidStateTransitionError';
  }
}

// Raised when a review-state change violates the review state machine -> 422.
// Mirrors InvalidStateTransitionError so routes map both to the same 422.
export class InvalidReviewTransitionError extends Error {
  readonly statusCode = 422;
  constructor(from: AssetReviewState, to: AssetReviewState) {
    super(`invalid review-state transition: ${from} -> ${to}`);
    this.name = 'InvalidReviewTransitionError';
  }
}

// Raised when a referenced parent asset does not exist in the workspace -> 422.
export class ParentNotFoundError extends Error {
  readonly statusCode = 422;
  constructor(parentId: string) {
    super(`parent asset not found: ${parentId}`);
    this.name = 'ParentNotFoundError';
  }
}

// Raised when deleting a parent that still has children -> 409.
export class HasChildrenError extends Error {
  readonly statusCode = 409;
  constructor(id: string) {
    super(`asset ${id} has child assets and cannot be deleted`);
    this.name = 'HasChildrenError';
  }
}

export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface AssetRepository {
  create(input: CreateAssetInput): Promise<Asset>;
  get(id: string): Promise<Asset | undefined>;
  list(opts?: ListOptions): Promise<ListResult>;
  search(query: string): Promise<Asset[]>;
  update(id: string, patch: UpdateAssetInput): Promise<Asset | undefined>;
  // Transition the asset's editorial review state (issue #134). Validates the
  // move against the review state machine (throws InvalidReviewTransitionError
  // on an illegal move) and persists the new state. Returns the updated asset,
  // or undefined if the asset does not exist. INDEPENDENT of `status`.
  transitionReviewState(id: string, to: AssetReviewState): Promise<Asset | undefined>;
  // Returns the count of direct children of an asset (for delete-blocking).
  countChildren(id: string): Promise<number>;
  // Soft-delete: transitions the asset to `archived`. Returns the archived
  // asset, or undefined if it does not exist.
  remove(id: string): Promise<Asset | undefined>;
}

// Build the initial status history entry for a freshly created asset.
export function initialHistory(now: string): StatusTransition[] {
  return [{ at: now, from: null, to: 'uploading' }];
}

// Build the initial provenance log for a freshly created asset (issue #53).
export function initialProvenance(now: string, method: AssetSourceMethod): ProvenanceEntry[] {
  return [{ at: now, by: 'user', op: 'create', detail: `source=${method}` }];
}

// Derive the provenance entries a given patch produces (issue #53).
export function provenanceForPatch(patch: UpdateAssetInput, now: string): ProvenanceEntry[] {
  const entries: ProvenanceEntry[] = [];
  if (patch.status !== undefined) {
    entries.push({ at: now, by: 'system', op: 'state', detail: patch.status });
  }
  if (patch.technicalMetadata !== undefined || patch.technicalMetadataError !== undefined) {
    entries.push({ at: now, by: 'system', op: 'technical' });
  }
  if (patch.renditions !== undefined) {
    entries.push({ at: now, by: 'system', op: 'rendition' });
  }
  if (patch.manifestUrls !== undefined || patch.packagingError !== undefined) {
    entries.push({ at: now, by: 'system', op: 'manifest' });
  }
  if (patch.thumbnails !== undefined) {
    entries.push({ at: now, by: 'system', op: 'thumbnail' });
  }
  if (
    patch.name !== undefined ||
    patch.description !== undefined ||
    patch.metadata !== undefined ||
    patch.tags !== undefined ||
    patch.audioTracks !== undefined ||
    patch.subtitleTracks !== undefined
  ) {
    entries.push({ at: now, by: 'user', op: 'descriptive' });
  }
  return entries;
}

// Apply a status change, validating the transition and appending to history.
// Mutates and returns the passed-in arrays/values via a new object the caller
// can persist. Throws InvalidStateTransitionError on an illegal move.
export function applyStatus(
  current: AssetStatus,
  next: AssetStatus,
  history: StatusTransition[],
  now: string
): { status: AssetStatus; statusHistory: StatusTransition[] } {
  if (!isValidTransition(current, next)) {
    throw new InvalidStateTransitionError(current, next);
  }
  if (current === next) {
    return { status: current, statusHistory: history };
  }
  return {
    status: next,
    statusHistory: [...history, { at: now, from: current, to: next }]
  };
}

// Apply a review-state change (issue #134), validating the transition against
// the review state machine. `current` defaults to `draft` for assets that have
// no reviewState yet (backward compat). Throws InvalidReviewTransitionError on
// an illegal move. Returns the resolved next state.
export function applyReviewState(
  current: AssetReviewState | undefined,
  next: AssetReviewState
): { reviewState: AssetReviewState } {
  const from = current ?? 'draft';
  if (!isValidReviewTransition(from, next)) {
    throw new InvalidReviewTransitionError(from, next);
  }
  return { reviewState: next };
}

// Apply a metadata patch to an asset's existing metadata (issue #12). When
// `replace` is set the patch becomes the new metadata wholesale (PUT semantics);
// otherwise the patch is shallow-merged into the existing object — top-level
// keys in the patch override existing keys, all other existing keys are kept.
export function applyMetadata(
  existing: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
  replace: boolean
): Record<string, unknown> {
  if (replace) {
    return { ...patch };
  }
  return { ...(existing ?? {}), ...patch };
}

// Deduplicate a tag list while preserving first-seen order (issue #11).
export function normalizeTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tags) {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Human-readable slug generation (issue #131)
// ---------------------------------------------------------------------------

// Small embedded word lists for friendly, URL-safe slugs (e.g. `brave-river-042`).
// No existing generator/word list was found in the repo, so a compact list is
// used here. All entries are lowercase [a-z] only, so the joined slug is always
// URL-safe without further escaping.
const SLUG_ADJECTIVES = [
  'brave', 'calm', 'clever', 'bright', 'bold', 'gentle', 'happy', 'keen',
  'lively', 'lucky', 'merry', 'noble', 'proud', 'quiet', 'swift', 'warm',
  'wise', 'zesty', 'amber', 'azure', 'cosmic', 'crisp', 'daring', 'eager',
  'fancy', 'golden', 'humble', 'jolly', 'mellow', 'nimble', 'placid', 'rapid'
] as const;

const SLUG_NOUNS = [
  'river', 'forest', 'meadow', 'canyon', 'harbor', 'summit', 'valley', 'island',
  'comet', 'nebula', 'falcon', 'otter', 'badger', 'lynx', 'heron', 'willow',
  'cedar', 'maple', 'ember', 'pebble', 'ripple', 'breeze', 'boulder', 'lagoon',
  'glacier', 'prairie', 'tundra', 'orchard', 'thicket', 'delta', 'fjord', 'reef'
] as const;

// Maximum number of generation attempts before falling back to a guaranteed
// suffix. Bounds the collision-retry loop so create() cannot spin forever.
export const SLUG_MAX_ATTEMPTS = 25;

function pick<T>(list: readonly T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

// Coerce an arbitrary string into a URL-safe, lowercase, hyphen-joined slug
// base. Non-alphanumeric runs collapse to a single hyphen; leading/trailing
// hyphens are trimmed. Returns '' when nothing usable remains (caller then
// falls back to a generated base).
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize('NFKD')
    // Strip combining diacritical marks (U+0300-U+036F) left by NFKD so
    // accented input folds to plain ASCII before the alnum filter below.
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// Build one random `<adjective>-<noun>-<NNN>` slug candidate. The numeric
// suffix is zero-padded to three digits for a stable, readable shape.
export function randomSlug(): string {
  const suffix = Math.floor(Math.random() * 1000)
    .toString()
    .padStart(3, '0');
  return `${pick(SLUG_ADJECTIVES)}-${pick(SLUG_NOUNS)}-${suffix}`;
}

// Generate a slug that is unique within a workspace. `isTaken` performs the
// workspace-scoped existence check (each repository supplies its own lookup,
// so uniqueness is always scoped to that repository's isolated store).
//
// When `base` is provided (a caller-supplied slug) it is normalized and used as
// the stem; collisions append an incrementing `-N` suffix. When `base` is
// absent a fresh random `adjective-noun-NNN` candidate is drawn each attempt.
// After SLUG_MAX_ATTEMPTS the loop appends a short unique-ish suffix so create()
// is always bounded and never blocks.
export async function generateUniqueSlug(
  isTaken: (slug: string) => Promise<boolean>,
  base?: string
): Promise<string> {
  const stem = base ? slugify(base) : '';
  for (let attempt = 0; attempt < SLUG_MAX_ATTEMPTS; attempt++) {
    let candidate: string;
    if (stem) {
      candidate = attempt === 0 ? stem : `${stem}-${attempt + 1}`;
    } else {
      candidate = randomSlug();
    }
    if (!(await isTaken(candidate))) {
      return candidate;
    }
  }
  // Bounded fallback: append a random 6-char base36 tail to whatever stem we
  // have (or a fresh random slug), guaranteeing termination.
  const tail = Math.random().toString(36).slice(2, 8);
  const fallbackStem = stem || randomSlug();
  return `${fallbackStem}-${tail}`;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export class InMemoryAssetRepository implements AssetRepository {
  // Keyed by the asset's local id. OSC provides structural isolation, so there
  // is no workspace namespacing on the key.
  private readonly store = new Map<string, Asset>();

  async create(input: CreateAssetInput): Promise<Asset> {
    if (input.parentId) {
      const parent = await this.get(input.parentId);
      if (!parent) {
        throw new ParentNotFoundError(input.parentId);
      }
    }
    const now = new Date().toISOString();
    // ULID local id (ADR-005 / issue #53): time-sortable + URL-safe.
    const localId = ulid();
    const method = input.sourceMethod ?? 'upload';
    // Human-readable slug (issue #131), unique within this repository's store
    // (workspace-scoped uniqueness — the store is one tenant's isolated set).
    const slug = await generateUniqueSlug((s) => this.slugTaken(s), input.slug);
    const asset: Asset = {
      id: localId,
      name: input.name,
      slug,
      description: input.description,
      status: 'uploading',
      parentId: input.parentId,
      objectKey: input.objectKey,
      statusHistory: initialHistory(now),
      metadata: input.metadata,
      tags: input.tags ? normalizeTags(input.tags) : undefined,
      sourceMethod: method,
      originUri: input.originUri,
      provenance: initialProvenance(now, method),
      createdAt: now,
      updatedAt: now
    };
    this.store.set(localId, asset);
    return { ...asset };
  }

  // Workspace-scoped slug existence check (issue #131). Scans this store, which
  // holds exactly one tenant's assets, so uniqueness is per-workspace.
  private async slugTaken(slug: string): Promise<boolean> {
    for (const a of this.store.values()) {
      if (a.slug === slug) {
        return true;
      }
    }
    return false;
  }

  async get(id: string): Promise<Asset | undefined> {
    const asset = this.store.get(id);
    if (!asset) {
      return undefined;
    }
    return { ...asset };
  }

  async list(opts: ListOptions = {}): Promise<ListResult> {
    const limit = clampLimit(opts.limit);
    const offset = Math.max(0, opts.offset ?? 0);
    let all = [...this.store.values()];
    if (opts.status) {
      all = all.filter((a) => a.status === opts.status);
    }
    if (opts.parentId !== undefined) {
      all = all.filter((a) => a.parentId === opts.parentId);
    }
    all.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    const items = all.slice(offset, offset + limit).map((a) => ({ ...a }));
    return { items, limit, offset, total: all.length };
  }

  async search(query: string): Promise<Asset[]> {
    const q = query.toLowerCase();
    const { items } = await this.list({ limit: MAX_LIMIT });
    return items.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        (a.description?.toLowerCase().includes(q) ?? false)
    );
  }

  async update(
    id: string,
    patch: UpdateAssetInput
  ): Promise<Asset | undefined> {
    const key = id;
    const existing = this.store.get(key);
    if (!existing) {
      return undefined;
    }
    const now = new Date().toISOString();
    const next: Asset = { ...existing, updatedAt: now };
    if (patch.name !== undefined) next.name = patch.name;
    if (patch.description !== undefined) next.description = patch.description;
    if (patch.objectKey !== undefined) next.objectKey = patch.objectKey;
    if (patch.technicalMetadata !== undefined) {
      next.technicalMetadata = patch.technicalMetadata;
      // A successful extraction clears any stale error.
      if (patch.technicalMetadata !== null) {
        next.technicalMetadataError = undefined;
      }
    }
    if (patch.technicalMetadataError !== undefined) {
      next.technicalMetadataError = patch.technicalMetadataError;
    }
    if (patch.manifestUrls !== undefined) {
      next.manifestUrls = patch.manifestUrls;
      // A successful packaging result clears any stale error.
      next.packagingError = undefined;
    }
    if (patch.packagingError !== undefined) {
      next.packagingError = patch.packagingError;
    }
    if (patch.renditions !== undefined) {
      next.renditions = patch.renditions;
    }
    if (patch.thumbnails !== undefined) {
      next.thumbnails = patch.thumbnails;
    }
    if (patch.metadata !== undefined) {
      next.metadata = applyMetadata(existing.metadata, patch.metadata, patch.replaceMetadata ?? false);
    }
    if (patch.tags !== undefined) {
      next.tags = normalizeTags(patch.tags);
    }
    if (patch.audioTracks !== undefined) {
      next.audioTracks = patch.audioTracks;
    }
    if (patch.subtitleTracks !== undefined) {
      next.subtitleTracks = patch.subtitleTracks;
    }
    if (patch.status !== undefined) {
      const applied = applyStatus(existing.status, patch.status, existing.statusHistory, now);
      next.status = applied.status;
      next.statusHistory = applied.statusHistory;
    }
    const entries = provenanceForPatch(patch, now);
    if (entries.length > 0) {
      next.provenance = [...(existing.provenance ?? []), ...entries];
    }
    this.store.set(key, next);
    return { ...next };
  }

  async transitionReviewState(
    id: string,
    to: AssetReviewState
  ): Promise<Asset | undefined> {
    const existing = this.store.get(id);
    if (!existing) {
      return undefined;
    }
    const applied = applyReviewState(existing.reviewState, to);
    const now = new Date().toISOString();
    const next: Asset = { ...existing, reviewState: applied.reviewState, updatedAt: now };
    this.store.set(id, next);
    return { ...next };
  }

  async countChildren(id: string): Promise<number> {
    return [...this.store.values()].filter((a) => a.parentId === id && a.status !== 'archived').length;
  }

  async remove(id: string): Promise<Asset | undefined> {
    // Soft delete: transition to `archived` (see couch-asset-repo.ts for the
    // delete-strategy rationale). The route blocks if children exist.
    return this.update(id, { status: 'archived' });
  }
}

export function clampLimit(limit?: number): number {
  if (limit === undefined || Number.isNaN(limit)) {
    return DEFAULT_LIMIT;
  }
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(limit)));
}
