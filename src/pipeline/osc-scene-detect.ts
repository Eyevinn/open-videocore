// Default SceneDetector backed by the OSC eyevinn-function-scenes media function
// (issue #115).
//
// eyevinn-function-scenes ("Scene Detect Media Function") is a serverless media
// FUNCTION. Like eyevinn-auto-subtitles (and unlike the eyevinn-ffmpeg-s3
// ephemeral job runner used for ffprobe/thumbnails/clip), we treat it as a
// resolvable instance we call over HTTP at its instance URL. This runner resolves
// that instance URL (getInstance().url) and its service access token, then POSTs
// the detection request to the function's endpoint.
//
// !!! THE WIRE SHAPE BELOW IS KNOWN-WRONG — DO NOT COPY IT (issue #797/#798) !!!
// The real contract has now been CONFIRMED from the service's own source and
// OpenAPI document (see "Contract sources" below), and this file does not match
// it. What the code below does versus what the service actually accepts:
//   path   : POSTs to the function root ('/') — but '/' is the function's
//            HEALTHCHECK (`server.get("/")`, index.js:33). It has no POST route,
//            which is the real reason #783 saw `POST / -> 405 Allow: GET`. The
//            detection endpoint is `POST /api/v1`.
//   field  : sends `{ url: ... }` — the confirmed source-URL field is
//            `medialocator` (api.json `#/model/request`, index.js:45).
//   model  : treats detection as ONE synchronous call — it is actually an
//            ASYNCHRONOUS JOB API: `POST /api/v1` returns
//            `{ thumbnails, status }` (relative URLs) which the caller then polls.
//   result : expects `{ scenes, cuts }` — the service returns NO scene-boundary
//            timecodes at all, only extracted keyframe image URIs. The cut
//            timecodes go to a file inside the job workdir that no documented
//            endpoint exposes.
// There is NO source-URL QUERY PARAMETER anywhere in the service: no handler ever
// reads `req.query`. #797 was opened to find that parameter's name; the confirmed
// answer is that it does not exist.
//
// The wrong shape is left in place ON PURPOSE: #797 is contract-confirmation only
// and explicitly excludes an implementation change; #798 is the fix. It stays
// ISOLATED in this file (behind the injected SceneDetector interface from
// scene-detector.ts) so #798 corrects it in exactly one place without touching the
// fire-and-forget orchestration. Note that #798's own task text is written against
// the false "GET + query parameter" premise and must be re-scoped — see the
// investigation note for what the fix actually has to do.
//
// Contract sources (verified 2026-09-25):
//   - Upstream service source `Eyevinn/function-scenes`
//     @ 492a18f23e253194c27800563ea0c96bef187aef: `api.json` (the OpenAPI 3.0.0
//     document the function itself serves at /api/docs/) — symbols
//     `#/model/request.medialocator` (required) and `#/model/createJobResponse`
//     (`thumbnails`, `status`); and `index.js` route table — `server.get("/")`
//     (healthcheck, :33), `server.post("/api/v1")` (:39),
//     `server.get("/api/v1/:id/status")` (:78),
//     `server.get("/api/v1/:id/thumbnails")` (:63).
//   - Full write-up: docs/investigations/797-function-scenes-runtime-contract.md
//   - get-service-schema `eyevinn-function-scenes` (provisioning config: `name`
//     only — it exposes NO runtime wire shape, which is why the source was needed).
//   - services/stack.ts SCENE_DETECT_SERVICE_ID.

import { getInstance, type Context } from '@osaas/client-core';
import { SCENE_DETECT_SERVICE_ID } from '../services/stack.js';
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
  // Runtime endpoint path on the function, appended to the instance URL. Default
  // '/'. KNOWN-WRONG default (issue #798): '/' is the function's healthcheck; the
  // confirmed detection path is '/api/v1' (index.js:39). The override exists so a
  // deployment can already point at the right path via SCENE_DETECT_PATH, but the
  // request body and response handling are still wrong until #798 lands.
  path?: string;
  // Injectable fetch for tests; defaults to the global fetch.
  fetchImpl?: typeof fetch;
};

// Build the JSON request body for the detection endpoint.
//
// KNOWN-WRONG (issue #798): the confirmed contract names this field
// `medialocator`, not `url` — `api.json` `#/model/request` marks `medialocator`
// required, and the handler reads `req.body.medialocator` (index.js:45). Kept in
// one function so #798 corrects the name in a single place. The value itself is
// right: `medialocator` is documented as "URL to video file or video stream" and
// is handed straight to `ffmpeg -i`, so a short-lived presigned GET URL satisfies
// it (same convention as the ffmpeg-s3 `-i` / auto-subtitles paths).
export function sceneRequestBody(presignedUrl: string): Record<string, unknown> {
  return { url: presignedUrl };
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

// Construct the production SceneDetector. Each invocation resolves the service
// token + instance URL, POSTs the detection request, and returns the raw result
// envelope for scene-detector.ts to normalize.
export function makeOscSceneDetector(api: OscSceneApi): SceneDetector {
  const doFetch = api.fetchImpl ?? fetch;
  const path = api.path && api.path.length > 0 ? api.path : '/';
  return async (presignedUrl: string): Promise<SceneDetectorResult> => {
    const token = await api.context.getServiceAccessToken(SCENE_DETECT_SERVICE_ID);
    const baseUrl = await resolveInstanceUrl(api, token);
    // Join baseUrl (no trailing slash) + path (leading slash preserved).
    const endpoint = path.startsWith('/') ? `${baseUrl}${path}` : `${baseUrl}/${path}`;

    const res = await doFetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // OSC terminates service auth at the edge using the SAT bearer.
        authorization: `Bearer ${token}`
      },
      body: JSON.stringify(sceneRequestBody(presignedUrl))
    });
    if (!res.ok) {
      throw new Error(`scene-detect function failed: HTTP ${res.status}`);
    }

    // Parse the JSON envelope. KNOWN-WRONG (issue #798): the confirmed contract
    // returns `{ thumbnails, status }` (relative URLs to poll) from POST /api/v1 —
    // never `scenes`/`cuts`. Both fields below therefore always resolve to
    // undefined against the real service. The normalizer in scene-detector.ts
    // defends every field, so this degrades to "no scenes" rather than throwing.
    const json = (await res.json()) as SceneDetectorResult;
    return {
      scenes: json.scenes,
      cuts: json.cuts
    };
  };
}
