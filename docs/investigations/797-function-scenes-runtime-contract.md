# Investigation 797 — confirmed runtime contract for `eyevinn-function-scenes`

Status: **contract confirmed** from the service's own source and OpenAPI document.
No runtime behaviour changed here (per #797's acceptance criteria) — this record
feeds the follow-on fix, #798.

## Headline

**There is no source-URL query parameter, and the detection endpoint is not `GET /`.**

`GET /` is the function's *healthcheck*. The detection API is an **asynchronous job
API** rooted at `/api/v1`, started with a **POST** and a JSON body whose source-URL
field is named **`medialocator`**. The previous probing on #783 (`GET / -> 200`,
`POST / -> 405 Allow: GET`) was read as "the function is GET-only and must take the
source URL in a query string"; that inference was wrong, and #797 was opened to find
a parameter name that does not exist.

`POST /api/v1` also returns **only keyframe image URIs**, never scene-boundary
timecodes — so the `scenes` / `cuts` response shape our code assumes does not exist
either (see "Impact on `sceneMetadata`" below).

## Contract source (authoritative)

Upstream service source: **`Eyevinn/function-scenes`** @ `492a18f23e253194c27800563ea0c96bef187aef`
(`master`, default branch). This repository is the source of the OSC catalog service:
its `README.md` carries the OSC badge linking `https://app.osaas.io/browse/eyevinn-function-scenes`,
and `package.json` `name` is `@eyevinn/function-scenes` version `0.1.3`.

Two independent artefacts in that repo were read:

1. **`api.json`** — the service's own OpenAPI 3.0.0 document
   (`info.title` = `Eyevinn MediaFunction::Scenes`, `info.version` = `0.1`). It is
   served by the running function at `/api/docs/` (`index.js:29-30`, via
   `swagger-ui-restify`), so it is the contract the service itself publishes.
2. **`index.js`** — the restify route table, which is what actually answers requests.

Every symbol below was verified against both, with `index.js` taking precedence where
the two disagree (noted inline).

## Confirmed endpoints

Verified from the restify route registrations in `index.js`:

| Method + path | `index.js` | Purpose |
|---|---|---|
| `GET /` | line 33 | Healthcheck. `res.send(200)` — **empty body**, not JSON. |
| `GET /api/docs/`, `GET /api/docs/*` | lines 29-30 | Swagger UI serving `api.json`. |
| `POST /api/v1` | line 39 | **Start a detection job.** |
| `GET /api/v1/:id/status` | line 78 | Job status. |
| `GET /api/v1/:id/thumbnails` | line 63 | Extracted keyframe image URIs. |
| `PUT /api/v1/:id/status` | line 92 | Cancel a job (body `{"state":"cancel"}`). |
| `DELETE /api/v1/:id` | line 116 | Delete + clean up a job. |
| `GET /images/*` | line 131 | Static file serving of the generated images from `/var/jobs/`. |

**No route anywhere in the service reads a query parameter.** `index.js:24` registers
`Restify.plugins.queryParser()`, but no handler ever touches `req.query` — the only
request inputs are `req.body.medialocator` (line 45), `req.body.state` (line 99) and
the `:id` path parameter. This is the definitive answer to #797's question: the
"exact query parameter name for the presigned source URL" **does not exist**.

### Why #783's probe looked GET-only

`/` has exactly one registered method — `server.get("/", ...)` at `index.js:33`. There
is no `server.post("/")`. Restify therefore answers `POST /` with `405` and an `Allow: GET`
header listing the only method registered on that path. So the source **exactly predicts**
both observations recorded on #783 (`GET / -> 200`, `POST / -> 405 Allow: GET`) — they
are a healthcheck and a method-not-allowed on the healthcheck path, not evidence about
the detection API. The live probe and the wiki were never actually in conflict; the
probe was aimed at the wrong path.

The `401` on any query string (`GET /?url=... -> 401`) came from the OSC ingress in
front of the instance, not from the function, which is why it appeared regardless of
the parameter name tried. It is unrelated to the function's contract.

## Confirmed request shape

`POST /api/v1`, `content-type: application/json`.

Body — `api.json` `#/model/request`:

```json
{ "medialocator": "https://s3-bucket/testfile.mp4" }
```

- **`medialocator`** (string, **required**) — "URL to video file or video stream".
  Verified twice: `api.json` `model.request.required: ["medialocator"]` /
  `model.request.properties.medialocator`, and the handler read at
  `index.js:45` (`const mediaLocator = req.body.medialocator;`).
- No other request fields exist. `model.request` declares exactly one property, and
  the handler reads exactly one.
- A presigned GET URL satisfies this: the value is passed straight to `ffmpeg -i`
  (`lib/scene_detect_job.js`, `execute()`), so any URL ffmpeg can open works.

## Confirmed response shapes

**`POST /api/v1` → `200`** (`index.js:47-50`, `api.json` `#/model/createJobResponse`):

```json
{ "thumbnails": "/api/v1/1/thumbnails", "status": "/api/v1/1/status" }
```

Both values are **relative paths**, built as `` `${BASE_PATH}/api/v1/${jobId}/...` ``
where `BASE_PATH` is the function's own `BASE_PATH` env var (`index.js:21`, default
`''`). A client must resolve them against the instance base URL rather than assume
`/api/v1/{id}/...`. Note the job id is a **sequential integer** starting at `1`
(`lib/scene_detect.js`, `this.nextJobId++`) held in an in-memory map — ids are
per-replica, which is why the README requires sticky sessions when scaling.

**`GET /api/v1/:id/status` → `200`** (`index.js:84`, returning `job.getStatus()`):

```json
{ "id": 1, "state": "created", "session": "<uuid>" }
```

- `state` enum (`api.json` `#/model/job`, constants in `lib/scene_detect_job.js`):
  `created` | `running` | `completed` | `failed` | `cancelled`.
- **`session` is returned by the code but is absent from `api.json`'s `#/model/job`.**
  The OpenAPI document is incomplete here; `getStatus()` in `lib/scene_detect_job.js`
  is authoritative.
- `id` is the numeric job id (`api.json` types it `string`; the code returns the
  number it generated — another doc/code mismatch, so treat it as `string | number`).

**`GET /api/v1/:id/thumbnails` → `200`** (`index.js:70`) — a **bare JSON array of
strings**, not an object:

```json
["/images/1/img001.png", "/images/1/img002.png"]
```

Each entry is `` `${basePath}/images/${jobId}/${filename}` `` for every `*.png` in the
job's workdir (`getDetectedThumbnails()` in `lib/scene_detect_job.js`) — again relative,
again to be resolved against the instance URL. Per the README the array **grows while
the job runs**, so a client polls it until `status.state === 'completed'`. The images
are explicitly non-persistent and must be copied elsewhere.

## Confirmed error shape

Errors are `restify-errors` instances passed to `next(err)`, serialised by restify as
JSON `{"code": "...", "message": "..."}`:

- Missing/unparseable body on `POST /api/v1` → `InvalidContentError` → **`400`**,
  `code: "InvalidContent"`, `message: "Missing Request Body"` (`index.js:59`).
- Any failure inside job creation (including ffmpeg failing to open the source URL) →
  `InternalServerError` → **`500`** carrying the underlying message (`index.js:55`).
- `GET /api/v1/:id/thumbnails` on an unknown id throws inside the handler
  (`sceneDetect.getJob(req.params.id)`, `index.js:68`) and also surfaces as **`500`**,
  not `404` (`index.js:73`) — there is no not-found path.
  Same for a job in state `failed`: `"Can't get thumbnails of a job that has failed"`.

`api.json` documents **no** non-200 responses; the error shape above comes from the
code and from `restify-errors` defaults.

## Impact on `sceneMetadata` (feeds #798)

This is the part that matters most for the follow-on fix, and it invalidates #798 as
currently written:

1. **#798's premise is wrong.** It asks to "change the call to GET, passing the
   presigned source URL via the confirmed query parameter name". There is no such
   parameter and `GET /` is a healthcheck. The correct fix is to keep a **POST**, move
   it from `/` to **`/api/v1`**, and rename the body field from `url` to
   **`medialocator`** — then poll the returned `status` endpoint and read the
   `thumbnails` endpoint.
2. **The function returns no scene-boundary timecodes.** `SceneDetectorResult` in
   `src/pipeline/scene-detector.ts` expects `scenes[]` (`startSeconds` / `endSeconds` /
   `keyframeSeconds`) or `cuts[]` (seconds). The service exposes **neither**. Its
   ffmpeg invocation is
   `select='gt(scene,0.4)',metadata=print:file=${workdir}/time.txt` — the cut
   timecodes are written to `time.txt` **inside the job workdir and never exposed by
   any documented endpoint**. Only the extracted PNGs are returned, as URIs.
   (`/images/*` is a static mount of `/var/jobs/`, so `/images/{jobId}/time.txt` may
   in practice be readable, but that is an implementation artefact, not a contract,
   and must not be relied on.)
3. Consequently the scene-detect feature cannot populate `[start, end)` boundaries
   from this service as designed. #798 must first decide between: (a) redefining
   `sceneMetadata` as keyframe URIs rather than cut timecodes, (b) parsing `time.txt`
   and accepting the undocumented dependency, or (c) using a different OSC service.
   That is a design decision for the architect, not an implementation detail.
4. Calls are long-running and stateful: `createJob` `await`s `job.execute()` before
   responding (`lib/scene_detect.js`), and job state lives in a per-replica in-memory
   map, so any client needs a request timeout plus sticky-session-safe polling of the
   **exact `status`/`thumbnails` URLs returned by the POST** rather than reconstructed ones.

## Current code vs confirmed contract

> **Update (#799, 2026-09-26):** the paragraph below describes the code as it stood
> when this note was written. The **request** side has since been corrected and
> pinned: the call is built from `src/pipeline/function-scenes-contract.ts` (a
> recording of the contract confirmed here, diffed in CI against the vendored
> upstream document `docs/contracts/eyevinn-function-scenes-api.json` by
> `test/scene-detect-contract.test.ts`), so it now sends
> `POST <instanceUrl>/api/v1` with `{ "medialocator": <presigned> }`. The
> **response** side is unchanged and still the open part: create-then-poll and the
> `sceneMetadata` re-scope remain #798's, so a started job is reported as an
> explicit error rather than as a successful detection of zero scenes.

`src/pipeline/osc-scene-detect.ts` today sends `POST <instanceUrl>/` (path from
`SCENE_DETECT_PATH`, default `/`) with body `{ "url": <presigned> }` and expects
`{ scenes, cuts }` back. Against the confirmed contract that is wrong in four ways:
wrong path (`/` vs `/api/v1`), wrong field name (`url` vs `medialocator`), wrong
interaction model (single synchronous call vs create-then-poll), and a response shape
the service never produces. Left unchanged here deliberately — #797 is confirmation
only; #798 is the fix.

## What OSC tooling could and could not tell us

`get-service-schema(eyevinn-function-scenes)` returns only the **deployment** config
(a single required `name`), with `upstreamUrl` / `upstreamVersion` null, and the OSC
wiki's summary conflicted with the #783 probe. Neither pointed at
`Eyevinn/function-scenes`, which is where the answer was the whole time. Two prior
daily runs were blocked on this.

Two further gaps were confirmed first-hand while writing this note. The catalog HTTP API
(`GET https://catalog.svc.prod.osaas.io/service/eyevinn-function-scenes`) rejects a valid,
unexpired personal access token in every header form tried (`Authorization: Bearer <pat>`
and bare `<pat>` → `401 {"error":"invalid authorization header"}`; `x-pat-jwt` / `x-jwt` →
`401 missing authorization header`), and no `/servicespec*` route exists (`404`). And
`@osaas/client-core@0.24.0` does not re-export `getService` from its entry point at all
(39 exports, none of them `getService`, though `lib/core.d.ts:2` declares it); calling
`lib/core.js`'s `getService` directly fails with
`Service eyevinn-function-scenes not found in your subscriptions`, so catalog metadata is
only readable for services you have already subscribed to.

Logged as OSC friction in the agents repo at
`docs/osc-feedback/incoming-function-scenes-catalog-no-upstream-source-link.md`
(`Eyevinn/eng-open-videocore-agents`, pushed 2026-09-25 as commit `2ae6ed4` on branch
`osc-feedback/function-scenes-catalog-contract` — awaiting merge to `main`).
