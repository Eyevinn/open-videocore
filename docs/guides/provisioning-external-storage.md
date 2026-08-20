# Provisioning with external S3-compatible storage

By default, `POST /api/v1/provision` stands up a self-contained stack: a MinIO
instance is provisioned per stack and two buckets are created on it
(`openvideocore-source` for ingest and `openvideocore-packaged` for packaged
streaming output). This is the zero-config path — you supply nothing but a stack
`name` and the API owns the whole storage lifecycle.

Some deployments want the stack to read source media from, or write packaged
output to, storage they already run: an AWS-region S3 bucket, or a generic
S3-compatible object store fronted by its own S3 API. For those cases the
provision request accepts two optional blocks, `sourceStorage` and
`packagedStorage`, that point a role at an operator-owned bucket instead of the
per-stack MinIO default.

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
| `endpointUrl` | No | Full URL of the S3 API endpoint. Omit for AWS-region buckets; set it for a generic S3-compatible provider. Must be a valid URL. |
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

## Example 1 — an AWS-region S3 bucket

For a bucket that lives in an AWS region, provide `region` and **omit**
`endpointUrl`. Without an explicit endpoint the standard AWS S3 endpoint for the
region is used.

```bash
curl -X POST https://<your-instance>/api/v1/provision \
  -H "Content-Type: application/json" \
  -d '{
    "name": "prodstack",
    "sourceStorage": {
      "bucket": "acme-media-ingest",
      "accessKeyId": "AKIAEXAMPLE1234567890",
      "secretAccessKey": "wJalrXUtnFEMI-EXAMPLE-KEY-DO-NOT-USE",
      "region": "eu-north-1"
    }
  }'
```

Here only the source role is redirected to `acme-media-ingest`; packaged output
still lands on the per-stack MinIO bucket because `packagedStorage` was omitted.

## Example 2 — a generic S3-compatible provider

For a cloud object store that presents an S3-compatible API on its own host,
set `endpointUrl` to that provider's S3 endpoint. `region` is usually still
accepted (some providers ignore it; supply whatever value the provider
documents, or omit it).

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

This redirects the packaged-output role to `acme-streaming-output` on the
external provider, while source ingest continues to use MinIO.

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
- Omit `endpointUrl` for an AWS-region bucket; set it for a generic
  S3-compatible provider.
- Credentials (`secretAccessKey`, `sessionToken`) are stored as OSC secrets and
  never as plaintext parameters (ADR-002). Only `bucket`, `endpointUrl`, and
  `region` are persisted.
- Use `publicBaseUrl` on `packagedStorage` to serve packaged output through a
  CDN origin.
- The packager's `OutputFolder` must end in a single trailing slash
  (`s3://<bucket>/`).
