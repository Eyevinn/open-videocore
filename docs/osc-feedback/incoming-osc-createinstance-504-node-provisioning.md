# OSC friction — `createInstance` answers 504 while a worker node is provisioned, and the retry is not idempotent (issue #1071)

**Logged by:** surface-backend-api
**Date:** 2026-10-02
**SDK version pinned:** `@osaas/client-core@0.24.0`
**Related:** #1071 (a scale-up that could not spawn was invisible on `GET /scaler/status`), PR #1081
**Related prior logs:** `docs/osc-feedback/incoming-waitforinstanceready-unbounded.md` (same spawn path, #778)

## Context

The auto-scaler creates a transcoder instance per unit of pending work. When the
OSC region has no spare capacity, the platform provisions a new worker node
first, and `createInstance` — a synchronous HTTP POST — outruns the ingress
gateway while that happens. The call fails; the instance is created anyway,
minutes later. Everything below is what the API had to build to survive that,
and exists only because of the shape of the platform contract.

---

## Friction 1 — a 504 from the gateway is indistinguishable from a failed create

**Symptom.** `createInstance` rejects with a gateway timeout, so the caller
believes the create failed. The create usually SUCCEEDS behind the gateway once
the new node is up. The caller has no way to tell "did not happen" from "is
still happening", and nothing in the response identifies the in-progress
operation.

**Contract as shipped** (`@osaas/client-core@0.24.0`):

- `lib/core.js:76-90` — `createInstance(context, serviceId, token, body)` is a
  single `POST` to the service's `apiUrl` via `createFetch`, with no polling
  handle, operation id, or 202 path.
- `lib/fetch.js` `defaultErrorFactory` — on a non-ok response it throws
  `new FetchError({ message, httpCode: response.status })`. For the 504 the
  gateway answers with `text/html`, so `message` is the whole error page:
  `"<html>\r\n<head><title>504 Gateway Time-out</title></head>..."`.

**Impact on us.** Our retry classifier matched the message for `'500'`/`'502'`/
`'503'`, so the one status that actually means "still in progress" was never
retried, and a spawn that was about to succeed was thrown away on attempt 1.

**Workaround taken.** Classify on the structural `httpCode` instead of the
message text (`src/encore-scaler/osc-error.ts` `isTransientOscError`), and treat
5xx — explicitly including 504 — as retryable.

**What the OSC API would need to make the workaround unnecessary:** either an
asynchronous create (202 + an operation/instance URL to poll) or a documented
guarantee that a 504 means "not created". Returning JSON rather than an HTML
error page from the ingress would also help; an HTML body in an SDK error
message is unusable as a diagnostic and had to be stripped before it could be
shown to an operator.

---

## Friction 2 — no idempotency key, so the retry collides with its own first attempt

**Symptom.** Retrying the create after a 504 hits the instance the 504 itself
created, and the platform answers `"Name is already taken"` with a 4xx. The only
reason we can recover at all is that we choose the instance name ourselves and
hold it fixed across attempts, so the collision is evidence of our OWN earlier
attempt rather than of someone else's instance.

**Contract as shipped:**

- `createInstance` takes no `Idempotency-Key` header and no client-supplied
  request id; `body.name` is the only client-controlled identity.
- `lib/core.js:49-51` — `isValidInstanceName = /^[a-z0-9]+$/`, so the name
  cannot even carry a structured attempt/owner token; ours has to be a
  fixed-width hex tag by position.
- `lib/core.js:127-150` — `getInstance`, the natural way to confirm the
  collision, cannot distinguish "absent" from "could not ask": it returns
  `undefined` both for a 404 (`:145-146`) and for every other failure that falls
  out of its catch (`:149`), while `getService` at `:128` sits OUTSIDE that try
  and propagates. So the confirmation step is itself ambiguous AND can throw.

**Workaround taken.** `src/encore-scaler/instance-pool.ts` computes the instance
name once per spawn, outside the retry loop, and treats
`isNameAlreadyTakenError` as a signal to ADOPT: probe with `getInstance`, adopt
what comes back, and never destroy an adopted instance on rollback. Because
`undefined` is ambiguous, an unconfirmed collision is retried rather than
trusted, and the probe is wrapped (`tryGetInstance`) so its own failure cannot
replace the create's error.

**What the OSC API would need:** an idempotency key on `createInstance`, so a
retried create returns the original instance instead of a name collision; and a
`getInstance` that distinguishes 404 from an unavailable service catalog.

---

## Friction 3 — `FetchError` discards the response, so `Retry-After` is unreachable

**Symptom.** A `429 Too Many Requests` from the platform carries the wait in a
`Retry-After` header, but the error the SDK throws cannot express it.

**Contract as shipped:** `lib/fetch.js` — `class FetchError extends Error` has
exactly one extra field, `httpCode`. `defaultErrorFactory` reads the body and
then drops the `Response`, so no header reaches the caller.

**Impact on us.** Every retry in the scaler uses a fixed 5s/10s back-off even
when the platform has told us exactly how long to wait, which both over-waits on
a short limit and under-waits on a long one.

**Workaround taken.** `isTransientOscError` treats 408 and 429 as retryable
alongside the 5xx and the caller applies its own back-off
(`src/encore-scaler/osc-error.ts`).

**What the OSC API would need:** the SDK to surface response headers (or at
least a parsed `retryAfterMs`) on `FetchError`.

---

## Impact if unaddressed

Each of these is survivable per call and expensive in aggregate: a scale-up that
hits a provisioning node fails, leaves a live instance nobody owns, and bills
until something reaps it. Every consumer of `createInstance` that cares about
cost has to reimplement fixed naming, adopt-on-collision, a bounded readiness
wait and an orphan sweep — about 600 lines in our case — to work around a create
call that is synchronous but not idempotent.
