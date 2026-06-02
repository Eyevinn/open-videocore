# open-videocore

---
<div align="center">

## Quick Demo: Open Source Cloud

Run this service in the cloud with a single click.

[![Badge OSC](https://img.shields.io/badge/Try%20it%20out!-1E3A8A?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTIiIGZpbGw9InVybCgjcGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyKSIvPgo8Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI3IiBzdHJva2U9ImJsYWNrIiBzdHJva2Utd2lkdGg9IjIiLz4KPGRlZnM+CjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyIiB4MT0iMTIiIHkxPSIwIiB4Mj0iMTIiIHkyPSIyNCIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdG9wLWNvbG9yPSIjQzE4M0ZGIi8+CjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzREQzlGRiIvPgo8L2xpbmVhckdyYWRpZW50Pgo8L2RlZnM+Cjwvc3ZnPgo=)](https://app.osaas.io/browse/eyevinn-open-videocore)

</div>

---

A headless, API-first media asset management (MAM) middleware that runs entirely on [Open Source Cloud](https://www.osaas.io). A single API call provisions the full backing infrastructure — object storage, document store, transcoder, packager, and queue — and the middleware routes each workspace's requests to its own stack automatically.

## Features

- **Ingest** — URL pull, direct upload, and watch-folder from object storage
- **Transcoding** — ABR ladder generation via [Encore](https://github.com/svt/encore)
- **Packaging** — HLS/DASH output via Encore Packager
- **Technical metadata** — codec, resolution, duration, bitrate extracted on ingest
- **Thumbnails** — poster frame extraction at arbitrary timecodes
- **Clip and trim** — sub-segment extraction into new child assets
- **Export / re-wrap** — container remux (MP4, MKV, MOV, MXF, TS) without re-encode
- **Flexible metadata** — free-form key-value fields with tag support and search
- **Multi-language** — per-asset audio track and subtitle track management
- **Collections** — named groups for organising assets
- **Search** — full-text and metadata field filtering
- **Delivery** — playback URLs (HLS/DASH manifests or presigned source download)
- **Webhooks** — HTTP event notifications for asset and job lifecycle events
- **Ops UI** — built-in dashboard at `/ui` for managing assets, jobs, and buckets

## Requirements

- An [Open Source Cloud](https://www.osaas.io) account and a Personal Access Token
- Node.js 20 or later (for local development)

## Quick start

### 1. Bootstrap the parameter store

The parameter store persists provisioned stack coordinates. Create it once per installation:

```bash
# Create a Valkey instance to back the parameter store
osc create valkey-io-valkey ovcparamstore

# Note the redis:// URL from the output, then create the parameter store
osc create eyevinn-app-config-svc ovcconfig \
  -o RedisUrl=redis://<ip>:<port> \
  -o ConfigApiKey=<choose-a-strong-key>
```

> OSC instance names must be alphanumeric only (no hyphens or underscores).

### 2. Configure and run

```bash
cd backend-api
cp .env.example .env   # fill in the values below
pnpm install
pnpm dev
```

Open the ops dashboard at [http://localhost:3000/ui](http://localhost:3000/ui).

### 3. Provision a media stack

```bash
curl -X POST http://localhost:3000/api/v1/provision \
  -H "Content-Type: application/json" \
  -d '{"name": "mystack"}'
```

This creates MinIO, CouchDB, Valkey, Encore, the callback listener, and the packager — all on OSC. The middleware auto-connects to the provisioned stack for all subsequent requests. No manual connection string configuration required.

List and inspect provisioned stacks:

```bash
curl http://localhost:3000/api/v1/provision
curl http://localhost:3000/api/v1/provision/mystack
```

Tear down a stack:

```bash
curl -X DELETE http://localhost:3000/api/v1/provision/mystack
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OSC_ACCESS_TOKEN` | **Yes** | Personal Access Token from [app.osaas.io/settings](https://app.osaas.io/settings). Injected automatically at deploy time on OSC. |
| `PARAMETER_STORE_URL` | **Yes** | Base URL of the `eyevinn-app-config-svc` instance. |
| `PARAMETER_STORE_API_KEY` | **Yes** | `ConfigApiKey` of the `eyevinn-app-config-svc` instance. |
| `MINIO_ROOT_PASSWORD` | **Yes** | Admin password used when provisioning MinIO instances. |
| `COUCHDB_ADMIN_PASSWORD` | **Yes** | Admin password used when provisioning CouchDB instances. |
| `PORT` | No | HTTP port (default `3000`). |
| `PARAMETER_STORE_INSTANCE_NAME` | No | Name of the `eyevinn-app-config-svc` instance (default `ovcconfig`). |
| `DEV_WORKSPACE_ID` | No | Skip OSC token validation and use this value as the workspace ID. **Never set in production.** |

## API reference

Interactive API documentation is available at `/api-docs` when the service is running.

Key endpoints:

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/assets/ingest-url` | Ingest a video from a public URL |
| `POST` | `/api/v1/assets` | Create an asset record |
| `GET` | `/api/v1/assets` | List workspace assets |
| `POST` | `/api/v1/assets/:id/transcode` | Submit ABR transcoding job |
| `POST` | `/api/v1/assets/:id/thumbnails` | Extract poster frames |
| `POST` | `/api/v1/assets/:id/clip` | Clip a time segment into a new asset |
| `POST` | `/api/v1/assets/:id/export` | Re-wrap into a different container format |
| `GET` | `/api/v1/assets/:id/delivery` | Get playback URLs |
| `GET` | `/api/v1/search` | Full-text and metadata search |
| `GET` | `/api/v1/jobs` | List background jobs |
| `POST` | `/api/v1/provision` | Provision a full OSC media stack |
| `GET` | `/api/v1/storage/buckets` | List object storage buckets |

## Architecture

open-videocore is designed to run as an OSC service and compose other OSC services at runtime:

| OSC Service | Role |
|---|---|
| `encore` | ABR transcoding |
| `eyevinn-encore-callback-listener` | Bridges Encore callbacks onto the queue |
| `eyevinn-encore-packager` | HLS/DASH packaging |
| `valkey-io-valkey` | Queue and coordination backbone |
| `minio-minio` | S3-compatible object storage |
| `apache-couchdb` | Asset metadata document store |
| `eyevinn-ffmpeg-s3` | Ephemeral FFmpeg jobs (probing, thumbnails, clip, remux) |
| `eyevinn-app-config-svc` | Parameter store for provisioned stack coordinates |

Each workspace provisions and owns its own stack. The middleware resolves the right backing services per request automatically using the parameter store — no static connection strings required.

## Development

```bash
cd backend-api
pnpm install
pnpm dev          # starts with tsx watch + .env auto-load
pnpm build        # compile TypeScript
pnpm test         # run test suite
```

The ops UI is served at `/ui` and the Swagger API docs at `/api-docs`.

For local development against real OSC services, set `DEV_WORKSPACE_ID=<your-tenant-id>` to bypass the OSC token validation, then provision a stack via the Provision tab in the ops UI.

### Contributing

See [CONTRIBUTING](CONTRIBUTING.md)

# Support

Join our [community on Slack](http://slack.streamingtech.se) where you can post any questions regarding any of our open source projects. Eyevinn's consulting business can also offer you:

- Further development of this component
- Customization and integration of this component into your platform
- Support and maintenance agreement

Contact [sales@eyevinn.se](mailto:sales@eyevinn.se) if you are interested.

# About Eyevinn Technology

[Eyevinn Technology](https://www.eyevinntechnology.se) is an independent consultant firm specialized in video and streaming. Independent in a way that we are not commercially tied to any platform or technology vendor. As our way to innovate and push the industry forward we develop proof-of-concepts and tools. The things we learn and the code we write we share with the industry in [blogs](https://dev.to/video) and by open sourcing the code we have written.

Want to know more about Eyevinn and how it is to work here. Contact us at work@eyevinn.se!
