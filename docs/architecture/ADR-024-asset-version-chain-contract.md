# ADR-024: Asset version-chain contract — response shape, current-version identification, ordering, and chain topology

**Status:** PROPOSED 2026-09-29
**Date:** 2026-09-29
**Author agent:** claude-opus-5 (surface-backend-api)
**Issue:** #905 (broken out from #795; version-chain linkage originally shipped in #118)

---

## Numbering note

The highest ADR merged on `main` is ADR-023 (lazy provisioning of optional
services). Verified on 2026-09-29 that no remote branch claims 024 or above
(`git ls-tree -r <each origin branch> docs/architecture/` matched no
`ADR-02[4-9]`). **ADR-024 is the next free number.**

## Note on ADR-005

Issue #905 asks to "update ADR-005 (or file a follow-up ADR)". **There is no
`ADR-005-*.md` file in `docs/architecture/`** — it is referenced throughout the
codebase and by ADR-009, ADR-019 and ADR-020 as the asset aggregate /
four-namespace / ULID model, but only ever as an unwritten convention grounded
in `src/data/asset-document.ts`. ADR-009 line 344 and ADR-020 lines 76-77
already record this gap. Since there is no ADR-005 document to amend, this is
filed as the follow-up ADR the issue allows. Reconstructing ADR-005 itself is
out of scope here and remains open.

---

## Context

`POST /:id/clip` and `POST /:id/rewrap` accept an `asVersion` flag that records
the output as a version of its source, and `GET /api/v1/assets/:id/versions`
enumerates the result. Both shipped in #118. What was never written down is the
*contract*: nothing stated the response envelope, how a client identifies the
current version, what order the chain comes back in, or whether a chain may
branch. Consumers were left to reverse-engineer all four from the handler, and
the most natural guesses ("the last element is current", "a chain is a list")
are both wrong.

### Verified state of the running code

The endpoint **is implemented** — this ADR documents and closes gaps in a live
contract, it does not specify a greenfield one. Verified against:

Line numbers below are **post-change** (this branch) unless marked otherwise.

| Fact | Source |
| --- | --- |
| Route, params, response schema | `src/routes/assets.ts:3424` (`'/:id/versions'`); was `:3405` pre-change |
| Repository contract | `src/data/asset-repo.ts:1007` (`listVersions(id): Promise<Asset[] \| undefined>`) |
| Canonical (CouchDB) implementation | `src/data/couch-asset-repo.ts:613-632` |
| In-memory implementation | `src/data/asset-repo.ts:1774-1788` |
| Linkage fields on the aggregate | `src/data/asset-repo.ts:508-524` (`versionOfAssetId`, `versionGroupId`) |
| Linkage resolver | `src/data/asset-repo.ts:1210-1221` (`resolveVersionLinkage`) |
| `asVersion` write paths | `src/pipeline/clip.ts:142-164`, `src/pipeline/rewrap.ts:124-145` |
| Published spec entry | `openapi.json` → `paths./api/v1/assets/{id}/versions.get` |

Two gaps fell out of that reading:

1. **No current-version field.** A grep for `currentVersion` / `isCurrent` /
   `current_version` across `src/`, `openapi.json` and `docs/` returned
   nothing. The pre-change envelope was `{ assetId, versions }`, so a client
   could only *infer* which version is current — and the obvious inference
   ("take the last element") is wrong as soon as the newest member is archived.
2. **Topology was never stated.** The data model permits branching (see D4) but
   nothing said so, and the endpoint's own comment calls the result a "chain",
   which reads as linear.

---

## Decisions

### D1 — Response shape

`GET /api/v1/assets/:id/versions` returns `200` with:

```jsonc
{
  "assetId":          "01J...",   // required; the id queried, always a member
  "versionGroupId":   "01J...",   // optional; absent iff the asset has no lineage yet
  "currentVersionId": "01J...",   // required; always names a member of `versions`
  "versions":         [ /* Asset */ ]  // required; full asset objects
}
```

`404 { "error": "not_found" }` for an unknown id. The endpoint is
workspace-scoped and behind `authenticate`, like the rest of the asset routes.

`assetId` and `versions` are unchanged from #118; `versionGroupId` and
`currentVersionId` are **additive**, so existing consumers are unaffected.

Members are the full `assetSchema` object, not id stubs — each already carries
`versionOfAssetId` and `versionGroupId`
(`src/routes/assets.ts:878-879`), which is what makes D4's topology
reconstructible without a second round trip.

### D2 — Membership: group-scoped, includes the target, includes archived

A member of the chain is any asset sharing the target's `versionGroupId`.
Consequences, all confirmed against the handlers:

- **The target is always present**, so `versions` is never empty for an
  existing asset.
- **A never-versioned asset is its own single-member chain** and has no
  `versionGroupId` — a group is only minted when the first `asVersion`
  operation runs (`resolveVersionLinkage`, `asset-repo.ts:1210-1221`). The
  endpoint returns `[self]` rather than 404 or `[]`.
- **The result is identical for every entry point.** Querying any member
  returns the same set in the same order; only the echoed `assetId` differs.
- **`archived` members are included.** This endpoint is lineage *history*; a
  soft-deleted edit is still part of the record. (It is excluded from
  `currentVersionId` — see D3.)

This is **distinct from `?parentId=` listing**, which enumerates the
rendition/child hierarchy. The two axes are independent: a version output is
not a `parentId` child for delete-blocking purposes, so it never blocks its
source's deletion and never appears under `?parentId=<source>`.

### D3 — Current version is a server-computed field, never client-inferred

The API exposes **`currentVersionId`** as a required top-level field. Clients
MUST read it and MUST NOT re-derive it.

There is no operator-facing "promote to current" action today, so the value is
derived server-side by `currentVersionId()`
(`src/data/asset-repo.ts:1255`, beside `resolveVersionLinkage`):

1. The newest member by D4's ordering **whose status is not `archived`**.
2. If every member is archived, the newest member overall — an entirely
   archived lineage still reports a well-defined head rather than omitting the
   field.

Rule 1 is precisely why "last element of `versions`" is the wrong client-side
heuristic: archiving the newest version must move the current pointer back, and
a client applying the naive rule would keep pointing at a soft-deleted asset.

Putting this behind a named field is deliberate: it means an explicit
promotion mechanism can be added later (an operator-set marker that the
selector consults before falling back to recency) **without breaking any
consumer**, because no consumer encodes the heuristic. Explicit promotion is
out of scope for #905 and is left as a follow-up.

### D4 — Chain topology is a branching tree, not a strict line

**Chains MAY branch.** Nothing in the model prevents two versions being cut
from the same source: `resolveVersionLinkage` (`asset-repo.ts:1210-1221`) sets `versionOfAssetId` to the
*immediate* source and reuses that source's existing `versionGroupId`, so
running `clip --asVersion` twice against one asset yields two siblings in one
group both naming the same predecessor.

The correct mental model is therefore:

- `versionGroupId` — the **lineage**, a flat set spanning the whole tree,
  seeded to the root asset's own id on first version.
- `versionOfAssetId` — the **edge to the immediate predecessor**. Absent on the
  root. Immutable after create (`asset-repo.ts:649-651`) — an asset's
  provenance parent does not change.

So the structure is a **tree rooted at the asset whose id equals the group id**.
`versions` is a flat, ordered projection of that tree; clients that need the
shape reconstruct it from `versionOfAssetId`. A UI that renders the response as
a simple list is still correct, it just loses the branch structure.

This is documented as-is rather than constrained to linear: forcing linearity
would mean rejecting a second `asVersion` clip from the same source, which is a
legitimate editorial operation (two cuts from one master).

### D5 — Ordering is oldest-first and total

`versions` is sorted by `createdAt` ascending, ties broken by `id` ascending.
Both repository implementations already applied exactly this comparator; #905
lifts it into a single exported `compareVersionOrder` (`asset-repo.ts:1231`) so the ordering is stated
once and the D3 selector cannot drift from the order actually returned.

Ids are ULIDs, hence lexicographically time-ordered, so the tiebreak is itself
meaningful and the order is **total and stable** — two members can never
compare equal, and repeated reads cannot permute the list. This matters because
`createdAt` is millisecond-resolution and assets created in one burst can share
an instant.

Ordering is by creation time, not by tree depth: a branch cut from an old
version appears at its own creation position, not next to its predecessor.

### D6 — Not paginated

The chain is returned whole. The CouchDB query is bounded by `MAX_LIMIT`
(`couch-asset-repo.ts:624-627`), which is the practical ceiling on lineage
size; version chains are expected to be small (tens, not thousands). If a
lineage ever approaches `MAX_LIMIT` this becomes silent truncation and must be
revisited — flagged here as a known limit rather than left implicit.

---

## Consequences

- Consumers get a stable, documented envelope with an authoritative current
  pointer, instead of four reverse-engineered assumptions.
- The additive fields keep every existing `/versions` consumer working.
- An explicit "set current version" action can land later without a breaking
  change, because the derivation is server-side behind a named field.
- Branch-awareness is now a stated client responsibility; UIs that assumed a
  line are not *broken*, but they under-render branched lineages.
- `MAX_LIMIT` truncation on very long lineages is a known, documented gap.

## Alternatives considered

- **Constrain chains to strictly linear** (reject a second `asVersion` from one
  source). Rejected: it forbids a legitimate editorial operation, and it would
  be a behaviour change to a shipped write path rather than the documentation
  work #905 asks for.
- **Let clients infer the current version as `versions[versions.length - 1]`.**
  Rejected: wrong whenever the newest member is archived, and it hard-codes
  today's heuristic into every consumer, making future explicit promotion a
  breaking change.
- **Return id stubs instead of full assets.** Rejected: clients would need a
  second round trip for the status and linkage fields that current-version and
  topology reasoning depend on.
- **Add a boolean `isCurrentVersion` to each member.** Rejected: the invariant
  "exactly one member is current" would be expressed across N objects and could
  be violated in a partial read; a single top-level id cannot.

## Implementation

- `src/data/asset-repo.ts` — `compareVersionOrder`, `currentVersionId`.
- `src/routes/assets.ts` — envelope extended per D1.
- `src/routes/assets.versions.test.ts` — pins D1-D5 against the real route.
- `openapi.json`, `public/docs/` — regenerated from the live schema.
