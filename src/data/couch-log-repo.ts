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
//   - Read primitive: `couch.find({ resourceType }, { limit })` with a finite
//     fetch cap, then filter/paginate in the application layer so the wire
//     contract never leaks the Mango selector — src/data/audit-repo.ts:293-298.
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

import { monotonicFactory } from 'ulid';
import type { StackCouch, StoredDoc } from './couchdb.js';
import {
  applyLogQuery,
  LOG_LEVELS,
  LOG_STORE_MAX_RECORDS,
  type AppendLogInput,
  type ListLogsOptions,
  type ListLogsResult,
  type LogLevel,
  type LogReader,
  type LogRecord,
  type LogStoreOptions
} from '../services/log-store.js';

// resourceType discriminator for the log partition — mirrors the
// per-resource-type convention ('audit-entry' at src/data/audit-repo.ts:36,
// 'collection' at src/data/couch-collection-repo.ts:25).
const RESOURCE_TYPE = 'log-entry';

const SELECTOR: Record<string, unknown> = { resourceType: RESOURCE_TYPE };

export type CouchFactory = () => StackCouch;

// Upper bound on documents a single `list()` pulls before filtering. Mirrors
// AUDIT_FETCH_CAP (src/data/audit-repo.ts:305) so one huge partition cannot
// produce an unbounded read. It is deliberately LARGER than the retained-record
// cap below: because the Mango scan returns the OLDEST documents first, the
// retained window must fit inside this cap for a newest-first page to be
// correct, which the cap + eviction below guarantees.
export const LOG_FETCH_CAP = 10_000;

// Page size and page bound for the one-time high-water-mark scan. 20 pages of
// 1000 covers four times the retained cap, which bounds the scan even against a
// partition that predates the cap being enforced.
const INIT_PAGE_SIZE = 1000;
const MAX_INIT_PAGES = 20;

// Most documents a single append will evict. Keeps one append's work bounded
// when the retained count starts far above the cap; the remaining overflow is
// trimmed by the following appends.
const MAX_EVICTIONS_PER_APPEND = 50;

// Document-id minter: ULID, as CouchAuditRepository mints it
// (src/data/audit-repo.ts:202), but through `monotonicFactory()` rather than the
// bare `ulid()` the audit store calls.
//
// This is a deliberate, necessary divergence. Plain `ulid()` randomises the
// low bits, so two ids minted inside the SAME millisecond are not ordered by
// mint time. Audit entries tolerate that (they are sorted by their own `at` /
// id, and nothing evicts them by id order). A pipeline run appends ~8 log
// records back-to-back, several of them inside one millisecond, and BOTH
// id-ordered paths here depend on "ascending `_id` == append order": the
// high-water-mark scan and, critically, the oldest-first eviction — which with
// random intra-millisecond ids would delete the NEWEST records of a burst
// instead of the oldest. `monotonicFactory()` guarantees strictly increasing
// ids within this process, which restores that invariant. Module-level (not
// per-instance) so every store in the process shares one monotonic sequence.
const nextDocId = monotonicFactory();

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
  // evicted once the partition exceeds the cap. Here it is not a memory bound
  // but a READ-CORRECTNESS bound: `list()` pulls the partition oldest-first up
  // to LOG_FETCH_CAP, so the retained window has to fit inside that cap for the
  // newest-first page to contain the newest records. It also keeps the daily
  // CouchDB backup from growing without limit behind a busy pipeline producer.
  private readonly maxRecords: number;

  // In-process sequence allocator, seeded ONCE from the highest `seq` already
  // persisted (see loadHighWaterMark). This is what makes `seq` survive a
  // restart: a fresh process continues the sequence where the stored records
  // left off instead of restarting at 1 and colliding with history. Increments
  // are synchronous, so concurrent appends inside one process cannot share a
  // `seq`. Two processes writing the SAME stack concurrently can mint the same
  // `seq` (there is no cross-process allocator); the blast radius is two records
  // sharing a sequence number at a page boundary, not a lost or overwritten
  // record — every record is its own document under its own ULID id.
  private seq = 0;

  // Documents believed to be in the partition, seeded by the same scan and
  // maintained locally thereafter. Only drives eviction, so an approximation
  // under concurrent writers is acceptable: the next append re-trims.
  private retained = 0;

  // Memoised seed. Cleared on failure so a transient CouchDB error does not
  // permanently wedge the allocator at 0.
  private seeding: Promise<void> | undefined;

  constructor(
    private readonly couchFor: CouchFactory,
    opts: LogStoreOptions = {}
  ) {
    this.maxRecords = Math.max(
      1,
      Math.trunc(
        opts.maxRecords !== undefined && Number.isFinite(opts.maxRecords)
          ? opts.maxRecords
          : LOG_STORE_MAX_RECORDS
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
    const record: LogRecord = {
      seq: ++this.seq,
      timestamp: input.timestamp ?? new Date().toISOString(),
      message: input.message,
      ...(input.level !== undefined ? { level: input.level } : {}),
      ...(input.category !== undefined ? { category: input.category } : {})
    };
    // Fresh ULID document id, carried into the body as `localId` — the exact
    // id shape CouchAuditRepository.record writes (src/data/audit-repo.ts:202,
    // 213 with toDoc's `localId: entry.id`), minted monotonically (see
    // nextDocId).
    const docId = nextDocId();
    await couch.put(docId, toDoc(docId, record));
    this.retained += 1;
    // Keep the retained window inside the cap. Best-effort: a failed eviction
    // must not fail the append that triggered it (the record is already
    // durable), so it is swallowed here and retried by the next append.
    try {
      await this.evictOverflow(couch);
    } catch {
      // Intentionally ignored — see above.
    }
    return { ...record };
  }

  // The GET /api/v1/logs read path. Pulls the retained window through the same
  // `couch.find({ resourceType }, { limit })` primitive the audit query uses
  // (src/data/audit-repo.ts:293-298), then applies the SHARED pure query so the
  // filters, sort, cursor semantics and `{ items, nextCursor }` envelope are
  // byte-for-byte the in-memory store's (src/services/log-store.ts,
  // `applyLogQuery`). Read-only: never writes.
  async list(opts: ListLogsOptions = {}): Promise<ListLogsResult> {
    const couch = this.couchFor();
    const docs = await couch.find(SELECTOR, { limit: LOG_FETCH_CAP });
    const records: LogRecord[] = [];
    for (const doc of docs) {
      if (doc.resourceType !== RESOURCE_TYPE) continue;
      const record = fromDoc(doc);
      // A single unreadable document must not make the whole operational log
      // unreadable: it is skipped rather than thrown, unlike the audit read
      // path's strict `AuditEntrySchema.parse` (src/data/audit-repo.ts:375).
      // An audit entry is evidence about one resource; this is an incident tail
      // an operator reads under pressure.
      if (record) records.push(record);
    }
    return applyLogQuery(records, opts);
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
// `_id` just as the audit body repeats its entry id. `seq` is the log record's
// own pagination key and is stored as its own field.
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
  const seq = Number(doc['seq']);
  const timestamp = doc['timestamp'];
  const message = doc['message'];
  if (!Number.isFinite(seq) || typeof timestamp !== 'string' || typeof message !== 'string') {
    return undefined;
  }
  const level = doc['level'];
  const category = doc['category'];
  return {
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
