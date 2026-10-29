# Provisioning with external S3-compatible storage

By default, `POST /api/v1/provision` stands up a self-contained stack: a MinIO
instance is provisioned per stack and two buckets are created on it
(`openvideocore-source` for ingest and `openvideocore-packaged` for packaged
streaming output). This is the zero-config path — you supply nothing but a stack
`name` and the API owns the whole storage lifecycle.

Some deployments want the stack to read source media from, or write packaged
output to, a bucket they already run. For those cases the provision request
accepts two optional blocks, `sourceStorage` and `packagedStorage`, that record
an operator-owned bucket's credentials and coordinates for a role.

Two limits to know up front, both of them limits of **this route**:

- A block that names an external S3 API host via `endpointUrl` is refused with a
  400 — see Example 2 and issue #641.
- The `bucket` name in a block is **not** applied to the bucket the pipeline
  reads and writes. `POST /api/v1/provision` persists the stack's own
  `openvideocore-source` / `openvideocore-packaged` as the pipeline's source and
  packaged buckets regardless; your `bucket` is kept as a non-secret coordinate
  for delivery-URL emission. See
  [What a storage block actually does](#what-a-storage-block-actually-does).

Reading source media from an external S3 API host *is* supported today, through
a different route: register the host as a storage backend with
`POST /api/v1/storage/backends` and reference it per ingest with `sourceBackend`.
See [Reading from an external S3 API host today](#reading-from-an-external-s3-api-host-today)
below.

External storage is **additive**. If you omit both blocks you get exactly the
behaviour you get today — MinIO remains the zero-config default. If you supply
one block, only that role records external coordinates; the other role carries
the plain MinIO default. There is no all-or-nothing coupling between the two
roles.

## The request blocks

Both `sourceStorage` and `packagedStorage` accept the same shape. The schema is
defined by `externalStorageSchema` in `src/routes/provision.ts` (lines 119-132)
and wired into the provision request body at lines 207-209.

| Field | Required | Description |
|---|---|---|
| `bucket` | **Yes** | Name of the operator-owned bucket for this role. Persisted as a non-secret coordinate and used when delivery URLs are emitted; it does **not** replace the bucket the transcode/packaging pipeline reads and writes — see [What a storage block actually does](#what-a-storage-block-actually-does). |
| `accessKeyId` | **Yes** | Access key ID for the bucket. |
| `secretAccessKey` | **Yes** | Secret access key. Stored as an OSC secret, never in plaintext (see below). |
| `region` | No | Region of the bucket (e.g. `eu-north-1`). Omit for providers that ignore region. |
| `endpointUrl` | No | Full URL of the S3 API endpoint. Must be a valid URL — but **supplying it currently fails the provision request with 400** (issue #641): this route cannot point a stack role at an external S3 API host. Omit it; the stack's own object-storage endpoint is used. See Example 2. (The same field on `POST /api/v1/storage/backends` *is* honoured — see below.) |
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
`bucket` name, the `endpointUrl`, the `region`, and the `publicBaseUrl`. You can
confirm this in `src/routes/provision.ts`: the `storageBackendFor` helper (lines
922-937) copies only `bucket`, `endpointUrl`, `region`, and `publicBaseUrl` into
the stored `StorageBackendConfig`, and the block comment at lines 915-920 states
explicitly that `accessKeyId`/`secretAccessKey`/`sessionToken` are deliberately
not read into that object because they are secrets. As a result
`GET /api/v1/provision/:name` returns those coordinates for each role but never a
credential.

Practically: it is safe to inspect a provisioned stack's stored config and to
share it for debugging. It is never safe to expect a credential to be readable
back — like every OSC secret, these are write-once and are not echoed.

## What a storage block actually does

A storage block has two verifiable effects, and it is worth being precise about
both because neither is "the pipeline now uses your bucket".

1. **It pre-registers your credentials as per-service OSC secrets.** In
   `src/routes/provision.ts` the `sourceStorage` branch calls
   `applyCredentialMapping` with `encoreCredentialMapping` and
   `ffmpegS3CredentialMapping` for the two source-reading service ids
   (`src/routes/provision.ts:1670-1676`), so `secretAccessKey`/`sessionToken`
   land as `{{secrets.<name>}}` references the runtime paths can resolve. Note
   this is the `sourceStorage` branch only — a `packagedStorage` block's
   credentials are validated and stored as secrets but no packager credential
   mapping is applied on this route.
2. **It persists your bucket, region, endpoint and public origin as non-secret
   coordinates.** `storageBackendFor` (`src/routes/provision.ts:922-937`) builds
   a `StorageBackendConfig` with `backend: 'external'` plus `bucket`,
   `endpointUrl`, `region`, and `publicBaseUrl`. Those coordinates are consumed
   when **delivery URLs are emitted**: `externalPublicBaseUrl`
   (`src/pipeline/packaging.ts:160`) prefers `publicBaseUrl` verbatim and
   otherwise derives `<endpointUrl>/<bucket>` path-style, and
   `src/routes/assets.ts:4751-4752` reads the per-role backend to build the URLs
   returned for an asset.

What a block does **not** do is move the bucket the pipeline reads and writes.
`POST /api/v1/provision` persists the stack's own fixed constants as the
pipeline's buckets — `SOURCE_BUCKET = 'openvideocore-source'` and
`PACKAGED_BUCKET = 'openvideocore-packaged'` (`src/routes/provision.ts:99-100`)
are written into `StackConfig.sourceBucket`/`packagedBucket` (lines 1772-1773),
and that is the binding the runtime resolves against (for example
`src/routes/provision.ts:2272`, `bucket: config.sourceBucket`). Your
`sourceStorage.bucket`/`packagedStorage.bucket` reaches `config.storage` only.
So treat these blocks as "record the coordinates and credentials of my bucket for
delivery-URL emission", not as "read and write my bucket".

## Example 1 — pre-registering an operator-owned bucket

Supply the bucket and its credentials and **omit** `endpointUrl`. The credentials
are pre-registered at provision time as per-service OSC secrets, and `bucket`,
`region` and (if given) `publicBaseUrl` are stored as non-secret coordinates for
delivery-URL emission. The transcode and packaging steps still read and write the
stack's own `openvideocore-source` / `openvideocore-packaged` buckets on the
stack's own object-storage endpoint.

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

Here only the source role records external coordinates; the packaged role carries
the plain MinIO default because `packagedStorage` was omitted. Neither role's
bytes move: the pipeline continues to read `openvideocore-source` and write
`openvideocore-packaged` on the stack's own endpoint. If you need jobs to
actually read `acme-media-ingest` — on this host or an external one — this route
is not the way to do it; see
[Reading from an external S3 API host today](#reading-from-an-external-s3-api-host-today).

## Example 2 — a generic S3-compatible provider (not supported on this route)

> **Not supported on `POST /api/v1/provision` — tracked by issue #641.** This
> route cannot point a stack role at an external S3 API host, and it will not
> pretend otherwise: the request below is **refused with 400**. This is a limit of
> the provision route, not of the API as a whole — ingest can already read from
> an external host via a registered storage backend, see
> [Reading from an external S3 API host today](#reading-from-an-external-s3-api-host-today).

The bytes are read and written against the same object-storage endpoint and
credentials the stack already uses: the packager is configured with the stack's
own endpoint and credentials, and the transcode step forms bucket-only
`s3://<bucket>/...` URIs with no per-job endpoint or credential override
(`src/pipeline/transcode.ts:178`, and ADR-021 C1/C2). So a request that names a
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

One caveat on that error text, quoted verbatim above: "Only the bucket name can
be redirected" overstates what the route does. Dropping `endpointUrl` makes the
request succeed, but the bucket name is still not applied to the pipeline's
source/packaged buckets — see
[What a storage block actually does](#what-a-storage-block-actually-does).

To get a request the API accepts, drop `endpointUrl` and keep the bucket. The
role's coordinates are then stored and its credentials pre-registered, while the
pipeline keeps reading and writing the stack's own buckets on the stack's own
object-storage endpoint:

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
zero-config default. Note that `publicBaseUrl` is the one field in the block that
does change observable behaviour end to end: it only sets the host in emitted
delivery and manifest URLs for objects already written to the packaged bucket, so
it is unaffected by the endpoint restriction and stays usable (see the CDN section
below).

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

The **probe / metadata-extraction** job then reads `s3://<bucket>/<key>` on the
registered endpoint, carrying the backend's endpoint and `{{secrets.<name>}}`
credential references in the job body rather than pulling the bytes into
stack-managed storage first. That works because the ephemeral FFmpeg-based job
service takes endpoint, key and secret **in the job body at job time** (ADR-017
C3): `src/routes/assets.ts:3839-3851` builds an `ExternalProbeSource` whose
`s3EndpointUrl` comes from
`storageBackendRegistry.resolveSourceCredentials`
(`src/services/storage-backend-registry.ts:901`).

What this delivers end to end today is therefore: **register the backend →
`POST /api/v1/assets/ingest-url` with `sourceBackend` → probe/metadata extraction
reads the object in place on your host.** The ingested asset's technical metadata
comes back from the external object without a copy.

Three things this does **not** change.

- **The transcode job is not redirected to the registered host.** `submitTranscode`
  composes `inputUri = s3://${params.sourceBucket}/${params.sourceObjectKey}`
  (`src/pipeline/transcode.ts:178`) and the submit call
  (`deps.encore.submit({ externalId, inputUri, outputUri, profile, ... })`,
  `src/pipeline/transcode.ts:217`) carries **no** endpoint or credential field.
  The transcoder instance holds a single S3 endpoint and credential set for the
  whole instance, with no per-role or per-URI override — see
  ADR-021-external-s3-endpoint-source-and-packaged.md, constraints C1 and C2. So
  a bucket-only URI resolves against the stack's own object-storage endpoint, not
  your registered host. Do not read the registered-backend path as "the whole
  transcode/package pipeline now reads from my host".
- **It is a *source*-side path.** Packaged output still lands on the bucket the
  stack was provisioned with, because the packager gets a single fixed
  `S3EndpointUrl` and output relocation resolves a destination to a bucket and key
  prefix only.
- **It does not fix the provision route.**
  `sourceStorage.endpointUrl`/`packagedStorage.endpointUrl` are still refused with
  the 400 above.

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
default this is handled automatically: `packagerOutputFolder`
(`src/services/external-storage-credentials.ts:74-80`) strips any `s3://` scheme
and any leading/trailing slashes from the bucket name and re-appends exactly one,
so the packager always receives `s3://<bucket>/`.

If you are operating the packager against an external packaged bucket, apply the
same contract: the output folder must be `s3://<bucket>/` with a single trailing
slash. Give the bucket name only — no leading `s3://` and no path — in whichever
`bucket` field you are filling in; the `s3://` scheme and the trailing slash are
part of the packager's `OutputFolder` contract, not the bucket name itself, and
`packagerOutputFolder` adds them for you. (On the packaged side that normalisation
is reached through the storage backend registry,
`src/services/storage-backend-registry.ts:263`, not through
`POST /api/v1/provision`.)

## Summary

- MinIO is the zero-config default; external storage is purely additive and
  opt-in per role.
- Supply `sourceStorage` and/or `packagedStorage` to record an operator-owned
  bucket's credentials and coordinates for a role.
- On `POST /api/v1/provision`, a block pre-registers credentials as per-service
  OSC secrets and persists `bucket`/`region`/`endpointUrl`/`publicBaseUrl` as
  non-secret coordinates for delivery-URL emission. The bucket the pipeline
  reads and writes stays the stack's own (`openvideocore-source` /
  `openvideocore-packaged`). Leave `endpointUrl` out — supplying it is refused
  with 400 until issue #641 lands.
- To ingest from a bucket on an external S3 API host, register it with
  `POST /api/v1/storage/backends` (which does accept `endpointUrl`) and pass
  `sourceBackend` on `POST /api/v1/assets/ingest-url`. That gives you
  probe/metadata extraction in place on your host; the transcode submit carries
  no per-job endpoint or credential, so the transcode read is not redirected
  there (ADR-021 C1/C2).
- Credentials (`secretAccessKey`, `sessionToken`) are stored as OSC secrets and
  never as plaintext parameters (ADR-002). Only `bucket`, `endpointUrl`,
  `region`, and `publicBaseUrl` are persisted.
- Use `publicBaseUrl` on `packagedStorage` to serve packaged output through a
  CDN origin — it is the one field in the block that changes an emitted URL.
- The packager's `OutputFolder` must end in a single trailing slash
  (`s3://<bucket>/`).
