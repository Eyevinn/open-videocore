# OSC friction — no OSC client call can be bounded or cancelled (issue #1212)

**Logged by:** surface-backend-api
**Date:** 2026-10-15
**SDK version pinned:** `@osaas/client-core@^0.24.0`, resolved 0.24.0
**Related:** #1212, PR #1224
**Related prior logs:** `docs/osc-feedback/incoming-waitforinstanceready-unbounded.md` (same root cause, readiness side, #778)

> **This is a pointer. The canonical write-up — the one that goes to the platform
> team — lives in the engagement repository, at
> `docs/osc-feedback/incoming-osc-client-calls-cannot-be-bounded.md`
> (`Eyevinn/eng-open-videocore-agents`).** This file records only what a reader
> of THIS repository needs in order to understand the code. Add any new detail
> there, not here.

## The friction, in one paragraph

No function in `@osaas/client-core@0.24.0` accepts a timeout, a deadline or an
`AbortSignal`. The three calls a stack teardown makes are declared with
positional parameters only and no trailing options object —
`removeInstance(context, serviceId, name, token): Promise<void>`
(`lib/core.d.ts:46`), `getInstance(context, serviceId, name, token): Promise<any>`
(`lib/core.d.ts:56`), `listInstances(context, serviceId, token): Promise<any>`
(`lib/core.d.ts:65`) — as is the token mint on the same path,
`getServiceAccessToken(serviceId): Promise<string>` (`lib/context.d.ts:25`). The
transport underneath adds no bound either: `createFetch` calls the global
`fetch(url, { ...options })` with no `signal` and no timeout
(`lib/fetch.js:24`), and the options come from `lib/core.js` rather than from the
caller, so a signal cannot be smuggled in. A grep for
`signal|AbortController|AbortSignal|timeout` across the published `lib/` matches
nothing. The only remaining bound is undici's own ~300s-per-response-phase
default, which is how a single `DELETE` can sit for minutes.

## Why this repository had to build something

#1212: a second `DELETE` on a partially deleted stack stayed `running` for more
than seven minutes and removed nothing further. Teardown walks the stack's
services in sequence, so one hung `removeInstance` consumed the whole operation
— the services after the stuck one were never attempted, and their instances
kept billing.

## What this repository built because of it

`src/services/teardown-bounds.ts`, applied by `src/services/deprovision.ts` and
the DELETE route in `src/routes/provision.ts`:

- A **per-service deadline** (`DEFAULT_SERVICE_TEARDOWN_TIMEOUT_MS`, 30s) around
  each service's probe/remove/confirm including retries, so a hung call costs one
  service's budget instead of the operation, and the walk continues.
- A **whole-operation backstop** (`DEFAULT_OPERATION_TEARDOWN_TIMEOUT_MS`, 300s)
  so the async operation always reaches a terminal state the operator can act on.
- **Bounded retries with backoff** for faults that clear in seconds, each also
  capped by the per-service budget.
- A **classified failure** (`timeout` | `transient` | `permanent`) carrying the
  attempt count and underlying message.
- All bounds are env-configurable (`STACK_TEARDOWN_*`).

**What it cannot do:** cancel the abandoned call. `withTeardownTimeout` races the
SDK promise against a deadline; with no `AbortSignal` the in-flight request is
left to settle in the background, holding its socket until undici's ceiling. The
caller is bounded, the resource is not — accepted here because the alternative
was an operation that never ended.

## What was asked of the platform

Summarised so it is discoverable from this repository; the reasoning is in the
canonical copy.

1. An options argument on the instance calls (`{ timeoutMs?, signal? }`) —
   `signal` alone would be enough to make a deadline release the socket.
2. Honour `signal` (and an optional default `timeoutMs`) in `createFetch`, so
   every call in the library is bounded at one site.
3. A library-wide default timeout on `Context`, making the safe behaviour the
   default and unbounded the explicit opt-in.
4. Service attribution on a transport failure: `lib/fetch.js:43` re-wraps a
   rejected `fetch` as a `FetchError` with no `httpCode` and only the message, so
   clients are pushed into substring-matching `'fetch failed'` instead of
   classifying structurally.
