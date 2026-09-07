# Per-stack Valkey queue connection is process-global (issue #615 residual)

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

## Why deferred
Making the queue connection per-stack requires the scaler registry to hold one
IORedis connection per resolved stack (and lifecycle-manage them), a broader
change than #615's testable scope. Two healthy stacks that happen to share a
single Valkey (or an operator who runs one Valkey per workspace) are unaffected;
the failure mode is specifically two stacks each with their OWN Valkey.

## Suggested follow-up
- Extend `WorkspaceEncoreScalerConfig` with a `resolveRedisUrl(stackKey)` hook
  (mirroring the existing `resolveS3Config(stackKey)`), and have the registry
  create/cache a per-stack IORedis connection at loop creation time.
- Retire the single `sharedRedis` binding in `src/main.ts` in favour of the
  per-stack connections, or scope it to the packaging queue only.
