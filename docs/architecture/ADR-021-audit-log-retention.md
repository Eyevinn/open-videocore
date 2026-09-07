# ADR-021: Audit-log retention policy and alignment with the archived-asset purge lifecycle

**Status:** PROPOSED 2026-09-07
**Date:** 2026-09-07
**Author agent:** claude-opus-4-8 (surface-backend-api)
**Issue:** #566 (prerequisite #563 — audit store; parent #529)

---

## Numbering note

The highest ADR file on this branch's `main` base is ADR-020 (#567). ADR-021 is
the next free number above it. (A stale `ADR-006` string appears in a code
comment in `src/services/workspace-stack.ts` referring to the auto-scaler; there
is no `ADR-006-*.md` file, and this ADR does not reuse that number.)

---

## Context

Issue #563 shipped an append-only audit store (`CouchAuditRepository` /
`AuditEntry`, `src/data/audit-repo.ts`) with `record`/`get`/`list` and **no
expiry path** — every entry lives forever. Issue #566 asks whether audit entries
should be retained indefinitely or expired on an operator-configurable window,
and — if a window is adopted — to implement a bounded purge that mirrors, and is
clearly separable from, the existing archived-asset purge sweep
(`src/pipeline/archived-asset-purge-sweep.ts`, issue #327), preserving
append-only-until-purge (whole-entry expiry, never in-place edit).

## Decision

**Adopt an operator-configurable audit-log retention window, default OFF
(indefinite retention unless configured).**

This mirrors the archived-asset retention model exactly:

- Boot config via env (`AUDIT_RETENTION_MS`), unset/`0`/negative -> `0` =
  indefinite retention. This is behaviourally identical to today (#563 stored
  entries forever), so no existing deployment changes behaviour without opting
  in.
- The window is hot-reloadable at runtime via `PATCH /api/v1/retention/config`
  (`auditRetentionMs`), no restart, exactly as the archived-asset window
  (`retentionMs`) is. The two windows share the ONE retention config surface —
  not a parallel endpoint.
- The effective policy is exposed to operators on `GET
  /api/v1/retention/config`, which now reports BOTH `retentionMs` (archived
  asset) and `auditRetentionMs` (audit log).

Indefinite-by-default is retained as the no-op path, but it is **not** the whole
answer: an operator who must bound audit-log growth (storage cost, data-minimisation
/ retention-compliance obligations) can now set a window without a code change.
Choosing default-off keeps the audit trail complete for every deployment that
has not made a deliberate retention decision.

## Mechanism (mirror, do not duplicate)

The audit purge reuses the archived-asset sweep's shape rather than inventing a
parallel one:

- `purgeExpiredAuditEntries` (`src/pipeline/audit-retention-purge-sweep.ts`) is
  a pure `deps`-driven function returning `{ scanned, purged }`, best-effort per
  entry (one entry's failure is logged and skipped, never aborts the run),
  disabled when `retentionMs <= 0` — the same contract as
  `purgeExpiredArchivedAssets`.
- `AuditRetentionPurgeLoop` (`src/pipeline/audit-retention-purge-loop.ts`)
  mirrors `ArchivedAssetPurgeLoop`: an unref'd, overlap-guarded `setInterval`
  whose per-tick errors are swallowed; cadence via `AUDIT_PURGE_INTERVAL_MS`
  (default 1h); reads the live window each tick and skips when unset.
- The enumerate + expire seam is on the store: `listOldestPage` (paged,
  oldest-first walk) + `purgeEntry` (whole-entry removal) on
  `CouchAuditRepository`. `purgeEntry` delegates to `StackCouch.remove`
  (`src/data/couchdb.ts:87-93`: read `_rev`, then `destroy`) — a whole-document
  delete, never a read-modify-write. This upholds **append-only-until-purge**:
  an entry is either present verbatim or gone.

### Differences from the archived-asset sweep (why they exist)

- No cross-bucket object reclamation and no child-ordering guard: an audit entry
  is a single immutable document with no storage objects and no parent/child
  graph, so purge is simply the whole-entry removal (the audit analogue of the
  archived sweep's terminal `purge -> purgeToTombstone` step).
- Expiry is measured from the entry's write instant (`AuditEntry.at`), analogous
  to the archived sweep measuring from the last `-> archived` transition. An
  unparseable timestamp is refused (never purged), matching the archived sweep's
  guard.
- Because entries are enumerated oldest-first, the walk stops at the first entry
  still inside the window (all later entries are younger), bounding each sweep to
  the aged tail.

## Consequences

- Operators can bound audit-log storage growth and satisfy retention-window
  obligations without a code change; the default preserves a complete trail.
- The audit store gains its FIRST removal path. It remains append-only at the
  application boundary: the only removal is `purgeEntry`, which exists solely to
  enforce the retention window, and there is still no update/rewrite path.
- The audit store is CouchDB-only (#563). The purge loop is wired in `main.ts`
  to resolve the active stack's `CouchAuditRepository` per tick and no-ops when a
  resolved connection has no audit store (env-override no-couch / in-memory
  fallback), so nothing is ever purged in those modes.

## Alternatives considered

- **Indefinite retention only (no window).** Rejected as the sole outcome:
  legitimate operators need a bound, and the archived-asset lifecycle already
  established the default-off configurable-window pattern this should align with.
- **A separate audit-retention config endpoint / a parallel sweep + loop.**
  Rejected: #566 explicitly asks to mirror and reuse the existing mechanism, not
  add a parallel one. Both windows now share the one retention config surface and
  the sweep/loop reuse the archived-asset shapes.
- **Soft-expire (mark entries expired in place).** Rejected: it would be an
  in-place edit, violating append-only-until-purge. Purge is whole-entry.
