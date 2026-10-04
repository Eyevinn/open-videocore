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
// SCOPE (issue #1084): the JOB RECORD ONLY — settled to `failed` with a reason
// naming the interruption, plus the matching terminal audit entry (below). It is
// deliberately NOT re-queued and the asset is NOT moved out of `uploading`
// (issue #1085).
//
// Partially-written bytes are also NOT cleaned up here (issue #1086). That gap
// does not need new machinery: the in-process terminal-failure path already
// discards the staged multipart upload for exactly this reason
// (`discardOrphanedUpload` -> `storage.abortIncompleteMultipartUploads(objectKey)`,
// src/pipeline/url-pull-worker.ts:102-127, called on terminal failure at :302 per
// issue #1088). #1086 is the work of giving this reconciler the same two inputs
// that helper needs — a WorkspaceStorage for the job's stack and the job's
// `objectKey` — and calling it; it is out of scope for #1084 because the object
// key is not on the Job record (src/data/job-repo.ts) and deriving it is its own
// decision.
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
  // The liveness boundary in epoch ms. A `running` ingest-url job whose
  // `updatedAt` is strictly EARLIER than this is declared interrupted; one
  // stamped AT OR AFTER it is left untouched (it may be a live pull). Injectable
  // so the boundary is deterministic in tests; defaults to this process's real
  // start time.
  processStartedAtMs?: number;
  // The reason recorded on Job.error. Defaults to INTERRUPTED_PULL_ERROR.
  reason?: string;
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

      // Settle the JOB ONLY (issue #1084 scope). `running -> failed` is a valid
      // transition (src/data/job-repo.ts:248) and `error` is the caller-facing
      // terminal reason surfaced by GET /api/v1/jobs/:id. The asset is left to
      // issue #1085 and partial bytes to #1086; the pull is NOT re-queued.
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
