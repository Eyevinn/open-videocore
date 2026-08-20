// HTTP-backed TAMS Gateway read client — flow + segment reads (issue #163,
// sub-task of #151, epic #116).
//
// This module implements the flow-read and segment-read methods of the
// read-only surface declared in `tams-gateway-client.ts` (issue #162). It maps
// 1:1 to the read endpoints pinned by the contract; it adds NO write/create/
// update/delete path and NO persistence (issue #163 scope: "No write path, no
// persistence").
//
// Contract source (pinned): docs/architecture/ADR-008-tams-gateway-contract.md
// (issue #150), "Verified HTTP API surface" API table and the "Read-only client
// scope (#151)", "Paging", "Time-addressing model", and "Authentication"
// sections. Typed request/response shapes are imported verbatim from the pinned
// interface in `./tams-gateway-client.js` (issue #162) — this file guesses no
// path, field, or type; every endpoint below cites its ADR-008 API-table row.
//
// Style is aligned with the repo's other HTTP-backed OSC clients
// (src/pipeline/encore-client.ts, src/services/param-store.ts): an injectable
// `fetch` for tests, a per-request `AbortController` timeout, a Bearer auth
// header carrying the delegated OSC access token, and `throw new Error(...)`
// with the response status + body text on any non-OK response.

import type {
  TamsGatewayClientConfig,
  TamsGatewayReadClient,
  ListFlowsRequest,
  ListFlowsResponse,
  GetFlowRequest,
  GetFlowResponse,
  ListFlowSegmentsRequest,
  ListFlowSegmentsResponse,
  TamsFlow,
  TamsSegment,
  TamsPaging
} from './tams-gateway-client.js';

// The subset of the pinned read interface implemented by this file. Issue #163
// covers flow reads and segment reads only; the source reads
// (`listSources` / `getSource`) are a sibling sub-task and are intentionally
// NOT implemented here. Using `Pick` keeps this implementation typed against the
// pinned `TamsGatewayReadClient` (issue #162) rather than a re-declared shape.
export type TamsGatewayFlowSegmentReadClient = Pick<
  TamsGatewayReadClient,
  'listFlows' | 'getFlow' | 'listFlowSegments'
>;

// Config for the HTTP client. Extends the pinned `TamsGatewayClientConfig`
// (issue #162) with an injectable `fetch` so tests can substitute a mocked
// gateway without standing up a real instance (mirrors HttpEncoreConfig.fetch
// and HttpParamStoreConfig.fetch).
export interface HttpTamsGatewayReadClientConfig extends TamsGatewayClientConfig {
  // Injectable fetch for tests; defaults to global fetch.
  fetch?: typeof globalThis.fetch;
}

// Default matches the other OSC HTTP clients (param-store) when the caller
// supplies no `timeoutMs` (TamsGatewayClientConfig.timeoutMs is optional).
const DEFAULT_TIMEOUT_MS = 10_000;

// Parse the opaque continuation key for the next segment page. ADR-008 "Paging"
// (lines 90-94): follow the `Link: <...>; rel="next"` header, or feed
// `X-Paging-NextKey` back as the `page` query param. We prefer the explicit
// `X-Paging-NextKey` header and fall back to parsing the `Link` header's
// rel="next" target's `page` query param.
function parseNextKey(headers: Headers): string | undefined {
  const explicit = headers.get('x-paging-nextkey');
  if (explicit && explicit.length > 0) return explicit;

  const link = headers.get('link');
  if (!link) return undefined;
  // Link header grammar: `<url>; rel="next", <url>; rel="prev"`. Find the
  // comma-separated part whose params include rel="next".
  for (const part of link.split(',')) {
    if (!/rel\s*=\s*"?next"?/i.test(part)) continue;
    const match = part.match(/<([^>]+)>/);
    if (!match) continue;
    // The next-page URL carries the continuation as its `page` query param.
    try {
      const url = new URL(match[1], 'http://tams.local');
      const page = url.searchParams.get('page');
      if (page && page.length > 0) return page;
    } catch {
      // Malformed Link target — ignore and fall through.
    }
  }
  return undefined;
}

// Build the `TamsPaging` envelope from the segment listing's response headers
// (ADR-008 "Paging", lines 90-94). Header values are numeric/boolean-encoded as
// strings; absent headers leave the corresponding field undefined.
function parsePaging(headers: Headers): TamsPaging {
  const paging: TamsPaging = {};

  const limit = headers.get('x-paging-limit');
  if (limit !== null) {
    const parsed = Number(limit);
    if (!Number.isNaN(parsed)) paging.limit = parsed;
  }

  const count = headers.get('x-paging-count');
  if (count !== null) {
    const parsed = Number(count);
    if (!Number.isNaN(parsed)) paging.count = parsed;
  }

  const reverse = headers.get('x-paging-reverse-order');
  if (reverse !== null) paging.reverseOrder = reverse.toLowerCase() === 'true';

  const timerange = headers.get('x-paging-timerange');
  if (timerange !== null && timerange.length > 0) paging.timerange = timerange;

  const nextKey = parseNextKey(headers);
  if (nextKey !== undefined) paging.nextKey = nextKey;

  return paging;
}

// Create an HTTP-backed TAMS Gateway read client for the flow + segment reads.
//
// Auth (ADR-008 "Authentication", lines 116-122; ADR-001 open question 2): the
// gateway sits behind the OSC ingress gate with its own `API_TOKEN` unset, so we
// authenticate with the delegated OSC access token as a Bearer credential — NOT
// a TAMS-specific API token. The token is read from config, which per CLAUDE.md
// and 12-factor must itself be sourced from the environment / OSC context, never
// hardcoded.
export function makeHttpTamsGatewayReadClient(
  config: HttpTamsGatewayReadClientConfig
): TamsGatewayFlowSegmentReadClient {
  const doFetch = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // A trailing slash on the base URL is not significant (TamsGatewayClientConfig
  // "A trailing slash, if present, is not significant.").
  const base = config.gatewayBaseUrl.replace(/\/$/, '');

  async function withTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  function authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${config.oscAccessToken}` };
  }

  async function getJson(url: string): Promise<{ body: unknown; headers: Headers }> {
    const res = await withTimeout((signal) =>
      doFetch(url, { method: 'GET', headers: authHeaders(), signal })
    );
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`TAMS gateway read failed: ${res.status} ${text}`.trim());
    }
    const body = await res.json().catch(() => undefined);
    return { body, headers: res.headers };
  }

  return {
    // List flows. Maps to: GET /flows (ADR-008 API table, line 66; "Read-only
    // client scope (#151)", lines 82-89).
    async listFlows(
      _request?: ListFlowsRequest
    ): Promise<ListFlowsResponse> {
      // ListFlowsRequest carries no ADR-tabled filters (issue #162); the arg is
      // accepted for signature stability but sends no query params.
      const { body } = await getJson(`${base}/flows`);
      // GET /flows returns a bare JSON array of flow records.
      const flows = (Array.isArray(body) ? body : []) as TamsFlow[];
      return { flows };
    },

    // Get a single flow by id (and, implicitly, its source id). Maps to:
    // GET /flows/{id} (ADR-008 API table, line 68).
    async getFlow(request: GetFlowRequest): Promise<GetFlowResponse> {
      const { body } = await getJson(
        `${base}/flows/${encodeURIComponent(request.flowId)}`
      );
      return { flow: (body ?? {}) as TamsFlow };
    },

    // List a flow's segments, optionally filtered by TAI timerange, one paged
    // page at a time. Maps to:
    // GET /flows/{id}/segments?timerange=[start_end) (ADR-008 API table, line
    // 75; "Paging", lines 90-94; "Time-addressing model", lines 102-105).
    async listFlowSegments(
      request: ListFlowSegmentsRequest
    ): Promise<ListFlowSegmentsResponse> {
      const params = new URLSearchParams();
      // `timerange` query filter in the pinned grammar (ADR-008 API table).
      if (request.timerange !== undefined) {
        params.set('timerange', request.timerange);
      }
      // `limit` requested page size (ADR-008 "Paging").
      if (request.limit !== undefined) {
        params.set('limit', String(request.limit));
      }
      // `page` continuation key from a prior page's nextKey (ADR-008 "Paging").
      if (request.page !== undefined) {
        params.set('page', request.page);
      }
      const query = params.toString();
      const url =
        `${base}/flows/${encodeURIComponent(request.flowId)}/segments` +
        (query ? `?${query}` : '');

      const { body, headers } = await getJson(url);
      // GET /flows/{id}/segments returns a bare JSON array of segments; the
      // paging envelope is carried in response headers (ADR-008 "Paging").
      const segments = (Array.isArray(body) ? body : []) as TamsSegment[];
      return { segments, paging: parsePaging(headers) };
    }
  };
}
