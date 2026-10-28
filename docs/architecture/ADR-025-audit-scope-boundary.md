# ADR-025: Audit scope boundary — which mutation surfaces produce audit entries

**Status:** PROPOSED 2026-10-04
**Date:** 2026-10-04
**Author agent:** claude-opus-5 (surface-backend-api)
**Issue:** #1001 (broken down from #986; blocks #987 — the cross-cutting audit view)

---

## Numbering note

The highest ADR merged on `main` is ADR-024 (asset version-chain contract,
#905). Verified on 2026-10-04 that no remote branch claims 025 or above
(`git ls-tree -r <each origin branch> -- docs/architecture/` across all
`origin/*` refs matched no `ADR-025`). **ADR-025 is the next free number.**
Note that 018-021 each carry two unrelated documents; this ADR does not add to
that collision.

---

## Context

`AUDIT_TARGET_TYPES` is a closed enum of three values:

```ts
// src/data/audit-repo.ts:53
export const AUDIT_TARGET_TYPES = ['asset', 'collection', 'job'] as const;
```

It is enforced at write time (`targetType: z.enum(AUDIT_TARGET_TYPES)` in
`AuditEntrySchema`, `src/data/audit-repo.ts:88`, and in `RecordAuditInputSchema`,
`:99`), so a mutation surface cannot emit an audit entry at all until its
resource kind is added to this enum. It is also a **published wire contract**:
`src/routes/audit.ts:55,65` derives both the `targetType` query filter and the
response entry field from the same constant, and `openapi.json` publishes the
resulting `enum: ["asset", "collection", "job"]` on the `GET /api/v1/audit`
`targetType` parameter and on the entry response schema. Widening the enum is
therefore a generated-spec change, not a purely internal one.

Issue #986 observed that several mutation surfaces emit nothing. #1001 exists to
settle **whether** they should, because #987 (the cross-cutting audit view)
cannot claim completeness over a scope that is still open.

### What is audited today (verified)

Every audit write goes through the single fire-and-forget helper `emitAudit`
(`src/data/audit-emit.ts:59-75`) against the narrow `AuditEmitter` interface
(`:28-30`). There are 22 call sites in 5 files, producing exactly 12 distinct
actions:

| Target type | Actions | Call sites |
|---|---|---|
| `asset` | `asset.created`, `asset.metadata_updated`, `asset.status_changed`, `asset.archived`, `asset.restored` | `src/routes/assets.ts:2928, 3029, 3117, 5611, 5956, 6046, 6175` |
| `collection` | `collection.created`, `collection.deleted`, `collection.member_added`, `collection.member_removed` | `src/routes/collections.ts:332, 511, 616, 649` |
| `job` | `job.submitted`, `job.completed`, `job.failed` | `src/routes/assets.ts:3055, 3073, 3158`; `src/pipeline/transcode.ts:114, 319, 412`; `src/pipeline/packaging.ts:524, 622, 661`; `src/pipeline/url-pull-worker.ts:273, 328` |

### What is NOT audited today (verified)

`grep -n audit src/routes/{provision,storage,webhooks,scaler,optional-services}.ts`
returns **nothing**. None of the four candidate surfaces named in #1001 emits an
audit entry, and the Encore pool emits none either — its lifecycle observability
is `console.warn` / `console.error` to process stderr
(`src/encore-scaler/scaler-loop.ts:184, 229, 252, 299, 407, 531, 557, 695, 710,
740, 752, 822, 838`), which is neither durable nor queryable.

### A cross-cutting caveat that applies to every entry

`originActor()` hardcodes `principalId: null` (`src/data/audit-emit.ts:47`), so
**no** existing audit entry names an actor, even though `request.principal` is
now available on authenticated routers (ADR-018; the role gate at
`src/routes/storage.ts:331-341` reads it). The audit model reserves the field for
forward-compatible enrichment (`src/data/audit-repo.ts:49-50`), so this is a
tracked gap, not a schema break. It bears on this decision only insofar as it
lowers — but does not remove — the value of any widening: an entry still records
*what* changed and *when*, which is the bulk of an incident timeline.

---

## Decision

**Widen audit scope by exactly two target types — `storage-backend` and
`webhook` — and hold the line everywhere else.** Specifically:

| Candidate surface | Decision |
|---|---|
| Storage backend registration / removal | **IN SCOPE** — follow-on to be filed |
| Webhook registration / deletion | **IN SCOPE** — follow-on to be filed |
| Encore instance lifecycle (spawn / dispatch / drain / reap) | **OUT OF SCOPE** — revisit after #778 |
| Stack provisioning / deprovisioning | **OUT OF SCOPE** — structurally unsuitable |
| Scaler config mutation (`PATCH /scaler/config`) | **OUT OF SCOPE** — deferred with the scaler |

No code changes in this issue. The two inclusions are filed as follow-on
implementation issues (named below) so #987 can be built against a settled
scope, with two known target types arriving later rather than an open question.

---

## Rationale per surface

### IN: storage backend registration / removal → `storage-backend`

Routes: `POST /backends` (`src/routes/storage.ts:353`, delegating to
`storageBackendRegistry.register(workspaceId, request.body)` at `:375`),
`DELETE /backends/:id` (`:525`, `.remove(...)` at `:544`). Also relevant:
`POST /backends/:id/test-connection` (`:485`).

Reasons to include:

1. **It is the one place a credential enters the system.** Per ADR-017 D1 the
   secret access key is written to OSC per-serviceId secret storage and the
   response is always redacted; the route refuses outright (501) when no secret
   sink is configured (`:370-375`). "When did a credential for an external
   bucket appear or disappear, and against which workspace" is precisely the
   question an incident review asks, and today there is no durable record of it
   anywhere.
2. **It is structurally identical to a surface already audited.** Like
   `collection.created` / `collection.deleted`, it is workspace-scoped,
   request-scoped, role-gated (`authorize(role, action, 'asset')`,
   `src/routes/storage.ts:331-334`, over the viewer/editor/admin set at
   `src/auth/principal.ts:31`), operator-initiated, and low volume. There is no
   principled line that admits collection membership changes but excludes
   credential registration.
3. **Nothing gates it.** It has no dependency on #778 and no bearing on
   instance billing. Deferring it defers nothing but the work.

Counterweight considered and rejected: widening the enum changes the generated
spec (`openapi.json`), which is an additive enum change that could surprise a
strict client-side enum validator. That is a real but ordinary migration cost,
not a reason to leave a credential surface unrecorded — and it is cheaper to pay
once, now, than after #987 has shipped a view advertised as complete.

### IN: webhook registration / deletion → `webhook`

Routes: `POST /` (`src/routes/webhooks.ts:112`, `repo.create(request.body)`),
`DELETE /:id` (`:143`, `repo.delete(request.params.id)` at `:155`).

Reasons to include:

1. **Registering a webhook opens a new outbound data path.** It is a change to
   where workspace data egresses, which is an authorisation-relevant change of
   posture rather than a content edit.
2. **It carries a shared secret.** Stored registrations hold `secret`, projected
   out of every response by `toListedRegistration`
   (`src/routes/webhooks.ts:76`, applied at `:139`, #821) — the same "secret is
   handled here" property that motivates the storage-backend case.
3. **Same structural class as the audited surfaces.** Workspace-scoped,
   request-scoped behind the 401 presence gate (`authGate(app)`,
   `src/routes/webhooks.ts:103`, #711), operator-initiated, low volume.
4. **Deletion is a silent idempotent no-op** (`:153-155`: an unknown or foreign
   id still answers 204 so existence does not leak across workspaces). That is
   correct for the wire, but it means a removal currently leaves no trace at all.
   An audit entry is the right place to retain what the response deliberately
   withholds.

### OUT: Encore instance lifecycle → revisit after #778

Surface: `spawnInstance` (`src/encore-scaler/instance-pool.ts:438`),
`destroyInstance` (`:1092`), `reapOrphanedInstances` (`:1225`),
`reconcilePoolFromOsc` (`:268`), `resolvePendingSpawns` (`:925`).

Reasons to exclude, for now:

1. **The behaviour being recorded is not settled.** Orphan detection, the
   bounded readiness wait, and the reap grace window are all still moving under
   #778 (`src/encore-scaler/types.ts:107, 116, 135, 141, 392`;
   `instance-pool.ts:315, 733, 1129-1134`). Auditing a lifecycle whose state
   transitions are mid-redesign would bake in action names we expect to rename.
2. **The open question is a billing-attribution question, and it is not ours to
   answer here.** The pool's own comments frame spawn/reap as a billing-leak
   problem (`instance-pool.ts:330, 755, 806, 1065, 1205, 1372, 1407`;
   `types.ts:121, 292`). Whether instance-hours need an attributable,
   append-only, retention-governed record is a product and commercial decision
   that interacts with the quota/metering model (ADR-020, quota deployment model
   and metering source). #1001 is a scope call about the audit surface; it should
   not quietly decide the metering substrate.
3. **Volume is wrong for this store.** Audit retention defaults to indefinite
   (ADR-021: `AUDIT_RETENTION_MS` unset means no expiry). A scaler tick stream
   of spawn/drain/reap churn is unbounded system noise that would dominate the
   partition and swamp the operator-intent entries #987 exists to surface.
4. **A better-fitting home already exists.** The durable operational log store
   (`CouchLogStore`, `src/data/couch-log-repo.ts`, #996, surfaced at
   `GET /api/v1/logs`) models exactly this: a durable, queryable, retention-bounded
   message stream for system events. Moving the scaler off `console.warn` and
   onto that store is the right fix for scaler observability, and it is **not**
   an audit widening. Filed separately below.

If #778 lands and the billing answer turns out to require attributable
instance-hours, this ADR should be superseded rather than stretched — the
requirement would then be a metering record, not an audit entry.

### OUT: provisioning / deprovisioning → structurally unsuitable

Routes: `POST /` (`src/routes/provision.ts:644`), `DELETE /:name` (`:1668`).

Reasons to exclude:

1. **The audit store lives inside the thing being provisioned.** Audit writes
   resolve per-stack: `PerWorkspaceAuditEmitter.record()` does
   `(await this.resolver.resolve(currentRequestStackName())).audit` and **no-ops
   when the resolved stack has no durable audit store**
   (`src/data/per-workspace-repos.ts:377-388`). A `provision` entry therefore has
   nowhere to go — the partition does not exist yet — and a `deprovision` entry
   would be destroyed by the very teardown it records. This is not a wiring
   detail that can be worked around inside the current model; it would require a
   control-plane-level audit store, which is a materially larger design than
   #1001 or #986 scopes.
2. **A record already exists, at the right level.** Both routes answer 202 and
   track progress through `OperationStore`
   (`src/services/operation-store.ts:17-24`, `OperationType = 'provision' |
   'deprovision'`), polled via `GET /operations/:id`. The real deficiency is that
   this store is an in-process `Map` and so does not survive a restart — a
   durability bug in the operations surface, not a missing audit target type.
   Filed separately below.

### OUT: scaler config mutation → deferred with the scaler

`PATCH /scaler/config` (`src/routes/scaler.ts:297`) is not named in #1001, but it
is the one scaler mutation that *is* operator-initiated, so it was considered.
It is excluded because it mutates process-local variables
(`liveMaxInstances` / `liveMinInstances` / `liveIdleTimeoutMs`, `:308-310`) rather
than a persisted resource, so there is no stable `targetId` to record against,
and because its semantics move with #778. It should be reconsidered together with
the Encore lifecycle, not separately.

---

## Follow-on issues to be filed

Implementation is explicitly **not** part of #1001. On approval of this ADR,
file:

1. `feat: add 'storage-backend' audit target type and emit register/remove entries (from #1001)`
2. `feat: add 'webhook' audit target type and emit registration/deletion entries (from #1001)`
3. `fix: populate audit actor principalId from request.principal instead of null (from #1001)`
4. `fix: make provision/deprovision operation records survive a restart (from #1001)`
5. `feat: route Encore instance lifecycle to the durable operational log instead of stderr (from #1001)`
6. `fix: revisit Encore instance lifecycle and scaler-config audit scope once #778 and instance billing attribution are settled (from #1001)`

Items 1 and 2 are the scope widening this ADR decides. Items 3-5 are adjacent
gaps surfaced while grounding the decision and are deliberately framed as *not*
audit widenings. Item 6 is the explicit revisit trigger.

---

## Consequences

- **#987 can proceed.** The cross-cutting audit view should be built against five
  target types — `asset`, `collection`, `job`, plus `storage-backend` and
  `webhook` — treating the latter two as known-pending. Concretely, #987 should
  not hardcode a three-value filter list; it should render whatever
  `AUDIT_TARGET_TYPES` publishes so items 1 and 2 land without a frontend change.
- **One generated-spec change is expected, once.** Items 1 and 2 should widen the
  enum together and regenerate `openapi.json` in a single change
  (`pnpm generate:openapi`) rather than shipping two consecutive enum revisions.
- **Audit volume stays operator-scale.** Excluding the scaler keeps the partition
  dominated by intent-bearing entries, which matters because retention defaults
  to indefinite (ADR-021).
- **Scaler observability remains a gap after this ADR**, deliberately. It is
  reassigned to the operational log, not fixed by audit.
- **This is a scope/product call and carries PROPOSED status**, per the
  convention every other ADR in this directory follows. It should be confirmed
  before items 1 and 2 are implemented.

## Alternatives considered

- **Keep scope closed at three types.** Rejected: it leaves the only
  credential-handling route and the only outbound-egress-configuring route with
  no durable record, and it would ship #987 as a view that is complete only by
  definition.
- **Open `targetType` to a free-form string.** Rejected: the closed enum is the
  mechanism that rejects a mis-populated entry at write time
  (`src/data/audit-repo.ts:88,99`), and `emitAudit` is fire-and-forget
  (`src/data/audit-emit.ts:59-75`) so a typo'd target type would be silently
  logged-and-dropped rather than caught. The enum is load-bearing.
- **Widen to everything named in #986 at once.** Rejected on the Encore and
  provisioning grounds above — one is gated on an unsettled billing question, the
  other cannot physically write to the store it would need.
