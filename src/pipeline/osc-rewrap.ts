// Default RewrapRunner backed by the OSC eyevinn-ffmpeg-s3 ephemeral job
// (issue #19).
//
// The same service used for ffprobe (issue #6) and thumbnails (issue #7) runs
// ffmpeg against a downloaded HTTPS source. For an export / re-wrap we copy
// every stream verbatim into a different container: `-c copy`. No transcoding
// happens, so this is fast and lossless. eyevinn-ffmpeg-s3 downloads the `-i`
// source URL before running ffmpeg and uploads ffmpeg's output files back to
// S3; we hand it the destination as a presigned PUT URL so the remuxed file
// lands at the object key we chose. The output container is inferred by ffmpeg
// from the destination URL's file extension.
//
// We do one job per export request, then best-effort removeJob so spent
// ephemeral instances do not accumulate (same lifecycle as osc-thumbnail.ts).

import {
  createJob,
  getLogsForInstance,
  removeJob,
  getInstanceHealth,

  type Context
} from '@osaas/client-core';
import { FFPROBE_SERVICE_ID } from '../services/stack.js';
import { pollOscJobUntilDone } from './osc-job-poll.js';
import type { RewrapRunner } from './rewrap.js';

// Subset of the OSC SDK surface this runner needs. Declared structurally so the
// real SDK functions satisfy it and tests can pass lightweight fakes (mirrors
// OscJobApi in osc-thumbnail.ts).
export type OscJobApi = {
  context: Context;
  createJob: typeof createJob;
  getInstanceHealth: typeof getInstanceHealth;

  getLogsForInstance: typeof getLogsForInstance;
  removeJob: typeof removeJob;
};

// Build the ffmpeg command line that remuxes the source into a new container
// without re-encoding. `-c copy` copies all streams verbatim; the destination
// URL's extension selects the output muxer. `-y` overwrites so re-runs are
// idempotent.
export function rewrapCmdLine(sourceUrl: string, putUrl: string): string {
  return `-y -i "${sourceUrl}" -c copy "${putUrl}"`;
}

// A unique, OSC-valid ephemeral job name. Lowercase alphanumeric, bounded
// length (OSC instance-name constraints). Mirrors thumbnailJobName in
// osc-thumbnail.ts.
function rewrapJobName(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36).slice(-6);
  return `rewrap${ts}${rand}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
}

// Construct the production RewrapRunner. Each invocation creates one ephemeral
// ffmpeg job that remuxes the source to its destination, waits for completion,
// then best-effort removes the job.
export function makeOscRewrapRunner(api: OscJobApi): RewrapRunner {
  return async (sourceUrl: string, putUrl: string): Promise<void> => {
    const sat = await api.context.getServiceAccessToken(FFPROBE_SERVICE_ID);
    const name = rewrapJobName();
    await api.createJob(api.context, FFPROBE_SERVICE_ID, sat, {
      name,
      cmdLineArgs: rewrapCmdLine(sourceUrl, putUrl)
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
