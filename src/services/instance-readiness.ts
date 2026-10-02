// Bounded readiness wait for an OSC service instance.
//
// WHY THIS EXISTS (issue #1038, originally #778 review finding 4):
// @osaas/client-core's own waitForInstanceReady is
//
//   async function waitForInstanceReady(serviceId, name, ctx) {
//     const serviceAccessToken = await ctx.getServiceAccessToken(serviceId);
//     let instanceOk = false;
//     while (!instanceOk) {
//       await delay(1000);
//       const status = await getInstanceHealth(ctx, serviceId, name, serviceAccessToken);
//       if (status && status === 'running') { instanceOk = true; }
//     }
//   }
//
// (verified verbatim in node_modules/@osaas/client-core/lib/core.js:343-353,
// v0.24.0). Two problems, both of which have bitten this repo:
//   1. NO DEADLINE. An instance that never reports `running` hangs the caller
//      forever while a live, billing OSC instance sits there untracked.
//   2. NO TOLERANCE FOR A FAILED POLL. getInstanceHealth is a plain fetch, and
//      it is not wrapped in a try, so ONE transient network error out of
//      several hundred polls (`fetch failed`) rejects the whole wait — even
//      when the instance would have come up seconds later. That is what
//      aborted a full stack provision on 2026-09-30.
// Logged as OSC friction (CLAUDE.md rule 6):
//   docs/osc-feedback/incoming-waitforinstanceready-unbounded.md
//
// This helper owns the poll loop instead: it has a hard deadline, treats a
// failed probe as "not ready yet" and retries until that deadline, and folds
// the last probe error (or last reported health) into the timeout message so
// the failure names the service instead of surfacing a bare `fetch failed`.
//
// Owning the loop also matters for cancellation (#778 review round 2): racing a
// timer against the SDK helper left its internal `while (!instanceOk)` loop
// running after the caller stopped waiting — the SDK exposes no AbortSignal and
// no cancellation — leaking one getInstanceHealth request per second for the
// lifetime of the process.
//
// CONTRACTS VERIFIED (CLAUDE.md rule 7), @osaas/client-core@0.24.0:
//   lib/core.d.ts:86  getInstanceHealth(context: Context, serviceId: string,
//                       name: string, token: string): Promise<string>
//   lib/core.d.ts:152 waitForInstanceReady(serviceId: string, name: string,
//                       ctx: Context): Promise<void>   (the helper replaced)
//   lib/context.d.ts  Context.getServiceAccessToken(serviceId): Promise<string>
// 'running' is the exact ready state the SDK's own helper gates on
// (lib/core.js:347-349), so this is behaviour-compatible on the happy path and
// no chattier than it (same 1s cadence).

import { getInstanceHealth, type Context } from '@osaas/client-core';

// Default bound (ms) on how long a readiness wait polls before giving up.
export const DEFAULT_INSTANCE_READY_TIMEOUT_MS = 5 * 60_000;

// Default cadence (ms) between health probes. Matches the 1s cadence the SDK's
// waitForInstanceReady uses (lib/core.js:343-353, v0.24.0). The final sleep is
// clamped to the remaining budget, so a timeout shorter than one interval still
// ends on time.
export const DEFAULT_INSTANCE_READY_POLL_INTERVAL_MS = 1_000;

export type InstanceReadinessOptions = {
  // Hard deadline for the whole wait. Unset =>
  // DEFAULT_INSTANCE_READY_TIMEOUT_MS.
  timeoutMs?: number;
  // Interval between health probes. Unset =>
  // DEFAULT_INSTANCE_READY_POLL_INTERVAL_MS.
  pollIntervalMs?: number;
  // Human-readable label for the thing being waited on, used in the timeout
  // message (e.g. 'object storage'). Unset => the serviceId alone identifies
  // it. Never include credentials here.
  label?: string;
};

// Wait for an OSC instance to report `running`, with a hard deadline.
//
// Resolves as soon as getInstanceHealth returns 'running'. Rejects with an
// Error naming the service, the instance and the last probe error/health once
// the deadline passes. A rejecting probe is NOT fatal: it is recorded and
// retried on the next tick.
export async function waitForInstanceReadyBounded(
  context: Context,
  serviceId: string,
  name: string,
  options: InstanceReadinessOptions = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSTANCE_READY_TIMEOUT_MS;
  const pollIntervalMs =
    options.pollIntervalMs ?? DEFAULT_INSTANCE_READY_POLL_INTERVAL_MS;
  const deadline = Date.now() + timeoutMs;
  const sat = await context.getServiceAccessToken(serviceId);

  let lastError: unknown;
  let lastStatus: string | undefined;
  for (;;) {
    // Sleep first, as the SDK helper does: a just-created instance is never
    // healthy on the same tick it was created.
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, Math.min(pollIntervalMs, remaining));
      timer.unref?.();
    });

    try {
      const status = await getInstanceHealth(context, serviceId, name, sat);
      lastStatus = status;
      if (status === 'running') return;
    } catch (err) {
      // A transient probe failure (`fetch failed`, a 404/503 while the
      // instance is still being scheduled) means "not ready yet", not "give
      // up" — the single most important difference from the SDK helper.
      lastError = err;
    }
    if (Date.now() >= deadline) break;
  }

  const detail = lastError
    ? `; last health check error: ${
        lastError instanceof Error ? lastError.message : String(lastError)
      }`
    : lastStatus
      ? `; last reported health: ${lastStatus}`
      : '';
  const what = options.label
    ? `${options.label}, service ${serviceId}`
    : `service ${serviceId}`;
  throw new Error(
    `timed out after ${timeoutMs}ms waiting for OSC instance ${name} ` +
      `(${what}) to report running${detail}`
  );
}
