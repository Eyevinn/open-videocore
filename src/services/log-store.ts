// Operational log store: record model, query semantics, and the in-memory
// implementation (issue #473; persisted to CouchDB by issue #996).
//
// Backs GET /api/v1/logs — a cursor/sequence-paged, append-only, time-ordered
// log stream: a single append-only sequence with message/level/category records
// and monotonic record ids so paging is stable against concurrent appends (no
// offset drift, and — since the #996 review — no key collisions between two
// store instances over one database either; see `LogRecord.id`).
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

import { monotonicFactory } from 'ulid';

// Optional severity carried by a log record. Absent when the underlying source
// does not classify the entry.
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// Record-id minter shared by EVERY store in the process (#996 review finding 1).
//
// `monotonicFactory()` (not bare `ulid()`) because log records arrive in
// same-millisecond bursts and plain ULIDs randomise the low bits, so two ids
// minted in one millisecond are not ordered by mint time. Monotonic ids are
// strictly increasing within this process, which is what makes `id` a usable
// total order (see `LogRecord.id`).
//
// MODULE level, deliberately: the durable CouchLogStore is reconstructed on
// every resolver cache miss (buildConnectionsFromStack,
// src/services/workspace-stack.ts:249, CACHE_TTL_MS), so two store instances can
// be live over ONE database at once. A per-instance minter would let them mint
// colliding keys; one module-level minter cannot.
const mintId = monotonicFactory();

// Mint the next log record id. Exported so the durable store can use the SAME
// sequence for the record id and the CouchDB document `_id` — the two must be
// the same value, because ascending `_id` order is what the store's oldest-first
// scans mean by "append order" (src/data/couch-log-repo.ts).
export function mintLogRecordId(): string {
  return mintId();
}

// One log record.
//
// `id` is a monotonic ULID minted at append time and is the AUTHORITATIVE
// ordering and pagination key (#996 review finding 1): it is unique per record
// across every store instance in the process, so sorting and cursor resumption
// can never skip a record. On the durable store it is also the CouchDB document
// `_id`. It is internal — the HTTP response schema (src/routes/logs.ts:55-63)
// does not include it, and the zod serializer strips it, so the wire contract is
// unchanged.
//
// `seq` is a per-store counter kept for DISPLAY only. It is NOT unique: a fresh
// store instance seeds it from the persisted high-water mark, so two instances
// over one database can mint the same `seq`. Nothing may order or paginate on
// it (that is exactly the bug finding 1 describes).
//
// `timestamp` is an ISO-8601 instant. `level`/`category` are optional metadata
// the source may attach.
export type LogRecord = {
  id: string;
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
  // Opaque forward cursor from a previous page's `nextCursor`. Encodes the `id`
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
  // Set when the store could not scan the whole retained window for this read,
  // so the answer is a bounded view rather than the complete one (#996 review
  // finding 2). Only the durable store sets it; the in-memory store always holds
  // its whole window. NOT part of the HTTP body — the response schema
  // (src/routes/logs.ts:81-85) does not include it and the zod serializer strips
  // it; the route turns it into a response header instead.
  degraded?: boolean;
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

// Minimal error-logging surface a store writes its own failures to (#996 review
// finding 2: a log store must never swallow its own errors). Structurally
// satisfied by the Fastify/pino logger and by StackResolverLogger
// (src/services/workspace-stack.ts:89-93), which is what the resolver passes to
// the durable store, so no adapter is needed. Same shape as
// `PipelineLogErrorLog` (src/services/pipeline-log.ts:60-62) — kept separate
// because that one is the PRODUCER's seam and this one is the STORE's.
export interface LogStoreErrorLog {
  error(obj: unknown, msg?: string): void;
}

// Cursors are opaque to callers. We encode the last-returned record's `id` as a
// base64url token so it survives round-tripping through a query string and is
// clearly not an offset. Decoding is tolerant: anything that does not parse is
// treated as "no cursor".
//
// The key is `id`, not `seq` (#996 review finding 1). `seq` is minted by a
// per-store counter, so two store instances over one database can mint the same
// value; because paging resumes STRICTLY past the boundary, a duplicate `seq`
// straddling a page boundary made a durably-written record unreachable. `id` is
// a monotonic ULID that is unique per record, so no record can be skipped.
const CURSOR_PREFIX = 'id:';

// Cursors minted BEFORE this change encoded a `seq` boundary. They are still
// honoured, with the old semantics, so a page in flight across a deploy keeps
// paging forward instead of silently restarting at page one. New cursors are
// never minted in this form.
const LEGACY_SEQ_CURSOR_PREFIX = 'seq:';

// The decoded paging boundary: an `id` from a current cursor, or a `seq` from a
// pre-#996-review one.
type CursorBoundary = { kind: 'id'; id: string } | { kind: 'seq'; seq: number };

function encodeCursor(id: string): string {
  return Buffer.from(`${CURSOR_PREFIX}${id}`, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string | undefined): CursorBoundary | undefined {
  if (!cursor) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  if (decoded.startsWith(CURSOR_PREFIX)) {
    const id = decoded.slice(CURSOR_PREFIX.length);
    return id ? { kind: 'id', id } : undefined;
  }
  if (decoded.startsWith(LEGACY_SEQ_CURSOR_PREFIX)) {
    const parsed = Number.parseInt(decoded.slice(LEGACY_SEQ_CURSOR_PREFIX.length), 10);
    return Number.isFinite(parsed) ? { kind: 'seq', seq: parsed } : undefined;
  }
  return undefined;
}

// Total order on record ids. ULIDs are fixed-length Crockford base32, so a plain
// codepoint comparison is their time order; `localeCompare` is deliberately NOT
// used here (it is locale-sensitive, and this comparison must be stable).
function compareIds(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

// Is this record strictly past the paging boundary, in the direction of travel?
function isAfterBoundary(
  record: LogRecord,
  boundary: CursorBoundary,
  order: 'asc' | 'desc'
): boolean {
  if (boundary.kind === 'id') {
    return order === 'desc'
      ? compareIds(record.id, boundary.id) < 0
      : compareIds(record.id, boundary.id) > 0;
  }
  // Legacy `seq` boundary — the pre-review semantics, verbatim.
  return order === 'desc' ? record.seq < boundary.seq : record.seq > boundary.seq;
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
  const boundary = decodeCursor(opts.cursor);
  const q = opts.q?.toLowerCase();

  // Apply the server-side filters first. Filtering never changes the underlying
  // `seq` values, so cursors stay valid across filter changes.
  const filtered = records.filter((r) => {
    if (opts.from !== undefined && r.timestamp < opts.from) return false;
    if (opts.to !== undefined && r.timestamp > opts.to) return false;
    if (q !== undefined && !r.message.toLowerCase().includes(q)) return false;
    return true;
  });

  // Newest-first by default, ordered by `id`. `id` is the tie-break-free
  // ordering authority: it is a monotonic ULID minted per record, so it is
  // unique across store instances (timestamps can collide, and so can `seq` —
  // see LogRecord). `filtered` is already a fresh array owned by this call, so
  // it is sorted in place — the caller's array is never reordered.
  const ordered = filtered.sort((a, b) =>
    order === 'desc' ? compareIds(b.id, a.id) : compareIds(a.id, b.id)
  );

  // Resume strictly AFTER the cursor's boundary, respecting direction. Because
  // the boundary is a unique `id`, "strictly after" can only ever exclude the
  // boundary record itself — never a second record that happened to share a key.
  const afterCursor =
    boundary === undefined ? ordered : ordered.filter((r) => isAfterBoundary(r, boundary, order));

  const page = afterCursor.slice(0, limit);
  // There is a next page iff the filtered/ordered stream had more entries than
  // this page returned. The cursor is the last returned record's id.
  const hasMore = afterCursor.length > page.length;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeCursor(last.id) : null;

  return { items: page.map((r) => ({ ...r })), nextCursor };
}

// The read capability GET /api/v1/logs needs (src/routes/logs.ts). Returns the
// `{ items, nextCursor }` contract either synchronously (in-memory LogStore) or
// as a promise (CouchLogStore / PerWorkspaceLogStore), so the route is written
// against the interface and works over both without a contract change.
export interface LogReader {
  list(opts?: ListLogsOptions): ListLogsResult | Promise<ListLogsResult>;
}

// The retention capability the log-retention purge sweep needs (issue #1067).
// Kept SEPARATE from `LogReader` so the read route and the frontend table are
// not handed a removal path: only the retention sweep consumes this.
//
// Mirrors `AuditRetentionRepository` (src/data/audit-repo.ts) one-for-one — the
// audit partition this store is modelled on carries exactly this pair — with the
// one difference that the return types are unions of the sync and promised form,
// as `LogReader.list` / `LogSink.append` already are, because the in-memory
// LogStore answers synchronously and the durable CouchLogStore
// (src/data/couch-log-repo.ts) answers with a promise. Both concrete stores
// implement it, so the sweep drives whichever store the resolved stack surfaces.
export interface LogRetentionStore {
  // Oldest-first page of log records (ascending `id`, i.e. append order).
  listOldestPage(opts: { limit: number; offset?: number }): LogRecord[] | Promise<LogRecord[]>;
  // Whole-record expiry (never an in-place edit). True on a live removal.
  purgeEntry(id: string): boolean | Promise<boolean>;
}

// Pure oldest-first paging over already-materialised records, shared by the
// in-memory LogStore and the durable CouchLogStore so their `listOldestPage`
// semantics cannot drift — the same device `applyLogQuery` provides for the
// listing contract. Sorts a COPY: the caller's array is never reordered.
//
// Ascending `id` is append order: `id` is a process-wide monotonic ULID
// (mintLogRecordId above), which is exactly the basis
// CouchAuditRepository.listOldestPage relies on (src/data/audit-repo.ts).
export function applyOldestPage(
  records: readonly LogRecord[],
  opts: { limit: number; offset?: number }
): LogRecord[] {
  const oldestFirst = [...records].sort((a, b) => compareIds(a.id, b.id));
  const offset = opts.offset ?? 0;
  return oldestFirst.slice(offset, offset + opts.limit).map((r) => ({ ...r }));
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
export class LogStore implements LogReader, LogSink, LogRetentionStore {
  // Append order == id order, so the array is intrinsically ordered by `id`
  // ascending. We never reorder entries, and the only removal is oldest-first
  // eviction at the cap (see maxRecords) — so the held window is always a
  // contiguous, ascending `id` tail, which is what keeps cursor paging
  // drift-free: a cursor is an `id` boundary, never an array offset, so appends
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
      // Authoritative ordering/cursor key, from the process-wide monotonic
      // minter so it cannot collide with any other store's ids (#996 review
      // finding 1).
      id: mintLogRecordId(),
      seq: ++this.seq,
      timestamp: input.timestamp ?? new Date().toISOString(),
      message: input.message,
      ...(input.level !== undefined ? { level: input.level } : {}),
      ...(input.category !== undefined ? { category: input.category } : {})
    };
    this.records.push(record);
    // Evict oldest-first past the cap. Ids are NEVER reset or reused, so the
    // monotonic ordering contract survives eviction: an aged-out cursor
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

  // Oldest-first page (ascending `id` / append order) for the log-retention
  // purge sweep (issue #1067). Mirrors CouchLogStore.listOldestPage so the
  // no-Couch dev/test path drives the SAME sweep as production, exactly as
  // InMemoryAuditRepository.listOldestPage mirrors the Couch audit store
  // (src/data/audit-repo.ts). NOT the newest-first `list()` above — kept
  // separate so the read contract is untouched.
  listOldestPage(opts: { limit: number; offset?: number }): LogRecord[] {
    return applyOldestPage(this.records, opts);
  }

  // Whole-record expiry for the retention sweep (issue #1067): removes the
  // single matching record outright, never an in-place edit, so a record is
  // either present verbatim or gone. Returns true when a live record was
  // removed, false when nothing matched — the contract
  // CouchAuditRepository.purgeEntry defines (src/data/audit-repo.ts) and the
  // sweep counts purges on.
  purgeEntry(id: string): boolean {
    const idx = this.records.findIndex((r) => r.id === id);
    if (idx < 0) {
      return false;
    }
    this.records.splice(idx, 1);
    return true;
  }
}
