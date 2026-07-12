# OSC friction — TAMS bridge mapping ADR (issue #169)

**Date:** 2026-07-12
**Surface:** backend-api
**Issue:** #169 (feat: define asset-to-TAMS mapping and config contract; ADR-009)
**Service:** `eyevinn-tams-gateway` (TAMS store; pinned by ADR-008 / #150)

## What we needed

Before writing indexing code, lock the asset -> TAMS Source/Flow/Segment
mapping, the deterministic id derivation, the timerange definition, and the
config-gating contract (ADR-009).

## Friction / gaps (none blocking; all resolvable from pinned contracts)

1. **`PUT /flows/{id}` source-id body field is not tabled.** ADR-008's API table
   (lines 65-80) documents `PUT /flows/{id}` as creating "a flow **and its
   source**", but neither ADR-008 nor the fetched README tables the request-body
   field that carries the source id, nor whether the gateway assigns the source
   id itself or honours a caller-supplied one. ADR-009 defines the *intended*
   deterministic source id (UUIDv5) but flags this as a verify-against-Swagger
   prerequisite for the write path (#170). No live OSC MCP tools were available
   to this author to confirm it; the running instance's `/docs` Swagger
   (ADR-008 line 62) must be checked before the write path is implemented.

2. **ULID -> UUID impedance mismatch.** Asset ids are 26-char Crockford-base32
   ULIDs (`src/data/asset-repo.ts` lines 498-502), but TAMS flow ids are UUIDs
   (ADR-008 line 114; `TamsFlowIdSchema = z.string().uuid()`,
   `src/data/asset-document.ts` line 185). The two id systems do not
   interoperate directly, so ADR-009 defines a UUIDv5(namespace, ULID)
   derivation. Not an OSC defect — noted so future authors know why the bridge
   carries a derivation step rather than passing the asset id straight through.

3. **Config-key naming divergence from repo convention.** The issue proposes
   `TAMS_STORE_URL` (a raw gateway URL). The rest of the codebase resolves an
   OSC service instance URL at runtime from an **instance name** via the OSC SDK
   (e.g. `PARAMETER_STORE_INSTANCE_NAME` resolved by `resolveParamStoreBaseUrl`,
   `src/services/param-store.ts` lines 345-361), not from a raw-URL env var.
   ADR-009 keeps `TAMS_STORE_URL` as the issue requested (simpler, maps 1:1 to
   `TamsGatewayClientConfig.gatewayBaseUrl`) but records the alternative
   (`TAMS_STORE_INSTANCE_NAME` + SDK resolution) so sibling #171 can decide. The
   gating rule (present + non-empty, trimmed) is identical either way.

## Asks for OSC

1. Publish the `PUT /flows/{id}` request-body schema in the gateway's advertised
   contract (README/Swagger) — specifically the source-id field name and whether
   a caller-supplied source id is honoured — so bridge authors do not have to
   introspect a live instance to code the write path.

## Open questions

- ADR-005 (asset aggregate / ULID model) is referenced by #169 but has **no
  file** in `docs/architecture/` (only ADR-001, ADR-007, ADR-008). ADR-009
  grounds the ULID/aggregate facts in the model code instead. This is the third
  absent-ADR reference logged for this repo (cf. ADR-002 in
  `incoming-issue31-param-store.md`, ADR-003 in
  `incoming-issue162-tams-read-client-adr003-ref.md`); the ADR numbering/index
  should be reconciled.
