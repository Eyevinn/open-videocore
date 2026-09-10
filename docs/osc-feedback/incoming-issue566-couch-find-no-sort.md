# OSC friction: CouchDB `find` seam exposes no `sort`, forcing reliance on implicit `_id` scan order

**Issue:** #566 (audit-log retention purge sweep)
**Surface:** backend-api
**Date:** 2026-09-07
**Severity:** low (works today; latent fragility)

## What happened

The audit-retention purge sweep enumerates aged audit entries oldest-first so it
can page from the tail forward and stop at the first entry still inside the
retention window. The store's paging primitive (`CouchAuditRepository.listOldestPage`,
`src/data/audit-repo.ts`) is built on `StackCouch.find`
(`src/data/couchdb.ts:66-76`), which forwards only `{ selector, limit, skip }` to
nano's Mango `find` — it exposes **no `sort` option**.

To get oldest-first order we therefore depend on the *implicit* behaviour that a
Mango `find` with no `sort` clause scans the primary `_id` index and returns
results in ascending `_id` order. That happens to be correct for the audit
partition because every audit `_id` is a time-sortable ULID, so `_id`-ascending
== oldest-first. But it is an undocumented, implicit ordering contract: a future
CouchDB/nano change, a secondary index selection, or a different selector could
silently reorder pages and break the "stop at the first in-window entry" bound
(entries could be purged/skipped out of order).

## Impact

None today. The sweep is correct given the current nano/CouchDB `_id`-scan
behaviour. The risk is latent: the correctness of a *bounded* sweep rests on an
implicit ordering the seam cannot express or enforce.

## Suggested follow-up (not in this issue's scope)

Extend `StackCouch.find` to accept an optional `sort` (and ideally a `use_index`)
so ordering-sensitive callers — the audit-retention sweep here, and any future
cursor-paged reader — can state the order explicitly rather than relying on the
default index scan. This mirrors the archived-asset sweep's preference for an
explicit, verifiable contract over implicit behaviour.
