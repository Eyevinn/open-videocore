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

import { ulid } from 'ulid';
import type { AssetRepository, Rendition } from '../data/asset-repo.js';
import {
  encodeEncoreJobId,
  type JobRepository
} from '../data/job-repo.js';
import type { EncoreProfile } from './encode-presets.js';
import type { EncoreClient } from './encore-client.js';

export const PACKAGED_OUTPUT_PREFIX = 'transcode';

export type SubmitTranscodeParams = {
  // Context token embedded in the encoreJobId so the unauthenticated Encore
  // callback + the auto-scaler's Valkey pool keying can resolve the job. This is
  // the fixed deployment context, not a request-derived workspace.
  workspaceId: string;
  sourceAssetId: string;
  sourceObjectKey: string;
  // Profile name forwarded verbatim to Encore (server-side named profile).
  preset?: string;
  customProfile?: EncoreProfile;
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
  deps: { jobs: JobRepository; assets: AssetRepository; encore: EncoreClient }
): Promise<SubmitTranscodeResult> {
  // Profile name forwarded verbatim to Encore. Falls back to 'program' —
  // the only profile guaranteed to exist in the default Encore test-profiles set.
  const profileName = params.preset ?? 'program';

  // Create the job first so we have a local id to embed in the Encore job id.
  const job = await deps.jobs.create({
    type: 'transcode',
    assetId: params.sourceAssetId,
    profile: profileName
  });

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
    const encoreProfile = params.customProfile ? params.customProfile.name : profileName;
    const result = await deps.encore.submit({ externalId: encoreJobId, inputUri, outputUri, profile: encoreProfile, progressCallbackUri: undefined });
    encoreInternalJobId = result.encoreInternalId || undefined;
    if (encoreInternalJobId) {
      await deps.jobs.update(job.id, { encoreInternalJobId });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.jobs.update(job.id, { status: 'failed', error: message });
    // Best-effort revert: the source could not be transcoded.
    await deps.assets.update(params.sourceAssetId, { status: 'failed' });
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
};

export type CompleteTranscodeResult = {
  // false when the job was already terminal (duplicate callback) and we no-oped.
  applied: boolean;
  // Number of embedded renditions recorded on the source asset (issue #79).
  renditionCount: number;
};

// Apply an Encore completion to the job + source asset. Idempotent: a second
// call for an already-terminal job no-ops. On success, builds one embedded
// Rendition per produced variant (issue #79 — no child assets) and records the
// list on the SINGLE source asset, then returns it to `ready`.
export async function completeTranscode(
  params: CompleteTranscodeParams,
  deps: { jobs: JobRepository; assets: AssetRepository }
): Promise<CompleteTranscodeResult> {
  const job = await deps.jobs.get(params.jobId);
  if (!job) {
    return { applied: false, renditionCount: 0 };
  }
  if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
    // Duplicate / late callback, or the job was cancelled by an operator: nothing
    // to do. `cancelled` is terminal (src/data/job-repo.ts:103), so short-circuit
    // here to keep a late Encore callback idempotent — attempting an update would
    // otherwise throw InvalidJobTransitionError (issue #126).
    return { applied: false, renditionCount: 0 };
  }

  if (!params.success) {
    await deps.jobs.update(params.jobId, {
      status: 'failed',
      error: params.error ?? 'transcode failed'
    });
    await deps.assets.update(params.sourceAssetId, { status: 'failed' });
    return { applied: true, renditionCount: 0 };
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
  }
  await deps.jobs.update(params.jobId, {
    status: 'done',
    progress: 100
  });

  return { applied: true, renditionCount: renditions.length };
}
