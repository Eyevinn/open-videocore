// CouchDB-backed pipeline execution repository (issue #184).
//
// Implements PipelineRepository on top of StackCouch so that pipeline
// executions survive server restarts. Executions are stored as documents with
// resourceType 'pipeline_execution' under their flat local id (the ULID). OSC
// provides structural tenant isolation (ADR-003), so there is no workspace
// partitioning here.
//
// Note on findRunningByAssetAndStep: StackCouch.find() uses CouchDB Mango
// queries, which cannot express a deep query over the elements of the `steps`
// array. Instead we narrow with a Mango selector to running executions for the
// asset, then filter in JS for a step matching the requested name in 'running'
// status.

import type {
  PipelineExecution,
  PipelineRepository,
  StepExecution
} from './pipeline-repo.js';
import type { PipelineStepName } from '../pipeline/pipelines.js';
import type { StoredDoc, StackCouch } from './couchdb.js';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

const RESOURCE_TYPE = 'pipeline_execution';

export type CouchFactory = () => StackCouch;

export class CouchPipelineRepository implements PipelineRepository {
  constructor(private readonly couchFor: CouchFactory) {}

  async create(input: {
    assetId: string;
    pipelineName: string;
    steps: PipelineStepName[];
    destinationBucket?: string;
  }): Promise<PipelineExecution> {
    const couch = this.couchFor();
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
    await couch.put(id, toDoc(execution));
    return execution;
  }

  async get(id: string): Promise<PipelineExecution | undefined> {
    const couch = this.couchFor();
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return undefined;
    }
    return fromDoc(doc);
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
    const couch = this.couchFor();
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return undefined;
    }
    const existing = fromDoc(doc);
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
    await couch.put(id, { ...toDoc(next), _rev: doc._rev });
    return next;
  }

  async listByAsset(assetId: string): Promise<PipelineExecution[]> {
    const couch = this.couchFor();
    const docs = await couch.find({ resourceType: RESOURCE_TYPE, assetId });
    const items = docs.filter((d) => d.resourceType === RESOURCE_TYPE).map(fromDoc);
    items.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return items;
  }

  async listAll(opts?: {
    status?: 'running' | 'done' | 'failed';
    limit?: number;
    offset?: number;
  }): Promise<{ items: PipelineExecution[]; total: number }> {
    const couch = this.couchFor();
    const docs = await couch.find({ resourceType: RESOURCE_TYPE });
    let items = docs.filter((d) => d.resourceType === RESOURCE_TYPE).map(fromDoc);
    if (opts?.status) {
      items = items.filter((e) => e.status === opts.status);
    }
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    const total = items.length;
    const offset = opts?.offset ?? 0;
    const limit = opts?.limit ?? 50;
    return { items: items.slice(offset, offset + limit), total };
  }

  async findRunningByAssetAndStep(
    assetId: string,
    step: PipelineStepName
  ): Promise<PipelineExecution | undefined> {
    const couch = this.couchFor();
    // Mango cannot query into the elements of the `steps` array, so narrow to
    // running executions for the asset and filter for the step in JS.
    const docs = await couch.find({
      resourceType: RESOURCE_TYPE,
      assetId,
      status: 'running'
    });
    const candidates = docs
      .filter((d) => d.resourceType === RESOURCE_TYPE)
      .map(fromDoc)
      .filter((e) => e.steps.some((s) => s.name === step && s.status === 'running'))
      // Most recent first.
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    return candidates.length > 0 ? candidates[0] : undefined;
  }
}

function toDoc(execution: PipelineExecution): Record<string, unknown> {
  return {
    resourceType: RESOURCE_TYPE,
    localId: execution.id,
    assetId: execution.assetId,
    pipelineName: execution.pipelineName,
    status: execution.status,
    steps: execution.steps,
    ...(execution.destinationBucket !== undefined
      ? { destinationBucket: execution.destinationBucket }
      : {}),
    ...(execution.resolvedOutputLocation !== undefined
      ? { resolvedOutputLocation: execution.resolvedOutputLocation }
      : {}),
    ...(execution.relocatedPackagingIds !== undefined
      ? { relocatedPackagingIds: execution.relocatedPackagingIds }
      : {}),
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt
  };
}

function fromDoc(doc: StoredDoc): PipelineExecution {
  const rawSteps = Array.isArray(doc['steps']) ? (doc['steps'] as unknown[]) : [];
  const steps: StepExecution[] = rawSteps.map((s) => {
    const step = s as Record<string, unknown>;
    return {
      name: step['name'] as PipelineStepName,
      status: step['status'] as StepExecution['status'],
      jobId: step['jobId'] as string | undefined,
      encoreJobId: step['encoreJobId'] as string | undefined,
      error: step['error'] as string | undefined,
      startedAt: step['startedAt'] as string | undefined,
      completedAt: step['completedAt'] as string | undefined,
      progress: step['progress'] as number | undefined
    };
  });
  return {
    id: String(doc['localId'] ?? stripPartition(doc._id)),
    assetId: String(doc['assetId'] ?? ''),
    pipelineName: String(doc['pipelineName'] ?? ''),
    status: doc['status'] as PipelineExecution['status'],
    steps,
    ...(typeof doc['destinationBucket'] === 'string'
      ? { destinationBucket: doc['destinationBucket'] }
      : {}),
    ...(isResolvedLocation(doc['resolvedOutputLocation'])
      ? { resolvedOutputLocation: doc['resolvedOutputLocation'] }
      : {}),
    ...(Array.isArray(doc['relocatedPackagingIds'])
      ? {
          relocatedPackagingIds: (doc['relocatedPackagingIds'] as unknown[]).map(
            (v) => String(v)
          )
        }
      : {}),
    createdAt: String(doc['createdAt'] ?? ''),
    updatedAt: String(doc['updatedAt'] ?? '')
  };
}

function stripPartition(id: string): string {
  const idx = id.indexOf(':');
  return idx >= 0 ? id.slice(idx + 1) : id;
}

// Narrow a stored value to the { bucket, prefix } resolved-location shape
// (issue #208). Guards against malformed/legacy documents so a bad field never
// yields a partially-typed PipelineExecution.
function isResolvedLocation(
  value: unknown
): value is { bucket: string; prefix: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { bucket?: unknown }).bucket === 'string' &&
    typeof (value as { prefix?: unknown }).prefix === 'string'
  );
}
