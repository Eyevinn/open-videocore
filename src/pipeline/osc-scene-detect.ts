// Default SceneDetector backed by the OSC eyevinn-function-scenes media function
// (issue #115).
//
// eyevinn-function-scenes ("Scene Detect Media Function") is a serverless media
// FUNCTION. Like eyevinn-auto-subtitles (and unlike the eyevinn-ffmpeg-s3
// ephemeral job runner used for ffprobe/thumbnails/clip), we treat it as a
// resolvable instance we call over HTTP at its instance URL. This runner resolves
// that instance URL (getInstance().url) and its service access token, then starts
// a detection job on the function's job API.
//
// CALL SHAPE (issue #799): the request is no longer written out at the call site.
// It is built from the recorded service contract in function-scenes-contract.ts
// and pinned by test/scene-detect-contract.test.ts, because this call has drifted
// from the service once before: it used to POST `{ url }` to the function root,
// and `/` is the HEALTHCHECK (`server.get("/")`, index.js:33) with no POST route
// — which is the whole reason #783 saw `405 Allow: GET` in production. The
// confirmed detection endpoint is `POST /api/v1` with a `{ medialocator }` body.
// There is NO source-URL query parameter anywhere in the service: no handler ever
// reads `req.query` (#797 was opened to find that parameter's name; the confirmed
// answer is that it does not exist).
//
// STILL OPEN (issue #798): detection is an ASYNCHRONOUS JOB API. `POST /api/v1`
// returns `{ thumbnails, status }` — two relative endpoints to poll — and the
// service exposes only extracted KEYFRAME IMAGE URIs, never the scene-boundary
// timecodes `SceneDetectorResult` models. So a job can be started correctly (that
// is what this file now does) but cannot yet be turned into `sceneMetadata`:
// polling plus a re-scope of what `sceneMetadata` means is #798's job, and the
// re-scope is an architect/ux decision, not an implementation detail. Until then
// this runner reports an explicit error rather than an empty result — see the
// comment at the end of makeOscSceneDetector for why the empty result would be
// actively harmful.
//
// Contract sources (verified 2026-09-26): see function-scenes-contract.ts, which
// records `Eyevinn/function-scenes` @ 492a18f23e253194c27800563ea0c96bef187aef
// (`api.json` `#/model/request.medialocator`, `#/model/createJobResponse`, and
// the `index.js` route table), plus
// docs/investigations/797-function-scenes-runtime-contract.md and
// services/stack.ts SCENE_DETECT_SERVICE_ID. `get-service-schema
// eyevinn-function-scenes` exposes provisioning config (`name`) only — no runtime
// wire shape — which is why the service source is the contract of record.

import { getInstance, type Context } from '@osaas/client-core';
import { SCENE_DETECT_SERVICE_ID } from '../services/stack.js';
import {
  FUNCTION_SCENES_CONTRACT,
  buildCreateJobRequest,
  parseCreateJobResponse
} from './function-scenes-contract.js';
import type { SceneDetector, SceneDetectorResult } from './scene-detector.js';

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
  // Runtime endpoint path on the function, appended to the instance URL.
  // Defaults to the contract path (`POST /api/v1`); the override exists only so
  // a deployment can follow a future service change without a release, and is
  // carried verbatim. Setting it to anything else takes the call off-contract,
  // which is exactly what the pinned default protects against.
  path?: string;
  // Per-request timeout in milliseconds. Needed because `POST /api/v1` is NOT a
  // quick acknowledgement: the handler awaits the whole ffmpeg decode before it
  // answers (lib/scene_detect.js `createJob`), so an un-timed call can hold a
  // socket open for the length of the video. Injectable so tests need not wait.
  requestTimeoutMs?: number;
  // Injectable fetch for tests; defaults to the global fetch.
  fetchImpl?: typeof fetch;
};

// Default cap on one create-job call. Generous because the service decodes the
// whole source before responding, but bounded so a wedged instance cannot pin a
// socket indefinitely.
export const DEFAULT_SCENE_REQUEST_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

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

// Construct the production SceneDetector. Each invocation resolves the service
// token + instance URL and starts one detection job on the function.
export function makeOscSceneDetector(api: OscSceneApi): SceneDetector {
  const doFetch = api.fetchImpl ?? fetch;
  const path = api.path && api.path.length > 0 ? api.path : FUNCTION_SCENES_CONTRACT.createJob.path;
  return async (presignedUrl: string): Promise<SceneDetectorResult> => {
    const token = await api.context.getServiceAccessToken(SCENE_DETECT_SERVICE_ID);
    const baseUrl = await resolveInstanceUrl(api, token);
    // Join baseUrl (no trailing slash) + path (leading slash preserved).
    const endpoint = path.startsWith('/') ? `${baseUrl}${path}` : `${baseUrl}/${path}`;
    const request = buildCreateJobRequest(presignedUrl);

    const res = await doFetch(endpoint, {
      method: request.method,
      headers: {
        ...request.headers,
        // OSC terminates service auth at the edge using the SAT bearer.
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(request.body),
      signal: AbortSignal.timeout(api.requestTimeoutMs ?? DEFAULT_SCENE_REQUEST_TIMEOUT_MS)
    });
    if (!res.ok) {
      throw new Error(`scene-detect function failed: HTTP ${res.status}`);
    }

    // Validate the create-job envelope against the contract, so an incompatible
    // service update is reported as a contract failure rather than swallowed.
    const created = parseCreateJobResponse(await res.json());

    // The job exists and is running; we just cannot report it yet (#798). The
    // alternative — returning `{}` — would be normalised by parseSceneResult
    // into `{ boundaries: [], sceneCount: 0 }` and stored as a SUCCESSFUL
    // detection of zero scenes, which is indistinguishable from a genuinely
    // cut-free video and would be wrong for every single input. An explicit
    // failure is recorded as `sceneDetectionError` by the orchestrator and is
    // honest about the gap.
    throw new Error(
      `scene-detect job started (status endpoint "${created.status}") but scene boundaries ` +
        `cannot be read from ${SCENE_DETECT_SERVICE_ID}: it returns keyframe image URIs only, ` +
        `and create-then-poll plus the sceneMetadata re-scope are pending (issue #798)`
    );
  };
}
