// GET /api/v1/pipelines/ pagination order, reach and total (issue #1350).
//
// Regression for: once a stack held more than 50 pipeline executions, the
// listing stopped showing new ones. `CouchPipelineRepository.listAll` called
// `couch.find({ resourceType })` with no limit, so `StackCouch.find` applied
// its own default of 50 and passed no `sort` — CouchDB answered with the first
// 50 documents in id order, and execution ids are ULIDs, so that is the 50
// OLDEST. The status filter, the sort, `total` and the offset/limit slice then
// all ran over those 50 documents alone: an execution created after the 50th
// was unreachable, `total` was stuck at `min(count, 50)`, and paging walked a
// fixed window. The same starvation hit the stalled-package reconciler, which
// asks for `status: 'running'`.
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - `CouchPipelineRepository(couchFor: () => StackCouch, log?)` with
//     `.listAll({ status?, limit?, offset? }) => Promise<{ items, total }>` and
//     `PIPELINE_EXECUTIONS_LIST_INDEX` — src/data/couch-pipeline-repo.ts.
//     The interface it implements is `PipelineRepository.listAll`
//     (src/data/pipeline-repo.ts:159-163); the in-memory sibling's whole-list
//     semantics are at src/data/pipeline-repo.ts:243-258.
//   - `StackCouch.find(selector, { limit, skip, sort, useIndex })`,
//     `StackCouch.count(selector)`, `StackCouch.ensureIndex(def)`,
//     `resetEnsuredIndexesForTest()`, `COUNT_CAP`, and the types `MangoSort`,
//     `MangoIndexDef`, `StoredDoc` — src/data/couchdb.ts.
//   - nano Mango contracts the fake mirrors: `sort?: SortOrder[]` with
//     `SortOrder = ... | { [key: string]: 'asc' | 'desc' }` (nano.d.ts:1694/1709),
//     `use_index?: string | [string, string]` (nano.d.ts:1721),
//     `createIndex({ index: { fields }, ddoc, name, type })` (nano.d.ts:1798).
//   - The exact `total` primitive copied from the asset repository:
//     `couch.count(selector)` alongside `couch.find`
//     (src/data/couch-asset-repo.ts:312-325).
//   - The route contract this serves: `status` one of running|done|failed,
//     `limit` 1..200 default 50, `offset` >= 0 default 0
//     (src/routes/pipelines.ts:120-133).
//   - Documents: `resourceType: 'pipeline_execution'`, flat `_id`, published id
//     on `localId` — src/data/couch-pipeline-repo.ts toDoc/fromDoc.

import { describe, it, expect, beforeEach } from 'vitest';

import {
  CouchPipelineRepository,
  PIPELINE_EXECUTIONS_LIST_INDEX
} from './couch-pipeline-repo.js';
import {
  resetEnsuredIndexesForTest,
  type MangoIndexDef,
  type MangoSort,
  type StoredDoc,
  type StackCouch
} from './couchdb.js';

type FindOpts = {
  limit?: number;
  skip?: number;
  sort?: MangoSort;
  useIndex?: string | [string, string];
};

function noUsableIndex(): Error {
  const err = new Error(
    'No index exists for this sort, try indexing by the sort fields.'
  ) as Error & { statusCode: number; error: string };
  err.statusCode = 400;
  err.error = 'no_usable_index';
  return err;
}

// A StackCouch fake that models the parts of CouchDB this listing depends on:
//
//   - `find` DEFAULTS to limit 50 when the caller passes none — the default in
//     src/data/couchdb.ts that produced the bug;
//   - an UNSORTED `find` returns documents in the database's own key order
//     (ascending document id), which for ULID ids is oldest first;
//   - a SORTED `find` is refused with 400 `no_usable_index` unless an index
//     covering the sort fields, in the same order, has been declared;
//   - a sorted `find` applies sort BEFORE skip/limit, with equal keys ordered
//     by document id;
//   - `count` counts every matching document, not the page.
function makeCouch(docs: StoredDoc[]): {
  couch: StackCouch;
  indexes: () => MangoIndexDef[];
  sortedFinds: () => number;
  unsortedFinds: () => number;
} {
  const store = new Map<string, StoredDoc>(docs.map((d) => [d._id, { ...d }]));
  const declared: MangoIndexDef[] = [];
  let sortedFinds = 0;
  let unsortedFinds = 0;

  const matches = (doc: StoredDoc, selector: Record<string, unknown>): boolean =>
    Object.entries(selector).every(([field, condition]) => {
      const value = doc[field];
      if (condition !== null && typeof condition === 'object') {
        const ops = condition as Record<string, unknown>;
        // The only operator this listing uses: `createdAt: { $gt: null }`,
        // which CouchDB matches for any present, non-null value.
        if ('$gt' in ops && ops['$gt'] === null) {
          return value !== undefined && value !== null;
        }
        throw new Error(`fake couch: unsupported condition ${JSON.stringify(condition)}`);
      }
      return value === condition;
    });

  const couch = {
    async find(selector: Record<string, unknown>, opts: FindOpts = {}): Promise<StoredDoc[]> {
      const limit = opts.limit ?? 50;
      const skip = opts.skip ?? 0;
      const hits = [...store.values()].filter((d) => matches(d, selector));

      if (!opts.sort || opts.sort.length === 0) {
        unsortedFinds += 1;
        // Database key order: ascending document id.
        hits.sort((a, b) => a._id.localeCompare(b._id));
        return hits.slice(skip, skip + limit).map((d) => ({ ...d }));
      }

      sortedFinds += 1;
      const sortFields = opts.sort.map((term) => Object.keys(term)[0]!);
      const covered = declared.some((idx) =>
        sortFields.every((field, i) => idx.fields[i] === field)
      );
      if (!covered) {
        throw noUsableIndex();
      }
      const directions = new Set(opts.sort.map((term) => Object.values(term)[0]!));
      if (directions.size > 1) {
        throw new Error('fake couch: CouchDB requires one direction for all sort fields');
      }
      const descending = directions.has('desc');
      hits.sort((a, b) => {
        for (const field of sortFields) {
          const cmp = String(a[field] ?? '').localeCompare(String(b[field] ?? ''));
          if (cmp !== 0) return descending ? -cmp : cmp;
        }
        // Equal index keys: ordered by document id, in the sort's direction.
        const byId = a._id.localeCompare(b._id);
        return descending ? -byId : byId;
      });
      return hits.slice(skip, skip + limit).map((d) => ({ ...d }));
    },
    async count(selector: Record<string, unknown>): Promise<number> {
      return [...store.values()].filter((d) => matches(d, selector)).length;
    },
    async ensureIndex(def: MangoIndexDef): Promise<void> {
      if (!declared.some((d) => d.ddoc === def.ddoc && d.name === def.name)) {
        declared.push({ ...def });
      }
    }
  } as unknown as StackCouch;

  return {
    couch,
    indexes: () => declared.map((d) => ({ ...d })),
    sortedFinds: () => sortedFinds,
    unsortedFinds: () => unsortedFinds
  };
}

// A StackCouch fake that NEVER accepts a sorted query and cannot declare an
// index — a stack whose runtime credential may not write design documents.
// Everything else behaves as above.
function makeCouchWithoutIndexSupport(docs: StoredDoc[]): StackCouch {
  const base = makeCouch(docs);
  return {
    find: (selector: Record<string, unknown>, opts: FindOpts = {}) => {
      if (opts.sort && opts.sort.length > 0) {
        return Promise.reject(noUsableIndex());
      }
      return (base.couch as unknown as { find: (s: unknown, o: unknown) => Promise<StoredDoc[]> })
        .find(selector, opts);
    },
    count: (selector: Record<string, unknown>) =>
      (base.couch as unknown as { count: (s: unknown) => Promise<number> }).count(selector),
    ensureIndex: () => Promise.reject(new Error('forbidden: cannot write design documents'))
  } as unknown as StackCouch;
}

// 137 executions, more than the 50-document default that caused the bug.
//
// `createdAt` ASCENDS with the index `i` (one minute apart), while the document
// id is a ULID-shaped string whose order is deliberately SHUFFLED with respect
// to it: ids are assigned from a fixed permutation, so neither "database key
// order" nor "insertion order" is createdAt order, and an implementation that
// lets the database cut the page and sorts afterwards returns the wrong
// executions, not merely a mis-ordered page.
const TOTAL = 137;

function shuffledIndex(i: number): number {
  // A fixed, dependency-free permutation of 0..TOTAL-1 (TOTAL is prime-ish
  // enough that stepping by a co-prime stride visits every slot exactly once).
  return (i * 61) % TOTAL;
}

function execDoc(i: number, status: 'running' | 'done' | 'failed'): StoredDoc {
  // Ids sort lexically (fixed width), as ULIDs do, but carry the SHUFFLED
  // position so id order and createdAt order disagree.
  const id = `01HSHUFFLE${String(shuffledIndex(i)).padStart(4, '0')}`;
  const minute = String(i).padStart(4, '0');
  return {
    _id: id,
    _rev: `1-${id}`,
    resourceType: 'pipeline_execution',
    localId: id,
    assetId: `asset-${i}`,
    pipelineName: 'full',
    status,
    steps: [{ name: 'transcode', status: status === 'running' ? 'running' : 'done' }],
    createdAt: `2026-11-01T00:00:00.${minute}Z`,
    updatedAt: `2026-11-01T00:00:00.${minute}Z`
  };
}

// Newest first: the execution with the LARGEST index comes first.
function expectedOrderNewestFirst(docs: StoredDoc[]): string[] {
  return [...docs]
    .sort(
      (a, b) =>
        String(b['createdAt']).localeCompare(String(a['createdAt'])) ||
        String(b._id).localeCompare(String(a._id))
    )
    .map((d) => String(d['localId']));
}

describe('CouchPipelineRepository.listAll pages the whole execution list (#1350)', () => {
  beforeEach(() => {
    // The ensured-index memo lives on the module, so a cold process per test.
    resetEnsuredIndexesForTest();
  });

  const allDone = (): StoredDoc[] =>
    Array.from({ length: TOTAL }, (_, i) => execDoc(i, 'done'));

  it('returns the NEWEST executions on page 1, not the 50 oldest', async () => {
    const docs = allDone();
    const { couch } = makeCouch(docs);
    const repo = new CouchPipelineRepository(() => couch);

    const page1 = await repo.listAll({ limit: 50, offset: 0 });
    const expected = expectedOrderNewestFirst(docs);

    expect(page1.items.map((e) => e.id)).toEqual(expected.slice(0, 50));
    // The newest execution — the one the old code could never reach once the
    // stack held more than 50 — is the first item.
    expect(page1.items[0]?.createdAt).toBe(docs[TOTAL - 1]!['createdAt']);
  });

  it('reports an exact total, not a window stuck at 50', async () => {
    const { couch } = makeCouch(allDone());
    const repo = new CouchPipelineRepository(() => couch);

    expect((await repo.listAll({ limit: 50, offset: 0 })).total).toBe(TOTAL);
    // `total` describes the whole list, so it does not move with the page.
    expect((await repo.listAll({ limit: 10, offset: 120 })).total).toBe(TOTAL);
    expect((await repo.listAll({ limit: 200, offset: 0 })).total).toBe(TOTAL);
  });

  it('cuts non-overlapping pages whose union is every execution', async () => {
    const docs = allDone();
    const { couch } = makeCouch(docs);
    const repo = new CouchPipelineRepository(() => couch);

    const pageSize = 50;
    const seen: string[] = [];
    for (let offset = 0; offset < TOTAL; offset += pageSize) {
      const page = await repo.listAll({ limit: pageSize, offset });
      seen.push(...page.items.map((e) => e.id));
    }

    // Pages do not overlap...
    expect(new Set(seen).size).toBe(seen.length);
    // ...they cover every execution...
    expect(seen.length).toBe(TOTAL);
    // ...and they are slices of ONE newest-first order.
    expect(seen).toEqual(expectedOrderNewestFirst(docs));
  });

  it('reaches an execution past the 50th page position', async () => {
    const docs = allDone();
    const { couch } = makeCouch(docs);
    const repo = new CouchPipelineRepository(() => couch);

    const expected = expectedOrderNewestFirst(docs);
    const tail = await repo.listAll({ limit: 7, offset: 130 });
    expect(tail.items.map((e) => e.id)).toEqual(expected.slice(130, 137));
    expect(tail.total).toBe(TOTAL);
  });

  it('finds a running execution older than 50 newer finished ones', async () => {
    // One running execution at the OLDEST position, 136 newer finished ones on
    // top of it: the old code's 50-document window was taken before the status
    // filter, so this execution was invisible to `listAll({ status: 'running' })`
    // — and therefore to the stalled-package reconciler.
    const docs = Array.from({ length: TOTAL }, (_, i) =>
      execDoc(i, i === 0 ? 'running' : 'done')
    );
    const runningId = String(docs[0]!['localId']);
    const { couch } = makeCouch(docs);
    const repo = new CouchPipelineRepository(() => couch);

    const running = await repo.listAll({ status: 'running', limit: 50, offset: 0 });
    expect(running.total).toBe(1);
    expect(running.items.map((e) => e.id)).toEqual([runningId]);
    expect(running.items[0]?.status).toBe('running');
  });

  it('filters by status over the whole list, newest first', async () => {
    // Every third execution failed; the failures are spread across the list, so
    // a window over the 50 oldest documents would miss most of them.
    const docs = Array.from({ length: TOTAL }, (_, i) =>
      execDoc(i, i % 3 === 0 ? 'failed' : 'done')
    );
    const failedDocs = docs.filter((d) => d['status'] === 'failed');
    const { couch } = makeCouch(docs);
    const repo = new CouchPipelineRepository(() => couch);

    const page = await repo.listAll({ status: 'failed', limit: 200, offset: 0 });
    expect(page.total).toBe(failedDocs.length);
    expect(page.items.map((e) => e.id)).toEqual(expectedOrderNewestFirst(failedDocs));
    expect(page.items.every((e) => e.status === 'failed')).toBe(true);
  });

  it('declares the [resourceType, createdAt] index and asks the database to sort', async () => {
    const { couch, indexes, sortedFinds, unsortedFinds } = makeCouch(allDone());
    const repo = new CouchPipelineRepository(() => couch);

    await repo.listAll({ limit: 50, offset: 0 });

    expect(indexes()).toContainEqual(PIPELINE_EXECUTIONS_LIST_INDEX);
    expect(PIPELINE_EXECUTIONS_LIST_INDEX.fields).toEqual(['resourceType', 'createdAt']);
    // The ordering is the database's work, not a post-hoc sort of a default page.
    expect(sortedFinds()).toBe(1);
    expect(unsortedFinds()).toBe(0);
  });

  it('still pages the whole list when the database refuses the sort', async () => {
    // A stack whose runtime credential cannot create the index: the listing
    // degrades to a bounded scan, which must return the SAME pages rather than
    // falling back to the 50-oldest window.
    const docs = allDone();
    const couch = makeCouchWithoutIndexSupport(docs);
    const warnings: unknown[] = [];
    const repo = new CouchPipelineRepository(() => couch, {
      warn: (obj) => warnings.push(obj)
    });

    const expected = expectedOrderNewestFirst(docs);
    const page1 = await repo.listAll({ limit: 50, offset: 0 });
    const page3 = await repo.listAll({ limit: 50, offset: 100 });

    expect(page1.items.map((e) => e.id)).toEqual(expected.slice(0, 50));
    expect(page3.items.map((e) => e.id)).toEqual(expected.slice(100, TOTAL));
    expect(page1.total).toBe(TOTAL);
    // The degradation is reported rather than silent.
    expect(warnings.length).toBeGreaterThan(0);
  });

  it('propagates a non-index failure instead of serving a degraded page', async () => {
    // A credential or transport failure means the query got NO answer; serving
    // a scan-built page behind a 200 would hide a broken deployment.
    const unauthorized = Object.assign(new Error('unauthorized'), {
      statusCode: 401,
      error: 'unauthorized'
    });
    const couch = {
      find: () => Promise.reject(unauthorized),
      count: () => Promise.resolve(0),
      ensureIndex: () => Promise.resolve()
    } as unknown as StackCouch;
    const repo = new CouchPipelineRepository(() => couch);

    await expect(repo.listAll({ limit: 50, offset: 0 })).rejects.toThrow('unauthorized');
  });

  it('defaults to the first 50 newest executions when no page is given', async () => {
    const docs = allDone();
    const { couch } = makeCouch(docs);
    const repo = new CouchPipelineRepository(() => couch);

    const page = await repo.listAll();
    expect(page.items).toHaveLength(50);
    expect(page.items.map((e) => e.id)).toEqual(expectedOrderNewestFirst(docs).slice(0, 50));
    expect(page.total).toBe(TOTAL);
  });
});
