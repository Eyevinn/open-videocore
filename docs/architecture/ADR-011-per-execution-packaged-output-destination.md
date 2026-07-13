# ADR-011: Per-execution packaged-output destination mechanism

**Status:** PROPOSED 2026-07-13
**Date:** 2026-07-13
**Author agent:** claude-opus-4-8
**Issue:** #206 (contract spike for #190)

---

## Context

Parent request #190 wants a per-execution `destinationBucket` override for
packaged (CMAF HLS/DASH) output, and assumed it would be "passed through to the
packager job payload." This spike introspected the live packager contract and
re-verified the queue envelope to determine whether that pass-through is even
possible, then evaluated three candidate mechanisms.

The assumption is **not backed by the packager contract**. The only output-base
control the `eyevinn-encore-packager` service exposes is set at PROVISION time
and is instance-scoped; the queue envelope the packager consumes carries no
output path. This ADR pins the mechanism a per-execution destination override
must use, given that constraint.

## Verified constraint

### Packager output configuration is instance-scoped (not per-job)

Source: OSC MCP `get-service-schema` for `eyevinn-encore-packager`, retrieved
2026-07-13.

- **`OutputFolder`** (string, REQUIRED) — "Base folder for packaging output...
  Can be a local path or an AWS S3 bucket." Set at PROVISION time, instance-
  scoped. **This is the only output-base control and it is NOT per-job.**
- **`OutputSubfolderTemplate`** (string, optional, default
  `$INPUTNAME$/$JOBID$`) — a subfolder *relative to* `OutputFolder`. The
  keywords `$INPUTNAME$`, `$JOBID$`, `$EXTERNALID$` are substituted per job.
  The template string itself is an instance-level config value, **not** a
  queue-envelope field. `$EXTERNALID$` is the only per-job-controllable token
  (it derives from the Encore job's `externalId`), and it can only vary the
  **subfolder beneath** `OutputFolder` — never the base bucket.
- **`AwsAccessKeyId` / `AwsSecretAccessKey` / `AwsRegion` / `AwsSessionToken` /
  `S3EndpointUrl`** — all instance-scoped S3 credentials/endpoint, set at
  provision time. A different destination bucket may require different
  credentials/endpoint, which are likewise fixed per instance.
- **`RedisUrl` + `RedisQueue`** (default `packaging-queue`) — the queue the
  packager consumes.
- **No field in the schema accepts a per-job output BASE folder or bucket.**

### The queue envelope carries no output path

Sources (this repo):

- `src/pipeline/packaging.ts` (`PackagingJob` type, lines 83-86; contract note
  lines 78-86) — the enqueued job is exactly `{ jobId: string, url: string }`.
  `jobId` is our correlation id (the asset id); `url` is the Encore job API URL
  the packager fetches output details from.
- `src/pipeline/osc-packager-queue.ts` (lines 9-16, 31-37) — the producer does
  `ZADD <key> <Date.now()> <json>` onto a Redis/Valkey **sorted set**; the
  packager consumes via `BZPOPMIN`. Message shape is `{ jobId, url }`.

The packager success callback (`PackagerSuccessPayload`,
`src/pipeline/packaging.ts` lines 106-116) returns `{ url, jobId, outputPath? }`
— it *reports* where it wrote, but does not accept a destination. Nothing in the
envelope or callback contradicts the schema above: there is no per-job output
base anywhere in the contract.

**Conclusion:** a per-execution destination cannot be expressed to the packager
through the current queue message. The output base is fixed at the instance's
`OutputFolder`, and per-job control stops at the `$EXTERNALID$`-driven subfolder
*inside* that base.

## Candidate approaches

### Approach 1 — OSC-native (per-job output path in the queue envelope)

The packager would read a per-job output base from the queue envelope (or a new
schema field bound per job).

- **Requires:** an OSC/upstream change to `eyevinn-encore-packager` — a new
  per-job output-base field on the consumed message, plus per-job S3
  credentials/endpoint if the destination is in a different account/endpoint.
- **Verdict:** **BLOCKED.** The verified schema (2026-07-13) exposes no such
  field, and the queue envelope is `{ jobId, url }` with no output slot. This is
  not implementable against today's contract. Logged as an OSC capability gap
  (see "OSC feedback").
- **Trade-off if it existed:** cleanest — one packager instance, no relocation,
  destination is authoritative at write time. It is the target end-state, but
  cannot be the v1 decision.

### Approach 2 — Instance-per-destination

open-videocore provisions/reuses one packager instance per allowed destination
bucket (each with its own `OutputFolder` = that bucket, plus that bucket's S3
credentials/endpoint), and routes the enqueue to the instance whose
`OutputFolder` matches the requested destination.

- **Feasibility:** instance lifecycle management is already an established
  pattern in this codebase — `src/encore-scaler/instance-pool.ts` provisions and
  reaps OSC instances via `@osaas/client-core` `createInstance` /
  `removeInstance` / `waitForInstanceReady`, keyed in a Valkey pool hash. A
  packager pool would mirror this.
- **Pros:** the packager writes directly to the final destination (no copy, no
  double storage); destination credentials/endpoint are honoured natively via
  each instance's provision-time `Aws*` / `S3EndpointUrl` fields.
- **Cons:**
  - Each distinct destination is a persistent running instance (cost + a warm
    startup/`wait-for-service-ready` on first use of a new destination), so this
    scales poorly with the *number* of destinations. It fits a small, mostly
    static allow-list; it does not fit many or ad-hoc destinations.
  - Operational complexity: a packager pool, its Valkey routing state, health,
    and reaping — a second scaler-like subsystem to own and monitor.
  - Each instance needs its own routing on the shared `RedisQueue`/`OutputFolder`
    pairing; a mis-route silently writes to the wrong bucket.
  - The default packaged bucket (`openvideocore-packaged`,
    `src/pipeline/packaging.ts` line 35) still needs its own instance, so
    "no destination override" is just the default instance.

### Approach 3 — Post-package relocation

The packager writes to the default packaged bucket (its provisioned
`OutputFolder`), then open-videocore copies/moves the CMAF output to the
requested destination after the success callback.

- **Feasibility:** the packaged store is `minio-minio`, an S3-compatible
  endpoint (ADR-001, storage row). A **server-side** `CopyObject` between two
  buckets on the *same* MinIO endpoint does not re-download bytes through
  open-videocore; MinIO streams the copy internally. The success callback already
  reports `outputPath` (`PackagerSuccessPayload.outputPath`,
  `src/pipeline/packaging.ts` line 115), giving the exact source prefix to
  relocate, and `handleSuccess` is already the hook where post-package work runs.
- **Pros:**
  - **One** packager instance regardless of destination count — no packager pool,
    no per-destination provisioning, far lower operational surface than (2).
  - Works for many/ad-hoc destinations, bounded only by the destination
    allow-list, not by running-instance count.
  - The default packaged bucket can stay **private**: it is an internal staging
    area, and only the relocated copy lands in the (possibly externally-shared)
    destination. This keeps the source/staging bucket private by construction.
  - No upstream OSC change required — implementable entirely on our side today.
- **Cons:**
  - A CMAF package is many objects (init segment, media segments, HLS + DASH
    manifests). The copy must enumerate and copy every object under the prefix,
    then verify, then delete the staging copies if a *move* (not copy) is
    requested — more moving parts than a native write.
  - Copy cost: server-side copy avoids egress through our API, but still consumes
    MinIO IO and (transiently) double storage until staging cleanup. This is
    proportional to output size, per execution.
  - Cross-endpoint destinations (a bucket on a *different* S3 endpoint) fall back
    to a client-side streamed copy — no free server-side copy across endpoints.
  - Manifest URLs must be recomputed against the destination base after
    relocation (the existing `outputPathToManifestUrls` builds them from
    `outputPath` + a public base, so the base becomes the destination's public
    origin).

## Decision

**CHOSEN: Approach 3 — post-package relocation**, with **Approach 1 recorded as
the target end-state** to migrate to once the OSC gap (below) is closed.

Approach 1 is blocked by the verified contract and cannot be the v1 mechanism.
Between the two implementable options:

- Approach 3 needs **one** packager instance for any number of destinations;
  Approach 2 needs one running instance **per destination**. For anything beyond
  a tiny static allow-list, (2)'s cost and the operational weight of a second
  pool subsystem dominate.
- Approach 3 lets the default packaged bucket remain **private** as a staging
  area, satisfying the "source bucket must stay private" requirement by
  construction — only the deliberately relocated copy reaches a shareable
  destination. Approach 2 writes straight into each destination and offers no
  such private staging boundary.
- On the same MinIO endpoint, relocation is a **server-side `CopyObject`** — no
  byte re-download through open-videocore — so the dominant cost is bounded,
  proportional MinIO IO and transient double storage, not egress. This is
  acceptable for the expected per-execution output sizes and destination counts.
- Approach 3 requires **no upstream OSC change**, so #190 can ship now instead of
  blocking on packager evolution.

If per-execution destinations were guaranteed to be a very small, fixed set
sharing one S3 endpoint/credentials, Approach 2 would be competitive (it avoids
the copy entirely). We reject it as the default because it does not generalise to
more than a handful of destinations and doubles our instance-management surface.

### Contract field the chosen mechanism relies on

Approach 3 depends only on contract elements that **already exist and are
verified**:

- The packager's instance-scoped **`OutputFolder`** (schema source: OSC
  `get-service-schema` for `eyevinn-encore-packager`, 2026-07-13) — the fixed,
  private staging base the single packager instance writes into.
- The success-callback **`outputPath`** field (`PackagerSuccessPayload`,
  `src/pipeline/packaging.ts` line 115; contract note lines 106-116) — the exact
  source prefix to enumerate and relocate.
- The `minio-minio` S3-compatible **`CopyObject`** operation (ADR-001 storage
  row) for the same-endpoint server-side copy.

It relies on **no** unverified or absent field. Notably it does **not** depend on
any per-job output-base field (which does not exist) — that is precisely why it
is implementable today.

## Fallback behaviour

- **No `destinationBucket` supplied on the execution:** skip relocation entirely.
  Output stays in the default packaged bucket
  (`DEFAULT_PACKAGED_BUCKET = 'openvideocore-packaged'`,
  `src/pipeline/packaging.ts` line 35) and manifest URLs resolve against the
  default public base, exactly as today. #190 is purely additive.
- **Destination not on the allow-list:** reject at the API boundary before
  enqueueing (validation error), so an execution never packages to an
  unauthorised bucket.
- **Relocation fails after a successful package:** the packaged output still
  exists in the private staging bucket; record a `packagingError`-style
  annotation on the asset (matching the existing failure-annotation convention in
  `PackagingService`, which never changes lifecycle status) and surface the
  staging manifest URLs so the asset is still playable from staging. The move is
  retryable; a *copy* (leave staging intact) is the safe default over a *move*
  (delete staging) so a mid-relocation failure never loses the only copy.
- **Cross-endpoint destination (different S3 endpoint than staging):** fall back
  from server-side `CopyObject` to a client-side streamed copy through
  open-videocore; if the destination endpoint/credentials are not configured,
  reject at the API boundary (same as an off-allow-list destination).

## Consequences

- #190's implementation adds a relocation step invoked from
  `PackagingService.handleSuccess` (the existing post-package hook) and a
  destination allow-list validated at the execute boundary. It does **not**
  change the queue envelope (`{ jobId, url }` stays as-is) or require a second
  packager instance.
- Manifest-URL construction must key off the *destination* public base when a
  relocation occurred (extend `outputPathToManifestUrls` /
  `packagingPublicBaseUrl` to take a per-execution base), not the default base.
- The default packaged bucket is formally an **internal, private staging area**;
  public/shared exposure is a property of a destination bucket, not the staging
  bucket.
- If/when the logged OSC gap is closed (a per-job output base on the packager
  queue message), a follow-up ADR should migrate to Approach 1 and retire the
  relocation step, since a native write is strictly cheaper than copy-then-move.

## OSC feedback

Approach 1 is blocked by a genuine capability gap: `eyevinn-encore-packager`
exposes no per-job output-base field (only the instance-scoped `OutputFolder` and
the subfolder-only `OutputSubfolderTemplate`/`$EXTERNALID$`), and the consumed
queue envelope is `{ jobId, url }`. Logged to
`docs/osc-feedback/incoming-per-job-packager-output.md`.

## Contract sources

- OSC MCP `get-service-schema` for `eyevinn-encore-packager`, retrieved
  2026-07-13 — `OutputFolder` (REQUIRED, instance-scoped base),
  `OutputSubfolderTemplate` (subfolder-only, `$EXTERNALID$` per-job token),
  `Aws*` / `S3EndpointUrl` (instance-scoped), `RedisUrl` / `RedisQueue`. No
  per-job output-base field.
- `src/pipeline/packaging.ts` — `PackagingJob` (`{ jobId, url }`, lines 83-86),
  `PackagerSuccessPayload` (`{ url, jobId, outputPath? }`, lines 106-116),
  `DEFAULT_PACKAGED_BUCKET` (line 35), `PackagingService.handleSuccess` (post-
  package hook, lines 173-185), `outputPathToManifestUrls` (lines 200-214).
- `src/pipeline/osc-packager-queue.ts` — queue producer contract: `ZADD` onto a
  Redis/Valkey sorted set, consumed via `BZPOPMIN`; message `{ jobId, url }`
  (lines 9-16, 31-37).
- `src/encore-scaler/instance-pool.ts` — the existing OSC instance-pool pattern
  (`@osaas/client-core` `createInstance` / `removeInstance` /
  `waitForInstanceReady`) that Approach 2 would have to replicate.
- ADR-001 — `minio-minio` as the S3-compatible packaged store;
  `eyevinn-encore-packager` reading `REDIS_URL` + `MINIO_*` from env.
