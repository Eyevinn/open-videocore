// Default ClipRunner backed by the OSC eyevinn-ffmpeg-s3 ephemeral job
// (issue #17).
//
// The same service used for ffprobe (issue #6) and thumbnails (issue #7) runs
// ffmpeg against a downloaded HTTPS source. For clips we seek to the window
// start, stream-copy until the window end, and write the result out.
//
// OUTPUT goes to an `s3://bucket/key` URI, NOT a presigned HTTPS PUT URL
// (issue #786). ffmpeg's http protocol is read-only for output unless it is
// explicitly driven with `-method PUT`, and even then an MP4 muxed to a
// non-seekable target cannot rewrite its `moov` atom, so `-c copy` to a
// presigned PUT URL produced a job that "succeeded" while writing nothing —
// the caller got a `ready` child asset whose object answered NoSuchKey. This is
// the same failure mode already fixed for thumbnails (issue #92) and for
// export / re-wrap (issue #316); we follow the fix those made:
// eyevinn-ffmpeg-s3 writes S3 output natively when handed AWS-compatible
// credentials in the job body (`awsAccessKeyId`, `awsSecretAccessKey`,
// `s3EndpointUrl` — the MinIO endpoint, per ADR-001), so ffmpeg muxes to a
// seekable local file and the service uploads it. See
// osc-rewrap.ts:rewrapCmdLine / osc-rewrap.ts:makeOscRewrapRunner.
//
// Input-level `-ss` before `-i` keeps the seek fast; `-to` (also an input
// option here) bounds the read at the window end, so the clip covers
// [startSeconds, endSeconds). `-c copy` stream-copies without re-encoding so
// the clip is produced quickly and without quality loss. `-y` overwrites so
// re-runs are idempotent. We do one job per clip request, then best-effort
// removeJob so spent ephemeral instances do not accumulate (same lifecycle as
// osc-ffprobe.ts / osc-thumbnail.ts).

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
// OscJobApi in osc-rewrap.ts / osc-thumbnail.ts).
export type OscJobApi = {
  context: Context;
  createJob: typeof createJob;
  getJob: typeof getJob;

  getLogsForInstance: typeof getLogsForInstance;
  removeJob: typeof removeJob;
  // MinIO/S3 credentials + bucket for native S3 output. Passed in the job body
  // so ffmpeg's output lands in `s3://bucket/key` (a presigned HTTPS PUT URL
  // does not work as an ffmpeg output — see the file header, issue #786/#316).
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Bucket: string;
};

// The ONLY job statuses that mean the ffmpeg job finished successfully.
// eyevinn-ffmpeg-s3 reports 'SuccessCriteriaMet'; 'Complete' is the generic SDK
// value (and what osc-job-poll.ts synthesises when the instance has already been
// reaped). Any OTHER value returned by the poller is treated as a FAILURE
// (issue #786: checking only for two exact failure values let every other
// terminal value pass as success).
//
// What this actually observes, verified against
// osc-job-poll.ts:TERMINAL_STATUS/ACTIVE_STATUS: the poller only ever RETURNS a
// value from its terminal set, so in practice this branch sees 'Failed', 'Error'
// or 'Stopped'. A status the poller recognises as neither terminal nor active —
// a value this service grew since — does not arrive here as a status at all: the
// poller throws after a bounded grace window, and the catch below turns that
// into the same failure. The allow-list is kept as the second line of defence so
// a future terminal value added to the poller cannot become a silent success.
const SUCCESS_STATUSES = new Set(['SuccessCriteriaMet', 'Complete']);

// Cap on how much ffmpeg log text is attached to a failure message, so a
// runaway log cannot blow up an error string / response body.
const MAX_LOG_CHARS = 4_000;

// ffmpeg echoes its `-i` argument verbatim into stderr, and that argument is a
// presigned MinIO GET URL whose query string carries a live SigV4 signature
// (`X-Amz-Signature`, TTL per clip.ts:clipUrlTtlSeconds). The captured log ends
// up in the server log, so every query string is stripped before the log leaves
// this module — a live signature does not belong in a log file either. Path and
// status text — the parts that explain the failure — are preserved. This is
// defence in depth, not the primary control: the log is never returned to the
// caller (see OscClipJobError).
export function redactLogQueryStrings(text: string): string {
  return text.replace(/\?[^"\s]+/g, '?<redacted>');
}

// Error thrown when the ffmpeg job does not end in a known-good state.
//
// The captured ffmpeg log is carried as a PROPERTY (and as `cause`), never
// concatenated into `message` (issue #786 round-2 review). `message` is what
// routes/assets.ts sends back in the 502 body, and the log is output from a
// service we do not control: it can carry storage endpoint hostnames, bucket
// names, container paths, and anything else that service chooses to print.
// redactLogQueryStrings is a deny-list — it strips query strings and nothing
// else — so it cannot be relied on to sanitise a form we have not anticipated.
// Operators read the full text from the server log (routes/assets.ts logs
// `oscJobLog` on the warn line); callers get only the status-bearing sentence.
export class OscClipJobError extends Error {
  readonly jobLog: string;
  constructor(message: string, jobLog: string) {
    super(message, jobLog ? { cause: jobLog } : undefined);
    this.name = 'OscClipJobError';
    this.jobLog = jobLog;
  }
}

// Pull the captured ffmpeg log off an error for server-side logging, without
// assuming the error is an OscClipJobError (the orchestrator rethrows whatever
// the runner threw, and its own verification errors carry no log).
export function oscClipJobLog(err: unknown): string | undefined {
  const log = (err as { jobLog?: unknown } | null | undefined)?.jobLog;
  return typeof log === 'string' && log.length > 0 ? log : undefined;
}

// Build the destination URI the ffmpeg job writes to. Mirrors the
// `s3://bucket/<objectKey>` form used by osc-rewrap.ts:rewrapCmdLine; the `.mp4`
// extension on the key selects the MP4 muxer.
export function clipDestinationUri(bucket: string, objectKey: string): string {
  return `s3://${bucket}/${objectKey}`;
}

// Build the ffmpeg command line that extracts [startSeconds, endSeconds) from
// the source and writes it to `destination` — an `s3://bucket/key` URI built by
// clipDestinationUri, NOT a presigned PUT URL (issue #786). `-c copy` avoids a
// re-encode; the destination key's `.mp4` extension forces the MP4 muxer.
export function clipCmdLine(
  sourceUrl: string,
  destination: string,
  startSeconds: number,
  endSeconds: number
): string {
  return `-y -ss ${startSeconds} -to ${endSeconds} -i "${sourceUrl}" -c copy "${destination}"`;
}

// A unique, OSC-valid ephemeral job name. Lowercase alphanumeric, bounded
// length (OSC instance-name constraints). Mirrors probeJobName/thumbnailJobName.
function clipJobName(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36).slice(-6);
  return `clip${ts}${rand}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
}

// Best-effort capture of the job's ffmpeg output BEFORE the instance is removed
// (issue #786: the runner held getLogsForInstance but never called it, so the
// one artefact that explains an ffmpeg failure was discarded when the job was
// reaped). Never throws — a failed log fetch must not mask the real failure.
// getLogsForInstance returns `string | string[]`
// (@osaas/client-core/lib/core.d.ts:85), so both shapes are normalised here.
// Query strings are redacted before the text is returned — see
// redactLogQueryStrings.
async function captureJobLogs(api: OscJobApi, name: string, sat: string): Promise<string> {
  try {
    const log = await api.getLogsForInstance(api.context, FFPROBE_SERVICE_ID, name, sat);
    const text = Array.isArray(log) ? log.join('\n') : String(log ?? '');
    const trimmed = redactLogQueryStrings(text).trim();
    return trimmed.length > MAX_LOG_CHARS ? trimmed.slice(-MAX_LOG_CHARS) : trimmed;
  } catch {
    return '';
  }
}

// Construct the production ClipRunner. Each invocation creates one ephemeral
// ffmpeg job that writes the clip to `s3://<bucket>/<outputKey>`, waits for
// completion, and — on anything other than a known-good terminal status —
// captures the job's logs before the instance is removed and throws an
// OscClipJobError carrying them as data (server-side diagnostics only). The orchestrator (pipeline/clip.ts) additionally verifies the object
// really landed, because a "successful" status is not proof of a written object.
export function makeOscClipRunner(api: OscJobApi): ClipRunner {
  return async (
    sourceUrl: string,
    outputKey: string,
    startSeconds: number,
    endSeconds: number
  ): Promise<void> => {
    const sat = await api.context.getServiceAccessToken(FFPROBE_SERVICE_ID);
    const name = clipJobName();
    await api.createJob(api.context, FFPROBE_SERVICE_ID, sat, {
      name,
      cmdLineArgs: clipCmdLine(
        sourceUrl,
        clipDestinationUri(api.s3Bucket, outputKey),
        startSeconds,
        endSeconds
      ),
      awsAccessKeyId: api.s3AccessKey,
      awsSecretAccessKey: api.s3SecretKey,
      s3EndpointUrl: api.s3Endpoint
    });

    // Resolve the outcome first, WITHOUT removing the job: the logs are only
    // fetchable while the instance still exists.
    let failure: string | undefined;
    try {
      // failFastOnUnknownStatus: POST /:id/clip awaits this runner, so a status
      // the poller cannot classify must not hold the caller's connection open
      // for the full 5-minute poll timeout. Opt-in per caller — the
      // fire-and-forget ingest pipelines deliberately stay tolerant. See
      // osc-job-poll.ts:PollOptions.
      const status = await pollOscJobUntilDone(api, FFPROBE_SERVICE_ID, name, sat, {
        failFastOnUnknownStatus: true
      });
      if (!SUCCESS_STATUSES.has(status)) {
        failure = `OSC clip job "${name}" ended with non-success status "${status}"`;
      }
    } catch (err) {
      failure = `OSC clip job "${name}" did not complete: ${err instanceof Error ? err.message : String(err)}`;
    }

    const logs = failure ? await captureJobLogs(api, name, sat) : '';

    try {
      await api.removeJob(api.context, FFPROBE_SERVICE_ID, name, sat);
    } catch {
      // ignore cleanup failure
    }

    if (failure) {
      // The log goes on the error as data, NOT into the message — see
      // OscClipJobError.
      throw new OscClipJobError(failure, logs);
    }
  };
}
