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
// !!! WIRE SHAPE NOT CONTRACT-VERIFIED !!!
// The get-service-schema tool describes ONLY the create-service-instance CONFIG
// for eyevinn-function-scenes (required `name` (string) ONLY — it is a serverless
// media function). It does NOT expose the runtime endpoint's request path or the
// request/response BODY shape. That un-verified wire shape is deliberately
// ISOLATED in this file (behind the injected SceneDetector interface from
// scene-detector.ts) so it can be corrected in exactly one place, or swapped for
// a stub, without touching the fire-and-forget orchestration. The request/
// response mapping below encodes our best-effort assumption:
//   request : { url: <presigned source> } POSTed to the function root ('/').
//   response: a JSON envelope carrying either a structured `scenes` list or a
//             bare `cuts` list of scene-boundary timecodes in seconds.
// Both the endpoint path (`OSC_SCENE_DETECT_PATH`, default '/') and these field
// names are overridable / centralised here precisely because they are NOT
// contract-verified; scene-detector.ts normalizes whatever shape comes back.
//
// Contract sources:
//   - get-service-schema `eyevinn-function-scenes` (provisioning config: `name`
//     only). Runtime wire shape NOT exposed by get-service-schema — isolated here.
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
  // '/'. Overridable because the path is NOT contract-verified (see file header).
  path?: string;
  // Injectable fetch for tests; defaults to the global fetch.
  fetchImpl?: typeof fetch;
};

// Build the JSON request body for the detection endpoint. Kept in one function
// so the (unverified) field names are easy to correct once the real contract is
// known. `url` mirrors the ffmpeg-s3 `-i` / auto-subtitles convention: the
// function is handed an addressable, short-lived presigned source URL.
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

    // Parse the JSON envelope. The exact shape is not contract-verified (see file
    // header); we pass whatever `scenes`/`cuts` fields are present straight to the
    // normalizer in scene-detector.ts, which defends every field.
    const json = (await res.json()) as SceneDetectorResult;
    return {
      scenes: json.scenes,
      cuts: json.cuts
    };
  };
}
