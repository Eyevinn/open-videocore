# open-videocore

---
<div align="center">

## Quick Demo: Open Source Cloud

Run this service in the cloud with a single click.

[![Badge OSC](https://img.shields.io/badge/Try%20it%20out!-1E3A8A?style=for-the-badge&logo=data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjQiIGhlaWdodD0iMjQiIHZpZXdCb3g9IjAgMCAyNCAyNCIgZmlsbD0ibm9uZSIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj4KPGNpcmNsZSBjeD0iMTIiIGN5PSIxMiIgcj0iMTIiIGZpbGw9InVybCgjcGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyKSIvPgo8Y2lyY2xlIGN4PSIxMiIgY3k9IjEyIiByPSI3IiBzdHJva2U9ImJsYWNrIiBzdHJva2Utd2lkdGg9IjIiLz4KPGRlZnM+CjxsaW5lYXJHcmFkaWVudCBpZD0icGFpbnQwX2xpbmVhcl8yODIxXzMxNjcyIiB4MT0iMTIiIHkxPSIwIiB4Mj0iMTIiIHkyPSIyNCIgZ3JhZGllbnRVbml0cz0idXNlclNwYWNlT25Vc2UiPgo8c3RvcCBzdG9wLWNvbG9yPSIjQzE4M0ZGIi8+CjxzdG9wIG9mZnNldD0iMSIgc3RvcC1jb2xvcj0iIzREQzlGRiIvPgo8L2xpbmVhckdyYWRpZW50Pgo8L2RlZnM+Cjwvc3ZnPgo=)](https://app.osaas.io/browse/eyevinn-open-videocore)

</div>

---

Headless, API-first media asset management (MAM) middleware that runs entirely on [Open Source Cloud](https://www.osaas.io). A single API call provisions the full backing infrastructure — object storage, document store, transcoder, packager, and queue — and the middleware routes each workspace's requests to its own stack.

📖 **[Documentation](https://videocore.pages.osaas.io/)** — guides, data model, and full API reference.

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
- **Delivery** — playback URLs (HLS/DASH manifests proxy-streamed through the API, or presigned source download); see [ADR-003](docs/architecture/ADR-003-delivery-and-stream-url-contract.md) for the full `/delivery` + `/stream/*` contract
- **Webhooks** — HTTP event notifications for asset and job lifecycle events
- **Ops UI** — built-in dashboard at `/ui` for managing assets, jobs, and buckets

> A dedicated Transcoders tab in the ops UI for observing and tuning the Encore auto-scaler is planned (issue #86).

## Requirements

- An [Open Source Cloud](https://www.osaas.io) account and a Personal Access Token
- Node.js 20 or later (for local development)

## Security and deployment

> **The service must run behind an authenticating boundary. Do not expose it directly.**

Open Videocore has **no in-app authentication fallback**. Its request gate,
`requireAuth()` in [`src/auth/workspace.ts`](src/auth/workspace.ts), is a
**presence gate only**: it checks that a bearer token is present on the request
and rejects anonymous traffic, but it does **not** verify the token's identity,
validity, or authorisation. Real authentication is performed upstream by the OSC
auth wall, which authenticates every caller before the request reaches the
process (see issue #59 for the authoritative decision that removed in-app tenant
resolution in favour of the wall). The presence gate exists only as a last-ditch
guard so an accidentally-exposed deployment rejects anonymous requests — it is
**not** a substitute for the wall.

Because of this, the service **MUST** run in one of the following ways:

- **On OSC** — behind the OSC platform auth wall, which is the default when the
  service is deployed as an OSC instance. This is the supported configuration.
- **Off OSC** — behind an equivalent authenticating reverse proxy that
  authenticates every request before forwarding it, mirroring what the wall does
  on OSC.

**Publishing the container port directly, or otherwise bypassing the auth wall,
exposes the full API with no meaningful authentication.** Any caller that
attaches an arbitrary non-empty bearer token would pass the presence gate and
reach every endpoint — asset management, provisioning, storage, and
tear-down included. Do not map the container port to a public interface unless
an authenticating proxy sits in front of it.

## Quick start

The easiest way to get Open Videocore running is through an AI agent connected to OSC via MCP. The agent handles provisioning through natural language — no CLI, no copy-pasting resource IDs.

### 1. Connect your agent to OSC

For Claude Code or Claude Desktop:

```bash
claude mcp add --transport http osc https://mcp.osaas.io/mcp
```

For Cursor, VS Code, or other MCP-compatible tools, add `https://mcp.osaas.io/mcp` as an MCP server with your OSC Personal Access Token (from [app.osaas.io/settings](https://app.osaas.io/settings)) as the Bearer token. Full setup guides at [osaas.io/mcp](https://www.osaas.io/mcp).

### 2. Set up a parameter store

Open Videocore uses a parameter store to track the backing services it provisions. Ask your agent:

> Set up an app-config parameter store called `ovcconfig` for my Open Videocore deployment.

The agent provisions Valkey and the config service, then returns a config API key.

### 3. Deploy Open Videocore

> Create a Personal Access Token for the Open Videocore instance, then create an Open Videocore instance called `ovctest`. Connect it to the parameter store named `ovcconfig` using the API key from the previous step. Use the Personal Access Token as the OSC access token. Generate strong passwords for `MinioRootPassword` and `CouchdbAdminPassword`.

The agent provisions the instance and returns its public URL — `https://<your-instance>` in all examples below.

### 4. Provision a media stack

A single API call stands up the backing infrastructure for a workspace — MinIO, CouchDB, and Valkey. Neither Encore nor the packager is created here; the Encore auto-scaler spins Encore instances up on demand when the first transcode jobs arrive, and the packager is provisioned on demand the first time a packaging job runs (see below).

```bash
curl -X POST https://<your-instance>/api/v1/provision \
  -H "Content-Type: application/json" \
  -d '{"name": "mystack"}'
```

Provisioning is asynchronous. Poll the returned `operationId` until `status` reaches `"done"`:

```bash
curl https://<your-instance>/api/v1/provision/operations/<operationId>
```

By default the stack provisions its own MinIO instance and buckets — no storage
configuration is required. The optional `sourceStorage` / `packagedStorage`
blocks name an operator-owned bucket for a role: `bucket`/`region`/`publicBaseUrl`
are persisted as non-secret coordinates used when delivery URLs are emitted, and
a `sourceStorage` block's credentials become per-service OSC secrets (a
`packagedStorage` block's are validated and then discarded by this route). The
bucket **name** moves the bucket jobs read and write only when the API runs with
[`HONOUR_CUSTOM_BUCKETS`](#environment-variables) enabled; off (the default) that stays
the stack's own. Neither setting accepts an external S3 API host: a block
carrying `endpointUrl` is refused with a 400 (issue #641). To ingest from a
bucket on an external S3 API host, register it with
`POST /api/v1/storage/backends` — which does take `endpointUrl` — and pass
`sourceBackend` on `POST /api/v1/assets/ingest-url`. See
[Provisioning with external S3-compatible storage](docs/guides/provisioning-external-storage.md)
for every field, worked examples, and the CDN-origin pattern.

List, inspect, and tear down stacks:

```bash
curl https://<your-instance>/api/v1/provision
curl https://<your-instance>/api/v1/provision/mystack
curl -X DELETE https://<your-instance>/api/v1/provision/mystack
```

#### On-demand packaging provisioning

The packaging service (`eyevinn-encore-packager`) is **not** provisioned when you provision a stack. It is provisioned **lazily**, on the first pipeline execution that includes a packaging step, wired to the stack's shared Valkey queue and packaged-output storage, and reused by every subsequent packaging execution. It is torn down automatically when you deprovision the stack (`DELETE /api/v1/provision/:name`).

Operator-visible trade-offs:

- **Lower provision-time footprint.** A freshly provisioned stack creates three OSC instances (MinIO, CouchDB, Valkey) instead of four, and mints **no** packager secrets or tokens until packaging is actually used. Stacks that never package never pay for a packager.
- **First-run cold start.** The **first** packaging execution on a stack incurs additional latency while the packager instance is created and becomes ready (the create call plus a wait-for-ready gate — the packaging job is only enqueued once the packager reports healthy). Every subsequent packaging execution reuses the running instance and does not pay this cost.
- **No pre-warm option.** There is currently no API or configuration flag to pre-warm the packager ahead of the first packaging job — the cold start happens on first use by design. If you need to absorb the cold start before a time-sensitive workload, run one throwaway packaging execution first to leave the packager running for the stack. (Idle teardown of the packager is a noted follow-up and is not yet implemented, so a warmed packager stays up until the stack is deprovisioned.)

### 5. Bootstrap transcoding profiles

```bash
curl -X POST https://<your-instance>/api/v1/profiles/bootstrap
```

Seeds the profile store from the default Encore test profiles. The ops dashboard is at `https://<your-instance>/ui`.

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `OSC_ACCESS_TOKEN` | **Yes** | Personal Access Token from [app.osaas.io/settings](https://app.osaas.io/settings). Injected automatically at deploy time on OSC. |
| `PARAMETER_STORE_API_KEY` | **Yes** | `ConfigApiKey` of the `eyevinn-app-config-svc` instance. |
| `PARAMETER_STORE_INSTANCE_NAME` | **Yes** | Name of the `eyevinn-app-config-svc` instance (default `ovcconfig`). |
| `MINIO_ROOT_PASSWORD` | **Yes** | Deployment-level object-store credential material. Each stack provisioned from here gets its **own** object-store access key id and secret, derived from this value, so a credential issued for one stack cannot read or write another stack's buckets. **Use a high-entropy value** (at least 32 characters, which is what reliably reaches the ~112-bit floor the API enforces — generated, not chosen, e.g. `openssl rand -base64 32`): the derivation key is `scrypt` of this value, and that per-stack isolation holds only while the value is expensive to guess, because anyone holding one stack's leaked credential can otherwise search for it offline. Below that strength the API logs an **error** at startup and for each affected stack, and newly provisioned stacks keep the deployment-wide credential instead; set `ALLOW_SHARED_OBJECT_STORE_CREDENTIAL=true` to acknowledge that deliberately and downgrade the startup line to a warning. Treat it as a root secret: it is never used as a stack credential itself, but it can derive every stack's credential. Rotating it invalidates the derived credentials of already-provisioned stacks (the live instances keep the credential they were created with), exactly as rotating it did before. A stack provisioned by an older build keeps its original deployment-wide credential until it is migrated — see [Moving a legacy stack to a per-stack object-store credential](docs/guides/legacy-stack-object-store-credentials.md) for how to identify one, what re-provisioning costs, and what rotating this value breaks. |
| `COUCHDB_ADMIN_PASSWORD` | **Yes** | Admin password used when provisioning CouchDB instances. |
| `PORT` | No | HTTP port (default `3000`). |
| `DEFAULT_STACK_NAME` | No | Pins the **default stack** — the stack a request with no `X-Stack-Name` header is routed to, and whose transcode profile index is served as the deployment default. Normally leave this unset: the default is the first-created stack, and provisioning or deprovisioning another stack cannot change it. Set it only on a deployment that had **several** stacks before this version began recording stack creation times — those stacks carry no recorded instant and the config service stores no creation metadata of its own, so there is nothing to reconstruct their original order from. They are ordered by name instead, which can move the default once; naming the stack that should remain the default here overrides ordering entirely. A name matching no provisioned stack is ignored rather than failing the listing. |
| `PROVISION_READY_TIMEOUT_MS` | No | How long provisioning waits for each backing instance to report healthy, in milliseconds (default `300000`, i.e. 5 minutes). The wait polls instance health on its own loop and treats a dropped poll as "not ready yet", so a single network blip no longer aborts the stack; on timeout the error names the service and the last probe error, and the usual rollback tears down what that run created. |
| `PROVISION_READY_POLL_INTERVAL_MS` | No | How often that readiness wait re-checks instance health, in milliseconds (default `1000`). |
| `HONOUR_CUSTOM_BUCKETS` | No | **Off by default.** Set to `1`/`true`/`yes`/`on` to make `POST /api/v1/provision` honour the `bucket` you supply in `sourceStorage` / `packagedStorage`: the stack creates (or adopts) that bucket **on its own object-storage endpoint** and binds every job to it, so ingest, packaged output and the emitted delivery URLs all name one bucket. Off, a bucket differing from the stack default is **not** used — jobs keep using `openvideocore-source` / `openvideocore-packaged` and the ignored field is logged at `error` level. Only the bucket **name** is ever redirected: a supplied `endpointUrl` is still rejected with a 400, because the pipeline builds bucket-only `s3://` URIs against one fixed endpoint. A bucket that cannot be created or reached **fails** the provision rather than falling back to the default. Re-provisioning an existing stack with a different bucket is **rejected** — nothing migrates the objects already written, so the stack would otherwise be split across two buckets. See [Provisioning with external S3-compatible storage](docs/guides/provisioning-external-storage.md). |
| `DRM_ENABLED` | No | **Off by default (ADR-008 D9).** Set to exactly `true` to enable DRM protection of packaged output: per-asset protection state is persisted at `structural.drm` and a per-execution DRM request is accepted. Unset — or any other value — and no protection state is written from or read back onto an asset, so the clear path behaves exactly as it did before the feature existed. Turning the flag back off does **not** delete protection state already persisted by a flag-on run: an existing block is round-tripped untouched by later writes, so the switch is reversible. A DRM system is identified by its registered common-encryption system id (the CPIX `DRMSystem@systemId` UUID), never by a product name. |
| `DRM_KEY_PROVIDER_USERNAME` | No | Username used when this API requests content keys from the configured key server, for a stack whose DRM `authMode` is `basic` (ADR-008 §5.2). **Required only in that mode**, together with `DRM_KEY_PROVIDER_PASSWORD`: with either one missing the key step fails with `drm_not_configured` instead of calling the key server unauthenticated. The pair is sent as an HTTP `Basic` `Authorization` header, and only over TLS — `keyServerUrl` must be `https:`, which is enforced when the provider is built. Read from the environment **per key request**, so a rotated credential applies without a restart. Per ADR-002 and ADR-008 §5.2 it stays an operator environment variable: it never enters the parameter store, an API response (`GET /api/v1/drm/config` reports only `credentials: configured \| missing`) or a log line. Not exposed by the OSC deploy form, so it is self-hosted only. |
| `DRM_KEY_PROVIDER_PASSWORD` | No | Password that goes with `DRM_KEY_PROVIDER_USERNAME` for DRM `authMode: basic`. Identical handling: required only in that mode, sent only over TLS, re-read per key request, never persisted, echoed in a response or logged. |
| `DRM_KEY_PROVIDER_TOKEN` | No | Bearer token presented to the key server for a stack whose DRM `authMode` is `bearer` (ADR-008 §5.2). **Required only in that mode** — absent, the key step fails with `drm_not_configured` rather than calling the key server unauthenticated. Sent as `Authorization: Bearer <token>` over TLS, re-read per key request, never persisted, echoed in a response or logged. |
| `DRM_KEY_PROVIDER_CLIENT_CERT` | No | TLS **client certificate** for a stack whose DRM `authMode` is `mtls` (ADR-008 §5.2). In this mode the certificate *is* the credential and no `Authorization` header is sent: it is presented on the TLS handshake to the key server. Accepts **either** the PEM text inline (any value containing a `-----BEGIN` armour line is used as-is) **or** a filesystem **path** to a PEM file, which is read when a key is requested; a path that cannot be read fails with `drm_not_configured` naming only the variable, never its contents. **Required only in that mode**, together with `DRM_KEY_PROVIDER_CLIENT_KEY`. Never persisted, echoed in a response or logged. |
| `DRM_KEY_PROVIDER_CLIENT_KEY` | No | Private key matching `DRM_KEY_PROVIDER_CLIENT_CERT`, for DRM `authMode: mtls`. Same two accepted forms (inline PEM or a path to a PEM file) and the same handling: required only in that mode, read per key request, never persisted, echoed in a response or logged. |
| `ENCORE_MAX_INSTANCES` | No | Maximum Encore instances the auto-scaler may run per workspace (default `3`). Sets the boot-time value; it can be overridden at runtime without a restart via `PATCH /api/v1/scaler/config` (`maxInstances`). That change is persisted to the parameter store **and reloaded at boot** (#1078), so after a restart the persisted value wins and this variable applies only until the first `PATCH` (or when the store cannot be read at boot, which is warn-logged) — see [Runtime scaler config: where it lives, what wins](#runtime-scaler-config-where-it-lives-what-wins). |
| `ENCORE_MIN_INSTANCES` | No | Minimum Encore instances the auto-scaler keeps warm per workspace even when idle (default `0` — scale to zero). Set to `1` or more to keep a warm floor for production / latency-sensitive shared pools. A `minInstances` sent to `PATCH /api/v1/scaler/config` is not applied to the already-running scaler, but it is persisted and, since #1078, loaded at boot with precedence over this variable — so changing the enforced floor through the API takes one restart. See [Auto-scaler warm floor](#auto-scaler-warm-floor-cost-vs-reliability) for the cost-vs-reliability trade-off. |
| `ENCORE_IDLE_TIMEOUT_MS` | No | Idle time before an Encore instance is torn down, in milliseconds (default `300000`, i.e. 5 minutes). Sets the boot-time value; it can be overridden at runtime without a restart via `PATCH /api/v1/scaler/config` (`idleTimeoutMs`, minimum `10000`). That change is persisted to the parameter store **and reloaded at boot** (#1078), so after a restart the persisted value wins; this variable is the value for a deployment never configured through the API. |
| `ENCORE_SPAWN_ADOPT_PROBE_TIMEOUT_MS` | No | How long a scale-up keeps asking the platform for the instance name it already requested, after every create attempt ended in a **gateway timeout** (504/408), in milliseconds (default `90000`, i.e. 90 seconds). It is a **ceiling, not a fixed wait**. A create that times out at the gateway usually completes behind it, so the spawn watches that same name instead of inventing a new one on the next tick — but it only adopts an instance whose existence OSC **confirms**; an instance merely being *reported* is not enough, because a 200 that is not an instance body (a gateway page, an empty body, a record being rolled back) used to be read as "it appeared" and taken over. The watch ends one of three ways: OSC confirms the instance, which adopts it; OSC enumerates this service's instances and the name is **not** among them, which is a proven absence and ends the watch **early**, without spending the rest of this budget; or the budget runs out with nothing proven either way, which fails the spawn — and if an instance was seen under that name it is deliberately left to the orphan reaper, because it may be live and this spawn cannot prove it owns it. An absent, unparseable or negative value falls back to the default; `0` does **not** disable the probe — only values greater than zero are honoured, so `0` is treated as absent and the default applies. Not exposed by the OSC deploy form (see ADR-026 C9), so on a catalog deploy this is the default. |
| `ENCORE_SPAWN_GATEWAY_BACKOFF_MS` | No | How long the next scale-up for a workspace is held off after a spawn that ended in a gateway timeout, in milliseconds (default `120000`, i.e. 2 minutes) — the **first** such failure's hold-off; each consecutive failure doubles it, up to `ENCORE_SPAWN_BACKOFF_MAX_MS`, and the first successful spawn resets it. A 504 is the platform telling us it is slow, so the scaler waits instead of starting a second create against it on the very next tick. A gateway timeout and a transport failure (`fetch failed` — nobody answered at all) trigger the hold-off; any other spawn failure (a `403`, a rejected body) never delays the retry. An absent, unparseable or negative value falls back to the default; `0` **disables** the hold-off, so scale-up may retry on the next tick. `GET /api/v1/scaler/status` reports `spawnFailure.httpCode`, so a pool that is standing still because of this hold-off can be told apart from one that is failing for another reason. Not exposed by the OSC deploy form (see ADR-026 C9), so on a catalog deploy this is the default. |
| `ENCORE_MAX_CONCURRENT_SPAWNS` | No | How many transcoder spawns this API instance may have in flight at once, **across every workspace it serves** (default `1`). Each spawn creates two service instances, so two ingresses, and each ingress goes through the cluster's admission webhook (observed at 15-19s each when the platform is busy); the per-workspace gates cannot see each other, so two workspaces with queued work used to start their creates in the same instant and overlapping bursts took out the platform's controllers. A workspace that cannot get a slot is not queued: it logs why and retries on its next tick, and the rest of that tick (scale-down, the orphan sweep, dispatch) runs as usual. Raise it only on a cluster you have verified can take the parallel creates. An absent, unparseable value, or anything below `1`, falls back to the default — there is no "unlimited" setting. Not exposed by the OSC deploy form (see ADR-026 C9), so on a catalog deploy this is the default. |
| `ENCORE_SPAWN_BACKOFF_MAX_MS` | No | Ceiling on the scale-up hold-off once repeated failures have lengthened it, in milliseconds (default `1800000`, i.e. 30 minutes). The hold-off starts at `ENCORE_SPAWN_GATEWAY_BACKOFF_MS` and doubles with each consecutive failed spawn, so a platform that keeps refusing the create is asked less and less often; without a ceiling the doubling would park scale-up for hours after a bad afternoon. The first successful spawn clears the record and the hold-off starts over at the base value. An absent, unparseable or non-positive value falls back to the default, and a value below the base hold-off is ignored in favour of the base — it can never shorten the first hold-off. Not exposed by the OSC deploy form (see ADR-026 C9), so on a catalog deploy this is the default. |
| `ENCORE_S3_ENDPOINT` | No | Static object-store endpoint URL passed to Encore instances so they can read source media. **Normally leave this unset on OSC** — the endpoint is read per stack from the provisioned stack's own config in the parameter store. Set it only for local development, or as a fallback for deployments with no provisioned stack config. It is a *fallback*, not an override: when a stack does have a stored endpoint, that stored endpoint is what the transcoder gets, and this value is not used for that stack. When it is unset *and* no endpoint can be resolved from a stack's stored config, transcode submission fails loudly with an error naming the cause, rather than silently spawning a transcoder with no endpoint (which used to surface as an unexplained 404 on the `s3://` input). |
| `ENCORE_S3_INTERNAL_ENDPOINT` | No | Set to `off` (also `false`/`0`/`no`/`disabled`) to stop handing spawned Encore instances the **in-cluster** object-store Service address (`http://<instance>.minio-minio.svc.cluster.local:8080`) and use the stack's public endpoint instead. Default is on: the address is looked up from the platform itself (the `getInternalEndpoint` API, which returns the instance's `serviceDns`), falling back to deriving it from the stack's stored public endpoint when the platform cannot answer — and it is used **only after a live health probe from this API succeeds**. Otherwise the public endpoint is used and a warning is logged, so a cross-cluster deployment keeps working unchanged. This exists because one long single-connection read of a large source through the public ingress is severed mid-stream (see `docs/investigations/294-minio-ingress-longlived-connections.md`); routing the transcoder's reads/writes in-cluster takes the ingress out of that data path. Client-facing URLs (presigned uploads, playback, API responses) always stay public. This applies to the endpoint read from a provisioned stack's config; a static `ENCORE_S3_ENDPOINT` is used verbatim on its own path and never passes through this resolver. Full audit: `docs/investigations/991-internal-object-store-endpoint-paths.md`. |
| `ENCORE_S3_INTERNAL_PORT` | No | Service port used for the in-cluster object-store endpoint (default `8080`, the S3 API port). An invalid value falls back to the default rather than failing startup. The platform's `getInternalEndpoint` currently reports no ports for object-store instances (`ports: []`), so this default is what is actually used; if the platform starts reporting ports, the reported one is preferred over this. |
| `ENCORE_S3_INTERNAL_PROBE_TIMEOUT_MS` | No | Timeout for the in-cluster endpoint health probe, in milliseconds (default `3000`). On timeout the public endpoint is used. |
| `ENCORE_S3_MULTIPART_PART_SIZE_BYTES` | No | Multipart part size, in bytes, that each **newly spawned** Encore instance uploads its outputs with (the transcoder's `s3MultipartMinPartsize` option). **Unset by default: nothing is sent and the transcoder keeps its own default of `104857600` (100 MB).** Accepts a whole number of bytes from 5 MiB (`5242880`) to 5 GiB; anything else is ignored with a warning in the log and the default applies. **Read before lowering it:** the transcoder's multipart *threshold* defaults to the part size, so a lower value also sends smaller outputs (everything above the new value) through the multipart path that is used today only above 100 MB. It is a tunable, and it is **not established** that it affects the large-output upload failure in #1221 (the failing error text may come from a client this setting does not reach). Instances already running when you change it keep their old value until they are torn down and respawned. |
| `ENCORE_INPUT_RECONNECT_ENABLED` | No | Set to `false` to submit transcode job inputs with **no** input params at all, the pre-#1222 behaviour. Default is on: every network input (`s3:`/`http:`/`https:`) carries `reconnect=1`, `reconnect_on_network_error=1`, `reconnect_delay_max` and `rw_timeout`, so a source connection that dies mid-read times out and resumes from the same byte offset instead of hanging the read or failing the job with no output. Only the exact string `false` (case-insensitive, surrounding whitespace ignored) disables it — any other value, including unset, keeps the recovering behaviour, so the safe setting is the default. This is a diagnostic escape hatch for ruling these params out while investigating something else, not a tuning knob. Note the params cover the encode's own source reads; the analyze step that runs before it takes no input params service-side, so that window is still a single unprotected read (`docs/osc-feedback/incoming-issue1222-mediainfo-no-input-params.md`). |
| `ENCORE_INPUT_RECONNECT_DELAY_MAX_SECONDS` | No | Ceiling on the exponential backoff between a network input's reconnect attempts, in **seconds** (default `30`). Emitted as ffmpeg's `reconnect_delay_max` input option. Unset, unparseable, non-positive, or fractional-below-1 (which would truncate to `0` and remove the ceiling) falls back to the default rather than disabling the bound; a larger fractional value is truncated to whole seconds. Ignored when `ENCORE_INPUT_RECONNECT_ENABLED=false`. |
| `ENCORE_INPUT_RW_TIMEOUT_MICROSECONDS` | No | Read deadline for a network input, in **microseconds** (default `10000000`, i.e. 10 seconds) — the unit is ffmpeg's, not this API's, so this is seconds-scale and not ~3 hours. Emitted as ffmpeg's `rw_timeout` input option: a read that stalls longer than this fails, and the reconnect logic above takes over. Unset, unparseable, non-positive, or fractional-below-1 (which would truncate to `0`, and ffmpeg reads `rw_timeout=0` as *no* timeout) falls back to the default rather than disabling the bound. Raise it for a source that is legitimately slow to first byte; lower it to detect a dead source sooner. Ignored when `ENCORE_INPUT_RECONNECT_ENABLED=false`. |
| `ENCORE_TRANSCODE_STALL_TIMEOUT_MS` | No | How long a transcode job may report the **same** progress percent before it is declared stalled, in milliseconds (default `3600000`, i.e. 60 minutes). **This changes what happens to a silently hung transcode.** A source connection dropped mid-encode can freeze the encoder with no error at all: progress simply stops advancing, Encore keeps reporting the job `IN_PROGRESS`, and the job used to stay `running` forever with nothing in the packaged bucket and no retry. It is now **failed and bounded-retried** like the fast-erroring version of the same drop — re-dispatched with backoff, and only settled terminal once the retry bound is exhausted. Two things keep a legitimately slow encode out of that path: a job reporting progress `0` is never counted as stalled at all (that is also what the pre-encode analyze step looks like, and it can run a long time on a large source), and the default bound is derived from the reporting granularity — Encore reports **integer** percent, so a healthy job holds one value for at most its total runtime ÷ 100, and a 60-minute bound therefore only misfires on an encode longer than ~100 hours. Raise it if you encode sources far longer than that; lower it to detect a hang sooner, accepting that a value near one percent of your longest encode will start failing healthy jobs. An absent, unparseable or non-positive value falls back to the default rather than shortening to zero. Not exposed by the OSC deploy form (see ADR-026 C9), so on a catalog deploy this is the default. |
| `ENCORE_PROFILES_URL` | No | Default Encore profile index used to seed the profile store on first startup / bootstrap (default: the Eyevinn `encore-test-profiles` index). |
| `SCENE_POLL_BUDGET_SECONDS` | No | How long one scene-detection job may be polled before it is given up on, in **seconds** (default `1500`, i.e. 25 minutes). An absent, unparseable or non-positive value falls back to the default. The value is then **clamped to 5/6 of `SCENE_URL_TTL_SECONDS`**, the lifetime of the presigned source URL the detector decodes as its input: a budget outliving that URL would not wait longer, it would fail mid-decode with a 403. **So raising this alone does nothing above that ceiling — raise both together** (ADR-027 D8). A clamp is not a startup error: it is warn-logged once per detection run, and detection is dispatched detached from the ingest/pipeline request, so that log line is the only notice you get. Not exposed by the OSC deploy form, so on a catalog deploy this is the default. |
| `SCENE_URL_TTL_SECONDS` | No | Lifetime of the presigned source URL handed to the scene detector, in **seconds** (default `1800`, i.e. 30 minutes). An absent, unparseable or non-positive value falls back to the default. It is also the ceiling `SCENE_POLL_BUDGET_SECONDS` is clamped against — 5/6 of this value, which is exactly the `1500` budget default against the `1800` TTL default — so in practice the two are halves of one setting: a longer detection budget needs this raised first. Not exposed by the OSC deploy form, so on a catalog deploy this is the default. |
| `THUMBNAIL_MULTI_SIZE` | No | Opt in to extracting **small (360px wide) and medium (1280px wide)** thumbnails alongside the full frame, so a list or grid view can fetch a few KB instead of a whole source-resolution frame. Default **off**: only the exact string `true` enables it, so a typo (`TRUE`, `1`, `yes`) fails safe and leaves extraction at the full frame only. Each size is written to its own object key (`thumb_<t>s_1280.jpg` / `thumb_<t>s_360.jpg`) by its own job, because the `eyevinn-ffmpeg-s3` service uploads exactly one `s3://` output per invocation — so **N sizes cost N extra jobs per timecode**, which is the reason this is opt-in rather than always on. Sizes that landed are reported as `thumbnailSizes` on the asset, each entry naming the `thumbnails[]` key it was derived from; the `thumbnails` list and its index meaning are unchanged either way, so `GET /api/v1/assets/:id/thumbnails/:index` behaves the same with the flag on or off. A size whose job failed is simply absent — the list only ever names objects confirmed in storage. Turning the flag back **off** and re-extracting clears `thumbnailSizes`, so it never outlives the frames it points at. |
| `PUBLIC_BASE_URL` | No | Publicly-reachable base URL of this API (e.g. `https://ovc.example.com`). Used to build the `profilesUrl` handed to each Encore instance the auto-scaler spawns, pointing at `GET /api/v1/profiles/index.yml` so Encore loads the operator-managed profiles from CouchDB. If unset, Encore instances fall back to `ENCORE_PROFILES_URL`. |
| `OVC_TRUST_ROLE_HEADER` | No | Opt in to per-caller roles by trusting the `X-OVC-Role` request header (`viewer` / `editor` / `admin`) as the caller's authenticated role. Default **off**: only the exact string `true` enables it, so a typo (`TRUE`, `1`, `yes`, ` true`) fails safe and leaves the deployment untrusted. **Only enable it behind a fronting layer — a reverse proxy or self-deployed identity provider — that strips any client-supplied `X-OVC-Role` and injects the authenticated caller's role itself.** Enabled without such a layer, the header is attacker-controlled: any caller can send `X-OVC-Role: admin`, and a caller who sends no header at all still resolves to `admin` (the single-operator default), so every caller is effectively an admin and the role gate stops protecting anything. Left off, the header is deleted at the trust boundary before it is read, every caller resolves to `admin`, and behaviour is identical to the existing authenticated-⇒-full-access model. The planned OSC catalog option for this is `TrustRoleHeader` (string `"true"` / `"false"`, default `"false"`); it is not in the service manifest yet, so for now set the environment variable directly. |

## API reference

Task-oriented guides, the data model, and the full endpoint reference are published at **[videocore.pages.osaas.io](https://videocore.pages.osaas.io/)** — no running instance required, and kept in sync with `openapi.json` by CI (see [Development](#development) below).

A generated [openapi.json](openapi.json) is committed to the repo and kept up to date — no running instance required.

Interactive documentation is also at `/api-docs` when the service is running.

> **Collection paths and the trailing slash.** Each collection root below (for
> example `POST /api/v1/assets` to create an asset record, or `GET /api/v1/assets`
> to list) is served both with and without a trailing slash — `POST /api/v1/assets`
> and `POST /api/v1/assets/` reach the same handler. The generated
> [openapi.json](openapi.json) keys these collection-root operations with a
> trailing slash (`/api/v1/assets/`), because that is the path the framework emits
> for a route mounted at a router's prefix root. The tables below use the shorter,
> slash-free form for readability. Both forms are valid at runtime; neither returns
> a 404.

Key endpoints:

**Health**

| Method | Path | Description |
|---|---|---|
| `GET` | `/health` | Liveness probe with service identity, build identity, resolver and ingest status |
| `GET` | `/healthz` | Minimal liveness probe |

### Which build is a deployment running?

`GET /health` is the one endpoint that answers this, and it needs no
authentication:

```console
$ curl -s https://<your-instance>/health | jq .build
{
  "version": "v1.5.0-56-g92a13cc",
  "commit": "92a13cc4f0e1b2a3d5c7890fab12cd34ef567890",
  "sourceDigest": "11cb8d5651d972cc",
  "builtAt": "2026-09-25T06:11:02Z",
  "packageVersion": "1.5.0"
}
```

`packageVersion` is the release line, not the build — it only moves when a
release is cut, so two instances on different images share it. The other fields
identify the build:

- `version` and `commit` come from `git describe --tags --always --dirty` and
  `git rev-parse HEAD` at image build time, passed in as `--build-arg
  BUILD_VERSION` / `BUILD_COMMIT` (see the `Dockerfile`). A builder with no git
  metadata to pass reports `"unknown"` for both rather than guessing.
- `sourceDigest` is always present. The image build computes it from the files
  it ships, using `scripts/source-digest.mjs`. To turn a digest back into the
  commit it was built from:

  ```console
  $ scripts/find-build-commit.sh 11cb8d5651d972cc
  ```

The full build string is served unauthenticated on purpose: this project is open
source, so a commit identifier discloses nothing that is not already public, and
the people who need it — an operator checking a stack after a channel switch,
support asking what a customer is running, a probe asserting the expected build
— are the least likely to hold a token.

The OpenAPI document's `info.version` deliberately stays pinned to
`packageVersion`, so the docs badge keeps tracking releases.

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
| `POST` | `/api/v1/assets/:id/deliver` | Deliver the asset's source object to a registered export destination |
| `GET` | `/api/v1/assets/:id/delivery` | Get playback URLs (see [ADR-003](docs/architecture/ADR-003-delivery-and-stream-url-contract.md)) |
| `GET` | `/api/v1/assets/:id/stream/*` | Proxy-stream packaged HLS/DASH manifests and segments (see [ADR-003](docs/architecture/ADR-003-delivery-and-stream-url-contract.md)) |
| `PUT` | `/api/v1/assets/:id/metadata` | Replace free-form metadata |
| `GET` | `/api/v1/assets/:id/tracks` | List audio and subtitle tracks |
| `POST` | `/api/v1/assets/:id/audio-tracks` | Add an audio track |
| `DELETE` | `/api/v1/assets/:id/audio-tracks/:trackId` | Remove an audio track |
| `POST` | `/api/v1/assets/:id/subtitle-tracks` | Add a subtitle track |
| `DELETE` | `/api/v1/assets/:id/subtitle-tracks/:trackId` | Remove a subtitle track |
| `POST` | `/api/v1/assets/:id/tags` | Add a tag |
| `DELETE` | `/api/v1/assets/:id/tags/:tag` | Remove a tag |

Upload errors on the routes above return a machine-readable failure cause
alongside the HTTP status (body-size limit, network/connection error, storage
backend error, …) — see
[Upload failure causes](docs/guides/upload-failure-causes.md).

**Jobs**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/jobs` | List background jobs, newest first |
| `GET` | `/api/v1/jobs/:id` | Get a job |
| `DELETE` | `/api/v1/jobs/:id` | Cancel or delete a job |

The listing is ordered by creation time, newest first, and `limit`/`offset` cut
each page out of that one order — so page 2 is strictly older than page 1, and
walking the pages of an unchanging list visits every job exactly once. (As with
any offset paging, a job created while you are part-way through shifts the
window by one.) `total` is a count of matching jobs, counted up to 10,000: a
deployment holding more jobs than that reports `10000`, not the true number.

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

The single canonical search endpoint. It combines an exact-filter tier (`status`,
`tags`, `mimeType`, `metadata.<key>`, `tamsFlowId`, `tamsTimerange`, `from`/`to`)
with a free-text tier (`q`, over name and description) behind one contract; all
filters are ANDed and results are paginated (`page`/`pageSize`, returned as
`{ assets, total, page }`).

`mimeType` filters on the container format extracted from the media and takes
either a container token (`mp4`, `webm`) or a common media MIME type
(`video/mp4`), which is resolved onto the container family it names. A MIME type
that neither resolves to a container family nor names a content type this API
accepts on upload can never match anything, so it is rejected with `400
unsupported_mime_type` rather than returning an empty page.

`status` takes the same values and has the same exact-match semantics as
`GET /api/v1/assets?status=`, and is applied independently of `q` — the same
status answers the same asset set with or without a free-text term. It is
asset-only: supplying it excludes collection hits, since a collection has no
lifecycle status.

`from` and `to` bound the asset creation timestamp and are accepted by **both**
`GET /api/v1/search` and `GET /api/v1/assets`. Each takes either a calendar date
(`YYYY-MM-DD`) or a full ISO 8601 date-time, and **both bounds are inclusive**: a
bare `from` date means the first instant of that UTC day and a bare `to` date the
last, so `?from=2026-03-01&to=2026-03-01` returns everything created during
1 March. The range is applied to the whole result set before pagination, so it
narrows `total` and every page rather than only the page returned. A `from` later
than `to` is a `400`, not an empty page.

**Search results are always current — there is no reindex step.** Search is a
read-through projection over the stored documents, not a separately maintained
index: every request reads the assets and collections back and filters them, so
an edit is visible to the next search immediately. Rename an asset with
`PATCH /api/v1/assets/{id}` (or a collection with
`PATCH /api/v1/collections/{id}`) and the following `GET /api/v1/search` already
answers with the new name, while the old name stops matching. Nothing has to be
called in between, by a client or an operator, and nothing needs rebuilding after
a restart.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/search` | Full-text and metadata search (canonical) |

> **Deprecated:** `GET /api/v1/assets/search?q=<term>` is a legacy free-text-only
> alias that returns `{ items }`. It resolves the same assets as
> `GET /api/v1/search/?q=<term>` and is retained for backward compatibility; new
> integrations should use the canonical `/api/v1/search` endpoint above. The
> alias is marked `deprecated` in the OpenAPI spec and sends a `Deprecation`
> response header.

**Auto-scaler**

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/v1/scaler/status` | Current Encore instance pool status (reports the effective `maxInstances`, `jobsPerInstance` — concurrent jobs one instance can take — and `idleTimeoutMs`; each instance carries `draining: true` while it is being drained ahead of teardown). Returns `scalerActive: false` until a stack is provisioned; the auto-scaler activates against the provisioned stack's Valkey immediately after `POST /api/v1/provision` completes, with no restart. Each provisioned stack has its own Valkey, so the read fans out over all of them: every entry in `workspaces[]` carries the `connectionId` its `queueDepth`/`inflightDepth`/`instances` were read from, and `connections[]` lists every store the read covered. A pool that could not be queried is reported with `observed: false` and an `unobservedReason` — its state is unknown, not empty — rather than being left out of the response. `connectionId` is a stable non-secret label; no connection string, host, port or credential is ever returned. |
| `GET` | `/api/v1/scaler/config` | Get the auto-scaler configuration in force in the serving process (the runtime value if a `PATCH` has been accepted since startup, otherwise the boot-time environment values) |
| `PATCH` | `/api/v1/scaler/config` | Update auto-scaler configuration (`maxInstances`, `minInstances`, `idleTimeoutMs`) at runtime; `idleTimeoutMs` must be at least `10000` ms. Written to the parameter store before it is applied — `501` if no parameter store is configured, `503` if the write fails, and in both cases nothing is applied. The stored value is reloaded at boot (#1078); `minInstances` is recorded and applied at the next boot, not to the already-running scaler. See [Runtime scaler config: where it lives, what wins](#runtime-scaler-config-where-it-lives-what-wins) |

#### Runtime scaler config: where it lives, what wins

`PATCH /api/v1/scaler/config` changes the auto-scaler's settings without a
restart. It is worth being precise about what that does and does not mean:

- **Where the value is stored.** Two places, in this order. The request is first
  written to the parameter store as one complete snapshot of all three fields,
  under a single deployment-wide key; only then is it applied to the serving
  process, where `maxInstances` / `idleTimeoutMs` are pushed into the running
  scaler loops. A `200 OK` therefore means the change is both *saved* and
  *applied*. If no parameter store is configured you get a `501` and nothing is
  applied; if the store rejects the write or cannot be reached you get a `503`
  and nothing is applied, so `GET /api/v1/scaler/config` still reports the
  previous values.
- **Precedence.** Three layers, in order: the most recent `PATCH` this process
  accepted, then the persisted snapshot loaded at boot, then the environment.
  Since #1078 boot reads the stored record first, so `ENCORE_MAX_INSTANCES`,
  `ENCORE_MIN_INSTANCES` and `ENCORE_IDLE_TIMEOUT_MS` are the values for a
  deployment that has never been configured through the API — or for a boot where
  the parameter store could not be read, which is logged as a warning naming the
  reason. `GET /api/v1/scaler/config` and
  `GET /api/v1/scaler/status` report whichever is in force, but do **not** say
  which of the two it came from, and neither reads the stored record — they
  report the live copy only.
- **Resetting to the environment default.** There is no reset endpoint and no
  sentinel value. `PATCH` the environment values back explicitly, which
  overwrites the stored snapshot. Since #1078 that is the only way back:
  restarting the process no longer undoes a `PATCH`, because boot reads the
  stored snapshot and serves it again (`source: "runtime"`). A field reports
  `source: "env"` again only on a process that booted with no usable stored
  record.
- **Restarts and replicas.** The stored snapshot survives a restart **and is read
  back at boot** (#1078): a restarted or redeployed process serves the persisted
  values, for the config endpoint and for the scaler loops it creates, with no
  need to re-send the `PATCH`. `GET /api/v1/scaler/config` reports a restored
  field as `source: "runtime"` (with no `updatedAt`, because the stored record
  carries no timestamp). If the store is unreachable at boot the process starts
  on its environment values and logs a warning with the reason. The applied value
  of a live `PATCH` is still local to one
  process: if you run more than one replica, a `PATCH` is applied by whichever
  one answered the request, not by all of them, even though all of them share
  the one stored record. For a change that must take effect everywhere after a
  restart, set the environment variable and redeploy.
- **`minInstances` is the exception.** It is validated, persisted, and echoed
  back, but it is **not** fanned out to the **already-running** scaler loops:
  they keep enforcing the floor they were created with. Since #1078 the persisted
  value *is* applied at the next boot, where it takes precedence over
  `ENCORE_MIN_INSTANCES`, so a `PATCH` to the floor takes effect on the loops
  after a restart rather than never.
- **Patching while the scaler is inactive.** While `GET /api/v1/scaler/status`
  reports `scalerActive: false` (no stack provisioned yet) a `PATCH` is accepted
  and reported back, but it is not carried into the scaler that activates later
  against a newly provisioned stack — that activation uses the environment
  values. Re-send the `PATCH` once the stack is up.

#### Auto-scaler warm floor (cost vs. reliability)

The auto-scaler keeps a per-workspace pool of Encore instances and scales it on
demand. `ENCORE_MIN_INSTANCES` sets the **warm floor** — the minimum number of
instances the scaler keeps running even when the pool is idle. It **defaults to
`0`** (scale to zero). The floor is set by that environment variable at boot and
changing it takes a restart: `PATCH /api/v1/scaler/config` accepts a
`minInstances`, persists it and echoes it back, but the running scaler keeps the
boot floor
(see [Runtime scaler config](#runtime-scaler-config-where-it-lives-what-wins)).

The default of `0` and any value `>= 1` behave differently, and the right choice
depends on whether you are optimising for idle cost or for responsiveness:

- **`ENCORE_MIN_INSTANCES=0` (default — scale to zero).** When a pool goes idle
  past `ENCORE_IDLE_TIMEOUT_MS`, the scaler tears down its last instance, so an
  idle workspace runs **no** Encore instances and reclaims the Encore compute
  spend entirely. The cost is **scale-up cold-start latency**: the first
  transcode submitted to a cold pool must wait for the scaler to create an Encore
  instance and for that instance to become ready before the job is dispatched
  (instance spawn takes on the order of 60–120 seconds). A scale-to-zero pool
  also has **no warm headroom** — every burst starts from an empty pool.

- **`ENCORE_MIN_INSTANCES >= 1` (warm floor — recommended for production).** The
  scaler pre-warms up to this many instances regardless of pending work and never
  scales the pool **below** the floor on idle teardown. The first job of a burst
  lands on an already-running instance instead of paying the cold-start wait, and
  the floor provides standing headroom for latency-sensitive or shared pools. The
  trade-off is **standing cost**: the floor instances keep consuming Encore
  compute while idle, so scale-to-zero savings no longer apply to that workspace.

**Recommendation.** For production and any latency-sensitive or shared pool, set
`ENCORE_MIN_INSTANCES` to at least `1` so the first request never eats a
cold-start spawn. Leave it at the `0` default for development, bursty batch
workloads, or cost-sensitive deployments where occasional first-job latency is
acceptable in exchange for zero idle spend. Tune `ENCORE_MAX_INSTANCES` (default
`3`) and `ENCORE_IDLE_TIMEOUT_MS` (default 5 minutes) alongside the floor to shape
the pool's upper bound and how aggressively it scales back down. Those two can
also be moved at runtime via `PATCH /api/v1/scaler/config`, with the in-memory /
lost-on-restart caveats above; set them in the environment for anything you need
to persist.

> **Warm floor vs. drain on scale-down.** The warm floor governs *how many*
> instances stay up when idle; it is independent of *how* an instance is removed
> when the pool does scale down. Whatever the floor, scale-down only ever removes
> an instance once it reports **zero** active jobs, so raising the floor is a
> latency/headroom decision, not a fix for in-flight work — it does not change
> which instances are eligible for teardown, only the floor they stop at.

Two more things can hold a pool below where the queue says it should be, and both
are deliberate.

First, the hold-off after a failed spawn. After a spawn whose instance-create
timed out at the gateway (504), or failed with no answer at all (`fetch failed`),
scale-up for that workspace waits about two minutes
(`ENCORE_SPAWN_GATEWAY_BACKOFF_MS`, default `120000`; `0` disables it) so the
scaler does not start a second create against a platform that just told us it was
slow, and so the instance the timed-out create is probably still building has time
to appear and be adopted — adoption needing OSC to *confirm* that instance exists,
not merely to report it (`ENCORE_SPAWN_ADOPT_PROBE_TIMEOUT_MS` is the ceiling on
that watch: a confirmed absence ends it early, and a watch that ends with nothing
confirmed either way fails the spawn and leaves any instance under that name to
the orphan reaper rather than writing it off as absent). Each
*consecutive* failure doubles that wait, up to `ENCORE_SPAWN_BACKOFF_MAX_MS`
(default 30 minutes), and the first successful spawn resets it — so a platform
that is briefly slow costs one short pause, while one that has refused the same
create ten times running is left alone. `GET /api/v1/scaler/status` reports
`spawnFailure.httpCode` and `spawnFailure.consecutiveFailures` for exactly this
reason — a `504` with a climbing count means the pause is the back-off doing its
job, not a pool that has stopped growing for an unknown reason.

Second, the spawn cap. At most `ENCORE_MAX_CONCURRENT_SPAWNS` spawns (default
`1`) are *creating instances* at any moment across **all** workspaces this
deployment serves, because each one creates two ingresses through the cluster's
admission webhook and simultaneous bursts are what overload the platform. A
workspace that arrives second retries on its next tick, and keeps the rest of
that tick (scale-down, the orphan sweep, dispatch) meanwhile. The slot is held
only for the creates and released before the spawn waits for its instances to
report ready — so what the second workspace waits for is the first one's two
creates (seconds normally; a few minutes at worst, if those creates are
themselves timing out at the gateway and the adopt probe runs), **not** the up to
15 minutes of node provisioning a readiness wait can cover. In both cases the
scaler log says
which gate held the spawn and what it is waiting for — `spawn cap reached`,
`spawn hold-off active` or `adoption pending`, each with its numbers — so the
reason is readable in a pod tail without a log-aggregation query.

#### What the idle clock measures

An instance's idle age is measured from the last job it finished. An instance
that has never been given a job has no such timestamp, so its clock runs from the
moment it entered the pool ready for work — a spawned-but-never-dispatched
instance is torn down within `ENCORE_IDLE_TIMEOUT_MS` of becoming ready, exactly
like one that has gone idle after a transcode. If a pool record turns up without
a usable timestamp at all, the instance is treated as eligible for teardown
rather than kept: unknown age must not mean "run forever" for something that
bills by the hour. Eligible only means the instance is considered — it is still
checked against Encore's own in-flight job list and any pending packaging
handoff, and is drained rather than destroyed if either says it is still needed.

The scaler also sweeps, every few minutes, for Encore instances (and their paired
callback listeners) that are running on OSC with no pool record at all — the
residue of a spawn interrupted part-way through, a wiped Valkey, or a deleted
deployment. Nothing else can see those instances, since every other teardown path
works from the pool. Because a deployment's cleanup sweep sees every instance in
the OSC subscription, not just its own, four things must all hold before anything
is removed:

- the instance name proves it belongs to *this* deployment (each name carries a
  fingerprint of the deployment identity, so two deployments with similar names —
  `dev` and `dev-2`, say — can never reclaim each other's instances),
- no pool, on any workspace, is tracking it,
- it has been seen unaccounted-for across the whole grace window (20 minutes by
  default), so a spawn still waiting for its instance to become ready is never cut
  off mid-flight, and
- the instance itself confirms it has no queued or in-progress job and no pending
  packaging handoff. An instance that reports work, or that cannot be reached to
  answer, is never destroyed by the sweep: it is taken back into the pool and
  drained by the normal path instead.

Anything the sweep declines to remove is logged by name, so an instance that
cannot be reclaimed automatically is at least visible.

The fingerprint is derived from the deployment's workspace identity, which
assumes what the rest of the scaler already assumes: one workspace identity means
one deployment within a subscription. Two deployments configured with the same
workspace identity but pointing at different Valkeys would produce the same
fingerprint and each would treat the other's untracked instances as its own to
reclaim. Give each deployment its own workspace identity.

**Collections**

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/collections` | Create a collection |
| `GET` | `/api/v1/collections` | List collections |
| `GET` | `/api/v1/collections/:id` | Get a collection |
| `DELETE` | `/api/v1/collections/:id` | Delete a collection (confirm the member count to delete a non-empty one) |
| `PUT` | `/api/v1/collections/:id/assets/:assetId` | Add an asset to a collection |
| `DELETE` | `/api/v1/collections/:id/assets/:assetId` | Remove an asset from a collection |

Deleting a collection never deletes its member assets — it only unlinks them.
An empty collection deletes outright. A non-empty one is refused with `409`,
`error: "delete_blocked"`, `reason: "member_of_collection"`, and a `memberCount`
telling you how many assets are in it. Echo that number back to confirm:

```
DELETE /api/v1/collections/:id?confirmMemberCount=7   ->  204
```

The count must match the collection's *current* membership. If it changed in
between, you get the same `409 member_of_collection` carrying the new
authoritative `memberCount` rather than a silent delete — re-confirm with that
value and retry. `?force=true` is the blind alternative that skips the check.

A `409` with `reason: "delete_protected"` is a different condition: the
collection carries an explicit delete lock, it has no `memberCount`, and neither
`?confirmMemberCount=` nor `?force=true` gets past it. Clear the lock with
`DELETE /api/v1/collections/:id/lock` first. Branch on `reason`, not on the
status code.

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

Watch-folder ingest runs one poller per provisioned stack, each watching that
stack's own source bucket, so a file dropped into any stack's bucket is ingested
into that stack. `WATCH_FOLDER_ENABLED` and `WATCH_FOLDER_POLL_INTERVAL_SECONDS`
are deployment-wide; the bucket each poller watches comes from the stack's own
provisioning record, so a newly provisioned stack is picked up with no restart.
The three admin endpoints above report and control the default stack's poller
(the stack a request with no `X-Stack-Name` resolves to).

**Internal** (called by OSC services, not for direct client use)

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/internal/encore-callback` | Encore job callback |
| `POST` | `/api/v1/internal/packagerCallback/success` | Packager success callback |
| `POST` | `/api/v1/internal/packagerCallback/failure` | Packager failure callback |

## Architecture

Open Videocore runs as an OSC service and composes other OSC services at runtime:

| OSC Service | Role |
|---|---|
| `encore` | ABR transcoding. Instances are pooled and scaled on demand by the built-in Encore auto-scaler (spins up under load, tears down when idle) |
| `eyevinn-encore-callback-listener` | Bridges Encore callbacks onto the queue — one dedicated listener is paired with each Encore instance the auto-scaler starts |
| `eyevinn-encore-packager` | HLS/DASH packaging. Provisioned on demand on the first packaging execution (not at stack-provision time) and torn down on stack deprovision |
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

The ops UI is at `http://localhost:3000/ui` and the interactive API docs are at `http://localhost:3000/api-docs`. To regenerate `openapi.json` after adding routes, run `pnpm generate:openapi`.

The static, task-oriented docs site at `public/docs/` (served at `http://localhost:3000/ui/docs/`) is generated from `openapi.json` by `pnpm generate:docs` (see `scripts/generate-docs.ts`) — don't hand-edit files under `public/docs/`. A GitHub Actions workflow (`.github/workflows/update-openapi.yml`) runs both `generate:openapi` and `generate:docs` on every push to `main` and commits the results, so the reference section never drifts from the real contract.

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

[Eyevinn Technology](https://www.eyevinn.se) is an independent consultant firm specialized in video and streaming. Independent in a way that we are not commercially tied to any platform or technology vendor. As our way to innovate and push the industry forward we develop proof-of-concepts and tools. The things we learn and the code we write we share with the industry in [blogs](https://dev.to/video) and by open sourcing the code we have written.

Want to know more about Eyevinn and how it is to work here. Contact us at work@eyevinn.se!
