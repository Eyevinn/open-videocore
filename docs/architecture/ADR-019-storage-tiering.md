# ADR-019: Storage tiering design (tier model, trigger, per-byte-class scope, rehydrate contract, status separation)

**Status:** PROPOSED 2026-09-04
**Date:** 2026-09-04
**Author agent:** claude-opus-4-8 (architect)
**Issue:** #555 (design work under parent #524; substrate is ADR-017)

---

## Numbering / placement note (read first)

Issue #555's title asks for this design to land "as a tiering-policy section of
**ADR-007** (the multi-backend storage ADR introduced by #524)." That label is
**wrong in two ways**, and this note records the correction honestly rather than
overwriting anything:

1. **ADR-007 is not the storage ADR.** On `main`,
   `docs/architecture/ADR-007-pipeline-visualisation.md` already exists and owns
   the ADR-007 slot — it is about pipeline visualisation, unrelated to storage.
   It is **not** touched here.
2. **The real multi-backend storage ADR introduced by #524 is ADR-017.** That
   document (`docs/architecture/ADR-017-external-storage-backends.md`) is
   currently **PROPOSED and in review** on branch
   `origin/issue-546/adr-007-external-storage` (PR #583) — it is **not yet on
   `main`**. Its own "Numbering note" states verbatim: *"Any downstream #524
   sub-issue that says 'ADR-007' for storage means THIS document (ADR-017),"* and
   names #555 among the siblings.
3. **This is a new standalone ADR, not an edit to ADR-017.** Because ADR-017 lives
   only on another branch, a `main`-based edit to it would guarantee a merge
   conflict with PR #583. So #555's storage-tiering design is captured here in a
   **new ADR that cross-references ADR-017** as its substrate, rather than as a
   new section inside ADR-017.
4. **Foldable later.** If the maintainers prefer, this document can be folded into
   ADR-017 as its tiering section once ADR-017 lands on `main`. Until then it
   stands alone.

Numbering was resolved contract-first by listing `docs/architecture/` on `main`
(highest present is **ADR-016**; ADR-002 and ADR-013 slots are unused gaps) and
checking the two in-review branches that each add one ADR:
`origin/issue-546/adr-007-external-storage` adds **ADR-017** (#546) and
`origin/issue-552/authorisation-adr` adds **ADR-018** (#552). The next-free number
above all three is therefore **ADR-019**, this document.

---

## Context

Parent issue #524 (CLOSED) established externally-owned, S3-compatible object
storage as a first-class, registerable backend. Its design substrate is
**ADR-017** (credential model + config scope), and the registration API lands
under #547. Issue #555 asks the next design question: once bytes can live on
multiple backends, **how does open-videocore move an asset's bytes between a fast
"hot" tier and a cheap "archive/cold" tier**, and how does that byte-level tiering
stay cleanly separated from the asset **lifecycle status** it superficially
resembles (`archived`).

This ADR is **design-only**. It settles the six decisions that unblock
storage-tiering implementation and pins each to a verified repo contract or to
ADR-017. It does **not** implement tiering; the follow-up implementation slices
proceed once ADR-017 lands (see Dependency).

The central risk this ADR must retire is a **naming collision**. open-videocore
already has a terminal lifecycle status literally named `archived`
(`src/data/asset-repo.ts:28`) and a retention **purge** sweep that permanently
deletes the bytes of `archived` assets past a retention window
(`src/pipeline/archived-asset-purge-sweep.ts`). "Move bytes to an archive tier"
and "the asset's lifecycle status is archived" are **different concepts** that
must never be conflated — conflating them would let a tiering action trigger a
retention purge, destroying an asset that is merely cold-stored. Decision 6 is the
explicit firewall between them.

---

## Verified contracts (cited before any decision)

Every mechanism below was read from the repo. Branch is `main` unless stated.

### V1 — The `archived` lifecycle status and its state machine

`ASSET_STATUSES = ['uploading', 'processing', 'ready', 'failed', 'archived']`
(`src/data/asset-repo.ts:28`). `archived` is **terminal**:
`ALLOWED_TRANSITIONS.archived = []` (`src/data/asset-repo.ts:39`). It is a
"terminal soft-deleted / retired state" (`src/data/asset-repo.ts:22-24`), reached
via `remove()` (`src/data/asset-repo.ts:1108-1110`,
`src/data/couch-asset-repo.ts:353`) and left only by the audited `restore()`
exception that bypasses the state machine
(`src/data/asset-repo.ts:591-596,616-629`; `src/data/couch-asset-repo.ts:357-384`).

### V2 — `status` is already documented as ONE independent axis among several

The code already treats `status` as a single, narrow axis and layers *other*
independent state beside it: `reviewState` is "DISTINCT from the lifecycle
`status`" and "the two are INDEPENDENT" (`src/data/asset-repo.ts:53-57`). This is
the established house pattern this ADR follows for the tier axis.

### V3 — The retention purge sweep permanently deletes `archived` assets' bytes

`purgeExpiredArchivedAssets(...)` enumerates `list({ status: 'archived' })`
(`src/pipeline/archived-asset-purge-sweep.ts:200-204`), and for each asset past
the window **removes every byte object across every bucket** then replaces the
document with a tombstone: source `objectKey`, each `renditions[].objectKey`, the
whole packaged prefix, subtitle tracks, and thumbnails
(`src/pipeline/archived-asset-purge-sweep.ts:255-314`). Eligibility is measured
from the **last `-> archived` transition** (`archivedAtOf`,
`src/data/asset-tombstone.ts:87-95`), NOT `updatedAt`
(`src/pipeline/archived-asset-purge-sweep.ts:144-150`). The window is instance-
global config: `retentionMs`, where `0` = disabled/never-purge
(`src/routes/retention.ts:25-56`; `RETENTION_DISABLED_MS = 0` at
`src/routes/retention.ts:27`).

### V4 — The asset byte classes actually produced

An `Asset` (`src/data/asset-repo.ts:257-370`) references these distinct byte
classes:

- **Source** — `objectKey` (source bucket) (`src/data/asset-repo.ts:291-292`).
- **Renditions** — `renditions[].objectKey`, a plain source-bucket key or an
  `s3://bucket/key` URI (`src/data/asset-repo.ts:210-221`;
  purge handling `src/pipeline/archived-asset-purge-sweep.ts:266-278`).
- **Packaged manifests + segments** — the CMAF HLS/DASH output under the packaged
  prefix, captured as `packagedOutput { bucket, prefix, masterHlsKey,
  masterDashKey }` (`src/data/asset-repo.ts:178-203,307-311`), written by
  `eyevinn-encore-packager` under `outputPrefix(assetId)`
  (`src/pipeline/packaging.ts:60-64`) in `packagedBucket()`
  (`src/pipeline/packaging.ts:38-40`). Per ADR-011 the packaged prefix is
  job-nested (`<assetId>/<packagerJobId>/`), instance-scoped
  (`ADR-011` "Verified constraint").
- **Subtitle tracks** — `subtitleTracks[].objectKey`
  (`src/data/asset-repo.ts:246-255`).
- **Thumbnails** — `thumbnails[]` object keys (`src/data/asset-repo.ts:315-318`).

### V5 — Delivery reads the packaged prefix live; there is no CDN/edge in front

A `ready` HLS/DASH URL is an API-proxied `/stream/*` URL that reads from the
**private** packaged bucket per request; clients never touch a raw/presigned/direct
bucket URL (`ADR-003:34-45,130-137`; OpenAPI path
`GET /api/v1/assets/{id}/stream/{*}` at `ADR-003:163-174`). The proxy resolves and
rewrites every manifest child reference through the same `/stream/*` prefix
(`ADR-003:197-222`). So **packaged bytes are on the read path of every playback
request** and any latency added to reading them is added to playback.

### V6 — Timestamps the asset carries today; NO last-access field exists

An `Asset` carries `createdAt` and `updatedAt`
(`src/data/asset-repo.ts:368-369`) and an append-only `statusHistory` of
`{ at, from, to }` transitions (`src/data/asset-repo.ts:91-95,293-294`).
**There is no `accessedAt` / `lastAccess` / `lastAccessed` field anywhere in the
data model** — a repo-wide search (`accessedAt|lastAccess|last_access|
lastAccessed|accessed`, case-insensitive, over `src/`) returns only an unrelated
comment in `src/routes/provision.ts:283`. The delivery `/stream/*` proxy (V5) does
**not** record a per-asset last-served timestamp today. This absence is load-
bearing for Decision 2.

### V7 — ADR-017's credential + config-scope substrate (consumed, not re-litigated)

- Credentials use one primitive: **per-serviceId OSC secrets** via `saveSecret`,
  fanned out per consuming serviceId, with only the `{{secrets.<name>}}`
  reference in each service body (ADR-017 C1/D1; `src/routes/provision.ts:585-593`).
- Each consumer spells the S3 fields differently and is mapped in
  `src/services/external-storage-credentials.ts` (ADR-017 C2): `encore`
  (`s3AccessKeyId`/`s3SecretAccessKey`/`s3Endpoint`, lines 91-116),
  `eyevinn-encore-packager` (`AwsAccessKeyId`/`AwsSecretAccessKey`/`OutputFolder`,
  lines 122-148), `eyevinn-ffmpeg-s3` (`awsAccessKeyId`/`awsSecretAccessKey`, per
  job, lines 155-180).
- Only **non-secret** coordinates persist to the param store as
  `StorageBackendConfig { backend, bucket, endpointUrl?, region?, publicBaseUrl? }`
  (ADR-017 C4; `src/services/param-store.ts:41-47`), with credentials actively
  rejected by `assertNoCredentials` (`src/services/param-store.ts:165-204`).
- Backend scope is **per-workspace/per-stack, per-role** (`storage.source` /
  `storage.packaged`), not per-collection or per-asset (ADR-017 D2/C5;
  `src/services/param-store.ts:83-92`).
- The #547 registry realises this split as `StorageBackendRecord` with roles
  `'source' | 'packaged' | 'both'` and a non-deletable synthetic `'default'`
  backend (`src/services/storage-backend-registry.ts:44-52` on branch
  `origin/issue-547/storage-backend-registration-api`).

---

## Decision

### D1 — Tier model: a separate `storageTier` byte-location axis (`hot` | `archive`), never a lifecycle status

Introduce a **new axis on the asset, orthogonal to lifecycle `status`**, that
describes **where the asset's bytes physically live**, not what the asset *is*
editorially or in its ingest lifecycle. The vocabulary is deliberately small:

- **`hot`** — bytes on a low-latency backend, immediately readable by delivery and
  by processing jobs. This is the default and the only tier a fresh asset has.
- **`archive`** (synonym in prose: *cold*) — bytes moved to a cheaper,
  higher-latency archive-class backend; not directly readable at playback latency
  until rehydrated (D4).

This mirrors the established house pattern where `reviewState` is an independent
axis beside `status` (V2). The tier axis is a property of **bytes**, so it must be
modelled **per byte class** (D3), not as one asset-wide flag. Naming rule
(normative): the value is `archive` (or `cold`), **never** `archived` — the `-d`
form is reserved for the lifecycle status (V1) and using it here would reintroduce
the collision Decision 6 exists to prevent.

**Why not overload `status`?** `status` is terminal at `archived` with an empty
transition set (V1) and drives the destructive retention purge (V3). A byte
location is not a lifecycle state, changes far more often, and must be reversible
without the audited `restore()` exception. Keeping it a separate axis is both the
house pattern (V2) and the safety requirement (D6).

### D2 — Tiering trigger: explicit operator action is the mandatory baseline; age/last-access are **opt-in policies**, and last-access requires a new recorded signal first

The trigger to move bytes `hot -> archive` is, in priority order:

1. **Explicit operator action** (baseline, always available) — an operator
   requests archiving of a named asset (or byte class). This needs no new signal:
   it is an intentful API call, analogous to how `remove()` is an intentful
   lifecycle action (V1). Implementation is a follow-up slice.
2. **Asset age** (opt-in policy) — "archive bytes older than N." Age is derivable
   **today** from `createdAt` (V6), so an age policy can ship without a new data-
   model field.
3. **Last-access time** (opt-in policy) — "archive bytes not served for N." This
   is the intuitively best signal but **cannot be implemented against the current
   data model**: there is **no last-access field**, and the `/stream/*` delivery
   proxy does not record a per-asset served-at timestamp (V6). Therefore a
   last-access policy is **explicitly gated** on first adding that recorded signal.

**Where last-access must be recorded (design mandate for the follow-up):** because
the only live read path for packaged playback is the API `/stream/*` proxy (V5),
last-access is *observable at exactly one seam*: the stream/delivery proxy handler.
A last-access policy must therefore add a new asset field — proposed
`lastAccessedAt` (ISO string), mirroring the existing `updatedAt`/`extractedAt`
timestamp conventions (V6) — updated (throttled, best-effort, never blocking
playback) from the `/stream/*` proxy in `src/routes/assets.ts` (the delivery route
verified at `ADR-003:163-174`). Until that field exists, a last-access policy MUST
NOT be offered. This gap (no last-access recording seam today) is logged to OSC/
data-model feedback per the ground rules.

**Trigger direction is one-way here:** D2 governs `hot -> archive`. The reverse
(`archive -> hot`) is the rehydrate contract in D4.

### D3 — Per-byte-class scope: tiers are tracked **per byte class**, and packaged manifests/segments MUST stay `hot`; source and (optionally) renditions may be archived

Tiering is **per byte class**, not per asset as a unit, because the asset's byte
classes have different delivery obligations (V4, V5):

- **Packaged manifests + segments (`packagedOutput` / packaged prefix)** — these
  are on the **live playback read path** of every `/stream/*` request (V5). They
  **MUST remain `hot`** for any asset that is deliverable. Archiving packaged bytes
  would add archive-tier latency to playback, breaking delivery. **Not archivable
  while the asset is meant to be playable.**
- **Source (`objectKey`)** — the mezzanine/original. It is **not** on the playback
  read path (delivery serves packaged output, V5); it is read only by processing
  jobs (re-transcode, rewrap, thumbnailing). It is the **primary archive
  candidate**: archiving source does not break delivery, only defers
  reprocessing until rehydrated (D4).
- **Renditions (`renditions[].objectKey`)** — intermediate ABR variants consumed to
  produce packaged output. Once packaged output exists they are not on the
  playback path either, so they **may** be archived alongside source, at policy
  discretion.
- **Subtitle tracks / thumbnails** — small; archiving them yields negligible saving
  and thumbnails often back UI/preview. Default is to **leave them `hot`**; they
  are out of scope for the initial tiering policy and may be revisited.

**Normative rule:** an asset that must remain deliverable may have its **source
and renditions** archived while its **packaged output stays hot**; delivery keeps
working unchanged (V5). Because the tier is tracked per byte class (D1), the asset
record can honestly express "source archived, packaged hot" — a single asset-wide
flag could not, which is why D1 is per-class.

### D4 — Rehydrate contract: **explicit restore request** with an operator-facing latency expectation; automatic-on-access is deferred

Moving bytes `archive -> hot` (rehydrate) is by **explicit restore request**, not
automatic-on-access, for the initial design:

- **Explicit restore** is deterministic and cheap to reason about: an operator (or
  a pipeline step that needs an archived source) issues a restore for the asset's
  archived byte class; the bytes are copied back to the `hot` backend and the
  per-class tier flips to `hot` on completion. This parallels the intentful,
  audited shape of the existing `restore()` lifecycle exception (V1) — same
  principle, different axis.
- **Automatic-on-access is explicitly deferred.** The only automatic access seam
  is the `/stream/*` proxy (V5), and D3 already keeps **packaged bytes hot**, so
  playback never hits an archived object in the first place. The remaining
  consumers of archived bytes are **processing jobs** reading source/renditions;
  those are asynchronous and should request an explicit restore and await it,
  rather than blocking a synchronous request on an unbounded archive fetch. If a
  concrete auto-rehydrate need appears later it is its own follow-up.

**Documented latency expectation for the Media Developer persona (normative):**

- **`hot` bytes** — available at normal object-store latency; no restore needed.
- **`archive` bytes** — **not** immediately readable. A restore is an asynchronous
  operation whose completion the caller must await/poll; the developer MUST NOT
  assume an archived byte class is fetchable inline. The concrete latency figure is
  a property of the archive-class backend chosen at registration time (D5) and is
  therefore reported by the restore operation's status, not hard-coded here. The
  contract the persona can rely on: *hot = inline; archive = request-restore-then-
  await, latency backend-defined and surfaced on the restore status.*

### D5 — Config/credential reuse: reuse ADR-017's registration + per-serviceId secret model **as-is**; the archive tier is just another registered backend (role `archive` to be added)

Tiering introduces **no new credential mechanism**. An archive-class destination is
an **externally registered S3-compatible backend** exactly as ADR-017 defines
(V7):

- Credentials are stored as **per-serviceId OSC secrets** via `saveSecret`, fanned
  out per consuming serviceId, with only `{{secrets.<name>}}` references in service
  bodies (ADR-017 C1/D1; `src/routes/provision.ts:585-593`). The same **secret
  fan-out** trade-off ADR-017 already logged applies; it is not re-litigated here.
- Only **non-secret** archive-backend coordinates persist to the param store as a
  `StorageBackendConfig` (ADR-017 C4; `src/services/param-store.ts:41-47`),
  credentials rejected by `assertNoCredentials`
  (`src/services/param-store.ts:165-204`).
- Registration reuses the #547 `StorageBackendRecord` /
  `storage-backend-registry.ts` machinery
  (`src/services/storage-backend-registry.ts:44-52`, branch
  `origin/issue-547/storage-backend-registration-api`).

**The one additive change tiering needs** is a new **role** for the archive
destination. The registry today models roles `'source' | 'packaged' | 'both'`
matching the two live per-role slots (V7). An archive tier is **not** a live
source/packaged slot — it is a cold destination — so it needs its own role value
(proposed `'archive'`) and its own per-role slot alongside
`storage.{source,packaged}` (`src/services/param-store.ts:83-92`), rather than
overloading an existing role. This is a small, additive extension of the ADR-017
model, **not** a new config or credential system. Adding that role/slot is a
follow-up implementation slice; ADR-017's credential handling is consumed
unchanged.

**Rejected:** an archive-class-specific credential store. It would duplicate the
one OSC secret primitive (V7) for no benefit and diverge from the shipped path.

### D6 — Status separation: archived **bytes tier** is firewalled from the `archived` lifecycle **status** and from the retention purge sweep

This is the load-bearing decision. Two facts must never touch:

- **`archived` lifecycle status** (V1) — a terminal, soft-deleted state that makes
  an asset eligible for the **retention purge** that **permanently deletes all its
  bytes** and tombstones the record (V3).
- **`archive` bytes tier** (D1) — a reversible, per-byte-class *location*; the asset
  is fully live and deliverable (D3), its bytes are merely cheaper/slower to read.

**Normative firewall rules:**

1. **Distinct identifiers.** The tier value is `archive`/`cold` and lives on the
   new `storageTier` axis (D1). It is **never** written to `status`, and the string
   `archived` is **never** used for a tier. The retention sweep's only trigger is
   `list({ status: 'archived' })` (`src/pipeline/archived-asset-purge-sweep.ts:200-204`);
   because a cold-tiered asset keeps a **non-`archived` status** (e.g. `ready`), it
   is **structurally invisible** to the purge sweep. Tiering bytes to `archive`
   therefore **cannot** enqueue an asset for purge.
2. **The purge sweep is not modified to consider tier.** It continues to key solely
   off lifecycle `status` and `archivedAtOf` (V3). A cold-tiered but `ready` asset
   is not a purge candidate. Correspondingly, tiering must **not** reuse or touch
   `statusHistory`'s `-> archived` transition (that timestamp is the purge clock,
   V3) — the tier axis records its own transition timestamp if needed, never the
   lifecycle one.
3. **The interaction when both are true is well-defined.** If an operator both
   cold-tiers an asset's bytes *and later* soft-deletes it (`status -> archived`),
   the asset becomes purge-eligible via the **lifecycle** path (V1/V3) as normal;
   the retention purge then deletes those bytes **wherever they live** — the sweep
   already removes across foreign buckets (it resolves `s3://bucket/key` renditions
   to their own bucket, `src/pipeline/archived-asset-purge-sweep.ts:266-278`), so
   an archive-tier location is deleted by the same best-effort per-object logic. In
   short: **tier decides where bytes live; lifecycle status decides whether they
   get purged.** They compose without special-casing.
4. **No silent revival.** Rehydrate (D4) flips only the byte tier; it never calls
   the audited lifecycle `restore()` (V1) and cannot move an asset out of
   `archived` status. Leaving `archived` status remains the single sanctioned
   `restore()` path (V1).

---

## Consequences

**Positive:**

- The byte-tier axis is cleanly separated from lifecycle `status` (D1/D6), following
  the established `reviewState`-beside-`status` house pattern (V2), so a tiering
  action can never trigger the destructive retention purge (V3).
- Delivery is provably unaffected: packaged bytes stay `hot` (D3), so `/stream/*`
  playback (V5) is unchanged for tiered assets.
- Tiering reuses ADR-017's credential + config model wholesale (D5); the only
  additive need is one new backend role/slot for the archive destination.
- The Media Developer persona gets an unambiguous latency contract: hot = inline,
  archive = request-restore-then-await (D4).

**Negative / trade-offs:**

- **Last-access policies are blocked on a new signal.** There is no last-access
  field or recording seam today (V6); an age policy can ship first, but the most
  useful trigger (last-access) needs a new `lastAccessedAt` recorded at the
  `/stream/*` proxy before it can exist (D2). Logged as friction.
- **Secret fan-out inherited.** The archive backend inherits ADR-017's per-serviceId
  secret fan-out cost (V7/D5); rotating archive credentials means re-saving per
  consuming serviceId.
- **Per-byte-class tracking is more state.** Tracking a tier per byte class (D1/D3)
  is richer than one asset-wide flag, but it is required to honestly express
  "source archived, packaged hot" and to keep delivery safe.
- **Restore latency is explicit and operator-visible** (D4); processing jobs that
  need archived source must request-and-await rather than read inline.

---

## Dependency

Depends on **#524 (CLOSED) / ADR-017** as its substrate. This ADR **consumes**
ADR-017's multi-backend registration, per-serviceId secret model, and config-scope
decisions and does **not** re-litigate them (V7). Because ADR-017 is still in
review (PR #583, branch `origin/issue-546/adr-007-external-storage`), the
implementation follow-ups for tiering (the `storageTier` axis, the `archive` role/
slot, the trigger policies, the restore operation, and the `/stream/*`
last-access seam) proceed **once ADR-017 lands on `main`**.

---

## Out of scope

- Implementation of the tier axis, archive role/slot, trigger policies, restore
  operation, and last-access recording (separate follow-up slices; this ADR is
  design-only).
- Automatic-on-access rehydrate (deferred, D4).
- Tiering of subtitle/thumbnail byte classes (default: stay hot, D3).
- Any change to the retention purge sweep's trigger, which stays keyed on lifecycle
  `status` (D6).

---

## References

- **ADR-017** — external / multi-backend storage design (credential model + config
  scope); substrate consumed here. In review on branch
  `origin/issue-546/adr-007-external-storage` (PR #583).
- **ADR-011** — packaged output is job-nested and instance-scoped (the packaged
  prefix constraint referenced in V4).
- **ADR-003** — delivery/stream-URL contract; the private-bucket `/stream/*` proxy
  read path (V5): `ADR-003:34-45,130-137,163-174,197-222`.
- Code (verified contracts, `main` unless noted):
  - `src/data/asset-repo.ts:22-24,28,39,53-57,91-95,178-203,210-221,246-255,257-370,368-369,591-596,616-629,1108-1110`
    — `archived` status + terminal machine, `reviewState`-beside-`status` pattern,
    byte-class fields, timestamps, `restore()` exception.
  - `src/data/couch-asset-repo.ts:353,357-384` — Couch `remove()`/`restore()`.
  - `src/data/asset-tombstone.ts:87-95` — `archivedAtOf` (purge clock).
  - `src/pipeline/archived-asset-purge-sweep.ts:144-150,200-204,255-314,266-278`
    — retention purge sweep: `status:'archived'` trigger, cross-bucket byte
    deletion, foreign-bucket rendition handling.
  - `src/routes/retention.ts:25-56` — retention window config (`0` = never purge).
  - `src/pipeline/packaging.ts:38-40,60-64` — packaged bucket + `outputPrefix`.
  - `src/services/param-store.ts:41-47,83-92,165-204` — `StorageBackendConfig`,
    per-role storage slots, `assertNoCredentials`.
  - `src/routes/provision.ts:283,585-593` — (no last-access field; per-serviceId
    `saveSecret` helper).
  - `src/services/external-storage-credentials.ts:91-116,122-148,155-180` —
    per-service S3 field mappings.
  - `src/services/storage-backend-registry.ts:44-52` — `StorageBackendRecord`
    roles + synthetic `default` backend (branch
    `origin/issue-547/storage-backend-registration-api`).
- Not-verifiable / gap: **no `lastAccessedAt` / last-access field or recording seam
  exists** in the current data model (repo-wide search, V6). A last-access tiering
  policy (D2) is blocked until one is added; logged as friction per the ground
  rules.
