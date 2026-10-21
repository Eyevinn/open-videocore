// Contract test for the scene-detect call against eyevinn-function-scenes
// (issue #799).
//
// WHAT THIS PINS AND WHY
// The scene-detect call shipped off-contract once: it POSTed `{ url }` to the
// function root, `/` is the service's healthcheck with no POST route, and the
// mismatch only surfaced when a live run returned `405 Allow: GET` (#783).
// Nothing could have caught it earlier — `get-service-schema
// eyevinn-function-scenes` describes the PROVISIONING config (a single `name`)
// and publishes no runtime wire shape at all. This suite closes that hole from
// both ends:
//
//   1. RECORDING FIDELITY — the contract recorded in
//      src/pipeline/function-scenes-contract.ts is diffed against the service's
//      own OpenAPI document, vendored byte-identically at
//      docs/contracts/eyevinn-function-scenes-api.json. An incompatible service
//      update (renamed field, moved path, changed job states) fails here as soon
//      as the snapshot is refreshed, instead of in production.
//   2. CALL SHAPE — the request `makeOscSceneDetector` actually puts on the wire
//      is captured through an injected `fetchImpl` and asserted against that
//      recording: POST, `/api/v1`, a JSON body whose only key is `medialocator`,
//      and no query string. Reverting the call to GET, back to the healthcheck
//      root, or renaming the source field fails CI.
//
// NOTE ON THIS ISSUE'S ORIGINAL WORDING: #799 asks to assert that the call "uses
// GET, the confirmed query parameter is present". That premise was falsified by
// #797 — the detection endpoint is `POST /api/v1` with a `{ medialocator }` BODY
// and the service reads no query parameter anywhere (`req.query` is never
// touched by any handler). Asserting the issue text verbatim would enshrine a
// contract that does not exist, so this suite asserts the CONFIRMED contract and
// additionally pins the absence of any query parameter, which is the durable
// form of what the issue was reaching for.
//
// CONTRACT SOURCES (fetched first-hand 2026-09-26, per CLAUDE.md rule 7):
//   - `Eyevinn/function-scenes` @ 492a18f23e253194c27800563ea0c96bef187aef,
//     which is `master` HEAD as of 2026-09-26:
//       * `api.json` (the document the function serves at /api/docs/) — symbols
//         `paths./api/v1.post`, `#/model/request` (`required: ["medialocator"]`),
//         `#/model/createJobResponse` (`thumbnails`, `status`),
//         `#/model/job.state.enum`. Vendored snapshot read below.
//       * `index.js` route table — `server.get("/")` healthcheck (:33),
//         `server.post("/api/v1")` reading `req.body.medialocator` (:39, :45),
//         `server.get("/api/v1/:id/status")` (:78),
//         `server.get("/api/v1/:id/thumbnails")` (:63).
//   - docs/investigations/797-function-scenes-runtime-contract.md
//   - services/stack.ts SCENE_DETECT_SERVICE_ID = 'eyevinn-function-scenes'.
//
// This runs in CI with no network and no provisioned instance: the recorded
// snapshot IS the instance's published contract, which is what makes the check
// deterministic. Refreshing the snapshot from upstream is the one manual step,
// and a refresh that changes anything material fails this suite by design.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  FUNCTION_SCENES_CONTRACT,
  FUNCTION_SCENES_CONTRACT_SOURCE,
  SCENE_SOURCE_FIELD,
  buildCreateJobRequest,
  parseCreateJobResponse
} from '../src/pipeline/function-scenes-contract.js';
import { makeOscSceneDetector, type OscSceneApi } from '../src/pipeline/osc-scene-detect.js';
import { SCENE_DETECT_SERVICE_ID } from '../src/services/stack.js';

// ── the service's own OpenAPI document, as vendored ──────────────────────────
const SNAPSHOT_URL = new URL(
  `../${FUNCTION_SCENES_CONTRACT_SOURCE.snapshot}`,
  import.meta.url
);
const apiDoc = JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8')) as {
  openapi: string;
  info: { title: string; version: string };
  paths: Record<string, Record<string, unknown>>;
  model: Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
};

describe('recorded eyevinn-function-scenes contract matches the service document', () => {
  it('is taken from the document the service itself publishes', () => {
    expect(apiDoc.info.title).toBe(FUNCTION_SCENES_CONTRACT_SOURCE.openApiTitle);
    expect(apiDoc.info.version).toBe(FUNCTION_SCENES_CONTRACT_SOURCE.openApiVersion);
    expect(apiDoc.openapi).toMatch(/^3\./);
  });

  it('records the create-job endpoint at the documented method and path', () => {
    const { method, path } = FUNCTION_SCENES_CONTRACT.createJob;
    expect(apiDoc.paths[path]).toBeDefined();
    expect(apiDoc.paths[path][method.toLowerCase()]).toBeDefined();
  });

  it('does not put the detection call on the function root (the healthcheck)', () => {
    // `/` carries only `server.get("/")` in index.js:33 and is absent from the
    // published document entirely — POSTing it is what produced the 405 in #783.
    expect(apiDoc.paths[FUNCTION_SCENES_CONTRACT.healthcheck.path]).toBeUndefined();
    expect(FUNCTION_SCENES_CONTRACT.createJob.path).not.toBe(
      FUNCTION_SCENES_CONTRACT.healthcheck.path
    );
  });

  it('records the source-URL field exactly as the request model requires it', () => {
    expect(apiDoc.model['request'].required).toEqual(
      FUNCTION_SCENES_CONTRACT.createJob.requiredBodyFields
    );
    expect(Object.keys(apiDoc.model['request'].properties ?? {})).toEqual(
      FUNCTION_SCENES_CONTRACT.createJob.bodyFields
    );
    expect(FUNCTION_SCENES_CONTRACT.createJob.bodyFields).toContain(SCENE_SOURCE_FIELD);
  });

  it('records the create-job response envelope', () => {
    expect(Object.keys(apiDoc.model['createJobResponse'].properties ?? {})).toEqual(
      FUNCTION_SCENES_CONTRACT.createJob.responseFields
    );
  });

  it('records the poll endpoints the response points at', () => {
    for (const { method, pathTemplate } of [
      FUNCTION_SCENES_CONTRACT.jobStatus,
      FUNCTION_SCENES_CONTRACT.jobThumbnails
    ]) {
      expect(apiDoc.paths[pathTemplate]).toBeDefined();
      expect(apiDoc.paths[pathTemplate][method.toLowerCase()]).toBeDefined();
    }
  });

  it('records the documented job states', () => {
    const state = (apiDoc.model['job'].properties ?? {})['state'] as { enum?: string[] };
    expect(state.enum).toEqual(FUNCTION_SCENES_CONTRACT.jobStates);
  });

  it('confirms the service takes NO query parameter (the #797 answer)', () => {
    // Every documented parameter is a path parameter; if upstream ever adds a
    // query parameter this fails and the recording has to be updated
    // deliberately rather than guessed at, as #783/#797 did.
    const documented = Object.values(apiDoc.paths)
      .flatMap((methods) => Object.values(methods))
      .flatMap((op) => ((op as { parameters?: Array<{ in: string }> }).parameters ?? []));
    expect(documented.length).toBeGreaterThan(0);
    expect(documented.filter((p) => p.in === 'query')).toEqual([]);
    expect(FUNCTION_SCENES_CONTRACT.queryParameters).toEqual([]);
  });
});

// ── the call we actually make ────────────────────────────────────────────────
const INSTANCE_BASE = 'https://scene-detect-test.eyevinn-function-scenes.osaas.example';
const PRESIGNED =
  'https://minio.example/assets/01J0SOURCE.mp4?X-Amz-Signature=abc&X-Amz-Expires=1800';
const CREATED_JOB = { thumbnails: '/api/v1/1/thumbnails', status: '/api/v1/1/status' };

type Captured = { url: string; init: RequestInit };

function fakeApi(
  opts: {
    path?: string;
    status?: number;
    body?: unknown;
    // Trailing slash on the instance URL is the realistic OSC shape.
    instanceUrl?: string;
  } = {}
): { api: OscSceneApi; calls: Captured[]; tokenFor: string[] } {
  const calls: Captured[] = [];
  const tokenFor: string[] = [];
  const context = {
    getServiceAccessToken: vi.fn(async (serviceId: string) => {
      tokenFor.push(serviceId);
      return 'sat-token';
    })
  } as unknown as OscSceneApi['context'];
  const status = opts.status ?? 200;
  const api: OscSceneApi = {
    context,
    getInstance: vi.fn(async () => ({
      url: opts.instanceUrl ?? `${INSTANCE_BASE}/`
    })) as unknown as OscSceneApi['getInstance'],
    instanceName: 'scene-detect-test',
    ...(opts.path === undefined ? {} : { path: opts.path }),
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => opts.body ?? CREATED_JOB
      } as unknown as Response;
    }) as unknown as typeof fetch
  };
  return { api, calls, tokenFor };
}

// The detector always throws today (scene boundaries are not retrievable from
// this service — see #798), so every call-shape assertion inspects the request
// that was captured before the throw.
async function captureCall(api: OscSceneApi, calls: Captured[]): Promise<Captured> {
  await makeOscSceneDetector(api)(PRESIGNED).catch(() => undefined);
  expect(calls).toHaveLength(1);
  return calls[0];
}

describe('the scene-detect call matches the recorded contract', () => {
  it('uses the contract method — POST, never GET', async () => {
    const { api, calls } = fakeApi();
    const call = await captureCall(api, calls);
    expect(call.init.method).toBe(FUNCTION_SCENES_CONTRACT.createJob.method);
    expect(call.init.method).toBe('POST');
    // Guards the falsified #799/#798 premise: a revert to GET fails here.
    expect(call.init.method).not.toBe('GET');
  });

  it('calls the contract path on the instance, not the healthcheck root', async () => {
    const { api, calls } = fakeApi();
    const call = await captureCall(api, calls);
    const url = new URL(call.url);
    expect(url.pathname).toBe(FUNCTION_SCENES_CONTRACT.createJob.path);
    expect(url.pathname).not.toBe(FUNCTION_SCENES_CONTRACT.healthcheck.path);
    expect(url.origin).toBe(new URL(INSTANCE_BASE).origin);
    // One slash, not two, when the resolved instance URL ends in one.
    expect(call.url).toBe(`${INSTANCE_BASE}${FUNCTION_SCENES_CONTRACT.createJob.path}`);
  });

  it('passes the source URL in the body and NOT in a query string', async () => {
    const { api, calls } = fakeApi();
    const call = await captureCall(api, calls);
    expect(new URL(call.url).search).toBe('');
    const body = JSON.parse(String(call.init.body)) as Record<string, unknown>;
    expect(Object.keys(body)).toEqual(FUNCTION_SCENES_CONTRACT.createJob.bodyFields);
    expect(body[SCENE_SOURCE_FIELD]).toBe(PRESIGNED);
    // The field the pre-#797 call used. Renaming it back fails here.
    expect(body['url']).toBeUndefined();
  });

  it('sends JSON and the OSC service access token for this service', async () => {
    const { api, calls, tokenFor } = fakeApi();
    const call = await captureCall(api, calls);
    const headers = call.init.headers as Record<string, string>;
    expect(headers['content-type']).toBe(FUNCTION_SCENES_CONTRACT.createJob.contentType);
    expect(headers['authorization']).toBe('Bearer sat-token');
    expect(tokenFor).toEqual([SCENE_DETECT_SERVICE_ID]);
  });

  it('bounds the request with a timeout (the service decodes before answering)', async () => {
    const { api, calls } = fakeApi();
    const call = await captureCall({ ...api, requestTimeoutMs: 50 }, calls);
    expect(call.init.signal).toBeInstanceOf(AbortSignal);
  });

  it('honours an explicit path override verbatim', async () => {
    const { api, calls } = fakeApi({ path: '/base/api/v1' });
    const call = await captureCall(api, calls);
    expect(new URL(call.url).pathname).toBe('/base/api/v1');
  });

  it('surfaces the historical 405 as an explicit failure', async () => {
    const { api } = fakeApi({ status: 405 });
    await expect(makeOscSceneDetector(api)(PRESIGNED)).rejects.toThrow(/405/);
  });
});

describe('create-job response handling', () => {
  it('parses the documented envelope', () => {
    expect(parseCreateJobResponse(CREATED_JOB)).toEqual(CREATED_JOB);
  });

  it('rejects an envelope that is not the documented shape', () => {
    // e.g. an incompatible service update, or the `{ scenes, cuts }` shape the
    // pre-#797 code wrongly expected.
    expect(() => parseCreateJobResponse({ scenes: [{ startSeconds: 0 }] })).toThrow(
      /did not match the Eyevinn\/function-scenes contract/
    );
    expect(() => parseCreateJobResponse({ status: '/api/v1/1/status' })).toThrow();
    expect(() => parseCreateJobResponse(null)).toThrow();
  });

  it('never reports a started job as a successful detection of zero scenes', async () => {
    // `POST /api/v1` returns only the two endpoints to poll, and the service
    // exposes keyframe image URIs rather than cut timecodes, so there is no
    // honest `sceneMetadata` to derive yet (#798). An empty result here would be
    // normalised into `{ boundaries: [], sceneCount: 0 }` and stored as a
    // successful detection — indistinguishable from a genuinely cut-free video.
    const { api } = fakeApi();
    await expect(makeOscSceneDetector(api)(PRESIGNED)).rejects.toThrow(/#798/);
  });
});

describe('buildCreateJobRequest', () => {
  it('builds the request straight from the recorded contract', () => {
    const req = buildCreateJobRequest(PRESIGNED);
    expect(req.method).toBe(FUNCTION_SCENES_CONTRACT.createJob.method);
    expect(req.path).toBe(FUNCTION_SCENES_CONTRACT.createJob.path);
    expect(req.headers['content-type']).toBe(FUNCTION_SCENES_CONTRACT.createJob.contentType);
    expect(req.body).toEqual({ [SCENE_SOURCE_FIELD]: PRESIGNED });
  });
});
