// PipelineExecution repository (PipelineExecution feature).
//
// A PipelineExecution is a first-class record of a named pipeline being run
// against a single asset. It replaces the ad-hoc pipelineStatus/
// pipelineTranscodeJobId/pipelineError fields that previously lived on Asset.
//
// Each execution carries an ordered list of StepExecution entries whose status
// advances as OSC callbacks arrive (see src/routes/internal.ts). Only an
// in-memory implementation is provided — executions are ephemeral orchestration
// state, not durable domain records, so no CouchDB backing is required yet.

import { monotonicFactory } from 'ulid';
import type { PipelineStepName } from '../pipeline/pipelines.js';

const ulid = monotonicFactory();

export type StepStatus = 'pending' | 'running' | 'done' | 'failed';

export type StepExecution = {
  name: PipelineStepName;
  status: StepStatus;
  jobId?: string; // internal job repo ID (transcode steps)
  encoreJobId?: string; // Encore external job ID (transcode steps)
  error?: string;
  startedAt?: string;
  completedAt?: string;
  progress?: number; // 0-100, populated at read time from the linked job
};

export type PipelineExecution = {
  id: string; // ULID
  assetId: string;
  pipelineName: string;
  status: 'running' | 'done' | 'failed';
  steps: StepExecution[];
  // Optional per-execution destination override (issue #207). A normalized
  // destination bucket/folder identifier (always trailing-slash terminated).
  // When absent, later stages (packager relocation, delivery — #208/#210) fall
  // back to the provisioned instance-level default. Persisted so the pipeline
  // and delivery endpoint can both resolve the destination actually used.
  destinationBucket?: string;
  // The canonical location the packaged output actually landed at, resolved
  // after post-package relocation (issue #208, ADR-011). When a per-execution
  // `destinationBucket` override is set, PackagingService server-side-copies the
  // produced CMAF/HLS/DASH objects there and records the resolved
  // `{bucket, prefix}` here so delivery-URL resolution (issue #210) can read the
  // location actually used rather than re-deriving it. Absent when no override
  // was supplied (delivery then falls back to the provisioned default).
  resolvedOutputLocation?: { bucket: string; prefix: string };
  // PackagingIds whose post-package relocation has already run (issue #208). The
  // packager success callback can fire more than once for the same packagingId
  // (retries, at-least-once callback delivery); recording completed ids here
  // makes the server-side copy idempotent so a repeat callback neither re-copies
  // nor double-counts. Absent/empty when no relocation has run.
  relocatedPackagingIds?: string[];
  createdAt: string;
  updatedAt: string;
};

export interface PipelineRepository {
  create(input: {
    assetId: string;
    pipelineName: string;
    steps: PipelineStepName[];
    destinationBucket?: string;
  }): Promise<PipelineExecution>;
  get(id: string): Promise<PipelineExecution | undefined>;
  update(
    id: string,
    patch: Partial<
      Pick<
        PipelineExecution,
        'status' | 'steps' | 'resolvedOutputLocation' | 'relocatedPackagingIds'
      >
    >
  ): Promise<PipelineExecution | undefined>;
  listByAsset(assetId: string): Promise<PipelineExecution[]>;
  listAll(opts?: {
    status?: 'running' | 'done' | 'failed';
    limit?: number;
    offset?: number;
  }): Promise<{ items: PipelineExecution[]; total: number }>;
  // Find the most recent running execution for an asset that has the given step
  // in 'running' state.
  findRunningByAssetAndStep(
    assetId: string,
    step: PipelineStepName
  ): Promise<PipelineExecution | undefined>;
}

export class InMemoryPipelineRepository implements PipelineRepository {
  private readonly store = new Map<string, PipelineExecution>();

  async create(input: {
    assetId: string;
    pipelineName: string;
    steps: PipelineStepName[];
    destinationBucket?: string;
  }): Promise<PipelineExecution> {
    const now = new Date().toISOString();
    const id = ulid();
    const execution: PipelineExecution = {
      id,
      assetId: input.assetId,
      pipelineName: input.pipelineName,
      status: 'running',
      steps: input.steps.map((name) => ({ name, status: 'pending' })),
      ...(input.destinationBucket !== undefined
        ? { destinationBucket: input.destinationBucket }
        : {}),
      createdAt: now,
      updatedAt: now
    };
    this.store.set(id, execution);
    return clone(execution);
  }

  async get(id: string): Promise<PipelineExecution | undefined> {
    const found = this.store.get(id);
    return found ? clone(found) : undefined;
  }

  async update(
    id: string,
    patch: Partial<
      Pick<
        PipelineExecution,
        'status' | 'steps' | 'resolvedOutputLocation' | 'relocatedPackagingIds'
      >
    >
  ): Promise<PipelineExecution | undefined> {
    const existing = this.store.get(id);
    if (!existing) {
      return undefined;
    }
    const next: PipelineExecution = {
      ...existing,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(patch.steps !== undefined ? { steps: patch.steps } : {}),
      ...(patch.resolvedOutputLocation !== undefined
        ? { resolvedOutputLocation: patch.resolvedOutputLocation }
        : {}),
      ...(patch.relocatedPackagingIds !== undefined
        ? { relocatedPackagingIds: patch.relocatedPackagingIds }
        : {}),
      updatedAt: new Date().toISOString()
    };
    this.store.set(id, next);
    return clone(next);
  }

  async listByAsset(assetId: string): Promise<PipelineExecution[]> {
    return [...this.store.values()]
      .filter((e) => e.assetId === assetId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map(clone);
  }

  async listAll(opts?: {
    status?: 'running' | 'done' | 'failed';
    limit?: number;
    offset?: number;
  }): Promise<{ items: PipelineExecution[]; total: number }> {
    let all = [...this.store.values()].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id)
    );
    if (opts?.status) {
      all = all.filter((e) => e.status === opts.status);
    }
    const total = all.length;
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    return { items: all.slice(offset, offset + limit).map(clone), total };
  }

  async findRunningByAssetAndStep(
    assetId: string,
    step: PipelineStepName
  ): Promise<PipelineExecution | undefined> {
    const candidates = [...this.store.values()]
      .filter(
        (e) =>
          e.assetId === assetId &&
          e.status === 'running' &&
          e.steps.some((s) => s.name === step && s.status === 'running')
      )
      // Most recent first.
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return candidates.length > 0 ? clone(candidates[0]) : undefined;
  }
}

function clone(execution: PipelineExecution): PipelineExecution {
  return {
    ...execution,
    steps: execution.steps.map((s) => ({ ...s })),
    ...(execution.resolvedOutputLocation !== undefined
      ? { resolvedOutputLocation: { ...execution.resolvedOutputLocation } }
      : {}),
    ...(execution.relocatedPackagingIds !== undefined
      ? { relocatedPackagingIds: [...execution.relocatedPackagingIds] }
      : {})
  };
}
