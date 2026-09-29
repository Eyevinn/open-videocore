# Contract note: asset & collection delete-lock (`/:id/lock`) — issue #892

**Verdict: the endpoints EXIST and are governed by an ADR. The parent issue's
premises were wrong on three counts (verb, ADR location, and which ADR covers
auth).**
**Scope: verification + documentation only — no production code changed.**

Verified on branch `issue-892/lock-unlock-contract`, based on `origin/main`
(`ff359c7`). Every shape below was read from this tree's source and from the
generated `openapi.json` (CLAUDE.md rule 7). Nothing is taken from the issue text.

---

## Corrections to the parent issue (#788) / #892 premises

1. **The verb is `PUT`, not `POST`.** The lock is a sub-resource with
   `PUT` (set) / `DELETE` (clear): `src/routes/assets.ts:5575` (`app.put('/:id/lock', …)`)
   and `src/routes/assets.ts:5609` (`app.delete('/:id/lock', …)`). Confirmed in the
   generated spec: `openapi.json` → `paths["/api/v1/assets/{id}/lock"]` exposes exactly
   `put` and `delete`. There is **no** `POST /:id/lock`. A UI calling `POST` gets a 404
   from the router, not a lock.
2. **ADR-020 does exist — in the product repo, not the agents repo.**
   `docs/architecture/ADR-020-delete-protection-contract.md` (this repo), added by
   commit `f344ab3` "feat(adr): define delete-protection contract (ADR-020) (#592)".
   The agents repo (`eng-open-videocore-agents`) keeps a **separate, lower-numbered
   ADR series** (`ADR-001`, `ADR-002-credential-storage`, `ADR-003-auth-model`,
   `ADR-005-asset-metadata-framework`, `ADR-006-encore-autoscaler`) and has no
   ADR-020. Looking for ADR-020 there is what produced the "no ADR-020 exists"
   claim. **The two repos' ADR numbers are not the same series** — see gap G1.
3. **"ADR-003 auth model" resolves to two different documents.** In the agents repo
   `docs/architecture/ADR-003-auth-model.md` is the auth ADR (APPROVED 2026-06-02).
   In *this* repo `docs/architecture/ADR-003-delivery-and-stream-url-contract.md` is
   the delivery/stream-URL contract and says nothing about auth. The authorisation
   model actually implemented in this codebase is
   `docs/architecture/ADR-018-authorisation-model.md` (this repo), which already
   documents that the older "ADR-003" citations were a stale doc gap
   (`ADR-018-authorisation-model.md:47-64`). See gap G2.

ADR-020's own status is **PROPOSED**, not ACCEPTED
(`docs/architecture/ADR-020-delete-protection-contract.md:3`) — yet the contract is
fully implemented and tested. See gap G3.

---

## 1. Endpoints

| Method | Path | Purpose |
|---|---|---|
| `PUT` | `/api/v1/assets/{id}/lock` | set the asset delete-lock (`src/routes/assets.ts:5575`) |
| `DELETE` | `/api/v1/assets/{id}/lock` | clear the asset delete-lock (`src/routes/assets.ts:5609`) |
| `PUT` | `/api/v1/collections/{id}/lock` | set the collection delete-lock (`src/routes/collections.ts:449`) |
| `DELETE` | `/api/v1/collections/{id}/lock` | clear the collection delete-lock (`src/routes/collections.ts:478`) |

The `/api/v1/assets` and `/api/v1/collections` prefixes are the router mount points;
the generated spec lists all four paths (`openapi.json` →
`paths["/api/v1/assets/{id}/lock"]`, `paths["/api/v1/collections/{id}/lock"]`).

Both lock routes are **idempotent overwrites**, not create-once: `PUT` on an
already-locked asset succeeds with 200, replaces `reason`/`lockedBy`, refreshes
`lockedAt` to *now*, and appends a **second** `lock` provenance entry
(`applyDeleteLock`, `src/data/asset-repo.ts:1062-1087` — it builds a fresh lock
object unconditionally and always appends). `DELETE` on an already-unlocked asset
also returns 200 and appends an `unlock` entry. There is **no 409 "already locked"**.

## 2. Request bodies

Identical for assets and collections (`src/routes/assets.ts:5582-5587`,
`src/routes/collections.ts:454-459`):

```
PUT /:id/lock
body (optional, defaults to {}):
  reason?:   string, max 1024   // operator note
  lockedBy?: string, max 256    // actor label
```

`additionalProperties: false` (generated: `openapi.json` →
`paths["/api/v1/assets/{id}/lock"].put.requestBody`). Note the spec marks
`requestBody.required: true` because of the Zod `.default({})`, but every property
is optional — `{}` is a valid body.

`DELETE /:id/lock` takes **no body and no query parameters**
(`src/routes/assets.ts:5612-5615` declares only `params`). In particular there is no
`force` on this route.

## 3. Responses

| Status | Body | Source |
|---|---|---|
| `200` | the **full asset** (`assetSchema`) / **full collection** (`collectionSchema`) | `src/routes/assets.ts:5588`, `:5614`; `src/routes/collections.ts:460`, `:483` |
| `404` | `{ error: "not_found" }` (base envelope `{ error, message? }`) | `src/routes/assets.ts:5598`, `:5620`; `errorSchema` at `src/routes/assets.ts:503` |

After `PUT` the returned asset carries `deleteLock` populated; after `DELETE` the
field is **absent** (not `locked: false`) — `applyDeleteLock` returns
`deleteLock: undefined` on unlock (`src/data/asset-repo.ts:1083-1086`). The UI must
treat **absent ⇒ unlocked**.

`deleteLock` object (`deleteLockSchema`, `src/routes/assets.ts:528-533`; domain type
`DeleteLock`, `src/data/asset-repo.ts:441-446`; persisted at
`administrative.deleteLock`, `src/data/asset-document.ts:333` and mapped at
`:490-495` / `:643-648`):

```
deleteLock: {
  locked:    boolean   // required
  lockedAt:  string    // required, ISO-8601, server-generated
  reason?:   string
  lockedBy?: string
}
```
Generated confirmation: `openapi.json` →
`paths["/api/v1/assets/{id}/lock"].put.responses["200"]…properties.deleteLock`,
`required: ["locked","lockedAt"]`.

## 4. Auth — which roles may lock vs unlock

The governing ADR is **ADR-018** (this repo), not ADR-003. Enforcement is a
router-scoped preHandler, not a per-route scope:

- `src/routes/assets.ts:1718` — `app.addHook('preHandler', resourceAuthorizationPreHandler('asset'))`
- `src/routes/collections.ts:247` — the same hook with `'collection'`

The gate derives the action **from the HTTP method only** — `methodToAction`,
`src/auth/authorize.ts:76-90`: `GET/HEAD → read`, `POST/PUT/PATCH → write`,
`DELETE → delete`. The matrix is `MATRIX` at `src/auth/authorize.ts:54-58`
(transcribed from ADR-018 decision 1):

| Role | `PUT /:id/lock` (action `write`) | `DELETE /:id/lock` (action `delete`) |
|---|:--:|:--:|
| `viewer` | denied 403 | denied 403 |
| `editor` | allowed | allowed |
| `admin` | allowed | allowed |
| unrecognised header ⇒ `role: null` | denied 403 (fail closed, `src/auth/authorize.ts:69-72`) | denied 403 |

There are **no OAuth scopes** and no lock-specific permission: locking and unlocking
are covered by the generic `write` / `delete` actions on the `asset` (or
`collection`) resource type. Consequences the UI must handle:

- Denial body is `{ error: "forbidden_insufficient_role", message, action, resourceType, role }`
  with HTTP 403 — `AuthorizationFailureBody`, `src/auth/authorize.ts:99-111`.
  This is distinct from the 401 presence gate (`.code(401)` at `src/auth/middleware.ts:47`).
- **Lock and unlock are not separable by role today.** `editor` and `admin` both have
  `write` *and* `delete`, so anyone who can lock can also unlock. The only role that
  is refused is `viewer`, which is refused both. A "lock but never unlock" role does
  not exist.
- The role comes from the trusted header `X-OVC-Role` (`ROLE_HEADER`,
  `src/auth/principal.ts:36`), and **only** when the deployment sets
  `OVC_TRUST_ROLE_HEADER=true` (`src/main.ts:483-485`). Otherwise the header is
  stripped and every authenticated caller resolves to `admin`
  (`if (!opts.trustRoleHeader)` strip at `src/auth/principal.ts:199`; absent-principal
  default branch `src/auth/authorize.ts:145-147`).
  **On a default deployment the lock UI is available to every authenticated caller.**

## 5. Provenance entries written on lock / unlock

Produced by `applyDeleteLock` (`src/data/asset-repo.ts:1062-1087`), appended to the
asset's `provenance` array (`administrative.provenance`). Entry type
`ProvenanceEntry`, `src/data/asset-repo.ts:270-275`:

```
{ at: string, by: ProvenanceActor, op: string, detail?: string }
```

| Operation | `op` | `by` | `at` | `detail` |
|---|---|---|---|---|
| lock (`PUT`) | `"lock"` | `"user"` | server `now`, same value as `deleteLock.lockedAt` | the request's `reason`, or absent when no reason was sent |
| unlock (`DELETE`) | `"unlock"` | `"user"` | server `now` | never set |

Exact lines: lock entry `src/data/asset-repo.ts:1079`
(`{ at: now, by: 'user', op: 'lock', detail: input.reason }`); unlock entry
`src/data/asset-repo.ts:1085` (`{ at: now, by: 'user', op: 'unlock' }`). Asserted by
`src/routes/assets.delete-lock.test.ts:95-114` ("records lock/unlock in the
administrative provenance trail").

Note `lockedBy` is stored on the lock object but is **not** copied into the
provenance entry — the entry's actor is always the coarse `'user'`. To render "who
locked this", the UI must read `deleteLock.lockedBy`, not the provenance actor.

> **Blocker for UI work — see gap G4: provenance is not reachable through the API.**
> `assetSchema` (`src/routes/assets.ts:811-887`) has **no `provenance` property**, so
> Fastify's response serializer drops it from every asset response, including the
> 200 from `PUT/DELETE /:id/lock`. A scan of the generated spec for any operation
> mentioning `provenance` returns **zero** paths. The lock/unlock trail is written to
> the document but is currently **unreadable by any client**.

**Collections have no provenance array at all.** The `Collection` type is flat
(`src/data/collection-repo.ts:19-50`, with `deleteLock?: DeleteLock` at `:50`), and
ADR-020 pins the lock's own `lockedAt`/`lockedBy` as the record of the change for
collections (`src/routes/collections.ts:444-446`). Asserted by
`src/routes/collections.delete-lock.test.ts:106` ("records the change via the lock
object (lockedAt / lockedBy)").

## 6. `?force=true` on `DELETE /:id` when a lock is present

**No — `force` makes no difference at all. The response is byte-identical.**

- `force` is declared only on the asset delete route:
  `querystring: z.object({ force: z.coerce.boolean().optional() })`,
  `src/routes/assets.ts:5484`.
- The lock guard is **unconditional and runs first**, before `force` is ever read:
  `src/routes/assets.ts:5499-5502` (`if (existing?.deleteLock?.locked) throw new DeleteProtectedError(...)`).
  `request.query.force` is consulted only much later, for the *soft*
  member-of-collection block (`src/routes/assets.ts:5533`).
- Both with and without `force` the caller gets HTTP **409** with the shared
  `delete_blocked` envelope (`deleteBlockedSchema`, `src/routes/assets.ts:542-549`;
  mapped from `DeleteProtectedError` at `src/routes/assets.ts:2666-2673`;
  `DeleteProtectedError.statusCode = 409`, `src/data/asset-repo.ts:801-807`):

```json
{
  "error": "delete_blocked",
  "message": "asset <id> is protected from deletion by an explicit lock",
  "reason": "delete_protected",
  "blockedBy": { "jobIds": [], "collectionIds": [] }
}
```

`reason` is one of `referenced_by_job` | `member_of_collection` | `delete_protected`
and `blockedBy` is required with both arrays present (generated:
`openapi.json` → `paths["/api/v1/assets/{id}"].delete.responses["409"]`, an `anyOf`
of the `delete_blocked` shape and the base `{ error, message? }` envelope — the base
arm still serves the pre-existing `has_children` block).

Asserted by `src/routes/assets.delete-lock.test.ts:79-93` ("does NOT let
`?force=true` bypass the lock" — expects 409 and `reason === 'delete_protected'`,
and that the asset is still not archived) and by the collection equivalent
`src/routes/collections.delete-lock.test.ts:87`.

**UI implication:** there is no distinct status or error code to branch on. A UI
cannot detect "lock present" from a forced delete any differently than from an
unforced one, and must not offer "force delete" as a way past a lock. The only way
to lift protection is `DELETE /:id/lock`.

---

## Gaps flagged (for the sub-issues / whoever owns the docs)

- **G1 — Two divergent ADR series.** The product repo and the agents repo both
  number ADRs from 001 with different content (`ADR-003` is the delivery/stream
  contract here, the auth model there). Any cross-repo "ADR-0NN" citation is
  ambiguous. Cross-references should name the repo, or the series should be
  reconciled.
- **G2 — Stale "ADR-003 auth model" citations.** Issue #892's "see ADR-003 auth
  model" points at the *agents* repo. For this codebase the authority is ADR-018
  (this repo), which itself records that the old `src/auth`/`src/data` "ADR-003"
  citations were a doc gap (`ADR-018-authorisation-model.md:47-64`).
- **G3 — Implemented-but-PROPOSED ADRs.** ADR-020 (`:3`) and ADR-018 (`:3`) are both
  still `PROPOSED 2026-09-04` while their contracts are shipped and tested. Worse,
  agents-repo ADR-003 (APPROVED) explicitly rules out what ADR-018 implements —
  "no role hierarchy (viewer/editor/admin), and no per-operation permission model in
  v1" (`ADR-003-auth-model.md:54`), deferring it to a follow-up ADR
  (`:56`, `:102`, `:108`). ADR-018 *is* that follow-up but was never moved to
  APPROVED, so the shipped role gate currently contradicts the only APPROVED auth
  ADR. **Needs an approval decision, not more code.**
- **G4 — Provenance is written but not exposed (blocks the UI requirement).** The
  issue asks for "the exact provenance-entry fields … so the UI can render them".
  The fields are pinned above, but no endpoint returns them: `assetSchema`
  (`src/routes/assets.ts:811-887`) omits `provenance`, and no path in `openapi.json`
  mentions it. **A sub-issue must add read access** (expose `provenance` on the asset
  response, or a dedicated history endpoint) before any lock-history UI is buildable.
- **G5 — No audit-log entry for lock/unlock.** The asset router emits audit entries
  for `asset.created` (`src/routes/assets.ts:2722`), `asset.metadata_updated`
  (`:5153`), `asset.status_changed` (`:5462`) and `asset.archived` (`:5552`), but the
  two lock handlers (`:5591-5601`, `:5617-5623`) call no `emitAudit`. A deliberate,
  security-relevant operator action is therefore absent from `GET /api/v1/audit`.
  Decide whether that is intended.
- **G6 — `delete` action for an unlock is a method artefact.** Clearing a lock is
  semantically a *write* to the administrative namespace, but because the gate maps
  method→action (`src/auth/authorize.ts:76-90`) it is authorised as `delete`. It is
  harmless today (`editor`/`admin` hold both), but it means the matrix can never
  express "may lock, may not unlock" without a route-level action override.
