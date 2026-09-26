// Default SceneDetector backed by the OSC eyevinn-function-scenes media function
// (issue #115; wire shape corrected in #798).
//
// eyevinn-function-scenes ("Scene Detect Media Function") is a serverless media
// FUNCTION. Like eyevinn-auto-subtitles (and unlike the eyevinn-ffmpeg-s3
// ephemeral job runner used for ffprobe/thumbnails/clip), we treat it as a
// resolvable instance we call over HTTP at its instance URL. This runner resolves
// that instance URL (getInstance().url) and its service access token, then drives
// the function's ASYNCHRONOUS JOB API.
//
// Interaction model (confirmed, see "Contract sources"):
//   1. `POST /api/v1` with `{"medialocator": "<presigned GET url>"}` starts a job
//      and returns `{ thumbnails, status }` — both RELATIVE paths built from the
//      function's own BASE_PATH, so they are resolved against the instance URL
//      rather than reconstructed from a job id we guessed.
//   2. `GET <status>` is polled until `state` is terminal: `completed` (success)
//      or `failed` / `cancelled` (genuine detection failure).
// The earlier shape — `POST /` with `{"url": ...}` — was the cause of the HTTP 405
// this issue fixes: `/` is the function's HEALTHCHECK and has only a GET route
// (`server.get("/")`, index.js:33), so restify answered `POST /` with
// `405 Allow: GET`. There is NO source-URL query parameter anywhere in the service
// (no handler reads `req.query`), so the "switch to GET + query parameter" premise
// this issue was filed with does not match the service; the 405 is fixed by moving
// the POST to the real detection route instead.
//
// KNOWN GAP — scene-boundary timecodes are NOT retrievable from this service.
// The job's ffmpeg invocation writes cut timecodes to `time.txt` INSIDE the job
// workdir (`select='gt(scene,0.4)',metadata=print:file=${workdir}/time.txt`,
// lib/scene_detect_job.js `execute()`), and no documented endpoint exposes that
// file — `GET /api/v1/:id/thumbnails` returns only extracted keyframe image URIs.
// Our `SceneMetadata` (asset-repo.ts, and `sceneMetadata` in openapi.json, which
// pins `boundaries[].startSeconds/endSeconds/keyframeSeconds` with
// `additionalProperties: false`) models timecodes only, so a successful run
// currently yields ZERO boundaries. Re-scoping `sceneMetadata` to carry keyframe
// URIs is an API-contract change, and reading `time.txt` through the undocumented
// `/images/*` static mount is not a contract — both are decisions for the
// architect/ux, tracked from
// docs/investigations/797-function-scenes-runtime-contract.md ("Impact on
// sceneMetadata"). This runner therefore reports a completed job HONESTLY as "no
// boundaries" rather than inventing them, and reserves failure reporting (which
// becomes `sceneDetectionError` upstream) for genuine detection failures:
// transport errors, non-2xx responses, malformed payloads, a `failed`/`cancelled`
// job, or a job that never reaches a terminal state inside the poll budget.
//
// Contract sources (verified from the service's own source, 2026-09-26):
//   - Upstream service source `Eyevinn/function-scenes`
//     @ 492a18f23e253194c27800563ea0c96bef187aef (`master`):
//       * `api.json` — the OpenAPI 3.0.0 document the function serves at
//         `/api/docs/` (index.js:29-30): `paths./api/v1.post` with request body
//         `#/model/request` (`required: ["medialocator"]`, "URL to video file or
//         video stream") and response `#/model/createJobResponse`
//         (`thumbnails`, `status`); `paths./api/v1/{id}/status.get` → `#/model/job`
//         (`state` enum `created|running|completed|failed|cancelled`).
//       * `index.js` route table — `server.get("/")` healthcheck (:33),
//         `server.post("/api/v1")` reading `req.body.medialocator` (:39,:45) and
//         responding `{ thumbnails, status }` (:47-50),
//         `server.get("/api/v1/:id/status")` (:78),
//         `server.get("/api/v1/:id/thumbnails")` (:63).
//       * `lib/scene_detect_job.js` — `getStatus()` (`{ id, state, session }`),
//         `execute()` (the ffmpeg command and the `time.txt` gap above).
//   - Full write-up: docs/investigations/797-function-scenes-runtime-contract.md
//   - get-service-schema `eyevinn-function-scenes` (provisioning config: `name`
//     only — it exposes NO runtime wire shape, which is why the source was needed).
//   - services/stack.ts SCENE_DETECT_SERVICE_ID.

import { getInstance, type Context } from '@osaas/client-core';
import { SCENE_DETECT_SERVICE_ID } from '../services/stack.js';
import type { SceneDetector, SceneDetectorResult } from './scene-detector.js';

// Detection route on the function (api.json `paths./api/v1.post`). NOT '/', which
// is the healthcheck — see the file header.
export const DEFAULT_SCENE_DETECT_PATH = '/api/v1';

// Per-request timeout for every call to the function. `createJob` awaits the
// ffmpeg spawn before responding (lib/scene_detect.js), so the POST is not
// instantaneous, but no single call may hang a detached pipeline task forever.
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
// Status polling budget. Detection runs for roughly the decode time of the
// source, so the ceiling is generous; the step is fire-and-forget, nobody is
// waiting on it.
const DEFAULT_POLL_INTERVAL_MS = 3_000;
const DEFAULT_POLL_TIMEOUT_MS = 15 * 60_000;

// Job states (api.json `#/model/job.state` enum; constants in
// lib/scene_detect_job.js).
const STATE_COMPLETED = 'completed';
const FAILURE_STATES = new Set(['failed', 'cancelled']);
const ACTIVE_STATES = new Set(['created', 'running']);

// Subset of the OSC SDK surface this runner needs, declared structurally so the
// real SDK functions satisfy it and callers can pass lightweight fakes (mirrors
// OscSubtitleApi in osc-auto-subtitles.ts). We only need instance resolution (to
// find the function URL) and the context's service-access-token minting.
export type OscSceneApi = {
  context: Context;
  getInstance: typeof getInstance;
  // The instance name to call. eyevinn-function-scenes is provisioned separately,
  // so the deployment supplies the name it created; there is no per-request
  // instance.
  instanceName: string;
  // Runtime detection path on the function, appended to the instance URL.
  // Defaults to DEFAULT_SCENE_DETECT_PATH ('/api/v1'); the override exists only so
  // a deployment can follow the function if it is ever mounted under a BASE_PATH.
  path?: string;
  // Injectable fetch for tests; defaults to the global fetch.
  fetchImpl?: typeof fetch;
  // Bounded-wait knobs, injectable so tests need not sleep.
  requestTimeoutMs?: number;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
};

// Build the JSON request body for the detection endpoint. The source-URL field is
// `medialocator` — api.json `#/model/request` marks it the single REQUIRED
// property ("URL to video file or video stream") and the handler reads
// `req.body.medialocator` (index.js:45). A short-lived presigned GET URL satisfies
// it: the value is handed straight to `ffmpeg -i`
// (lib/scene_detect_job.js `execute()`), the same convention as the ffmpeg-s3
// `-i` / auto-subtitles paths.
export function sceneRequestBody(presignedUrl: string): Record<string, unknown> {
  return { medialocator: presignedUrl };
}

// Resolve the base URL of the eyevinn-function-scenes instance. Throws when the
// instance cannot be resolved so the orchestrator records a clear error.
async function resolveInstanceUrl(api: OscSceneApi, token: string): Promise<string> {
  const instance = await api.getInstance(
    api.context,
    SCENE_DETECT_SERVICE_ID,
    api.instanceName,
    token
  );
  const url = (instance as { url?: string } | undefined)?.url;
  if (!url) {
    throw new Error(
      `scene-detect instance "${api.instanceName}" has no resolvable URL`
    );
  }
  return url.replace(/\/+$/, '');
}

// Resolve one of the RELATIVE endpoints the create-job response hands back
// (`${BASE_PATH}/api/v1/${jobId}/status`) against the instance URL. Using the
// returned value verbatim — rather than rebuilding `/api/v1/{id}/status` — is what
// keeps us correct when the function runs under a BASE_PATH (index.js:21).
function resolveAgainstInstance(baseUrl: string, reference: string): string {
  try {
    return new URL(reference, `${baseUrl}/`).toString();
  } catch {
    throw new Error(
      `scene-detect function returned an unusable endpoint reference: ${reference}`
    );
  }
}

// Every call to the function is bounded: a detached pipeline step has no caller to
// time it out.
async function fetchWithTimeout(
  doFetch: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number
): Promise<Response> {
  try {
    return await doFetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`scene-detect call to ${url} failed: ${message}`);
  }
}

// Errors are restify-errors instances serialised as `{ code, message }`
// (index.js:55,:59 — InternalServerError / InvalidContentError). Surface whichever
// of those we can read so a recorded `sceneDetectionError` says why.
async function describeErrorResponse(res: Response): Promise<string> {
  let detail = '';
  try {
    const body = (await res.json()) as { code?: unknown; message?: unknown };
    const parts = [body.code, body.message].filter(
      (part): part is string => typeof part === 'string' && part.length > 0
    );
    if (parts.length > 0) detail = ` (${parts.join(': ')})`;
  } catch {
    // Body absent or not JSON — the status code alone has to do.
  }
  return `HTTP ${res.status}${detail}`;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Poll the job's own status endpoint until it reports a terminal state. Returns
// on `completed`; throws on `failed`/`cancelled`, on a malformed status payload,
// and on exhausting the poll budget — all genuine detection failures.
async function waitForJob(
  doFetch: typeof fetch,
  statusUrl: string,
  token: string,
  requestTimeoutMs: number,
  pollIntervalMs: number,
  pollTimeoutMs: number
): Promise<void> {
  const deadline = Date.now() + pollTimeoutMs;
  let lastState = 'unknown';
  while (Date.now() < deadline) {
    const res = await fetchWithTimeout(
      doFetch,
      statusUrl,
      { method: 'GET', headers: { authorization: `Bearer ${token}` } },
      requestTimeoutMs
    );
    if (!res.ok) {
      throw new Error(`scene-detect status poll failed: ${await describeErrorResponse(res)}`);
    }
    const status = (await res.json()) as { state?: unknown } | null;
    const state = typeof status?.state === 'string' ? status.state : undefined;
    if (state === undefined) {
      throw new Error('scene-detect status response carried no job state');
    }
    lastState = state;
    if (state === STATE_COMPLETED) return;
    if (FAILURE_STATES.has(state)) {
      throw new Error(`scene-detect job ended in state "${state}"`);
    }
    // `created`/`running` — and anything the service grows later — keep polling
    // until the budget runs out; the timeout below is the backstop.
    if (!ACTIVE_STATES.has(state)) lastState = `${state} (unrecognised)`;
    await sleep(pollIntervalMs);
  }
  throw new Error(
    `scene-detect job did not reach a terminal state within ${pollTimeoutMs / 1000}s ` +
      `(last state: ${lastState})`
  );
}

// Construct the production SceneDetector. Each invocation resolves the service
// token + instance URL, starts a detection job, waits for it to finish, and
// returns the raw result envelope for scene-detector.ts to normalize.
export function makeOscSceneDetector(api: OscSceneApi): SceneDetector {
  const doFetch = api.fetchImpl ?? fetch;
  const path = api.path && api.path.length > 0 ? api.path : DEFAULT_SCENE_DETECT_PATH;
  const requestTimeoutMs = api.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const pollIntervalMs = api.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const pollTimeoutMs = api.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;

  return async (presignedUrl: string): Promise<SceneDetectorResult> => {
    const token = await api.context.getServiceAccessToken(SCENE_DETECT_SERVICE_ID);
    const baseUrl = await resolveInstanceUrl(api, token);
    // Join baseUrl (no trailing slash) + path (leading slash preserved).
    const endpoint = path.startsWith('/') ? `${baseUrl}${path}` : `${baseUrl}/${path}`;

    const res = await fetchWithTimeout(
      doFetch,
      endpoint,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          // OSC terminates service auth at the edge using the SAT bearer.
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(sceneRequestBody(presignedUrl))
      },
      requestTimeoutMs
    );
    if (!res.ok) {
      throw new Error(`scene-detect function failed: ${await describeErrorResponse(res)}`);
    }

    // `#/model/createJobResponse`: `{ thumbnails, status }`, both relative.
    const created = (await res.json()) as { status?: unknown } | null;
    if (typeof created?.status !== 'string' || created.status.length === 0) {
      throw new Error('scene-detect function returned no job status endpoint');
    }
    await waitForJob(
      doFetch,
      resolveAgainstInstance(baseUrl, created.status),
      token,
      requestTimeoutMs,
      pollIntervalMs,
      pollTimeoutMs
    );

    // The job completed. The function exposes keyframe image URIs only and no cut
    // timecodes at all (see the KNOWN GAP in the file header), so there is nothing
    // to map onto `scenes`/`cuts` — an empty result is the truthful answer, and
    // scene-detector.ts turns it into `sceneMetadata` with zero boundaries rather
    // than an error.
    return {};
  };
}
