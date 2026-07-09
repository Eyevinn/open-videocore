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

export const BUILT_IN_PIPELINES: Record<string, PipelineStepName[]> = {
  transcode: ['transcode'],
  'abr-vod': ['transcode', 'package'],
  ingest: ['extract-metadata', 'thumbnail'],
  subtitles: ['subtitles'],
  'scene-detect': ['scene-detect'],
  full: ['extract-metadata', 'thumbnail', 'subtitles', 'scene-detect', 'transcode', 'package']
};

export const PIPELINE_DESCRIPTIONS: Record<string, string> = {
  transcode: 'Transcode the source file using the selected profile. Profile is chosen at execution time.',
  'abr-vod': 'Transcode then package to HLS/DASH for streaming. Profile is chosen at execution time.',
  ingest: 'Extract technical metadata and generate thumbnail frames.',
  subtitles: 'Auto-generate a subtitle track from the audio using Whisper transcription and attach it to the asset.',
  'scene-detect': 'Detect scene/shot boundaries and keyframes and attach them to the asset for clip and trim workflows.',
  full: 'Full pipeline: metadata extraction, thumbnails, auto-subtitles, scene detection, transcode, and HLS/DASH packaging.'
};

export const PIPELINE_NAMES = Object.keys(BUILT_IN_PIPELINES) as (keyof typeof BUILT_IN_PIPELINES)[];
