// Default FrameExtractor backed by the OSC eyevinn-ffmpeg-s3 ephemeral job
// (issue #7).
//
// eyevinn-ffmpeg-s3 downloads the `-i` source URL before running ffmpeg and
// uploads ffmpeg's output files back to S3 via the destination URL. We hand it
// a short-lived presigned GET URL for the source and a presigned PUT URL per
// frame, so the service never needs standing credentials.
//
// OSC FRICTION (logged, issue #6): eyevinn-ffmpeg-s3 exposes no structured job
// result and ffprobe is not accessible — see
// docs/osc-feedback/submitted-2026-06-02-issue6-metadata.md.

import {
  createJob,
  getLogsForInstance,
  removeJob,
  getInstanceHealth,

  type Context
} from '@osaas/client-core';
import { FFPROBE_SERVICE_ID } from '../services/stack.js';
import { pollOscJobUntilDone } from './osc-job-poll.js';
import type { FrameExtractor, FrameTarget } from './thumbnail.js';

export type OscJobApi = {
  context: Context;
  createJob: typeof createJob;
  getInstanceHealth: typeof getInstanceHealth;

  getLogsForInstance: typeof getLogsForInstance;
  removeJob: typeof removeJob;
};

// Build an ffmpeg command that seeks to each timecode and writes one JPEG per
// frame to its presigned PUT URL. One job covers all frames in a single pass.
export function thumbnailCmdLine(sourceUrl: string, frames: FrameTarget[]): string {
  if (frames.length === 0) throw new Error('no frames requested');
  return frames
    .map(
      (f) =>
        `-y -ss ${f.timecodeSeconds} -i "${sourceUrl}" -frames:v 1 -f image2 "${f.putUrl}"`
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
      cmdLineArgs: thumbnailCmdLine(sourceUrl, frames)
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
