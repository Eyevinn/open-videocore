# ADR-020: Quota deployment model and usage-metering source

**Status:** ACCEPTED 2026-09-07
**Date:** 2026-09-07
**Author agent:** claude-opus-4-8
**Issue:** #578 (design spike). Settles the contract for the storage-cap (#579)
and throughput-cap (#580) sub-issues.

---

## Context

open-videocore wants a cost guardrail: a storage cap (#579) and a throughput
cap (#580) so a runaway ingest or transcode load cannot balloon an operator's
OSC bill. Before either cap can be built, two premises must be settled so both
sub-issues build against a fixed contract:

1. **Whose usage is being capped?** A per-deployment guardrail and a
   per-tenant partition on a shared instance are materially different designs
   (the latter needs per-request tenant resolution, per-tenant accounting, and
   fair-share enforcement). We must confirm which one applies.
2. **Where does the storage total come from?** A cap needs an authoritative
   "bytes currently consumed" number. That can come from the object store or
   from an app-maintained running total. The choice affects correctness,
   reconciliation, and the OSC dependency surface.

This is a design spike. The deliverable is this decision; **no enforcement code
is written here.** Every claim below is traceable to a cited source in the repo
as of this branch.

---

## Decision 1 — Deployment model: per-deployment cost guardrail (single-tenant)

**The quota is a per-deployment cost guardrail. It is NOT per-tenant
partitioning on a shared instance.** One deployed open-videocore instance is one
tenant; the cap applies to that whole instance's consumption.

This follows directly from the auth/isolation model, which is **structural, not
in-app**. Tenant isolation is achieved by OSC provisioning a separate set of
backing resources (CouchDB, PostgreSQL, MinIO, Encore) per deploying tenant, so
a deployed instance IS the tenant's workspace. Verified in code:

- `src/auth/workspace.ts:5-17` — the auth wall is a **pure presence gate**;
  open-videocore does not read a per-request workspace/tenant identifier because
  "tenant isolation is structural … a deployed instance IS the tenant's
  workspace. There is no shared backing store across tenants and thus no in-app
  workspace scoping to perform." `requireAuth` (`workspace.ts:37-42`) only
  asserts a bearer token is present; it never resolves identity.
- `src/auth/workspace.ts:26-31` — `DEPLOYMENT_CONTEXT = 'default'` is a single,
  deployment-wide resource context, "NOT a tenant/workspace identifier derived
  from the request."
- `src/data/guard.ts:25-38` — the isolation guards are inert:
  `assertOwned(...)` is intentionally empty, `namespacedId(ctx, localId)`
  returns `localId` unchanged, and `objectPrefix(ctx)` returns `''`. There is
  "no per-workspace document-id prefix, object-key prefix, or cross-workspace
  ownership check."
- `src/data/storage.ts:71-77` — `scopedKey` only normalises the key and rejects
  `..` traversal; it prepends **no** workspace prefix, confirming objects are
  not partitioned by tenant within a deployment.

**Reference to the auth ADR.** The isolation decision is attributed in code to
"ADR-003 / issue #59" (`workspace.ts:3,14`; `guard.ts:3`). Note a numbering
caveat for future readers: in this repo `docs/architecture/ADR-003-delivery-and-stream-url-contract.md`
is the **delivery/stream-URL** ADR (issue #509), not an auth ADR. The
"ADR-003" cited by the auth code refers to the auth-wall isolation decision as
recorded in issue #59 and encoded in `src/auth/workspace.ts` and
`src/data/guard.ts`; those source files are the authoritative statement of the
isolation model this ADR relies on. (Two documents ended up reserving the
"ADR-003" slot; this ADR does not attempt to renumber history — it just points
the reader at the real symbols.)

**Stale-comment note (non-blocking).** `src/routes/storage.ts:9-14` still
describes a `<workspaceId>/` object-key prefix and cross-workspace ownership
checks. That comment is **aspirational/stale**: the actual `objectPrefix` it
would depend on returns `''` (`guard.ts:36-38`), so no such prefix exists at
runtime. The comment should be corrected when #579 touches that router, but it
does not change this decision.

**Consequence / boundary condition.** If a future **shared multi-tenant hosting
mode** is ever planned (many tenants on one deployed instance), it MUST first
revisit the auth model in `src/auth/workspace.ts` (re-introduce per-request
tenant resolution) and would materially change this quota design (per-tenant
accounting + fair-share enforcement instead of a single instance-wide total).
Until then, #579 and #580 build a **single instance-wide** cap and MUST NOT
introduce a per-request tenant/workspace dimension.

---

## Decision 2 — Storage-accounting source: app-maintained running total, with object-store reconciliation

**Primary source of truth for "bytes consumed" is an app-maintained running
total**, reconciled against the object store. We do not depend on the object
store surfacing an authoritative aggregate-usage metric, because it does not
expose one today (see the OSC-dependency note below).

### Why not "read the total from the object store"

The object store is MinIO (ADR-001, `minio-minio`). The code accesses it only
through per-object operations — there is **no aggregate-usage / total-bytes
call** anywhere in the codebase:

- `src/data/storage.ts:92-102` — `statObject(localKey)` returns
  `{ size, etag }` for a **single** object.
- `src/data/storage.ts:223-236` and `242-255` — `list()` /
  `listUnderPrefix(prefix)` stream **object keys** via `listObjectsV2`; they do
  not sum sizes.
- `src/routes/storage.ts:307-341` (`listBounded`) lists at most
  `MAX_OBJECTS = 200` objects per call (`storage.ts:29`) and is capped/bounded
  by design — it is a browsing surface, not an accounting surface.

Deriving a live total by streaming `listObjectsV2` across the whole bucket on
every write is an O(n-objects) scan that scales poorly and races with concurrent
mutations; it is unsuitable as the hot-path enforcement source. MinIO exposes no
cheap authoritative "bucket bytes used" figure through the client surface the app
uses.

### The app already captures per-object size

A per-asset byte count is already modelled and persisted, so a running total is
cheap to maintain incrementally:

- `src/data/asset-document.ts:238` — the persisted document carries
  `administrative.storage = { bucket, key, sizeBytes }`.
- `src/data/asset-document.ts:356,397-403` — `toAssetDocument(asset, { …,
  storageSizeBytes })` writes that `sizeBytes` on persist.
- `statObject().size` (`storage.ts:92-95`) provides the authoritative per-object
  size at write time to populate it.

### The decision

- **Maintain a running total** (a single counter for the deployment, keyed by
  `DEPLOYMENT_CONTEXT`) updated transactionally on the events that change
  storage: successful source upload, packaged-output write, rendition write, and
  retention/deletion. Each delta is the authoritative per-object `sizeBytes`
  already available from `statObject` / the asset document. #579 owns the exact
  counter store and event wiring.
- **Reconcile periodically** against ground truth by streaming
  `listObjectsV2` over the source + packaged buckets and summing object sizes
  (a batch sweep, NOT on the write hot path), then correcting drift in the
  counter. This is the same listing mechanism already used by the retention
  sweep, so no new object-store capability is required for reconciliation. #579
  owns the reconciliation cadence.
- **Fallback / degraded mode.** If the counter is lost or suspected wrong (e.g.
  after a crash mid-write), the cap treats the state as unknown and a
  reconciliation sweep re-establishes the authoritative total before the cap is
  re-armed. The batch sweep is the recovery path; the counter is the fast path.

This gives correct, cheap enforcement on the hot path (counter) with a
self-healing ground-truth anchor (reconciliation), and it does **not** block on
OSC surfacing a new metric.

### Open OSC dependency (does not block this decision)

If OSC/MinIO later surfaces an **authoritative aggregate bucket-usage metric**
that is cheap to read, #579 MAY adopt it as the reconciliation ground truth
(replacing the full `listObjectsV2` sweep), simplifying the design. Because no
such authoritative usage metric is available through the client surface the app
uses today, this is logged as OSC friction (see below). The absence is **not**
blocking: the app-maintained-counter + list-and-sum reconciliation strategy
above stands on its own.

---

## Acceptance mapping (issue #578)

- **Deployment model decided** (Decision 1): per-deployment cost guardrail,
  single-tenant, referencing the auth isolation model in `src/auth/workspace.ts`
  and `src/data/guard.ts` (attributed to "ADR-003 / issue #59" in code).
- **Storage-accounting source decided** (Decision 2): app-maintained running
  total as source of truth, with a documented `listObjectsV2`-sum reconciliation
  fallback and a crash-recovery path.
- **OSC metering gap logged**: friction note filed in the agents repo at
  `docs/osc-feedback/incoming-issue578-object-store-usage-metric.md`.

---

## Contract sources verified

| Claim | Source symbol / line |
|---|---|
| Auth is a pure presence gate, no tenant resolution | `src/auth/workspace.ts:5-17,37-42` |
| Single deployment-wide context, not a request tenant | `src/auth/workspace.ts:26-31` (`DEPLOYMENT_CONTEXT`) |
| Isolation guards inert (no prefix, no ownership check) | `src/data/guard.ts:25-38` |
| Object keys not tenant-prefixed at runtime | `src/data/storage.ts:71-77` (`scopedKey`) |
| Per-object size available + persisted | `src/data/storage.ts:92-95`; `src/data/asset-document.ts:238,356,397-403` |
| No aggregate-usage metric; only per-object stat / key listing | `src/data/storage.ts:223-255`; `src/routes/storage.ts:29,307-341` |
| ADR-003 slot is the delivery contract, not auth | `docs/architecture/ADR-003-delivery-and-stream-url-contract.md:1-8` |
