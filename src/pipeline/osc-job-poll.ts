// Shared completion helper for OSC eyevinn-ffmpeg-s3 ephemeral jobs.
//
// OSC FRICTION (logged in docs/osc-feedback/): waitForJobToComplete polls
// job.status === 'Complete' but eyevinn-ffmpeg-s3 sets job.status to
// 'SuccessCriteriaMet' on completion. The SDK never detects this and loops
// for 1000 iterations (~16 min). We poll getJob directly and check against
// the actual terminal values observed from the service.

import { getJob } from '@osaas/client-core';
import type { Context } from '@osaas/client-core';

export type JobWaiter = {
  context: Context;
  getJob: typeof getJob;
};

// 'SuccessCriteriaMet' is the terminal status for eyevinn-ffmpeg-s3 jobs.
// 'Complete' is what the SDK waits for (never set by this service).
const TERMINAL_STATUS = new Set(['SuccessCriteriaMet', 'Complete', 'Failed', 'Error', 'Stopped']);

// Statuses that mean "the job is still working, keep polling". OSC publishes no
// enumeration of `job.status` values — `getJob` is typed `Promise<any>`
// (@osaas/client-core/lib/job.d.ts:51) and the service description does not list
// them — so this set was established by OBSERVATION against the live service on
// 2026-09-24: a job polled every 2s reported `status: "Running"` for its entire
// execution and flipped straight to `"SuccessCriteriaMet"` when ffmpeg exited.
// A missing/empty status is handled separately below (treated as "not scheduled
// yet", bounded by TIMEOUT_MS).
const ACTIVE_STATUS = new Set(['Running']);

const POLL_INTERVAL_MS = 3_000;
const TIMEOUT_MS = 5 * 60_000; // 5 minutes

// How long a status that is neither known-terminal nor known-active is tolerated
// before the wait gives up (issue #786 review): without this, a status the
// service grew since — 'Cancelled', 'Timeout', a renamed failure value — is
// silently non-terminal, so the caller keeps polling for the full TIMEOUT_MS.
// For the awaited routes (POST /:id/clip) that means a request held open for five
// minutes, well past any sensible gateway timeout, for a job that is already
// finished. Ten poll cycles is long enough to ride out a transient value and
// short enough to fail while the caller is still listening.
const UNKNOWN_STATUS_GRACE_MS = 30_000;

// Wait for an OSC ephemeral job to reach a terminal state. Returns the terminal
// status string so callers can branch on success vs failure.
//
// THROWS on timeout, and on a status that is neither in TERMINAL_STATUS nor in
// ACTIVE_STATUS once it has persisted for UNKNOWN_STATUS_GRACE_MS. Throwing
// (rather than returning the unknown value) is deliberate: callers classify a
// returned status against their own success/failure lists, and every current
// caller's failure list is a closed set of known-bad values, so a returned
// unknown status would read as SUCCESS. An unrecognised terminal value is not
// evidence of success — it is evidence we cannot tell — so it surfaces as a
// failure to every caller at once.
export async function pollOscJobUntilDone(
  api: JobWaiter,
  serviceId: string,
  name: string,
  sat: string
): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  let unrecognised: { status: string; since: number } | undefined;
  while (Date.now() < deadline) {
    const job = await api.getJob(api.context, serviceId, name, sat) as Record<string, unknown> | undefined;
    if (job === undefined) return 'Complete'; // instance gone = completed and cleaned up
    const status = job['status'] as string | undefined;
    if (status && TERMINAL_STATUS.has(status)) return status;
    if (status && !ACTIVE_STATUS.has(status)) {
      // Unrecognised, non-empty status: neither "done" nor "still working" as far
      // as this poller knows. Give it a bounded grace window (in case it is a
      // transient scheduling value) and then fail rather than spin to TIMEOUT_MS.
      if (unrecognised?.status !== status) unrecognised = { status, since: Date.now() };
      if (Date.now() - unrecognised.since >= UNKNOWN_STATUS_GRACE_MS) {
        throw new Error(
          `job "${name}" reported unrecognised status "${status}" for ` +
            `${UNKNOWN_STATUS_GRACE_MS / 1000}s; treating it as a failure ` +
            `(known terminal: ${[...TERMINAL_STATUS].join(', ')}; known active: ${[...ACTIVE_STATUS].join(', ')})`
        );
      }
    } else {
      unrecognised = undefined;
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
  throw new Error(`probe job "${name}" timed out after ${TIMEOUT_MS / 1000}s`);
}
