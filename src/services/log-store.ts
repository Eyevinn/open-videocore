// Operational log store: record model, query semantics, and the in-memory
// implementation (issue #473; persisted to CouchDB by issue #996).
//
// Backs GET /api/v1/logs — a cursor/sequence-paged, append-only, time-ordered
// log stream: a single append-only sequence with message/level/category records
// and monotonic sequence numbers so paging is stable against concurrent appends
// (no offset drift).
//
// The DURABLE implementation is CouchLogStore (src/data/couch-log-repo.ts,
// issue #996), which persists each record as its own immutable document the way
// CouchAuditRepository persists audit entries (src/data/audit-repo.ts:199-215).
// The class below is the in-memory implementation retained for the
// no-Couch/dev/test paths (buildEnvConnections / buildInMemoryConnections,
// src/services/workspace-stack.ts), exactly as InMemoryAuditRepository is
// retained alongside CouchAuditRepository. Both share ONE filter/sort/paginate
// function (`applyLogQuery` below) so the two cannot drift — the same device
// `applyAuditQuery` (src/data/audit-repo.ts:141) uses for the audit stores.
//
// The retained window is CAPPED (LOG_STORE_MAX_RECORDS, issue #995 review):
// records are evicted oldest-first once the cap is reached, so a long-running
// process with a busy pipeline producer cannot grow this array without bound.
// Sequence numbers are never reset or reused, so eviction does not weaken the
// paging contract.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - OperationStore in-memory store + sort-newest-first list() shape:
//     src/services/operation-store.ts:17-38.
//   - `{ items, nextCursor }` cursor envelope expected by the frontend table
//     primitive: public/ops-ui-table.js:210-213 (`state.nextCursor = i.nextCursor`)
//     and pageParams() sending `{ limit, cursor }`: public/ops-ui-table.js:262-268.
//   - Shared-pure-query device for a Couch + in-memory store pair:
//     `applyAuditQuery(all, query)` at src/data/audit-repo.ts:141-162.

// Optional severity carried by a log record. Absent when the underlying source
// does not classify the entry.
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// One log record. `seq` is a monotonic, gap-free sequence number assigned at
// append time; it is the stable pagination key (cursors encode a `seq`
// boundary, never an array offset, so newly appended entries never shift an
// in-flight page). `timestamp` is an ISO-8601 instant. `level`/`category` are
// optional metadata the source may attach.
export type LogRecord = {
  seq: number;
  timestamp: string;
  message: string;
  level?: LogLevel;
  category?: string;
};

// Input accepted by append(). `timestamp` defaults to now; `seq` is assigned by
// the store and must not be supplied by callers.
export type AppendLogInput = {
  message: string;
  level?: LogLevel;
  category?: string;
  timestamp?: string;
};

export type ListLogsOptions = {
  // Bounded page size. Callers pass a validated, clamped value; the store also
  // defends with its own clamp so a direct (non-route) caller cannot request an
  // unbounded page.
  limit?: number;
  // Opaque forward cursor from a previous page's `nextCursor`. Encodes the `seq`
  // boundary already returned, so paging resumes strictly after it regardless of
  // appends since. Invalid/garbage cursors are treated as "from the start".
  cursor?: string;
  // Inclusive ISO-8601 time-range filter on `timestamp`.
  from?: string;
  to?: string;
  // Free-text, case-insensitive substring filter on `message`.
  q?: string;
  // 'desc' (default) = newest-first; 'asc' = oldest-first.
  order?: 'asc' | 'desc';
};

export type ListLogsResult = {
  items: LogRecord[];
  // Opaque token to fetch the next page, or null when this page is the last.
  nextCursor: string | null;
};

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

// Hard cap on records held in memory (issue #995 review). The store is process
// memory with no retention sweep behind it, and now that the pipeline producer
// (src/services/pipeline-log.ts) writes ~8 records per asset run, an
// authenticated client repeating POST /api/v1/assets/:id/execute would otherwise
// grow it without bound for the lifetime of the process. Appends past the cap
// evict oldest-first (a ring buffer over the append-ordered array), which is the
// right trade for an operational log tail: the newest entries are the ones
// operators read, and `list()` work stays bounded too (it filters/sorts the held
// array). 5000 records is ~600 asset runs of pipeline history.
export const LOG_STORE_MAX_RECORDS = 5000;

export type LogStoreOptions = {
  // Override the retained-record cap. Values below 1 are clamped to 1. Exposed
  // so tests can drive eviction cheaply and so a deployment can tune the tail
  // depth without touching this module.
  maxRecords?: number;
};

// Cursors are opaque to callers. We encode the last-returned `seq` as a
// base64url token so it survives round-tripping through a query string and is
// clearly not an offset. Decoding is tolerant: anything that does not parse to a
// finite integer is treated as "no cursor".
const CURSOR_PREFIX = 'seq:';

function encodeCursor(seq: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${seq}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): number | undefined {
  if (!cursor) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  if (!decoded.startsWith(CURSOR_PREFIX)) return undefined;
  const parsed = Number.parseInt(decoded.slice(CURSOR_PREFIX.length), 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

// Pure filter + sort + cursor-paginate over already-materialised records.
// Shared by the in-memory LogStore and the durable CouchLogStore
// (src/data/couch-log-repo.ts) so the two implementations of the
// `{ items, nextCursor }` contract cannot drift — the same device
// `applyAuditQuery` (src/data/audit-repo.ts:141) provides for the audit stores.
// Never mutates its input: the array it sorts is its own copy.
//
// This is the ONLY place the listing semantics live: the time-range/`q` filters,
// the `seq`-ordered sort, the "resume strictly after the cursor boundary" rule,
// and the `nextCursor` mint. Moving it out of the class changed none of them.
export function applyLogQuery(
  records: readonly LogRecord[],
  opts: ListLogsOptions = {}
): ListLogsResult {
  const limit = clampLimit(opts.limit);
  const order = opts.order === 'asc' ? 'asc' : 'desc';
  const cursorSeq = decodeCursor(opts.cursor);
  const q = opts.q?.toLowerCase();

  // Apply the server-side filters first. Filtering never changes the underlying
  // `seq` values, so cursors stay valid across filter changes.
  const filtered = records.filter((r) => {
    if (opts.from !== undefined && r.timestamp < opts.from) return false;
    if (opts.to !== undefined && r.timestamp > opts.to) return false;
    if (q !== undefined && !r.message.toLowerCase().includes(q)) return false;
    return true;
  });

  // Newest-first by default. Sequence order is the tie-break-free ordering
  // authority (timestamps can collide; `seq` cannot), so we order by `seq`.
  // `filtered` is already a fresh array owned by this call, so it is sorted in
  // place — the caller's array is never reordered.
  const ordered = filtered.sort((a, b) => (order === 'desc' ? b.seq - a.seq : a.seq - b.seq));

  // Resume strictly AFTER the cursor's seq boundary, respecting direction.
  const afterCursor =
    cursorSeq === undefined
      ? ordered
      : ordered.filter((r) => (order === 'desc' ? r.seq < cursorSeq : r.seq > cursorSeq));

  const page = afterCursor.slice(0, limit);
  // There is a next page iff the filtered/ordered stream had more entries than
  // this page returned. The cursor is the last returned record's seq.
  const hasMore = afterCursor.length > page.length;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.seq) : null;

  return { items: page.map((r) => ({ ...r })), nextCursor };
}

// The read capability GET /api/v1/logs needs (src/routes/logs.ts). Returns the
// `{ items, nextCursor }` contract either synchronously (in-memory LogStore) or
// as a promise (CouchLogStore / PerWorkspaceLogStore), so the route is written
// against the interface and works over both without a contract change.
export interface LogReader {
  list(opts?: ListLogsOptions): ListLogsResult | Promise<ListLogsResult>;
}

// The write capability the pipeline producer needs. Satisfied synchronously by
// the in-memory LogStore and asynchronously by the durable CouchLogStore
// (src/data/couch-log-repo.ts). `PipelineLogSink`
// (src/services/pipeline-log.ts:51-53) is the even narrower, return-type-
// agnostic view the pipeline call sites depend on; this one keeps the record
// type for callers that use the written record.
export interface LogSink {
  append(input: AppendLogInput): LogRecord | Promise<LogRecord>;
}

// In-memory operational log store, retained for the no-Couch paths (dev/test,
// buildEnvConnections without COUCHDB_URL, buildInMemoryConnections) exactly as
// InMemoryAuditRepository is retained alongside CouchAuditRepository
// (src/data/audit-repo.ts:312). Process-local: records do NOT survive a restart
// — that is what CouchLogStore (src/data/couch-log-repo.ts, issue #996) is for.
export class LogStore {
  // Append order == sequence order, so the array is intrinsically ordered by
  // `seq` ascending. We never reorder entries, and the only removal is
  // oldest-first eviction at the cap (see maxRecords) — so the held window is
  // always a contiguous, ascending `seq` tail, which is what keeps cursor paging
  // drift-free: a cursor is a `seq` boundary, never an array offset, so appends
  // AND evictions both leave an in-flight page's boundary meaningful.
  private readonly records: LogRecord[] = [];
  private seq = 0;
  private readonly maxRecords: number;

  constructor(opts: LogStoreOptions = {}) {
    this.maxRecords = Math.max(
      1,
      Math.trunc(
        opts.maxRecords !== undefined && Number.isFinite(opts.maxRecords)
          ? opts.maxRecords
          : LOG_STORE_MAX_RECORDS
      )
    );
  }

  append(input: AppendLogInput): LogRecord {
    const record: LogRecord = {
      seq: ++this.seq,
      timestamp: input.timestamp ?? new Date().toISOString(),
      message: input.message,
      ...(input.level !== undefined ? { level: input.level } : {}),
      ...(input.category !== undefined ? { category: input.category } : {})
    };
    this.records.push(record);
    // Evict oldest-first past the cap. `seq` is NEVER reset or reused, so the
    // monotonic sequence contract survives eviction: an aged-out cursor
    // boundary simply has no records on its older side, which `list()` already
    // handles (a desc page resuming after an evicted boundary returns the
    // remaining older records, or an empty last page with nextCursor null).
    if (this.records.length > this.maxRecords) {
      this.records.splice(0, this.records.length - this.maxRecords);
    }
    return { ...record };
  }

  // Total number of records currently HELD (not the number ever appended —
  // oldest records are evicted at the cap). Exposed for tests/observability only; the
  // listing endpoint intentionally does NOT return a total (it is a cursor-paged
  // stream, not an offset-paged collection).
  size(): number {
    return this.records.length;
  }

  // Filter/sort/paginate the held window. Delegates to the shared pure
  // `applyLogQuery` so this store and the durable CouchLogStore answer the
  // listing contract identically (`records` is passed as a readonly view and is
  // never reordered or mutated by the query).
  list(opts: ListLogsOptions = {}): ListLogsResult {
    return applyLogQuery(this.records, opts);
  }
}
