// CouchDB access.
//
// Tenant isolation is structural (ADR-003 / issue #59): OSC provisions a
// dedicated CouchDB instance per deploying tenant, so this database belongs to
// exactly one tenant. There is NO workspace partitioning, NO per-document
// workspaceId stamp, and NO workspaceId predicate on queries. Documents use a
// flat id (the resource's local id).

import nano from 'nano';
import type { DocumentScope, ServerScope } from 'nano';

export type StoredDoc = {
  _id: string;
  _rev?: string;
  resourceType: string;
  [key: string]: unknown;
};

// One Mango sort term per entry, e.g. `[{ resourceType: 'desc' }, { createdAt:
// 'desc' }]`. Mirrors nano's `SortOrder` object form (nano.d.ts:1694
// `type SortOrder = string | string[] | { [key: string]: 'asc' | 'desc' }`),
// narrowed to the object form because CouchDB requires an explicit direction
// per field and the same direction for every field in one sort.
export type MangoSort = Array<Record<string, 'asc' | 'desc'>>;

// A Mango json index this process needs in place before it can ask CouchDB to
// sort. `fields` follows the index's own sort syntax (nano.d.ts:1798
// `interface CreateIndexRequest { index: { fields: SortOrder[] }, ddoc?, name?,
// type? }`); the field ORDER matters, and a query may only sort on a prefix of
// it, in the same order.
export type MangoIndexDef = {
  /** Design document the index lives in. */
  ddoc: string;
  /** Index name inside that design document. */
  name: string;
  /** Indexed fields, in index order. */
  fields: string[];
};

// Per-process memo of indexes already ensured, keyed by database + ddoc + name.
// StackCouch is constructed per call (`wc = () => new StackCouch(server,
// dbName)` — src/services/workspace-stack.ts:280/:507), so the memo cannot live
// on the instance or every request would re-POST `_index`.
const ensuredIndexes = new Set<string>();

// Per-process memo of index declarations that FAILED, keyed the same way, with
// the failure and when it happened.
//
// Why memoise a failure at all (#1346 review finding 1): the index declaration
// can be attempted from a read path, and on a database whose runtime credential
// may not write design documents it fails every time. Without a memo that is a
// fresh `POST _index` on EVERY request, which is a write attempt per read that
// can never succeed. Why memoise it only for a COOLDOWN rather than for the
// process lifetime: the failure may be transient (CouchDB still starting, a
// node briefly unavailable), and a permanently-disabled declaration would leave
// such a deployment on the degraded read path until it is restarted. One
// attempt per cooldown is bounded and still self-healing.
const failedIndexAttempts = new Map<string, { err: unknown; at: number }>();

// How long a failed index declaration suppresses the next attempt.
const INDEX_RETRY_COOLDOWN_MS = 10 * 60_000;

// Test seam: forget the ensured-index memos (successes and failures) so each
// test starts from a cold process. Not used by production code.
export function resetEnsuredIndexesForTest(): void {
  ensuredIndexes.clear();
  failedIndexAttempts.clear();
}

// CouchDB access for a single stack's database. OSC provisions a dedicated
// CouchDB instance per stack, so there is no workspace partitioning: documents
// are stored under their flat local id.
export class StackCouch {
  private readonly db: DocumentScope<StoredDoc>;
  private readonly dbName: string;

  constructor(server: ServerScope, dbName: string) {
    this.db = server.use<StoredDoc>(dbName);
    this.dbName = dbName;
  }

  async put(localId: string, body: Record<string, unknown>): Promise<{ id: string; rev: string }> {
    const doc: StoredDoc = {
      ...body,
      _id: localId,
      resourceType: String(body['resourceType'] ?? 'asset')
    };
    const res = await this.db.insert(doc);
    return { id: res.id, rev: res.rev };
  }

  async get(localId: string): Promise<StoredDoc | undefined> {
    try {
      return await this.db.get(localId);
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
  }

  async list(opts: { limit?: number; skip?: number } = {}): Promise<StoredDoc[]> {
    const result = await this.db.list({
      include_docs: true,
      limit: opts.limit ?? 50,
      skip: opts.skip ?? 0
    });
    const docs: StoredDoc[] = [];
    for (const row of result.rows) {
      const doc = row.doc as StoredDoc | undefined;
      if (doc && !doc._id.startsWith('_design/')) {
        docs.push(doc);
      }
    }
    return docs;
  }

  // Mango query. `sort` and `useIndex` are OPTIONAL additions (issue #1337):
  // every pre-existing caller passes `{ limit, skip }` only and keeps exactly
  // the previous behaviour, where CouchDB applies skip/limit in its own index
  // order. A caller that needs database-side ordering passes `sort` — and must
  // first put a covering index in place with `ensureIndex`, because CouchDB
  // answers a sorted `_find` with 400 `no_usable_index` otherwise.
  async find(
    selector: Record<string, unknown>,
    opts: {
      limit?: number;
      skip?: number;
      sort?: MangoSort;
      useIndex?: string | [string, string];
    } = {}
  ): Promise<StoredDoc[]> {
    const query: nano.MangoQuery = {
      selector: selector as nano.MangoSelector,
      limit: opts.limit ?? 50,
      skip: opts.skip ?? 0
    };
    if (opts.sort && opts.sort.length > 0) {
      // nano.d.ts:1709 `sort?: SortOrder[]`, whose object form is
      // `{ [key: string]: 'asc' | 'desc' }` — what MangoSort already is.
      query.sort = opts.sort;
    }
    if (opts.useIndex) {
      // nano.d.ts:1721 `use_index?: string | [string, string]`.
      query.use_index = opts.useIndex;
    }
    const result = await this.db.find(query);
    return result.docs;
  }

  // Declare a Mango json index, once per process (issue #1337).
  //
  // POST `_index` is idempotent for a given ddoc + name + fields: CouchDB
  // answers `{ result: 'exists' }` instead of rebuilding (nano.d.ts:1824
  // `interface CreateIndexResponse { result: string }`, "created" or "exists").
  //
  // The index for a provisioned stack is created at PROVISION time with the
  // admin credential (src/routes/provision.ts, step 2c), so on a stack
  // provisioned by this version this call finds the index already there. It
  // remains available as a best-effort declaration for a stack provisioned
  // before that step existed.
  //
  // Attempt bounding (#1346 review finding 1): a success is memoised for the
  // process, and so is a FAILURE — for INDEX_RETRY_COOLDOWN_MS — so a database
  // this credential cannot write design documents to costs at most one `POST
  // _index` per cooldown instead of one per caller. Inside the cooldown the
  // remembered error is re-thrown without a request, so the caller's own
  // error handling is unchanged.
  async ensureIndex(def: MangoIndexDef): Promise<void> {
    const key = `${this.dbName}|${def.ddoc}|${def.name}`;
    if (ensuredIndexes.has(key)) {
      return;
    }
    const failed = failedIndexAttempts.get(key);
    if (failed && Date.now() - failed.at < INDEX_RETRY_COOLDOWN_MS) {
      throw failed.err;
    }
    try {
      await this.db.createIndex({
        index: { fields: def.fields },
        ddoc: def.ddoc,
        name: def.name,
        type: 'json'
      });
    } catch (err) {
      failedIndexAttempts.set(key, { err, at: Date.now() });
      throw err;
    }
    failedIndexAttempts.delete(key);
    ensuredIndexes.add(key);
  }

  async count(selector: Record<string, unknown>): Promise<number> {
    const result = await this.db.find({
      selector: selector as nano.MangoSelector,
      fields: ['_id'],
      limit: COUNT_CAP
    });
    return result.docs.length;
  }

  async remove(localId: string): Promise<void> {
    const existing = await this.get(localId);
    if (!existing || !existing._rev) {
      return;
    }
    await this.db.destroy(existing._id, existing._rev);
  }
}

// Most documents `count` will match. A selector matching more than this reports
// COUNT_CAP, not the true total — `count` is a CAPPED count, not an exact one.
// Exported so callers can describe their own `total` honestly (#1346).
export const COUNT_CAP = 10_000;

function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    ((err as { statusCode?: number }).statusCode === 404 ||
      (err as { status?: number }).status === 404)
  );
}

// A CouchDB update conflict (issue #278).
//
// When two writers `put` the same document with the same `_rev`, the second
// loses: CouchDB rejects it with HTTP 409. nano surfaces this as a
// RequestError (nano.d.ts: `interface RequestError extends Error`) whose shape
// is `{ statusCode: 409, error: 'conflict', reason: 'Document update
// conflict.' }`. We key primarily on the numeric 409 (mirroring isNotFound's
// 404 check, and robust across nano versions) and also accept the stable
// `error: 'conflict'` identifier or the CouchDB reason string. This is a
// pure-write race, NOT a validation or transport failure, so it is safe to
// re-read and retry; every other error must propagate unchanged.
export function isUpdateConflict(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const e = err as {
    statusCode?: number;
    status?: number;
    error?: string;
    reason?: string;
  };
  return (
    e.statusCode === 409 ||
    e.status === 409 ||
    e.error === 'conflict' ||
    e.reason === 'Document update conflict.'
  );
}

// "This sorted query has no usable index" — the ONLY `_find` failure a caller
// may answer by reading the documents itself instead (#1346 review finding 1).
//
// Contract (apache/couchdb `src/mango/src/mango_error.erl`, fetched
// 2026-11-10):
//   - `info(mango_idx, {no_usable_index, missing_sort_index*})` -> HTTP 400,
//     error `no_usable_index`, reason "No index exists for this sort, try
//     indexing by the sort fields." (lines 21-44) — a `sort` with no covering
//     index.
//   - `info(mango_cursor, {invalid_index, [DDocName(, ViewName)]})` -> HTTP 400,
//     error `invalid_index`, reason "_design/<ddoc>(, <name>) specified by
//     `use_index` could not be found or it is not suitable." (lines 51-72) — the
//     named index is absent or cannot serve this sort.
//
// Both mean exactly "the index this query needs is not in place", which a
// bounded client-side scan CAN answer in the same order. Every other failure —
// 401/403 (credential), 409, a 5xx, a transport error — means the query itself
// did not get an answer, so it must propagate instead of being disguised as a
// successful, silently degraded page.
export function isMissingUsableIndex(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const e = err as {
    statusCode?: number;
    status?: number;
    error?: string;
    reason?: string;
  };
  const status = e.statusCode ?? e.status;
  // Keyed on the stable error identifier (as isUpdateConflict keys on 409 /
  // 'conflict'); when a status IS present it must be the documented 400, so a
  // 500 that happens to carry the same identifier is not treated as benign.
  const identified = e.error === 'no_usable_index' || e.error === 'invalid_index';
  if (identified) {
    return status === undefined || status === 400;
  }
  // nano surfaces some errors with only the reason string filled in; match the
  // two documented reasons above rather than any 400.
  const reason = e.reason ?? '';
  return (
    status === 400 &&
    (reason.startsWith('No index exists for this sort') ||
      reason.includes('specified by `use_index` could not be found'))
  );
}

// Options for updateWithRetry. All are optional; the defaults give a few
// bounded attempts with a short, growing backoff.
export type UpdateWithRetryOptions = {
  /** Total number of write attempts (>= 1). Default 5. */
  maxAttempts?: number;
  /** Base backoff in ms before the first retry; grows linearly per attempt. Default 25ms. */
  backoffMs?: number;
  /** Injectable sleep, for deterministic tests. Defaults to setTimeout. */
  sleep?: (ms: number) => Promise<void>;
};

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_BACKOFF_MS = 25;

// Read-modify-write with conflict-retry (issue #278).
//
// Wraps a single asset document write in a bounded read -> apply -> write loop.
// `patchFn` receives the CURRENT stored document (freshly fetched inside the
// loop) and returns the body to write; `updateWithRetry` carries the document's
// `_rev` forward so CouchDB accepts the write. On an update conflict (see
// isUpdateConflict) it refetches the latest `_rev`, re-applies `patchFn` to the
// new document, and retries after a short backoff, for at most `maxAttempts`
// tries. Non-conflict errors — and a conflict that persists past the last
// attempt — propagate unchanged.
//
// `patchFn` may be async and MUST be free of write side-effects, since it can
// run more than once. Follow-ups #279/#280 adopt this primitive by passing the
// asset id and their existing per-field patch application as `patchFn`.
//
// Returns the write result from the final successful put, or `undefined` when
// the document does not exist (so callers can preserve their not-found paths).
export async function updateWithRetry(
  couch: StackCouch,
  id: string,
  patchFn: (current: StoredDoc) => Record<string, unknown> | Promise<Record<string, unknown>>,
  opts: UpdateWithRetryOptions = {}
): Promise<{ id: string; rev: string } | undefined> {
  const maxAttempts = Math.max(1, opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
  const backoffMs = opts.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const current = await couch.get(id);
    if (!current) {
      return undefined;
    }
    const body = await patchFn(current);
    try {
      // Carry the just-read _rev so CouchDB detects a stale write as a 409
      // rather than silently branching the document.
      return await couch.put(id, { ...body, _rev: current._rev });
    } catch (err) {
      // Only a genuine update conflict is retryable, and only while attempts
      // remain. Everything else — and the final exhausted conflict — throws.
      if (isUpdateConflict(err) && attempt < maxAttempts) {
        await sleep(backoffMs * attempt);
        continue;
      }
      throw err;
    }
  }
  // Unreachable: the loop either returns or throws on the last attempt.
  return undefined;
}

export function couchServer(url: string): ServerScope {
  return nano(url);
}
