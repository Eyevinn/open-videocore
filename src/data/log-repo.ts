// Durable operational log store over CouchDB (issue #996, parent #985).
//
// #473 shipped the operational log stream behind a process-local array
// (InMemoryLogStore, src/services/log-store.ts), so every restart emptied the
// tab whose purpose is reviewing what happened before an incident. This module
// persists the same records to the per-stack CouchDB the rest of this class of
// record already lives in (ADR-001 metadata store; the partition is covered by
// the existing daily CouchDB backup schedule), following the audit store's
// document pattern rather than introducing a new store.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Document pattern being followed — fresh ULID `_id` per immutable entry, a
//     `resourceType` discriminator, `localId` echoed in the body, `toDoc`/
//     `fromDoc` mapping, `find({ resourceType }, { limit })` reads, a bounded
//     fetch cap, and a zod parse on read: CouchAuditRepository
//     (src/data/audit-repo.ts:192-299), toDoc/fromDoc
//     (src/data/audit-repo.ts:361-384).
//   - `schemaVersion: 1` on the persisted body plus the READ RULE that
//     schemaVersion is INJECTED at parse time, not read from the stored body:
//     src/data/couch-asset-repo.ts:806-820 and src/data/couch-search-repo.ts:159-166.
//   - StackCouch surface used here: `put(localId, body)` (src/data/couchdb.ts:29),
//     `find(selector, { limit, skip })` (src/data/couchdb.ts:66) — Mango
//     selector, no `sort` support, so ordering is done in the application layer
//     exactly as audit does.
//   - Store contract implemented: `LogStore` (append/list/size) and the shared
//     pure query engine `applyLogQuery` + cursor codec,
//     src/services/log-store.ts.
//   - PUBLIC contract that must NOT change: `{ items, nextCursor }` with
//     `{ seq, timestamp, message, level?, category? }` records and
//     `limit`/`cursor`/`from`/`to`/`q`/`order` params — src/routes/logs.ts:34-64.
//     Unchanged by this module: the route and its zod schemas are untouched.
//
// Append-only, exactly like the audit partition (ADR-005 "append, never rewrite
// history"): every append mints a brand-new ULID document and never carries a
// `_rev` forward, so a written entry cannot be overwritten by application code.
// There is no update and no delete path here.
//
// ---------------------------------------------------------------------------
// TWO KNOWN GAPS (review findings on #996), both deliberately left as follow-ups
// because neither is contained to this module. Recorded here with the exact
// symbols a follow-up would reuse, so nobody has to rediscover them.
//
// 1. NO MANGO INDEX BACKS THESE READS. Every `couch.find` below (the `seq`
//    window in `list`, and `existsAboveSeq` on the probe + freshness paths) is a
//    selector with no matching index, so CouchDB falls back to the all-docs
//    index and scans the whole database per call, warning "no matching index
//    found". The right index is a composite on `['resourceType', 'seq']`
//    (resourceType first — it is the equality term; `seq` second — it carries
//    the range), which makes both the window read and the `limit: 1` existence
//    probe index-only.
//    Why not here: `StackCouch` (src/data/couchdb.ts:22) exposes put/get/list/
//    find/count/remove and NO index-creation primitive, and nothing in this repo
//    creates a Mango index or a `_design` document today — the pre-existing audit
//    partition reads the same unindexed way (`find({ resourceType })`,
//    src/data/audit-repo.ts:295). So adding one means a new shared StackCouch
//    primitive plus deciding WHERE ddocs get provisioned for a per-stack
//    database, which is an architecture + stack-provisioning call, not a
//    log-store call. It should be fixed once, for every partition, not smuggled
//    in here for one.
//    Logged as OSC-adjacent friction per CLAUDE.md rule 6 (there is no index /
//    `_design` provisioning primitive for an OSC-provisioned CouchDB instance,
//    and no decided home for design documents on a per-stack database):
//    docs/osc-feedback/incoming-couchdb-mango-index-provisioning.md in the agent
//    repo.
//    Bounded in the meantime: `list` reads at most
//    LOG_MAX_SCAN_WINDOWS * LOG_SCAN_WINDOW documents per call and
//    `existsAboveSeq` at most 1, so the RESULT size is bounded even though the
//    scan is not.
//
// 2. NO RETENTION / PURGE PATH FOR THIS PARTITION. The partition grows for the
//    lifetime of the deployment. The in-memory sibling is capped
//    (LOG_STORE_MAX_RECORDS, src/services/log-store.ts), but that cap is about
//    process memory and deliberately does not apply to a durable store, so there
//    is currently nothing that ages a persisted log entry out.
//    The precedent to copy is audit-log retention, which solved exactly this for
//    the sibling append-only partition: ADR-021
//    (docs/architecture/ADR-021-audit-log-retention.md), boot config via env
//    (`AUDIT_RETENTION_MS`, unset/0/negative = never purge),
//    `AuditRetentionRepository` (src/data/audit-repo.ts:180),
//    `purgeExpiredAuditEntries` (src/pipeline/audit-retention-purge-sweep.ts)
//    and its loop (src/pipeline/audit-retention-purge-loop.ts).
//    Why not here: that is a new config surface (a `LOG_RETENTION_MS` env var),
//    a new sweep + loop, and a retention-window policy decision — an ADR-level
//    choice, and ADR-021 shows the repo treats it as one.
//    NOTE for whoever picks it up: purging breaks this store's gap-free `seq`
//    premise at the OLD end of the stream. `list`'s window arithmetic already
//    tolerates missing seqs inside a window, but `probeMaxSeq` must keep being
//    the authority for the HEAD of the stream (it already is), and `size()`
//    below would stop being the record count once entries are removed.
// ---------------------------------------------------------------------------

import { z } from 'zod';
import { ulid } from 'ulid';
import type { StoredDoc, StackCouch } from './couchdb.js';
import {
  LOG_LEVELS,
  applyLogQuery,
  buildLogRecord,
  clampLogLimit,
  decodeLogCursor,
  encodeLogCursor,
  type AppendLogInput,
  type ListLogsOptions,
  type ListLogsResult,
  type LogRecord,
  type LogStore,
  type SequencedLogRecord
} from '../services/log-store.js';

// resourceType discriminator for the log partition — mirrors the
// per-resource-type convention ('audit-entry', src/data/audit-repo.ts:36).
export const LOG_RESOURCE_TYPE = 'log-entry';

// Explicit integer schema version for forward migration, as carried by the asset
// document (src/data/asset-document.ts:279). Additive optional fields do NOT bump
// this.
export const LOG_SCHEMA_VERSION = 1;

// The persisted document body. Parsed on read so a malformed/foreign document
// cannot reach the wire contract.
const LogEntryDocumentSchema = z.object({
  resourceType: z.literal(LOG_RESOURCE_TYPE),
  schemaVersion: z.literal(LOG_SCHEMA_VERSION),
  // The document's own ULID id, echoed into the body like audit's `localId`
  // (src/data/audit-repo.ts:365).
  localId: z.string().min(1),
  // Monotonic, gap-free sequence number — the pagination key of the public
  // contract (src/routes/logs.ts:34-42).
  seq: z.number().int().positive(),
  timestamp: z.string().min(1),
  message: z.string(),
  level: z.enum(LOG_LEVELS).optional(),
  category: z.string().optional()
});

export type CouchFactory = () => StackCouch;

// How many records ONE window of a `list()` call materialises before the shared
// in-process filter/sort/paginate runs. A whole `seq` window is read in a single
// `find`, so this is both the Mango `limit` and the window width. Chosen well
// above LOG_MAX_LIMIT (200, src/services/log-store.ts) so sparse filters still
// fill a page from one round trip, while keeping any single read bounded (the
// audit partition takes the same "bounded fetch, then filter in the application
// layer" approach, src/data/audit-repo.ts:301-305).
//
// The `seq` range is gap-free and exactly LOG_SCAN_WINDOW wide, so at most
// LOG_SCAN_WINDOW documents can match it: the Mango `limit` can never truncate a
// window and hide an entry.
const LOG_SCAN_WINDOW = 1000;

// How many windows ONE `list()` call may walk before it gives up and hands back
// a window-edge cursor (review finding on #996). `list` used to scan exactly one
// window and then filter in process, so a filtered page whose only match sat
// beyond that window returned `{ items: [], nextCursor: <edge> }` — and the UI
// rendered "no entries match" while a match existed one window further down.
// Advancing internally fixes that for any realistic filter; the cap keeps a
// single request bounded (at most LOG_MAX_SCAN_WINDOWS * LOG_SCAN_WINDOW
// documents read) instead of walking an arbitrarily long partition inside one
// HTTP request. Hitting the cap is not a dead end: the edge cursor resumes the
// walk exactly where it stopped, and the page is still marked "keep paging".
const LOG_MAX_SCAN_WINDOWS = 10;

// Upper bound on the exponential/binary probe below, so a corrupt `seq` cannot
// spin the doubling loop forever. 2^45 entries is unreachable in practice.
const MAX_PROBE_DOUBLINGS = 45;

// Durable, append-only operational log store over the per-stack CouchDB.
//
// Sequence numbers. The public contract's `seq` is a monotonic, gap-free integer
// and the ONLY pagination key, so it has to keep counting across restarts rather
// than restarting at 1 (which would make old cursors point into the middle of
// the new stream). On the first append/list after boot the store recovers the
// high-water mark straight from the partition (`probeMaxSeq`) and counts on from
// there in memory.
//
// `seq` IS NOT GLOBALLY UNIQUE, and the read path does not assume it is (review
// finding, #996 — the earlier "race-free within one process" claim here was
// wrong and has been removed).
//
// Why it was wrong: a store instance is not process-wide. WorkspaceConnections
// is cached for only CACHE_TTL_MS (5 min, src/services/workspace-stack.ts:70)
// and every rebuild mints a fresh `new CouchLogStore(wc)`
// (src/services/workspace-stack.ts:235) whose `highWater` starts `undefined`.
// So within ONE process, across a cache expiry, two live instances over the same
// partition both recover the same mark and both issue seq N — no second API
// process required (and ADR-020's one-instance-per-tenant deployment model does
// nothing to prevent it). A replayed backup or a genuinely second writer
// produces the same duplicate.
//
// What that used to break: entries are distinct ULID documents, so neither is
// overwritten, but the cursor WAS a bare `seq` boundary and `applyLogQuery`
// resumes strictly past the boundary — so a duplicated N landing on a page
// boundary made the second entry with seq N unreachable by paging. A silent read
// loss, not a cosmetic tie.
//
// FIXED by making the cursor a composite `(seq, document ULID)` boundary
// (`encodeLogCursor`/`decodeLogCursor`/`applyLogQuery`,
// src/services/log-store.ts): ULIDs are unique and lexicographically sortable,
// so `(seq, id)` is a total order even when `seq` repeats, and paging resumes
// strictly past that composite rather than past the whole `seq`. Both backends
// run the same engine, so neither can drift. The cursor is opaque to callers
// (src/routes/logs.ts), so this is NOT a public contract change, and a legacy
// bare-`seq` token still decodes and still behaves as it did.
//
// STILL OPEN, deliberately: `seq` remains per-instance, so a duplicate is
// possible and the numbers are therefore not a global ordinal — only a
// pagination axis, which is all the public contract uses them for. If a future
// mode needs globally unique numbers, allocate `seq` from a single CAS'd counter
// document using `updateWithRetry` + `isUpdateConflict`
// (src/data/couchdb.ts:171,118) — the read-modify-write-with-409-retry primitive
// #278 added. Not done here: it costs a get+put on every append, on a path that
// is fire-and-forget by design, and the composite cursor already removes the
// read loss that made duplicates dangerous.
export class CouchLogStore implements LogStore {
  // Highest `seq` known to exist in the partition. `undefined` until recovered.
  private highWater: number | undefined;
  // In-flight recovery, shared so concurrent first callers probe only once.
  private probe: Promise<number> | undefined;

  constructor(private readonly couchFor: CouchFactory) {}

  // Append one record: mint the next `seq`, then write a brand-new ULID
  // document with NO `_rev` — a fresh document every time, never a
  // read-modify-write, so prior entries are untouched (append-only, ADR-005).
  async append(input: AppendLogInput): Promise<LogRecord> {
    const couch = this.couchFor();
    await this.recoverHighWater(couch);
    // No `await` between reading and incrementing, so two concurrent appends in
    // this process cannot take the same number.
    const seq = (this.highWater ?? 0) + 1;
    this.highWater = seq;
    const record = buildLogRecord(input, seq);
    const id = ulid();
    await couch.put(id, toDoc(id, record));
    return { ...record };
  }

  // Number of records in the partition. Observability/tests only (the listing
  // endpoint returns no total). Reported as the high-water mark, which is the
  // record count because the stream is append-only — nothing in this module
  // removes an entry — and `seq` starts at 1.
  //
  // Caveat, since this is the one place it leaks: a `seq` is claimed BEFORE the
  // document write, so an append whose `couch.put` fails leaves its number
  // consumed and the mark one ahead of the documents that exist. Harmless for
  // the read path (`list`'s window simply finds no document at that `seq`, and
  // `applyLogQuery` pages over the hole) and for a fire-and-forget producer,
  // but it means this is an upper bound, not an exact count, after a failed
  // write.
  async size(): Promise<number> {
    return this.currentMaxSeq(this.couchFor());
  }

  // One cursor-paged page, with the SAME semantics the in-memory store has —
  // both run the identical `applyLogQuery` engine, so filtering, ordering and
  // cursor handling cannot drift (src/services/log-store.ts).
  //
  // The stream is walked in bounded `seq` windows, in the paging direction, from
  // the cursor boundary. CouchDB Mango exposes no `sort` through StackCouch.find
  // (src/data/couchdb.ts:66), so a window is selected by `seq` range — cheap and
  // exact, because `seq` is gap-free — and ordered in process.
  //
  // KEEPS ADVANCING until the page is full (review finding on #996). One window
  // is not enough when a filter is sparse: `from`/`to`/`q` are applied after the
  // window is materialised, so a single-window read returned an EMPTY page for a
  // match sitting one window further along, and the UI then said "no entries
  // match" about a stream that contained one. This loop keeps opening the next
  // window until the page is filled, the stream is exhausted in this direction,
  // or LOG_MAX_SCAN_WINDOWS windows have been read in this one call.
  //
  // When the walk stops with unscanned `seq` space still ahead of it, the
  // returned `nextCursor` is anchored at the window edge instead of null. That
  // keeps the documented contract ("null `nextCursor` marks the last page",
  // src/routes/logs.ts:79-87) honest: a short page with a cursor means "keep
  // paging", never "the stream ended". The frontend reads it that way too — an
  // empty page WITH a cursor is rendered as "keep paging", not as "no match"
  // (public/logs-table.js, public/ops-ui-table.js).
  async list(opts: ListLogsOptions = {}): Promise<ListLogsResult> {
    const couch = this.couchFor();
    const maxSeq = await this.currentMaxSeq(couch);
    if (maxSeq === 0) {
      return { items: [], nextCursor: null };
    }

    const order = opts.order === 'asc' ? 'asc' : 'desc';
    const limit = clampLogLimit(opts.limit);
    const boundary = decodeLogCursor(opts.cursor);
    // Pre-filter pushed into the Mango selector. Never NARROWER than the
    // in-process filter (see logMangoFilter), so it can only reduce transfer.
    const mangoFilter = logMangoFilter(opts);

    // Outer edge, inclusive, of the next window to read. The cursor's own `seq`
    // is INCLUDED rather than stepped past: a `seq` can repeat (see
    // SequencedLogRecord, src/services/log-store.ts), and it is `applyLogQuery`
    // that excludes the exact boundary RECORD by its composite `(seq, id)` key.
    // Stepping past the whole `seq` here is what used to lose a tied entry.
    let frontier =
      order === 'desc'
        ? boundary === undefined
          ? maxSeq
          : Math.min(maxSeq, boundary.seq)
        : boundary === undefined
          ? 1
          : Math.max(1, boundary.seq);
    const streamRemains = (): boolean => (order === 'desc' ? frontier >= 1 : frontier <= maxSeq);

    const scanned: SequencedLogRecord[] = [];
    let page: ListLogsResult = { items: [], nextCursor: null };

    for (let window = 0; window < LOG_MAX_SCAN_WINDOWS && streamRemains(); window += 1) {
      const lo = order === 'desc' ? Math.max(1, frontier - LOG_SCAN_WINDOW + 1) : frontier;
      const hi = order === 'desc' ? frontier : Math.min(maxSeq, frontier + LOG_SCAN_WINDOW - 1);

      const docs = await couch.find(
        { resourceType: LOG_RESOURCE_TYPE, seq: { $gte: lo, $lte: hi }, ...mangoFilter },
        { limit: LOG_SCAN_WINDOW }
      );
      for (const doc of docs) {
        if (doc.resourceType === LOG_RESOURCE_TYPE) scanned.push(fromDoc(doc));
      }
      // This window is now fully accounted for; the next one starts past it.
      frontier = order === 'desc' ? lo - 1 : hi + 1;

      // Re-run the shared engine over everything scanned so far. Windows are
      // disjoint and walked in order, so the union is exactly the prefix of the
      // stream this call has seen.
      page = applyLogQuery(scanned, opts);
      if (page.items.length >= limit) break;
    }

    if (page.nextCursor !== null) {
      // More matches inside what we scanned: the composite cursor the engine
      // produced already points at the right boundary record.
      return page;
    }
    if (!streamRemains()) {
      // Walked to the end of the stream in this direction: a null cursor here is
      // the truth, not a window artefact.
      return page;
    }
    // Stopped with stream left (page full, or the window budget ran out). Anchor
    // on the edge of the last window read — an id-less `seq` boundary, so the
    // next call resumes strictly past the whole of that `seq`, which is sound
    // precisely because every entry at that `seq` was in a window we scanned.
    const edgeSeq = order === 'desc' ? frontier + 1 : frontier - 1;
    return { items: page.items, nextCursor: encodeLogCursor(edgeSeq) };
  }

  // The highest `seq` the partition holds right now, for the read path.
  //
  // The cached mark only tracks OUR OWN appends, so a reader has to allow for
  // entries written by someone else (a second API process, a replayed backup, a
  // restart's worth of history recovered by another instance). One `limit: 1`
  // "anything above the mark?" probe per read keeps the window anchored at the
  // true head of the stream; the full O(log n) probe runs only when that cheap
  // check says the mark is behind.
  private async currentMaxSeq(couch: StackCouch): Promise<number> {
    await this.recoverHighWater(couch);
    if (await existsAboveSeq(couch, this.highWater ?? 0)) {
      this.highWater = await probeMaxSeq(couch);
    }
    return this.highWater ?? 0;
  }

  // Recover (once per instance) the highest `seq` already persisted, so appends
  // continue the sequence after a restart instead of colliding with history.
  private async recoverHighWater(couch: StackCouch): Promise<void> {
    if (this.highWater !== undefined) return;
    this.probe ??= probeMaxSeq(couch);
    const probed = await this.probe;
    // An append may have landed while the probe was in flight; never go
    // backwards.
    this.highWater = Math.max(this.highWater ?? 0, probed);
  }
}

// Pre-filter for the window read, pushed into the Mango selector so CouchDB
// drops non-matching documents before they cross the wire (review finding on
// #996: a sparse filter used to pull a whole window back and discard it in
// process).
//
// HARD INVARIANT: this selector must never be NARROWER than the in-process
// filter in `applyLogQuery` (src/services/log-store.ts). A narrower pushdown
// hides a matching entry, which is the exact silent-drop failure this fix is
// about, so each term here is only pushed down when it provably agrees with the
// in-process comparison:
//   - `q` -> `message: { $regex }`. The in-process test is
//     `message.toLowerCase().includes(q.toLowerCase())`, so the pattern is the
//     query escaped to a literal with the case-insensitive inline flag. Pushed
//     down ONLY for printable-ASCII queries, where `(?i)` and `toLowerCase()`
//     agree by construction; anything else (non-ASCII case folding differs
//     between the two engines) is left to the in-process filter alone.
//   - `from`/`to` are deliberately NOT pushed down. The in-process test is a
//     plain lexicographic string comparison, while Mango compares strings with
//     CouchDB's own collation; the two agree for identically formatted ISO
//     instants but are not guaranteed to for mixed-offset timestamps, and a
//     disagreement at the boundary would drop a matching entry. The `seq`
//     window already bounds the read, so the pushdown would buy little.
function logMangoFilter(opts: ListLogsOptions): Record<string, unknown> {
  const q = opts.q;
  if (q === undefined || q === '' || !isPrintableAscii(q)) return {};
  return { message: { $regex: `(?i)${escapeRegExpLiteral(q)}` } };
}

function isPrintableAscii(value: string): boolean {
  return /^[ -~]*$/.test(value);
}

// Escape every regex metacharacter so the query is matched as a literal
// substring, exactly as `String.includes` does in process.
function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Highest persisted `seq` in the log partition, or 0 when the partition is
// empty.
//
// StackCouch.find exposes no `sort` (src/data/couchdb.ts:66-76), so "the newest
// entry" cannot simply be read off a descending scan. Instead this asks a
// yes/no question — "does any entry exist above N?" — with a `limit: 1` Mango
// probe, and brackets the answer by doubling and then bisecting. That is
// O(log n) tiny round trips, versus paging the whole partition to its tail.
//
// How often it runs: once per store instance to recover the mark after boot
// (`recoverHighWater`), and again on a read whose cheap `existsAboveSeq` check
// says the cached mark is behind — i.e. whenever someone else has appended. NOT
// once per process: a new store instance is minted whenever the
// WorkspaceConnections cache is rebuilt (src/services/workspace-stack.ts:235).
async function probeMaxSeq(couch: StackCouch): Promise<number> {
  // `seq` starts at 1, so "something above 0" means "the partition is non-empty".
  if (!(await existsAboveSeq(couch, 0))) return 0;

  // Invariant: an entry exists above `lo`, and none exists above `hi`.
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < MAX_PROBE_DOUBLINGS && (await existsAboveSeq(couch, hi)); i += 1) {
    lo = hi;
    hi *= 2;
  }
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await existsAboveSeq(couch, mid)) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return hi;
}

// Does the log partition hold any entry with a `seq` above `n`? One `limit: 1`
// Mango read — the single primitive both the probe and the read path's freshness
// check are built from.
async function existsAboveSeq(couch: StackCouch, n: number): Promise<boolean> {
  const docs = await couch.find(
    { resourceType: LOG_RESOURCE_TYPE, seq: { $gt: n } },
    { limit: 1 }
  );
  return docs.some((d) => d.resourceType === LOG_RESOURCE_TYPE);
}

// Map a LogRecord to its persisted document body. Mirrors the
// resourceType + localId + flat-body shape of audit's toDoc
// (src/data/audit-repo.ts:361-372), plus the explicit `schemaVersion` the asset
// document carries (src/data/asset-document.ts:452). `id` is the fresh ULID the
// document is written under, echoed into the body as `localId`.
function toDoc(id: string, record: LogRecord): Record<string, unknown> {
  return {
    resourceType: LOG_RESOURCE_TYPE,
    schemaVersion: LOG_SCHEMA_VERSION,
    localId: id,
    seq: record.seq,
    timestamp: record.timestamp,
    message: record.message,
    ...(record.level !== undefined ? { level: record.level } : {}),
    ...(record.category !== undefined ? { category: record.category } : {})
  };
}

// Rebuild the wire record from a persisted document.
//
// READ RULE, as for assets (src/data/couch-asset-repo.ts:806-820): the
// `schemaVersion` is INJECTED at parse time rather than read from the stored
// body, so a document written before the field existed still deserializes.
// `localId` falls back to the document `_id` the same way audit's fromDoc does
// (src/data/audit-repo.ts:376).
// The document ULID is carried through as the record's internal `id`, which is
// the tie-break half of the composite cursor (`SequencedLogRecord`,
// src/services/log-store.ts). It is stripped again by `applyLogQuery` and never
// reaches the wire.
function fromDoc(doc: StoredDoc): SequencedLogRecord {
  const parsed = LogEntryDocumentSchema.parse({
    ...doc,
    resourceType: LOG_RESOURCE_TYPE,
    schemaVersion: LOG_SCHEMA_VERSION,
    localId: String(doc['localId'] ?? doc._id)
  });
  return {
    id: parsed.localId,
    seq: parsed.seq,
    timestamp: parsed.timestamp,
    message: parsed.message,
    ...(parsed.level !== undefined ? { level: parsed.level } : {}),
    ...(parsed.category !== undefined ? { category: parsed.category } : {})
  };
}
