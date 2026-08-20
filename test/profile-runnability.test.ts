// Profile runnability detection tests (issue #286).
//
// Verifies content-based detection of GPU-only (NVENC/CUDA) profiles against the
// shape of the actual seeded profiles (Eyevinn/encore-test-profiles): NVENC
// video encodes use `codec: hevc_nvenc` and CUDA-only filters (`scale_cuda`,
// `hwaccel: cuda`); CPU profiles use X264/X265 encodes with no CUDA markers.

import { describe, it, expect } from 'vitest';
import {
  isGpuOnlyProfileYaml,
  isProfileRunnable
} from '../src/services/profile-runnability.js';

describe('profile runnability detection (issue #286)', () => {
  it('flags an NVENC-codec profile as GPU-only / not runnable', () => {
    const yaml = 'name: x\nencodes:\n  - type: VideoEncode\n    codec: hevc_nvenc\n    height: 1080\n';
    expect(isGpuOnlyProfileYaml(yaml)).toBe(true);
    expect(isProfileRunnable(yaml)).toBe(false);
  });

  it('flags a CUDA scale-filter profile as GPU-only', () => {
    const yaml = 'name: x\nfilterSettings:\n  scaleFilter: scale_cuda\n';
    expect(isGpuOnlyProfileYaml(yaml)).toBe(true);
  });

  it('flags a cuda hwaccel input profile as GPU-only', () => {
    const yaml = 'name: x\ninputs:\n  - params:\n      hwaccel: cuda\n';
    expect(isGpuOnlyProfileYaml(yaml)).toBe(true);
  });

  it('treats a plain X264 CPU profile as runnable', () => {
    const yaml = 'name: program\nencodes:\n  - type: X264Encode\n    height: 1080\n';
    expect(isGpuOnlyProfileYaml(yaml)).toBe(false);
    expect(isProfileRunnable(yaml)).toBe(true);
  });

  it('treats an X265 CPU profile as runnable (not confused by "x265" naming)', () => {
    const yaml = 'name: program-x265\nencodes:\n  - type: X265Encode\n    suffix: _x265_2600\n';
    expect(isProfileRunnable(yaml)).toBe(true);
  });
});
