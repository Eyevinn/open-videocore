# ADR-021: External (non-default) S3 endpoint + credentials for source and packaged storage — platform capability blocker

**Status:** PROPOSED 2026-09-08 — records a design + an OSC platform blocker; no runtime wiring shipped
**Date:** 2026-09-08
**Author agent:** claude-opus-4-8 (surface-backend-api)
**Issue:** #641 (feat: support external S3 endpoint + credentials for source and packaged storage). Parent: #635. Related: #640 (fail-loud accept-and-ignore guard), ADR-011, ADR-017.

---

## Context

Parent report #635 asks for an "external S3 bucket" S3-in / S3-out pipeline:
`sourceStorage` / `packagedStorage` should carry a **full external S3 target**
(endpoint, region, bucket, credential reference) so the transcode/packaging step
**reads input from and writes output to that external target**, with credentials
injected via OSC service secrets (never returned/logged).

The request schema **already accepts** the full target today
(`externalStorageSchema`, `src/routes/provision.ts:65-78`): `bucket`,
`accessKeyId`, `secretAccessKey`, `region`, `endpointUrl`, `sessionToken`,
`publicBaseUrl`. ADR-017 already decided the **credential model** (OSC
per-serviceId secrets fanned out per consuming service) and the **config scope**
(per-workspace/per-role), and a pure mapping layer already spells the external
endpoint + credentials into every consuming service's own field names
(`src/services/external-storage-credentials.ts`). ADR-017 was explicitly
**design-only** and deferred *ingest wiring and output wiring* to downstream
sub-issues (ADR-017 "Out of scope", D4 "wiring is a downstream sub-issue, not
implemented here"). **#641 is that wiring.**

This ADR introspects whether the OSC transcode + packaging **services** can
actually honour an arbitrary external endpoint for the source and/or packaged
role, before designing that wiring. The answer is: **not with the endpoint model
the services expose today.** This ADR pins that blocker with verified contracts,
so #641 is not "implemented" with bytes that silently never leave the internal
store.

---

## Verified contracts (cited before the decision)

### C1 — Encore instance carries a SINGLE S3 endpoint + credential set, per instance

The Encore auto-scaler configures each spawned Encore instance with exactly one
S3 endpoint + credential set, taken from `config.s3Config`:

- `src/encore-scaler/instance-pool.ts:164-168` — `instanceBody['s3Endpoint']`,
  `['s3AccessKeyId']`, `['s3SecretAccessKey']`, `['s3Region']` are set once from
  `config.s3Config`. There is **one** endpoint field on the instance; there is no
  per-role or per-URI endpoint.
- That `s3Config` is resolved **only** from the stack's own MinIO, never from an
  external `sourceStorage`: `src/services/workspace-stack.ts:226`
  (`s3Config: { endpoint: config.minioEndpoint, accessKey: 'admin', secretKey:
  minioPassword }`) and `src/main.ts:790` (the scaler `s3Config` is the MinIO
  endpoint + `MINIO_*` env creds).

### C2 — Transcode job URIs are bucket-only; input and output resolve against that single endpoint

`submitTranscode` builds `s3://<bucket>/<key>` URIs with **no** endpoint or
credential component:

- `src/pipeline/transcode.ts:93-94` —
  `inputUri = s3://${params.sourceBucket}/${params.sourceObjectKey}` and
  `outputUri = s3://${params.outputBucket}/...`.

Because the URI carries only a bucket + key, **both the source read and the
transcode-output write resolve against the one endpoint the instance was
configured with (C1)**. There is no place in the job document to point the
*source read* at endpoint-A and the *output write* at endpoint-B.

### C3 — The packager carries a SINGLE `S3EndpointUrl`, used for BOTH its input read and its output write

- The packager instance config sets one `S3EndpointUrl`, one `AwsAccessKeyId`,
  one `AwsSecretAccessKey`, and one `OutputFolder` at PROVISION time:
  `src/services/packager-provisioning.ts:94-104` (`buildPackagerCreateBody`
  currently hardcodes `S3EndpointUrl: coords.minioEndpoint`,
  `AwsAccessKeyId: 'admin'`). The `packagerCredentialMapping`
  (`src/services/external-storage-credentials.ts:122-148`) confirms the same
  field set (`S3EndpointUrl`, `Aws*`, `OutputFolder`).
- The packager's work item is `{ jobId, url }` where `url` is the **Encore job
  API URL** it fetches to locate the transcoded ABR output
  (`src/pipeline/packaging.ts:165-173`, contract verified from the packager's
  `redisListener.ts`, 2026-07-07). It **reads** those transcoded segments (which
  live on the internal MinIO) and **writes** CMAF to `OutputFolder` — both over
  the same single `S3EndpointUrl`. The queue envelope carries no per-job endpoint
  or output path.
- Instance-scoped output is independently confirmed by ADR-011's live
  `get-service-schema` introspection (2026-07-13): `OutputFolder` is the only
  output-base control and it is **not** per-job; the endpoint/credential fields
  (`S3EndpointUrl`, `Aws*`) are likewise instance-scoped. See ADR-011 "Verified
  constraint" and `docs/osc-feedback/incoming-per-job-packager-output.md`.

### C4 — The external target is already accepted and persisted (non-secret) + fanned out as secrets

- `externalStorageSchema` accepts the full external target
  (`src/routes/provision.ts:65-78`); the non-secret coordinates
  (`bucket`/`endpointUrl`/`region`/`publicBaseUrl`) are persisted into
  `StackConfig.storage.{source,packaged}`
  (`src/services/param-store.ts:41-47,89-92`), and the source credentials are
  saved as OSC secrets scoped to `encore` + `eyevinn-ffmpeg-s3`
  (`src/routes/provision.ts:920-934`). The mapping layer already produces the
  packager's external fields (`packagerCredentialMapping`).
- **What is missing is not acceptance or persistence — it is that no runtime path
  reads the external endpoint back and applies it to a service.** The scaler feeds
  Encore only the MinIO endpoint (C1); the packager create body hardcodes the
  MinIO endpoint + `admin` (C3).

---

## Decision

### D1 — #641 (real S3-in / S3-out against an external endpoint) is BLOCKED on an OSC platform capability; do NOT ship a wiring that cannot land bytes externally

The transcode and packaging services expose **one endpoint per instance**, used
for both the read and the write side of a job (C1, C2, C3). Honouring #635/#641
requires at least one of the following, none of which the services offer today:

1. **Per-URI (per-job) endpoint + credentials** on the Encore job document and on
   the packager work item, so a single instance can read the source from
   endpoint-A and write output to endpoint-B; **or**
2. **A distinct read-endpoint vs write-endpoint** on the instance config for both
   Encore and the packager.

Without (1) or (2):

- **Source-role external endpoint** cannot be honoured: the scaler configures the
  Encore instance with one endpoint (C1) and the job URI is endpoint-less (C2),
  so pointing the instance at an external source endpoint would also send the
  transcode *output* there and break the packager's subsequent read of that
  output from internal MinIO (C3).
- **Packaged-role external endpoint** cannot be honoured either: the packager
  uses its single `S3EndpointUrl` to READ the Encore output (internal MinIO) as
  well as to WRITE CMAF (C3). Pointing `S3EndpointUrl` at an external endpoint
  would break the read of the internal Encore output. There is no separate
  write-endpoint field.

Therefore **no honest wiring exists** that makes bytes land on an arbitrary
external endpoint within the current service contracts. Fabricating one (e.g.
setting the packager `S3EndpointUrl` to the external endpoint) would produce a
**broken pipeline that looks partially wired** — a worse outcome than the
current honest "not honoured".

**Classification: external / OSC platform gap.** Logged (with the newly-verified
single-endpoint read+write detail) to
`docs/osc-feedback/incoming-640-external-s3-endpoint-not-honourable.md` (agents
repo).

### D2 — Keep the accepted-but-not-honoured surface honest: the fail-loud guard is #640's job, not #641's

The request schema still **accepts** `endpointUrl` and persists it (C4), while no
runtime path honours it — the "looks like success" hazard #640 was filed to
close. #641 does **not** widen that surface (it adds no new accepted-but-ignored
field) and does **not** implement the fail-loud guard, because that guard is the
deliverable of **#640** (fail-loud validation naming the offending field). This
ADR records that the guard is the required companion so #641 landing "blocked"
does not leave the misrouting hazard unowned: **#640 must land the 400/structured
rejection for a block carrying `endpointUrl` until this ADR's platform capability
exists.** ADR-011's per-execution *destination relocation* (copy CMAF out of a
staging bucket after packaging) is a related but distinct mechanism and is **not**
a substitute for an external *source/packaged endpoint*.

### D3 — When the platform capability lands, the wiring seams are already in place

If/when the OSC services expose (1) per-job endpoints or (2) split read/write
endpoints, #641's wiring is small and its seams already exist:

- **Packaged role:** `ensurePackaging` (`src/main.ts:995-1108`) already loads the
  full `StackConfig` (`stackCfg`), which carries `storage.packaged`
  (endpoint/region/bucket). `buildPackagerCreateBody`
  (`src/services/packager-provisioning.ts:87-105`) is the single place to consume
  `packagerCredentialMapping` for the external endpoint + credentials — once the
  packager can read its input from one endpoint and write to another.
- **Source role:** the scaler `s3Config` resolution
  (`src/services/workspace-stack.ts:226`, `src/main.ts:790`) is the single place
  to feed Encore an external source endpoint — once Encore accepts a per-URI or
  split read/write endpoint so the transcode *output* still lands where the
  packager can read it.

This ADR deliberately implements **none** of the above, because each is inert (or
actively harmful) until the platform capability exists.

---

## Consequences

**Positive:**
- #641's blocker is pinned to verified service contracts (C1–C3) rather than
  assumed, so the issue is not falsely marked done.
- The credential model + persistence + mapping layer from ADR-017 are confirmed
  ready; only the platform-level endpoint capability is missing.
- The wiring seams (D3) are identified, so the follow-up is a small, well-scoped
  change once OSC ships per-job / split endpoints.

**Negative / trade-offs:**
- The external S3-in / S3-out use case remains unsupported; operators needing it
  must use the OSC-managed default store, or (for packaged output only) the
  ADR-011 per-execution relocation to a destination on the **same** endpoint.
- The request schema continues to accept `endpointUrl` without honouring it until
  #640's fail-loud guard lands (D2).

---

## Out of scope

- Implementing any runtime wiring of the external endpoint (D1: no honest wiring
  exists today).
- The fail-loud accept-and-ignore guard (owned by #640, D2).
- Per-execution packaged *destination* relocation on the same endpoint (owned by
  ADR-011).

---

## References

- Issue #641 (this feature); parent #635; #640 (fail-loud guard); ADR-011
  (per-execution destination, packager instance-scoped output constraint);
  ADR-017 (external-storage credential model + config scope, design-only).
- Code (verified contracts):
  - `src/encore-scaler/instance-pool.ts:164-168` — single per-instance Encore S3
    endpoint + credentials.
  - `src/services/workspace-stack.ts:226`, `src/main.ts:790` — scaler `s3Config`
    resolved from the stack MinIO only.
  - `src/pipeline/transcode.ts:93-94` — bucket-only, endpoint-less transcode
    URIs.
  - `src/services/packager-provisioning.ts:87-105` — single `S3EndpointUrl` +
    hardcoded `admin` in the packager create body.
  - `src/pipeline/packaging.ts:165-173` — packager work item `{ jobId, url }`;
    `url` is the Encore job API URL the packager reads output details from (read
    and write share the one `S3EndpointUrl`).
  - `src/routes/provision.ts:65-78,920-934` — external target accepted; source
    credentials fanned out as OSC secrets.
  - `src/services/external-storage-credentials.ts:122-148` —
    `packagerCredentialMapping` (the external packager field set, ready to
    consume).
  - `src/services/param-store.ts:41-47,89-92` — persisted non-secret
    `StorageBackendConfig` per role.
- OSC friction:
  `docs/osc-feedback/incoming-640-external-s3-endpoint-not-honourable.md` and
  `docs/osc-feedback/incoming-per-job-packager-output.md` (agents repo).
