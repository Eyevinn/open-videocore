// Scene detection on eyevinn-ffmpeg-s3 (issue #1192, ADR-027).
//
// The fixtures below are the VERBATIM objects captured by the 2026-10-28 live
// run and pinned in docs/contracts/eyevinn-ffmpeg-s3-job-and-logs.json under
// `sceneCutReadback.viaS3Object.liveRun.runs['with-cuts'].objectVerbatim` and
// `...runs['zero-cut'].objectVerbatim`. They are copied here rather than
// paraphrased so the parser is tested against the real output of the real
// service, including the two different `#tb` timebases the live run recorded
// (1/25 and 1/12800 — `liveRun.findings`: "THE TIMEBASE IS NOT FIXED").

import { describe, it, expect } from 'vitest';
import {
  makeFfmpegS3SceneDetector,
  parseFramemd5Cuts,
  sceneDetectCmdLine,
  sceneCutObjectKey,
  sceneCutDestinationUri,
  sceneDetectJobName,
  Framemd5ParseError,
  SCENE_SELECT_THRESHOLD,
  type OscSceneJobApi
} from '../src/pipeline/osc-scene-detect-ffmpeg-s3.js';
import { parseSceneResult } from '../src/pipeline/scene-detector.js';
import { detectScenes } from '../src/pipeline/scene-detector.js';

// liveRun.runs['with-cuts']: 12s / 25fps clip with hard cuts at 3s, 6s, 9s.
const WITH_CUTS_OBJECT = [
  '#format: frame checksums',
  '#version: 2',
  '#hash: MD5',
  '#software: Lavf60.16.100',
  '#tb 0: 1/25',
  '#media_type 0: video',
  '#codec_id 0: rawvideo',
  '#dimensions 0: 640x360',
  '#sar 0: 1/1',
  '#stream#, dts,        pts, duration,     size, hash',
  '0,         75,         75,        1,   345600, b6bdf78425c71ed0f9dc99bdd3d6467c',
  '0,        150,        150,        1,   345600, 9e3b46ee66ea2374c8d7b200f5d3ca87',
  '0,        225,        225,        1,   345600, 29a653044efdf73bae6681f875a750ac'
].join('\n');

// liveRun.runs['zero-cut']: 3s single-shot clip. Header-only object, job still
// exits 0 — the case ADR-027 D3 allows to be persisted as a real zero-cut
// result.
const ZERO_CUT_OBJECT = [
  '#format: frame checksums',
  '#version: 2',
  '#hash: MD5',
  '#software: Lavf60.16.100',
  '#tb 0: 1/12800',
  '#media_type 0: video',
  '#codec_id 0: rawvideo',
  '#dimensions 0: 640x360',
  '#sar 0: 1/1',
  '#stream#, dts,        pts, duration,     size, hash'
].join('\n');

type Recorded = {
  bodies: Record<string, unknown>[];
  removedJobs: string[];
  removedObjects: string[];
};

function makeApi(
  opts: {
    object?: string | undefined;
    statuses?: string[];
    readThrows?: boolean;
  } = {}
): { api: OscSceneJobApi; rec: Recorded } {
  const rec: Recorded = { bodies: [], removedJobs: [], removedObjects: [] };
  const statuses = opts.statuses ?? ['SuccessCriteriaMet'];
  let pollCount = 0;
  const api = {
    context: {
      getServiceAccessToken: async () => 'sat-token'
    } as unknown as OscSceneJobApi['context'],
    createJob: (async (_ctx: unknown, _svc: string, _sat: string, body: Record<string, unknown>) => {
      rec.bodies.push(body);
      return body;
    }) as unknown as OscSceneJobApi['createJob'],
    getJob: (async () => {
      const status = statuses[Math.min(pollCount, statuses.length - 1)];
      pollCount += 1;
      return { status };
    }) as unknown as OscSceneJobApi['getJob'],
    getLogsForInstance: (async () => 'Uploaded s3://bucket/key') as unknown as OscSceneJobApi['getLogsForInstance'],
    removeJob: (async (_ctx: unknown, _svc: string, name: string) => {
      rec.removedJobs.push(name);
    }) as unknown as OscSceneJobApi['removeJob'],
    s3Endpoint: 'https://minio.example.test',
    s3AccessKey: 'ak',
    s3SecretKey: 'sk',
    s3Bucket: 'videocore-source',
    readCutObject: async () => {
      if (opts.readThrows) throw new Error('read failed');
      return opts.object;
    },
    removeCutObject: async (key: string) => {
      rec.removedObjects.push(key);
    },
    pollBudgetMs: 5_000
  } satisfies OscSceneJobApi;
  return { api, rec };
}

describe('parseFramemd5Cuts (issue #1192)', () => {
  it('maps the live-run object with cuts to 3s/6s/9s using its #tb timebase', () => {
    expect(parseFramemd5Cuts(WITH_CUTS_OBJECT)).toEqual([3, 6, 9]);
  });

  it('reads the timebase per object rather than assuming 1/25', () => {
    // Same pts values, the other live-run timebase (1/12800).
    const text = ZERO_CUT_OBJECT + '\n0, 12800, 12800, 1, 345600, b6bdf78425c71ed0f9dc99bdd3d6467c';
    expect(parseFramemd5Cuts(text)).toEqual([1]);
  });

  it('returns an empty cut list for the header-only zero-cut object', () => {
    expect(parseFramemd5Cuts(ZERO_CUT_OBJECT)).toEqual([]);
  });

  it('sorts cuts ascending even if rows arrive out of order', () => {
    const text = [
      '#tb 0: 1/25',
      '#stream#, dts,        pts, duration,     size, hash',
      '0, 225, 225, 1, 345600, 29a653044efdf73bae6681f875a750ac',
      '0, 75, 75, 1, 345600, b6bdf78425c71ed0f9dc99bdd3d6467c'
    ].join('\n');
    expect(parseFramemd5Cuts(text)).toEqual([3, 9]);
  });

  it('throws on an empty object (not a zero-cut result)', () => {
    expect(() => parseFramemd5Cuts('')).toThrow(Framemd5ParseError);
  });

  it('throws when the #tb timebase header is missing', () => {
    const text = [
      '#format: frame checksums',
      '#stream#, dts,        pts, duration,     size, hash'
    ].join('\n');
    expect(() => parseFramemd5Cuts(text)).toThrow(/missing #tb/);
  });

  it('throws when the row header is missing', () => {
    expect(() => parseFramemd5Cuts('#format: frame checksums\n#tb 0: 1/25')).toThrow(
      Framemd5ParseError
    );
  });

  it('throws on a truncated final row', () => {
    const text = WITH_CUTS_OBJECT.replace(
      '0,        225,        225,        1,   345600, 29a653044efdf73bae6681f875a750ac',
      '0,        225,        225,        1,   345'
    );
    expect(() => parseFramemd5Cuts(text)).toThrow(/truncated|columns/);
  });

  it('throws on a row whose hash column is cut short mid-write', () => {
    const text = WITH_CUTS_OBJECT.replace(
      '29a653044efdf73bae6681f875a750ac',
      '29a653044efdf73bae'
    );
    expect(() => parseFramemd5Cuts(text)).toThrow(/hash/);
  });

  it('throws on a row naming a stream with no declared timebase', () => {
    const text = [
      '#tb 0: 1/25',
      '#stream#, dts,        pts, duration,     size, hash',
      '1, 75, 75, 1, 345600, b6bdf78425c71ed0f9dc99bdd3d6467c'
    ].join('\n');
    expect(() => parseFramemd5Cuts(text)).toThrow(/no #tb/);
  });
});

describe('cuts-to-boundaries mapping stays the existing parseSceneResult path', () => {
  it('turns the live-run cuts into [start,end) boundaries with the last end open', () => {
    const metadata = parseSceneResult(
      { cuts: parseFramemd5Cuts(WITH_CUTS_OBJECT) },
      '2026-11-02T00:00:00.000Z'
    );
    expect(metadata.sceneCount).toBe(3);
    expect(metadata.boundaries).toEqual([
      { startSeconds: 3, keyframeSeconds: 3, endSeconds: 6 },
      { startSeconds: 6, keyframeSeconds: 6, endSeconds: 9 },
      { startSeconds: 9, keyframeSeconds: 9 }
    ]);
  });
});

describe('scene-detect job body and command line', () => {
  it('sends only the pinned ffmpeg-s3 job-body fields', async () => {
    const { api, rec } = makeApi({ object: WITH_CUTS_OBJECT });
    const detect = makeFfmpegS3SceneDetector(api);
    await detect('https://minio.example.test/src.mp4?X-Amz-Signature=abc');
    expect(rec.bodies).toHaveLength(1);
    expect(Object.keys(rec.bodies[0]!).sort()).toEqual([
      'awsAccessKeyId',
      'awsSecretAccessKey',
      'cmdLineArgs',
      'name',
      's3EndpointUrl'
    ]);
  });

  it('builds the command line shape the live run confirmed', () => {
    const cmd = sceneDetectCmdLine('https://src.test/a.mp4', 's3://b/scene-detect/j.framemd5');
    expect(cmd).toBe(
      '-i "https://src.test/a.mp4" -an -fps_mode passthrough ' +
        `-vf "select='gt(scene,${SCENE_SELECT_THRESHOLD})'" -f framemd5 "s3://b/scene-detect/j.framemd5"`
    );
  });

  it('keeps the detection threshold at the retired service value (0.4)', () => {
    expect(SCENE_SELECT_THRESHOLD).toBe(0.4);
  });

  it('writes the cut list to a .framemd5 key so the uploader basename match holds', () => {
    const key = sceneCutObjectKey('scenesabc123');
    expect(key).toBe('scene-detect/scenesabc123.framemd5');
    expect(sceneCutDestinationUri('bkt', key)).toBe('s3://bkt/scene-detect/scenesabc123.framemd5');
  });

  it('generates an OSC-valid job name', () => {
    const name = sceneDetectJobName();
    expect(name).toMatch(/^[a-z0-9]+$/);
    expect(name.length).toBeLessThanOrEqual(40);
  });
});

describe('scene detector result and failure handling', () => {
  it('returns the cuts and deletes the cut object and the job', async () => {
    const { api, rec } = makeApi({ object: WITH_CUTS_OBJECT });
    const result = await makeFfmpegS3SceneDetector(api)('https://src.test/a.mp4');
    expect(result).toEqual({ cuts: [3, 6, 9] });
    expect(rec.removedJobs).toHaveLength(1);
    expect(rec.removedObjects).toHaveLength(1);
  });

  it('returns an empty cut list for a well-formed header-only object', async () => {
    const { api } = makeApi({ object: ZERO_CUT_OBJECT });
    await expect(makeFfmpegS3SceneDetector(api)('https://src.test/a.mp4')).resolves.toEqual({
      cuts: []
    });
  });

  it('throws when the job ends on a non-success status', async () => {
    const { api } = makeApi({ object: WITH_CUTS_OBJECT, statuses: ['Failed'] });
    await expect(makeFfmpegS3SceneDetector(api)('https://src.test/a.mp4')).rejects.toThrow(
      /non-success status "Failed"/
    );
  });

  it('throws when the job succeeded but the cut object is missing', async () => {
    const { api } = makeApi({ object: undefined });
    await expect(makeFfmpegS3SceneDetector(api)('https://src.test/a.mp4')).rejects.toThrow(
      /cut list .* is missing/
    );
  });

  it('throws when the cut object cannot be parsed', async () => {
    const { api } = makeApi({ object: 'not a framemd5 document at all' });
    await expect(makeFfmpegS3SceneDetector(api)('https://src.test/a.mp4')).rejects.toThrow(
      /unreadable cut list/
    );
  });
});

describe('a failed scene-detect job persists NOTHING (ADR-027 D3 / issue #881)', () => {
  function makeDeps(detect: () => Promise<never> | Promise<{ cuts: number[] }>) {
    const updates: Record<string, unknown>[] = [];
    const deps = {
      assets: {
        update: async (_id: string, patch: Record<string, unknown>) => {
          updates.push(patch);
          return undefined as never;
        }
      },
      storage: {
        presignedGet: async () => 'https://src.test/a.mp4'
      },
      detect
    } as unknown as Parameters<typeof detectScenes>[1];
    return { deps, updates };
  }

  it('records sceneDetectionError with sceneMetadata null, never empty boundaries', async () => {
    const { api } = makeApi({ object: WITH_CUTS_OBJECT, statuses: ['Failed'] });
    const detector = makeFfmpegS3SceneDetector(api);
    const { deps, updates } = makeDeps(() => detector('https://src.test/a.mp4') as Promise<never>);
    await detectScenes({ assetId: 'a1', objectKey: 'assets/a1/source.mp4' }, deps);
    expect(updates).toHaveLength(1);
    expect(updates[0]!['sceneMetadata']).toBeNull();
    expect(updates[0]!['sceneDetectionError']).toMatch(/non-success status "Failed"/);
    // The sharp edge: no run that failed may leave a readable-looking result.
    expect(JSON.stringify(updates[0])).not.toContain('"boundaries"');
    expect(JSON.stringify(updates[0])).not.toContain('"sceneCount"');
  });

  it('persists real boundaries for a successful run', async () => {
    const { api } = makeApi({ object: WITH_CUTS_OBJECT });
    const detector = makeFfmpegS3SceneDetector(api);
    const { deps, updates } = makeDeps(() => detector('https://src.test/a.mp4'));
    await detectScenes({ assetId: 'a1', objectKey: 'assets/a1/source.mp4' }, deps);
    expect(updates).toHaveLength(1);
    const metadata = updates[0]!['sceneMetadata'] as { boundaries: unknown[]; sceneCount: number };
    expect(metadata.sceneCount).toBe(3);
    expect(metadata.boundaries[0]).toEqual({ startSeconds: 3, keyframeSeconds: 3, endSeconds: 6 });
  });
});
