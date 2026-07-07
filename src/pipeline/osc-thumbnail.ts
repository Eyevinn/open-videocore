// Default FrameExtractor backed by the OSC eyevinn-ffmpeg-s3 ephemeral job
// (issue #7).
//
// eyevinn-ffmpeg-s3 downloads the `-i` source URL (a short-lived presigned GET
// URL) before running ffmpeg. For OUTPUT we write to an `s3://bucket/key` URI,
// not a presigned PUT URL: ffmpeg's `image2` muxer writes to file paths /
// protocols it can open for output, and a presigned HTTP PUT endpoint is NOT one
// of them — pointing `-f image2` at a presigned PUT URL silently produces no
// object, so the stored thumbnail key never exists and the API thumbnail proxy
// serves a broken image (issue #92). eyevinn-ffmpeg-s3 supports S3 output
// natively when handed AWS-compatible credentials in the job body
// (`awsAccessKeyId`, `awsSecretAccessKey`, `s3EndpointUrl` — the MinIO endpoint,
// per ADR-001), so we use that instead.
//
// OSC FRICTION (logged, issue #6): eyevinn-ffmpeg-s3 exposes no structured job
// result and ffprobe is not accessible — see
// docs/osc-feedback/submitted-2026-06-02-issue6-metadata.md.

import {
  createJob,
  getLogsForInstance,
  removeJob,
  getJob,

  type Context
} from '@osaas/client-core';
import { FFPROBE_SERVICE_ID } from '../services/stack.js';
import { pollOscJobUntilDone } from './osc-job-poll.js';
import type { FrameExtractor, FrameTarget } from './thumbnail.js';

export type OscJobApi = {
  context: Context;
  createJob: typeof createJob;
  getJob: typeof getJob;

  getLogsForInstance: typeof getLogsForInstance;
  removeJob: typeof removeJob;
  // MinIO/S3 credentials + bucket for native S3 output. Passed in the job body
  // so ffmpeg writes each frame directly to `s3://bucket/key` (a presigned HTTP
  // PUT URL does not work with the image2 muxer — see the file header, issue #92).
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Bucket: string;
};

// Build an ffmpeg command that seeks to each timecode and writes one JPEG per
// frame to `s3://bucket/<objectKey>`. One job covers all frames in a single pass.
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
      const status = await pollOscJobUntilDone(api, FFPROBE_SERVICE_ID, name, sat);
      if (status === 'Failed' || status === 'Error') {
        throw new Error(`OSC thumbnail job "${name}" ended with status "${status}"`);
      }
    } finally {
      try {
        await api.removeJob(api.context, FFPROBE_SERVICE_ID, name, sat);
      } catch {
        // ignore cleanup failure
      }
    }
  };
}
