// Shared completion helper for OSC eyevinn-ffmpeg-s3 ephemeral jobs.
//
// The SDK's waitForJobToComplete blocks until the job reaches a terminal
// status, resolving on success and rejecting on failure/timeout. The runners
// delegate to it so the wait/cleanup lifecycle lives in one place and tests can
// inject a lightweight fake (mirrors the OscJobApi fakes in the runner tests).
//
// OSC FRICTION: logged in docs/osc-feedback/incoming-issue6-metadata.md

import type { waitForJobToComplete } from '@osaas/client-core';
import type { Context } from '@osaas/client-core';

export type JobWaiter = {
  context: Context;
  waitForJobToComplete: typeof waitForJobToComplete;
};

// Wait for an OSC ephemeral job to reach a terminal state. Resolves when the
// job completes successfully; rejects (propagating the SDK error) on failure or
// timeout. Returns the terminal status string for callers that branch on it.
export async function pollOscJobUntilDone(
  api: JobWaiter,
  serviceId: string,
  name: string,
  sat: string
): Promise<string> {
  await api.waitForJobToComplete(api.context, serviceId, name, sat);
  return 'Complete';
}
