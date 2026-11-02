# OSC friction: config service list has no order, no creation metadata, and no stable cursor

**Issue:** #1165 (stack listing order / no-header default stack)
**Surface:** backend-api
**Date:** 2026-10-28
**Service:** `eyevinn-app-config-svc` (OSC parameter store)
**Severity:** medium (caused a user-visible default-stack change; worked around in-repo)

## Contract verified

Everything below was read off the service's own source, not inferred
(CLAUDE.md rule 7): `Eyevinn/app-config-svc`, `src/api_config.ts` at commit
`85b3c15fda466fc069e8e027f88ca1ca10c724fb` (`main`), route `GET /config` under
the `/api/v1` prefix, plus the TypeBox schemas `ConfigObject` (l.55-62),
`PageQuery` (l.81-85) and `ConfigObjectList` (l.88-100) in the same file.

## What happened

open-videocore stores one config blob per stack under
`openvideocore/<workspaceId>/<stackName>` and resolves a request that carries no
`X-Stack-Name` header to the **first** stack in the listing. `openapi.json`
states that unconditionally ("element 0 is the default stack", "provisioning
another stack never changes which stack is first"). The config service cannot
support that guarantee, for four separate reasons.

**1. List order is unspecified.** The list handler builds its result by iterating
`redis.scan` and appending to arrays (`allPrefixedKeys`, then `bareKeys`), then
slices that array. There is no `sort` anywhere in the handler and no ordering
field in `PageQuery`, so the order of `items` is whatever order the backing store
hands keys back in. Reported effect: a deployment with one stack that provisioned
a second one found its no-header default had moved to the new stack.

**2. `ConfigObject` carries no creation-time metadata.** The stored object is
exactly `{ key: string; value: string; secret?: boolean }`. There is no
`createdAt`, `updatedAt`, revision, or sequence number — nothing a consumer could
order by, and nothing to recover the creation order of keys written by an earlier
build. A consumer that needs creation order has to put it inside its own `value`
payload before the key is first written, and keys written before it started doing
that are unrecoverable.

**3. `limit` is capped at 100 per page.** `PageQuery.limit` is
`Type.Number({ minimum: 1, maximum: 100 })` (default 20), and schema validation
rejects a larger value. A store holding more than 100 matching keys therefore
cannot be enumerated in a single call — relevant here because a truncated listing
does not merely return fewer stacks, it can drop the oldest stack and silently
promote a different one to element 0.

**4. A page walk is not a stable cursor.** Each call re-derives the whole result
set from scratch: two fresh full `SCAN` loops (one `MATCH osc:params:<pattern>`,
one `MATCH *` to pick up pre-migration bare keys), then a `type` pipeline, then
per-key `GET`, then `allItems.slice(offset, offset + limit)` — pagination is in
memory, per call. Two consequences for a consumer:
- a concurrent write between page 1 and page 2 shifts items across the page
  boundary, so a walk can return an item twice or miss it entirely;
- the response's `offset` is the **next** offset, not the requested one
  (`nextOffset = offset + limit < total ? offset + limit : 0`), so `0` means "that
  was the last page". Readable, but the opposite of the usual echo-back
  convention, and easy to turn into an infinite loop if assumed otherwise.

Each call also costs two complete key-space scans regardless of `match`, so
walking N pages costs 2N full scans of the store.

## Impact

User-visible before the fix: adding a stack could change which stack an
unheadered request was routed to. After the workaround below, the ordering
guarantee holds against adding, removing and re-listing stacks — but it could not
be met from the service's contract alone, and one case stays unrecoverable (see
"Residual gap").

## Workaround in open-videocore

`src/services/param-store.ts` stops consuming the service's order at all and
imposes its own:

1. **Record creation time in the value.** `StackConfig.createdAt` (an ISO-8601
   instant written once at provision and preserved verbatim by every later write)
   is the only ordering key. Since `ConfigObject` has no metadata, this is the
   only place it can live.
2. **Enumerate exhaustively, not one page.** `listStackNames` scopes the scan with
   `match=openvideocore/<workspaceId>/*`, requests `limit=100`
   (`CONFIG_LIST_PAGE_LIMIT`), and follows the response `offset` until it reports
   `0` or stops moving forward. Because the walk is not a stable cursor, results
   are **deduped by key** into a `Map` rather than concatenated, and the walk is
   bounded at 50 pages (`CONFIG_LIST_MAX_PAGES`); hitting that bound is logged as
   a possibly-incomplete listing instead of being accepted silently. The whole
   walk is one retry unit, so a mid-walk failure restarts it rather than returning
   a partial listing that could reorder element 0. `items` carries the value
   alongside the key, so the ordering data arrives in the same pages — no extra
   round-trip per stack.
3. **Sort deterministically.** `compareStackCreationOrder` is a total order:
   creation-time-unknown stacks first, then `createdAt` ascending, then name
   ascending as the final tiebreak. The name tiebreak exists precisely so that
   ties never fall through to the store's unspecified iteration order. "Unknown"
   is one equivalence class covering both an absent/unparseable `createdAt` and
   the explicit `LEGACY_STACK_CREATED_AT` marker that the converge path in
   `src/routes/provision.ts` backfills onto a pre-#1165 stack, so a best-effort
   partial backfill cannot move a stack out of the legacy group mid-rollout. A value that will not parse orders as
   legacy rather than throwing.
4. **Let an operator override it.** `DEFAULT_STACK_NAME` (read per call,
   `resolvePinnedStackName`) hoists one stack to index 0 and leaves the rest in
   creation order; a pin naming a stack that is not in the listing is ignored
   rather than fabricating an entry.

Net effect: the listing order is a function of the stored records, not of the
service's iteration order, so it is stable across adds, removes and re-lists.

### Residual gap

A deployment that already had **several** stacks before `createdAt` was recorded
has no stored instant to reconstruct their original order from, so those stacks
sort by name and its no-header default can change once, at upgrade. That is a
direct consequence of limitation 2 — there is no server-side metadata to recover
a real creation order from. `DEFAULT_STACK_NAME` is the only remedy, and it is an
explicit operator statement rather than an inference.

## Asks for OSC

1. **Document the order of `items`, or make it orderable.** Either state in the
   OpenAPI description that the order is unspecified (so consumers know they must
   impose their own), or add an explicit `sort` option to `PageQuery`
   (`key` ascending would already be enough for most consumers).
2. **Expose creation/modification metadata on `ConfigObject`.** A server-side
   `createdAt`/`updatedAt` (or a monotonic revision) would let consumers order by
   creation without smuggling a timestamp into their own value payload, and would
   make pre-existing keys orderable instead of permanently unknown.
3. **Offer a real cursor, or raise the cap for scoped matches.** A
   `cursor`-based page token derived from one scan would make a multi-page walk
   coherent under concurrent writes; failing that, allowing `limit > 100` when
   `match` is a narrow prefix would let most consumers avoid the walk entirely.
4. **Skip the second full `MATCH *` scan when `match` is given.** The bare-key
   legacy scan ignores the prefix and re-scans the entire key space on every list
   call, which is the dominant cost of a scoped listing and scales with unrelated
   keys in the shared store.
5. **Echo the requested `offset`, and name the next one.** Returning the next
   offset in a field called `offset` is a sharp edge; `offset` plus an explicit
   `nextOffset` (absent on the last page) would be unambiguous.
