# ADR-001: OSC stack for eng-open-videocore

**Status:** APPROVED 2026-06-01
**Date:** 2026-06-01
**Architect agent:** claude-opus-4-8

---

## Context

open-videocore is an open source, OSC-native media asset management API that orchestrates OSC video-processing services for ingest, transcoding, metadata, search, and delivery. The target audience is media developers who need a self-hostable, extensible backend for managing video assets and driving processing workflows. The success metric is publication to the OSC public catalog as a one-click deployable service usable by a third-party developer with zero prior knowledge of the codebase. The project is greenfield with no mandatory external system integrations. Hard constraints are: no commercial product names anywhere in the codebase or docs, genuine open source licensing, and all processing must delegate to OSC services rather than reinvent them.

---

## Decision

### Chosen OSC services

| serviceId | Purpose in this solution | GitHub / Catalog | Notes |
|---|---|---|---|
| `encore` | Video transcoding (ABR ladder generation, job submission, progress callbacks) | Essential service | Core processing engine; submit jobs via REST, receive callbacks via `progressCallbackUri` |
| `eyevinn-encore-packager` | HLS/DASH packaging of transcoded ABR output | Eyevinn catalog | Listens on Valkey queue for completed Encore jobs; produces streaming manifests |
| `eyevinn-encore-callback-listener` | Bridges Encore job completion events onto the Valkey queue | Eyevinn catalog | Decouples callback receipt from packaging worker; posts `jobId` + URL to queue |
| `valkey-io-valkey` | Queue and coordination backbone for the transcoding/packaging pipeline | Essential service | Redis-compatible; used by Encore, Encore Packager, and Encore Callback Listener |
| `minio-minio` | S3-compatible object storage for asset source files, transcoding outputs, and packaged manifests | Essential service | Default storage backend; pre-signed URLs for direct upload; bucket events for watch-folder ingest trigger |
| `apache-couchdb` | Flexible document store for asset records, rendition metadata, job/workflow state, and webhook subscription registry | Essential service | Schema-free documents match the "highly flexible metadata model" requirement; Mango queries cover basic search |
| `birme-osc-postgresql` | Relational store and full-text search index for asset discovery (tsvector/tsquery) | OSC catalog | Fills the search gap that CouchDB alone cannot; pgvector extension available for future AI-powered similarity search |
| `eyevinn-ffmpeg-s3` | Lightweight, ephemeral FFmpeg jobs for tasks where Encore is overkill: technical probing (ffprobe), thumbnail extraction, remux/container conversion, clip trimming, audio extraction | Eyevinn catalog | Per-job instantiation via `create-service-instance` with `cmdLineArgs`; reads/writes S3 URLs; native MinIO endpoint support via `s3EndpointUrl`. One instance = one job; the open-videocore API spawns instances on demand and tears them down on completion. |
| `eyevinn-auto-subtitles` | Speech-to-text subtitle generation via OpenAI Whisper | Eyevinn catalog | Optional AI/ML pipeline stage; produces VTT/SRT for full-text transcript indexing |

### Chosen OSC solution (if applicable)

No pre-packaged OSC Solution covers the full MAM-layer scope. The architecture composes individual services rather than deploying a solution template. If the OSC VOD transcoding solution (`eyevinn-vod-transcoding-solution` or equivalent) ships to the catalog before implementation begins, the infra agent should evaluate it as a partial shortcut for the transcode/package/deliver path.

Coverage: n/a (no single solution selected)
Gaps to fill outside a solution: asset metadata model, ingest API, search, notifications, web UI, watch-folder orchestration.

### Integration depth

**catalog-only**, meaning open-videocore itself will be submitted to the OSC public catalog via `submit-open-source-repository` so any OSC user can one-click-deploy it. It is NOT deployed as a My App by Eyevinn. The downstream services it depends on (Encore, MinIO, CouchDB, etc.) are provisioned by the operator who deploys open-videocore, either via OSC one-click or the Day-1 deploy plan below. OSC agentic SDLC does not govern this repo's CI/CD pipeline (the project is open source with its own GitHub Actions).

### External systems in this solution

None detected in intake material. This is a greenfield, pure-OSC stack. No external AWS/Azure/GCP accounts, no third-party SaaS subscriptions, no on-prem systems, no customer identity provider integrations are required at v1. External CDN integration is explicitly deferred to a post-v1 delivery ADR (see open question 4 below).

---

## Why OSC for this engagement

The load-bearing OSC capabilities are: `encore` as a managed, scalable transcoding engine that would require significant infrastructure work to self-host; `minio-minio` providing S3-compatible object storage with bucket event semantics that power watch-folder ingest without any custom messaging infrastructure; `eyevinn-encore-packager` and `eyevinn-encore-callback-listener` composing a complete VOD packaging pipeline that would otherwise require several weeks of integration work; and `apache-couchdb` providing the flexible document model required for heterogeneous asset metadata without schema migrations. The leaving cost for an operator moving off OSC is: re-hosting Encore (stateful, GPU-adjacent workload), re-hosting MinIO with equivalent bucket-event wiring, re-hosting CouchDB and PostgreSQL with connection string management, and replacing the Encore pipeline callback chain. All of these are standard open source services, so the exit is technically possible, but the OSC catalog removes the operational overhead that makes them prohibitive as self-hosted dependencies in a developer tool.

---

## OSC capability frontier

This engagement composes OSC services into a MAM orchestration layer, which is a new use pattern: rather than deploying one OSC service, open-videocore is itself an OSC catalog entry that depends on six or more other OSC catalog entries at runtime. This is the first project in this team's history to use OSC as a full "media platform substrate" rather than a utility service. It pushes the catalog flywheel in two ways: (1) it uses `eyevinn-ffmpeg-s3` as an on-demand ephemeral job runner spawned programmatically per asset, which is a new integration pattern (API-driven create-service-instance at job time rather than a persistent service); (2) the watch-folder trigger via MinIO bucket events combined with an OSC-hosted orchestrator is a pattern not yet documented in OSC examples, and friction encountered here will be fed back via the osc-feedback agent.

The search gap (no OpenSearch/Elasticsearch in the OSC catalog as of 2026-06-01) is the most material frontier issue. PostgreSQL FTS is the MVP workaround, but a dedicated search service in the OSC catalog would materially improve this architecture. Logged as `docs/osc-feedback/incoming-01-search-service-gap.md`.

---

## Alternatives considered

| Service slot | Chosen | Alternative 1 | Why rejected | Alternative 2 | Why rejected |
|---|---|---|---|---|---|
| ABR transcoding | `encore` | `eyevinn-ffmpeg-s3` for ABR | No managed job queue, no callback system, no ABR profile management; `eyevinn-ffmpeg-s3` is correct for single-output jobs but not for multi-rendition ABR ladders | `eyevinn-live-encoding` | Live encoding only; no VOD transcoding job model |
| Lightweight FFmpeg jobs | `eyevinn-ffmpeg-s3` | `eyevinn-function-probe` | Covers probing only; `eyevinn-ffmpeg-s3` handles probing AND thumbnail extraction AND remux AND trim in a single service with a unified S3/MinIO interface | `eyevinn-function-scenes` | Scene detection only; no general-purpose FFmpeg capability |
| Object storage | `minio-minio` | OSC storage buckets (platform primitive) | Bucket event / notification API not confirmed for watch-folder use; MinIO S3 API is more portable and better documented for pre-signed URLs | External S3 (AWS) | Introduces mandatory external cloud account; violates OSC-native constraint |
| Metadata store | `apache-couchdb` | `birme-osc-postgresql` (primary) | PostgreSQL is better for relational queries and search but lacks schema-free document flexibility needed for heterogeneous asset metadata; used as complement, not replacement | `linuxserver-docker-mariadb` | Less expressive query language for document-style data; no JSON document path operators |
| Search | `birme-osc-postgresql` (FTS) | OpenSearch / Elasticsearch | Not present in OSC catalog as of 2026-06-01; would require external hosting or a new OSC catalog entry | CouchDB Mango queries only | No full-text ranking, no faceting, no transcript search |
| Queue / coordination | `valkey-io-valkey` | `dicedb-dice` (dicedb-dice) | DiceDB is Redis-compatible but is newer and less battle-tested for queue semantics required by Encore Packager | Embedded in-process queue | Not portable across replicas; breaks when open-videocore restarts |

---

## Day-1 deploy plan

OSC-first deployment is the default. The infra agent runs the following calls in the development environment before any code is merged. All parameter-store values land under the `openvideocore` parameter store and are read by backend, qa, and data-pipeline agents via `mcp__osc__get-parameter`.

| # | MCP call | Target service / artefact | Tier | Post-condition | Parameter-store key | Owner |
|---|---|---|---|---|---|---|
| 1 | `mcp__osc__setup-parameter-store` | Parameter store `openvideocore` | dev | Store exists; `CONFIG_API_KEY` captured in session secrets | n/a (meta) | infra |
| 2 | `mcp__osc__create-service-instance` | `minio-minio` | dev | MinIO endpoint reachable; access/secret keys captured | `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | infra |
| 3 | `mcp__osc__set-parameter` | MinIO connection values | dev | Parameters readable by open-videocore runtime | `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, `MINIO_SECRET_KEY` | infra |
| 4 | `mcp__osc__create-service-instance` | `apache-couchdb` | dev | CouchDB reachable; admin credentials captured | `COUCHDB_URL`, `COUCHDB_USER`, `COUCHDB_PASSWORD` | infra |
| 5 | `mcp__osc__set-parameter` | CouchDB connection values | dev | Parameters readable | `COUCHDB_URL`, `COUCHDB_USER`, `COUCHDB_PASSWORD` | infra |
| 6 | `mcp__osc__create-service-instance` | `birme-osc-postgresql` | dev | PostgreSQL reachable; connection string captured | `DATABASE_URL` | infra |
| 7 | `mcp__osc__set-parameter` | PostgreSQL connection string | dev | Parameter readable | `DATABASE_URL` | infra |
| 8 | `mcp__osc__create-service-instance` | `valkey-io-valkey` | dev | Valkey reachable on default port | `REDIS_URL` | infra |
| 9 | `mcp__osc__set-parameter` | Valkey URL | dev | Parameter readable | `REDIS_URL` | infra |
| 10 | `mcp__osc__create-service-instance` | `encore` | dev | Encore API reachable; base URL captured | `ENCORE_URL` | infra |
| 11 | `mcp__osc__set-parameter` | Encore base URL | dev | Parameter readable | `ENCORE_URL` | infra |
| 12 | `mcp__osc__create-service-instance` | `eyevinn-encore-callback-listener` | dev | Callback listener running; configured with `REDIS_URL` from step 8 | `ENCORE_CALLBACK_URL` | infra |
| 13 | `mcp__osc__create-service-instance` | `eyevinn-encore-packager` | dev | Packager running; listening on Valkey queue | n/a (reads `REDIS_URL` + `MINIO_*` from env) | infra |
| 14 | `mcp__osc__schedule-backup` | `apache-couchdb` instance | dev | Daily backup to MinIO bucket `openvideocore-backups` scheduled | n/a | infra |
| 15 | `mcp__osc__schedule-backup` | `birme-osc-postgresql` instance | dev | Daily backup scheduled | n/a | infra |

**`eyevinn-ffmpeg-s3` provisioning:** this service is NOT provisioned as a persistent instance in the Day-1 plan. The open-videocore API creates one instance per job at runtime via `mcp__osc__create-service-instance` (serviceId: `eyevinn-ffmpeg-s3`), passing the appropriate `cmdLineArgs` (e.g. `ffprobe` for probing, `-ss 00:00:05 -frames:v 1` for thumbnails, `-c copy` for remux). The instance runs to completion and is then deleted. The `MINIO_ENDPOINT`, `MINIO_ACCESS_KEY`, and `MINIO_SECRET_KEY` parameters set in steps 2-3 are passed as `s3EndpointUrl`, `awsAccessKeyId`, and `awsSecretAccessKey` at instantiation time. No persistent URL to store in the parameter store.

**My App creation:** open-videocore is a catalog service, not a My App. The open-videocore API container will be submitted via `mcp__osc__submit-open-source-repository` once the skeleton PR merges and the service is functional. No `create-my-app` call is needed for open-videocore itself.

**Cost delta vs local-only path:** running the 8 persistent service instances in dev tier costs approximately 165 OSC tokens/day (see cost estimate below). `eyevinn-ffmpeg-s3` adds 10 tokens/day per active job instance; in light dev use this cost is near zero. A hypothetical all-local docker-compose dev environment costs 0 OSC tokens but requires developers to run 6+ containers locally with manual wiring. The OSC dev tier eliminates local resource overhead and provides shared state across the agent team. Net recommendation: use OSC dev tier as the default; document docker-compose as a contributor fallback option in the repo README.

**Fallback policy:** if any `create-service-instance` call fails (capacity, auth, or missing capability), the infra agent immediately files `docs/osc-feedback/incoming-NN-<slug>.md` in the same session and records the blocked service as an open question. The session does NOT silently fall back to long-lived local docker. The infra agent pauses and surfaces the failure to the consultant before continuing.

---

## Cost estimate

All costs are in OSC tokens per day, at 1 instance each, dev tier. Token pricing in EUR depends on the OSC plan; the PERSONAL plan refills 1,000 tokens/day.

| Service | tokens/day | tokens/month (30 d) |
|---|---|---|
| `encore` | 100 | 3,000 |
| `eyevinn-encore-packager` | 10 | 300 |
| `eyevinn-encore-callback-listener` | 10 | 300 |
| `valkey-io-valkey` | 10 | 300 |
| `minio-minio` | 10 | 300 |
| `apache-couchdb` | 10 | 300 |
| `birme-osc-postgresql` | 5 | 150 |
| **MVP core total (persistent)** | **155** | **4,650** |
| `eyevinn-ffmpeg-s3` (per active job instance) | 10 | variable |
| `eyevinn-auto-subtitles` (optional AI) | 10 | 300 |
| **Full stack total** | **165 + job overhead** | **~4,950 + variable** |

Assumptions: 1 persistent instance per service, dev tier, continuous uptime. `eyevinn-ffmpeg-s3` is ephemeral and billed only while a job instance is running; in a light dev environment with a few probes/thumbnails per day the cost is minimal. Encore dominates at 100 tokens/day (more than all other persistent services combined) because it is an Essential service with active transcoding capability. At 1,000 tokens/day refill the persistent stack consumes 15.5% of daily refill, sustainable on the PERSONAL plan. Production tier pricing was not verified in this session; confirm with OSC before prod provisioning.

---

## Portability note

OSC My Apps run the customer's own git repo on open-source `web-runner-{node,python,wasm}` images. For open-videocore specifically: the repo IS the export artefact. To leave OSC: `git clone` the repo and `docker run web-runner-node` (or equivalent) anywhere. The dependent services (Encore, MinIO, CouchDB, PostgreSQL, Valkey) are all standard open source projects with official Docker images. No proprietary export layer exists.

---

## Open questions for the customer

1. **Runtime language:** ~~Undecided~~ **RESOLVED 2026-06-01** — Node 22 + Fastify + Zod + pnpm, aligned with open-live org pattern.
2. **Authentication model for v1:** ~~Open (no auth), API keys, or OIDC?~~ **RESOLVED 2026-06-01** — Gated behind OSC login-wall. `OSC_ACCESS_TOKEN` is the operator's credential; open-videocore calls OSC APIs on their behalf. No additional API key layer needed for v1.
3. **Search scope for v1:** ~~Dedicated search cluster or PostgreSQL FTS?~~ **RESOLVED 2026-06-01** — PostgreSQL FTS is sufficient for v1. Dedicated search deferred to ADR-004.
4. **CDN / delivery URLs:** ~~v1 scope or post-v1?~~ **RESOLVED 2026-06-01** — CDN deferred to post-v1 delivery ADR (ADR-003).
5. **Open source license:** ~~Apache 2.0, MIT, or other?~~ **RESOLVED 2026-06-01** — Apache 2.0.
6. **AI/ML pipeline stages:** ~~`eyevinn-auto-subtitles` in v1 scope?~~ **RESOLVED 2026-06-01** — Not in v1 scope. `eyevinn-ffmpeg-s3` handles probing, thumbnails, and remux. Subtitle generation deferred to post-v1.

---

## Consequences

**Positive:**
- All processing delegates to proven OSC open source services; open-videocore itself contains only orchestration logic, which is easier to test and maintain.
- MinIO's S3-compatible API means any S3 SDK works for direct uploads, and the pre-signed URL pattern is well-understood by media developers.
- CouchDB's document model handles heterogeneous asset metadata without schema migrations across versions.
- PostgreSQL FTS provides viable search for v1 without adding an external search cluster.
- The Encore callback pipeline (`encore` + `eyevinn-encore-callback-listener` + `eyevinn-encore-packager` + `valkey-io-valkey`) is a reference-tested combination with known integration points.
- `eyevinn-ffmpeg-s3` covers probing, thumbnails, remux, and trim in a single service with a unified MinIO interface, eliminating the need for two separate function services (`eyevinn-function-probe` and `eyevinn-function-scenes`). The ephemeral per-job model means no persistent probe service to maintain.

**Negative / risks:**
- `encore` costs 100 tokens/day, which dominates the stack. If the consultant's OSC plan has a lower daily refill, a shared dev Encore instance may be needed.
- PostgreSQL FTS is a workaround for the search gap, not a long-term solution. Faceting, fuzzy matching, and transcript search will be limited without a dedicated search engine.
- Watch-folder semantics via MinIO bucket events have not been confirmed for exactly-once processing at scale. This is a known gap that must be addressed in the data-pipeline surface implementation.
- `eyevinn-auto-subtitles` introduces a dependency on an external commercial API (OpenAI Whisper). This is opt-in but should be clearly documented in the catalog listing.
- No dedicated notification/webhook delivery service exists in the OSC catalog. The webhook subsystem must be built inside open-videocore. This is the second material gap after search.

**Follow-up ADRs needed:**
- ADR-002: API authentication and multi-tenancy model (after open question 2 is answered).
- ADR-003: Delivery and CDN integration (after open question 4 is answered).
- ADR-004: Search backend evolution (if PostgreSQL FTS proves insufficient at scale, or when an OSC search service enters the catalog).

---

## Currency check

- OSC service count verified at runtime: 183 services across 8 categories (source: `mcp__osc__list-service-categories`, 2026-06-01)
- All serviceIds in the chosen-services table were returned by `mcp__osc__list-available-services` calls in this session (2026-06-01)
- Cost estimates sourced from `mcp__osc__estimate-service-cost` per-service calls, 2026-06-01
- OSC Architect recommendation sourced from `mcp__osc__ask-osc-architect`, 2026-06-01
