// Storage-quota reconciliation (issue #579, ADR-020 Decision 2).
//
// The app-maintained running counter (storage-quota.ts) is the fast path for
// cap enforcement on the ingest hot path. This module is the SLOW PATH ground
// truth: a batch listObjectsV2-sum sweep over the source + packaged buckets
// (off the write hot path) that re-computes the true committed total and
// overwrites the counter's `consumedBytes`, correcting any drift and
// re-establishing the total after a crash mid-write (ADR-020 Decision 2
// recovery path).
//
// It reuses WorkspaceStorage.sumObjectSizes() (the same listObjectsV2 listing
// mechanism the retention sweep uses), so no new object-store capability is
// required — exactly as ADR-020 Decision 2 specifies. `reservedBytes` is left
// untouched: in-flight reservations are still pending and are not part of the
// on-disk ground truth.

import type { StorageQuotaStore } from './storage-quota.js';

// The minimal storage surface the sweep needs: one per bucket (source +
// packaged). Structurally satisfied by WorkspaceStorage (src/data/storage.ts).
export type ReconcileStorage = {
  sumObjectSizes(): Promise<number>;
};

export type ReconcileDeps = {
  store: StorageQuotaStore;
  // The buckets whose bytes count toward the cap: the source bucket (ingested
  // originals) and the packaged bucket (renditions + packaged outputs). ADR-020
  // Decision 2 names exactly these two.
  buckets: ReconcileStorage[];
};

// Run one reconciliation sweep. Sums object sizes across all provided buckets
// and overwrites the committed total. Returns the true total it wrote.
export async function reconcileStorageQuota(deps: ReconcileDeps): Promise<number> {
  let total = 0;
  for (const bucket of deps.buckets) {
    total += await bucket.sumObjectSizes();
  }
  await deps.store.reconcile(total);
  return total;
}

export const DEFAULT_RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 hours

// Resolve the reconciliation cadence (12-factor: config via env). Unset /
// invalid / <= 0 falls back to the 6-hour default. Mirrors the env-read
// convention in src/data/storage.ts:27-37.
export function reconcileIntervalMsFromEnv(): number {
  const raw = process.env['STORAGE_QUOTA_RECONCILE_INTERVAL_MS'];
  if (!raw) return DEFAULT_RECONCILE_INTERVAL_MS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_RECONCILE_INTERVAL_MS;
  return parsed;
}

// A periodic reconciliation scheduler. Runs one sweep immediately (to
// re-establish the total on boot / after a crash) then on a fixed interval.
// Timers are injectable for deterministic tests. Never throws out of a tick: a
// sweep failure is reported via onError so the schedule keeps running.
export class StorageQuotaReconciler {
  private handle?: ReturnType<typeof setInterval>;
  private readonly intervalMs: number;
  private readonly setIntervalFn: (h: () => void, ms: number) => ReturnType<typeof setInterval>;
  private readonly clearIntervalFn: (h: ReturnType<typeof setInterval>) => void;
  private readonly onError?: (err: unknown) => void;

  constructor(
    private readonly deps: ReconcileDeps & {
      intervalMs?: number;
      setIntervalFn?: (h: () => void, ms: number) => ReturnType<typeof setInterval>;
      clearIntervalFn?: (h: ReturnType<typeof setInterval>) => void;
      onError?: (err: unknown) => void;
    }
  ) {
    this.intervalMs = deps.intervalMs ?? reconcileIntervalMsFromEnv();
    this.setIntervalFn = deps.setIntervalFn ?? ((h, ms) => setInterval(h, ms));
    this.clearIntervalFn = deps.clearIntervalFn ?? ((h) => clearInterval(h));
    this.onError = deps.onError;
  }

  async runOnce(): Promise<void> {
    try {
      await reconcileStorageQuota(this.deps);
    } catch (err) {
      this.onError?.(err);
    }
  }

  start(): void {
    if (this.handle) return;
    void this.runOnce();
    this.handle = this.setIntervalFn(() => void this.runOnce(), this.intervalMs);
  }

  stop(): void {
    if (this.handle) {
      this.clearIntervalFn(this.handle);
      this.handle = undefined;
    }
  }
}
