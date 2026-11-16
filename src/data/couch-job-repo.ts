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
  isMissingUsableIndex,
  updateWithRetry,
  COUNT_CAP,
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
// "this resource type, newest first". The index's keys carry the document id as
// their final component, so jobs sharing a `createdAt` still have one stable
// total order and the pages stay disjoint slices of it.
//
// Exported because the stack's provisioner creates this index UP FRONT with the
// admin credential (src/routes/provision.ts step 2c) — one definition, used by
// both the creator and the reader, so they cannot drift apart.
export const JOBS_LIST_INDEX: MangoIndexDef = {
  ddoc: 'jobs-by-created-at',
  name: 'jobs-by-created-at',
  fields: ['resourceType', 'createdAt']
};

const LIST_INDEX = JOBS_LIST_INDEX;

// Every sort field must carry the SAME direction and must appear in the index
// in index order, so `resourceType` leads even though the selector pins it to a
// single value.
const LIST_SORT: MangoSort = [{ resourceType: 'desc' }, { createdAt: 'desc' }];

// Documents the degraded (sort-refused) listing path will scan. It IS the
// COUNT_CAP that bounds `couch.count` (src/data/couchdb.ts), imported rather
// than re-stated so the two cannot drift: the scan reads exactly as far as the
// count counts, and neither can turn one listing into an unbounded read.
const LIST_SCAN_CAP = COUNT_CAP;

// Newest first, ties broken by DESCENDING id.
//
// The tie-break direction matters and follows the query's: `LIST_SORT` reads
// LIST_INDEX in reverse (every sort field is `desc`), and the document id is
// the last component of the index key, so two jobs with the same `createdAt`
// come back newest-key-first — i.e. in descending id order — not ascending.
// Sorting a page here with an ASCENDING tie-break (what this comparator did
// before #1346 review) could therefore reorder a tied pair against the order
// the pages were cut in, which is the one thing the in-memory sort must never
// do: with ties straddling a page boundary, disagreeing orders can hide a job
// or repeat it.
function byCreatedAtDesc(a: Job, b: Job): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

// Which read path answered the listing (#1346 review finding 1).
//
// Process-local counters in the shape resolver-health already uses
// (src/services/resolver-health.ts): monotonic totals since boot plus a
// gauge-like "last path", so a deployment that NEVER serves the sorted query —
// previously indistinguishable from one that always does — is visible both in
// the logs (one line per transition, below) and here. Framework-free on
// purpose: this service has no metrics framework (resolver-health.ts:18-20).
export type JobListReadPath = 'none' | 'sorted-index' | 'degraded-scan';

export type JobListReadPathStats = {
  /** Path that answered the most recent listing. */
  last: JobListReadPath;
  /** Listings answered by the sorted, index-backed query since boot. */
  sortedIndexTotal: number;
  /** Listings answered by the bounded scan-and-sort fallback since boot. */
  degradedScanTotal: number;
  /** Failed best-effort index declarations from the read path since boot. */
  indexDeclarationFailureTotal: number;
};

const readPathStats: JobListReadPathStats = {
  last: 'none',
  sortedIndexTotal: 0,
  degradedScanTotal: 0,
  indexDeclarationFailureTotal: 0
};

/** Snapshot of which path has been answering GET /api/v1/jobs. */
export function jobListReadPathStats(): JobListReadPathStats {
  return { ...readPathStats };
}

/** Test seam: reset the counters so each test starts from a cold process. */
export function resetJobListReadPathStatsForTest(): void {
  readPathStats.last = 'none';
  readPathStats.sortedIndexTotal = 0;
  readPathStats.degradedScanTotal = 0;
  readPathStats.indexDeclarationFailureTotal = 0;
}

// Minimal logger surface, structurally satisfied by the Fastify/pino logger and
// by StackResolverLogger (src/services/workspace-stack.ts:116-120), which is
// what the resolver passes in — same seam shape as LogStoreErrorLog
// (src/services/log-store.ts:159-161). Defaults to a noop so existing callers
// and tests that construct the repository with a factory alone keep working.
export type JobListLog = {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
};

const NOOP_LOG: JobListLog = { info: () => {}, warn: () => {} };

export type CouchFactory = () => StackCouch;

export class CouchJobRepository implements JobRepository {
  private readonly log: JobListLog;

  constructor(
    private readonly couchFor: CouchFactory,
    // Where the listing reports which read path served it and why it degraded
    // (#1346 review finding 1). Optional: omitted means noop, so every
    // pre-existing `new CouchJobRepository(wc)` call is unchanged.
    opts: { log?: JobListLog } = {}
  ) {
    this.log = opts.log ?? NOOP_LOG;
  }

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
  // could appear on two pages or on none.
  //
  // `total` is a COUNT of the matching documents (`couch.count`) — the same
  // primitive and the same concurrent read pair the asset repository uses
  // (src/data/couch-asset-repo.ts:312-325) — replacing the old
  // `skip + items.length + 1` lower bound that read 101 after a full page. It is
  // not unbounded and must not be described as exact: `couch.count` asks for at
  // most COUNT_CAP (10,000) ids (src/data/couchdb.ts), so a stack with more than
  // COUNT_CAP jobs reports exactly COUNT_CAP. Raising or paginating past that
  // cap is a separate change; this one only stops `total` being a lower bound
  // that moved with the page.
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

  // Ask CouchDB for the page in `createdAt desc` order.
  //
  // The covering index is created at PROVISION time with the stack's admin
  // credential (src/routes/provision.ts step 2c), so on a stack provisioned by
  // this version the index is already in place when the first request arrives
  // and this method only reads. `declareIndexBestEffort` below remains for a
  // stack provisioned BEFORE that step existed; it can never fail a read.
  //
  // Degraded path: ONLY when CouchDB answers "the index this sort needs is not
  // in place" (isMissingUsableIndex — 400 `no_usable_index` / `invalid_index`,
  // src/data/couchdb.ts), fall back to a bounded scan of the matching documents
  // sorted here. That is slower but returns the SAME ordering and the same page
  // boundaries, so a listing never regresses to the unordered pages issue #1337
  // is about. Any OTHER failure (a 401/403 from the credential, a 409, a 5xx, a
  // transport error) propagates: the query got no answer, and answering with a
  // silently degraded page instead would hide a broken deployment behind a 200
  // (#1346 review finding 1).
  private async findPageNewestFirst(
    couch: StackCouch,
    limit: number,
    skip: number
  ): Promise<StoredDoc[]> {
    await this.declareIndexBestEffort(couch);
    try {
      const page = await couch.find(LIST_SELECTOR, {
        limit,
        skip,
        sort: LIST_SORT,
        useIndex: [LIST_INDEX.ddoc, LIST_INDEX.name]
      });
      this.recordReadPath('sorted-index');
      return page;
    } catch (err) {
      if (!isMissingUsableIndex(err)) {
        throw err;
      }
      this.recordReadPath('degraded-scan', err);
      const all = await couch.find(LIST_SELECTOR, { limit: LIST_SCAN_CAP });
      return all
        .filter((d) => d.resourceType === RESOURCE_TYPE)
        .sort(
          (a, b) =>
            String(b['createdAt'] ?? '').localeCompare(String(a['createdAt'] ?? '')) ||
            // Descending id on a tie, matching the reverse index traversal the
            // sorted query performs (see byCreatedAtDesc) so both paths cut the
            // pages out of the same total order.
            b._id.localeCompare(a._id)
        )
        .slice(skip, skip + limit);
    }
  }

  // Declare the covering index, best-effort: a design-document write is NOT
  // part of answering a read, so a failure here is counted and logged and the
  // sorted query is attempted anyway (if the index does exist, it serves; if it
  // does not, the sorted query's own `no_usable_index` drives the degraded path
  // above). StackCouch.ensureIndex bounds the attempts to one per process per
  // index per cooldown, so a stack whose runtime credential cannot write ddocs
  // does not issue a write per request (src/data/couchdb.ts ensureIndex).
  private async declareIndexBestEffort(couch: StackCouch): Promise<void> {
    try {
      await couch.ensureIndex(LIST_INDEX);
    } catch (err) {
      readPathStats.indexDeclarationFailureTotal += 1;
      this.log.warn(
        {
          err,
          ddoc: LIST_INDEX.ddoc,
          index: LIST_INDEX.name,
          indexDeclarationFailureTotal: readPathStats.indexDeclarationFailureTotal
        },
        'could not declare the jobs listing index from the read path; the index ' +
          'is normally created at provision time with the admin credential — if ' +
          'this stack was provisioned before that step, re-provision it, or the ' +
          'listing keeps paying a bounded scan'
      );
    }
  }

  // Count the serving path and log every TRANSITION between paths — one line
  // when a deployment starts degrading and one when it recovers, rather than a
  // line per request, so a permanently-degraded deployment is visible in the
  // logs without flooding them.
  private recordReadPath(path: Exclude<JobListReadPath, 'none'>, err?: unknown): void {
    const previous = readPathStats.last;
    if (path === 'sorted-index') {
      readPathStats.sortedIndexTotal += 1;
    } else {
      readPathStats.degradedScanTotal += 1;
    }
    readPathStats.last = path;
    if (previous === path) {
      return;
    }
    if (path === 'degraded-scan') {
      this.log.warn(
        {
          err,
          scanCap: LIST_SCAN_CAP,
          degradedScanTotal: readPathStats.degradedScanTotal,
          sortedIndexTotal: readPathStats.sortedIndexTotal
        },
        'GET /api/v1/jobs is being served by a bounded scan because the ' +
          'newest-first index is not usable; order and paging are correct but ' +
          `each listing reads up to ${LIST_SCAN_CAP} documents and jobs beyond ` +
          'that are not listed'
      );
      return;
    }
    this.log.info(
      {
        degradedScanTotal: readPathStats.degradedScanTotal,
        sortedIndexTotal: readPathStats.sortedIndexTotal
      },
      previous === 'none'
        ? 'GET /api/v1/jobs is served by the newest-first index'
        : 'GET /api/v1/jobs is served by the newest-first index again'
    );
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
