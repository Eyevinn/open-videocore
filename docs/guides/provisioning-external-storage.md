# Provisioning with external S3-compatible storage

By default, `POST /api/v1/provision` stands up a self-contained stack: a MinIO
instance is provisioned per stack and two buckets are created on it
(`openvideocore-source` for ingest and `openvideocore-packaged` for packaged
streaming output). This is the zero-config path — you supply nothing but a stack
`name` and the API owns the whole storage lifecycle.

Some deployments want the stack to read source media from, or write packaged
output to, a bucket they already run. For those cases the provision request
accepts two optional blocks, `sourceStorage` and `packagedStorage`, that point a
role at an operator-owned bucket instead of the per-stack MinIO default.

One limit to know up front, and it is a limit of **this route only**: a
`sourceStorage`/`packagedStorage` block on `POST /api/v1/provision` may only
redirect the **bucket name**. A block that also names an external S3 API host
via `endpointUrl` is refused with a 400 — see Example 2 and issue #641.

Reading source media from an external S3 API host *is* supported today, through
a different route: register the host as a storage backend with
`POST /api/v1/storage/backends` and reference it per ingest with `sourceBackend`.
See [Reading from an external S3 API host today](#reading-from-an-external-s3-api-host-today)
below.

External storage is **additive**. If you omit both blocks you get exactly the
behaviour you get today — MinIO remains the zero-config default. If you supply
one block, only that role is redirected; the other role still uses MinIO. There
is no all-or-nothing coupling between the two roles.

## The request blocks

Both `sourceStorage` and `packagedStorage` accept the same shape. The schema is
defined by `externalStorageSchema` in `src/routes/provision.ts` (lines 47-54)
and wired into the provision request body at lines 64-67.

| Field | Required | Description |
|---|---|---|
| `bucket` | **Yes** | Name of the bucket to use for this role. |
| `accessKeyId` | **Yes** | Access key ID for the bucket. |
| `secretAccessKey` | **Yes** | Secret access key. Stored as an OSC secret, never in plaintext (see below). |
| `region` | No | Region of the bucket (e.g. `eu-north-1`). Omit for providers that ignore region. |
| `endpointUrl` | No | Full URL of the S3 API endpoint. Must be a valid URL — but **supplying it currently fails the provision request with 400** (issue #641): on this route only the bucket name can be redirected. Omit it to use the stack's own object-storage endpoint. See Example 2. (The same field on `POST /api/v1/storage/backends` *is* honoured — see below.) |
| `sessionToken` | No | Temporary session token for short-lived / assumed-role credentials. Stored as an OSC secret. |
| `publicBaseUrl` | No | Public HTTPS base URL under which objects in this bucket are served (CDN origin). Used for `packagedStorage` so player-facing manifests resolve to your delivery domain rather than the raw bucket endpoint. |

> Note: `publicBaseUrl` is introduced by issue #213. If your checkout predates
> that change the field is not yet accepted by the schema; the rest of this
> guide applies unchanged and `publicBaseUrl` becomes available once #213 lands.

Anything the schema does not list is rejected — the request body is validated,
so a typo'd field name fails fast rather than being silently ignored.

## Credentials are OSC secrets, never plaintext parameters

This is the load-bearing rule (ADR-002): `secretAccessKey` and `sessionToken`
are **secrets**. During provisioning each is registered as a per-service OSC
secret and referenced from the service configuration via a `{{secrets.<name>}}`
placeholder. The literal value never reaches a `createInstance` body, never
appears in a provision response, and — critically — is never written to the
parameter store.

Only the **non-secret coordinates** of an external bucket are persisted: the
`bucket` name, the `endpointUrl`, and the `region`. You can confirm this in
`src/routes/provision.ts`: the `storageBackendFor` helper (lines 309-320) copies
only `bucket`, `endpointUrl`, and `region` into the stored
`StorageBackendConfig`, and the block comment at lines 305-308 states explicitly
that `accessKeyId`/`secretAccessKey`/`sessionToken` are deliberately not read
into that object because they are secrets. As a result `GET /api/v1/provision/:name`
returns the bucket, endpoint, and region for each role but never a credential.

Practically: it is safe to inspect a provisioned stack's stored config and to
share it for debugging. It is never safe to expect a credential to be readable
back — like every OSC secret, these are write-once and are not echoed.

## Example 1 — redirecting a role's bucket name

Supply the bucket and its credentials and **omit** `endpointUrl`. The bucket
*name* is the part the pipeline honours: the source-reading services address
`s3://<your-bucket>/<key>` against the stack's own object-storage endpoint, which
is the only redirection this route can honour (see Example 2). The credentials
you supply are pre-registered at provision time as per-service OSC secrets so the
runtime paths can reference them — in `src/routes/provision.ts` the `sourceStorage`
branch calls `applyCredentialMapping` with `encoreCredentialMapping` and
`ffmpegS3CredentialMapping` for the two source-reading service ids — and `region`
is kept as a stored, non-secret coordinate.

```bash
curl -X POST https://<your-instance>/api/v1/provision \
  -H "Content-Type: application/json" \
  -d '{
    "name": "prodstack",
    "sourceStorage": {
      "bucket": "acme-media-ingest",
      "accessKeyId": "EXAMPLEKEYID1234567890",
      "secretAccessKey": "example-secret-key-DO-NOT-USE",
      "region": "eu-north-1"
    }
  }'
```

Here only the source role is redirected to `acme-media-ingest`; packaged output
still lands on the per-stack MinIO bucket because `packagedStorage` was omitted.
If that bucket only exists on an external S3 API host, this route is not the way
to reach it — see
[Reading from an external S3 API host today](#reading-from-an-external-s3-api-host-today).

## Example 2 — a generic S3-compatible provider (not supported on this route)

> **Not supported on `POST /api/v1/provision` — tracked by issue #641.** This
> route cannot point a stack role at an external S3 API host, and it will not
> pretend otherwise: the request below is **refused with 400**. This is a limit of
> the provision route, not of the API as a whole — ingest can already read from
> an external host via a registered storage backend, see
> [Reading from an external S3 API host today](#reading-from-an-external-s3-api-host-today).

A provision request may only redirect the **bucket name**. The bytes are still
read and written against the same object-storage endpoint and credentials the
stack already uses: the packager is configured with the stack's own endpoint and
credentials, and the transcode step forms bucket-only `s3://<bucket>/...` URIs
with no per-job endpoint or credential override. So a request that names a
different, non-default endpoint cannot be honoured, and rather than accept it
and silently write to the default endpoint, the route rejects it up front —
before any OSC instance is created — naming the offending field:

```bash
curl -X POST https://<your-instance>/api/v1/provision \
  -H "Content-Type: application/json" \
  -d '{
    "name": "prodstack",
    "packagedStorage": {
      "bucket": "acme-streaming-output",
      "accessKeyId": "OBJSTOREKEYEXAMPLE",
      "secretAccessKey": "objstore-secret-EXAMPLE-DO-NOT-USE",
      "region": "us-east-1",
      "endpointUrl": "https://s3.object-store.example.com",
      "publicBaseUrl": "https://cdn.example.com/vod"
    }
  }'
```

```json
400
{
  "error": "requested storage redirection cannot be honoured: packagedStorage.endpointUrl",
  "unsupported": [
    {
      "field": "packagedStorage.endpointUrl",
      "message": "packagedStorage.endpointUrl requests redirection to an external, non-default object-storage endpoint, which the transcode/packaging pipeline cannot honour yet (issue #641). Only the bucket name can be redirected; remove packagedStorage.endpointUrl to use the stack's object-storage endpoint, or omit the block for the zero-config default."
    }
  ]
}
```

The same rejection applies to `sourceStorage.endpointUrl`; the field name in the
error tells you which role was at fault.

To get a request the API accepts, drop `endpointUrl` and keep the bucket. The
role then uses your bucket name against the stack's own object-storage endpoint:

```bash
curl -X POST https://<your-instance>/api/v1/provision \
  -H "Content-Type: application/json" \
  -d '{
    "name": "prodstack",
    "packagedStorage": {
      "bucket": "acme-streaming-output",
      "accessKeyId": "OBJSTOREKEYEXAMPLE",
      "secretAccessKey": "objstore-secret-EXAMPLE-DO-NOT-USE",
      "region": "us-east-1",
      "publicBaseUrl": "https://cdn.example.com/vod"
    }
  }'
```

Omit the whole `packagedStorage` block instead if you are happy with the
zero-config default bucket. Note that `publicBaseUrl` is **not** affected by this
restriction: it only changes the host in emitted delivery and manifest URLs for
objects that have already been written to the honoured bucket, so it stays
usable (see the CDN section below).

Issue #641 is where external endpoint plus credential support *for the provision
route* is being tracked; this section will be rewritten when the route can honour
it. In the meantime, an external S3 API host is reachable through the storage
backend registry, below.

## Reading from an external S3 API host today

What `POST /api/v1/provision` cannot do, the storage backend registry can: it
accepts the external host's `endpointUrl` and keeps the credentials, and ingest
jobs then read the object **in place** on that host. Two steps.

First register the host as a backend. `POST /api/v1/storage/backends` requires
`name`, `bucket`, `accessKeyId`, and `secretAccessKey`, and accepts `role`
(`source`, `packaged`, `both` — the default — or `archive`), `region`,
`endpointUrl`, `sessionToken`, and `publicBaseUrl`:

```bash
curl -X POST https://<your-instance>/api/v1/storage/backends \
  -H "Content-Type: application/json" \
  -d '{
    "name": "acme-ingest",
    "role": "source",
    "bucket": "acme-media-ingest",
    "accessKeyId": "EXAMPLEKEYID1234567890",
    "secretAccessKey": "example-secret-key-DO-NOT-USE",
    "region": "us-east-1",
    "endpointUrl": "https://s3.object-store.example.com"
  }'
```

The 201 response echoes the backend's `id`, `bucket`, `endpointUrl`, and
`region`, with the credentials redacted (`secretAccessKey: "***redacted***"`) —
the same write-once rule as everywhere else in this guide.

Then reference it per ingest with `sourceBackend` on
`POST /api/v1/assets/ingest-url`, where `sourceUrl` addresses the object *within*
that backend. The backend must serve the `source` or `both` role, and no
credential is ever supplied inline — the registered endpoint and credentials are
reused server-side:

```bash
curl -X POST https://<your-instance>/api/v1/assets/ingest-url \
  -H "Content-Type: application/json" \
  -d '{
    "sourceUrl": "s3://acme-media-ingest/incoming/clip.mp4",
    "sourceBackend": "acme-ingest",
    "title": "Clip"
  }'
```

The probe and transcode jobs then read `s3://<bucket>/<key>` on the registered
endpoint, carrying the backend's endpoint and `{{secrets.<name>}}` credential
references in the job body rather than pulling the bytes into stack-managed
storage first.

Two things this does **not** change. It is a *source*-side path: packaged output
still lands on the bucket the stack was provisioned with, because the packager
gets a single fixed `S3EndpointUrl` and output relocation resolves a destination
to a bucket and key prefix only. And it does not make
`sourceStorage.endpointUrl`/`packagedStorage.endpointUrl` work on the provision
route — those are still refused with the 400 above.

## Serving packaged output from a CDN origin

Packaged streaming output (HLS/DASH manifests and segments) is written under a
bucket, but players should fetch it through a CDN rather than hitting the bucket
endpoint directly. That is what `publicBaseUrl` on `packagedStorage` is for:
point it at the public HTTPS base URL that fronts the packaged bucket — your CDN
distribution domain — and player-facing URLs are built against that origin
instead of the raw S3 endpoint.

The typical topology is: packager writes objects into the packaged bucket, the
CDN is configured with that bucket as its origin, and `publicBaseUrl` is the
CDN's public domain (for example `https://cdn.example.com/vod`). Set it to the
same path prefix under which the CDN exposes the bucket contents so the two line
up. Leave `publicBaseUrl` unset when you are serving packaged output directly
from the bucket with no CDN in front.

## Packaged output path and the trailing-slash rule

The packager is configured with an `OutputFolder` of the form
`s3://<bucket>/` — note the **required trailing slash**. The packager treats
`OutputFolder` as a directory prefix and joins each asset's output path onto it;
without the trailing slash the join produces a malformed key. For the MinIO
default this is handled automatically: `src/routes/provision.ts` (line 578)
strips any trailing slashes from the bucket name and re-appends exactly one, so
the packager always receives `s3://<bucket>/`.

If you are operating the packager against an external packaged bucket, apply the
same contract: the output folder must be `s3://<bucket>/` with a single trailing
slash. Give the bucket name only (no leading `s3://` and no path) in the
`packagedStorage.bucket` field — the `s3://` scheme and the trailing slash are
part of the packager's `OutputFolder` contract, not the bucket name itself.

## Summary

- MinIO is the zero-config default; external storage is purely additive and
  opt-in per role.
- Supply `sourceStorage` and/or `packagedStorage` to redirect a role to an
  operator-owned bucket.
- On `POST /api/v1/provision` only the bucket name can be redirected today.
  Leave `endpointUrl` out — supplying it is refused with 400 until issue #641
  lands, and omitting it means the role uses your bucket name on the stack's own
  object-storage endpoint.
- To ingest from a bucket on an external S3 API host, register it with
  `POST /api/v1/storage/backends` (which does accept `endpointUrl`) and pass
  `sourceBackend` on `POST /api/v1/assets/ingest-url`.
- Credentials (`secretAccessKey`, `sessionToken`) are stored as OSC secrets and
  never as plaintext parameters (ADR-002). Only `bucket`, `endpointUrl`, and
  `region` are persisted.
- Use `publicBaseUrl` on `packagedStorage` to serve packaged output through a
  CDN origin.
- The packager's `OutputFolder` must end in a single trailing slash
  (`s3://<bucket>/`).
