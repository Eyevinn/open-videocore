# open-videocore

An open source, OSC-native media asset management (MAM) API that orchestrates OSC video-processing services for ingest, transcoding, metadata, search, and delivery.

> **Status:** Early development — not yet ready for production use.

## What is open-videocore?

open-videocore is a headless, API-first MAM that manages media assets through their full lifecycle: ingest, transcoding, packaging, metadata, search, and delivery. It is designed for the [Open Source Cloud](https://www.osaas.io) catalog and composes OSC-hosted open source video-processing services into a single REST API.

A single `POST /api/v1/provision` call provisions the full backing infrastructure (object storage, document store, transcoder, packager, queue) on OSC. Tear it all down with `DELETE /api/v1/provision/:name`.

---

## Feature set

### Ingest

| Method | Endpoint | Notes |
|--------|----------|-------|
| URL pull | `POST /api/v1/assets/ingest-url` | SSRF-guarded; streams from any public HTTP/HTTPS URL into object storage |
| Direct upload | `POST /api/v1/assets/:id/upload-url` | Returns a presigned PUT URL for client-side upload |
| Watch folder | Background service | Polls or listens to MinIO bucket events; opt-in via `WATCH_FOLDER_ENABLED=true` |
| Placeholder | `POST /api/v1/assets` then `PATCH` | Create the record first, attach the object key later |

### Transcoding and packaging

| Feature | Endpoint | Notes |
|---------|----------|-------|
| ABR transcoding | `POST /api/v1/assets/:id/transcode` | Submits to Encore; preset-based (1080p, 720p, 480p ladders) |
| HLS/DASH packaging | Automatic callback | Triggered on transcode completion; output written to packaged bucket |
| Technical metadata | Auto on ingest; `POST /api/v1/assets/:id/extract-metadata` | ffprobe via `eyevinn-ffmpeg-s3`; writes codec, resolution, duration, bitrate |
| Thumbnail extraction | `POST /api/v1/assets/:id/thumbnails` | One or more timecodes; stored in MinIO |
| Clip / trim | `POST /api/v1/assets/:id/clip` | Time-window stream copy; creates new child asset with `parentId` |
| Export / re-wrap | `POST /api/v1/assets/:id/export` | Container remux (mp4, mkv, mov, mxf, ts) without re-encode; creates child asset |

### Delivery

| Feature | Endpoint | Notes |
|---------|----------|-------|
| Playback URL | `GET /api/v1/assets/:id/delivery` | Returns HLS/DASH manifest URLs when packaged, presigned source URL otherwise |
| Presigned download | Included in delivery response | Configurable TTL via `DELIVERY_URL_TTL_SECONDS` |

### Metadata

| Feature | Endpoint | Notes |
|---------|----------|-------|
| Flexible metadata | `PUT /api/v1/assets/:id/metadata` | Free-form `Record<string,unknown>`; replace wholesale |
| Partial update | `PATCH /api/v1/assets/:id` | Shallow-merges `metadata`, `name`, `description`, `tags` |
| First-class tags | `POST /api/v1/assets/:id/tags`, `DELETE /api/v1/assets/:id/tags/:tag` | Deduplicated string array |
| Audio tracks | `POST/DELETE /api/v1/assets/:id/audio-tracks/:trackId` | Language, codec, channels, label |
| Subtitle tracks | `POST/DELETE /api/v1/assets/:id/subtitle-tracks/:trackId` | VTT, SRT, TTML; presigned PUT URL for file upload |

### Search

| Feature | Endpoint | Notes |
|---------|----------|-------|
| Full-text + filters | `GET /api/v1/search` | Query by `q`, `tags`, `mimeType`, `metadata.<key>=<value>` |
| Pagination | `?page=&pageSize=` | — |
| Asset list | `GET /api/v1/assets` | Filter by `status`, `parentId`; paginated |

### Collections

| Feature | Endpoint | Notes |
|---------|----------|-------|
| Create / list / get / delete | `CRUD /api/v1/collections` | Workspace-scoped named groups |
| Membership | `PUT/DELETE /api/v1/collections/:id/assets/:assetId` | Validates asset exists (422 on dangling ref) |

### Event notifications (webhooks)

| Feature | Endpoint | Events |
|---------|----------|--------|
| Register | `POST /api/v1/webhooks` | url, events[], optional HMAC secret |
| List / delete | `GET/DELETE /api/v1/webhooks` | — |
| Fired on | — | `asset.ready`, `asset.failed`, `transcode.complete`, `transcode.failed`, `package.complete`, `package.failed` |

### Jobs

| Feature | Endpoint | Notes |
|---------|----------|-------|
| Poll job | `GET /api/v1/jobs/:id` | Status, progress, error; covers ingest, transcode, packaging |

### Infrastructure

| Feature | Endpoint | Notes |
|---------|----------|-------|
| Provision stack | `POST /api/v1/provision` | Creates MinIO, CouchDB, PostgreSQL, Valkey, Encore, callback listener, packager |
| List stacks | `GET /api/v1/provision` | Names of all provisioned stacks for this workspace |
| Get stack coords | `GET /api/v1/provision/:name` | Non-secret endpoints + bucket names |
| Deprovision | `DELETE /api/v1/provision/:name` | Tears down all services in dependency-safe order |
| Watch-folder status | `GET /api/v1/admin/watch-folder/status` | enabled / running / processedCount |

### Ops UI

A built-in single-page dashboard is served at `/ui`. Tabs: Assets, Jobs, Collections, Search, Webhooks, Provision.

---

## Supported use cases

The following end-to-end workflows can be tested today against a provisioned OSC stack.

### 1 — Ingest a video from a public URL and get playback URLs

```bash
# Ingest
curl -X POST http://localhost:3000/api/v1/assets/ingest-url \
  -H "Content-Type: application/json" \
  -d '{"sourceUrl":"https://example.com/media/clip.mp4","name":"clip.mp4"}'
# → {"assetId":"...","jobId":"..."}

# Poll until ready
curl http://localhost:3000/api/v1/jobs/{jobId}

# Get delivery URL (presigned source while not yet transcoded)
curl http://localhost:3000/api/v1/assets/{assetId}/delivery
```

### 2 — Ingest → transcode to ABR → package to HLS/DASH → deliver

```bash
# After ingest completes:
curl -X POST http://localhost:3000/api/v1/assets/{assetId}/transcode \
  -H "Content-Type: application/json" \
  -d '{"preset":"1080p"}'

# Encore → callback → packager runs automatically.
# When asset status reaches "ready":
curl http://localhost:3000/api/v1/assets/{assetId}/delivery
# → { urls: { hls: "https://...", dash: "https://..." } }
```

### 3 — Extract technical metadata and poster frames

```bash
# Metadata (auto on ingest; or on-demand):
curl -X POST http://localhost:3000/api/v1/assets/{assetId}/extract-metadata

# Poster frames at 0s, 30s, 60s:
curl -X POST http://localhost:3000/api/v1/assets/{assetId}/thumbnails \
  -H "Content-Type: application/json" \
  -d '{"timecodes":[0,30,60]}'

curl http://localhost:3000/api/v1/assets/{assetId}/thumbnails
# → { thumbnails: ["https://...0s.jpg", "...30s.jpg", "...60s.jpg"] }
```

### 4 — Clip a sub-segment and re-wrap into a different container

```bash
# Clip seconds 10–40:
curl -X POST http://localhost:3000/api/v1/assets/{assetId}/clip \
  -H "Content-Type: application/json" \
  -d '{"startSeconds":10,"endSeconds":40,"outputName":"highlight.mp4"}'
# → new child asset with parentId set

# Re-wrap clip to MXF for broadcast delivery:
curl -X POST http://localhost:3000/api/v1/assets/{clipAssetId}/export \
  -H "Content-Type: application/json" \
  -d '{"targetFormat":"mxf"}'
```

### 5 — Rich metadata, tagging, and search

```bash
# Set structured metadata:
curl -X PUT http://localhost:3000/api/v1/assets/{assetId}/metadata \
  -H "Content-Type: application/json" \
  -d '{"genre":"documentary","rightsHolder":"Eyevinn","language":"sv","embargo":"2026-01-01"}'

# Tag:
curl -X POST http://localhost:3000/api/v1/assets/{assetId}/tags \
  -H "Content-Type: application/json" \
  -d '{"tags":["sport","outdoor","4k"]}'

# Search by metadata field + tag:
curl "http://localhost:3000/api/v1/search?metadata.genre=documentary&tags=4k"
```

### 6 — Multi-language audio and subtitle tracks

```bash
# Add Swedish audio track:
curl -X POST http://localhost:3000/api/v1/assets/{assetId}/audio-tracks \
  -H "Content-Type: application/json" \
  -d '{"language":"sv","codec":"aac","channels":2,"default":true}'

# Add subtitle track + upload VTT file:
curl -X POST http://localhost:3000/api/v1/assets/{assetId}/subtitle-tracks \
  -H "Content-Type: application/json" \
  -d '{"language":"en","format":"vtt"}'
# → { track: {...}, uploadUrl: "https://..." }
curl -X PUT "{uploadUrl}" --data-binary @subtitles.vtt
```

### 7 — Organise assets into collections

```bash
# Create collection:
curl -X POST http://localhost:3000/api/v1/collections \
  -H "Content-Type: application/json" \
  -d '{"name":"Q1 Campaign"}'
# → { id: "collection-...", ... }

# Add assets:
curl -X PUT http://localhost:3000/api/v1/collections/{collectionId}/assets/{assetId}

# List collection with resolved assets:
curl http://localhost:3000/api/v1/collections/{collectionId}
```

### 8 — Event-driven integration via webhooks

```bash
# Register webhook (fired when asset is ready or transcode completes):
curl -X POST http://localhost:3000/api/v1/webhooks \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://your-system.example.com/hooks/ovc",
    "events": ["asset.ready","transcode.complete","package.complete"],
    "secret": "my-hmac-secret"
  }'

# open-videocore will POST signed payloads to your URL as events fire.
```

### 9 — Watch-folder auto-ingest from object storage

```bash
# Set WATCH_FOLDER_ENABLED=true and point the API at a MinIO stack.
# Any file uploaded directly to the source bucket (outside the API) is
# automatically detected, a new asset record is created, and technical
# metadata extraction fires — no API call required.
```

### 10 — One-command OSC stack provisioning and teardown

```bash
# Provision a full stack in ~90 seconds:
curl -X POST http://localhost:3000/api/v1/provision \
  -H "Content-Type: application/json" \
  -d '{"name":"production"}'

# List provisioned stacks:
curl http://localhost:3000/api/v1/provision

# Get endpoints:
curl http://localhost:3000/api/v1/provision/production

# Tear down everything:
curl -X DELETE http://localhost:3000/api/v1/provision/production
```

---

## Capability gaps vs enterprise MAMs

The following capabilities are present in enterprise-grade MAMs but not yet in open-videocore:

| Gap | Notes |
|-----|-------|
| **Metadata versioning** | No changeset audit trail; no diff between revisions; no historical queries |
| **Trim-on-delivery** | Clipping creates a new stored asset; there is no export-with-timecodes that produces a transient output |
| **Search faceting / autocomplete** | Text search is substring/Mango-based; no facet counts, no spell-check, no suggestion API |
| **Collection metadata inheritance** | Collections are membership groups only; metadata does not propagate from collection to member assets |
| **Rights / access windows** | No embargo dates, rights windows, or per-asset ACLs beyond workspace-level isolation |
| **Job priority and hold states** | Transcode jobs run at default priority; no hold-state or priority queue |
| **Bulk operations** | No batch metadata update, batch transcode, or batch export (issue #21) |
| **Multi-transport notifications** | Webhooks are HTTP-only; no JMS, SQS/SNS, or script invocation |
| **Shape hierarchy** | Renditions are modelled as child assets (parentId); there is no first-class Shape/Component model with per-rendition metadata |

---

## Architecture

See [docs/architecture/ADR-001-osc-stack.md](docs/architecture/ADR-001-osc-stack.md) for the full OSC service selection and rationale.

**OSC services used at runtime:**

| Service | Role |
|---------|------|
| `encore` | ABR transcoding |
| `eyevinn-encore-callback-listener` | Bridges Encore callbacks onto the queue |
| `eyevinn-encore-packager` | HLS/DASH packaging |
| `valkey-io-valkey` | Queue and coordination backbone |
| `minio-minio` | S3-compatible object storage |
| `apache-couchdb` | Asset metadata document store |
| `birme-osc-postgresql` | Relational store / future FTS index |
| `eyevinn-ffmpeg-s3` | Ephemeral FFmpeg jobs (probing, thumbnails, clip, remux) |
| `eyevinn-app-config-svc` | Parameter store for provisioned stack coordinates |

## Surfaces

| Directory | Description |
|-----------|-------------|
| [`backend-api/`](backend-api/) | Node.js / Fastify REST API + ops UI at `/ui` |
| [`frontend-web/`](frontend-web/) | Web UI (Next.js, not yet implemented) |
| [`data-pipeline/`](data-pipeline/) | Ingest and processing pipeline |
| [`infra/`](infra/) | OSC provisioning scripts |

---

## Quick start (OSC operator)

### Prerequisites

You need two deployment-level OSC resources created once per installation.

> **Note:** OSC instance names must be **alphanumeric only**. Set `OSC_ACCESS_TOKEN` before running `osc` commands.

**1. A Valkey instance (backing store for the parameter store)**

```bash
osc create valkey-io-valkey ovcparamstore
osc describe valkey-io-valkey ovcparamstore
# Note the redis:// connection URL from the output
```

**2. A parameter store (`eyevinn-app-config-svc`)**

```bash
osc create eyevinn-app-config-svc ovcconfig \
  -o RedisUrl=redis://172.232.x.x:YYYY \
  -o ConfigApiKey=<your-chosen-key>
# Note the url field — this is PARAMETER_STORE_URL
```

### Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OSC_ACCESS_TOKEN` | **Yes** | OSC Personal Access Token. Injected automatically at deploy time on OSC. |
| `MINIO_ROOT_PASSWORD` | **Yes** | Admin password used when provisioning MinIO instances. |
| `COUCHDB_ADMIN_PASSWORD` | **Yes** | Admin password used when provisioning CouchDB instances. |
| `PARAMETER_STORE_URL` | **Yes** | Base URL of the `eyevinn-app-config-svc` instance. |
| `PARAMETER_STORE_API_KEY` | **Yes** | `ConfigApiKey` of the `eyevinn-app-config-svc` instance. |
| `PORT` | No | HTTP port (default `3000`). |
| `DEV_WORKSPACE_ID` | No | Skip OSC token validation in local dev; sets workspace to this value. **Never set in production.** |
| `COUCHDB_URL` | No | CouchDB URL (with credentials). Falls back to in-memory when unset. |
| `MINIO_URL` | No | MinIO endpoint. Upload, ingest, thumbnails, clip, and export respond `501` when unset. |
| `MINIO_ACCESS_KEY` / `MINIO_SECRET_KEY` | No | MinIO credentials (default `admin`). |
| `MINIO_SOURCE_BUCKET` | No | Source bucket (default `openvideocore-source`). |
| `MINIO_PACKAGED_BUCKET` | No | Packaged output bucket (default `openvideocore-packaged`). |
| `ENCORE_URL` | No | Encore instance URL. Transcode route responds `501` when unset. |
| `REDIS_URL` | No | Valkey/Redis URL. HLS/DASH packaging responds `501` when unset. |
| `WATCH_FOLDER_ENABLED` | No | Set `true` to enable the watch-folder background service. |
| `DELIVERY_URL_TTL_SECONDS` | No | Presigned delivery URL TTL (default `3600`). |
| `UPLOAD_URL_TTL_SECONDS` | No | Presigned upload URL TTL (default `900`). |

### Run locally

```bash
cd backend-api
pnpm install
pnpm dev        # uses tsx watch + .env auto-load
```

Open the ops dashboard at [http://localhost:3000/ui](http://localhost:3000/ui).

### Provision a media stack

```bash
curl -X POST http://localhost:3000/api/v1/provision \
  -H "Content-Type: application/json" \
  -d '{"name":"mystack"}'
```

The response contains all connection endpoints. They are also persisted in the parameter store and retrievable at any time:

```bash
curl http://localhost:3000/api/v1/provision/mystack
curl -X DELETE http://localhost:3000/api/v1/provision/mystack   # teardown
```

---

## Contributing

Contributions welcome. Please open an issue or PR.

Open architectural questions: see [docs/architecture/ADR-001-osc-stack.md](docs/architecture/ADR-001-osc-stack.md#open-questions-for-the-customer).

## License

Apache 2.0 — see [LICENSE](LICENSE).
