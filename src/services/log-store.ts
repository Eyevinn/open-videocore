// Operational log store contract + shared query engine (issues #473, #996).
//
// Backs GET /api/v1/logs — a cursor/sequence-paged, append-only, time-ordered
// log stream. #473 shipped this as a process-local in-memory array, which meant
// every restart emptied the tab whose whole purpose is reviewing what happened
// before an incident. #996 keeps this module as the CONTRACT (the `LogStore`
// interface) plus the pure query engine (`applyLogQuery`) and the cursor codec,
// and moves durability into a CouchDB-backed implementation
// (CouchLogStore, src/data/log-repo.ts) alongside the in-memory one kept here
// for the env-no-couch / dev / test path — mirroring how the audit store pairs
// CouchAuditRepository with InMemoryAuditRepository (src/data/audit-repo.ts:192,312).
//
// The in-memory implementation's retained window is CAPPED
// (LOG_STORE_MAX_RECORDS, issue #995 review): records are evicted oldest-first
// once the cap is reached, so a long-running process with a busy pipeline
// producer cannot grow that array without bound. Sequence numbers are never
// reset or reused, so eviction does not weaken the paging contract.
//
// The store surface is async (`Promise`-returning) because the durable
// implementation talks to CouchDB. The PUBLIC wire contract of GET /api/v1/logs
// is unchanged: same `{ items, nextCursor }` envelope, same record shape, same
// `limit`/`cursor`/`from`/`to`/`q`/`order` params (src/routes/logs.ts:34-64).
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Public response envelope + record shape this store must keep feeding:
//     `logRecordSchema` / `listLogsResponseSchema`, src/routes/logs.ts:34-64;
//     consumed as `{ limit, cursor }` -> `{ items, nextCursor }` by the frontend
//     table primitive, public/ops-ui-table.js:210-213,262-268.
//   - Async store + in-memory sibling pattern: InMemoryAuditRepository /
//     CouchAuditRepository, src/data/audit-repo.ts:192,312.
//   - Pure filter+sort+paginate helper shared by both backends so they cannot
//     drift: `applyAuditQuery`, src/data/audit-repo.ts:141.

import { ulid } from 'ulid';

// Optional severity carried by a log record. Absent when the underlying source
// does not classify the entry.
export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

// One log record. `seq` is a monotonic, gap-free sequence number assigned at
// append time; it is the pagination AXIS (cursors encode a `seq`-anchored
// boundary, never an array offset, so newly appended entries never shift an
// in-flight page). It is not guaranteed globally unique — see
// SequencedLogRecord below, which is why a cursor carries a tie-break too.
// `timestamp` is an ISO-8601 instant. `level`/`category` are optional metadata
// the source may attach.
export type LogRecord = {
  seq: number;
  timestamp: string;
  message: string;
  level?: LogLevel;
  category?: string;
};

// A held/persisted record plus the identity of the entry that holds it. `id` is
// the store's own per-entry unique id — the document ULID for CouchLogStore
// (src/data/log-repo.ts, `localId`), a locally minted ULID for
// InMemoryLogStore. It is INTERNAL: it never reaches the wire (applyLogQuery
// strips it from `items`, and the route's response schema would drop it anyway,
// src/routes/logs.ts), and exists for exactly one reason — to break a `seq` tie.
//
// Why a tie is possible at all (review finding on #996): `seq` is allocated from
// a store instance's in-memory high-water mark, and a store instance is NOT
// process-wide. WorkspaceConnections is cached for CACHE_TTL_MS
// (src/services/workspace-stack.ts:70) and each rebuild mints a fresh
// `new CouchLogStore(wc)` (src/services/workspace-stack.ts:235) whose high-water
// mark starts undefined, so two live instances over the same partition can
// recover the same mark and both issue the same `seq`. ULIDs are
// lexicographically sortable and unique per entry, so `(seq, id)` is a total
// order even when `seq` repeats — which is what keeps a tied entry reachable
// through paging instead of being silently skipped at a page boundary.
export type SequencedLogRecord = LogRecord & { id?: string };

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
  // Opaque forward cursor from a previous page's `nextCursor`. Encodes the
  // composite `(seq, entry id)` boundary already returned, so paging resumes
  // strictly past it regardless of appends since — and past exactly one record,
  // even when two records share a `seq`. Invalid/garbage cursors are treated as
  // "from the start".
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

// The store contract the logs router depends on (src/routes/logs.ts:66-68).
// Implemented by InMemoryLogStore (below) and by the durable CouchLogStore
// (src/data/log-repo.ts). Async so a durable backend can be swapped in without
// touching the route; the router already awaits its handler's return value.
export interface LogStore {
  // Append one record and return it with its assigned `seq`. A durable backend
  // talks to a remote store, so this CAN reject (the in-memory one never does).
  // Producers should treat logging as fire-and-forget — catch and swallow, the
  // way `emitAudit` (src/data/audit-emit.ts) does for audit entries — so a store
  // hiccup never fails the operation being logged.
  append(input: AppendLogInput): Promise<LogRecord>;
  // One cursor-paged page of the stream, honouring the filters.
  list(opts?: ListLogsOptions): Promise<ListLogsResult>;
  // Total records held. Observability/tests only — the listing endpoint
  // deliberately does NOT return a total (it is a cursor-paged stream, not an
  // offset-paged collection).
  size(): Promise<number>;
}

export const LOG_DEFAULT_LIMIT = 50;
export const LOG_MAX_LIMIT = 200;

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

// Cursors are opaque to callers. We encode the last-returned record's
// `(seq, id)` COMPOSITE boundary as a base64url token so it survives
// round-tripping through a query string and is clearly not an offset. Decoding
// is tolerant: anything that does not parse to a finite integer `seq` is treated
// as "no cursor".
//
// The composite replaced a bare `seq` boundary on the #996 review: a bare `seq`
// is not a unique boundary (see SequencedLogRecord above), so resuming "strictly
// past seq N" skipped the second entry that also carried N whenever N fell on a
// page boundary — a silent read loss. The `id` half makes the boundary unique.
//
// Backwards compatible in BOTH directions, which is why this is not a public
// contract change (the token is opaque — src/routes/logs.ts `cursor`):
//   - a legacy `seq:N` token still decodes, to an id-less boundary that behaves
//     exactly as before (strictly past the whole of `seq` N);
//   - an id-less boundary is also what a window-edge cursor uses deliberately
//     (src/data/log-repo.ts), since an edge is a `seq` position, not a record.
const CURSOR_PREFIX = 'seq:';
const CURSOR_ID_SEP = '|id:';

// A decoded cursor boundary. `id` is absent for legacy and window-edge tokens.
export type LogCursorBoundary = { seq: number; id?: string };

export function encodeLogCursor(seq: number, id?: string): string {
  const body =
    id === undefined || id === ''
      ? `${CURSOR_PREFIX}${seq}`
      : `${CURSOR_PREFIX}${seq}${CURSOR_ID_SEP}${id}`;
  return Buffer.from(body, 'utf8').toString('base64url');
}

export function decodeLogCursor(cursor: string | undefined): LogCursorBoundary | undefined {
  if (!cursor) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  } catch {
    return undefined;
  }
  if (!decoded.startsWith(CURSOR_PREFIX)) return undefined;
  const rest = decoded.slice(CURSOR_PREFIX.length);
  const sep = rest.indexOf(CURSOR_ID_SEP);
  const seqPart = sep === -1 ? rest : rest.slice(0, sep);
  const idPart = sep === -1 ? '' : rest.slice(sep + CURSOR_ID_SEP.length);
  const parsed = Number.parseInt(seqPart, 10);
  if (!Number.isFinite(parsed)) return undefined;
  return idPart === '' ? { seq: parsed } : { seq: parsed, id: idPart };
}

// Total order over records: `seq` first, then the entry id as the tie-break.
// ULIDs are lexicographically sortable, so a plain string comparison is the
// right tie-break (and a missing id sorts before any present one).
function compareRecords(a: SequencedLogRecord, b: SequencedLogRecord): number {
  if (a.seq !== b.seq) return a.seq - b.seq;
  return compareIds(a.id, b.id);
}

function compareIds(a: string | undefined, b: string | undefined): number {
  const x = a ?? '';
  const y = b ?? '';
  return x < y ? -1 : x > y ? 1 : 0;
}

// Where `record` sits relative to a cursor boundary in the composite order:
// negative = before it, 0 = AT it, positive = after it. An id-less boundary
// compares on `seq` alone, so the whole of that `seq` counts as "at" the
// boundary — the legacy semantics, preserved for legacy and window-edge tokens.
function compareToBoundary(record: SequencedLogRecord, boundary: LogCursorBoundary): number {
  if (record.seq !== boundary.seq) return record.seq - boundary.seq;
  if (boundary.id === undefined) return 0;
  return compareIds(record.id, boundary.id);
}

export function clampLogLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return LOG_DEFAULT_LIMIT;
  return Math.min(LOG_MAX_LIMIT, Math.max(1, Math.trunc(limit)));
}

// Pure filter + order + cursor + paginate over already-materialised records.
// Shared by BOTH stores so the durable and in-memory backends cannot drift —
// the same role `applyAuditQuery` (src/data/audit-repo.ts:141) plays for audit.
// Never mutates its input.
//
// `nextCursor` is non-null iff the filtered, ordered, cursor-trimmed stream held
// MORE records than this page returned — i.e. it reflects only the records
// handed in. A backend that materialises a bounded slice of a larger stream must
// therefore decide for itself whether unscanned records remain beyond the slice
// (see CouchLogStore.list).
export function applyLogQuery(
  records: readonly SequencedLogRecord[],
  opts: ListLogsOptions = {}
): ListLogsResult {
  const limit = clampLogLimit(opts.limit);
  const order = opts.order === 'asc' ? 'asc' : 'desc';
  const boundary = decodeLogCursor(opts.cursor);
  const q = opts.q?.toLowerCase();

  // Apply the server-side filters first. Filtering never changes the underlying
  // `seq` values, so cursors stay valid across filter changes.
  const filtered = records.filter((r) => {
    if (opts.from !== undefined && r.timestamp < opts.from) return false;
    if (opts.to !== undefined && r.timestamp > opts.to) return false;
    if (q !== undefined && !r.message.toLowerCase().includes(q)) return false;
    return true;
  });

  // Newest-first by default. Ordered on the COMPOSITE `(seq, id)` key: `seq`
  // carries the ordering (timestamps can collide), and the entry id breaks a
  // repeated `seq` so the order is total rather than merely stable-by-accident.
  const ordered =
    order === 'desc'
      ? [...filtered].sort((a, b) => compareRecords(b, a))
      : [...filtered].sort((a, b) => compareRecords(a, b));

  // Resume strictly PAST the cursor's composite boundary, respecting direction.
  const afterCursor =
    boundary === undefined
      ? ordered
      : ordered.filter((r) => {
          const side = compareToBoundary(r, boundary);
          return order === 'desc' ? side < 0 : side > 0;
        });

  const page = afterCursor.slice(0, limit);
  const hasMore = afterCursor.length > page.length;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last ? encodeLogCursor(last.seq, last.id) : null;

  // `id` is internal: strip it so the page carries exactly the wire record.
  return { items: page.map(toWireRecord), nextCursor };
}

// Drop the internal entry id, returning a copy of the public record shape.
function toWireRecord(record: SequencedLogRecord): LogRecord {
  return {
    seq: record.seq,
    timestamp: record.timestamp,
    message: record.message,
    ...(record.level !== undefined ? { level: record.level } : {}),
    ...(record.category !== undefined ? { category: record.category } : {})
  };
}

// Build a LogRecord from an append input plus the sequence number the store
// assigned. Shared by both backends so the record shape is minted in ONE place
// (optional `level`/`category` are omitted entirely rather than set to
// undefined, keeping the persisted document and the wire payload identical).
export function buildLogRecord(input: AppendLogInput, seq: number): LogRecord {
  return {
    seq,
    timestamp: input.timestamp ?? new Date().toISOString(),
    message: input.message,
    ...(input.level !== undefined ? { level: input.level } : {}),
    ...(input.category !== undefined ? { category: input.category } : {})
  };
}

// Process-local log store for local/dev, tests, and the env-no-couch fallback
// path — the in-memory sibling of CouchLogStore, mirroring
// InMemoryAuditRepository (src/data/audit-repo.ts:312). NOT durable: entries are
// lost on restart, which is exactly why the provisioned path uses CouchLogStore
// (#996).
export class InMemoryLogStore implements LogStore {
  // Append order == sequence order, so the array is intrinsically ordered by
  // `seq` ascending. We never reorder entries, and the only removal is
  // oldest-first eviction at the cap (see maxRecords) — so the held window is
  // always a contiguous, ascending `seq` tail, which is what keeps cursor paging
  // drift-free: a cursor is a `seq` boundary, never an array offset, so appends
  // AND evictions both leave an in-flight page's boundary meaningful.
  private readonly records: SequencedLogRecord[] = [];
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

  async append(input: AppendLogInput): Promise<LogRecord> {
    const record = buildLogRecord(input, ++this.seq);
    // Mint the same per-entry id the durable store gets from its document ULID,
    // so BOTH backends run the composite-cursor path and cannot drift.
    this.records.push({ ...record, id: ulid() });
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
  // oldest records are evicted at the cap). Exposed for tests/observability
  // only; the listing endpoint intentionally does NOT return a total (it is a
  // cursor-paged stream, not an offset-paged collection).
  async size(): Promise<number> {
    return this.records.length;
  }

  async list(opts: ListLogsOptions = {}): Promise<ListLogsResult> {
    return applyLogQuery(this.records, opts);
  }
}
