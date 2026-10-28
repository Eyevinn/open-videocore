# Contract note: search index freshness after a PATCH rename — issue #929

**Verdict: search updates are SYNCHRONOUS. There is no search index to refresh
and no reindex trigger to add.** A renamed asset or collection is returned by
`GET /api/v1/search` on the very next request, with nothing called in between.

Every shape below was read from this tree's source (CLAUDE.md rule 7). Nothing is
taken from the issue text.

## Why: search is a read-through projection, not a maintained index

The search surface does not own any state. On every request it fetches documents
from the canonical store and reconstructs the domain objects through the *same*
mappers the read endpoints use, then applies the match rules in-process. So a
write to the document store *is* the index update — there is no second copy that
can lag.

Contract sources verified:

| What | Where |
|---|---|
| Search interface (one method, no write/index side) | `SearchRepository` — `src/data/search-repo.ts:95` |
| Free-text match on the asset title | `matchesQuery` — `src/data/search-repo.ts:372` (`asset.name.toLowerCase().includes(q)`) |
| Free-text match on the collection name | `matchesCollectionQuery` — `src/data/search-repo.ts:149` (`collection.name.toLowerCase().includes(q)`) |
| Collection search projection | `toCollectionHit` — `src/data/search-repo.ts:104` |
| Search route | `app.get('/')` — `src/routes/search.ts:260` (calls `repo.search(...)` only) |
| Production search backend | `CouchSearchRepository.search` — `src/data/couch-search-repo.ts:44` |
| Documents re-read per request | `couch.find(selector, { limit: MAX_LIMIT })` — `src/data/couch-search-repo.ts:51` |
| Asset rebuilt from the stored document | `fromDoc` — `src/data/couch-search-repo.ts:159` → `fromAssetDocument` |
| Collections rebuilt via the collection repo | `this.collections.list()` — `src/data/couch-search-repo.ts:69` |
| Dev/test search backend (same matchers) | `InMemorySearchRepository.search` — `src/data/inmemory-search-repo.ts:36` |
| Wiring (one store, both backends) | `new CouchSearchRepository(wc, collections)` — `src/services/workspace-stack.ts:206`, `:329` |

There is no `index`/`reindex`/`refresh` method anywhere on `SearchRepository`, and
no route, sweep or background loop that writes to a search store. (The only
`indexAsset` in the tree belongs to the unrelated TAMS bridge write client,
`src/tams/tams-gateway-write-client.ts:180`, which projects assets into a
timed-media store and is not consulted by `GET /api/v1/search`.)

## The rename path, end to end

**Asset rename**

1. `PATCH /api/v1/assets/{id}` with `{ "name": ... }` — body schema
   `updateSchema.name: z.string().min(1).max(256).optional()`,
   `src/routes/assets.ts:411`; handler `src/routes/assets.ts:5532`.
2. `CouchAssetRepository.update` — `src/data/couch-asset-repo.ts:338`; the patch is
   applied by `applyPatch` (`src/data/couch-asset-repo.ts:379`,
   `if (patch.name !== undefined) next.name = patch.name`) inside
   `updateWithRetry`, which puts the whole document.
3. The new name is persisted at `descriptive.title` — `toAssetDocument`,
   `src/data/asset-document.ts:455` (`title: asset.name`).
4. The next search request reads that document back and maps
   `descriptive.title` → `Asset.name` — `fromAssetDocument`,
   `src/data/asset-document.ts:634` — before `matchesQuery` compares it against
   `q`.

**Collection rename** (available since issue #926)

1. `PATCH /api/v1/collections/{id}` with `{ "name": ... }` — body schema
   `updateBodySchema.name`, `src/routes/collections.ts:224`; handler
   `src/routes/collections.ts:388`.
2. `CouchCollectionRepository.update` — `src/data/couch-collection-repo.ts:93` →
   `applyCollectionUpdate` (`src/data/collection-repo.ts:97`) → `toDoc` writes
   `name` (`src/data/couch-collection-repo.ts:171`).
3. The next search request lists collections through the same repository
   (`src/data/couch-search-repo.ts:69`), which rebuilds them from those documents
   (`src/data/couch-collection-repo.ts:201`), then applies
   `matchesCollectionQuery` and `toCollectionHit`.

The same argument covers `GET /api/v1/assets` and `GET /api/v1/collections`: they
read the identical documents, so "in the list" and "in search" move together
rather than on separate schedules.

## Consequences worth knowing

- **No manual step, ever.** No client needs to call anything after a rename, and
  no operator runbook needs a reindex entry.
- **Read-your-write is immediate on a single store.** The write is committed
  before the PATCH responds, so a search issued after that response observes it.
- **Nothing to rebuild after a restart.** The projection is derived purely from
  stored documents, so a fresh process (or a fresh repository instance) answers
  identically — the property already asserted for the asset and collection
  projections in `test/search-parity.test.ts` and
  `test/search-collections-couch.test.ts`.
- **The cost is per-request work, not staleness.** `CouchSearchRepository` fetches
  up to `MAX_LIMIT` workspace-partitioned candidates and filters free text
  in-process (`src/data/couch-search-repo.ts:51`, and the `NOTE (issue #345)` in
  `buildSelector`). That is a scale trade-off, not a freshness one; if a real
  text index is introduced later, *that* is when a reindex-on-write path becomes
  a question — and this note is the record of why one does not exist today.

## Regression coverage

`test/rename-search-freshness.test.ts` wires the asset router, the collection
router and the search router over ONE document store using the CouchDB-backed
repositories (the production persistence path), renames through the public
`PATCH`, and asserts the next search request already answers with the new name —
and that the old name stops matching. Nothing is called between the PATCH and the
search, so the test fails if a trigger ever becomes necessary.
