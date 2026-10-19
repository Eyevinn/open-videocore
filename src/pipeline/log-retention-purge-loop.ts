// Independent background loop that drives the operational-log retention purge
// sweep (issue #1067), parallel to the audit-retention purge loop (#566) and
// behind it the archived-asset purge lifecycle (#327/#323).
//
// This MIRRORS AuditRetentionPurgeLoop exactly
// (src/pipeline/audit-retention-purge-loop.ts): an overlap-guarded setInterval
// whose timer is unref'd so it never keeps the event loop alive on its own, and
// whose per-tick errors are caught so one bad tick never kills the interval. It
// is a SEPARATE interval from the audit and archived-asset loops (they own
// different stores and can run at different cadences) but is deliberately NOT a
// parallel mechanism — it reuses the same start/stop/tick shape and the same
// live-`retentionMs()` + skip-when-unset semantics.
//
// The loop reads the current log-retention window each tick via `retentionMs()`
// (which reflects the hot-reloadable instance global updated by PATCH
// /api/v1/retention/config for the log window) and no-ops the sweep when it is
// 0/disabled (indefinite retention).
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Overlap guard + unref'd interval + tick-error swallow + env cadence:
//     AuditRetentionPurgeLoop / auditPurgeIntervalMsFromEnv,
//     src/pipeline/audit-retention-purge-loop.ts.
//   - Sweep entrypoint + result shape: purgeExpiredLogRecords,
//     src/pipeline/log-retention-purge-sweep.ts.

import {
  purgeExpiredLogRecords,
  type PurgeExpiredLogRecordsDeps
} from './log-retention-purge-sweep.js';

// Default cadence. Retention purging is a low-urgency reclamation task, so a
// generous default keeps store load low. Same default as the audit loop's
// DEFAULT_AUDIT_PURGE_INTERVAL_MS; overridable via LOG_PURGE_INTERVAL_MS.
export const DEFAULT_LOG_PURGE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function logPurgeIntervalMsFromEnv(): number {
  const raw = process.env['LOG_PURGE_INTERVAL_MS'];
  if (!raw) {
    return DEFAULT_LOG_PURGE_INTERVAL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_LOG_PURGE_INTERVAL_MS;
  }
  return parsed;
}

type Logger = {
  info?(...a: unknown[]): void;
  warn?(...a: unknown[]): void;
  error?(...a: unknown[]): void;
};

export type LogRetentionPurgeLoopOptions = {
  // Everything the sweep needs EXCEPT the retention window, which is read live
  // each tick from `retentionMs()` so the hot-reloadable config is honoured.
  sweepDeps: Omit<PurgeExpiredLogRecordsDeps, 'retentionMs'>;
  // The current log-retention window (ms). Read every tick so a PATCH to
  // /api/v1/retention/config takes effect without a restart, and so the sweep
  // is skipped entirely when retention is unset (0/disabled = indefinite).
  retentionMs(): number;
  // Run one tick's sweep once per provisioned stack (issue #1098). Bound in
  // main.ts to perStackSweepRunner (src/services/for-each-stack.ts); unset, the
  // sweep runs exactly once, as before. Mirrors AuditRetentionPurgeLoop.
  forEachStack?(run: () => Promise<void>): Promise<void>;
  logger?: Logger;
};

// The log-retention purge loop. Mirrors AuditRetentionPurgeLoop: start()
// installs an unref'd, overlap-guarded interval; stop() clears it.
export class LogRetentionPurgeLoop {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: LogRetentionPurgeLoopOptions) {}

  start(intervalMs = DEFAULT_LOG_PURGE_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Overlap guard: skip a tick if the previous one is still running.
      if (this.running) return;
      this.running = true;
      void this.tick()
        .catch((err) => {
          // A tick failure must never kill the interval; the next tick retries.
          this.options.logger?.error?.('[log-retention-purge] tick error:', err);
        })
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    // Do not keep the event loop alive solely for the purge loop.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // One tick: read the live retention window and run the sweep unless retention
  // is unset (0/disabled = indefinite retention), in which case the sweep is
  // skipped entirely. The window is instance-global, so it is read ONCE per tick
  // and the same value applies to every stack swept below.
  async tick(): Promise<void> {
    const retentionMs = this.options.retentionMs();
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
      return; // retention unset — never purge (skip the sweep entirely)
    }
    const runSweep = async (): Promise<void> => {
      const result = await purgeExpiredLogRecords({
        ...this.options.sweepDeps,
        retentionMs
      });
      if (result.purged > 0) {
        this.options.logger?.info?.(
          '[log-retention-purge] tick complete: scanned=%d purged=%d',
          result.scanned,
          result.purged
        );
      }
    };
    // Once per provisioned stack when wired (issue #1098); otherwise exactly
    // once, unchanged.
    const perStack = this.options.forEachStack?.bind(this.options);
    if (perStack) await perStack(runSweep);
    else await runSweep();
  }
}
