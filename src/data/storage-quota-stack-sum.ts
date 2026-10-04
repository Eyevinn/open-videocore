// Per-stack ground-truth sum for the storage-quota reconciliation sweep
// (issue #1098, closing the known gap recorded in issue #1090).
//
// The reconciliation sweep (storage-quota-reconcile.ts, issue #579, ADR-020
// Decision 2) OVERWRITES the committed total with a listObjectsV2-derived sum.
// Its buckets were built ONCE at boot from `resolveCached()` with NO stack name,
// i.e. the FIRST listed stack only — so on a multi-stack installation every
// sweep erased the bytes held on stacks 2..N and the cap silently UNDER-counted.
//
// The counter it writes is ONE deployment-wide number: ADR-020 Decision 1 fixes
// the quota as a "per-deployment cost guardrail (single-tenant)" keyed by
// `DEPLOYMENT_CONTEXT`, and ADR-018 §3 states the same framing ("One deployed
// stack == one tenant's workspace"). So the per-stack rule from issue #1098
// applies to the ENUMERATION, not to the write: visit every provisioned stack,
// sum all of their buckets, and write that one total once. This module is that
// enumeration, exposed as a single `sumObjectSizes()` so the reconciler's
// existing `ReconcileStorage` contract is unchanged — and, because the walk
// happens inside the call, the stack list is re-read on EVERY sweep rather than
// frozen at boot.
//
// PARTIAL PASSES ARE NEVER WRITTEN. Every stack is visited even if an earlier
// one fails (per-stack isolation), but if ANY stack could not be summed the walk
// throws, so `reconcileStorageQuota` never reaches `store.reconcile(total)`
// with an incomplete sum. Writing a short total is strictly worse than leaving
// the previous one in place: it is exactly the silent under-count #1090
// describes, on a billing-adjacent number. The counter keeps its last good value
// and the next sweep retries.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - ReconcileStorage (`sumObjectSizes(): Promise<number>`) and
//     reconcileStorageQuota's sum-then-`store.reconcile(total)` order:
//     src/data/storage-quota-reconcile.ts:23-42
//   - StorageQuotaReconciler.runOnce() catches and routes to `onError`, so a
//     throw here skips the write and never kills the schedule:
//     src/data/storage-quota-reconcile.ts:81-88
//   - WorkspaceStorage.sumObjectSizes(): src/data/storage.ts
//   - forEachStack / StackSweepResolver: src/services/for-each-stack.ts
//   - ADR-020 Decision 1 (single deployment-wide counter):
//     docs/architecture/ADR-020-quota-deployment-model-and-metering-source.md

import { forEachStack, type StackSweepResolver } from '../services/for-each-stack.js';
import type { ReconcileStorage } from './storage-quota-reconcile.js';

type Logger = {
  info?(...a: unknown[]): void;
  warn?(...a: unknown[]): void;
};

export type PerStackQuotaSumDeps = {
  resolver: StackSweepResolver;
  // The buckets whose bytes count toward the cap for ONE stack — the source and
  // packaged buckets of that stack (ADR-020 Decision 2 names exactly those two).
  // Returns an empty list when the stack has no object storage configured, which
  // contributes nothing rather than failing the sweep.
  bucketsForStack(stackName: string | undefined): Promise<ReconcileStorage[]>;
  logger?: Logger;
};

// Why a sweep refused to overwrite the deployment-wide total. Carried on the
// error so main.ts can log an unreachable stack (`stack-failures`) differently
// from a deployment that simply has no object storage yet
// (`no-object-storage`) — the latter is the normal state of a fresh install
// before the first stack is provisioned, not a fault.
export type PerStackQuotaSumSkipReason = 'stack-failures' | 'no-object-storage';

export class PerStackQuotaSumIncomplete extends Error {
  readonly reason: PerStackQuotaSumSkipReason;
  constructor(reason: PerStackQuotaSumSkipReason, message: string) {
    super(message);
    this.name = 'PerStackQuotaSumIncomplete';
    this.reason = reason;
  }
}

// Build the single `ReconcileStorage` the reconciler sums: one call walks every
// provisioned stack and returns the deployment-wide byte total.
export function makePerStackQuotaSum(deps: PerStackQuotaSumDeps): ReconcileStorage {
  return {
    async sumObjectSizes(): Promise<number> {
      let total = 0;
      let bucketsVisited = 0;
      const failedStacks: string[] = [];

      // Each stack's buckets are summed inside that stack's request-stack
      // context, so a dependency resolving the ambient stack sees this stack.
      const pass = await forEachStack(
        { resolver: deps.resolver, label: 'storage-quota-reconcile', logger: deps.logger },
        async (stackName) => {
          try {
            const buckets = await deps.bucketsForStack(stackName);
            for (const bucket of buckets) {
              total += await bucket.sumObjectSizes();
              bucketsVisited += 1;
            }
          } catch (err) {
            // Isolated: record the gap and let the remaining stacks be summed.
            failedStacks.push(stackName ?? '(default)');
            deps.logger?.warn?.(
              { err, stackName },
              'storage-quota-reconcile: could not sum this stack; the deployment total will not be overwritten this sweep'
            );
          }
        }
      );

      const failed = failedStacks.length + pass.failed;
      if (failed > 0) {
        throw new PerStackQuotaSumIncomplete(
          'stack-failures',
          `storage-quota reconciliation skipped: ${failed} of ${pass.stacks} stack(s) could not be summed`
        );
      }
      if (bucketsVisited === 0) {
        throw new PerStackQuotaSumIncomplete(
          'no-object-storage',
          'storage-quota reconciliation skipped: no provisioned stack has object storage configured'
        );
      }
      return total;
    }
  };
}
