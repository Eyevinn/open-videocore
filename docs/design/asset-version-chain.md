# Interaction spec: version-chain view and navigation on asset detail

**Issues:** #941 and #906 — both broken out from #795 against the same surface. #906 asks for
the chain view, current-version indicator and empty state; §2, §3 and §5 answer it, and §7-§9
add the state wireframes, narrow-panel layout and accessibility contract it needs.
This file is the single spec for the surface; do not open a second one.
**Canonical issue:** not recorded. #941 is still open alongside #906, and this file does not
decide which of the two is canonical — a maintainer must record that on the issues themselves.
**Status:** design spec. No production code accompanies it.
**Audience:** whoever implements the asset-detail versions view, plus anyone writing operator copy about versions.

This pins the **layout, current-version indicator, navigation and empty state** for one
surface: the versions view on asset detail. It does not restate the contract, it cites it.
Where the contract cannot support a design, the design says so rather than inventing a field.

---

## 0. Contract grounding

Everything below was read from `openapi.json`, the route source and the repository source in
this tree. Nothing is taken from the issue text.

Citations below are **symbol-anchored, not line-anchored**. Every row names a file plus a
greppable symbol — an exported function, a schema const, a route literal, the symbol a doc
comment hangs off, a test name, or a CSS selector. Line numbers are deliberately absent: they
drift with every unrelated edit to these files (`src/routes/assets.ts` and `public/app.js` have
each shifted by hundreds of lines since this spec was drafted), and a stale line number sends a
reader to unrelated code with no signal that it is wrong. A symbol either greps or it does not.
To check any row, grep the symbol in the file named next to it.

| What | Exact symbol verified |
|---|---|
| Endpoint exists | `openapi.json` → `paths["/api/v1/assets/{id}/versions"]` — exposes exactly `get`. Source: the `app.get('/:id/versions', …)` registration in `src/routes/assets.ts` |
| Path parameter | `openapi.json` → `…versions.get.parameters` — the **only** parameter: `id` (in `path`, `required: true`, `type: string`). Source: `params: z.object({ id: z.string() })` on the `'/:id/versions'` route schema, `src/routes/assets.ts` |
| 200 envelope | `openapi.json` → `…get.responses["200"].content["application/json"].schema` — properties `assetId`, `versionGroupId`, `currentVersionId`, `versions`; `required: ["assetId","currentVersionId","versions"]`. Source: the `response: { 200: … }` schema on the `'/:id/versions'` route, `src/routes/assets.ts` |
| `versionGroupId` is optional | Same schema: absent from `required`. Source: `versionGroupId: z.string().optional()` in that 200 schema; populated from the **target asset**, not searched for in the page — `versionGroupId: target?.versionGroupId` in the handler body, `src/routes/assets.ts` |
| `versions` item shape | `…schema.properties.versions.items` — the full `assetSchema` (`versions: z.array(assetSchema)` in that 200 schema, `src/routes/assets.ts`). `required: ["id","name","status","statusHistory","createdAt","updatedAt"]` |
| Per-member lineage fields | `assetSchema`, `src/routes/assets.ts` → `versionOfAssetId: z.string().optional()` and `versionGroupId: z.string().optional()`, declared immediately below `parentId` and commented as distinct from it ("Version-chain linkage (issue #118), DISTINCT from `parentId`"). Both `type: string`, both optional in `openapi.json` |
| `status` enum | `…versions.items.properties.status.enum` = `uploading`, `processing`, `ready`, `failed`, `archived` |
| Ordering | **oldest first**: `createdAt` ascending, ties broken by `id` ascending. Stated once as `compareVersionOrder`, `src/data/asset-repo.ts`; the same comparator is applied inline by both repositories inside `InMemoryAssetRepository.listVersions` (`src/data/asset-repo.ts`) and `CouchAssetRepository.listVersions` (`src/data/couch-asset-repo.ts`). ULIDs make the `id` tiebreak total and time-ordered |
| Current version | `currentVersionId` — **server-computed**, `const current = currentVersionId(versions) ?? request.params.id` in the `'/:id/versions'` handler (`src/routes/assets.ts`), defined as `export function currentVersionId` in `src/data/asset-repo.ts`. Preference ladder over `status`: `ready` → (`uploading`\|`processing`) → `failed` → `archived`, newest-first within the highest non-empty tier |
| Current version is **not** the last array element | the doc comment on `currentVersionId` (`src/data/asset-repo.ts`) states it explicitly — "'last element of the array' is NOT the rule"; the ladder skips archived / failed / in-flight members while a usable one exists |
| Current version does **not** promise playability | same `currentVersionId` doc comment — "it names the head of the lineage, it does not promise `ready`"; the member's own `status` must be checked |
| Membership | group-scoped, **always includes the target**, **includes `archived` members** (lineage history, not a live listing). `listVersions` — declared on the `AssetRepository` interface (`src/data/asset-repo.ts`), implemented as `InMemoryAssetRepository.listVersions` (same file) and `CouchAssetRepository.listVersions` (`src/data/couch-asset-repo.ts`) |
| Never-versioned asset | returns a **single-member chain** containing only itself, with `versionGroupId` absent — `if (!asset.versionGroupId) return [{ ...asset }]` in `InMemoryAssetRepository.listVersions` and `if (!asset.versionGroupId) return [asset]` in `CouchAssetRepository.listVersions` |
| 404 body | `openapi.json` → `…get.responses["404"]` — `{ error: string, message?: string }`, `required: ["error"]`, `additionalProperties: false`. Source: `const errorSchema = z.object({ error: z.string(), message: z.string().optional() })`, `src/routes/assets.ts`, wired as `404: errorSchema` on the `'/:id/versions'` route; that handler sends `{ error: 'not_found' }` |
| Only two responses | `openapi.json` → `…get.responses` has exactly `200` and `404`. There is no documented 4xx/5xx body beyond those, so anything else is handled as a fetch failure — §5 for the rule, §7 for the wireframe |
| No pagination | `…get.parameters` contains **only** `id`. Chain returned whole, bounded by `export const MAX_LIMIT = 200` (`src/data/asset-repo.ts`) applied inside `CouchAssetRepository.listVersions` (`src/data/couch-asset-repo.ts`) |
| How versions are created | `resolveVersionLinkage(source)`, `src/data/asset-repo.ts` — returns `versionOfAssetId: source.id` and `versionGroupId: source.versionGroupId ?? source.id`, plus `seedSourceGroup` to backfill the root |
| Opt-in only | `asVersion: z.boolean().optional()` on `exportBodySchema` and on `clipBodySchema` (`src/routes/assets.ts`); threaded as `asVersion: request.body.asVersion` from the `'/:id/export'` and `'/:id/clip'` handlers in the same file; consumed at `if (asVersion && source)` in `src/pipeline/clip.ts` and `src/pipeline/rewrap.ts` |
| Governing ADR | `docs/architecture/ADR-024-asset-version-chain-contract.md` — D1 response shape, D2 membership, D3 server-computed current, D4 branching tree, D5 ordering, D6 not paginated |
| Behaviour under test | `src/routes/assets.versions.test.ts`, by `describe` name — `GET /:id/versions — envelope and single-member chain`, `… — membership, ordering and group`, **`… — chain topology is a branching tree`**, `… — current-version identification` |
| UI primitives available for reuse | `public/style.css`: `.badge` plus the status variants (note `.badge-archived` shares one rule with `.badge-failed` — the selector list is `.badge-failed, .badge-error, .badge-archived`), `.badge-attention`, `.badge-locked` with its rationale comment, `.visually-hidden`. `public/app.js`: the `.section-title` heading convention; asset detail renderer `renderAssetDetailBody`; in-panel navigation `showAssetDetail` (reached from the assets table's `onRowClick` callback); detached window `openDetailWindow`; asset-id link pattern — `data-asset-id` on the `.job-asset-link` markup in `renderJobDetailBody`, read back by that function's delegated handler as `assetLink.dataset.assetId` and dispatched through `opts.onAssetLink` |

Field names used in this spec — `assetId`, `versionGroupId`, `currentVersionId`, `versions`,
`id`, `name`, `status`, `createdAt`, `versionOfAssetId`, `error`, `message` — are all from
the rows above. No other field name appears.

### Contract gaps (do not design around them, design *for* them)

1. **No operator-settable "current".** There is no promote / set-current endpoint and no
   stored marker; `currentVersionId` is derived (`currentVersionId`, `src/data/asset-repo.ts`).
   The view must therefore present current as **observed state, not an operator choice** —
   no "Make current" button, no radio selection. ADR-024 D3 leaves room for one later
   without a breaking change.
2. **No per-version label, note, or author.** `assetSchema` carries `name`, `status`,
   `createdAt` and the lineage edges only. A version row cannot show "why" it exists beyond
   whatever `name` the caller passed as `outputName`.
3. **Silent truncation above 200 members.** `MAX_LIMIT` bounds the page and
   `currentVersionId` is computed from the page that came back (ADR-024 D6), so a lineage
   over 200 can name a head that is not the true head. See §6.
4. **The 404 body is `{ error, message? }`**, which is this repo's established asset-route
   error shape — not the `{ error: { code, message, details? } }` envelope. The view must
   read `error` / `message` as flat strings. Reconciling the two envelopes is an API-wide
   decision, out of scope here. Same-repo note, not OSC friction.

---

## 1. Vocabulary

One noun, one verb, everywhere.

| Use | Do not use |
|---|---|
| **version** (a member), **version chain** (the whole lineage) | "revision", "edit", "cut", "generation", any vendor or product name |
| **Current** (the badge on the `currentVersionId` member) | "Latest", "Active", "Head", "Published", "Live" |
| **source version** (the member a version was cut from) | "parent" — `parentId` (on `assetSchema`, `src/routes/assets.ts`) is the *rendition* hierarchy, a different relationship the comment above the `'/:id/versions'` route calls out as "DISTINCT from ?parentId= listing" |
| **Versions** (the section heading) | "History" — `statusHistory` already owns that word on this page |

**Current vs. Latest is the whole point.** `currentVersionId` is the newest *usable* member,
not the newest member. Calling the badge "Latest" would be a lie on any chain whose newest
member is `processing` or `failed`. Copy must never imply the operator chose it.

---

## 2. Chain layout: tree, not flat list

**The chain can branch. Render a tree.**

Evidence: `resolveVersionLinkage` (`src/data/asset-repo.ts`) sets `versionOfAssetId` to the
*immediate* source and reuses that source's existing `versionGroupId`. Nothing
rejects a second `asVersion` operation against the same source, so two `POST /:id/clip`
calls with `asVersion: true` against one asset produce two siblings in one group both naming
the same predecessor. This is asserted, not assumed: in `src/routes/assets.versions.test.ts`,
`GET /:id/versions — chain topology is a branching tree` → `returns both branches when two
versions are cut from the same source` creates exactly that shape and checks both members
report the same `versionOfAssetId`.
ADR-024 D4 documents it as intentional — "two cuts from one master" is a legitimate
editorial operation and forcing linearity would mean rejecting it.

So:

- `versionGroupId` is the **lineage**: a flat set spanning the whole tree, seeded to the
  root asset's own id.
- `versionOfAssetId` is the **edge to the immediate predecessor**. Absent on the root.
- `versions` is a flat, oldest-first **projection**; the client reconstructs the tree.

### Reconstruction rule

Index `versions` by `id`. The **root** is the member whose `versionOfAssetId` is absent
(equivalently, whose `id` equals the response `versionGroupId`). Every other member attaches
as a child of `versionOfAssetId`. Render children in the order they appear in `versions`,
which preserves the server's oldest-first ordering within each sibling group.

Two defensive cases, because `versions` is a bounded page (§6):

- a member whose `versionOfAssetId` names an id **not present** in the page is an **orphan**;
- a page with **no** root (the root fell outside the window) leaves every member orphaned.

Attach orphans to a single group at the end of the tree under the heading
**"Source version not in this list"**. Never drop them, and never silently reparent them to
the root — that would fabricate a lineage edge.

### Layout

A single vertical list, indented by tree depth, oldest at top (matching `versions` order,
so the default read is chronological and the server's ordering is visible rather than
re-sorted). Depth is drawn with an indent plus a connector rule; depth is capped visually at
~4 levels and anything deeper renders at the cap so a long chain cannot run off the panel.

Each row carries, left to right: the connector/indent, the **Current** badge slot (fixed
width so rows stay aligned whether or not the badge is present), `name`, the `status` badge
reusing the existing `.badge-*` palette (`public/style.css`), `createdAt` rendered
as ISO 8601 UTC, and the `id` as click-to-copy monospace text following the existing
asset-id convention.

A strictly linear chain — the common case — falls out of this as a flat, un-indented list
with zero extra work. Implementing a flat list *only* is the thing to avoid: it is not
wrong, but it silently loses branch structure the API can already produce, and retrofitting
the tree later means rewriting the row renderer.

```
Versions                                        versionGroupId 01JQ…A7

  ○  master                     [ready]      2026-03-01T00:00:00Z   01JQ…A7
  ├─ ○  rough-cut               [archived]   2026-03-02T09:14:00Z   01JQ…B1
  │  └─ ●  rough-cut-v2  Current [ready]     2026-03-04T11:02:00Z   01JQ…C5
  └─ ○  trailer-cut             [processing] 2026-03-03T16:40:00Z   01JQ…D9
     ▸ you are here
```

(`rough-cut` and `trailer-cut` are the branch: both carry `versionOfAssetId` = the master's
id. Note `rough-cut-v2` is Current while `trailer-cut` is newer — the ladder skipped the
in-flight member. This is the case a "Latest" label would get wrong.)

---

## 3. Current-version indicator

- Exactly **one** row carries the **Current** badge: the member whose `id` equals
  `currentVersionId`. The field is always present and always names a member
  (`currentVersionId: z.string()` — non-optional — in the `'/:id/versions'` 200 schema,
  `src/routes/assets.ts`, and the `?? request.params.id` fallback in that handler keeps it
  so), therefore the view must not handle "no current".
- **Read the field. Never re-derive it** — not as the last element of `versions`, not as
  the newest `createdAt`. The doc comment on `currentVersionId` (`src/data/asset-repo.ts`)
  is explicit that the last element is not the rule.
- The badge is a **new variant**, not a reuse of a status badge: Current is orthogonal to
  `status` and both appear on the same row. Follow the `.badge-locked` precedent
  (`public/style.css`) — a distinct deliberate-state variant rather than a
  `.badge-attention` (something is wrong) or `.badge-failed` (an error).
- The badge carries a visually-hidden consequence string for screen readers, matching the
  lock badge convention:
  `"Current version: the newest version of this asset that is usable."`
- **Current does not promise playable** (`currentVersionId` doc comment,
  `src/data/asset-repo.ts`). When the
  current member's own `status` is not `ready`, the row shows its real status badge
  alongside Current and a one-line note under the section:
  *"No version of this asset is ready yet. Current names the newest version in the chain."*
  Do not suppress the Current badge in that case — the field still names the head, and
  hiding it would make the view disagree with the API.
- The asset being viewed is marked separately with a **"you are here"** marker on its own
  row (`assetId` from the response — `assetId: request.params.id` in the `'/:id/versions'`
  handler, `src/routes/assets.ts`). Current and
  you-are-here are different facts and frequently land on different rows; they must be
  visually distinct and must be able to coexist on one row.

---

## 4. Inter-version navigation

- Every row except the you-are-here row is a **link to that version's asset detail**. Reuse
  the existing in-panel navigation rather than inventing a route: the delegated
  `data-asset-id` link pattern (markup and handler both in `renderJobDetailBody`,
  `public/app.js`) dispatching to `showAssetDetail` (`public/app.js`). The detached-window
  path (`openDetailWindow`, `public/app.js`) stays available as the
  secondary action, unchanged.
- Navigating re-renders detail for the new id and **re-fetches `GET /api/v1/assets/{id}/versions`
  for it**. Do not carry the previous response over. The envelope is target-relative:
  `assetId` changes, so you-are-here moves. `versions`, `versionGroupId` and
  `currentVersionId` are group-scoped and will normally match, but re-fetching keeps the
  view honest if the lineage changed between reads and costs one request the page is
  already making.
- The section stays **expanded and scrolled to the you-are-here row** after navigation, so
  moving between versions does not reset the reader's position in the chain.
- Provide **Previous / Next** controls that step through `versions` in array order
  (oldest → newest), disabled at each end. Array order, not tree order — it is the server's
  declared total order (§0, ordering row) and is stable across reads, so stepping is
  predictable on a branching chain where "next" has no single tree answer.
- No sorting or filtering controls in v1. The order is contractual and the chain is capped
  at 200; re-sorting would hide the ordering the current-version ladder is defined against.
- **Archived members stay in the list** (ADR-024 D2). They render with the existing
  `.badge-archived` style (`public/style.css`) at reduced emphasis and remain navigable — this is lineage
  history. Do not add a "hide archived" toggle in v1: on an entirely archived lineage it
  would empty a list that is not empty.

---

## 5. Empty state

There is no empty `versions` array for an existing asset. `listVersions` returns the asset
itself when it has no `versionGroupId` (`InMemoryAssetRepository.listVersions`,
`src/data/asset-repo.ts`; `CouchAssetRepository.listVersions`,
`src/data/couch-asset-repo.ts`), so the "no versions" case arrives as a
**single-member chain**: `versions.length === 1`, that member's `id` equals `assetId`,
`currentVersionId` equals `assetId`, and `versionGroupId` is **absent**.

Detect it as `versions.length === 1 && !versionGroupId`. Do not test for `versions.length === 0` —
that shape does not occur, and coding for it will produce a branch nothing can reach.

Render the section (never hide it) with:

> **Versions**
> This asset has no other versions.
> Versions are created by running a clip or export with `asVersion` enabled.

Do not render a one-row tree with a Current badge — a chain of one is not a meaningful
current. Do not render an action button: creating a version is the clip/export flow, which
lives elsewhere on this page; the empty state explains *how* versions come to exist and
stops there. Keep the `versionGroupId` header slot empty rather than showing "none".

Two states that are **not** this one and must not reuse its copy:

- **404** — `{ error: 'not_found' }` (sent by the `'/:id/versions'` handler,
  `src/routes/assets.ts`). The asset does not
  exist; the whole detail view is already in its not-found state and the versions section
  does not render at all.
- **Fetch failure** — show an inline error using `message` when present, falling back to
  `error`, with a retry affordance. Never degrade a failed fetch into "no other versions":
  that reads as a fact about the asset when it is a fact about the request.

---

## 6. Truncation above 200 members

If `versions.length === MAX_LIMIT` (200), the lineage may be truncated and
`currentVersionId` may name the head of the *page* rather than of the chain (ADR-024 D6).
Render a notice above the tree:

> Showing the first 200 versions of this chain. Some versions are not listed, and the
> current version shown may not be the newest one.

This is unreachable for any realistic chain — versions are tens, not thousands — but the
orphan handling in §2 and this notice are what keep the view from quietly lying if one ever
gets there.

---

## 7. State wireframes

§2 draws the populated branching chain. The other four states the view can be in are drawn
here so none of them gets improvised at implementation time. The section heading **Versions**
and the `versionGroupId` slot are present in every state; only the body below them changes.

**Loading.** Reuse the existing spinner rather than inventing one: `loadingEl`
(`public/app.js`) renders `.loading` (`public/style.css`) with the text
`Loading…`. Do not render a row skeleton — a skeleton implies a known row count, and until
the response lands the chain length is unknown; on the overwhelmingly common single-member
chain a multi-row skeleton would flash a lineage that does not exist.

```
Versions

  ⟳ Loading…
```

**Empty (single-member chain — §5).** `versions.length === 1 && !versionGroupId`.
The `versionGroupId` slot in the header stays blank; no row, no badge, no button.

```
Versions

  This asset has no other versions.
  Versions are created by running a clip or export with `asVersion` enabled.
```

**Fetch failure (§5).** `message` when present, else `error`, plus retry. The copy names the
request, never the asset — "no versions" is a different fact and must not be shown here.

```
Versions

  ⚠  Couldn't load versions.
     <message ?? error>                                   [ Retry ]
```

**Truncated (§6).** `versions.length === MAX_LIMIT`. The notice sits above the tree, not
below it, so it is read before the chain it qualifies.

```
Versions                                        versionGroupId 01JQ…A7

  ⚠  Showing the first 200 versions of this chain. Some versions are not
     listed, and the current version shown may not be the newest one.

  ○  master                     [ready]      2026-03-01T00:00:00Z   01JQ…A7
  …
```

**Linear chain — the common case.** Worth drawing explicitly because it is what the
implementer will see 99% of the time, and because it must fall out of the tree renderer with
no special-casing: depth 0 for the root, depth 1 for everything after it in a strict line.

```
Versions                                        versionGroupId 01JQ…A7

  ○  master                     [archived]   2026-03-01T00:00:00Z   01JQ…A7
  └─ ○  master-rewrap           [archived]   2026-03-02T09:14:00Z   01JQ…B1
     └─ ●  master-rewrap-v2  Current [ready] 2026-03-04T11:02:00Z   01JQ…C5
        ▸ you are here
```

The warning triangle in the failure and truncation states is decorative only — it duplicates
text that is already present, following the `.badge-locked` precedent's rule that an icon
never carries meaning alone — see the comment on `tr.row-locked td:first-child`
(`public/style.css`), which states the row accent is "purely decorative" because it
duplicates the badge.

---

## 8. Narrow-panel layout

The versions view lives inside the asset detail panel, which is **38% of the viewport width,
floor 320px** (`.assets-side` — `flex: 0 0 38%` / `min-width: 320px`, `public/style.css`), and
collapses to full width under the existing `@media (max-width: 900px)` breakpoint, which
re-declares `.assets-side` (`public/style.css`).
A five-column row — indent, badge slot, `name`, `status`, `createdAt`, `id` — does not fit in
320px. Do not introduce a new breakpoint; reuse that one.

**Wide (panel ≥ ~560px):** the single-line row of §2.

**Narrow (below that):** the row wraps to two lines. Line one keeps the facts that identify
the version and its state — indent, Current badge slot, `name`, `status` badge. Line two
carries the metadata, indented to line one's text origin — `createdAt` then `id`.

```
  └─ ●  master-rewrap-v2  Current [ready]
        2026-03-04T11:02:00Z   01JQ…C5
```

What must **not** be dropped at narrow width:

- the **Current** badge — it is the whole point of the section;
- the `status` badge — Current does not imply `ready` (§3), so hiding `status` next to
  Current would state something the contract denies;
- the indent/connector — dropping it flattens a tree into a list and fabricates a topology.

What **may** be dropped: nothing. `createdAt` and `id` move to line two rather than
truncating, because `id` is click-to-copy and a truncated copy target is worse than a wrapped
one. The depth cap of ~4 levels (§2) does the horizontal budgeting; below the cap, indent
width shrinks before anything else gives.

---

## 9. Accessibility and keyboard

- **Semantics follow the topology, not the drawing.** Render the chain as a nested list
  (`ul`/`li`), not a flat list with padding, so the nesting a sighted reader sees in the
  connector rules is the nesting a screen reader announces. Do not reach for
  `role="tree"`/`role="treeitem"`: those carry an expand/collapse and roving-tabindex contract
  this view does not implement — every member is always visible (§4: no hide-archived toggle,
  no pagination), so a nested list is both accurate and cheaper.
- **The connector glyphs are decorative.** `├─`, `└─`, `│`, `○`, `●`, `▸` must be
  `aria-hidden`. Depth is conveyed by the list nesting; the glyphs are a visual echo of it.
- **Current** carries its visually-hidden consequence string (§3) via `.visually-hidden`
  (`public/style.css`), matching the `.badge-locked` convention and its rationale comment
  (`public/style.css`).
- **You-are-here** is announced, not just styled. Give the row `aria-current="true"` and mark
  it as not a link (§4) — a link to the page you are on is a dead end for keyboard users.
- **Focus after navigation.** §4 keeps the section expanded and scrolled to the you-are-here
  row. Move focus there too, otherwise a keyboard user who activated a version row lands back
  at the top of the re-rendered panel and has to tab through the whole detail view to return
  to the chain.
- **Previous / Next** are real `button` elements with `disabled` at each end, not styled
  spans, so the disabled state is exposed rather than merely grey. Label them for their actual
  behaviour — `Previous version` / `Next version` — since "Previous"/"Next" alone is
  ambiguous on a page that also pages a job list.
- **Status is never colour-only.** `.badge-archived` shares a rule with `.badge-failed` — the
  selector list is `.badge-failed, .badge-error, .badge-archived` (`public/style.css`) — so
  archived and failed members are the same colour; the badge text
  is the only thing distinguishing them. The §4 "reduced emphasis" treatment for archived rows
  must therefore be opacity or weight *in addition to* the text, never a colour swap that
  makes the two states look identical.
- **ISO 8601 UTC timestamps** (§2) render inside `time` with a machine-readable `datetime`,
  so assistive tech and copy-paste both get the exact value the API returned.

---

## 10. What the implementation ticket inherits

1. Reconstruct the tree from `versionOfAssetId`; render orphans under
   "Source version not in this list"; never reparent.
2. Badge exactly the `currentVersionId` member as **Current**. Never re-derive it.
3. Mark the `assetId` member as **you are here**, separately from Current.
4. Row links reuse the `data-asset-id` → `showAssetDetail` pattern; re-fetch on navigation.
5. Previous / Next step through `versions` in array order.
6. Empty state is `versions.length === 1 && !versionGroupId`, not length 0.
7. Do not add a promote / set-current control — the contract has no such endpoint.
8. Read errors as flat `{ error, message? }`.
9. Four non-populated states, all drawn in §7: loading (`loadingEl`), empty, fetch failure,
   truncated. None of them is the same copy as another.
10. Rows wrap to two lines under the existing `max-width: 900px` breakpoint (§8). Current
    badge, `status` badge and the indent survive the wrap; nothing is truncated.
11. Nested `ul`/`li`, connector glyphs `aria-hidden`, `aria-current` on the you-are-here row,
    focus moved to it after navigation (§9). Not `role="tree"`.
