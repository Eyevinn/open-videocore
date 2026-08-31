# ADR-016: How scaler-managed workspaces detect silently-dropped Encore jobs (reconcile-driven terminal settle vs. HTTP poll)

**Status:** PROPOSED 2026-08-31
**Date:** 2026-08-31
**Author agent:** claude-opus-4-8 (surface-backend-api)
**Issue:** #450 (decision spike; unblocks the stuck-`running` fix sub-issue)

---

## Context

A transcode job dispatched through the auto-scaler can end up stuck in
`running` forever with its source asset stuck in `processing`, with **no error
surfaced**. This happens when a job **silently disappears** from an Encore
instance: it leaves the QUEUED/IN_PROGRESS set without ever reaching
SUCCESSFUL/FAILED, and no completion callback is delivered. Once the scaler
scales the instance down, no live endpoint exists to poll, and nothing ever
drives the local job to a terminal state.

Two mutually-exclusive fixes were proposed. This ADR picks one so the fix
sub-issue can proceed.

### Why the existing mechanisms do NOT already cover this case

Three settle paths exist today; each misses the silently-dropped case:

1. **Callback poller queue drain** — the callback listener only enqueues
   **SUCCESSFUL** jobs (`failed-transcode-reconciler.ts:5-9`), so a dropped job
   produces no message.
2. **`sweepTerminalJobs`** (`encore-callback-poller.ts:524-603`) queries each
   pooled instance's `findByStatus` for **SUCCESSFUL and FAILED**
   (`SWEEP_STATUSES`, `encore-callback-poller.ts:515`) and re-synthesises a
   message. A silently-dropped job is in **neither** list, so the sweep never
   sees it. The sweep also only scans instances still present in
   `encore:pool:*` (`encore-callback-poller.ts:527`); a scaled-down instance is
   gone from the pool entirely.
3. **`reconcileFailedTranscodes`** (`failed-transcode-reconciler.ts:82-145`)
   polls `EncoreClient.getJobStatus(job.encoreInternalJobId)`
   (`failed-transcode-reconciler.ts:104`) and settles on `status === 'failed'`
   (`:115`) or, for `undefined`, after `stallTimeoutMs`
   (`:121-137`, default `DEFAULT_STALL_TIMEOUT_MS = 30 * 60 * 1000`, `:49`).
   **But** for scaler-managed workspaces the injected `EncoreClient` is
   `makeScalingEncoreClient` (`main.ts:769` passes `scalerRegistry`), whose
   `getJobStatus` (`index.ts:35-43`) reads the **Valkey** hash
   `keys.jobStatus` — **not** a live Encore instance. A silently-dropped job
   still carries its stale `'running'` value written at dispatch
   (`scaler-loop.ts:291`), which normalises to `'running'` (`index.ts:39`), so
   `reconcileFailedTranscodes` sees `'running'` and does **nothing**
   (`failed-transcode-reconciler.ts:140-141`). The `stallTimeoutMs` /
   `undefined` branch is never reached because the Valkey key never goes
   missing on its own.

So the gap is real and specific to the scaler path.

### The scaler already detects the exact signal

`reconcile()` (`scaler-loop.ts:189-257`) runs once per tick
(`scaler-loop.ts:82`). For each pooled instance with `activeJobs > 0`
(`scaler-loop.ts:205`) it counts the instance's live QUEUED + IN_PROGRESS jobs
via `findByStatus` (`scaler-loop.ts:213-230`) and, on a mismatch, logs:

```
[encore-scaler] reconcile: correcting stale activeJobs for instance …: tracked=1 actual=0
```

(`scaler-loop.ts:234-237`) and corrects `record.activeJobs` down to `actualCount`
(`scaler-loop.ts:238`). `tracked > actual` is precisely "a job we think is
running has vanished from Encore's active set with no completion" — the
silently-dropped signal. Today that signal only fixes the **internal counter**;
it never touches the caller-facing job.

## Verified contract sources (CLAUDE.md rule 7)

Every symbol below was read in this branch (`issue-450/scaler-dropped-job-adr`)
before citing:

- `reconcile()` — `src/encore-scaler/scaler-loop.ts:189-257` (the log line at
  `:234-237`, the counter correction at `:238`, the `activeJobs === 0` skip at
  `:205`, the QUEUED+IN_PROGRESS count at `:213-230`). **Note:** issue #450
  cites this as living in `src/encore-scaler/index.ts`; it is actually in
  `scaler-loop.ts`. `index.ts` holds `makeScalingEncoreClient` only.
- `makeScalingEncoreClient` incl. `getJobStatus` (Valkey-backed) and `cancel`
  — `src/encore-scaler/index.ts:19-107` (`getJobStatus` at `:35-43`).
- `makeHttpEncoreClient.getJobStatus` (live HTTP, 404 → `undefined`) —
  `src/pipeline/encore-client.ts:112-124` (the referenced 112-119 range; the
  404 branch is at `:120`).
- `reconcileFailedTranscodes` incl. the `stallTimeoutMs` / `undefined` bound —
  `src/pipeline/failed-transcode-reconciler.ts:82-145`; `settleFailed`
  (`completeTranscode({ success: false })` + pipeline-lock release) at
  `:151-213`; `DEFAULT_STALL_TIMEOUT_MS` at `:49`.
- `sweepTerminalJobs` + `SWEEP_STATUSES = ['SUCCESSFUL','FAILED']` —
  `src/pipeline/encore-callback-poller.ts:485-603` (`SWEEP_STATUSES` at `:515`,
  pool scan at `:527`).
- Callback settle path (`completeTranscode` + `decrementActiveJobs`) —
  `src/pipeline/encore-callback-poller.ts:365,384-400`; `completeTranscode`
  applies terminal state and returns `{ applied }` (used at
  `failed-transcode-reconciler.ts:171`).
- Scaler config hooks the scaler has no repos for, wired in `main.ts`:
  `reconcileFailedTranscodes`, `onDispatched`, `onEncodeDispatched` —
  `src/encore-scaler/types.ts:65-81`; wiring at `src/main.ts:729-798`.
- Valkey status write at dispatch (`keys.jobStatus` → `'running'`) —
  `src/encore-scaler/scaler-loop.ts:291`; key builders `keys.jobStatus`,
  `keys.uuidToExternalId`, `keys.jobUuid` — `src/encore-scaler/types.ts:114-142`.

## Decision

**Adopt Direction 2 — reconcile-driven terminal settle.** Wire the
`tracked > actual` signal that `reconcile()` (`scaler-loop.ts:232`) already
computes to drive the affected job(s) to a terminal `failed` state, in addition
to correcting `activeJobs`. **Reject Direction 1 (HTTP reconciliation check).**

### Why not Direction 1 (HTTP poll of `GET {baseUrl}/encoreJobs/{id}`)

- **It cannot answer the defining case.** The stuck job is stuck *because* the
  instance has been scaled down — there is no `baseUrl` to GET. Direction 1's
  own open question ("what to return when no live endpoint exists") has no good
  answer: returning `undefined` collapses "scaled-down/dropped" into the same
  bucket as a transient blip, forcing reliance on `stallTimeoutMs` anyway, so
  the HTTP call adds cost without resolving the ambiguity.
- **It duplicates existing detection.** For instances still in the pool, a live
  per-job GET re-derives information `reconcile()` already gathers in aggregate
  via two `findByStatus` calls per instance (`scaler-loop.ts:213-220`). We
  would be issuing N extra HTTP calls (one per non-terminal job) to recompute a
  signal we already have per instance.
- **Wrong client shape.** The scaler path's `EncoreClient` is deliberately
  Valkey-backed (`index.ts:35-43`) so the reconciler stays decoupled from live
  instance URLs. Making it do live HTTP would fork behaviour from
  `makeHttpEncoreClient` and reintroduce the "instance no longer available"
  fragility the dispatch-time URL caching (`scaler-loop.ts:328-329`) was added
  to avoid.

### Point 1 — the scaled-down-instance case

Direction 2 handles it natively. When an instance is scaled down
(`destroyInstance`, `scaler-loop.ts:129`) while a job it was running has already
silently vanished, the mismatch was **already** observable on the tick(s)
before teardown (the job left QUEUED/IN_PROGRESS but `activeJobs` still counted
it). The fix settles the job at the moment `reconcile()` observes
`tracked > actual`, which is *before or independent of* teardown — the settle is
driven by the counter delta, not by the instance still existing. For a job
whose instance is **already gone** from the pool before any reconcile tick
caught the delta (e.g. process restart), the durable safety net remains
`reconcileFailedTranscodes`' `stallTimeoutMs` bound (see Point 2): the job is
still capped, never stuck forever.

### Point 2 — interaction with `stallTimeoutMs`

`stallTimeoutMs` (`failed-transcode-reconciler.ts:86`, default 30 min at `:49`)
stays as the **backstop**, unchanged. The relationship becomes layered:

- **Reconcile-driven settle = fast path.** Fires on the tick that observes
  `tracked > actual` (tick interval default 10 s, `scaler-loop.ts:41`), so a
  dropped job is settled in seconds-to-tick time, not 30 minutes.
- **`stallTimeoutMs` = slow backstop.** Still catches jobs the fast path
  cannot see (instance gone before any reconcile delta was recorded; scaler
  process was down across the drop). It requires no change.

The reconcile settle must NOT introduce its own timeout. `reconcile()` counts
QUEUED **and** IN_PROGRESS (`scaler-loop.ts:227-230`) specifically so a
freshly-dispatched job is not miscounted as vanished (`scaler-loop.ts:209-212`);
a job present in either set keeps `actual` high and is never settled. Therefore
`tracked > actual` at reconcile time is already an unambiguous "gone", and
settling immediately on it is safe without an extra grace window.

### Point 3 — idempotency vs. a late callback arriving after settle

A late SUCCESSFUL callback (or a late `sweepTerminalJobs` re-queue) can arrive
after the reconcile settle. This is safe because settle is **idempotent at the
job repo**: `completeTranscode` returns `{ applied }` and is a no-op when the
job is already terminal (the guard used at
`failed-transcode-reconciler.ts:171-173` and the poller's identical skip at
`encore-callback-poller.ts:574`, which bails when `status === 'done' ||
'failed'`). So:

- If the reconcile settle wins, a later SUCCESSFUL callback's
  `completeTranscode({ success: true })` runs against an already-`failed` job
  and does not apply — **first terminal write wins**. This is the correct
  policy for a *silently-dropped* job: by definition Encore produced no success
  signal at drop time; a contradictory late success is not expected, and if it
  ever occurs the operator sees a `failed` job (safe, surfaced) rather than a
  stuck one.
- The reconcile settle must additionally overwrite the stale Valkey
  `keys.jobStatus` (`types.ts:119`) entry from `'running'` to a terminal value
  so a subsequent `makeScalingEncoreClient.getJobStatus` (`index.ts:41`) agrees
  with the job repo and does not re-report `'running'`.

To keep the fast path from racing the backstop, the settle reason strings stay
distinct ("dropped by Encore: gone from active set with no completion" for the
reconcile path vs. the existing "transcode timed out: Encore has no record …",
`failed-transcode-reconciler.ts:133`) purely for observability; both funnel to
the same idempotent `settleFailed`.

### Point 4 — which component owns the terminal write

**The failed-transcode reconciler owns the terminal write; `reconcile()` only
raises the signal.** `reconcile()` (in `scaler-loop.ts`) is inside the scaler
package, which **owns no repositories** by design (`types.ts:62-64,76-81`) — it
cannot call `completeTranscode` (which touches CouchDB via the job/asset repos,
`failed-transcode-reconciler.ts:157-166`). It must therefore surface the signal
through a callback, exactly as `onDispatched` / `reconcileFailedTranscodes` are
wired from `main.ts:729-798`.

Concrete ownership (implementation detail for the fix sub-issue, not
prescriptive code here):

1. `reconcile()` collects the set of `encoreJobId`s it just decremented past
   (the jobs represented by the `tracked - actual` delta) and passes them to a
   new best-effort config hook (shape mirroring `onDispatched`,
   `types.ts:65`), e.g. `onJobsDropped?: (encoreJobIds: string[]) =>
   Promise<void>`. The scaler stays repo-free; failures are swallowed like the
   other hooks (`scaler-loop.ts:341-347`).
2. `main.ts` wires that hook to resolve each id via
   `jobRepository.findByEncoreJobId` (as `onDispatched` already does,
   `main.ts:730`) and route it through the **same** `settleFailed` path the
   reconciler already uses — `completeTranscode({ success: false })` +
   `releasePipelineLock` (`failed-transcode-reconciler.ts:151-213`) — plus the
   Valkey `keys.jobStatus` overwrite from Point 3. Reusing `settleFailed`
   guarantees identical asset/pipeline side-effects and idempotency to the
   existing #273 path.

So: **detection lives in `reconcile()` (scaler-loop.ts); the terminal write
lives in the reconciler/`main.ts` repo-owning layer.** No new terminal-write
site is introduced.

## Consequences

- Fast settle (tick-scale, ~10 s) for the common in-pool drop; the 30-minute
  `stallTimeoutMs` backstop is retained unchanged for the residual
  scaled-down/process-down cases. No behaviour is removed.
- No new HTTP fan-out: reuses the two `findByStatus` calls `reconcile()`
  already issues per instance (`scaler-loop.ts:213-220`).
- One additive, optional, best-effort scaler config hook (mirroring the three
  existing repo-bridge hooks in `types.ts:65-81`); the scaler package remains
  repository-free.
- Terminal writes remain funnelled through the single idempotent `settleFailed`
  path (`failed-transcode-reconciler.ts:151`), so first-terminal-write-wins and
  late-callback safety hold across all paths.
- The reconcile settle must overwrite the stale `keys.jobStatus` Valkey entry
  (`types.ts:119`, written `'running'` at `scaler-loop.ts:291`); the fix
  sub-issue must include that write so the Valkey view and the durable job
  record cannot diverge.
- Implementation (the `onJobsDropped` hook, `reconcile()` returning the dropped
  id set, the `main.ts` wiring, and tests) is out of scope here and is tracked
  by the fix sub-issue this ADR unblocks.
