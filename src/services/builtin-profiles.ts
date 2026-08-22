// Built-in Encore transcoding profiles shipped with the API (issue #385).
//
// The default profile set is normally seeded from a remote Encore profile index
// (ENCORE_PROFILES_URL -> the Eyevinn encore-test-profiles; see
// src/services/profile-bootstrap.ts + src/main.ts). Some profiles, however, must
// ship as part of the standard served set regardless of that remote index — they
// are a capability of THIS API, not of the upstream test-profile repo. This
// module holds those built-in profiles; bootstrapProfiles seeds them into the
// per-tenant profile store alongside (and taking precedence over) the remote
// index, so they always appear in GET /index.yml and are selectable by name.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - docs/architecture/encore-audioencode-loudnorm-contract.md (#383): the
//     verified upstream SVT Encore contract. `AudioEncode.filters: List<String>`
//     is joined with commas and inserted VERBATIM into the ffmpeg audio filter
//     chain ((dialogueEnhanceFilters + mixFilters + filters).joinToString(","),
//     AudioEncode.kt). YAML path: `encodes[] where type == "AudioEncode" ->
//     .filters[]`. loudnorm form: `loudnorm=I=-23:TP=-1:LRA=7`.
//   - docs/architecture/ADR-013-loudnorm-pass-mode.md (#384): DECISION = ship
//     single-pass DYNAMIC loudnorm as a profile-only change (NOT two-pass
//     measure-then-apply orchestration). So this profile carries a single
//     `loudnorm=...` filter element; the target rides profileParams.
//   - src/pipeline/profile-params.ts:24-53 + test/profile-params-allowlist.test.ts:
//     the SpEL default form Encore evaluates is `#{profileParams['<key>']?:<default>}`
//     (Spring Expression Language property indexing on the profileParams map).
//     declaredProfileParamKeys() extracts `<key>` from exactly this shape, so the
//     target key below is auto-allowlisted for POST /:id/transcode (#290).
//   - src/services/profile-runnability.ts: a profile is RUNNABLE iff it uses no
//     NVENC/CUDA markers (_nvenc, scale_cuda, hwaccel: cuda). This profile uses a
//     CPU X264 video encode + a CPU AAC AudioEncode, so it passes isProfileRunnable.

export type BuiltinProfile = {
  name: string;
  yaml: string;
};

// The profileParams SpEL key carrying the integrated-loudness target (LUFS).
// Rides the existing profileParams channel wired in #287/#288/#289 (transcode
// request -> EncoreSubmitInput.profileParams -> toEncorePayload). A caller sets
// it per request, e.g. { profileParams: { targetI: '-16' } }; when omitted the
// SpEL default below applies.
export const LOUDNORM_TARGET_PARAM = 'targetI';

// DEFAULT integrated-loudness target: -23 LUFS.
//
// Chosen default = -23 LUFS, the EBU R128 / broadcast integrated-loudness target
// (ITU-R BS.1770 gated measurement). This is the correct conservative default for
// a general media asset manager: it is the widely-mandated broadcast delivery
// level. Streaming targets (-16 / -14 LUFS) are reachable per request by setting
// profileParams.targetI without editing the profile. TP=-1 (true-peak ceiling
// -1 dBTP) and LRA=7 (loudness range) are the standard EBU R128 companions and
// are held fixed here; only the integrated target is parametrised for #385.
export const LOUDNORM_DEFAULT_TARGET_LUFS = -23;

// The name of the built-in loudness-normalisation profile. Descriptive and
// non-trademarked: it names the standard (EBU R128) it targets, nothing more.
export const LOUDNORM_PROFILE_NAME = 'loudnorm-ebu-r128';

// The single-pass loudnorm filter string, with the integrated-loudness target
// (`I=`) supplied via a profileParams SpEL expression defaulting to -23 LUFS.
// Per ADR-013 this is single-pass DYNAMIC loudnorm (one ffmpeg invocation, no
// measure-then-apply). The `I=` value is the only parametrised field; TP/LRA are
// the fixed EBU R128 companions. This exact string becomes one element of the
// AudioEncode.filters list and reaches ffmpeg verbatim (contract #383).
//
// NOTE (issue #386, DEFERRED): audible / MEASURED verification that the output
// integrated loudness actually lands on the requested target is issue #386 and is
// deferred for live measurement — 0 Encore instances are provisioned for this
// workspace (see ADR-013 "Empirical validation: DEFERRED"). No measured result is
// fabricated here; this ships the parametrised profile only.
export const LOUDNORM_FILTER = `loudnorm=I=#{profileParams['${LOUDNORM_TARGET_PARAM}']?:${LOUDNORM_DEFAULT_TARGET_LUFS}}:TP=-1:LRA=7`;

// The served YAML for the loudness-normalisation profile. A CPU X264 video encode
// (keeps the rendition complete and RUNNABLE — no NVENC/CUDA) plus an AudioEncode
// carrying the single-pass loudnorm filter. Structure matches the verified
// upstream Profile/AudioEncode shape (encodes[].type discriminator; filters is a
// YAML list of ffmpeg filter strings) — contract #383 §2/§3.
const LOUDNORM_PROFILE_YAML = `name: ${LOUDNORM_PROFILE_NAME}
description: EBU R128 / BS.1770 single-pass loudness-normalised audio; integrated-loudness target (LUFS) settable via profileParams['${LOUDNORM_TARGET_PARAM}'] (default ${LOUDNORM_DEFAULT_TARGET_LUFS}).
scaling: bicubic
encodes:
  - type: X264Encode
    suffix: _x264
    twoPass: false
    height: #{profileParams['height']?:1080}
    params:
      preset: medium
      crf: "23"
  - type: AudioEncode
    codec: aac
    bitrate: 128k
    samplerate: 48000
    filters:
      - ${LOUDNORM_FILTER}
`;

// All profiles shipped built-in with the API (currently just the loudness one).
// bootstrapProfiles seeds these into the profile store on startup/bootstrap.
export const BUILTIN_PROFILES: BuiltinProfile[] = [
  { name: LOUDNORM_PROFILE_NAME, yaml: LOUDNORM_PROFILE_YAML }
];
