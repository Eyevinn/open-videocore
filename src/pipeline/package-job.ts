// Package-step Job records (issue #976).
//
// Every other pipeline step that does real work leaves an observable object
// behind: `ingest-url` and `transcode` both create a Job (src/routes/assets.ts
// ingest handlers and src/pipeline/transcode.ts submitTranscode), which is what
// `GET /api/v1/jobs` lists and what `steps[].jobId` points at. `package` — the
// step that produces the artifact a caller actually consumes (the HLS/DASH
// manifests) — created nothing: a failure was written as `packagingError` on the
// asset and a stall was only ever visible as a step error on the execution.
//
// This module owns the package Job's lifecycle so the FOUR paths that enqueue or
// settle packaging cannot drift:
//   - PackagingService.triggerPackaging / handleSuccess / handleFailure
//     (src/pipeline/packaging.ts)
//   - the OSC-native transcode->package handoff in the callback poller
//     (src/pipeline/encore-callback-poller.ts enqueuePackagingJob)
//   - the packager's failure callback (src/routes/internal.ts
//     POST /packagerCallback/failure), which carries no jobId and correlates by
//     execution state
//   - the stalled-package sweep (src/pipeline/stalled-package-reconciler.ts,
//     issue #336)
//
// PRECEDENT (mirrored deliberately): a transcode job is created by
// `submitTranscode` (src/pipeline/transcode.ts) with `jobs.create({ type:
// 'transcode', assetId })` and then immediately patched with its external
// correlation id + non-pending status (`jobs.update(job.id, { encoreJobId,
// status: 'queued' })`); it is settled by `completeTranscode`, which patches
// `{ status: 'done', progress: 100 }` or `{ status: 'failed', error }`. A package
// job follows the same create-then-annotate/settle shape, carrying `packagingId`
// + `outputPrefix` where transcode carries `encoreJobId` (CONTRACT: `Job`,
// `CreateJobInput`, `UpdateJobInput` in src/data/job-repo.ts).
//
// EVERY function here is BEST-EFFORT and never throws: packaging has never been
// allowed to fail because of its own bookkeeping (see the detached-safety
// comments in packaging.ts), and adding an observability record must not change
// that. A repository error is reported to the optional logger and swallowed.

import {
  isActiveJobStatus,
  type Job,
  type JobRepository
} from '../data/job-repo.js';
import type { PipelineRepository, StepExecution } from '../data/pipeline-repo.js';
// The correlation id + deterministic prefix are derived from the ONE definition
// of each (packaging.ts), never re-implemented here. packaging.ts imports this
// module back; both imported symbols are hoisted function declarations
// evaluated only at call time, so the cycle has no initialisation order hazard.
import { outputPrefix, packagingId } from './packaging.js';

// Status a package job is created in. The packager queue has no dispatch signal
// we observe (unlike the Encore scaler's `onDispatched`, which is what advances a
// transcode job from `queued` to `running`), so the job goes straight to
// `running` at enqueue time — the same moment the execution's `package` step is
// set to `running`. This also keeps the job settleable: the repository's
// transition table (ALLOWED_JOB_TRANSITIONS, src/data/job-repo.ts) permits
// `running -> done|failed` but NOT `queued -> done`.
const PACKAGE_JOB_START_STATUS = 'running' as const;

// Structural, permissive logger so every caller can pass what it already holds:
// a Fastify logger (warn + error), the sweep's `{ info, warn }` shim
// (src/pipeline/stalled-package-reconciler.ts), or an AuditErrorLog (`error`
// only, src/data/audit-emit.ts). Both members are optional; `logWarn` prefers
// `warn` and degrades to `error`, and to silence when neither exists.
type PackageJobLogger = {
  warn?(...a: unknown[]): void;
  error?(...a: unknown[]): void;
};

function logWarn(logger: PackageJobLogger | undefined, message: string, ...args: unknown[]): void {
  if (logger?.warn) {
    logger.warn(message, ...args);
    return;
  }
  logger?.error?.(message, ...args);
}

export type PackageJobDeps = {
  // Absent on deployments/tests that have not wired a job repository into the
  // packaging path; every helper then no-ops, preserving pre-#976 behaviour.
  jobs?: JobRepository;
  // When present, the created job id is stamped onto the execution's running
  // `package` step (`steps[].jobId`, the field that already exists on
  // StepExecution — src/data/pipeline-repo.ts).
  pipeline?: PipelineRepository;
  logger?: PackageJobLogger;
};

// The in-flight package job for an asset, if any. Uses the repository's existing
// active-job lookup (`findActiveByAssetId`, src/data/job-repo.ts — the
// non-terminal set pending/queued/running) and narrows to package jobs, so a
// concurrent transcode/ingest job for the same asset is never mistaken for one.
async function findActivePackageJob(
  jobs: JobRepository,
  assetId: string
): Promise<Job | undefined> {
  const active = await jobs.findActiveByAssetId(assetId);
  return active.find((j) => j.type === 'package');
}

// Create (or re-attempt) the `package` Job for an asset at enqueue time, and
// stamp its id onto the execution's running `package` step. Returns the job id,
// or undefined when no job repository is wired / the write failed.
//
// A re-enqueue for an asset whose previous package job is still in flight
// increments `attempts` on that SAME record rather than creating a second one:
// one packaging run for one asset is one observable object, and the attempt
// count is what distinguishes a re-enqueue from a slow first run.
export async function startPackageJob(
  deps: PackageJobDeps,
  assetId: string
): Promise<string | undefined> {
  if (!deps.jobs) return undefined;
  let jobId: string | undefined;
  try {
    const existing = await findActivePackageJob(deps.jobs, assetId);
    if (existing) {
      await deps.jobs.update(existing.id, { attempts: existing.attempts + 1 });
      jobId = existing.id;
    } else {
      // Mirrors submitTranscode: create first (the repository always creates
      // `pending` with attempts 0), then patch the correlation fields + the
      // non-pending status in one update.
      const created = await deps.jobs.create({ type: 'package', assetId });
      await deps.jobs.update(created.id, {
        status: PACKAGE_JOB_START_STATUS,
        attempts: 1,
        packagingId: packagingId(assetId),
        outputPrefix: outputPrefix(assetId)
      });
      jobId = created.id;
    }
  } catch (err) {
    logWarn(deps.logger, '[package-job] failed to record package job for asset %s: %o', assetId, err);
    return undefined;
  }
  await stampJobIdOnPackageStep(deps, assetId, jobId);
  return jobId;
}

// Populate `steps[].jobId` on the asset's running `package` step (the field
// that already exists — StepExecution.jobId, src/data/pipeline-repo.ts). No-op
// when the step is not yet persisted as `running` (the package-only pipeline
// start path in src/routes/assets.ts stamps the returned id itself, before its
// first write) or when it already carries a jobId.
async function stampJobIdOnPackageStep(
  deps: PackageJobDeps,
  assetId: string,
  jobId: string
): Promise<void> {
  if (!deps.pipeline) return;
  try {
    const execution = await deps.pipeline.findRunningByAssetAndStep(assetId, 'package');
    if (!execution) return;
    const idx = execution.steps.findIndex((s) => s.name === 'package' && s.status === 'running');
    if (idx < 0 || execution.steps[idx].jobId) return;
    const steps: StepExecution[] = execution.steps.map((s) => ({ ...s }));
    steps[idx] = { ...steps[idx], jobId };
    await deps.pipeline.update(execution.id, { steps });
  } catch (err) {
    logWarn(
      deps.logger,
      '[package-job] failed to stamp package jobId on execution for asset %s: %o',
      assetId,
      err
    );
  }
}

// Resolve the package job a settle applies to. Prefers an explicit id (the
// stalled sweep reads `steps[].jobId`), falling back to the asset's in-flight
// package job (the packager callbacks carry no job id of ours).
async function resolvePackageJob(
  jobs: JobRepository,
  target: { jobId?: string; assetId: string }
): Promise<Job | undefined> {
  if (target.jobId) {
    const byId = await jobs.get(target.jobId);
    if (byId && byId.type === 'package') return byId;
  }
  return findActivePackageJob(jobs, target.assetId);
}

// Settle the asset's package job as `done`. Idempotent: an already-terminal job
// is left untouched, so an at-least-once packager success callback never
// re-settles (mirrors completeTranscode's first-terminal-write-wins guard).
// Returns the resolved job's id (whether or not this call changed it) so the
// caller can audit against the SAME target the submission was audited under.
export async function completePackageJob(
  deps: PackageJobDeps,
  target: { jobId?: string; assetId: string }
): Promise<string | undefined> {
  if (!deps.jobs) return undefined;
  try {
    const job = await resolvePackageJob(deps.jobs, target);
    if (!job) return undefined;
    if (!isActiveJobStatus(job.status)) return job.id;
    await deps.jobs.update(job.id, { status: 'done', progress: 100 });
    return job.id;
  } catch (err) {
    logWarn(
      deps.logger,
      '[package-job] failed to complete package job for asset %s: %o',
      target.assetId,
      err
    );
    return undefined;
  }
}

// Settle the asset's package job as `failed`, recording WHY. This is what makes
// a packaging failure readable from the Jobs tab instead of only from the
// asset's `packagingError` / the execution's step error. Idempotent in the same
// way as completePackageJob, and returns the resolved job id for the same
// auditing reason.
export async function failPackageJob(
  deps: PackageJobDeps,
  target: { jobId?: string; assetId: string },
  reason: string
): Promise<string | undefined> {
  if (!deps.jobs) return undefined;
  try {
    const job = await resolvePackageJob(deps.jobs, target);
    if (!job) return undefined;
    if (!isActiveJobStatus(job.status)) return job.id;
    await deps.jobs.update(job.id, { status: 'failed', error: reason });
    return job.id;
  } catch (err) {
    logWarn(
      deps.logger,
      '[package-job] failed to record package job failure for asset %s: %o',
      target.assetId,
      err
    );
    return undefined;
  }
}
