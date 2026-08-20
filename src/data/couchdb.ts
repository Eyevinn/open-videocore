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

// CouchDB access for a single stack's database. OSC provisions a dedicated
// CouchDB instance per stack, so there is no workspace partitioning: documents
// are stored under their flat local id.
export class StackCouch {
  private readonly db: DocumentScope<StoredDoc>;

  constructor(server: ServerScope, dbName: string) {
    this.db = server.use<StoredDoc>(dbName);
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

  async find(
    selector: Record<string, unknown>,
    opts: { limit?: number; skip?: number } = {}
  ): Promise<StoredDoc[]> {
    const result = await this.db.find({
      selector: selector as nano.MangoSelector,
      limit: opts.limit ?? 50,
      skip: opts.skip ?? 0
    });
    return result.docs;
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

const COUNT_CAP = 10_000;

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
