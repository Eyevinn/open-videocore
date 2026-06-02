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
//                       marks the job done/failed; on success creates a child
//                       asset (status=ready, parentId=source) per produced
//                       rendition and records the renditions on the source.
//
// Idempotency: the callback listener may deliver more than once. completeTranscode
// no-ops if the job is already terminal, so duplicate callbacks never create
// duplicate child assets.

import type { AssetRepository, Rendition } from '../data/asset-repo.js';
import {
  encodeEncoreJobId,
  type JobRepository
} from '../data/job-repo.js';
import { resolveProfile, type EncoreProfile, type PresetName } from './encode-presets.js';
import type { EncoreClient } from './encore-client.js';

export const PACKAGED_OUTPUT_PREFIX = 'transcode';

export type SubmitTranscodeParams = {
  workspaceId: string;
  sourceAssetId: string;
  sourceObjectKey: string;
  preset?: PresetName;
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
  deps: { jobs: JobRepository; assets: AssetRepository; encore: EncoreClient; encoreCallbackUrl?: string }
): Promise<SubmitTranscodeResult> {
  const profile = resolveProfile(params.preset, params.customProfile);

  // Create the job first so we have a local id to embed in the Encore job id.
  const job = await deps.jobs.create(params.workspaceId, {
    type: 'transcode',
    assetId: params.sourceAssetId,
    profile: profile.name
  });

  const encoreJobId = encodeEncoreJobId(params.workspaceId, job.id);
  // Object keys are workspace-local; prefix the workspaceId so Encore reads/writes
  // from the right path in the shared bucket (matches WorkspaceStorage behaviour).
  const inputUri = `s3://${params.sourceBucket}/${params.workspaceId}/${params.sourceObjectKey}`;
  const outputUri = `s3://${params.outputBucket}/${params.workspaceId}/${PACKAGED_OUTPUT_PREFIX}/${params.sourceAssetId}/${job.id}`;

  // Record the encore job id and advance the job to running + the source asset
  // to processing before we submit, so a callback that races back finds a
  // resolvable job.
  await deps.jobs.update(params.workspaceId, job.id, { encoreJobId, status: 'running' });
  await deps.assets.update(params.workspaceId, params.sourceAssetId, { status: 'processing' });

  let encoreInternalJobId: string | undefined;
  try {
    // Use the stack's encore-callback-listener URL so Encore POSTs completions
    // to the listener, which then puts the result on the Redis queue our API reads.
    const progressCallbackUri = deps.encoreCallbackUrl
      ? `${deps.encoreCallbackUrl.replace(/\/$/, '')}/encoreCallback`
      : undefined;
    const result = await deps.encore.submit({ externalId: encoreJobId, inputUri, outputUri, profile, progressCallbackUri });
    encoreInternalJobId = result.encoreInternalId || undefined;
    if (encoreInternalJobId) {
      await deps.jobs.update(params.workspaceId, job.id, { encoreInternalJobId });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.jobs.update(params.workspaceId, job.id, { status: 'failed', error: message });
    // Best-effort revert: the source could not be transcoded.
    await deps.assets.update(params.workspaceId, params.sourceAssetId, { status: 'failed' });
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
};

export type CompleteTranscodeParams = {
  workspaceId: string;
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
  renditionAssetIds: string[];
};

// Apply an Encore completion to the job + assets. Idempotent: a second call for
// an already-terminal job no-ops. On success, creates one child asset per
// rendition (status=ready, parentId=source) and records them on the source.
export async function completeTranscode(
  params: CompleteTranscodeParams,
  deps: { jobs: JobRepository; assets: AssetRepository }
): Promise<CompleteTranscodeResult> {
  const job = await deps.jobs.get(params.workspaceId, params.jobId);
  if (!job) {
    return { applied: false, renditionAssetIds: [] };
  }
  if (job.status === 'done' || job.status === 'failed') {
    // Duplicate / late callback: nothing to do.
    return { applied: false, renditionAssetIds: job.renditionAssetIds ?? [] };
  }

  if (!params.success) {
    await deps.jobs.update(params.workspaceId, params.jobId, {
      status: 'failed',
      error: params.error ?? 'transcode failed'
    });
    await deps.assets.update(params.workspaceId, params.sourceAssetId, { status: 'failed' });
    return { applied: true, renditionAssetIds: [] };
  }

  // Success: materialise each rendition as a ready child asset of the source.
  const source = await deps.assets.get(params.workspaceId, params.sourceAssetId);
  const baseName = source?.name ?? params.sourceAssetId;
  const renditionAssetIds: string[] = [];
  const renditions: Rendition[] = [];

  for (const r of params.renditions) {
    const child = await deps.assets.create(params.workspaceId, {
      name: `${baseName} [${r.label}]`,
      parentId: params.sourceAssetId,
      objectKey: r.objectKey
    });
    // A freshly created asset is `uploading`; the rendition payload already
    // exists, so advance it straight to ready (uploading -> processing -> ready).
    await deps.assets.update(params.workspaceId, child.id, { status: 'processing' });
    await deps.assets.update(params.workspaceId, child.id, { status: 'ready' });
    renditionAssetIds.push(child.id);
    renditions.push({
      assetId: child.id,
      label: r.label,
      width: r.width,
      height: r.height,
      objectKey: r.objectKey
    });
  }

  // Record renditions on the source and finalise the job.
  await deps.assets.update(params.workspaceId, params.sourceAssetId, { renditions });
  // The source asset itself returns to `ready` now that renditions exist.
  const refreshed = await deps.assets.get(params.workspaceId, params.sourceAssetId);
  if (refreshed?.status === 'processing') {
    await deps.assets.update(params.workspaceId, params.sourceAssetId, { status: 'ready' });
  }
  await deps.jobs.update(params.workspaceId, params.jobId, {
    status: 'done',
    progress: 100,
    renditionAssetIds
  });

  return { applied: true, renditionAssetIds };
}
