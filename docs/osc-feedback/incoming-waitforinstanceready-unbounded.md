# OSC friction — unbounded `waitForInstanceReady` and no instance age from `listInstances` (issue #778)

**Logged by:** surface-backend-api
**Date:** 2026-09-25
**SDK version pinned:** `@osaas/client-core@0.24.0`
**Related:** #778 (an Encore instance spawned but never dispatched a job billed for ~20h), PR #784
**Related prior logs:** `docs/osc-feedback/incoming-issue615-per-stack-valkey-connection.md`

## Context

Issue #778 is a billing leak: the auto-scaler spawned an Encore OSC instance,
the instance never took a job, and nothing in the system could ever tear it
down. Fixing it needed two workarounds that exist only because of SDK
limitations, both recorded here per CLAUDE.md rule 6.

---

## Friction 1 — `waitForInstanceReady` has no timeout and no cancellation

**Symptom.** A spawn that waits on an instance which never reports `running`
(image pull stuck, quota refusal, crash loop, or a paired service that is slow
to come up) blocks forever while an OSC instance is already created, live, and
billing. In our case the instance also had no pool record yet, so no teardown
path could see it.

**Contract as shipped** (`@osaas/client-core@0.24.0`):

- `lib/core.d.ts:153` — `waitForInstanceReady(serviceId: string, name: string, ctx: Context): Promise<void>`
- `lib/core.js:343-353`:

  ```js
  async function waitForInstanceReady(serviceId, name, ctx) {
      const serviceAccessToken = await ctx.getServiceAccessToken(serviceId);
      let instanceOk = false;
      while (!instanceOk) {
          await delay(1000);
          const status = await getInstanceHealth(ctx, serviceId, name, serviceAccessToken);
          if (status && status === 'running') { instanceOk = true; }
      }
  }
  ```

There is no `timeoutMs` argument, no `maxAttempts`, no `AbortSignal`, and no
return value distinguishing "ready" from "gave up" — the loop only exits when
health becomes `running` or when `getInstanceHealth` throws.

**Why the obvious workaround is not enough.** Racing the call against a
`setTimeout` bounds *our* wait but not the SDK's loop: because there is no
cancellation, the abandoned promise keeps issuing one `getInstanceHealth` call
per second for the remaining lifetime of the process, once per timed-out spawn.
That trades a billing leak for a request leak.

**Workaround taken** (`src/encore-scaler/instance-pool.ts`,
`waitForInstanceReadyBounded`): we do not call `waitForInstanceReady` at all in
the scaler. We poll the public primitive it is built on —
`getInstanceHealth(context, serviceId, name, token): Promise<string>`
(`lib/core.d.ts:86`) — on our own loop with a deadline
(`DEFAULT_SPAWN_READY_TIMEOUT_MS`, 5 min) and our own interval
(`DEFAULT_SPAWN_READY_POLL_INTERVAL_MS`, 1s — the SDK's own cadence). Polling
stops exactly at the deadline; the timeout routes into the spawn's cleanup path,
which destroys the Encore instance and its paired callback listener rather than
leaving either to bill. Transient health-probe failures are treated as "not
ready yet" until the deadline rather than aborting the spawn, which is strictly
more forgiving than the SDK's behaviour (an exception there propagates).

**What the OSC API would need to make the workaround unnecessary:**

1. An options argument on `waitForInstanceReady` — at minimum
   `{ timeoutMs?: number; signal?: AbortSignal; intervalMs?: number }` — so a
   caller can bound the wait *and* stop the polling it started.
2. A distinguishable failure: reject with a typed timeout error (or resolve to
   the last observed health string) rather than only ever resolving on success.
3. Terminal-state awareness: if the orchestrator knows an instance has entered a
   state it can never leave (`failed`, image pull error, quota refusal), the
   helper should stop rather than poll a doomed instance for the full budget.

---

## Friction 2 — `listInstances` returns no instance creation timestamp

**Symptom.** To clean up an instance that exists on OSC but has no record on our
side, we must know how long it has existed — destroying one that was created
seconds ago would kill a spawn still in flight. The listing gives us no way to
ask.

**Contract as shipped:**

- `lib/core.d.ts:65` — `listInstances(context: Context, serviceId: string, token: string): Promise<any>`
- `lib/core.js:160-171` — returns the raw JSON body of the service's `apiUrl`
  instance endpoint. The elements we can rely on are `name` and `url` (the same
  fields our provisioning route reads); there is no `createdAt`, `startedAt`, or
  age field, and the declared return type is `any`, so there is no generated
  type to check a field against either.

**Workaround taken** (`src/encore-scaler/instance-pool.ts`,
`reapOrphanedInstances`): first-sighting is tracked by us. The reaper records
the timestamp at which each untracked-but-owned instance was first observed in a
Valkey hash (`keys.orphanSeen(workspaceId)`, `src/encore-scaler/types.ts`) and
only destroys an instance that has been continuously observed as orphaned for a
grace window (`DEFAULT_ORPHAN_GRACE_MS`). Consequences we accept: the clock
restarts if that Valkey key is lost, and an instance orphaned before the API
process ever saw it still has to wait out a fresh grace window.

Ownership has the same shape of problem one level down. `createInstance`
validates names against `isValidInstanceName = (name) => /^[a-z0-9]+$/`
(`lib/core.js:49-51`), so an instance name cannot carry a delimiter and there is
no tag/label/metadata field on an instance to mark ownership with. We therefore
encode ownership as a fixed-width lowercase-hex tag inside the name itself,
which is the only field of the contract that survives a round trip.

**What the OSC API would need:**

1. A creation timestamp on each element of the `listInstances` response
   (`createdAt`, ISO-8601), which makes an age-based sweep stateless.
2. A declared element type for the listing rather than `Promise<any>`, so
   callers can verify field names against a contract instead of observed
   responses.
3. Optional but decisive for multi-deployment safety: free-form labels/metadata
   on an instance, settable at `createInstance` and returned by `listInstances`,
   so ownership is a first-class field rather than something smuggled through a
   `[a-z0-9]+` name.

---

## Impact if unaddressed

Every consumer that spawns OSC instances programmatically has to re-invent both
workarounds (an owned poll loop and an external first-sighting store) or accept
instances that can hang a caller indefinitely and bill until someone notices by
hand. That is exactly how issue #778 reached ~20 hours of billing on an instance
that never processed a single job.
