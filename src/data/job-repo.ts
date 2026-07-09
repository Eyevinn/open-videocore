// Ingest job repository (issue #5: URL-pull ingest).
//
// An IngestJob tracks the asynchronous pull of a remote source (HTTP/S or S3)
// into MinIO. It mirrors the asset repository design: a workspace-scoped
// interface with an in-memory implementation for tests/dev and a CouchDB-backed
// implementation for production (see couch-job-repo.ts). The job is the unit of
// observability for the pull worker — clients poll GET /api/v1/jobs/:id to see
// status, progress, and any terminal error.

// ---------------------------------------------------------------------------
// Job model + lifecycle
// ---------------------------------------------------------------------------

// Job lifecycle. A job is created `pending`. Transcode jobs then sit `queued`
// while they wait in the Encore auto-scaler's local Redis queue (ADR-006), and
// advance to `running` once the scaler dispatches them to an Encore instance.
// Ingest jobs advance straight to `running` once the worker starts streaming
// bytes. Both kinds end in `done`, `failed`, or `cancelled` (operator-initiated
// via the cancel handler, distinct from `failed`); all three are terminal.
export const JOB_STATUSES = ['pending', 'queued', 'running', 'done', 'failed', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// The kind of work a job performs. URL-pull ingest (issue #5) and ABR
// transcoding (issue #8) share one repository + one observability endpoint
// (GET /api/v1/jobs/:id), distinguished by `jobType`.
export const JOB_TYPES = ['ingest-url', 'transcode'] as const;
export type JobType = (typeof JOB_TYPES)[number];

// A Job is the unit of observability for any async pipeline. The shape is a
// superset: ingest jobs use `sourceUrl` + byte progress; transcode jobs use
// `encoreJobId` + `renditionAssetIds`. Fields not relevant to a given jobType
// are left undefined. The legacy alias `IngestJob` is retained so existing
// issue #5 code compiles unchanged.
export type Job = {
  id: string;
  type: JobType;
  status: JobStatus;
  // The asset this job operates on. For ingest this is the asset being
  // populated; for transcode it is the SOURCE asset whose renditions are built.
  assetId: string;
  // The source being pulled (HTTP/S or S3 URL). Ingest jobs only.
  sourceUrl: string;
  // 0..100 percentage of bytes transferred. Stays at 0 until the worker knows
  // the total size; if the source reports no Content-Length the worker leaves
  // progress at 0 and only fills bytesTransferred.
  progress: number;
  bytesTransferred: number;
  // Total expected size in bytes when known (from Content-Length / S3 stat).
  totalBytes?: number;
  // Number of pull attempts made so far (retry tracking).
  attempts: number;
  // Terminal error message when status === 'failed'.
  error?: string;
  // --- Transcode-job fields (issue #8) ---
  // Our correlation externalId passed to Encore on submission. Used by the
  // callback listener to correlate completions back to this Job.
  encoreJobId?: string;
  // Encore's internal UUID, returned on submission. Used to poll job status.
  encoreInternalJobId?: string;
  // Name of the encode profile used (preset name or custom profile name).
  profile?: string;
  // Child asset ids created for each produced rendition on completion.
  renditionAssetIds?: string[];
  createdAt: string;
  updatedAt: string;
};

// Backwards-compatible alias (issue #5 code imports IngestJob).
export type IngestJob = Job;

export type CreateJobInput = {
  type: JobType;
  assetId: string;
  // Required for ingest jobs; omitted (defaults to '') for transcode jobs.
  sourceUrl?: string;
  // Transcode jobs only.
  encoreJobId?: string;
  encoreInternalJobId?: string;
  profile?: string;
};

// Fields the worker may patch as it makes progress. id/workspace/createdAt are
// immutable; status is constrained by the lifecycle in applyJobStatus.
export type UpdateJobInput = {
  status?: JobStatus;
  progress?: number;
  bytesTransferred?: number;
  totalBytes?: number;
  attempts?: number;
  error?: string;
  encoreJobId?: string;
  encoreInternalJobId?: string;
  profile?: string;
  renditionAssetIds?: string[];
};

const ALLOWED_JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  pending: ['queued', 'running', 'failed', 'cancelled'],
  queued: ['running', 'failed', 'cancelled'],
  running: ['done', 'failed', 'running', 'cancelled'],
  done: [],
  failed: [],
  cancelled: []
};

export class InvalidJobTransitionError extends Error {
  readonly statusCode = 422;
  constructor(from: JobStatus, to: JobStatus) {
    super(`invalid job status transition: ${from} -> ${to}`);
    this.name = 'InvalidJobTransitionError';
  }
}

export function isValidJobTransition(from: JobStatus, to: JobStatus): boolean {
  if (from === to) {
    return true;
  }
  return ALLOWED_JOB_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Repository interface
// ---------------------------------------------------------------------------

export interface JobRepository {
  create(input: CreateJobInput): Promise<Job>;
  get(id: string): Promise<Job | undefined>;
  list(opts?: { limit?: number; offset?: number }): Promise<{ items: Job[]; total: number }>;
  update(id: string, patch: UpdateJobInput): Promise<Job | undefined>;
  // Locate a transcode job by Encore's job id. Used by the internal Encore
  // callback endpoint (issue #8): the callback listener is unauthenticated, so
  // the job is looked up by the opaque encoreJobId we issued when submitting.
  // Returns the job, or undefined if unknown.
  findByEncoreJobId(encoreJobId: string): Promise<{ job: Job } | undefined>;
}

// The Encore job id we issue when submitting a transcode job. It embeds a
// context token and the job's local id so the UNAUTHENTICATED Encore callback
// (and the Encore auto-scaler's Valkey pool keying) can resolve the job. The
// context token is the fixed deployment context (OSC provides structural
// isolation); it is retained so the scaler's pool-key partitioning stays stable.
const ENCORE_ID_SEP = '__';

export function encodeEncoreJobId(contextId: string, jobLocalId: string): string {
  return `${contextId}${ENCORE_ID_SEP}${jobLocalId}`;
}

export function decodeEncoreJobId(
  encoreJobId: string
): { workspaceId: string; jobLocalId: string } | undefined {
  const idx = encoreJobId.indexOf(ENCORE_ID_SEP);
  if (idx <= 0) {
    return undefined;
  }
  const workspaceId = encoreJobId.slice(0, idx);
  const jobLocalId = encoreJobId.slice(idx + ENCORE_ID_SEP.length);
  if (!workspaceId || !jobLocalId) {
    return undefined;
  }
  return { workspaceId, jobLocalId };
}

function clampProgress(p: number): number {
  if (Number.isNaN(p)) return 0;
  return Math.min(100, Math.max(0, Math.round(p)));
}

// Apply a patch to a job, validating any status transition. Pure helper shared
// by both backends.
export function applyJobPatch(existing: IngestJob, patch: UpdateJobInput, now: string): IngestJob {
  const next: IngestJob = { ...existing, updatedAt: now };
  if (patch.status !== undefined) {
    if (!isValidJobTransition(existing.status, patch.status)) {
      throw new InvalidJobTransitionError(existing.status, patch.status);
    }
    next.status = patch.status;
  }
  if (patch.progress !== undefined) next.progress = clampProgress(patch.progress);
  if (patch.bytesTransferred !== undefined) next.bytesTransferred = patch.bytesTransferred;
  if (patch.totalBytes !== undefined) next.totalBytes = patch.totalBytes;
  if (patch.attempts !== undefined) next.attempts = patch.attempts;
  if (patch.error !== undefined) next.error = patch.error;
  if (patch.encoreJobId !== undefined) next.encoreJobId = patch.encoreJobId;
  if (patch.encoreInternalJobId !== undefined) next.encoreInternalJobId = patch.encoreInternalJobId;
  if (patch.profile !== undefined) next.profile = patch.profile;
  if (patch.renditionAssetIds !== undefined) next.renditionAssetIds = patch.renditionAssetIds;
  return next;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export class InMemoryJobRepository implements JobRepository {
  private readonly store = new Map<string, IngestJob>();
  private counter = 0;

  async create(input: CreateJobInput): Promise<IngestJob> {
    const now = new Date().toISOString();
    const localId = `job-${++this.counter}`;
    const job: Job = {
      id: localId,
      type: input.type,
      status: 'pending',
      assetId: input.assetId,
      sourceUrl: input.sourceUrl ?? '',
      progress: 0,
      bytesTransferred: 0,
      attempts: 0,
      encoreJobId: input.encoreJobId,
      profile: input.profile,
      createdAt: now,
      updatedAt: now
    };
    this.store.set(localId, job);
    return { ...job };
  }

  async get(id: string): Promise<IngestJob | undefined> {
    const job = this.store.get(id);
    if (!job) {
      return undefined;
    }
    return { ...job };
  }

  async list(opts?: { limit?: number; offset?: number }): Promise<{ items: Job[]; total: number }> {
    const all = Array.from(this.store.values())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    return { items: all.slice(offset, offset + limit).map((j) => ({ ...j })), total: all.length };
  }

  async update(
    id: string,
    patch: UpdateJobInput
  ): Promise<IngestJob | undefined> {
    const existing = this.store.get(id);
    if (!existing) {
      return undefined;
    }
    const next = applyJobPatch(existing, patch, new Date().toISOString());
    this.store.set(id, next);
    return { ...next };
  }

  async findByEncoreJobId(
    encoreJobId: string
  ): Promise<{ job: Job } | undefined> {
    for (const job of this.store.values()) {
      if (job.encoreJobId === encoreJobId) {
        return { job: { ...job } };
      }
    }
    return undefined;
  }
}
