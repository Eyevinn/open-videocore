# Investigation #1221 — `archive` profile: large single output fails to upload with an S3 connection-pool-acquire timeout

**Type:** Fix ticket that resolves to "no reachable lever exists" (no feature code).
**Branch:** `issue-1221/archive-upload-pool-timeout`
**Contract introspection date:** 2026-10-15
**Supersedes the dated evidence in:** `docs/investigations/291-encore-s3-sdk-tunables.md`
(2026-08-19), `docs/investigations/292-archive-write-pool-timeout.md`,
`docs/investigations/294-minio-ingress-longlived-connections.md`.
**Related closed issues:** #292, #277, #291, #293, #294, #295, #991.

## Reported symptom

With the `archive` profile (DNxHD 185x, MXF), a 740 MB 4K source **encodes
fine** and then the upload of the single large output to the stack object store
fails on **every** attempt, with no connection drop:

```
SdkClientException: Unable to execute HTTP request: Acquire operation took
longer than the configured maximum time. This indicates that a request cannot
get a connection from the pool within the specified maximum time.
(e.g. "Acquire operation took longer than 10000 milliseconds")
```

The job settles FAILED with 0 files in the bucket after 3 transport-class
attempts. The `program` profile on the same source uploads in ~1 s.

## What is new since #292 / #294, and what it rules out

Two facts in this report change the conclusion reached in August, and both of
them *narrow* the fault to the S3 client inside the transcoder container:

1. **The failing path no longer crosses the platform ingress.** #991 took the
   ingress out of the transcoder's object-store data path: the spawned
   transcoder is handed the in-cluster Service address
   (`http://<service>.minio-minio.svc.cluster.local:<port>`), resolved from the
   platform's own `getInternalEndpoint` contract and used only after a live
   liveness probe (`src/services/internal-minio-endpoint.ts`, wired through
   `src/services/encore-s3-config.ts` `mapEndpointForTranscoder`). This report
   reproduces the failure on that in-cluster endpoint. The #294 routing —
   "mitigation falls to the ingress side" — is therefore **refuted for the
   write path**: there is no ingress in the path any more and the pool-acquire
   timeout still fires.

2. **The failure is deterministic, not a transient blip.** 3 of 3 attempts, no
   connection drop, and an acquire timeout of 10 000 ms (the AWS SDK's default
   `connectionAcquisitionTimeout`, not the ~35 s observed on the pre-#991
   ingress path). The #295 bounded retry
   (`src/encore-scaler/retry-policy.ts`, `MAX_ENCODE_ATTEMPTS = 3`,
   `BACKOFF_MS = [15_000, 60_000]`) classifies this message as `transport` —
   correctly, by the `'acquire operation took longer than the configured
   maximum time'` signature at `retry-policy.ts:139` — and re-runs the encode
   twice more. Because the cause reproduces exactly, retry cannot fix it; it
   only multiplies the wasted 4K encode by three. The retry classification is
   still right (a pool-acquire timeout IS plumbing, not media), but retry is
   the wrong *remedy* for a deterministic plumbing fault.

So the fault is the connection-pool sizing / acquire timeout of the S3 client
**inside the transcoder container**, on a sustained multipart upload of one
large output. `program` succeeds because its outputs are small and each upload
completes before the pool is contended; `archive` produces one multi-GB object
whose concurrent part uploads cannot all lease a connection within 10 s.

## Contract enumeration — is there any lever this repo can reach? (LIVE, 2026-10-15)

Three contracts bound what this application can influence. All three were
fetched live today, not taken from the August snapshot.

### 1. Transcoder instance configuration — OSC service catalogue

**Source:** `GET https://catalog.svc.prod.osaas.io/mysubscriptions` with the
deployment's personal access token. This is the exact endpoint the platform SDK
resolves a service through — `getService(context, serviceId)`,
`node_modules/@osaas/client-core/lib/core.js:8-22` (package `@osaas/client-core`
0.24.0) — so it is the authoritative source for what
`createInstance(context, 'encore', sat, body)` accepts.

Verbatim, for `serviceId: "encore"`:

```json
"availableServiceInstanceOptions": [
  "name", "profilesUrl", "s3AccessKeyId", "s3SecretAccessKey",
  "s3SessionToken", "s3Region", "s3Endpoint"
]
```

and the typed `serviceInstanceOptions` for the same entry carry exactly those
seven names (`name` mandatory, `regexValidator: ^\w+$`; `s3Region` described as
"AWS region used for S3 access… Read from AWS_REGION by Encore"; the three
credential fields `sensitive: true`).

| Candidate tunable                    | Exposed? | Evidence |
|--------------------------------------|----------|----------|
| S3 client max-connections / pool size| **No**   | absent from `availableServiceInstanceOptions` |
| S3 client connection-acquire timeout | **No**   | ditto |
| S3 client socket/read/write timeout  | **No**   | ditto |
| Multipart part size / upload concurrency | **No** | ditto |
| S3 endpoint / credentials / region   | Yes      | the four `s3*` fields the scaler already sets |

The scaler sets `s3Endpoint`, `s3AccessKeyId`, `s3SecretAccessKey`, `s3Region`
(`src/encore-scaler/instance-pool.ts:613-618`) plus `profilesUrl`
(`:621-623`). The only option in the catalogue it does **not** set is
`s3SessionToken`, which is a credential field, not a pool tunable, and is
irrelevant here. There is nothing left to add.

### 2. Transcoder job document — Encore job API

**Source:** the `openApiUrl` published on the same catalogue entry,
`https://eyevinn.github.io/encore-api-docs/swagger-encore-0.2.11-3.yaml`,
fetched 2026-10-15. `EncoreJobRequestBody` (schema at line 910) accepts exactly:

`id` (readOnly), `externalId`, `profile`, `profileParams`, `outputFolder`,
`baseName`, `createdDate` (readOnly), `progressCallbackUri`, `priority`,
`segmentLength`, `audioEncodingMode`, `audioSegmentLength`,
`segmentedEncodingInfo` (readOnly), `message`/`progress`/`speed`/
`startedDate`/`completedDate` (readOnly), `debugOverlay`, `logContext`,
`seekTo`, `duration`, `thumbnailTime`, `inputs`.

No field configures the output upload: not the connection pool, not the acquire
timeout, not part size, not upload concurrency. `src/pipeline/encore-client.ts`
`toEncorePayload` already sends the writable subset this API needs
(`externalId`, `profile`, `profileParams`, `outputFolder`, `baseName`,
`inputs`, `progressCallbackUri`).

`segmentLength` / `audioEncodingMode` are **encode** parallelism controls
("Transcode segments of specified length in seconds in parallell"), not upload
controls, and `segmentedEncodingInfo` is readOnly. Setting `segmentLength` in
the hope that it reshapes the output upload would be a guess about an upload
mechanism the contract does not describe, which CLAUDE.md rule 7 forbids; it
would also change the delivered archive master. Not done here.

### 3. Object store instance configuration — OSC service catalogue

Verbatim, same fetch, for `serviceId: "minio-minio"`:

```json
"availableServiceInstanceOptions": ["name", "RootUser", "RootPassword"]
```

No connection, keep-alive, idle, or request-timeout option — unchanged from the
2026-08-19 finding in #294, and in any case not in the data path any more (see
"what is new", point 1).

## Determination

**There is no lever in this repository, and none exposed by any verified
contract, that sets the connection-pool size or the connection-acquire timeout
of the S3 client that uploads a transcode output.** That client is constructed
inside the transcoder container from configuration this application cannot
reach:

- the instance-create body accepts seven options, none of them pool or timeout
  related (live catalogue, above);
- the job document accepts no upload tunable (live OpenAPI, above);
- the object store exposes no timeout option (live catalogue, above);
- the ingress — the one remaining external explanation — is already out of the
  path for this failure (#991).

Fabricating a key such as `s3MaxConnections` or `s3AcquireTimeout` and passing
it to `createInstance` would be rejected as an unknown option and would violate
CLAUDE.md rule 7. #292 refused exactly that on the August evidence; the live
2026-10-15 evidence above does not change the answer.

This ticket therefore makes **no code change**, and the gap is logged upstream:

- `docs/osc-feedback/incoming-encore-s3-upload-connection-pool-not-configurable.md`
  (agent-team repo `eng-open-videocore-agents`) — asks for an instance-config
  option for the transcoder's S3 client pool size and acquire/socket timeouts,
  or a platform default sized for a sustained multi-GB single-output upload.

## What would close the acceptance criterion, once a lever exists

"Large single outputs should upload like small ones do" becomes testable the
moment the catalogue exposes a pool/acquire-timeout option for the transcoder
service. At that point the change is small and lands in one place: add the
option to the instance body in `src/encore-scaler/instance-pool.ts` next to the
existing `s3*` fields, resolved from the environment in `src/main.ts` like every
other scaler tunable, with the value cited from the catalogue entry. Until then
the only app-side behaviour available is the existing bounded retry, which this
report shows cannot succeed against a deterministic pool exhaustion.

## Cited sources

- `GET https://catalog.svc.prod.osaas.io/mysubscriptions`, 2026-10-15 —
  `encore` and `minio-minio` `availableServiceInstanceOptions` /
  `serviceInstanceOptions` (verbatim above). Endpoint identified from
  `getService`, `node_modules/@osaas/client-core/lib/core.js:8-22`
  (`@osaas/client-core` 0.24.0).
- `https://eyevinn.github.io/encore-api-docs/swagger-encore-0.2.11-3.yaml`,
  2026-10-15 — `EncoreJobRequestBody` property list (schema at line 910).
- `src/encore-scaler/instance-pool.ts:613-623` — the instance-create body the
  scaler sends (four `s3*` fields + `profilesUrl`).
- `src/pipeline/encore-client.ts` `toEncorePayload` — the job document this API
  submits.
- `src/services/internal-minio-endpoint.ts`,
  `src/services/encore-s3-config.ts` `mapEndpointForTranscoder` — the #991
  in-cluster endpoint hand-off that removed the ingress from this path.
- `src/encore-scaler/retry-policy.ts:122,133,139` — `MAX_ENCODE_ATTEMPTS`,
  `BACKOFF_MS`, and the `transport` signature that matches this message.
- Prior determinations, now superseded on their dated evidence:
  `docs/investigations/291-encore-s3-sdk-tunables.md`,
  `docs/investigations/292-archive-write-pool-timeout.md`,
  `docs/investigations/294-minio-ingress-longlived-connections.md`.
