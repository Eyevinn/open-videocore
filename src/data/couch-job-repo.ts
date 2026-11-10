// CouchDB-backed ingest job repository (issue #5).
//
// Implements JobRepository on top of WorkspaceCouch, reusing the same
// workspace partition + ownership re-check as the asset repository. Jobs are
// stored as documents with resourceType 'job' inside the caller's partition, so
// a job id from another workspace resolves to undefined (existence is not
// leaked) and is never mutated cross-workspace.

import {
  ACTIVE_JOB_STATUSES,
  applyJobPatch,
  appendEncodeAttemptToJob,
  finalizeLatestEncodeAttemptOnJob,
  decodeEncoreJobId,
  type CreateJobInput,
  type EncodeAttempt,
  type Job,
  type JobInterruptionReason,
  type JobRepository,
  type JobStatus,
  type JobType,
  type UpdateJobInput
} from './job-repo.js';
import type { MessageFailureClass } from '../encore-scaler/retry-policy.js';
import { currentDocumentStackName } from '../services/request-stack-context.js';
import {
  updateWithRetry,
  type MangoIndexDef,
  type MangoSort,
  type StoredDoc,
  type StackCouch
} from './couchdb.js';

const RESOURCE_TYPE = 'job';

// The newest-first listing query (issue #1337).
//
// `createdAt: { $gt: null }` is in the selector because CouchDB will only sort
// on a field the query also constrains; `$gt: null` is the range predicate that
// matches every present, non-null value, so it narrows nothing a job document
// written by `toDoc` below (which always writes `createdAt`) would match.
const LIST_SELECTOR: Record<string, unknown> = {
  resourceType: RESOURCE_TYPE,
  createdAt: { $gt: null }
};

// Mango json index backing LIST_SORT. Field order matters and a sort may only
// use a prefix of it in the same order, so `[resourceType, createdAt]` serves
// "this resource type, newest first". Within one index key CouchDB orders equal
// keys by document id, so jobs sharing a `createdAt` still have one stable
// total order and the pages stay disjoint slices of it.
const LIST_INDEX: MangoIndexDef = {
  ddoc: 'jobs-by-created-at',
  name: 'jobs-by-created-at',
  fields: ['resourceType', 'createdAt']
};

// Every sort field must carry the SAME direction and must appear in the index
// in index order, so `resourceType` leads even though the selector pins it to a
// single value.
const LIST_SORT: MangoSort = [{ resourceType: 'desc' }, { createdAt: 'desc' }];

// Documents the degraded (sort-refused) listing path will scan. Mirrors the
// COUNT_CAP that bounds `couch.count` (src/data/couchdb.ts), so that path
// cannot turn one listing into an unbounded read either.
const LIST_SCAN_CAP = 10_000;

// Newest first, ties broken by ascending id — the same total order CouchDB
// applies inside LIST_INDEX (equal index keys are ordered by document id), so
// re-sorting a page here can never disagree with the order the pages were cut
// in.
function byCreatedAtDesc(a: Job, b: Job): number {
  return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

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
      packagingId: input.packagingId,
      outputPrefix: input.outputPrefix,
      // Durable stack identity (#1097): the stack this job is being created
      // against, so a worker that picks the job up after the request (or after a
      // process restart) can re-enter it. Undefined outside a request, which
      // preserves the previous default-stack behaviour on boot/sweep paths.
      stackName: input.stackName ?? currentDocumentStackName(),
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

  // One page of the newest-first job list (issue #1337).
  //
  // The page is cut by CouchDB from a `createdAt desc` ORDER, not from the
  // index's own document-id order: job ids are `job-<random>`, so before this
  // the database applied skip/limit to an effectively unordered sequence and the
  // in-memory sort could only reorder whatever that page happened to contain —
  // page 2 could start again with jobs newer than the end of page 1, and a job
  // could appear on two pages or on none. `total` is now the exact count of
  // matching documents (`couch.count`), the same primitive and the same
  // concurrent read pair the asset repository uses
  // (src/data/couch-asset-repo.ts:312-325), replacing the old
  // `skip + items.length + 1` lower bound that read 101 after a full page.
  async list(opts?: { limit?: number; offset?: number }): Promise<{ items: Job[]; total: number }> {
    const couch = this.couchFor();
    const limit = opts?.limit ?? 50;
    const skip = opts?.offset ?? 0;
    const [docs, total] = await Promise.all([
      this.findPageNewestFirst(couch, limit, skip),
      couch.count(LIST_SELECTOR)
    ]);
    const items = docs.filter((d) => d.resourceType === RESOURCE_TYPE).map(fromDoc);
    // The page is already ordered by the query; re-applying the same comparator
    // is a no-op that keeps the returned order explicit at this layer (and
    // orders the degraded path below identically).
    items.sort(byCreatedAtDesc);
    return { items, total };
  }

  // Ask CouchDB for the page in `createdAt desc` order, declaring the covering
  // index first.
  //
  // Degraded path: if the index cannot be declared or the sorted query is
  // refused (e.g. a database this process may read but not add a design
  // document to), fall back to a bounded scan of the matching documents sorted
  // here. That is slower but returns the SAME ordering and the same page
  // boundaries, so a listing never regresses to the unordered pages this issue
  // is about, and never fails outright.
  private async findPageNewestFirst(
    couch: StackCouch,
    limit: number,
    skip: number
  ): Promise<StoredDoc[]> {
    try {
      await couch.ensureIndex(LIST_INDEX);
      return await couch.find(LIST_SELECTOR, {
        limit,
        skip,
        sort: LIST_SORT,
        useIndex: [LIST_INDEX.ddoc, LIST_INDEX.name]
      });
    } catch {
      const all = await couch.find(LIST_SELECTOR, { limit: LIST_SCAN_CAP });
      return all
        .filter((d) => d.resourceType === RESOURCE_TYPE)
        .sort(
          (a, b) =>
            String(b['createdAt'] ?? '').localeCompare(String(a['createdAt'] ?? '')) ||
            a._id.localeCompare(b._id)
        )
        .slice(skip, skip + limit);
    }
  }

  // Find every in-flight job referencing `assetId` as its source (issue #569).
  // A Mango selector on the workspace partition: resourceType 'job', the target
  // assetId, and a non-terminal status (ACTIVE_JOB_STATUSES via $in). Settled
  // jobs are excluded server-side so the asset DELETE handler blocks only on
  // truly active references (ADR-020 decision 2). Sorted by createdAt so the
  // returned ids are deterministic.
  async findActiveByAssetId(assetId: string): Promise<Job[]> {
    const couch = this.couchFor();
    const docs = await couch.find(
      { resourceType: RESOURCE_TYPE, assetId, status: { $in: [...ACTIVE_JOB_STATUSES] } },
      { limit: 1000 }
    );
    return docs
      .filter((d) => d.resourceType === RESOURCE_TYPE)
      .map(fromDoc)
      .filter((j) => j.assetId === assetId && ACTIVE_JOB_STATUSES.includes(j.status))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
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
    packagingId: job.packagingId,
    outputPrefix: job.outputPrefix,
    encodeAttempts: job.encodeAttempts,
    encodeAttemptLog: job.encodeAttemptLog,
    interrupted: job.interrupted,
    interruptionReason: job.interruptionReason,
    droppedByScaler: job.droppedByScaler,
    // #1023: the durable trace that a drop was reported and later corrected.
    // Persisted here (not only in the audit trail) so it survives on the record
    // for every correction path, including the callback poller, which applies
    // completions with no audit emitter wired.
    droppedThenRecovered: job.droppedThenRecovered,
    correctedDropError: job.correctedDropError,
    // #1226: the durable trace that a completion arrived for this job after it
    // was cancelled and was discarded, with the output prefix that was
    // reclaimed. Persisted here (not only logged) so a cancelled job reporting
    // 0 renditions explains itself from the record alone.
    lateCompletionDiscarded: job.lateCompletionDiscarded,
    discardedRenditionCount: job.discardedRenditionCount,
    discardedOutputPrefix: job.discardedOutputPrefix,
    // Durable stack identity (#1097). Written on every put so an update()
    // round-trip never drops the value; absent (undefined) on jobs created
    // outside a request and on documents written before #1097.
    stackName: job.stackName,
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
    packagingId: doc['packagingId'] as string | undefined,
    outputPrefix: doc['outputPrefix'] as string | undefined,
    encodeAttempts: doc['encodeAttempts'] as number | undefined,
    encodeAttemptLog: doc['encodeAttemptLog'] as EncodeAttempt[] | undefined,
    interrupted: doc['interrupted'] as boolean | undefined,
    interruptionReason: doc['interruptionReason'] as JobInterruptionReason | undefined,
    droppedByScaler: doc['droppedByScaler'] as boolean | undefined,
    droppedThenRecovered: doc['droppedThenRecovered'] as boolean | undefined,
    correctedDropError: doc['correctedDropError'] as string | undefined,
    // #1226: absent on every job that never had a completion discarded after a
    // cancel, which reads back as undefined exactly like the #1023 pair above.
    lateCompletionDiscarded: doc['lateCompletionDiscarded'] as boolean | undefined,
    discardedRenditionCount: doc['discardedRenditionCount'] as number | undefined,
    discardedOutputPrefix: doc['discardedOutputPrefix'] as string | undefined,
    // Durable stack identity (#1097). A document written before #1097 has no
    // such field and reads back as undefined — the documented legacy case,
    // which keeps the first-listed-stack behaviour.
    stackName: doc['stackName'] as string | undefined,
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
