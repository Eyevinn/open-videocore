// CouchDB-backed ingest job repository (issue #5).
//
// Implements JobRepository on top of WorkspaceCouch, reusing the same
// workspace partition + ownership re-check as the asset repository. Jobs are
// stored as documents with resourceType 'job' inside the caller's partition, so
// a job id from another workspace resolves to undefined (existence is not
// leaked) and is never mutated cross-workspace.

import {
  applyJobPatch,
  appendEncodeAttemptToJob,
  finalizeLatestEncodeAttemptOnJob,
  decodeEncoreJobId,
  type CreateJobInput,
  type EncodeAttempt,
  type Job,
  type JobRepository,
  type JobStatus,
  type JobType,
  type UpdateJobInput
} from './job-repo.js';
import type { MessageFailureClass } from '../encore-scaler/retry-policy.js';
import { updateWithRetry, type StoredDoc, type StackCouch } from './couchdb.js';

const RESOURCE_TYPE = 'job';

export type CouchFactory = () => StackCouch;

export class CouchJobRepository implements JobRepository {
  constructor(private readonly couchFor: CouchFactory) {}

  async create(input: CreateJobInput): Promise<Job> {
    const couch = this.couchFor();
    const now = new Date().toISOString();
    const localId = `job-${cryptoId()}`;
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
    await couch.put(localId, toDoc(job));
    return job;
  }

  async get(id: string): Promise<Job | undefined> {
    const couch = this.couchFor();
    const doc = await couch.get(id);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return undefined;
    }
    return fromDoc(doc);
  }

  async list(opts?: { limit?: number; offset?: number }): Promise<{ items: Job[]; total: number }> {
    const couch = this.couchFor();
    const limit = opts?.limit ?? 50;
    const skip = opts?.offset ?? 0;
    const docs = await couch.find({ resourceType: RESOURCE_TYPE }, { limit, skip });
    const items = docs.filter((d) => d.resourceType === RESOURCE_TYPE).map(fromDoc);
    items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { items, total: skip + items.length + (items.length === limit ? 1 : 0) };
  }

  // The internal Encore callback is unauthenticated and carries no workspace.
  // We encode the workspaceId into the encoreJobId at submit time (see
  // job-repo.encodeEncoreJobId), so we can decode it here and resolve the job
  // through the normal workspace-scoped path — no cross-partition scan.
  async findByEncoreJobId(
    encoreJobId: string
  ): Promise<{ job: Job } | undefined> {
    const decoded = decodeEncoreJobId(encoreJobId);
    if (!decoded) {
      return undefined;
    }
    const couch = this.couchFor();
    const doc = await couch.get(decoded.jobLocalId);
    if (!doc || doc.resourceType !== RESOURCE_TYPE) {
      return undefined;
    }
    const job = fromDoc(doc);
    if (job.encoreJobId !== encoreJobId) {
      return undefined;
    }
    return { job };
  }

  // Concurrent-write safety (issue #451, reusing the #278 primitive): route the
  // read-modify-write through updateWithRetry so a `Document update conflict.`
  // (HTTP 409) from a concurrent writer racing on the same _rev — e.g. the
  // sibling encodeAttemptLog append and the queued->running flip both firing in
  // one dispatch(), or a progress/reconcile write landing between this read and
  // put — is refetched and re-applied rather than silently dropped. patchFn is
  // pure (no writes), so it is safe to re-run per attempt.
  async update(
    id: string,
    patch: UpdateJobInput
  ): Promise<Job | undefined> {
    const couch = this.couchFor();
    let updated: Job | undefined;
    const written = await updateWithRetry(couch, id, (current) => {
      if (current.resourceType !== RESOURCE_TYPE) {
        // Not a job doc: return it unchanged so the write is a no-op, then the
        // not-found contract is preserved below (updated stays undefined).
        return current;
      }
      updated = applyJobPatch(fromDoc(current), patch, new Date().toISOString());
      return toDoc(updated);
    });
    return written ? updated : undefined;
  }

  // Durably append one Encore dispatch to the job's encode-attempt log (#380).
  // Read-modify-write against the current CouchDB revision so the append lands
  // on top of the latest persisted state. This is the durable capture that
  // outlives the Valkey retry TTL: it is never cleared by clearRetryState.
  // Routed through updateWithRetry (#451): the sibling `update` (queued->running)
  // fires in the same dispatch() against the same doc, so a raw get+put here
  // races and 409s — the scaler swallowed that failure, dropping the log. The
  // retry refetches _rev and re-appends so the append is not lost.
  async appendEncodeAttempt(
    id: string,
    attempt: { index?: number; startedAt?: string; endedAt?: string; classification?: MessageFailureClass }
  ): Promise<Job | undefined> {
    const couch = this.couchFor();
    let updated: Job | undefined;
    const written = await updateWithRetry(couch, id, (current) => {
      if (current.resourceType !== RESOURCE_TYPE) {
        return current;
      }
      updated = appendEncodeAttemptToJob(fromDoc(current), attempt, new Date().toISOString());
      return toDoc(updated);
    });
    return written ? updated : undefined;
  }

  // Durably finalise the latest (open) encode-attempt on completion (#381).
  // Read-modify-write against the current CouchDB revision so the close-out
  // lands on top of the latest persisted state (the dispatch-time append from
  // #380). Finalises the last log entry in place — never appends — so the
  // attempt count is unchanged. Routed through updateWithRetry (#451) for the
  // same conflict-retry safety as the other read-modify-write paths.
  async finalizeEncodeAttempt(
    id: string,
    patch: { endedAt?: string; classification?: MessageFailureClass }
  ): Promise<Job | undefined> {
    const couch = this.couchFor();
    let updated: Job | undefined;
    const written = await updateWithRetry(couch, id, (current) => {
      if (current.resourceType !== RESOURCE_TYPE) {
        return current;
      }
      updated = finalizeLatestEncodeAttemptOnJob(fromDoc(current), patch, new Date().toISOString());
      return toDoc(updated);
    });
    return written ? updated : undefined;
  }
}

function toDoc(job: Job): Record<string, unknown> {
  return {
    resourceType: RESOURCE_TYPE,
    localId: job.id,
    type: job.type,
    status: job.status,
    assetId: job.assetId,
    sourceUrl: job.sourceUrl,
    progress: job.progress,
    bytesTransferred: job.bytesTransferred,
    totalBytes: job.totalBytes,
    attempts: job.attempts,
    error: job.error,
    encoreJobId: job.encoreJobId,
    encoreInternalJobId: job.encoreInternalJobId,
    profile: job.profile,
    renditionAssetIds: job.renditionAssetIds,
    encodeAttempts: job.encodeAttempts,
    encodeAttemptLog: job.encodeAttemptLog,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt
  };
}

function fromDoc(doc: StoredDoc): Job {
  return {
    id: String(doc['localId'] ?? stripPartition(doc._id)),
    type: doc['type'] as JobType,
    status: doc['status'] as JobStatus,
    assetId: String(doc['assetId'] ?? ''),
    sourceUrl: String(doc['sourceUrl'] ?? ''),
    progress: Number(doc['progress'] ?? 0),
    bytesTransferred: Number(doc['bytesTransferred'] ?? 0),
    totalBytes: doc['totalBytes'] as number | undefined,
    attempts: Number(doc['attempts'] ?? 0),
    error: doc['error'] as string | undefined,
    encoreJobId: doc['encoreJobId'] as string | undefined,
    encoreInternalJobId: doc['encoreInternalJobId'] as string | undefined,
    profile: doc['profile'] as string | undefined,
    renditionAssetIds: doc['renditionAssetIds'] as string[] | undefined,
    encodeAttempts: doc['encodeAttempts'] as number | undefined,
    encodeAttemptLog: doc['encodeAttemptLog'] as EncodeAttempt[] | undefined,
    createdAt: String(doc['createdAt'] ?? ''),
    updatedAt: String(doc['updatedAt'] ?? '')
  };
}

function stripPartition(id: string): string {
  const idx = id.indexOf(':');
  return idx >= 0 ? id.slice(idx + 1) : id;
}

function cryptoId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
