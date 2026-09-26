# OSC Friction: the Encore `findByStatus` paging contract is reachable only by guessing the OpenAPI URL, and there is no way to ask "is externalId X still active here?"

**Date:** 2026-09-26 (updated same day after live verification)
**Severity:** Low (was Medium — the paging question is now answered; what remains
is discoverability and a missing query shape)
**Service:** encore (Encore transcoding service on OSC)
**Affected features:** scaler reconcile / dropped-job detection (#449, #768,
#839, #769), orphan reaper (#778), scale-down drain-don't-kill (#513)

## What we needed to know

The scaler asks an instance "which of my jobs are you still running?" via

```
GET {instanceUrl}/encoreJobs/search/findByStatus?status=QUEUED&page=0&size=...
GET {instanceUrl}/encoreJobs/search/findByStatus?status=IN_PROGRESS&page=0&size=...
```

and reads the returned HATEOAS page
`{ _embedded: { encoreJobs: [{ externalId }] }, page: { totalElements } }`
(`src/encore-scaler/encore-active-state.ts`).

Issue #769 turns that answer into a decision: a job Encore still reports active
anywhere in the pool must not be classified as silently dropped. That made two
properties of the page load-bearing:

1. Is `page.totalElements` the count across ALL pages, or the number of elements
   on the returned page?
2. Is there a maximum accepted `size`, or a supported way to ask for "all active
   jobs" in one request?

Neither is answered by anything linked from the catalog entry for the service.

## Resolved by live introspection (both questions)

The running service does publish a machine-readable contract — it is just not
linked from the catalog entry, so we only found it by trying the conventional
Spring path:

```
GET {instanceUrl}/v3/api-docs   ->  200 application/json
{"openapi":"3.1.0","info":{"title":"Encore OpenAPI", ...}}
```

It declares `/encoreJobs/search/findByStatus` (operationId
`executeSearch-encorejob-get`), the `status` enum
(`NEW|QUEUED|IN_PROGRESS|SUCCESSFUL|FAILED|CANCELLED`), the `page`/`size`/`sort`
parameters, and the response schema `PagedModelEntityModelEncoreJob` with
`page: PageMetadata = { size, totalElements, totalPages, number }`.

What the document does **not** say is what `totalElements` counts — which is the
one thing #769 depends on. Confirmed empirically against a live catalog instance
(two throwaway jobs seeded under a known `externalId` prefix, then deleted):

| request | `_embedded.encoreJobs.length` | `page` | `_links` |
|---|---|---|---|
| `?status=FAILED&page=0&size=1` | 1 | `{size:1, totalElements:2, totalPages:2, number:0}` | first, self, next, last |
| `?status=FAILED&page=0&size=100` | 2 | `{size:100, totalElements:2, totalPages:1, number:0}` | self |

**Answer to 1:** `totalElements` is the total across all pages. So
`totalElements > _embedded.encoreJobs.length` is a sound truncation test, and
`_links.next` is present exactly when the page is truncated.

**Answer to 2:** `size` is silently clamped to **1000** — `size=2000` and
`size=5000` both came back with `page.size: 1000`. There is no documented maximum
and no error on overflow; the request just quietly returns less than asked for.
The clamp is not in the OpenAPI document either (`size` is only `minimum: 1`).

## Why it matters

An instance holding more active jobs than one page returns a complete-looking
page whose `_embedded.encoreJobs` omits the rest. Before #769 that only weakened
one instance's count diff. Now the same partial set is the evidence for "this
externalId is active nowhere in the pool", so a job sitting off page 0 would be
classified dropped and failed while it is genuinely running.

## What we do

`fetchEncoreActiveState` requests the verified clamp value (1000) per status and
compares `page.totalElements` against the number of documents actually returned,
flagging the result `truncated`. A truncated instance is still trusted for
POSITIVE evidence (an externalId Encore did return is running) but is treated as
unchecked for any "active nowhere" claim, and its drop classification is skipped
for that pass. With question 1 now answered, that flag is known to fire correctly
rather than being an assumption.

## Ask

- **Link the OpenAPI document from the catalog entry.** `/v3/api-docs` exists and
  is good, but nothing in the catalog listing points at it; we found it by
  guessing a framework-conventional path. Every integrator will pay that cost.
- **Document the silent `size` clamp at 1000**, ideally in the OpenAPI `size`
  parameter description (or reject oversized `size` instead of clamping). A caller
  that asks for 5000 and gets 1000 with no signal other than `page.size` will
  believe it has the whole set.
- **Expose a bounded "is this externalId active?" query** — either allow
  `findByStatus` to be filtered by a set of externalIds, or add a
  `findByExternalId` search. Today the only way to answer a question about one job
  is to page the entire active set of every instance, which is what forces the
  truncation workaround above to exist at all.

## Verification status

Verified 2026-09-26 against a live catalog Encore instance: OpenAPI document
fetched from `{instanceUrl}/v3/api-docs`, paging semantics and the `size` clamp
confirmed by the requests tabulated above. The two probe jobs created for the
`totalElements` test were deleted afterwards (`DELETE /encoreJobs/{id}` -> 200)
and the instance was confirmed back at `totalElements: 0`.
