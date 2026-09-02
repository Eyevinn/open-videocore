# Open Videocore — Terraform module

This module provisions an **Open Videocore** instance on
[Eyevinn Open Source Cloud](https://www.osaas.io) (OSC), together with the
parameter store it uses to track the backing services it stands up at runtime.

It is written for a media developer with **zero prior OSC knowledge**: follow the
steps in order and you will reach a running Open Videocore instance with a
provisioned media stack and seeded transcoding profiles.

## What Terraform provisions (and what it does NOT)

Terraform stands up only the **control plane**:

- An `eyevinn-app-config-svc` **parameter store** and the Valkey instance that
  backs it (see `paramstore.tf`).
- The **Open Videocore** instance itself (`osc_eyevinn_open_videocore.this`),
  wired to the parameter store.

Terraform does **NOT** provision the per-workspace media stack. **MinIO,
CouchDB, and the workspace Valkey are provisioned by Open Videocore itself at
runtime** when you call `POST /api/v1/provision` (step 4). **Encore, the
callback listener, and the packager come up lazily at runtime** — the Encore
auto-scaler spins up Encore instances (each with a paired callback listener) on
demand when the first transcode jobs arrive, and the packager is provisioned on
demand the first time a packaging job runs. None of these are Terraform
resources.

## Prerequisites

- **OSC Personal Access Token (PAT).** Create one at
  [app.osaas.io/settings](https://app.osaas.io/settings). Supplied as the
  `osc_pat` variable.
- **Terraform >= 1.6.0** or **OpenTofu >= 1.6.0** (`versions.tf`).
- **Provider install.** The module uses the `EyevinnOSC/osc` and
  `hashicorp/random` providers, declared in `versions.tf`. `terraform init`
  installs them from the registry — no manual download needed.
- **`PARAMETER_STORE_API_KEY` (obtained out-of-band).** The Open Videocore
  instance needs the `ConfigApiKey` of the `eyevinn-app-config-svc` parameter
  store. The OSC provider does not expose this key, so it must be retrieved
  manually and passed in as the `parameter_store_api_key` variable. See
  [`PARAMETER_STORE_API_KEY.md`](./PARAMETER_STORE_API_KEY.md) for the exact
  procedure.

## Required variables

Declared in [`variables.tf`](./variables.tf):

| Variable | Required | Sensitive | Default | Description |
|---|---|---|---|---|
| `osc_pat` | **Yes** | Yes | — | OSC Personal Access Token. |
| `open_videocore_name` | **Yes** | No | — | Name of the Open Videocore instance. Lowercase letters and numbers only. |
| `parameter_store_api_key` | **Yes** | Yes | — | `ConfigApiKey` of the `eyevinn-app-config-svc` instance. Obtained out-of-band; see [`PARAMETER_STORE_API_KEY.md`](./PARAMETER_STORE_API_KEY.md). |
| `osc_environment` | No | No | `prod` | OSC environment: `prod`, `stage`, or `dev`. |
| `paramstore_name` | No | No | `ovcconfig` | Name of the parameter store (app config) solution. Lowercase letters and numbers only. |
| `valkey_password` | No | Yes | `null` (auto-generate) | Password for the Valkey instance backing the parameter store. |

Provide values with `-var` flags, a `terraform.tfvars` file, or `TF_VAR_*`
environment variables. Keep the two sensitive values (`osc_pat`,
`parameter_store_api_key`) out of source control.

## Outputs

Declared in [`outputs.tf`](./outputs.tf):

| Output | Sensitive | Description |
|---|---|---|
| `open_videocore_instance_url` | No | Public URL of the deployed Open Videocore instance. Use this as `<your-instance>` in the runtime steps below. |
| `app_config_svc_instance_url` | No | Instance URL of the `eyevinn-app-config-svc` parameter store. |
| `app_config_svc_external_ip` | No | External IP of the parameter store instance. |
| `app_config_svc_external_port` | No | External port of the parameter store instance. |
| `app_config_svc_service_id` | No | Service ID of the parameter store instance. |
| `parameter_store_instance_name` | No | Value for `PARAMETER_STORE_INSTANCE_NAME` on the instance (the parameter store's name). |
| `parameter_store_api_key` | Yes | Value for `PARAMETER_STORE_API_KEY` (echoed from the input variable). |
| `valkey_instance_url` | No | Instance URL of the Valkey backing the parameter store. |
| `valkey_external_ip` | No | External IP of the backing Valkey. |
| `valkey_external_port` | No | External port of the backing Valkey. |
| `valkey_service_id` | No | Service ID of the backing Valkey. |

> `open_videocore_instance_url` is added together with the Open Videocore
> instance resource. If your checkout does not yet include it, `terraform output`
> will not list it — read the instance URL from the OSC console instead.

## Step 1 — Initialise

```bash
cd terraform
terraform init
```

Installs the `EyevinnOSC/osc` and `hashicorp/random` providers declared in
`versions.tf`.

## Step 2 — Plan

Review what will be created before applying:

```bash
terraform plan \
  -var 'osc_pat=<YOUR_OSC_PAT>' \
  -var 'open_videocore_name=ovctest' \
  -var 'parameter_store_api_key=<CONFIG_API_KEY>'
```

## Step 3 — Apply and read the instance URL

```bash
terraform apply \
  -var 'osc_pat=<YOUR_OSC_PAT>' \
  -var 'open_videocore_name=ovctest' \
  -var 'parameter_store_api_key=<CONFIG_API_KEY>'
```

Terraform provisions the parameter store and the Open Videocore instance. When
the apply completes, read the public URL of the deployed instance:

```bash
terraform output open_videocore_instance_url
```

This URL is referred to as `https://<your-instance>` in the runtime steps below.

The remaining steps run against the **deployed instance** over HTTP — they are
not Terraform operations. They mirror the root project
[`README.md`](../README.md) Quick start steps 4 and 5, the source of truth for
these calls.

## Step 4 — Provision a media stack (`POST /api/v1/provision`)

A single API call stands up the backing infrastructure for one workspace —
**MinIO, CouchDB, and Valkey**. Encore and the packager are **not** created
here: the Encore auto-scaler spins Encore instances up on demand when the first
transcode jobs arrive, and the packager is provisioned on demand the first time
a packaging job runs.

Provisioning is **asynchronous**: the call returns `202 Accepted` with an
`operationId` that you poll until it reaches `status: "done"`.

```bash
curl -X POST https://<your-instance>/api/v1/provision \
  -H "Content-Type: application/json" \
  -d '{"name": "mystack"}'
```

The `name` must be lowercase alphanumeric (`^[a-z0-9]+$`, 1–63 characters). The
`202` response body is:

```json
{ "operationId": "<uuid>", "name": "mystack", "status": "pending" }
```

Poll the operation until it is done:

```bash
curl https://<your-instance>/api/v1/provision/operations/<operationId>
```

When `status` is `"done"`, the operation's `result` carries the stack
coordinates (`name`, `minioEndpoint`, `couchdbUrl`, `redisUrl`).

By default the stack provisions its own MinIO instance and buckets — no storage
configuration is required. To point the source and/or packaged-output roles at
an existing S3-compatible bucket instead, pass the optional `sourceStorage` /
`packagedStorage` blocks; to opt into extra pipeline services, pass
`options.autoSubtitles` / `options.sceneDetect` (both default `false`). See the
[external-storage guide](../docs/guides/provisioning-external-storage.md) for
the full field list.

List, inspect, and tear down stacks:

```bash
# List provisioned stack names
curl https://<your-instance>/api/v1/provision

# Get one stack's stored coordinates
curl https://<your-instance>/api/v1/provision/mystack

# Deprovision (asynchronous — returns 202 with an operationId to poll)
curl -X DELETE https://<your-instance>/api/v1/provision/mystack
```

`GET /api/v1/provision/:name` returns `404` if the stack does not exist and
`501` if the parameter store is not configured. `DELETE` is asynchronous like
`POST`: poll `GET /api/v1/provision/operations/:operationId` for the teardown
result.

## Step 5 — Bootstrap transcoding profiles (`POST /api/v1/profiles/bootstrap`)

Seed the profile store from the default Encore profile index. This is
idempotent: it skips seeding when profiles already exist unless you pass
`?force=true` to re-seed.

```bash
curl -X POST https://<your-instance>/api/v1/profiles/bootstrap
```

The `200` response reports how many profiles were seeded:

```json
{ "seeded": 12, "skipped": false, "builtinSeeded": 3 }
```

Force a re-seed:

```bash
curl -X POST "https://<your-instance>/api/v1/profiles/bootstrap?force=true"
```

The ops dashboard is at `https://<your-instance>/ui`.

## Endpoint reference

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/v1/provision` | Provision a media stack (MinIO, CouchDB, Valkey). Returns `202` + `operationId`. |
| `GET` | `/api/v1/provision/:name` | Get a provisioned stack's stored coordinates. |
| `DELETE` | `/api/v1/provision/:name` | Deprovision a stack. Returns `202` + `operationId`. |
| `GET` | `/api/v1/provision/operations/:operationId` | Poll an async provision/deprovision operation. |
| `POST` | `/api/v1/profiles/bootstrap` | Seed transcoding profiles (`?force=true` to re-seed). |
