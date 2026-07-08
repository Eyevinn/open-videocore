# open-videocore

---
<div align="center">

## Quick Demo: Open Source Cloud

Run this service in the cloud with a single click.

[![Badge OSC](https://img.shields.io/badge/Try%20it%20out!-1E3A8A?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTIiIGZpbGw9InVybCgjcGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyKSIvPgo8Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI3IiBzdHJva2U9ImJsYWNrIiBzdHJva2Utd2lkdGg9IjIiLz4KPGRlZnM+CjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyIiB4MT0iMTIiIHkxPSIwIiB4Mj0iMTIiIHkyPSIyNCIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdG9wLWNvbG9yPSIjQzE4M0ZGIi8+CjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzREQzlGRiIvPgo8L2xpbmVhckdyYWRpZW50Pgo8L2RlZnM+Cjwvc3ZnPgo=)](https://app.osaas.io/browse/eyevinn-open-videocore)

</div>

---

Headless, API-first media asset management (MAM) middleware that runs entirely on [Open Source Cloud](https://www.osaas.io). A single API call provisions the full backing infrastructure — object storage, document store, transcoder, packager, and queue — and the middleware routes each workspace's requests to its own stack.

## Features

- **Ingest** — URL pull, direct upload, and watch-folder from object storage
- **Transcoding** — ABR ladder generation via [Encore](https://github.com/svt/encore)
- **Scalable transcoding** — an Encore auto-scaler spins up Encore instances on demand and tears down idle ones, paired with a dedicated callback listener per instance
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

> A dedicated Transcoders tab in the ops UI for observing and tuning the Encore auto-scaler is planned (issue #86).

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

This creates MinIO, CouchDB, Valkey, Encore, the callback listener, and the packager — all on OSC. The middleware connects to the provisioned stack automatically for all subsequent requests.

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
| `PARAMETER_STORE_API_KEY` | **Yes** | `ConfigApiKey` of the `eyevinn-app-config-svc` instance. |
| `PARAMETER_STORE_INSTANCE_NAME` | **Yes** | Name of the `eyevinn-app-config-svc` instance (default `ovcconfig`). |
| `MINIO_ROOT_PASSWORD` | **Yes** | Admin password used when provisioning MinIO instances. |
| `COUCHDB_ADMIN_PASSWORD` | **Yes** | Admin password used when provisioning CouchDB instances. |
| `REDIS_URL` | No | `redis://` connection URL for the Valkey instance used by the Encore auto-scaler. On OSC this is resolved automatically from the parameter store after provisioning — set it explicitly only for local development before a stack is provisioned. Without a Redis URL (and no provisioned stack to pull one from), transcoding is disabled. |
| `PORT` | No | HTTP port (default `3000`). |
| `ENCORE_MAX_INSTANCES` | No | Maximum Encore instances the auto-scaler may run per workspace (default `3`). |
| `ENCORE_MIN_INSTANCES` | No | Minimum Encore instances kept warm (default `0`). |
| `ENCORE_IDLE_TIMEOUT_MS` | No | Idle time before an Encore instance is torn down, in milliseconds (default `300000`, i.e. 5 minutes). Sets the boot-time default; it can be overridden at runtime without a restart via `PATCH /api/v1/scaler/config` (`idleTimeoutMs`, minimum `10000`). |
| `ENCORE_S3_ENDPOINT` | No | MinIO/S3 endpoint URL passed to Encore instances so they can read source media. If unset, Encore instances cannot read from MinIO. |
| `ENCORE_PROFILES_URL` | No | Default Encore profile index used to seed the profile store on first startup / bootstrap (default: the Eyevinn `encore-test-profiles` index). |
| `PUBLIC_BASE_URL` | No | Publicly-reachable base URL of this API (e.g. `https://ovc.example.com`). Used to build the `profilesUrl` handed to each Encore instance the auto-scaler spawns, pointing at `GET /api/v1/profiles/index.yml` so Encore loads the operator-managed profiles from CouchDB. If unset, Encore instances fall back to `ENCORE_PROFILES_URL`. |

## API reference

Interactive API documentation is at `/api-docs` when the service is running.

Key endpoints:

**Health**

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness probe with service identity |
| `GET` | `/healthz` | Minimal liveness probe |

**Assets**

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/assets` | Create an asset record |
| `GET` | `/api/v1/assets` | List workspace assets |
| `GET` | `/api/v1/assets/:id` | Get an asset |
| `PATCH` | `/api/v1/assets/:id` | Update asset fields |
| `DELETE` | `/api/v1/assets/:id` | Delete an asset |
| `POST` | `/api/v1/assets/ingest-url` | Ingest a video from a public URL |
| `PUT` | `/api/v1/assets/:id/upload` | Direct upload of source media |
| `POST` | `/api/v1/assets/:id/upload-url` | Get a presigned single-part upload URL |
| `POST` | `/api/v1/assets/:id/multipart/initiate` | Initiate a multipart upload |
| `GET` | `/api/v1/assets/:id/multipart/:uploadId/part-url` | Get a presigned URL for a part |
| `POST` | `/api/v1/assets/:id/multipart/:uploadId/complete` | Complete a multipart upload |
| `DELETE` | `/api/v1/assets/:id/multipart/:uploadId` | Abort a multipart upload |
| `POST` | `/api/v1/assets/:id/upload-complete` | Finalize a completed upload |
| `POST` | `/api/v1/assets/:id/transcode` | Submit an ABR transcoding job |
| `POST` | `/api/v1/assets/:id/package` | Submit an HLS/DASH packaging job |
| `POST` | `/api/v1/assets/:id/execute` | Run a pipeline execution |
| `GET` | `/api/v1/assets/:id/executions` | List pipeline executions for an asset |
| `GET` | `/api/v1/assets/:id/executions/:execId` | Get a pipeline execution |
| `POST` | `/api/v1/assets/:id/extract-metadata` | Extract technical metadata |
| `POST` | `/api/v1/assets/:id/thumbnails` | Extract poster frames |
| `GET` | `/api/v1/assets/:id/thumbnails` | List extracted thumbnails |
| `GET` | `/api/v1/assets/:id/thumbnails/:index` | Get a single thumbnail |
| `POST` | `/api/v1/assets/:id/clip` | Clip a time segment into a new asset |
| `POST` | `/api/v1/assets/:id/export` | Re-wrap into a different container format |
| `GET` | `/api/v1/assets/:id/delivery` | Get playback URLs |
| `PUT` | `/api/v1/assets/:id/metadata` | Replace free-form metadata |
| `GET` | `/api/v1/assets/:id/tracks` | List audio and subtitle tracks |
| `POST` | `/api/v1/assets/:id/audio-tracks` | Add an audio track |
| `DELETE` | `/api/v1/assets/:id/audio-tracks/:trackId` | Remove an audio track |
| `POST` | `/api/v1/assets/:id/subtitle-tracks` | Add a subtitle track |
| `DELETE` | `/api/v1/assets/:id/subtitle-tracks/:trackId` | Remove a subtitle track |
| `POST` | `/api/v1/assets/:id/tags` | Add a tag |
| `DELETE` | `/api/v1/assets/:id/tags/:tag` | Remove a tag |

**Jobs**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/jobs` | List background jobs |
| `GET` | `/api/v1/jobs/:id` | Get a job |
| `DELETE` | `/api/v1/jobs/:id` | Cancel or delete a job |

**Profiles**

Transcoding profiles are persisted in CouchDB (seeded from `ENCORE_PROFILES_URL`
on first startup) and served to Encore via the public, unauthenticated
`index.yml` endpoint. Operators manage them through the API or the Profiles tab
in the ops UI.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/profiles` | List profiles (names for the picker + full items) |
| `POST` | `/api/v1/profiles` | Create a profile (`{ name, yaml }`) |
| `GET` | `/api/v1/profiles/:name` | Get a single profile |
| `PUT` | `/api/v1/profiles/:name` | Replace a profile's YAML (`{ yaml }`) |
| `DELETE` | `/api/v1/profiles/:name` | Delete a profile |
| `POST` | `/api/v1/profiles/bootstrap` | Seed profiles from the default Encore index (`?force=true` to re-seed) |
| `GET` | `/api/v1/profiles/index.yml` | Public Encore-format profile index (no auth) |

**Search**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/search` | Full-text and metadata search |

**Auto-scaler**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/scaler/status` | Current Encore instance pool status (reports the effective `maxInstances` and `idleTimeoutMs`) |
| `GET` | `/api/v1/scaler/config` | Get auto-scaler configuration |
| `PATCH` | `/api/v1/scaler/config` | Update auto-scaler configuration (`maxInstances`, `minInstances`, `idleTimeoutMs`) at runtime; `idleTimeoutMs` must be at least `10000` ms |

**Collections**

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/collections` | Create a collection |
| `GET` | `/api/v1/collections` | List collections |
| `GET` | `/api/v1/collections/:id` | Get a collection |
| `DELETE` | `/api/v1/collections/:id` | Delete a collection |
| `PUT` | `/api/v1/collections/:id/assets/:assetId` | Add an asset to a collection |
| `DELETE` | `/api/v1/collections/:id/assets/:assetId` | Remove an asset from a collection |

**Webhooks**

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/webhooks` | Register a webhook |
| `GET` | `/api/v1/webhooks` | List webhooks |
| `DELETE` | `/api/v1/webhooks/:id` | Delete a webhook |

**Storage**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/storage/buckets` | List object storage buckets |
| `POST` | `/api/v1/storage/buckets` | Create a bucket |
| `GET` | `/api/v1/storage/buckets/:bucket/watch-folder` | Get watch-folder status for a bucket |
| `POST` | `/api/v1/storage/buckets/:bucket/watch-folder/toggle` | Toggle watch-folder ingest |
| `GET` | `/api/v1/storage/buckets/:bucket/objects` | List objects in a bucket |
| `DELETE` | `/api/v1/storage/buckets/:bucket/objects/*` | Delete an object |

**Provisioning**

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/provision` | Provision a full OSC media stack |
| `GET` | `/api/v1/provision` | List provisioned stacks |
| `GET` | `/api/v1/provision/:name` | Get a provisioned stack |
| `DELETE` | `/api/v1/provision/:name` | Deprovision (tear down) a stack |
| `GET` | `/api/v1/provision/operations` | List provisioning operations |
| `GET` | `/api/v1/provision/operations/:id` | Get a provisioning operation |

**Admin**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/admin/watch-folder/status` | Watch-folder poller status |
| `POST` | `/api/v1/admin/watch-folder/start` | Start the watch-folder poller |
| `POST` | `/api/v1/admin/watch-folder/stop` | Stop the watch-folder poller |

**Internal** (called by OSC services, not for direct client use)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/internal/encore-callback` | Encore job callback |
| `POST` | `/api/v1/internal/packagerCallback/success` | Packager success callback |
| `POST` | `/api/v1/internal/packagerCallback/failure` | Packager failure callback |

## Architecture

open-videocore runs as an OSC service and composes other OSC services at runtime:

| OSC Service | Role |
|---|---|
| `encore` | ABR transcoding. Instances are pooled and scaled on demand by the built-in Encore auto-scaler (spins up under load, tears down when idle) |
| `eyevinn-encore-callback-listener` | Bridges Encore callbacks onto the queue — one dedicated listener is paired with each Encore instance the auto-scaler starts |
| `eyevinn-encore-packager` | HLS/DASH packaging |
| `valkey-io-valkey` | Queue and coordination backbone |
| `minio-minio` | S3-compatible object storage |
| `apache-couchdb` | Asset metadata document store |
| `eyevinn-ffmpeg-s3` | Ephemeral FFmpeg jobs (probing, thumbnails, clip, remux) |
| `eyevinn-app-config-svc` | Parameter store for provisioned stack coordinates |

Each workspace provisions and owns its own stack. The middleware resolves the right backing services per request using the parameter store — no static connection strings required.

## Development

```bash
pnpm install
pnpm dev          # starts with tsx watch + .env auto-load
pnpm build        # compile TypeScript
pnpm test         # run test suite
```

The ops UI is served at `/ui` and the Swagger API docs at `/api-docs`.

For local development against real OSC services, set your `OSC_ACCESS_TOKEN`, then provision a stack via the Provision tab in the ops UI.

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
