// A late SUCCESSFUL Encore completion on a CANCELLED transcode job (#1226).
//
// Reported state: 'applied encore completion ... status SUCCESSFUL applied false
// renditionCount 0' while the bucket held a complete output (5 video renditions
// plus audio). The job stayed CANCELLED with 0 renditions and the asset stayed
// PROCESSING, so the job record, the rendition count and the files on disk all
// disagreed.
//
// The implemented rule is CANCEL WINS: the completion is discarded, the stopped
// run's output is reclaimed from the output bucket, the discard is recorded
// durably on the job, and the source asset is released from `processing`. The
// rationale is in src/pipeline/cancelled-transcode-completion.ts.
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - `completeTranscode(params, deps)` + `CompleteTranscodeResult`
//     (`applied` / `renditionCount`), the `resolveOutputStorage` /
//     `onCancelledCompletionDiscarded` / `logWarn` deps, and
//     `transcodeOutputPrefix(sourceAssetId, jobId)` — src/pipeline/transcode.ts.
//   - `reclaimCancelledTranscodeCompletion` / `CancelledJobOutputStorage`
//     (`removeObjectsUnderPrefix(prefix: string): Promise<void>`, the
//     WorkspaceStorage method it mirrors — src/data/storage.ts) —
//     src/pipeline/cancelled-transcode-completion.ts.
//   - `Job.status` / `ALLOWED_JOB_TRANSITIONS` (`cancelled: []`) and the
//     `lateCompletionDiscarded` / `discardedRenditionCount` /
//     `discardedOutputPrefix` record fields — src/data/job-repo.ts.
//   - `InMemoryJobRepository` / `InMemoryAssetRepository` and
//     `ALLOWED_TRANSITIONS` (`processing -> ready`) — src/data/job-repo.ts,
//     src/data/asset-repo.ts.

import { describe, it, expect } from 'vitest';

import { completeTranscode, transcodeOutputPrefix, type CallbackRendition } from './transcode.js';
import type {
  CancelledCompletionReclaim,
  CancelledJobOutputStorage
} from './cancelled-transcode-completion.js';
import { InMemoryJobRepository } from '../data/job-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';

// A transcode job the user cancelled while its source asset was `processing` —
// the exact state job-n0z0hqtr6yx4 was in when its completion arrived.
async function cancelledTranscode() {
  const jobs = new InMemoryJobRepository();
  const assets = new InMemoryAssetRepository();
  const asset = await assets.create({ name: 'clip' });
  await assets.update(asset.id, { status: 'processing' });
  const job = await jobs.create({ type: 'transcode', assetId: asset.id, profile: 'program' });
  await jobs.update(job.id, { status: 'queued' });
  await jobs.update(job.id, { status: 'running' });
  // What DELETE /api/v1/jobs/:id writes (src/routes/jobs.ts).
  await jobs.update(job.id, { status: 'cancelled', error: 'cancelled by operator' });
  return { jobs, assets, jobId: job.id, assetId: asset.id };
}

// Records the prefixes a reclaim asked to remove.
function recordingStorage(): CancelledJobOutputStorage & { removed: string[] } {
  const removed: string[] = [];
  return {
    removed,
    async removeObjectsUnderPrefix(prefix: string) {
      removed.push(prefix);
    }
  };
}

// Collects what the reclaim reported through completeTranscode's
// `onCancelledCompletionDiscarded` dep.
function reclaimCollector(): { seen: CancelledCompletionReclaim[]; last(): CancelledCompletionReclaim | undefined } {
  const seen: CancelledCompletionReclaim[] = [];
  return { seen, last: () => seen[seen.length - 1] };
}

// Five video renditions, as the reported completion carried.
const fiveRenditions: CallbackRendition[] = [1080, 720, 540, 360, 234].map((height, i) => ({
  label: `rendition-${i + 1}`,
  width: Math.round((height * 16) / 9),
  height,
  objectKey: `transcode/asset/job/${height}.mp4`,
  codec: 'h264',
  bitrateBps: 1_000_000
}));

describe('late SUCCESSFUL completion on a cancelled job (#1226)', () => {
  it('keeps the job cancelled, reclaims the output and records the discard so job, renditionCount and files agree', async () => {
    const { jobs, assets, jobId, assetId } = await cancelledTranscode();
    const storage = recordingStorage();
    const reclaims = reclaimCollector();

    const result = await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: fiveRenditions },
      {
        jobs,
        assets,
        resolveOutputStorage: async () => storage,
        onCancelledCompletionDiscarded: (r) => reclaims.seen.push(r)
      }
    );

    // No transcode terminal state was applied: the cancel stands.
    expect(result.applied).toBe(false);
    expect(result.renditionCount).toBe(0);
    expect(result.renditions).toEqual([]);

    // The output of the stopped run was removed, under the SAME prefix the
    // submit path told Encore to write to.
    const prefix = transcodeOutputPrefix(assetId, jobId);
    expect(storage.removed).toEqual([prefix]);
    expect(reclaims.seen).toHaveLength(1);
    expect(reclaims.last()?.outputRemoved).toBe(true);
    expect(reclaims.last()?.outputPrefix).toBe(prefix);
    expect(reclaims.last()?.discardedRenditionCount).toBe(5);

    // The job record agrees with the (now absent) files, and says why.
    const job = await jobs.get(jobId);
    expect(job?.status).toBe('cancelled');
    expect(job?.lateCompletionDiscarded).toBe(true);
    expect(job?.discardedRenditionCount).toBe(5);
    expect(job?.discardedOutputPrefix).toBe(prefix);

    // No renditions were registered, and the asset no longer sits PROCESSING
    // with nothing running.
    const asset = await assets.get(assetId);
    expect(asset?.renditions ?? []).toHaveLength(0);
    expect(asset?.status).toBe('ready');
  });

  it('records the discard (and the reason it could not clean up) when the stack has no object storage', async () => {
    const { jobs, assets, jobId, assetId } = await cancelledTranscode();
    const reclaims = reclaimCollector();

    const result = await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: fiveRenditions },
      {
        jobs,
        assets,
        resolveOutputStorage: async () => undefined,
        onCancelledCompletionDiscarded: (r) => reclaims.seen.push(r)
      }
    );

    expect(result.applied).toBe(false);
    expect(reclaims.last()?.outputRemoved).toBe(false);
    expect(reclaims.last()?.removalError).toBeTruthy();

    // The prefix is still on the record, so an operator knows what to reclaim.
    const job = await jobs.get(jobId);
    expect(job?.status).toBe('cancelled');
    expect(job?.lateCompletionDiscarded).toBe(true);
    expect(job?.discardedOutputPrefix).toBe(transcodeOutputPrefix(assetId, jobId));
  });

  it('never throws when the object removal fails — the discard is still recorded', async () => {
    const { jobs, assets, jobId, assetId } = await cancelledTranscode();
    const warnings: Record<string, unknown>[] = [];
    const reclaims = reclaimCollector();

    await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: fiveRenditions },
      {
        jobs,
        assets,
        resolveOutputStorage: async () => ({
          async removeObjectsUnderPrefix() {
            throw new Error('storage unreachable');
          }
        }),
        onCancelledCompletionDiscarded: (r) => reclaims.seen.push(r),
        logWarn: (detail) => warnings.push(detail)
      }
    );

    expect(reclaims.last()?.outputRemoved).toBe(false);
    expect(reclaims.last()?.removalError).toBe('storage unreachable');
    expect(warnings).toHaveLength(1);
    const job = await jobs.get(jobId);
    expect(job?.status).toBe('cancelled');
    expect(job?.lateCompletionDiscarded).toBe(true);
  });

  it('leaves the asset PROCESSING while another job is still active on it', async () => {
    const { jobs, assets, jobId, assetId } = await cancelledTranscode();
    // A second transcode of the same source is genuinely running.
    const other = await jobs.create({ type: 'transcode', assetId, profile: 'program' });
    await jobs.update(other.id, { status: 'queued' });
    await jobs.update(other.id, { status: 'running' });

    await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: fiveRenditions },
      { jobs, assets, resolveOutputStorage: async () => recordingStorage() }
    );

    const asset = await assets.get(assetId);
    expect(asset?.status).toBe('processing');
  });

  it('reclaims the output even when the completion reported none (Encore document unreachable)', async () => {
    const { jobs, assets, jobId, assetId } = await cancelledTranscode();
    const storage = recordingStorage();
    const reclaims = reclaimCollector();

    await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: [] },
      {
        jobs,
        assets,
        resolveOutputStorage: async () => storage,
        onCancelledCompletionDiscarded: (r) => reclaims.seen.push(r)
      }
    );

    // The poller completes as SUCCESSFUL with no renditions when it cannot
    // fetch the Encore job document, so a reported count of 0 is no proof that
    // nothing was written.
    expect(storage.removed).toEqual([transcodeOutputPrefix(assetId, jobId)]);
    expect(reclaims.last()?.discardedRenditionCount).toBe(0);
  });
});
