# ADR-020: Delete-protection contract — 409 reason codes, force-override policy, and lock storage location

**Status:** PROPOSED 2026-09-04
**Date:** 2026-09-04
**Author agent:** claude-opus-4-8 (architect)
**Issue:** #567 (parent #530 — deletion protection)

---

## Numbering note

The highest ADR merged on `main` is ADR-016. Three ADRs are already claimed on
in-review branches: ADR-017 (external storage backends, #546), ADR-018
(authorisation model, #552), and ADR-019 (storage tiering, #555). Verified on
2026-09-04 that none of those branches also took 020
(`git ls-tree -r origin/issue-546/... origin/issue-552/... origin/issue-555/...`
returned only 017/018/019). **ADR-020 is the next free number above the
in-review set.** This mirrors how those in-review ADRs claimed the next-free
slot above their own predecessors.

---

## Context

Parent #530 introduces deletion protection, which spans several INDEPENDENT
detection mechanisms that can each block a delete:

- **referenced-by-job** — an asset is an input/output of a running or pending
  pipeline job.
- **member-of-collection** — an asset is a member of one or more collections
  (a collection stores a flat list of asset ids, `assetIds`, at
  `src/data/collection-repo.ts:19-25`).
- **explicit lock** — an operator has pinned the asset (or collection) with a
  deliberate "do not delete" flag.

The per-mechanism ENFORCEMENT is delivered by sibling sub-issues and is
explicitly OUT OF SCOPE here. This ADR pins the shared contract those sub-issues
consume so that all three mechanisms return a **consistent, machine-readable
409** and honour **one override convention**. Without a pinned contract each
sub-issue would invent its own error shape and its own `force` semantics, and
callers could not reliably distinguish why a delete was blocked or act on the
referencing ids.

This is a DESIGN-ONLY contract. No code, route, schema, or system write path is
changed by this ADR.

## Verified contracts

Every shape below was read from the live source tree before this ADR was
written (CLAUDE.md rule 7). Nothing here is guessed.

### Existing 4xx error envelope (the shape we mirror)

Both asset and collection routes declare and use the **same** error envelope:

- `src/routes/assets.ts:325` — `const errorSchema = z.object({ error: z.string(), message: z.string().optional() });`
- `src/routes/collections.ts:32` — identical `z.object({ error: z.string(), message: z.string().optional() })`.

Every 4xx in these routes is sent as `{ error, message? }`, where `error` is a
short machine-readable slug and `message` is optional human text. Examples:

- `src/routes/assets.ts:1414` — `409 { error: 'pipeline_running', message: … }`
- `src/routes/assets.ts:1635` — `409 { error: 'has_children', message: err.message }` (the delete-block that already exists for parent/child)
- `src/routes/assets.ts:1949`, `:1953`, `:1981` — `404 { error: 'not_found' }`

The existing parent/child delete block is raised by
`HasChildrenError` (`src/data/asset-repo.ts:527-533`, `readonly statusCode = 409`)
and surfaced at `src/routes/assets.ts:1634-1636` as
`{ error: 'has_children', message }`. **That existing 409 carries no list of
referencing ids** — the caller is told *that* it is blocked but not *by what*.
Closing that gap (a machine-readable list of blockers) is a primary reason this
contract exists.

### The `administrative` namespace (asset lock location)

Assets use the four-namespace ADR-005 document model. There is **no standalone
`ADR-005-*.md` file** in `docs/architecture/` (highest merged is ADR-016); the
authoritative namespace table lives in the code comment at
`src/data/asset-document.ts:1-23`, which defines:

- `descriptive` — user / editorial
- `technical` — machine (ffprobe)
- **`administrative` — system: timestamps, source method, storage refs, provenance**
- `structural` — pipeline: renditions, manifests, thumbnails, collections

The `administrative` object schema is at
`src/data/asset-document.ts:231-249` and today contains: `createdAt`,
`updatedAt`, `source { method, originUri? }`, `storage?`, `rights?`,
`provenance[]`, `statusHistory[]`, and `reviewState`
(`.enum(ASSET_REVIEW_STATES).default('draft')`, #134). This namespace is
system-owned and **NOT user-writable**, which is exactly why a delete-lock
belongs here (a user must not be able to clear their own protection through the
ordinary editorial update path).

### Collection document shape (collection lock location)

Collections do **NOT** use the four-namespace model. The domain type is flat
(`src/data/collection-repo.ts:19-25`): `{ id, name, assetIds, createdAt,
updatedAt }`. The persisted CouchDB shape is the `toDoc` projection at
`src/data/couch-collection-repo.ts:98-107`: `{ resourceType, localId, name,
assetIds, createdAt, updatedAt }`, and `fromDoc`
(`src/data/couch-collection-repo.ts:109-117`) reads exactly those fields.
**There is no `administrative` (or any) namespace on a collection** — it is a
flat document.

### Lifecycle states and the archive/purge/restore paths

- Lifecycle states: `ASSET_STATUSES = ['uploading', 'processing', 'ready', 'failed', 'archived']` (`src/data/asset-repo.ts:28`). `archived` is the terminal soft-deleted state; `ALLOWED_TRANSITIONS.archived = []` (`src/data/asset-repo.ts:39`).
- **DELETE is a SOFT delete → archive.** `DELETE /:id` (`src/routes/assets.ts:3706-3728`) blocks on children (`countChildren` → `HasChildrenError`, `:3717-3719`) then calls `repo.remove(...)` which archives (comment `src/routes/assets.ts:3721`; file header `:10-11`).
- **Restore** (`POST /:id/restore`, `src/routes/assets.ts:3741-3767`, #328) revives an `archived` asset that has not yet been purged; a purged (tombstoned) id returns `410` (`:3757-3758`).
- **Hard purge** is the background retention sweep `purgeExpiredArchivedAssets` (`src/pipeline/archived-asset-purge-sweep.ts:117-190`): it enumerates `list({ status: 'archived' })`, checks the retention window (`archivedAtOf`, per its header `:15-22`), removes objects across buckets, then REPLACES the document with a tombstone (`:307-313`). The retention window is governed by `src/routes/retention.ts` (`RETENTION_DISABLED_MS = 0`, `:27`).

So the two destructive operations are distinct: **ARCHIVE** (caller-initiated,
reversible via restore) and **PURGE** (background, irreversible, tombstones the
document).

## Decision

### 1. The `409` response envelope for a blocked delete

A blocked delete returns HTTP `409` with a body that **extends** the existing
`{ error, message? }` envelope (`src/routes/assets.ts:325`,
`src/routes/collections.ts:32`) rather than inventing a divergent shape:

```json
{
  "error": "delete_blocked",
  "message": "asset is protected from deletion",
  "reason": "referenced_by_job",
  "blockedBy": {
    "jobIds": ["job_01H…", "job_01H…"],
    "collectionIds": []
  }
}
```

Contract rules:

- `error` — the fixed slug `"delete_blocked"`, matching the existing slug-style
  `error` field (cf. `has_children`, `pipeline_running`). Callers branch on the
  finer `reason`.
- `message` — optional human text, exactly as the existing envelope allows.
- `reason` — a **required** enum with exactly three members:
  `"referenced_by_job"`, `"member_of_collection"`, `"delete_protected"`. When
  more than one mechanism blocks the same delete, the enforcement layer reports
  the FIRST-tripped reason in the fixed precedence
  `delete_protected` > `referenced_by_job` > `member_of_collection` (explicit
  lock is the strongest signal and is surfaced first; precedence is fixed so
  the response is deterministic). Sibling sub-issues must not add members to
  this enum without amending this ADR.
- `blockedBy` — a **required** object carrying the referencing ids so a caller
  can act (remove the membership, wait for / cancel the job, or unlock):
  - `jobIds: string[]` — populated for `referenced_by_job`, else `[]`.
  - `collectionIds: string[]` — populated for `member_of_collection`, else `[]`.
  - For `delete_protected` both arrays are `[]` (the block is intrinsic to the
    document, not a foreign reference).

This directly closes the gap noted above: the existing `has_children` 409
(`src/routes/assets.ts:1635`) tells the caller nothing about *which* children
block it; `delete_blocked` always names its blockers in `blockedBy`.
`has_children` is a PRE-EXISTING, SEPARATE block (parent/child integrity, not
deletion protection) and is intentionally left unchanged by this contract.

### 2. Override policy (per mechanism)

`?force=true` is the single override convention across all three mechanisms.
Whether it is honoured differs per mechanism, and each choice is justified:

| Mechanism | Reason code | `?force=true` behaviour | Justification |
|-----------|-------------|-------------------------|---------------|
| member-of-collection | `member_of_collection` | **Soft — overridable.** Without `force` → `409`; with `force=true` → proceed. | Collection membership is a loose, non-authoritative grouping. The collection layer already does not cascade or validate membership (`src/data/collection-repo.ts:14-17`: ids are dropped silently at read time when they no longer resolve). Blocking is a courtesy warning, not an invariant, so an explicit `force` may proceed. |
| referenced-by-job | `referenced_by_job` | **Soft — overridable, but only for terminal/settled jobs.** Without `force` → `409`; with `force=true` → proceed. An ACTIVE (running/pending) job reference remains a **hard block even with `force`**. | Deleting an asset a *completed* job merely records is safe to override. Deleting an asset a *running* job is actively reading/writing would corrupt an in-flight pipeline, so `force` must not defeat it. The precise "active job" predicate is defined by the enforcement sub-issue; this contract only pins that active-job references are non-forceable. |
| explicit lock | `delete_protected` | **Hard block. `force` is NOT honoured.** Always `409` while the lock flag is set. | An explicit operator lock is a deliberate, auditable "do not delete" intent. If `force` could defeat it the lock would be meaningless. Removal requires clearing the lock flag first through the system write path (a separate sub-issue), never through `force` on the delete call. |

Summary: `member_of_collection` is soft/forceable; `referenced_by_job` is
soft/forceable for settled jobs but hard for active jobs; `delete_protected`
is always hard. `?force=true` is advisory and never overrides a hard block.

### 3. Lock-flag storage location

**Assets.** The explicit delete-lock lives in the system-owned `administrative`
namespace (`src/data/asset-document.ts:231-249`), as a new optional field:

```
administrative.deleteLock?: {
  locked: boolean;         // true = protected
  reason?: string;         // optional operator note
  lockedAt: string;        // ISO-8601 timestamp
  lockedBy?: string;       // provenance actor, optional
}
```

Placement rationale, all grounded in verified contract:

- It sits in `administrative` because ADR-005 (namespace table at
  `src/data/asset-document.ts:1-23`) makes that namespace system-owned and NOT
  user-writable — a user must not clear their own protection via the editorial
  update path.
- It is **optional**, matching the established pattern in this document where
  every post-v1 field is added optional so documents written before the field
  existed still deserialize with no `schemaVersion` bump (cf. `reviewState`
  `.default('draft')` at `:244-248`, `packagedOutput` optional at `:261-268`).
  A document with `deleteLock` absent is treated as unlocked.
- Because `administrative` is not user-writable, **setting/clearing this flag
  requires a dedicated system write path.** That write path is explicitly NOT
  built here (out of scope); this ADR only reserves the field and its
  placement so the enforcement sub-issue can implement the write path against a
  fixed target.

**Collections.** Collections have **no namespace model** — the document is flat
(`src/data/collection-repo.ts:19-25`; persisted projection
`src/data/couch-collection-repo.ts:98-107`). There is therefore no
`administrative`-equivalent to place the lock in. The lock is a new
**top-level optional field on the collection document**, mirroring the asset
sub-shape for cross-mechanism consistency:

```
Collection.deleteLock?: {
  locked: boolean;
  reason?: string;
  lockedAt: string;
  lockedBy?: string;
}
```

This field would be added to the `Collection` type
(`src/data/collection-repo.ts:19-25`) and carried through the `toDoc`/`fromDoc`
projections (`src/data/couch-collection-repo.ts:98-117`) by the enforcement
sub-issue. Since collections have no non-user-writable namespace, the guarantee
that only a system path may set/clear it is provided at the route/authorisation
layer rather than by the document model — the enforcement sub-issue owns that.
This ADR states the honest reality (no namespace on collections) and pins the
concrete field.

### 4. Interaction with soft-delete / restore and hard purge

The lock's scope is defined against the real lifecycle
(`src/data/asset-repo.ts:28,39`) and the two destructive operations:

- **ARCHIVE (soft delete via `DELETE /:id`, `src/routes/assets.ts:3706-3728`):**
  an explicit lock (`delete_protected`) **BLOCKS archive.** The lock check
  joins the existing pre-archive guards (the `HasChildrenError` check at
  `:3717-3719`) so a locked asset cannot even enter the `archived` state. This
  is the primary enforcement point: protection means the operator cannot
  soft-delete a pinned asset.
- **HARD PURGE (background sweep, `src/pipeline/archived-asset-purge-sweep.ts`):**
  because a locked asset can never become `archived`, and the sweep only ever
  enumerates `list({ status: 'archived' })`
  (`src/pipeline/archived-asset-purge-sweep.ts:195-215`), a lock also
  transitively protects against purge — a locked asset is never in the sweep's
  candidate set. **As a defence-in-depth requirement this contract additionally
  mandates that the purge sweep skip any asset whose `administrative.deleteLock.locked`
  is true**, so that even an asset that reached `archived` before being locked
  (or locked out-of-band) is never tombstoned while the lock stands. The
  enforcement sub-issue adds that predicate to `purgeOne`'s eligibility.
- **Therefore the lock blocks BOTH archive and hard purge.** Archive is blocked
  at the delete route (the normal path); purge is blocked transitively (locked
  assets never reach `archived`) AND explicitly (the sweep skips locked
  documents) as belt-and-braces.
- **RESTORE (`POST /:id/restore`, `src/routes/assets.ts:3741-3767`)** is
  UNAFFECTED — it is a recovery/un-delete operation, not a delete, so a lock
  never blocks restoring an already-archived asset. (A tombstoned asset still
  returns `410` per `:3757-3758`; the lock does not change that.)

## Consequences

- **Positive.** All three deletion-protection mechanisms now share one 409
  envelope (`delete_blocked` + `reason` enum + `blockedBy`) and one override
  convention (`?force=true`, advisory, never defeating a hard block). Callers
  get machine-readable blockers they can act on — a strict improvement over the
  existing id-less `has_children` 409 (`src/routes/assets.ts:1635`). Sub-issues
  implement enforcement against a fixed target rather than each inventing a
  shape.
- **Cost / follow-up.** A **system write path** to set/clear the lock is
  required and is NOT built here: for assets because `administrative` is not
  user-writable (`src/data/asset-document.ts:1-23`), and for collections at the
  route/authorisation layer (collections have no protected namespace). Adding
  the asset field touches `src/data/asset-document.ts`; adding the collection
  field touches `src/data/collection-repo.ts` and
  `src/data/couch-collection-repo.ts`. Both are deferred to enforcement
  sub-issues.
- **Backward compatibility.** `administrative.deleteLock` and
  `Collection.deleteLock` are both optional; absent = unlocked, so no
  `schemaVersion` bump is needed and all existing v1 documents remain valid
  (consistent with the optional-field precedent at
  `src/data/asset-document.ts:244-268`).
- **Bounded enum.** The `reason` enum is fixed at exactly three members; any new
  detection mechanism must amend this ADR before adding a member, keeping the
  machine contract stable for callers.
