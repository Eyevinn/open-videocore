// Shared completion helper for OSC eyevinn-ffmpeg-s3 ephemeral jobs.
//
// OSC FRICTION (logged in docs/osc-feedback/): waitForJobToComplete from the
// SDK polls for job.status === 'Complete', but eyevinn-ffmpeg-s3 reports
// completion via job.health === 'SuccessCriteriaMet' (pod-status health source).
// The SDK never detects completion and blocks for its full 1000-iteration
// timeout (~16 minutes). We work around this by polling getJob ourselves and
// checking the health field directly.

import { getJob } from '@osaas/client-core';
import type { Context } from '@osaas/client-core';

export type JobWaiter = {
  context: Context;
  getJob: typeof getJob;
};

const TERMINAL_HEALTH = new Set(['SuccessCriteriaMet', 'Failed', 'Error', 'Stopped']);
const POLL_INTERVAL_MS = 3_000;
const TIMEOUT_MS = 5 * 60_000; // 5 minutes

// Wait for an OSC ephemeral job to reach a terminal state by polling the
// health field on the instance object. Returns the terminal health string so
// callers can branch on success vs failure. Throws on timeout.
export async function pollOscJobUntilDone(
  api: JobWaiter,
  serviceId: string,
  name: string,
  sat: string
): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const job = await api.getJob(api.context, serviceId, name, sat) as Record<string, unknown> | undefined;
    const health = job?.['health'] as string | undefined;
    if (health && TERMINAL_HEALTH.has(health)) {
      return health;
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
  throw new Error(`probe job "${name}" timed out after ${TIMEOUT_MS / 1000}s`);
}
