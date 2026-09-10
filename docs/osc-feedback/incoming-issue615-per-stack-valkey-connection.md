# Per-stack Valkey queue connection (issue #615)

> STATUS UPDATE (issue #615, PR #633 review round 2): the residual documented
> below is now RESOLVED for the live per-request path. `WorkspaceEncoreScalerConfig`
> gained a `resolveRedisUrl(stackKey)` hook + a `makeRedis(url)` factory (mirroring
> the existing `resolveS3Config(stackKey)`), and `WorkspaceEncoreScalerRegistry`
> now creates and caches ONE IORedis connection per resolved stack key
> (`redisConnections` map) — bounded by the number of provisioned stacks, not by
> request volume. Each per-stack scaler loop is handed its OWN connection, so a
> job keyed to stack B is enqueued on stack B's physical Valkey. `main.ts`
> `activateScaler` wires `resolveRedisUrl` to load `StackConfig.redisUrl` per
> stack from the parameter store; the process-global `sharedRedis` remains ONLY
> as the fallback for the env-override single-stack path (and for the packaging
> queue, which is stack-scoped by the activated stack). Owned per-stack
> connections are disconnected on `teardown`/`stopAll`.
>
> One NARROWED residual remains (see "Narrowed residual" below): the restart-time
> `resumeExistingWorkspaces()` discovery SCAN still runs against the process-global
> connection; a stack whose pool/queue keys live only on a different physical
> Valkey is resumed lazily on its next request rather than eagerly at boot.

## Context
Issue #615 fixed the transcode path so it resolves the target stack's connection
coordinates per request, keyed by the stack the request names (X-Stack-Name),
rather than tracking whichever stack was provisioned first in the process. The
fix keys the Encore auto-scaler's pool, Valkey queue KEYS, and MinIO endpoint
resolution by the effective stack identity.

## Residual limitation (not addressed by #615)
Each provisioned stack gets its OWN Valkey instance (see `src/routes/provision.ts`
step 3 — a `valkey-io-valkey` instance named after the stack — and the per-stack
`StackConfig.redisUrl` in `src/services/param-store.ts`). However, the scaler's
Valkey *connection* is still process-global:

- `src/main.ts` `activateScaler(redisUrl)` binds a single `sharedRedis` IORedis
  connection for the process lifetime and early-returns if one already exists
  (`if (sharedRedis) return`).
- `resolveStackRedisUrl()` picks `names[0]` (the first provisioned stack) for
  that single connection.
- `WorkspaceEncoreScalerRegistry` shares that one `redis`/`redisUrl` across every
  per-stack loop; only the Valkey KEY namespace is partitioned per stack
  (`encore:queue:<stackKey>` etc. in `src/encore-scaler/types.ts`).

Consequence: with two stacks in one workspace, jobs keyed to stack B are enqueued
on stack A's Valkey server (namespaced by key, so no collision, but on the wrong
physical instance). The Encore/MinIO coordinates ARE now resolved per-stack (so
the reported "delete-and-recreate to re-route" behaviour is resolved for the
Encore/storage path), but the queue backbone remains single-Valkey.

## Resolution (PR #633, review round 2)
The residual above is now fixed on the live per-request path:

- `src/encore-scaler/workspace-registry.ts`: `WorkspaceEncoreScalerConfig` gained
  `resolveRedisUrl(stackKey)` + `makeRedis(url)`. `resolveStackRedis(stackKey)`
  lazily resolves each stack's `StackConfig.redisUrl` and opens (via `makeRedis`)
  its own IORedis connection, caching it in a `redisConnections` map keyed by
  stackKey. `getOrCreate`, `resumeExistingWorkspaces`, and `teardown` all read the
  per-stack connection; owned connections are `disconnect()`ed on
  `teardown`/`stopAll`.
- `src/main.ts` `activateScaler`: `resolveRedisUrl` loads the named stack's
  `redisUrl` from the parameter store (falling back to the first-provisioned
  stack only when the requested key has no config, matching `resolveS3Config`).
  `makeRedis` uses the same `new IORedis(url, { lazyConnect, maxRetriesPerRequest:
  null })` construction as the process-global connection.
- The bound on connections is the number of DISTINCT provisioned stacks: the loop
  cache short-circuits repeat requests before connection creation, and identical
  URLs reuse the injected connection rather than opening a duplicate socket.

Consequence: with two stacks each on their OWN Valkey, a job for stack B is now
enqueued on stack B's Valkey. If stack A's Valkey is the unreachable dependency,
a transcode against healthy stack B no longer fails on stack A's queue — the
issue #615 acceptance scenario is met.

## Narrowed residual
`resumeExistingWorkspaces()` restart discovery still SCANS the process-global
connection (`this.config.redis`) for `encore:pool:*` / `encore:queue:*` keys. Once
a workspaceId is discovered it is re-bound to its per-stack Valkey, but a stack
whose keys live only on a different physical Valkey is not eagerly resumed at
boot — it is resumed lazily on its next submit/request (`getOrCreate` ->
`resolveStackRedis`). This is a boot-eagerness gap, not a routing-correctness gap:
live job routing is fully per-stack. A future improvement would enumerate the
provisioned stacks from the parameter store and scan each stack's Valkey at boot.
