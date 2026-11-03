// Multi-size thumbnail extraction (issue #1303).
//
// Covers:
//   - the scaled key shape and the scaled ffmpeg command builder
//   - the FLAG-OFF path: identical keys, no `scaled` targets handed to the
//     extractor, no `thumbnailSizes` written (behaviour unchanged from #332)
//   - the flag-on happy path: both variants recorded against the full-size key
//   - PARTIAL success: only sizes whose object is confirmed in storage are
//     recorded, and a frame whose FULL object never landed contributes none
//   - the OSC runner: one job per size, derived from the already-written full
//     frame; a failing scaled job is non-fatal; a failing FULL frame skips its
//     scaled jobs entirely
//   - the document round-trip for the new optional `thumbnailSizes` field
//
// Contract sources verified (contract-first rule):
//   - docs/contracts/eyevinn-ffmpeg-s3-job-and-logs.json — the pinned
//     eyevinn-ffmpeg-s3 job contract. `job.createJob.bodyFields` (`name`,
//     `cmdLineArgs`, `awsAccessKeyId`, `awsSecretAccessKey`, `s3EndpointUrl`)
//     for the job body, and symbols `rewriteCmdString output detection`
//     (upstream src/ffmpeg.ts:90-99) + `uploadResult single-file S3 branch`
//     (upstream src/ffmpeg.ts:337-345) for WHY each size needs its own
//     invocation: exactly ONE output is detected and uploaded per command.
//   - src/pipeline/osc-thumbnail.ts — thumbnailFrameCmdLine (unchanged full
//     frame), scaledThumbnailFrameCmdLine, makeOscThumbnailExtractor, OscJobApi.
//   - src/pipeline/thumbnail.ts — extractThumbnails, thumbnailObjectKey,
//     scaledThumbnailObjectKey, THUMBNAIL_SIZE_VARIANTS,
//     thumbnailMultiSizeEnabled, FrameTarget.scaled.
//   - src/data/asset-repo.ts — Asset.thumbnailSizes / UpdateAssetInput
//     .thumbnailSizes, InMemoryAssetRepository.update.
//   - src/data/asset-document.ts — ThumbnailSizeSchema,
//     structural.thumbnailSizes, toAssetDocument / fromAssetDocument.

import { describe, it, expect, vi, afterEach } from 'vitest';

import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import {
  AssetDocumentSchema,
  toAssetDocument,
  fromAssetDocument
} from '../src/data/asset-document.js';
import {
  extractThumbnails,
  scaledThumbnailObjectKey,
  thumbnailMultiSizeEnabled,
  thumbnailObjectKey,
  THUMBNAIL_SIZE_VARIANTS,
  type FrameExtractor,
  type FrameTarget
} from '../src/pipeline/thumbnail.js';
import {
  makeOscThumbnailExtractor,
  scaledThumbnailFrameCmdLine,
  thumbnailFrameCmdLine,
  type OscJobApi
} from '../src/pipeline/osc-thumbnail.js';
import type { WorkspaceStorage } from '../src/data/storage.js';

// Same seam as test/thumbnail.test.ts: statObject reports EXACTLY the keys the
// extractor is deemed to have written, which is what lets record-only-stored be
// tested without a real MinIO.
function fakeStorage(written = new Set<string>()): {
  storage: WorkspaceStorage;
  written: Set<string>;
} {
  const storage = {
    presignedGet: vi.fn(async (key: string) => `https://minio.example/${key}?sig=get`),
    presignedPut: vi.fn(async (key: string) => `https://minio.example/${key}?sig=put`),
    statObject: vi.fn(async (key: string) =>
      written.has(key) ? { size: 1024, etag: 'etag' } : undefined
    )
  } as unknown as WorkspaceStorage;
  return { storage, written };
}

// A FrameExtractor that writes the full frame for every target, plus each
// scaled variant unless its key is in `fail`. Mirrors the real runner: scaled
// variants are derived from the full frame, so a frame whose full key is failed
// contributes no sizes either.
function multiSizeExtractor(
  written: Set<string>,
  fail: Set<string> = new Set()
): FrameExtractor & { calls: FrameTarget[][] } {
  const calls: FrameTarget[][] = [];
  const fn = vi.fn(async (_url: string, frames: FrameTarget[]) => {
    calls.push(frames);
    for (const f of frames) {
      if (fail.has(f.objectKey)) continue;
      written.add(f.objectKey);
      for (const s of f.scaled ?? []) {
        if (!fail.has(s.objectKey)) written.add(s.objectKey);
      }
    }
  }) as unknown as FrameExtractor & { calls: FrameTarget[][] };
  fn.calls = calls;
  return fn;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('THUMBNAIL_MULTI_SIZE flag (issue #1303)', () => {
  it('is OFF unless the env var is exactly "true"', () => {
    vi.stubEnv('THUMBNAIL_MULTI_SIZE', '');
    expect(thumbnailMultiSizeEnabled()).toBe(false);
    vi.stubEnv('THUMBNAIL_MULTI_SIZE', 'false');
    expect(thumbnailMultiSizeEnabled()).toBe(false);
    vi.stubEnv('THUMBNAIL_MULTI_SIZE', '1');
    expect(thumbnailMultiSizeEnabled()).toBe(false);
    vi.stubEnv('THUMBNAIL_MULTI_SIZE', 'true');
    expect(thumbnailMultiSizeEnabled()).toBe(true);
  });

  it('declares exactly the medium (1280) and small (360) variants', () => {
    expect(THUMBNAIL_SIZE_VARIANTS.map((v) => [v.variant, v.width])).toEqual([
      ['medium', 1280],
      ['small', 360]
    ]);
    // Every scaled variant carries an EXPLICIT -q:v (the full frame's quality is
    // deliberately untouched).
    for (const v of THUMBNAIL_SIZE_VARIANTS) {
      expect(Number.isInteger(v.quality)).toBe(true);
    }
  });
});

describe('scaled thumbnail object keys', () => {
  it('suffixes the width before the extension, leaving the full key untouched', () => {
    expect(thumbnailObjectKey('asset-1', 30)).toBe('thumbnails/asset-1/thumb_30s.jpg');
    expect(scaledThumbnailObjectKey('asset-1', 30, 1280)).toBe(
      'thumbnails/asset-1/thumb_30s_1280.jpg'
    );
    expect(scaledThumbnailObjectKey('asset-1', 30, 360)).toBe(
      'thumbnails/asset-1/thumb_30s_360.jpg'
    );
  });

  it('keeps full and scaled keys distinct for the same timecode', () => {
    const keys = [
      thumbnailObjectKey('a', 7),
      scaledThumbnailObjectKey('a', 7, 1280),
      scaledThumbnailObjectKey('a', 7, 360)
    ];
    expect(new Set(keys).size).toBe(3);
  });

  it('rounds the timecode the same way as the full-size key', () => {
    expect(scaledThumbnailObjectKey('a', 12.6, 360)).toBe('thumbnails/a/thumb_13s_360.jpg');
  });
});

describe('scaledThumbnailFrameCmdLine', () => {
  const scaled = {
    variant: 'small' as const,
    width: 360,
    quality: 6,
    objectKey: 'thumbnails/a/thumb_5s_360.jpg'
  };

  it('scales with scale=<w>:-2 and an explicit -q:v, reading the full frame back', () => {
    const cmd = scaledThumbnailFrameCmdLine('thumbnails/a/thumb_5s.jpg', scaled, 'bkt');
    expect(cmd).toContain('-i "s3://bkt/thumbnails/a/thumb_5s.jpg"');
    expect(cmd).toContain('-vf scale=360:-2');
    expect(cmd).toContain('-q:v 6');
    expect(cmd).toContain('-f image2');
    expect(cmd).toContain('"s3://bkt/thumbnails/a/thumb_5s_360.jpg"');
  });

  it('uses exactly ONE input and ONE output (the only shape the service supports)', () => {
    const cmd = scaledThumbnailFrameCmdLine('thumbnails/a/thumb_5s.jpg', scaled, 'bkt');
    // One `-i` (issue #332 forbids multiple inputs in one command).
    expect([...cmd.matchAll(/(^|\s)-i\s/g)]).toHaveLength(1);
    // Two s3:// URIs total: the input and the single output.
    expect([...cmd.matchAll(/s3:\/\//g)]).toHaveLength(2);
    // The service detects the output as the LAST argument not starting with `-`
    // (pinned contract, `rewriteCmdString output detection`). That argument must
    // be the scaled destination.
    const args = cmd.split(' ').filter((a) => a.length > 0);
    const last = args[args.length - 1];
    expect(last).toBe('"s3://bkt/thumbnails/a/thumb_5s_360.jpg"');
  });

  it('does not alter the full-size command (full-size quality unchanged)', () => {
    const frame: FrameTarget = {
      timecodeSeconds: 5,
      objectKey: 'thumbnails/a/thumb_5s.jpg',
      putUrl: 'https://minio/x?sig=put'
    };
    const full = thumbnailFrameCmdLine('https://minio/src?sig=s', frame, 'bkt');
    expect(full).toBe(
      '-y -ss 5 -i "https://minio/src?sig=s" -frames:v 1 -f image2 ' +
        '"s3://bkt/thumbnails/a/thumb_5s.jpg"'
    );
    expect(full).not.toContain('-q:v');
    expect(full).not.toContain('scale=');
  });

  it('never makes the output a substring-collision target of the input', () => {
    // The service rewrites the output with a FIRST-OCCURRENCE substring replace
    // (pinned contract, `rewriteCmdString output substitution`). The scaled key
    // must therefore not appear anywhere earlier in the command.
    const cmd = scaledThumbnailFrameCmdLine('thumbnails/a/thumb_5s.jpg', scaled, 'bkt');
    const out = `s3://bkt/${scaled.objectKey}`;
    expect(cmd.indexOf(out)).toBe(cmd.lastIndexOf(out));
  });
});

describe('extractThumbnails with the flag OFF (unchanged behaviour)', () => {
  it('hands the extractor frames with NO scaled targets and writes no thumbnailSizes', async () => {
    vi.stubEnv('THUMBNAIL_MULTI_SIZE', 'false');
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'x', objectKey: 'ingest/x' });
    const { storage, written } = fakeStorage();
    const extractor = multiSizeExtractor(written);

    const result = await extractThumbnails(
      { assetId: asset.id, objectKey: 'ingest/x', timecodes: [5, 10] },
      { assets: repo, storage, extractor }
    );

    expect(result).toEqual([thumbnailObjectKey(asset.id, 5), thumbnailObjectKey(asset.id, 10)]);
    const frames = extractor.calls[0];
    for (const f of frames) {
      // Not merely empty — the property is ABSENT, so the object handed to the
      // extractor is identical to the pre-#1303 one.
      expect('scaled' in f).toBe(false);
    }
    const stored = await repo.get(asset.id);
    expect(stored?.thumbnails).toEqual(result);
    expect(stored?.thumbnailSizes).toBeUndefined();
    // No scaled object was even looked for.
    expect(written).toEqual(new Set(result));
  });

  it('writes no thumbnailSizes when deps.multiSize is false even if the env says true', async () => {
    vi.stubEnv('THUMBNAIL_MULTI_SIZE', 'true');
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'x', objectKey: 'ingest/x' });
    const { storage, written } = fakeStorage();
    const extractor = multiSizeExtractor(written);

    await extractThumbnails(
      { assetId: asset.id, objectKey: 'ingest/x', timecodes: [1] },
      { assets: repo, storage, extractor, multiSize: false }
    );

    expect('scaled' in extractor.calls[0][0]).toBe(false);
    expect((await repo.get(asset.id))?.thumbnailSizes).toBeUndefined();
  });
});

describe('extractThumbnails with the flag ON', () => {
  it('requests both variants per timecode and records the ones that landed', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'x', objectKey: 'ingest/x' });
    const { storage, written } = fakeStorage();
    const extractor = multiSizeExtractor(written);

    const result = await extractThumbnails(
      { assetId: asset.id, objectKey: 'ingest/x', timecodes: [5] },
      { assets: repo, storage, extractor, multiSize: true }
    );

    // The full-size list and its index meaning are untouched.
    expect(result).toEqual([thumbnailObjectKey(asset.id, 5)]);

    const frame = extractor.calls[0][0];
    expect(frame.scaled?.map((s) => s.objectKey)).toEqual([
      scaledThumbnailObjectKey(asset.id, 5, 1280),
      scaledThumbnailObjectKey(asset.id, 5, 360)
    ]);

    const stored = await repo.get(asset.id);
    expect(stored?.thumbnails).toEqual(result);
    expect(stored?.thumbnailSizes).toEqual([
      {
        fullObjectKey: thumbnailObjectKey(asset.id, 5),
        variant: 'medium',
        width: 1280,
        objectKey: scaledThumbnailObjectKey(asset.id, 5, 1280)
      },
      {
        fullObjectKey: thumbnailObjectKey(asset.id, 5),
        variant: 'small',
        width: 360,
        objectKey: scaledThumbnailObjectKey(asset.id, 5, 360)
      }
    ]);
  });

  it('PARTIAL: records only sizes confirmed in storage', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'x', objectKey: 'ingest/x' });
    const { storage, written } = fakeStorage();
    // The 1280 variant's job fails for both timecodes; the 360 ones land.
    const fail = new Set([
      scaledThumbnailObjectKey(asset.id, 3, 1280),
      scaledThumbnailObjectKey(asset.id, 9, 1280)
    ]);
    const extractor = multiSizeExtractor(written, fail);

    const result = await extractThumbnails(
      { assetId: asset.id, objectKey: 'ingest/x', timecodes: [3, 9] },
      { assets: repo, storage, extractor, multiSize: true }
    );

    // Full frames are unaffected by a scaled failure.
    expect(result).toEqual([thumbnailObjectKey(asset.id, 3), thumbnailObjectKey(asset.id, 9)]);
    const stored = await repo.get(asset.id);
    expect(stored?.thumbnailSizes?.map((s) => s.objectKey)).toEqual([
      scaledThumbnailObjectKey(asset.id, 3, 360),
      scaledThumbnailObjectKey(asset.id, 9, 360)
    ]);
    // Never a key whose object was not stored.
    for (const key of fail) {
      expect(stored?.thumbnailSizes?.some((s) => s.objectKey === key)).toBe(false);
    }
  });

  it('PARTIAL: a frame whose FULL object never landed contributes no sizes', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'x', objectKey: 'ingest/x' });
    const { storage, written } = fakeStorage();
    const extractor = multiSizeExtractor(written, new Set([thumbnailObjectKey(asset.id, 3)]));

    const result = await extractThumbnails(
      { assetId: asset.id, objectKey: 'ingest/x', timecodes: [3, 9] },
      { assets: repo, storage, extractor, multiSize: true }
    );

    expect(result).toEqual([thumbnailObjectKey(asset.id, 9)]);
    const stored = await repo.get(asset.id);
    expect(stored?.thumbnailSizes?.map((s) => s.fullObjectKey)).toEqual([
      thumbnailObjectKey(asset.id, 9),
      thumbnailObjectKey(asset.id, 9)
    ]);
  });

  it('records no sizes (and leaves the field absent) when every scaled job fails', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'x', objectKey: 'ingest/x' });
    const { storage, written } = fakeStorage();
    const fail = new Set([
      scaledThumbnailObjectKey(asset.id, 1, 1280),
      scaledThumbnailObjectKey(asset.id, 1, 360)
    ]);
    const extractor = multiSizeExtractor(written, fail);

    const result = await extractThumbnails(
      { assetId: asset.id, objectKey: 'ingest/x', timecodes: [1] },
      { assets: repo, storage, extractor, multiSize: true }
    );

    expect(result).toEqual([thumbnailObjectKey(asset.id, 1)]);
    expect((await repo.get(asset.id))?.thumbnailSizes).toBeUndefined();
  });

  it('tolerates an extractor that ignores `scaled` entirely', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'x', objectKey: 'ingest/x' });
    const { storage, written } = fakeStorage();
    // Pre-#1303 extractor: writes only the full-size key.
    const extractor: FrameExtractor = vi.fn(async (_url, frames) => {
      for (const f of frames) written.add(f.objectKey);
    });

    const result = await extractThumbnails(
      { assetId: asset.id, objectKey: 'ingest/x', timecodes: [2] },
      { assets: repo, storage, extractor, multiSize: true }
    );

    expect(result).toEqual([thumbnailObjectKey(asset.id, 2)]);
    expect((await repo.get(asset.id))?.thumbnailSizes).toBeUndefined();
  });
});

describe('makeOscThumbnailExtractor with scaled targets', () => {
  function fakeApi(): OscJobApi {
    const context = {
      getServiceAccessToken: vi.fn(async () => 'sat-token')
    } as unknown as OscJobApi['context'];
    return {
      context,
      createJob: vi.fn(async () => ({ name: 'x' })),
      getJob: vi.fn(async () => ({ status: 'SuccessCriteriaMet' })),
      getLogsForInstance: vi.fn(async () => ''),
      removeJob: vi.fn(async () => undefined),
      s3Endpoint: 'https://minio.example',
      s3AccessKey: 'admin',
      s3SecretKey: 'secret',
      s3Bucket: 'thumbs-bucket'
    } as unknown as OscJobApi;
  }

  const frameWithSizes = (): FrameTarget => ({
    timecodeSeconds: 5,
    objectKey: 'thumb_5s.jpg',
    putUrl: 'https://minio/5',
    scaled: [
      { variant: 'medium', width: 1280, quality: 4, objectKey: 'thumb_5s_1280.jpg' },
      { variant: 'small', width: 360, quality: 6, objectKey: 'thumb_5s_360.jpg' }
    ]
  });

  const bodies = (api: OscJobApi) =>
    (api.createJob as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[3].cmdLineArgs));

  it('runs one job per size, each deriving from the already-written full frame', async () => {
    const api = fakeApi();
    await makeOscThumbnailExtractor(api)('https://minio/src', [frameWithSizes()]);

    // 1 full + 2 scaled.
    expect(api.createJob).toHaveBeenCalledTimes(3);
    const cmds = bodies(api);
    expect(cmds[0]).toContain('-ss 5');
    expect(cmds[0]).toContain('"s3://thumbs-bucket/thumb_5s.jpg"');
    expect(cmds[1]).toContain('-i "s3://thumbs-bucket/thumb_5s.jpg"');
    expect(cmds[1]).toContain('-vf scale=1280:-2');
    expect(cmds[1]).toContain('"s3://thumbs-bucket/thumb_5s_1280.jpg"');
    expect(cmds[2]).toContain('-vf scale=360:-2');
    expect(cmds[2]).toContain('"s3://thumbs-bucket/thumb_5s_360.jpg"');
    // Every ephemeral instance is removed, scaled ones included.
    expect(api.removeJob).toHaveBeenCalledTimes(3);
    // The scaled jobs carry the same S3 credentials in the body as the full one
    // (pinned contract `job.createJob.bodyFields`).
    const body = (api.createJob as ReturnType<typeof vi.fn>).mock.calls[2][3];
    expect(body.awsAccessKeyId).toBe('admin');
    expect(body.awsSecretAccessKey).toBe('secret');
    expect(body.s3EndpointUrl).toBe('https://minio.example');
  });

  it('a failing scaled job is NOT fatal — the full frame still counts as written', async () => {
    const api = fakeApi();
    (api.createJob as ReturnType<typeof vi.fn>).mockImplementation(async (_c, _s, _t, body) => {
      if (String(body.cmdLineArgs).includes('scale=360')) throw new Error('scale job boom');
      return { name: 'x' };
    });

    await expect(
      makeOscThumbnailExtractor(api)('https://minio/src', [frameWithSizes()])
    ).resolves.toBeUndefined();
    expect(api.createJob).toHaveBeenCalledTimes(3);
  });

  it('skips the scaled jobs when the FULL frame job failed (no input to derive from)', async () => {
    const api = fakeApi();
    (api.createJob as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

    await expect(
      makeOscThumbnailExtractor(api)('https://minio/src', [frameWithSizes()])
    ).rejects.toThrow(/failed/);
    // Only the full-frame attempt — no derive jobs dispatched.
    expect(api.createJob).toHaveBeenCalledTimes(1);
  });

  it('dispatches nothing extra for frames without scaled targets (flag off)', async () => {
    const api = fakeApi();
    await makeOscThumbnailExtractor(api)('https://minio/src', [
      { timecodeSeconds: 1, objectKey: 'k', putUrl: 'https://minio/k' }
    ]);
    expect(api.createJob).toHaveBeenCalledTimes(1);
    expect(bodies(api)[0]).not.toContain('scale=');
  });
});

describe('asset document round-trip for thumbnailSizes', () => {
  it('persists and restores the scaled variants under structural', async () => {
    const repo = new InMemoryAssetRepository();
    const created = await repo.create({ name: 'x' });
    const asset = await repo.update(created.id, {
      thumbnails: ['thumbnails/x/thumb_5s.jpg'],
      thumbnailSizes: [
        {
          fullObjectKey: 'thumbnails/x/thumb_5s.jpg',
          variant: 'small',
          width: 360,
          objectKey: 'thumbnails/x/thumb_5s_360.jpg'
        }
      ]
    });

    const parsed = AssetDocumentSchema.parse(toAssetDocument(asset!));
    expect(parsed.structural.thumbnailSizes).toEqual([
      {
        fullObjectKey: 'thumbnails/x/thumb_5s.jpg',
        variant: 'small',
        width: 360,
        objectKey: 'thumbnails/x/thumb_5s_360.jpg'
      }
    ]);
    const back = fromAssetDocument(parsed);
    expect(back.thumbnailSizes).toEqual(asset!.thumbnailSizes);
    // The full-size list is unchanged by the new field.
    expect(back.thumbnails).toEqual(['thumbnails/x/thumb_5s.jpg']);
  });

  it('leaves the field absent for an asset with no scaled variants', async () => {
    const repo = new InMemoryAssetRepository();
    const created = await repo.create({ name: 'x' });
    const asset = await repo.update(created.id, { thumbnails: ['thumbnails/x/thumb_5s.jpg'] });
    const doc = toAssetDocument(asset!);
    expect('thumbnailSizes' in doc.structural).toBe(false);
    expect(fromAssetDocument(AssetDocumentSchema.parse(doc)).thumbnailSizes).toBeUndefined();
  });
});
