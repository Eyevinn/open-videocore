// Interrupted-ingest reconciliation on boot (issue #1084).
//
// An ingest-url Job's lifecycle is owned IN-PROCESS by runPull
// (src/pipeline/url-pull-worker.ts): the route starts it detached, the worker
// drives the job `pending -> running` and is the only thing that ever writes the
// terminal `done`/`failed`. There is no queue and no external completion
// callback behind it, so if the owning process dies mid-pull — a restart, a
// redeploy, an OOM kill — nothing is left that can ever settle the job. It stays
// `running` forever, with no error explaining why, and no existing sweep picks it
// up: reconcileFailedTranscodes (src/pipeline/failed-transcode-reconciler.ts)
// skips every job whose `type` is not 'transcode', and reconcileStalledPackages
// only walks pipeline executions' `package` steps.
//
// This reconciler closes that gap for the Job record. It runs ONCE at boot (not
// on a tick) because the signal it uses is only unambiguous at that moment: a
// `running` ingest-url job whose `updatedAt` is EARLIER than this process's start
// time cannot be owned by any live worker in this process, because the worker
// writes `updatedAt` on every status/attempt/progress update it makes. Anything
// stamped at or after process start may well be a pull that is streaming bytes
// right now, so it is left strictly alone — that boundary is what keeps a live
// pull from being mistaken for a dead one.
//
// SCOPE (issue #1084): the JOB RECORD — settled to `failed` with a reason naming
// the interruption, plus the matching terminal audit entry (below). The pull is
// deliberately NOT re-queued.
//
// SCOPE (issue #1085): and the JOB'S ASSET, which the #1084 version left behind.
// A pull's asset is created in `uploading` before any bytes arrive
// (src/data/asset-repo.ts initialHistory), so settling only the job left the
// asset claiming an upload was in progress while the only thing that could ever
// complete it was already dead. The abandoned-upload sweep would eventually
// reach it, but not for 24h (src/pipeline/abandoned-upload-loop.ts) — a full day
// of a state we can already prove is wrong at boot. So the asset is moved
// `uploading -> failed` here, in the same pass, carrying a `statusReason` that
// names the interrupted pull (INTERRUPTED_PULL_ASSET_REASON) rather than the
// sweep's `upload abandoned` — from/to alone cannot tell a dead pull worker from
// a client that closed its tab.
//
// NOT ONE TRANSACTION, by necessity: the job and the asset are separate
// documents in a store with no cross-document transaction (CouchDB —
// src/data/couch-asset-repo.ts / couch-job-repo.ts write one `_id` at a time),
// so the two writes are sequential and either can fail alone. The ORDER makes
// each half safe on its own: the job is settled FIRST (its terminal state is
// what #1084 guarantees and what GET /api/v1/jobs/:id reports), then the asset.
// If the asset write fails, the asset simply keeps today's behaviour — stuck
// `uploading` until the 24h sweep settles it as an abandoned upload — and the
// failure is logged, never thrown. The reverse half-write cannot strand anything
// either: an asset settled whose job write then fails is re-examined on the next
// boot, where the still-`running` job is settled again and the asset, no longer
// `uploading`, is left untouched by the status guard below.
//
// SCOPE (issue #1086): and the PARTIAL BYTES the dead pull left in object
// storage, which the #1084/#1085 versions left occupying the bucket forever. A
// pull streams straight into its own object key, so a transfer killed mid-stream
// leaves either a truncated object under that key or a multipart upload still
// open with its staged parts — bytes nothing will ever read, under a key whose
// job is now terminal. The in-process worker already discards the staged upload
// when IT reaches terminal failure (`discardOrphanedUpload` ->
// `storage.abortIncompleteMultipartUploads(objectKey)`,
// src/pipeline/url-pull-worker.ts, called on terminal failure per issue #1088);
// a worker killed by a restart never gets there, so the same cleanup is done
// here, plus a `removeObject` for the truncated single-part object that the
// multipart abort does not cover. RESUME IS NOT ATTEMPTED (explicitly out of
// scope for #1086): the job is settled `failed` and the bytes are discarded.
//
// WHICH KEY: resolved from the ASSET record's `objectKey`
// (src/data/asset-repo.ts) — the pull's key is minted by POST /ingest-url as
// `ingest/<assetId>` and written to the asset BEFORE the job is created
// (src/routes/assets.ts), and it is NOT on the Job record (src/data/job-repo.ts
// has no object-key field). So cleanup needs `deps.assets`, and runs only on the
// branch where this reconciler ITSELF moved the asset `uploading -> failed`: an
// asset still in `uploading` at settle time is one whose bytes never completed,
// which is exactly the proof that the object under its key is partial. An asset
// that had already moved on to `processing`/`ready` is skipped by the status
// guard below and its object — a COMPLETE source someone is using — is never
// touched. An `s3://…` key is skipped too: that is the external-backend branch's
// foreign bucket, whose bytes this deployment does not own and did not write.
//
// CLEANUP NEVER BLOCKS THE SETTLE (#1086 acceptance): it runs AFTER both durable
// writes, and a storage error is logged and swallowed — the job stays `failed`
// and the asset stays `failed`, because a bucket we cannot reach must not be
// able to resurrect the "stuck running forever" defect #1084 fixed. The asset
// keeps its `objectKey` in that case, so the record still names the bytes that
// were not reclaimed: that is what a later sweep (or an asset delete/purge,
// which removes the object itself) needs to find them. This reconciler does not
// retry on a later boot by itself — the job it would retry from is terminal by
// then and no longer a candidate.
//
// IDEMPOTENT and safe to run more than once: the settle re-reads each job
// immediately before writing and only acts while it is STILL `running` and STILL
// stamped before process start. A job this reconciler settles becomes `failed`
// (terminal) and is stamped with a fresh `updatedAt`, so a second run matches
// nothing.
//
// MULTI-STACK: the job repository resolves the ambient request stack, of which
// boot has none, so an unassisted scan sees only the first-listed stack
// (issue #1062). The caller therefore passes `deps.stacks` and the scan+settle
// runs once inside EACH provisioned stack's context — the same remedy the
// transcode/package sweeps adopted for this defect (src/main.ts:1346-1352).
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - Job.type / JOB_TYPES incl. 'ingest-url': src/data/job-repo.ts:84-85, :94
//   - Job.status / JOB_STATUSES incl. 'running': src/data/job-repo.ts:56-57, :95
//   - Job.updatedAt (ISO string, rewritten on every patch by applyJobPatch):
//     src/data/job-repo.ts:179, :347
//   - Job.error — "Terminal error message when status === 'failed'":
//     src/data/job-repo.ts:113-114; patchable via UpdateJobInput.error:
//     src/data/job-repo.ts:208
//   - `running -> failed` is an allowed transition (ALLOWED_JOB_TRANSITIONS):
//     src/data/job-repo.ts:248
//   - JobRepository.list({ limit, offset }) -> { items, total } and get(id) /
//     update(id, patch): src/data/job-repo.ts:275-285
//   - The worker whose death this reconciler cleans up after, and the terminal
//     write it would have made: src/pipeline/url-pull-worker.ts:110, :203
//   - Sweep shape (deps-driven fn, { scanned, settled } result, best-effort per
//     record, re-read before write, paged offset walk):
//     src/pipeline/abandoned-upload-sweep.ts:93-166
//   - Terminal audit entry: emitAudit(emitter, RecordAuditInput, log) +
//     originActor('user'|'system'|'ai') + AuditEmitter.record / AuditErrorLog.error:
//     src/data/audit-emit.ts:28-30, :35-36, :44-48, :59-63; the `job.failed` entry shape
//     this reconciler must match: src/pipeline/url-pull-worker.ts:320-334
//   - RecordAuditInput fields (actor/action/targetType/targetId/detail) and the
//     closed AUDIT_TARGET_TYPES enum incl. 'job': src/data/audit-repo.ts:53, :96-105
//   - Per-stack scan: WorkspaceStackResolver.listStackNames() (returns [] with no
//     param store, never throws — src/services/workspace-stack.ts:1155-1170) and
//     runWithRequestStack(stackName, fn) (src/services/request-stack-context.ts:46-48),
//     the pair the sibling boot/tick sweeps already use for this exact defect
//     (src/main.ts:1346-1352, issue #1058/#1062)
//
// Contract sources verified for the #1085 asset settle:
//   - AssetStatus incl. 'uploading'/'failed' and `uploading -> failed` allowed
//     (ALLOWED_TRANSITIONS.uploading): src/data/asset-repo.ts:28-38
//   - AssetRepository.get(id) / update(id, patch) -> Asset | undefined:
//     src/data/asset-repo.ts:1009 (interface), InMemoryAssetRepository.update
//   - UpdateAssetInput.status + UpdateAssetInput.statusReason (the #1085 field
//     that annotates the appended history entry): src/data/asset-repo.ts
//     UpdateAssetInput
//   - StatusTransition { at, from, to, reason? } and applyStatus() appending it:
//     src/data/asset-repo.ts StatusTransition / applyStatus
//   - The sibling settle whose reason this one must NOT collide with:
//     ABANDONED_UPLOAD_REASON, src/pipeline/abandoned-upload-sweep.ts
//   - An asset is created in `uploading` with a `null -> uploading` entry before
//     bytes arrive (why a dead pull leaves it there): src/data/asset-repo.ts
//     initialHistory()
//
// Contract sources verified for the #1086 partial-byte cleanup:
//   - Asset.objectKey — "Object key (workspace-local) for the asset payload":
//     src/data/asset-repo.ts:559-560; patchable via UpdateAssetInput.objectKey
//     (src/data/asset-repo.ts UpdateAssetInput) and written by the pull route
//   - The pull's key is `ingest/<assetId>`, set on the asset before the ingest
//     job is created, and passed to the worker as PullParams.objectKey:
//     src/routes/assets.ts POST /ingest-url; PullParams: src/pipeline/url-pull-worker.ts:93-106
//   - The Job record has NO object-key field (hence the asset lookup):
//     src/data/job-repo.ts
//   - WorkspaceStorage.removeObject(localKey: string): Promise<void>:
//     src/data/storage.ts:158-160
//   - WorkspaceStorage.abortIncompleteMultipartUploads(localKey: string):
//     Promise<number> (clears the staged parts of an upload killed mid-stream;
//     bounded loop over findUploadId): src/data/storage.ts:260-272
//   - The in-process cleanup this mirrors, and its best-effort/never-throw
//     stance: discardOrphanedUpload + its terminal-failure call site,
//     src/pipeline/url-pull-worker.ts (issue #1088)
//   - The external-backend `s3://<bucket>/<key>` objectKey that must NEVER be
//     deleted from here: src/routes/assets.ts POST /ingest-url sourceBackend branch
//   - Per-stack storage resolution used by the sibling object-removing sweep
//     (resolve the ambient stack's connections, build WorkspaceStorage from
//     them, undefined when storage is not configured):
//     src/main.ts `storageForBucket` for the archived-asset purge;
//     WorkspaceConnections.storageFor: src/services/workspace-stack.ts:158;
//     StorageFactory = () => WorkspaceStorage: src/routes/asset-upload.ts:65

import type { Asset, AssetRepository } from '../data/asset-repo.js';
import type { Job, JobRepository } from '../data/job-repo.js';
import {
  emitAudit,
  originActor,
  type AuditEmitter,
  type AuditErrorLog
} from '../data/audit-emit.js';

// The reason written to Job.error for a pull whose owning process died. Exported
// so callers and tests assert on the same string rather than duplicating it.
export const INTERRUPTED_PULL_ERROR = 'pull interrupted by process restart';

// The reason recorded on the ASSET's `uploading -> failed` statusHistory entry
// (issue #1085). Deliberately DIFFERENT from the abandoned-upload sweep's
// ABANDONED_UPLOAD_REASON ('upload abandoned',
// src/pipeline/abandoned-upload-sweep.ts): the two settles write the identical
// from/to pair, so this string is the only thing that tells an operator reading
// the asset whether a client stopped uploading or a server-side pull worker
// died. Kept shorter than the job's INTERRUPTED_PULL_ERROR above because the
// asset entry is a status annotation, not the job's terminal error message.
export const INTERRUPTED_PULL_ASSET_REASON = 'pull interrupted';

// An `objectKey` with this prefix names an object in a REGISTERED EXTERNAL
// bucket, not in this deployment's object storage: POST /ingest-url's
// `sourceBackend` branch records the source in place as `s3://<bucket>/<key>`
// and pulls no bytes at all (src/routes/assets.ts). Those bytes belong to the
// customer's own bucket and were never written by a pull, so cleanup skips them
// — deleting a foreign object would destroy data this system does not own.
// (Such a job is settled `done` inline and so is never an interrupted-pull
// candidate in the first place; this is the belt-and-braces check that a
// mis-shaped record cannot turn into a destructive call.)
const EXTERNAL_OBJECT_KEY_PREFIX = 's3://';

// The two storage operations the partial-byte cleanup needs (issue #1086).
// Structural, and satisfied as-is by WorkspaceStorage
// (src/data/storage.ts:158-160, :260-272), so no adapter is needed in
// production; declared narrowly so a test can supply a stub without
// constructing a MinIO client.
export type InterruptedPullCleanupStorage = {
  // Clear any multipart upload still open for the key, reclaiming its staged
  // parts. This is the half that covers a transfer big enough to have gone
  // multipart, whose bytes are NOT visible as an object.
  abortIncompleteMultipartUploads(localKey: string): Promise<number>;
  // Delete the object at the key. Covers the other half: a single-part write
  // that landed truncated, or a completed object from an earlier attempt that
  // the interrupted one was overwriting.
  removeObject(localKey: string): Promise<void>;
};

// How many jobs to enumerate per list call. JobRepository.list() has no status or
// type filter (src/data/job-repo.ts:276), so the walk pages over the job list and
// filters in memory; a generous page keeps the number of calls low. The walk
// stops on a short page.
const SCAN_PAGE_SIZE = 200;

// Defensive bound on the offset walk. The reconciler only needs to reach the
// jobs that could possibly predate process start, and it must never turn into an
// unbounded enumeration of a large historical job list at boot. Pages beyond this
// are not scanned, and the cut is logged as a WARNING because it is permanent for
// the jobs it hides: list() orders newest-first (src/data/job-repo.ts:539-540) and
// the job list only grows, so the records the cap truncates are the OLDEST ones
// and a later boot scanning the same leading pages will not reach them either.
// Such a job keeps the behaviour it has today — `running` forever, unsettled —
// so the cap trades an unbounded boot scan for a logged, bounded blind spot.
const MAX_SCAN_PAGES = 50;

type Logger = {
  info?(...a: unknown[]): void;
  warn?(...a: unknown[]): void;
};

// This process's start time in epoch ms, derived from process.uptime() so it is
// correct whenever it is called and never depends on module-import order. Used as
// the default liveness boundary: a `running` ingest-url job stamped before this
// cannot belong to a worker in this process.
export function processStartTimeMs(): number {
  return Date.now() - Math.round(process.uptime() * 1000);
}

export type ReconcileInterruptedIngestsDeps = {
  // Read + write side: enumerate jobs (paged), re-read one before settling, and
  // transition it to `failed` via update(). All three are on the shared
  // JobRepository interface, so no concrete-repo callback is needed.
  jobs: JobRepository;
  // The settled job's asset (issue #1085). Supplied, the reconciler moves each
  // settled pull's asset `uploading -> failed` with `statusReason` =
  // `assetReason` below, instead of leaving it to claim an upload is in progress
  // until the 24h abandoned-upload sweep notices. OPTIONAL so a test (or a
  // caller) that only cares about the job record keeps the exact #1084
  // behaviour: omitted, no asset is read or written.
  assets?: AssetRepository;
  // Object storage for the stack currently being scanned (issue #1086).
  // Supplied, the partial bytes a dead pull left under the asset's `objectKey`
  // are discarded once the job and asset are settled. A FACTORY, not an
  // instance, for the same reason the sibling object-removing sweep resolves one
  // per tick (src/main.ts `storageForBucket`): the scan runs once inside EACH
  // provisioned stack's context (`stacks` below), so the storage handle has to
  // be resolved INSIDE that context or the bytes would be deleted from the
  // wrong stack's bucket. Called at most once per settled job, and only on the
  // branch that actually settled one.
  //
  // May return undefined (or reject) when the scanned stack has no object
  // storage — a bare local run, or an in-memory fallback. That is not an error:
  // nothing was written there, so there is nothing to clean up, and the job and
  // asset settles are unaffected. OPTIONAL overall, so a caller or test that
  // only cares about the records keeps the exact pre-#1086 behaviour: omitted,
  // no storage call is made.
  storage?: () =>
    | InterruptedPullCleanupStorage
    | undefined
    | Promise<InterruptedPullCleanupStorage | undefined>;
  // The liveness boundary in epoch ms. A `running` ingest-url job whose
  // `updatedAt` is strictly EARLIER than this is declared interrupted; one
  // stamped AT OR AFTER it is left untouched (it may be a live pull). Injectable
  // so the boundary is deterministic in tests; defaults to this process's real
  // start time.
  processStartedAtMs?: number;
  // The reason recorded on Job.error. Defaults to INTERRUPTED_PULL_ERROR.
  reason?: string;
  // The reason recorded on the ASSET's statusHistory entry (issue #1085).
  // Defaults to INTERRUPTED_PULL_ASSET_REASON. Separate from `reason` above
  // because the two annotate different records: a job's terminal error message
  // vs an asset's status transition.
  assetReason?: string;
  // Best-effort terminal audit emission (issues #1000/#1032). This reconciler is
  // a SETTLE SITE for the ingest-url job's terminal transition, so it owes the
  // same `job.failed` entry the in-process worker emits when IT settles the job
  // (src/pipeline/url-pull-worker.ts:320-334). Without it a reconciler-settled
  // job keeps its `job.submitted` entry and never gets a closing one — exactly
  // the "history that never closes" defect #1000 fixed. Optional: when no
  // emitter is wired (an in-memory test that does not assert audit) emission is
  // a no-op, and a failed audit write is logged, never propagated
  // (src/data/audit-emit.ts:59-63).
  audit?: AuditEmitter;
  auditLog?: AuditErrorLog;
  // Multi-stack scan (issues #1058/#1062). The repository passed above is
  // normally PerWorkspaceJobRepository, which resolves the AMBIENT request stack
  // (src/data/per-workspace-repos.ts:164-168) — and boot has no request, so
  // currentRequestStackName() is undefined and the repo resolves the FIRST
  // LISTED stack only (src/services/request-stack-context.ts:51-53,
  // src/services/workspace-stack.ts resolve() no-stackName branch). On a
  // multi-stack install that would leave every non-default stack's interrupted
  // jobs stuck forever. Supplying this runs the whole scan+settle ONCE INSIDE
  // EACH provisioned stack's context, the same shape the transcode/package
  // sweeps use for this defect (src/main.ts:1346-1352). Omit it (or let
  // listStackNames() return []) and the scan runs exactly once against the
  // default resolution, byte-identical to not having it.
  stacks?: {
    // Provisioned stack names; [] when no parameter store is configured.
    listStackNames(): Promise<string[]>;
    // Run `fn` with `stackName` as the ambient stack for every resolution made
    // inside it.
    runInStack<T>(stackName: string | undefined, fn: () => Promise<T>): Promise<T>;
  };
  logger?: Logger;
};

// Deliberately UNCHANGED by issue #1085 — still `{ scanned, settled }`, both
// counting JOBS. The asset settle is a consequence of a settled job, not a
// separate unit of work, and no caller consumes the result (main.ts voids it),
// so adding a third counter would churn every existing assertion on this shape
// for no reader. Asset outcomes are observable where they matter: the asset's
// own `status`/`statusHistory`, plus the per-asset info/warn log lines.
export type ReconcileInterruptedIngestsResult = {
  scanned: number;
  settled: number;
};

// Settle every ingest-url job left `running` by a previous process, in EVERY
// provisioned stack when `deps.stacks` is supplied (and in the default-resolved
// stack only when it is not — see the `stacks` doc comment). Best-effort per job:
// one job's error is logged and skipped and never aborts the run; likewise
// per-stack, so one unreachable stack cannot hide the others' interrupted jobs.
// Never throws for a per-job or per-stack failure; only a failure to enumerate
// jobs in the single no-`stacks` case propagates to the caller, which decides
// whether that is fatal (it is not, at boot).
export async function reconcileInterruptedIngests(
  deps: ReconcileInterruptedIngestsDeps
): Promise<ReconcileInterruptedIngestsResult> {
  if (!deps.stacks) {
    return settleInterruptedIngestsInCurrentStack(deps);
  }

  // listStackNames() swallows its own errors and returns [] (workspace-stack.ts:1155-1170),
  // so an empty list means "no stack configs visible" — either a single fixed
  // deployment context or an unreadable store. Both want the one default-resolved
  // pass, which is the pre-#1062 behaviour.
  const names = await deps.stacks.listStackNames();
  const contexts: Array<string | undefined> = names.length > 0 ? names : [undefined];

  const totals: ReconcileInterruptedIngestsResult = { scanned: 0, settled: 0 };
  for (const stackName of contexts) {
    try {
      const result = await deps.stacks.runInStack(stackName, () =>
        settleInterruptedIngestsInCurrentStack(deps)
      );
      totals.scanned += result.scanned;
      totals.settled += result.settled;
    } catch (err) {
      // One stack whose job store cannot even be enumerated must not stop the
      // remaining stacks from being reconciled.
      deps.logger?.warn?.(
        '[interrupted-ingest-reconciler] failed to scan stack %s: %o',
        stackName ?? '(default)',
        err
      );
    }
  }
  return totals;
}

// One stack's scan + settle, run under whatever stack context is ambient at call
// time (the repositories resolve it themselves).
async function settleInterruptedIngestsInCurrentStack(
  deps: ReconcileInterruptedIngestsDeps
): Promise<ReconcileInterruptedIngestsResult> {
  const processStartedAtMs = deps.processStartedAtMs ?? processStartTimeMs();
  const reason = deps.reason ?? INTERRUPTED_PULL_ERROR;
  const assetReason = deps.assetReason ?? INTERRUPTED_PULL_ASSET_REASON;

  const candidates = await listInterruptedCandidates(deps, processStartedAtMs);

  let scanned = 0;
  let settled = 0;

  for (const job of candidates) {
    scanned += 1;

    try {
      // Re-read immediately before the write so a job that advanced between the
      // page snapshot and now is NEVER settled, and so a concurrent settle (or a
      // second run of this reconciler) cannot be clobbered. Only a job that is
      // STILL `running` AND STILL stamped before process start is eligible.
      const fresh = await deps.jobs.get(job.id);
      if (!fresh || fresh.type !== 'ingest-url' || fresh.status !== 'running') {
        continue; // already terminal, or gone — leave it alone
      }
      if (!isStampedBefore(fresh, processStartedAtMs)) {
        continue; // touched since the snapshot — it is a live pull after all
      }

      // Settle the JOB first (issue #1084). `running -> failed` is a valid
      // transition (src/data/job-repo.ts:248) and `error` is the caller-facing
      // terminal reason surfaced by GET /api/v1/jobs/:id. The asset follows
      // below (#1085); partial bytes are still #1086 and the pull is NOT
      // re-queued.
      const result = await deps.jobs.update(job.id, { status: 'failed', error: reason });
      if (result === undefined) {
        deps.logger?.warn?.(
          '[interrupted-ingest-reconciler] job %s vanished before settle',
          job.id
        );
        continue;
      }
      settled += 1;
      // Audit: this reconciler just performed the job's TERMINAL transition, so it
      // emits the terminal entry the (dead) in-process worker never got to write —
      // identical shape to url-pull-worker.ts:324-334, down to targetId = the job
      // id the `job.submitted` entry used at creation (src/routes/assets.ts POST
      // /ingest-url), so the ingest job's audit history opens and closes on the
      // same object (issue #1000/#1032). Emitted AFTER the durable write and only
      // on the branch that actually settled, and the settle is guarded by the
      // re-read above, so exactly ONE `job.failed` entry exists per settled job no
      // matter how often the reconciler runs. No `sourceUrl` in `detail`: a pull
      // source may be a pre-signed URL carrying credentials and the audit store is
      // queryable.
      emitAudit(
        deps.audit,
        {
          actor: originActor('system'),
          action: 'job.failed',
          targetType: 'job',
          targetId: job.id,
          detail: { jobType: 'ingest-url', assetId: job.assetId, error: reason }
        },
        deps.auditLog
      );
      deps.logger?.info?.(
        '[interrupted-ingest-reconciler] settled interrupted ingest job %s (asset %s) to failed: %s',
        job.id,
        job.assetId,
        reason
      );

      // Issue #1085: move the pull's asset out of `uploading` in the same pass,
      // so it stops advertising an upload that nothing is driving. Runs ONLY on
      // the branch that actually settled the job, and inside the same per-stack
      // context, so the asset repository resolves the same stack the job did
      // (#1062). Isolated in its own try so an asset-side failure leaves the
      // job's settle (already durable) intact.
      if (deps.assets) {
        try {
          const settledAsset = await settleAssetForInterruptedPull(deps, job, assetReason);

          // Issue #1086: the bytes. Only on the branch where the asset was
          // STILL `uploading` and this pass moved it to `failed` — that is the
          // proof the object under its key is a partial write and not a
          // complete source something else is now using. Runs LAST, after both
          // durable writes, and never throws (every storage error is logged
          // inside), so a bucket that cannot be reached leaves the job and asset
          // settled exactly as they are above.
          if (settledAsset) {
            await discardPartialPullBytes(deps, job, settledAsset);
          }
        } catch (err) {
          // Best-effort, exactly like the per-job guard: the asset keeps today's
          // behaviour (stuck `uploading` until the 24h abandoned-upload sweep)
          // and nothing else in the run is affected.
          deps.logger?.warn?.(
            '[interrupted-ingest-reconciler] settled job %s but failed to settle asset %s: %o',
            job.id,
            job.assetId,
            err
          );
        }
      }
    } catch (err) {
      // Best-effort: one job's failure never aborts the run.
      deps.logger?.warn?.(
        '[interrupted-ingest-reconciler] failed to settle job %s: %o',
        job.id,
        err
      );
    }
  }

  return { scanned, settled };
}

// Move an interrupted pull's asset `uploading -> failed` (issue #1085),
// annotated with `assetReason`. Returns the WRITTEN asset record, and undefined
// on every branch that did not write — so the caller's partial-byte cleanup
// (#1086) is driven by the one condition that proves the object is partial
// ("this pass took the asset out of `uploading`"), and reads the key off the
// post-write record rather than taking a second read.
//
// ONLY an asset still in `uploading` is touched — the acceptance criterion
// "never overwrite an asset that has already moved on". That guard matters for
// real cases, not just races: a retried pull may have already carried the asset
// to `processing` or `ready`, and an operator may have archived it. The check is
// made against a FRESH read taken here (not the job's page snapshot), for the
// same reason the job settle re-reads — it is the only state that can be acted
// on. `uploading -> failed` is the only move this makes, and it is an allowed
// transition (src/data/asset-repo.ts:28-38), so update() cannot reject it with
// InvalidStateTransitionError; any other current status is skipped BEFORE the
// write rather than being attempted and caught.
async function settleAssetForInterruptedPull(
  deps: ReconcileInterruptedIngestsDeps,
  job: Job,
  assetReason: string
): Promise<Asset | undefined> {
  const assets = deps.assets;
  if (!assets) {
    return undefined;
  }

  const asset = await assets.get(job.assetId);
  if (!asset) {
    // The asset was deleted/purged while its job hung. The job is settled; there
    // is nothing else to do.
    deps.logger?.warn?.(
      '[interrupted-ingest-reconciler] job %s has no asset %s to settle',
      job.id,
      job.assetId
    );
    return undefined;
  }
  if (asset.status !== 'uploading') {
    // Already moved on (processing/ready/failed/archived) — leave it exactly as
    // it is, and never append a second history entry on top of someone else's
    // state. Returning undefined also withholds the #1086 cleanup: an asset
    // that has moved on may be serving a COMPLETE object under this key, which
    // must not be deleted.
    return undefined;
  }

  // `statusReason` rides on the SAME update() that changes `status`, so the
  // appended `uploading -> failed` entry carries the reason atomically with the
  // transition — there is no window in which the asset is `failed` with an
  // unexplained entry (src/data/asset-repo.ts applyStatus).
  const updated = await assets.update(job.assetId, {
    status: 'failed',
    statusReason: assetReason
  });
  if (!updated) {
    deps.logger?.warn?.(
      '[interrupted-ingest-reconciler] asset %s vanished before settle',
      job.assetId
    );
    return undefined;
  }

  deps.logger?.info?.(
    '[interrupted-ingest-reconciler] settled asset %s (job %s) to failed: %s',
    job.assetId,
    job.id,
    assetReason
  );
  return updated;
}

// Discard the bytes an interrupted pull left behind (issue #1086): the staged
// parts of a multipart upload killed mid-stream, and any object sitting at the
// pull's key. Called ONLY after this pass settled both the job and the asset,
// and ONLY for an asset this pass took out of `uploading` — see the caller.
//
// NEVER THROWS, by design and by #1086 acceptance ("cleanup failure must be
// logged and must not block settling the job or asset"). Both durable writes are
// already done when this runs, so there is nothing left for a thrown error to
// protect; what it could do is make an unreachable bucket look like a failed
// settle and leave the job `running` for another boot to find — reintroducing
// the exact defect #1084 fixed. Each storage call is therefore guarded
// SEPARATELY, so a failing multipart abort does not skip the object delete (and
// vice versa): the two reclaim different bytes and neither depends on the other.
//
// Idempotent and safe to repeat: aborting with no open upload is a no-op that
// returns 0 (src/data/storage.ts:260-272), and deleting an absent object is a
// no-op on the backend's own delete semantics. The asset keeps its `objectKey`
// either way, so a record whose bytes could not be reclaimed still names them.
async function discardPartialPullBytes(
  deps: ReconcileInterruptedIngestsDeps,
  job: Job,
  asset: Asset
): Promise<void> {
  if (!deps.storage) {
    return; // cleanup not wired — pre-#1086 behaviour
  }

  const objectKey = asset.objectKey;
  if (!objectKey) {
    // No key was ever recorded, so no pull target is known. POST /ingest-url
    // writes it before creating the job, so this is a pre-#1086-era or
    // hand-made record; there is nothing safe to delete without a key, and
    // guessing one is not an option.
    deps.logger?.warn?.(
      '[interrupted-ingest-reconciler] asset %s (job %s) has no objectKey; partial bytes (if any) not reclaimed',
      asset.id,
      job.id
    );
    return;
  }
  if (objectKey.toLowerCase().startsWith(EXTERNAL_OBJECT_KEY_PREFIX)) {
    // A registered external backend's own object (see the prefix constant). We
    // did not write it and we do not delete it.
    deps.logger?.info?.(
      '[interrupted-ingest-reconciler] asset %s (job %s) sources an external object (%s); nothing to reclaim here',
      asset.id,
      job.id,
      objectKey
    );
    return;
  }

  let storage: InterruptedPullCleanupStorage | undefined;
  try {
    storage = await deps.storage();
  } catch (err) {
    // The stack's storage could not be resolved at all (connection build
    // failure, or no object storage on this stack). Logged, not fatal.
    deps.logger?.warn?.(
      '[interrupted-ingest-reconciler] could not resolve storage to reclaim %s (job %s): %o',
      objectKey,
      job.id,
      err
    );
    return;
  }
  if (!storage) {
    // No object storage on the scanned stack (bare local run / in-memory
    // fallback) — no bytes were ever written there, so there is nothing to
    // reclaim and this is not worth a warning.
    return;
  }

  // The multipart half first: a pull large enough to have gone multipart leaves
  // staged parts that are NOT reachable as an object, so the delete below would
  // never find them. Mirrors the in-process worker's terminal-failure cleanup
  // (src/pipeline/url-pull-worker.ts discardOrphanedUpload, issue #1088).
  try {
    const aborted = await storage.abortIncompleteMultipartUploads(objectKey);
    if (aborted > 0) {
      deps.logger?.info?.(
        '[interrupted-ingest-reconciler] discarded %d incomplete multipart upload(s) for %s (job %s)',
        aborted,
        objectKey,
        job.id
      );
    }
  } catch (err) {
    deps.logger?.warn?.(
      '[interrupted-ingest-reconciler] failed to discard incomplete multipart upload(s) for %s (job %s): %o',
      objectKey,
      job.id,
      err
    );
  }

  // The object half: a single-part write that landed truncated, or whatever an
  // earlier attempt had completed at this key before the process died.
  try {
    await storage.removeObject(objectKey);
    deps.logger?.info?.(
      '[interrupted-ingest-reconciler] deleted partial object %s left by interrupted pull (job %s, asset %s)',
      objectKey,
      job.id,
      asset.id
    );
  } catch (err) {
    deps.logger?.warn?.(
      '[interrupted-ingest-reconciler] failed to delete partial object %s (job %s, asset %s): %o',
      objectKey,
      job.id,
      asset.id,
      err
    );
  }
}

// True when the job's `updatedAt` is strictly earlier than the boundary. An
// unparseable stamp cannot be aged, so it is refused (never settled) rather than
// settled on a bad date — the same stance the abandoned-upload sweep takes
// (src/pipeline/abandoned-upload-sweep.ts:118-121).
function isStampedBefore(job: Job, boundaryMs: number): boolean {
  const updatedAtMs = Date.parse(job.updatedAt);
  if (Number.isNaN(updatedAtMs)) {
    return false;
  }
  return updatedAtMs < boundaryMs;
}

// Page through list() collecting every ingest-url job that is `running` and was
// last touched before process start. list() returns { items, total } and
// paginates via limit/offset (src/data/job-repo.ts:276), so the offset walk
// terminates on a short page, once the reported total is covered, or at the
// defensive page cap.
async function listInterruptedCandidates(
  deps: ReconcileInterruptedIngestsDeps,
  processStartedAtMs: number
): Promise<Job[]> {
  const out: Job[] = [];
  let offset = 0;

  for (let page = 0; page < MAX_SCAN_PAGES; page++) {
    const { items, total } = await deps.jobs.list({ limit: SCAN_PAGE_SIZE, offset });
    for (const job of items) {
      if (job.type !== 'ingest-url') continue; // transcode/package jobs are not ours
      if (job.status !== 'running') continue; // pending/queued are not owned by a dead worker yet; terminal is settled
      if (!isStampedBefore(job, processStartedAtMs)) continue; // possibly a live pull
      out.push(job);
    }
    if (items.length < SCAN_PAGE_SIZE) {
      return out;
    }
    offset += items.length;
    if (offset >= total) {
      return out;
    }
    if (page === MAX_SCAN_PAGES - 1) {
      deps.logger?.warn?.(
        '[interrupted-ingest-reconciler] stopped scanning at %d jobs (page cap); older jobs beyond this point are NOT scanned here or on a later boot and stay running if interrupted',
        offset
      );
    }
  }

  return out;
}
