// Built-in pipeline definitions (PipelineExecution feature).
//
// A pipeline is an ordered list of processing steps applied to a source asset.
// The API exposes a small set of named built-in pipelines; POST /assets/:id/execute
// runs one of them and tracks progress as a first-class PipelineExecution entity
// (see src/data/pipeline-repo.ts) rather than ad-hoc fields on the asset.

export const PIPELINE_STEPS = ['extract-metadata', 'thumbnail', 'transcode', 'package'] as const;
export type PipelineStepName = (typeof PIPELINE_STEPS)[number];

export const BUILT_IN_PIPELINES: Record<string, PipelineStepName[]> = {
  encode: ['transcode'],
  'abr-vod': ['transcode', 'package'],
  ingest: ['extract-metadata', 'thumbnail'],
  full: ['extract-metadata', 'thumbnail', 'transcode', 'package']
};

export const PIPELINE_DESCRIPTIONS: Record<string, string> = {
  encode: 'Encode the source file using the selected profile. Profile is chosen at execution time.',
  'abr-vod': 'Encode then package to HLS/DASH for streaming. Profile is chosen at execution time.',
  ingest: 'Extract technical metadata and generate thumbnail frames.',
  full: 'Full pipeline: metadata extraction, thumbnails, encode, and HLS/DASH packaging.'
};

export const PIPELINE_NAMES = Object.keys(BUILT_IN_PIPELINES) as (keyof typeof BUILT_IN_PIPELINES)[];
