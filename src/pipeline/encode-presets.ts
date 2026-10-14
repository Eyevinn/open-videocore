// Encode profile selection vocabulary (issue #8; narrowed by issue #1022).
//
// IMPORTANT — Encore profiles are SERVER-SIDE named configurations:
// the `profile` field of a job submission is a NAME STRING that Encore resolves
// against its own profile index. A job document cannot carry an inline outputs
// ladder, so there is nothing for this module to model beyond the name.
//
// Contract sources verified before writing (CLAUDE.md rule 7), fetched
// 2026-10-05 from the upstream transcoding service this API submits to
// (github.com/svt/encore, the project already cited by encore-client.ts and
// docs/architecture/encore-audioencode-loudnorm-contract.md):
//   - `encore-common/src/main/kotlin/se/svt/oss/encore/model/EncoreJob.kt`
//     — the job document. Fields: `val profile: String` (:52),
//     `val profileParams: Map<String, Any?>` (:58), `val outputFolder: String`
//     (:66), `val baseName: String` (:74), `val inputs: List<Input>` (:180).
//     There is NO `outputs` (or any inline-profile) field on the job document.
//   - `encore-common/src/main/kotlin/se/svt/oss/encore/service/profile/ProfileService.kt`
//     — `fun getProfile(job: EncoreJob): Profile` reads the configured profile
//     index (`properties.location`) as a `Map<String, String>` and resolves
//     `profiles[job.profile]`, throwing
//     "Could not find location for profile ${job.profile}!" when the name is
//     absent. Name-based resolution is the ONLY selection mechanism.
//
// WHY THERE IS NO `EncoreProfile`/`EncoreOutput` TYPE HERE ANY MORE (issue
// #1022): the API used to accept a `customProfile` carrying a fully-validated
// `outputs` ladder (label/width/height/bitrates/format) and then submit only its
// `name`, silently discarding every encoding setting the caller supplied. Per
// the contract above that ladder can never reach the transcoding service from a
// job submission, so the field was removed from the API rather than left as a
// field that validates and does nothing. An encoding ladder is defined by
// registering a profile (POST /api/v1/profiles, src/routes/profiles.ts) and then
// naming it in `profile`; the profile store is what the transcoding instances
// load, via the public index (GET /api/v1/profiles/index.yml).

// Preset-name vocabulary kept for the compatibility submit surface
// (src/routes/encore-compat.ts:238), which recognises these names in an
// incoming job document's `profile.name`. Each value is forwarded verbatim as
// the server-side profile name, so a deployment must have a profile of that
// name registered for it to resolve.
export const PRESET_NAMES = ['1080p', '720p', '480p'] as const;
export type PresetName = (typeof PRESET_NAMES)[number];
