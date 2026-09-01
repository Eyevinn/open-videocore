# Deploying open-videocore with Terraform

This module deploys an open-videocore instance on [Open Source Cloud](https://www.osaas.io)
(OSC), together with the parameter store it needs to track the media stacks it
provisions. After `terraform apply` you get a public URL; you then make two HTTP
calls against that URL to stand up a workspace stack and seed transcoding
profiles.

This guide assumes no prior knowledge of OSC or of open-videocore. Follow it
top to bottom.

> **What Terraform does and does not create.** Terraform provisions two things:
> the parameter store (a Valkey instance plus an `eyevinn-app-config-svc`
> instance) and the open-videocore instance itself. Terraform does **not**
> create the per-workspace media stack. MinIO, CouchDB, and the workspace Valkey
> are provisioned by open-videocore **at runtime** when you call
> `POST /api/v1/provision` (step 4). Encore instances, their callback listeners,
> and the packager come up **lazily at runtime** — the Encore auto-scaler spawns
> Encore on demand when the first transcode job arrives, and the packager is
> created on the first packaging job. None of these runtime services are managed
> by Terraform.

## Prerequisites

- **An OSC account and a Personal Access Token (PAT).** Create a PAT at
  [app.osaas.io/settings](https://app.osaas.io/settings). Keep it secret; it
  authenticates every OSC API call this module makes.
- **Terraform >= 1.6.0 or OpenTofu >= 1.6.0.** Pinned in
  [`versions.tf`](versions.tf).
- **The OSC Terraform provider.** This module pins
  `registry.terraform.io/EyevinnOSC/osc` version `0.5.0`
  ([`versions.tf`](versions.tf)). `terraform init` downloads it for you from the
  registry — no manual install step.
- **`curl`** (or any HTTP client) for the post-apply runtime steps.

### Required input variables

Declared in [`variables.tf`](variables.tf):

| Variable | Required | Default | Description |
|---|---|---|---|
| `osc_pat` | **Yes** | — | Your OSC Personal Access Token. Sensitive. |
| `open_videocore_name` | **Yes** | — | Name of the open-videocore instance. Lowercase letters and numbers only. |
| `parameter_store_api_key` | **Yes** | — | `ConfigApiKey` of the `eyevinn-app-config-svc` instance. Sensitive; obtained out-of-band — see below. |
| `osc_environment` | No | `prod` | OSC environment: `prod`, `stage`, or `dev`. |
| `paramstore_name` | No | `ovcconfig` | Name of the parameter store instance. Lowercase letters and numbers only. |
| `valkey_password` | No | `null` (auto-generated) | Password for the Valkey instance backing the parameter store. |

### About `parameter_store_api_key`

The open-videocore instance requires a `PARAMETER_STORE_API_KEY` — the
`ConfigApiKey` of the `eyevinn-app-config-svc` parameter store. The OSC Terraform
provider (`0.5.0`) does not expose this key on any resource attribute or data
source, so Terraform cannot derive it. You obtain it out-of-band and pass it in.

The full procedure — retrieving the key via the OSC MCP or console, and passing
it with `-var` or `TF_VAR_parameter_store_api_key` — is in
[`PARAMETER_STORE_API_KEY.md`](PARAMETER_STORE_API_KEY.md). Read that file before
your first apply.

## Quick start

### 1. Configure the provider and variables

Create a `terraform.tfvars` (do not commit it — it holds secrets) or supply the
variables on the command line. A minimal `terraform.tfvars`:

```hcl
osc_pat             = "<your-osc-pat>"
open_videocore_name = "ovctest"
# parameter_store_api_key is best passed out-of-band; see below.
```

Keep `parameter_store_api_key` out of committed files. Pass it at apply time:

```bash
export TF_VAR_osc_pat="<your-osc-pat>"
export TF_VAR_parameter_store_api_key="<config-api-key>"
```

### 2. Initialize

```bash
terraform init
```

This downloads the pinned OSC provider (`0.5.0`) and the `random` provider.

### 3. Plan and apply

```bash
terraform plan
terraform apply
```

`apply` provisions, in order: a random Valkey password, the OSC secrets, the
Valkey instance, and the `eyevinn-app-config-svc` parameter store, then the
open-videocore instance wired to that parameter store.

When apply finishes, read the instance URL from the outputs
([`outputs.tf`](outputs.tf)):

```bash
terraform output open_videocore_url
```

That URL — written as `https://<your-instance>` in the examples below — is the
base for every runtime call. The ops dashboard is at
`https://<your-instance>/ui`.

Other useful outputs:

| Output | Description |
|---|---|
| `open_videocore_url` | Public URL of the open-videocore instance. |
| `parameter_store_instance_name` | Name of the `eyevinn-app-config-svc` instance (equals `paramstore_name`). |
| `app_config_svc_instance_url` | Instance URL of the parameter store. |
| `valkey_instance_url` | Instance URL of the Valkey backing the parameter store. |

`terraform output` shows all outputs; sensitive ones require
`terraform output -raw <name>`.

### 4. Provision a media stack

The following steps run against the **deployed instance** — they are HTTP calls,
not Terraform. This is the point where open-videocore provisions the per-workspace
backing services (MinIO, CouchDB, and a workspace Valkey) at runtime. Encore and
the packager are **not** created here; the auto-scaler spins Encore up on demand
when the first transcode job arrives, and the packager comes up lazily on the
first packaging job.

The only required field is `name` (lowercase alphanumeric, up to 63 characters):

```bash
curl -X POST https://<your-instance>/api/v1/provision \
  -H "Content-Type: application/json" \
  -d '{"name": "mystack"}'
```

Provisioning is asynchronous. The call returns `202 Accepted` with an
`operationId`. Poll the operation until its `status` reaches `"done"`:

```bash
curl https://<your-instance>/api/v1/provision/operations/<operationId>
```

Inspect and manage stacks with the other provision routes:

```bash
# List provisioned stacks
curl https://<your-instance>/api/v1/provision

# Get one stack's stored coordinates
curl https://<your-instance>/api/v1/provision/mystack

# Tear a stack down (also removes any lazily-provisioned packager)
curl -X DELETE https://<your-instance>/api/v1/provision/mystack
```

Verified provision endpoints:

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/provision` | Provision a media stack. Body: `{ "name": string }` (required). Returns `202` with `operationId`. |
| `GET` | `/api/v1/provision` | List provisioned stack names. |
| `GET` | `/api/v1/provision/:name` | Get a provisioned stack's stored coordinates. |
| `DELETE` | `/api/v1/provision/:name` | Deprovision (tear down) a stack. Returns `202` with `operationId`. |
| `GET` | `/api/v1/provision/operations/:id` | Get the status/result of a provision or deprovision operation. |

The `POST /api/v1/provision` body also accepts optional `sourceStorage` /
`packagedStorage` blocks (to point at an existing S3-compatible bucket instead of
the per-stack MinIO default) and an optional `options` block. Omit them for the
zero-config MinIO default. See the repo's
[external-storage guide](../docs/guides/provisioning-external-storage.md) for
those fields.

### 5. Bootstrap transcoding profiles

Seed the profile store from the default Encore profile index. No request body is
required:

```bash
curl -X POST https://<your-instance>/api/v1/profiles/bootstrap
```

This is idempotent: it skips seeding when profiles already exist. Pass
`?force=true` to re-seed:

```bash
curl -X POST "https://<your-instance>/api/v1/profiles/bootstrap?force=true"
```

Verified endpoint:

| Method | Path | Description |
|---|---|---|
| `POST` | `/api/v1/profiles/bootstrap` | Seed profiles from the default Encore index. Optional query `?force=true` to re-seed. No request body. Returns `200`; `502` if the default index could not be fetched. |

You now have a working pipeline: a deployed instance, a provisioned stack, and
seeded profiles. From here, ingest and transcode assets via the API or the ops
UI at `https://<your-instance>/ui`.

## Tearing everything down

To remove the Terraform-managed resources (the open-videocore instance and the
parameter store):

```bash
terraform destroy
```

Deprovision any runtime media stacks **first** with
`DELETE /api/v1/provision/:name` (step 4) — those stacks and their lazily
provisioned Encore/packager instances are created by open-videocore at runtime
and are not tracked in Terraform state, so `terraform destroy` will not remove
them.
