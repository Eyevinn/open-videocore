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
// THE WALK VERIFIES WHAT THE RESOLVER GAVE IT RATHER THAN TRUSTING EXCEPTIONS
// (#1141 review findings 1 and 2). `WorkspaceStackResolver.resolve(name)` is NOT
// "that stack's connections or a throw" — it has three silent non-throwing
// outcomes, each of which would corrupt a deployment-wide total:
//
//   (a) ENV OVERRIDE WINS OVER THE NAME. With COUCHDB_URL/MINIO_URL set,
//       `resolve()` returns env-built connections for EVERY name and never
//       consults the parameter store (workspace-stack.ts:395-397, :1000-1015),
//       while `listStackNames()` still lists the stacks recorded in the
//       parameter store (:1274-1288) — the two are not mutually exclusive, since
//       MINIO_URL is a documented ops-level override. A naive walk would resolve
//       the SAME buckets once per listed name and commit N x the real bytes.
//   (b) ALIASED RESOLUTION. An explicitly requested name with no stored config
//       is re-resolved to the FIRST listed stack instead of throwing
//       (:1054-1066) — so stack-b's slot would re-count stack-a's bytes and
//       stack-b's own bytes would be dropped.
//   (c) DEGRADED RESOLUTION. A thrown parameter-store refresh is caught INSIDE
//       the resolver and degrades to last-known-good or to no-storage in-memory
//       connections (:1083-1125, fallback label 'in-memory (no object
//       storage)'). Those connections have no `storageClient`, so the stack
//       contributes 0 bytes without raising anything.
//
// So: (a) and (b) are neutralised by summing each resolved OBJECT-STORE IDENTITY
// at most once (endpoint + the two bucket names — the only identity that decides
// which bytes get listed; two names resolving to one identity really are one set
// of buckets), (b) additionally fails the sweep when the resolved connections
// carry a different `stackName` than the one requested, and (c) fails the sweep
// when a LISTED stack yields no buckets while some other stack did. The
// "no stack anywhere has object storage" branch is unchanged: that is a fresh
// install, not a partial pass.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - ReconcileStorage (`sumObjectSizes(): Promise<number>`) and
//     reconcileStorageQuota's sum-then-`store.reconcile(total)` order:
//     src/data/storage-quota-reconcile.ts:21-42
//   - StorageQuotaReconciler.runOnce() catches and routes to `onError`, so a
//     throw here skips the write and never kills the schedule:
//     src/data/storage-quota-reconcile.ts:81-88
//   - WorkspaceConnections.stackName ("The stack identity these connections were
//     built from (issue #1058) ... Undefined on the env-override and in-memory
//     fallback paths"): src/services/workspace-stack.ts:190-198, set from
//     `resolvedName` at :381 (and :299 on the tagged credential)
//   - WorkspaceConnections.s3Config.endpoint / .sourceBucket / .packagedBucket,
//     per-stack values from StackConfig: src/services/workspace-stack.ts:362-375
//     (`endpoint: config.minioEndpoint` at :371); env-override values from
//     MINIO_URL: :537-539; default bucket names with `s3Config: undefined` on the
//     no-storage in-memory fallback: :585-587
//   - resolve() env-override-first ordering: src/services/workspace-stack.ts:994-1015;
//     not-found alias fallback: :1054-1066; caught-refresh degradation: :1083-1125
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
// before the first stack is provisioned, not a fault — and both differently from
// a stack that IS provisioned but resolved without object storage
// (`stack-without-object-storage`), which is the degraded/aliased resolver
// outcome (c)/(b) above and needs an operator to look at the parameter store.
export type PerStackQuotaSumSkipReason =
  | 'stack-failures'
  | 'no-object-storage'
  | 'stack-without-object-storage';

export class PerStackQuotaSumIncomplete extends Error {
  readonly reason: PerStackQuotaSumSkipReason;
  constructor(reason: PerStackQuotaSumSkipReason, message: string) {
    super(message);
    this.name = 'PerStackQuotaSumIncomplete';
    this.reason = reason;
  }
}

// The parts of `WorkspaceConnections` this walk needs in order to verify a
// resolution. Narrowed structurally from `StackSweepResolver.resolve`'s
// `Promise<unknown>` (src/services/for-each-stack.ts) so this module stays free
// of the resolver's client imports — and so every field is treated as
// POSSIBLY-ABSENT, which is the honest shape: the in-memory fallback has no
// `s3Config` at all and the env-override path has no `stackName`.
type ResolvedConnectionsLike = {
  stackName?: unknown;
  sourceBucket?: unknown;
  packagedBucket?: unknown;
  s3Config?: { endpoint?: unknown } | null;
};

function asResolvedConnections(value: unknown): ResolvedConnectionsLike {
  return typeof value === 'object' && value !== null ? (value as ResolvedConnectionsLike) : {};
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// WHICH BYTES this resolution would list: the object-store endpoint plus the two
// bucket names. Two stack names resolving to the same triple address the same
// objects, so they must contribute to the deployment total exactly once —
// `logObjectStoreClient`'s own note that "every stack's buckets carry the same
// literal names" (src/services/workspace-stack.ts:291-295) is why the endpoint
// has to be part of the key rather than the bucket names alone.
//
// `undefined` means the identity is NOT determined (no endpoint and/or no bucket
// names on the resolution, e.g. the no-storage in-memory fallback). An
// undetermined identity is never deduplicated — a stack that cannot be shown to
// be a duplicate is treated as distinct, so the only way this check can be wrong
// is by summing something twice that the `stackName` / empty-bucket checks below
// then fail the sweep on. It never silently drops a stack.
function objectStoreIdentity(conns: ResolvedConnectionsLike): string | undefined {
  const endpoint = nonEmptyString(conns.s3Config?.endpoint);
  const sourceBucket = nonEmptyString(conns.sourceBucket);
  const packagedBucket = nonEmptyString(conns.packagedBucket);
  if (!endpoint || !sourceBucket || !packagedBucket) return undefined;
  return `${endpoint}|${sourceBucket}|${packagedBucket}`;
}

// Build the single `ReconcileStorage` the reconciler sums: one call walks every
// provisioned stack and returns the deployment-wide byte total.
export function makePerStackQuotaSum(deps: PerStackQuotaSumDeps): ReconcileStorage {
  return {
    async sumObjectSizes(): Promise<number> {
      let total = 0;
      let bucketsVisited = 0;
      const failedStacks: string[] = [];
      // Object-store identities already summed in THIS sweep. Guards outcome (a)
      // (env override returning one set of connections for every listed name)
      // and the double-count half of outcome (b).
      const summedIdentities = new Set<string>();
      // Listed stacks that resolved to no buckets at all — outcome (c). Not a
      // hard failure on its own: on a deployment where NO stack has object
      // storage this is the normal fresh-install state, which keeps its own
      // `no-object-storage` reason. It only means "partial pass" once some other
      // stack did contribute bytes.
      const stacksWithoutBuckets: string[] = [];

      // Each stack's buckets are summed inside that stack's request-stack
      // context, so a dependency resolving the ambient stack sees this stack.
      const pass = await forEachStack(
        { resolver: deps.resolver, label: 'storage-quota-reconcile', logger: deps.logger },
        async (stackName) => {
          try {
            // Already warmed by forEachStack, so this is the resolver's cache
            // read rather than a second parameter-store round trip. We re-read
            // it here because the walk must inspect WHAT came back, not just
            // whether it threw.
            const conns = asResolvedConnections(await deps.resolver.resolve(stackName));

            // (b) ALIASED RESOLUTION. `WorkspaceConnections.stackName` is the
            // identity the connections were actually built from (#1058). If it
            // is present and names a different stack than the one we asked for,
            // the resolver silently substituted another stack: this stack's
            // bytes are NOT in this resolution, so the sweep must not write a
            // total that pretends otherwise.
            const resolvedStackName = nonEmptyString(conns.stackName);
            if (stackName !== undefined && resolvedStackName !== undefined && resolvedStackName !== stackName) {
              failedStacks.push(stackName);
              deps.logger?.warn?.(
                { stackName, resolvedStackName },
                'storage-quota-reconcile: resolver returned another stack for this name (no stored config?); the deployment total will not be overwritten this sweep'
              );
              return;
            }

            // (a) DUPLICATE OBJECT STORE. Sum each distinct set of buckets once.
            const identity = objectStoreIdentity(conns);
            if (identity !== undefined) {
              if (summedIdentities.has(identity)) {
                deps.logger?.info?.(
                  { stackName },
                  'storage-quota-reconcile: this stack resolves to object storage already summed this sweep (env-var override active?); counted once'
                );
                return;
              }
              summedIdentities.add(identity);
            }

            const buckets = await deps.bucketsForStack(stackName);
            // (c) DEGRADED RESOLUTION. A stack that is listed in the parameter
            // store but resolved without object storage contributes 0 bytes
            // without throwing. Record it; whether that is a fresh install or a
            // partial pass is decided after the walk.
            if (stackName !== undefined && buckets.length === 0) {
              stacksWithoutBuckets.push(stackName);
              return;
            }
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
      // Some stacks were summed and others resolved without object storage: the
      // total on hand is short by those stacks' bytes. Decline, exactly as for
      // an unreachable stack — the counter keeps its last good value.
      if (stacksWithoutBuckets.length > 0) {
        throw new PerStackQuotaSumIncomplete(
          'stack-without-object-storage',
          `storage-quota reconciliation skipped: ${stacksWithoutBuckets.length} of ${pass.stacks} provisioned stack(s) resolved without object storage ` +
            `(${stacksWithoutBuckets.join(', ')}), so the deployment total would be short by their bytes`
        );
      }
      return total;
    }
  };
}
