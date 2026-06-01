// Ingest job repository (issue #5: URL-pull ingest).
//
// An IngestJob tracks the asynchronous pull of a remote source (HTTP/S or S3)
// into MinIO. It mirrors the asset repository design: a workspace-scoped
// interface with an in-memory implementation for tests/dev and a CouchDB-backed
// implementation for production (see couch-job-repo.ts). The job is the unit of
// observability for the pull worker — clients poll GET /api/v1/jobs/:id to see
// status, progress, and any terminal error.

import { assertOwned, assertValidWorkspaceId, namespacedId } from './guard.js';

// ---------------------------------------------------------------------------
// Job model + lifecycle
// ---------------------------------------------------------------------------

// Job lifecycle. A job is created `pending`, advances to `running` once the
// worker starts streaming bytes, and ends in either `done` or `failed`. Both
// are terminal.
export const JOB_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

// The kind of work a job performs. URL-pull ingest is the only kind today;
// transcode/metadata jobs will reuse this repo in later issues.
export const JOB_TYPES = ['ingest-url'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export type IngestJob = {
  id: string;
  workspaceId: string;
  type: JobType;
  status: JobStatus;
  // The asset this job populates.
  assetId: string;
  // The source being pulled (HTTP/S or S3 URL).
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
  createdAt: string;
  updatedAt: string;
};

export type CreateJobInput = {
  type: JobType;
  assetId: string;
  sourceUrl: string;
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
};

const ALLOWED_JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  pending: ['running', 'failed'],
  running: ['done', 'failed', 'running'],
  done: [],
  failed: []
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
  create(workspaceId: string, input: CreateJobInput): Promise<IngestJob>;
  get(workspaceId: string, id: string): Promise<IngestJob | undefined>;
  update(workspaceId: string, id: string, patch: UpdateJobInput): Promise<IngestJob | undefined>;
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
  return next;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

export class InMemoryJobRepository implements JobRepository {
  private readonly store = new Map<string, IngestJob>();
  private counter = 0;

  async create(workspaceId: string, input: CreateJobInput): Promise<IngestJob> {
    assertValidWorkspaceId(workspaceId);
    const now = new Date().toISOString();
    const localId = `job-${++this.counter}`;
    const job: IngestJob = {
      id: localId,
      workspaceId,
      type: input.type,
      status: 'pending',
      assetId: input.assetId,
      sourceUrl: input.sourceUrl,
      progress: 0,
      bytesTransferred: 0,
      attempts: 0,
      createdAt: now,
      updatedAt: now
    };
    this.store.set(namespacedId(workspaceId, localId), job);
    return { ...job };
  }

  async get(workspaceId: string, id: string): Promise<IngestJob | undefined> {
    assertValidWorkspaceId(workspaceId);
    const job = this.store.get(namespacedId(workspaceId, id));
    if (!job) {
      return undefined;
    }
    assertOwned(workspaceId, job.workspaceId);
    return { ...job };
  }

  async update(
    workspaceId: string,
    id: string,
    patch: UpdateJobInput
  ): Promise<IngestJob | undefined> {
    assertValidWorkspaceId(workspaceId);
    const key = namespacedId(workspaceId, id);
    const existing = this.store.get(key);
    if (!existing || existing.workspaceId !== workspaceId) {
      return undefined;
    }
    const next = applyJobPatch(existing, patch, new Date().toISOString());
    this.store.set(key, next);
    return { ...next };
  }
}
