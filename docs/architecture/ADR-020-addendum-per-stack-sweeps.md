# ADR-020 addendum: background sweeps run once per provisioned stack

**Status:** ACCEPTED 2026-10-04
**Date:** 2026-10-04
**Author agent:** claude-opus-5 (surface-backend-api)
**Issue:** #1098 (`fix: run main.ts sweeps once per provisioned stack`), closing
the known gap recorded as #1090
**Addendum to:** `docs/architecture/ADR-020-quota-deployment-model-and-metering-source.md`
(Decision 1 — per-deployment cost guardrail) and
`docs/architecture/ADR-018-authorisation-model.md` §3 + its `X-Stack-Name` scope
note (structural per-deployment tenant isolation)

---

## Context

Since #1058 the data plane is keyed by the request's `X-Stack-Name`: documents
and object bytes land on whichever provisioned stack the request named
(`src/services/request-stack-context.ts`; every `PerWorkspace*` repository
resolves the ambient stack at `src/data/per-workspace-repos.ts:99-103`).

The background sweeps wired in `src/main.ts` run OUTSIDE a request, so the
ambient stack is empty and `WorkspaceStackResolver.resolve()` took its
no-`stackName` branch — cache key `''`, which resolves `listStackNames()[0]`,
the FIRST listed stack (`src/services/workspace-stack.ts:906,975-990`). On an
installation with more than one provisioned stack, five sweeps therefore only
ever saw stack 1:

| Sweep | Consequence on stacks 2..N before #1098 |
|---|---|
| archived-asset purge (#327) | archived assets never purged; storage never reclaimed |
| audit-retention purge (#566) | audit entries retained indefinitely in spite of the configured window |
| log-retention purge (#1067) | each stack keeps its own operational log partition, so stacks 2..N retained their log indefinitely in spite of the configured policy |
| abandoned-upload settle (#726) | wedged `uploading` records never settled; permanent orphans in the asset list |
| storage-quota reconcile (#579) | bytes erased from the counter on every sweep (the sweep OVERWRITES the total), so the cap silently UNDER-counted |

Issue #1098 names four of these; the log-retention purge is the fifth because
#1067 landed on `main` after the #1098 branch forked, with the same no-stack-name
resolution and so the same bug. It is wired through the same helper.

PR #1062 had already fixed the same class of bug for the scaler tick's
reconcilers by iterating `WorkspaceStackResolver.listStackNames()`, but the five
sweeps above were left on the single default resolution.

## Decision

**Background sweeps are per-stack: each sweep runs once inside EVERY provisioned
stack's context, on every tick.**

The iteration is one shared helper, `forEachStack` /`perStackSweepRunner`
(`src/services/for-each-stack.ts`), which the scaler tick now also uses so there
is a single mechanism rather than one inline copy per sweep. It:

1. re-reads `listStackNames()` on EVERY pass, so a stack provisioned after boot
   is swept from its next tick with no restart;
2. warms that stack's connections with `resolve(name)` and runs the sweep body
   inside `runWithRequestStack(name, …)`, so the repositories, the audit store
   and the object-storage handles the body resolves are all that one stack's;
3. isolates failures per stack — one stack's error is logged and the remaining
   stacks are still swept;
4. falls back to the single `undefined` context when no stack is listed (no
   parameter store: env override or a bare local run), which is byte-identical
   to the previous behaviour.

### This does not conflict with "one deployment == one tenant"

ADR-018 §3 ("One deployed stack == one tenant's workspace") and ADR-020
Decision 1 (per-deployment cost guardrail, single-tenant) both frame a
deployment as a single tenant. Per-stack sweeps sit UNDER that framing rather
than against it: ADR-018's `X-Stack-Name` scope note already records that
"stacks 2..N belong to the same tenant as stack 1 and the header partitions one
tenant's own storage rather than crossing a trust boundary". Iterating the stacks
therefore introduces no tenant dimension and no per-request identity — it just
stops the sweeps from ignoring most of the one tenant's own data. In a
single-stack deployment (every OSC deployment today) the loop runs exactly once
and behaviour is unchanged.

### Exception for the storage-quota sweep: per-stack ENUMERATION, one write

The quota counter is explicitly ONE deployment-wide number keyed by
`DEPLOYMENT_CONTEXT` (ADR-020 Decision 1; `src/main.ts` quota wiring). So for
this sweep the per-stack rule applies to the enumeration, not to the write:
`makePerStackQuotaSum` (`src/data/storage-quota-stack-sum.ts`) walks every listed
stack, sums each stack's own source + packaged buckets, and returns ONE total
that `reconcileStorageQuota` writes once. Reconciling per stack would be wrong —
each write overwrites the committed total, so the last stack swept would erase
all the others, which is the #1090 under-count with extra steps.

A corollary: **a partial pass is never written.** Every stack is still visited
when one fails, but if any stack could not be summed the walk throws, so
`store.reconcile(total)` is not reached and the counter keeps its last good
value until the next sweep. A short total would silently admit more usage than
the operator configured, which is strictly worse than a stale one on a
billing-adjacent number. A deployment with no object storage on any stack (fresh
install, nothing provisioned yet) likewise declines to write rather than zeroing
the counter, and logs that at info level.

**"Could not be summed" is decided by inspecting the resolution, not by catching
an exception.** This is the correction from the #1141 review: `resolve(name)` is
not "that stack's connections or a throw". It has three silent outcomes that
would each corrupt the one deployment-wide number, so the walk checks for them
directly:

| Resolver outcome | Where | Effect if trusted | Guard |
|---|---|---|---|
| The env-var override (`COUCHDB_URL`/`MINIO_URL`) returns the same connections for every name, while `listStackNames()` still lists the parameter store's stacks — the two are not mutually exclusive, `MINIO_URL` being a documented ops override | `workspace-stack.ts:395-397`, `:1000-1015` vs `:1274-1288` | the same buckets summed once per listed name: **N x the real bytes**, i.e. uploads rejected at ~capacity/N | each distinct object-store identity (endpoint + the two bucket names) is summed at most once per sweep |
| A requested name with no stored config is re-resolved to the FIRST listed stack instead of throwing | `workspace-stack.ts:1052-1065` | stack 1's bytes counted twice, stack N's dropped | `WorkspaceConnections.stackName` (#1058) is compared against the requested name; a mismatch fails the sweep |
| A thrown parameter-store refresh is caught INSIDE the resolver and degrades to last-known-good or to no-storage in-memory connections | `workspace-stack.ts:1083-1125` | that stack contributes 0 bytes and the short total is committed | a LISTED stack that yields no buckets fails the sweep (reason `stack-without-object-storage`) — unless NO stack has object storage, which stays the fresh-install `no-object-storage` decline |

The guards fail closed in the same direction as the rest of this section: the
counter keeps its last good value and the next sweep retries.

## Consequences

- Archived-asset purge, audit expiry, log expiry, upload settling and quota
  accounting are correct on a multi-stack installation; #1090 is closed by this
  change rather than deferred.
- Each sweep's cost grows linearly with the number of provisioned stacks. All
  five are already off the hot path on generous cadences (archived purge 1 h,
  audit retention 1 h, log retention 1 h, abandoned uploads 15 min, quota
  reconcile 6 h) and overlap-guarded, so a long pass skips a tick instead of
  piling up.
- An unreachable stack degrades to "that stack was not swept this tick", logged,
  and is retried on the next tick.
- If the deployment model ever becomes genuinely multi-tenant (ADR-020
  Decision 1's boundary condition), these sweeps become per-tenant and the quota
  sum must be partitioned rather than summed. Nothing here assumes otherwise.

## Contract sources verified

| Claim | Source symbol / line |
|---|---|
| No-name resolution means the first listed stack | `src/services/workspace-stack.ts:994` (`resolve`, `cacheKey = stackName ?? ''`), `:1068-1081` (no-`X-Stack-Name` branch, `resolvedName = names[0]` at `:1080`) |
| Stack list read, empty without a parameter store, never throws | `src/services/workspace-stack.ts:1274-1288` (`listStackNames`) |
| Cached read is keyed identically to `resolve` | `src/services/workspace-stack.ts:1296-1301` (`resolveCached`) |
| Env override wins over the requested name, and is independent of the stack listing | `src/services/workspace-stack.ts:395-397` (`envOverrideConnectionsActive`), `:1000-1015` (override branch, before the parameter store) vs `:1274-1288` |
| An unknown stack name resolves to the first listed stack, it does not throw | `src/services/workspace-stack.ts:1054-1066` (`resolvedName = names[0]` at `:1065`) |
| A caught parameter-store refresh degrades to last-known-good or no-storage connections | `src/services/workspace-stack.ts:1083-1125` (fallback label `in-memory (no object storage)` at `:1102`) |
| Resolved connections carry the stack identity they were built from | `src/services/workspace-stack.ts:190-198` (`WorkspaceConnections.stackName`), set from `resolvedName` at `:381` |
| Object-store identity of a resolution (endpoint + the two bucket names) | `src/services/workspace-stack.ts:362-375` (per stack, `sourceBucket`/`packagedBucket` from `StackConfig`, `s3Config.endpoint` = `config.minioEndpoint` at `:371`), `:537-539` (env override, `endpoint: minioUrl`), `:585-587` (no-storage fallback: default bucket names, `s3Config: undefined`) |
| Ambient stack context is empty outside a request | `src/services/request-stack-context.ts:27-28,46-53` |
| Repositories resolve the ambient stack | `src/data/per-workspace-repos.ts:99-103` |
| Scaler tick already iterated the stacks (#1062) | `src/main.ts`, `reconcileFailedTranscodes` |
| Quota counter is one deployment-wide total | ADR-020 Decision 1; `src/data/storage-quota.ts:99-131`; `src/main.ts` quota wiring |
| Reconcile sums then OVERWRITES the total | `src/data/storage-quota-reconcile.ts:35-42` |
| A thrown sum skips the write and keeps the schedule | `src/data/storage-quota-reconcile.ts:81-96` (`runOnce`/`start`) |
| Stacks 2..N are the same tenant as stack 1 | `docs/architecture/ADR-018-authorisation-model.md` §3 + `X-Stack-Name` scope note |
