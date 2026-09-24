// Independent background loop that drives the abandoned-upload settle sweep
// (issue #726).
//
// This is a SEPARATE interval from the Encore auto-scaler loop and from the
// archived-asset / audit purge loops — it owns a distinct concern (settling
// assets wedged in `uploading`) and runs at its own cadence. The loop mirrors
// ArchivedAssetPurgeLoop.start() exactly (src/pipeline/archived-asset-purge-loop.ts:
// 70-88), which itself mirrors EncoreScalerLoop.start(): an overlap-guarded
// setInterval whose timer is unref'd so it never keeps the event loop alive on
// its own, and whose per-tick errors are caught so one bad tick never kills the
// interval.
//
// It is wired in main.ts alongside the other retention loops and reads the
// current settle threshold each tick via `thresholdMs()`, so the threshold can
// be resolved live and the sweep is SKIPPED ENTIRELY when the threshold is
// 0/disabled.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Overlap guard + unref'd interval + tick-error swallow + live-window read:
//     src/pipeline/archived-asset-purge-loop.ts:64-116
//   - Env parse convention (parseInt, fall back to default on unset/invalid):
//     src/pipeline/archived-asset-purge-loop.ts:33-43
//   - Sweep entrypoint + result shape: src/pipeline/abandoned-upload-sweep.ts

import {
  settleAbandonedUploads,
  type SettleAbandonedUploadsDeps
} from './abandoned-upload-sweep.js';

// Default cadence. Settling is a low-urgency housekeeping task (the threshold is
// hours), so a moderate default keeps list load low while still settling orphans
// promptly. Overridable via ABANDONED_UPLOAD_SWEEP_INTERVAL_MS.
export const DEFAULT_ABANDONED_UPLOAD_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

// Default liveness threshold: an asset in `uploading` untouched for longer than
// this is treated as abandoned. Deliberately generous so it comfortably exceeds
// the longest legitimate upload — a genuinely slow-but-progressing upload is
// never cut off. Overridable via ABANDONED_UPLOAD_THRESHOLD_MS; set to 0 to
// disable the sweep entirely.
export const DEFAULT_ABANDONED_UPLOAD_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours

export function abandonedUploadIntervalMsFromEnv(): number {
  return positiveIntFromEnv(
    'ABANDONED_UPLOAD_SWEEP_INTERVAL_MS',
    DEFAULT_ABANDONED_UPLOAD_INTERVAL_MS
  );
}

// Resolve the settle threshold (ms) from env. Unset -> the generous default.
// A parseable 0 or negative value DISABLES the sweep (never settle), letting an
// operator opt out without removing the wiring. Non-numeric falls back to the
// default so a typo never silently disables settling.
export function abandonedUploadThresholdMsFromEnv(): number {
  const raw = process.env['ABANDONED_UPLOAD_THRESHOLD_MS'];
  if (raw === undefined || raw === '') {
    return DEFAULT_ABANDONED_UPLOAD_THRESHOLD_MS;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) {
    return DEFAULT_ABANDONED_UPLOAD_THRESHOLD_MS;
  }
  // 0 / negative is an explicit, honoured "disabled" (the sweep no-ops).
  return parsed;
}

// Shared parse for a strictly-positive interval env var: unset / non-numeric /
// <= 0 all fall back to the default (an interval must be positive).
function positiveIntFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

type Logger = {
  info?(...a: unknown[]): void;
  warn?(...a: unknown[]): void;
  error?(...a: unknown[]): void;
};

export type AbandonedUploadSweepLoopOptions = {
  // Everything the sweep needs EXCEPT the threshold, which is read live each tick
  // from `thresholdMs()` so the effective policy is honoured (and the sweep is
  // skipped entirely when it is 0/disabled).
  sweepDeps: Omit<SettleAbandonedUploadsDeps, 'thresholdMs'>;
  // The current settle threshold (ms), read every tick. 0/disabled skips the
  // sweep entirely.
  thresholdMs(): number;
  logger?: Logger;
};

// The abandoned-upload settle loop. Mirrors ArchivedAssetPurgeLoop: start()
// installs an unref'd, overlap-guarded interval; stop() clears it.
export class AbandonedUploadSweepLoop {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: AbandonedUploadSweepLoopOptions) {}

  start(intervalMs = DEFAULT_ABANDONED_UPLOAD_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Overlap guard: skip a tick if the previous one is still running (a large
      // uploading set can make a sweep run long).
      if (this.running) return;
      this.running = true;
      void this.tick()
        .catch((err) => {
          // A tick failure must never kill the interval; the next tick retries.
          this.options.logger?.error?.('[abandoned-upload-sweep] tick error:', err);
        })
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    // Do not keep the event loop alive solely for the settle loop.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // One tick: read the live threshold and run the sweep unless the threshold is
  // unset (0/disabled), in which case the sweep is skipped entirely.
  async tick(): Promise<void> {
    const thresholdMs = this.options.thresholdMs();
    if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
      return; // threshold unset — never settle (skip the sweep entirely)
    }
    const result = await settleAbandonedUploads({
      ...this.options.sweepDeps,
      thresholdMs
    });
    if (result.settled > 0) {
      this.options.logger?.info?.(
        '[abandoned-upload-sweep] tick complete: scanned=%d settled=%d',
        result.scanned,
        result.settled
      );
    }
  }
}
