// Operational-log retention purge sweep (issue #1067, mirrors the audit-log
// retention sweep #566 and, behind it, the archived-asset purge lifecycle
// #327/#323).
//
// A bounded background sweep that expires log records aged past the retention
// window. The persisted log partition (CouchLogStore,
// src/data/couch-log-repo.ts, issue #996) shipped with NO retention path at all:
// its only removal path bounds the record COUNT (the retained-window eviction,
// `evictOverflow`), which says nothing about record AGE — an operator who wants
// "keep 30 days" had no way to ask for it, and a quiet deployment keeps its
// oldest records indefinitely. This sweep is the age half of that pair, and the
// two are complementary, not alternatives.
//
// It DELIBERATELY MIRRORS — and is cleanly SEPARABLE from —
// purgeExpiredAuditEntries (src/pipeline/audit-retention-purge-sweep.ts): a pure
// `deps`-driven function returning a small `{ scanned, purged }` summary,
// BEST-EFFORT per record (one record's failure is logged and skipped and never
// aborts the run), disabled when the window is unset (retentionMs <= 0). It is
// NOT a parallel mechanism: the ONLY differences are the store it drives (the
// log partition, not the audit partition) and the field expiry is measured from
// (`timestamp` on a LogRecord, where an audit entry carries `at`). Log volume is
// far higher than audit volume — the pipeline producer writes ~8 records per
// asset run (src/services/pipeline-log.ts) — which is why the log partition
// needs this at least as much as the audit partition did.
//
// RETENTION DECISION: default OFF, as for audit (ADR-021
// docs/architecture/ADR-021-audit-log-retention.md) and for archived assets
// (ARCHIVE_RETENTION_MS / RETENTION_DISABLED_MS, src/routes/retention.ts). An
// unset/0 window means indefinite retention, behaviourally identical to today
// (#996 shipped no expiry path), so no existing deployment loses a record by
// upgrading.
//
// APPEND-ONLY-UNTIL-PURGE: purge is whole-record expiry, NEVER an in-place edit.
// A record is either present verbatim or gone. `purgeEntry`
// (LogRetentionStore, src/services/log-store.ts) is the only path this sweep
// uses; there is no update/rewrite anywhere on the log stores.
//
// ELIGIBILITY: a record is expired when now - Date.parse(record.timestamp) >
// retentionMs. `timestamp` is the ISO-8601 append instant on the record
// (LogRecord.timestamp, src/services/log-store.ts). An unparseable stamp is
// refused (never purged), mirroring the audit sweep's guard on an unparseable
// `at`.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Result/skip-never-abort/disabled-window shape + paged oldest-first walk +
//     the offset advance past survivors: purgeExpiredAuditEntries,
//     src/pipeline/audit-retention-purge-sweep.ts.
//   - Log enumerate (oldest-first page) + whole-record purge:
//     `LogRetentionStore.listOldestPage` / `.purgeEntry`,
//     src/services/log-store.ts; implemented by CouchLogStore
//     (src/data/couch-log-repo.ts) and the in-memory LogStore.
//   - LogRecord.timestamp / .id shape: `LogRecord`, src/services/log-store.ts.

import type { LogRecord, LogRetentionStore } from '../services/log-store.js';

type Logger = {
  info?(...a: unknown[]): void;
  warn?(...a: unknown[]): void;
};

// How many log records to enumerate per page. The store paginates
// (listOldestPage(limit/offset)), so the sweep pages oldest-first until it
// reaches a record still inside the window — this bounds each read while
// covering the whole aged tail. Same value as SCAN_PAGE_SIZE in the audit sweep.
const SCAN_PAGE_SIZE = 200;

// The minimal log-store surface the sweep needs. Structurally the shared
// `LogRetentionStore` (src/services/log-store.ts), re-exported under a
// sweep-scoped alias so the sweep can be driven by an injected fake without a
// live CouchDB, exactly as the audit sweep's `AuditRetentionStore` is.
export type LogRetentionSweepStore = LogRetentionStore;

export type PurgeExpiredLogRecordsDeps = {
  // Read + expire side: enumerate (paged, oldest-first) and whole-record purge.
  logs: LogRetentionSweepStore;
  // Retention window in ms. 0 / negative means disabled (never purge =
  // indefinite retention); the loop skips the sweep entirely when unset, but
  // this is also enforced here so a direct call is safe. Mirrors the audit
  // sweep's retentionMs guard exactly.
  retentionMs: number;
  // Injectable clock so the expiry check is deterministic in tests.
  now?: () => number;
  logger?: Logger;
};

export type PurgeExpiredLogRecordsResult = {
  scanned: number;
  purged: number;
};

// Enumerate aged log records (oldest-first) and purge every one past the
// retention window. Best-effort per record: one record's error is logged and
// skipped and never aborts the run. Because records are visited oldest-first,
// the walk STOPS at the first record still inside the window (every later record
// is younger and therefore also inside it), bounding the scan to the aged tail.
export async function purgeExpiredLogRecords(
  deps: PurgeExpiredLogRecordsDeps
): Promise<PurgeExpiredLogRecordsResult> {
  const now = deps.now ?? (() => Date.now());

  // Disabled window -> never purge (indefinite retention). Behaviourally
  // identical to today, matching the audit sweep's disabled guard.
  if (!Number.isFinite(deps.retentionMs) || deps.retentionMs <= 0) {
    return { scanned: 0, purged: 0 };
  }

  const cutoff = now() - deps.retentionMs;

  let scanned = 0;
  let purged = 0;
  let offset = 0;

  for (;;) {
    const page: LogRecord[] = await deps.logs.listOldestPage({
      limit: SCAN_PAGE_SIZE,
      offset
    });
    if (page.length === 0) {
      break;
    }

    let reachedWindow = false;
    let purgedInPage = 0;

    for (const record of page) {
      scanned += 1;

      // Expiry measured from the record's append instant (`timestamp`). An
      // unparseable stamp is refused (never purged), as the audit sweep refuses
      // an unparseable `at`.
      const atMs = Date.parse(record.timestamp);
      if (Number.isNaN(atMs)) {
        deps.logger?.warn?.(
          '[log-retention-purge] record %s has an unparseable timestamp %o — refusing to purge',
          record.id,
          record.timestamp
        );
        continue;
      }
      if (atMs > cutoff) {
        // Inside the window. Oldest-first: every later record is younger, so we
        // can stop scanning entirely once we reach a live-window record.
        reachedWindow = true;
        break;
      }

      try {
        const removed = await deps.logs.purgeEntry(record.id);
        if (removed) {
          purged += 1;
          purgedInPage += 1;
          deps.logger?.info?.('[log-retention-purge] purged expired log record %s', record.id);
        }
      } catch (err) {
        // Best-effort: one record's failure never aborts the run.
        deps.logger?.warn?.(
          '[log-retention-purge] failed to purge log record %s: %o',
          record.id,
          err
        );
      }
    }

    if (reachedWindow) {
      break;
    }
    if (page.length < SCAN_PAGE_SIZE) {
      break;
    }
    // Advance past the records that survived this page (e.g. a failed purge or
    // an unparseable stamp we skipped) so the next page does not re-scan them;
    // purged records are gone, so the store's paging window shifts by the number
    // we removed. Net forward offset = page length minus records purged.
    offset += page.length - purgedInPage;
  }

  return { scanned, purged };
}
