// Default FrameExtractor backed by the OSC eyevinn-ffmpeg-s3 ephemeral job
// (issue #7).
//
// eyevinn-ffmpeg-s3 supports S3 output natively via s3://bucket/key URIs with
// AWS-compatible credentials (awsAccessKeyId, awsSecretAccessKey, s3EndpointUrl).
// We use that instead of presigned PUT URLs: ffmpeg's image2 muxer writes to
// file paths, not HTTP PUT endpoints, so presigned URLs silently produced no output.
//
// OSC FRICTION (logged, issue #6): eyevinn-ffmpeg-s3 exposes no structured job
// result and ffprobe is not accessible — see
// docs/osc-feedback/submitted-2026-06-02-issue6-metadata.md.

import {
  createJob,
  getLogsForInstance,
  removeJob,
  getJob,
  waitForJobToComplete,
  type Context
} from '@osaas/client-core';
import { FFPROBE_SERVICE_ID } from '../services/stack.js';
import { pollOscJobUntilDone } from './osc-job-poll.js';
import type { FrameExtractor, FrameTarget } from './thumbnail.js';

export type OscJobApi = {
  context: Context;
  createJob: typeof createJob;
  getJob: typeof getJob;
  waitForJobToComplete: typeof waitForJobToComplete;
  getLogsForInstance: typeof getLogsForInstance;
  removeJob: typeof removeJob;
  // MinIO credentials for S3 output — passed in the job body so ffmpeg can
  // write directly to the bucket without a presigned URL.
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Bucket: string;
};

// Build an ffmpeg command that seeks to each timecode and writes one JPEG per
// frame to s3://bucket/key. One job covers all frames in a single pass.
export function thumbnailCmdLine(sourceUrl: string, frames: FrameTarget[], bucket: string): string {
  if (frames.length === 0) throw new Error('no frames requested');
  return frames
    .map(
      (f) =>
        `-y -ss ${f.timecodeSeconds} -i "${sourceUrl}" -frames:v 1 -f image2 "s3://${bucket}/${f.objectKey}"`
    )
    .join(' ');
}

function thumbnailJobName(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36).slice(-6);
  return `thumb${ts}${rand}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
}

export function makeOscThumbnailExtractor(api: OscJobApi): FrameExtractor {
  return async (sourceUrl: string, frames: FrameTarget[]): Promise<void> => {
    const sat = await api.context.getServiceAccessToken(FFPROBE_SERVICE_ID);
    const name = thumbnailJobName();
    await api.createJob(api.context, FFPROBE_SERVICE_ID, sat, {
      name,
      cmdLineArgs: thumbnailCmdLine(sourceUrl, frames, api.s3Bucket),
      awsAccessKeyId: api.s3AccessKey,
      awsSecretAccessKey: api.s3SecretKey,
      s3EndpointUrl: api.s3Endpoint
    });
    try {
      const _status = await pollOscJobUntilDone(api, FFPROBE_SERVICE_ID, name, sat);
      if (_status === 'Failed' || _status === 'Error') {
        throw new Error(`OSC thumbnail job "${name}" ended with status "${_status}"`);
      }
      void _status;
    } finally {
      try {
        await api.removeJob(api.context, FFPROBE_SERVICE_ID, name, sat);
      } catch {
        // ignore cleanup failure
      }
    }
  };
}
