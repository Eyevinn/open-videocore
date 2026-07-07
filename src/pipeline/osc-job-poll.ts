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
const POLL_INTERVAL_MS = 3_000;
const TIMEOUT_MS = 5 * 60_000; // 5 minutes

// Wait for an OSC ephemeral job to reach a terminal state. Returns the terminal
// status string so callers can branch on success vs failure. Throws on timeout.
export async function pollOscJobUntilDone(
  api: JobWaiter,
  serviceId: string,
  name: string,
  sat: string
): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const job = await api.getJob(api.context, serviceId, name, sat) as Record<string, unknown> | undefined;
    if (job === undefined) return 'Complete'; // instance gone = completed and cleaned up
    const status = job['status'] as string | undefined;
    if (status && TERMINAL_STATUS.has(status)) return status;
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
  throw new Error(`probe job "${name}" timed out after ${TIMEOUT_MS / 1000}s`);
}
