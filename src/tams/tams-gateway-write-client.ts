// TAMS Gateway write / index client (issue #170, sub-task of the #116 TAMS
// bridge epic). Implements the idempotent index-write of ONE Open Videocore
// asset against the shared eyevinn-tams-gateway store.
//
// Scope: this module owns the WRITE path only — the read client
// (`tams-gateway-client.ts`, #151) is deliberately read-only, so the gateway's
// PUT/POST endpoints live here (ADR-008 "Read-only client scope (#151)", which
// assigns the write endpoints to the indexing path #169/#170). It reuses the
// SAME public types from `tams-gateway-client.ts` (config, id, timerange, flow,
// source, segment) so the two clients share one contract surface.
//
// Contract sources (pinned):
//   - docs/architecture/ADR-008-tams-gateway-contract.md
//       * "Verified HTTP API surface" API table — the write endpoints used:
//           PUT  /flows/{id}              (create/update a flow AND its source)
//           POST /flows/{id}/segments     (register a segment for a flow)
//       * "Time-addressing model" — the TAI timerange grammar
//           `[<seconds>:<nanoseconds>_<seconds>:<nanoseconds>)`.
//       * "Authentication" — delegated OSC Bearer token through the OSC gate.
//   - ADR-009 (mapping ADR, #169) LOCKED decisions (branch not yet on main):
//       * one asset -> one TAMS Source + one canonical Flow; media exposed as
//         Segment(s) on that flow; v1 = exactly one flow per asset.
//       * deterministic id derivation via UUIDv5:
//           flowId   = uuidv5(assetUlid, TAMS_BRIDGE_FLOW_NAMESPACE)
//           sourceId = uuidv5(assetUlid, TAMS_BRIDGE_SOURCE_NAMESPACE)
//         UUIDv5 is a pure function of (namespace, name), so re-indexing the
//         same asset always targets the same ids => idempotent by construction.
//       * timerange: a single full-duration segment `[0:0_<duration>)`.
//       * an asset with no known duration is NOT indexed (skip + log).
//
// CONTRACT-GAP (see PUT-body comment below and the OSC feedback log): ADR-008
// does NOT table the `PUT /flows/{id}` request-body field that carries the
// source id (whether the gateway assigns it or accepts a caller-supplied one).
// We pass the deterministic sourceId in the most contract-consistent field
// (`source_id`, the same field the read-client `TamsFlow` surfaces for the
// flow->source link) and mark it `// CONTRACT-GAP:` rather than invent a
// verified field name.

import { createHash } from 'node:crypto';

import type { Asset } from '../data/asset-repo.js';
import type {
  TamsFlowId,
  TamsGatewayClientConfig,
  TamsSourceId,
  TamsTimerange
} from './tams-gateway-client.js';

// ---------------------------------------------------------------------------
// Deterministic id-derivation namespaces (ADR-009 LOCKED)
// ---------------------------------------------------------------------------

// Fixed, committed namespace UUID constants for the UUIDv5 derivation. These are
// part of the ADR-009 contract: they MUST NOT change once assets are indexed,
// because the derived flow/source ids (and therefore idempotency) depend on
// them. Two distinct namespaces guarantee flowId !== sourceId for the same
// asset ULID. Generated as random v4 UUIDs and frozen here as constants.
export const TAMS_BRIDGE_FLOW_NAMESPACE = '6f8a1e2c-3b4d-4a5e-8c7f-1d2e3a4b5c6d';
export const TAMS_BRIDGE_SOURCE_NAMESPACE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

// ---------------------------------------------------------------------------
// UUIDv5 (RFC 4122 sec. 4.3) — SHA-1 name-based UUID.
// ---------------------------------------------------------------------------

// No `uuid` package is a dependency (checked package.json), and Node's
// `crypto.randomUUID` only emits v4 — which is NOT deterministic. UUIDv5 is a
// pure SHA-1 hash of (namespace bytes || name bytes) with the version/variant
// bits overwritten, so we implement it directly on `node:crypto` (already used
// elsewhere: createHmac in webhook-dispatcher, randomUUID in operation-store).
// This keeps the derivation dependency-free and deterministic.

function parseUuidToBytes(uuid: string): Buffer {
  const hex = uuid.replace(/-/g, '');
  if (hex.length !== 32 || /[^0-9a-fA-F]/.test(hex)) {
    throw new Error(`invalid namespace UUID: ${uuid}`);
  }
  return Buffer.from(hex, 'hex');
}

function bytesToUuid(bytes: Buffer): string {
  const hex = bytes.toString('hex');
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-` +
    `${hex.slice(16, 20)}-${hex.slice(20, 32)}`
  );
}

// Compute the RFC 4122 v5 UUID for (namespace, name). Deterministic: identical
// inputs always yield the identical UUID — the property ADR-009 relies on for
// idempotent re-indexing.
export function uuidv5(name: string, namespaceUuid: string): string {
  const namespaceBytes = parseUuidToBytes(namespaceUuid);
  const nameBytes = Buffer.from(name, 'utf8');
  const hash = createHash('sha1')
    .update(namespaceBytes)
    .update(nameBytes)
    .digest();
  // Take the first 16 bytes and set version (5) + variant (RFC 4122) bits.
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  return bytesToUuid(bytes);
}

// Derive the deterministic TAMS flow id for an asset ULID (ADR-009 LOCKED).
export function deriveFlowId(assetUlid: string): TamsFlowId {
  return uuidv5(assetUlid, TAMS_BRIDGE_FLOW_NAMESPACE);
}

// Derive the deterministic TAMS source id for an asset ULID (ADR-009 LOCKED).
export function deriveSourceId(assetUlid: string): TamsSourceId {
  return uuidv5(assetUlid, TAMS_BRIDGE_SOURCE_NAMESPACE);
}

// ---------------------------------------------------------------------------
// Timerange derivation (ADR-009 LOCKED + ADR-008 grammar)
// ---------------------------------------------------------------------------

// Build the single full-duration segment timerange `[0:0_<seconds>:<nanos>)` in
// the ADR-008 TAI grammar from a duration in seconds. Returns undefined when the
// duration is not a positive finite number — the caller skips indexing (ADR-009:
// "an asset with no known duration is NOT indexed").
export function fullDurationTimerange(durationSeconds: number | undefined): TamsTimerange | undefined {
  if (
    durationSeconds === undefined ||
    !Number.isFinite(durationSeconds) ||
    durationSeconds <= 0
  ) {
    return undefined;
  }
  const wholeSeconds = Math.floor(durationSeconds);
  // Fractional remainder -> nanoseconds on the TAI timescale.
  const nanos = Math.round((durationSeconds - wholeSeconds) * 1_000_000_000);
  // Guard the rounding edge (e.g. 9.9999999995 -> 10:0 rather than 9:1e9).
  if (nanos >= 1_000_000_000) {
    return `[0:0_${wholeSeconds + 1}:0)`;
  }
  return `[0:0_${wholeSeconds}:${nanos})`;
}

// Resolve an asset's known duration in seconds from the flat domain model. The
// exact field is the ffprobe-derived `technicalMetadata.durationSeconds`
// (src/data/asset-repo.ts, `TechnicalMetadata.durationSeconds`). Returns
// undefined when no technical metadata (and hence no duration) is known.
export function assetDurationSeconds(asset: Asset): number | undefined {
  return asset.technicalMetadata?.durationSeconds;
}

// ---------------------------------------------------------------------------
// Write-client interface + result
// ---------------------------------------------------------------------------

// The outcome of an index-write for one asset.
export interface IndexAssetResult {
  // Whether the asset was indexed. `false` only when it was skipped for lack of
  // a known duration (ADR-009). Any gateway/transport failure throws instead.
  indexed: boolean;
  // Present when indexed: the deterministic ids the asset maps onto, plus the
  // full-duration timerange the segment covers. A caller (#170 acceptance
  // criterion: "addressable by timerange") persists these onto the asset's
  // structural TAMS block (tamsFlowIds / tamsTimerange).
  flowId?: TamsFlowId;
  sourceId?: TamsSourceId;
  timerange?: TamsTimerange;
  // 'skipped-no-duration' when indexed === false; else undefined.
  skippedReason?: 'skipped-no-duration';
}

// The write client. One method: register a single asset against the TAMS store.
// Bounded to the write endpoints ADR-008 tables (PUT /flows/{id},
// POST /flows/{id}/segments). Idempotent by construction (deterministic ids).
export interface TamsGatewayWriteClient {
  // Register one ready asset against the TAMS store so it becomes addressable by
  // timerange. Idempotent: re-indexing the same asset targets the identical
  // derived flow/source ids and the identical full-duration segment timerange,
  // so a second call is a safe upsert that creates no duplicate entities.
  indexAsset(asset: Asset): Promise<IndexAssetResult>;
}

// Config for the HTTP-backed write client. Extends the shared read-client config
// surface (baseUrl + delegated OSC token + timeout) with an injectable fetch so
// tests can substitute a fake gateway (mirrors makeHttpEncoreClient).
export interface HttpTamsWriteClientConfig extends TamsGatewayClientConfig {
  // Injectable fetch for tests; defaults to global fetch.
  fetch?: typeof globalThis.fetch;
  // Optional structured logger for the skip-on-no-duration case (ADR-009 asks
  // for "skip + log"). Defaults to console.warn.
  logger?: (message: string, context?: Record<string, unknown>) => void;
}

// Default per-request timeout when the caller does not set one.
const DEFAULT_TIMEOUT_MS = 10_000;

// Strip a single trailing slash so paths append cleanly (matches read/encore).
function normaliseBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Request-body builders (verified against ADR-008; CONTRACT-GAP marked inline)
// ---------------------------------------------------------------------------

// Build the PUT /flows/{id} body. ADR-008 line 69 documents that PUT /flows/{id}
// "Create or update a flow and its source", and the read-client `TamsFlow` type
// (tams-gateway-client.ts) surfaces `id` and `source_id` as the flow->source
// linkage. We therefore send the derived flowId as `id` and the derived
// sourceId as `source_id`.
export function buildPutFlowBody(flowId: TamsFlowId, sourceId: TamsSourceId): Record<string, unknown> {
  return {
    // Flow id — path param AND body id (idempotent target).
    id: flowId,
    // CONTRACT-GAP: ADR-008 does NOT table the PUT /flows/{id} request-body
    // field that carries the source id (whether the gateway assigns it or
    // accepts a caller-supplied one). We pass the deterministic sourceId in
    // `source_id` — the SAME field the verified read-client `TamsFlow` type
    // exposes for the flow->source link — as the most contract-consistent
    // choice, rather than inventing an unverified field name. If the gateway
    // ignores a caller-supplied source id and self-assigns, this field is
    // harmless; if it honours it, we get the deterministic (idempotent) source.
    // Logged in docs/osc-feedback/incoming-tams-index-write.md.
    source_id: sourceId
  };
}

// Build the POST /flows/{id}/segments body. ADR-008 line 74 tables the endpoint
// as "Register a segment for a flow" and the read-client `TamsSegment` type
// pins `timerange` as the field carrying the TAI range a segment covers. We
// send exactly that one field for the single full-duration segment (ADR-009).
export function buildPostSegmentBody(timerange: TamsTimerange): Record<string, unknown> {
  return { timerange };
}

// ---------------------------------------------------------------------------
// HTTP-backed implementation
// ---------------------------------------------------------------------------

export function makeHttpTamsWriteClient(
  config: HttpTamsWriteClientConfig
): TamsGatewayWriteClient {
  const doFetch = config.fetch ?? globalThis.fetch;
  const baseUrl = normaliseBaseUrl(config.gatewayBaseUrl);
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const log = config.logger ?? ((message, context) => console.warn(message, context ?? {}));

  // One fetch with the delegated OSC Bearer token, JSON body, and a per-request
  // timeout (CLAUDE.md: every OSC call needs a timeout + error handling).
  async function call(
    method: 'PUT' | 'POST',
    path: string,
    body: Record<string, unknown>
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          // Delegated OSC access token (ADR-008 "Authentication"): the OSC gate
          // terminates auth; the client never holds a TAMS-specific API token.
          authorization: `Bearer ${config.oscAccessToken}`
        },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async indexAsset(asset: Asset): Promise<IndexAssetResult> {
      const durationSeconds = assetDurationSeconds(asset);
      const timerange = fullDurationTimerange(durationSeconds);
      if (!timerange) {
        // ADR-009: an asset with no known duration is NOT indexed (skip + log).
        log('tams-index-write: skipping asset with no known duration', {
          assetId: asset.id
        });
        return { indexed: false, skippedReason: 'skipped-no-duration' };
      }

      // Deterministic ids (ADR-009). Pure function of the asset ULID, so a
      // re-index always targets the SAME flow + source ids => idempotent.
      const flowId = deriveFlowId(asset.id);
      const sourceId = deriveSourceId(asset.id);

      // 1) PUT /flows/{id} — create/update the flow AND its source (ADR-008
      // line 69). Idempotent: same id => upsert, no duplicate flow/source.
      const putRes = await call(
        'PUT',
        `/flows/${flowId}`,
        buildPutFlowBody(flowId, sourceId)
      );
      if (!putRes.ok) {
        const text = await putRes.text().catch(() => '');
        throw new Error(
          `TAMS flow PUT failed for asset ${asset.id}: ${putRes.status} ${text}`.trim()
        );
      }

      // 2) POST /flows/{id}/segments — register the single full-duration segment
      // (ADR-008 line 74). Idempotent target: the segment covers the SAME
      // deterministic timerange on the SAME flow, so a re-index is a safe upsert
      // over the identical `[0:0_<duration>)` range rather than a new segment.
      const segRes = await call(
        'POST',
        `/flows/${flowId}/segments`,
        buildPostSegmentBody(timerange)
      );
      if (!segRes.ok) {
        const text = await segRes.text().catch(() => '');
        throw new Error(
          `TAMS segment POST failed for asset ${asset.id}: ${segRes.status} ${text}`.trim()
        );
      }

      return { indexed: true, flowId, sourceId, timerange };
    }
  };
}
