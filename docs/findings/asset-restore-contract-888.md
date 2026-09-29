# Contract note: `POST /api/v1/assets/{id}/restore` — response + error contract (issue #888)

**Verdict: the endpoint reports outcomes honestly. The success body is the FULL
updated asset; `410` is `{ "error": "gone", "message": "asset has been purged" }`;
and there is NO retention/remaining-window field anywhere on the asset document
or the restore response — a UI must compute it, or the "show remaining window"
requirement must be descoped. See §4.**

**Scope: verification + documentation only — no production code changed.**

Verified on branch `issue-888/restore-contract-note`, based on `origin/main`
(`df04e92`, which includes `ac5c1b3` "audit the asset restore transition and lock
its honest 200/404/410 reporting (closes #930)"). Every shape below was read from
this tree's route source and from the generated `openapi.json`, and re-checked by
running `npx vitest run test/asset-restore.test.ts` (21 passed) against the live
route (CLAUDE.md rule 7). Nothing is taken from the issue text.

Relationship to #930: that PR changed behaviour (it added the missing
`asset.restored` audit entry) and locked it with tests, but wrote **no operator-
or UI-facing note**. This file is that note, and it additionally answers the
retention-window question #930 never touched.

---

## 1. The route

| Item | Value | Contract source |
|---|---|---|
| Verb + path | `POST /api/v1/assets/{id}/restore` | `src/routes/assets.ts:5645-5646` (`app.post('/:id/restore', …)`), mounted at prefix `/api/v1/assets` |
| Declared responses | `{ 200: assetSchema, 404: errorSchema, 410: errorSchema }` | `src/routes/assets.ts:5650` |
| Published spec | `openapi.json` → `paths["/api/v1/assets/{id}/restore"]` has exactly the `post` key, whose `responses` keys are exactly `200`, `404`, `410` | `openapi.json`; asserted at runtime in `test/asset-restore.test.ts:427-437` |
| Path param | `id` only — `z.object({ id: z.string() })` | `src/routes/assets.ts:5649` |
| Request body | none | no `body` in the route schema (`:5648-5651`) |

`{id}` here means the **ULID id only**. Unlike `GET /:id` (which resolves a slug
via `resolveAsset`, `src/routes/assets.ts:3363`), the restore handler passes the
raw param straight to `repo.restore(id)`, which is keyed by document id
(`src/data/couch-asset-repo.ts:653-655` does `couch.get(id)`;
`src/data/asset-repo.ts:1733` does `this.store.get(id)`). **A slug therefore
returns 404, not a restore.**

---

## 2. Success: `200` — the full updated asset

The handler returns `reply.code(200).send(restored)` where `restored` is the
value the repository actually persisted (`src/routes/assets.ts:5665,5688`). It is
**not** a bare status code and **not** a partial/`{status}` projection: the
response schema is `assetSchema` (`src/routes/assets.ts:811-…`, serialised with
`additionalProperties: false`), the same schema `GET /api/v1/assets/{id}` returns.

Top-level fields in the 200 body, read from
`openapi.json` → `paths["/api/v1/assets/{id}/restore"].post.responses["200"]
.content["application/json"].schema.properties`:

```
id, name, slug, description, status, reviewState, deleteLock, storageTiering,
parentId, versionOfAssetId, versionGroupId, objectKey, statusHistory,
technicalMetadata, technicalMetadataError, sceneMetadata, sceneDetectionError,
manifestUrls, packagingError, renditions, thumbnails, metadata, audioTracks,
subtitleTracks, tags, createdAt, updatedAt
```

`required`: `["id", "name", "status", "statusHistory", "createdAt", "updatedAt"]`.
`additionalProperties: false` — nothing outside that list can appear.

### The transition IS visible in the body

- `status` is the post-restore lifecycle state: `ready` when the pre-archive
  status was `ready`, otherwise `failed` (`restoreTargetStatus`,
  `src/data/asset-repo.ts:1006-1014`).
- `statusHistory` (`src/routes/assets.ts:855`, item shape
  `{ at: string, from: status|null, to: status }`) has **one appended entry**
  `{ "at": <ISO>, "from": "archived", "to": "ready" | "failed" }` as its last
  element; the earlier `-> archived` entry is preserved (append, never rewrite —
  `applyRestore`, `src/data/asset-repo.ts:1022-1030`).
- `updatedAt` is refreshed to the restore instant.

Illustrative (field values elided; shape is the one above):

```json
{
  "id": "01J…",
  "name": "…",
  "status": "ready",
  "statusHistory": [
    { "at": "2026-09-20T10:00:00.000Z", "from": null, "to": "uploading" },
    { "at": "2026-09-20T10:04:00.000Z", "from": "processing", "to": "ready" },
    { "at": "2026-09-25T08:30:00.000Z", "from": "ready", "to": "archived" },
    { "at": "2026-09-29T09:15:00.000Z", "from": "archived", "to": "ready" }
  ],
  "createdAt": "2026-09-20T10:00:00.000Z",
  "updatedAt": "2026-09-29T09:15:00.000Z"
}
```

**The 200 is honest.** `test/asset-restore.test.ts:439-460` asserts the response
body is byte-for-byte equal to an independent `GET /api/v1/assets/{id}` read-back
and that the store itself holds the new status with exactly one `from: archived`
entry. A real restore also emits exactly one `asset.restored` audit entry
(`src/routes/assets.ts:5677-5687`), queryable via `GET /api/v1/audit`.

### One honest limitation worth surfacing in a UI

Restore moves the **lifecycle** axis only. The orthogonal `storageTiering` axis
is untouched (`src/routes/assets.ts:5640-5644`; the schema is representation-only,
`src/routes/assets.ts:218-244`), so an asset whose bytes sit on the `archive`
tier comes back as `status: "ready"` while those bytes are still cold. Read
`storageTiering.tiers.*` from the same 200 body before promising playability.

**`provenance` is NOT on the wire.** The repo does append a
`{ at, by: 'user', op: 'restore', detail }` provenance entry
(`src/data/couch-asset-repo.ts:678-681`), but `provenance` is absent from
`assetSchema` and from `openapi.json`. `statusHistory` plus the audit log are the
only HTTP-observable evidence of a restore.

---

## 3. Failure modes

Both failure bodies use the shared envelope `errorSchema =
z.object({ error: z.string(), message: z.string().optional() })`
(`src/routes/assets.ts:503`) — in the spec:
`{ type: object, properties: { error, message }, required: ["error"],
additionalProperties: false }`.

### `410 Gone` — the retention sweep has tombstoned the document

Exact body, verbatim from `src/routes/assets.ts:5662`:

```json
{ "error": "gone", "message": "asset has been purged" }
```

Guard: `src/routes/assets.ts:5659-5664`. It runs **only when the path param is a
ULID** (`isUlid(id)` → `repo.getState(id)` → `state.kind === 'tombstone'`). The
tombstone is not revived and no audit entry is emitted
(`test/asset-restore.test.ts:516-533`). This is the same `error`/`message` pair
`GET /:id` returns for a tombstone (`src/routes/assets.ts:3356`), so a client can
treat the two identically.

Consequence for a non-ULID param: a purged asset's **former slug** drops out of
the slug index, so it resolves to `404`, not `410`. Only the id preserves the
"existed and was intentionally purged" distinction.

### `404 Not Found` — two distinct causes, one indistinguishable body

Exact body, verbatim from `src/routes/assets.ts:5667`:

```json
{ "error": "not_found" }
```

(`message` is omitted, not null.) It is returned whenever `repo.restore(id)`
resolves `undefined`, which covers **both**:

1. the id is unknown (or is a slug, per §1), and
2. the asset exists but is **not currently `archived`** — nothing to restore
   (`src/data/couch-asset-repo.ts:656-660` — unknown/wrong-type at `:656-658`,
   not-archived at `:659-661`; `src/data/asset-repo.ts:1733-1736`).

The CouchDB path re-checks the guard **inside** the conflict-retry loop
(`src/data/couch-asset-repo.ts:665-669`), so a concurrent writer that leaves
`archived` first yields "no restore" → 404 rather than a fabricated transition
(`test/asset-restore.test.ts:536`). A 404 changes no state and emits no audit
entry (`test/asset-restore.test.ts:477-514`), including on a repeated restore:
the second call is a truthful 404, not an idempotent 200.

**Gap G1 — the two 404 causes are not machine-distinguishable.** A UI cannot tell
"no such asset" from "this asset is live, there is nothing to restore" without a
follow-up `GET /:id`. If the UI needs to say "already restored", it must do that
extra read. Splitting the cause (e.g. `error: "not_archived"`) would be a
breaking change to the envelope and is deliberately not proposed here.

### Undeclared-but-reachable: `401` and `403`

Every asset route sits behind two plugin-scoped preHandlers
(`src/routes/assets.ts:1708,1718`):

- `401` `{ "error": "unauthorized", "message": <reason> }` plus a
  `WWW-Authenticate: Bearer` header, for a missing/invalid bearer token
  (`src/auth/middleware.ts:44-49`).
- `403` `{ "error": "forbidden_insufficient_role", "message": …, "action": "write",
  "resourceType": "asset", "role": <role|null> }` when the caller's role may not
  `write` an asset — `POST` maps to the `write` action
  (`src/auth/authorize.ts:99-116,150-165`).

**Gap G2 — neither is declared on this path in `openapi.json`** (its `responses`
keys are exactly `200`/`404`/`410`). A generated client will treat a 401/403 as
an unmodelled failure. This is a spec-wide pattern, not specific to restore, so it
is recorded here rather than fixed in this note.

### Not reachable

`409 delete_blocked` (ADR-020) belongs to `DELETE /:id`, not to restore: a
delete-lock never blocks a restore (ADR-020 decision 4). Restore has no
`?force=true` and no `409`.

---

## 4. Retention window: **not exposed — no such field exists**

**Answer to the issue's second scope item: there is NO retention-expiry or
remaining-window value in the asset document, in the restore response, or in any
per-asset response.** Checked exhaustively: the 200 property list in §2 is the
complete set (`additionalProperties: false`) and contains no `archivedAt`,
`purgeAfter`, `expiresAt`, `retentionMs`, or equivalent. Repository-wide,
`archivedAt` exists **only** on the tombstone document written *after* purge
(`src/data/asset-tombstone.ts:66`), which is never served over HTTP.

What a client *can* assemble, and exactly how the sweep computes the same thing:

1. **`archivedAt`** — derive client-side as the `at` of the **last** transition
   whose `to === "archived"` in `statusHistory`, falling back to `updatedAt`.
   That is precisely `archivedAtOf()` (`src/data/asset-tombstone.ts:87-95`), the
   function the sweep itself uses (`src/pipeline/archived-asset-purge-sweep.ts:146`).
   `statusHistory` is present on both `GET /api/v1/assets/{id}` and the list
   endpoint `GET /api/v1/assets/` (`openapi.json` list item schema includes
   `statusHistory`), so `GET /api/v1/assets/?status=archived` is enough.
2. **`retentionMs`** — instance-global, from
   `GET /api/v1/retention/config` → `{ "retentionMs": <int≥0>,
   "auditRetentionMs": <int≥0> }` (`src/routes/retention.ts:96-107`, mounted at
   `/api/v1/retention`, `src/main.ts:2113-2124`; in the spec as
   `paths["/api/v1/retention/config"]`). Note this route is intentionally not
   behind `authenticate` (`src/routes/retention.ts:16-18`).
3. **Remaining window** ≈ `archivedAt + retentionMs - now`, the inverse of the
   sweep's eligibility test `archivedAtMs > cutoff`, `cutoff = now - retentionMs`
   (`src/pipeline/archived-asset-purge-sweep.ts:128,146-150`).

### Why that client-side computation is only an approximation

- **`retentionMs === 0` means never purge** (`RETENTION_DISABLED_MS`,
  `src/routes/retention.ts:36`; early return at
  `src/pipeline/archived-asset-purge-sweep.ts:124-126`). A UI must render
  "no expiry", not a countdown to zero.
- **The window is hot-swappable at runtime** via `PATCH /api/v1/retention/config`
  (`src/routes/retention.ts:109-128`). Any client-cached `retentionMs` can go
  stale mid-session, silently moving every displayed deadline.
- **Expiry ≠ purge.** The sweep runs on a timer, default **1 hour**
  (`DEFAULT_PURGE_INTERVAL_MS`, `src/pipeline/archived-asset-purge-loop.ts:31`,
  overridable via `ARCHIVE_PURGE_INTERVAL_MS`), so an asset stays restorable for
  up to one extra tick after its deadline passes. A countdown that hits zero does
  **not** mean the next restore returns 410.
- **A parent with any live child is skipped** and deferred to a later tick
  (`src/pipeline/archived-asset-purge-sweep.ts:153-163`), extending its effective
  window by an amount the client cannot see.
- **The unparseable-timestamp case refuses to purge**
  (`src/pipeline/archived-asset-purge-sweep.ts:147-150`).

So a computed remaining window is a **lower bound on the truth, presented as a
deadline** — honest only if labelled approximate.

### Recommendation

**Preferred — expose it server-side (small, additive, non-breaking).** Add a
read-only `retention` object to `assetSchema`, populated only while
`status === "archived"`:

```jsonc
"retention": {
  "archivedAt": "2026-09-25T08:30:00.000Z",  // archivedAtOf(asset)
  "purgeAfter": "2026-10-25T08:30:00.000Z",  // null when retentionMs === 0
  "retentionMs": 2592000000                   // the effective window at read time
}
```

This costs one derived field, reuses `archivedAtOf()` (no new expiry logic and no
second source of truth), and keeps the window authoritative at read time so a
hot-swapped `PATCH /config` cannot leave a stale client deadline. `purgeAfter:
null` carries "never purge" explicitly. It does **not** remove the sweep-cadence
imprecision — the field is still an earliest-possible-purge time, and should be
documented as such.

**Fallback — descope.** If the field is not added, the "show remaining window"
requirement should be **descoped from the first UI iteration**, not implemented
client-side by hand: doing it by hand requires an extra unauthenticated config
fetch, re-implements `archivedAtOf` in the browser, and displays a deadline the
backend does not guarantee. A restore-availability affordance ("restore" is
offered; a 410 says it is gone) is honest without a countdown.

This note does **not** implement either option — it records the finding so the
UI issue can choose.

---

## 5. Adjacent observations (not in scope, recorded so they are not lost)

- **G3 — stale line citations in ADR-020.**
  `docs/architecture/ADR-020-delete-protection-contract.md:110,260` cite the
  restore route as `src/routes/assets.ts:3741-3767` and the 410 as `:3757-3758`.
  The route is now at `:5645-5690`, 410 at `:5659-5664`. The ADR's *claims* remain
  correct; only the line anchors drifted. `test/asset-restore.test.ts:18,20`
  likewise cites `:5637-5638` and `:5642` (now `:5645-5646`, `:5650`).
- **G4 — ADR-020 decision 4 mandates the purge sweep skip any asset with
  `administrative.deleteLock.locked === true` as defence in depth
  (`ADR-020-delete-protection-contract.md:243-252`). No `deleteLock` predicate
  exists in `src/pipeline/archived-asset-purge-sweep.ts`.** An asset that reached
  `archived` before being locked is therefore still purgeable. Belongs to the
  enforcement issue, not here.

## 6. Acceptance criteria → where answered

| #888 criterion | Answer |
|---|---|
| Exact success payload | §2 — full `assetSchema` asset, status `ready`\|`failed`, appended `{from:"archived",to:<target>}` `statusHistory` entry; property list and `required` quoted from `openapi.json` |
| Exact `410` payload | §3 — `{"error":"gone","message":"asset has been purged"}` (`src/routes/assets.ts:5662`), ULID-only guard |
| Other failure modes | §3 — one `{"error":"not_found"}` for both unknown-id and not-archived (gap G1); undeclared 401/403 (gap G2) |
| Does a retention-window field exist | §4 — **no**, stated explicitly, with the exhaustive property list as evidence |
| Propose adding it or descope | §4 — additive read-only `retention` object preferred; otherwise descope the countdown from the first UI iteration |

## Contract sources verified

- `src/routes/assets.ts:503` (`errorSchema`), `:811` (`assetSchema`), `:855`
  (`statusHistory`), `:1708,1718` (auth preHandlers), `:3356,3363` (`GET /:id`
  tombstone + slug resolution), `:5645-5690` (the restore route).
- `src/data/asset-repo.ts:996` (interface), `:1006-1014` (`restoreTargetStatus`),
  `:1022-1030` (`applyRestore`), `:1728-1745` (in-memory `restore`).
- `src/data/couch-asset-repo.ts:653-686` (CouchDB `restore`).
- `src/data/asset-tombstone.ts:66` (tombstone `archivedAt`), `:87-95` (`archivedAtOf`).
- `src/pipeline/archived-asset-purge-sweep.ts:124-163` (window + eligibility).
- `src/pipeline/archived-asset-purge-loop.ts:31` (sweep cadence).
- `src/routes/retention.ts:36,96-128`; `src/main.ts:2113-2124` (mount prefix).
- `src/auth/middleware.ts:36-53`; `src/auth/authorize.ts:99-116,126-165`.
- `openapi.json` → `paths["/api/v1/assets/{id}/restore"]`,
  `paths["/api/v1/assets/"]`, `paths["/api/v1/retention/config"]`.
- Runtime check: `npx vitest run test/asset-restore.test.ts` — 21 passed.
