// Created-at date-range filtering (issue #833).
//
// One shared definition of the `from`/`to` wire grammar and of the match
// semantics, imported by BOTH filtered surfaces so they cannot drift:
//   - `GET /api/v1/assets/`  (src/routes/assets.ts -> AssetRepository.list)
//   - `GET /api/v1/search/`  (src/routes/search.ts -> SearchRepository.search)
//
// CONTRACT SOURCES verified before writing this module:
//   - `openapi.json` -> `paths./api/v1/assets/.get.parameters` and
//     `paths./api/v1/search/.get.parameters`: NEITHER endpoint carried a
//     created-at range before this change (assets had only limit/offset/status/
//     parentId; search had only q/tags/mimeType/tamsFlowId/tamsTimerange/page/
//     pageSize), so `from`/`to` are new names with no collision.
//   - `AssetDocumentSchema.administrative.createdAt` (src/data/asset-document.ts)
//     — a REQUIRED `z.string()` on every persisted asset document (ADR-005
//     four-namespace model). That is the stored field this range addresses;
//     there is no top-level `createdAt` mirror.
//   - Every write of that field goes through `new Date().toISOString()`
//     (src/data/asset-repo.ts InMemoryAssetRepository.create,
//     src/data/couch-asset-repo.ts CouchAssetRepository.create), so stored
//     values are always the canonical fixed-width UTC form
//     `YYYY-MM-DDTHH:MM:SS.sssZ`.
//
// WIRE GRAMMAR. Both bounds accept either
//   (a) a calendar date, `YYYY-MM-DD`, or
//   (b) a full ISO 8601 instant, `YYYY-MM-DDTHH:MM[:SS[.sss]][Z|±HH:MM]`.
// Both bounds are INCLUSIVE. A bare calendar date is expanded to cover the whole
// UTC day — `from` to its first instant, `to` to its last — because the opposite
// (treating `to=2026-09-25` as midnight) would silently drop every asset created
// during the named day, which is never what a date range means to a caller.
//
// NORMALISATION. `normalizeCreatedFrom`/`normalizeCreatedTo` return the bound as
// a canonical `toISOString()` string, i.e. EXACTLY the shape the stored value
// has. That matters for the CouchDB push-down (see couch-asset-repo.ts): Mango
// `$gte`/`$lte` compare the raw JSON values, and comparing two strings of
// identical fixed-width shape puts the first difference on a digit in the same
// position, so the string order and the chronological order agree.

import { z } from 'zod';

// `YYYY-MM-DD`, optionally followed by a time-of-day with optional seconds,
// optional milliseconds and an optional `Z`/`±HH:MM` offset. The year is pinned
// to four digits so a normalised bound can never widen past the fixed-width
// `toISOString()` shape (JS renders years outside 0000-9999 as `±YYYYYY`).
const CREATED_BOUND_RE =
  /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?(?:Z|[+-](\d{2}):(\d{2}))?)?$/;

// True when the value is a date-only bound (no time-of-day component).
function isDateOnly(value: string): boolean {
  return value.length === 10;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Rejects the impossible calendar values the shape regex alone lets through
// (month 13, 31 February, hour 25, ...). This is checked component by component
// on purpose: V8's `Date.parse` silently ROLLS OVER an out-of-range day, so
// `2026-02-31` would otherwise be accepted and quietly answer as 2026-03-03 —
// a wrong result presented as a correct one.
function isRealInstant(value: string): boolean {
  const m = CREATED_BOUND_RE.exec(value);
  if (!m) {
    return false;
  }
  const [, year, month, day, hour, minute, second, offsetHour, offsetMinute] = Array.from(m) as
    Array<string | undefined>;
  if (year === undefined || month === undefined || day === undefined) {
    return false;
  }
  const y = Number(year);
  const mo = Number(month);
  const d = Number(day);
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) {
    return false;
  }
  if (hour !== undefined && (Number(hour) > 23 || Number(minute) > 59)) {
    return false;
  }
  if (second !== undefined && Number(second) > 59) {
    return false;
  }
  if (offsetHour !== undefined && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) {
    return false;
  }
  return true;
}

// Shared zod field for a `from`/`to` query param. Validation only — the handler
// normalises, so the generated OpenAPI parameter stays a plain
// `{ type: 'string', pattern: ... }` rather than a transformed effect type.
function boundSchema(description: string) {
  return z
    .string()
    .regex(CREATED_BOUND_RE, 'expected YYYY-MM-DD or an ISO 8601 date-time')
    .refine(isRealInstant, { message: 'not a valid calendar date or ISO 8601 date-time' })
    .describe(description);
}

export const CreatedFromSchema = boundSchema(
  'Inclusive lower bound on the asset creation timestamp (`createdAt`). ' +
    'Accepts a calendar date (`YYYY-MM-DD`, interpreted as the first instant ' +
    'of that UTC day) or a full ISO 8601 date-time. Applied across the whole ' +
    'result set, not just the returned page.'
);

export const CreatedToSchema = boundSchema(
  'Inclusive upper bound on the asset creation timestamp (`createdAt`). ' +
    'Accepts a calendar date (`YYYY-MM-DD`, interpreted as the LAST instant of ' +
    'that UTC day, so the named day is included) or a full ISO 8601 date-time. ' +
    'Applied across the whole result set, not just the returned page.'
);

// Normalise a validated `from` bound to a canonical UTC instant string.
export function normalizeCreatedFrom(value: string): string {
  return new Date(isDateOnly(value) ? `${value}T00:00:00.000Z` : value).toISOString();
}

// Normalise a validated `to` bound to a canonical UTC instant string. A bare
// calendar date covers through the end of that UTC day (inclusive).
export function normalizeCreatedTo(value: string): string {
  return new Date(isDateOnly(value) ? `${value}T23:59:59.999Z` : value).toISOString();
}

// The normalised range carried through the repository layer. Named
// `createdFrom`/`createdTo` rather than `from`/`to` so the repository option is
// unambiguous next to pagination options; the routes map wire -> repo.
export type CreatedRange = {
  createdFrom?: string;
  createdTo?: string;
};

// Inclusive membership test used by every in-process matcher (in-memory repos
// and the CouchDB re-check). Compares parsed instants rather than raw strings so
// it stays correct even for a record whose stored timestamp is not in the
// canonical shape.
export function withinCreatedRange(createdAt: string, range: CreatedRange): boolean {
  if (range.createdFrom === undefined && range.createdTo === undefined) {
    return true;
  }
  const at = Date.parse(createdAt);
  if (Number.isNaN(at)) {
    // An unparseable stored timestamp cannot be placed in the range; excluding
    // it keeps the filter honest rather than leaking an unfilterable record.
    return false;
  }
  if (range.createdFrom !== undefined && at < Date.parse(range.createdFrom)) {
    return false;
  }
  if (range.createdTo !== undefined && at > Date.parse(range.createdTo)) {
    return false;
  }
  return true;
}

// Thrown shape for an inverted range. The routes turn this into a 400 rather
// than quietly answering an empty page, because `from` after `to` can only ever
// be a caller mistake.
export function isInvertedRange(range: CreatedRange): boolean {
  if (range.createdFrom === undefined || range.createdTo === undefined) {
    return false;
  }
  return Date.parse(range.createdFrom) > Date.parse(range.createdTo);
}

// Build the normalised range from the raw wire params, or report the inversion.
export function resolveCreatedRange(params: {
  from?: string;
  to?: string;
}): { ok: true; range: CreatedRange } | { ok: false; message: string } {
  const range: CreatedRange = {
    createdFrom: params.from === undefined ? undefined : normalizeCreatedFrom(params.from),
    createdTo: params.to === undefined ? undefined : normalizeCreatedTo(params.to)
  };
  if (isInvertedRange(range)) {
    return {
      ok: false,
      message: `'from' (${range.createdFrom}) is after 'to' (${range.createdTo})`
    };
  }
  return { ok: true, range };
}
