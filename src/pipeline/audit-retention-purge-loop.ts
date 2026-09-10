// Independent background loop that drives the audit-log retention purge sweep
// (issue #566), aligned with the archived-asset purge lifecycle (#327/#323).
//
// This MIRRORS ArchivedAssetPurgeLoop exactly
// (src/pipeline/archived-asset-purge-loop.ts): an overlap-guarded setInterval
// whose timer is unref'd so it never keeps the event loop alive on its own, and
// whose per-tick errors are caught so one bad tick never kills the interval. It
// is a SEPARATE interval from the archived-asset purge loop (they own different
// stores and can run at different cadences) but is deliberately NOT a parallel
// mechanism — it reuses the same start/stop/tick shape and the same
// live-`retentionMs()` + skip-when-unset semantics.
//
// The loop reads the current audit-retention window each tick via
// `retentionMs()` (which reflects the hot-reloadable instance global updated by
// PATCH /api/v1/retention/config for the audit window) and no-ops the sweep
// when it is 0/disabled (indefinite retention).
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Overlap guard + unref'd interval + tick-error swallow + env cadence:
//     ArchivedAssetPurgeLoop / archivePurgeIntervalMsFromEnv,
//     src/pipeline/archived-asset-purge-loop.ts:31-116.
//   - Sweep entrypoint + result shape: purgeExpiredAuditEntries,
//     src/pipeline/audit-retention-purge-sweep.ts.

import {
  purgeExpiredAuditEntries,
  type PurgeExpiredAuditEntriesDeps
} from './audit-retention-purge-sweep.js';

// Default cadence. Retention purging is a low-urgency reclamation task, so a
// generous default keeps store load low. Mirrors DEFAULT_PURGE_INTERVAL_MS in
// the archived-asset loop; overridable via AUDIT_PURGE_INTERVAL_MS.
export const DEFAULT_AUDIT_PURGE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function auditPurgeIntervalMsFromEnv(): number {
  const raw = process.env['AUDIT_PURGE_INTERVAL_MS'];
  if (!raw) {
    return DEFAULT_AUDIT_PURGE_INTERVAL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_AUDIT_PURGE_INTERVAL_MS;
  }
  return parsed;
}

type Logger = {
  info?(...a: unknown[]): void;
  warn?(...a: unknown[]): void;
  error?(...a: unknown[]): void;
};

export type AuditRetentionPurgeLoopOptions = {
  // Everything the sweep needs EXCEPT the retention window, which is read live
  // each tick from `retentionMs()` so the hot-reloadable config is honoured.
  sweepDeps: Omit<PurgeExpiredAuditEntriesDeps, 'retentionMs'>;
  // The current audit-retention window (ms). Read every tick so a PATCH to
  // /api/v1/retention/config takes effect without a restart, and so the sweep
  // is skipped entirely when retention is unset (0/disabled = indefinite).
  retentionMs(): number;
  logger?: Logger;
};

// The audit-retention purge loop. Mirrors ArchivedAssetPurgeLoop: start()
// installs an unref'd, overlap-guarded interval; stop() clears it.
export class AuditRetentionPurgeLoop {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: AuditRetentionPurgeLoopOptions) {}

  start(intervalMs = DEFAULT_AUDIT_PURGE_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Overlap guard: skip a tick if the previous one is still running.
      if (this.running) return;
      this.running = true;
      void this.tick()
        .catch((err) => {
          // A tick failure must never kill the interval; the next tick retries.
          this.options.logger?.error?.('[audit-retention-purge] tick error:', err);
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
  // skipped entirely.
  async tick(): Promise<void> {
    const retentionMs = this.options.retentionMs();
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
      return; // retention unset — never purge (skip the sweep entirely)
    }
    const result = await purgeExpiredAuditEntries({
      ...this.options.sweepDeps,
      retentionMs
    });
    if (result.purged > 0) {
      this.options.logger?.info?.(
        '[audit-retention-purge] tick complete: scanned=%d purged=%d',
        result.scanned,
        result.purged
      );
    }
  }
}
