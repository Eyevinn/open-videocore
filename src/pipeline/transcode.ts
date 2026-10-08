// Transcode orchestration (issue #8).
//
// Two operations live here, both pure of HTTP concerns so the routes stay thin
// and the logic is unit-testable:
//
//   submitTranscode  — resolve the profile, create a TranscodeJob, advance the
//                       source asset to `processing`, and submit to Encore. The
//                       Encore job id we issue (encodeEncoreJobId) embeds the
//                       workspace + job id so the unauthenticated callback can
//                       resolve them later.
//
//   completeTranscode — invoked from the internal Encore callback. Idempotently
//                       marks the job done/failed; on success records the
//                       produced renditions as EMBEDDED variants on the single
//                       source asset (issue #79 — no child assets) and returns
//                       the source to `ready`.
//
// Idempotency: the callback listener may deliver more than once. completeTranscode
// no-ops if the job is already terminal, so duplicate callbacks never record
// duplicate renditions.
//
// Profile selection (issue #1022): a transcode selects its encoding ladder by
// NAME only. The upstream job document has no inline-profile/outputs field
// (`EncoreJob`: profile: String, profileParams, outputFolder, baseName, inputs —
// github.com/svt/encore, encore-common/.../model/EncoreJob.kt:52-180, fetched
// 2026-10-05) and the name is resolved server-side against the profile index
// (`ProfileService.getProfile`, .../service/profile/ProfileService.kt). So the
// submitted profile is a single string, resolved once as `submittedProfile`
// below and used for BOTH the job record and the submit — they can no longer
// disagree.

import { ulid } from 'ulid';
import { isValidTransition, type AssetRepository, type Rendition } from '../data/asset-repo.js';
import {
  encodeEncoreJobId,
  type JobRepository
} from '../data/job-repo.js';
import type { EncoreClient } from './encore-client.js';
import { BURN_IN_PROFILE_PARAM_KEY } from './burn-in.js';
import { emitAudit, originActor, type AuditEmitter, type AuditErrorLog } from '../data/audit-emit.js';
import { logPipelineEvent, type PipelineLogSink } from '../services/pipeline-log.js';

export const PACKAGED_OUTPUT_PREFIX = 'transcode';

// Profile submitted when a caller names none. 'program' is the conventional
// entry of the default Encore profile index this API bootstraps from
// (src/services/profile-bootstrap.ts), so it is the only name likely to resolve
// on a freshly-seeded deployment. Exported so the routes record/validate the
// same default the submit path uses (issue #1022).
export const DEFAULT_PROFILE_NAME = 'program';

export type SubmitTranscodeParams = {
  // Context token embedded in the encoreJobId so the unauthenticated Encore
  // callback + the auto-scaler's Valkey pool keying can resolve the job. This is
  // the fixed deployment context, not a request-derived workspace.
  workspaceId: string;
  sourceAssetId: string;
  sourceObjectKey: string;
  // Profile name forwarded verbatim to Encore (server-side named profile).
  // When omitted, DEFAULT_PROFILE_NAME is submitted. Whatever this resolves to
  // is BOTH what is sent to Encore and what is recorded on the job document
  // (`Job.profile`) — see `submittedProfile` below (issue #1022).
  preset?: string;
  // Flat string map forwarded verbatim into the Encore job document's
  // `profileParams` object (issue #287). Encore evaluates these as SpEL
  // expression properties within the named profile (e.g. crf, preset, height,
  // keyframes for `x264-crf-parametrized`). Omitting it preserves the profile's
  // default output. Verified shape: SVT Encore `EncoreJob.profileParams`
  // (github.com/svt/encore, encore-common/.../model/EncoreJob.kt).
  profileParams?: Record<string, string>;
  // Per-request burn-in filter (issue #388, ADR-014 D3). When set, this is the
  // fully-resolved FFmpeg `subtitles=<key>[:force_style='...']` string built by
  // src/pipeline/burn-in.ts. It is threaded into the Encore job's
  // `profileParams` under the `subtitlesFilter` SpEL key
  // (BURN_IN_PROFILE_PARAM_KEY), so a burn-in-capable server-side profile's
  // VideoEncode `filters` list can reference it via
  // `#{profileParams['subtitlesFilter']?:''}`. Omitting it => no burn-in filter
  // (clean rendition), so a single submission can mix burned and clean profiles
  // and existing transcodes are unaffected.
  burnInSubtitlesFilter?: string;
  // S3 bucket names so we can build the s3:// URIs Encore reads/writes.
  sourceBucket: string;
  outputBucket: string;
};

export type SubmitTranscodeResult = {
  jobId: string;
  encoreJobId: string;
};

// Resolve, persist, and submit a transcode job. Returns the local job id and
// the Encore job id (our correlation key). Throws if Encore submission fails,
// after marking the job failed and reverting the source asset.
export async function submitTranscode(
  params: SubmitTranscodeParams,
  deps: {
    jobs: JobRepository;
    assets: AssetRepository;
    encore: EncoreClient;
    // Best-effort audit emission (issue #564). Optional so existing callers /
    // tests that do not assert audit are unaffected; when absent, emission is a
    // no-op. A failed audit write is logged, never propagated.
    audit?: AuditEmitter;
    auditLog?: AuditErrorLog;
    // Best-effort operational log emission (issue #995). Optional, exactly like
    // `audit` above: when absent no log record is appended and behaviour is
    // unchanged. Wired to the log store that backs GET /api/v1/logs
    // (src/main.ts, `logStore`).
    pipelineLog?: PipelineLogSink;
  }
): Promise<SubmitTranscodeResult> {
  // THE profile this submission uses. Resolved exactly ONCE, here, and then
  // reused verbatim for the job record, the audit entry, the operational log and
  // the Encore submit below — so the recorded profile can never disagree with
  // the submitted one (issue #1022: `job.profile` used to be written from this
  // default while a `customProfile.name` was what actually reached Encore, so a
  // job document reported a profile that was never submitted).
  const submittedProfile = params.preset ?? DEFAULT_PROFILE_NAME;

  // Create the job first so we have a local id to embed in the Encore job id.
  const job = await deps.jobs.create({
    type: 'transcode',
    assetId: params.sourceAssetId,
    profile: submittedProfile
  });

  // Audit: transcode job submitted (issue #564). One entry, targetId = the new
  // job id. `system` origin — this is a pipeline-initiated job. Emitted right
  // after the durable job record exists (the meaningful submission moment) and
  // BEFORE the fallible Encore enqueue, so the audit trail records the
  // submission regardless of the downstream Encore result.
  emitAudit(
    deps.audit,
    {
      actor: originActor('system'),
      action: 'job.submitted',
      targetType: 'job',
      targetId: job.id,
      detail: { jobType: 'transcode', assetId: params.sourceAssetId, profile: submittedProfile }
    },
    deps.auditLog
  );

  // Operational log: the `transcode` stage started (issue #995). Emitted at the
  // SAME point as the audit entry above — the moment the durable job record
  // exists — so the Logs tab shows the stage beginning even if the Encore enqueue
  // below then fails.
  logPipelineEvent(
    deps.pipelineLog,
    {
      stage: 'transcode',
      level: 'info',
      message: `submitted job ${job.id} for asset ${params.sourceAssetId} with profile ${submittedProfile}`
    },
    deps.auditLog
  );

  const encoreJobId = encodeEncoreJobId(params.workspaceId, job.id);
  // OSC provides structural tenant isolation (ADR-003): the deployment owns a
  // single bucket namespace, so the s3:// URIs use the object key directly with
  // no workspace prefix.
  const inputUri = `s3://${params.sourceBucket}/${params.sourceObjectKey}`;
  const outputUri = `s3://${params.outputBucket}/${PACKAGED_OUTPUT_PREFIX}/${params.sourceAssetId}/${job.id}`;

  // Record the encore job id and mark the job `queued`: submitTranscode only
  // enqueues the job onto the Encore auto-scaler's Redis queue (ADR-006); the
  // job is not actually running on an Encore instance until the scaler loop
  // dispatches it. The scaler's onDispatched callback advances the job to
  // `running` (and the source asset to `processing`) at dispatch time. We set
  // the encoreJobId before submit so a callback that races back can resolve the
  // job.
  await deps.jobs.update(job.id, { encoreJobId, status: 'queued' });

  let encoreInternalJobId: string | undefined;
  try {
    // progressCallbackUri is injected by the scaler at dispatch time, pointing
    // at the callback listener paired with the chosen Encore instance (ADR-006),
    // so it is not set here.
    // Burn-in opt-in (issue #388, ADR-014 D3): merge the resolved subtitles
    // filter into profileParams under the `subtitlesFilter` SpEL key so the
    // selected profile's VideoEncode filters can pick it up. This is additive —
    // when no burn-in was requested the key is absent and the profile's default
    // (`''`) applies, so the rendition carries NO subtitles filter (clean).
    const profileParams = params.burnInSubtitlesFilter
      ? { ...(params.profileParams ?? {}), [BURN_IN_PROFILE_PARAM_KEY]: params.burnInSubtitlesFilter }
      : params.profileParams;
    // `submittedProfile` is the SAME value recorded on the job document above
    // (issue #1022), so `Job.profile` always names the profile Encore was asked
    // for. EncoreSubmitInput.profile is a name string resolved server-side
    // (src/pipeline/encore-client.ts:29-30).
    const result = await deps.encore.submit({ externalId: encoreJobId, inputUri, outputUri, profile: submittedProfile, profileParams, progressCallbackUri: undefined });
    encoreInternalJobId = result.encoreInternalId || undefined;
    if (encoreInternalJobId) {
      await deps.jobs.update(job.id, { encoreInternalJobId });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.jobs.update(job.id, { status: 'failed', error: message });
    // Operational log: the submission itself was rejected (issue #995). This
    // point has no audit entry (the audit trail records the submission, then the
    // terminal state from the callback), but for an operator reading the Logs tab
    // a submit-time rejection is the whole story of the run — it never reaches a
    // callback, so without this entry the stage would appear to have started and
    // then gone silent.
    logPipelineEvent(
      deps.pipelineLog,
      {
        stage: 'transcode',
        level: 'error',
        message: `job ${job.id} for asset ${params.sourceAssetId} could not be submitted: ${message}`
      },
      deps.auditLog
    );
    // Best-effort revert: the source could not be transcoded. Under ADR-006 the
    // submit only ENQUEUES the job on the scaler's local queue and does NOT move
    // the source out of `ready` (the scaler's onDispatched advances it to
    // `processing` at dispatch time). So on a submit-time rejection the asset is
    // usually still `ready`, and the asset state machine forbids `ready -> failed`
    // (ALLOWED_TRANSITIONS in src/data/asset-repo.ts:34-40). Only move the asset to
    // `failed` when that transition is legal from its CURRENT state (i.e. it was
    // already advanced to `processing`); otherwise the failure belongs solely to
    // the job just marked `failed` above and the source stays `ready` (reusable /
    // retryable). Guarding here also prevents the InvalidStateTransitionError from
    // masking the real Encore error we rethrow below.
    const source = await deps.assets.get(params.sourceAssetId);
    if (source && isValidTransition(source.status, 'failed')) {
      await deps.assets.update(params.sourceAssetId, { status: 'failed' });
    }
    throw err;
  }

  return { jobId: job.id, encoreJobId };
}

// One produced rendition as reported by the Encore callback payload.
export type CallbackRendition = {
  label: string;
  width: number;
  height: number;
  objectKey: string;
  codec?: string;
  bitrateBps?: number;
};

export type CompleteTranscodeParams = {
  jobId: string;
  sourceAssetId: string;
  // 'SUCCESSFUL' | 'FAILED' from Encore's status, normalised by the route.
  success: boolean;
  error?: string;
  renditions: CallbackRendition[];
  // Reversible drop-detection settle (#709). Set true ONLY by the scaler's
  // gone-from-active-set drop path (settleFailedTranscode reason
  // 'gone-from-active-set'). Meaningful only on a failure write (success:false):
  // it stamps `droppedByScaler` on the job so the resulting `failed` state is
  // CONDITIONAL — a genuine SUCCESSFUL callback arriving afterwards can still
  // correct the job to `done`. Absent/false => a normal unconditional terminal
  // failure (e.g. an Encore-reported error) that is never overridden.
  conditionalDrop?: boolean;
};

export type CompleteTranscodeResult = {
  // false when the job was already terminal (duplicate callback) and we no-oped.
  applied: boolean;
  // Number of embedded renditions recorded on the source asset (issue #79).
  renditionCount: number;
  // The embedded renditions recorded on the source asset on a successful apply
  // (issue #79). Surfaced here so the caller (the internal Encore callback,
  // src/routes/internal.ts) can derive the encode-completion event's
  // codec/height/width/bitrateBps companions from the SAME rendition list that
  // was persisted, rather than re-deriving them from the raw Encore output
  // (issue #693, ADR-022). Empty on a failure / no-op apply.
  renditions: Rendition[];
};

// Apply an Encore completion to the job + source asset. Idempotent: a second
// call for an already-terminal job no-ops. On success, builds one embedded
// Rendition per produced variant (issue #79 — no child assets) and records the
// list on the SINGLE source asset, then returns it to `ready`.
export async function completeTranscode(
  params: CompleteTranscodeParams,
  deps: {
    jobs: JobRepository;
    assets: AssetRepository;
    // Best-effort audit emission (issue #564). Optional; when absent, no-op.
    audit?: AuditEmitter;
    auditLog?: AuditErrorLog;
    // Best-effort operational log emission (issue #995). Optional; when absent,
    // no-op. See submitTranscode's identical dep.
    pipelineLog?: PipelineLogSink;
  }
): Promise<CompleteTranscodeResult> {
  const job = await deps.jobs.get(params.jobId);
  if (!job) {
    return { applied: false, renditionCount: 0, renditions: [] };
  }
  // Reversible drop-detection correction (#709). A job settled `failed` by the
  // scaler's gone-from-active-set drop path carries `droppedByScaler === true`:
  // that `failed` state is a CONDITIONAL inference (the job vanished from Encore's
  // live set with no completion, ADR-016), NOT proof the encode failed. If a
  // genuine SUCCESSFUL callback then arrives (out of order — e.g. the completion
  // message was delayed past the reconcile drop window), we allow it to override
  // the conditional failure and drive the job to `done` so the pipeline resumes
  // (package / playback URL). This is the ONLY exception to first-terminal-write-
  // wins: it is gated strictly on `droppedByScaler` AND `success`, so a genuine
  // Encore-error `failed` (flag absent) is never overridden, and a redelivered
  // FAILED callback for a dropped job still no-ops.
  const isConditionalDropFailed =
    job.status === 'failed' && job.droppedByScaler === true;
  if (job.status === 'done' || job.status === 'cancelled') {
    // Duplicate / late callback, or the job was cancelled by an operator: nothing
    // to do. `cancelled` is terminal (src/data/job-repo.ts:103), so short-circuit
    // here to keep a late Encore callback idempotent — attempting an update would
    // otherwise throw InvalidJobTransitionError (issue #126). No audit entry: a
    // no-op / already-terminal callback is not a fresh terminal transition.
    return { applied: false, renditionCount: 0, renditions: [] };
  }
  if (job.status === 'failed' && !(isConditionalDropFailed && params.success)) {
    // Terminal `failed`: no-op UNLESS this is a SUCCESSFUL callback correcting a
    // conditional drop-detection failure (handled below). A genuine Encore-error
    // failure, or a redelivered FAILED callback for a dropped job, stops here so
    // first-terminal-write-wins is preserved for real failures.
    return { applied: false, renditionCount: 0, renditions: [] };
  }

  if (!params.success) {
    await deps.jobs.update(params.jobId, {
      status: 'failed',
      error: params.error ?? 'transcode failed',
      // #709: mark a gone-from-active-set drop settle as CONDITIONAL so a later
      // SUCCESSFUL callback can still correct it. An unconditional (Encore-error)
      // failure explicitly clears the flag so it can never be mistaken for a
      // reversible drop even if the same job id is somehow reused.
      droppedByScaler: params.conditionalDrop === true
    });
    await deps.assets.update(params.sourceAssetId, { status: 'failed' });
    // Audit: transcode job reached terminal `failed` (issue #564). One entry,
    // emitted only on the FIRST time the job transitions terminal (guarded by the
    // idempotency short-circuit above).
    emitAudit(
      deps.audit,
      {
        actor: originActor('system'),
        action: 'job.failed',
        targetType: 'job',
        targetId: job.id,
        detail: { jobType: 'transcode', assetId: params.sourceAssetId, error: params.error ?? 'transcode failed' }
      },
      deps.auditLog
    );
    // Operational log: terminal failure (issue #995). Same first-terminal-write
    // guard as the audit entry, so a duplicate/late callback appends nothing.
    logPipelineEvent(
      deps.pipelineLog,
      {
        stage: 'transcode',
        level: 'error',
        message: `job ${job.id} for asset ${params.sourceAssetId} failed: ${params.error ?? 'transcode failed'}`
      },
      deps.auditLog
    );
    return { applied: true, renditionCount: 0, renditions: [] };
  }

  // Success: build one self-contained embedded rendition per produced variant.
  const renditions: Rendition[] = params.renditions.map((r) => ({
    id: ulid(),
    label: r.label,
    width: r.width,
    height: r.height,
    objectKey: r.objectKey,
    codec: r.codec,
    bitrateBps: r.bitrateBps
  }));

  // Record renditions on the source and finalise the job.
  await deps.assets.update(params.sourceAssetId, { renditions });
  // The source asset itself returns to `ready` now that renditions exist.
  const refreshed = await deps.assets.get(params.sourceAssetId);
  if (refreshed?.status === 'processing') {
    await deps.assets.update(params.sourceAssetId, { status: 'ready' });
  } else if (refreshed?.status === 'failed') {
    // #709: a SUCCESSFUL callback is correcting a conditional-drop failure — the
    // drop settle had moved the source asset to `failed`. Recover it to `ready`
    // so it is usable again. The asset state machine forbids `failed -> ready`
    // directly (asset-repo.ts ALLOWED_TRANSITIONS) but allows `failed ->
    // processing -> ready`, so route through `processing` (the state the asset
    // legitimately held while its transcode was in flight) to reach `ready`.
    await deps.assets.update(params.sourceAssetId, { status: 'processing' });
    await deps.assets.update(params.sourceAssetId, { status: 'ready' });
  }
  // #1023: the failure text the conditional drop settle wrote (if any), captured
  // BEFORE it is cleared below so the audit entry can still carry it. On a job
  // that never hit drop-detection this is undefined and nothing changes.
  const clearedDropError = isConditionalDropFailed ? job.error : undefined;
  await deps.jobs.update(params.jobId, {
    status: 'done',
    progress: 100,
    // #709: a successful completion is a real terminal outcome — clear the
    // conditional-drop marker so the job is no longer flagged reversible.
    droppedByScaler: false,
    // #1023: ...and clear the failure text with it, in the SAME write. #709
    // corrected the status but left `error` in place, so a job that recovered
    // from a spurious drop settled `done` + `progress: 100` while still carrying
    // "dropped by Encore: gone from active set with no completion". That is a
    // terminal success that reads as a failure to every consumer of `error`, and
    // it poisons "find jobs with an error" triage with drops that recovered.
    // Applies to the whole success path, not just the correction: a job that ends
    // `done` carries no error message, whatever happened on the way there.
    clearError: true,
    // #1023: ...but the spurious drop must not vanish with the text. Record the
    // correction ON THE JOB RECORD, in this same write, so it is present on
    // EVERY correction path and in BOTH repository backends. The audit entry
    // below is NOT sufficient on its own: `deps.audit` is optional and the
    // callback poller (src/pipeline/encore-callback-poller.ts) applies
    // completions with only `{ jobs, assets }`, so emitAudit no-ops there and an
    // audit-only trace would exist for corrections observed by the internal
    // callback route and for nothing else. With these two fields a corrected
    // drop stays diagnosable — and so does a too-short reconcile grace period —
    // from the job record alone, however the correction arrived. Written only
    // when this completion actually corrected a conditional drop; a normal
    // completion leaves both fields absent.
    ...(isConditionalDropFailed
      ? {
          droppedThenRecovered: true,
          ...(clearedDropError ? { correctedDropError: clearedDropError } : {})
        }
      : {})
  });

  // Audit: transcode job reached terminal `done` (issue #564). One entry per
  // first terminal transition (duplicate callbacks are short-circuited above).
  emitAudit(
    deps.audit,
    {
      actor: originActor('system'),
      action: 'job.completed',
      targetType: 'job',
      targetId: job.id,
      detail: {
        jobType: 'transcode',
        assetId: params.sourceAssetId,
        renditionCount: renditions.length,
        // #1023: when this completion CORRECTED a conditional drop-detection
        // failure (#709), note that on the audit entry too — including the
        // failure text just cleared off the job — so the correction shows up in
        // the actor/timeline view an operator reads the audit trail for. This is
        // a SECOND copy of a diagnostic that already lives durably on the job
        // record (`droppedThenRecovered` / `correctedDropError` in the write
        // above), not the only copy: this entry is emitted only when a caller
        // wired `deps.audit`, which the callback poller does not. The audit
        // detail bag is deliberately free-form (src/data/audit-repo.ts
        // AuditDetailSchema), so these keys need no schema change. Omitted
        // entirely on a normal completion.
        ...(isConditionalDropFailed
          ? {
              correctedConditionalDrop: true,
              ...(clearedDropError ? { clearedDropError } : {})
            }
          : {})
      }
    },
    deps.auditLog
  );

  // Operational log: terminal success (issue #995). One entry per first terminal
  // transition, matching the audit entry above.
  logPipelineEvent(
    deps.pipelineLog,
    {
      stage: 'transcode',
      level: 'info',
      message: `job ${job.id} for asset ${params.sourceAssetId} completed with ${renditions.length} rendition(s)`
    },
    deps.auditLog
  );

  return { applied: true, renditionCount: renditions.length, renditions };
}
