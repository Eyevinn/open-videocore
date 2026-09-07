# ADR-018: Export destination vs. storage-backend registry relationship

**Status:** PROPOSED 2026-09-07
**Date:** 2026-09-07
**Author agent:** claude-opus-4-8 (surface-backend-api)
**Issue:** #571 (design spike, blocking the named-export-destination family under #531 / #524)

---

## Numbering & attachment note (read first)

This ADR **attaches to and extends** the external/multi-backend storage ADR
produced for issue #546. That ADR is titled **ADR-017: External / multi-backend
storage design (credential model + config scope)** and, at the time of writing,
lives on the in-review branch `issue-546/adr-007-external-storage`
(file `docs/architecture/ADR-017-external-storage-backends.md`); it has **not**
yet merged to `main`, so it is not present in this branch's working tree. It was
read directly from that branch (`git show
origin/issue-546/adr-007-external-storage:docs/architecture/ADR-017-external-storage-backends.md`)
to verify the contracts this decision depends on.

Numbering was resolved contract-first by listing `docs/architecture/`: the
present files are ADR-001, ADR-003, ADR-007–ADR-012, ADR-014–ADR-016 (ADR-016 is
the highest on this branch). ADR-017 is claimed by the unmerged #546 branch. The
next free number is therefore **ADR-018**. This is written as a **separate ADR**
rather than an in-file addendum to ADR-017 because ADR-017 does not exist on this
branch and CLAUDE.md forbids guessing/colliding on a filename that is not on
disk. When ADR-017 merges, this ADR stands as its downstream companion; the
downstream CRUD sub-issue should cite **both**.

> Note on the "#524 storage-backend ADR" referenced by issue #571: that ADR is
> **ADR-017** (the #546 work). Some #524-family issues textually say "ADR-007";
> per ADR-017's own numbering note, "ADR-007 for storage" means ADR-017.
> `ADR-007` remains pipeline-visualisation and is untouched.

---

## Context

Issue #531 asks for **named, reusable export/delivery destinations**. Its central
open question — restated by the #571 spike — is whether an "export destination"
is:

- **(Option 1)** a *role/view* over the **#524 storage-backend registry**
  (ADR-017): the same registration records and the same credential store, viewed
  in an output/delivery role; or
- **(Option 2)** a **distinct object** with its own storage, its own credential
  handling, and its own CRUD surface.

Every downstream decision (data model, CRUD surface, credential store,
reachability validation) depends on this answer. This spike settles it against
the **verified in-repo contracts** below and hands the CRUD sub-issue a concrete
data-model and credential source to cite.

There are **two pre-existing, distinct destination mechanisms** already in the
code, and the relationship must be justified against both:

1. A **standing, named, per-role backend** — ADR-017's registered
   `StorageBackendConfig` on `StackConfig.storage.{source,packaged}`.
2. A **one-off, per-execution destination override** — the ad-hoc
   `destinationBucket` string on a pipeline execution, relocated post-package by
   `src/pipeline/output-relocation.ts` (ADR-011). This is **not** a named,
   reusable, credential-bearing object; it is a validated path/URI on a single
   run.

---

## Verified contracts (cited before the decision)

Each path/symbol below was opened on this branch (or, for ADR-017, on the
`issue-546` branch) and verified to say what is claimed. Issue #571's
`src/routes/assets.ts:534` line reference is **stale**: line 534 is an unrelated
audio-track field. The real `destinationBucket` schema is elsewhere, cited as C2.

### C1 — Post-package relocation is the per-execution destination path (ADR-011)

`src/pipeline/output-relocation.ts` server-side-copies (S3 `copyObject`, no bytes
proxied) the packaged objects from the default staging bucket to a caller-supplied
override, then treats the override as canonical for that execution
(`src/pipeline/output-relocation.ts:1-17`, `relocatePackagedOutput` lines
136-153). It parses the override with `parseDestination`
(`src/pipeline/output-relocation.ts:57-80`) into `{ bucket, prefix }`. The module
takes **no credentials** — it uses one already-resolved MinIO/S3 client
(`RelocationClient`, lines 29-40); relocation happens **within** the workspace's
already-provisioned default client. ADR-011's verified constraint: the packager's
`OutputFolder` is instance-scoped and the queue envelope is only `{ jobId, url }`,
so a per-execution output path cannot be threaded through the packager — hence
post-package relocation (`src/pipeline/output-relocation.ts:3-10`; ADR-011
Context).

### C2 — The ad-hoc `destinationBucket` override is a validated string, not an object reference

`destinationBucketSchema` (`src/routes/assets.ts:756-781`, **not** line 534)
accepts either an `s3://bucket/prefix/` URI **or** a plain `bucket/prefix/` path,
rejects whitespace/control-chars/wildcards/`..`/non-`s3://` schemes, and
normalises exactly one trailing slash. It is consumed at the export/execution
request site (`src/routes/assets.ts:2966`,
`destinationBucket: destinationBucketSchema.optional()`) and persisted onto the
execution as `pipelineExecutionSchema.destinationBucket` (`src/routes/assets.ts:738-740`,
"Per-execution destination override actually used"). It carries **no name, no
reuse, no credentials** — it is a per-run coordinate string.

### C3 — ADR-017 already fixes the storage-backend record shape, scope, and credential store

From `docs/architecture/ADR-017-external-storage-backends.md` (issue-546 branch),
cross-checked against code on this branch:

- **Record:** the non-secret registration record is a `StorageBackendConfig`
  (`backend: 'minio' | 'external'`, `bucket`, optional `endpointUrl`, `region`,
  `publicBaseUrl`) — **no** credential fields
  (`src/services/param-store.ts:41-47`). It lives per-role on
  `StackConfig.storage.{source,packaged}` (`src/services/param-store.ts:83-92`).
- **Scope (ADR-017 D2):** a registered backend is **per-workspace/per-stack,
  per-role** — not per-collection, not per-asset.
- **Credentials (ADR-017 D1):** access key/secret/session token are stored as
  **OSC per-service secrets** via `saveSecret(serviceId, name, value, osc)` and
  fanned out per consuming serviceId (`secretRef`/`applyCredentialMapping`,
  `src/routes/provision.ts:585-615`); only **non-secret** coordinates go to the
  param store. The store **actively rejects** credentials via
  `assertNoCredentials` (`src/services/param-store.ts:165-203`).

### C4 — The credential-handling reuse path exists and is service-specific

`src/services/external-storage-credentials.ts` is the pure mapping layer from one
external storage block onto each consuming service's own field names —
`encoreCredentialMapping` (lines 91-116), `packagerCredentialMapping` (lines
122-148, writes packaged output; sets instance-scoped `OutputFolder =
s3://<bucket>/` via `packagerOutputFolder`, lines 75-81), `ffmpegS3CredentialMapping`
(lines 155-180, per-job ephemeral). ServiceIds at lines 186-190. The
`SecretToSave`/`ServiceCredentialMapping` types (lines 47-69) are exactly what
`applyCredentialMapping` (C3) consumes. **This is the credential path an export
destination reuses; no new credential store is introduced.**

### C5 — Registration-time reachability: prior art is a boot-time SELF-probe, not a store probe

The only reachability prior art is `src/services/profiles-reachability.ts`, a
**boot-time self-check** that HTTP-GETs the app's *own* derived profiles-index
URL to confirm Encore can reach it (`src/services/profiles-reachability.ts:1-45`).
There is **no** registration-time external-bucket reachability probe (e.g.
`headBucket`/`listBuckets`) anywhere in the storage path today: `src/routes/storage.ts`
only ever addresses the workspace's already-provisioned buckets and its
`isBucketExistsError` (`src/routes/storage.ts:302`) is a *create-time* existence
check on the local MinIO, not an external-store probe. ADR-017 did **not** mandate
registration-time reachability validation.

---

## Decision

### D1 — Option 1: an export destination is a ROLE/VIEW over the #524 (ADR-017) storage-backend registry, NOT a distinct object

A named export/delivery destination (#531) is a **registered storage backend
(ADR-017 `StorageBackendConfig`) referenced in an output role**. It **reuses the
same registration records and the same credential store**; it is **not** a
separate object with its own storage or its own secret vault.

Concretely:

- **Data model (for the CRUD sub-issue to cite):** an export destination is a
  `StorageBackendConfig` record (`src/services/param-store.ts:41-47`) — non-secret
  coordinates only (`backend`, `bucket`, optional `endpointUrl`, `region`,
  `publicBaseUrl`). A "named export destination" is that record plus a stable
  **name/id** used as the reference handle. It occupies (or is addressable
  alongside) the same per-role storage structure ADR-017 defined
  (`StackConfig.storage`, `src/services/param-store.ts:83-92`); the CRUD sub-issue
  MAY widen that from the two fixed `{source, packaged}` slots to a **named map**
  of output backends, but MUST NOT change the record shape or the credential rule.
- **Credential source (for the CRUD sub-issue to cite):** OSC per-service secrets
  via `saveSecret`, mapped by `src/services/external-storage-credentials.ts`
  (`packagerCredentialMapping` for the packaged/write role) and applied by
  `applyCredentialMapping` (`src/routes/provision.ts:602-615`). **No new
  credential store.** Non-secret coordinates go to the param store; the
  `assertNoCredentials` backstop (`src/services/param-store.ts:165-203`) stands.

### D2 — Justification against the two existing destination paths

- **Against the standing registered backend (ADR-017):** a named export
  destination and a registered output backend are *the same thing viewed in the
  output role*. Both are (a) named/reusable, (b) credential-bearing via the exact
  same OSC-secret mechanism, (c) non-secret-coordinate-persisted in the param
  store, (d) consumed by the packager write path via `packagerCredentialMapping`
  (C3, C4). Making export destinations a **distinct** object (Option 2) would
  duplicate the registration record, **duplicate the credential fan-out and its
  trust boundary** (C3/C4) — the very cost ADR-017 already flagged as friction —
  and diverge two code paths that resolve to the identical packager fields. Option
  1 avoids that duplication.
- **Against the per-execution `destinationBucket` override (ADR-011 / C1, C2):**
  this override is deliberately **left as-is** and is **out of Option 1's model**.
  It is an unnamed, non-reusable, credential-free path/URI relocated *within* the
  workspace's already-resolved client (C1). A named export destination is the
  **standing, reusable, possibly-external, credential-bearing** concept. The clean
  seam between them is: the per-execution `destinationBucket` may, in a downstream
  job-reference sub-issue, additionally **accept the name/id of a registered
  export destination** (resolving to that backend's bucket/prefix + credentials),
  while continuing to accept a raw `s3://…/` or `bucket/prefix/` string for the
  one-off case. That is a *reference-resolution* extension of the existing schema
  (C2), not a merge of the two data models. This ADR does **not** re-open ADR-011.

### D3 — Registration-time reachability validation is OPTIONAL and NOT required by this decision

Per C5 there is no external-store reachability prior art and ADR-017 did not
require one. A named export destination is therefore registrable **without** a
registration-time `headBucket`/`listBuckets` probe; validation stays at the
**shape** level (the same edge validation ADR-017/`StorageBackendConfig` already
imply, plus the `destinationBucketSchema`-style syntactic checks, C2). Rationale:
(a) it matches the shipped posture (registration persists non-secret coordinates;
failures surface at first use, mirroring how the per-execution relocation surfaces
copy failures at run time, C1); (b) a registration-time probe would need the OSC
per-service secret already saved and a client built against it — extra
moving parts not justified for a spike-unblocking decision. The CRUD sub-issue MAY
add an **opt-in** `POST …/verify`-style reachability check later; if it does, it
SHOULD follow the self-probe timeout/error-handling shape of
`src/services/profiles-reachability.ts` (C5) and MUST NOT block registration on it.

---

## Consequences

**Positive**

- The CRUD sub-issue cites **one** data model (`StorageBackendConfig`,
  `src/services/param-store.ts:41-47`) and **one** credential source (OSC
  per-service secrets via `src/services/external-storage-credentials.ts` +
  `applyCredentialMapping`) — both already shipped/verified. No new storage, no new
  secret vault.
- The per-execution `destinationBucket` path (ADR-011) and the named-destination
  path stay cleanly separated; the only linkage is optional *reference resolution*
  in a later job-reference sub-issue.
- Zero-config default (ADR-017 D3) is preserved: registering a named export
  destination is additive/opt-in.

**Negative / trade-offs**

- Inherits ADR-017's **secret fan-out** (one external credential saved per
  consuming serviceId) — for export destinations the primary consumer is the
  packager write role (`packagerCredentialMapping`). Already logged as OSC friction
  by ADR-017; no new friction introduced here.
- The `{source, packaged}` two-slot storage structure may need to widen to a named
  map to hold multiple output destinations; that is a data-model *extension* the
  CRUD sub-issue owns, constrained to keep the record shape and credential rule.

---

## Out of scope (per issue #571)

- No implementation. This spike unblocks the CRUD and job-reference sub-issues.
- The CRUD API surface, the named-map schema change, and job-reference resolution
  are separate #531 sub-issues.

---

## References

- Issue #571 (this spike); #531 (named export destinations); parent #524.
- **ADR-017** — External / multi-backend storage design (issue #546, branch
  `issue-546/adr-007-external-storage`): storage-backend record, per-stack/per-role
  scope, OSC-per-service-secret credential model. This ADR extends it.
- **ADR-011** — Per-execution packaged-output destination mechanism
  (`docs/architecture/ADR-011-per-execution-packaged-output-destination.md`): the
  post-package relocation path this decision keeps separate.
- Code (verified on this branch unless noted):
  - `src/pipeline/output-relocation.ts:1-17,29-40,57-80,136-153` — post-package
    relocation, `RelocationClient`, `parseDestination`, `relocatePackagedOutput`.
  - `src/routes/assets.ts:738-740,756-781,2966` — execution `destinationBucket`
    field, `destinationBucketSchema` (the real location; #571's `:534` is stale),
    request-site usage.
  - `src/services/param-store.ts:41-47,83-92,165-203` — `StorageBackendConfig`,
    per-role storage on `StackConfig`, `assertNoCredentials`.
  - `src/services/external-storage-credentials.ts:47-69,75-81,91-116,122-148,155-190`
    — credential mapping types, `packagerOutputFolder`, per-service mappings,
    serviceIds.
  - `src/routes/provision.ts:585-615` — `secretRef`, `applyCredentialMapping`
    (the OSC-secret credential reuse path).
  - `src/services/profiles-reachability.ts:1-45`,
    `src/routes/storage.ts:302` — the only reachability prior art (boot-time
    self-probe; create-time local existence check), justifying D3.
