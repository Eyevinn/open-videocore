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
import { cloneDrmRequest } from './pipeline-repo.js';
import type { PipelineStepName } from '../pipeline/pipelines.js';
import { stepErrorDetailSchema } from '../pipeline/step-error-detail.js';
import { PROTECTION_SCHEMES, drmEnabled, isDrmSystemId } from '../types/drm.js';
import {
  isMissingUsableIndex,
  COUNT_CAP,
  type MangoIndexDef,
  type MangoSort,
  type StoredDoc,
  type StackCouch
} from './couchdb.js';
import { monotonicFactory } from 'ulid';

const ulid = monotonicFactory();

const RESOURCE_TYPE = 'pipeline_execution';

// The newest-first listing query (issue #1350).
//
// `createdAt: { $gt: null }` is in the selector because CouchDB will only sort
// on a field the query also constrains; `$gt: null` is the range predicate that
// matches every present, non-null value, so it narrows nothing an execution
// document written by `toDoc` below (which always writes `createdAt`) would
// match.
function buildListSelector(status?: 'running' | 'done' | 'failed'): Record<string, unknown> {
  return {
    resourceType: RESOURCE_TYPE,
    ...(status !== undefined ? { status } : {}),
    createdAt: { $gt: null }
  };
}

// Mango json index backing LIST_SORT. Field order matters and a sort may only
// use a prefix of it in the same order, so `[resourceType, createdAt]` serves
// "this resource type, newest first". A `status` filter is NOT in the index: it
// stays a selector condition CouchDB applies while walking this index, which is
// correct (and is why the status listing pages over the whole list too, not
// over a pre-cut window).
//
// Exported so a provisioner can create the index up front with the admin
// credential — one definition for creator and reader, so they cannot drift.
export const PIPELINE_EXECUTIONS_LIST_INDEX: MangoIndexDef = {
  ddoc: 'pipeline-executions-by-created-at',
  name: 'pipeline-executions-by-created-at',
  fields: ['resourceType', 'createdAt']
};

// Every sort field must carry the SAME direction and must appear in the index
// in index order, so `resourceType` leads even though the selector pins it to a
// single value.
const LIST_SORT: MangoSort = [{ resourceType: 'desc' }, { createdAt: 'desc' }];

// Documents the degraded (sort-refused) listing path will scan, and the page
// size it reads them in. The cap IS the COUNT_CAP that bounds `couch.count`
// (src/data/couchdb.ts), imported rather than re-stated so the two cannot
// drift: the scan reads exactly as far as the count counts, and neither can
// turn one listing into an unbounded read.
const LIST_SCAN_CAP = COUNT_CAP;
const LIST_SCAN_PAGE_SIZE = 500;

// Newest first, ties broken by DESCENDING id.
//
// The tie-break direction follows the query's: `LIST_SORT` reads the index in
// reverse (every sort field is `desc`) and the document id is the last
// component of the index key, so two executions with the same `createdAt` come
// back newest-key-first — i.e. in descending id order. Sorting a page here with
// an ascending tie-break could reorder a tied pair against the order the pages
// were cut in, which is the one thing an in-memory sort must never do: with
// ties straddling a page boundary, disagreeing orders can hide an execution or
// repeat it. This is the comparator `listAll` already used (and the inverse of
// InMemoryPipelineRepository.listAll's, src/data/pipeline-repo.ts:243-258).
function byCreatedAtDesc(a: PipelineExecution, b: PipelineExecution): number {
  return b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id);
}

// Same order over raw documents, for the degraded scan path. `_id` is the ULID
// (toDoc writes the same value to `localId`), so this is the same total order.
function docByCreatedAtDesc(a: StoredDoc, b: StoredDoc): number {
  return (
    String(b['createdAt'] ?? '').localeCompare(String(a['createdAt'] ?? '')) ||
    String(b._id).localeCompare(String(a._id))
  );
}

// Minimal logger surface, structurally satisfied by Fastify's logger. Optional:
// used only to make a degraded listing observable instead of silent — the same
// seam CouchCommentRepository takes (src/data/couch-comment-repo.ts:50-52).
export type PipelineRepoLogger = {
  warn: (obj: unknown, msg?: string) => void;
};

export type CouchFactory = () => StackCouch;

export class CouchPipelineRepository implements PipelineRepository {
  constructor(
    private readonly couchFor: CouchFactory,
    // Where a degraded listing reports itself (#1350). Optional: omitted means
    // silence, so every pre-existing `new CouchPipelineRepository(wc)` call —
    // and every existing test — is unchanged.
    private readonly log?: PipelineRepoLogger
  ) {}

  async create(input: {
    assetId: string;
    pipelineName: string;
    steps: PipelineStepName[];
    destinationBucket?: string;
    // Per-execution DRM request (ADR-008, issue #1259) — see PipelineRepository.
    drm?: PipelineExecution['drm'];
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
      // DRM request (#1259). Persisted only with `DRM_ENABLED` on (ADR-008 D9),
      // so a flag-off execution document is identical to a pre-#1259 one.
      ...(drmEnabled() && input.drm !== undefined ? { drm: cloneDrmRequest(input.drm) } : {}),
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

  // One page of the newest-first execution list (issue #1350).
  //
  // The page is cut by CouchDB out of a `createdAt desc` ORDER over EVERY
  // matching execution, not out of whatever `find`'s default limit of 50
  // happened to return. Before this, `find({ resourceType })` took that default
  // — 50 documents in the database's own id order, and ids are ULIDs, so the 50
  // OLDEST — and the status filter, sort, `total` and offset/limit slice all
  // ran over those 50 alone. An execution created after the 50th never
  // appeared, `total` was stuck at `min(count, 50)`, and offset/limit paged
  // through a fixed window. The same bug starved the stalled-package
  // reconciler, which asks for `status: 'running'`
  // (src/pipeline/stalled-package-reconciler.ts:104-108).
  //
  // `total` is now a COUNT of the matching documents (`couch.count`) — the same
  // primitive and the same concurrent read pair the asset repository uses
  // (src/data/couch-asset-repo.ts:312-325). It is bounded, not unbounded:
  // `couch.count` asks for at most COUNT_CAP (10,000) ids
  // (src/data/couchdb.ts), so a stack holding more executions than that reports
  // exactly COUNT_CAP. That is still a count of the whole list rather than of
  // one fixed window.
  async listAll(opts?: {
    status?: 'running' | 'done' | 'failed';
    limit?: number;
    offset?: number;
  }): Promise<{ items: PipelineExecution[]; total: number }> {
    const couch = this.couchFor();
    const limit = opts?.limit ?? 50;
    const skip = opts?.offset ?? 0;
    const selector = buildListSelector(opts?.status);
    const [docs, total] = await Promise.all([
      this.findPageNewestFirst(couch, selector, limit, skip),
      couch.count(selector)
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
  // Degraded path: ONLY when CouchDB answers "the index this sort needs is not
  // in place" (isMissingUsableIndex — 400 `no_usable_index` / `invalid_index`,
  // src/data/couchdb.ts), fall back to a bounded scan of the matching documents
  // sorted here. That is slower but returns the SAME ordering and the same page
  // boundaries, so a stack whose runtime credential cannot create the index
  // still gets whole-list paging rather than the 50-oldest window of #1350. Any
  // OTHER failure (a 401/403 from the credential, a 409, a 5xx, a transport
  // error) propagates: the query got no answer, and answering with a silently
  // degraded page instead would hide a broken deployment behind a 200.
  private async findPageNewestFirst(
    couch: StackCouch,
    selector: Record<string, unknown>,
    limit: number,
    skip: number
  ): Promise<StoredDoc[]> {
    await this.declareIndexBestEffort(couch);
    try {
      return await couch.find(selector, {
        limit,
        skip,
        sort: LIST_SORT,
        useIndex: [
          PIPELINE_EXECUTIONS_LIST_INDEX.ddoc,
          PIPELINE_EXECUTIONS_LIST_INDEX.name
        ]
      });
    } catch (err) {
      if (!isMissingUsableIndex(err)) {
        throw err;
      }
      this.log?.warn(
        { err, ddoc: PIPELINE_EXECUTIONS_LIST_INDEX.ddoc },
        'pipeline execution listing has no usable sort index: serving this page ' +
          'from a bounded scan instead (correct order, slower) — create the ' +
          `${PIPELINE_EXECUTIONS_LIST_INDEX.ddoc} index on this database`
      );
      return this.scanPageNewestFirst(couch, selector, limit, skip);
    }
  }

  // Declare the covering index, best effort. Never fails a read: a database
  // whose runtime credential may not write design documents simply stays on the
  // degraded path above. `StackCouch.ensureIndex` memoises both the success and
  // (for a cooldown) the failure, so this costs at most one `POST _index` per
  // process per cooldown rather than one per listing.
  private async declareIndexBestEffort(couch: StackCouch): Promise<void> {
    try {
      await couch.ensureIndex(PIPELINE_EXECUTIONS_LIST_INDEX);
    } catch {
      // Swallowed on purpose: the sorted query below either works anyway (the
      // index already exists) or reports no usable index, which the caller
      // handles by scanning.
    }
  }

  // Degraded page: read the matching documents in bounded pages, order them
  // here with the SAME comparator the sorted query uses, then cut the requested
  // slice. Capped at LIST_SCAN_CAP documents so one listing can never become an
  // unbounded read; past the cap the tail of the list is not reachable, which
  // is the same horizon `couch.count` reports.
  private async scanPageNewestFirst(
    couch: StackCouch,
    selector: Record<string, unknown>,
    limit: number,
    skip: number
  ): Promise<StoredDoc[]> {
    const docs: StoredDoc[] = [];
    while (docs.length < LIST_SCAN_CAP) {
      const batch = await couch.find(selector, {
        limit: Math.min(LIST_SCAN_PAGE_SIZE, LIST_SCAN_CAP - docs.length),
        skip: docs.length
      });
      docs.push(...batch);
      if (batch.length < LIST_SCAN_PAGE_SIZE) {
        break;
      }
    }
    docs.sort(docByCreatedAtDesc);
    return docs.slice(skip, skip + limit);
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
    // Per-execution DRM request (#1259). Request intent only — no key material
    // and no key identifiers ever reach this document (ADR-008 D4).
    ...(execution.drm !== undefined ? { drm: cloneDrmRequest(execution.drm) } : {}),
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt
  };
}

function fromDoc(doc: StoredDoc): PipelineExecution {
  const rawSteps = Array.isArray(doc['steps']) ? (doc['steps'] as unknown[]) : [];
  const steps: StepExecution[] = rawSteps.map((s) => {
    const step = s as Record<string, unknown>;
    const errorDetail = toStepErrorDetail(step['errorDetail']);
    return {
      name: step['name'] as PipelineStepName,
      status: step['status'] as StepExecution['status'],
      jobId: step['jobId'] as string | undefined,
      encoreJobId: step['encoreJobId'] as string | undefined,
      error: step['error'] as string | undefined,
      // Structured failure detail (#1060). `toDoc` persists whole step objects,
      // so the write side already round-trips it; this read side has to name it
      // explicitly because the mapper rebuilds steps field by field. Validated
      // against the response contract on the way out, so a malformed document
      // degrades to "no detail" instead of 500ing the GET that reads it.
      ...(errorDetail !== undefined ? { errorDetail } : {}),
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
    // Per-execution DRM request (#1259). Hydrated only with `DRM_ENABLED` on
    // (ADR-008 D9), so a block left by an earlier flag-on run is not read back
    // while the feature is off, and only when the stored value actually matches
    // the contract — the `isResolvedLocation` guard precedent, so a malformed
    // document degrades to "no request" instead of a partially-typed execution.
    ...(drmEnabled() && isDrmRequest(doc['drm']) ? { drm: cloneDrmRequest(doc['drm']) } : {}),
    createdAt: String(doc['createdAt'] ?? ''),
    updatedAt: String(doc['updatedAt'] ?? '')
  };
}

// Narrow a stored value to the per-execution DRM request shape (#1259):
// `requested: true` plus optional, ENUM-CHECKED coordinates. Mirrors
// `isResolvedLocation` below. An out-of-enum `scheme`/`systems` entry fails the
// guard rather than being cast through, so no invented vocabulary can reach a
// typed PipelineExecution.
function isDrmRequest(value: unknown): value is NonNullable<PipelineExecution['drm']> {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  if (v['requested'] !== true) {
    return false;
  }
  if (v['providerId'] !== undefined && typeof v['providerId'] !== 'string') {
    return false;
  }
  if (
    v['scheme'] !== undefined &&
    !PROTECTION_SCHEMES.includes(v['scheme'] as (typeof PROTECTION_SCHEMES)[number])
  ) {
    return false;
  }
  if (v['systems'] !== undefined) {
    if (!Array.isArray(v['systems'])) {
      return false;
    }
    // Each entry must be a common-encryption system id (the CPIX
    // `DRMSystem@systemId` UUID — `isDrmSystemId`, src/types/drm.ts), not a
    // product name: CLAUDE.md rule 1 / ADR-008 §5.3.
    if (!v['systems'].every((s) => isDrmSystemId(s))) {
      return false;
    }
  }
  return true;
}

function stripPartition(id: string): string {
  const idx = id.indexOf(':');
  return idx >= 0 ? id.slice(idx + 1) : id;
}

// Narrow a stored `steps[].errorDetail` value to a StepErrorDetail (#1060), or
// give back undefined so the step hydrates with NO detail.
//
// Why validate here rather than just checking "is it an object": this mapper
// feeds GET /api/v1/pipelines[/:executionId] and the three asset execution
// routes, all of which serialize the step through `stepExecutionSchema`, whose
// `errorDetail` member IS `stepErrorDetailSchema`
// (src/pipeline/step-error-detail.ts:106-151, embedded at
// src/routes/pipelines.ts and src/routes/assets.ts). That schema requires
// `code` to be one of STEP_ERROR_CODES and `message` to be a string, and — if
// `source` is present at all — requires `source.url` to be a string. A stored
// document whose `errorDetail` were `{}`, a string, or `{ source: {} }` would
// pass an "is it an object" check, hydrate, and then fail serialization,
// turning a read of one bad document into a 500. Parsing with the response
// schema itself means the only values that reach a StepExecution are values the
// response can actually carry; anything else degrades to "no detail", which is
// exactly the pre-#1060 behaviour.
//
// Parsing (rather than casting) is also what makes this type-safe without an
// assertion: `stepErrorDetailSchema` and `StepErrorDetail` are asserted
// mutually assignable at src/pipeline/step-error-detail.ts:155-161, so the
// parsed output needs no cast. zod strips unknown keys, so the hydrated detail
// is a fresh object containing only contract fields.
function toStepErrorDetail(value: unknown): StepExecution['errorDetail'] {
  const parsed = stepErrorDetailSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
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
