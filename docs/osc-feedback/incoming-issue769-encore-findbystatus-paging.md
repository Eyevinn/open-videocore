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

## Update 2026-09-29 — pinned from upstream source, and two corrections

Re-verified while turning the prose above into an executable contract
(`docs/contracts/encore-findbystatus-paging.json` +
`src/encore-scaler/encore-paging-contract.ts` +
`test/encore-findbystatus-contract.test.ts`). Three things changed.

**1. A live instance could not be reached this time, which is itself the
friction.** The OSC personal access token available to the build is rejected:

```
GET https://catalog.svc.prod.osaas.io/mysubscriptions   ->  401
{"message":"Authorization token is invalid: The token signature is invalid."}
```

So `/v3/api-docs` — the only place this contract is published — was
unavailable, and no fixture could be recorded from it. A contract that is
reachable only from a running instance, only via an unadvertised path, and only
with a working tenant token is a contract that cannot be pinned in CI. That is
the core ask below.

**2. The contract IS pinnable from upstream source, and the source answers the
question the OpenAPI document does not.** `svt/encore` at
`8dd7c596c51a8c31bae805e31ff0969564f68229` (`master` HEAD, 2026-09-14):

- `encore-common/.../redis/RedisService.kt:154-163` — `findByQuery` returns
  `PageImpl(jobs, pageable, count)` where `count = searchReply.count` is the FULL
  Redis `FT.SEARCH` match count and `jobs` is limited to the requested window by
  `searchArgs.limit(offset, pageSize)`. **`page.totalElements` is therefore the
  all-pages total by construction** — the empirical answer above, now proved
  rather than observed.
- `encore-web/.../controller/EncoreController.kt:101-111` — the endpoint,
  `status`, and `@PageableDefault(size = 10)`.
- Spring HATEOAS `PagedResourcesAssembler` adds the `next` link iff
  `page.hasNext()`, which for page 0 is exactly
  `totalElements > documents.length`. That independently explains the `_links`
  rel sets recorded in the table above.

**3. The 1000 clamp is not Encore's — it is framework/classpath-dependent, so
the earlier note overstated it.** Encore configures no maximum page size
anywhere. The effective clamp comes from whichever Spring pageable argument
resolver is wired: Spring Data REST defaults to 1000 (and
`spring-boot-starter-data-rest` is on `encore-web`'s classpath —
`encore-web/build.gradle.kts:14`), while the plain Spring Data web resolver
defaults to 2000. 1000 is what the 2026-09-26 capture observed, so we keep asking
for 1000 — it can never be silently reduced. But a caller who treats 1000 as "the
Encore limit" will be wrong on some deployment. Nothing about our correctness
rests on the number; it rests on the `truncated` flag, which is derived from the
response itself.

**4. `findByExternalId` already exists upstream — the third ask below is
partially answered.** `EncoreController.kt:115-125` exposes
`GET /encoreJobs/search/findByExternalId?externalId=...`, and it is in the
service's own `docs/api-guide.md`. That is exactly the bounded per-job query this
log asked for: it would let the scaler ask "is job X alive here?" without paging
an instance's whole active set, and would close the truncation blind spot
outright. We have NOT adopted it, because we cannot tell which Encore version the
catalog deploys and could not probe one (see 1). Which is the same discoverability
problem wearing a different hat.

## Ask

- **Publish the service contract somewhere a CI job can reach without a tenant
  token.** `/v3/api-docs` is good but it is instance-scoped, unadvertised, and
  gated on a working PAT — none of which a contract test can rely on. A static
  per-version OpenAPI artefact in the catalog (or even a link to the upstream tag
  the image was built from) would let integrators pin the contract instead of
  transcribing it.
- **State the deployed Encore version in the catalog entry.** Without it we cannot
  tell whether an endpoint we can see in upstream source (`findByExternalId`) or a
  limit we measured once (the `size` clamp) applies to the instance we just
  provisioned.
- **Document the silent `size` clamp**, ideally in the OpenAPI `size` parameter
  description, or reject an oversized `size` instead of clamping. A caller that
  asks for 5000 and gets 1000 with no signal other than `page.size` will believe
  it has the whole set. Note the clamp value is inherited from Spring defaults and
  therefore varies (see update item 3) — publishing the effective value per
  deployment matters more than the number itself.

## Verification status

- **2026-09-26** — verified against a live catalog Encore instance: OpenAPI
  document fetched from `{instanceUrl}/v3/api-docs`, paging semantics and the
  `size` clamp confirmed by the requests tabulated above. The two probe jobs
  created for the `totalElements` test were deleted afterwards
  (`DELETE /encoreJobs/{id}` -> 200) and the instance was confirmed back at
  `totalElements: 0`.
- **2026-09-29** — live instance NOT reachable (401, see update item 1). Contract
  re-verified against upstream source at the pinned commit and recorded as an
  executable artefact; the 2026-09-26 capture is carried forward as data inside
  it (`recordedResponses`) and replayed by the contract test.
