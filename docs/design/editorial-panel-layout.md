# Design spec: the unified editorial panel — tags, comments and review state

**Issue:** #898 (broken out from #792). Feeds the implementation tickets #899, #900, #934, #935, #937.
**Status:** design spec / information architecture. No production code accompanies it.
**Audience:** whoever implements the asset-detail editorial panel, plus anyone writing operator copy
about review state or tags.

**Revision 2 — re-verified against `main` at `cdeb83d`.** The first draft was written ~22 commits
behind and three of its claims had gone stale: comments were recorded as non-durable (they are
persisted — gap C4 is **resolved**, §0.2.1 and §10), `public/style.css` was recorded as having no
`details`/`summary` rules (it has them, scoped to `.raw-disclosure` — §6.4), and every line-number
citation had drifted. Citations are now **anchored to symbols and literals**, not line numbers (§0).

**Revision 3 — reconciled with in-flight client work.** Revision 2 still described both the tags and
the comments sub-sections as greenfield. They are not. Tags are being implemented by **PR #1036**
(`public/editorial-tags.js`, symbol `mountEditorialTags`), which matches this spec; comments are
already implemented by **PR #1040** (`public/comments-panel.js`, symbol `mountAssetComments`), which
differs from this spec on three decisions. The comments sub-section is therefore no longer a
build-from-scratch brief — it is a **re-parent-and-amend** brief against #1040, and every divergence
is written up as an explicit, reversible change rather than left to be discovered as a merge
conflict. See §5.3.0 (reconciliation), §6.2, §6.4 and §11.

**Revision 4 — #1040 is merged; the comments module is now greppable here.** Revision 3 described
#1040 as open and in flight, and used that as the reason not to grep `public/comments-panel.js`
(every comments row carried an *(unmerged — #1040)* label and a line number taken from that PR's
branch head). **#1040 merged to `main` as `c1a6368`.** This branch now contains `origin/main` at
`2a622ca`, so every comments claim below was read in this tree like any other: the labels are gone,
the line numbers are re-grepped, the one contract question Revision 3 deferred is answered (§5.3.0
step 1 — `mountAssetComments` **does** support a `host`-only call), and the A1–A3 amendments are now
explicitly edits to *shipped operator-facing behaviour* rather than negotiations against an open PR.
The `durabilityNote` deletion has been recast as a pointer to a **separate shipped-code bug**
(§5.3 *Durability*, §10 C4, §11) — it is wrong on `main` today, independently of whether this layout
ever lands, so it should not wait on this spec. Only the tags rows remain labelled: **#1036 is still
open**, so `public/editorial-tags.js` genuinely is not in any merged tree.

This pins the **information architecture** of one surface: the editorial panel on asset detail.
It specifies what the panel contains, in what order, what collapses, how the editorial review axis
is kept visually separate from the lifecycle `status` axis (#134), and exactly where the panel
attaches inside `public/app.js`.

It does not restate the contract — it cites it. Where the contract cannot support a design, the
design says so (§10) rather than inventing a field.

---

## 0. Contract grounding

Everything below was read from `openapi.json`, the route source, the repository source and the
existing client source **in the merged tree** — this branch merged with `origin/main` at
**`2a622ca`**. Nothing is taken from issue text.

**Citations are anchored to symbols, not to line numbers.** Every row below names the exact
identifier, literal or source comment to grep for (`const tagSchema`, `['Tags', renderTags(…)]`,
`REVIEW_COPY.axisNote`). Line numbers are given only where no stable symbol exists, and are marked
as such. The first draft of this spec cited line numbers throughout and every one of them went
stale within ~20 commits; symbol anchors survive the churn that broke them.

**Citations to unmerged branches are marked as such — and there is now exactly one such source.**
`public/comments-panel.js` is **merged** (#1040, `c1a6368`) and is in this tree, so §5.3.0, §6.2,
§6.4 and §11 grep it directly; Revision 3's *(unmerged — #1040)* labels are withdrawn. The only
remaining unmerged source is `public/editorial-tags.js` (**PR #1036**, still open), cited in §6.2
and labelled *(unmerged — #1036)*: that row carries the symbol plus a line number **as verified in
review against that PR's branch head**, and cannot be grepped here. Treat the symbol as the anchor
and the line number as a hint that will drift; re-grep the symbol before implementing. Everything
not so labelled was read in this branch's own merged tree at `2a622ca`.

### 0.1 Tags

| What | Exact symbol verified |
|---|---|
| Wire field on the asset | `assetSchema` → `tags: z.array(z.string()).optional()`, `src/routes/assets.ts`. Comment on the line above it: *"First-class tags (issue #11). Absent until the first tag is set."* Mirrored in `openapi.json` → `paths["/api/v1/assets/{id}"].get.responses["200"]…properties.tags` = `{"type":"array","items":{"type":"string"}}`, and **not** in that schema's `required` list (`required: ["id","name","status","statusHistory","createdAt","updatedAt"]`) |
| Empty ⇒ **absent**, not `[]` | `tags: doc.descriptive.tags && doc.descriptive.tags.length > 0 ? doc.descriptive.tags : undefined` in `assetFromDocument`, `src/data/asset-document.ts` |
| Persisted location | `descriptive.tags: z.array(z.string()).default([])` in `AssetDocumentSchema`, `src/data/asset-document.ts`; written from the flat asset as `tags: asset.tags ?? []` inside the `descriptive: { … }` literal of `documentFromAsset`. User-writable `descriptive` namespace, **not** system-owned `administrative` |
| Per-tag validation | `const tagSchema = z.string().min(1).max(128)`, `src/routes/assets.ts`. **No `.trim()`, no charset restriction, no case folding** |
| List cap | `const tagsSchema = z.array(tagSchema).max(128)`, `src/routes/assets.ts` (the line directly after `tagSchema`) |
| Append endpoint | `app.post('/:id/tags', …)`, `src/routes/assets.ts`. Body `z.object({ tags: z.array(tagSchema).min(1).max(128) })`; `response: { 200: assetSchema, 404: errorSchema }` — **200 returns the FULL asset**, not the tag list |
| Append is merge + dedupe | `normalizeTags([...(asset.tags ?? []), ...request.body.tags])` in the `POST /:id/tags` handler, `src/routes/assets.ts` |
| Dedupe is exact-string, first-seen order | `export function normalizeTags(tags: readonly string[]): string[]`, `src/data/asset-repo.ts` — `const seen = new Set<string>()` on the raw value. `"News"` and `"news"` are two tags; `" news"` and `"news"` are two tags |
| Remove endpoint | `app.delete('/:id/tags/:tag', …)`, `src/routes/assets.ts`. `params: z.object({ id: z.string(), tag: z.string().min(1) })`; `response: { 200: assetSchema, 404: errorSchema }`. Handler filters with `(asset.tags ?? []).filter((t) => t !== request.params.tag)`; removing an absent tag is a no-op that still answers 200 |
| PATCH replaces wholesale | `updateSchema` → `tags: tagsSchema.optional()`, `src/routes/assets.ts`, directly under the comment *"First-class tags (issue #11). On PATCH this REPLACES the tag list wholesale."* |
| Response `tags` is **unbounded** | `assetSchema` uses `z.array(z.string())`, not `tagsSchema` — the 128-item / 128-char caps are write-side only. (`createSchema` also takes `tags: tagsSchema.optional()`, so the caps apply on create too) |

### 0.2 Comments

| What | Exact symbol verified |
|---|---|
| Endpoints exist | `openapi.json` → `paths["/api/v1/assets/{id}/comments"]` exposes exactly `post` and `get`. Routes `app.post('/:id/comments', …)` and `app.get('/:id/comments', …)`, `src/routes/assets.ts` |
| Create body | `const commentBodySchema = z.object({ body: z.string().trim().min(1).max(4096) })`, `src/routes/assets.ts`. **`.trim()` is applied server-side here** — unlike tags |
| Comment shape | `const commentSchema = z.object({ id, assetId, body, createdAt })`, all `z.string()`, `src/routes/assets.ts` (immediately after `commentBodySchema`). In `openapi.json`: `required: ["id","assetId","body","createdAt"]`, `additionalProperties: false` |
| Create responses | `response: { 201: commentSchema, 404: errorSchema }` on `POST /:id/comments`. `openapi.json` → `…comments.post.responses` = exactly `["201","404"]` — **the 400 for an empty body is undeclared** (it comes from the zod validator compiler; the route's own source comment does document it: *"400 — empty / invalid body (rejected by commentBodySchema)"*) |
| List responses | `response: { 200: z.array(commentSchema), 404: errorSchema }` on `GET /:id/comments`. `openapi.json` → `…comments.get.responses` = exactly `["200","404"]`; the 200 schema is a bare array — **no envelope, no cursor, no total** |
| Order on the wire | **oldest first.** `InMemoryCommentRepository.listByAsset` sorts `a.createdAt.localeCompare(b.createdAt) \|\| a.id.localeCompare(b.id)`, `src/data/comment-repo.ts`; `CouchCommentRepository.listByAsset` (`src/data/couch-comment-repo.ts`) holds the same order. Interface contract comment: *"Comments for an asset in stable chronological order (oldest -> newest)"* on `CommentRepository.listByAsset`, `src/data/comment-repo.ts`. Covered by `it('keeps oldest-first ordering across the restart and scopes by asset')`, `test/asset-comments-couch.test.ts` |
| `id` is a ULID, `createdAt` is ISO 8601 | `export type Comment = { id: string; // ULID … createdAt: string; // ISO 8601 }`, `src/data/comment-repo.ts`; minted in `InMemoryCommentRepository.create` with `ulid()` and `new Date().toISOString()` |
| **No author field** | `Comment` has exactly `id`/`assetId`/`body`/`createdAt`; `CreateCommentInput` has exactly `assetId`/`body` (`src/data/comment-repo.ts`). There is no `author`, `createdBy`, or actor of any kind on the wire |
| **No update, no delete** | `interface CommentRepository` declares exactly `create` and `listByAsset`, `src/data/comment-repo.ts`. `openapi.json` exposes no `put`/`patch`/`delete` on `…/comments` and no `…/comments/{commentId}` path at all |
| Store is **durable per resolved stack** | `const commentRepository = new PerWorkspaceCommentRepository(stackResolver, app.log)`, `src/main.ts`, passed to the assets router as `commentRepository`. The facade (`export class PerWorkspaceCommentRepository`, `src/data/per-workspace-repos.ts`) delegates to `(await this.resolver.resolve()).comments`, which `buildConnectionsFromStack` / `buildEnvConnections` set to `new CouchCommentRepository(wc, log)` (`src/services/workspace-stack.ts`). Persisted since issue #1046 — see §0.2.1 |
| In-memory is the **last-resort fallback only** | `new InMemoryCommentRepository()` is returned by `workspace-stack.ts` only when no stack resolves, or on the env path with `MINIO_URL` but no `COUCHDB_URL`. `src/routes/assets.ts` still has `const comments = opts.commentRepository ?? new InMemoryCommentRepository()` — that default is for **tests**, which inject their own repo; `src/main.ts` always injects |
| Behaviour under test | `test/asset-comments.test.ts` (endpoint contract), `test/asset-comments-couch.test.ts` (`describe('asset comments survive a restart on CouchDB (issue #1046)')`), `test/comments-stack-wiring.test.ts` (`describe('comment store selection per resolved stack (#1046)')`) |

#### 0.2.1 Durability, exactly

`PerWorkspaceCommentRepository.repo()` (`src/data/per-workspace-repos.ts`) checks
`comments instanceof InMemoryCommentRepository` on every call and, the first time it is true, logs a
warning naming the reason:

> asset comments are being served from the IN-MEMORY store because the resolved stack has no
> CouchDB — comments will be LOST on restart (issue #1046). Provision a stack with CouchDB, or set
> `COUCHDB_URL`, for a durable comment store.

It re-arms the flag when the store becomes durable again, so a later fall-back is reported rather
than swallowed (`it('warns once when the resolved comment store is in-memory, and not when it is
durable')`, `test/comments-stack-wiring.test.ts`).

Two consequences for this panel:

1. On any deployment with a provisioned stack — the deployment shape this panel targets — comments
   are **as durable as tags and review state**. The comments sub-section is therefore buildable and
   shippable (see gap C4, §10, now resolved).
2. The fall-back is a **server-side** condition, surfaced only in the server log. There is still no
   field on the wire that tells a client which store is live, so the UI must not claim durability it
   cannot observe — it simply does not mention storage at all. That residual is tracked as C4a (§10).

### 0.3 Review state

| What | Exact symbol verified |
|---|---|
| Vocabulary | `export const ASSET_REVIEW_STATES = ['draft', 'in-review', 'approved', 'rejected'] as const`, `src/data/asset-repo.ts` |
| Persisted field | `reviewState: z.enum(ASSET_REVIEW_STATES).default('draft')`, `src/data/asset-document.ts`, inside the **system-owned `administrative`** namespace (sibling of `provenance` and `statusHistory`). Absent ⇒ `draft` |
| Wire field on the asset | `assetSchema` → `reviewState: reviewStateSchema.optional()`, `src/routes/assets.ts`. `openapi.json` → `…assets/{id}.get…properties.reviewState.enum` = `["draft","in-review","approved","rejected"]`, not in `required` |
| Transition graph | `const ALLOWED_REVIEW_TRANSITIONS: Record<AssetReviewState, readonly AssetReviewState[]>`, `src/data/asset-repo.ts` — `draft→['in-review']`, `in-review→['approved','rejected']`, `approved→['in-review']`, `rejected→['in-review']`. Read by **both** `isValidReviewTransition` (the 422 gate) and `allowedReviewTransitions` (what the read advertises) |
| Advertised ⊂ accepted, by exactly one value | The two readers of that table do **not** return the same set. `allowedReviewTransitions` returns `[...ALLOWED_REVIEW_TRANSITIONS[from ?? 'draft']]` and deliberately **excludes `from` itself**; `isValidReviewTransition` opens with `if (from === to) { return true; // idempotent no-op transitions are allowed }`. So re-sending the **current** state is accepted and answers **200, not 422**, even though the read never advertises it. The *graph of real moves* cannot drift (one table, two readers); the *accepted set* is the advertised set plus `{current}` — see §5.1 |
| No edge targets `draft` | The source comment above the table states it: *"`draft` is an ENTRY state only — once an asset has been submitted it can never go back to `draft`, and no edge anywhere in the table targets `draft`."* Also: no direct `approved → rejected` or `rejected → approved`; a verdict changes only by passing through `in-review` again |
| Read sub-resource | `app.get('/:id/review-state', …)`, `src/routes/assets.ts`. `response: { 200: reviewStateReadSchema, 404: errorSchema }`. Handler: `const current = asset.reviewState ?? 'draft'`, then sends `{ reviewState: current, allowedTransitions: allowedReviewTransitions(current) }` |
| 200 shape | `const reviewStateReadSchema = z.object({ reviewState, allowedTransitions })`, `src/routes/assets.ts`; both `required`, `additionalProperties: false` in `openapi.json`. `allowedTransitions` may be empty ⇒ terminal; the current state is never listed |
| Write sub-resource | `app.post('/:id/review-state', …)`, `src/routes/assets.ts`. Body `z.object({ reviewState: reviewStateSchema })`. `response: { 200: assetSchema, 404: errorSchema, 422: errorSchema }` — **200 returns the FULL asset** |
| 422 body | `return reply.code(422).send({ error: 'invalid_review_transition', message: err.message })`, `src/routes/assets.ts` (the router's error mapping, not the handler) |
| Two independent axes | Source comment above `ASSET_REVIEW_STATES`, `src/data/asset-repo.ts`: *"The two are INDEPENDENT: a `ready` asset can be `draft`, `in-review`, `approved`, or `rejected`, and moving one never moves the other."* |
| Existing contract note | `docs/findings/review-state-contract-897.md` — §1 graph, §4 auth, §5 UI notes, §6 gaps G1–G3 |

### 0.4 Lifecycle `status` (the axis review state must never be confused with)

| What | Exact symbol verified |
|---|---|
| Vocabulary | `export const ASSET_STATUSES = ['uploading', 'processing', 'ready', 'failed', 'archived'] as const`, `src/data/asset-repo.ts`. Confirmed on the wire: `openapi.json` → `…assets/{id}.get…properties.status.enum` |
| `status` is `required` on the wire | `openapi.json` → `…assets/{id}.get.responses["200"]…required` = `["id","name","status","statusHistory","createdAt","updatedAt"]`, so `status` and `statusHistory` are both required — unlike `reviewState` and `tags`, which are optional |
| Has an audited trail | `statusHistory: array of { at, from: <status>\|null, to: <status> }`, `openapi.json` same schema; `statusHistory: z.array(transitionSchema)` on `assetSchema`, `src/routes/assets.ts`. (Note: the comment block above the status-history renderer cites this as *"`statusHistory` on `assetSchema` (src/routes/assets.ts:855)"*, `public/app.js:2801` — and that line number is itself stale: the field is at `src/routes/assets.ts:1011` at `2a622ca`. A standing illustration of why this spec anchors on symbols, not lines) |
| **Zero vocabulary overlap with review state** | `ASSET_STATUSES` and `ASSET_REVIEW_STATES` (both `src/data/asset-repo.ts`) share no member |

### 0.5 Authorization (ADR-018)

| What | Exact symbol verified |
|---|---|
| Matrix | `const MATRIX: Record<PrincipalRole, Record<Action, boolean>>`, `src/auth/authorize.ts` — `viewer: { read: true, write: false, delete: false }`; `editor` and `admin` all true |
| Method ⇒ action | `export function methodToAction(method: string)`, `src/auth/authorize.ts` — `GET`/`HEAD` → `read`, `POST`/`PUT`/`PATCH` → `write`, `DELETE` → `delete`, anything else `undefined` |
| Enforcement point | `app.addHook('preHandler', resourceAuthorizationPreHandler('asset'))`, `src/routes/assets.ts` (handler `export function resourceAuthorizationPreHandler`, `src/auth/authorize.ts`). **Router-scoped, so it covers every sub-resource in this panel** |
| Denial | 403 `export const AUTHZ_FORBIDDEN_ERROR = 'forbidden_insufficient_role' as const`, `src/auth/authorize.ts`. A `null` (unrecognised) role fails closed — `if (role === null)` returns false before `MATRIX` is consulted |
| Client-side mirror | `function canChangeReviewState()`, `public/app.js` — `r === 'editor' \|\| r === 'admin'` off `getClientRole()`. A mirror only; the 403 is still handled when it arrives |

Derived per-control gate for this panel:

| Control | Method | Action | `viewer` | `editor` / `admin` |
|---|---|---|:--:|:--:|
| Read review state + legal moves | `GET …/review-state` | `read` | allowed | allowed |
| Apply a review transition | `POST …/review-state` | `write` | **403** | allowed |
| Read tags (via the asset read) | `GET …/assets/{id}` | `read` | allowed | allowed |
| Add tags | `POST …/tags` | `write` | **403** | allowed |
| Remove a tag | `DELETE …/tags/{tag}` | **`delete`** | **403** | allowed |
| Read comments | `GET …/comments` | `read` | allowed | allowed |
| Post a comment | `POST …/comments` | `write` | **403** | allowed |

### 0.6 Sub-resources take the ULID only — never the slug

`async function resolveAsset(idOrSlug)` (`src/routes/assets.ts`) is the only ULID-or-slug resolver:
`if (isUlid(idOrSlug)) return repo.get(idOrSlug); return repo.getBySlug(idOrSlug);`. Verified by
grep, it has **exactly one caller** — the `app.get('/:id', …)` detail handler.

Every sub-resource in this panel bypasses it and goes straight to the id:

| Call | How it reads the id |
|---|---|
| `POST /:id/tags` | `const asset = await repo.get(request.params.id)` |
| `DELETE /:id/tags/:tag` | `const asset = await repo.get(request.params.id)` |
| `POST /:id/comments` | `const asset = await repo.get(request.params.id)` |
| `GET /:id/comments` | `const asset = await repo.get(request.params.id)` |
| `GET /:id/review-state` | `const asset = await repo.get(request.params.id)` |
| `POST /:id/review-state` | `await repo.transitionReviewState(request.params.id, …)` — no `repo.get` at all |

So **all six calls must use `asset.id` (the ULID), even when the detail pane was opened by slug.**
Passing a slug yields a 404 that looks like a missing asset. (`renderAssetDetailBody` already holds
`asset.id`, and the existing `mountReviewState` call already passes `assetId: asset.id` for this
reason.)

### 0.7 Client primitives already in the tree

All anchored to symbols / literals; grep the quoted string.

| What | Exact symbol verified |
|---|---|
| Detail renderer | `async function renderAssetDetailBody(id, bodyEl, opts)`, `public/app.js` |
| Summary grid | `kvDiv.className = 'kv-grid'` inside `renderAssetDetailBody`, built from `kvRows` via the `kvHtml` map directly above it |
| Lifecycle status cell | `['Status', statusCell]` in the `kvRows.push(…)` block. `statusCell` is an **HTML string**, not an element: `var statusCell = renderBadge(asset.status)` then `statusCell += …` for the wedged "Needs attention" badge (`isAssetWedged(asset)`) and for `asset.sceneDetectionError` |
| **Tags row (today's home for tags)** | `['Tags', renderTags(asset.tags)]` in the same `kvRows.push(…)` block |
| Tag pill renderer | `function renderTags(tags)`, `public/app.js` — returns `'<span class="text-muted">—</span>'` when falsy/empty, else `.map(…'<span class="tag">' + escHtml(t) + '</span>').join(' ')`. **Also called by the search-results table (`'<td>' + renderTags(hit.tags) + '</td>'`) and injected into the shared assets table (`renderTags,` in the `createAssetsTable({…})` literal → `const renderTags = renderCtx.renderTags` in `buildColumns`, then `render: (a) => renderTags(a.tags)` on the `key: 'tags'` column, `public/assets-table.js`)**, so it must not change shape |
| Lifecycle badge renderer | `function renderBadge(status)`, `public/app.js`; class chosen by `function badgeClass(status)` directly above it — four buckets plus `'badge-unknown'` for anything unrecognised (`archived` buckets with `failed` into `badge-failed`) |
| Status-history block | guarded by `if (lifecycleHistory.length > 0)` in `renderAssetDetailBody`; `histDiv.id = 'status-history'`; heading `histTitle.textContent = 'Status history'`; rendered **newest first** via `.slice().reverse()` on `lifecycleHistory`, with the caption *"Audited status transitions, newest first"* |
| Review-state block (exists) | `await mountReviewState({ assetId: asset.id, anchorEl: actionsDiv, host: body, canChange: canChangeReviewState(), apiFetch: apiFetch, showMsg: showMsg })`, `public/app.js`; module `public/review-state.js` |
| Comments block (exists — merged #1040) | `await mountAssetComments({ assetId: asset.id, anchorEl: actionsDiv, host: body, canAdd: canAddComment(), apiFetch, showMsg, fmtDate })`, `public/app.js:3424`; module `public/comments-panel.js`. Role mirror is its own helper, `function canAddComment()`, `public/app.js:270` — **not** `canChangeReviewState()` |
| Comment CSS (exists — merged #1040) | `.comment-list` (`public/style.css:698`), `.comment-item` (`:707`), `.comment-meta` (`:714`), `.comment-body` (`:725`), `.comment-form` (`:731`), `.comment-input` (`:735`) |
| Action row (the anchor) | `const actionsDiv = document.createElement('div'); actionsDiv.className = 'mt12 flex-gap';` … `body.appendChild(actionsDiv)` |
| Shared outcome region | `actionMsg.id = 'action-msg'; actionMsg.className = 'mt8';` + `actionMsg.setAttribute('aria-live', 'polite')`. Re-read on each use as `bodyEl.querySelector('#action-msg') \|\| bodyEl` |
| Heading conventions | `.section-title` `public/style.css`; sub-group heading precedent `.tracks-group-title` (`font-size: 12px; font-weight: 600; color: var(--text-muted); margin: 12px 0 6px`) |
| Badge styles | `.badge` (`border-radius: 20px`); `.review-badge` (`border-radius: 3px` + `border: 1px solid transparent`); per-state variants `.review-badge--draft` / `--in-review` / `--approved` / `--rejected` / `--unknown`; `.review-block` left accent rail (`border-left: 3px solid var(--review-accent, #2dd4bf); padding-left: 10px`); `.tag` (`border-radius: 20px`, accent-tinted) — all `public/style.css` |
| Disclosure precedent, **in JS** | `function rawJsonDisclosure(value, open)`, `public/app.js` — builds a native `<details>` with `className = RAW_DISCLOSURE_CLASS + ' mt12'` and a `<summary>` written via `textContent`. Its own comment names the second precedent (*"matching the existing / disclosure idiom in"* — the sentence wraps across two comment lines) as `renderCollectionAssetPicker()`, which inlines `'<details class="mt8" id="add-asset-fallback">'` + `'<summary>Add by asset ID instead</summary>'` |
| Disclosure precedent, **in CSS** | **`details`/`summary` rules now EXIST** (added with issue #964): `.raw-disclosure > summary` plus `:hover` and `:focus-visible` variants, `public/style.css`. They are **scoped to `.raw-disclosure`**, not to bare `summary`, so they do not apply to a new disclosure — see §6.4 |
| Date formatter | `function fmtDate(val)`, `public/app.js` — returns `'—'` for falsy |
| Escaping | `function escHtml(str)`, `public/app.js` |
| Comma-separated convention already in the UI | `'<label for="search-tags">Tags (comma-separated)</label>'` with `placeholder="news,sports"`, read as `section.querySelector('#search-tags').value.trim()`, `public/app.js` |
| Sibling-module convention | `public/review-state.js`, `public/lock-detail.js`, `public/tracks-panel.js`, `public/asset-rename.js`, `public/asset-clip.js` — one concern per file, mounted from `renderAssetDetailBody` |

**Today's scatter, precisely.** Tags are a read-only row in the summary grid
(`['Tags', renderTags(asset.tags)]`) with *no write control anywhere in `public/`* — grep confirms
nothing in the client calls `POST /:id/tags` or `DELETE /:id/tags/:tag`. Review state is its own
block wedged above the action row (`mountReviewState({ …, anchorEl: actionsDiv, host: body })`).
Comments **do have a UI in this tree**: PR #1040 merged to `main` as `c1a6368`, landing
`public/comments-panel.js` (`mountAssetComments`, imported at `public/app.js:96`) and mounting it
from `renderAssetDetailBody` at `public/app.js:3424` with `anchorEl: actionsDiv, host: body` — the
same slot the review block uses (`await mountReviewState({`, `public/app.js:3328`). An earlier
revision of this spec said comments had *"no UI at all"*; that was true against `main` before
`c1a6368` and is **false now**, which is why §5.3.0 is a re-parent brief and not a build brief.
Tags are the one half still absent from any merged tree: there is no write control in `public/`
(grep confirms nothing merged calls `POST /:id/tags` or `DELETE /:id/tags/:tag`), and the write UI
is in flight on **PR #1036** (`public/editorial-tags.js`, `mountEditorialTags` — *unmerged*).

So the scatter this spec replaces is: **one shipped scattered block** (comments, merged, wedged
above the action row), **one shipped scattered block** (review state, merged, wedged in the same
place), **one read-only grid row** (tags) and **one in-flight block** (tags write, #1036). #898 is
therefore mostly a re-parenting job, not a writing job. §5.3.0 states the comments half precisely;
the tags half needs nothing beyond the symbol name, because #1036 already matches this spec.

---

## 1. What the panel is

One container on asset detail, headed **"Editorial"**, holding the three things a human decides
about an asset — its approval state, its classification, and the notes people leave on it.

```
#editorial-panel  .editorial-panel
├─ .section-title            "Editorial"
├─ .editorial-intro          one line naming the axis (§4)
├─ #editorial-review         .editorial-group   "Review"     (always open)
├─ #editorial-tags           .editorial-group   "Tags"       (always open; overflow discloses)
└─ #editorial-comments       .editorial-group   "Comments"   (collapsible <details>)
```

**Naming.** The container is "Editorial", not "Metadata" and not "Workflow". "Metadata" already
means the free-form `metadata` object block (`metaTitle.textContent = 'Metadata'`, `public/app.js`);
"Workflow" would invite
confusion with the pipeline/job blocks above it. "Editorial" matches the vocabulary the source
already uses for this axis — `reviewState` sits in the user-facing editorial workflow
(the `reviewState` comment block in `src/data/asset-repo.ts`), the existing block heading is already
`REVIEW_COPY.heading = 'Editorial review'` (`public/review-state.js`), and `descriptive` is the
user-writable namespace tags live in (`descriptive: z.object({ … })` in `AssetDocumentSchema`,
`src/data/asset-document.ts`).

**The panel itself never collapses.** Only sub-sections do (§3). A collapsed panel would hide the
review axis behind a click, which is the exact failure #134 asks this layout to prevent.

---

## 2. Ordering, and why

Fixed order, top to bottom: **Review → Tags → Comments.** Not configurable, not reordered by
content, identical on every asset.

1. **Review first.** It is the only sub-section with a state machine, the only one whose controls
   are gated on a server-advertised set, and the only one an operator is blocked *by*. It also has
   to be the sub-section that sits furthest from the lifecycle `status` badge in the summary grid —
   see §4.
2. **Tags second.** Fixed, scannable height. Classification answers "what is this", which is
   context for the review decision above it.
3. **Comments last.** The only unbounded sub-section: the thread grows without limit and the API
   offers no pagination (§0.2). Anything placed below it gets pushed off-screen as the thread
   grows, so nothing is placed below it.

The same argument fixes the panel's own position: **immediately before the action row**
(`actionsDiv`, `public/app.js`) — i.e. exactly the slot `mountReviewState` already occupies via
`anchorEl: actionsDiv`. Read top-down the pane becomes: what the asset *is*
(summary grid, technical, tracks) → what has *happened* to it (status history, pipeline runs) → what
humans *decide and say* about it (this panel) → what you can *do* to it (action row, delete
protection, rename).

---

## 3. Disclosure and collapse

| Region | Collapses? | Default | Rule |
|---|---|---|---|
| `#editorial-panel` | **no** | — | Always rendered, always open, even on an asset with no tags and no comments |
| `#editorial-review` | **no** | — | Always open. Review state is never behind a click (#134) |
| `#editorial-tags` | no | — | The group is always open; the *pill list inside it* discloses (below) |
| tag overflow | yes | first 12 shown | When `tags.length > 12`, render 12 pills then a `<button>` toggle: `Show all 37 tags` / `Show fewer tags`. `aria-expanded` on the button, `aria-controls` pointing at the pill list. 12 ≈ three rows in the side pane at the `.tag` metrics in `public/style.css` |
| `#editorial-comments` | **yes** | open when `count ≤ 5`, else closed | Native `<details>`; `open` set from the fetched count on each render |
| comment overflow | yes | newest 10 shown | When `count > 10`, render 10 then `Show all 34 comments`. Same toggle pattern as tags |

**Disclosure state is not persisted.** No `localStorage`, no URL parameter. The rules above are a
pure function of the fetched data, so the same asset always presents the same way — for the operator,
for a screenshot in a bug report, and for a test. A remembered open/closed state would survive some
re-renders and not others (the pane is rebuilt wholesale whenever `renderAssetDetailBody` runs, but
individual sub-sections re-render in place after their own writes — §6.3), which is a worse
experience than a deterministic default.

**Empty sub-sections are shown, not hidden.** A tags group reading "No tags" plus an input is how an
operator learns tagging exists. Hiding empty groups would make the panel's shape vary per asset and
make the feature undiscoverable — the same reasoning `.tracks-none`
(`public/style.css`) already encodes for empty track sub-groups.

---

## 4. Review state vs lifecycle `status` — seven separations

`status` and `reviewState` are independent axes (the `reviewState` comment block,
`src/data/asset-repo.ts`) that an operator can
catastrophically confuse: "archived" and "rejected" are both things you would stop working on, but
one is a storage fact and the other is an editorial verdict. This design keeps them apart on seven
axes at once, so no single rendering mode (monochrome, colour-blind, zoomed, screen-reader) can
collapse the distinction.

| # | Separation | Lifecycle `status` | Review state |
|---|---|---|---|
| 1 | **Region** | `['Status', statusCell]` inside `.kv-grid` (`public/app.js`) | `#editorial-review`, inside the editorial panel |
| 2 | **Shape** | `.badge` — `border-radius: 20px`, a full pill (`public/style.css`) | `.review-badge` — `border-radius: 3px` + `border: 1px solid transparent`, a rectangle (`public/style.css`) |
| 3 | **Vocabulary** | `uploading`/`processing`/`ready`/`failed`/`archived` (`ASSET_STATUSES`) | `draft`/`in-review`/`approved`/`rejected` (`ASSET_REVIEW_STATES`) — both `src/data/asset-repo.ts`, **zero overlap, and this design forbids ever introducing an overlapping value on either axis** |
| 4 | **Always-present word label** | Preceded by the grid key `Status` | Preceded by the literal words `Review state:` (`REVIEW_COPY.stateKey`, rendered by `el('span', 'review-state-key', REVIEW_COPY.stateKey + ':')` in `public/review-state.js`; `.review-state-key` in `public/style.css`) — never a bare badge |
| 5 | **Container accent** | none | the panel carries a left accent rail (§4.1) |
| 6 | **Explicit sentence** | none needed | one sentence in the panel saying the two are different axes (§4.2) |
| 7 | **Trail** | the `Status history` table of transitions (`histDiv.id = 'status-history'`, `public/app.js`) | **no trail exists** — the API stores only the current state (§10, gap R1). The panel shows one state and never implies a history |

**Hard rule:** the two badges never appear in the same row, the same table cell, or the same grid.
A "review" chip in the assets *table* (out of scope here) would have to obey the same rule.

### 4.1 Move the accent rail from the block to the panel

`.review-block` currently owns the teal left rail (`border-left: 3px solid var(--review-accent, #2dd4bf)`,
`public/style.css`). With the review block
nested inside the editorial panel, that rail should move to `.editorial-panel` and be **removed**
from `.review-block`. A rail on both draws a rail inside a rail, which reads as two nesting levels
where there is one, and dilutes the signal that made the rail worth having. The rail then means
exactly one thing: *everything inside this boundary is the human/editorial axis; the lifecycle axis
is outside it.*

### 4.2 The axis sentence needs one word changed

`REVIEW_COPY.axisNote` (`public/review-state.js`) currently reads:

> Editorial approval. This is a separate axis from the lifecycle status **above** — moving one never
> moves the other.

"above" is a positional claim that happens to be true today and silently becomes false the moment
this block is re-parented, re-ordered, or the pane is narrowed. Replace the positional reference
with a nominal one, and promote the sentence to the panel intro (`.editorial-intro`) so it covers all
three sub-sections:

> **Editorial state — set by people, not by the pipeline.** Review state, tags and comments are all
> edited here. Review state is a separate axis from the asset's lifecycle **status** in the summary
> grid: moving one never moves the other.

The per-block note then shortens to the non-positional half:

> Editorial approval. A separate axis from the lifecycle status — moving one never moves the other.

---

## 5. Sub-section specifications

### 5.1 `#editorial-review` — Review

Behaviour is already specified and implemented by `public/review-state.js` (#901) and is **not
redesigned here**. This spec changes only its placement and two copy strings:

- It becomes the **first child of the editorial panel** instead of a sibling of the action row:
  `mountReviewState({ assetId: asset.id, host: editorialPanel })` with **no `anchorEl`**. Its JSDoc
  already promises this — *"The block is inserted before `anchorEl` when given, else appended to
  `host`."* — and `place()` implements it (`if (o.anchorEl && o.anchorEl.parentNode) … else if
  (o.host) { o.host.appendChild(block); }`), so **no signature change is needed**.
- Its heading drops to the sub-group level: `.editorial-group-title` reading **"Review"**, not
  `.section-title` reading "Editorial review" — "Editorial" is now the panel heading, and repeating
  it inside would read as a section of its own (the exact problem `.tracks-group-title`
  (`public/style.css`) was introduced to solve).
- `REVIEW_COPY.axisNote` loses the word "above" (§4.2).
- `.review-block` loses its left rail (§4.1).

Everything else holds: one transition button per entry of the server's `allowedTransitions` and by no
other route; empty array ⇒ the terminal sentence; `viewer` ⇒ state visible, no buttons, role note;
403 ⇒ the action group is removed for the rest of the view; 422 ⇒ re-read and say the state moved.

**The one accepted move the read never advertises.** `isValidReviewTransition` returns `true` when
`from === to` (*"idempotent no-op transitions are allowed"*), while `allowedReviewTransitions`
deliberately excludes the current state — its comment says advertising it *"would put a button on the
screen that changes nothing"* (§0.3). So re-sending the current state answers **200 with an unchanged
asset**, not 422.

Build-only-from-`allowedTransitions` already makes that unreachable from the UI, and this spec keeps
it that way — there is no "confirm current state" control. The consequence worth writing down is for
**error copy**, not for layout: a 200 from `POST …/review-state` does **not** prove a transition
happened, so the success message must be phrased from the state in the returned asset ("Review state
is now *approved*") rather than from the state the client asked for ("Moved to *approved*"). The 422
path is correspondingly narrower than "any state not in `allowedTransitions`": it is every such state
**except** the current one.

### 5.2 `#editorial-tags` — Tags

This is the sub-section with the most new surface: tags are currently **read-only in the client**
(§0.7) even though two write endpoints exist.

```
Tags
┌──────────────────────────────────────────────────────────┐
│ [news ×] [sports ×] [2026-final ×]        ← .tag pills  │
│                                                          │
│ [ add a tag…                       ] [Add]               │
│ Separate several tags with commas.                        │
└──────────────────────────────────────────────────────────┘
```

**Read.** Tags come from the asset read already in hand (`asset.tags`); **no extra request**. The
field is **absent when empty** (§0.1), so the
renderer must treat `undefined` and `[]` identically — the existing `renderTags` guard
(`if (!tags || tags.length === 0) return …`) already does. Order is the server's first-seen order
(`normalizeTags`, `src/data/asset-repo.ts`); **do not sort client-side** — re-sorting would
make a newly added tag jump to an unpredictable position instead of appearing at the end where the
operator's eye already is.

**Add.** One `POST …/tags` with the whole array, never one request per tag — the body takes an array
(`body: z.object({ tags: z.array(tagSchema).min(1).max(128) })`), so a comma-separated entry of five
tags is one round trip. The comma-separated convention matches the existing search filter, whose
label is already `Tags (comma-separated)` with placeholder `news,sports` (`#search-tags`,
`public/app.js`).
The 200 is the **full asset** (`response: { 200: assetSchema, 404: errorSchema }`), so the write path re-renders from the response rather than
patching the pill list locally (same rule the lock and review blocks already follow) — that is the
only way the client observes the server's dedupe and ordering.

**Client-side normalisation, and its limits.** `tagSchema` (`src/routes/assets.ts`) has **no
`.trim()`** — in pointed contrast to `commentBodySchema`, which does. So the input
**must** trim each token and drop empties before sending; otherwise `" news"` is accepted as a tag
permanently distinct from `"news"`, invisible to the operator who typed it and unmatched by a search
for `news`. Dedupe is exact-string (`new Set<string>()` on the raw value in `normalizeTags`), so:

- **Trim** each comma-separated token; drop tokens that are empty after trimming; if every token is
  empty, show the inline error and send nothing.
- **Do not lowercase, do not fold, do not rewrite.** Silently altering an operator's text is worse
  than letting `News` and `news` coexist, and the search index matches what was stored.
- **Instead, help them match by eye:** the existing pills sit directly above the input, and a token
  that differs from an existing tag only by case gets a pre-submit inline note —
  *"This asset already has a tag `News`. Tags are case-sensitive, so `news` would be a second tag.
  Add it anyway?"* — with the operator's choice preserved either way.
- Drop a token already present verbatim (the server would dedupe it; sending it is a pointless
  write).

**Caps.** 128 tags per asset, 128 characters per tag (`tagSchema` / `tagsSchema`,
`src/routes/assets.ts`). Both are
enforced pre-submit with a specific message, because the server's rejection is an **undeclared**
zod 400: `…tags.post.responses` in `openapi.json` is exactly `["200","404"]`. Show the remaining
budget only when it is nearly gone (`tags.length ≥ 112`): *"16 of 128 tag slots left."*

**Remove.** An `×` button inside each pill, `aria-label="Remove tag news"`. No confirm dialog — a
tag is cheap to re-add and `POST …/tags` makes re-adding one click. The 200 again returns the full
asset, so removal re-renders from the response. Removing an absent tag is a server-side no-op that
still answers 200 (the handler's `.filter((t) => t !== request.params.tag)` simply matches nothing),
so a double click is harmless.

**The un-removable tag.** `tagSchema` restricts no characters, but removal addresses the tag as a
**path segment** (`app.delete('/:id/tags/:tag', …)`, `src/routes/assets.ts`). A tag containing `/`, `?`,
`#`, or a literal `%` cannot be addressed reliably even percent-encoded (gap T1, §10). The panel's
mitigation, in both directions:

- **Prevent:** reject those four characters in the *input*, pre-submit, naming them.
- **Be honest about what already exists:** a tag already carrying one of them is still **rendered**
  (never hidden — it is real data), but its `×` is `disabled` with
  `title="This tag can't be removed from here because it contains a character the remove URL can't
  carry. Replace the whole tag list with PATCH /assets/{id}."`

**Role gate.** `viewer` gets pills with no `×` and no input, plus the read-only note. `POST` is
`write` and `DELETE` is **`delete`** (`methodToAction`, `src/auth/authorize.ts`) — two different
actions. Both belong to `editor`/`admin` in today's `MATRIX` so one client-side mirror covers both, but
they must be mirrored as two capability checks, not one (gap T2, §10).

### 5.3 `#editorial-comments` — Comments

#### 5.3.0 Reconciliation with the merged comments panel (#1040) — an amendment, not a greenfield build

**The comments UI already exists and is shipped.** Issue #900 — the implementation ticket this
sub-section feeds — is implemented on `main`: **PR #1040 merged as `c1a6368`**. Revision 2 of this
spec described the sub-section as if nothing existed and proposed a new module
`public/editorial-comments.js`. **That module must not be created.** There would then be two comment
UIs on one pane, both reading the same sub-resource, and the panel would be assembled from the wrong
one.

What `main` ships — all rows grepped in this tree at `2a622ca`:

| What | On `main` |
|---|---|
| Module | `public/comments-panel.js` — **not** `public/editorial-comments.js` |
| Mount symbol | `mountAssetComments`, called from `renderAssetDetailBody` at `public/app.js:3424` with `anchorEl: actionsDiv, host: body`, `canAdd: canAddComment()` |
| Render order | **oldest first** — `public/comments-panel.js:122` (*"Free-text notes on this asset, oldest first"*), `:49`, `:397`, and announced to assistive tech at `:401` |
| Behaviour after a successful add | **re-reads the sub-resource and rebuilds the block in place** — `async function refresh(quiet)` at `public/comments-panel.js:656`, called from the submit path at `:708` |
| Heading | plain `.section-title`, no disclosure — `block.appendChild(el('div', 'section-title', heading))`, `public/comments-panel.js:364` |
| CSS classes | `.comment-item`, `.comment-meta`, `.comment-body` — `public/style.css:707`, `:714`, `:725` (with `.comment-list` `:698`, `.comment-form` `:731`, `.comment-input` `:735`) |
| Durability copy | `COMMENTS_COPY.durabilityNote`, `public/comments-panel.js:129-131` — says comments *"do not survive an API restart"*. **Wrong on `main` today — see the follow-up note in §5.3 *Durability*** |

Because #1040 is merged, A1–A3 below are **edits to shipped, operator-visible behaviour**, not
negotiations against an open PR. Each one changes something an operator can see on `main` right now,
so each is written as an explicit, reversible decision.

**So the comments work under #898 is: re-parent `mountAssetComments` into the editorial panel, then
apply the amendments below.** Concretely:

1. **Re-parent.** Change the existing call site from `{ anchorEl: actionsDiv, host: body }` to
   `{ host: editorialPanel }` (§6.2). This is the same re-parenting `mountReviewState` gets, and for
   the same reason. **`mountAssetComments` already supports a `host`-only call — no signature change
   is needed.** Revision 3 deferred this question; it is now answered by grep. Its JSDoc carries the
   same contract sentence as `mountReviewState` — *"The block is inserted before `anchorEl` when
   given, else appended to `host`"* (`public/comments-panel.js:522`, cf. `public/review-state.js:405`)
   — and `function place(block)` implements the identical branch: `o.anchorEl && o.anchorEl.parentNode`
   → `insertBefore`, `else if (o.host)` → `appendChild` (`public/comments-panel.js:553-556`, cf.
   `public/review-state.js:433-434`). `host` and `anchorEl` are both optional in the JSDoc
   (`[opts.host]` `:530`, `[opts.anchorEl]` `:531`). Dropping `anchorEl` is therefore a one-line
   change at the call site, exactly as for the review block.
2. **Re-house the heading** under `.editorial-group-title` reading `Comments ({n})` inside the
   `<details>`/`<summary>` (§3). Today the block renders a standalone `.section-title`
   (`public/comments-panel.js:364`), the same heading class the pane's other top-level blocks use —
   correct for a standalone block, one level too loud for a sub-section of the panel.
3. **Apply amendments A1–A3** below, each of which reverses behaviour already shipped on `main`.
4. **Do not carry `COMMENTS_COPY.durabilityNote` into the panel** — and note that it is already wrong
   on `main` independently of this work, so it is tracked as a separate code bug rather than a line
   item here (§5.3 *Durability*, §10 gap C4, §11).

**Three amendments to behaviour already shipped on `main`.** These are written as explicit changes
so that reversing them later — or deciding during implementation that the shipped behaviour was
right — is a visible, deliberate decision recorded against this spec, not a silent conflict resolved
by whoever rebases last. **A1 and A3 are visible to operators using the product today**, so each
needs a deliberate "yes, change it" rather than a quiet re-implementation.

| # | Shipped on `main` | This spec specifies | Reversible? |
|---|---|---|---|
| **A1** | oldest first (`public/comments-panel.js:122`, `:49`, `:397`, `:401`) | **newest first** (reverse the wire order) | Yes — see the rationale in *Order* below. This flips an order an operator already reads today, and the on-screen copy says so, so the copy at `:122` and the `aria-label` at `:401` change with it. If the operator research behind the shipped order said otherwise, keep oldest-first and amend §3 (comment overflow becomes "oldest 10 hidden") and §11. Record the reversal here. |
| **A2** | re-read the sub-resource and rebuild the block in place after a successful add (`refresh`, `public/comments-panel.js:656`, called at `:708`) | **prepend the 201 body** to the rendered list | Yes, and **A2 is the weaker of the two positions.** The shipped re-read is strictly more correct: it cannot drift from the server, and it costs one extra `GET` on an already-unpaginated resource (gap C2). A2's only advantages are one fewer round trip and not losing scroll position. **Keeping the shipped re-read is an accepted outcome** — the binding requirement is only that `id`/`createdAt` are never synthesised client-side. The module already exposes `refresh()` on its return value (`public/comments-panel.js:752-754`), so the panel can drive a re-read without touching the internals. |
| **A3** | heading/block rendered standalone, no disclosure (`.section-title`, `public/comments-panel.js:364`) | wrapped in a native `<details>`, open when `count ≤ 5` (§3) | Yes — but A3 is load-bearing for the panel's shape: without it an unbounded thread pushes everything below it off-screen (§2). |

**Class names: adopt the shipped ones, supersede this spec's.** Revision 2 proposed `.comment-row`
and `.comment-time`. `main` already defines `.comment-item` (`public/style.css:707`),
`.comment-meta` (`:714`) and `.comment-body` (`:725`). **`.comment-item` and `.comment-meta` are
hereby adopted and `.comment-row` / `.comment-time` are withdrawn** — renaming shipped classes to
satisfy a design doc buys nothing, and `.comment-body` was already the same name in both. §6.4
carries the corrected list. Only genuinely new classes are added.

```
▾ Comments (3)
┌──────────────────────────────────────────────────────────┐
│ [ Add a note…                                         ]  │
│                                       (0/4096)  [Post]   │
│ Comments are not attributed to a user.                    │
│──────────────────────────────────────────────────────────│
│ 2026-09-30 14:02   Cleared for the 18:00 bulletin.       │
│ 2026-09-29 09:41   Audio 3 dB hot from 00:04.            │
│ 2026-09-28 16:15   Received from the field.              │
└──────────────────────────────────────────────────────────┘
```

**Fetch.** One `GET …/comments` per render of the panel, using `asset.id` (§0.6). The response is a
bare array with no envelope and no cursor (`response: { 200: z.array(commentSchema), … }`,
`src/routes/assets.ts`).

**Order: newest first — which means reversing the wire order, and reversing shipped behaviour
(amendment A1).** The API returns oldest→newest (`listByAsset`, §0.2) and **the merged panel renders
that order through** (`public/comments-panel.js:122`, `:49`, `:397`, `:401`); this spec renders the
reverse, so adopting it edits what operators see today, not a draft. Two reasons: it matches the
convention the pane already sets for `Status history`, which reverses for exactly this purpose
(`.slice().reverse()` on `lifecycleHistory`, `public/app.js`), and in a side pane with a collapsed,
unpaginated thread the operator's
question is "what is the latest note", which must be answerable without scrolling. The cost is that
a long thread no longer reads as a conversation top-to-bottom; that is the right trade for a notes
field with no replies, no threading and no attribution. If that trade is rejected during
implementation, keep the shipped oldest-first and record the reversal in the A1 row of §5.3.0 — do
not leave the two orders to be settled by a rebase. Either way the **on-screen copy must match the
rendered order**: `public/comments-panel.js:122` states the order to the operator in words and
`:401` states it in the list's `aria-label`, so flipping the render without flipping both strings
ships a panel that describes itself incorrectly.

**Composer at the top**, above the list, for the same reason: the control must not move down the
page as the thread grows.

**Post (amendment A2 — the one place this spec is the weaker position).** `POST …/comments` with
`{ body }`. The 201 returns **the created comment**, not the asset
(`response: { 201: commentSchema, 404: errorSchema }`) — so unlike tags and review state, this
response cannot re-render the
whole panel. This spec's preference is to prepend the returned comment to the rendered list, clear
the composer, and announce the result in the sub-section's `aria-live` region.

**`main` instead re-reads the sub-resource and rebuilds the block in place** — `async function
refresh(quiet)` (`public/comments-panel.js:656`), called from the submit path at `:708`, with the
reasoning stated in the module's own header (`:11`, *"A successful add re-reads the list in place"*)
and its JSDoc (`:517-520`). That is strictly more correct — the rendered list cannot drift from the
server — at the cost of one extra unpaginated `GET` (gap C2) and the scroll position. **Either is
acceptable; the shipped re-read may be kept as-is**, and the module already exposes `refresh()` on
its return value (`public/comments-panel.js:752-754`) if the panel needs to drive one. What is *not*
negotiable either way: do **not** synthesise the comment from the
local draft. `id` and `createdAt` are server-minted (`ulid()` / `new Date().toISOString()` in the
repository's `create`) and the rendered row must show the server's values — which both approaches
satisfy, since both render only what the server returned.

**Validation.** `body` is trimmed server-side then `min(1).max(4096)`
(`commentBodySchema`, `src/routes/assets.ts`). Mirror it: `Post` is disabled while the trimmed draft
is empty; a
character counter appears at ≥ 3800 characters; over 4096 the button disables with
*"A comment can be at most 4096 characters. This one is 4210."* This matters more than usual because
the 400 is **undeclared** in the spec (`…comments.post.responses` = `["201","404"]`), so the client
cannot rely on a documented error shape for it — handle it as a generic failure and prevent it.

**No attribution, and say so.** There is no author field anywhere in the contract
(`Comment` / `CreateCommentInput`, `src/data/comment-repo.ts`, and `CouchCommentRepository` adds no
field of its own). The panel therefore shows **no** avatar, no "you", no name, and
no "added by". It carries one quiet line under the composer — *"Comments are not attributed to a
user."* — because an operator who assumes a note is signed may write something that only makes sense
if it is. This is the single most important honesty constraint in the sub-section (gap C1, §10).

**No edit, no delete.** `CommentRepository` declares only `create` and `listByAsset`
(`interface CommentRepository`, `src/data/comment-repo.ts`) and no `…/comments/{commentId}` path
exists. So no hover-edit, no
`×` on a comment row, and the composer's helper text must not imply a post is revisable. A typo is
fixed by posting a correction (gap C3, §10).

**Timestamps.** `createdAt` is ISO 8601 UTC (`createdAt: string; // ISO 8601` on `Comment`,
`src/data/comment-repo.ts`; minted with `new Date().toISOString()`). Render through the existing
`fmtDate` (`public/app.js`). If a relative form ("2 hours ago") is ever added it must be
*in addition to* the absolute timestamp, never instead of it.

**Role gate.** `viewer` gets the list with no composer, plus the read-only note.

**Durability.** Comments are persisted per resolved stack (§0.2.1), so this sub-section is cleared to
ship — gap C4 is **resolved** (§10). What remains is C4a: the client cannot observe *which* store is
live, so the panel carries **no durability copy at all** — no "saved", no "stored permanently", no
sync indicator. The thread is simply shown as read back from the server.

**One required deletion — and it is a shipped bug, not just a line item here.** `main` carries
`COMMENTS_COPY.durabilityNote` (`public/comments-panel.js:129-131`), which tells the operator that
comments *"do not survive an API restart"*, under a JSDoc line asserting *"The repository wired in
this deployment is in-memory (src/main.ts:979)"* (`:128`). **Both statements are wrong on `main`
today.** Comments are persisted: `src/main.ts:1081` reads *"Asset comments (issue #135), persisted
since issue #1046"* and `src/main.ts:1095` wires
`new PerWorkspaceCommentRepository(stackResolver, app.log)` (both grepped at `2a622ca`; the cited
`src/main.ts:979` no longer points at the wiring at all).

The panel must not carry that copy. But note the scope carefully:

> **Follow-up, outside this spec.** This is **wrong in shipped code right now**, visible to every
> operator who opens an asset, regardless of whether this layout ever lands. It should be fixed as
> its own bug against `public/comments-panel.js` — **not** held hostage to the editorial-panel work,
> which may land much later. This spec only states the rule the panel must obey; the §11 checklist
> links back here. Recommended: a bug issue titled *"comments panel tells operators comments are
> lost on restart, and cites a stale wiring line"*, covering both `:129-131` (the operator-visible
> string) and `:128` (the stale `src/main.ts:979` reference in the JSDoc).

**Delete, do not reword.** Rewording it into a positive claim would be just as wrong, because of
C4a: the client cannot observe which store is live, so it can honestly say neither "lost on restart"
nor "saved permanently". The correct copy is **none**.

---

## 6. Composition with `public/app.js`

Concrete, minimal, and expressed as a diff against `renderAssetDetailBody`
(`public/app.js`).

### 6.1 One row leaves the summary grid

Delete `['Tags', renderTags(asset.tags)]` (the `kvRows.push(…)` block, `public/app.js`) from
`kvRows`. Tags then live in
exactly one place on this pane. Leaving the row *and* adding the panel would put two renderings of
the same field on one screen, one of which silently goes stale after a write.

- `function renderTags(tags)` (`public/app.js`) itself **must not be touched** — the search-results
  table calls it (`'<td>' + renderTags(hit.tags) + '</td>'`), and it is injected into the shared
  assets table (`renderTags,` in the `createAssetsTable({…})` literal) where it renders the Tags
  column (`render: (a) => renderTags(a.tags)` on the `key: 'tags'` column, `public/assets-table.js`).
- The `['Status', statusCell]` row **stays** in the grid. It belongs there: the grid is the
  pipeline-owned summary of the asset, and keeping the lifecycle badge there while review state lives
  in the editorial panel is separation #1 in §4.
- No test asserts the detail pane's `Tags` row label (verified across `test/*.test.ts`), so the
  removal is not a test-contract break.

### 6.2 One container replaces one mount

At the current review-state mount site (the `await mountReviewState({…})` call in
`renderAssetDetailBody`, `public/app.js`):

```
build #editorial-panel (heading + .editorial-intro)
insert it before actionsDiv            ← the slot mountReviewState uses today
  await mountReviewState({    assetId: asset.id, host: editorialPanel, canChange, apiFetch, showMsg })
  await mountEditorialTags({  assetId: asset.id, host: editorialPanel, tags: asset.tags, canChange, apiFetch, … })
  await mountAssetComments({  assetId: asset.id, host: editorialPanel, canAdd: canAddComment(), apiFetch, fmtDate, … })
```

- `mountReviewState` is called with `host` and **no `anchorEl`**, so it appends into the panel. Its
  existing `place()` already supports this; no signature change.
- The panel is inserted before `actionsDiv`, so **the vertical order of every
  other block is unchanged** — the panel occupies precisely the slot the review block occupies today.
- All three mounts receive `asset.id`, never `id` (the route parameter, which may be a slug) — §0.6.

**All three mount symbols already exist or are in flight — none is invented here.** The pseudo-code
above names the *real landing symbols*, not placeholders. **Two of the three are merged**, so their
rows were grepped in this tree at `2a622ca`:

| Mount | Module | Status |
|---|---|---|
| `mountReviewState` | `public/review-state.js` | **merged** — imported at `public/app.js:60`, called at `public/app.js:3328` with `anchorEl: actionsDiv, host: body`; this spec drops the `anchorEl`. `place()` already supports `host`-only (`public/review-state.js:405`, `:433-434`) |
| `mountEditorialTags` | `public/editorial-tags.js` | **in flight on PR #1036** *(unmerged — #1036; `public/editorial-tags.js:614` on that branch head — the one citation in this spec that cannot be grepped here)*. #1036 matches this spec; nothing in §5.2 changes |
| `mountAssetComments` | `public/comments-panel.js` | **merged (#1040, `c1a6368`)** — imported at `public/app.js:96`, called at `public/app.js:3424` with `anchorEl: actionsDiv, host: body` and `canAdd: canAddComment()`. Re-parent to `host: editorialPanel` (supported as-is — `public/comments-panel.js:522`, `:553-556`), then apply amendments A1–A3 — §5.3.0 |

- **Do not confuse the two merged mount sites.** They are ~96 lines apart in the same function and
  take near-identical option objects. `public/app.js:3328` is `await mountReviewState({`;
  `public/app.js:3424` is `await mountAssetComments({`. Re-parenting the wrong one is the single
  easiest mistake in this change, so grep the symbol rather than trusting either number — an earlier
  revision of this spec cited `:3296` for the comments mount, which is the *review* mount's line on
  an intermediate tree.
- **The role mirrors are different helpers.** `mountReviewState` takes
  `canChange: canChangeReviewState()`; `mountAssetComments` takes `canAdd: canAddComment()`
  (`public/app.js:270`); and §10 gap T2 requires tags to take **two** separate checks. Do not collapse
  them into one flag while re-parenting.
- **No new module is created for comments.** Revision 2 proposed `public/editorial-comments.js`;
  that is withdrawn in favour of amending `public/comments-panel.js` (§5.3.0). Creating it would put
  two comment UIs on one pane.
- The sibling-module convention (`public/review-state.js`, `public/lock-detail.js`,
  `public/tracks-panel.js` — one concern per file, mounted from `renderAssetDetailBody`) is satisfied
  by both in-flight modules as they stand, so the convention argument no longer implies new files.
- The naming inconsistency between `editorial-tags.js` and `comments-panel.js` is **accepted, not
  fixed.** Renaming a shipped module to match a doc's prefix is churn with no operator-visible
  effect; the panel is identified by `#editorial-panel`, not by its modules' filenames.

### 6.3 Messages and re-render

- Each sub-section keeps its **own** `aria-live` message host, as `public/review-state.js` already
  does. Sub-section outcomes do **not** go to the shared `#action-msg`
  (`actionMsg.id = 'action-msg'`, `public/app.js`), which belongs to the action row below and is far
  enough away that an operator would not connect the two.
- A tag write returns the full asset, so it re-renders the tags group from the response. It must
  **not** call `renderAssetDetailBody`, which would rebuild the whole pane, collapse the comments
  disclosure and destroy the composer draft.
- For the same reason a comment post updates only its own sub-section — by prepending one row
  (amendment A2) or by the shipped in-place re-read of `GET …/comments` (`refresh`,
  `public/comments-panel.js:656`) (§5.3). Both are acceptable; what neither may do is call
  `renderAssetDetailBody`. The merged panel already keeps a per-asset draft so a background refresh
  cannot wipe a half-typed comment (`public/app.js:3418-3419`); the panel must not regress that.

### 6.4 CSS to add (`public/style.css`)

`.editorial-panel` (accent rail, moved off `.review-block` — §4.1), `.editorial-group`,
`.editorial-group-title` (modelled on `.tracks-group-title`, `public/style.css`),
`.editorial-intro`, `.tag-remove` (the `×` affordance inside `.tag`), `.tag-input-row`.

**No comment-row classes are added — the shipped ones are adopted.** Revision 2 listed
`.comment-row`, `.comment-time` and `.comment-body` as new. `main` already defines
`.comment-item` (`public/style.css:707`), `.comment-meta` (`:714`) and `.comment-body` (`:725`),
which cover the same three roles, alongside `.comment-list` (`:698`), `.comment-form` (`:731`) and
`.comment-input` (`:735`). **Use the shipped names; `.comment-row` and `.comment-time` are
withdrawn** (§5.3.0). The only CSS the comments sub-section needs beyond what is already in
`public/style.css` is whatever the `<details>` wrapper requires (amendment A3), covered immediately
below.

**Disclosure styling: follow the precedent, don't re-invent it.** An earlier draft said no
`details`/`summary` rules existed in `public/style.css`. That is no longer true — issue #964 added
`.raw-disclosure > summary` with `:hover` and `:focus-visible` variants (`cursor: pointer`,
`color: var(--text-muted)`, `font-size: 12px`, `padding: 2px 0`, `user-select: none`, and a kept
focus ring: `outline: 2px solid var(--accent, var(--border))` with `outline-offset: 2px`).

Those rules are **class-scoped to `.raw-disclosure`**, so they will not style the comments
disclosure on their own. Two things follow:

- The comments `<details>` still needs its own rule — but it should **match** the `.raw-disclosure`
  summary treatment rather than invent a second disclosure look, and it must keep the same
  `:focus-visible` ring (WCAG 2.1 SC 2.4.7, which that rule's comment already cites).
- The cheapest honest implementation is to **extract the shared declarations into a selector list**
  (`.raw-disclosure > summary, .editorial-group > summary { … }`) instead of copying the block. One
  disclosure look, one place to change it.

`rawJsonDisclosure` (`public/app.js`) is the JS precedent to copy: native `<details>`, no ARIA of its
own, `<summary>` text set via `textContent`.

---

## 7. Empty, loading, error and role states

| Sub-section | Empty | Loading | Request failed | `viewer` |
|---|---|---|---|---|
| Review | n/a — always has a state (absent ⇒ `draft`: `const current = asset.reviewState ?? 'draft'`, `src/routes/assets.ts`) | none (single fetch, rendered on arrival) | `REVIEW_COPY.unavailable` + no controls (existing behaviour) | state + badge, no buttons, `REVIEW_COPY.readOnly` |
| Tags | "No tags yet." + input | none — comes from the asset read already in hand | inline error on the write only; the pill list is never blanked by a failed write | pills without `×`, no input, read-only note |
| Comments | "No comments yet." + composer | one-line "Loading comments…" (separate fetch) | "Could not load comments." + a `Retry` button; the composer is still shown, because posting does not depend on the list | list only, no composer, read-only note |

Read-only notes reuse the established phrasing of `REVIEW_COPY.readOnly`:
*"Your role can see the tags but cannot change them. Ask an editor or administrator."*

A failed write never silently discards operator input: a rejected comment stays in the composer, and
a rejected tag entry stays in the input.

---

## 8. Accessibility

- Panel heading `.section-title`; sub-section headings one level down
  (`.editorial-group-title`). Heading *levels* must nest — the panel heading cannot be an `h3` with
  `h2` children.
- Every sub-section has its own `aria-live="polite"` region; a write that does not move focus is
  still announced (the rule `docs/ux/asset-lock-state-spec.md` §8 already sets).
- Review state is never carried by colour or position alone: the words `Review state:` precede the
  badge, and the badge's shape differs from `.badge` (WCAG 1.4.1) — §4, separations 2 and 4.
- Disclosure toggles are real `<button>`s with `aria-expanded` + `aria-controls`; the comments
  `<details>`/`<summary>` gets that behaviour natively.
- Tag removal buttons carry `aria-label="Remove tag <name>"` — an `×` alone announces as "times".
- The tag input has a visible `<label>`; the composer has a visible `<label>` or an
  `aria-label` plus visible placeholder-independent helper text.
- Focus after a write lands somewhere stable: after adding tags, the tag input (so several tags can
  be added in sequence); after posting, the composer; after removing a tag, the next pill's `×`, or
  the input when the removed pill was last.
- All operator-visible server strings are written with `textContent` — including a review state or
  tag value this build does not recognise, which is rendered verbatim rather than guessed at
  (the rule `public/review-state.js` already sets).

---

## 9. Copy deck

| Key | Text |
|---|---|
| panel heading | Editorial |
| panel intro | Editorial state — set by people, not by the pipeline. Review state, tags and comments are all edited here. Review state is a separate axis from the asset's lifecycle status in the summary grid: moving one never moves the other. |
| review group heading | Review |
| review axis note (revised) | Editorial approval. A separate axis from the lifecycle status — moving one never moves the other. |
| tags group heading | Tags |
| tags empty | No tags yet. |
| tags input label | Add a tag |
| tags input helper | Separate several tags with commas. Tags are case-sensitive. |
| tags overflow open | Show all {n} tags |
| tags overflow close | Show fewer tags |
| tags near cap | {n} of 128 tag slots left. |
| tag too long | A tag can be at most 128 characters. “{first 24 chars}…” is {n}. |
| tag cap reached | This asset already has 128 tags, the maximum. Remove one before adding another. |
| tag bad character | A tag can’t contain / ? # or %. Those characters can’t be carried in the URL used to remove a tag again. |
| tag case clash | This asset already has a tag “{existing}”. Tags are case-sensitive, so “{typed}” would be a second tag. |
| tag unremovable | This tag can’t be removed from here because it contains a character the remove URL can’t carry. |
| tag remove label | Remove tag {name} |
| tags read-only | Your role can see the tags but cannot change them. Ask an editor or administrator. |
| tag add failed | Could not add {n, plural, one {that tag} other {those tags}}. The tag list is unchanged. |
| tag remove failed | Could not remove “{name}”. The tag list is unchanged. |
| comments group heading | Comments ({n}) |
| comments empty | No comments yet. |
| composer label | Add a note |
| composer attribution note | Comments are not attributed to a user. |
| composer over cap | A comment can be at most 4096 characters. This one is {n}. |
| comments overflow open | Show all {n} comments |
| comments overflow close | Show fewer comments |
| comments load failed | Could not load comments. |
| comment post failed | Could not post that comment. It is still in the box, so you can try again. |
| comments read-only | Your role can see the comments but cannot add one. Ask an editor or administrator. |

No commercial product names, and no vocabulary borrowed from any commercial MAM. "Review state",
"tags" and "comments" are the field names the contract already uses.

---

## 10. Gaps this design routes around

Carried forward from `docs/findings/review-state-contract-897.md` §6:

- **R1 (= G2) — no actor and no history on the review axis.** The asset stores only the current
  `reviewState` (`administrative.reviewState`, `src/data/asset-document.ts`); there is no
  `reviewedBy`, no `reviewedAt` and no
  per-transition trail, unlike lifecycle `statusHistory`. "Who approved this and when" is
  unanswerable. *Routed around:* the panel shows one state, has no "Review history" sub-section, and
  no copy implies a trail. This is the single largest functional asymmetry between the two axes in
  §4 (separation 7) — and the one most likely to be requested first.
- **R2 (= G1) — a review transition emits no audit entry.** `POST …/review-state`
  (`app.post('/:id/review-state', …)`, whose handler is just `repo.transitionReviewState(…)` + a 404
  branch + `reply.code(200).send(updated)`) calls no `emitAudit`, so editorial approval is absent from
  `GET /api/v1/audit`. *Routed around:* the panel cannot offer "see this in the audit log".
- **R3 (= G3) — `reviewState` optional on the asset read, resolved on the sub-resource.** The panel
  reads the sub-resource, so it is unaffected; any other surface reading `asset.reviewState` must
  apply absent-⇒-`draft` itself.

New, found while writing this spec:

- **T1 — a tag can be created that cannot be deleted.** `tagSchema`
  (`src/routes/assets.ts`) restricts no characters, but `DELETE /:id/tags/:tag` addresses the tag as
  a single path segment. A tag containing `/`, `?`, `#` or `%` is not
  reliably addressable. *Routed around* client-side in §5.2, but the real fix is server-side — either
  restrict the charset on write, or accept the tag to remove in a body. **Worth an API issue.**
- **T2 — add and remove tags are different authorization actions.** `POST …/tags` is `write` and
  `DELETE …/tags/{tag}` is `delete` (`methodToAction`, `src/auth/authorize.ts`). Today
  `editor`/`admin` hold both in `MATRIX` so nothing is observable, but any future role with `write` and not `delete` could add
  tags it cannot remove. The client mirror must be two checks, not one.
- **C1 — comments have no author.** `Comment` is exactly `{ id, assetId, body, createdAt }`
  (`src/data/comment-repo.ts`) and `CreateCommentInput` carries no actor, even
  though the request is authenticated and a principal role is resolved
  (`src/auth/authorize.ts`). An unattributed comment thread is of limited value for editorial
  hand-off. *Routed around:* the panel states plainly that comments are unattributed rather than
  implying otherwise. **Worth an API issue** — and it should be resolved before the comments UI is
  built, because adding attribution later changes this sub-section's layout.
- **C2 — comments are unpaginated.** `GET …/comments` returns a bare array with no cursor and no
  total (`response: { 200: z.array(commentSchema), … }`, `src/routes/assets.ts`), against the
  project's cursor-token pagination principle.
  Every render of the panel transfers the entire thread. *Routed around* with client-side truncation
  (§3), which limits rendering cost but not payload. **Worth an API issue.**
- **C3 — comments cannot be edited or deleted.** `CommentRepository` declares only `create` and
  `listByAsset` (`src/data/comment-repo.ts`); no `…/comments/{commentId}` path exists. A
  mistaken or sensitive note is permanent. *Routed around:* no such controls, and copy that does not
  imply revisability.
- **C4 — comments are not durable. RESOLVED (issue #1046), no longer blocking.** An earlier draft of
  this spec recorded C4 as blocking and said the comments sub-section must not ship. **That is false
  against current `main`.** A persistent `CommentRepository` now exists
  (`export class CouchCommentRepository implements CommentRepository`,
  `src/data/couch-comment-repo.ts`), it is wired per resolved stack
  (`comments: CommentRepository` on `WorkspaceConnections` and `new CouchCommentRepository(wc, log)`
  in `src/services/workspace-stack.ts`), and `src/main.ts` injects it into the assets router through
  `new PerWorkspaceCommentRepository(stackResolver, app.log)` under the comment *"Asset comments
  (issue #135), persisted since issue #1046."* Restart durability is covered by
  `describe('asset comments survive a restart on CouchDB (issue #1046)')`,
  `test/asset-comments-couch.test.ts` (that comment is at `src/main.ts:1081` in this tree, with the
  wiring at `:1095` — grepped at `2a622ca`; the line numbers will drift, the quoted text will not).
  **The comments sub-section is cleared to ship**; the merge gate that referenced this gap is
  withdrawn (§11). **One shipped string still asserts the resolved gap, and it is now live on
  `main`:** `COMMENTS_COPY.durabilityNote` (`public/comments-panel.js:129-131`) tells the operator
  that comments *"do not survive an API restart"*, and the JSDoc above it (`:128`) cites a wiring
  line (`src/main.ts:979`) that no longer holds the wiring. **That is a defect in shipped code, not
  a task this spec owns.** It must be fixed as its own bug against `public/comments-panel.js` —
  deleted rather than reworded, because C4a means no positive claim is observable either — and it
  must not wait on the editorial panel landing. See §5.3 *Durability* for the recommended issue, and
  the §11 checklist for the rule the panel itself must obey.
- **C4a — a client cannot tell which comment store is live.** The residual of C4. In-memory remains
  the fall-back when no stack resolves, or on the env path with `MINIO_URL` set and `COUCHDB_URL`
  unset (`src/services/workspace-stack.ts`); `PerWorkspaceCommentRepository.repo()` warns once to the
  **server log** when that happens, naming the reason (§0.2.1). Nothing on the wire exposes it — no
  field, no header, no health endpoint. *Routed around:* the panel makes **no durability claim at
  all**. It never says "saved permanently", never shows a sync/persistence indicator, and its copy
  reads the same either way, so a non-durable deployment cannot make the UI tell a lie. The honest
  fix is server-side — surface the resolved store in a readiness/health response so an operator
  dashboard can warn. **Worth an API issue** (low priority; the warning is already in the log and the
  default deployment path is durable).

None of these are OSC-platform limitations, so none are logged to `docs/osc-feedback/`; they are all
gaps in this project's own API surface.

---

## 11. Acceptance checklist for the implementation tickets

Layout / IA (all tickets):

- [ ] One `#editorial-panel` on asset detail, headed "Editorial", inserted **before** `actionsDiv`
      (`actionsDiv`, `public/app.js`) so no other block moves.
- [ ] Sub-sections in the fixed order Review → Tags → Comments, on every asset, including empty ones.
- [ ] The panel itself never collapses; the review sub-section never collapses.
- [ ] Comments `<details>` opens by default when `count ≤ 5`; tag overflow discloses past 12; comment
      overflow past 10. No disclosure state persisted.
- [ ] `['Tags', renderTags(asset.tags)]` removed from `kvRows`; `renderTags` itself unchanged (still
      called from the search-results table and injected into `public/assets-table.js`).
- [ ] `Status` row stays in the summary grid.
- [ ] The comments disclosure is styled by **extending** the existing `.raw-disclosure > summary`
      rules in `public/style.css` (issue #964) into a shared selector list, not by a second
      copy-pasted disclosure look — and the `:focus-visible` ring is kept.

Review-vs-`status` distinction (#134):

- [ ] The two badges never share a row, cell or grid.
- [ ] `.review-badge` keeps a shape distinct from `.badge` (rectangle vs 20px pill).
- [ ] The review badge is always preceded by the words "Review state".
- [ ] The accent rail is on `.editorial-panel`, removed from `.review-block`.
- [ ] The panel intro states the two-axis rule; `REVIEW_COPY.axisNote` no longer says "above".
- [ ] No "Review history" sub-section, and no copy implying a review trail (gap R1).
- [ ] The success message after `POST …/review-state` is phrased from the `reviewState` in the
      **returned asset**, not from the state the client requested — a 200 does not prove a move
      happened, because `from === to` is accepted as an idempotent no-op (§5.1).

Tags:

- [ ] `undefined` and `[]` render identically as the empty state.
- [ ] Server order preserved; no client-side sort.
- [ ] A comma-separated entry sends **one** `POST …/tags` with an array.
- [ ] Tokens trimmed client-side; empties dropped; nothing lowercased or rewritten.
- [ ] Case-clash note shown pre-submit; the operator's choice is honoured either way.
- [ ] 128-tag and 128-character caps enforced pre-submit with specific copy.
- [ ] `/ ? # %` rejected in the input; an existing tag containing one still renders, with a disabled
      `×` and the explanatory title (gap T1).
- [ ] Both writes re-render the group from the returned **full asset**, not from local state.
- [ ] `viewer` sees pills without `×`, no input, and the read-only note.

Comments — **amendments to the merged comments panel (#1040), not a new build** (§5.3.0):

- [ ] `public/editorial-comments.js` is **not** created. The sub-section is `mountAssetComments` in
      `public/comments-panel.js` (merged as `c1a6368`), re-parented — exactly one comment UI exists
      on the pane.
- [ ] `mountAssetComments` is called with `host: editorialPanel` and **no `anchorEl`** (it uses
      `anchorEl: actionsDiv, host: body` at `public/app.js:3424` today). **No signature change** —
      `host`-only is already supported (`public/comments-panel.js:522`, `:553-556`).
- [ ] The re-parented call is the **comments** mount at `public/app.js:3424`, not the review mount at
      `:3328`. Grep the symbol; the two calls are ~96 lines apart and look alike (§6.2).
- [ ] `canAdd: canAddComment()` (`public/app.js:270`) is preserved — not replaced by, or merged with,
      `canChangeReviewState()`.
- [ ] **A1:** rendered **newest first** — this *reverses* the oldest-first render shipped on `main`,
      which operators see today. The copy at `public/comments-panel.js:122` and the list `aria-label`
      at `:401` are flipped with it, so the panel does not describe itself incorrectly. If
      oldest-first is kept instead, the reversal is recorded in the A1 row of §5.3.0 and §3's
      comment-overflow rule is amended to match. Not left to a rebase.
- [ ] **A2:** after a successful add, the list shows only server-returned values — either the
      prepended 201 body (this spec) or the shipped in-place re-read of `GET …/comments`
      (`refresh`, `public/comments-panel.js:656`). **Either passes.** `id`/`createdAt` are never
      synthesised client-side, and the per-asset composer draft (`public/app.js:3418-3419`) survives.
- [ ] **A3:** the sub-section is wrapped in a native `<details>` (open when `count ≤ 5`), replacing
      the standalone `.section-title` block it renders today (`public/comments-panel.js:364`).
- [ ] The panel carries **no** durability copy — `COMMENTS_COPY.durabilityNote`
      (`public/comments-panel.js:129-131`) is not rendered inside it. **Deleting that string from the
      shipped module is a separate bug, tracked on its own issue, and is not a prerequisite for this
      panel** (§5.3 *Durability*, §10 C4): its "do not survive an API restart" copy contradicts
      `src/main.ts:1081` (*"Asset comments (issue #135), persisted since issue #1046"*), and the
      JSDoc at `:128` cites a stale wiring line. Deleted rather than reworded, because C4a means the
      client cannot observe a positive durability claim either.
- [ ] `.comment-item` / `.comment-meta` / `.comment-body` (`public/style.css:707`, `:714`, `:725`)
      are reused, as are `.comment-list` (`:698`), `.comment-form` (`:731`) and `.comment-input`
      (`:735`); no `.comment-row` / `.comment-time` is introduced (§6.4).
- [ ] Composer above the list.
- [ ] Trimmed-empty draft disables `Post`; over-4096 disables with the character count.
- [ ] The "not attributed to a user" line is present (gap C1).
- [ ] No edit and no delete affordance on a comment (gap C3).
- [ ] Absolute timestamps via `fmtDate`.
- [ ] `viewer` sees the list with no composer.
- [ ] No durability claim in the copy at all: nothing says "saved", "stored permanently", "lost on
      restart", or shows a persistence indicator (gap C4a — the client cannot observe which store is
      live).

Cross-cutting:

- [ ] All six sub-resource calls use `asset.id` (the ULID), never the route parameter (§0.6).
- [ ] Each sub-section has its own `aria-live` region; none writes to `#action-msg`.
- [ ] No write path calls `renderAssetDetailBody` (it would discard the composer draft).
- [ ] Every operator-visible server value set via `textContent`.
