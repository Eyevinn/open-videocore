# Investigation #1221 — `archive` profile: large single output fails to upload with an S3 connection-pool-acquire timeout

**Type:** fix ticket that resolves to "no lever inside this repository" (no product code changed).
**Branch:** `issue-1221/large-output-upload-pool-timeout`
**Contract introspection:** LIVE, 2026-10-15, re-fetched for this pass (not reused from
the 2026-08-19 snapshot in `docs/investigations/291-encore-s3-sdk-tunables.md` and
not reused from the earlier pass on `issue-1221/archive-upload-pool-timeout`).
**Related closed issues:** #277, #291, #292, #293, #294, #295, #991.

## Symptom (from the report)

`archive` profile (DNxHD 185x, one large MXF; 3.4 GiB output on the 2026-10-14 run),
740 MB 4K source. The encode succeeds (~41 s), then the upload of the output to the
stack object store fails on **every** attempt, ~10 s after the upload starts:

```
software.amazon.awssdk.core.exception.SdkClientException: Unable to execute HTTP request:
Acquire operation took longer than the configured maximum time. This indicates that a
request cannot get a connection from the pool within the specified maximum time. This can
be due to high request rate.
...
12:55:59  Acquire operation took longer than 10000 milliseconds
```

3 of 3 attempts fail identically; the job settles FAILED with 0 objects in the bucket.
The `program` profile on the same source and the same stack uploads in ~1 s.

Two structural facts follow from the evidence and bound where the fault can be:

1. **10 000 ms is the AWS SDK's own default `connectionAcquisitionTimeout`**, and the
   failure is the SDK's *pool lease* step, not a socket read, not a connection reset, and
   not an HTTP status. So the exhausted/contended resource is the connection pool of the
   S3 async client **constructed inside the transcoder container**.
2. **It is size-correlated and deterministic**, not transient: identical message on 3 of
   3 attempts for a multi-GB single output, while a multi-output profile whose objects are
   small succeeds on the same endpoint, same stack, same pod class. The data path contains
   no platform ingress any more (#991 hands each spawned transcoder the probed in-cluster
   Service address — `src/services/internal-minio-endpoint.ts` via
   `mapEndpointForTranscoder` in `src/services/encore-s3-config.ts`), so the #294
   ingress-idle-timeout hypothesis cannot explain this one: the ingress is gone and the
   acquire timeout still fires.

The levers that would close it are therefore the S3 client's `maxConcurrency` (pool size),
its `connectionAcquisitionTimeout`, or the multipart part-size / upload-concurrency used
for one very large PUT. All three live in the transcoder container's own client
construction.

## Contract enumeration — what this repository can actually set (LIVE 2026-10-15)

### 1. Transcoder instance configuration — OSC service catalogue

**Source:** `GET https://catalog.svc.prod.osaas.io/mysubscriptions`, header
`x-pat-jwt: Bearer <PAT>` — i.e. byte-for-byte the request the platform SDK makes in
`getService(context, serviceId)`, `node_modules/@osaas/client-core/lib/core.js:8-22`
(`@osaas/client-core` 0.24.0). This is authoritative for what
`createInstance(context, 'encore', sat, body)` accepts, because the scaler's spawn body is
validated against this entry.

Verbatim response for `serviceId: "encore"`:

```json
"availableServiceInstanceOptions": [
  "name", "profilesUrl", "s3AccessKeyId", "s3SecretAccessKey",
  "s3SessionToken", "s3Region", "s3Endpoint"
]
```

The typed `serviceInstanceOptions` array on the same entry carries exactly those seven
names and nothing else (`name` mandatory, `regexValidator: ^\w+$`; the three credential
fields `sensitive: true`; `s3Region` described as "AWS region used for S3 access… Read
from AWS_REGION by Encore").

| Candidate lever                          | Exposed? | Evidence |
|------------------------------------------|----------|----------|
| S3 client pool size / max-connections    | **No**   | absent from the verbatim option list above |
| S3 connection-acquire timeout            | **No**   | ditto |
| S3 socket / read / write timeout         | **No**   | ditto |
| Multipart part size, upload concurrency  | **No**   | ditto |
| S3 endpoint, credentials, region         | Yes      | the four `s3*` fields the scaler already sets |

`src/encore-scaler/instance-pool.ts:598-601` already sets `s3Endpoint`, `s3AccessKeyId`,
`s3SecretAccessKey`, `s3Region`, and `:607` sets `profilesUrl`. The only catalogue
option left unset is `s3SessionToken`, which is a credential, not a pool tunable. There is
nothing in this contract to add.

### 2. Transcoder job document — Encore job API

**Source:** `https://eyevinn.github.io/encore-api-docs/swagger-encore-0.2.11-3.yaml`,
fetched 2026-10-15 (HTTP 200, 33 115 bytes). `EncoreJobRequestBody` (schema at line 910)
declares exactly: `id`, `externalId`, `profile`, `profileParams`, `outputFolder`,
`baseName`, `createdDate`, `progressCallbackUri`, `priority`, `segmentLength`,
`audioEncodingMode`, `audioSegmentLength`, `segmentedEncodingInfo`, `message`, `progress`,
`speed`, `startedDate`, `completedDate`, `debugOverlay`, `logContext`, `seekTo`,
`duration`, `thumbnailTime`, `inputs`.

A case-insensitive search of the whole document for `part`, `multipart`, `concurren`,
`pool`, `acquire`, `upload`, `timeout`, `maxConnections` returns **zero** matches, and the
only paths are `/encoreJobs`, `/encoreJobs/search/findByStatus`, `/encoreJobs/{id}`,
`/encoreJobs/{jobId}/cancel`, `/queue`. There is no per-job and no administrative surface
that configures how an output is uploaded.

`src/pipeline/encore-client.ts` `toEncorePayload` already sends the writable subset this
API needs. `segmentLength` / `audioEncodingMode` are **encode** parallelism controls
("Transcode segments of specified length in seconds in parallell") and
`segmentedEncodingInfo` is readOnly; setting `segmentLength` in the hope that it reshapes
the upload would be a guess about an upload mechanism the contract does not describe
(CLAUDE.md rule 7) and would also change the delivered mezzanine master. Not done.

### 3. Object store instance configuration — OSC service catalogue

Same live fetch, `serviceId: "minio-minio"`:

```json
"availableServiceInstanceOptions": ["name", "RootUser", "RootPassword"]
```

No connection, keep-alive, idle or request-timeout option — and, per #991, this side is no
longer in the transcoder's data path via any ingress anyway.

### 4. Profile contract — what this repository *does* own

Since #1215 this API publishes the profile index the transcoder loads
(`src/services/profile-index-publisher.ts`, `profilesUrl` resolution at
`src/main.ts:1154-1196`), so the profile YAML is genuinely under our control. The profile
contract describes encode settings only (`encodes[].type/suffix/params/filters`, per the
verified upstream shape recorded in
`docs/architecture/encore-audioencode-loudnorm-contract.md`); it has no output-upload,
connection, or transfer section. A profile edit cannot set a pool size or an acquire
timeout, and re-shaping the `archive` profile so that it stops producing a single
multi-GB mezzanine object would change the deliverable rather than fix the defect.

## Determination

**No verified contract reachable from this repository exposes the S3 connection-pool size,
the connection-acquire timeout, or the multipart part-size/concurrency used by the
transcoder when it uploads an output.** The client that times out is built inside the
transcoder container from configuration the catalogue does not surface. Implementing
anything here would mean inventing an instance-config key that does not exist, which rule
7 forbids and which the #291/#292 line already settled once on older evidence.

Routed as external platform friction: the transcoding service needs either a
pool-size/acquire-timeout/part-size config option on its instance schema, or a platform
default sized for sustained multi-GB single-output uploads. Logged for the weekly
osc-feedback submission as
`incoming-1221-transcoder-s3-upload-pool-not-configurable.md`.

Two further notes for whoever picks this up when an option does exist:

- **The one-place change** is the spawn body in
  `src/encore-scaler/instance-pool.ts:597-608` (the `if (config.s3Config)` block), fed
  from `EncoreScalerConfig.s3Config` (`src/encore-scaler/types.ts`) and
  `resolveEncoreS3Config` (`src/services/encore-s3-config.ts`). Adding a verified
  pool/timeout option is a two-line addition there plus the config plumbing, nothing more.
- **Retry is the wrong remedy here and currently costs three full 4K encodes.**
  `src/encore-scaler/retry-policy.ts:139` classifies
  `'acquire operation took longer than the configured maximum time'` as `transport` and
  re-dispatches up to `MAX_ENCODE_ATTEMPTS = 3`. That classification is right in general —
  a pool-acquire timeout is plumbing, not media — but against a deterministic,
  size-correlated fault it cannot succeed. Narrowing it is **not** done in this pass: #295
  deliberately chose bounded transport retry as the agreed mitigation, and #292's open
  question from @alexbj75 (whether a mezzanine row may be recorded as fixed on the
  strength of a retry) is a decision for the issue owners, not something to change
  unilaterally inside a different ticket.
