// Optional operator-configured job-throughput / concurrency cap (issue #580).
//
// WHY THIS EXISTS — and why it is NOT a second accounting path.
//
// The Encore auto-scaler (ADR-006) already bounds the number of CONCURRENTLY
// RUNNING Encore OSC instances via `maxInstances` (ENCORE_MAX_INSTANCES,
// src/main.ts:610; enforced in src/encore-scaler/scaler-loop.ts:122). That caps
// live compute cost. It does NOT, however, bound job SUBMISSION: the submit path
// enqueues onto an unbounded Valkey list (src/encore-scaler/index.ts
// makeScalingEncoreClient.submit, src/encore-scaler/encore-scaler-router.ts
// POST /encoreJobs), so a busy client can push an unbounded backlog that the
// pool drains serially. That backlog is the cost/throughput surface this cap
// guards: it bounds how many jobs may be OUTSTANDING (queued + being dispatched)
// at once, and rejects over-limit submissions up front with a 429.
//
// Source of truth (ADR-020 Decision 2, applied to jobs): this cap reuses the
// scaler's OWN Valkey state — the pending queue (encore:queue:{workspaceId}) and
// the transient inflight list (encore:inflight:{workspaceId}) — as the single
// authoritative measure of outstanding work. It introduces NO parallel counter.
// Those are exactly the two depths the scaler status surface already reports
// (src/routes/scaler.ts:114-118).
//
// Deployment model (ADR-020 Decision 1): the cap is a single instance-wide
// ceiling. There is no per-request tenant/workspace dimension; the workspaceId
// used for the Valkey keys is the deployment-wide context
// (DEPLOYMENT_CONTEXT, src/auth/workspace.ts).
//
// Opt-in: when no cap is configured the assertion is a no-op and submission
// behaviour is unchanged.

import type { Redis } from 'ioredis';
import { keys } from './types.js';

// The reason code surfaced to the caller in the machine-readable error body and
// used as the `error` discriminator, so a client can branch on it without
// string-matching a message.
export const JOB_THROUGHPUT_CAP_REASON = 'job_throughput_cap_exceeded' as const;

// A structured error raised when accepting one more job would exceed the
// operator-configured outstanding-job cap. Mirrors DependencyUnreachableError
// (src/encore-scaler/dependency-timeout.ts): it carries a `statusCode` and a
// `toResponseBody()` so the route maps it deterministically and the caller gets
// a machine-readable reason code rather than a silent unbounded queue.
export class JobThroughputCapExceededError extends Error {
  // HTTP status the route should return. 429 Too Many Requests communicates
  // "you are over an allowed rate/volume; retry later" — the correct semantic
  // for an admission cap (vs 409, which implies a state conflict).
  readonly statusCode = 429 as const;
  readonly reason = JOB_THROUGHPUT_CAP_REASON;
  // The configured ceiling and the observed outstanding count, for diagnostics.
  readonly cap: number;
  readonly outstanding: number;

  constructor(cap: number, outstanding: number) {
    super(
      `Job throughput cap exceeded: ${outstanding} job(s) already outstanding, ` +
        `cap is ${cap}. Retry once in-flight work drains.`
    );
    this.name = 'JobThroughputCapExceededError';
    this.cap = cap;
    this.outstanding = outstanding;
  }

  // The machine-readable body a route sends to the caller.
  toResponseBody(): {
    error: typeof JOB_THROUGHPUT_CAP_REASON;
    cap: number;
    outstanding: number;
    message: string;
  } {
    return {
      error: this.reason,
      cap: this.cap,
      outstanding: this.outstanding,
      message: this.message
    };
  }
}

export function isJobThroughputCapExceededError(
  err: unknown
): err is JobThroughputCapExceededError {
  return err instanceof JobThroughputCapExceededError;
}

// Resolve the opt-in cap from the environment. ENCORE_MAX_QUEUED_JOBS is the
// maximum number of OUTSTANDING jobs (pending in the queue + being dispatched)
// an operator will allow at once. Unset, zero, negative, or non-numeric => no
// cap (undefined), which keeps submission behaviour unchanged (opt-in).
export function resolveJobThroughputCap(
  env: NodeJS.ProcessEnv = process.env
): number | undefined {
  const raw = env['ENCORE_MAX_QUEUED_JOBS'];
  if (!raw) return undefined;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return parsed;
}

// Current count of outstanding jobs from the scaler's OWN Valkey state: pending
// queue depth + transient inflight depth. This is the single source of truth —
// the same two depths the scaler status surface reports (src/routes/scaler.ts).
// No separate counter is maintained.
export async function outstandingJobCount(
  redis: Redis,
  workspaceId: string
): Promise<number> {
  const [queued, inflight] = await Promise.all([
    redis.llen(keys.queue(workspaceId)),
    redis.llen(keys.inflight(workspaceId))
  ]);
  return queued + inflight;
}

// Throw JobThroughputCapExceededError if accepting ONE more job would push the
// outstanding count past `cap`. No-op when `cap` is undefined (opt-in disabled).
//
// Admission semantics: we reject when `outstanding >= cap` (i.e. there is no
// headroom for one more), so a cap of N admits up to N outstanding jobs.
export async function assertUnderJobThroughputCap(
  redis: Redis,
  workspaceId: string,
  cap: number | undefined
): Promise<void> {
  if (cap === undefined) return;
  const outstanding = await outstandingJobCount(redis, workspaceId);
  if (outstanding >= cap) {
    throw new JobThroughputCapExceededError(cap, outstanding);
  }
}
