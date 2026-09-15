// Unit test for completeTranscode surfacing the produced renditions on its
// result (issue #693, ADR-022).
//
// The encode-completion event emitter (src/routes/internal.ts) needs the
// codec / height / width / bitrateBps of the produced variant to build the
// #691 payload's optional companions. Rather than re-derive these from the raw
// Encore output, completeTranscode returns the SAME embedded Rendition list it
// persisted on the source asset. These tests pin that the result now carries
// `renditions`, and that a duplicate / failure apply carries an empty list.
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - completeTranscode / CompleteTranscodeResult (now with `renditions`) —
//     src/pipeline/transcode.ts:181-276.
//   - Rendition shape {codec,height,width,bitrateBps} — src/data/asset-repo.ts.
//   - InMemoryJobRepository / InMemoryAssetRepository — src/data/*.

import { describe, it, expect } from 'vitest';

import { completeTranscode, type CallbackRendition } from './transcode.js';
import { InMemoryJobRepository } from '../data/job-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';

// Build a `running` transcode job over a `processing` source asset — the state
// a job is in when the Encore success callback lands.
async function runningTranscode() {
  const jobs = new InMemoryJobRepository();
  const assets = new InMemoryAssetRepository();
  const asset = await assets.create({ name: 'clip' });
  await assets.update(asset.id, { status: 'processing' });
  const job = await jobs.create({ type: 'transcode', assetId: asset.id, profile: 'program' });
  await jobs.update(job.id, { status: 'queued' });
  await jobs.update(job.id, { status: 'running' });
  return { jobs, assets, jobId: job.id, assetId: asset.id };
}

const rendition1080: CallbackRendition = {
  label: 'rendition-1',
  width: 1920,
  height: 1080,
  objectKey: 'transcode/asset/job/1080.mp4',
  codec: 'h264',
  bitrateBps: 5_000_000
};

describe('completeTranscode surfaces produced renditions (issue #693)', () => {
  it('returns the recorded renditions with codec/height/width/bitrate on success', async () => {
    const { jobs, assets, jobId, assetId } = await runningTranscode();

    const result = await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: [rendition1080] },
      { jobs, assets }
    );

    expect(result.applied).toBe(true);
    expect(result.renditionCount).toBe(1);
    expect(result.renditions).toHaveLength(1);
    const [variant] = result.renditions;
    expect(variant.codec).toBe('h264');
    expect(variant.height).toBe(1080);
    expect(variant.width).toBe(1920);
    expect(variant.bitrateBps).toBe(5_000_000);
  });

  it('returns an empty renditions list on a failure apply', async () => {
    const { jobs, assets, jobId, assetId } = await runningTranscode();

    const result = await completeTranscode(
      { jobId, sourceAssetId: assetId, success: false, error: 'boom', renditions: [] },
      { jobs, assets }
    );

    expect(result.applied).toBe(true);
    expect(result.renditions).toEqual([]);
  });

  it('returns an empty renditions list on a duplicate (already-terminal) callback', async () => {
    const { jobs, assets, jobId, assetId } = await runningTranscode();

    const first = await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: [rendition1080] },
      { jobs, assets }
    );
    expect(first.applied).toBe(true);

    // A redelivered callback for the now-`done` job no-ops.
    const dup = await completeTranscode(
      { jobId, sourceAssetId: assetId, success: true, renditions: [rendition1080] },
      { jobs, assets }
    );
    expect(dup.applied).toBe(false);
    expect(dup.renditions).toEqual([]);
  });
});
