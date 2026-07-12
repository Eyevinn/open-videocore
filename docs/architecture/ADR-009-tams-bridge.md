# ADR-009: Asset-to-TAMS bridge mapping and config-gating contract

**Status:** PROPOSED 2026-07-12
**Date:** 2026-07-12
**Author agent:** claude-opus-4-8
**Issue:** #169 (sub-task of the #116 TAMS bridge epic; blocks #153, #171 and siblings)

---

## Context

The TAMS bridge epic (#116) makes an Open Videocore asset addressable as a
time-ranged media flow in a shared Time-addressable Media Store (TAMS). ADR-008
pinned the runtime service contract (the `eyevinn-tams-gateway` HTTP surface,
timerange grammar, paging, and auth). ADR-008 deliberately deferred four
decisions to this ADR (ADR-008 "Consequences", "#169's mapping ADR still owns
the undecided asset->source/flow/segment identity mapping, the config-gating
key, and the timerange-per-asset definition"):

1. how one asset maps onto TAMS Source/Flow/Segment entities;
2. the deterministic identity mapping from an asset id to a stable TAMS
   Flow/Source id (so re-index is idempotent);
3. the definition of an asset's timerange (single full-duration segment vs
   per-rendition segments);
4. the config-gating contract (parameter-store key name + the exact rule for
   "TAMS is configured").

This ADR locks those four decisions. It is **docs-only** — it introduces no
client code, indexing code, or config code. The write endpoints and the indexer
that consumes these decisions are #170/#153/#171.

Per CLAUDE.md rule 7, every shape below is grounded in an already-fetched
contract, cited inline. The authoritative TAMS store schema source is ADR-008
(`docs/architecture/ADR-008-tams-gateway-contract.md`), which pinned the
gateway's HTTP surface and time-addressing model from the OSC MCP service
catalog/schema and the upstream README on 2026-07-09. This ADR does **not** make
live service calls (no OSC MCP tools are available to this author); where ADR-008
does not table a field this ADR needs, that gap is stated explicitly rather than
invented.

### Grounding sources (verified, not assumed)

- **TAMS store schema (authoritative):**
  `docs/architecture/ADR-008-tams-gateway-contract.md`.
  - Entity hierarchy — "Time-addressing model" (ADR-008 lines 106-111): "a
    **source** is the abstract media; a **flow** is a concrete representation of
    a source; **segments** are the time-addressed media objects that make up a
    flow."
  - Write/index endpoints — "Verified HTTP API surface" table (ADR-008
    lines 65-80): `PUT /flows/{id}` ("Create or update a flow and its source
    (write path — bridge index side)"), `POST /flows/{id}/segments` ("Register a
    segment for a flow"), `POST /flows/{id}/storage` ("Allocate storage, get
    presigned PUT URLs"), and `DELETE /flows/{id}` ("Delete a flow and its
    segments").
  - Flow ids are UUIDs, and a source can carry many flows — ADR-008 "Time-
    addressing model" (line 114) and the addressing-field note (lines 112-114).
  - Timerange grammar — ADR-008 lines 102-105:
    `[<seconds>:<nanoseconds>_<seconds>:<nanoseconds>)` on the TAI timescale,
    interval-notation bounds (`[`/`]` inclusive, `(`/`)` exclusive), open-ended
    ranges permitted, e.g. `[0:0_10:0)`.
  - Auth — ADR-008 "Authentication" (lines 117-122): the gateway leaves its own
    `API_TOKEN` unset behind the OSC ingress gate; callers reach it through the
    OSC auth-wall / delegated OSC access token.

- **Asset addressing-field shape (#152/#165), verified in code:**
  `src/data/asset-document.ts`. The addressing block is `TamsAddressingSchema`
  (lines 188-195) stored under the machine-owned `structural.tams` namespace
  (lines 276-280): `flowIds: z.array(TamsFlowIdSchema).optional()` where
  `TamsFlowIdSchema = z.string().uuid()` (line 185), and
  `timerange: TamsTimerangeSchema.optional()` validated against
  `TAMS_TIMERANGE_REGEX` (lines 167-182). The flat domain mirror is
  `tamsFlowIds?: string[]` and `tamsTimerange?: string` on the `Asset` type in
  `src/data/asset-repo.ts` (lines 334-335).

- **Asset id is a ULID, verified in code:**
  `src/data/asset-repo.ts` — the repository mints the id with `ulid()`
  (`import { ulid } from 'ulid'`, line 15; `const localId = ulid()` in
  `InMemoryAssetRepository.create`, line 767). The document key is that ULID
  (`AssetDocumentSchema._id`, `asset-document.ts` lines 201-202, comment "ULID").
  A ULID is exactly 26 chars of Crockford base32 (`ULID_PATTERN`,
  `asset-repo.ts` lines 498-502). The asset document is the single aggregate root
  (`asset-document.ts` lines 3-6, "A single asset document is the aggregate
  root").

- **Config / parameter-store conventions, verified in code:**
  `src/services/param-store.ts` (env-var gating pattern, e.g.
  `paramStoreFromEnv` returns `undefined` when `PARAMETER_STORE_API_KEY` is
  unset, lines 368-380) and `.env.example` (env-var naming, e.g.
  `PARAMETER_STORE_INSTANCE_NAME`). The existing TAMS read-client config surface
  is `TamsGatewayClientConfig` in `src/tams/tams-gateway-client.ts`
  (`gatewayBaseUrl` + `oscAccessToken`, lines 37-54).

### Referenced-but-absent ADRs (noted, not relied on as a shape)

- **ADR-005** (asset aggregate / ULID / four-namespace model) is referenced by
  the issue but has **no file** in `docs/architecture/` (only ADR-001, ADR-007,
  ADR-008 exist there). Its facts are instead grounded in the live model code
  cited above (`asset-document.ts` header lines 1-23 describe the ADR-005 shape;
  `asset-repo.ts` mints the ULID). This mirrors the same absent-ADR situation
  logged for ADR-002 (`docs/osc-feedback/incoming-issue31-param-store.md`) and
  ADR-003 (`docs/osc-feedback/incoming-issue162-tams-read-client-adr003-ref.md`).

---

## Decision

### 1. Asset -> TAMS entity mapping

**One asset maps to exactly one TAMS Source and exactly one TAMS Flow, and the
asset's media is exposed as Segment(s) on that single Flow.**

Rationale grounded in the ADR-008 hierarchy (lines 106-111):

- **Source = the asset.** The source is "the abstract media" — this is the
  editorial identity of the Open Videocore asset (its ULID aggregate). One asset
  is one piece of content, so it is one source.
- **Flow = the asset's canonical media representation.** A flow is "a concrete
  representation of a source." The v1 bridge publishes a **single canonical
  flow** per asset (see decision 3 for what that flow's media is). The
  addressing field is nonetheless modelled as `flowIds: string[]`
  (`asset-document.ts` line 191) — an **array** — because ADR-008 line 114 pins
  that "a source can carry multiple flows." v1 populates that array with exactly
  one flow id; the array cardinality is reserved for a future per-rendition
  expansion (decision 3) without a schema change.
- **Segment(s) = the asset's media on the flow.** Segments are "the
  time-addressed media objects that make up a flow" and are registered via
  `POST /flows/{id}/segments` (ADR-008 table line 74) after storage is allocated
  via `POST /flows/{id}/storage` (line 73).

Index write path (ADR-008 table, cited for the implementer of #170/#153, not
implemented here): the source and flow are created/updated together by a single
`PUT /flows/{id}` ("Create or update a flow and its source"), then storage is
allocated (`POST /flows/{id}/storage`) and segment(s) registered
(`POST /flows/{id}/segments`). Re-index of an existing asset re-issues the same
`PUT /flows/{id}` (idempotent by decision 2) and reconciles segments; a removed
asset is torn down with `DELETE /flows/{id}` (deletes the flow and its
segments).

**Gap (stated, not invented):** ADR-008 tables `PUT /flows/{id}` as creating
"a flow **and its source**" but does **not** table (a) the request body field
that carries the source id, nor (b) whether the gateway derives the source id
itself or accepts a caller-supplied one. Decision 2 fixes the source id we
*intend* to use; confirming the exact body field name that carries it (and
whether the gateway honours a caller-supplied source id vs assigning its own) is
an implementation prerequisite for #170 and must be verified against the running
instance's `/docs` Swagger (ADR-008 line 62) before the write path is coded. If
the gateway assigns the source id, the bridge stores the returned id rather than
the derived one; the derived-flow-id contract (decision 2) is unaffected.

### 2. Deterministic identity mapping (idempotent re-index)

**The TAMS Flow id is derived deterministically from the asset ULID as a
version-5 UUID (RFC 4122 §4.3) over a fixed bridge namespace, so re-indexing the
same asset always targets the same flow id and is therefore idempotent.**

TAMS flow ids are UUIDs (ADR-008 line 114; `TamsFlowIdSchema = z.string().uuid()`
in `asset-document.ts` line 185), while asset ids are 26-char Crockford-base32
ULIDs (`asset-repo.ts` lines 498-502). A ULID is **not** a UUID, so the mapping
must transform the ULID into a UUID. A UUIDv5 is chosen (not v4) precisely
because it is a pure function of (namespace, name): the same input always yields
the same UUID, which is exactly the idempotency property re-index needs.

Concrete, implementable derivation:

- **Namespace UUID (fixed constant, define once in the indexer, never
  regenerate):**
  `TAMS_BRIDGE_FLOW_NAMESPACE = 6f8e2a1c-0b3d-5e4f-8a9b-1c2d3e4f5a6b`.
  This is an arbitrary but permanent constant that scopes the derivation to the
  Open Videocore -> TAMS bridge (analogous to how `stackConfigKey` prefixes
  parameter-store keys with `openvideocore/`, `param-store.ts` lines 112-114).
  It MUST be committed as a literal in the indexer and MUST NOT change once any
  asset has been indexed (changing it re-keys every flow).
- **Name:** the asset ULID string exactly as stored in `AssetDocument._id`
  (uppercase Crockford base32, 26 chars — the value minted by `ulid()`), with no
  normalisation, prefix, or case change.
- **Flow id:** `flowId = uuidv5(assetUlid, TAMS_BRIDGE_FLOW_NAMESPACE)`.
  This satisfies `z.string().uuid()` (a v5 UUID is a valid UUID) and is stored in
  `structural.tams.flowIds` (as the single-element array of decision 1).

**Source id:** the source is created implicitly by `PUT /flows/{id}`
(decision 1). Where the bridge needs to name the source deterministically, it is
derived the same way from a **distinct** namespace so a flow id and its source
id never collide:
`TAMS_BRIDGE_SOURCE_NAMESPACE = 7a9f3b2d-1c4e-5f6a-9b0c-2d3e4f5a6b7c`, and
`sourceId = uuidv5(assetUlid, TAMS_BRIDGE_SOURCE_NAMESPACE)`. The source id is
subject to the ADR-008 gap noted in decision 1: if the gateway assigns the
source id, the derived value is the *intended* id and the returned id is stored;
if it accepts a caller-supplied source id, this derived value is used.

Consequences for idempotency: because both ids are a pure function of the
immutable asset ULID, re-index is a no-op-safe upsert — the bridge never
accumulates duplicate flows/sources for one asset, and a delete + re-create of
the same asset ULID would even resurrect the same ids. The bridge stores
`flowIds` in `structural.tams` after a successful index; on re-index it can also
recompute the id from the ULID without a read, so the addressing field is a cache
rather than the source of truth for the mapping.

### 3. Timerange definition: single full-duration segment (not per-rendition)

**v1 defines an asset's TAMS media as a SINGLE full-duration flow whose
timerange spans the whole asset, addressed as `[0:0_<duration>)` on the TAI
timescale.** Per-rendition flows/segments are explicitly deferred.

- **Timerange value.** The canonical `structural.tams.timerange`
  (`asset-document.ts` line 193) is the closed-open full-duration range
  `[0:0_<seconds>:<nanoseconds>)` in the ADR-008 grammar (lines 102-105). The
  duration comes from the asset's own technical metadata
  (`technical.durationMs`, `asset-document.ts` line 222; flat mirror
  `TechnicalMetadata.durationSeconds`, `asset-repo.ts` lines 127-136): the
  seconds/nanoseconds components are derived from `durationMs`
  (`seconds = floor(durationMs/1000)`, `nanoseconds = (durationMs % 1000) * 1e6`).
  An asset with no probed duration yet is **not** indexed (the timerange is
  undefined until `technical.durationMs` exists); indexing is gated on a
  successful probe.
- **Segment cardinality.** The flow is registered with segment(s) covering that
  full range via `POST /flows/{id}/segments` (ADR-008 line 74). Whether the
  gateway stores this as one physical segment object or chunks it internally is
  the gateway's concern; the **bridge's addressing contract** is a single
  logical full-duration range per asset, not a per-rendition matrix.

**Rationale for single full-duration over per-rendition:**

1. **Matches the current addressing field.** `structural.tams.timerange` is a
   single scalar string (`asset-document.ts` lines 192-193), not a per-rendition
   map. A per-rendition model would need a schema change to
   `TamsAddressingSchema`; the single-range model fits the field #165 already
   shipped, with no schemaVersion bump (the field is additive/optional,
   `asset-document.ts` lines 143-152).
2. **Renditions are embedded variants of one asset, not separate content.**
   `asset-repo.ts` lines 178-194 pin that renditions are "EMBEDDED variants of a
   single asset, not separate child assets" — all of an asset's ABR rungs share
   the same content and therefore the same time axis. Modelling one flow per
   asset (its canonical timeline) is the honest representation; per-rendition
   flows would encode transcode-ladder detail that is orthogonal to
   time-addressing.
3. **Simplest idempotent re-index.** One deterministic flow id per asset
   (decision 2) with one full-duration range means re-index reconciles exactly
   one flow. Per-rendition flows would multiply the deterministic-id derivation
   (a namespace per rendition id) and the reconcile/delete surface for no v1
   consumer benefit.
4. **Forward-compatible.** The `flowIds` array (decision 1) and the many-per-
   source cardinality ADR-008 already pins (line 114) leave the door open: a
   later ADR can add per-rendition flows by populating additional array elements
   with ids derived from `(assetUlid, renditionId)`, without invalidating v1
   single-flow assets.

### 4. Config-gating contract

**Parameter-store / env key name (proposed, as the issue requests):
`TAMS_STORE_URL`.**

**"TAMS is configured" rule (exact):** TAMS bridging is enabled **iff**
`TAMS_STORE_URL` is **present and non-empty after trimming surrounding
whitespace** — i.e. `typeof value === 'string' && value.trim().length > 0`.
When it is absent, empty, or whitespace-only, the bridge is **disabled**: no
flow/source/segment writes are attempted, the indexer is a no-op, and reads that
would consult TAMS degrade to "not configured" rather than erroring. This is the
same "unset -> feature-off, no throw" gating the parameter store already uses
(`paramStoreFromEnv` returns `undefined` when `PARAMETER_STORE_API_KEY` is unset,
`param-store.ts` lines 372-373; `ensureParameterStore` returns `false`,
lines 414-415). This rule is consumed by sibling #171.

- **Value semantics:** `TAMS_STORE_URL` is the base URL of the provisioned
  `eyevinn-tams-gateway` instance — the value that populates
  `TamsGatewayClientConfig.gatewayBaseUrl`
  (`src/tams/tams-gateway-client.ts` lines 37-41). A trailing slash is not
  significant (the client already normalises it).
- **Auth is separate and already contracted.** `TAMS_STORE_URL` carries **only**
  the URL, never a token. Authentication is the delegated OSC access token
  (`OSC_ACCESS_TOKEN`, `.env.example` line 2) threaded as
  `TamsGatewayClientConfig.oscAccessToken` per ADR-008 "Authentication"
  (lines 117-122) and ADR-001 open question 2 (see
  `docs/osc-feedback/incoming-issue162-tams-read-client-adr003-ref.md`). No new
  TAMS-specific token env var is introduced — consistent with the read client,
  which "never holds a TAMS-specific `API_TOKEN`"
  (`tams-gateway-client.ts` lines 46-49).
- **`.env.example` addition (for #171 to make, not made here):**
  a commented `# TAMS_STORE_URL=` entry documenting that setting it enables the
  bridge and that it is the gateway instance base URL.

**Convention note / friction (does not block this decision):** the rest of the
codebase resolves an OSC service instance's URL at runtime from an **instance
name** via the OSC SDK rather than taking a raw URL env var — e.g.
`PARAMETER_STORE_INSTANCE_NAME` (`.env.example` line 7) is resolved to a URL by
`resolveParamStoreBaseUrl` (`param-store.ts` lines 345-361). A strictly
convention-matching alternative would be `TAMS_STORE_INSTANCE_NAME` +
SDK-resolution. This ADR keeps the issue's proposed `TAMS_STORE_URL` as the
gate key (it is the simpler, direct-URL form and maps 1:1 to
`gatewayBaseUrl`), and logs the naming divergence to
`docs/osc-feedback/incoming-tams-bridge-adr.md` so #171 can decide whether to
adopt the instance-name+SDK pattern; either way the **gating rule**
(present + non-empty) is unchanged.

---

## Consequences

- **#153/#170 (indexer + write path)** implement decision 1 against the ADR-008
  write endpoints (`PUT /flows/{id}`, `POST /flows/{id}/storage`,
  `POST /flows/{id}/segments`, `DELETE /flows/{id}`) using the decision-2
  UUIDv5 flow id, and must first verify the `PUT /flows/{id}` source-id body
  field against the running instance's Swagger (the gap flagged in decision 1).
- **#171 (config gate)** consumes decision 4 verbatim: gate on `TAMS_STORE_URL`
  present + non-empty (trimmed), add the commented `.env.example` entry, and
  feed the value into `TamsGatewayClientConfig.gatewayBaseUrl`.
- The addressing field (`structural.tams`, `asset-document.ts` lines 188-195)
  needs **no schema change** for v1: `flowIds` holds the single derived flow id,
  `timerange` holds the single full-duration range. A future per-rendition ADR
  can extend `flowIds` without a schemaVersion bump (the block is additive/
  optional).
- Idempotency is guaranteed by construction (decision 2): the bridge never
  creates duplicate flows/sources for one asset, and re-index is a safe upsert.
- Assets without a probed duration are not indexed until `technical.durationMs`
  is populated (decision 3) — indexing is gated on a successful ffprobe.

## Contract sources

- `docs/architecture/ADR-008-tams-gateway-contract.md` — the authoritative TAMS
  store schema: entity hierarchy (lines 106-111), HTTP write/index + delete
  endpoints (table lines 65-80), flow-ids-are-UUIDs + many-flows-per-source
  (line 114), timerange grammar (lines 102-105), auth model (lines 117-122).
- `src/data/asset-document.ts` — `TamsAddressingSchema` / `structural.tams`
  (lines 143-195, 276-280), `TamsFlowIdSchema` UUID (line 185), ULID `_id`
  (lines 201-202).
- `src/data/asset-repo.ts` — ULID minting (`ulid()`, lines 15, 767),
  `ULID_PATTERN` (lines 498-502), `tamsFlowIds`/`tamsTimerange` flat fields
  (lines 334-335), rendition = embedded variant (lines 178-194),
  `TechnicalMetadata.durationSeconds` (lines 127-136).
- `src/tams/tams-gateway-client.ts` — `TamsGatewayClientConfig`
  (`gatewayBaseUrl` + `oscAccessToken`, lines 37-54); write endpoints out of
  read-client scope (lines 82-89 of ADR-008, restated here).
- `src/services/param-store.ts` — env-gating precedent (`paramStoreFromEnv`
  lines 368-380; `ensureParameterStore` lines 411-461), SDK URL resolution
  (lines 345-361), key namespacing (`stackConfigKey` lines 112-114).
- `.env.example` — env-var naming convention (`OSC_ACCESS_TOKEN` line 2,
  `PARAMETER_STORE_INSTANCE_NAME` line 7).
- RFC 4122 §4.3 — UUID version 5 (namespace + name, SHA-1) derivation used in
  decision 2.

## References

- ADR-001 (OSC stack; open question 2 — OSC auth-wall delegation).
- ADR-008 (TAMS Gateway service contract — pinned #150 contract).
- ADR-005 (asset aggregate / ULID model) — **no file present** in
  `docs/architecture/`; grounded in code (`asset-repo.ts`, `asset-document.ts`)
  as noted above.
- Issue #116 (TAMS bridge epic), #150 (ADR-008), #152/#165 (addressing fields),
  #153/#170 (indexer), #171 (config gate).
