# ADR-010: TAMS-address query contract for the assets API

**Status:** PROPOSED 2026-07-12
**Date:** 2026-07-12
**Author agent:** claude-opus-4-8
**Issue:** #174 (sub-task of the #116 TAMS bridge epic; blocks #154)

---

## Context

Before any lookup endpoint or test work (#175, #154), the contract for what a
"TAMS address" means as a query surface against the assets API must be pinned. A
TAMS address is not a single identifier — ADR-008's addressing hierarchy is
`source -> flow -> segment` — so the accepted addressing MODES must be
enumerated and typed rather than assumed to be one id.

This ADR records the v1 addressing modes, the typed query-param schema, the
response cardinality and pagination shape, and the error taxonomy with HTTP
status codes. It introduces **no lookup handler** — that is #175, which imports
the schema module defined here (`src/tams/tams-query-contract.ts`).

## Reconciliation with the index representation (#153 / #168)

The "#153 indexing path" in this codebase was implemented as the search-index
projection (issue #168, **not yet merged to main**). Its authoritative index
fields — the representation this query contract must agree with — are:

- **`tamsFlowId`** — a **single** flow UUID, matched by membership against the
  asset's `tamsFlowIds: string[]`.
- **`tamsTimerange`** — the exact canonical timerange string (equality match).

Both are exposed as `SearchQuery` / `matchesQuery` fields in
`src/data/search-repo.ts` and as the Mango selector in
`src/data/couch-search-repo.ts`, surfaced on `GET /api/v1/search`. Since #168 is
not on this branch, those field names are treated as the authoritative index
representation to reconcile with.

Consequence for this contract: a query addresses a flow by a **single UUID**
(`flowId`), matching #168's single-valued `tamsFlowId` index field — **not** by
the asset model's plural `tamsFlowIds` array. The array is the storage shape
(one asset can carry many flows); a query addresses one flow at a time.

The underlying asset-model fields (ON main, issue #165, under `structural.tams`)
are `tamsFlowIds: string[]` and `tamsTimerange: string`. Their validation rules
are **reused, not re-declared**, from `src/data/asset-document.ts`:

- `TamsFlowIdSchema` — a UUID.
- `TamsTimerangeSchema` — the ADR-008 TAI timerange grammar.

## v1 addressing modes + defer list

v1 accepts exactly the two modes the #168 index can resolve:

| Mode | Params | Meaning |
| --- | --- | --- |
| `flowId` | `flowId` (UUID) | Address one flow by its id. |
| `flowIdWithTimerange` | `flowId` + `timerange` | That one flow's media, sliced to a TAI timerange. |

Deferred (NOT accepted in v1), each with its reason:

- **`sourceId`** — the asset model carries no source id, only
  `tamsFlowIds` / `tamsTimerange` (#165). ADR-008's source layer is not
  projected into the index (#168), so a source cannot resolve to an asset yet.
- **`segmentRef` / media-object reference** — segments are addressed inside the
  TAMS gateway (`GET /flows/{id}/segments`, ADR-008), not the assets index, and
  a segment does not map to a distinct asset.
- **`timerangeOnly`** — a bare timerange with no flow is non-deterministic (it
  could match media across many assets). Deferred until a cross-flow time query
  is specified.

## Query-param schema summary

Defined as a zod schema (`TamsQueryParamsSchema`), matching the assets router
style (`listQuerySchema` in `src/routes/assets.ts`): flat query object,
`z.coerce.number` pagination, reused field schemas, `.strict()` so unknown
params are rejected.

| Param | Type / validation | Required | Notes |
| --- | --- | --- | --- |
| `flowId` | `TamsFlowIdSchema` (UUID) | yes | Required in every v1 mode. Bad UUID => 400. |
| `timerange` | `TamsTimerangeSchema` (ADR-008 TAI grammar) | no | Presence selects `flowIdWithTimerange`. Bad grammar => 400. |
| `limit` | int `[1, MAX_LIMIT]` (coerced) | no | Mirrors `ListOptions.limit`. |
| `offset` | int `>= 0` (coerced) | no | Mirrors `ListOptions.offset`. |

The MODE is DERIVED from `timerange` presence, not passed explicitly.
`resolveTamsQueryMode(raw)` parses and narrows to a discriminated union
(`TamsQueryAddress`) so #175 has an exhaustively-switchable value.

## Response cardinality + pagination

| Mode | Cardinality |
| --- | --- |
| `flowId` | **At most one asset.** A flow id is deterministic per asset (a flow maps to exactly one asset — ADR-008/ADR-009), so this is a single-match lookup. |
| `flowIdWithTimerange` | A **time-sliced view of that one asset** — the same single asset narrowed to the requested timerange. Still at most one asset. |

Both v1 modes are single-match; a resolved response is one asset or a 404.
**Pagination is defined anyway** for safety and forward-compat: if a deferred
multi-match mode (`sourceId` — a source carries many flows) is later added,
#175's envelope already carries paging fields and callers do not change shape.
The paging fields mirror the assets `list` style (`ListResult`:
`items`/`limit`/`offset`/`total`; `ListOptions`: `limit`/`offset` clamped to
`[1, MAX_LIMIT]`). The envelope type is `TamsQueryResult<TAsset>`.

## Error taxonomy -> HTTP status

Typed as `TamsQueryErrorCode` with a frozen `TAMS_QUERY_ERROR_STATUS` map and a
`TamsQueryError` class carrying the code + pre-mapped status.

| Code | Status | Rationale |
| --- | --- | --- |
| `malformed` | **400** | Address does not parse (bad UUID / bad TAI grammar). Syntactic failure at the boundary; zod raises it before any lookup. |
| `unknown` | **404** | Well-formed but no asset carries that flow id. Existence is not leaked (same convention as `GET /assets/:id`). |
| `notYetIndexed` | **404** | Asset exists but its TAMS addressing is not yet projected into the index (#168 is async to ingest). Collapsed to 404 — the assets lookup does not model async indexing state as a first-class resource, so an un-indexed address is simply unresolvable, same as unknown. Not 202/425. |
| `ambiguous` | **409** | **Reserved; NOT reachable in v1** — a flow id is deterministic per asset, so two assets cannot claim the same flow. Kept in the taxonomy so a future multi-source/segment mode has a pinned status without re-litigating it. |

**Not-found decision (404 vs 200-empty):** the single-match v1 modes resolve a
specific address, so a miss is **404**, matching the assets router's
`GET /assets/:id` convention. A future list-style mode would instead return
`200` with an empty page (the pagination envelope above), which is not an error.

## Decision

Adopt the two v1 modes (`flowId`, `flowIdWithTimerange`), the strict typed
query-param schema reusing `TamsFlowIdSchema` / `TamsTimerangeSchema`, the
single-match-with-defined-pagination response shape, and the error->status map
above as the pinned contract for #175's lookup handler and #154's tests. The
query addresses flows by a single UUID to agree 1:1 with #168's `tamsFlowId`
index field.

## Consequences

- #175 imports `src/tams/tams-query-contract.ts` and implements the handler
  against these types; it does not re-decide modes, params, cardinality, or
  status codes.
- Deferred modes (`sourceId`, `segmentRef`, `timerangeOnly`) require a follow-up
  ADR + a source-id / segment projection in the index before they can be
  accepted.
- If #168's `tamsFlowId` / `tamsTimerange` field names change before merge, this
  contract must be re-reconciled (the field names are the coupling point).

## Contract sources

- `src/data/asset-document.ts` — `TamsFlowIdSchema` (UUID), `TamsTimerangeSchema`
  (ADR-008 TAI grammar), `TamsAddressingSchema` (issue #165), reused directly.
- `src/data/asset-repo.ts` — `ListOptions`, `ListResult`, `DEFAULT_LIMIT`,
  `MAX_LIMIT` — pagination style reused.
- `src/routes/assets.ts` — `listQuerySchema` (~line 156) — query-schema style
  matched.
- Issue #168 (search-index projection, not yet on main) — `tamsFlowId` /
  `tamsTimerange` index fields in `src/data/search-repo.ts` /
  `src/data/couch-search-repo.ts`, the authoritative index representation.
- ADR-008 — TAMS timerange TAI grammar and source/flow/segment hierarchy.
