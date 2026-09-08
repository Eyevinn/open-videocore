// Bounded dependency timeouts + named-dependency error (issue #616).
//
// The transcode submit path enqueues a job onto the stack's Valkey queue
// (src/encore-scaler/index.ts makeScalingEncoreClient.submit -> redis.lpush /
// redis.hset). The shared IORedis client is constructed lazily with
// `{ lazyConnect: true, maxRetriesPerRequest: null }` (src/main.ts:744), which
// means a command issued while Valkey is unreachable is queued in the client's
// offline command buffer and never rejects on its own. The request therefore
// hangs until the inbound socket is dropped (~50s) with no HTTP status, no body,
// and nothing logged for the caller (issue #616).
//
// This module provides:
//   1. DependencyUnreachableError — a structured, machine-readable error that
//      NAMES the unreachable dependency (which service + which endpoint) so the
//      route can map it to a deterministic 504 and log a diagnostic.
//   2. withDependencyTimeout — races an outbound dependency operation against a
//      bounded deadline so no single dependency can stall the request near the
//      ~50s socket-drop boundary. On deadline it throws DependencyUnreachableError.
//
// It is transport-agnostic (wraps any Promise), so it applies equally to the
// Valkey queue writes, and could wrap the Encore/storage calls on the same path.

// Default bound for a single outbound dependency operation on the transcode
// path. Well under the ~50s inbound socket-drop boundary so the caller always
// gets a definite response first. Overridable via env for operators on slow
// links; falls back to this default when unset/invalid.
export const DEFAULT_DEPENDENCY_TIMEOUT_MS = 5_000;

export function resolveDependencyTimeoutMs(
  env: NodeJS.ProcessEnv = process.env
): number {
  const raw = env['STACK_DEPENDENCY_TIMEOUT_MS'];
  if (!raw) return DEFAULT_DEPENDENCY_TIMEOUT_MS;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DEPENDENCY_TIMEOUT_MS;
}

// The stack dependencies an outbound call on the transcode path can target. Used
// as the machine-readable `dependency` discriminator in the error body so a
// caller can branch on it without string-matching a message.
export type StackDependency = 'queue' | 'encore' | 'storage';

export type DependencyUnreachableDetail = {
  // Which stack dependency was unreachable (machine-readable).
  dependency: StackDependency;
  // The endpoint we were talking to, with any credentials stripped. Names the
  // concrete target so an operator can diagnose without a live repro.
  endpoint: string;
  // The stack whose dependency was unreachable (workspace/deployment context).
  // Named `stackName` (not `stack`) so it never shadows Error.prototype.stack.
  stackName?: string;
  // The specific operation attempted (e.g. 'lpush encore:queue:default').
  operation?: string;
  // Why we gave up: a bounded-timeout deadline, or an underlying connect error.
  reason: 'timeout' | 'connect_error';
  // The bound we applied, when the failure was a timeout.
  timeoutMs?: number;
};

// A structured error raised when a required stack dependency is unreachable or
// does not respond within the bounded deadline. Carries enough detail (which
// dependency, which endpoint, which stack, cause) for a deterministic HTTP
// mapping AND a server-side diagnostic log, per issue #616.
export class DependencyUnreachableError extends Error {
  readonly dependency: StackDependency;
  readonly endpoint: string;
  readonly stackName?: string;
  readonly operation?: string;
  readonly reason: 'timeout' | 'connect_error';
  readonly timeoutMs?: number;
  // Preserved underlying cause for the server-side log (not exposed to callers).
  readonly cause?: unknown;

  constructor(detail: DependencyUnreachableDetail, cause?: unknown) {
    const target = detail.operation
      ? `${detail.dependency} (${detail.endpoint}) during ${detail.operation}`
      : `${detail.dependency} (${detail.endpoint})`;
    const why =
      detail.reason === 'timeout'
        ? `did not respond within ${detail.timeoutMs ?? DEFAULT_DEPENDENCY_TIMEOUT_MS}ms`
        : 'is unreachable';
    super(`Stack dependency ${target} ${why}`);
    this.name = 'DependencyUnreachableError';
    this.dependency = detail.dependency;
    this.endpoint = detail.endpoint;
    this.stackName = detail.stackName;
    this.operation = detail.operation;
    this.reason = detail.reason;
    this.timeoutMs = detail.timeoutMs;
    this.cause = cause;
  }

  // The machine-readable body a route sends to the caller. Deliberately omits
  // the underlying cause/stack trace (server-side only).
  toResponseBody(): {
    error: 'dependency_unreachable';
    dependency: StackDependency;
    endpoint: string;
    message: string;
  } {
    return {
      error: 'dependency_unreachable',
      dependency: this.dependency,
      endpoint: this.endpoint,
      message: this.message
    };
  }
}

export function isDependencyUnreachableError(
  err: unknown
): err is DependencyUnreachableError {
  return err instanceof DependencyUnreachableError;
}

// Strip credentials from a connection URL so an endpoint can appear in an error
// body / log without leaking secrets. `redis://user:pass@host:6379` becomes
// `redis://host:6379`. Falls back to the host:port heuristic when the value is
// not a parseable URL (redis URLs from OSC are standard URLs, but be defensive).
export function sanitizeEndpoint(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    // URL keeps a trailing slash for the empty path; trim it for readability.
    return parsed.toString().replace(/\/$/, '');
  } catch {
    // Not a URL — best-effort strip of any `user:pass@` prefix within an
    // `scheme://` authority, otherwise return as-is.
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
  }
}

// Race a dependency operation against a bounded deadline. On timeout, rejects
// with a DependencyUnreachableError naming the dependency/endpoint so the caller
// never hangs near the ~50s socket-drop boundary. The underlying operation is
// left to settle in the background (best-effort): we cannot cancel an in-flight
// ioredis command, but we guarantee the caller gets a prompt, definite outcome.
export async function withDependencyTimeout<T>(
  op: () => Promise<T>,
  detail: Omit<DependencyUnreachableDetail, 'reason'> & { timeoutMs: number }
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new DependencyUnreachableError({
          dependency: detail.dependency,
          endpoint: detail.endpoint,
          stackName: detail.stackName,
          operation: detail.operation,
          reason: 'timeout',
          timeoutMs: detail.timeoutMs
        })
      );
    }, detail.timeoutMs);
    // Don't keep the event loop alive on account of this guard timer.
    if (typeof timer.unref === 'function') timer.unref();
  });

  try {
    return await Promise.race([op(), timeout]);
  } catch (err) {
    // A hard connect/refused error from the client itself: normalise to the same
    // structured error so the route mapping stays single-path. Preserve the
    // cause for the server-side log.
    if (err instanceof DependencyUnreachableError) throw err;
    throw new DependencyUnreachableError(
      {
        dependency: detail.dependency,
        endpoint: detail.endpoint,
        stackName: detail.stackName,
        operation: detail.operation,
        reason: 'connect_error',
        timeoutMs: detail.timeoutMs
      },
      err
    );
  } finally {
    if (timer) clearTimeout(timer);
  }
}
