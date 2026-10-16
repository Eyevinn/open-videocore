// A transcode completion that arrives AFTER the job was cancelled (#1226).
//
// THE RULE — CANCEL WINS, THE LATE OUTPUT IS RECLAIMED.
//
// #1226 left the choice open between (a) ignore the output and clean it up and
// (b) accept it and drive the job to a completed state with its renditions
// registered. This module implements (a), for three reasons that come from the
// code and the data model rather than from taste:
//
//   1. `cancelled` is the ONE job status with no outgoing transition at all
//      (ALLOWED_JOB_TRANSITIONS, src/data/job-repo.ts: `cancelled: []`, and
//      TERMINAL_JOB_STATUSES there). `failed` deliberately keeps
//      `failed -> done` so a conditional drop-detection settle can be corrected
//      (#709) — a conditional failure is an INFERENCE about what Encore did. A
//      cancel is not an inference about Encore: it is a user decision, applied
//      synchronously by DELETE /api/v1/jobs/:id (src/routes/jobs.ts), which also
//      asks Encore to cancel. Option (b) would mean reopening the only truly
//      terminal state in the lifecycle so that a user's explicit "stop this"
//      could be undone by the machine, minutes later.
//   2. #1220's stated expectation is "a cancelled job is not re-run", and #1225
//      excludes `cancelled` from scale-down recovery and dropped-job
//      reconciliation on exactly that basis. Registering the output of a run the
//      user stopped would contradict that same invariant from the other end.
//   3. The output of a cancelled run is unreferenced by construction: Encore
//      writes it under the job's own deterministic prefix
//      (`transcode/{assetId}/{jobId}` — submitTranscode's `outputUri`,
//      src/pipeline/transcode.ts), nothing else is stored there, and no
//      rendition on the asset points at it. So it can be removed without
//      touching any live object, and removing it is what makes the three facts
//      #1226 requires to agree actually agree: job `cancelled`, renditionCount
//      0, and no output files.
//
// What this module does on a completion for a cancelled job:
//   - removes every object under the job's output prefix (best effort — a
//      storage error is recorded, never thrown, and leaves the prefix for a
//      retry/operator);
//   - stamps a DURABLE trace on the job record (`lateCompletionDiscarded`,
//      `discardedRenditionCount`, `discardedOutputPrefix`) so "0 renditions" on
//      a cancelled job is explained on the record itself rather than only by a
//      log line that said `applied false renditionCount 0`;
//   - leaves the job `cancelled` (no status write at all, so no terminal
//      transition is attempted);
//   - releases the source asset from `processing` when this job was the last
//      active one for it, because a cancelled transcode leaves the SOURCE intact
//      and reusable — the same reasoning submitTranscode applies when it reverts
//      a rejected submission.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - `Job`, `UpdateJobInput`, `JobRepository.findActiveByAssetId`,
//     `ACTIVE_JOB_STATUSES`, `ALLOWED_JOB_TRANSITIONS` (`cancelled: []`) —
//     src/data/job-repo.ts.
//   - `AssetRepository.get/update`, `AssetStatus`, `isValidTransition`
//     (`processing -> ready` allowed, `ALLOWED_TRANSITIONS`) —
//     src/data/asset-repo.ts.
//   - `WorkspaceStorage.removeObjectsUnderPrefix(prefix: string): Promise<void>`
//     — src/data/storage.ts (the method the archived-asset purge sweep uses for
//     the packaged-output prefix, src/pipeline/archived-asset-purge-sweep.ts).
//   - Output location `s3://{outputBucket}/{transcodeOutputPrefix(assetId,
//     jobId)}` — `transcodeOutputPrefix` / `PACKAGED_OUTPUT_PREFIX`,
//     src/pipeline/transcode.ts (the prefix is passed in by the caller so this
//     module cannot drift from the submit path).

import type { AssetRepository } from '../data/asset-repo.js';
import { type AssetStatus } from '../data/asset-repo.js';
import type { Job, JobRepository } from '../data/job-repo.js';
// #1227: the ONE rule for recomputing an asset's state from a job's final
// state. A late completion is one of the terminal edges it serves; the others
// are the cancel route and the pipeline-execution cancel.
import { recomputeAssetStateAfterTerminalJob } from './asset-state-after-terminal-job.js';

// The minimal object-storage surface the reclaim needs: a subset of
// WorkspaceStorage (src/data/storage.ts), declared structurally so the rule is
// testable without a live object store — the same shape the archived-asset purge
// sweep declares for its own removals (`PurgeStorage`).
export type CancelledJobOutputStorage = {
  removeObjectsUnderPrefix(prefix: string): Promise<void>;
};

// What the reclaim did, returned so the caller can log one explicit line instead
// of the bare `applied false renditionCount 0` that #1226 was reported from.
export type CancelledCompletionReclaim = {
  // The job's deterministic output prefix this reclaim targeted.
  outputPrefix: string;
  // How many renditions the discarded completion reported (0 when the completion
  // carried no output document, e.g. the poller's Encore-unreachable fallback).
  discardedRenditionCount: number;
  // true when the prefix removal ran and succeeded (or had nothing to remove);
  // false when no storage was wired or the removal errored — see `removalError`.
  outputRemoved: boolean;
  // Why the removal did not happen, when it did not. Never thrown.
  removalError?: string;
  // The source asset's status after the reclaim, when the reclaim moved it out
  // of `processing`. Absent when the asset was left exactly as it was.
  assetStatus?: AssetStatus;
};

export type ReclaimCancelledCompletionParams = {
  // The cancelled job the completion arrived for. Callers pass the record they
  // already read, so this never re-fetches it.
  job: Job;
  // The job's SOURCE asset (Job.assetId for a transcode job).
  sourceAssetId: string;
  // The job's deterministic transcode output prefix, built by the caller with
  // `transcodeOutputPrefix` so the submit path owns the one spelling of it.
  outputPrefix: string;
  // Renditions the late completion reported, for the durable trace.
  reportedRenditionCount: number;
};

export type ReclaimCancelledCompletionDeps = {
  jobs: JobRepository;
  assets: AssetRepository;
  // Resolves object storage for the transcode OUTPUT bucket of the stack this
  // job belongs to. Lazy (and optional) on purpose: it is only ever called on
  // this rare path, so a normal completion builds no storage handle, and a
  // deployment with no object storage degrades to "trace recorded, objects left"
  // rather than failing the completion.
  resolveOutputStorage?: () => Promise<CancelledJobOutputStorage | undefined>;
  // Best-effort warn sink for a removal failure. Optional; absent => silent
  // (the failure is still returned in the result and visible to the caller).
  logWarn?: (detail: Record<string, unknown>) => void;
};

// Apply the rule above. Callers invoke this ONLY for a job whose status is
// already `cancelled`; it is idempotent, so a redelivered completion for the
// same cancelled job simply re-asserts an empty prefix and the same trace.
export async function reclaimCancelledTranscodeCompletion(
  params: ReclaimCancelledCompletionParams,
  deps: ReclaimCancelledCompletionDeps
): Promise<CancelledCompletionReclaim> {
  const { job, sourceAssetId, outputPrefix, reportedRenditionCount } = params;

  // 1. Remove the orphaned output. Attempted whatever the completion's reported
  //    rendition count is: a cancelled job's prefix holds nothing we will ever
  //    register, and the count can be 0 on a completion whose Encore job
  //    document we could not fetch (encore-callback-poller.ts's
  //    "encore unreachable after retries" fallback) while the files are there.
  let outputRemoved = false;
  let removalError: string | undefined;
  try {
    const storage = await deps.resolveOutputStorage?.();
    if (storage) {
      await storage.removeObjectsUnderPrefix(outputPrefix);
      outputRemoved = true;
    } else {
      removalError = 'object storage is not configured for this stack';
    }
  } catch (err) {
    removalError = err instanceof Error ? err.message : String(err);
  }
  if (removalError) {
    deps.logWarn?.({
      msg: 'late completion on a cancelled job: could not remove the orphaned transcode output',
      jobId: job.id,
      assetId: sourceAssetId,
      outputPrefix,
      error: removalError
    });
  }

  // 2. Durable trace on the job record. NO `status` in this patch: the job stays
  //    `cancelled` and no transition is attempted (there is none to attempt —
  //    `cancelled: []`), so this write cannot throw InvalidJobTransitionError.
  //    `error` is left as the cancel wrote it ('cancelled by operator').
  await deps.jobs.update(job.id, {
    lateCompletionDiscarded: true,
    discardedRenditionCount: reportedRenditionCount,
    discardedOutputPrefix: outputPrefix
  });

  // 3. Release the source asset. The cancel path marks the job (and the
  //    pipeline's transcode step) terminal but never moves the asset, so an
  //    asset advanced to `processing` at dispatch time stays there with nothing
  //    running. Only when no OTHER job is still active on it, and only through a
  //    transition the asset state machine allows — a cancelled transcode leaves
  //    the source object intact, so `ready` (reusable/retryable), never `failed`.
  //
  //    #1227: that recompute is no longer written here. It is the SAME rule the
  //    cancel route and the pipeline-execution cancel need (an asset must leave
  //    `processing` whenever its last active job ends, however it ended), so it
  //    lives in one place — `recomputeAssetStateAfterTerminalJob` — and this
  //    path calls it with the cancelled job. The outcome for a cancelled
  //    transcode is unchanged: no renditions and a job that did not fail, so the
  //    asset returns to its prior state, falling back to `ready` because a
  //    transcode only READ the source (asset-state-after-terminal-job.ts).
  const recompute = await recomputeAssetStateAfterTerminalJob(
    job,
    { assets: deps.assets, jobs: deps.jobs, logWarn: deps.logWarn },
    sourceAssetId
  );
  const assetStatus: AssetStatus | undefined =
    recompute.outcome === 'applied' ? recompute.status : undefined;

  return {
    outputPrefix,
    discardedRenditionCount: reportedRenditionCount,
    outputRemoved,
    ...(removalError ? { removalError } : {}),
    ...(assetStatus ? { assetStatus } : {})
  };
}
