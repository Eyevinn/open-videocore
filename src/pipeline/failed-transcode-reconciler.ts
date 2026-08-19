// Failed-transcode reconciliation sweep (issue #273).
//
// Completion of a transcode normally flows through the Encore callback listener,
// which by design posts ONLY SUCCESSFUL jobs onto the Redis queue that
// encore-callback-poller.ts drains. A job that reaches terminal FAILED (or
// CANCELLED) on Encore therefore never produces a queue message, so nothing ever
// drives the VideoCore Job to `failed` — it stays `running` and its source asset
// stays `processing` forever, with no error surfaced.
//
// This sweep closes that gap. It mirrors the cancellation fix in
// src/routes/jobs.ts (#124/#126): for each transcode Job still in a non-terminal
// state it polls Encore via EncoreClient.getJobStatus(encoreInternalJobId), and
// when Encore reports the job `failed` it routes through the SAME settle path the
// callback poller uses for a failed callback:
//   1. completeTranscode({ success: false, error }) — marks the Job `failed` and
//      moves the source asset out of `processing` (transcode.ts:139).
//   2. release the running pipeline lock — mark the running `transcode` step
//      `failed` so the asset's PipelineExecution is no longer RUNNING and a new
//      transcode can be submitted (mirrors jobs.ts DELETE /:id, lines 113-133).
//
// Bounded timeout for the 404 case: EncoreClient.getJobStatus() returns
// `undefined` when Encore has garbage-collected the job record (HTTP 404 — see
// encore-client.ts:105) OR when Encore is momentarily unreachable. `undefined`
// must NOT be read as "still running forever". A job whose Encore record has
// vanished and never received a success callback is treated as failed once it
// has been non-terminal for longer than `stallTimeoutMs` (measured from the
// Job's updatedAt). Below the timeout we leave it alone, so a transient 404 /
// blip during a genuinely in-flight job does not prematurely fail it.

import type { AssetRepository } from '../data/asset-repo.js';
import type { Job, JobRepository } from '../data/job-repo.js';
import type { PipelineRepository, StepExecution } from '../data/pipeline-repo.js';
import type { EncoreClient } from './encore-client.js';
import { completeTranscode } from './transcode.js';

// Non-terminal statuses a transcode Job can sit in while waiting on Encore.
// Terminal statuses (done/failed/cancelled) are skipped — nothing to reconcile.
const NON_TERMINAL: ReadonlySet<Job['status']> = new Set([
  'pending',
  'queued',
  'running'
]);

// Default: a non-terminal transcode whose Encore record has vanished (404) and
// that has not advanced for this long is declared failed. Generous by default so
// a genuinely long transcode is never cut off — the callback path settles a
// healthy job long before this fires; this only catches jobs Encore has actually
// dropped.
export const DEFAULT_STALL_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

// How many jobs to scan per sweep. The repositories paginate list(); we only
// ever need to look at non-terminal jobs, of which there are few, so a single
// generous page is enough for the reconciliation to make progress each tick.
const SCAN_PAGE_SIZE = 200;

type Logger = {
  info?(...a: unknown[]): void;
  warn?(...a: unknown[]): void;
};

export type ReconcileFailedTranscodesDeps = {
  jobs: JobRepository;
  assets: AssetRepository;
  // Optional: when present, a failed job also releases the running pipeline lock
  // so the asset's PipelineExecution is no longer RUNNING (mirrors jobs.ts).
  pipeline?: PipelineRepository;
  encore: EncoreClient;
  // Injectable clock + timeout so the bounded-timeout path is unit-testable.
  now?: () => number;
  stallTimeoutMs?: number;
  logger?: Logger;
};

export type ReconcileFailedTranscodesResult = {
  scanned: number;
  failed: number;
};

// Sweep non-terminal transcode jobs and settle any that Encore reports failed
// (or that have stalled past the bounded timeout after Encore dropped them).
// Best-effort per job: one job's error never aborts the sweep for the rest.
export async function reconcileFailedTranscodes(
  deps: ReconcileFailedTranscodesDeps
): Promise<ReconcileFailedTranscodesResult> {
  const now = deps.now ?? (() => Date.now());
  const stallTimeoutMs = deps.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;

  const { items } = await deps.jobs.list({ limit: SCAN_PAGE_SIZE, offset: 0 });
  let scanned = 0;
  let failed = 0;

  for (const job of items) {
    if (job.type !== 'transcode') continue;
    if (!NON_TERMINAL.has(job.status)) continue;
    // Without Encore's internal id there is nothing to poll. Such a job is still
    // pre-dispatch (submitTranscode records encoreInternalJobId only after a
    // successful submit); the dispatch/callback paths own it.
    if (!job.encoreInternalJobId) continue;

    scanned += 1;

    let status: string | undefined;
    try {
      status = await deps.encore.getJobStatus(job.encoreInternalJobId);
    } catch (err) {
      // Encore momentarily unreachable — leave the job for the next sweep.
      deps.logger?.warn?.(
        '[failed-transcode-reconciler] getJobStatus threw for job %s: %o',
        job.id,
        err
      );
      continue;
    }

    if (status === 'failed') {
      await settleFailed(deps, job, 'transcode failed on Encore');
      failed += 1;
      continue;
    }

    if (status === undefined) {
      // 404 / garbage-collected OR a transient blip: getJobStatus cannot tell
      // these apart. Apply the bounded timeout — only declare failed once the
      // job has been non-terminal (unchanged) longer than stallTimeoutMs. This
      // guarantees a vanished Encore record can never leave a job stuck forever,
      // while a genuinely in-flight job survives a transient 404.
      const updatedAtMs = Date.parse(job.updatedAt);
      const ageMs = Number.isNaN(updatedAtMs) ? 0 : now() - updatedAtMs;
      if (ageMs > stallTimeoutMs) {
        await settleFailed(
          deps,
          job,
          'transcode timed out: Encore has no record of the job'
        );
        failed += 1;
      }
      continue;
    }

    // 'done' or 'running' — the success callback / normal running path owns the
    // settle; nothing to do here.
  }

  return { scanned, failed };
}

// Settle a single failed transcode: run completeTranscode({ success: false }) to
// mark the Job failed and take the source asset out of `processing`, then
// release the running pipeline lock. Errors are swallowed (logged) so one job's
// failure to settle never aborts the sweep.
async function settleFailed(
  deps: ReconcileFailedTranscodesDeps,
  job: Job,
  error: string
): Promise<void> {
  try {
    const result = await completeTranscode(
      {
        jobId: job.id,
        sourceAssetId: job.assetId,
        success: false,
        error,
        renditions: []
      },
      { jobs: deps.jobs, assets: deps.assets }
    );

    // Only touch the pipeline lock when completeTranscode actually applied (i.e.
    // the job was still non-terminal). A no-op (already terminal) means another
    // path settled it first; don't re-fail the pipeline step.
    if (result.applied && deps.pipeline) {
      await releasePipelineLock(deps.pipeline, job.assetId, error);
    }

    deps.logger?.info?.(
      '[failed-transcode-reconciler] settled failed transcode job %s (asset %s): %s',
      job.id,
      job.assetId,
      error
    );
  } catch (err) {
    deps.logger?.warn?.(
      '[failed-transcode-reconciler] failed to settle job %s: %o',
      job.id,
      err
    );
  }
}

// Release the running pipeline lock for an asset by marking its running
// `transcode` step failed. Mirrors the cancel handler in src/routes/jobs.ts
// (lines 113-133): find the running execution with a running transcode step and
// fail it so the PipelineExecution is no longer RUNNING. No-op when no such
// execution exists (e.g. a bare POST /:id/transcode, not a full pipeline).
async function releasePipelineLock(
  pipeline: PipelineRepository,
  assetId: string,
  error: string
): Promise<void> {
  const execution = await pipeline.findRunningByAssetAndStep(assetId, 'transcode');
  if (!execution) return;
  const now = new Date().toISOString();
  const steps: StepExecution[] = execution.steps.map((s) => ({ ...s }));
  const tIdx = steps.findIndex((s) => s.name === 'transcode');
  if (tIdx < 0) return;
  steps[tIdx] = {
    ...steps[tIdx],
    status: 'failed',
    error,
    completedAt: now
  };
  await pipeline.update(execution.id, { steps, status: 'failed' });
}
