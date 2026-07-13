// Timerange read method for the read-only TAMS Gateway client (issue #164,
// sub-task of #151, epic #116).
//
// This module implements the TAMS "timerange read": the timerange-filtered,
// paged segment listing. It maps 1:1 to the single pinned endpoint
//
//   GET /flows/{id}/segments?timerange=[start_end)
//
// from docs/architecture/ADR-008-tams-gateway-contract.md, "Verified HTTP API
// surface" API table (line 75), "Read-only client scope (#151)" (lines 82-89),
// "Paging" (lines 90-94) and "Time-addressing model" (lines 102-105). No other
// endpoint is contacted here; the flow/source reads live elsewhere (#163) and
// the write endpoints belong to the indexing path (#169/#170).
//
// Contract symbols used (from src/tams/tams-gateway-client.ts, pinned #162):
//   - TamsGatewayReadClient.listFlowSegments  (interface method, mapped 1:1)
//   - ListFlowSegmentsRequest { flowId, timerange?, limit?, page? }
//   - ListFlowSegmentsResponse { segments, paging }
//   - TamsSegment { timerange, [key]: unknown }
//   - TamsPaging { limit?, count?, reverseOrder?, timerange?, nextKey? }
//   - TamsGatewayClientConfig { gatewayBaseUrl, oscAccessToken, timeoutMs? }
//   - TamsTimerange, TamsFlowId
//
// Error-handling contract (enforced here for the timerange read, shared with the
// other read methods): see src/tams/tams-gateway-error.ts. Every non-success
// outcome — 404, other 4xx, 5xx, and a 2xx body that fails schema validation —
// is surfaced as a thrown, typed TamsGatewayError with a discriminating `.kind`.

import { z } from 'zod';

import type {
  ListFlowSegmentsRequest,
  ListFlowSegmentsResponse,
  TamsGatewayClientConfig,
  TamsPaging,
  TamsSegment
} from './tams-gateway-client.js';
import { tamsHttpError, tamsInvalidPayloadError, TamsGatewayError } from './tams-gateway-error.js';

const OPERATION = 'listFlowSegments';

// Default per-request timeout when the config does not pin one. Applied via an
// AbortSignal so a hung gateway does not hang the read (CLAUDE.md: all external
// OSC calls must have a timeout).
const DEFAULT_TIMEOUT_MS = 15_000;

// Response-body schema for the segment listing. ADR-008 does not table the full
// JSON body of a segment beyond the required `timerange` (Time-addressing
// model), so the schema pins ONLY that field and passes the rest through — this
// matches the open-shape TamsSegment in the pinned interface. The gateway
// returns the page as a bare JSON array of segment objects; the paging metadata
// travels in response headers (ADR-008 "Paging"), not the body.
const segmentSchema = z
  .object({
    // Required by ADR-008: every segment carries the TAI timerange it covers.
    timerange: z.string()
  })
  .passthrough();

const segmentsBodySchema = z.array(segmentSchema);

// Config that additionally lets tests inject a fetch fake (mirrors the pattern
// in pipeline/encore-client.ts). Production callers pass only the pinned
// TamsGatewayClientConfig fields; `fetch` defaults to global fetch.
export type TamsTimerangeClientConfig = TamsGatewayClientConfig & {
  fetch?: typeof globalThis.fetch;
};

// The narrow client surface this module provides: the pinned timerange read
// method only. It is a structural subset of TamsGatewayReadClient so it can be
// composed into the full read client once the sibling flow/source methods land.
export interface TamsTimerangeReadClient {
  listFlowSegments(request: ListFlowSegmentsRequest): Promise<ListFlowSegmentsResponse>;
}

// Parse the paging envelope from the response headers per ADR-008 "Paging"
// (X-Paging-* headers + Link: rel="next"). Header parse failures are treated as
// "field absent" — they must not fail a valid 2xx segment page.
function parsePaging(headers: Headers): TamsPaging {
  const paging: TamsPaging = {};

  const limit = headers.get('x-paging-limit');
  if (limit !== null && limit.trim() !== '') {
    const n = Number(limit);
    if (Number.isFinite(n)) paging.limit = n;
  }

  const count = headers.get('x-paging-count');
  if (count !== null && count.trim() !== '') {
    const n = Number(count);
    if (Number.isFinite(n)) paging.count = n;
  }

  const reverse = headers.get('x-paging-reverse-order');
  if (reverse !== null && reverse.trim() !== '') {
    paging.reverseOrder = reverse.toLowerCase() === 'true';
  }

  const timerange = headers.get('x-paging-timerange');
  if (timerange !== null && timerange.trim() !== '') {
    paging.timerange = timerange;
  }

  // Prefer the explicit next-key header; fall back to the Link rel="next" URL's
  // `page` query param (ADR-008 "Paging" describes both mechanisms).
  const nextKey = headers.get('x-paging-nextkey');
  if (nextKey !== null && nextKey.trim() !== '') {
    paging.nextKey = nextKey;
  } else {
    const link = headers.get('link');
    const fromLink = link ? nextKeyFromLinkHeader(link) : undefined;
    if (fromLink) paging.nextKey = fromLink;
  }

  return paging;
}

// Extract the `page` query param from a `Link: <url>; rel="next"` header.
function nextKeyFromLinkHeader(linkHeader: string): string | undefined {
  for (const part of linkHeader.split(',')) {
    if (!/rel="?next"?/i.test(part)) continue;
    const match = part.match(/<([^>]+)>/);
    if (!match) continue;
    try {
      const url = new URL(match[1], 'http://placeholder.invalid');
      const page = url.searchParams.get('page');
      if (page) return page;
    } catch {
      // Unparseable Link URL: treat next-key as absent (no throw).
    }
    return undefined;
  }
  return undefined;
}

// Build the request URL for the timerange read, appending only the query params
// that are present (ADR-008 API table + "Paging": timerange, limit, page).
function buildUrl(baseUrl: string, request: ListFlowSegmentsRequest): string {
  const trimmed = baseUrl.replace(/\/$/, '');
  const path = `${trimmed}/flows/${encodeURIComponent(request.flowId)}/segments`;
  const params = new URLSearchParams();
  // The timerange grammar contains reserved chars ([ , : , ) ); URLSearchParams
  // percent-encodes them safely so the pinned `[start_end)` filter round-trips.
  if (request.timerange !== undefined) params.set('timerange', request.timerange);
  if (request.limit !== undefined) params.set('limit', String(request.limit));
  if (request.page !== undefined) params.set('page', request.page);
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

// Construct the timerange read client. `config.fetch` is injectable for tests;
// production defaults to global fetch (ESM-safe, no import needed).
export function makeTamsTimerangeReadClient(
  config: TamsTimerangeClientConfig
): TamsTimerangeReadClient {
  const doFetch = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return {
    // Timerange read — GET /flows/{id}/segments?timerange=[start_end)
    // (ADR-008 API table line 75). Returns one paged page of segments plus the
    // header-derived paging envelope. Enforces the shared error contract.
    async listFlowSegments(
      request: ListFlowSegmentsRequest
    ): Promise<ListFlowSegmentsResponse> {
      const url = buildUrl(config.gatewayBaseUrl, request);

      // Per-request timeout so a hung gateway cannot hang the caller.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      let res: Response;
      try {
        res = await doFetch(url, {
          method: 'GET',
          headers: {
            accept: 'application/json',
            // Delegated OSC access token as a Bearer credential (ADR-008
            // "Authentication"): the OSC auth-wall terminates service auth.
            authorization: `Bearer ${config.oscAccessToken}`
          },
          signal: controller.signal
        });
      } catch (cause) {
        // Network failure / abort (timeout) — no HTTP status obtained. Mapped to
        // 'server-error' per the contract so callers see a single failure type.
        throw new TamsGatewayError({
          kind: 'server-error',
          operation: OPERATION,
          message: `TAMS gateway ${OPERATION} request failed: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
          cause
        });
      } finally {
        clearTimeout(timer);
      }

      // Non-2xx: 404 -> 'not-found', other 4xx -> 'client-error',
      // 5xx/unexpected -> 'server-error' (tams-gateway-error.ts).
      if (!res.ok) {
        const bodyText = await res.text().catch(() => '');
        throw tamsHttpError({ operation: OPERATION, status: res.status, bodyText });
      }

      // 2xx: parse then schema-validate the body. A malformed / non-conforming
      // payload becomes a typed 'invalid-payload' error — it is never returned
      // as if valid.
      let raw: unknown;
      try {
        raw = await res.json();
      } catch (cause) {
        throw new TamsGatewayError({
          kind: 'invalid-payload',
          operation: OPERATION,
          status: res.status,
          message: `TAMS gateway ${OPERATION} returned unparseable JSON`,
          validationIssues: ['(root): response body is not valid JSON'],
          cause
        });
      }

      const parsed = segmentsBodySchema.safeParse(raw);
      if (!parsed.success) {
        throw tamsInvalidPayloadError({
          operation: OPERATION,
          status: res.status,
          zodError: parsed.error
        });
      }

      // Validated array elements satisfy the open-shape TamsSegment.
      const segments = parsed.data as TamsSegment[];
      const paging = parsePaging(res.headers);
      return { segments, paging };
    }
  };
}
