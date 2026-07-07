// Default ClipRunner backed by the OSC eyevinn-ffmpeg-s3 ephemeral job
// (issue #17).
//
// The same service used for ffprobe (issue #6) and thumbnails (issue #7) runs
// ffmpeg against a downloaded HTTPS source. For clips we seek to the window
// start, stream-copy until the window end, and write the result to the clip's
// presigned PUT URL. eyevinn-ffmpeg-s3 downloads the `-i` source URL before
// running ffmpeg and uploads ffmpeg's output files back to S3, so the
// destination is handed as a presigned PUT URL.
//
// Input-level `-ss` before `-i` keeps the seek fast; `-to` bounds the output to
// the window end (interpreted relative to the post-seek timeline). `-c copy`
// stream-copies without re-encoding so the clip is produced quickly and without
// quality loss. `-y` overwrites so re-runs are idempotent. We do one job per
// clip request, then best-effort removeJob so spent ephemeral instances do not
// accumulate (same lifecycle as osc-ffprobe.ts / osc-thumbnail.ts).

import {
  createJob,
  getLogsForInstance,
  removeJob,
  getJob,

  type Context
} from '@osaas/client-core';
import { FFPROBE_SERVICE_ID } from '../services/stack.js';
import { pollOscJobUntilDone } from './osc-job-poll.js';
import type { ClipRunner } from './clip.js';

// Subset of the OSC SDK surface this runner needs. Declared structurally so the
// real SDK functions satisfy it and tests can pass lightweight fakes (mirrors
// OscJobApi in osc-ffprobe.ts / osc-thumbnail.ts).
export type OscJobApi = {
  context: Context;
  createJob: typeof createJob;
  getJob: typeof getJob;

  getLogsForInstance: typeof getLogsForInstance;
  removeJob: typeof removeJob;
};

// Build the ffmpeg command line that extracts [startSeconds, endSeconds) from
// the source and writes it to the destination PUT URL. The `.mp4` URL forces
// the MP4 muxer; `-c copy` avoids a re-encode.
export function clipCmdLine(
  sourceUrl: string,
  putUrl: string,
  startSeconds: number,
  endSeconds: number
): string {
  return `-y -ss ${startSeconds} -to ${endSeconds} -i "${sourceUrl}" -c copy "${putUrl}"`;
}

// A unique, OSC-valid ephemeral job name. Lowercase alphanumeric, bounded
// length (OSC instance-name constraints). Mirrors probeJobName/thumbnailJobName.
function clipJobName(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36).slice(-6);
  return `clip${ts}${rand}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
}

// Construct the production ClipRunner. Each invocation creates one ephemeral
// ffmpeg job that writes the clip, waits for completion, then best-effort
// removes the job.
export function makeOscClipRunner(api: OscJobApi): ClipRunner {
  return async (
    sourceUrl: string,
    putUrl: string,
    startSeconds: number,
    endSeconds: number
  ): Promise<void> => {
    const sat = await api.context.getServiceAccessToken(FFPROBE_SERVICE_ID);
    const name = clipJobName();
    await api.createJob(api.context, FFPROBE_SERVICE_ID, sat, {
      name,
      cmdLineArgs: clipCmdLine(sourceUrl, putUrl, startSeconds, endSeconds)
    });
    try {
      const _status = await pollOscJobUntilDone(api, FFPROBE_SERVICE_ID, name, sat);
      if (_status === 'Failed' || _status === 'Error') throw new Error(`OSC job "${name}" failed with status "${_status}"`);
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
