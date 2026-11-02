// Default SceneDetector backed by an ephemeral OSC eyevinn-ffmpeg-s3 job
// (issue #1192, decided by ADR-027).
//
// WHY THIS REPLACES THE FUNCTION-SCENES RUNNER
// eyevinn-function-scenes cannot return cut timecodes through any documented
// endpoint (#797), so the old runner in osc-scene-detect.ts starts a job and
// then deliberately throws. ADR-027 D1 moves the slot to eyevinn-ffmpeg-s3 —
// the same ephemeral create-run-read-delete runner that already serves probe,
// thumbnail, re-wrap and clip — and keeps `sceneMetadata` exactly as it is
// (ADR-027 D2: no type, schema or openapi.json change).
//
// HOW THE CUTS COME BACK: AN S3 OBJECT, NEVER THE LOG
// ffmpeg's `select` filter reports cuts on stderr, and eyevinn-ffmpeg-s3 only
// forwards stderr to the job log when ffmpeg exits NON-ZERO
// (docs/contracts/eyevinn-ffmpeg-s3-job-and-logs.json,
// `job.logs.carriesFfmpegStderr`; upstream `src/ffmpeg.ts:224-235`). A job that
// succeeds logs nothing but the wrapper's own lines, so a log-scraping detector
// would read "no cuts" for every video. Instead the cut list IS the muxer
// output: `-f framemd5` writes one row per frame that reaches the muxer, and
// with `select` upstream the only frames that reach it are the cuts. The
// service's single-file S3 upload branch then carries that object to
// `s3://<bucket>/<key>` (same native-S3 writer clip and re-wrap use).
//
// CONTRACT SOURCES (CLAUDE.md rule 7) — all read on this branch, nothing guessed:
//   - Job body fields `name`, `cmdLineArgs`, `awsAccessKeyId`,
//     `awsSecretAccessKey`, `s3EndpointUrl`:
//     docs/contracts/eyevinn-ffmpeg-s3-job-and-logs.json
//     `job.createJob.bodyFields.*` (pinned at Eyevinn/ffmpeg-s3
//     @95ede50d3486cc4b2145871af08a4138ba5e3b9d, readme.md:43-47), and the same
//     five fields as sent by the 2026-10-28 live run recorded at
//     `sceneCutReadback.viaS3Object.liveRun.createJobBody`.
//   - Command shape: `sceneCutReadback.viaS3Object.liveRun.runs['with-cuts'].cmdLineArgs`
//     (verbatim, incl. the 0.4 threshold ADR-027 D1 requires us to keep) and
//     `shapeThatFitsTheUploader`.
//   - framemd5 row/`#tb` layout and the header-only zero-cut object: the two
//     verbatim objects under `sceneCutReadback.viaS3Object.liveRun.runs.*.objectVerbatim`
//     plus `liveRun.findings` ("THE TIMEBASE IS NOT FIXED", "the pts column is
//     the third").
//   - Service id: src/services/stack.ts FFPROBE_SERVICE_ID ('eyevinn-ffmpeg-s3').
//   - Terminal status + poll helper: src/pipeline/osc-job-poll.ts
//     TERMINAL_STATUS / pollOscJobUntilDone (`SuccessCriteriaMet`), and the
//     success ALLOW-list idiom from src/pipeline/osc-clip.ts SUCCESS_STATUSES
//     (issue #786: a failure DENY-list let every unknown terminal value pass as
//     success).
//   - Job-name rule: src/pipeline/osc-clip.ts clipJobName /
//     src/pipeline/osc-ffprobe.ts probeJobName.
//   - Boundary mapping: src/pipeline/scene-detector.ts parseSceneResult, which
//     already turns `cuts: number[]` into `boundaries[]` — so this runner emits
//     `cuts` only (ADR-027 D2's detector-level note) and stitches no windows.
//
// FAILURE SEMANTICS (ADR-027 D3, the #881 rule made normative)
// Every failure path here THROWS. detectScenes() turns a throw into
// `sceneDetectionError` with `sceneMetadata` left null, so nothing that reads
// as a result is ever persisted for a run that did not produce one. In
// particular this runner never returns `{ cuts: [] }` for a job it could not
// read: `{ boundaries: [], sceneCount: 0 }` asserts "this video has no cuts",
// which a consumer cannot distinguish from a genuine single-shot video. A
// zero-cut result is only returned when the job reached a success status AND the
// object exists and parses as a well-formed, header-complete framemd5 file —
// the header-only object the live run confirmed for a cut-free clip.

import {
  createJob,
  getJob,
  getLogsForInstance,
  removeJob,
  type Context
} from '@osaas/client-core';
import { FFPROBE_SERVICE_ID } from '../services/stack.js';
import { pollOscJobUntilDone } from './osc-job-poll.js';
import { captureJobLogs, OscJobError } from './osc-job-log.js';
import type { SceneDetector, SceneDetectorResult } from './scene-detector.js';

// Scene-change threshold for ffmpeg's `select` filter. Held at the value the
// retired eyevinn-function-scenes service used for its own invocation
// (investigation 797) so moving services does not silently change results —
// ADR-027 D1 makes that explicit ("must stay at the upstream service's 0.4").
export const SCENE_SELECT_THRESHOLD = 0.4;

// Key prefix for the per-job cut-list object inside the stack's source bucket.
// The job applies no lifecycle of its own and platform job removal does NOT
// delete the object (liveRun.findings, "Object location"), so this runner
// deletes it itself after reading; the shared prefix additionally makes a leaked
// object sweepable.
export const SCENE_CUT_KEY_PREFIX = 'scene-detect/';

// Poll budget for ONE detection job (ADR-027 D8). Scene detection is the first
// caller that decodes the whole file rather than seeking, so the shared
// 5-minute default of osc-job-poll.ts is not a sensible ceiling for it. Sized
// to stay inside the presigned source URL's own lifetime
// (DEFAULT_SCENE_URL_TTL_SECONDS = 30 min in scene-detector.ts): the URL is
// ffmpeg's `-i`, so it must remain valid for the whole decode, and a budget
// that outlived the URL would just trade a timeout for a mid-decode read error.
export const DEFAULT_SCENE_POLL_BUDGET_MS = 25 * 60_000; // 25 minutes

// The ONLY statuses that mean the job finished successfully. Mirrors
// osc-clip.ts SUCCESS_STATUSES verbatim (issue #786): an ALLOW-list, so a
// terminal value this service grows later cannot become a silent success.
const SUCCESS_STATUSES = new Set(['SuccessCriteriaMet', 'Complete']);

export class OscSceneDetectJobError extends OscJobError {
  constructor(message: string, jobLog: string) {
    super(message, jobLog);
    this.name = 'OscSceneDetectJobError';
  }
}

// Subset of the OSC SDK surface this runner needs, declared structurally so the
// real SDK functions satisfy it and tests pass lightweight fakes (mirrors
// OscJobApi in osc-clip.ts / osc-rewrap.ts).
export type OscSceneJobApi = {
  context: Context;
  createJob: typeof createJob;
  getJob: typeof getJob;
  getLogsForInstance: typeof getLogsForInstance;
  removeJob: typeof removeJob;
  // Object-store coordinates for the native S3 writer, passed in the job body
  // exactly as osc-clip.ts does. The cut-list object is written into the stack's
  // own bucket, so no second credential is involved.
  s3Endpoint: string;
  s3AccessKey: string;
  s3SecretKey: string;
  s3Bucket: string;
  // Read the finished cut-list object back with the stack's own storage
  // credentials (ADR-027 D1, "Output contract"). Resolves undefined when the
  // object is absent — which is a FAILURE here, never an empty result.
  readCutObject: (objectKey: string) => Promise<string | undefined>;
  // Best-effort delete of the cut-list object once parsed. Optional so a
  // deployment without delete rights still gets detection.
  removeCutObject?: (objectKey: string) => Promise<void>;
  // Per-call poll budget; defaults to DEFAULT_SCENE_POLL_BUDGET_MS.
  pollBudgetMs?: number;
  // Override for the cut-object key prefix (tests, and deployments that sweep a
  // different prefix).
  keyPrefix?: string;
};

// A unique, OSC-valid ephemeral job name: lowercase alphanumeric, bounded
// length. Same rule as clipJobName (osc-clip.ts) / probeJobName
// (osc-ffprobe.ts).
export function sceneDetectJobName(): string {
  const rand = Math.random().toString(36).slice(2, 8);
  const ts = Date.now().toString(36).slice(-6);
  return `scenes${ts}${rand}`.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
}

// Object key for one job's cut list. The `.framemd5` extension is not cosmetic:
// the service's uploader matches the staged file by the destination's basename
// (upstream src/ffmpeg.ts:337-345), so the muxer output and the destination must
// agree.
export function sceneCutObjectKey(jobName: string, prefix: string = SCENE_CUT_KEY_PREFIX): string {
  return `${prefix}${jobName}.framemd5`;
}

// `s3://bucket/key` destination for the native S3 writer. Same form as
// osc-clip.ts clipDestinationUri.
export function sceneCutDestinationUri(bucket: string, objectKey: string): string {
  return `s3://${bucket}/${objectKey}`;
}

// The ffmpeg command line, carried over verbatim from the live run recorded in
// the pinned snapshot (`liveRun.runs['with-cuts'].cmdLineArgs`):
//   -i <source> -an -fps_mode passthrough -vf "select='gt(scene,0.4)'" -f framemd5 <dest>
// `-an` drops audio so only video frames can reach the muxer; `-fps_mode
// passthrough` stops ffmpeg from re-timing the sparse selected frames, which is
// what keeps each row's pts equal to the cut's own presentation time.
export function sceneDetectCmdLine(
  sourceUrl: string,
  destination: string,
  threshold: number = SCENE_SELECT_THRESHOLD
): string {
  return (
    `-i "${sourceUrl}" -an -fps_mode passthrough ` +
    `-vf "select='gt(scene,${threshold})'" -f framemd5 "${destination}"`
  );
}

export class Framemd5ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Framemd5ParseError';
  }
}

// `#tb <stream>: <num>/<den>` — the stream timebase. NOT a constant: the live
// run saw 1/25 for one clip and 1/12800 for another, so the parser must read it
// (liveRun.findings, "THE TIMEBASE IS NOT FIXED").
const TB_LINE = /^#tb\s+(\d+):\s*(\d+)\/(\d+)\s*$/;
// The row header the data lines are described by:
//   #stream#, dts,        pts, duration,     size, hash
const ROW_HEADER_PREFIX = '#stream#';
const HASH_COLUMN = /^[0-9a-f]{32}$/i;
const EXPECTED_COLUMNS = 6;

// Parse a framemd5 object into cut timecodes in SECONDS.
//
// THROWS (never returns a partial or empty-by-default list) when the text is not
// a well-formed framemd5 document: no `#tb` header, no row header, a row with
// the wrong column count, a non-numeric pts, a truncated MD5 column, or a row
// for a stream with no declared timebase. ADR-027 D3 requires exactly this —
// an unreadable or truncated object must persist nothing, and "zero rows"
// must only mean "no cuts" when the document around those rows is complete.
export function parseFramemd5Cuts(text: string): number[] {
  const lines = String(text ?? '').split(/\r?\n/);
  const timebases = new Map<number, { num: number; den: number }>();
  let sawRowHeader = false;
  const cuts: number[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith('#')) {
      const tb = TB_LINE.exec(line);
      if (tb) {
        const den = Number(tb[3]);
        const num = Number(tb[2]);
        if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
          throw new Framemd5ParseError(`framemd5 timebase header is unusable: "${line}"`);
        }
        timebases.set(Number(tb[1]), { num, den });
      } else if (line.startsWith(ROW_HEADER_PREFIX)) {
        sawRowHeader = true;
      }
      continue;
    }

    const cols = line.split(',').map((c) => c.trim());
    if (cols.length !== EXPECTED_COLUMNS) {
      // A short row is the signature of a truncated object (the hash is last).
      throw new Framemd5ParseError(
        `framemd5 row has ${cols.length} columns, expected ${EXPECTED_COLUMNS} ` +
          `(object truncated or not framemd5 output)`
      );
    }
    if (!HASH_COLUMN.test(cols[5] ?? '')) {
      throw new Framemd5ParseError('framemd5 row has a truncated or malformed hash column');
    }
    const streamIndex = Number(cols[0]);
    // Column 3 is `pts` — `stream#, dts, pts, duration, size, hash`
    // (liveRun.findings: "the pts column is the third").
    const pts = Number(cols[2]);
    if (!Number.isInteger(streamIndex) || !Number.isFinite(pts)) {
      throw new Framemd5ParseError(`framemd5 row is not parseable: "${line}"`);
    }
    const tb = timebases.get(streamIndex);
    if (!tb) {
      throw new Framemd5ParseError(
        `framemd5 row names stream ${streamIndex}, which has no #tb timebase header`
      );
    }
    // seconds = pts * num / den. Rounded to microseconds so a timebase like
    // 1/12800 does not leak binary-float noise into the stored timecode.
    cuts.push(Math.round((pts * tb.num * 1_000_000) / tb.den) / 1_000_000);
  }

  if (timebases.size === 0 || !sawRowHeader) {
    throw new Framemd5ParseError(
      'framemd5 object is incomplete: missing #tb timebase header and/or the row header'
    );
  }

  return cuts.sort((a, b) => a - b);
}

// Construct the production SceneDetector. One ephemeral ffmpeg-s3 job per call:
// create → poll to a terminal status → read the cut object back → parse → delete
// the object. The job itself is removed in a `finally`, exactly as the other
// four runners do.
export function makeFfmpegS3SceneDetector(api: OscSceneJobApi): SceneDetector {
  return async (presignedUrl: string): Promise<SceneDetectorResult> => {
    const sat = await api.context.getServiceAccessToken(FFPROBE_SERVICE_ID);
    const name = sceneDetectJobName();
    const objectKey = sceneCutObjectKey(name, api.keyPrefix ?? SCENE_CUT_KEY_PREFIX);
    const destination = sceneCutDestinationUri(api.s3Bucket, objectKey);

    await api.createJob(api.context, FFPROBE_SERVICE_ID, sat, {
      name,
      cmdLineArgs: sceneDetectCmdLine(presignedUrl, destination),
      awsAccessKeyId: api.s3AccessKey,
      awsSecretAccessKey: api.s3SecretKey,
      s3EndpointUrl: api.s3Endpoint
    });

    // Resolve the outcome BEFORE removing the job — the log is only fetchable
    // while the ephemeral instance exists (osc-job-log.ts header, #786).
    let failure: string | undefined;
    try {
      // No failFastOnUnknownStatus: detection is fire-and-forget, so nobody is
      // holding a connection open, and the tolerant behaviour of the other
      // detached runners (osc-ffprobe / osc-thumbnail) applies — an unseen but
      // healthy queueing status must not break detection for every asset.
      const status = await pollOscJobUntilDone(api, FFPROBE_SERVICE_ID, name, sat, {
        timeoutMs: api.pollBudgetMs ?? DEFAULT_SCENE_POLL_BUDGET_MS
      });
      if (!SUCCESS_STATUSES.has(status)) {
        failure = `OSC scene-detect job "${name}" ended with non-success status "${status}"`;
      }
    } catch (err) {
      failure = `OSC scene-detect job "${name}" did not complete: ${
        err instanceof Error ? err.message : String(err)
      }`;
    }

    // captureJobLogs redacts presigned query strings before retaining them —
    // which matters here: the ffmpeg-s3 job log echoes the signed input URL in
    // full (liveRun.findings SECURITY NOTE).
    const logs = failure ? await captureJobLogs(api, FFPROBE_SERVICE_ID, name, sat) : '';

    try {
      await api.removeJob(api.context, FFPROBE_SERVICE_ID, name, sat);
    } catch {
      // ignore cleanup failure
    }

    if (failure) {
      // Nothing is persisted for this run: the throw becomes
      // `sceneDetectionError` one layer up (ADR-027 D3).
      throw new OscSceneDetectJobError(failure, logs);
    }

    const text = await api.readCutObject(objectKey);
    // Delete the cut list whatever the parse does with it: the job leaves no
    // lifecycle behind it and removeJob does not touch the object.
    const cleanup = async (): Promise<void> => {
      if (!api.removeCutObject) return;
      try {
        await api.removeCutObject(objectKey);
      } catch {
        // ignore cleanup failure
      }
    };

    if (text === undefined) {
      await cleanup();
      throw new Error(
        `OSC scene-detect job "${name}" reported success but its cut list ` +
          `"${objectKey}" is missing`
      );
    }

    try {
      const cuts = parseFramemd5Cuts(text);
      await cleanup();
      // `cuts` only — parseSceneResult owns the window stitching (ADR-027 D2).
      return { cuts };
    } catch (err) {
      await cleanup();
      throw new Error(
        `OSC scene-detect job "${name}" produced an unreadable cut list ` +
          `"${objectKey}": ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };
}
