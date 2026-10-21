# Interaction spec: delete-lock state across the asset list, asset detail, and protected-delete flows

**Issue:** #893 (broken out from #788). Implemented against by #894 (list), #895 (detail), #896 (protected delete).
**Status:** design spec. No production code changes accompany it.
**Audience:** whoever implements the three feat sub-issues, and anyone writing operator-facing copy about the lock.

This document pins the **states, copy and iconography** for one feature — the explicit
delete-lock — so the three sub-issues ship one pattern instead of three. It does not
restate the contract; it cites it. Where the contract cannot support a design, the design
says so rather than inventing a field.

---

## 0. Contract grounding

Everything below was read from the generated spec and the source in this tree on branch
`issue-893/lock-state-interaction-spec`. Nothing is taken from the issue text.

| What | Exact symbol verified |
|---|---|
| Lock object shape | `openapi.json` → `paths["/api/v1/assets/{id}/lock"].put.responses["200"].content["application/json"].schema.properties.deleteLock` — properties `locked`, `reason`, `lockedAt`, `lockedBy`; `required: ["locked","lockedAt"]`; `additionalProperties: false` |
| Lock object on the **detail** payload | `openapi.json` → `paths["/api/v1/assets/{id}"].get.responses["200"]…properties.deleteLock` (same shape). Responses declared: `200`, `404`, `410` |
| Lock object on the **list** payload | `openapi.json` → `paths["/api/v1/assets/"].get.responses["200"]…properties.items.items.properties.deleteLock` — present. Envelope is `{ items, limit, offset, total }` |
| Lock object **absent** from the canonical search payload | `openapi.json` → `paths["/api/v1/search/"].get.responses["200"]…properties.assets.items.properties` = `id, name, description, status, parentId, objectKey, statusHistory, technicalMetadata, technicalMetadataError, manifestUrls, packagingError, renditions, metadata, createdAt, updatedAt, type` — **no `deleteLock`**. Source schema `assetSchema`, `src/routes/search.ts:78` |
| Set / clear endpoints | `openapi.json` → `paths["/api/v1/assets/{id}/lock"]` exposes exactly `put` and `delete`. Handlers `src/routes/assets.ts:5575` (PUT), `:5609` (DELETE). There is no `POST` |
| Lock request body | `paths["/api/v1/assets/{id}/lock"].put.requestBody` — `required: true`; schema `{ reason?: string (maxLength 1024), lockedBy?: string (maxLength 256) }`, `default: {}` |
| Blocked-delete envelope | `openapi.json` → `paths["/api/v1/assets/{id}"].delete.responses["409"]` — `anyOf` of `{ error: "delete_blocked", message?, reason: "referenced_by_job" \| "member_of_collection" \| "delete_protected", blockedBy: { jobIds: string[], collectionIds: string[] } }` (required: `error`, `reason`, `blockedBy`) and the base `{ error, message? }` |
| Delete query params | `paths["/api/v1/assets/{id}".delete].parameters` — `force` (query, optional), `id` (path, required) |
| List query params (no lock filter) | `paths["/api/v1/assets/"].get.parameters` — `limit`, `offset`, `status` (enum `uploading, processing, ready, failed, archived`), `parentId`, `from`, `to` |
| Lock is a hard block; `force` is not consulted | `src/routes/assets.ts:5499-5502` (guard runs first) vs `:5533` (`force` read afterwards); `DeleteProtectedError.statusCode = 409`, `src/data/asset-repo.ts:801-807` |
| Re-lock is an idempotent overwrite | `applyDeleteLock`, `src/data/asset-repo.ts:1062-1087` — builds a fresh lock unconditionally, refreshes `lockedAt` to now, replaces `reason`/`lockedBy` |
| Unlock removes the field | `src/data/asset-repo.ts:1083-1086` returns `deleteLock: undefined` — **absent, not `locked: false`** |
| Authorisation | `resourceAuthorizationPreHandler('asset')`, `src/routes/assets.ts:1718`; method→action map `src/auth/authorize.ts:76-90`; matrix `:54-58`; 403 body `AuthorizationFailureBody` `:99-111` |
| Prior contract note | `docs/findings/asset-lock-contract-892.md` (issue #892) — this spec is the UI half of it and reuses its gap numbering where it overlaps |
| Governing ADR | `docs/architecture/ADR-020-delete-protection-contract.md` §1 (409 envelope), §2 (lock is a hard block, `force` not honoured), §3 (lock lives in `administrative`, not user-writable) |
| Existing UI conventions reused | `.badge` / `.badge-attention` `public/style.css:292,324`; row accent `tr.row-wedged` `:331`; `button:disabled` `:475`; `.visually-hidden` `:194`; `confirmModal(spec)` `public/app.js:976`; asset row actions `public/assets-table.js:425-445`; detail action bar `public/app.js:2236-2245`; note-under-control pattern `public/app.js:2259-2269` |

Field names used in this spec — `deleteLock.locked`, `deleteLock.lockedAt`,
`deleteLock.lockedBy`, `deleteLock.reason`, `error`, `message`, `reason`,
`blockedBy.jobIds`, `blockedBy.collectionIds` — are all from the rows above. No other
field name appears.

---

## 1. Vocabulary and copy rules

One noun, one verb, everywhere. Divergent wording is the main thing this spec exists to prevent.

| Use | Do not use |
|---|---|
| **delete lock** (the thing), **Locked** (the badge), **locked** (the adjective) | "protection lock", "retention hold", "freeze", "write lock", any vendor or product name |
| **Lock** / **Unlock** (the two buttons) | "Enable protection", "Remove lock", "Disable", "Release" |
| **"protected from deletion"** (why the archive is refused) | "you do not have permission" (that is the 403, a different thing) |
| **Archive** for `DELETE /api/v1/assets/{id}` | "Delete". The route soft-deletes to `archived` (`src/routes/assets.ts:5474-5560`); the existing UI already says Archive and must keep saying it |
| **"clear the lock"** as the resolution | "force delete", "override", "delete anyway" — `force` is never an escape hatch for a lock (ADR-020 §2) |

Copy rules:

1. Never promise an outcome the API has not delivered. The lock is one of four guards on
   archive (`src/routes/assets.ts:5499-5540`), so "unlock and this will archive" is false.
   Say "clearing the lock removes *this* block".
2. Never say the lock is written to the audit log. It is not — see gap **G5**.
3. Never render an inferred lock state. Absent projection means unknown, not unlocked
   (see state **L0**).
4. Timestamps render through the existing `fmtDate` helper (`public/app.js:254`), never raw
   ISO-8601, and never as a relative age ("2 days ago") — there is no server clock exposed
   to calibrate against.

---

## 2. State model

All three surfaces derive from the same four states. Implementations must use this exact
derivation; do not re-derive per surface.

| State | Derivation | Meaning |
|---|---|---|
| **L0 Unknown** | The asset object comes from a projection that does not carry `deleteLock` at all — today, the canonical search response (`paths["/api/v1/search/"]`, §0) | Lock state is not knowable client-side. Render neutral, promise nothing |
| **L1 Unlocked** | `deleteLock` absent, **or** `deleteLock.locked !== true`, on a payload that does carry the field | Not protected |
| **L2 Locked** | `deleteLock.locked === true` | Protected. `deleteLock.lockedAt` is guaranteed present (`required`); `lockedBy` and `reason` are each independently optional |
| **L3 Stale** | A `409` with `reason === "delete_protected"` arrived for an asset the client last saw as L1 or L0 | Another client locked it, or the row is from a projection without the field. Treat as L2 and refresh |

Derivation helper (shared, one place — pair it with the existing `isAssetWedged`):

```
lockStateOf(asset, { projectionCarriesLock })
  -> 'unknown'   when !projectionCarriesLock
  -> 'locked'    when asset.deleteLock && asset.deleteLock.locked === true
  -> 'unlocked'  otherwise
```

Two traps this closes, both verified:

- **Unlock leaves no tombstone.** After `DELETE /:id/lock` the field is gone, not
  `locked: false` (`src/data/asset-repo.ts:1083-1086`). Any check shaped
  `asset.deleteLock.locked === false` throws on an unlocked asset; any check shaped
  `'deleteLock' in asset` reports a *locked* asset after unlock. Only the derivation above
  is correct.
- **`locked` and `lockedAt` are both required, but `locked` is a real boolean.** The schema
  permits `{ locked: false, lockedAt: … }`. Treat anything other than `true` as L1 and do
  not render its `lockedAt`/`reason`, or the UI will show lock metadata for an unlocked asset.

Permission overlays the state but is not part of it. There is **no capability endpoint** —
a scan of `openapi.json` paths for `/me`, `auth`, `role`, `capabilities` or `session`
returns nothing — so the UI cannot know in advance whether this caller may lock. Controls
are therefore rendered optimistically and the `403` is handled when it arrives (§4.4).

---

## 3. Surface A — asset list (#894)

**Goal:** identify a locked asset without opening it.

### 3.1 Placement

One badge in the existing **Status** cell, appended after the status badge, exactly where
the "Needs attention" flag already sits (`public/assets-table.js:399-410`). No new column:
the table already carries seven, and lock is a rare, secondary attribute.

Plus one row accent, mirroring `tr.row-wedged` (`public/style.css:331-333`) so the flag
survives horizontal scrolling:

```css
tr.row-locked td:first-child { box-shadow: inset 3px 0 0 var(--accent); }
```

`--accent` (indigo, `public/style.css:7`), deliberately **not** `--warning` and **not**
`--danger`. A lock is a deliberate operator state, not a fault and not an error. Amber is
already spoken for by the wedged flag; reusing it would say "something is wrong".

### 3.2 States

| State | Renders |
|---|---|
| L1 Unlocked | Nothing. No badge, no accent, no empty placeholder. Absence is the signal |
| L2 Locked | Status cell: `<span class="badge badge-locked">Locked</span>` after the status badge. Row gets `row-locked` |
| L0 Unknown | Nothing, same as L1 — but the Archive action must fall back to the 409 path (§5.4), because the row genuinely does not know. See **H1** |

A row can be both wedged and locked. Order in the cell is: status badge, `Needs attention`,
`Locked` — fault first, then policy.

### 3.3 Copy

- Badge text: **`Locked`** (the `.badge` rule uppercases it).
- Badge `title`: **`Delete-locked. Archiving is refused until the lock is cleared.`**
- Badge also carries a `.visually-hidden` suffix so screen readers get the same sentence
  the sighted tooltip gives:
  `<span class="visually-hidden">: archiving is refused until the lock is cleared</span>`.
  A `title` alone is not exposed reliably; the badge word alone does not say what it costs.
- `deleteLock.reason` is **not** rendered in the list. It is free text up to 1024 characters
  and will destroy the row height. It belongs on detail (§4.2).

### 3.4 What this surface must not do

- **No "Locked only" filter, and no locked-first sort.** `GET /api/v1/assets/` accepts only
  `limit, offset, status, parentId, from, to` (§0) — there is no lock predicate. A
  client-side filter would silently narrow the current page while the table's `total` kept
  reporting the unfiltered count, which is the exact failure the assets table already warns
  about for page-scoped narrowing (`public/assets-table.js:539-540`). If a locked filter is
  wanted, it needs a server-side parameter first. Tracked as **H2**.
- **No lock/unlock action in the row.** Locking is a deliberate act that takes an optional
  reason; it belongs on detail, behind the asset's full context. One place to lock means one
  place to get the copy right.

---

## 4. Surface B — asset detail (#895)

**Goal:** show the current lock state with its owner and timestamp, and offer the two controls.

### 4.1 Placement

A **"Delete protection"** block in the detail panel, directly above the existing action row
(`public/app.js:2236`, `.mt12.flex-gap`). It renders in both L1 and L2 — unlike Restore,
which is correctly hidden unless the asset is archived, lock state is always meaningful, and
an always-present block is where an operator learns the feature exists.

The control itself joins the existing action row so all asset actions stay on one line:
`[Restore?] [Lock | Unlock] [Extract Metadata] [Thumbnails]`. Lock sits first among the
always-present actions because it gates the destructive one.

### 4.2 States and copy

**L1 Unlocked**

- Block heading: `Delete protection`
- Body (muted, 12px, matching the restore-note pattern at `public/app.js:2259-2263`):
  `Not locked. This asset can be archived, subject to the other checks (running jobs, child assets, collection membership).`
- Button: `Lock`, class `btn-ghost`, `aria-describedby` pointing at the body text above.

**L2 Locked**

- Block heading: `Delete protection`
- Status line, assembled from what is actually present:

  | Available fields | Line |
  |---|---|
  | `lockedBy` and `reason` | `Locked by {lockedBy} on {fmtDate(lockedAt)}.` then, on its own line, `Reason: {reason}` |
  | `lockedBy`, no `reason` | `Locked by {lockedBy} on {fmtDate(lockedAt)}.` then `No reason recorded.` |
  | no `lockedBy`, `reason` | `Locked on {fmtDate(lockedAt)}.` then `Reason: {reason}` |
  | neither | `Locked on {fmtDate(lockedAt)}.` then `No reason recorded.` |

  Never substitute a placeholder actor. `lockedBy` is a free-text actor label the caller
  chose, not a resolved identity — do not label it "user" or "owner" when it is missing.
  `reason` renders as plain text, escaped, clamped to three lines with the full value in the
  element's `title`.
- Supporting sentence: `Archiving this asset is refused while the lock is set. The lock cannot be forced.`
- Buttons: `Unlock` (`btn-ghost`) and `Edit lock note` (`btn-ghost`, secondary).

**L0 Unknown** does not occur on this surface: `GET /api/v1/assets/{id}` carries
`deleteLock` (§0). If the field is missing from a detail payload, that is a contract
regression — render `Lock state unavailable.` with no controls rather than guessing.

### 4.3 The two dialogs

**Lock** — a form, so `reason` and `lockedBy` can be supplied. `confirmModal` takes no
inputs, so use `openModal(title, builder)` directly.

- Title: `Lock asset`
- Intro: `Locking prevents this asset from being archived until the lock is cleared. It does not change the asset's status and does not move or delete any files.`
- Field `Reason (optional)` — textarea, `maxlength="1024"`, placeholder
  `Why this asset must not be deleted`. Helper: `Up to 1024 characters.`
- Field `Locked by (optional)` — text input, `maxlength="256"`, placeholder
  `Who or what is asking for the lock`. Helper: `A free-text label, up to 256 characters. It is not verified against your identity.`
- Buttons: `Cancel`, `Lock` (`btn-sm`, **not** `btn-danger` — locking destroys nothing).
- Request: `PUT /api/v1/assets/{id}/lock` with a JSON body **always present**. Send `{}`
  when both fields are blank; a body-less PUT is rejected with a `400 FST_ERR_VALIDATION`
  before the handler runs (§0 → `requestBody.required: true`). Omit blank fields rather than
  sending `""`.
- The `maxlength` attributes are a courtesy, not the guard: the server enforces both caps
  and answers 400. Handle that 400 inline in the dialog (§4.4) rather than closing it.

**Edit lock note** — the same form, prefilled from the current `deleteLock`, with one extra
line the operator must see before saving, because re-locking is an overwrite and not a patch
(`src/data/asset-repo.ts:1062-1087`):

> `Saving replaces the current reason and "locked by" label, and resets the lock timestamp to now.`

**Unlock** — `confirmModal`, reusing the house `affected` / `unaffected` structure
(`public/app.js:976-1020`):

- `title: 'Clear delete lock'`
- `question: 'Clear the delete lock on "{name}"?'`
- `confirmLabel: 'Unlock'`
- `affected`:
  - `This asset becomes archivable again. Anyone who can archive an asset can then archive it.`
  - `The reason and "locked by" label recorded with the lock are discarded, not kept as history.`
- `unaffected`:
  - `Nothing is deleted or moved. The asset's status, files, renditions and metadata are untouched.`
  - `Other assets and collections keep their own locks.`
- Request: `DELETE /api/v1/assets/{id}/lock`, no body, no query parameters.

The second `affected` bullet is load-bearing and must not be softened: the discarded lock is
genuinely unrecoverable through the API, because the provenance trail that records it is not
readable (gap **G4**).

### 4.4 Non-happy paths

Both requests return the **full asset** on `200`. Re-render the detail from that response
rather than from an optimistic local edit — it is the only way the UI learns the
server-generated `lockedAt`, and the only way it notices an unknown body key was silently
dropped (gap **G7**).

| Outcome | Treatment |
|---|---|
| `200` | Close the dialog, re-render from the returned asset, write a one-line confirmation into the existing action-message area: `Asset locked.` / `Delete lock cleared.` |
| `403` (`error: "forbidden_insufficient_role"`) | Keep the dialog open. Inline: `Your role cannot change the delete lock on this asset. Ask an editor or administrator.` Then hide the Lock/Unlock buttons for the rest of the session's view of this asset — a control that is known to fail should stop being offered. Do not print the raw `action`/`resourceType`/`role` fields at the operator |
| `400` (`FST_ERR_VALIDATION`) | Keep the dialog open, mark the offending field: `Reason is too long (maximum 1024 characters).` / `"Locked by" is too long (maximum 256 characters).` The 400 body is the Fastify envelope `{ statusCode, code, error, message }`, **not** `{ error, message? }` — parse defensively |
| `404` (`{ error: "not_found" }`) | Close the dialog, re-render the detail: the asset is gone. `This asset no longer exists.` |
| Network / other | `Could not reach the API. The lock was not changed.` Never leave the button in its pending state |

No status other than `200` and `404` is declared for either lock operation
(`openapi.json`, §0), yet `400` and `403` are both reachable. Handle them anyway; see **H3**.

---

## 5. Surface C — protected delete (#896)

**Goal:** a locked asset's Archive control explains the protection instead of failing opaquely.

### 5.1 Decision: keep the control enabled, block the confirmation

The Archive control stays **enabled** for a locked asset. It does not become `disabled`.

Reasoning, stated here so the sub-issue does not relitigate it:

1. A `disabled` button is removed from the tab order and carries no accessible explanation.
   The one thing this issue asks for — telling the operator *why* — is precisely what
   `button:disabled` (`public/style.css:475`: `opacity: .5; cursor: not-allowed`) cannot do.
2. The list cannot always know. Rows in state **L0** (search results, §0) have no lock field,
   so a disabled-on-lock rule would be applied inconsistently across the same table.
3. The lock is one of four guards. A control disabled only for the lock still fails opaquely
   for the other three, which teaches the operator that an enabled Archive means "this will
   work" — a promise the API does not make.

So: the control stays live, and the **confirmation dialog** becomes the explanation point.
This also keeps one code path for the pre-flight case (state known) and the post-flight case
(409 arrived), which is what stops the two from drifting apart.

### 5.2 The blocked dialog

`confirmModal` today always renders `Cancel` plus a danger confirm (`public/app.js:1022-1036`).
#896 adds a **blocked variant**: when `spec.blocked` is truthy, the confirm button is not
rendered, the cancel button is labelled `Close`, and the promise resolves `false`. Additive,
no behaviour change for existing callers.

Content for a locked asset:

- `title: 'Archive blocked'`
- `question: '"{name}" is protected from deletion.'`
- `detail: 'A delete lock is set on this asset, so the API refuses to archive it. Nothing has changed.'`
- `affected`: *(empty — nothing is affected, and saying so explicitly is the point)*
- `unaffected`:
  - `The asset, its files and its metadata are untouched.`
  - `No job was started and nothing was queued.`
- Resolution line, rendered under the lists:
  `To archive this asset, clear its delete lock from the asset's detail view first. The lock cannot be forced.`
- Buttons: `Close`. Where the caller has the asset's detail available, add a secondary
  `Open detail` that navigates to it. Do **not** put an `Unlock` button in this dialog:
  unlocking mid-archive-flow turns two deliberate decisions into one click.

### 5.3 Why no "force" affordance, ever

`?force=true` is declared on the delete route (§0) and is genuinely honoured — for
collection membership. It is **never** consulted for a lock: the lock guard throws at
`src/routes/assets.ts:5499-5502`, before `request.query.force` is read at `:5533`. The
response is byte-identical with and without it (asserted by
`src/routes/assets.delete-lock.test.ts:79-93`).

Therefore no surface may offer "force", "delete anyway", "override" or "retry" for a locked
asset. Offering a retry that is guaranteed to fail identically is worse than offering
nothing. The only resolution is `DELETE /api/v1/assets/{id}/lock`.

### 5.4 Handling the 409 when the lock was not known in advance

Required for L0 rows and for L3 races. On a `409` from `DELETE /api/v1/assets/{id}`, branch
on the body — and branch **defensively**, because the declared schema is an `anyOf` whose
second arm is the bare `{ error, message? }` envelope that still serves the pre-existing
`has_children` block (§0):

| Body | Treatment |
|---|---|
| `error === "delete_blocked"` and `reason === "delete_protected"` | Open the §5.2 blocked dialog. `blockedBy.jobIds` and `blockedBy.collectionIds` are both `[]` here by contract — do not render an empty "blocked by" list |
| `error === "delete_blocked"` and `reason === "referenced_by_job"` | Blocked dialog, job wording, naming `blockedBy.jobIds` |
| `error === "delete_blocked"` and `reason === "member_of_collection"` | Blocked dialog, membership wording, naming `blockedBy.collectionIds` |
| `error === "delete_blocked"`, `reason` anything else | Blocked dialog with generic wording. The enum is closed by ADR-020 §1 but a client must not crash on a future member |
| No `reason` key (base envelope arm, e.g. `has_children`) | Blocked dialog with generic wording built from `message`. **Never read `.reason` or `.blockedBy` without checking** — they are absent on this arm |

Replace the current `alert('Error: ' + err.message)` fallback
(`public/app.js:1554`) for the 409 case. An `alert` is the opaque failure this issue exists
to remove.

After showing the dialog, refresh the affected row so the `Locked` badge appears — the
client has just learned the true state.

### 5.5 Collection parity

Collections carry the same `deleteLock` shape and the same hard-block semantics
(`openapi.json` → `paths["/api/v1/collections/{id}/lock"]`, methods `put` and `delete`;
guard at `src/routes/collections.ts:403-406`). The collection list already reads
`c.deleteLock.locked` and warns in its delete dialog (`public/app.js:3083`, `:3151-3154`),
but it still lets the operator confirm a delete that cannot succeed.

Not in scope for #894-#896, but when collections are next touched they should adopt §5.2
verbatim: same blocked dialog, same resolution sentence with "collection" substituted. Two
different explanations for one mechanism is the outcome this spec exists to prevent.

---

## 6. Iconography

**There is no icon set in this UI.** `public/*.js` and `public/*.html` contain zero `<svg>`
elements, there is no icon font, and no emoji is used anywhere in the interface. The lock
feature must not be the thing that introduces one.

The treatment is therefore **text and colour only**:

| Element | Treatment |
|---|---|
| List flag | The word `Locked` in a `.badge`. Real text, so it is searchable, translatable and readable by assistive technology |
| Row accent | 3px inset left border in `--accent` (§3.1). Decorative only — it never carries meaning that the badge does not also carry |
| Detail block | A text heading, `Delete protection`. No glyph |
| Colour | `--accent` indigo for the badge and accent. `--warning` is reserved for the wedged/attention flag, `--danger` for failures and destructive buttons, `--success` for ready states. A lock is none of those |

New CSS, one rule, sitting with the other badge variants around `public/style.css:324`:

```css
/* Explicit delete-lock (issue #893). Indigo, not amber: a lock is a deliberate
   operator state, not a fault. Distinct from .badge-attention, which means
   something went wrong. */
.badge-locked {
  background: rgba(99, 102, 241, 0.18);
  color: var(--accent);
  border: 1px solid rgba(99, 102, 241, 0.45);
}
```

If a glyph is ever wanted, it arrives as a separate decision covering the whole UI, with an
accessible-name rule, and it supplements this text rather than replacing it. Colour and
shape must never be the only carrier of the lock state (WCAG 1.4.1).

---

## 7. Copy deck

Every operator-visible string this feature introduces, in one place. Sentence case, full
stops on sentences, no exclamation marks, no product names.

| Key | String |
|---|---|
| `lock.badge` | `Locked` |
| `lock.badge.title` | `Delete-locked. Archiving is refused until the lock is cleared.` |
| `lock.detail.heading` | `Delete protection` |
| `lock.detail.unlocked` | `Not locked. This asset can be archived, subject to the other checks (running jobs, child assets, collection membership).` |
| `lock.detail.locked.by` | `Locked by {lockedBy} on {lockedAt}.` |
| `lock.detail.locked.anon` | `Locked on {lockedAt}.` |
| `lock.detail.reason` | `Reason: {reason}` |
| `lock.detail.reason.none` | `No reason recorded.` |
| `lock.detail.consequence` | `Archiving this asset is refused while the lock is set. The lock cannot be forced.` |
| `lock.detail.unavailable` | `Lock state unavailable.` |
| `lock.btn.lock` | `Lock` |
| `lock.btn.unlock` | `Unlock` |
| `lock.btn.edit` | `Edit lock note` |
| `lock.dialog.lock.title` | `Lock asset` |
| `lock.dialog.lock.intro` | `Locking prevents this asset from being archived until the lock is cleared. It does not change the asset's status and does not move or delete any files.` |
| `lock.field.reason.label` | `Reason (optional)` |
| `lock.field.reason.placeholder` | `Why this asset must not be deleted` |
| `lock.field.reason.help` | `Up to 1024 characters.` |
| `lock.field.lockedBy.label` | `Locked by (optional)` |
| `lock.field.lockedBy.placeholder` | `Who or what is asking for the lock` |
| `lock.field.lockedBy.help` | `A free-text label, up to 256 characters. It is not verified against your identity.` |
| `lock.dialog.edit.warning` | `Saving replaces the current reason and "locked by" label, and resets the lock timestamp to now.` |
| `lock.dialog.unlock.title` | `Clear delete lock` |
| `lock.dialog.unlock.question` | `Clear the delete lock on "{name}"?` |
| `lock.dialog.unlock.affected.1` | `This asset becomes archivable again. Anyone who can archive an asset can then archive it.` |
| `lock.dialog.unlock.affected.2` | `The reason and "locked by" label recorded with the lock are discarded, not kept as history.` |
| `lock.dialog.unlock.unaffected.1` | `Nothing is deleted or moved. The asset's status, files, renditions and metadata are untouched.` |
| `lock.dialog.unlock.unaffected.2` | `Other assets and collections keep their own locks.` |
| `lock.result.locked` | `Asset locked.` |
| `lock.result.unlocked` | `Delete lock cleared.` |
| `lock.error.forbidden` | `Your role cannot change the delete lock on this asset. Ask an editor or administrator.` |
| `lock.error.reason.long` | `Reason is too long (maximum 1024 characters).` |
| `lock.error.lockedBy.long` | `"Locked by" is too long (maximum 256 characters).` |
| `lock.error.notFound` | `This asset no longer exists.` |
| `lock.error.network` | `Could not reach the API. The lock was not changed.` |
| `blocked.title` | `Archive blocked` |
| `blocked.question` | `"{name}" is protected from deletion.` |
| `blocked.detail` | `A delete lock is set on this asset, so the API refuses to archive it. Nothing has changed.` |
| `blocked.unaffected.1` | `The asset, its files and its metadata are untouched.` |
| `blocked.unaffected.2` | `No job was started and nothing was queued.` |
| `blocked.resolution` | `To archive this asset, clear its delete lock from the asset's detail view first. The lock cannot be forced.` |
| `blocked.btn.close` | `Close` |
| `blocked.btn.detail` | `Open detail` |

---

## 8. Accessibility

- The badge is text, not a title-only affordance, and carries a `.visually-hidden`
  consequence clause (§3.3).
- The row accent is decorative; it duplicates the badge and never stands alone.
- Detail controls use `aria-describedby` pointing at the state text, following the existing
  restore-note pattern (`public/app.js:2240`, `:2260`).
- Dialogs inherit `openModal`'s focus handling. The blocked variant focuses `Close`, which
  is its only destructive-free action.
- State changes after a lock or unlock write their one-line result into the existing action
  message area; that area needs `aria-live="polite"` so the change is announced without
  moving focus.
- Colour alone never conveys the lock (§6).

---

## 9. Gaps this spec is blocked by or routes around

Each is a real, verified limitation. The sub-issues implement the "today" column; the gaps
need their own tickets.

| Id | Gap | Effect on this spec |
|---|---|---|
| **H1** | The canonical search payload omits `deleteLock` entirely (`src/routes/search.ts:78`; `paths["/api/v1/search/"]` asset item properties, §0), and the assets table uses that endpoint whenever a free-text `q` is active (`public/assets-table.js:213`, `:226`). | Every search-result row is state **L0**. A locked asset shows no badge while the operator is searching. Routed around by §5.4 (409 fallback), but the fix is to add `deleteLock` to the search projection. **Highest-value follow-up.** |
| **H2** | No lock filter or sort on `GET /api/v1/assets/` (params list, §0). | No "Locked only" view (§3.4). Needs a server-side parameter before the UI can offer one. |
| **H3** | `400` and `403` are reachable on both lock operations but neither is declared; `openapi.json` lists only `200` and `404`. A generated client will not model either. | §4.4 handles undeclared statuses. The spec should declare them. |
| **H4** (= G4 in `docs/findings/asset-lock-contract-892.md`) | Lock/unlock provenance is written (`src/data/asset-repo.ts:1079`, `:1085`) but `assetSchema` (`src/routes/assets.ts:811-887`) has no `provenance` property, so no endpoint returns it. | **No lock history timeline is buildable.** Detail shows the current lock only, and §4.3 must warn that a cleared lock's note is gone for good. |
| **H5** (= G5) | Neither lock handler emits an audit entry (`src/routes/assets.ts:5591-5601`, `:5617-5623`), unlike archive (`:5546`). | Lock copy must not claim an audit trail (§1 rule 2). A deliberate, security-relevant action is invisible in `GET /api/v1/audit`. |
| **H6** (= G7) | The spec advertises `additionalProperties: false` on the lock body, but the Zod object strips instead, so a misspelled key silently locks with no reason recorded. | §4.4 requires re-rendering from the `200` response rather than from optimistic local state, so a dropped field is visible immediately. |
| **H7** | `PUT /:id/lock` with no body at all is a `400`, despite every property being optional. | §4.3 requires always sending `{}`. |
| **H8** | The `409` uses `{ error: string, message? }`, not the `{ error: { code, message } }` envelope the house API principles describe. | This spec deliberately follows the shipped contract, not the principle. Aligning the two is an API-wide decision, not something #896 should do locally. |

---

## 10. Acceptance checklist for #894 / #895 / #896

- [ ] `lockStateOf` lives in one module and all three surfaces call it (§2).
- [ ] No code path reads `asset.deleteLock.locked === false` or tests `'deleteLock' in asset` (§2).
- [ ] The list badge is the word `Locked` with a visually-hidden consequence clause; no reason text in the list (§3.3).
- [ ] No "Locked only" filter and no locked-first sort shipped (§3.4).
- [ ] The detail block renders in both locked and unlocked states (§4.1).
- [ ] The lock request always carries a JSON body, `{}` when empty (§4.3).
- [ ] Both lock requests re-render the detail from the returned asset (§4.4).
- [ ] `403` and `400` on the lock routes are handled inline, not as an `alert` (§4.4).
- [ ] The Archive control is never `disabled` on account of a lock (§5.1).
- [ ] No "force", "delete anyway" or "retry" affordance exists for a locked asset (§5.3).
- [ ] The 409 handler checks `error === "delete_blocked"` before reading `reason` or `blockedBy` (§5.4).
- [ ] Every operator-visible string matches §7 exactly.
- [ ] No SVG, icon font or emoji is added (§6).
