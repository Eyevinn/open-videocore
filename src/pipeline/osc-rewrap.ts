// Default RewrapRunner backed by the OSC eyevinn-ffmpeg-s3 ephemeral job
// (issue #19).
//
// The same service used for ffprobe (issue #6) and thumbnails (issue #7) runs
// ffmpeg against a downloaded HTTPS source. For an export / re-wrap we copy
// every stream verbatim into a different container: `-c copy`. No transcoding
// happens, so this is fast and lossless. eyevinn-ffmpeg-s3 downloads the `-i`
// source URL (a short-lived presigned GET URL) before running ffmpeg.
//
// For OUTPUT we write to an `s3://bucket/key` URI, NOT a presigned PUT URL:
// ffmpeg's output muxer cannot write to an HTTPS PUT endpoint — pointing
// `-c copy` at a presigned PUT URL fails with "Unsupported protocol for
// upload: https:" and silently produces no object, so the child asset is
// marked `ready` with an objectKey that never existed (issue #316). This is the
// exact same failure mode already fixed for thumbnails (issue #92).
// eyevinn-ffmpeg-s3 supports S3 output natively when handed AWS-compatible
// credentials in the job body (`awsAccessKeyId`, `awsSecretAccessKey`,
// `s3EndpointUrl` — the MinIO endpoint, per ADR-001), so we use that instead.
// The output container is inferred by ffmpeg from the destination key's file
// extension.
//
// We do one job per export request, then best-effort removeJob so spent
// ephemeral instances do not accumulate (same lifecycle as osc-thumbnail.ts).

import {
  createJob,
  getLogsForInstance,
  removeJob,
  getJob,

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
  getJob: typeof getJob;

  getLogsForInstance: typeof getLogsForInstance;
  removeJob: typeof removeJob;
  // MinIO/S3 credentials + bucket for native S3 output. Passed in the job body
  // so ffmpeg writes the remuxed file directly to `s3://bucket/key` (a presigned
  // HTTP PUT URL does not work with ffmpeg's output muxer — see the file header,
  // issue #316 / #92).
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Bucket: string;
};

// Build the ffmpeg command line that remuxes the source into a new container
// without re-encoding. `-c copy` copies all streams verbatim; the destination
// key's extension selects the output muxer. `-y` overwrites so re-runs are
// idempotent. Output is written to `s3://bucket/<objectKey>` (native S3 write),
// NOT a presigned PUT URL — see the file header (issue #316).
export function rewrapCmdLine(sourceUrl: string, objectKey: string, bucket: string): string {
  return `-y -i "${sourceUrl}" -c copy "s3://${bucket}/${objectKey}"`;
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
  return async (sourceUrl: string, objectKey: string): Promise<void> => {
    const sat = await api.context.getServiceAccessToken(FFPROBE_SERVICE_ID);
    const name = rewrapJobName();
    await api.createJob(api.context, FFPROBE_SERVICE_ID, sat, {
      name,
      cmdLineArgs: rewrapCmdLine(sourceUrl, objectKey, api.s3Bucket),
      awsAccessKeyId: api.s3AccessKey,
      awsSecretAccessKey: api.s3SecretKey,
      s3EndpointUrl: api.s3Endpoint
    });
    try {
      const status = await pollOscJobUntilDone(api, FFPROBE_SERVICE_ID, name, sat);
      if (status === 'Failed' || status === 'Error') throw new Error(`OSC job "${name}" failed with status "${status}"`);
    } finally {
      try {
        await api.removeJob(api.context, FFPROBE_SERVICE_ID, name, sat);
      } catch {
        // ignore cleanup failure
      }
    }
  };
}
