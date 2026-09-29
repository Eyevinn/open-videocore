# Contract note: editorial review state and its transition graph — issue #897

**Verdict: the state machine EXISTS and is fully defined in code; the graph was
NOT readable through the API. This change adds the read side
(`GET /assets/{id}/review-state`) and names the re-review paths explicitly.**

Every shape below was read from this tree's source and from the spec the running
app generates (CLAUDE.md rule 7). Nothing is taken from the issue text.

Contract sources verified:

| What | Where |
|---|---|
| State vocabulary | `ASSET_REVIEW_STATES`, `src/data/asset-repo.ts` (`['draft','in-review','approved','rejected']`) |
| Transition table (the graph) | `ALLOWED_REVIEW_TRANSITIONS`, `src/data/asset-repo.ts` |
| The 422 gate | `isValidReviewTransition()` / `applyReviewState()` / `InvalidReviewTransitionError`, `src/data/asset-repo.ts` |
| Write route | `app.post('/:id/review-state', …)`, `src/routes/assets.ts` |
| Read route (added by #897) | `app.get('/:id/review-state', …)`, `src/routes/assets.ts` |
| Persisted shape | `reviewState: z.enum(ASSET_REVIEW_STATES).default('draft')`, `src/data/asset-document.ts` |
| Asset response field | `reviewState: reviewStateSchema.optional()` in `assetSchema`, `src/routes/assets.ts` |
| Generated spec | `openapi.json` → `paths["/api/v1/assets/{id}/review-state"]` |

---

## 1. The transition graph, exactly

`reviewState` is the **editorial approval** axis. It is INDEPENDENT of the
lifecycle `status`: a `ready` asset may be in any review state, and moving one
axis never moves the other (`src/data/asset-repo.ts`, the comment above
`ASSET_REVIEW_STATES`).

```
        (new asset)
             |
             v
   +----> draft ----> in-review ----> approved
   |                    ^  |             |
   |                    |  |             |
   |                    |  +--> rejected |
   |                    |         |      |
   |                    +---------+------+
   |                     (re-review paths)
   |
   (nothing ever returns to draft)
```

| From | Allowed next states | Meaning |
|---|---|---|
| `draft` | `in-review` | submit for review |
| `in-review` | `approved`, `rejected` | reviewer decision |
| `approved` | `in-review` | re-open an approved asset for re-review (a later edit needs fresh sign-off) |
| `rejected` | `in-review` | resubmit after changes |

**The re-review question #897 asks, answered:** both `approved` **and**
`rejected` return to **`in-review`** — and to nothing else. **Neither returns to
`draft`.** `draft` is an *entry state only*: no edge anywhere in the table
targets it, so once an asset has been submitted it can never be put back into
`draft` through this API. There is likewise **no direct `approved -> rejected`
or `rejected -> approved`**; a verdict can only be changed by passing through
`in-review` again.

No state is terminal — every state has at least one outgoing edge.

Anything not in the table is refused with **422**
(`InvalidReviewTransitionError`, `src/data/asset-repo.ts`), mapped in
`src/routes/assets.ts` to:

```json
{ "error": "invalid_review_transition", "message": "invalid review-state transition: approved -> rejected" }
```

**Self-transitions are accepted, not refused.** `isValidReviewTransition()`
returns `true` when `from === to`, so `POST {"reviewState":"approved"}` on an
already-`approved` asset returns **200** as an idempotent no-op. It is not a
move, and it is deliberately **not** advertised in `allowedTransitions` (§3).

**Absent means `draft`.** Assets stored before the field existed have no
`reviewState`; every read path resolves that to `draft`
(`applyReviewState()`'s `current ?? 'draft'` in `src/data/asset-repo.ts`, the
`.default('draft')` in `src/data/asset-document.ts`, and the new read route).

## 2. Endpoints

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/v1/assets/{id}/review-state` | read the current state **and the legal moves from it** (new, #897) |
| `POST` | `/api/v1/assets/{id}/review-state` | apply a transition; body `{ "reviewState": <state> }`; 200 returns the **full asset** |

The current state is also visible as `reviewState` on every asset response
(`assetSchema`, `src/routes/assets.ts`) — that field is unchanged. What was
missing, and what #897 adds, is the *graph*: `assetSchema` carries the state but
never said which moves it permits.

## 3. Read response

`GET /api/v1/assets/{id}/review-state` → **200**:

```json
{
  "reviewState": "in-review",
  "allowedTransitions": ["approved", "rejected"]
}
```

Both properties are required (generated: `openapi.json` →
`paths["/api/v1/assets/{id}/review-state"].get.responses["200"]`,
`required: ["reviewState","allowedTransitions"]`).

- `reviewState` — the current state; `draft` for an asset that has never been
  submitted, including pre-#134 records.
- `allowedTransitions` — the states this asset may move to **next**. Every value
  listed is accepted by the POST; every state *not* listed, other than
  `reviewState` itself, is refused with 422. The current state is never listed
  (see the self-transition note in §1). An empty array would mean a terminal
  state — no state is terminal today.

**404** `{ "error": "not_found" }` for an unknown or foreign asset (existence is
not leaked), matching the sibling POST and the other `/:id/*` sub-resources.

**No drift by construction.** `allowedTransitions` is produced by
`allowedReviewTransitions()` (`src/data/asset-repo.ts`) reading the same
`ALLOWED_REVIEW_TRANSITIONS` table that `isValidReviewTransition()` — the 422
gate — validates against. The advertised graph and the enforced graph are the
same object, and `src/routes/assets.review-state.test.ts` pins that
exhaustively: for every (from, to) pair it drives the real routes and asserts
200 iff the pair was advertised (or is the self no-op), 422 otherwise.

## 4. Auth

Enforcement is the router-scoped `resourceAuthorizationPreHandler('asset')`
(`src/routes/assets.ts`), which derives the action from the HTTP method
(`methodToAction`, `src/auth/authorize.ts`) and looks it up in `MATRIX`
(`src/auth/authorize.ts`, ADR-018 decision 1):

| Role | `GET /:id/review-state` (action `read`) | `POST /:id/review-state` (action `write`) |
|---|:--:|:--:|
| `viewer` | allowed | denied 403 |
| `editor` | allowed | allowed |
| `admin` | allowed | allowed |
| unrecognised role (`null`) | denied 403 (fail closed) | denied 403 |

A `viewer` can therefore read the state and its legal moves but cannot apply
one — the correct shape for a UI that renders the workflow read-only for
viewers. There is no review-specific permission and no reviewer role: anyone
with `write` on the asset can both submit and decide.

## 5. Notes for the UI (#792)

- Gate the buttons on `allowedTransitions`, not on a client-side copy of the
  graph. Re-read after every successful POST — the set changes with the state.
- Do not render a "re-submit to the same state" control: the self-transition
  succeeds but changes nothing, which is why it is not advertised.
- Do not render an "un-approve back to draft" control: that edge does not exist.
  The way back from `approved` is `in-review`.
- Present the axis distinctly from lifecycle `status` (#792 acceptance
  criterion). They share no vocabulary and never move together.

## 6. Gaps flagged

- **G1 — no audit entry for a review transition.** The asset router emits audit
  entries for `asset.created`, `asset.metadata_updated`, `asset.status_changed`
  and `asset.archived` (`src/routes/assets.ts`), but the review-state handler
  calls no `emitAudit`. An editorial approval — arguably the most
  accountability-relevant action in the workflow — is absent from
  `GET /api/v1/audit`. Same class of gap as G5 in
  `docs/findings/asset-lock-contract-892.md` (lock/unlock). Decide whether that
  is intended.
- **G2 — no actor and no history on the review axis.** The asset stores only the
  current `reviewState`. There is no `reviewedBy`, no `reviewedAt` and no
  per-transition history (unlike lifecycle `status`, which has
  `statusHistory`), so "who approved this and when" is unanswerable from the
  API. A UI can show the state but not the trail.
- **G3 — `reviewState` is optional on the asset response but required on this
  read.** `assetSchema` declares `reviewState` optional (absent ⇒ `draft`),
  while `GET /:id/review-state` always resolves it. A client reading the asset
  must apply the absent-means-draft rule itself; a client reading the
  sub-resource does not. Worth converging if the asset response ever
  back-fills the default.
