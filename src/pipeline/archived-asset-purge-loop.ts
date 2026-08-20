// Independent background loop that drives the archived-asset retention purge
// sweep (issue #327, part of #323).
//
// This is a SEPARATE interval from the Encore auto-scaler loop — it is NOT
// folded into the scaler tick, because the two own different concerns (scaling
// Encore vs reclaiming archived storage) and run at different cadences. The loop
// mirrors EncoreScalerLoop.start() exactly (src/encore-scaler/scaler-loop.ts:
// 41-59): an overlap-guarded setInterval whose timer is unref'd so it never
// keeps the event loop alive on its own, and whose per-tick errors are caught so
// one bad tick never kills the interval.
//
// It is wired in main.ts alongside startEncoreCallbackPoller and is SKIPPED
// ENTIRELY when retention is unset — the loop reads the current retention window
// each tick via `retentionMs()` (which reflects the hot-reloadable instance
// global updated by PATCH /api/v1/retention/config) and no-ops the sweep when it
// is 0/disabled.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Overlap guard + unref'd interval + tick-error swallow:
//     src/encore-scaler/scaler-loop.ts:35-66
//   - Sweep entrypoint + result shape: src/pipeline/archived-asset-purge-sweep.ts

import {
  purgeExpiredArchivedAssets,
  type PurgeExpiredArchivedAssetsDeps
} from './archived-asset-purge-sweep.js';

// Default cadence. Purging is a low-urgency reclamation task (the retention
// window is typically hours/days), so a generous default keeps list/storage load
// low. Overridable via ARCHIVE_PURGE_INTERVAL_MS.
export const DEFAULT_PURGE_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function archivePurgeIntervalMsFromEnv(): number {
  const raw = process.env['ARCHIVE_PURGE_INTERVAL_MS'];
  if (!raw) {
    return DEFAULT_PURGE_INTERVAL_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_PURGE_INTERVAL_MS;
  }
  return parsed;
}

type Logger = {
  info?(...a: unknown[]): void;
  warn?(...a: unknown[]): void;
  error?(...a: unknown[]): void;
};

export type ArchivedAssetPurgeLoopOptions = {
  // Everything the sweep needs EXCEPT the retention window, which is read live
  // each tick from `retentionMs()` so the hot-reloadable config is honoured.
  sweepDeps: Omit<PurgeExpiredArchivedAssetsDeps, 'retentionMs'>;
  // The current retention window (ms). Read every tick so a PATCH to
  // /api/v1/retention/config takes effect without a restart, and so the sweep is
  // skipped entirely when retention is unset (0/disabled).
  retentionMs(): number;
  logger?: Logger;
};

// The archived-asset purge loop. Mirrors EncoreScalerLoop: start() installs an
// unref'd, overlap-guarded interval; stop() clears it.
export class ArchivedAssetPurgeLoop {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: ArchivedAssetPurgeLoopOptions) {}

  start(intervalMs = DEFAULT_PURGE_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Overlap guard: skip a tick if the previous one is still running (a large
      // archived set can make a sweep run long).
      if (this.running) return;
      this.running = true;
      void this.tick()
        .catch((err) => {
          // A tick failure must never kill the interval; the next tick retries.
          this.options.logger?.error?.('[archived-asset-purge] tick error:', err);
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
  // is unset (0/disabled), in which case the sweep is skipped entirely.
  async tick(): Promise<void> {
    const retentionMs = this.options.retentionMs();
    if (!Number.isFinite(retentionMs) || retentionMs <= 0) {
      return; // retention unset — never purge (skip the sweep entirely)
    }
    const result = await purgeExpiredArchivedAssets({
      ...this.options.sweepDeps,
      retentionMs
    });
    if (result.purged > 0) {
      this.options.logger?.info?.(
        '[archived-asset-purge] tick complete: scanned=%d purged=%d',
        result.scanned,
        result.purged
      );
    }
  }
}
