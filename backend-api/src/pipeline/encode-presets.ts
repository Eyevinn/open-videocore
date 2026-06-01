// ABR encoding presets + the Encore profile shape (issue #8).
//
// IMPORTANT — Encore profiles are SERVER-SIDE named configurations:
// The `profile` field in a job submission is a name string that Encore resolves
// against profiles registered in its own configuration. We cannot send an
// inline outputs ladder. Our preset `name` values MUST match profile names
// configured in the provisioned Encore instance.
//
// SMOKE TEST CONFIRMED (2026-06-01): The only known profile in the
// openvideocore Encore instance is "program". The preset names below
// (abr-1080p, abr-720p, abr-480p) are PLACEHOLDERS — they will fail until
// matching profiles are registered in the Encore instance configuration.
//
// The `outputs` field on EncoreProfile is kept for documentation/UI purposes
// (describing what the ladder produces) but is NOT sent to Encore's API.

// A single output rung of an Encore profile. These map to the fields Encore's
// transcode API expects per output rendition.
export type EncoreOutput = {
  // Human label for the rung; also used to name the produced child asset.
  label: string;
  width: number;
  height: number;
  // Target video bitrate in bits per second.
  videoBitrateBps: number;
  // Target audio bitrate in bits per second.
  audioBitrateBps: number;
  // Container/segment format Encore should emit (e.g. "mp4", "fmp4").
  format: string;
};

// An Encore profile. `inputs` are filled in per job (the source object), so a
// stored/preset profile carries only `name` + the `outputs` ladder; the worker
// injects the concrete input when it submits the job.
export type EncoreProfile = {
  name: string;
  inputs?: EncoreInput[];
  outputs: EncoreOutput[];
};

export type EncoreInput = {
  // S3 URI (or presigned URL) of the source object Encore should read.
  uri: string;
  type?: string;
};

export const PRESET_NAMES = ['1080p', '720p', '480p'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];

// Standard audio rung shared by all rungs of every preset (128 kbps AAC).
const AUDIO_BITRATE_BPS = 128_000;

function rung(label: string, width: number, height: number, videoKbps: number): EncoreOutput {
  return {
    label,
    width,
    height,
    videoBitrateBps: videoKbps * 1000,
    audioBitrateBps: AUDIO_BITRATE_BPS,
    format: 'mp4'
  };
}

// The three built-in ABR ladders. Each is named by its top rung; lower rungs
// are conventional steps down so adaptive players can switch under bandwidth
// pressure.
// All presets map to "program" — the only confirmed profile in the OSC Encore
// instance (smoke tested 2026-06-01). The `outputs` array describes the
// intended ladder for documentation purposes but is NOT sent to Encore.
// When Encore is configured with named abr-1080p/720p/480p profiles these
// names can be restored.
export const PRESETS: Record<PresetName, EncoreProfile> = {
  '1080p': {
    name: 'program',
    outputs: [
      rung('1080p', 1920, 1080, 5000),
      rung('720p', 1280, 720, 3000),
      rung('480p', 854, 480, 1500),
      rung('360p', 640, 360, 800)
    ]
  },
  '720p': {
    name: 'program',
    outputs: [
      rung('720p', 1280, 720, 3000),
      rung('480p', 854, 480, 1500),
      rung('360p', 640, 360, 800)
    ]
  },
  '480p': {
    name: 'program',
    outputs: [
      rung('480p', 854, 480, 1500),
      rung('360p', 640, 360, 800)
    ]
  }
};

// Resolve a request's profile selection into a concrete EncoreProfile. Exactly
// one of `preset` / `customProfile` should be supplied; a preset wins if both
// are given is NOT allowed by the route schema, so this assumes a clean input.
export function resolveProfile(
  preset: PresetName | undefined,
  customProfile: EncoreProfile | undefined
): EncoreProfile {
  if (customProfile) {
    return customProfile;
  }
  return PRESETS[preset ?? '1080p'];
}
