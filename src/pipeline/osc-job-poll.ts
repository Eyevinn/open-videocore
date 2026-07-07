// Shared completion helper for OSC eyevinn-ffmpeg-s3 ephemeral jobs.
//
// OSC FRICTION (logged in docs/osc-feedback/): waitForJobToComplete polls
// job.status === 'Complete' but eyevinn-ffmpeg-s3 signals completion via the
// health endpoint returning 'SuccessCriteriaMet'. The raw instance object from
// getJob/getInstance has no 'health' field — health is a separate endpoint.
// We use getInstanceHealth directly and poll until a terminal status appears.

import { getInstanceHealth } from '@osaas/client-core';
import type { Context } from '@osaas/client-core';

export type JobWaiter = {
  context: Context;
  getInstanceHealth: typeof getInstanceHealth;
};

const TERMINAL_HEALTH = new Set(['SuccessCriteriaMet', 'Failed', 'Error', 'Stopped']);
const POLL_INTERVAL_MS = 3_000;
const TIMEOUT_MS = 5 * 60_000; // 5 minutes

// Wait for an OSC ephemeral job to reach a terminal state by polling the
// health endpoint directly. Returns the terminal health string so callers can
// branch on success vs failure. Throws on timeout.
export async function pollOscJobUntilDone(
  api: JobWaiter,
  serviceId: string,
  name: string,
  sat: string
): Promise<string> {
  const deadline = Date.now() + TIMEOUT_MS;
  while (Date.now() < deadline) {
    const health = await api.getInstanceHealth(api.context, serviceId, name, sat);
    if (health && TERMINAL_HEALTH.has(health)) {
      return health;
    }
    await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS));
  }
  throw new Error(`probe job "${name}" timed out after ${TIMEOUT_MS / 1000}s`);
}
