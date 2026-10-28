# OSC Friction: `POST /encoreJobs/{id}/cancel` answers 200 "Ok" but does not stop a FROZEN encode, and the job never leaves the active set

**Date:** 2026-10-15
**Severity:** Medium (no data loss, but a cancelled job keeps burning a whole
instance's CPU and a slot against `maxInstances` until something destroys the
instance)
**Service:** encore (Encore transcoding service on OSC)
**Affected features:** job cancel (`DELETE /api/v1/jobs/{id}`), scaler
scale-down / drain-don't-kill (#513), instance reclaim (#1219)

## What we expected

The documented cancel contract is a single POST, no body:

```
POST {instanceUrl}/encoreJobs/{uuid}/cancel
```

Contract source: SVT Encore `EncoreController.kt`
(github.com/svt/encore, `encore-web/.../controller/EncoreController.kt`),
mirrored in this repo at `src/pipeline/encore-client.ts:52-58` (interface
`EncoreClient.cancel`) and `src/pipeline/encore-client.ts:142-155` (the call
itself). Only `NEW`/`QUEUED`/`IN_PROGRESS` jobs are cancellable; `404`/`409`
mean the job is already gone or terminal.

We expected a 2xx to mean the job stops: the encode is interrupted and the job
leaves the set returned by

```
GET {instanceUrl}/encoreJobs/search/findByStatus?status=QUEUED|IN_PROGRESS
```

(page shape captured in `docs/contracts/encore-findbystatus-paging.json`; read
by `src/encore-scaler/encore-active-state.ts`).

## What actually happens

Reproduced by hand in issue #1219, against a job whose source connection was cut
mid-encode (a "frozen" encode — the ffmpeg process is blocked in a read that
never returns):

1. Submit a transcode; let it reach `IN_PROGRESS`.
2. Cut the source connection mid-encode. ffmpeg keeps logging frame lines.
3. `POST {instanceUrl}/encoreJobs/{uuid}/cancel`.
4. The request returns **`200 "Ok"`**.
5. ffmpeg keeps running and frame lines keep coming. The job stays in the
   `QUEUED`+`IN_PROGRESS` set returned by `findByStatus` **indefinitely** — it
   never reaches a terminal status and never emits a completion callback.

So the 200 acknowledges that the cancel was *recorded*, not that the job was
*stopped*. There is no field in the job document, and no status, that
distinguishes "cancel accepted and acted on" from "cancel accepted and ignored":
polling the job tells us only that it is still active.

The reporter's own workaround was to delete the Encore instance — the only thing
that stopped the process.

## Why this costs us more than a stale status

Our scaler reads the `findByStatus` active set as the authoritative "real
in-flight work" signal before it tears an instance down (drain-don't-kill,
#513), precisely so a tracked-count divergence can never kill a live transcode.
A job that ignores its cancel therefore **pins its instance for ever**:
`real.count` never reaches 0, so every tick drains the instance and none ever
destroys it, it keeps counting towards `maxInstances`, and the ffmpeg keeps
burning CPU on a job nobody wants.

## Workaround we shipped (#1219, PR #1229)

`src/encore-scaler/cancelled-job-reclaim.ts`:

- record the cancel with its timestamp (`encore:job-cancel-requested:{jobId}`,
  24h TTL) and mark the host instance `draining` so no further transcode is
  routed to an instance whose job may be stuck;
- after a grace window (`CANCEL_RECLAIM_GRACE_MS`, 60s — well above a healthy
  cancel, well below the idle timeout), a cancelled job that Encore STILL
  reports active has demonstrably ignored its cancel, so it stops counting as
  work that protects its instance, and the existing scale-down path destroys
  the instance — doing automatically what the reporter had to do by hand;
- every other active job keeps full drain-don't-kill protection (the exclusion
  is per-`externalId`), an instance whose real state cannot be confirmed is
  never destroyed, and a truncated active page leaves its unseen jobs counted;
- a cancel Encore honours normally must not cost its host instance anything, so
  a cancel-set drain is explicitly NOT evidence for teardown: with no abandoned
  job past the grace window, scale-down keeps the instance, releases the drain
  and lets the normal idle timeout govern it.

Destroying a healthy instance to stop one job is a blunt instrument. We only do
it because there is no narrower lever.

## What we would like from the service

Any one of these would let us drop the instance-level reclaim:

1. **A cancel that actually interrupts the encode** — kill/`SIGKILL` the ffmpeg
   child after a bounded wait when a cooperative cancel does not take effect,
   and move the job to a terminal status.
2. **A force variant**, e.g. `POST /encoreJobs/{uuid}/cancel?force=true` (or a
   documented `DELETE /encoreJobs/{uuid}`), with a stated contract for what it
   stops.
3. **An observable cancel outcome** — a `cancelRequestedAt` /
   `cancelAcknowledged` field (or a distinct `CANCELLING` status) on the job
   document, so "cancel in progress" is distinguishable from "cancel ignored"
   without us timing it ourselves and guessing a grace window.
4. **A watchdog** that fails a job whose progress has not advanced for N
   minutes, which would also cover the frozen-source case with no cancel at all.

## References

- Issue #1219 (cancelling a frozen transcode job does not stop it on Encore);
  PR #1229 and its review finding on cancel-set drains.
- `src/encore-scaler/cancelled-job-reclaim.ts` — the reclaim and its grace
  window.
- `src/encore-scaler/cancel-target.ts` — how the cancel URL is resolved.
- `src/pipeline/encore-client.ts:52-58,142-155` — the cancel contract as we
  call it.
- `docs/contracts/encore-findbystatus-paging.json`,
  `src/encore-scaler/encore-active-state.ts` — the active-set contract whose
  "job is still here" answer is what the ignored cancel poisons.
- Related, already logged: `incoming-issue769-encore-findbystatus-paging.md`
  (discoverability of the same API surface).
