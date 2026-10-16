// Recompute an asset's lifecycle state when one of its jobs reaches a TERMINAL
// state (#1227).
//
// THE BUG. An asset is advanced to `processing` when work starts on it (the
// scaler's onDispatched for a transcode, the URL-pull worker for an ingest), and
// it is moved OUT of `processing` by exactly one place: the transcode completion
// handler (`completeTranscode`, src/pipeline/transcode.ts). Every OTHER way a
// job can reach a terminal state skipped that write:
//
//   - `DELETE /api/v1/jobs/:id` (src/routes/jobs.ts) writes the job `cancelled`
//     and fails the running pipeline step, but never touches the asset — so a
//     cancelled-then-re-run job left the asset reading PROCESSING forever,
//     which is the symptom #1227 was reported from;
//   - `DELETE /api/v1/pipelines/:executionId` (src/routes/pipelines.ts) settles
//     each non-terminal step's job `failed` with the same blind spot;
//   - a completion that arrives AFTER a cancel (#1226) has to release the asset
//     itself, because the normal completion path short-circuits on a terminal
//     job.
//
// So the asset's state has to be RECOMPUTED FROM THE FINAL JOB STATE at every
// terminal edge, not written only on the happy path. That is what this module
// is: one rule, called from each of those sites.
//
// THE RULE (#1227 acceptance). When the LAST active job for an asset ends, the
// asset leaves `processing`:
//
//   1. renditions exist on the asset            -> `ready`
//      The work product is there and servable, whatever happened to this job
//      (e.g. a second pass was cancelled after the first one registered its
//      renditions). This clause is checked FIRST so a cancel can never bury
//      output that is already registered on the record.
//   2. the job's final state is `failed`        -> `failed`
//      The asset follows the job it was processing for.
//   3. otherwise (`cancelled`, or `done` with
//      nothing registered)                      -> the asset's PRIOR state,
//      i.e. the state it held before it entered `processing`, when that state
//      is still reachable from `processing`; otherwise a type-derived fallback
//      (see `assetStateAfterTerminalJob`). A cancel is a user decision that
//      destroys nothing, so it must put the asset back where it was rather
//      than invent a failure.
//
// NOTHING happens unless the asset is actually `processing` and this job was
// its last active one — a `ready`, `uploading` or `archived` asset is never
// moved by a job settling, and an asset with another transcode still running
// stays `processing` (that job will recompute in its turn).
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - `Job` (`id`, `type`, `status`, `assetId`), `JobStatus`, `JobType`,
//     `JOB_STATUSES`, `isActiveJobStatus` / `ACTIVE_JOB_STATUSES` (the
//     non-terminal set: pending/queued/running) and
//     `JobRepository.findActiveByAssetId(assetId)` — src/data/job-repo.ts.
//   - `AssetStatus` / `ASSET_STATUSES`, `ALLOWED_TRANSITIONS`
//     (`processing: ['ready', 'failed', 'archived']`), `isValidTransition`,
//     `StatusTransition` (`{ at, from: AssetStatus | null, to, reason? }`),
//     `Asset.statusHistory` / `Asset.renditions`, `AssetRepository.get/update`
//     and `UpdateAssetInput.status` / `.statusReason` (recorded on the appended
//     history entry, ignored without `status`) — src/data/asset-repo.ts.
//   - The prior-state derivation mirrors `restoreTargetStatus(history)` in that
//     same file: scan the history backwards for the most recent transition INTO
//     the state in question and read its `from`.

import {
  isValidTransition,
  type AssetRepository,
  type AssetStatus,
  type StatusTransition
} from '../data/asset-repo.js';
import { isActiveJobStatus, type Job, type JobRepository, type JobStatus, type JobType } from '../data/job-repo.js';

// The state an asset held immediately before it entered `processing`: the `from`
// of the most recent transition INTO `processing` in its append-only status
// history. Undefined when the asset has no recorded `-> processing` transition
// (it was seeded straight into `processing`, or the history predates the entry),
// which is why every caller needs a fallback. Exactly the shape of
// `restoreTargetStatus` (src/data/asset-repo.ts), which resolves the pre-archive
// state the same way.
export function priorStatusBeforeProcessing(
  history: readonly StatusTransition[]
): AssetStatus | undefined {
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i].to === 'processing') {
      return history[i].from ?? undefined;
    }
  }
  return undefined;
}

export type AssetStateAfterTerminalJobInput = {
  // The asset's CURRENT lifecycle status.
  current: AssetStatus;
  // The job's FINAL status. Only terminal values move an asset.
  jobStatus: JobStatus;
  // What kind of work the job did. This decides the fallback in clause 3: a job
  // that was PRODUCING the asset's source bytes and did not finish leaves no
  // usable source, whereas a job that merely READ them leaves the asset exactly
  // as it was.
  jobType: JobType;
  // Whether the asset already carries registered renditions.
  hasRenditions: boolean;
  // The asset's append-only status history, used to recover its prior state.
  statusHistory: readonly StatusTransition[];
};

// Resolve the status an asset should hold now that one of its jobs is terminal,
// or undefined when it should not be moved at all. Pure, so the rule can be
// asserted without repositories.
export function assetStateAfterTerminalJob(
  input: AssetStateAfterTerminalJobInput
): AssetStatus | undefined {
  // Only a terminal job recomputes anything: a job that is still
  // pending/queued/running is precisely why the asset is `processing`.
  if (isActiveJobStatus(input.jobStatus)) {
    return undefined;
  }
  // `processing` is the ONE state a settling job releases. Anything else is a
  // state some other writer owns — `ready`/`failed` are already settled,
  // `uploading` belongs to the upload path, `archived` is terminal and its
  // transition table is empty.
  if (input.current !== 'processing') {
    return undefined;
  }

  // 1. Registered output wins: the asset is servable.
  if (input.hasRenditions) {
    return 'ready';
  }
  // 2. The asset follows a failed job.
  if (input.jobStatus === 'failed') {
    return 'failed';
  }
  // 3. Back to where it came from, when that is still reachable. `processing`
  //    itself is excluded explicitly: isValidTransition treats a same-status
  //    move as a legal no-op, which would leave the asset exactly where #1227
  //    says it must not stay. `archived` is excluded because a job settling must
  //    never soft-delete an asset.
  const prior = priorStatusBeforeProcessing(input.statusHistory);
  if (
    prior !== undefined &&
    prior !== 'processing' &&
    prior !== 'archived' &&
    isValidTransition('processing', prior)
  ) {
    return prior;
  }
  // No usable prior state. Fall back on what the job was doing to the asset:
  //   - `ingest-url` was WRITING the asset's source bytes. It ended without
  //     delivering them, so there is nothing to serve -> `failed` (the same
  //     state the abandoned-upload sweep and the interrupted-ingest reconciler
  //     settle an incomplete ingest to).
  //   - `transcode` / `package` only READ the source, which was a precondition
  //     of the job and is untouched by it ending -> `ready`, i.e. reusable and
  //     retryable. This is the state #1226's late-completion reclaim already
  //     releases a cancelled transcode's source to.
  return input.jobType === 'ingest-url' ? 'failed' : 'ready';
}

// Why a recompute did (or did not) move the asset. Returned rather than logged
// so each call site can log one explicit line in its own voice, and so the rule
// is assertable.
export type AssetStateRecomputeOutcome =
  // The asset was moved; `status` holds its new state.
  | 'applied'
  // The job is not terminal yet, so the asset is legitimately `processing`.
  | 'job-not-terminal'
  // The job's asset no longer exists (deleted/purged under the job).
  | 'asset-unknown'
  // The asset is not `processing`: some other writer owns its state.
  | 'asset-not-processing'
  // Another job is still active on the asset; it will recompute when it ends.
  | 'other-jobs-active'
  // The asset write itself failed (store unreachable, invalid transition). The
  // asset is left as it was; never thrown at the caller.
  | 'write-failed';

export type AssetStateRecompute = {
  outcome: AssetStateRecomputeOutcome;
  // The asset's status after the recompute, present only on 'applied'.
  status?: AssetStatus;
  // The error text behind a 'write-failed' outcome.
  error?: string;
};

export type RecomputeAssetStateDeps = {
  assets: AssetRepository;
  jobs: JobRepository;
  // Best-effort warn sink for a failed asset write. Optional; absent => the
  // failure is reported only through the returned result.
  logWarn?: (detail: Record<string, unknown>) => void;
};

// Apply the rule above for ONE job that has just reached a terminal state.
//
// Idempotent and non-throwing: a redelivered completion, a repeated cancel, or a
// second call for the same job finds the asset already out of `processing` and
// reports 'asset-not-processing' without writing. Callers pass the job record as
// it stands AFTER their terminal write, so the asset is recomputed from the
// job's FINAL state (#1227) rather than from the state it had on the way in.
export async function recomputeAssetStateAfterTerminalJob(
  job: Pick<Job, 'id' | 'type' | 'status' | 'assetId'>,
  deps: RecomputeAssetStateDeps,
  // The asset to recompute. Defaults to the job's own `assetId`, which is the
  // SOURCE asset for a transcode job (src/data/job-repo.ts `Job.assetId`).
  assetId: string = job.assetId
): Promise<AssetStateRecompute> {
  if (isActiveJobStatus(job.status)) {
    return { outcome: 'job-not-terminal' };
  }
  if (!assetId) {
    return { outcome: 'asset-unknown' };
  }

  const asset = await deps.assets.get(assetId).catch(() => undefined);
  if (!asset) {
    return { outcome: 'asset-unknown' };
  }
  if (asset.status !== 'processing') {
    return { outcome: 'asset-not-processing' };
  }

  // The asset stays `processing` while anything else is still working on it.
  // This job is excluded by id: a caller that has just written the terminal
  // state would otherwise race its own record through a backend that has not
  // caught up.
  const stillActive = (await deps.jobs.findActiveByAssetId(assetId).catch(() => [])).filter(
    (other) => other.id !== job.id
  );
  if (stillActive.length > 0) {
    return { outcome: 'other-jobs-active' };
  }

  const next = assetStateAfterTerminalJob({
    current: asset.status,
    jobStatus: job.status,
    jobType: job.type,
    hasRenditions: (asset.renditions?.length ?? 0) > 0,
    statusHistory: asset.statusHistory ?? []
  });
  if (next === undefined || next === asset.status) {
    return { outcome: 'asset-not-processing' };
  }

  try {
    const updated = await deps.assets.update(assetId, {
      status: next,
      // #1085: name the settle on the appended history entry, so an asset that
      // left `processing` because its job was cancelled is distinguishable from
      // one that left because the transcode completed.
      statusReason: `job ${job.id} ${job.status}`
    });
    return { outcome: 'applied', status: updated?.status ?? next };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    deps.logWarn?.({
      msg: 'could not recompute asset state after its job reached a terminal state',
      jobId: job.id,
      jobStatus: job.status,
      assetId,
      targetStatus: next,
      error
    });
    return { outcome: 'write-failed', error };
  }
}
