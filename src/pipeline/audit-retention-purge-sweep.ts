// Audit-log retention purge sweep (issue #566, aligns with the archived-asset
// purge lifecycle #327/#323).
//
// A bounded background sweep that expires audit entries aged past the retention
// window. It DELIBERATELY MIRRORS — and is cleanly SEPARABLE from — the
// archived-asset purge sweep (purgeExpiredArchivedAssets,
// src/pipeline/archived-asset-purge-sweep.ts): a pure `deps`-driven function
// returning a small `{ scanned, purged }` summary, BEST-EFFORT per entry (one
// entry's failure is logged and skipped and never aborts the run), disabled
// when the window is unset (retentionMs <= 0). It is NOT a parallel mechanism:
// the ONLY differences are the store it drives (the audit partition, not the
// asset repo) and that expiry is WHOLE-ENTRY (there is no cross-bucket object
// state to reclaim and no child-ordering — an audit entry is a single immutable
// document), so a purge here is simply `purgeEntry` (whole-doc removal), the
// audit analogue of the archived sweep's `purge` -> purgeToTombstone step.
//
// RETENTION DECISION (see docs/architecture/ADR-021-audit-log-retention.md): audit
// retention is operator-configurable and DEFAULT OFF — an unset/0 window means
// indefinite retention, behaviourally identical to today (issue #563 shipped no
// expiry path). This exactly matches the archived-asset default-off model
// (ARCHIVE_RETENTION_MS, RETENTION_DISABLED_MS, src/routes/retention.ts:27-43).
//
// APPEND-ONLY-UNTIL-PURGE: purge is whole-entry expiry, NEVER an in-place edit.
// An entry is either present verbatim or gone. `purgeEntry`
// (src/data/audit-repo.ts) is the ONLY removal path; there is no update/rewrite.
//
// ELIGIBILITY: an entry is expired when now - Date.parse(entry.at) >
// retentionMs. `at` is the ISO-8601 write instant on the entry
// (AuditEntrySchema.at, src/data/audit-repo.ts). An unparseable stamp is
// refused (never purged), mirroring the archived sweep's guard on an
// unparseable archivedAt (archived-asset-purge-sweep.ts:146-150).
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Result/skip-never-abort/disabled-window shape + paged enumerate walk:
//     purgeExpiredArchivedAssets / listAllArchived,
//     src/pipeline/archived-asset-purge-sweep.ts:114-215.
//   - Audit enumerate (oldest-first page) + whole-entry purge:
//     CouchAuditRepository.listOldestPage / purgeEntry, src/data/audit-repo.ts.
//   - AuditEntry.at / .id shape: AuditEntrySchema, src/data/audit-repo.ts:63-72.

import type { AuditEntry } from '../data/audit-repo.js';

type Logger = {
  info?(...a: unknown[]): void;
  warn?(...a: unknown[]): void;
};

// How many audit entries to enumerate per page. The store paginates
// (listOldestPage(limit/offset)), so the sweep pages oldest-first until it
// reaches an entry still inside the window — this bounds each read while
// covering the whole aged tail. Mirrors SCAN_PAGE_SIZE in the archived sweep.
const SCAN_PAGE_SIZE = 200;

// The minimal audit-store surface the sweep needs — a subset of
// CouchAuditRepository (src/data/audit-repo.ts). Injected so the sweep can be
// exercised without a live CouchDB, exactly as the archived sweep injects its
// storage/purge seams.
export type AuditRetentionStore = {
  // Oldest-first page of audit entries (ascending ULID / write order).
  listOldestPage(opts: { limit: number; offset?: number }): Promise<AuditEntry[]>;
  // Whole-entry expiry (never an in-place edit). Truthy on a live removal.
  purgeEntry(id: string): Promise<boolean> | boolean;
};

export type PurgeExpiredAuditEntriesDeps = {
  // Read + expire side: enumerate (paged, oldest-first) and whole-entry purge.
  audit: AuditRetentionStore;
  // Retention window in ms. 0 / negative means disabled (never purge =
  // indefinite retention); the loop skips the sweep entirely when unset, but
  // this is also enforced here so a direct call is safe. Mirrors the archived
  // sweep's retentionMs guard exactly.
  retentionMs: number;
  // Injectable clock so the expiry check is deterministic in tests.
  now?: () => number;
  logger?: Logger;
};

export type PurgeExpiredAuditEntriesResult = {
  scanned: number;
  purged: number;
};

// Enumerate aged audit entries (oldest-first) and purge every one past the
// retention window. Best-effort per entry: one entry's error is logged and
// skipped and never aborts the run. Because entries are visited oldest-first,
// the walk STOPS at the first entry still inside the window (every later entry
// is younger and therefore also inside it), bounding the scan to the aged tail.
export async function purgeExpiredAuditEntries(
  deps: PurgeExpiredAuditEntriesDeps
): Promise<PurgeExpiredAuditEntriesResult> {
  const now = deps.now ?? (() => Date.now());

  // Disabled window -> never purge (indefinite retention). Behaviourally
  // identical to today, matching the archived sweep's disabled guard
  // (archived-asset-purge-sweep.ts:124-126).
  if (!Number.isFinite(deps.retentionMs) || deps.retentionMs <= 0) {
    return { scanned: 0, purged: 0 };
  }

  const cutoff = now() - deps.retentionMs;

  let scanned = 0;
  let purged = 0;
  let offset = 0;

  for (;;) {
    const page = await deps.audit.listOldestPage({ limit: SCAN_PAGE_SIZE, offset });
    if (page.length === 0) {
      break;
    }

    let reachedWindow = false;
    let purgedInPage = 0;

    for (const entry of page) {
      scanned += 1;

      // Expiry measured from the entry's write instant (`at`). An unparseable
      // stamp is refused (never purged), as the archived sweep refuses an
      // unparseable archivedAt.
      const atMs = Date.parse(entry.at);
      if (Number.isNaN(atMs)) {
        deps.logger?.warn?.(
          '[audit-retention-purge] entry %s has an unparseable timestamp %o — refusing to purge',
          entry.id,
          entry.at
        );
        continue;
      }
      if (atMs > cutoff) {
        // Inside the window. Oldest-first: every later entry is younger, so we
        // can stop scanning entirely once we reach a live-window entry.
        reachedWindow = true;
        break;
      }

      try {
        const removed = await deps.audit.purgeEntry(entry.id);
        if (removed) {
          purged += 1;
          purgedInPage += 1;
          deps.logger?.info?.('[audit-retention-purge] purged expired audit entry %s', entry.id);
        }
      } catch (err) {
        // Best-effort: one entry's failure never aborts the run.
        deps.logger?.warn?.(
          '[audit-retention-purge] failed to purge audit entry %s: %o',
          entry.id,
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
    // Advance past the entries that survived this page (e.g. a failed purge or
    // an unparseable stamp we skipped) so the next page does not re-scan them;
    // purged entries are gone, so the store's paging window shifts by the
    // number we removed. Net forward offset = page length minus entries purged.
    offset += page.length - purgedInPage;
  }

  return { scanned, purged };
}
