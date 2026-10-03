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
//   lib/core.d.ts:153 waitForInstanceReady(serviceId: string, name: string,
//                       ctx: Context): Promise<void>   (the helper replaced)
//   lib/context.d.ts:25 Context.getServiceAccessToken(serviceId): Promise<string>
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

// The logger subset resolveReadinessDurationMs warns through. Deliberately the
// same shape BootstrapLogger uses (src/services/profile-bootstrap.ts:39-42), so
// Fastify's `app.log` satisfies it directly with no adapter.
export type InstanceReadinessLogger = {
  warn: (obj: unknown, msg?: string) => void;
};

// Resolve a readiness duration (ms) from a raw environment string, rejecting
// anything that would not actually bound the wait.
//
// WHY THIS EXISTS (#1055 review, blocking finding 2). Callers used to read the
// env directly — `parseInt(process.env['PROVISION_READY_TIMEOUT_MS'], 10)` —
// and leave the default to the `??` fallbacks downstream
// (src/routes/provision.ts readinessOptions, and `options.timeoutMs ??
// DEFAULT_INSTANCE_READY_TIMEOUT_MS` in waitForInstanceReadyBounded below).
// That does not hold, because `parseInt('abc', 10)` is `NaN` and NaN is NOT
// nullish: it survives every `??` and lands in `timeoutMs`, where it kills all
// three loop guards at once —
//   * `remaining <= 0` is false for NaN, so the loop never breaks there;
//   * `Math.min(pollIntervalMs, NaN)` is NaN, so setTimeout fires immediately
//     instead of waiting out the poll interval; and
//   * `Date.now() >= deadline` is never true for a NaN deadline.
// The result is the opposite of this module's purpose: an unbounded hot loop
// issuing hundreds of getInstanceHealth calls a second for the life of the
// process. `'0'` was a milder variant of the same hole — truthy, so it was
// forwarded, putting the deadline in the past and timing the wait out before
// its first probe.
//
// So only a finite, strictly positive duration is accepted. Anything else
// (unparseable, zero, negative) falls back to `defaultMs`, and a value the
// operator actually set is warn-logged naming the rejected input so a typo is
// visible at boot rather than silently changing the deadline.
export function resolveReadinessDurationMs(
  raw: string | undefined,
  defaultMs: number,
  envName: string,
  log?: InstanceReadinessLogger
): number {
  if (raw === undefined || raw.trim() === '') return defaultMs;
  const parsed = parseInt(raw, 10);
  if (Number.isFinite(parsed) && parsed > 0) return parsed;
  log?.warn(
    { env: envName, value: raw, fallbackMs: defaultMs },
    `${envName} must be a positive number of milliseconds; ignoring ` +
      `"${raw}" and using the default of ${defaultMs}ms`
  );
  return defaultMs;
}

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
