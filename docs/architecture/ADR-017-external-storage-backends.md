# ADR-017: External / multi-backend storage design (credential model + config scope)

**Status:** PROPOSED 2026-09-04
**Date:** 2026-09-04
**Author agent:** claude-opus-4-8 (surface-backend-api)
**Issue:** #546 (design work blocking the external-storage family under parent #524)

---

## Numbering note (read first)

Issue #546's title, and the downstream sibling issues in the #524 family
(#555, #556, #557, #558), textually reference **"ADR-007"** for external
storage. That label is **superseded** by this document's real number,
**ADR-017**, because `docs/architecture/ADR-007-pipeline-visualisation.md`
**already exists** and owns the ADR-007 slot.

Numbering was resolved contract-first by listing `docs/architecture/`:

- Existing ADRs run ADR-001, ADR-003, ADR-007–ADR-012, ADR-014–ADR-016
  (ADR-002 and ADR-013 slots are unused gaps; ADR-016 is the highest present).
- The next-free number above the highest existing ADR is **ADR-017**.

**Any downstream #524 sub-issue that says "ADR-007" for storage means THIS
document (ADR-017).** ADR-007 remains pipeline-visualisation and is not
touched. This note keeps the record honest instead of overwriting an existing
ADR.

---

## Context

Parent issue #524 wants open-videocore to support **externally-owned,
S3-compatible object storage** as a source (ingest) and/or output (packaged)
backend, in addition to the zero-config OSC-managed default. Several
sub-issues (registration API, ingest wiring, output wiring) depend on two
open design questions being settled first:

1. **How is a customer's external bucket access key + secret stored?**
2. **What is the configuration scope of a registered backend** — global to the
   deployment, per-collection, or per-asset?

The complication called out by #546 is that the existing credential model does
**not** cover this case. That model (referenced in code as "ADR-002", see the
Record-gap note below) is built for **OSC service instances**: each secret is
scoped to a **serviceId** and injected into that service's create/job body as a
`{{secrets.<name>}}` reference. An externally-owned bucket is **not** an OSC
service instance, so there is no serviceId that naturally owns its credential.

This ADR is **design-only**. It makes the credential-storage and config-scope
decisions and pins them to verified repo contracts, so each downstream #524
sub-issue can cite a concrete decision. It does **not** implement the
registration API, ingest wiring, or output wiring (those are separate
sub-issues, listed Out of scope).

### Record-gap note (ADR-002)

The credential model this ADR extends is cited in code as "ADR-002"
(`src/routes/provision.ts:56`, `src/routes/provision.ts:392`,
`src/routes/provision.ts:414`), but **no `ADR-002-*.md` file exists** in
`docs/architecture/`. This ADR therefore cites the **implemented code**, not
the absent ADR file, for every credential mechanism below. The gap is logged to
`docs/osc-feedback/incoming-adr007-external-storage.md` (agents repo).

---

## Verified contracts (cited before any decision)

Every mechanism this ADR relies on was read from the repo. `@osaas/client-core`
is **not vendored** in this checkout, so the OSC SDK surface is cited from the
**verified in-repo call sites** (the exact argument order used against the SDK),
not from the SDK's `.d.ts`. This limitation is logged to
`docs/osc-feedback/incoming-adr007-external-storage.md`.

### C1 — OSC secrets are per-**serviceId**, injected as `{{secrets.<name>}}`

`saveSecret(serviceId, secretName, value, osc)` scopes a secret to one
serviceId; the caller then embeds the reference `{{secrets.<secretName>}}` in
that service's create/job body. Verified:

- `secretRef` helper: `src/routes/provision.ts:585-593` — builds
  `secretName = \`${name}.${purpose}\``, calls
  `saveSecret(serviceId, secretName, value, osc)`, returns
  `` `{{secrets.${secretName}}}` ``.
- SDK import of `saveSecret`: `src/routes/provision.ts:6-13`.
- "Secrets are per-service: the same logical value … must be saved separately
  under each consuming serviceId." `src/routes/provision.ts:580-584`.

### C2 — Each storage-consuming service spells the credential fields differently

`src/services/external-storage-credentials.ts` is a pure mapping layer from one
external storage block onto each target service's own field names. Verified
per-service conventions (`src/services/external-storage-credentials.ts:20-27`):

- `encore` — `s3AccessKeyId`, `s3SecretAccessKey` (secret), `s3SessionToken`
  (secret), `s3Region`, `s3Endpoint`.
  Mapping: `encoreCredentialMapping`, lines 91-116.
- `eyevinn-encore-packager` — `AwsAccessKeyId`, `AwsSecretAccessKey` (secret),
  `AwsSessionToken` (secret), `AwsRegion`, `S3EndpointUrl`, `OutputFolder`
  (= `s3://<bucket>/`, trailing slash enforced by `packagerOutputFolder`,
  lines 75-81). Mapping: `packagerCredentialMapping`, lines 122-148.
- `eyevinn-ffmpeg-s3` — `awsAccessKeyId`, `awsSecretAccessKey` (secret),
  `awsSessionToken` (secret), `awsRegion`, `s3EndpointUrl`. **Per-job
  ephemeral.** Mapping: `ffmpegS3CredentialMapping`, lines 155-180.

The serviceIds: `src/services/external-storage-credentials.ts:186-190`.

The split of each block into non-secret `configFields` vs. `secrets[]` (each
`{ field, purpose, value }`) is the type contract at
`src/services/external-storage-credentials.ts:34-69`. The provision route
realises a mapping with `applyCredentialMapping`
(`src/routes/provision.ts:602-615`): non-secret fields go straight into the
body; every secret is saved via `secretRef` and only the `{{secrets.*}}`
reference is placed in the body.

### C3 — The ephemeral FFmpeg job service takes endpoint/key/secret in the **job body** at job time

The transient `eyevinn-ffmpeg-s3` service is created **per job** via `createJob`
(not at provision time), and its S3 credentials are passed **in the job body**:

- Thumbnail job body: `createJob(context, FFPROBE_SERVICE_ID, sat, { name,
  cmdLineArgs, awsAccessKeyId: s3AccessKey, awsSecretAccessKey: s3SecretKey,
  s3EndpointUrl: s3Endpoint })` — `src/pipeline/osc-thumbnail.ts:69-75`.
  The runner's credential surface: `OscJobApi.s3Endpoint / s3AccessKey /
  s3SecretKey / s3Bucket`, `src/pipeline/osc-thumbnail.ts:38-45`.
- Rewrap/export uses the identical shape and rationale:
  `src/pipeline/osc-rewrap.ts:16-18` (job body carries `awsAccessKeyId`,
  `awsSecretAccessKey`, `s3EndpointUrl`) and `src/pipeline/osc-rewrap.ts:47-55`.
- Output must be written as `s3://bucket/key` (native S3 write), not a presigned
  PUT URL, because ffmpeg's muxer cannot upload over HTTPS
  (`src/pipeline/osc-rewrap.ts:10-20`, `src/pipeline/osc-thumbnail.ts:47-55`).

Where those values come from today: the route factory is handed the workspace's
resolved MinIO credentials at request time
(`src/main.ts:475-491` thumbnail, `src/main.ts:502-515` rewrap), i.e. the
already-provisioned default backend's credentials — **not** an externally
registered backend's.

### C4 — The parameter store persists **only non-secret** storage coordinates; secrets are forbidden there

`StorageBackendConfig` carries `backend: 'minio' | 'external'`, `bucket`,
optional `endpointUrl`, `region`, `publicBaseUrl` — and **no** credential fields
(`src/services/param-store.ts:41-47`, doc comment 21-40). The stored per-stack
`StackConfig.storage` holds one such block per role (`source`, `packaged`)
(`src/services/param-store.ts:83-92`).

Credentials are actively **rejected** from the store: `assertNoCredentials`
throws if any of `accessKeyId`/`secretAccessKey`/`sessionToken` appears in a
storage block, and strips/rejects credential-bearing `endpointUrl`s
(`src/services/param-store.ts:165-204`). So the param store is the correct home
for the **non-secret** external-backend registration record, and is
categorically the **wrong** home for the access key + secret.

### C5 — Tenancy model: one stack per workspace; env overrides win globally

- Each workspace provisions its **own** OSC stack (MinIO/CouchDB/Encore/…) via
  `POST /api/v1/provision`; the resolver reads that workspace's stack config
  from the param store per request. `src/services/workspace-stack.ts:1-10`.
- Stored stack configs are namespaced per workspace so two tenants may reuse a
  stack name without collision: key
  `openvideocore/<workspaceId>/<name>`, `src/services/param-store.ts:127-133`;
  provision request name is a single lowercase-alphanumeric token
  `src/routes/provision.ts:82-88`.
- Env-var connection overrides (`COUCHDB_URL`, `MINIO_URL`, …), when set, apply
  to **all** workspaces (the deployment-global override path):
  `src/services/workspace-stack.ts:8-10`, and the resolver's env-wins branch
  around `src/services/workspace-stack.ts:237,403`.

**Interpretation vs. issue #546's "per ADR-003 one deployment is one tenant":**
ADR-003 does not contain that literal sentence — it refers to "multi-tenant
deployments" (`ADR-003:317`). The **implemented** model (C5) is that the tenant
boundary is the **workspace**, and one workspace maps to one provisioned stack
(its default). For a single-workspace deployment — the common OSC-catalog-service
case — "one deployment = one tenant = one stack" holds exactly. This ADR states
that honestly rather than quoting a sentence that is not in ADR-003, and scopes
the decision to the **workspace/stack** boundary that the code actually enforces.

---

## Decision

### D1 — Credential storage model: OSC per-service secrets, fanned out per consuming serviceId; only non-secret coordinates in the param store

An externally-owned bucket is not an OSC service instance (C1), so it has no
serviceId of its own. We therefore reuse the **existing, verified** credential
mechanism rather than inventing a new one:

1. **The access key + secret (and optional session token) are stored as OSC
   secrets via `saveSecret`, scoped to each consuming serviceId**, exactly as
   the provision flow already does for the operator's default-backend
   credentials (C1, C2). The registration flow (a downstream sub-issue) saves,
   for each service that will touch the external bucket, that service's secret
   under its serviceId and records only the resulting `{{secrets.<name>}}`
   references — never the literal value — into the create/job body.
   - Persistent consumers (`encore`, `eyevinn-encore-packager`) receive the
     secret at their existing provision-time create body via the C2 mappings.
   - The ephemeral consumer (`eyevinn-ffmpeg-s3`) receives credentials in the
     **job body at job time** (C3), because it is created per job. See D4.

2. **The secret name is role- and backend-qualified** so the source-role and
   packaged-role external secrets never collide under one serviceId. We follow
   the established `<stackName>.<purpose>` convention
   (`src/routes/provision.ts:590`) with `purpose` carrying the role
   (`.source.…` / `.packaged.…`) exactly as the mapping layer's `rolePurpose`
   already does (`src/services/external-storage-credentials.ts:88-113`).

3. **Only the non-secret registration record is persisted to the parameter
   store**, as a `StorageBackendConfig` with `backend: 'external'` (C4). The
   access key, secret, and session token are **never** written to the param
   store; `assertNoCredentials` (C4) is the defence-in-depth backstop that a
   registration handler must not defeat.

**Why not a new bespoke credential vault?** The platform gives us exactly one
secret primitive — the per-serviceId OSC secret (C1). Introducing a second
secret store would (a) duplicate the trust boundary, (b) diverge from the
already-shipped default-backend path, and (c) still have to fan the value out
to each service, since every service reads its own field names (C2). The cost of
the chosen model is the **fan-out** (the same external secret saved once per
consuming serviceId); that cost is inherent to OSC's per-serviceId secret scope
and is logged as friction in
`docs/osc-feedback/incoming-adr007-external-storage.md` (ask: a
workspace/tenant-scoped secret so one save can serve all services).

### D2 — Configuration scope: **per-workspace/per-stack (deployment-global within a workspace)** — NOT per-collection, NOT per-asset

A registered external backend is **global to the workspace's stack**, occupying
the same per-role slot the default MinIO backend occupies today
(`StackConfig.storage.{source,packaged}`, C4). It is **not** per-collection and
**not** per-asset.

Justification against the implemented tenancy model (C5):

- The tenant boundary the code enforces is the **workspace → one stack**
  (C5). Storage backends are already a **per-stack, per-role** property
  (`storage.source` / `storage.packaged`), chosen once at provision time. A
  registered external backend slots into that exact structure, so the scope
  decision is consistent with the shipped data model and requires no new scoping
  dimension.
- For the common single-workspace OSC-catalog deployment this is precisely "one
  deployment, one backend per role" — the plain reading of #546's intent.
- **Per-collection / per-asset are explicitly rejected** for this ADR:
  - There is no collection- or asset-scoped storage-backend field anywhere in
    the verified data model — storage is only ever resolved per-stack-per-role
    (C4, C5). Adding per-asset backend selection would require a new asset-level
    credential-resolution path and a new secret-scoping story that OSC does not
    provide (C1). That is out of proportion to #546 and is not requested by it.
  - Per-execution **destination** overrides are a **separate, already-decided**
    concern: ADR-011 pins that a per-execution packaged **destination** is
    instance/relocation-scoped because the packager's `OutputFolder` is
    instance-scoped and the queue envelope carries no output path
    (`ADR-011` "Verified constraint"). ADR-017 does not re-open that; a
    registered backend is the **standing** per-role backend, distinct from a
    one-off per-execution destination.

If a future requirement genuinely needs per-collection backends, it must be its
own ADR that first solves the OSC secret-scoping gap (C1) — it is deliberately
out of scope here.

### D3 — Default-unchanged guarantee: a fresh deployment still provisions and uses OSC-managed default object storage, no external account required

Registration of an external backend is **strictly additive and opt-in**. When no
external backend is registered for a role, behaviour is byte-identical to today:

- `POST /api/v1/provision` provisions a per-stack MinIO instance and creates the
  `openvideocore-source` / `openvideocore-packaged` buckets on it
  (`src/routes/provision.ts:52-53`, `src/routes/provision.ts:670-684`); the
  external storage blocks are `.optional()` in the request schema
  (`src/routes/provision.ts:88-91`).
- `StackConfig.storage` is **optional for back-compat**: a config written before
  external storage existed has no `storage`, in which case **both roles default
  to the per-stack MinIO backend** (`src/services/param-store.ts:83-92`,
  doc comment 26-32). ADR-017 preserves this: absence of a registered external
  backend ≡ default MinIO backend.
- Delivery on the default backend stays API-proxied through `/stream/*` with the
  private bucket unchanged (ADR-003). Nothing about registering an external
  backend for one role alters the default posture of the other role or of a
  deployment that registers nothing.

**Guarantee (normative):** the zero-config path requires **no** external S3
account, no external credentials, and no registration call. Registration only
ever adds a backend; it never becomes a precondition for provisioning or use.

### D4 — Roles: a registered backend may serve **ingest (source), output (packaged), or both**; it maps onto the existing per-service and job-time parameters

The data model already carries **two independent per-role slots**,
`storage.source` and `storage.packaged` (C4). A registered external backend is
declared for one or both roles, mapping onto the existing consumers:

- **Source (ingest) role** → the services that **read** the source object:
  - `encore` (transcode) reads the source; mapped via `encoreCredentialMapping`
    onto `s3AccessKeyId` / `s3SecretAccessKey` / `s3Endpoint` / …
    (`src/services/external-storage-credentials.ts:83-116`).
  - `eyevinn-ffmpeg-s3` (probe / thumbnail / rewrap) reads the source; mapped via
    `ffmpegS3CredentialMapping` onto `awsAccessKeyId` / `awsSecretAccessKey` /
    `s3EndpointUrl` (`src/services/external-storage-credentials.ts:150-180`),
    injected **into the job body at job time** (C3,
    `src/pipeline/osc-thumbnail.ts:69-75`, `src/pipeline/osc-rewrap.ts:16-18`).
    Concretely, the request-time factories that today receive the workspace's
    default MinIO credentials (`src/main.ts:475-491`, `src/main.ts:502-515`) are
    the exact seam a source-role external backend's credentials flow through
    (wiring is a downstream sub-issue, not implemented here).
- **Output (packaged) role** → the service that **writes** packaged output:
  - `eyevinn-encore-packager` writes packaged CMAF; mapped via
    `packagerCredentialMapping`, which additionally sets the instance-scoped
    `OutputFolder = s3://<bucket>/`
    (`src/services/external-storage-credentials.ts:118-148`).

**Both** is the two roles configured independently (they are independent slots in
`StackConfig.storage`, C4) — e.g. external source + default packaged, or vice
versa, or external for both. No new role concept is introduced; ADR-017 only
states that registration populates the **existing** per-role slots and reuses the
**existing** per-service field mappings (C2) and job-time parameters (C3).

**Constraint noted, not re-decided:** the packager's `OutputFolder` is
instance-scoped (ADR-011 verified constraint), so an output-role external backend
is bound at packager provision/registration time, not per job. A registered
output backend is the standing per-role destination; per-execution destination
overrides remain ADR-011's separate mechanism.

---

## Consequences

**Positive:**
- Reuses one already-shipped, verified credential primitive (per-serviceId OSC
  secret, C1) and one already-shipped non-secret registration record
  (`StorageBackendConfig`, C4). No new secret store, no new scoping dimension.
- The default zero-config deployment is provably unchanged (D3): external storage
  is additive and opt-in end to end.
- Downstream #524 sub-issues can now cite concrete decisions: D1 (credential
  storage), D2 (scope), D3 (default guarantee), D4 (roles + parameter mapping).

**Negative / trade-offs:**
- **Secret fan-out.** OSC secrets are per-serviceId (C1), so one external bucket
  credential is stored once **per consuming service** (`encore`,
  `eyevinn-encore-packager`, `eyevinn-ffmpeg-s3`). Rotating the external
  credential means re-saving it under each serviceId. Logged as friction with an
  ask for a workspace-scoped secret
  (`docs/osc-feedback/incoming-adr007-external-storage.md`).
- **Backend scope is coarse (per-stack-per-role).** No per-collection/per-asset
  backend selection (D2). If that is ever needed it is a new ADR that must first
  close the OSC secret-scoping gap.
- **Output backend is instance-bound** (ADR-011 constraint): changing the
  standing packaged backend is a registration/provision-time action, not a
  per-job one.

---

## Out of scope (per issue #546)

- Implementation of the registration API, ingest wiring, and output wiring
  (separate #524 sub-issues; this ADR is design-only).
- Storage tiering (tracked separately).

---

## References

- Issue #546 (this design task); parent #524; siblings #555–#558 (which reference
  "ADR-007" — see the Numbering note; they mean this ADR-017).
- ADR-003 — delivery/stream contract and the private-bucket + `/stream/*` proxy
  posture the default backend keeps (`ADR-003`, tenancy framing at `ADR-003:317`).
- ADR-011 — per-execution packaged-output **destination** mechanism and the
  packager `OutputFolder` instance-scoped constraint (distinct from a standing
  registered backend).
- Code (verified contracts):
  - `src/routes/provision.ts:6-13,56,82-91,392,414,580-615,670-684` — SDK
    `saveSecret` import, per-service secret helper, external storage request
    schema, `applyCredentialMapping`, default MinIO provisioning.
  - `src/services/external-storage-credentials.ts:20-27,34-69,75-190` —
    per-service field-name mappings and serviceIds.
  - `src/services/param-store.ts:21-47,83-92,127-133,165-204` —
    `StorageBackendConfig`, per-role stored storage, workspace-namespaced key,
    `assertNoCredentials` credential rejection.
  - `src/pipeline/osc-thumbnail.ts:38-45,69-75`,
    `src/pipeline/osc-rewrap.ts:10-20,47-55` — ephemeral ffmpeg-s3 job-time
    endpoint/key/secret parameters.
  - `src/main.ts:475-491,502-515` — request-time credential factories for the
    ephemeral job runners (the source-role wiring seam).
  - `src/services/workspace-stack.ts:1-10` — one-stack-per-workspace tenancy.
- OSC friction: `docs/osc-feedback/incoming-adr007-external-storage.md`
  (agents repo) — per-serviceId secret fan-out, absent SDK types, absent ADR-002
  file.
