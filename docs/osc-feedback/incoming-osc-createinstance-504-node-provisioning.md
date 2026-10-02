# OSC friction — `createInstance` answers 504 while a worker node is provisioned, and the retry is not idempotent (issue #1071)

**Logged by:** surface-backend-api
**Date:** 2026-10-02
**SDK version pinned:** `@osaas/client-core@0.24.0`
**Related:** #1071, PR #1081
**Related prior logs:** `docs/osc-feedback/incoming-waitforinstanceready-unbounded.md` (same spawn path, #778)

> **This is a pointer. The canonical write-up — the one that goes to the platform
> team — lives in the engagement repository, at
> `docs/osc-feedback/incoming-osc-createinstance-504-node-provisioning.md`
> (`Eyevinn/eng-open-videocore-agents`, PR #50).** Two copies were written
> independently; rather than let them drift, the full account is kept in one
> place and this file records only what a reader of THIS repository needs in
> order to understand the code. Add any new detail there, not here.

## The friction, in one paragraph

`createInstance` is a synchronous POST. When the region has no spare capacity the
platform provisions a new worker node first, and the call outruns the ingress
gateway: the caller gets `504 Gateway Time-out` (an HTML error page, not JSON)
while the create continues behind it and succeeds minutes later. Confirmed as
expected platform behaviour on 2026-10-02 — the scaler is expected to allow for
it. There is no idempotency key, so the only safe retry is to re-send the same
instance name and read the resulting `"Name is already taken"` as
success-in-disguise; and there is no operation handle to poll, so "still
provisioning" and "gone" are distinguishable only by polling `getInstance` /
`getInstanceHealth` by name against a timeout of our own choosing.

## What this repository had to build because of it

All in `src/encore-scaler/`, under #1071:

- `osc-error.ts` — retryability decided on the structural `httpCode` carried by
  the SDK's `FetchError`, not by substring-matching the message, so a 504 that
  arrives as an HTML page is retried and a 4xx is not.
- `instance-pool.ts` `createOrAdoptCallbackListener` / the Encore create loop —
  a stable instance name across retries, and adoption via `getInstance` on
  `"already taken"`, with an adopted-vs-created flag so cleanup never destroys an
  instance it did not create.
- `instance-pool.ts` `resolvePendingSpawns` — a readiness budget sized for node
  provisioning (15 min) rather than pod start, and a pending pool entry that the
  next tick completes, promotes or reclaims, so a spawn interrupted by node
  provisioning is neither thrown away nor leaked.
- `spawn-failure.ts` — the failure is recorded and surfaced on
  `GET /scaler/status`, with the HTML error page stripped out of the stored
  message.

## What was asked of the platform

Summarised here only so the request is discoverable from this repository; the
reasoning is in the canonical copy.

1. An idempotency key on `createInstance`, so a retry after a gateway timeout
   returns the original instance instead of `"Name is already taken"`.
2. Or an asynchronous create (`202` plus an operation handle, or an instance
   returned immediately in a provisioning state), so the long pole is polled
   rather than held open on a connection the gateway will cut.
3. Failing both, a documented contract for the 504 — "accepted, still in
   progress" — and a gateway timeout long enough to cover node provisioning.

Separately: a JSON error body rather than an HTML page, so client logs and status
endpoints are not left carrying markup.
