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
// them — so only ONE member of this set is evidenced: OBSERVATION against the
// live service on 2026-09-24 showed a job polled every 2s reporting
// `status: "Running"` for its entire execution, flipping straight to
// `"SuccessCriteriaMet"` when ffmpeg exited.
//
// The remaining members are deliberate, unproven padding (issue #786 round-2
// review). Because the in-progress vocabulary is unpublished, a value we have
// not seen yet is indistinguishable from "still working", and the cost of
// guessing wrong is asymmetric: mistaking a queueing status for "unknown" fails
// a healthy job, while mistaking it for "active" only costs the wait more time
// (still bounded by TIMEOUT_MS). So the plausible scheduling/cold-start
// vocabulary is admitted here rather than treated as unrecognised. Matching is
// case-insensitive (see isActiveStatus) for the same reason.
// A missing/empty status is handled separately below (treated as "not scheduled
// yet", bounded by TIMEOUT_MS).
const ACTIVE_STATUS = new Set([
  'Running',
  // Plausible pre-execution vocabulary — unproven, admitted to avoid failing a
  // job that is merely queued or pulling an image.
  'Pending',
  'Queued',
  'Scheduled',
  'Scheduling',
  'Starting',
  'Creating',
  'ContainerCreating',
  'Initializing',
  'Waiting',
  'Provisioning',
  'InProgress',
  'Active'
]);

const ACTIVE_STATUS_LOWER = new Set([...ACTIVE_STATUS].map((s) => s.toLowerCase()));

function isActiveStatus(status: string): boolean {
  return ACTIVE_STATUS_LOWER.has(status.toLowerCase());
}

const POLL_INTERVAL_MS = 3_000;
const TIMEOUT_MS = 5 * 60_000; // 5 minutes

// How long a status that is neither known-terminal nor known-active is tolerated
// before an opted-in caller gives up (issue #786 review): without this, a status
// the service grew since — 'Cancelled', 'Timeout', a renamed failure value — is
// silently non-terminal, so the caller keeps polling for the full TIMEOUT_MS.
// For the awaited routes (POST /:id/clip, POST /:id/export) that means a request
// held open for five minutes, well past any sensible gateway timeout, for a job
// that is already finished.
//
// Sized at two minutes so it comfortably clears a container cold start (image
// pull + schedule) — 30s, the round-1 value, is shorter than a plausible pull —
// while still failing well inside TIMEOUT_MS and while the caller is listening.
const UNKNOWN_STATUS_GRACE_MS = 120_000;

export type PollOptions = {
  // OPT-IN fail-fast on a status that is neither terminal nor known-active
  // (issue #786 round-2 review). Default false — an unrecognised status is
  // simply polled until TIMEOUT_MS, which is the behaviour every caller had
  // before #786 and which still ends in a failure, just later.
  //
  // Only the AWAITED pipelines pass true: POST /:id/clip (osc-clip.ts) and
  // POST /:id/export (osc-rewrap.ts) hold an HTTP request open for the whole
  // wait, so five minutes on a job that is already dead is a held connection
  // past any sensible gateway timeout. The fire-and-forget pipelines —
  // osc-ffprobe.ts and osc-thumbnail.ts, both dispatched with `void` from
  // main.ts:onObjectStored on EVERY ingest — keep the tolerant behaviour: there
  // nobody is waiting, so the only thing fail-fast could buy is a way for an
  // unseen-but-healthy queueing status to break metadata extraction and
  // thumbnails for every uploaded asset.
  failFastOnUnknownStatus?: boolean;
};

// Wait for an OSC ephemeral job to reach a terminal state. Returns the terminal
// status string so callers can branch on success vs failure.
//
// THROWS on timeout, and — only when `failFastOnUnknownStatus` is set — on a
// status that is neither in TERMINAL_STATUS nor in ACTIVE_STATUS once it has
// persisted for UNKNOWN_STATUS_GRACE_MS. Throwing (rather than returning the
// unknown value) is deliberate: callers classify a returned status against their
// own success/failure lists, and every current caller's failure list is a closed
// set of known-bad values, so a returned unknown status would read as SUCCESS.
// An unrecognised terminal value is not evidence of success — it is evidence we
// cannot tell.
//
// NOTE the fail-safe property does not depend on this option: osc-clip.ts guards
// the poller's return value with a SUCCESS_STATUSES ALLOW-list, so an
// unrecognised status can never become a 201 whether it is failed fast or waited
// out. The option buys latency on the awaited routes, nothing else.
export async function pollOscJobUntilDone(
  api: JobWaiter,
  serviceId: string,
  name: string,
  sat: string,
  options: PollOptions = {}
): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  let unrecognised: { status: string; since: number } | undefined;
  while (Date.now() < deadline) {
    const job = await api.getJob(api.context, serviceId, name, sat) as Record<string, unknown> | undefined;
    if (job === undefined) return 'Complete'; // instance gone = completed and cleaned up
    const status = job['status'] as string | undefined;
    if (status && TERMINAL_STATUS.has(status)) return status;
    if (status && !isActiveStatus(status)) {
      // Unrecognised, non-empty status: neither "done" nor "still working" as far
      // as this poller knows. Opted-in callers give it a bounded grace window (in
      // case it is a transient scheduling value) and then fail rather than spin
      // to TIMEOUT_MS; everyone else keeps polling, exactly as before #786.
      if (unrecognised?.status !== status) unrecognised = { status, since: Date.now() };
      if (
        options.failFastOnUnknownStatus === true &&
        Date.now() - unrecognised.since >= UNKNOWN_STATUS_GRACE_MS
      ) {
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
