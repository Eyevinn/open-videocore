// Which path answers GET /api/v1/jobs, and what it does with a failure
// (PR #1346 review findings 1 and 2).
//
// Regression for: `CouchJobRepository.findPageNewestFirst` wrapped the index
// declaration AND the sorted query in one bare `catch {}`. A 401/403 on
// `_index`, a transient `_find` 5xx and a genuine `no_usable_index` all landed
// in the same branch, so a broken deployment answered every listing with an
// unprojected scan and HTTP 200 — and nothing logged or counted which path had
// served, so a stack that NEVER served the sorted query looked exactly like one
// that always did.
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - `CouchJobRepository(couchFor: () => StackCouch, { log })` and
//     `.list({ limit, offset }) => Promise<{ items, total }>`
//     (src/data/couch-job-repo.ts; JobRepository.list in src/data/job-repo.ts).
//   - `StackCouch.find(selector, { limit, skip, sort, useIndex })`,
//     `StackCouch.ensureIndex({ ddoc, name, fields })`, `StackCouch.count`,
//     `isMissingUsableIndex`, `COUNT_CAP` (src/data/couchdb.ts).
//   - The recoverable-error contract: apache/couchdb
//     `src/mango/src/mango_error.erl` (fetched 2026-11-10) maps
//     `{no_usable_index, missing_sort_index}` to HTTP 400 / error
//     `no_usable_index` / "No index exists for this sort, try indexing by the
//     sort fields." (lines 21-44) and `{invalid_index, [DDoc(, View)]}` to
//     HTTP 400 / error `invalid_index` / "_design/<ddoc> specified by
//     `use_index` could not be found or it is not suitable." (lines 51-72).
//   - nano `createIndex({ index: { fields }, ddoc, name, type })` ->
//     `{ result: 'created' | 'exists' }`, and `ServerScope.use(db)`
//     (node_modules/nano/lib/nano.d.ts CreateIndexRequest / CreateIndexResponse
//     / ServerScope).
//   - Route contract unchanged: `limit` 1..100 default 50, `offset` >= 0
//     default 0, 200 `{ items, total: z.number() }` (src/routes/jobs.ts:193-197).

import { describe, it, expect, beforeEach } from 'vitest';
import type { ServerScope } from 'nano';

import {
  CouchJobRepository,
  JOBS_LIST_INDEX,
  jobListReadPathStats,
  resetJobListReadPathStatsForTest,
  type JobListLog
} from './couch-job-repo.js';
import {
  isMissingUsableIndex,
  resetEnsuredIndexesForTest,
  StackCouch,
  COUNT_CAP,
  type MangoIndexDef,
  type MangoSort,
  type StoredDoc
} from './couchdb.js';

type FindOpts = {
  limit?: number;
  skip?: number;
  sort?: MangoSort;
  useIndex?: string | [string, string];
};

function couchError(statusCode: number, error: string, reason?: string): Error {
  const err = new Error(reason ?? error) as Error & {
    statusCode: number;
    error: string;
    reason?: string;
  };
  err.statusCode = statusCode;
  err.error = error;
  if (reason !== undefined) err.reason = reason;
  return err;
}

const NO_USABLE_INDEX = () =>
  couchError(
    400,
    'no_usable_index',
    'No index exists for this sort, try indexing by the sort fields.'
  );

const INVALID_INDEX = () =>
  couchError(
    400,
    'invalid_index',
    '_design/jobs-by-created-at, jobs-by-created-at specified by `use_index` could not be found or it is not suitable.'
  );

// 3 jobs whose document-id order is the reverse of their createdAt order, so a
// page that was NOT ordered by the query is immediately visible.
const DOCS: StoredDoc[] = [
  { _id: 'job-a', resourceType: 'job', localId: 'job-a', createdAt: '2026-10-01T00:00:00.000Z' },
  { _id: 'job-b', resourceType: 'job', localId: 'job-b', createdAt: '2026-10-03T00:00:00.000Z' },
  { _id: 'job-c', resourceType: 'job', localId: 'job-c', createdAt: '2026-10-02T00:00:00.000Z' }
];

// A couch double whose SORTED find can be told to fail with a specific error.
// The UNSORTED find (the degraded scan) always works and returns documents in
// database key order — ascending document id — which is not createdAt order.
function makeCouch(sortedFailure?: () => Error) {
  const calls = { sorted: 0, unsorted: 0, ensureIndex: 0 };
  const declared: MangoIndexDef[] = [];
  const couch = {
    async find(_selector: Record<string, unknown>, opts: FindOpts = {}): Promise<StoredDoc[]> {
      if (opts.sort && opts.sort.length > 0) {
        calls.sorted += 1;
        if (sortedFailure) throw sortedFailure();
        const hits = [...DOCS].sort(
          (a, b) => String(b['createdAt']).localeCompare(String(a['createdAt']))
        );
        return hits.slice(opts.skip ?? 0, (opts.skip ?? 0) + (opts.limit ?? 50));
      }
      calls.unsorted += 1;
      expect(opts.limit).toBe(COUNT_CAP);
      return [...DOCS].sort((a, b) => a._id.localeCompare(b._id));
    },
    async count(): Promise<number> {
      return DOCS.length;
    },
    async ensureIndex(def: MangoIndexDef): Promise<void> {
      calls.ensureIndex += 1;
      declared.push({ ...def });
    }
  } as unknown as StackCouch;
  return { couch, calls, declared };
}

function makeLog(): { log: JobListLog; warns: unknown[][]; infos: unknown[][] } {
  const warns: unknown[][] = [];
  const infos: unknown[][] = [];
  return {
    log: {
      warn: (obj: unknown, msg?: string) => warns.push([obj, msg]),
      info: (obj: unknown, msg?: string) => infos.push([obj, msg])
    },
    warns,
    infos
  };
}

describe('GET /api/v1/jobs read path: recoverable vs real failures (#1346)', () => {
  beforeEach(() => {
    resetEnsuredIndexesForTest();
    resetJobListReadPathStatsForTest();
  });

  it('serves the newest-first page from the sorted query and records that path', async () => {
    const { couch, calls } = makeCouch();
    const { log, infos, warns } = makeLog();
    const repo = new CouchJobRepository(() => couch, { log });

    const page = await repo.list({ limit: 2, offset: 0 });

    expect(page.items.map((j) => j.id)).toEqual(['job-b', 'job-c']);
    expect(page.total).toBe(3);
    expect(calls.unsorted).toBe(0);
    const stats = jobListReadPathStats();
    expect(stats.last).toBe('sorted-index');
    expect(stats.sortedIndexTotal).toBe(1);
    expect(stats.degradedScanTotal).toBe(0);
    // The served path is announced once, not warned about, and nothing degraded.
    expect(infos).toHaveLength(1);
    expect(warns).toEqual([]);
  });

  it('falls back to the bounded scan ONLY on no_usable_index, and says so', async () => {
    const { couch, calls } = makeCouch(NO_USABLE_INDEX);
    const { log, warns } = makeLog();
    const repo = new CouchJobRepository(() => couch, { log });

    const page = await repo.list({ limit: 2, offset: 0 });

    // Same order and the same page boundaries as the sorted query would give.
    expect(page.items.map((j) => j.id)).toEqual(['job-b', 'job-c']);
    expect(page.total).toBe(3);
    expect(calls.sorted).toBe(1);
    expect(calls.unsorted).toBe(1);

    const stats = jobListReadPathStats();
    expect(stats.last).toBe('degraded-scan');
    expect(stats.degradedScanTotal).toBe(1);
    expect(stats.sortedIndexTotal).toBe(0);
    // Observable: one warning naming the cause, carrying the counters.
    expect(warns).toHaveLength(1);
    expect(warns[0]![1]).toContain('bounded scan');
    expect(warns[0]![0]).toMatchObject({ degradedScanTotal: 1, scanCap: COUNT_CAP });
  });

  it('also treats invalid_index (use_index absent/unsuitable) as recoverable', async () => {
    const { couch, calls } = makeCouch(INVALID_INDEX);
    const repo = new CouchJobRepository(() => couch);

    const page = await repo.list({ limit: 3, offset: 0 });

    expect(page.items.map((j) => j.id)).toEqual(['job-b', 'job-c', 'job-a']);
    expect(calls.unsorted).toBe(1);
    expect(jobListReadPathStats().degradedScanTotal).toBe(1);
  });

  it.each([
    ['401 unauthorized', () => couchError(401, 'unauthorized', 'Name or password is incorrect.')],
    ['403 forbidden', () => couchError(403, 'forbidden', 'You are not a server admin.')],
    ['409 conflict', () => couchError(409, 'conflict', 'Document update conflict.')],
    ['500 server error', () => couchError(500, 'internal_server_error', 'badarg')],
    ['transport failure', () => new Error('socket hang up')]
  ])('propagates a %s from the sorted query instead of degrading silently', async (_name, failure) => {
    const { couch, calls } = makeCouch(failure as () => Error);
    const repo = new CouchJobRepository(() => couch);

    await expect(repo.list({ limit: 2, offset: 0 })).rejects.toThrow();

    // No scan was issued and no path was counted as having served the request.
    expect(calls.unsorted).toBe(0);
    expect(jobListReadPathStats()).toMatchObject({
      last: 'none',
      sortedIndexTotal: 0,
      degradedScanTotal: 0
    });
  });

  it('never fails a read because the index declaration failed, and counts it', async () => {
    const { couch, calls } = makeCouch();
    const refusing = {
      ...couch,
      find: couch.find.bind(couch),
      count: couch.count.bind(couch),
      ensureIndex: async () => {
        throw couchError(403, 'forbidden', 'You are not a db or server admin.');
      }
    } as unknown as StackCouch;
    const { log, warns } = makeLog();
    const repo = new CouchJobRepository(() => refusing, { log });

    // The index already exists here (created at provision time), so the sorted
    // query still serves the page even though this process may not write ddocs.
    const page = await repo.list({ limit: 3, offset: 0 });

    expect(page.items.map((j) => j.id)).toEqual(['job-b', 'job-c', 'job-a']);
    expect(calls.unsorted).toBe(0);
    const stats = jobListReadPathStats();
    expect(stats.sortedIndexTotal).toBe(1);
    expect(stats.indexDeclarationFailureTotal).toBe(1);
    expect(warns).toHaveLength(1);
    expect(warns[0]![1]).toContain('provision');
  });

  it('attempts POST _index at most once per process, not once per listing', async () => {
    let createIndexCalls = 0;
    const server = {
      use: () => ({
        async createIndex() {
          createIndexCalls += 1;
          throw couchError(403, 'forbidden', 'You are not a db or server admin.');
        },
        async find() {
          return { docs: [] as StoredDoc[] };
        }
      })
    } as unknown as ServerScope;
    const couch = new StackCouch(server, 'assets');

    for (let i = 0; i < 3; i += 1) {
      await expect(couch.ensureIndex(JOBS_LIST_INDEX)).rejects.toThrow();
    }

    // Three callers, one write attempt: the failure is memoised for a cooldown,
    // so a database this credential cannot write design documents to does not
    // get a `_index` write per request.
    expect(createIndexCalls).toBe(1);
  });
});

describe('isMissingUsableIndex (#1346)', () => {
  it('accepts exactly the two documented "index not in place" errors', () => {
    expect(isMissingUsableIndex(NO_USABLE_INDEX())).toBe(true);
    expect(isMissingUsableIndex(INVALID_INDEX())).toBe(true);
    // Reason-only shape (no error identifier filled in).
    expect(
      isMissingUsableIndex({
        statusCode: 400,
        reason: 'No index exists for this sort, try indexing by the sort fields.'
      })
    ).toBe(true);
  });

  it('rejects everything that means the query got no answer', () => {
    expect(isMissingUsableIndex(couchError(401, 'unauthorized'))).toBe(false);
    expect(isMissingUsableIndex(couchError(403, 'forbidden'))).toBe(false);
    expect(isMissingUsableIndex(couchError(409, 'conflict'))).toBe(false);
    expect(isMissingUsableIndex(couchError(500, 'internal_server_error'))).toBe(false);
    expect(isMissingUsableIndex(couchError(400, 'invalid_bookmark'))).toBe(false);
    // Same identifier but a server-error status: not the documented benign case.
    expect(isMissingUsableIndex(couchError(500, 'no_usable_index'))).toBe(false);
    expect(isMissingUsableIndex(new Error('socket hang up'))).toBe(false);
    expect(isMissingUsableIndex(undefined)).toBe(false);
    expect(isMissingUsableIndex(null)).toBe(false);
  });
});

describe('one index definition for the creator and the reader (#1346)', () => {
  it('exposes the covering index the provisioner creates up front', () => {
    expect(JOBS_LIST_INDEX).toEqual({
      ddoc: 'jobs-by-created-at',
      name: 'jobs-by-created-at',
      // Index order matters: a sort may only use a prefix of it, in order, so
      // `resourceType` must lead `createdAt`.
      fields: ['resourceType', 'createdAt']
    });
  });
});
