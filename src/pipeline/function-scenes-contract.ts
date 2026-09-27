// Recorded runtime contract for the OSC eyevinn-function-scenes media function
// (issue #799).
//
// WHY THIS FILE EXISTS
// The scene-detect wire shape shipped wrong once already: the call POSTed to the
// function root, which is the service's HEALTHCHECK, and a live run failed with
// `405 Allow: GET` (#783). Nothing in the codebase could have caught that before
// production, because `get-service-schema eyevinn-function-scenes` describes only
// the PROVISIONING config (a single `name` field) and says nothing about the
// runtime request/response shape. So the contract is recorded HERE, as data, and
// pinned by test/scene-detect-contract.test.ts against the service's own OpenAPI
// document — a change to the call shape, or an incompatible service update, now
// fails CI instead of a production run.
//
// CONTRACT SOURCES (fetched and verified first-hand 2026-09-26, per CLAUDE.md
// rule 7 — nothing below is inferred from a probe or a wiki summary):
//   - `Eyevinn/function-scenes` @ 492a18f23e253194c27800563ea0c96bef187aef
//     (`master` HEAD on 2026-09-26, so the pin is current, not stale):
//       * `api.json` — the OpenAPI 3.0.0 document the function itself serves at
//         `/api/docs/` (`info.title` = "Eyevinn MediaFunction::Scenes",
//         `info.version` = "0.1"). Symbols used below: `paths./api/v1.post`,
//         `#/model/request` (`required: ["medialocator"]`),
//         `#/model/createJobResponse` (`thumbnails`, `status`),
//         `#/model/job.state.enum`.
//         A byte-identical snapshot is vendored at
//         docs/contracts/eyevinn-function-scenes-api.json (sha256
//         6eb32141f5f70fa2c7cd3a8442163ad4edb3d9ba01a28f930506722b4cb88ad2) and
//         is what the contract test diffs against.
//       * `index.js` — the restify route table that actually answers requests:
//         `server.get("/")` healthcheck (:33), `server.post("/api/v1")` reading
//         `req.body.medialocator` (:39, :45) and replying
//         `{ thumbnails, status }` (:48-49), `server.get("/api/v1/:id/status")`
//         (:78), `server.get("/api/v1/:id/thumbnails")` (:63),
//         `server.put("/api/v1/:id/status")` (:92), `server.del("/api/v1/:id")`
//         (:116). No handler anywhere reads `req.query`.
//   - Full write-up: docs/investigations/797-function-scenes-runtime-contract.md
//   - Service id: services/stack.ts SCENE_DETECT_SERVICE_ID.
//
// Where `api.json` and `index.js` disagree, `index.js` wins (it is what serves
// the request) and the disagreement is called out inline.

// The single request field that carries the source media URL. NOT `url`, and NOT
// a query parameter — see `FUNCTION_SCENES_CONTRACT.queryParameters`.
export const SCENE_SOURCE_FIELD = 'medialocator' as const;

// Provenance of the recording above, asserted by the contract test so the pin
// cannot drift silently away from the upstream document it was taken from.
export const FUNCTION_SCENES_CONTRACT_SOURCE = {
  repo: 'Eyevinn/function-scenes',
  ref: '492a18f23e253194c27800563ea0c96bef187aef',
  openApiTitle: 'Eyevinn MediaFunction::Scenes',
  openApiVersion: '0.1',
  // Path of the vendored snapshot, relative to the repository root.
  snapshot: 'docs/contracts/eyevinn-function-scenes-api.json',
  verifiedOn: '2026-09-26'
} as const;

export const FUNCTION_SCENES_CONTRACT = {
  // Start a detection job. This is the ONLY endpoint the API calls today.
  createJob: {
    method: 'POST',
    path: '/api/v1',
    contentType: 'application/json',
    requiredBodyFields: [SCENE_SOURCE_FIELD],
    // The request model declares exactly one property and the handler reads
    // exactly one, so any extra field we send is silently dropped — the test
    // pins the body to this exact key set to keep the call honest.
    bodyFields: [SCENE_SOURCE_FIELD],
    responseFields: ['thumbnails', 'status']
  },
  // Poll endpoints. Their concrete URLs MUST be taken from the create-job
  // response rather than rebuilt from these templates: the service prefixes both
  // with its own `BASE_PATH` env var (index.js:21, :48-49). The templates exist
  // so the test can prove the recorded shape matches the published document.
  jobStatus: { method: 'GET', pathTemplate: '/api/v1/{id}/status' },
  jobThumbnails: { method: 'GET', pathTemplate: '/api/v1/{id}/thumbnails' },
  // `GET /` is the healthcheck (empty 200 body), NOT detection. Recorded so the
  // test can assert the call never goes back to it.
  healthcheck: { method: 'GET', path: '/' },
  // `#/model/job.state.enum`, matching the STATE_* constants in
  // lib/scene_detect_job.js.
  jobStates: ['created', 'running', 'completed', 'failed', 'cancelled'],
  // Deliberately empty: the service registers restify's queryParser but no
  // handler ever touches `req.query`. There is no source-URL query parameter to
  // pass (the question #797 was opened to answer).
  queryParameters: [] as readonly string[]
} as const;

// The create-job request, built from the contract rather than from literals at
// the call site, so there is exactly one place the shape can drift and exactly
// one place the test has to pin.
export type SceneCreateJobRequest = {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

export function buildCreateJobRequest(medialocator: string): SceneCreateJobRequest {
  return {
    method: FUNCTION_SCENES_CONTRACT.createJob.method,
    path: FUNCTION_SCENES_CONTRACT.createJob.path,
    headers: { 'content-type': FUNCTION_SCENES_CONTRACT.createJob.contentType },
    // A presigned GET URL satisfies `medialocator` ("URL to video file or video
    // stream"): the value is handed straight to `ffmpeg -i`
    // (lib/scene_detect_job.js `execute()`).
    body: { [SCENE_SOURCE_FIELD]: medialocator }
  };
}

// What `POST /api/v1` answers with: the two endpoints to poll, both RELATIVE to
// the instance URL (index.js:48-49).
export type SceneCreateJobResponse = {
  thumbnails: string;
  status: string;
};

// Parse + validate a create-job response against the recorded contract. Throws
// on anything that is not the documented envelope, so an incompatible service
// update surfaces as a clear error instead of being read as "no scenes found".
export function parseCreateJobResponse(json: unknown): SceneCreateJobResponse {
  const obj = json as Partial<SceneCreateJobResponse> | null | undefined;
  const thumbnails = obj?.thumbnails;
  const status = obj?.status;
  if (typeof thumbnails !== 'string' || typeof status !== 'string') {
    throw new Error(
      `scene-detect create-job response did not match the ${FUNCTION_SCENES_CONTRACT_SOURCE.repo} contract: expected string fields ${FUNCTION_SCENES_CONTRACT.createJob.responseFields.join(
        ', '
      )}`
    );
  }
  return { thumbnails, status };
}
