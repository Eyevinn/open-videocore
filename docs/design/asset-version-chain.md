# Interaction spec: version-chain view and navigation on asset detail

**Issue:** #941 (broken out from #795). Feeds the implementation ticket.
**Status:** design spec. No production code accompanies it.
**Audience:** whoever implements the asset-detail versions view, plus anyone writing operator copy about versions.

This pins the **layout, current-version indicator, navigation and empty state** for one
surface: the versions view on asset detail. It does not restate the contract, it cites it.
Where the contract cannot support a design, the design says so rather than inventing a field.

---

## 0. Contract grounding

Everything below was read from `openapi.json`, the route source and the repository source in
this tree on branch `issue-941/version-chain-design`. Nothing is taken from the issue text.

| What | Exact symbol verified |
|---|---|
| Endpoint exists | `openapi.json` → `paths["/api/v1/assets/{id}/versions"]` — exposes exactly `get`. Handler `src/routes/assets.ts:3428-3466` |
| Path parameter | `openapi.json` → `…versions.get.parameters` — `id` (in `path`, `required: true`, `type: string`). Source `params: z.object({ id: z.string() })`, `src/routes/assets.ts:3432` |
| 200 envelope | `openapi.json` → `…get.responses["200"].content["application/json"].schema` — properties `assetId`, `versionGroupId`, `currentVersionId`, `versions`; `required: ["assetId","currentVersionId","versions"]`. Source `src/routes/assets.ts:3434-3439` |
| `versionGroupId` is optional | Same schema: absent from `required`. Source `versionGroupId: z.string().optional()`, `src/routes/assets.ts:3436`; populated from the **target asset**, not searched for in the page — `versionGroupId: target?.versionGroupId`, `src/routes/assets.ts:3454,3461` |
| `versions` item shape | `…schema.properties.versions.items` — the full `assetSchema` (`src/routes/assets.ts:3438`). `required: ["id","name","status","statusHistory","createdAt","updatedAt"]` |
| Per-member lineage fields | `assetSchema` → `versionOfAssetId: z.string().optional()`, `versionGroupId: z.string().optional()`, `src/routes/assets.ts:878-879`. Both `type: string`, both optional in `openapi.json` |
| `status` enum | `…versions.items.properties.status.enum` = `uploading`, `processing`, `ready`, `failed`, `archived` |
| Ordering | **oldest first**: `createdAt` ascending, ties broken by `id` ascending. Single comparator `compareVersionOrder`, `src/data/asset-repo.ts:1231-1233`, applied by both repositories — `src/data/asset-repo.ts:1817` (in-memory) and `src/data/couch-asset-repo.ts:631` (Couch). ULIDs make the `id` tiebreak total and time-ordered |
| Current version | `currentVersionId` — **server-computed**, `currentVersionId(versions)` at `src/routes/assets.ts:3458`, defined `src/data/asset-repo.ts:1275-1295`. Preference ladder over `status`: `ready` → (`uploading`\|`processing`) → `failed` → `archived`, newest-first within the highest non-empty tier |
| Current version is **not** the last array element | `src/data/asset-repo.ts:1239-1246` states this explicitly; the ladder skips archived / failed / in-flight members while a usable one exists |
| Current version does **not** promise playability | `src/data/asset-repo.ts:1266-1270` — it names the head of the lineage; the member's own `status` must be checked |
| Membership | group-scoped, **always includes the target**, **includes `archived` members** (lineage history, not a live listing). `listVersions`, `src/data/asset-repo.ts:1004-1007` (interface), `:1805-1819` (in-memory), `src/data/couch-asset-repo.ts:613-633` (Couch) |
| Never-versioned asset | returns a **single-member chain** containing only itself, with `versionGroupId` absent — `if (!asset.versionGroupId) return [{ ...asset }]`, `src/data/asset-repo.ts:1811-1813` and `src/data/couch-asset-repo.ts:620-622` |
| 404 body | `openapi.json` → `…get.responses["404"]` — `{ error: string, message?: string }`, `required: ["error"]`, `additionalProperties: false`. Source `errorSchema`, `src/routes/assets.ts:529`; handler sends `{ error: 'not_found' }`, `src/routes/assets.ts:3447` |
| No pagination | `…get.parameters` contains **only** `id`. Chain returned whole, bounded by `MAX_LIMIT = 200` (`src/data/asset-repo.ts:853`) inside `listVersions` (`src/data/couch-asset-repo.ts:626`) |
| How versions are created | `resolveVersionLinkage(source)`, `src/data/asset-repo.ts:1210-1221` — returns `versionOfAssetId: source.id` and `versionGroupId: source.versionGroupId ?? source.id`, plus `seedSourceGroup` to backfill the root |
| Opt-in only | `asVersion?: boolean` on `exportBodySchema` (`src/routes/assets.ts:720`) and `clipBodySchema` (`src/routes/assets.ts:733`); threaded at `src/routes/assets.ts:4931` (`POST /:id/export`, route at `:4882`) and `:4999` (`POST /:id/clip`, route at `:4949`); consumed at `src/pipeline/clip.ts:147-163` and `src/pipeline/rewrap.ts:129` |
| Governing ADR | `docs/architecture/ADR-024-asset-version-chain-contract.md` — D1 response shape, D2 membership, D3 server-computed current, D4 branching tree, D5 ordering, D6 not paginated |
| Behaviour under test | `src/routes/assets.versions.test.ts` — envelope + single-member chain `:112-144`, membership/ordering `:146-204`, **branching** `:206-235`, current-version identification `:237-381` |
| UI primitives available for reuse | `.badge` `public/style.css:292`, status variants `:302-317`, `.badge-attention` `:324`, `.visually-hidden` `:194`; `.section-title` heading convention `public/app.js:2421,2453,2625`; asset detail renderer `renderAssetDetailBody(id, bodyEl)` `public/app.js:2513`; in-panel navigation `showAssetDetail(id, detailPanel)` `public/app.js:2340`; asset-id link pattern `data-asset-id` + delegated handler `public/app.js:3549` / `:3515` |

Field names used in this spec — `assetId`, `versionGroupId`, `currentVersionId`, `versions`,
`id`, `name`, `status`, `createdAt`, `versionOfAssetId`, `error`, `message` — are all from
the rows above. No other field name appears.

### Contract gaps (do not design around them, design *for* them)

1. **No operator-settable "current".** There is no promote / set-current endpoint and no
   stored marker; `currentVersionId` is derived (`src/data/asset-repo.ts:1239-1246`).
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
| **source version** (the member a version was cut from) | "parent" — `parentId` is the *rendition* hierarchy, a different relationship (`src/routes/assets.ts:3404-3405`) |
| **Versions** (the section heading) | "History" — `statusHistory` already owns that word on this page |

**Current vs. Latest is the whole point.** `currentVersionId` is the newest *usable* member,
not the newest member. Calling the badge "Latest" would be a lie on any chain whose newest
member is `processing` or `failed`. Copy must never imply the operator chose it.

---

## 2. Chain layout: tree, not flat list

**The chain can branch. Render a tree.**

Evidence: `resolveVersionLinkage` sets `versionOfAssetId` to the *immediate* source and
reuses that source's existing `versionGroupId` (`src/data/asset-repo.ts:1215-1219`). Nothing
rejects a second `asVersion` operation against the same source, so two `POST /:id/clip`
calls with `asVersion: true` against one asset produce two siblings in one group both naming
the same predecessor. This is asserted, not assumed: `src/routes/assets.versions.test.ts:206-235`
creates exactly that shape and checks both members report the same `versionOfAssetId`.
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
reusing the existing `.badge-*` palette (`public/style.css:302-317`), `createdAt` rendered
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
  (`src/routes/assets.ts:3434-3439`, `required`), so the view must not handle "no current".
- **Read the field. Never re-derive it** — not as the last element of `versions`, not as
  the newest `createdAt`. `src/data/asset-repo.ts:1239-1246` is explicit that the last
  element is not the rule.
- The badge is a **new variant**, not a reuse of a status badge: Current is orthogonal to
  `status` and both appear on the same row. Follow the `.badge-locked` precedent
  (`public/style.css:335`) — a distinct deliberate-state variant rather than a
  `.badge-attention` (something is wrong) or `.badge-failed` (an error).
- The badge carries a visually-hidden consequence string for screen readers, matching the
  lock badge convention:
  `"Current version: the newest version of this asset that is usable."`
- **Current does not promise playable** (`src/data/asset-repo.ts:1266-1270`). When the
  current member's own `status` is not `ready`, the row shows its real status badge
  alongside Current and a one-line note under the section:
  *"No version of this asset is ready yet. Current names the newest version in the chain."*
  Do not suppress the Current badge in that case — the field still names the head, and
  hiding it would make the view disagree with the API.
- The asset being viewed is marked separately with a **"you are here"** marker on its own
  row (`assetId` from the response, echoed at `src/routes/assets.ts:3460`). Current and
  you-are-here are different facts and frequently land on different rows; they must be
  visually distinct and must be able to coexist on one row.

---

## 4. Inter-version navigation

- Every row except the you-are-here row is a **link to that version's asset detail**. Reuse
  the existing in-panel navigation rather than inventing a route: the delegated
  `data-asset-id` link pattern (`public/app.js:3549`) dispatching to
  `showAssetDetail(id, detailPanel)` (`public/app.js:2340`). The detached-window path
  (`openDetailWindow('asset', id)`, `public/app.js:1899`) stays available as the
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
  `.badge-archived` style at reduced emphasis and remain navigable — this is lineage
  history. Do not add a "hide archived" toggle in v1: on an entirely archived lineage it
  would empty a list that is not empty.

---

## 5. Empty state

There is no empty `versions` array for an existing asset. `listVersions` returns the asset
itself when it has no `versionGroupId` (`src/data/asset-repo.ts:1811-1813`,
`src/data/couch-asset-repo.ts:620-622`), so the "no versions" case arrives as a
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

- **404** — `{ error: "not_found" }` (`src/routes/assets.ts:3447`). The asset does not
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

## 7. What the implementation ticket inherits

1. Reconstruct the tree from `versionOfAssetId`; render orphans under
   "Source version not in this list"; never reparent.
2. Badge exactly the `currentVersionId` member as **Current**. Never re-derive it.
3. Mark the `assetId` member as **you are here**, separately from Current.
4. Row links reuse the `data-asset-id` → `showAssetDetail` pattern; re-fetch on navigation.
5. Previous / Next step through `versions` in array order.
6. Empty state is `versions.length === 1 && !versionGroupId`, not length 0.
7. Do not add a promote / set-current control — the contract has no such endpoint.
8. Read errors as flat `{ error, message? }`.
