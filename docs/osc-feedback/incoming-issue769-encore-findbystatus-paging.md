# OSC Friction: Encore `findByStatus` paging contract is undocumented, so "is this job still active?" is only answerable for page 0

**Date:** 2026-09-26
**Severity:** Medium
**Service:** encore (Encore transcoding service on OSC)
**Affected features:** scaler reconcile / dropped-job detection (#449, #768,
#839, #769), orphan reaper (#778), scale-down drain-don't-kill (#513)

## What we needed to know

The scaler asks an instance "which of my jobs are you still running?" via

```
GET {instanceUrl}/encoreJobs/search/findByStatus?status=QUEUED&page=0&size=100
GET {instanceUrl}/encoreJobs/search/findByStatus?status=IN_PROGRESS&page=0&size=100
```

and reads the Spring HATEOAS page
`{ _embedded: { encoreJobs: [{ externalId }] }, page: { totalElements } }`
(`src/encore-scaler/encore-active-state.ts`).

Issue #769 turns that answer into a decision: a job Encore still reports active
anywhere in the pool must not be classified as silently dropped. That makes two
properties of the page load-bearing, and neither is stated in the service
documentation we can reach from the catalog entry:

1. Is `page.totalElements` the count across ALL pages, or the number of elements
   on the returned page? We assume "all pages" — it is the Spring HATEOAS
   convention, and it is the only reading under which the existing
   count-correction logic makes sense — but that is inference, not a contract.
2. Is there a documented maximum `size`, or a supported way to ask for "all
   active jobs" in one request? We ask for one page of 100 per status because
   that is what the repo's existing readers do
   (`src/pipeline/encore-callback-poller.ts` `sweepTerminalJobs`).

## Why it matters

An instance with more than 100 QUEUED or 100 IN_PROGRESS jobs returns a
complete-looking page whose `_embedded.encoreJobs` omits the rest. Before #769
that only weakened one instance's count diff. Now the same partial set is the
evidence for "this externalId is active nowhere in the pool", so a job sitting
off page 0 would be classified dropped and failed while it is genuinely running.

## What we did instead

`fetchEncoreActiveState` now compares `page.totalElements` against the number of
documents actually returned and flags the result `truncated`. A truncated
instance is still trusted for POSITIVE evidence (an externalId Encore did return
is running) but is treated as unchecked for any "active nowhere" claim, and its
drop classification is skipped for that pass. This is a conservative workaround
built on assumption 1 above; if `totalElements` is per-page rather than total,
the flag never fires and the underlying blind spot remains.

## Ask

- Document the `findByStatus` page contract for the catalog Encore service:
  `page.totalElements` semantics, the maximum accepted `size`, and whether
  cursor/`_links.next` traversal is supported.
- Ideally expose a bounded "active externalIds" query (or allow filtering
  `findByStatus` by a set of externalIds) so a caller can answer "is externalId X
  still active here?" without paging the whole active set.

## Verification status

Unverified against a live instance: no reachable Encore instance was available
from the environment this change was written in, so the page shape is cited only
from the in-repo readers above. This is the one place in #769 where that gap
changes behaviour.
