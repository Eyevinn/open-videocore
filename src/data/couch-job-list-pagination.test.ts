// GET /api/v1/jobs pagination order and total (issue #1337).
//
// Regression for: the listing's pages were not slices of ONE newest-first list.
// `CouchJobRepository.list` asked CouchDB for `{ limit, skip }` with no `sort`,
// so the database cut pages out of its own index order — document id order, and
// job ids are `job-<random>` — and only then sorted the returned page in
// memory. A later page could therefore start again with jobs newer than the end
// of the previous page, and a job could show up on two pages or on none.
// `total` was `skip + items.length + (items.length === limit ? 1 : 0)`, a lower
// bound that reads one more than a full page rather than a count.
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - CouchJobRepository(couchFor: () => StackCouch).list({ limit, offset })
//     => Promise<{ items: Job[]; total: number }> (src/data/couch-job-repo.ts
//     list; JobRepository.list in src/data/job-repo.ts).
//   - StackCouch.find(selector, { limit, skip, sort, useIndex }) and
//     StackCouch.ensureIndex({ ddoc, name, fields }), StackCouch.count(selector)
//     (src/data/couchdb.ts).
//   - nano Mango contracts the fake mirrors: `sort?: SortOrder[]` with
//     `SortOrder = ... | { [key: string]: 'asc' | 'desc' }` (nano.d.ts:1694/1709),
//     `use_index?: string | [string, string]` (nano.d.ts:1721),
//     `createIndex({ index: { fields }, ddoc, name, type })` (nano.d.ts:1798)
//     answering `{ result: 'created' | 'exists' }` (nano.d.ts:1824).
//   - The exact `total` primitive copied from the asset repository:
//     `couch.count(selector)` alongside `couch.find` (couch-asset-repo.ts:312-325).
//   - The query route contract: `limit` 1..100 default 50, `offset` >= 0
//     default 0, response `{ items, total: z.number() }` (src/routes/jobs.ts).

import { describe, it, expect, beforeEach } from 'vitest';

import { CouchJobRepository } from './couch-job-repo.js';
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
  const err = new Error('No index exists for this sort, try indexing by the sort fields.') as Error & {
    statusCode: number;
    error: string;
  };
  err.statusCode = 400;
  err.error = 'no_usable_index';
  return err;
}

// A StackCouch fake that models the parts of CouchDB this listing depends on:
//
//   - an UNSORTED `find` returns documents in the database's own key order
//     (ascending document id), NOT in createdAt order — which is what made the
//     pages wrong;
//   - a SORTED `find` is refused with 400 `no_usable_index` unless an index
//     covering the sort fields, in the same order, has been declared;
//   - a sorted `find` applies sort BEFORE skip/limit, with equal keys ordered by
//     document id;
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
        // The only operator this listing uses: `createdAt: { $gt: null }`, which
        // CouchDB matches for any present, non-null value.
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
        // Database key order: ascending document id. With `job-<random>` ids
        // this bears no relation to createdAt.
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
        // Equal index keys: ordered by document id.
        return a._id.localeCompare(b._id);
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

// Jobs whose document-id order is deliberately SHUFFLED with respect to their
// createdAt order: id `job-<letter>` ascends while createdAt descends, so any
// implementation that lets the database page by id and sorts afterwards returns
// scrambled pages. 7 jobs over pages of 3 gives a full page, a second full page
// and a partial one.
const CREATED_AT = [
  '2026-10-01T00:00:00.000Z', // job-a (oldest)
  '2026-10-07T00:00:00.000Z', // job-b (newest)
  '2026-10-03T00:00:00.000Z',
  '2026-10-06T00:00:00.000Z',
  '2026-10-02T00:00:00.000Z',
  '2026-10-05T00:00:00.000Z',
  '2026-10-04T00:00:00.000Z'
];

function jobDocs(): StoredDoc[] {
  return CREATED_AT.map((createdAt, i) => {
    const id = `job-${String.fromCharCode('a'.charCodeAt(0) + i)}`;
    return {
      _id: id,
      _rev: '1-seed',
      resourceType: 'job',
      localId: id,
      type: 'transcode',
      status: 'done',
      assetId: 'asset-1',
      sourceUrl: '',
      progress: 100,
      bytesTransferred: 0,
      attempts: 1,
      createdAt,
      updatedAt: createdAt
    } satisfies StoredDoc;
  });
}

// A document that is NOT a job, to confirm the listing's selector and total
// both stay scoped to jobs.
const ASSET_DOC: StoredDoc = {
  _id: 'asset-zzz',
  _rev: '1-seed',
  resourceType: 'asset',
  createdAt: '2026-10-09T00:00:00.000Z'
};

describe('CouchJobRepository.list pagination order and total (#1337)', () => {
  beforeEach(() => {
    // The ensured-index memo is per process; clear it so each test exercises
    // the declaration path.
    resetEnsuredIndexesForTest();
  });

  it('cuts pages from one newest-first order, so page 2 is strictly older than page 1', async () => {
    const { couch } = makeCouch([...jobDocs(), ASSET_DOC]);
    const repo = new CouchJobRepository(() => couch);

    const page1 = await repo.list({ limit: 3, offset: 0 });
    const page2 = await repo.list({ limit: 3, offset: 3 });
    const page3 = await repo.list({ limit: 3, offset: 6 });

    // Each page is newest-first within itself (this already held pre-fix).
    for (const page of [page1, page2, page3]) {
      const createdAts = page.items.map((j) => j.createdAt);
      expect([...createdAts].sort().reverse()).toEqual(createdAts);
    }

    // And — the actual regression — each page is older than the one before it.
    expect(page2.items[0]!.createdAt < page1.items.at(-1)!.createdAt).toBe(true);
    expect(page3.items[0]!.createdAt < page2.items.at(-1)!.createdAt).toBe(true);

    // The whole list, read page by page, is exactly the newest-first order.
    const walked = [...page1.items, ...page2.items, ...page3.items];
    expect(walked.map((j) => j.createdAt)).toEqual([...CREATED_AT].sort().reverse());
    expect(walked.map((j) => j.id)).toEqual([
      'job-b',
      'job-d',
      'job-f',
      'job-g',
      'job-c',
      'job-e',
      'job-a'
    ]);
  });

  it('returns every job exactly once across the pages, and no non-job document', async () => {
    const { couch } = makeCouch([...jobDocs(), ASSET_DOC]);
    const repo = new CouchJobRepository(() => couch);

    const ids: string[] = [];
    for (let offset = 0; offset < 7; offset += 3) {
      const page = await repo.list({ limit: 3, offset });
      ids.push(...page.items.map((j) => j.id));
    }

    expect(ids).toHaveLength(7);
    expect(new Set(ids).size).toBe(7);
    expect([...ids].sort()).toEqual(jobDocs().map((d) => d._id).sort());
    expect(ids).not.toContain('asset-zzz');
  });

  it('reports total as the true job count, not a lower bound, on a full page', async () => {
    const { couch } = makeCouch([...jobDocs(), ASSET_DOC]);
    const repo = new CouchJobRepository(() => couch);

    // A page that is exactly full: pre-fix this reported limit + 1 (4).
    const full = await repo.list({ limit: 3, offset: 0 });
    expect(full.items).toHaveLength(3);
    expect(full.total).toBe(7);

    // Every other page agrees on the same total, including the last partial one
    // and an offset past the end.
    expect((await repo.list({ limit: 3, offset: 3 })).total).toBe(7);
    expect((await repo.list({ limit: 3, offset: 6 })).total).toBe(7);
    const beyond = await repo.list({ limit: 3, offset: 9 });
    expect(beyond.items).toEqual([]);
    expect(beyond.total).toBe(7);

    // And a page big enough for everything (route max limit is 100).
    const whole = await repo.list({ limit: 100, offset: 0 });
    expect(whole.items).toHaveLength(7);
    expect(whole.total).toBe(7);
  });

  it('declares the covering index and orders in the query, not after it', async () => {
    const { couch, indexes, sortedFinds, unsortedFinds } = makeCouch(jobDocs());
    const repo = new CouchJobRepository(() => couch);

    await repo.list({ limit: 3, offset: 3 });

    // The fake refuses a sorted find without a covering index, so reaching here
    // at all proves the index is declared before the query; assert its shape.
    expect(indexes()).toEqual([
      { ddoc: 'jobs-by-created-at', name: 'jobs-by-created-at', fields: ['resourceType', 'createdAt'] }
    ]);
    // The page came from a sorted query; nothing fell back to an unsorted scan.
    expect(sortedFinds()).toBe(1);
    expect(unsortedFinds()).toBe(0);
  });

  it('still returns correctly ordered, correctly counted pages when sorting is refused', async () => {
    // A database this process can read but cannot add a design document to:
    // ensureIndex fails, so the sorted query is refused. The listing must stay
    // newest-first rather than falling back to the unordered pages of the bug.
    const { couch } = makeCouch(jobDocs());
    const refusing = {
      ...couch,
      find: couch.find.bind(couch),
      count: couch.count.bind(couch),
      ensureIndex: async () => {
        throw new Error('forbidden: cannot write design document');
      }
    } as unknown as StackCouch;
    const repo = new CouchJobRepository(() => refusing);

    const page1 = await repo.list({ limit: 3, offset: 0 });
    const page2 = await repo.list({ limit: 3, offset: 3 });

    expect(page1.items.map((j) => j.id)).toEqual(['job-b', 'job-d', 'job-f']);
    expect(page2.items.map((j) => j.id)).toEqual(['job-g', 'job-c', 'job-e']);
    expect(page2.items[0]!.createdAt < page1.items.at(-1)!.createdAt).toBe(true);
    expect(page1.total).toBe(7);
  });
});
