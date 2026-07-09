# ADR-008: TAMS Gateway service contract for the time-addressable bridge

**Status:** PROPOSED 2026-07-09
**Date:** 2026-07-09
**Author agent:** claude-opus-4-8
**Issue:** #150 (sub-task of the #116 TAMS bridge epic)

---

## Context

The TAMS bridge epic (#116) wants Open Videocore assets to be addressable as
time-ranged media flows in a shared Time-addressable Media Store (TAMS). Before
any client code, model fields, indexing path, or lookup API is written
(#151–#154 and their sub-issues), the exact OSC service and its runtime API
contract must be pinned so downstream work maps 1:1 to real endpoints rather
than a guessed shape (CLAUDE.md rule 7).

This ADR records the verified service identity, deployment configuration, HTTP
API surface, and time-addressing model. It introduces **no client code** — that
is #151 and later.

## Verified service identity

- **serviceId:** `eyevinn-tams-gateway` (category `media`).
  Verified via the OSC MCP `list-available-services` catalog on 2026-07-09 —
  listed as **"TAMS Gateway"**, serviceId `eyevinn-tams-gateway`.
- **Upstream project:** [Eyevinn/tams-gateway](https://github.com/Eyevinn/tams-gateway)
  — "Time-addressable media store gateway implementing the BBC TAMS
  specification. Deployable in one click on Open Source Cloud."
- **What it is:** a gateway that stores segmented media flows by combining an
  S3-compatible media store (holds the flow segments) with a CouchDB index
  (holds the segment/flow/source metadata). It implements the AMWA/BBC TAMS
  API.

## Verified deployment configuration schema

Source: OSC MCP `get-service-schema` for `eyevinn-tams-gateway` (2026-07-09).

Required fields: `name` (`^\w+$`), `DbUrl`, `DbUsername`, `DbPassword`,
`AwsAccessKeyId`, `AwsSecretAccessKey`, `S3Bucket`.
Optional: `S3EndpointUrl`, `AwsRegion`, `CorsOrigin`, `LogLevel`.

Notes carried from the schema and the upstream README:

- The gateway needs a CouchDB service (segment index) and an S3-compatible
  bucket (MinIO) that **must already exist** — the gateway only allocates
  object keys within an existing bucket, it never creates buckets.
- On startup the gateway creates the required CouchDB databases and segment
  index automatically.
- **No in-place update support:** changing config requires
  delete + create (`update-service-instance` unsupported). Provisioning code
  must treat config as immutable per instance.
- A one-click Terraform solution
  ([terraform-examples/tams-pipeline](https://github.com/EyevinnOSC/terraform-examples/tree/main/examples/tams-pipeline))
  provisions gateway + CouchDB + MinIO together; the indexing sub-issues (#169)
  should decide whether to reuse it or provision the three services directly.

## Verified HTTP API surface

Source: [Eyevinn/tams-gateway README](https://github.com/Eyevinn/tams-gateway)
API table (2026-07-09). Interactive Swagger UI is served at `/docs` on a running
instance; the read paths the bridge depends on are:

| Method & path | Purpose |
| --- | --- |
| `GET /flows` | List flows |
| `GET /flows/{id}` | Get a flow (and, implicitly, its source) |
| `PUT /flows/{id}` | Create or update a flow and its source (write path — bridge index side) |
| `DELETE /flows/{id}` | Delete a flow and its segments |
| `GET /sources` | List sources |
| `GET /sources/{id}` | Get a source |
| `POST /flows/{id}/storage` | Allocate storage, get presigned PUT URLs |
| `POST /flows/{id}/segments` | Register a segment for a flow |
| `GET /flows/{id}/segments?timerange=[start_end)` | List a flow's segments, filtered by timerange |
| `DELETE /flows/{id}/segments?timerange=[start_end)` | Delete segments fully covered by the timerange |
| `GET /flows/{id}/output.m3u8?type=live\|vod` | Synthesised HLS playlist for a TS flow |
| `GET /service` | Service descriptor (advertised event streams) |
| `GET /service/storage-backends` | List object-store backends |
| `POST\|GET\|PUT\|DELETE /service/webhooks[/{id}]` | Manage TAMS event webhooks |

Additional verified behaviour relevant to the client (#151) and indexer (#169):

- **Read-only client scope (#151):** the read methods map to `GET /flows`,
  `GET /flows/{id}`, `GET /sources`, `GET /sources/{id}`, and
  `GET /flows/{id}/segments?timerange=...`. These are the "flow / segment /
  timerange reads" #151 asks for. The write endpoints (`PUT /flows/{id}`,
  `POST /flows/{id}/segments`, `POST /flows/{id}/storage`) belong to the
  indexing path (#169/#170), not the read client.
- **Paging:** `GET /flows/{id}/segments` is paged — pass `limit`, then follow the
  `Link: <...>; rel="next"` header (or feed `X-Paging-NextKey` back as the `page`
  query param). Responses carry `X-Paging-Limit`, `X-Paging-Count`,
  `X-Paging-Reverse-Order`, `X-Paging-Timerange`. The read client must expose
  paging, not assume a single-shot list.
- **Property sub-resources:** individual flow/source properties
  (`description`, `label`, `max_bit_rate`, `avg_bit_rate`, `flow_collection`,
  `read_only`) and tags (`/{resource}/{id}/tags[/{name}]`) are addressable
  without a full `PUT`. Writes to a `read_only` flow return `403`.

## Time-addressing model

- Segments are time-addressed with the TAMS **timerange** grammar:
  `[<seconds>:<nanoseconds>_<seconds>:<nanoseconds>)` on the **TAI** timescale,
  e.g. `[0:0_10:0)` for the first ten seconds. Bounds use interval notation
  (`[`/`]` inclusive, `(`/`)` exclusive); open-ended ranges are permitted.
- Addressing hierarchy: a **source** is the abstract media; a **flow** is a
  concrete representation of a source; **segments** are the time-addressed media
  objects that make up a flow. An Open Videocore asset therefore maps onto a
  source + one-or-more flows, with its media exposed as timerange-addressed
  segments. The exact ULID→flow/source id mapping and the "one segment vs
  per-rendition" decision are deferred to the mapping ADR called for by #169.
- **Timerange field for #152:** the asset addressing field must model this
  grammar as a validated string type (not free-form), and `flowId` should be
  treated as potentially many-per-source (a source can carry multiple flows).

## Authentication

Behind the OSC ingress gate the gateway leaves `API_TOKEN` unset and lets the
gate authenticate callers (README "Authentication"). The read client (#151)
should therefore reach the instance through the OSC auth-wall / delegated OSC
service token, consistent with how Open Videocore already reaches other OSC
services — not via a TAMS-specific `API_TOKEN`.

## Decision

Adopt `eyevinn-tams-gateway` as the TAMS store for the bridge, and treat the API
surface, timerange grammar, paging contract, and auth model recorded above as
the pinned contract for #151–#154. Downstream issues must cite this ADR (and the
upstream README/Swagger for any endpoint not tabled here) rather than assume a
shape.

## Consequences

- #151's read client is bounded to the five read endpoints above, must implement
  the documented paging contract, and authenticates via the OSC gate.
- #152's addressing fields must model the TAI timerange grammar and multi-flow
  cardinality.
- #169's mapping ADR still owns the undecided asset→source/flow/segment identity
  mapping, the config-gating key, and the timerange-per-asset definition; this
  ADR gives it the verified endpoints and grammar to build on.
- The gateway's lack of in-place config updates constrains any provisioning
  automation to delete+create.

## Contract sources

- OSC MCP `list-available-services` (category `media`), 2026-07-09 — serviceId
  `eyevinn-tams-gateway`.
- OSC MCP `get-service-schema` `eyevinn-tams-gateway`, 2026-07-09 — deployment
  config fields.
- [Eyevinn/tams-gateway README](https://github.com/Eyevinn/tams-gateway),
  2026-07-09 — HTTP API table, timerange grammar, paging, HLS output, auth.
