// Bounds for stack teardown: per-call deadlines, bounded retry with backoff,
// and a classified failure the caller can report verbatim (issue #1212).
//
// WHY THIS EXISTS
// ---------------
// A second DELETE on a partially deleted stack stayed `running` for more than
// seven minutes and removed nothing more. Two properties were missing:
//
//   1. NOTHING BOUNDED AN OSC CALL. Every teardown step goes through
//      @osaas/client-core, and none of its functions take a timeout, a deadline
//      or an AbortSignal (see the contract notes below). A control-plane call
//      that never answers therefore blocks the teardown closure forever, the
//      async operation never leaves `running`, and the services AFTER the stuck
//      one are never attempted — which is exactly "removed nothing more".
//   2. NOTHING RETRIED A TRANSIENT FAULT. `ORCHESTRATOR_UNAVAILABLE` and the
//      transport-level `fetch failed` are momentary: the same call a second
//      later usually succeeds. Without a retry each one costs a whole service,
//      so a flapping control plane left a stack half torn down and billing.
//
// This module supplies both, plus the vocabulary to REPORT them: every failure
// is classified `timeout` | `transient` | `permanent` and carries the attempt
// count and the underlying message.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
// -----------------------------------------------------------
//   - @osaas/client-core@0.24.0 (the version pinned in package.json) —
//     lib/core.d.ts:46/56/65:
//        removeInstance(context, serviceId, name, token): Promise<void>
//        getInstance(context, serviceId, name, token): Promise<any>
//        listInstances(context, serviceId, token): Promise<any>
//     None of the three takes an options/signal argument, and
//     lib/context.d.ts `getServiceAccessToken(serviceId): Promise<string>` takes
//     none either. There is NO SDK-level way to bound any of them.
//   - @osaas/client-core@0.24.0 lib/fetch.js `createFetch` — calls the global
//     `fetch(url, { ...options })` with no `signal` and no timeout, so the only
//     bound on a hung control-plane call is undici's own 300s headers timeout,
//     applied per response phase. That is how a single DELETE can sit for
//     minutes. Logged as OSC friction in
//     docs/osc-feedback/incoming-osc-client-calls-cannot-be-bounded.md.
//   - @osaas/client-core@0.24.0 lib/fetch.js `defaultErrorFactory` /
//     lib/fetch.d.ts `class FetchError extends Error { httpCode?: number }` —
//     a non-ok response carries `httpCode`; a rejected `fetch` is re-wrapped as
//     `new FetchError({ message: getErrorMessage(error) })` with NO httpCode,
//     which is why a transport fault is classified on its message.
//   - src/encore-scaler/osc-error.ts `isTransientOscError` — the repo's single
//     structural classifier for OSC errors (5xx/408/429 by `httpCode`, plus the
//     ORCHESTRATOR_UNAVAILABLE / ECONNRESET / ETIMEDOUT / ... message markers).
//     Reused here rather than re-deriving a second, drifting copy.

import { isTransientOscError, oscHttpCode } from '../encore-scaler/osc-error.js';

// How a teardown step failed, as reported to the caller.
//   timeout    — the per-service budget ran out while an OSC call was in flight
//   transient  — the OSC error is retryable (5xx/408/429, orchestrator or
//                transport fault) and the bounded retries were exhausted
//   permanent  — the error will fail identically on every attempt
export type TeardownFailureKind = 'timeout' | 'transient' | 'permanent';

// Raised when a bounded operation outruns its deadline. Exported so callers
// outside this module (the DELETE route wraps the scaler and packager teardowns
// with it) can recognise a deadline breach rather than string-matching.
export class TeardownTimeoutError extends Error {
  readonly label: string;
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms`);
    this.name = 'TeardownTimeoutError';
    this.label = label;
    this.timeoutMs = timeoutMs;
  }
}

export function isTeardownTimeoutError(err: unknown): err is TeardownTimeoutError {
  return err instanceof TeardownTimeoutError;
}

// The failure a bounded OSC call reports once its attempts (or its deadline)
// are exhausted. The message is written to be shown to an operator as-is: it
// names the call, the attempt count, the classification, and the underlying
// error text, so a stuck teardown is diagnosable from the operation record
// alone.
export class TeardownCallError extends Error {
  readonly label: string;
  readonly attempts: number;
  readonly kind: TeardownFailureKind;
  readonly cause: unknown;

  constructor(detail: {
    label: string;
    attempts: number;
    kind: TeardownFailureKind;
    cause: unknown;
  }) {
    super(describeTeardownFailure(detail));
    this.name = 'TeardownCallError';
    this.label = detail.label;
    this.attempts = detail.attempts;
    this.kind = detail.kind;
    this.cause = detail.cause;
  }
}

export function isTeardownCallError(err: unknown): err is TeardownCallError {
  return err instanceof TeardownCallError;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The operator-facing sentence for a failed teardown step. ALWAYS ends with the
// underlying error text so no detail is lost behind the classification.
export function describeTeardownFailure(detail: {
  label: string;
  attempts: number;
  kind: TeardownFailureKind;
  cause: unknown;
}): string {
  const underlying = errorMessage(detail.cause);
  const plural = detail.attempts === 1 ? 'attempt' : 'attempts';
  switch (detail.kind) {
    case 'timeout':
      return (
        `${detail.label} did not finish within its teardown budget after ` +
        `${detail.attempts} ${plural}; the DELETE is safe to retry: ${underlying}`
      );
    case 'transient':
      return (
        `${detail.label} failed after ${detail.attempts} ${plural} ` +
        `(transient OSC failure, retried with backoff); the DELETE is safe to ` +
        `retry: ${underlying}`
      );
    default:
      return `${detail.label} failed: ${underlying}`;
  }
}

// `fetch failed` is undici's message for a rejected request (DNS failure, reset
// socket, TLS error) and reaches us as a FetchError with NO httpCode
// (lib/fetch.js `createFetch` outer catch). It is named explicitly in #1212 as a
// fault that must be retried.
//
// It is classified HERE rather than added to the shared marker list in
// src/encore-scaler/osc-error.ts on purpose: that list also governs the scaler's
// instance-spawn retries, where widening the transient set changes how long a
// failing spawn is retried. #1212 is a teardown fix, so the widening is scoped
// to teardown; the shared structural rules (httpCode 5xx/408/429, the
// orchestrator and socket markers) are reused unchanged.
//
// It is also gated the same way the shared list is gated: the marker is only
// consulted when the error carries NO httpCode (`oscHttpCode`,
// src/encore-scaler/osc-error.ts:48). A response WITH a status is classified on
// that status alone — otherwise a 400 or 404 whose body happens to quote
// "fetch failed" (an upstream error relayed verbatim through
// lib/fetch.js `defaultErrorFactory`) would be retried three times against a
// call that will reject identically every time, spending a service's whole
// teardown budget to learn nothing.
const TEARDOWN_TRANSIENT_MESSAGE_MARKERS = ['fetch failed'];

export function isTransientTeardownError(err: unknown): boolean {
  if (isTransientOscError(err)) return true;
  if (oscHttpCode(err) !== undefined) return false;
  const message = errorMessage(err).toLowerCase();
  return TEARDOWN_TRANSIENT_MESSAGE_MARKERS.some((marker) =>
    message.includes(marker)
  );
}

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

// Budget for ONE service's teardown, retries and backoff included. 30s is far
// longer than a healthy control-plane call (sub-second) and far shorter than
// undici's 300s-per-phase ceiling, so a hung call now costs one service's budget
// instead of the whole operation.
export const DEFAULT_SERVICE_TEARDOWN_TIMEOUT_MS = 30_000;

// Backstop for the WHOLE teardown operation, covering the steps that do not run
// through a per-service budget (the scaler registry teardown, the parameter
// store reads/writes). Guarantees the async operation always reaches a terminal
// state: 5 minutes is more than a full stack of per-service budgets needs and
// well under the 7+ minutes of `running` reported in #1212.
export const DEFAULT_OPERATION_TEARDOWN_TIMEOUT_MS = 300_000;

// Attempts for a READ (token mint, instance probe, confirming list). One
// immediate re-read: a GET that just lost its socket is cheap to repeat, and an
// unconfirmable read must not hold the operation open waiting out a backoff —
// the stack-level result stays `failed`, which is retryable by the operator, and
// the retry now skips whatever is already gone.
export const DEFAULT_TEARDOWN_READ_ATTEMPTS = 2;

// Attempts for the destructive removeInstance call, inclusive of the first.
// This is the call that makes progress, so it is the one worth waiting for.
export const DEFAULT_TEARDOWN_REMOVE_ATTEMPTS = 3;

// Waits before removal attempt 2 and attempt 3. Short and bounded: the faults
// this absorbs (ORCHESTRATOR_UNAVAILABLE, fetch failed, 502/503/504) clear in
// seconds, and every wait is additionally capped by the per-service budget.
export const DEFAULT_TEARDOWN_BACKOFF_MS: readonly number[] = [500, 1500];

export type TeardownBounds = {
  // Deadline for the whole DELETE operation (route-level backstop).
  operationTimeoutMs: number;
  // Deadline for one service's teardown, retries and backoff included.
  serviceTimeoutMs: number;
  // Bounded attempts for the probe/confirm reads (no backoff between them).
  readAttempts: number;
  // Bounded attempts for removeInstance.
  removeAttempts: number;
  // Backoff before removal attempt n+1. The last entry repeats if attempts
  // exceed the table.
  backoffMs: readonly number[];
  // Injected so tests do not spend real time; production uses real timers.
  sleep: (ms: number) => Promise<void>;
  now: () => number;
};

export type TeardownBoundsOverrides = Partial<TeardownBounds>;

// Real-timer sleep. unref'd so a pending backoff never keeps the process alive
// during shutdown.
export function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
  });
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function backoffList(
  raw: string | undefined,
  fallback: readonly number[]
): readonly number[] {
  if (!raw) return fallback;
  const parsed = raw
    .split(',')
    .map((part) => Number.parseInt(part.trim(), 10))
    .filter((n) => Number.isFinite(n) && n >= 0);
  return parsed.length > 0 ? parsed : fallback;
}

// Resolve the teardown bounds: defaults, overlaid by environment variables
// (12-factor config), overlaid by explicit overrides (used by the composition
// root and by tests). Invalid or absent env values fall back to the defaults
// rather than disabling the bound.
//
//   STACK_TEARDOWN_OPERATION_TIMEOUT_MS  whole-operation deadline (ms)
//   STACK_TEARDOWN_SERVICE_TIMEOUT_MS    per-service deadline (ms)
//   STACK_TEARDOWN_READ_ATTEMPTS         attempts for probe/confirm reads
//   STACK_TEARDOWN_REMOVE_ATTEMPTS       attempts for removeInstance
//   STACK_TEARDOWN_RETRY_BACKOFF_MS      comma-separated backoff table, e.g. "500,1500"
export function resolveTeardownBounds(
  overrides: TeardownBoundsOverrides = {},
  env: NodeJS.ProcessEnv = process.env
): TeardownBounds {
  return {
    operationTimeoutMs: positiveInt(
      env['STACK_TEARDOWN_OPERATION_TIMEOUT_MS'],
      DEFAULT_OPERATION_TEARDOWN_TIMEOUT_MS
    ),
    serviceTimeoutMs: positiveInt(
      env['STACK_TEARDOWN_SERVICE_TIMEOUT_MS'],
      DEFAULT_SERVICE_TEARDOWN_TIMEOUT_MS
    ),
    readAttempts: positiveInt(
      env['STACK_TEARDOWN_READ_ATTEMPTS'],
      DEFAULT_TEARDOWN_READ_ATTEMPTS
    ),
    removeAttempts: positiveInt(
      env['STACK_TEARDOWN_REMOVE_ATTEMPTS'],
      DEFAULT_TEARDOWN_REMOVE_ATTEMPTS
    ),
    backoffMs: backoffList(
      env['STACK_TEARDOWN_RETRY_BACKOFF_MS'],
      DEFAULT_TEARDOWN_BACKOFF_MS
    ),
    sleep: realSleep,
    now: Date.now,
    ...overrides
  };
}

// Race an operation against a deadline. The underlying promise is left to settle
// in the background — an in-flight SDK call cannot be cancelled (no AbortSignal,
// see the contract notes above) — but the CALLER always gets a prompt, definite
// outcome, which is what keeps the async operation out of a permanent `running`.
export async function withTeardownTimeout<T>(
  op: () => Promise<T>,
  detail: { label: string; timeoutMs: number }
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new TeardownTimeoutError(detail.label, detail.timeoutMs)),
      detail.timeoutMs
    );
    if (typeof timer.unref === 'function') timer.unref();
  });
  try {
    return await Promise.race([op(), deadline]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export type BoundedCallBudget = {
  // Maximum attempts, inclusive of the first (>= 1).
  attempts: number;
  // Waits before attempt 2, 3, ... An empty table means retry immediately.
  backoffMs: readonly number[];
  // Absolute epoch-ms deadline shared by every attempt of this service.
  deadlineAt: number;
  // Human-readable call name used in the reported failure.
  label: string;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  // Invoked with the attempt number before each attempt, so the caller can
  // report how much work a service actually cost.
  onAttempt?: (attempt: number) => void;
};

function backoffFor(attempt: number, table: readonly number[]): number {
  if (table.length === 0) return 0;
  const idx = Math.min(attempt - 1, table.length - 1);
  return table[idx] ?? 0;
}

// Run one OSC call under the service's deadline with bounded retries.
//
// Rules:
//   - every attempt is bounded by whatever is LEFT of the deadline, so a hung
//     call ends the step instead of the operation;
//   - a transient error is retried until the attempts or the deadline run out,
//     waiting the backoff in between (never past the deadline);
//   - a permanent error fails immediately — retrying a rejected request only
//     burns the budget and delays the real error.
//
// Always throws TeardownCallError on failure, so the caller has the label, the
// attempt count and the classification without re-deriving them.
export async function runBoundedOscCall<T>(
  op: () => Promise<T>,
  budget: BoundedCallBudget
): Promise<T> {
  const maxAttempts = Math.max(1, budget.attempts);
  let attempt = 0;
  let lastError: unknown;

  while (attempt < maxAttempts) {
    const remaining = budget.deadlineAt - budget.now();
    if (remaining <= 0) {
      throw new TeardownCallError({
        label: budget.label,
        attempts: attempt,
        kind: 'timeout',
        cause:
          lastError ??
          new TeardownTimeoutError(budget.label, 0)
      });
    }

    attempt += 1;
    budget.onAttempt?.(attempt);
    try {
      return await withTeardownTimeout(op, {
        label: budget.label,
        timeoutMs: remaining
      });
    } catch (err) {
      lastError = err;
      if (isTeardownTimeoutError(err)) {
        throw new TeardownCallError({
          label: budget.label,
          attempts: attempt,
          kind: 'timeout',
          cause: err
        });
      }
      if (!isTransientTeardownError(err)) {
        throw new TeardownCallError({
          label: budget.label,
          attempts: attempt,
          kind: 'permanent',
          cause: err
        });
      }
      if (attempt >= maxAttempts) break;
      const wait = backoffFor(attempt, budget.backoffMs);
      if (wait > 0) {
        // Never sleep past the deadline: a backoff that cannot be followed by
        // an attempt is pure delay.
        if (budget.now() + wait >= budget.deadlineAt) break;
        await budget.sleep(wait);
      }
    }
  }

  throw new TeardownCallError({
    label: budget.label,
    attempts: attempt,
    kind: 'transient',
    cause: lastError
  });
}
