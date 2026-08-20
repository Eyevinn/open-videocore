// TAMS-address query contract for the assets lookup API (issue #174).
//
// Sub-task of the #116 TAMS bridge epic; blocks #154. This module PINS THE
// CONTRACT for what a "TAMS address" means as a query surface against the
// assets API. It is a contract-definition module only: it declares the accepted
// addressing modes, the typed query params, the response cardinality/pagination
// shape, and the error taxonomy. It does NOT implement the lookup handler — that
// is sibling #175, which imports these symbols.
//
// A TAMS address is not a single identifier (ADR-008 "Addressing hierarchy":
// source -> flow -> segment). The accepted addressing MODES are therefore
// enumerated and typed as a discriminated union rather than a single id.
//
// -------------------------------------------------------------------------
// Reconciliation with the index representation (issue #153 / #168)
// -------------------------------------------------------------------------
// The "#153 indexing path" in this codebase was implemented as the search-index
// projection (issue #168, not yet merged to main). Its authoritative index
// fields are:
//   - `tamsFlowId`   — a SINGLE flow UUID, matched by membership against the
//                      asset's `tamsFlowIds: string[]`.
//   - `tamsTimerange`— the exact canonical timerange string (equality match).
// Both are exposed as `SearchQuery` / `matchesQuery` fields in
// `src/data/search-repo.ts` and the Mango selector in
// `src/data/couch-search-repo.ts`, surfaced on `GET /api/v1/search`.
// Since #168 is not on this branch, those field names are treated as the
// authoritative index representation to reconcile with. This query contract
// therefore addresses a flow by a SINGLE UUID (`flowId`), matching #168's
// single-valued `tamsFlowId` index field — NOT by the asset model's plural
// `tamsFlowIds` array. The array is the storage shape; a query addresses one
// flow at a time.
//
// The underlying asset model fields (ON main, issue #165, under
// `structural.tams`) are `tamsFlowIds: string[]` and `tamsTimerange: string`.
// The validation rules are REUSED from `src/data/asset-document.ts`:
//   - `TamsFlowIdSchema`   (a UUID)                 — imported, not re-declared.
//   - `TamsTimerangeSchema` (ADR-008 TAI grammar)   — imported, not re-declared.

import { z } from 'zod';
import { TamsFlowIdSchema, TamsTimerangeSchema } from '../data/asset-document.js';
import { DEFAULT_LIMIT, MAX_LIMIT } from '../data/asset-repo.js';

// ---------------------------------------------------------------------------
// v1 addressing modes + explicit defer list
// ---------------------------------------------------------------------------
//
// v1 accepts exactly the two modes the #168 index can actually resolve:
//
//   - `flowId`            : address one flow by its UUID.
//   - `flowIdWithTimerange`: address one flow's media, sliced to a TAI timerange.
//
// Deferred (NOT accepted in v1), each with the reason:
//
//   - `sourceId`   : the asset model carries no source id — only `tamsFlowIds` /
//                    `tamsTimerange` under `structural.tams` (#165). ADR-008's
//                    source layer is not projected into the index (#168), so a
//                    source cannot be resolved to an asset yet.
//   - `segmentRef` / media-object reference : segments are addressed inside the
//                    TAMS gateway (ADR-008 `GET /flows/{id}/segments`), not in
//                    the assets index. A segment does not map to a distinct
//                    asset, so it has no place in an asset-lookup contract.
//   - `timerangeOnly` : a bare timerange with no flow is not deterministic — it
//                    could match media across many assets. Deferred until (and
//                    if) a cross-flow time query is specified.

export const TAMS_QUERY_MODES = ['flowId', 'flowIdWithTimerange'] as const;
export type TamsQueryMode = (typeof TAMS_QUERY_MODES)[number];

export const TAMS_DEFERRED_MODES = ['sourceId', 'segmentRef', 'timerangeOnly'] as const;
export type TamsDeferredMode = (typeof TAMS_DEFERRED_MODES)[number];

// ---------------------------------------------------------------------------
// Query parameter schema (raw wire shape)
// ---------------------------------------------------------------------------
//
// Params mirror the assets router style (`listQuerySchema` in
// `src/routes/assets.ts`): flat query object, `z.coerce.number` for numeric
// pagination, reused field schemas. The MODE is DERIVED from which params are
// present (see `resolveTamsQueryMode`) rather than passed explicitly, so a
// caller addresses `?flowId=...` or `?flowId=...&timerange=...` directly.
//
// - `flowId`   : REQUIRED in every v1 mode (both modes need a flow). Reuses
//                `TamsFlowIdSchema` (UUID) — malformed => zod rejects (=> 400).
// - `timerange`: OPTIONAL. Presence selects the `flowIdWithTimerange` mode.
//                Reuses `TamsTimerangeSchema` (ADR-008 TAI grammar) — malformed
//                => zod rejects (=> 400).
// - `limit`/`offset`: pagination, matching the assets `list` style
//                (`ListOptions` limit/offset, clamped to [1, MAX_LIMIT]).
export const TamsQueryParamsSchema = z
  .object({
    flowId: TamsFlowIdSchema,
    timerange: TamsTimerangeSchema.optional(),
    limit: z.coerce.number().int().min(1).max(MAX_LIMIT).optional(),
    offset: z.coerce.number().int().min(0).optional()
  })
  .strict();
export type TamsQueryParams = z.infer<typeof TamsQueryParamsSchema>;

// ---------------------------------------------------------------------------
// Discriminated resolver over the addressing MODE
// ---------------------------------------------------------------------------
//
// A discriminated union of the two v1 modes. `resolveTamsQueryMode` parses the
// raw params and narrows to exactly one mode based on `timerange` presence.
// This gives #175's handler a typed, exhaustively-switchable value.

export type TamsFlowIdAddress = {
  mode: 'flowId';
  flowId: string;
  limit?: number;
  offset?: number;
};

export type TamsFlowIdWithTimerangeAddress = {
  mode: 'flowIdWithTimerange';
  flowId: string;
  timerange: string;
  limit?: number;
  offset?: number;
};

export type TamsQueryAddress = TamsFlowIdAddress | TamsFlowIdWithTimerangeAddress;

// Parse + narrow raw query params to a typed addressing mode. Throws
// `z.ZodError` on malformed input (the handler maps that to a 400 via
// `TamsQueryError`). The mode is selected by `timerange` presence: absent =>
// `flowId`, present => `flowIdWithTimerange`.
export function resolveTamsQueryMode(raw: unknown): TamsQueryAddress {
  const params = TamsQueryParamsSchema.parse(raw);
  const base = { flowId: params.flowId, limit: params.limit, offset: params.offset };
  if (params.timerange !== undefined) {
    return { mode: 'flowIdWithTimerange', timerange: params.timerange, ...base };
  }
  return { mode: 'flowId', ...base };
}

// ---------------------------------------------------------------------------
// Error taxonomy (typed values + HTTP status mapping)
// ---------------------------------------------------------------------------
//
// The four failure classes the issue calls out, each pinned to one status:
//
//   - `malformed`     -> 400 : the address does not parse (bad UUID / bad TAI
//                              timerange grammar). A syntactic failure at the
//                              boundary; zod raises this before any lookup.
//   - `unknown`       -> 404 : the address is well-formed but no asset carries
//                              that flow id. Existence is not leaked; a valid
//                              but absent address is indistinguishable from a
//                              cross-workspace one.
//   - `notYetIndexed` -> 404 : the asset exists but its TAMS addressing has not
//                              been projected into the index yet (#168 is async
//                              relative to ingest). Collapsed to 404, NOT 202/425
//                              /409, because the assets lookup does not model
//                              async indexing state as a first-class resource;
//                              from the query's point of view an un-indexed
//                              address is simply not resolvable, same as unknown.
//   - `ambiguous`     -> 409 : reserved. NOT possible in v1 (see below) but kept
//                              in the taxonomy so #175 does not have to invent a
//                              status if a future multi-match mode is added.
//
// Not-found decision (404 vs 200 empty): the SINGLE-MATCH modes (`flowId`,
// `flowIdWithTimerange`) resolve a specific address, so a miss is 404 — the
// same convention the assets router uses for `GET /assets/:id`. (A future
// list-style mode would instead return 200 with an empty page; that is the
// pagination shape below, not an error.)

export const TAMS_QUERY_ERROR_CODES = [
  'malformed',
  'unknown',
  'notYetIndexed',
  'ambiguous'
] as const;
export type TamsQueryErrorCode = (typeof TAMS_QUERY_ERROR_CODES)[number];

// Typed code -> HTTP status map. Frozen so it is a single source of truth for
// #175's handler and any OpenAPI generation.
export const TAMS_QUERY_ERROR_STATUS: Readonly<Record<TamsQueryErrorCode, number>> =
  Object.freeze({
    malformed: 400,
    unknown: 404,
    notYetIndexed: 404,
    // Reserved: ambiguity is NOT reachable in v1 because a flow id is
    // deterministic per asset (ADR-008/ADR-009 — a flow maps to exactly one
    // asset). Kept so a future multi-source/segment mode has a pinned status.
    ambiguous: 409
  });

// A typed error the handler (#175) throws/returns; carries the taxonomy code
// and its pre-mapped HTTP status so the route layer stays declarative.
export class TamsQueryError extends Error {
  readonly code: TamsQueryErrorCode;
  readonly status: number;
  constructor(code: TamsQueryErrorCode, message?: string) {
    super(message ?? code);
    this.name = 'TamsQueryError';
    this.code = code;
    this.status = TAMS_QUERY_ERROR_STATUS[code];
  }
}

// ---------------------------------------------------------------------------
// Response cardinality + pagination shape
// ---------------------------------------------------------------------------
//
// Cardinality per mode (ADR-009 determinism):
//   - `flowId`             : resolves to AT MOST ONE asset. A flow id is
//                            deterministic per asset (a flow maps to one asset),
//                            so this is a single-match lookup.
//   - `flowIdWithTimerange`: a TIME-SLICED VIEW of that one asset — the same
//                            single asset, narrowed to the requested timerange.
//                            Still at most one asset; the timerange scopes the
//                            media window, not the match count.
//
// Both v1 modes are single-match, so a resolved response is one asset (or a
// 404). Pagination is DEFINED ANYWAY for safety and forward-compat: if a future
// mode (deferred `sourceId` — a source carries many flows) becomes multi-match,
// #175's response envelope already carries the paging fields and callers do not
// have to change shape. The paging fields mirror the assets `list` style
// (`ListResult`: items/limit/offset/total; `ListOptions`: limit/offset clamped
// to [1, MAX_LIMIT]).

export const TAMS_QUERY_DEFAULT_LIMIT = DEFAULT_LIMIT;
export const TAMS_QUERY_MAX_LIMIT = MAX_LIMIT;

// A single time-sliced view of a resolved asset. `assetId` is the resolved
// asset; `timerange` echoes the requested slice (present only for the
// `flowIdWithTimerange` mode). Kept minimal — #175 populates the asset body.
export type TamsResolvedItem<TAsset> = {
  assetId: string;
  asset: TAsset;
  // Present only when the query carried a timerange (time-sliced view).
  timerange?: string;
};

// The paginated envelope #175 returns. Mirrors `ListResult` (items/limit/
// offset/total). For the single-match v1 modes `total` is 0 or 1 and `items`
// has at most one entry; the envelope is uniform so a future multi-match mode
// reuses it unchanged.
export type TamsQueryResult<TAsset> = {
  mode: TamsQueryMode;
  items: TamsResolvedItem<TAsset>[];
  limit: number;
  offset: number;
  total: number;
};
