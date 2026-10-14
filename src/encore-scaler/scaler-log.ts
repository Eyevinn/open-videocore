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
// THREE PROPERTIES THIS MODULE OWES THE STORE (#998 review). A scaler entry is
// durable and API-served, so getting it there is not enough:
//   - REDACTED. The cause text goes through the SAME scrubber as the
//     spawn-failure record (`redactSpawnFailureMessage`, spawn-failure.ts) —
//     see describeScalerError. OSC error text can echo the createInstance body,
//     which carries the workspace's object-storage credentials.
//   - ADDRESSED TO A STACK. The emitting workspace rides along as
//     `ScalerLogContext`, because the sink main.ts wires picks its target stack
//     from the ambient request context and the loop has none (it is a
//     `setInterval`) — see ScalerLogContext.
//   - THROTTLED. One entry per (workspace, phase) per window, repeats counted
//     into the next one — see ScalerLogThrottle. The retained window is bounded
//     and oldest-first, so unthrottled appends would evict the history the Logs
//     tab exists for.
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
import { redactSpawnFailureMessage } from './spawn-failure.js';

// The single write capability a control-loop call site needs. Structurally
// satisfied by the in-memory `LogStore` (`append(input): LogRecord`), by the
// durable `CouchLogStore` (`append(input): Promise<LogRecord>`, issue #996) and
// by the stack-delegating `PerWorkspaceLogStore` — hence the `unknown` return
// type, exactly as `PipelineLogSink` (src/services/pipeline-log.ts) declares it.
export interface ScalerLogSink {
  append(input: AppendLogInput, context?: ScalerLogContext): unknown;
}

// Who the append is FOR, handed to the sink alongside the record.
//
// #998 review finding 2 (CRITICAL): the sink main.ts wires is a
// `PerWorkspaceLogStore`, which picks the stack to write to from the AMBIENT
// request stack (`currentRequestStackName()`, src/data/per-workspace-repos.ts
// PerWorkspaceLogStore.store). The scaler runs on `setInterval`, outside any
// request, where that resolves `undefined` (src/services/request-stack-context.ts
// currentRequestStackName) — so every workspace's failures landed on the DEFAULT
// stack and were invisible to GET /api/v1/logs for every other workspace.
//
// The loop knows which workspace it is; the sink's stack resolution does not. So
// the workspace travels WITH the append and main.ts enters that stack before
// delegating, the same correction #1058 made for the sibling repo-bridge hooks
// (`inEncoreJobStack`, src/main.ts). Optional, and an embedder whose sink is
// stack-agnostic (the in-memory `LogStore`, every test fake) simply ignores the
// second argument — a one-parameter `append` stays assignable to this interface.
export type ScalerLogContext = {
  // The scaler loop's stack identity (`EncoreScalerConfig.workspaceId`), which
  // is the same stack key `inEncoreJobStack` decodes out of an encore job id.
  workspaceId: string;
};

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
  // `console.error` it accompanies. ALWAYS redacted before it is persisted (see
  // describeScalerError below).
  err?: unknown;
  // Literal values the caller KNOWS were in play and that an OSC error could
  // echo back (the workspace's object-storage credentials, the Valkey URL).
  // Removed from `err`'s text before any pattern pass runs, exactly as
  // spawnInstance's failure path passes `spawnFailureSecrets(config, …)`
  // (src/encore-scaler/instance-pool.ts).
  secrets?: Iterable<string | undefined>;
  // How many further failures of this phase were collapsed into this entry by
  // the throttle (ScalerLogThrottle below). 0/undefined => this entry stands for
  // itself; N > 0 => it also stands for N appends that were deliberately not
  // written. Rendered into the message so the count is not lost.
  suppressed?: number;
};

// Longest error description spliced into a message. A log record is a single
// message string in a durable store with a bounded retained window
// (LOG_STORE_MAX_RECORDS), so an error carrying a multi-kilobyte body (an OSC
// HTML error page, a stringified response) must not be copied in whole.
//
// Enforced by `redactSpawnFailureMessage`, whose own output budget
// (SPAWN_FAILURE_MESSAGE_MAX_LENGTH, src/encore-scaler/spawn-failure.ts) is this
// same 400 characters and which cuts at a token boundary. Declared here as the
// documented bound of a scaler log entry's cause text; the two must stay equal.
export const SCALER_LOG_MAX_ERROR_CHARS = 400;

// What `redactSpawnFailureMessage` returns when redaction left no readable text
// at all (its own NO_MESSAGE constant, which it does not export). Derived by
// calling it with an empty input rather than duplicating the literal, so this
// can never drift from the module that owns it.
const REDACTION_EMPTY_RESULT = redactSpawnFailureMessage('');

// What a scaler entry says when the thrown value carried nothing renderable.
const UNRENDERABLE = 'unrenderable error';

// Render a caught error as one short, REDACTED line.
//
// #998 review finding 1 (CRITICAL): this text is spliced into a durable log
// record that GET /api/v1/logs serves, so it is exactly as public as the
// spawn-failure record on GET /scaler/status — and it is frequently the SAME
// error. OSC's create-instance failures echo the request body back (that body
// carries `s3AccessKeyId`/`s3SecretAccessKey`, src/encore-scaler/
// instance-pool.ts), which is why the spawn path scrubs before it persists
// (`redactSpawnFailureMessage`, src/encore-scaler/spawn-failure.ts, applied at
// instance-pool.ts spawnInstance). Persisting the raw `err.message` here would
// have re-leaked, through a second endpoint, precisely what that redaction
// exists to stop. So the SAME scrubber runs on the SAME error, with the same
// known-literal secrets — one redaction policy for both surfaces, not two.
//
// The shape-handling below is kept (an Error's `message`, a bare string, a
// `{ message }` object, a JSON-able value) because the scrubber only reads
// Error/string/`String(err)`: flattening the value FIRST means an error whose
// detail lives in a non-standard field is still reported, and still scrubbed.
// Never throws, even for a value whose own `toString` throws.
export function describeScalerError(
  err: unknown,
  secrets: Iterable<string | undefined> = []
): string {
  let text: string;
  try {
    if (err instanceof Error && err.message) text = err.message;
    else if (typeof err === 'string') text = err;
    else if (err === undefined || err === null) text = String(err);
    else if (typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
      text = (err as { message: string }).message;
    } else text = JSON.stringify(err) ?? String(err);
  } catch {
    return UNRENDERABLE;
  }
  if (text.replace(/\s+/g, ' ').trim() === '') return UNRENDERABLE;

  // Redaction owns the flattening, the secret/URL/credential passes and the
  // length cap (SPAWN_FAILURE_MESSAGE_MAX_LENGTH, which is the same 400 chars as
  // SCALER_LOG_MAX_ERROR_CHARS) — including the bounded-scan protection against
  // a multi-kilobyte OSC HTML error page. Never redo any of it here: a second
  // cap applied afterwards could only cut an already-safe string.
  let redacted: string;
  try {
    redacted = redactSpawnFailureMessage(text, secrets);
  } catch {
    // A scrubber that threw must never publish the unscrubbed text.
    return UNRENDERABLE;
  }
  if (redacted === '' || redacted === REDACTION_EMPTY_RESULT) return UNRENDERABLE;
  return redacted;
}

// Build the exact `message` a scaler log record carries. Exported so tests (and
// any future reader) assert the prefix contract in one place rather than
// re-deriving it.
export function scalerLogMessage(event: ScalerLogEvent): string {
  const cause =
    event.err === undefined ? '' : `: ${describeScalerError(event.err, event.secrets ?? [])}`;
  // The collapsed-repeat count, when this entry stands for more than itself.
  // Phrased like the spawn-failure record's `consecutiveFailures` so the two
  // read the same: "this is not a one-off, it has happened N+1 times running".
  const suppressed =
    event.suppressed && event.suppressed > 0
      ? ` (+${event.suppressed} further ${event.phase} failures in this window, not logged separately)`
      : '';
  return (
    `${SCALER_LOG_CATEGORY}/${event.phase}: ${event.message}${cause}${suppressed} ` +
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
    const result = sink.append(
      {
        message: scalerLogMessage(event),
        level: event.level,
        category: SCALER_LOG_CATEGORY
      },
      // #998 review finding 2: the emitting workspace, so a stack-delegating
      // sink writes to THAT workspace's log store instead of whichever stack the
      // (absent) ambient request context resolves to.
      { workspaceId: event.workspaceId }
    );
    if (isPromiseLike(result)) {
      void Promise.resolve(result).catch(report);
    }
  } catch (err: unknown) {
    report(err);
  }
}

// How long one emitted entry speaks for its (workspace, phase). Within the
// window, further failures of the SAME phase are counted, not appended.
//
// #998 review finding 3 (MAJOR): the log store retains a bounded, oldest-first
// window of LOG_STORE_MAX_RECORDS records (src/services/log-store.ts), and the
// control loop ticks every 10s by default. Unthrottled, ONE workspace stuck in a
// failing state writes ~8,600 records a day and evicts the pipeline history the
// Logs tab exists for — the instrumentation would destroy the visibility it was
// added to provide. 5 minutes caps a permanently broken (workspace, phase) at 12
// entries an hour — 288 a day, ~3% of the unthrottled rate — which still shows
// the failure on the very first tick, keeps it continuously present in the tail,
// and leaves the retained window overwhelmingly to everything else.
export const SCALER_LOG_THROTTLE_WINDOW_MS = 5 * 60_000;

// How long an idle throttle entry is kept before it is dropped. A phase that has
// stopped failing needs no bookkeeping, and the map must not grow with every
// workspace/phase a long-lived process ever saw. Two windows, so the entry
// outlives the window it governs (a repeat right at the boundary is still
// recognised as a repeat) and no longer.
export const SCALER_LOG_THROTTLE_TTL_MS = 2 * SCALER_LOG_THROTTLE_WINDOW_MS;

type ThrottleEntry = {
  // When the entry that currently speaks for this key was appended.
  emittedAt: number;
  // Failures seen since then that were NOT appended.
  suppressed: number;
};

// Rate-limit scaler log appends per (workspace, phase).
//
// Shape follows the project's existing precedent for "a failure that repeats
// must be visible once, with a count, not N times": the spawn-failure record
// (src/encore-scaler/spawn-failure.ts) keeps a SINGLE TTL'd record per workspace
// carrying `consecutiveFailures` forward instead of one record per failed spawn.
// Here the single TTL'd record is per (workspace, phase) and the counter is
// `suppressed`, reported in the next entry that is allowed through.
//
// Deliberately in-process, not in Valkey: the thing being rate-limited is this
// process's own appends from its own `setInterval`, there is exactly one loop
// object per workspace (src/encore-scaler/workspace-registry.ts), and a throttle
// that needed a network round trip could itself fail on the error path it is
// supposed to be reporting. Same reasoning — and same Map-keyed-by-identity
// shape — as the loop's existing `missingIdleStampWarnedAt` per-tick warning
// throttle (#778 review finding 6, src/encore-scaler/scaler-loop.ts).
//
// Keyed by PHASE, not by message text: an error whose message varies per
// occurrence (an instance id, a timestamp, an OSC request id) would otherwise
// defeat the throttle completely, which is the whole failure mode being fixed.
export class ScalerLogThrottle {
  private readonly entries = new Map<string, ThrottleEntry>();

  constructor(
    private readonly windowMs: number = SCALER_LOG_THROTTLE_WINDOW_MS,
    private readonly ttlMs: number = SCALER_LOG_THROTTLE_TTL_MS
  ) {}

  // Decide whether this failure is appended.
  //
  // Returns the number of collapsed repeats to report alongside it when it may
  // be appended (0 for the first failure in a window), or `undefined` when it
  // must be suppressed. The FIRST failure after a quiet period always passes, so
  // throttling never delays the first sight of a new problem.
  //
  // A count whose phase then RECOVERS is never published (there is no later
  // entry to carry it, and the record expires with the TTL). That is deliberate:
  // an entry saying "and 14 more" published after the trouble has passed is
  // noise, the container log still holds every occurrence, and the point of the
  // count is to qualify a failure that is still happening.
  admit(workspaceId: string, phase: ScalerLogPhase, now: number = Date.now()): number | undefined {
    this.prune(now);
    const key = `${workspaceId}\u0000${phase}`;
    const entry = this.entries.get(key);
    if (entry && now - entry.emittedAt < this.windowMs) {
      entry.suppressed += 1;
      return undefined;
    }
    const suppressed = entry?.suppressed ?? 0;
    this.entries.set(key, { emittedAt: now, suppressed: 0 });
    return suppressed;
  }

  // Drop entries nothing has touched for a TTL. Bounded by the number of live
  // (workspace, phase) pairs, and run on the error path only.
  private prune(now: number): void {
    for (const [key, entry] of this.entries) {
      if (now - entry.emittedAt > this.ttlMs) this.entries.delete(key);
    }
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}
