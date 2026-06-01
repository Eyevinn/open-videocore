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

1. Provision the required OSC services (see `infra/provision-dev.sh`).
2. Set the required environment variables (see `backend-api/.env.example`).
3. Deploy this repo as an OSC catalog entry or run it locally:

```bash
cd backend-api
npm install
npm start
```

## Environment variables

All connection strings are read from environment at startup. See `backend-api/.env.example` for the full list. When running on OSC, bind to the `openvideocore` parameter store — all keys are pre-populated by the Day-1 deploy plan.

## Contributing

Contributions welcome. Please open an issue or PR — see `.github/pull_request_template.md` for the PR format.

Open questions that need consultant decisions before implementation begins: see [docs/architecture/ADR-001-osc-stack.md](docs/architecture/ADR-001-osc-stack.md#open-questions-for-the-customer).

## License

Apache 2.0 — see [LICENSE](LICENSE).
