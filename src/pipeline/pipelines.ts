// Built-in pipeline definitions (PipelineExecution feature).
//
// A pipeline is an ordered list of processing steps applied to a source asset.
// The API exposes a small set of named built-in pipelines; POST /assets/:id/execute
// runs one of them and tracks progress as a first-class PipelineExecution entity
// (see src/data/pipeline-repo.ts) rather than ad-hoc fields on the asset.

// `subtitles` (issue #114) is an OPTIONAL, fire-and-forget step: it auto-
// generates a subtitle track via the OSC eyevinn-auto-subtitles (Whisper)
// service and attaches it to the asset. Like `extract-metadata` it settles
// immediately and never blocks the ingest path, so it is deliberately NOT part
// of the default `ingest` pipeline — a caller opts in via `full` or the dedicated
// `subtitles` pipeline.
//
// `scene-detect` (issue #115) is likewise an OPTIONAL, fire-and-forget step: it
// runs the OSC eyevinn-function-scenes media function to produce keyframe +
// scene-boundary metadata (for clip/trim workflows) and writes it onto the asset
// as `sceneMetadata`. Like `extract-metadata` and `subtitles` it settles
// immediately and never blocks the ingest path, so it is deliberately NOT part of
// the default `ingest` pipeline — a caller opts in via `full` or the dedicated
// `scene-detect` pipeline.
export const PIPELINE_STEPS = ['extract-metadata', 'thumbnail', 'subtitles', 'scene-detect', 'transcode', 'package'] as const;
export type PipelineStepName = (typeof PIPELINE_STEPS)[number];

// `package` (issue #739) is a PACKAGE-ONLY pipeline: it packages an asset's
// EXISTING transcode output to HLS/DASH without re-encoding. Unlike `abr-vod`
// (transcode + package) it dispatches no Encore transcode job, so it costs the
// packaging step alone rather than a full re-encode. Its purpose is RECOVERY:
// resuming a pipeline whose `transcode` succeeded but whose `package` failed,
// from the UI and from POST /:id/execute, instead of redoing the encode.
//
// SCOPE — bounded by the packager's contract, not by this repo. The packager's
// work item is `{ jobId, url }` where `url` is an Encore job API URL it fetches
// to locate the transcoded output (CONTRACT: `PackagingJob`,
// src/pipeline/packaging.ts:166-174, verified from the packager's
// redisListener.ts; ADR-021-external-s3-endpoint-source-and-packaged C3). There
// is no work-item form keyed by rendition object keys, and an Encore job
// document is only served while its instance is in the pool. So this pipeline is
// runnable exactly while a completed transcode's Encore job is still resolvable;
// packaging an asset transcoded long ago (whose instance is gone) needs a
// packager-side capability that does not exist yet — logged as OSC friction in
// docs/osc-feedback/incoming-packager-input-encore-job-url-only.md.
//
// Because `package` is the FIRST (and only) step, the execute path pre-flights
// BOTH conditions before creating an execution and 409s with the specific reason
// (`no_renditions` / `no_transcode_job` / `instance_not_found`) — see
// startPipelineExecution in src/routes/assets.ts. It never dispatches a
// packaging job it knows the packager cannot act on.
export const BUILT_IN_PIPELINES: Record<string, PipelineStepName[]> = {
  transcode: ['transcode'],
  'abr-vod': ['transcode', 'package'],
  package: ['package'],
  ingest: ['extract-metadata', 'thumbnail'],
  subtitles: ['subtitles'],
  'scene-detect': ['scene-detect'],
  full: ['extract-metadata', 'thumbnail', 'subtitles', 'scene-detect', 'transcode', 'package']
};

export const PIPELINE_DESCRIPTIONS: Record<string, string> = {
  transcode: 'Transcode the source file using the selected profile. Profile is chosen at execution time.',
  'abr-vod': 'Transcode then package to HLS/DASH for streaming. Profile is chosen at execution time.',
  package: 'Package an already-transcoded asset to HLS/DASH without re-encoding. Use it to finish a run whose transcode succeeded but whose packaging failed. Requires an existing transcode whose job is still resolvable.',
  ingest: 'Extract technical metadata and generate thumbnail frames.',
  subtitles: 'Auto-generate a subtitle track from the audio using Whisper transcription and attach it to the asset.',
  'scene-detect': 'Detect scene/shot boundaries and keyframes and attach them to the asset for clip and trim workflows.',
  full: 'Full pipeline: metadata extraction, thumbnails, auto-subtitles, scene detection, transcode, and HLS/DASH packaging.'
};

export const PIPELINE_NAMES = Object.keys(BUILT_IN_PIPELINES) as (keyof typeof BUILT_IN_PIPELINES)[];
