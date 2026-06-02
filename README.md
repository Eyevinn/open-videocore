# open-videocore

An open source, OSC-native media asset management API that orchestrates OSC video-processing services for ingest, transcoding, metadata, search, and delivery.

> **Status:** Early development — not yet ready for production use.

## What is open-videocore?

open-videocore provides a REST API for managing media assets through their full lifecycle: ingest, transcoding, metadata management, search, and delivery. It is designed to be published to the [Open Source Cloud](https://www.osaas.io) catalog and runs on top of other OSC-hosted open source video-processing services.

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
| `birme-osc-postgresql` | Full-text search index |
| `eyevinn-ffmpeg-s3` | Ephemeral FFmpeg jobs (probing, thumbnails, remux) |

## Surfaces

| Directory | Description |
|-----------|-------------|
| [`backend-api/`](backend-api/) | Node.js REST API |
| [`frontend-web/`](frontend-web/) | Web UI (Next.js) |
| [`data-pipeline/`](data-pipeline/) | Ingest and processing pipeline |
| [`infra/`](infra/) | OSC provisioning scripts |

## Features (planned v1)

- **Ingest** — direct upload, URL pull, watch-folder via MinIO bucket events
- **Transcoding** — job-based ABR ladder generation via Encore
- **Packaging** — HLS/DASH output via Encore Packager
- **Metadata** — flexible document model with tagging via CouchDB
- **Search** — full-text search via PostgreSQL FTS
- **Delivery** — pre-signed MinIO URLs for playback
- **Notifications** — webhook delivery for asset and job events

## Quick start (OSC operator)

### Prerequisites

Before running open-videocore you need two pieces of OSC infrastructure in place. These are **deployment-level** resources — created once per installation, not per workspace.

**1. A Valkey instance (backing store for the parameter store)**

```bash
osc create valkey-io-valkey openvideocore
```

Note the connection URL from the output (e.g. `redis://<ip>:<port>`).

**2. A parameter store (`eyevinn-app-config-svc`)**

The parameter store persists provisioned stack endpoints so the API can rediscover them at runtime and deprovision cleanly. Pick a strong `ConfigApiKey` — this becomes `PARAMETER_STORE_API_KEY`.

```bash
osc create eyevinn-app-config-svc openvideocore \
  --RedisUrl redis://<ip>:<port> \
  --ConfigApiKey <your-chosen-key>
```

Note the instance URL from the output (e.g. `https://<tenant>-openvideocore.eyevinn-app-config-svc.auto.prod.osaas.io`).

> **Why pre-create?** The parameter store is infrastructure for the middleware itself, not for the media stacks it provisions. Auto-bootstrapping on startup is a planned improvement ([#35](https://github.com/Eyevinn/open-videocore/issues/35)).

### Set environment variables

Copy `backend-api/.env.example` to `backend-api/.env` and fill in the values (see [Environment variables](#environment-variables) below).

### Run locally

```bash
cd backend-api
pnpm install
pnpm dev
```

### Provision a media stack

Once the API is running, create a full stack (MinIO, CouchDB, PostgreSQL, Valkey, Encore, callback listener, packager) with a single call:

```bash
curl -X POST http://localhost:3000/api/v1/provision \
  -H "Content-Type: application/json" \
  -d '{"name": "my-workspace"}'
```

The response contains the connection endpoints for the provisioned stack. The API also stores them internally so you can retrieve them later:

```bash
curl http://localhost:3000/api/v1/provision/my-workspace
```

To tear down the stack:

```bash
curl -X DELETE http://localhost:3000/api/v1/provision/my-workspace
```

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `OSC_ACCESS_TOKEN` | **Yes** | OSC Personal Access Token. Get yours from [app.osaas.io/settings](https://app.osaas.io/settings). On OSC this is injected automatically at deploy time. |
| `MINIO_ROOT_PASSWORD` | **Yes** | Admin password for provisioned MinIO instances. Also reused as the PostgreSQL DB password and the Encore/packager S3 secret. Never sent in plaintext — registered as an OSC service secret and referenced via `{{secrets.<name>}}` at provision time. |
| `COUCHDB_ADMIN_PASSWORD` | **Yes** | Admin password for provisioned CouchDB instances. Same OSC secrets treatment as above. |
| `PARAMETER_STORE_URL` | **Yes** | Base URL of your pre-created `eyevinn-app-config-svc` instance. Required for `GET /api/v1/provision/:name` and `DELETE /api/v1/provision/:name` to work. Without it provisioning still succeeds but stack coordinates are not persisted. |
| `PARAMETER_STORE_API_KEY` | **Yes** | The `ConfigApiKey` you chose when creating the `eyevinn-app-config-svc` instance. |
| `PORT` | No | HTTP port (default `3000`). |
| `OSC_ENVIRONMENT` | No | OSC environment for token validation (default `prod`). |
| `PARAMETER_STORE_NAME` | No | Human-readable name for the store (default `openvideocore`). Used in logs only. |
| `COUCHDB_URL` | No | CouchDB connection URL for the asset/job document store. When unset the API uses an in-memory store (non-durable, suitable for development only). |
| `MINIO_URL` | No | MinIO S3 endpoint for the upload and URL-pull ingest routes. |
| `MINIO_ACCESS_KEY` | No | MinIO access key (default `admin`). |
| `MINIO_SECRET_KEY` | No | MinIO secret key. When unset, upload and ingest routes respond `501`. |
| `MINIO_SOURCE_BUCKET` | No | Source object bucket name (default `openvideocore-source`). |
| `ENCORE_URL` | No | Encore instance URL for ABR transcoding. When unset, the transcode route responds `501`. |
| `REDIS_URL` | No | Valkey/Redis connection URL for the packaging queue. When unset, HLS/DASH packaging responds `501`. |
| `UPLOAD_URL_TTL_SECONDS` | No | TTL for presigned upload URLs (default `900` — 15 min). |
| `INGEST_MAX_SOURCE_BYTES` | No | Maximum source file size for URL-pull ingest (default `53687091200` — 50 GB). |
| `PROBE_URL_TTL_SECONDS` | No | TTL for presigned URLs handed to the FFmpeg metadata probe job (default `600` — 10 min). |

## Contributing

Contributions welcome. Please open an issue or PR — see `.github/pull_request_template.md` for the PR format.

Open questions that need consultant decisions before implementation begins: see [docs/architecture/ADR-001-osc-stack.md](docs/architecture/ADR-001-osc-stack.md#open-questions-for-the-customer).

## License

Apache 2.0 — see [LICENSE](LICENSE).
