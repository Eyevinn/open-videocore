# OSC friction — TAMS gateway write/index contract not fully tabled (issue #170)

**Date:** 2026-07-13
**Author agent:** surface-backend-api (claude-opus-4-8)
**Service:** `eyevinn-tams-gateway` (ADR-008)
**Context:** Idempotent single-asset TAMS index-write (#170,
`src/tams/tams-gateway-write-client.ts`).

## Summary

ADR-008 ("Verified HTTP API surface", table lines 65-80) pins the write endpoint
**paths and verbs** for the index side of the bridge:

- `PUT /flows/{id}` — "Create or update a flow and its source (write path)"
- `POST /flows/{id}/storage` — "Allocate storage, get presigned PUT URLs"
- `POST /flows/{id}/segments` — "Register a segment for a flow"

but does **not** table the **request/response body shapes** of any of them — only
paths, verbs, and a one-line purpose. ADR-009 decision 1 flags the same gap for
`PUT /flows/{id}` (the source-id body field) and states it "must be verified
against the running instance's `/docs` Swagger before the write path is coded."

## Impact on #170

No OSC MCP tool nor a running gateway instance was reachable in this session to
fetch the live `/docs` Swagger, so the exact JSON body field names for the flow
descriptor and the segment registration could not be verified against the wire.

## Mitigation taken (not a guess passed off as verified)

Per the CLAUDE.md rule-7 fallback ("if the real contract is unreachable, honour
the existing gateway-client methods as the contract"):

1. The `PUT /flows/{id}` body sends the derived flow id as `id` and the derived
   source id as `source_id` — the SAME field the pinned read-side `TamsFlow`
   type (`tams-gateway-client.ts`) already surfaces for the flow->source link —
   marked `// CONTRACT-GAP:` in-code rather than inventing an unverified field.
2. The `POST /flows/{id}/segments` body sends only `timerange`, the one field the
   pinned read-side `TamsSegment` type asserts a segment carries.
3. Body construction is isolated in named builders (`buildPutFlowBody`,
   `buildPostSegmentBody`) so once the live Swagger is fetched, only those
   builders change — the idempotency logic and endpoint wiring do not.

## Contract-conformance note (namespace constants)

The deterministic UUIDv5 namespaces in `tams-gateway-write-client.ts`
(`TAMS_BRIDGE_FLOW_NAMESPACE`, `TAMS_BRIDGE_SOURCE_NAMESPACE`) were reconciled to
the EXACT literals pinned by ADR-009 decision 2 (lines 167 and 184). An earlier
draft used freshly-generated values that diverged from the ADR; because these
namespaces are the idempotency contract (they MUST NOT drift), they are now
copied verbatim from the ADR and cited in-code.

## Action requested from the OSC / consultant side

Publish (or point to) the request/response JSON schemas for `PUT /flows/{id}`,
`POST /flows/{id}/storage`, and `POST /flows/{id}/segments` — ideally as a
committed OpenAPI fragment alongside ADR-008 — so the write path can be pinned
1:1 the way the five read endpoints already are.
