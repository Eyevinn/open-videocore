// Read-only TAMS Gateway client interface + config surface (issue #162,
// sub-task of #151, epic #116).
//
// This module defines ONLY the typed public surface of the TAMS Gateway read
// client: the configuration shape and a read-only interface whose methods map
// 1:1 to the verified read endpoints of the eyevinn-tams-gateway service. It
// deliberately contains NO endpoint implementation logic, NO persistence, and
// NO write/create/update/delete methods — those write endpoints belong to the
// indexing path (#169/#170), not the read client (ADR-008, "Read-only client
// scope (#151)", lines 82-89).
//
// Contract source (pinned): docs/architecture/ADR-008-tams-gateway-contract.md,
// "Verified HTTP API surface" (API table), "Read-only client scope (#151)",
// "Paging", and "Time-addressing model" sections. Every method below cites the
// exact HTTP verb + path it maps to. Do not add endpoints or fields that are
// not present in that ADR.
//
// Service identity (ADR-008, "Verified service identity"): serviceId
// `eyevinn-tams-gateway`, category `media`, implementing the AMWA/BBC TAMS API.
//
// Auth model (ADR-008, "Authentication", lines 117-122; ADR-001 open question 2,
// RESOLVED 2026-06-01): behind the OSC ingress gate the gateway leaves its own
// `API_TOKEN` unset and delegates authentication to the OSC auth-wall. The read
// client therefore reaches the instance through the delegated OSC access token
// — NOT a TAMS-specific API token. See `TamsGatewayClientConfig.oscAccessToken`.

// ---------------------------------------------------------------------------
// Configuration surface
// ---------------------------------------------------------------------------

// Configuration for a read-only TAMS Gateway client instance.
//
// The client is stateless with respect to persistence: it holds only the
// coordinates needed to reach a provisioned gateway instance and authenticate
// against the OSC auth-wall. Config is treated as immutable per instance
// (ADR-008 notes the gateway itself has no in-place update support).
export interface TamsGatewayClientConfig {
  // Base URL of the provisioned eyevinn-tams-gateway instance (e.g. the
  // instance `url` resolved from OSC). Paths from ADR-008's API table are
  // appended to this. A trailing slash, if present, is not significant.
  gatewayBaseUrl: string;

  // The delegated OSC access token used to authenticate every call, sent as a
  // Bearer credential so the OSC auth-wall terminates service auth at the edge
  // (ADR-008 "Authentication"; ADR-001 open question 2). This is the operator's
  // OSC credential threaded through to the gateway — the client never holds a
  // TAMS-specific `API_TOKEN`. Never hardcode: source from the environment /
  // OSC context per 12-factor and CLAUDE.md.
  oscAccessToken: string;

  // Optional per-request timeout in milliseconds applied to each gateway call.
  // When unset, the implementation (#151 endpoint logic) selects a default.
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Shared value types (derived from ADR-008 "Time-addressing model")
// ---------------------------------------------------------------------------

// A TAMS timerange string in the pinned grammar
// `[<seconds>:<nanoseconds>_<seconds>:<nanoseconds>)` on the TAI timescale
// (ADR-008 "Time-addressing model", lines 102-105). Bounds use interval
// notation (`[`/`]` inclusive, `(`/`)` exclusive); open-ended ranges are
// permitted, e.g. `[0:0_10:0)`. Modelled as a validated string type at the
// addressing-field layer (#152) — here it is the transport string.
export type TamsTimerange = string;

// A source id — the abstract media identity (ADR-008 "Time-addressing model":
// "a source is the abstract media"). Path parameter for source reads.
export type TamsSourceId = string;

// A flow id — a concrete representation of a source (ADR-008: "a flow is a
// concrete representation of a source"). A source may carry many flows. Path
// parameter for flow and segment reads.
export type TamsFlowId = string;

// A TAMS flow record. Modelled as an open shape: ADR-008 pins the endpoint
// paths and the addressing hierarchy but does not table the full JSON body of a
// flow, so only the fields the read client can rely on from the ADR are named,
// and the rest are preserved. Named property sub-resources called out by
// ADR-008 (lines 95-98) are surfaced as optional fields.
export interface TamsFlow {
  id: TamsFlowId;
  // The source this flow is a representation of (ADR-008 addressing hierarchy).
  source_id?: TamsSourceId;
  // Named, individually-addressable flow properties (ADR-008 "Property
  // sub-resources", lines 95-98). All optional; present when set on the flow.
  description?: string;
  label?: string;
  max_bit_rate?: number;
  avg_bit_rate?: number;
  flow_collection?: unknown;
  // Writes to a `read_only` flow return 403 (ADR-008 line 98); surfaced here so
  // read consumers can see the flag without attempting a write.
  read_only?: boolean;
  // Unspecified-in-ADR fields from the gateway's flow body are preserved rather
  // than dropped. The full body shape is deferred to the mapping ADR (#169).
  [key: string]: unknown;
}

// A TAMS source record — the abstract media (ADR-008 addressing hierarchy).
// Same open-shape rationale as TamsFlow: the ADR pins paths, not the full body.
export interface TamsSource {
  id: TamsSourceId;
  description?: string;
  label?: string;
  [key: string]: unknown;
}

// A TAMS segment — a time-addressed media object making up a flow (ADR-008
// "Time-addressing model": "segments are the time-addressed media objects that
// make up a flow"). Each segment carries the timerange it covers; the ADR does
// not table the full segment body, so remaining fields are preserved.
export interface TamsSegment {
  // The TAI timerange this segment covers, in the pinned grammar.
  timerange: TamsTimerange;
  [key: string]: unknown;
}

// Paging envelope for the segment listing (ADR-008 "Paging", lines 90-94).
// `GET /flows/{id}/segments` is paged: pass `limit`, then follow the
// `Link: <...>; rel="next"` header (or feed `X-Paging-NextKey` back as the
// `page` query param). Responses carry `X-Paging-Limit`, `X-Paging-Count`,
// `X-Paging-Reverse-Order`, `X-Paging-Timerange`. The read client must expose
// paging rather than assume a single-shot list, so these header-derived values
// are surfaced alongside the page items.
export interface TamsPaging {
  // Server-applied page size (from `X-Paging-Limit`).
  limit?: number;
  // Number of items in this page (from `X-Paging-Count`).
  count?: number;
  // Whether the server returned results in reverse order
  // (from `X-Paging-Reverse-Order`).
  reverseOrder?: boolean;
  // The effective timerange the server applied (from `X-Paging-Timerange`).
  timerange?: TamsTimerange;
  // Opaque continuation key for the next page (from `X-Paging-NextKey`, or
  // parsed from the `Link: rel="next"` header). Feed back as `page` on the next
  // request. Absent when there are no further pages.
  nextKey?: string;
}

// ---------------------------------------------------------------------------
// Request parameter types (one per read method)
// ---------------------------------------------------------------------------

// Request params for listing flows. GET /flows takes no required path/query
// params in the ADR table; kept as an explicit (empty, extensible) type so the
// signature is stable if list filters are later pinned by the ADR.
export interface ListFlowsRequest {
  // Reserved for future ADR-pinned list filters. None are tabled in ADR-008.
  [key: string]: never;
}

// Request params for getting a single flow by id.
export interface GetFlowRequest {
  flowId: TamsFlowId;
}

// Request params for listing sources. GET /sources takes no required params in
// the ADR table (mirrors ListFlowsRequest).
export interface ListSourcesRequest {
  [key: string]: never;
}

// Request params for getting a single source by id.
export interface GetSourceRequest {
  sourceId: TamsSourceId;
}

// Request params for listing a flow's segments, filtered by timerange and
// paged (ADR-008 API table line 75 + "Paging" lines 90-94).
export interface ListFlowSegmentsRequest {
  flowId: TamsFlowId;
  // The `timerange` query filter in the pinned grammar (ADR-008 API table:
  // `GET /flows/{id}/segments?timerange=[start_end)`). Optional: an unfiltered
  // read returns the flow's segments subject to paging.
  timerange?: TamsTimerange;
  // Requested page size — sent as the `limit` query param (ADR-008 "Paging").
  limit?: number;
  // Continuation key from a prior page's `TamsPaging.nextKey` — sent as the
  // `page` query param to fetch the next page (ADR-008 "Paging").
  page?: string;
}

// ---------------------------------------------------------------------------
// Response types (one per read method)
// ---------------------------------------------------------------------------

// Response for listing flows: the flow records.
export interface ListFlowsResponse {
  flows: TamsFlow[];
}

// Response for getting a single flow. ADR-008 line 68 notes GET /flows/{id}
// gets a flow "and, implicitly, its source"; the source id is carried on the
// flow (`TamsFlow.source_id`).
export interface GetFlowResponse {
  flow: TamsFlow;
}

// Response for listing sources: the source records.
export interface ListSourcesResponse {
  sources: TamsSource[];
}

// Response for getting a single source.
export interface GetSourceResponse {
  source: TamsSource;
}

// Response for listing a flow's segments: one page of segments plus the paging
// envelope so callers can request the next page (ADR-008 "Paging").
export interface ListFlowSegmentsResponse {
  segments: TamsSegment[];
  paging: TamsPaging;
}

// ---------------------------------------------------------------------------
// Read-only client interface
// ---------------------------------------------------------------------------

// The read-only TAMS Gateway client.
//
// Scope is bounded to the FIVE read endpoints pinned by ADR-008 ("Read-only
// client scope (#151)", lines 82-89): the flow reads, the source reads, and the
// timerange-filtered segment read. There are intentionally NO write, create,
// update, or delete methods on this interface — the gateway's PUT/POST/DELETE
// endpoints belong to the indexing path (#169/#170), not this client.
//
// Every method resolves against a configured gateway instance (see
// TamsGatewayClientConfig) and authenticates via the delegated OSC access token
// through the OSC auth-wall.
export interface TamsGatewayReadClient {
  // List flows.
  // Maps to: GET /flows
  // Source: ADR-008 "Verified HTTP API surface" API table (line 66) and
  // "Read-only client scope (#151)" (lines 82-89).
  listFlows(request?: ListFlowsRequest): Promise<ListFlowsResponse>;

  // Get a single flow by id (and, implicitly, its source id).
  // Maps to: GET /flows/{id}
  // Source: ADR-008 API table (line 68) and "Read-only client scope (#151)".
  getFlow(request: GetFlowRequest): Promise<GetFlowResponse>;

  // List sources.
  // Maps to: GET /sources
  // Source: ADR-008 API table (line 71) and "Read-only client scope (#151)".
  listSources(request?: ListSourcesRequest): Promise<ListSourcesResponse>;

  // Get a single source by id.
  // Maps to: GET /sources/{id}
  // Source: ADR-008 API table (line 72) and "Read-only client scope (#151)".
  getSource(request: GetSourceRequest): Promise<GetSourceResponse>;

  // List a flow's segments, optionally filtered by TAI timerange, returned one
  // paged page at a time.
  // Maps to: GET /flows/{id}/segments?timerange=[start_end)
  // Source: ADR-008 API table (line 75), "Read-only client scope (#151)"
  // (lines 82-89), "Paging" (lines 90-94), and "Time-addressing model"
  // (lines 102-105).
  listFlowSegments(
    request: ListFlowSegmentsRequest
  ): Promise<ListFlowSegmentsResponse>;
}
