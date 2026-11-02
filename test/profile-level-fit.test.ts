// Level-safe ladder fitting (issue #1167).
//
// The reported failure: a transcode with the default `program` profile fails on
// an 854x480 source with
//   [libx264] frame MB size (121x68) > level limit (8192)
//   [libx264] DPB size (4 frames, 32912 mbs) > level limit (3 frames, 32768 mbs)
//   Job execution failed: Coding might not be compatible on all devices: ...
// while a 1920x1080 source on the same stack works. These tests pin both cases:
// the 854x480 source must land inside every rung's declared level, and the
// 1920x1080 source must keep byte-identical output geometry.
//
// CONTRACT SOURCES (CLAUDE.md rule 7), all fetched 2026-10-19:
//   - Eyevinn/encore-test-profiles `program.yml` (branch main), the profile the
//     default index (ENCORE_PROFILES_URL, src/main.ts) seeds: five X264Encode
//     rungs with `height: 1080|720|540|360|234`, NO `width`, `params.level:
//     4.1|3.1|3.1|3.1|3.1`, `x264-params.ref: 4|4|4|4|3`. PROGRAM_LADDER_YAML
//     below reproduces that structure (rung keys, nested `params:`,
//     `x264-params:` and `audioEncode:` maps) with the non-geometric params
//     elided.
//   - svt/encore `encore-common/.../model/profile/VideoEncode.kt`
//     `fun videoFilter(...)`: width+height ->
//     `scale=W:H:force_original_aspect_ratio=decrease:force_divisible_by=2`,
//     height alone -> `scale=-2:H`. `.../X264Encode.kt`: `width`/`height` are
//     rung-level keys, `params` / `x264-params` are the nested maps.
//   - svt/encore `encore-common/.../service/FfmpegExecutor.kt`: a `warning`
//     line containing "DPB size" throws "Coding might not be compatible on all
//     devices", i.e. a level overflow is a hard failure.
//   - FFmpeg `libavcodec/h264_levels.c` `h264_levels[]` (H.264 Table A-1):
//     MaxFS / MaxDpbMbs per level.

import { describe, it, expect, vi } from 'vitest';
import {
  H264_LEVEL_LIMITS,
  lookupH264Level,
  frameSizeMbs,
  maxLevelSafeWidth,
  nominalSixteenNineWidth,
  predictScaledOutput,
  fitProfileLadderToLevel
} from '../src/pipeline/profile-level-fit.js';
import { bootstrapProfiles } from '../src/services/profile-bootstrap.js';
import { InMemoryProfileRepository } from '../src/data/inmemory-profile-repo.js';

// The seeded default ladder's geometry, verbatim from upstream `program.yml`
// (see header). Only the rate-control/x264 tuning params that play no part in
// level fitting are elided.
const PROGRAM_LADDER_YAML = `name: program
description: Program profile
scaling: bicubic
encodes:
  - type: X264Encode
    suffix: _x264_3100
    twoPass: false
    height: 1080
    params:
      b:v: 3100k
      pix_fmt: yuv420p
      profile:v: high
      level: 4.1
    x264-params:
      bframes: 6
      keyint: 192
      ref: 4
    audioEncode:
      optional: true
      type: AudioEncode
      codec: aac
      bitrate: 128k
      suffix: STEREO

  - type: X264Encode
    suffix: _x264_2069
    twoPass: false
    height: 720
    params:
      b:v: 2069k
      pix_fmt: yuv420p
      profile:v: main
      level: 3.1
    x264-params:
      bframes: 6
      ref: 4

  - type: X264Encode
    suffix: _x264_1312
    twoPass: false
    height: 540
    params:
      b:v: 1312k
      level: 3.1
      profile:v: main
    x264-params:
      bframes: 6
      ref: 4

  - type: X264Encode
    suffix: _x264_806
    twoPass: false
    height: 360
    params:
      b:v: 806121
      profile:v: main
      level: 3.1
    x264-params:
      bframes: 6
      ref: 4

  - type: X264Encode
    suffix: _x264_324
    twoPass: false
    height: 234
    params:
      b:v: 324051
      profile:v: baseline
      level: 3.1
    x264-params:
      cabac: 0
      ref: 3

  - type: AudioEncode
    optional: true
    codec: aac
    bitrate: 128k
    suffix: _STEREO

  - type: ThumbnailMapEncode
    decodeOutput: 0

  - type: ThumbnailEncode
    decodeOutput: 0
`;

const SINTEL_TRAILER = { width: 854, height: 480 }; // the reported source
const HD_SOURCE = { width: 1920, height: 1080 }; // the source that works today

type Rung = {
  suffix?: string;
  width?: number;
  height?: number;
  level?: string;
  ref?: number;
};

// Minimal reader for the rungs of a ladder document: each `- type: X264Encode`
// list item with its rung-level width/height/suffix and its nested level/ref.
function readVideoRungs(yaml: string): Rung[] {
  const rungs: Rung[] = [];
  let current: Rung | null = null;
  let inVideoItem = false;
  for (const line of yaml.split('\n')) {
    const item = /^(\s*)-\s+type\s*:\s*(\S+)\s*$/.exec(line);
    if (item) {
      if (current) rungs.push(current);
      current = null;
      inVideoItem = /X26[45]Encode/.test(item[2]);
      if (inVideoItem) current = {};
      continue;
    }
    if (!inVideoItem || !current) continue;
    const kv = /^\s*([A-Za-z0-9_:-]+)\s*:\s*(.+?)\s*$/.exec(line);
    if (!kv) continue;
    const [, key, value] = kv;
    if (key === 'width' && /^\d+$/.test(value)) current.width = Number(value);
    else if (key === 'height' && /^\d+$/.test(value)) current.height = Number(value);
    else if (key === 'level') current.level = value;
    else if (key === 'ref' && /^\d+$/.test(value)) current.ref = Number(value);
    else if (key === 'suffix' && current.suffix === undefined) current.suffix = value;
  }
  if (current) rungs.push(current);
  return rungs;
}

// Does this rung's output for `source` fit the level it declares? Mirrors the
// two limits libx264 reports in the issue's log: frame MB size vs MaxFS, and
// DPB (refs x frame MBs) vs MaxDpbMbs.
function levelCheck(rung: Rung, source: { width: number; height: number }) {
  const limits = lookupH264Level(rung.level);
  if (!limits) throw new Error(`unknown level ${rung.level}`);
  const out = predictScaledOutput(source, { width: rung.width, height: rung.height });
  const mbs = frameSizeMbs(out.width, out.height);
  const refs = rung.ref ?? 4;
  return {
    out,
    mbs,
    dpbMbs: mbs * refs,
    frameFits: mbs <= limits.maxFrameSizeMbs,
    dpbFits: mbs * refs <= limits.maxDpbMbs,
    limits
  };
}

describe('H.264 level limits table (FFmpeg libavcodec/h264_levels.c, Table A-1)', () => {
  it('carries the MaxFS / MaxDpbMbs values the issue log quotes', () => {
    // The log quotes "level limit (8192)" for the frame and
    // "(3 frames, 32768 mbs)" for the DPB — level 4.1.
    expect(lookupH264Level('4.1')).toEqual({
      level: '4.1',
      levelIdc: 41,
      maxFrameSizeMbs: 8192,
      maxDpbMbs: 32768
    });
    expect(lookupH264Level('3.1')).toMatchObject({ maxFrameSizeMbs: 3600, maxDpbMbs: 18000 });
    expect(lookupH264Level('4.2')).toMatchObject({ maxFrameSizeMbs: 8704, maxDpbMbs: 34816 });
    // Alternative spellings an operator profile may use.
    expect(lookupH264Level('"4.1"')).toMatchObject({ levelIdc: 41 });
    expect(lookupH264Level('41')).toMatchObject({ level: '4.1' });
    expect(lookupH264Level('4')).toMatchObject({ level: '4' });
    expect(lookupH264Level('4.0')).toMatchObject({ level: '4' });
    expect(lookupH264Level('1b')).toMatchObject({ maxFrameSizeMbs: 99 });
    // Not a level: a SpEL-parametrised or empty value is left undecided so the
    // fit leaves such a rung alone.
    expect(lookupH264Level("#{profileParams['level']?:4.1}")).toBeUndefined();
    expect(lookupH264Level(undefined)).toBeUndefined();
    expect(lookupH264Level('high')).toBeUndefined();
    // Every row is monotonically non-decreasing in both limits, as Table A-1 is.
    for (let i = 1; i < H264_LEVEL_LIMITS.length; i += 1) {
      expect(H264_LEVEL_LIMITS[i].maxFrameSizeMbs).toBeGreaterThanOrEqual(
        H264_LEVEL_LIMITS[i - 1].maxFrameSizeMbs
      );
    }
  });

  it('derives the widest level-safe width from MaxFS and the DPB budget', () => {
    // 1080 is 68 macroblock rows; level 4.1 allows floor(8192/68) = 120 columns
    // = 1920 px, and with ref 4 the DPB budget floor(32768/4) = 8192 gives the
    // same answer. That is exactly why 1920x1080 works and 1922x1080 does not.
    expect(maxLevelSafeWidth({ level: '4.1', height: 1080, refFrames: 4 })).toBe(1920);
    // 720 is 45 rows; level 3.1 allows floor(3600/45) = 80 columns = 1280 px.
    expect(maxLevelSafeWidth({ level: '3.1', height: 720, refFrames: 4 })).toBe(1280);
    // A level too low for the height still yields a usable (narrower) bound
    // rather than an overflow: 1080 at level 3.1 -> floor(3600/68) = 52 cols.
    expect(maxLevelSafeWidth({ level: '3.1', height: 1080, refFrames: 4 })).toBe(52 * 16);
    expect(maxLevelSafeWidth({ level: undefined, height: 1080 })).toBeUndefined();
  });

  it('computes the nominal 16:9 width of each ladder rung height', () => {
    expect(nominalSixteenNineWidth(1080)).toBe(1920);
    expect(nominalSixteenNineWidth(720)).toBe(1280);
    expect(nominalSixteenNineWidth(540)).toBe(960);
    expect(nominalSixteenNineWidth(360)).toBe(640);
    expect(nominalSixteenNineWidth(234)).toBe(416);
  });
});

describe('the reported failure, before the fit (issue #1167 root cause)', () => {
  it('overflows level 4.1 and the DPB on the 854x480 source with a height-only rung', () => {
    const rungs = readVideoRungs(PROGRAM_LADDER_YAML);
    expect(rungs.map((r) => r.height)).toEqual([1080, 720, 540, 360, 234]);
    expect(rungs.every((r) => r.width === undefined)).toBe(true);

    const top = levelCheck(rungs[0], SINTEL_TRAILER);
    // 854/480 is 1.7792, not 16:9, so `scale=-2:1080` yields 1922 px wide.
    expect(top.out).toEqual({ width: 1922, height: 1080 });
    // 121x68 = 8228 macroblocks, and 4 x 8228 = 32912 mbs in the DPB — the two
    // numbers libx264 prints in the issue log.
    expect(top.mbs).toBe(8228);
    expect(top.dpbMbs).toBe(32912);
    expect(top.frameFits).toBe(false);
    expect(top.dpbFits).toBe(false);

    // The 720 rung overflows level 3.1 the same way (81x45 = 3645 > 3600).
    const second = levelCheck(rungs[1], SINTEL_TRAILER);
    expect(second.mbs).toBe(3645);
    expect(second.frameFits).toBe(false);
  });

  it('is within every level on the 1920x1080 source, which is why that one worked', () => {
    for (const rung of readVideoRungs(PROGRAM_LADDER_YAML)) {
      const check = levelCheck(rung, HD_SOURCE);
      expect(check.frameFits).toBe(true);
      expect(check.dpbFits).toBe(true);
    }
  });
});

describe('fitProfileLadderToLevel on the default program ladder', () => {
  const fitted = fitProfileLadderToLevel(PROGRAM_LADDER_YAML);

  it('adds the bounding width each rung needs, and only to video rungs', () => {
    expect(fitted.changed).toBe(true);
    expect(fitted.adjustments).toEqual([
      { suffix: '_x264_3100', height: 1080, level: '4.1', width: 1920, levelConstrained: false },
      { suffix: '_x264_2069', height: 720, level: '3.1', width: 1280, levelConstrained: false },
      { suffix: '_x264_1312', height: 540, level: '3.1', width: 960, levelConstrained: false },
      { suffix: '_x264_806', height: 360, level: '3.1', width: 640, levelConstrained: false },
      { suffix: '_x264_324', height: 234, level: '3.1', width: 416, levelConstrained: false }
    ]);
    // The width is written at the rung's own indentation, immediately before
    // the height it bounds.
    expect(fitted.yaml).toContain('    width: 1920\n    height: 1080\n');
    // The audio-only, thumbnail and nested audioEncode blocks are untouched: no
    // width is added anywhere other than the five video rungs.
    expect(fitted.yaml.match(/^\s*width:/gm)?.length).toBe(5);
    expect(fitted.yaml).toContain('  - type: ThumbnailMapEncode\n    decodeOutput: 0');
    // Everything else survives byte-for-byte: removing the inserted lines gives
    // back the original document.
    const withoutInserted = fitted.yaml
      .split('\n')
      .filter((l) => !/^\s*width: \d+$/.test(l))
      .join('\n');
    expect(withoutInserted).toBe(PROGRAM_LADDER_YAML);
  });

  it('keeps the 854x480 source inside every rung\'s declared level', () => {
    const rungs = readVideoRungs(fitted.yaml);
    expect(rungs.map((r) => r.width)).toEqual([1920, 1280, 960, 640, 416]);
    for (const rung of rungs) {
      const check = levelCheck(rung, SINTEL_TRAILER);
      expect({ suffix: rung.suffix, frameFits: check.frameFits, dpbFits: check.dpbFits }).toEqual({
        suffix: rung.suffix,
        frameFits: true,
        dpbFits: true
      });
    }
    // The top rung now fits the 854x480 source inside the 1920x1080 box with the
    // aspect ratio preserved: 1920x1078 = 120x68 = 8160 mbs (<= 8192) and a DPB
    // of 4 x 8160 = 32640 mbs (<= 32768).
    const top = levelCheck(rungs[0], SINTEL_TRAILER);
    expect(top.out).toEqual({ width: 1920, height: 1078 });
    expect(top.mbs).toBe(8160);
    expect(top.dpbMbs).toBe(32640);
  });

  it('does not change the geometry of the 1920x1080 source (no regression)', () => {
    const before = readVideoRungs(PROGRAM_LADDER_YAML).map((r) =>
      predictScaledOutput(HD_SOURCE, { width: r.width, height: r.height })
    );
    const after = readVideoRungs(fitted.yaml).map((r) =>
      predictScaledOutput(HD_SOURCE, { width: r.width, height: r.height })
    );
    expect(after).toEqual(before);
    expect(after).toEqual([
      { width: 1920, height: 1080 },
      { width: 1280, height: 720 },
      { width: 960, height: 540 },
      { width: 640, height: 360 },
      { width: 416, height: 234 }
    ]);
  });

  it('keeps other common source shapes inside their levels too', () => {
    const sources = [
      { width: 854, height: 480 }, // the reported source
      { width: 640, height: 480 }, // 4:3
      { width: 1440, height: 1080 }, // 4:3 HD
      { width: 2048, height: 858 }, // 2.39:1 scope
      { width: 1080, height: 1920 }, // portrait
      { width: 3840, height: 2160 }, // UHD 16:9
      { width: 1918, height: 1080 } // off-by-two width
    ];
    const rungs = readVideoRungs(fitted.yaml);
    for (const source of sources) {
      for (const rung of rungs) {
        const check = levelCheck(rung, source);
        expect({ source, suffix: rung.suffix, ok: check.frameFits && check.dpbFits }).toEqual({
          source,
          suffix: rung.suffix,
          ok: true
        });
      }
    }
  });

  it('is idempotent — a second fit changes nothing', () => {
    const again = fitProfileLadderToLevel(fitted.yaml);
    expect(again.changed).toBe(false);
    expect(again.adjustments).toEqual([]);
    expect(again.yaml).toBe(fitted.yaml);
  });
});

describe('fitProfileLadderToLevel leaves everything else alone', () => {
  it('does not touch a rung that already declares its own width', () => {
    const yaml = `encodes:
  - type: X264Encode
    suffix: _x264
    width: 1280
    height: 720
    params:
      level: 3.1
`;
    expect(fitProfileLadderToLevel(yaml)).toEqual({ yaml, changed: false, adjustments: [] });
  });

  it('does not touch a rung with no declared level (the encoder derives one)', () => {
    const yaml = `encodes:
  - type: X264Encode
    suffix: _x264
    height: 1080
    params:
      crf: "23"
`;
    expect(fitProfileLadderToLevel(yaml).changed).toBe(false);
  });

  it('does not touch a SpEL-parametrised height (built-in loudness profile)', () => {
    const yaml = `encodes:
  - type: X264Encode
    suffix: _x264
    height: #{profileParams['height']?:1080}
    params:
      level: 4.1
`;
    expect(fitProfileLadderToLevel(yaml).changed).toBe(false);
  });

  it('bounds by the declared level when the level is too low for the height', () => {
    const yaml = `encodes:
  - type: X264Encode
    suffix: _x264
    height: 1080
    params:
      level: 3.1
    x264-params:
      ref: 4
`;
    const result = fitProfileLadderToLevel(yaml);
    expect(result.adjustments).toEqual([
      { suffix: '_x264', height: 1080, level: '3.1', width: 832, levelConstrained: true }
    ]);
    // 832x1080 is 52x68 = 3536 mbs, inside level 3.1's 3600, and the DPB is
    // 4 x 3536 = 14144 inside 18000 — so the encode runs instead of aborting.
    const check = levelCheck({ width: 832, height: 1080, level: '3.1', ref: 4 }, HD_SOURCE);
    expect(check.frameFits).toBe(true);
    expect(check.dpbFits).toBe(true);
  });

  it('returns a profile with no encodes unchanged', () => {
    expect(fitProfileLadderToLevel('name: program\n').changed).toBe(false);
    expect(fitProfileLadderToLevel('').changed).toBe(false);
  });
});

describe('profile bootstrap applies the fit (issue #1167)', () => {
  it('stores a level-safe ladder when seeding the remote index', async () => {
    const repo = new InMemoryProfileRepository();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith('/profiles.yml')) {
          return new Response('program: program.yml\n', { status: 200 });
        }
        if (url.endsWith('/program.yml')) {
          return new Response(PROGRAM_LADDER_YAML, { status: 200 });
        }
        return new Response('not found', { status: 404 });
      })
    );

    const result = await bootstrapProfiles({
      repository: repo,
      indexUrl: 'https://example.test/dir/profiles.yml'
    });
    expect(result.seeded).toBe(1);

    const stored = await repo.get('program');
    expect(stored?.yaml).toBe(fitProfileLadderToLevel(PROGRAM_LADDER_YAML).yaml);
    for (const rung of readVideoRungs(stored?.yaml ?? '')) {
      const check = levelCheck(rung, SINTEL_TRAILER);
      expect(check.frameFits && check.dpbFits).toBe(true);
    }
    vi.restoreAllMocks();
  });

  it('re-fits an already-stored ladder on the skip path, without any fetch', async () => {
    // A deployment provisioned before this fix: the unsafe ladder is already in
    // the store, so the remote seed is skipped and nothing would otherwise
    // re-read it. The fit must still land.
    const repo = new InMemoryProfileRepository();
    await repo.create({ name: 'program', yaml: PROGRAM_LADDER_YAML });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const result = await bootstrapProfiles({
      repository: repo,
      indexUrl: 'https://example.test/profiles.yml'
    });
    expect(result.skipped).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();

    const stored = await repo.get('program');
    expect(readVideoRungs(stored?.yaml ?? '').map((r) => r.width)).toEqual([
      1920, 1280, 960, 640, 416
    ]);

    // Second startup: idempotent, the stored YAML does not change again.
    const afterFirst = stored?.yaml;
    await bootstrapProfiles({ repository: repo, indexUrl: 'https://example.test/profiles.yml' });
    expect((await repo.get('program'))?.yaml).toBe(afterFirst);
    vi.restoreAllMocks();
  });
});
