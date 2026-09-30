# Interaction spec: editing an asset's external ID namespace/value pairs

**Issue:** #909 (broken out from #796).
**Status:** design spec. No production code changes accompany it.
**Audience:** whoever builds the external-ID editor, and anyone writing operator-facing copy for it.

This document pins the **states, validation and copy** for adding, editing and removing the
`{ namespace, id }` external identifiers on an asset. It does not restate the contract; it
cites it. Where the contract does not pin a behaviour, the spec says **PROPOSAL** and names
the decision that is still open — those parts are not established fact and must not be
implemented as if they were.

---

## 0. Contract grounding

Everything below was read from `openapi.json` and the source in this tree on branch
`issue-909/external-id-interaction-spec`. Rows marked *(probe)* were additionally confirmed
by running the routes against the in-memory backend; the probe was scratch and is not
committed.

| What | Exact symbol verified |
|---|---|
| Endpoints that exist | `openapi.json` → `paths["/api/v1/assets/{id}/external-ids"]` exposes exactly `post` and `get`; `paths["/api/v1/assets/{id}/external-ids/{namespace}/{externalId}"]` exposes exactly `delete`. Handlers `src/routes/assets.ts:3154` (POST), `:3296` (GET), `:3228` (DELETE) |
| **There is no `put` or `patch`** | Same paths above. No update verb exists on either path |
| **All three routes resolve the path `:id` by ULID only — a slug is a `404`** | The three handlers pass `request.params.id` straight to an id-keyed repository call: `repo.attachExternalId(request.params.id, …)` (`src/routes/assets.ts:3177`), `repo.detachExternalId(request.params.id, …)` (`:3260`), `repo.get(request.params.id)` (`:3333`). Each returns the same `404 { error: 'not_found' }` when the lookup misses — POST `:3185-3187`, DELETE `:3266-3268`, GET `:3334-3336`. The GET route's own comment states it: *"Resolution goes through `repo.get` (id only), matching the sibling write path … rather than GET `/:id`'s slug fallback"* (`:3287-3289`). Each repository method keys the document store directly with no slug fallback — `src/data/asset-repo.ts:1386-1392` (get), `:1455-1457` (attach preflight), `:1491-1494` (detach preflight); `src/data/couch-asset-repo.ts:122-133`, `:216-219`, `:276-279`. **By contrast `GET /api/v1/assets/{id}` accepts either**, via `resolveAsset`/`isUlid` (`src/routes/assets.ts:3345-3359`, called at `:3388`) |
| A purged asset is `404` here but `410` on the asset route | These routes see a tombstone as not-found (`src/data/asset-repo.ts:1456`, `:1493`; the `resourceType` guards at `src/data/couch-asset-repo.ts:125-131`, `:217`, `:277`), so they answer `404`. `GET /api/v1/assets/{id}` answers `410 { error: 'gone' }` for the same asset (`src/routes/assets.ts:3378-3386`). The `404` on these three routes therefore does **not** distinguish "purged", "never existed" and "addressed by slug" |
| Add request body | `attachExternalIdBodySchema`, `src/routes/assets.ts:496-513` — `namespace: z.string().min(1).max(256)` (`:497-504`), `id: z.string().min(1).max(1024)` (`:505-512`). Both **required**. `additionalProperties: false` in the generated schema |
| Namespace is **free text** | `:497-504` declares only `min`/`max`. No `regex`, no `enum`, no `refine`. A repo-wide search for a namespace enum or registry returns nothing |
| Persisted element shape | `ExternalIdentifierSchema`, `src/data/asset-document.ts:173-182` — exactly `{ namespace: z.string().min(1), id: z.string().min(1) }`. **No `source`, `writer`, `createdAt`, `lastSeenAt` or any other field** |
| Stored under | `administrative.externalIdentifiers`, optional array, `src/data/asset-document.ts:329`. System-owned by ADR-019 §2 (`docs/architecture/ADR-019-external-identifier-namespace-placement.md:75-95`) |
| Set semantics | ADR-019 §1, `docs/architecture/ADR-019-external-identifier-namespace-placement.md:55-73` — an array, because an asset may be correlated to several upstream systems independently |
| Add is **append**, never replace | `src/data/asset-repo.ts:1475-1481` and `src/data/couch-asset-repo.ts:246-253` both spread the existing array and push. Nothing removes a same-namespace entry *(probe: two POSTs with namespace `ingest-mam` and ids `X-1`, `X-2` yield `[{ingest-mam,X-1},{ingest-mam,X-2}]`, both 200)* |
| Add is idempotent for an exact repeat | `src/data/asset-repo.ts:1459-1465`, `src/data/couch-asset-repo.ts:227-234` — a pair the asset already carries returns the asset unchanged, no duplicate row |
| Cross-asset uniqueness is **operator-configurable** | `src/data/external-id-uniqueness.ts:28` — the exported constant is `EXTERNAL_ID_UNIQUENESS_ENV`, whose *value* is the operator-facing env var name `'EXTERNAL_ID_UNIQUENESS'`. Also `:38` (type `ExternalIdUniquenessMode`, modes `advisory` \| `enforced`), `:44` (`DEFAULT_EXTERNAL_ID_UNIQUENESS_MODE`, **default `advisory`**), `:50-60` (`externalIdUniquenessModeFromEnv` — only the literal `enforced`, case-insensitive, turns it on). Read per request at `src/routes/assets.ts:3183` |
| Conflict gate scope | `src/data/asset-repo.ts:1466-1473`, `src/data/couch-asset-repo.ts:235-245` — fires only when the **same `{namespace, id}` pair** already resolves to a **different asset**. Same-asset and same-namespace-different-id never reach it |
| 409 envelope | `externalIdConflictSchema`, `src/routes/assets.ts:519-526`; emitted at `:2677-2686`. Fields: `error` and `reason` both literal `"external_id_conflict"`, plus `namespace`, `externalId`, `conflictingAssetId`, optional `message`. `required: [error, reason, namespace, externalId, conflictingAssetId]` |
| Add success payload | `200` with `assetSchema` (`src/routes/assets.ts:3169`). **`assetSchema` has no `externalIdentifiers` property** — confirmed against `openapi.json` → `paths["/api/v1/assets/{id}"].get…properties` (27 properties, none of them `externalIdentifiers`); the route comments say the same at `src/routes/assets.ts:3274-3279` |
| Read-back | `GET` returns `200` with an array of `{ namespace, id }` **as stored** — persisted order, no dedup, no reformatting (`src/routes/assets.ts:3308-3327`, `:3341`) |
| Empty is a success | `src/routes/assets.ts:3341` → `asset.externalIdentifiers ?? []`. `200 []` for a known asset carrying none; `404 { error: 'not_found' }` only for an unknown asset id (`:3334-3336`) |
| Remove verb | `DELETE` params `src/routes/assets.ts:3239-3255` — `namespace` and `externalId` each `z.string().min(1)`. Responses `204 | 400 | 404` (`:3256`) |
| Remove is idempotent | `src/routes/assets.ts:3266-3270` — `204` whether or not the pair was attached. `404` **only** when the asset itself is unknown |
| Remove drops **every** equal entry | `src/data/asset-repo.ts:1496-1501` filters all entries equal to the pair, so a duplicate accumulated in advisory mode is cleared in one call |
| Namespace grammar is unrestricted in practice | *(probe)* namespaces `a/b`, `has space` and `"  padded  "` all POST `200`, read back byte-identical, and DELETE `204` when percent-encoded into the path. **No trimming, no normalisation, no rejection** |
| 400 body is the Fastify envelope, not a machine code | *(probe)* `POST` with `namespace: ""` returns `{"error":"Bad Request","message":"body/namespace String must contain at least 1 character(s)"}`. `error` is the HTTP reason phrase — it is **not** a stable code, despite `errorSchema` (`src/routes/assets.ts:528`) typing it as `{ error: string, message? }` |
| Authorisation | `resourceAuthorizationPreHandler('asset')`, `src/routes/assets.ts:1743`. Method→action `src/auth/authorize.ts:79-93` (POST→`write`, DELETE→`delete`, GET→`read`); matrix `:54-58` (viewer read-only); 403 code `AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role'`, `:99`; body shape `:105-111` |
| No audit entry is written | `emitAudit` is called at exactly five sites in this router — `src/routes/assets.ts:2743`, `:5174`, `:5519`, `:5609`, `:5738` — and **none** of them is in the external-ID handlers (`POST` body `:3176-3189`, `DELETE` body `:3259-3270`). The neighbouring metadata write *is* audited (`:5172-5174`, action `asset.metadata_updated`) |
| Existing UI primitives to reuse | `escHtml` `public/app.js:59-66`; `fmtDate` `public/app.js:307`; `openModal(title, buildBody, opts)` `public/app.js:945`; `confirmModal(spec)` `public/app.js:1051`. The `spec` keys **this spec uses** — `affected`, `unaffected`, `confirmLabel` — are documented at `:1014-1019`; the *blocked* variant's additional keys (`blocked`, `closeLabel`, `blockedBy`, `resolution`, `secondary`) are documented at `:1021-1041` and are **not** used here. `encodeURIComponent` is the house convention for anything interpolated into a path segment (e.g. `public/app.js:2165`). `.badge` `public/style.css:292`; `.visually-hidden` `:194`; `--accent` `:7`, `--danger` `:11` |

Field names used in this spec — `namespace`, `id`, `error`, `message`, `reason`,
`externalId`, `conflictingAssetId` — are all from the rows above. No other field name appears,
because no other field exists. Where the spec writes `asset.id` and `asset.slug` it means the
`id` and `slug` properties of the asset envelope (`assetSchema`, `openapi.json` →
`paths["/api/v1/assets/{id}"].get`), and it does so only to pin **which one goes in the path**.

---

## 1. Vocabulary and copy rules

| Use | Do not use |
|---|---|
| **external ID** (the pair), **namespace** (the label), **value** (the `id` component in the UI) | "foreign key", "correlation id", "sync key", any vendor or product name |
| **Add** / **Replace** / **Remove** (the three controls) | "Create", "Edit", "Save", "Delete" — see §3 for why "Replace" and not "Edit" |
| **"system of record"** for what a namespace names | "source system", "integration", "connector" — the contract's own word is system of record (`src/routes/assets.ts:478-480`) |

Copy rules:

1. **Never say `id` in the UI label.** The field is called `id` on the wire but sits next to
   the asset's own id on screen. Label it **Value**, and name the wire field only in
   developer-facing help text.
2. **Never claim an external ID is unused, safe to remove, or in use by an integration.** The
   stored record is `{ namespace, id }` and nothing else (`asset-document.ts:173-182`). The UI
   has no way to know. See §6.
3. **Never say removal can be undone.** No audit entry is written and no provenance is
   readable (§0). A removed pair is gone.
4. **Never render a namespace, a value, or `conflictingAssetId` unescaped.** The namespace is
   free text up to 256 characters including `<`, `/` and whitespace *(probe)*; the value is free
   text up to 1024; and `conflictingAssetId` is **server-supplied** (`externalIdConflictSchema`,
   `src/routes/assets.ts:519-526`), so it is not the client's own trusted string either. Route all
   three through `escHtml` (`public/app.js:59-66`) before they reach `innerHTML`.
   **Escaping is not encoding.** Where `conflictingAssetId` lands in an `href` — §5.3's
   `Open the other asset` link — HTML-escaping alone is the wrong tool: it does not neutralise
   `/`, `?`, `#` or `..`, any of which change which URL is fetched. Build the URL with
   `encodeURIComponent(conflictingAssetId)` for the path segment (the convention already used
   throughout `public/app.js`, e.g. `:2165`), then `escHtml` the finished URL if the anchor is
   assembled as a markup string. Prefer setting `a.href` on a created element, which needs no
   HTML escaping at all. The same applies to `namespace` and the value when either is
   percent-encoded into the `DELETE` path (§3).

5. **Address the asset by `asset.id`, never `asset.slug`.** All three external-ID routes accept
   the ULID only; a slug is a `404` (§0). See §5.2.

---

## 2. Namespace and value input constraints

### 2.1 Pinned by the contract

| Rule | Enforcement |
|---|---|
| Namespace required, 1–256 characters | `src/routes/assets.ts:497-504`. Server answers `400` |
| Value required, 1–1024 characters | `src/routes/assets.ts:505-512`. Server answers `400` |
| Namespace is **free text** — no character restriction, no chosen set | `src/routes/assets.ts:497-504` declares no pattern and no enum; no registry exists anywhere in the tree (§0) |
| Both are stored **verbatim** — no trim, no case-fold | `src/data/asset-repo.ts:1477-1480` writes `input.namespace` / `input.id` unmodified *(probe: `"  padded  "` round-trips byte-identical)* |

So the input is a plain text field with `maxlength="256"` / `maxlength="1024"` and a required
marker. **Do not ship a dropdown of allowed namespaces** — there is no set to populate it from,
and a closed list would reject values the API accepts.

### 2.2 PROPOSAL — client-side rules the contract does not impose

These are UX guardrails, not contract facts. Each needs a decision before it ships.

| P | Proposal | Why | Decision needed |
|---|---|---|---|
| **P1** | **Trim leading/trailing whitespace before sending**, silently. | The server stores `"  ingest-mam  "` and `"ingest-mam"` as two different namespaces, and `getByExternalId`'s `$elemMatch` (`src/data/couch-asset-repo.ts:177-191`) is an exact match — so a padded namespace is silently unresolvable forever. | Should the **server** trim instead? If it should, the UI trim is a stopgap and the server change is the real fix. |
| **P2** | **Warn, do not block**, when the namespace does not match `^[a-z0-9]([a-z0-9._-]*[a-z0-9])?$`. Inline, non-blocking: `Namespaces are usually lowercase words joined by hyphens, like ingest-catalogue. This will still be saved as typed.` | The contract's own examples (`ingest-mam`, `rights-registry`, `src/routes/assets.ts:478-479`) follow this shape. A hard block would reject valid API input. | Is there an intended house convention for namespaces? If yes it belongs in the contract, not only in the UI. |
| **P3** | **Suggest, do not restrict.** Back the namespace field with a `<datalist>` seeded from namespaces already seen on assets loaded in this client session. Degrade to a bare text field when the list is empty. | Typo-ing a namespace is the single most damaging mistake here (P1), and consistency across assets is the whole value of the field. | There is **no endpoint that lists distinct namespaces** (verified: no such path in `openapi.json`). A workspace-wide suggestion list needs one. |
| **P4** | Show the character counter only past 80% of the cap. | Caps are generous; a permanent counter implies the limit is close. | None. |

---

## 3. There is no edit operation — "Edit" is Replace, and it is two calls

**Pinned:** the contract exposes `post`, `get` and `delete` only (§0). There is no `PUT` and no
`PATCH`, and `POST` **appends** rather than replacing a same-namespace entry
(`src/data/asset-repo.ts:1475-1481`, probe-confirmed). Changing the value under a namespace is
therefore two non-atomic requests, and the UI must own the sequencing.

**PROPOSAL (P5) — order the two calls POST-then-DELETE, never DELETE-then-POST.**

```
1. POST   /api/v1/assets/{asset.id}/external-ids     { namespace, id: <new value> }
2. DELETE /api/v1/assets/{asset.id}/external-ids/{namespace}/{old value}   (percent-encoded)
3. GET    /api/v1/assets/{asset.id}/external-ids     (re-read; see §4.1)
```

`{asset.id}` is written out deliberately: **all three calls must use the ULID `asset.id`, never
`asset.slug`** (§0, §1 rule 5). A slug in any of these three paths is a `404`, even for a live
asset — unlike `GET /api/v1/assets/{id}`, which accepts either. Where the editor is opened from a
slug-addressed context, resolve the slug through `GET /api/v1/assets/{slug}` first and keep the
returned `id` for the whole session.

Rationale: between step 1 and step 2 **both** values resolve, so a caller round-tripping
through `GET /api/v1/assets/by-external-id/{namespace}/{id}` never sees a gap. The reverse
order opens a window in which neither value resolves. Under `enforced` mode step 1 is still
safe — the gate only fires for a pair already held by a *different* asset
(`src/data/asset-repo.ts:1466-1473`).

Failure handling for the two-call sequence:

| Where it fails | Treatment |
|---|---|
| Step 1 fails | Nothing changed. Report the step-1 error (§5) and leave the row as it was. |
| Step 2 fails | **Both values are now attached.** Do not silently retry. Surface: `The new value was added, but the old value could not be removed. This asset now has two IDs under "{namespace}".` with a `Remove old value` retry button. Refresh the list so the operator sees both. |

Because step 2 can fail, §4.2's "two values under one namespace" state is a **real state the UI
must render**, not a defensive nicety.

---

## 4. States

### 4.1 After every write, re-read

**Pinned trap:** `POST` returns `200` with the full asset, and `assetSchema` carries **no**
`externalIdentifiers` property (§0). The success response therefore does **not** contain the
field the operator just changed. `DELETE` returns `204` with no body at all.

So: **never render the external-ID list from a write response, and never from optimistic local
state.** After any `POST` or `DELETE`, re-issue `GET /api/v1/assets/{asset.id}/external-ids` and
render from that. It is the only endpoint that returns the set. Use the ULID `asset.id` here too
(§1 rule 5) — a slug makes this re-read a `404`, which §5.2 must not misreport as a deleted asset.

### 4.2 The list

| State | Derivation | Renders |
|---|---|---|
| **E0 Loading** | `GET` in flight | Skeleton rows. No empty-state copy — an empty state shown during a load is a lie |
| **E1 Empty** | `200` with `[]` (`src/routes/assets.ts:3341`) | §7 empty state |
| **E2 Populated** | `200` with ≥1 entry | One row per entry, **in the returned order** — the contract guarantees persisted order and no dedup (`src/routes/assets.ts:3324-3327`). Do not sort client-side; resorting hides the duplicate-detection signal below |
| **E3 Duplicated namespace** | Two or more entries share a `namespace` | Render every entry (they are all real), and group them under one namespace heading with an inline notice. See below |
| **E4 Unavailable** | `404 { error: 'not_found' }` | The set could not be read. **Do not assert the asset is gone** — this `404` also covers "addressed by slug" and "purged" (§0). `The external IDs for this asset could not be loaded.` plus a `Retry`, and no editing controls. Only escalate to `This asset no longer exists.` once `GET /api/v1/assets/{asset.id}` has confirmed it (§5.2) |

**E3 is a legitimate persisted state, not corruption.** The API appends and never dedupes by
namespace (§0), and a failed Replace (§3) produces it directly. Notice copy:

> `This asset has {n} IDs under "{namespace}". Round-trip lookups by this namespace resolve to one asset, but which value was used is not recorded. Remove the ones that are no longer correct.`

Do not auto-resolve, auto-remove, or block on E3.

### 4.3 Add

- Control: `Add external ID`, opening `openModal` (`public/app.js:945`) with two fields —
  **Namespace** and **Value** — plus help text naming the wire fields for developers:
  `Sent as {"namespace": …, "id": …}.`
- Submit is disabled only while either field is empty or a length cap is exceeded — the two
  conditions the server actually rejects (§2.1). P2's convention warning never disables submit.
- **Exact repeat is a silent success, by contract.** Adding a pair the asset already carries is
  a server-side no-op returning `200` (`src/data/asset-repo.ts:1459-1465`). The UI must not
  claim it added something. Detect it client-side against the current list and show
  `This asset already has that ID under "{namespace}". Nothing was changed.` rather than
  `Added.`

### 4.4 Remove

Single control per row: `Remove`. See §6 for the confirmation.

---

## 5. Validation errors

### 5.1 Client-side, before the request

| Condition | Message | Blocks submit |
|---|---|---|
| Namespace empty | `Enter a namespace. It names the system this ID belongs to.` | Yes |
| Namespace > 256 chars | `Namespace is too long (maximum 256 characters).` | Yes |
| Value empty | `Enter a value.` | Yes |
| Value > 1024 chars | `Value is too long (maximum 1024 characters).` | Yes |
| Namespace already on this asset with a *different* value | `This asset already has an ID under "{namespace}". Adding another keeps both.` with a `Replace instead` action that runs §3 | **No** — appending is legal (§0) |
| Namespace fails the P2 convention | P2's warning copy | **No** |

Client-side validation is the primary guard, because the server's 400 is not machine-readable:

> **Pinned:** the `400` body is `{"error":"Bad Request","message":"body/namespace String must contain at least 1 character(s)"}` *(probe)*. `error` is the HTTP reason phrase, not a stable code, and `message` is a Zod string. **Never branch on either.** Treat any `400` as a generic `The API rejected these values.` plus the raw `message` in a developer-detail disclosure, and fix the input rules so it stops happening.

### 5.2 Server responses

| Status | Body | Treatment |
|---|---|---|
| `200` | Full asset, **without** `externalIdentifiers` | Success. Re-read per §4.1. Message: `External ID added.` |
| `204` (remove) | Empty | Success. Re-read per §4.1. Message: `External ID removed.` |
| `400` | Fastify envelope (§5.1) | Keep the dialog open. Generic message + raw `message` behind a `Details` disclosure |
| `404` | `{ error: 'not_found' }` | **The asset id did not resolve** — which is *not* the same as "the asset is gone". On `DELETE` it is never "the pair was not attached", which is a `204` (`src/routes/assets.ts:3266-3270`). See §5.4: do **not** render `This asset no longer exists.` on this response alone |
| `409` | `external_id_conflict` envelope (§0) | §5.3 |
| `403` | `{ error: 'forbidden_insufficient_role', message, action, resourceType, role }` (`src/auth/authorize.ts:105-111`) | `Your role cannot change external IDs on this asset. Ask an editor or administrator.` Do not print `action` / `resourceType` / `role` at the operator. There is no capability endpoint, so controls render optimistically and this is handled on arrival |
| network / other | — | `Could not reach the API. Nothing was changed.` Never leave the button pending |

### 5.3 The 409 conflict

**Pinned:** `409` fires only when the **exact pair** already belongs to a **different asset**,
and only when the operator has set `EXTERNAL_ID_UNIQUENESS=enforced`
(`src/data/external-id-uniqueness.ts:44` — the default is `advisory`, and in advisory mode the
same request returns `200`). Same-namespace-different-value on the same asset never produces a
`409`.

Handle it in the add dialog, keeping it open:

> **Title:** `That ID belongs to another asset`
> **Body:** `The ID "{externalId}" under "{namespace}" is already attached to another asset in this workspace, and this deployment does not allow the same external ID on two assets.`
> **Action:** `Open the other asset` — a link built from `conflictingAssetId`. That value is
> server-supplied, so build the URL as `encodeURIComponent(conflictingAssetId)` and escape it if
> the anchor is assembled as markup (§1 rule 4). Do not print the raw id as the link text.
> **Resolution:** `Remove the ID from that asset first, or use a different value here.`

Read `namespace`, `externalId` and `conflictingAssetId` from the body; they are all `required`
(§0). Check `error === 'external_id_conflict'` **before** reading them — `409` is also returned
for `has_children` and for the `delete_blocked` family on other asset routes
(`src/routes/assets.ts:2669-2671`, `:2691-2698`), which carry different shapes.

**Gap (H2, §8):** the client cannot discover which uniqueness mode is running. No endpoint
exposes it. So the add dialog cannot warn in advance that a duplicate will be rejected, and in
advisory mode it cannot warn that a duplicate was silently allowed. Both are handled reactively.

### 5.4 The `404` is ambiguous — do not read it as "this asset was deleted"

**Pinned:** all three external-ID routes resolve `:id` by ULID only, so a **slug returns
`404 { error: 'not_found' }` for a perfectly live asset** (§0: `src/routes/assets.ts:3287-3289`,
`:3333-3336`, and the id-keyed repository lookups at `src/data/asset-repo.ts:1386-1392`, `:1455-1457`,
`:1491-1494`). `GET /api/v1/assets/{id}` accepts a slug (`:3345-3359`, `:3388`), so an editor
opened from a slug-addressed view can load the asset fine and then get a `404` from every
external-ID call. A purged asset is also `404` here while the asset route reports `410` (§0).

One status, three causes. So `404` on these routes means only **"this id did not resolve"**:

| Cause | Distinguishing check | Treatment |
|---|---|---|
| The editor was addressing a **slug** | The value sent is not a ULID | A bug, not an operator-facing condition. Fix by holding `asset.id` (§1 rule 5). Never surfaced as copy |
| The asset was **purged** | `GET /api/v1/assets/{asset.id}` returns `410 { error: 'gone' }` (`src/routes/assets.ts:3378-3386`) | `This asset has been purged.` Close the editor |
| The asset is **unknown** | `GET /api/v1/assets/{asset.id}` also returns `404` | `This asset no longer exists.` Close the editor |

Rule: on a `404` from any external-ID call, **do not close the editor and do not claim the asset
is gone.** Show `The external IDs for this asset could not be loaded.` with a `Retry` (E4, §4.2),
and confirm with a single `GET /api/v1/assets/{asset.id}` before rendering either terminal
message above. Getting this wrong tells an operator a live asset has been deleted, which is the
worst available outcome for a screen whose whole job is cross-system correlation.

---

## 6. Remove confirmation

### 6.1 The honest position on live integrations

The issue asks what happens when an external ID *a live integration also writes to* is removed.
**The UI cannot detect that case.** Verified:

- The persisted record is exactly `{ namespace, id }` — no writer, no source, no timestamps
  (`src/data/asset-document.ts:173-182`).
- No endpoint associates a namespace with an integration, a webhook or a credential (a scan of
  `openapi.json` and `src/routes/webhooks.ts` finds no namespace coupling).
- Nothing is recorded when the pair is attached or detached — neither handler emits an audit
  entry (`src/routes/assets.ts:3176-3189`, `:3259-3270`; the router's five `emitAudit` sites
  are `:2743`, `:5174`, `:5519`, `:5609`, `:5738`).

So the confirmation must **state the consequence unconditionally** rather than detect a
condition it cannot see. Never render "this ID is in use" or "this ID is safe to remove";
both are claims the system cannot support.

### 6.2 Copy

`confirmModal` (`public/app.js:1051`), using the house `affected` / `unaffected` structure:

- `title: 'Remove external ID'`
- `question: 'Remove the ID "{value}" under "{namespace}" from this asset?'`
- `affected`:
  - `Looking this asset up by "{namespace}" and "{value}" will stop working.`
  - `Any integration that still writes this ID may re-attach it on its next sync, or may start creating a duplicate asset instead. This is not detected here — check the upstream system before removing.`
  - `The removal is not recorded anywhere. There is no history to restore it from.`
- `unaffected`:
  - `The asset, its files, its metadata and its other external IDs are untouched.`
  - `No job is started and nothing is queued.`
  - `The upstream record in "{namespace}" is not changed or deleted.`
- `confirmLabel: 'Remove'`, danger styling (`--danger`, `public/style.css:11`).

The last `unaffected` bullet is load-bearing: "Remove external ID" reads, to a media developer,
as though it might delete something upstream. It does not.

The third `affected` bullet must not be softened — it is a direct consequence of §0's
no-audit-entry finding, and it is the only warning the operator gets.

### 6.3 Behaviour

- **One confirmation per removal.** No bulk remove in v1: `DELETE` is per-pair, so a bulk
  action is N non-atomic requests with N partial-failure states, and the copy above cannot be
  written truthfully for a mixed batch.
- **`204` is the only success, and it is unconditional** (`src/routes/assets.ts:3266-3270`). A
  `204` does not prove the pair existed. Re-read per §4.1 rather than asserting a removal.
- **Removing one entry under a duplicated namespace removes only the matching pair** — the
  filter is on the full `{namespace, id}` (`src/data/asset-repo.ts:1496-1501`). In E3 the row
  the operator clicked is the row that goes, and the notice must survive the refresh if others
  remain.

---

## 7. Empty state

Rendered for **E1** only — `200 []` on a known asset. This is a valid state, not an error
(`src/routes/assets.ts:3341`, and the route's own comment at `:3294-3295`).

- Heading: `No external IDs`
- Body: `External IDs link this asset to a record in another system, so you can look it up by that system's own key. Add one when this asset also exists in an ingest catalogue, a rights registry, or any other system of record.`
- Primary action: `Add external ID`
- When the caller's role cannot write (403 already seen this session, or known viewer role):
  drop the action and end the body at the first sentence. Do not render a disabled button —
  `button:disabled` carries no accessible explanation.

Do **not** render the empty state for `404`; that is E4, a different thing, and conflating them
tells the operator that an asset the client could not address simply has no IDs — which on a
slug-addressed editor would be an invented "no external IDs" for an asset that has several (§5.4).

---

## 8. Contract dependencies

### 8.1 Pinned by the verified contract — implement exactly as written

| § | Behaviour | Citation |
|---|---|---|
| 2.1 | Namespace 1–256, value 1–1024, both required, both free text, stored verbatim | `src/routes/assets.ts:496-513`; `src/data/asset-repo.ts:1477-1480` |
| 2.1 | No chosen set of namespaces exists | `src/routes/assets.ts:497-504`; no registry in tree |
| 3 | No update verb; add appends and never replaces | `openapi.json` paths; `src/data/asset-repo.ts:1475-1481` |
| 4.1 | Write responses do not carry the set; a re-read is mandatory | `src/routes/assets.ts:3169` + `assetSchema` property list |
| 4.2 | Order is as persisted; duplicates are returned, not deduped | `src/routes/assets.ts:3324-3327` |
| 4.3 | Exact repeat is a silent `200` no-op | `src/data/asset-repo.ts:1459-1465` |
| 5.1 | `400` body is the Fastify envelope, not a machine code | probe; `src/routes/assets.ts:528` |
| 5.2 | `DELETE` is `204` whether or not the pair existed; `404` is never "pair not attached" | `src/routes/assets.ts:3266-3270` |
| 5.4 | All three routes resolve `:id` by **ULID only**; a slug is `404` even for a live asset, so `404` must not be rendered as "this asset no longer exists" | `src/routes/assets.ts:3287-3289`, `:3177`, `:3260`, `:3333-3336`; `src/data/asset-repo.ts:1386-1392`, `:1455-1457`, `:1491-1494`; `src/data/couch-asset-repo.ts:122-133`, `:216-219`, `:276-279`. Contrast `GET /api/v1/assets/{id}`'s slug fallback at `src/routes/assets.ts:3345-3359`, `:3388` |
| 5.4 | A purged asset is `404` on these routes but `410` on the asset route | `src/data/asset-repo.ts:1456`, `:1493`; `src/routes/assets.ts:3378-3386` |
| 5.3 | `409` shape and its narrow trigger condition | `src/routes/assets.ts:519-526`, `:2677-2686`; `src/data/asset-repo.ts:1466-1473` |
| 5.3 | `409` is reachable only in `enforced` mode; default is `advisory` | `src/data/external-id-uniqueness.ts:44`, `:50-60` |
| 6.1 | No writer/source/timestamp is stored; no audit entry is written | `src/data/asset-document.ts:173-182`; `src/routes/assets.ts:3176-3189`, `:3259-3270` vs the `emitAudit` sites at `:2743`, `:5174`, `:5519`, `:5609`, `:5738` |
| 6.3 | Remove drops every entry equal to the full pair | `src/data/asset-repo.ts:1496-1501` |
| 7 | `200 []` is a valid state distinct from `404` | `src/routes/assets.ts:3334-3341` |

### 8.2 UX proposals awaiting a decision — not contract facts

| P | Proposal | Blocking question |
|---|---|---|
| **P1** | Client trims whitespace before sending | Should the server trim instead? Untrimmed namespaces are permanently unresolvable |
| **P2** | Non-blocking convention warning on namespace shape | Is there an intended house convention? If so it belongs in the contract |
| **P3** | Namespace suggestions from a datalist | Needs an endpoint that lists distinct namespaces (**H1**) |
| **P5** | Replace = POST-then-DELETE, in that order | Should the API gain an atomic replace instead (**H3**)? |
| §4.2 | Treating two values under one namespace as a warning rather than an error | Is one value per namespace per asset the intended rule? If yes, the server should enforce it (**H4**) |
| §6.3 | No bulk remove in v1 | Revisit if a bulk endpoint appears |

### 8.3 Contract gaps this spec routes around

| Id | Gap | Effect |
|---|---|---|
| **H1** | No endpoint lists the distinct namespaces in a workspace | P3 degrades to a bare text field; namespace typos stay easy to make and impossible to spot |
| **H2** | The `EXTERNAL_ID_UNIQUENESS` env var (`EXTERNAL_ID_UNIQUENESS_ENV`, `src/data/external-id-uniqueness.ts:28`) is not discoverable by a client | The add dialog cannot warn in advance that a duplicate will be rejected (or silently accepted). Handled reactively in §5.3 |
| **H3** | No atomic replace; changing a value is two non-atomic calls | §3's partial-failure state (both values attached) is a real state the UI must render |
| **H4** | Nothing enforces one value per namespace per asset, and nothing dedupes on read | E3 is a legitimate persisted state (§4.2) |
| **H5** | `assetSchema` carries no `externalIdentifiers`, so `POST`'s `200` omits the changed field | Mandatory re-read after every write (§4.1). Adding the field to the asset envelope would remove a round trip |
| **H6** | Neither write emits an audit entry, and no provenance is readable | Removal is unrecoverable and invisible; §6.2's third bullet exists because of this. A security-relevant change to a cross-system key leaves no trace in `GET /api/v1/audit` |
| **H7** | `403` is reachable on all three routes but is declared on none of them (`openapi.json` responses are `200/400/404/409`, `204/400/404`, `200/404`) | A generated client models no `403`. §5.2 handles it anyway |
| **H8** | The error envelopes here are `{ error, message? }` and the ad-hoc `409`, not the `{ error: { code, message, details? } }` shape the house API principles describe | This spec follows the shipped contract. Aligning the two is an API-wide decision, not something this feature should do locally |
| **H9** | The accepted id grammar differs between sibling routes and is **invisible in the contract**: `GET /api/v1/assets/{id}` takes a ULID **or** a slug, the three external-ID routes take a ULID only, yet every one of them declares the path parameter as a bare `{"type":"string"}` in `openapi.json` (the `DELETE` adds only the description `"Asset id."`) | A client holding the slug it was given gets `404` on every external-ID call, with nothing in the generated types or the spec to explain why. §5.4 defends against it at the UI layer. The real fixes are either accepting a slug on these three routes, or stating the ULID-only constraint in each path-parameter description so a generated client's docs carry it |

---

## 9. Acceptance checklist

- [ ] No `PUT`/`PATCH` is called; Replace is the §3 POST-then-DELETE sequence, and its
      partial-failure state is rendered (§3).
- [ ] Every write is followed by `GET /api/v1/assets/{asset.id}/external-ids`; nothing renders the
      set from a write response or optimistic state (§4.1).
- [ ] All three external-ID calls address the asset by the ULID `asset.id`; `asset.slug` is never
      interpolated into any of these three paths (§0, §1 rule 5, §3).
- [ ] The namespace field is free text with a `maxlength`, never a dropdown (§2.1).
- [ ] No code branches on the `400` body's `error` or `message` (§5.1).
- [ ] `409` handling checks `error === 'external_id_conflict'` before reading `conflictingAssetId` (§5.3).
- [ ] `DELETE`'s `404` is never treated as "pair not attached" — that case is a `204` (§5.2).
- [ ] No `404` from an external-ID route renders `This asset no longer exists.` on its own. The
      editor stays open with a retry, and a terminal message appears only after
      `GET /api/v1/assets/{asset.id}` returns `404` or `410` (§5.4).
- [ ] The remove confirmation never claims to know whether an integration uses the ID, and
      never implies the upstream record is affected (§6.2).
- [ ] The empty state is shown only for `200 []`, never for `404` or while loading (§7).
- [ ] Duplicate namespaces render as a notice, not an error, and are never auto-resolved (§4.2).
- [ ] Every namespace, value and `conflictingAssetId` is escaped through `escHtml` before display,
      and any of them landing in an `href` or a path segment goes through `encodeURIComponent`
      rather than HTML escaping alone (§1 rule 4).
- [ ] Anything marked PROPOSAL in §8.2 either has a recorded decision or is not shipped.
