// Shared failure diagnostics for OSC eyevinn-ffmpeg-s3 ephemeral jobs
// (issue #786, extracted for issue #944).
//
// Two awaited pipelines dispatch one ephemeral ffmpeg job per request and then
// reap it: clip (POST /api/v1/assets/:id/clip, src/pipeline/osc-clip.ts) and
// export / re-wrap (POST /api/v1/assets/:id/export, src/pipeline/osc-rewrap.ts).
// Both need the SAME two things when the job does not end in a known-good
// state, so they live here rather than being copied:
//
//   1. The job's ffmpeg output, fetched BEFORE the instance is removed. OSC only
//      exposes a job's logs while its ephemeral instance still exists
//      (getLogsForInstance is an INSTANCE call — @osaas/client-core
//      lib/core.d.ts:85), so a `finally { removeJob }` destroys the one artefact
//      that explains an ffmpeg failure. See
//      docs/osc-feedback/incoming-issue786-ffmpeg-s3-terminal-status-without-output.md
//      gap 3.
//   2. An error type that carries that log as DATA rather than in `message`.
//      `message` is what the route returns in the 502 body, and the log is
//      output from a service we do not control: it can carry storage endpoint
//      hostnames, bucket names, container paths, and anything else that service
//      chooses to print. Operators read the full text from the server log;
//      callers get only the status-bearing sentence.

import type { Context, getLogsForInstance } from '@osaas/client-core';

// Cap on how much ffmpeg log text is retained, so a runaway log cannot blow up
// an error object or a log line.
export const MAX_LOG_CHARS = 4_000;

// ffmpeg echoes its `-i` argument verbatim into stderr, and that argument is a
// presigned MinIO GET URL whose query string carries a live SigV4 signature
// (`X-Amz-Signature`). The captured log ends up in the server log, so every
// query string is stripped before the text leaves this module — a live
// signature does not belong in a log file either. Path and status text — the
// parts that explain the failure — are preserved.
//
// This is defence in depth, not the primary control: the log is never returned
// to the caller (see OscJobError). It is a deny-list — it strips query strings
// and nothing else — so it cannot be relied on to sanitise a form we have not
// anticipated.
export function redactLogQueryStrings(text: string): string {
  return text.replace(/\?[^"\s]+/g, '?<redacted>');
}

// The subset of the OSC SDK surface captureJobLogs needs. Declared structurally
// so the real SDK functions satisfy it and tests can pass lightweight fakes
// (same style as OscJobApi in osc-clip.ts / osc-rewrap.ts).
export type JobLogReader = {
  context: Context;
  getLogsForInstance: typeof getLogsForInstance;
};

// Best-effort capture of an ephemeral job's output BEFORE the instance is
// removed. Never throws — a failed log fetch must not mask the real failure.
// getLogsForInstance returns `string | string[]`
// (@osaas/client-core/lib/core.d.ts:85), so both shapes are normalised here.
export async function captureJobLogs(
  api: JobLogReader,
  serviceId: string,
  name: string,
  sat: string
): Promise<string> {
  try {
    const log = await api.getLogsForInstance(api.context, serviceId, name, sat);
    const text = Array.isArray(log) ? log.join('\n') : String(log ?? '');
    const trimmed = redactLogQueryStrings(text).trim();
    return trimmed.length > MAX_LOG_CHARS ? trimmed.slice(-MAX_LOG_CHARS) : trimmed;
  } catch {
    return '';
  }
}

// Error thrown when an ephemeral ffmpeg job does not end in a known-good state.
//
// The captured log rides on `jobLog` (and as `cause`), never concatenated into
// `message` — see the file header. Subclasses set their own `name` so the
// originating pipeline is identifiable in a server log.
export class OscJobError extends Error {
  readonly jobLog: string;
  constructor(message: string, jobLog: string) {
    super(message, jobLog ? { cause: jobLog } : undefined);
    this.name = 'OscJobError';
    this.jobLog = jobLog;
  }
}

// Pull the captured log off an error for server-side logging, without assuming
// the error is an OscJobError: the orchestrators rethrow whatever the runner
// threw, and their own verification errors (missing/empty output object) carry
// no log.
export function oscJobLog(err: unknown): string | undefined {
  const log = (err as { jobLog?: unknown } | null | undefined)?.jobLog;
  return typeof log === 'string' && log.length > 0 ? log : undefined;
}
