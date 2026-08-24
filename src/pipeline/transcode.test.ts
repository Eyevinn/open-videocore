// Pipeline-level unit tests for submitTranscode profileParams threading
// (issue #287).
//
// These assert the pure orchestration path (no HTTP) so they are unaffected by
// the pre-existing workspace-scoping / repo-signature drift that currently 409s
// the HTTP happy path in test/transcode.test.ts. We stub the JobRepository and
// EncoreClient with minimal fakes and verify that a supplied `profileParams`
// map reaches EncoreClient.submit verbatim, and that omitting it leaves the
// field undefined (backward compatible — Encore falls back to its `{}` default).

import { describe, it, expect, vi } from 'vitest';

import { submitTranscode } from './transcode.js';
import type { JobRepository } from '../data/job-repo.js';
import type { AssetRepository } from '../data/asset-repo.js';
import type { EncoreClient, EncoreSubmitInput } from './encore-client.js';

function fakeJobs(): JobRepository {
  const job = { id: 'job-1', status: 'created' } as unknown as Awaited<
    ReturnType<JobRepository['create']>
  >;
  return {
    create: vi.fn(async () => job),
    update: vi.fn(async () => job),
    get: vi.fn(async () => job),
    list: vi.fn(async () => ({ items: [], total: 0 })),
    findByEncoreJobId: vi.fn(async () => undefined)
  } as unknown as JobRepository;
}

function fakeEncore(): { encore: EncoreClient; submitted: EncoreSubmitInput[] } {
  const submitted: EncoreSubmitInput[] = [];
  const encore = {
    submit: vi.fn(async (input: EncoreSubmitInput) => {
      submitted.push(input);
      return { encoreInternalId: 'enc-1' };
    }),
    getJobStatus: vi.fn(),
    cancel: vi.fn()
  } as unknown as EncoreClient;
  return { encore, submitted };
}

const baseParams = {
  workspaceId: 'ctx',
  sourceAssetId: 'asset-1',
  sourceObjectKey: 'ingest/in.mp4',
  sourceBucket: 'src-bucket',
  outputBucket: 'out-bucket'
};

describe('submitTranscode profileParams threading (issue #287)', () => {
  it('forwards a supplied profileParams map verbatim to EncoreClient.submit', async () => {
    const jobs = fakeJobs();
    const { encore, submitted } = fakeEncore();
    const profileParams = { crf: '18', preset: 'slow', height: '720', keyframes: '48' };

    await submitTranscode(
      { ...baseParams, preset: 'x264-crf-parametrized', profileParams },
      { jobs, assets: {} as AssetRepository, encore }
    );

    expect(submitted).toHaveLength(1);
    expect(submitted[0].profile).toBe('x264-crf-parametrized');
    expect(submitted[0].profileParams).toEqual(profileParams);
  });

  it('leaves profileParams undefined when omitted (backward compatible default)', async () => {
    const jobs = fakeJobs();
    const { encore, submitted } = fakeEncore();

    await submitTranscode(
      { ...baseParams, preset: 'program' },
      { jobs, assets: {} as AssetRepository, encore }
    );

    expect(submitted[0].profileParams).toBeUndefined();
  });
});

// Burn-in filter threading (issue #388, ADR-014 D3). Per-rendition opt-in maps
// to Encore by injecting the resolved `subtitles=<key>[:force_style='...']`
// filter into the selected profile's VideoEncode filters via the
// `subtitlesFilter` profileParams SpEL key. These assert the pipeline threads
// that filter into the Encore submit payload's profileParams — and that a clean
// (no-burnIn) submission carries NO such key, so one submission can yield both a
// burned and a clean rendition.
describe('submitTranscode burn-in filter threading (issue #388)', () => {
  it('injects the resolved subtitles filter under the subtitlesFilter profileParams key', async () => {
    const jobs = fakeJobs();
    const { encore, submitted } = fakeEncore();

    await submitTranscode(
      {
        ...baseParams,
        preset: 'abr-1080p-burnin',
        burnInSubtitlesFilter: "subtitles=subtitles/asset-1/trk.srt:force_style='FontSize=24'"
      },
      { jobs, assets: {} as AssetRepository, encore }
    );

    expect(submitted).toHaveLength(1);
    expect(submitted[0].profileParams).toEqual({
      subtitlesFilter: "subtitles=subtitles/asset-1/trk.srt:force_style='FontSize=24'"
    });
  });

  it('merges the burn-in filter alongside caller-supplied profileParams (both preserved)', async () => {
    const jobs = fakeJobs();
    const { encore, submitted } = fakeEncore();

    await submitTranscode(
      {
        ...baseParams,
        preset: 'x264-crf-parametrized',
        profileParams: { crf: '18', preset: 'slow' },
        burnInSubtitlesFilter: 'subtitles=subtitles/asset-1/trk.vtt'
      },
      { jobs, assets: {} as AssetRepository, encore }
    );

    expect(submitted[0].profileParams).toEqual({
      crf: '18',
      preset: 'slow',
      subtitlesFilter: 'subtitles=subtitles/asset-1/trk.vtt'
    });
  });

  it('a clean submission (no burnIn) carries NO subtitlesFilter key — clean rendition', async () => {
    const jobs = fakeJobs();
    const { encore, submitted } = fakeEncore();

    await submitTranscode(
      { ...baseParams, preset: 'abr-1080p', profileParams: { crf: '20' } },
      { jobs, assets: {} as AssetRepository, encore }
    );

    // The caller-supplied params are forwarded verbatim, with NO burn-in key
    // added, so the profile's default (`''`) applies and no captions are burned.
    expect(submitted[0].profileParams).toEqual({ crf: '20' });
    expect(submitted[0].profileParams).not.toHaveProperty('subtitlesFilter');
  });

  it('two submissions from one caller — one burned, one clean — differ only by the burn-in key (per-rendition opt-in)', async () => {
    const jobs = fakeJobs();
    const { encore, submitted } = fakeEncore();

    // Burned rendition/profile.
    await submitTranscode(
      { ...baseParams, preset: 'abr-1080p-burnin', burnInSubtitlesFilter: 'subtitles=cap.srt' },
      { jobs, assets: {} as AssetRepository, encore }
    );
    // Clean rendition/profile in the same ladder.
    await submitTranscode(
      { ...baseParams, preset: 'abr-480p' },
      { jobs, assets: {} as AssetRepository, encore }
    );

    expect(submitted[0].profileParams).toEqual({ subtitlesFilter: 'subtitles=cap.srt' });
    expect(submitted[1].profileParams).toBeUndefined();
  });
});
