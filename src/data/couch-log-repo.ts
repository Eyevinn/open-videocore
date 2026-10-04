// Durable operational log store over CouchDB (issue #996, parent #985).
//
// The log store that backs GET /api/v1/logs was process memory (an array in
// src/services/log-store.ts), so every restart emptied the Logs tab — the one
// tab whose purpose is reviewing what happened BEFORE an incident. This module
// is the durable implementation: each appended record becomes its own immutable
// CouchDB document, so `LogStore.append()` output survives a restart and is
// still returned by GET /api/v1/logs afterward.
//
// Store choice is the architect's (issue #996): CouchDB is already this
// project's store for this class of record (ADR-001 metadata store; ADR-005
// append-only audit records), and the per-stack database is already covered by
// the daily backup schedule, so there is no new store and no new backup surface.
//
// Pattern followed — CouchAuditRepository (src/data/audit-repo.ts:192-299),
// verified before writing (CLAUDE.md rule 7):
//   - Construction: `constructor(private readonly couchFor: CouchFactory)` where
//     `CouchFactory = () => StackCouch`, resolved per call —
//     src/data/audit-repo.ts:94,193,210.
//   - Document identity: a FRESH `ulid()` as the document `_id`, passed as
//     `couch.put(entry.id, toDoc(entry))` with NO `_rev` carried forward, so an
//     append is always a new immutable document and never a read-modify-write of
//     an existing one — src/data/audit-repo.ts:199-215.
//   - Document body: `{ resourceType: '<type>', localId, ...flat fields }` and a
//     `resourceType` discriminator re-checked on every read —
//     src/data/audit-repo.ts:36,222,361-372 (toDoc) and :374-384 (fromDoc).
//     NOTE: audit documents carry NO `schemaVersion` field (`toDoc`,
//     src/data/audit-repo.ts:361-372); `schemaVersion` belongs to the ASSET
//     document (`ASSET_SCHEMA_VERSION`, src/data/asset-document.ts:279,452). This
//     module follows the audit shape it was told to follow, so log documents
//     carry no `schemaVersion` either.
//   - Read primitive: `couch.find({ resourceType }, { limit, skip })` with a
//     finite per-fetch cap, then filter/paginate in the application layer so the
//     wire contract never leaks the Mango selector —
//     src/data/audit-repo.ts:293-298 over src/data/couchdb.ts:66-76.
//   - Oldest-first paging relies on Mango `find` with NO explicit `sort` scanning
//     the primary `_id` index (ascending `_id`, which for ULID ids is append
//     order) — the assumption documented at src/data/audit-repo.ts:249-261. See
//     `nextDocId` below for the one divergence this forced: log ids are minted
//     MONOTONICALLY, because log records arrive in same-millisecond bursts where
//     bare `ulid()` is not append-ordered.
//   - Whole-document removal via `couch.remove(id)` after a resourceType check —
//     src/data/audit-repo.ts:277-285 (purgeEntry) over src/data/couchdb.ts:87-93.
//
// Public contract preserved: this class answers the SAME
// `list(opts) -> { items, nextCursor }` shape as the in-memory store, by calling
// the one shared pure query function `applyLogQuery`
// (src/services/log-store.ts), so no filter, sort, cursor or envelope semantics
// change for GET /api/v1/logs (src/routes/logs.ts:70-74,110-113).

import type { StackCouch, StoredDoc } from './couchdb.js';
import {
  applyLogQuery,
  mintLogRecordId,
  LOG_LEVELS,
  LOG_STORE_MAX_RECORDS,
  type AppendLogInput,
  type ListLogsOptions,
  type ListLogsResult,
  type LogLevel,
  type LogReader,
  type LogRecord,
  type LogStoreErrorLog,
  type LogStoreOptions
} from '../services/log-store.js';

// resourceType discriminator for the log partition — mirrors the
// per-resource-type convention ('audit-entry' at src/data/audit-repo.ts:36,
// 'collection' at src/data/couch-collection-repo.ts:25).
const RESOURCE_TYPE = 'log-entry';

const SELECTOR: Record<string, unknown> = { resourceType: RESOURCE_TYPE };

export type CouchFactory = () => StackCouch;

// Construction options: the shared retained-window cap, plus the error-logging
// seam this store writes its own failures to (#996 review finding 2 — a store
// that swallows its errors makes a silent data-loss mode look healthy).
export type CouchLogStoreOptions = LogStoreOptions & {
  log?: LogStoreErrorLog;
  // Override the per-fetch document cap (default LOG_FETCH_CAP). Exposed for
  // the same reason `maxRecords` is: so a test can drive the over-cap read path
  // without writing ten thousand documents, and so a deployment can tune the
  // read window. Values below 1 are clamped to 1.
  fetchCap?: number;
};

const NOOP_ERROR_LOG: LogStoreErrorLog = { error: () => {} };

// Documents a single `find` pulls. Mirrors AUDIT_FETCH_CAP
// (src/data/audit-repo.ts:305) so one request cannot produce an unbounded read.
//
// It is NOT, on its own, the correctness boundary any more (#996 review finding
// 2). The Mango scan returns the OLDEST documents first, so when the partition
// outgrew this cap the newest records fell off the end of the one capped fetch
// and `list()` served a stale window with HTTP 200 and no error. `list()` now
// walks forward past a full page (see fetchWindow) so the newest records stay
// reachable, and reports the overshoot instead of hiding it.
export const LOG_FETCH_CAP = 10_000;

// Pages of LOG_FETCH_CAP documents a single `list()` will walk. The FIRST page
// answers any partition inside the cap, so the healthy read path is exactly one
// `find` — unchanged. The extra pages exist only for the abnormal case where
// eviction has fallen behind, and they are bounded so a runaway partition cannot
// turn one read into an unbounded scan.
const LIST_MAX_PAGES = 5;

// `sort` is deliberately NOT used on the read path. StackCouch.find exposes only
// `{ selector, limit, skip }` (src/data/couchdb.ts:66-76) and nothing in this
// codebase declares a Mango index (no `createIndex` call anywhere), so asking
// CouchDB for `sort: [{ _id: 'desc' }]` would need both a widened helper and a
// per-stack index-bootstrap path — neither of which exists. The forward walk
// above removes the cap from the correctness path without either. Logged as a
// follow-up rather than smuggled in here.

// Page size and page bound for the one-time high-water-mark scan. 20 pages of
// 1000 covers four times the retained cap, which bounds the scan even against a
// partition that predates the cap being enforced.
const INIT_PAGE_SIZE = 1000;
const MAX_INIT_PAGES = 20;

// Most documents a single append will evict. Keeps one append's work bounded
// when the retained count starts far above the cap; the remaining overflow is
// trimmed by the following appends.
const MAX_EVICTIONS_PER_APPEND = 50;

// Document ids are the record ids, minted by the process-wide monotonic ULID
// minter `mintLogRecordId()` (src/services/log-store.ts).
//
// ULID, as CouchAuditRepository mints it (src/data/audit-repo.ts:202), but
// through `monotonicFactory()` rather than the bare `ulid()` the audit store
// calls. This is a deliberate, necessary divergence. Plain `ulid()` randomises
// the low bits, so two ids minted inside the SAME millisecond are not ordered by
// mint time. Audit entries tolerate that (they are sorted by their own `at` /
// id, and nothing evicts them by id order). A pipeline run appends ~8 log
// records back-to-back, several of them inside one millisecond, and THREE
// id-ordered paths here depend on "ascending `_id` == append order": the
// high-water-mark scan; the oldest-first eviction (which with random
// intra-millisecond ids would delete the NEWEST records of a burst instead of
// the oldest); and, since the #996 review, the listing sort and cursor itself.
//
// The minter lives in log-store.ts, at MODULE level, so every store instance in
// the process — in-memory or durable, and however many of them the resolver
// cache has constructed over one database — draws from ONE strictly increasing
// sequence. That is what makes the document `_id` a safe cursor key.

// Durable, append-only operational log store.
//
// Exposes ONLY `append` (write), `list` (the GET /api/v1/logs read contract) and
// `size` (held-record count, for tests/observability — the listing endpoint
// deliberately returns no total). No update path and no `_rev` carry-forward, so
// a written record can never be rewritten by application code — ADR-005 "append
// the audit entry, never rewrite history" as applied at
// src/data/audit-repo.ts:187-215. The single removal path is the retained-window
// eviction below, which deletes a whole document and never edits one.
export class CouchLogStore implements LogReader {
  // Same bounded-retention contract as the in-memory store
  // (LOG_STORE_MAX_RECORDS, src/services/log-store.ts): the oldest records are
  // evicted once the partition exceeds the cap, which keeps the daily CouchDB
  // backup from growing without limit behind a busy pipeline producer and keeps
  // a read's working set bounded. Since the #996 review it is NO LONGER the
  // thing that makes `list()` correct — `fetchWindow` walks past a full page
  // rather than trusting eviction to have kept the partition inside one — but it
  // is still the size of the window `list()` returns.
  private readonly maxRecords: number;

  // In-process allocator for the DISPLAY-ONLY `seq` field, seeded ONCE from the
  // highest `seq` already persisted (see loadHighWaterMark) so a fresh process
  // continues the numbering instead of restarting at 1 underneath the restored
  // history.
  //
  // `seq` is NOT unique and nothing may order or paginate on it (#996 review
  // finding 1). A new store is constructed on every resolver cache miss
  // (buildConnectionsFromStack, src/services/workspace-stack.ts:249) with no
  // in-flight dedup, so two live instances over one database seed from the same
  // high-water mark and mint the same next value — and before the review, that
  // duplicate straddling a page boundary made a durably-written record
  // unreachable, because paging resumed strictly past the cursor's `seq`. The
  // ordering and cursor key is now the monotonic ULID `_id` (== `LogRecord.id`),
  // which is unique across instances, so a duplicate `seq` is now nothing worse
  // than two rows showing the same number.
  private seq = 0;

  // Where this store reports its OWN failures (#996 review finding 2): eviction
  // errors and an over-cap read window. Defaults to a noop only so tests and
  // callers that build a store directly keep working; every production
  // construction site passes the resolver's logger
  // (src/services/workspace-stack.ts).
  private readonly log: LogStoreErrorLog;

  // Documents a single `find` pulls (see LOG_FETCH_CAP / fetchWindow).
  private readonly fetchCap: number;

  // Documents believed to be in the partition, seeded by the same scan and
  // maintained locally thereafter. Only drives eviction, so an approximation
  // under concurrent writers is acceptable: the next append re-trims.
  private retained = 0;

  // Memoised seed. Cleared on failure so a transient CouchDB error does not
  // permanently wedge the allocator at 0.
  private seeding: Promise<void> | undefined;

  constructor(
    private readonly couchFor: CouchFactory,
    opts: CouchLogStoreOptions = {}
  ) {
    this.log = opts.log ?? NOOP_ERROR_LOG;
    this.maxRecords = Math.max(
      1,
      Math.trunc(
        opts.maxRecords !== undefined && Number.isFinite(opts.maxRecords)
          ? opts.maxRecords
          : LOG_STORE_MAX_RECORDS
      )
    );
    this.fetchCap = Math.max(
      1,
      Math.trunc(
        opts.fetchCap !== undefined && Number.isFinite(opts.fetchCap)
          ? opts.fetchCap
          : LOG_FETCH_CAP
      )
    );
  }

  // Append exactly one log record as a new immutable document. Mints a fresh
  // ULID `_id` and writes with no `_rev`, so prior records are untouched
  // (src/data/audit-repo.ts:210-214). Returns the stored record — same return
  // shape as the in-memory `LogStore.append()` (src/services/log-store.ts), just
  // promise-wrapped, which is why `PipelineLogSink.append` is typed
  // `(input) => unknown` (src/services/pipeline-log.ts:51-53).
  async append(input: AppendLogInput): Promise<LogRecord> {
    const couch = this.couchFor();
    await this.ensureSeeded(couch);
    // Fresh monotonic ULID, used as BOTH the record's ordering key and the
    // document `_id` — the id shape CouchAuditRepository.record writes
    // (src/data/audit-repo.ts:202, 213 with toDoc's `localId: entry.id`). The
    // two must be the same value: ascending `_id` is what every oldest-first
    // scan here means by append order, and `LogRecord.id` is what the listing
    // sorts and pages on.
    const docId = mintLogRecordId();
    const record: LogRecord = {
      id: docId,
      seq: ++this.seq,
      timestamp: input.timestamp ?? new Date().toISOString(),
      message: input.message,
      ...(input.level !== undefined ? { level: input.level } : {}),
      ...(input.category !== undefined ? { category: input.category } : {})
    };
    await couch.put(docId, toDoc(docId, record));
    this.retained += 1;
    // Keep the retained window inside the cap. Best-effort on the APPEND's
    // behalf — a failed eviction must not fail the append that triggered it,
    // because the record is already durable — but never silent (#996 review
    // finding 2): eviction is what keeps the read window honest, so an eviction
    // that keeps failing is an operator-visible problem, not a detail. Logged at
    // error level and retried by the next append.
    try {
      await this.evictOverflow(couch);
    } catch (err: unknown) {
      this.log.error(
        {
          err,
          resourceType: RESOURCE_TYPE,
          retained: this.retained,
          maxRecords: this.maxRecords
        },
        'log store overflow eviction failed (append was durable; retried on next append)'
      );
    }
    return { ...record };
  }

  // The GET /api/v1/logs read path. Pulls the retained window through the same
  // `couch.find({ resourceType }, { limit })` primitive the audit query uses
  // (src/data/audit-repo.ts:293-298), then applies the SHARED pure query so the
  // filters, sort, cursor semantics and `{ items, nextCursor }` envelope are
  // byte-for-byte the in-memory store's (src/services/log-store.ts,
  // `applyLogQuery`). Read-only: never writes.
  //
  // `degraded` rides along on the result when the partition overshot one capped
  // fetch (#996 review finding 2). The HTTP body is unchanged — the response
  // schema has no such field and the zod serializer strips it
  // (src/routes/logs.ts) — the route turns it into a response header.
  async list(opts: ListLogsOptions = {}): Promise<ListLogsResult> {
    const couch = this.couchFor();
    const { records, degraded } = await this.fetchWindow(couch);
    const result = applyLogQuery(records, opts);
    return degraded ? { ...result, degraded: true } : result;
  }

  // Materialise the newest retained window, oldest-first scan and all.
  //
  // Before the #996 review this was a single `find(limit: LOG_FETCH_CAP)`, which
  // was correct ONLY while eviction kept the partition under the cap: the Mango
  // scan is ascending-`_id`, so the moment the partition exceeded the cap, the
  // page returned the OLDEST 10k documents and the newest records — the ones an
  // operator opens this tab for — vanished behind an HTTP 200. Worse, the
  // eviction that maintained that invariant swallowed its failures, so the
  // precondition could rot invisibly.
  //
  // So: the healthy path is still exactly ONE `find` (a short page proves the
  // partition ended inside the cap). A FULL page proves it did not, and we walk
  // forward from there, keeping only the newest `maxRecords` as we go, so the
  // tail stays reachable and memory stays bounded. The walk is capped at
  // LIST_MAX_PAGES so a runaway partition cannot turn a read into an unbounded
  // scan — and whenever we had to walk at all, the caller is told the window is
  // degraded and the condition is logged at error level.
  private async fetchWindow(
    couch: StackCouch
  ): Promise<{ records: LogRecord[]; degraded: boolean }> {
    const records: LogRecord[] = [];
    let skip = 0;
    let scanned = 0;

    for (let page = 0; page < LIST_MAX_PAGES; page += 1) {
      const docs = await couch.find(SELECTOR, { limit: this.fetchCap, skip });
      scanned += docs.length;
      for (const doc of docs) {
        if (doc.resourceType !== RESOURCE_TYPE) continue;
        const record = fromDoc(doc);
        // A single unreadable document must not make the whole operational log
        // unreadable: it is skipped rather than thrown, unlike the audit read
        // path's strict `AuditEntrySchema.parse` (src/data/audit-repo.ts:375).
        // An audit entry is evidence about one resource; this is an incident
        // tail an operator reads under pressure.
        if (record) records.push(record);
      }

      // Short page == end of the partition. On the first iteration this is the
      // healthy case and the whole window is in hand.
      if (docs.length < this.fetchCap) {
        const degraded = page > 0;
        if (degraded) this.reportOverflow(scanned, false);
        return { records, degraded };
      }

      // Full page: more documents exist past this window. Drop everything but
      // the newest `maxRecords` before pulling the next page — the scan is
      // oldest-first, so the tail of `records` is the newest.
      if (records.length > this.maxRecords) {
        records.splice(0, records.length - this.maxRecords);
      }
      skip += this.fetchCap;
    }

    // Walked every allowed page and the partition STILL had more. What comes
    // back is the newest `maxRecords` of the LIST_MAX_PAGES*fetchCap documents
    // actually scanned — NOT the newest records in the partition. That residual
    // limit is the price of a bounded read without a Mango sort (see the note by
    // LIST_MAX_PAGES); it needs a partition more than ten times the retained cap
    // to reach, and unlike before the review it is reported rather than served
    // as a clean 200.
    this.reportOverflow(scanned, true);
    if (records.length > this.maxRecords) {
      records.splice(0, records.length - this.maxRecords);
    }
    return { records, degraded: true };
  }

  // Say out loud that the read window was not the whole retained window. This is
  // the "never silently serve a stale/partial window" half of #996 review
  // finding 2: the condition means eviction is not keeping up (or is failing),
  // which is operator-actionable.
  private reportOverflow(scanned: number, hitPageLimit: boolean): void {
    this.log.error(
      {
        resourceType: RESOURCE_TYPE,
        scanned,
        fetchCap: this.fetchCap,
        maxPages: LIST_MAX_PAGES,
        maxRecords: this.maxRecords,
        hitPageLimit
      },
      hitPageLimit
        ? 'log partition exceeds the bounded read scan; the listed window is NOT the newest records (eviction is far behind)'
        : 'log partition exceeds one bounded fetch; serving the newest records only (eviction is behind)'
    );
  }

  // Documents currently HELD in the partition (not the number ever appended —
  // the oldest are evicted at the cap). Mirrors `LogStore.size()`; exposed for
  // tests/observability only. Uses the capped `count` primitive
  // (src/data/couchdb.ts:78-85).
  async size(): Promise<number> {
    const couch = this.couchFor();
    return couch.count(SELECTOR);
  }

  private async ensureSeeded(couch: StackCouch): Promise<void> {
    if (!this.seeding) {
      this.seeding = this.loadHighWaterMark(couch).catch((err: unknown) => {
        this.seeding = undefined;
        throw err;
      });
    }
    return this.seeding;
  }

  // Seed the sequence allocator and the retained count from what is already
  // persisted. THIS is the restart-survival mechanism for `seq`: without it a
  // fresh process would restart the sequence at 1 and its records would sort
  // underneath the restored history, breaking newest-first order and cursor
  // paging for the pre-restart records.
  //
  // Walks the partition in ascending-`_id` pages — Mango `find` with no explicit
  // `sort` scans the primary `_id` index, the assumption documented at
  // src/data/audit-repo.ts:249-261 — and keeps the maximum `seq` seen. It reads
  // the whole retained window and takes the maximum rather than trusting
  // "last page == highest seq": ids are monotonic within ONE process, but a
  // partition written by successive processes offers no such guarantee across
  // the boundary, and the whole point of this scan is to read across it.
  // Bounded at MAX_INIT_PAGES; a partition larger than that is trimmed back
  // under the cap by the eviction path.
  private async loadHighWaterMark(couch: StackCouch): Promise<void> {
    let skip = 0;
    let maxSeq = 0;
    let counted = 0;
    for (let page = 0; page < MAX_INIT_PAGES; page += 1) {
      const docs = await couch.find(SELECTOR, { limit: INIT_PAGE_SIZE, skip });
      for (const doc of docs) {
        if (doc.resourceType !== RESOURCE_TYPE) continue;
        counted += 1;
        const seq = Number(doc['seq']);
        if (Number.isFinite(seq) && seq > maxSeq) maxSeq = seq;
      }
      if (docs.length < INIT_PAGE_SIZE) break;
      skip += INIT_PAGE_SIZE;
    }
    // Never move the allocator backwards: an append that raced the seed keeps
    // its higher value.
    this.seq = Math.max(this.seq, maxSeq);
    this.retained = Math.max(this.retained, counted);
  }

  // Delete the oldest documents past the cap. Whole-document removal via
  // `couch.remove` after a resourceType check — the shape of
  // CouchAuditRepository.purgeEntry (src/data/audit-repo.ts:277-285) — so a
  // record is either present verbatim or gone, never rewritten. Oldest-first
  // comes from the ascending-`_id` scan (ULID ids are append-ordered), the same
  // basis as CouchAuditRepository.listOldestPage (src/data/audit-repo.ts:249-266).
  private async evictOverflow(couch: StackCouch): Promise<void> {
    const overflow = this.retained - this.maxRecords;
    if (overflow <= 0) return;
    const batch = Math.min(overflow, MAX_EVICTIONS_PER_APPEND);
    const oldest = await couch.find(SELECTOR, { limit: batch });
    for (const doc of oldest) {
      if (doc.resourceType !== RESOURCE_TYPE) continue;
      await couch.remove(doc._id);
      this.retained = Math.max(0, this.retained - 1);
    }
  }
}

// Map a LogRecord to its persisted document body. Mirrors the
// resourceType + localId + flat-body shape of CouchAuditRepository.toDoc
// (src/data/audit-repo.ts:361-372): `localId` repeats the document's own ULID
// `_id` just as the audit body repeats its entry id — and here that id is also
// `record.id`, the ordering/cursor key, so it is not stored a third time. `seq`
// is persisted as a plain display field (see fromDoc).
function toDoc(docId: string, record: LogRecord): Record<string, unknown> {
  return {
    resourceType: RESOURCE_TYPE,
    localId: docId,
    seq: record.seq,
    timestamp: record.timestamp,
    message: record.message,
    ...(record.level !== undefined ? { level: record.level } : {}),
    ...(record.category !== undefined ? { category: record.category } : {})
  };
}

// Rebuild a LogRecord from its document, or undefined when the document cannot
// be read as one. Optional fields are OMITTED (not set to undefined) when
// absent, so a round-tripped record is identical to what `append()` returned and
// the route's `level`/`category` optionals behave as before
// (src/routes/logs.ts:44-52).
function fromDoc(doc: StoredDoc): LogRecord | undefined {
  // The document `_id` IS the record id and the ordering/cursor key — it is what
  // CouchDB itself orders the partition by, so it is read from `_id` rather than
  // from the `localId` copy in the body, which could in principle disagree.
  const id = doc._id;
  const seq = Number(doc['seq']);
  const timestamp = doc['timestamp'];
  const message = doc['message'];
  if (
    typeof id !== 'string' ||
    id.length === 0 ||
    !Number.isFinite(seq) ||
    typeof timestamp !== 'string' ||
    typeof message !== 'string'
  ) {
    return undefined;
  }
  const level = doc['level'];
  const category = doc['category'];
  return {
    id,
    seq,
    timestamp,
    message,
    // Only the values in LOG_LEVELS are admissible — the route serialises
    // `level` as `z.enum(LOG_LEVELS)` (src/routes/logs.ts:50), so a stray value
    // would fail response validation for the whole page.
    ...(isLogLevel(level) ? { level } : {}),
    ...(typeof category === 'string' ? { category } : {})
  };
}

function isLogLevel(value: unknown): value is LogLevel {
  return typeof value === 'string' && (LOG_LEVELS as readonly string[]).includes(value);
}
