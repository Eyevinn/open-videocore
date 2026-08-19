// Profile runnability on the OSC platform tier (issue #286).
//
// Some seeded Encore transcoding profiles target NVENC / CUDA hardware encoders
// that are not available on the OSC platform tier (no GPU on the Encore
// instances the scaler spawns). Selecting such a profile yields a transcode job
// that Encore cannot execute. Two profiles in the default Encore test-profiles
// seed are affected: `program-nvenc-h265` and `nvenc-test`.
//
// This module decides, from a profile's YAML content, whether the profile can
// run on the current platform, so the store can (a) exclude GPU-only profiles
// from the runnable selectable set surfaced to callers and from the public
// Encore-facing index, and (b) reject a transcode that names one with a clear
// 4xx rather than letting it fail silently on Encore.
//
// Detection is content-based, not name-based, so an operator-authored profile
// that also uses NVENC/CUDA is handled the same way. Verified against the actual
// seeded profile YAML (CLAUDE.md rule 7):
//   - program-nvenc-h265.yml / nvenc-test.yml (Eyevinn/encore-test-profiles,
//     branch main, fetched 2026-08-19) — every video encode uses
//     `codec: hevc_nvenc` and CUDA-only filters (`scaleFilter: scale_cuda`,
//     `hwaccel: cuda`). By contrast the CPU profiles (e.g. program.yml) use
//     `type: X264Encode` / codecs without an `_nvenc` suffix and no CUDA
//     filters. NVENC ffmpeg encoders are conventionally suffixed `_nvenc`
//     (h264_nvenc, hevc_nvenc, av1_nvenc), and CUDA hardware acceleration is
//     the `cuda` hwaccel + `_cuda` filters — both are GPU-only.

// Marker patterns that indicate a GPU-only (NVENC/CUDA) profile. Matched
// case-insensitively against the raw profile YAML. Any single match is enough:
//   - `_nvenc`  — the ffmpeg NVENC hardware encoder codec suffix (hevc_nvenc, …)
//   - `scale_cuda` / `_cuda` filter — CUDA hardware scaling/format filters
//   - `hwaccel: cuda` — CUDA hardware decode acceleration
const GPU_ONLY_MARKERS: RegExp[] = [
  /_nvenc\b/i,
  /\bscale_cuda\b/i,
  /hwaccel[^\n]*\bcuda\b/i
];

// Returns true when the profile's YAML uses an NVENC/CUDA encoder or filter that
// the OSC platform tier cannot execute (no GPU on the running Encore instances).
export function isGpuOnlyProfileYaml(yaml: string): boolean {
  return GPU_ONLY_MARKERS.some((re) => re.test(yaml));
}

// A profile is runnable on the current platform when it is NOT GPU-only.
export function isProfileRunnable(yaml: string): boolean {
  return !isGpuOnlyProfileYaml(yaml);
}
