// Pipeline-step -> operational log store bridge (issue #995, parent #985).
//
// `LogStore.append()` (src/services/log-store.ts:112) had no callers: the read
// path (GET /api/v1/logs, src/routes/logs.ts:94) and the UI table
// (public/logs-table.js) were complete over a store nothing ever wrote to, so the
// Logs tab could only ever render an empty page. This module is the producer-side
// glue that fixes that for the ingest -> transcode -> package flow.
//
// It owns exactly two concerns, deliberately mirroring the audit instrumentation
// helper (src/data/audit-emit.ts) so the two producers read the same at every
// call site they share:
//
//   1. A NARROW structural interface (`PipelineLogSink`) so pipeline call sites
//      depend only on `append()` — the one write method the store exposes — and
//      not on the whole LogStore (which also owns the read/pagination path).
//      `LogStore` satisfies it structurally, and tests can pass a tiny spy.
//   2. A never-throwing wrapper (`logPipelineEvent`) so an instrumentation bug
//      can never fail the pipeline step it is reporting on — the same guarantee
//      `emitAudit` gives for audit writes (src/data/audit-emit.ts:50-58).
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Write primitive + its input shape: `LogStore.append(input: AppendLogInput)`
//     and `AppendLogInput = { message; level?; category?; timestamp? }` —
//     src/services/log-store.ts:112-122 and :43-48. `seq`/`timestamp` are
//     assigned by the store, so callers supply neither.
//   - Level vocabulary: `LOG_LEVELS = ['debug','info','warn','error']` —
//     src/services/log-store.ts:25, re-exported onto the response contract as
//     `z.enum(LOG_LEVELS)` at src/routes/logs.ts:40.
//   - Read contract this producer must NOT change: `logStore.list({ limit,
//     cursor, from, to, q, order })` — src/routes/logs.ts:94, backed by
//     `ListLogsOptions` src/services/log-store.ts:50-66. This module only calls
//     `append()`; the query/pagination surface is untouched.
//   - Renderer requirements the emitted records must satisfy: the level badge
//     reads `r.level` against the same enum (public/logs-table.js:241-248), the
//     category column reads `r.category` (public/logs-table.js:250-253), and the
//     `q` filter searches `message` ONLY, server-side
//     (public/logs-table.js:145-147 -> src/services/log-store.ts:143). Every
//     event below therefore carries an explicit `level` and a `message` that
//     names its stage, so the stage is searchable via `q` even though the
//     listing endpoint has no `category` param (known gap, already logged at
//     docs/osc-feedback/incoming-logs-level-category-filter.md).

import type { AppendLogInput, LogLevel } from './log-store.js';

// The single write capability a pipeline call site needs. Structurally satisfied
// by `LogStore` (its `append(input: AppendLogInput): LogRecord`), narrowed to the
// write path so instrumentation cannot reach the listing primitives. Optional at
// every call site: when no sink is wired (e.g. a unit test that does not assert
// logging) emission is a no-op.
export interface PipelineLogSink {
  append(input: AppendLogInput): unknown;
}

// A logger sink for failed log appends. Matches the subset of the Fastify / pino
// logger surface used here, so `request.log` / `app.log` can be passed directly
// without an adapter (same shape as `AuditErrorLog`, src/data/audit-emit.ts:35).
export interface PipelineLogErrorLog {
  error(obj: unknown, msg?: string): void;
}

// The three pipeline stages this producer reports on (issue #995). These are
// coarse STAGE labels for the operator-facing log, not step names: `ingest`
// covers the source-acquisition and synchronous ingest steps (URL pull,
// extract-metadata, thumbnail, and the optional subtitles / scene-detect steps),
// while `transcode` and `package` map to the two asynchronous steps that settle
// from an OSC callback. Used verbatim as the record's `category`.
export const PIPELINE_LOG_STAGES = ['ingest', 'transcode', 'package'] as const;
export type PipelineLogStage = (typeof PIPELINE_LOG_STAGES)[number];

export type PipelineLogEvent = {
  stage: PipelineLogStage;
  // Severity rendered as the level badge. Explicit at every call site (never
  // defaulted) so a failure is never reported as `info`.
  level: LogLevel;
  // Human-readable sentence, WITHOUT the stage prefix — `logPipelineEvent`
  // prepends the stage so `q` can find every entry for a stage.
  message: string;
};

// Append exactly ONE operational log record for a pipeline step event. Never
// throws and never returns a rejected promise: `append()` is synchronous
// (src/services/log-store.ts:112) so any failure is caught here and reported via
// `log`, leaving the primary pipeline operation exactly as failable as it was
// before instrumentation. A no-op when `sink` is undefined.
export function logPipelineEvent(
  sink: PipelineLogSink | undefined,
  event: PipelineLogEvent,
  log?: PipelineLogErrorLog
): void {
  if (!sink) {
    return;
  }
  try {
    sink.append({
      // Stage-prefixed so the server-side `q` substring filter (which searches
      // `message` only) can select a whole stage, e.g. `q=transcode:`.
      message: `${event.stage}: ${event.message}`,
      level: event.level,
      category: event.stage
    });
  } catch (err: unknown) {
    log?.error(
      { err, stage: event.stage, level: event.level },
      'pipeline log append failed (non-fatal)'
    );
  }
}
