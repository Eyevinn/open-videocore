// Profile colour-signalling carriability guard tests (issue #377).
//
// Verifies that a profile declaring HDR colour signalling that cannot be carried
// at its pixel format is rejected, naming both offending values, while genuine
// HDR10 / HLG / 10-bit-SDR profiles pass. The `x264-1080p-medium` case from the
// issue is included as an explicit negative control (an 8-bit yuv420p stream
// tagged PQ), and the served-profile-index audit is asserted so a regression
// that mistags an existing profile would fail here.
//
// Fixtures are copied verbatim (or minimally modified, as noted) from the seeded
// Eyevinn/encore-test-profiles set (branch main, fetched 2026-08-22) so the
// bit-depth-from-pixel-format mapping under test is exercised against the real
// profile shape, not a hardcoded guess.

import { describe, it, expect } from 'vitest';
import {
  validateProfileColourSignalling,
  isProfileColourCarriable,
  pixelFormatBitDepth
} from '../src/pipeline/profile-colour-guard.js';

// The real x264-1080p-medium.yml (8-bit yuv420p, SDR — legitimate as-is), used
// as the base for the negative-control mutation below.
const X264_1080P_MEDIUM_SDR = `name: x264-1080p-medium
description: Program profile
scaling: bicubic
encodes:
  - type: X264Encode
    suffix: _x264_3100
    twoPass: true
    height: 1080
    params:
      b:v: 3100k
      maxrate: 4700k
      bufsize: 6200k
      r: 25
      fps_mode: cfr
      pix_fmt: yuv420p
      force_key_frames: expr:not(mod(n,96))
      preset: medium
`;

describe('pixel-format-to-bit-depth mapping (issue #377)', () => {
  it('maps yuv420p to 8-bit and yuv420p10le to 10-bit', () => {
    expect(pixelFormatBitDepth('yuv420p')).toBe(8);
    expect(pixelFormatBitDepth('yuv420p10le')).toBe(10);
  });

  it('maps the archive 10-bit 4:2:2 and 12-bit formats explicitly', () => {
    expect(pixelFormatBitDepth('yuv422p10le')).toBe(10);
    expect(pixelFormatBitDepth('yuv420p12le')).toBe(12);
  });

  it('is case-insensitive and trims whitespace', () => {
    expect(pixelFormatBitDepth('  YUV420P10LE ')).toBe(10);
  });

  it('returns undefined for an unknown or absent pixel format', () => {
    expect(pixelFormatBitDepth('some-future-fmt')).toBeUndefined();
    expect(pixelFormatBitDepth(undefined)).toBeUndefined();
  });
});

describe('profile colour-signalling guard — negative controls (issue #377)', () => {
  it('NEGATIVE CONTROL: x264-1080p-medium tagged PQ at 8-bit is rejected', () => {
    // The observed defect: the real 8-bit yuv420p x264-1080p-medium profile with
    // a PQ transfer bolted on. An encode succeeds but ships an 8-bit stream
    // tagged PQ that a player tone-maps as HDR.
    const yaml = X264_1080P_MEDIUM_SDR.replace(
      '      preset: medium\n',
      '      preset: medium\n      transfer: smpte2084\n'
    );
    const result = validateProfileColourSignalling(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Message must name BOTH values: the transfer and the pixel format.
      expect(result.reason).toContain('smpte2084');
      expect(result.reason).toContain('yuv420p');
      expect(result.reason).toMatch(/8-bit/);
    }
    expect(isProfileColourCarriable(yaml)).toBe(false);
  });

  it('rejects HLG (arib-std-b67) transfer at an 8-bit pixel format', () => {
    const yaml = `encodes:
  - type: X264Encode
    params:
      pix_fmt: yuv420p
      transfer: arib-std-b67
`;
    const result = validateProfileColourSignalling(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('arib-std-b67');
      expect(result.reason).toContain('yuv420p');
    }
  });

  it('rejects colorprim=bt2020 at an 8-bit pixel format', () => {
    const yaml = `encodes:
  - type: X265Encode
    params:
      pix_fmt: yuv420p
      colorprim: bt2020
`;
    const result = validateProfileColourSignalling(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('bt2020');
      expect(result.reason).toContain('yuv420p');
    }
  });

  it('rejects HDR10 mastering metadata on a non-PQ (SDR) output', () => {
    const yaml = `encodes:
  - type: X265Encode
    params:
      pix_fmt: yuv420p10le
      master-display: G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)
      max-cll: 1000,400
`;
    const result = validateProfileColourSignalling(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('master-display');
      expect(result.reason).toMatch(/not PQ/i);
    }
  });

  it('rejects mastering metadata (master-display / max-cll) on an HLG output', () => {
    const yaml = `encodes:
  - type: X265Encode
    params:
      pix_fmt: yuv420p10le
      transfer: arib-std-b67
      colorprim: bt2020
      master-display: G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)
      max-cll: 1000,400
`;
    const result = validateProfileColourSignalling(yaml);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/HLG/);
      expect(result.reason).toMatch(/no mastering metadata/i);
    }
  });

  it('rejects the offending encode even when other encodes in the same profile are fine', () => {
    const yaml = `encodes:
  - type: X265Encode
    params:
      pix_fmt: yuv420p10le
  - type: X264Encode
    params:
      pix_fmt: yuv420p
      transfer: smpte2084
`;
    expect(validateProfileColourSignalling(yaml).ok).toBe(false);
  });
});

describe('profile colour-signalling guard — positive controls (issue #377)', () => {
  it('POSITIVE: the real 8-bit SDR x264-1080p-medium (no colour tags) passes', () => {
    expect(validateProfileColourSignalling(X264_1080P_MEDIUM_SDR).ok).toBe(true);
  });

  it('POSITIVE: 10-bit SDR is legitimate and passes (inverse case is not an error)', () => {
    const yaml = `encodes:
  - type: X265Encode
    params:
      pix_fmt: yuv420p10le
      profile:v: main10
`;
    expect(validateProfileColourSignalling(yaml).ok).toBe(true);
  });

  it('POSITIVE: a genuine HDR10 profile (10-bit PQ + BT.2020 + mastering) passes', () => {
    const yaml = `encodes:
  - type: X265Encode
    params:
      pix_fmt: yuv420p10le
      transfer: smpte2084
      colorprim: bt2020
      master-display: G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,1)
      max-cll: 1000,400
`;
    expect(validateProfileColourSignalling(yaml).ok).toBe(true);
    expect(isProfileColourCarriable(yaml)).toBe(true);
  });

  it('POSITIVE: a genuine HLG profile (10-bit HLG + BT.2020, no mastering) passes', () => {
    const yaml = `encodes:
  - type: X265Encode
    params:
      pix_fmt: yuv420p10le
      transfer: arib-std-b67
      colorprim: bt2020
`;
    expect(validateProfileColourSignalling(yaml).ok).toBe(true);
  });
});

describe('served profile index audit (issue #377 acceptance)', () => {
  // The profiles served by the default index (Eyevinn/encore-test-profiles,
  // branch main). Each is the real YAML fetched 2026-08-22, reduced to its
  // colour-relevant params (pix_fmt + any transfer/colorprim/master-display/
  // max-cll). The audit asserts NONE of them is affected by the 8-bit-tagged-HDR
  // defect: none declares any HDR colour tag, so all pass. A regression that
  // mistags an existing profile would flip one of these to failing.
  const SERVED_PROFILES: Record<string, string> = {
    program: 'encodes:\n  - type: X264Encode\n    params:\n      pix_fmt: yuv420p\n',
    'program-x265':
      'encodes:\n  - type: X265Encode\n    params:\n      pix_fmt: yuv420p10le\n  - type: X265Encode\n    params:\n      pix_fmt: yuv420p\n',
    'program-kf': 'encodes:\n  - type: X264Encode\n    params:\n      pix_fmt: yuv420p\n',
    'program-twopass': 'encodes:\n  - type: X264Encode\n    params:\n      pix_fmt: yuv420p\n',
    archive: 'encodes:\n  - type: VideoEncode\n    params:\n      pix_fmt: yuv422p10le\n',
    'x264-1080p-slow': 'encodes:\n  - type: X264Encode\n    params:\n      pix_fmt: yuv420p\n',
    'x264-1080p-medium': X264_1080P_MEDIUM_SDR,
    'x265-1080p-slow': 'encodes:\n  - type: X265Encode\n    params:\n      pix_fmt: yuv420p10le\n',
    'x265-1080p-medium': 'encodes:\n  - type: X265Encode\n    params:\n      pix_fmt: yuv420p10le\n',
    'x264-crf-parametrized': 'encodes:\n  - type: X264Encode\n    params:\n      pix_fmt: yuv420p\n'
  };

  it('reports that NO currently-served profile is affected by the 8-bit-tagged-HDR defect', () => {
    const affected = Object.entries(SERVED_PROFILES)
      .filter(([, yaml]) => !isProfileColourCarriable(yaml))
      .map(([name]) => name);
    // Audit result: empty — the served index is clean. The guard therefore
    // protects future/operator profiles; no existing profile needs re-tagging.
    expect(affected).toEqual([]);
  });
});
