// encore-scaler control loop -> operational log store bridge (issue #998,
// parent #985).
//
// The scaler control loop (ADR-006) reported every spawn/dispatch/reap/tick
// failure with `console.error` inside the container and nothing else: no API, no
// UI, no durable record. It was picked as the second log producer precisely
// because it is the one place in the system with no visibility at all today.
//
// This module is the producer-side glue, deliberately shaped like the
// pipeline-step producer (src/services/pipeline-log.ts, issue #995) so the two
// read the same at every call site:
//
//   1. A NARROW structural sink (`ScalerLogSink`) so the loop depends only on
//      `append()` — the one write method the store exposes — never on the whole
//      store (which also owns the read/pagination path).
//   2. A never-throwing wrapper (`logScalerEvent`) so an instrumentation bug can
//      never fail (or slow) the control-loop step it is reporting on. The loop's
//      existing `console.error` is KEPT at every call site: container logs stay
//      exactly as they were, and this is purely additive.
//
// DISTINGUISHABILITY (acceptance criterion 2). Every record this producer writes
// carries:
//   - `category: 'encore-scaler'` (SCALER_LOG_CATEGORY) — the pipeline producer
//     uses its stage name as the category ('ingest' | 'transcode' | 'package',
//     src/services/pipeline-log.ts PIPELINE_LOG_STAGES), so the two producers'
//     categories can never collide; and
//   - a message PREFIX of `encore-scaler/<phase>: `. The prefix is what actually
//     matters for filtering: the listing querystring has no `category` or `level`
//     parameter and the server-side `q` filter is a case-insensitive substring
//     match on `message` ONLY (`applyLogQuery`, src/services/log-store.ts), so
//     `q=encore-scaler` selects every scaler entry, `q=encore-scaler/spawn`
//     selects one phase, and neither can match a pipeline-step entry (whose
//     messages are prefixed `ingest: ` / `transcode: ` / `package: `).
// The emitting workspace is appended as ` [workspace=<id>]`, so one deployment's
// multi-stack scaler loops stay separable in the same tail.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Write primitive + input shape: `LogStore.append(input: AppendLogInput)` /
//     `CouchLogStore.append(input): Promise<LogRecord>` with
//     `AppendLogInput = { message; level?; category?; timestamp? }` —
//     src/services/log-store.ts (`AppendLogInput`, `LogSink`, `LogStore.append`)
//     and src/data/couch-log-repo.ts (`CouchLogStore.append`). `seq`/`id`/
//     `timestamp` are assigned by the store, so this module supplies none of them.
//   - Level vocabulary: `LOG_LEVELS = ['debug','info','warn','error']` —
//     src/services/log-store.ts, re-exported onto the response contract as
//     `z.enum(LOG_LEVELS)` (src/routes/logs.ts).
//   - Filter semantics the prefix above relies on: `applyLogQuery`'s
//     `q`/from/to filter — `r.message.toLowerCase().includes(q)` with no
//     category or level predicate — src/services/log-store.ts (`applyLogQuery`).
//   - The sink main.ts actually passes: `logStore: LogSink & LogReader =
//     new PerWorkspaceLogStore(stackResolver)` (src/main.ts), the same instance
//     GET /api/v1/logs reads and the pipeline producer writes to.

import type { AppendLogInput, LogLevel } from '../services/log-store.js';

// The single write capability a control-loop call site needs. Structurally
// satisfied by the in-memory `LogStore` (`append(input): LogRecord`), by the
// durable `CouchLogStore` (`append(input): Promise<LogRecord>`, issue #996) and
// by the stack-delegating `PerWorkspaceLogStore` — hence the `unknown` return
// type, exactly as `PipelineLogSink` (src/services/pipeline-log.ts) declares it.
export interface ScalerLogSink {
  append(input: AppendLogInput): unknown;
}

// Category carried by EVERY record this producer writes, and the first segment
// of the message prefix. Distinct from every PIPELINE_LOG_STAGES value
// (src/services/pipeline-log.ts) so scaler entries and pipeline-step entries are
// never confusable in the Logs tab.
export const SCALER_LOG_CATEGORY = 'encore-scaler';

// The four control-loop phases the loop reports failures from (issue #998):
//   - spawn:    scale-up instance creation and pending-spawn resolution
//               (spawnInstance / resolvePendingSpawns, instance-pool.ts).
//   - dispatch: posting a claimed job to an instance, and the callback-trust
//               gate that decides whether an instance may be dispatched to.
//   - reap:     teardown-side work — the orphan sweep and the scale-down
//               interruption re-enqueue at the drain/teardown boundary.
//   - tick:     the tick as a whole, plus the per-tick repo-bridge hooks
//               (reconcileFailedTranscodes, onJobsDropped).
export const SCALER_LOG_PHASES = ['spawn', 'dispatch', 'reap', 'tick'] as const;
export type ScalerLogPhase = (typeof SCALER_LOG_PHASES)[number];

export type ScalerLogEvent = {
  phase: ScalerLogPhase;
  // Severity rendered as the level badge (public/logs-table.js). Explicit at
  // every call site, never defaulted, so a failure is never reported as `info`.
  level: LogLevel;
  // The workspace (stack identity) whose loop emitted this, appended to the
  // message so a multi-stack deployment's entries stay separable.
  workspaceId: string;
  // Human-readable sentence WITHOUT the prefix — `logScalerEvent` prepends
  // `encore-scaler/<phase>: ` so `q` can select the producer or one phase.
  message: string;
  // The caught error, if any. Rendered into the message because a log record has
  // no structured error field (`LogRecord`, src/services/log-store.ts) — and
  // without the cause in the message, the entry would say less than the
  // `console.error` it accompanies.
  err?: unknown;
};

// Longest error description spliced into a message. A log record is a single
// message string in a durable store with a bounded retained window
// (LOG_STORE_MAX_RECORDS), so an error carrying a multi-kilobyte body (an OSC
// HTML error page, a stringified response) must not be copied in whole.
export const SCALER_LOG_MAX_ERROR_CHARS = 400;

// Render a caught error as one short line. Prefers `message` (the useful part of
// an Error) and falls back to a bounded `String(err)`; never throws, even for a
// value whose own `toString` throws.
export function describeScalerError(err: unknown): string {
  let text: string;
  try {
    if (err instanceof Error && err.message) text = err.message;
    else if (typeof err === 'string') text = err;
    else if (err === undefined || err === null) text = String(err);
    else if (typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
      text = (err as { message: string }).message;
    } else text = JSON.stringify(err) ?? String(err);
  } catch {
    return 'unrenderable error';
  }
  const flattened = text.replace(/\s+/g, ' ').trim();
  if (flattened === '') return 'unrenderable error';
  return flattened.length > SCALER_LOG_MAX_ERROR_CHARS
    ? `${flattened.slice(0, SCALER_LOG_MAX_ERROR_CHARS)}…`
    : flattened;
}

// Build the exact `message` a scaler log record carries. Exported so tests (and
// any future reader) assert the prefix contract in one place rather than
// re-deriving it.
export function scalerLogMessage(event: ScalerLogEvent): string {
  const cause = event.err === undefined ? '' : `: ${describeScalerError(event.err)}`;
  return (
    `${SCALER_LOG_CATEGORY}/${event.phase}: ${event.message}${cause} ` +
    `[workspace=${event.workspaceId}]`
  );
}

// Append exactly ONE operational log record for a control-loop failure.
//
// Never throws, never returns a rejected promise, and never makes the caller
// wait: the control loop stays exactly as failable as it was before
// instrumentation (the same guarantee `logPipelineEvent` gives the pipeline
// steps, src/services/pipeline-log.ts, and `emitAudit` gives audit writes,
// src/data/audit-emit.ts). A no-op when `sink` is undefined, which is the
// default for every test and embedder that has not wired a store.
//
// The sink's `append()` may be synchronous (in-memory LogStore) or asynchronous
// (CouchLogStore / PerWorkspaceLogStore). Both are handled: a synchronous throw
// is caught, and a returned promise is detached with its own `.catch` — without
// that catch a CouchDB write failure would surface as an unhandled rejection.
// A failed append is reported on the loop's own channel (`console.error`, the
// convention throughout src/encore-scaler/) and nowhere else: trying to log the
// log failure to the log store is how an append loop starts.
export function logScalerEvent(
  sink: ScalerLogSink | undefined,
  event: ScalerLogEvent
): void {
  if (!sink) return;
  const report = (err: unknown): void => {
    console.error(
      '[encore-scaler] log-store append failed (non-fatal; phase=%s workspace=%s):',
      event.phase,
      event.workspaceId,
      err
    );
  };
  try {
    const result = sink.append({
      message: scalerLogMessage(event),
      level: event.level,
      category: SCALER_LOG_CATEGORY
    });
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(report);
    }
  } catch (err: unknown) {
    report(err);
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
