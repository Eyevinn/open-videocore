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
//
// OUTCOME CLASSIFICATION (issue #944). This runner used to decide success with a
// DENY-list — `status === 'Failed' || status === 'Error'` — which is the exact
// shape that made clip report a false success in issue #786: every OTHER value
// the poller can return read as success, including 'Stopped', which is in
// osc-job-poll.ts:TERMINAL_STATUS and is therefore RETURNED rather than thrown.
// It now succeeds only on an ALLOW-list (SUCCESS_STATUSES below), so an
// unanticipated terminal value can never become a 201. It also captures the
// job's ffmpeg log before removeJob reaps the instance: getLogsForInstance was
// declared on OscJobApi and wired in main.ts but never called, so the one
// artefact that explains an export failure was discarded on every run.

import {
  createJob,
  getLogsForInstance,
  removeJob,
  getJob,

  type Context
} from '@osaas/client-core';
import { FFPROBE_SERVICE_ID } from '../services/stack.js';
import { pollOscJobUntilDone } from './osc-job-poll.js';
import { captureJobLogs, OscJobError } from './osc-job-log.js';
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

// The ONLY job statuses that mean the ffmpeg job finished successfully
// (issue #944, mirroring osc-clip.ts:SUCCESS_STATUSES). eyevinn-ffmpeg-s3 reports
// 'SuccessCriteriaMet'; 'Complete' is the generic SDK value, and is also what
// osc-job-poll.ts synthesises when the instance has already been reaped
// (`job === undefined`). Any OTHER value returned by the poller is a FAILURE.
//
// What this actually observes, verified against
// osc-job-poll.ts:TERMINAL_STATUS/ACTIVE_STATUS: the poller only ever RETURNS a
// value from its terminal set, so in practice the failure branch sees 'Failed',
// 'Error' or 'Stopped' — and 'Stopped' is precisely the value the previous
// deny-list let through as success. A status the poller recognises as neither
// terminal nor active does not arrive here as a status at all: with
// `failFastOnUnknownStatus` the poller throws after a bounded grace window, and
// the catch below turns that into the same failure. The allow-list is the second
// line of defence so a future terminal value added to the poller cannot become a
// silent success.
const SUCCESS_STATUSES = new Set(['SuccessCriteriaMet', 'Complete']);

// Error thrown when the export / re-wrap ffmpeg job does not end in a known-good
// state. The captured ffmpeg log rides on `jobLog`, never in `message` — see
// osc-job-log.ts:OscJobError. routes/assets.ts logs it server-side and returns
// only the status-bearing sentence in the 502 body.
export class OscRewrapJobError extends OscJobError {
  constructor(message: string, jobLog: string) {
    super(message, jobLog);
    this.name = 'OscRewrapJobError';
  }
}

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
// ffmpeg job that remuxes the source to `s3://<bucket>/<objectKey>`, waits for
// completion, and — on anything other than a known-good terminal status —
// captures the job's ffmpeg log before the instance is removed and throws an
// OscRewrapJobError carrying it as data (server-side diagnostics only). The
// orchestrator (pipeline/rewrap.ts) additionally verifies the output object
// really landed and carries bytes, because a "successful" status is not proof of
// a written object (issue #786 / #316 / #944).
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

    // Resolve the outcome FIRST, without removing the job: OSC only serves an
    // instance's logs while the instance exists (osc-job-log.ts), so reaping it
    // in a `finally` — as this runner used to — throws away the only explanation
    // of a failure.
    let failure: string | undefined;
    try {
      // failFastOnUnknownStatus: the export/re-wrap route awaits this runner
      // (routes/assets.ts), so an unclassifiable status must not hold the
      // request open for the full poll timeout. See osc-job-poll.ts:PollOptions.
      const status = await pollOscJobUntilDone(api, FFPROBE_SERVICE_ID, name, sat, {
        failFastOnUnknownStatus: true
      });
      if (!SUCCESS_STATUSES.has(status)) {
        failure = `OSC export/re-wrap job "${name}" ended with non-success status "${status}"`;
      }
    } catch (err) {
      failure = `OSC export/re-wrap job "${name}" did not complete: ${err instanceof Error ? err.message : String(err)}`;
    }

    const logs = failure ? await captureJobLogs(api, FFPROBE_SERVICE_ID, name, sat) : '';

    try {
      await api.removeJob(api.context, FFPROBE_SERVICE_ID, name, sat);
    } catch {
      // ignore cleanup failure
    }

    if (failure) {
      // The log goes on the error as data, NOT into the message — see
      // OscRewrapJobError / osc-job-log.ts:OscJobError.
      throw new OscRewrapJobError(failure, logs);
    }
  };
}
