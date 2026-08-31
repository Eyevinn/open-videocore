// In-memory operational log store (issue #473).
//
// Backs GET /api/v1/logs — a cursor/sequence-paged, append-only, time-ordered
// log stream. There is no persistent log store in the repo today; the closest
// analogues are the per-job `encodeAttemptLog` field (a nested array on one job)
// and the provision OperationStore (an unbounded in-memory array with no
// message/level/category fields and no paging). This store is the minimal,
// well-scoped source needed to satisfy #473: a single append-only sequence with
// message/level/category records and monotonic sequence numbers so paging is
// stable against concurrent appends (no offset drift).
//
// Modelled on OperationStore (src/services/operation-store.ts): a plain in-memory
// class holding records in a Map/array, injected into its router the same way
// the OperationStore is injected into provisionRouter (src/main.ts:301-307).
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - OperationStore in-memory store + sort-newest-first list() shape:
//     src/services/operation-store.ts:17-38.
//   - `{ items, nextCursor }` cursor envelope expected by the frontend table
//     primitive: public/ops-ui-table.js:210-213 (`state.nextCursor = i.nextCursor`)
//     and pageParams() sending `{ limit, cursor }`: public/ops-ui-table.js:262-268.

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

export class LogStore {
  // Append order == sequence order, so the array is intrinsically ordered by
  // `seq` ascending. We never remove or reorder entries, which is what makes
  // cursor paging drift-free.
  private readonly records: LogRecord[] = [];
  private seq = 0;

  append(input: AppendLogInput): LogRecord {
    const record: LogRecord = {
      seq: ++this.seq,
      timestamp: input.timestamp ?? new Date().toISOString(),
      message: input.message,
      ...(input.level !== undefined ? { level: input.level } : {}),
      ...(input.category !== undefined ? { category: input.category } : {})
    };
    this.records.push(record);
    return { ...record };
  }

  // Total number of records held. Exposed for tests/observability only; the
  // listing endpoint intentionally does NOT return a total (it is a cursor-paged
  // stream, not an offset-paged collection).
  size(): number {
    return this.records.length;
  }

  list(opts: ListLogsOptions = {}): ListLogsResult {
    const limit = clampLimit(opts.limit);
    const order = opts.order === 'asc' ? 'asc' : 'desc';
    const cursorSeq = decodeCursor(opts.cursor);
    const q = opts.q?.toLowerCase();

    // Apply the server-side filters first. This is done over the full array;
    // filtering never changes the underlying `seq` values, so cursors stay valid
    // across filter changes.
    const filtered = this.records.filter((r) => {
      if (opts.from !== undefined && r.timestamp < opts.from) return false;
      if (opts.to !== undefined && r.timestamp > opts.to) return false;
      if (q !== undefined && !r.message.toLowerCase().includes(q)) return false;
      return true;
    });

    // Newest-first by default. Sequence order is the tie-break-free ordering
    // authority (timestamps can collide; `seq` cannot), so we order by `seq`.
    const ordered =
      order === 'desc'
        ? [...filtered].sort((a, b) => b.seq - a.seq)
        : [...filtered].sort((a, b) => a.seq - b.seq);

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
}
