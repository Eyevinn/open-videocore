# ADR-027: Scene detection runs on `eyevinn-ffmpeg-s3`, not `eyevinn-function-scenes`

**Status:** PROPOSED 2026-10-15, last amended 2026-10-19 — decision record only; no product code changes in this PR
**Date:** 2026-10-15; amended 2026-10-19 (D1/D3/D6 moved to the merged #1191 spike result; review round 2 added [C6](#c6--the-poll-budget-and-the-two-input-url-lifetimes) and [D8](#d8--the-shared-5-minute-poll-budget-is-a-ceiling-on-which-assets-can-get-scenemetadata-1192-must-add-a-per-call-override) and corrected [D6 F1](#d6--fallbacks-f1-is-now-the-decision))
**Author agent:** architect
**Issue:** #1190 — *ADR-027: scene detection runs on `eyevinn-ffmpeg-s3`, not `eyevinn-function-scenes`*. Records the decision the maintainer took on **2026-10-14 in #883** (*re-scope `sceneMetadata` — `eyevinn-function-scenes` cannot return cut timecodes*, now closed). Grounded in #797 / `docs/investigations/797-function-scenes-runtime-contract.md` and in the partial fix #881. Supersedes ADR-001's silence on the scene-detect slot ([D4](#d4--supersedes-adr-001s-silence-on-the-scene-detect-slot)) and amends ADR-023 §4 ([D5](#d5--adr-023-4-is-superseded-in-principle-now-and-retired-with-1193)). Spike: **#1191** — **closed, merged as #1205**; D1, D3 and D6 amended 2026-10-19 to its result (see [§2 C5](#c5--the-ffmpeg-s3-runtime-job-contract-is-not-in-the-catalog-schema-it-is-pinned-by-the-merged-1191-snapshot)). Follow-ups: #1192 (detector rewrite), #1193 (retire the old path). Related: #115 (the step), #798 (closed 2026-10-14 as *not planned* — superseded, see [§5](#5-follow-up-implementation-issues)), #799 (the pinned request contract).

**Citation style.** Code is cited as **file path + symbol name**, without line
numbers, for the reason ADR-026 gives: this branch will drift behind `main`
until merge, and a record whose method is citation-grounding must not land with
stale line numbers. Every symbol named below was read on this branch at
`175ad51` on 2026-10-15; the poll-budget and TTL symbols of
[C6](#c6--the-poll-budget-and-the-two-input-url-lifetimes) were re-read at
`28e2d71` (`main` merged in) on 2026-10-19. Where an issue body, a review
comment, or the Scope of #1190 cites a line number, the symbol at that line is
named instead.

---

## Summary of the decision

| Question | Decision |
|---|---|
| Which OSC service detects scenes? | **`eyevinn-ffmpeg-s3`**, as an ephemeral per-job instance — the same runner that already serves probe, thumbnail, re-wrap and clip. |
| Which service is retired? | **`eyevinn-function-scenes`**. It cannot return cut timecodes through any documented endpoint (#797). |
| Does `sceneMetadata` change? | **No.** It keeps its timecode contract: `boundaries[].startSeconds` / `endSeconds` / `keyframeSeconds`, plus `sceneCount` and `detectedAt`. No OpenAPI change. |
| What does a failed job persist? | **Nothing.** Never `{ boundaries: [], sceneCount: 0 }`. The #881 rule becomes normative ([D3](#d3--failure-semantics-a-failed-or-unreadable-job-persists-nothing-the-881-rule-made-normative)). |
| How long may one detection job take? | **Longer than the shared poll helper allows today.** `pollOscJobUntilDone` has a non-overridable 5-minute budget, and a whole-file decode pass will exceed it for ordinary long-form assets. This ADR does **not** accept that as the ceiling: #1192 must add a per-call budget and raise the source-URL TTL with it ([D8](#d8--the-shared-5-minute-poll-budget-is-a-ceiling-on-which-assets-can-get-scenemetadata-1192-must-add-a-per-call-override)). |
| Is the new path proven? | **Partly.** #1191 (PR #1205) settled that the log route cannot carry the cuts on a successful job; the S3 object route is supported by the uploader but needs one live run before #1192 merges ([D1](#d1--scene-detection-runs-as-an-ephemeral-eyevinn-ffmpeg-s3-job)). Fallbacks if the object route fails: [D6](#d6--fallbacks-f1-is-now-the-decision). |
| Net service count | **−1.** This removes a catalog dependency instead of adding one. |

---

## 1. Context

### 1.1 The slot

`scene-detect` is an **optional, fire-and-forget, metadata-producing** pipeline
step (#115). It annotates the asset with the natural cut points so the clip and
trim workflows can offer them as edit points. Its documented invariants are in
the header of `src/pipeline/scene-detector.ts`: it must never block the ingest
response, never throw into a detached caller, and never drive the lifecycle
state machine. It is registered in `src/pipeline/pipelines.ts` as *"Detect
scene/shot boundaries and keyframes and attach them to the asset for clip and
trim workflows."*

### 1.2 Why the incumbent service cannot serve it

`eyevinn-function-scenes` structurally cannot produce cut timecodes. From
`docs/investigations/797-function-scenes-runtime-contract.md`, confirmed against
the upstream service source at `492a18f23e253194c27800563ea0c96bef187aef`:

- The detection API is an async job API: `POST /api/v1` with a single required
  body field `medialocator`.
- `GET /api/v1/{id}/thumbnails` returns a **bare JSON array of keyframe image
  URIs** — and that is the only result surface.
- The cut timecodes exist inside the job, written by ffmpeg's
  `metadata=print:file=…/time.txt`, and **no documented endpoint serves that
  file**. The investigation explicitly records that the `/images/*` static mount
  may expose it in practice but "must not be relied on".

So the gap is not a wiring bug that a further fix could close — there is no
source of `startSeconds`/`endSeconds` behind that service, for any input.

### 1.3 Where the code stands today (after #881 and #799)

The request side is correct and pinned: `src/pipeline/function-scenes-contract.ts`
records the confirmed contract and `test/scene-detect-contract.test.ts` diffs it
in CI against the vendored upstream document
`docs/contracts/eyevinn-function-scenes-api.json`. The response side is a
deliberate dead end: `makeOscSceneDetector` in
`src/pipeline/osc-scene-detect.ts` starts the job, then **throws** rather than
returning an empty result, with the reason stated in-line — returning `{}` would
be normalised by `parseSceneResult` into `{ boundaries: [], sceneCount: 0 }` and
stored as a *successful detection of zero scenes*. `detectScenes` turns that
throw into `sceneDetectionError` and leaves `sceneMetadata` null. The step runs
cleanly and produces nothing, which is why #881 did not close #798.

### 1.4 Why `eyevinn-ffmpeg-s3` is the obvious host

It is already the runner for four jobs in this codebase, all wired in the same
block of `src/main.ts`: `probe` (`makeOscProbeRunner`), `thumbnailExtractor`
(`makeOscThumbnailExtractor`), `rewrapRunner` (`makeOscRewrapRunner`) and the
clip runner. The ephemeral create-run-read-delete pattern, the terminal-status
poll, the log read, the native S3 writer for outputs, the external-backend
credential mapping and the per-job naming rules are all already built and
tested. Scene detection is one more `cmdLineArgs` string against machinery that
exists.

---

## 2. Verified contract sources (CLAUDE.md rule 7)

### C1 — `sceneMetadata` already models timecodes, at all three layers

The contract #883 decided to **keep** is recorded in three places, and all three
agree:

| Layer | Symbol | Shape |
|---|---|---|
| Domain type | `SceneMetadata`, `SceneBoundary` in `src/data/asset-repo.ts` | `boundaries: SceneBoundary[]`, `sceneCount: number`, `detectedAt: string` (ISO); each boundary `{ startSeconds?, endSeconds?, keyframeSeconds? }`, all optional |
| API schema | `sceneBoundarySchema`, `sceneMetadataSchema` in `src/routes/assets.ts` | `boundaries: z.array(sceneBoundarySchema)`, `keyframeSeconds: z.number().optional()` |
| Persisted document | `SceneBoundarySchema` and the `structural.sceneDetection` block in `src/data/asset-document.ts` | `boundaries: z.array(SceneBoundarySchema).default([])`, plus `sceneCount` and `detectedAt` |

Semantics, from the `SceneBoundary` doc comment in `src/data/asset-repo.ts`:
`startSeconds`/`endSeconds` are the `[start, end)` window of one shot in
seconds, `endSeconds` may be absent for the final shot (no following cut), and
`keyframeSeconds` is a representative keyframe timecode, typically the cut point
at the shot's start.

### C2 — the normaliser already accepts a bare list of cut timecodes

`parseSceneResult` in `src/pipeline/scene-detector.ts` handles two detector
reporting styles. The second one is exactly what an ffmpeg scene filter yields:
given `cuts: number[]`, it filters non-finite values, sorts ascending, and emits
one boundary per cut with `startSeconds = cuts[i]`,
`keyframeSeconds = cuts[i]` and `endSeconds = cuts[i+1]` (omitted for the last
cut). `SceneDetectorResult` already declares `cuts?: number[]`.

**This is load-bearing for the decision:** the new detector can satisfy the
existing `sceneMetadata` contract without changing a single type, schema, or
OpenAPI path. Only the injected `SceneDetector` implementation changes.

### C3 — the ffmpeg-s3 job pattern as this repo already exercises it

Read from `makeOscProbeRunner` in `src/pipeline/osc-ffprobe.ts` (the smallest of
the four runners, and the closest analogue — it also reads a *log*, not an
output object):

- **Service id:** `FFPROBE_SERVICE_ID = 'eyevinn-ffmpeg-s3'`, exported from
  `src/services/stack.ts`. The same string appears as `ffmpegS3` in
  `src/services/external-storage-credentials.ts`.
- **Auth:** `context.getServiceAccessToken(FFPROBE_SERVICE_ID)` — one service
  access token per job.
- **Dispatch:** `createJob(context, FFPROBE_SERVICE_ID, sat, jobBody)` from
  `@osaas/client-core`, with `jobBody = { name, cmdLineArgs }` for a URL source.
- **Job name:** `probeJobName()` — lowercase alphanumeric, bounded, per OSC
  instance-name constraints.
- **Completion:** `pollOscJobUntilDone(api, FFPROBE_SERVICE_ID, name, sat)`
  (`src/pipeline/osc-job-poll.ts`); the service's terminal success value is
  `SuccessCriteriaMet`, and `Failed` / `Error` are the failure values the runner
  rejects on. **The wait is bounded by a module-private 5-minute budget that no
  caller can change** — see [C6](#c6--the-poll-budget-and-the-two-input-url-lifetimes)
  for the exact symbols and [D8](#d8--the-shared-5-minute-poll-budget-is-a-ceiling-on-which-assets-can-get-scenemetadata-1192-must-add-a-per-call-override)
  for why that is the one part of this pattern scene detection cannot reuse as-is.
- **Result read:** `getLogsForInstance(context, FFPROBE_SERVICE_ID, name, sat)`.
  The in-code note is explicit that **the logs route is `/logs/:name`, not
  `/ffmpeg-s3job/:name/logs`** — "confirmed against the live API". The return
  value may be an array of lines or a string; the runner handles both.
- **Cleanup:** `removeJob(...)` in a `finally`, cleanup failure ignored.
- **External sources:** `ffprobeExternalCmdLine(bucket, objectKey)` reads
  `s3://bucket/key` natively, with `awsAccessKeyId` / `awsSecretAccessKey` /
  `s3EndpointUrl` / `awsRegion` / `awsSessionToken` supplied in the job body as
  `{{secrets.<name>}}` **references**, resolved by OSC at job time so the
  literal credential never enters this process (#548; the field-name mapping
  lives in `src/services/external-storage-credentials.ts` and
  `src/services/storage-backend-registry.ts`).
- **Known ffmpeg-s3 quirk, already recorded:** the service runs **ffmpeg, not
  ffprobe** — ffprobe flags exit with code 8. Hence the `-f null -` null-muxer
  idiom and log parsing. (Header of `src/pipeline/osc-ffprobe.ts`, smoke test
  2026-06-01; friction logged in the agents repo as
  `docs/osc-feedback/submitted-2026-06-02-issue6-metadata.md` friction #4 —
  the log was renamed when it was submitted, so the pre-submission
  `incoming-issue6-metadata.md` path cited in earlier revisions of this ADR no
  longer resolves.)

### C4 — ADR-001 already chose this service for this class of work

`docs/architecture/ADR-001-osc-stack.md`:

- The service table row for `eyevinn-ffmpeg-s3`: *"Lightweight, ephemeral FFmpeg
  jobs for tasks where Encore is overkill … Per-job instantiation via
  `create-service-instance` with `cmdLineArgs` … One instance = one job"*.
- The alternatives table, row **"Lightweight FFmpeg jobs"** (the line cited as
  `:73` in #1190): chosen `eyevinn-ffmpeg-s3`; **alternative 2
  `eyevinn-function-scenes`, rejected** — *"Scene detection only; no
  general-purpose FFmpeg capability"*.
- The Consequences bullet cited as `:160`: ffmpeg-s3 *"covers probing,
  thumbnails, remux, and trim in a single service … eliminating the need for two
  separate function services (`eyevinn-function-probe` and
  `eyevinn-function-scenes`)"*.

ADR-001 therefore rejected the service — but it never assigned the scene-detect
capability to anything. That silence is what [D4](#d4--supersedes-adr-001s-silence-on-the-scene-detect-slot) closes.

### C5 — the ffmpeg-s3 runtime job contract is NOT in the catalog schema; it is pinned by the merged #1191 snapshot

**Stated plainly, as the rules require: no live OSC catalog introspection was
available to this session.** No catalog tool was reachable from this agent
invocation, so `get-service-schema(eyevinn-ffmpeg-s3)` was **not** re-run on
2026-10-15. Two independent prior records say what it would have returned
anyway, and neither closes the gap that matters here:

- #797 records that `get-service-schema` for a media function returns **only the
  deployment config**, with `upstreamUrl` / `upstreamVersion` null — *"NOT the
  runtime endpoint's request/response wire shape"*. ADR-023 §2.2 records the
  same for the create config of `eyevinn-function-scenes` (`name` only).
- ADR-026's C-series records the same catalog limitation class for `encore`.

So the authoritative source for the **job body and log behaviour** of
`eyevinn-ffmpeg-s3` today is this repo's own working code (C3) — four runners in
production use plus their tests — not a catalog document. That is a verified
source for the *shape* (`{ name, cmdLineArgs, … }`, `/logs/:name`,
`SuccessCriteriaMet`), and this ADR relies on it only for that shape.

What it is **not** a source for is the one new fact this decision needs: whether
a **successfully completed** job carries the scene filter's per-cut
timestamps, and where. **That was #1191, now merged as #1205.** Its pinned
snapshot `docs/contracts/eyevinn-ffmpeg-s3-job-and-logs.json` settles, from the
service's source, that the log does not carry them on success, and recommends the
S3 object route that D1 now adopts. That route was **not executed**; its
live-run items are listed in D1 and are preconditions for #1192.

Logged as OSC friction (the catalog cannot describe an ephemeral job runner's job
body or result surface) in the agents repo (`Eyevinn/eng-open-videocore-agents`) at
`docs/osc-feedback/incoming-ffmpeg-s3-job-contract-not-in-catalog-schema.md`,
**proposed in `Eyevinn/eng-open-videocore-agents#105`, still open on 2026-10-19** —
so the log is not yet on that repo's `main`. The log records the limitation
from the prior first-hand records cited above (797, ADR-023 §2.2, ADR-026 §2 C1)
plus this repo's four runners. It does **not** claim a fresh `get-service-schema`
probe — no catalog tooling was reachable.

### C6 — the poll budget and the two input-URL lifetimes

Added in review round 2, because D1's reuse of the existing job pattern turns out
to inherit a hard time limit that the earlier revision did not state. Read on this
branch at `28e2d71` on 2026-10-19.

**The shared poll budget — `src/pipeline/osc-job-poll.ts`:**

| Symbol | Value | Overridable? |
|---|---|---|
| `TIMEOUT_MS` | `5 * 60_000` (5 minutes) | **No.** Module-private `const`: not exported, read from no env var, and not a parameter. |
| `POLL_INTERVAL_MS` | `3_000` | No (same). |
| `UNKNOWN_STATUS_GRACE_MS` | `120_000` | No (same); only *whether* it applies is a caller option. |
| `PollOptions` | `{ failFastOnUnknownStatus?: boolean }` | This is the **only** field. There is no timeout member. |

`pollOscJobUntilDone(api, serviceId, name, sat, options: PollOptions = {})`
computes `deadline = Date.now() + TIMEOUT_MS` and, when the loop falls out,
**throws** (`"probe job <name> timed out after 300s"` — the message hardcodes
"probe" for all callers, which #1192 should fix if it reuses the helper). All
four current call sites — `makeOscProbeRunner`, `makeOscThumbnailExtractor`,
`makeOscRewrapRunner` (the `POST /:id/export` path) and `makeOscClipRunner` —
pass no budget, because none of them needs one: thumbnail, clip, re-wrap and the
`-f null -` probe are seeks or short passes.

**The two input-URL lifetimes**, which bound how far that budget may be raised:

- *Internal storage:* `DEFAULT_SCENE_URL_TTL_SECONDS = 30 * 60` (30 minutes) in
  `src/pipeline/scene-detector.ts`, with `sceneUrlTtlSeconds()` reading the
  `SCENE_URL_TTL_SECONDS` env override (positive integers only, else the
  default). The detector passes that presigned GET URL as ffmpeg's `-i`, so it
  must stay valid for the **whole decode pass**, not just the first byte.
- *External storage backends:* the service itself converts an `s3://bucket/key`
  input into a **6-hour** presigned URL with the bundled aws-cli before ffmpeg
  sees it (pinned snapshot `docs/contracts/eyevinn-ffmpeg-s3-job-and-logs.json`,
  symbol `aws s3 presign for s3:// inputs`, `src/ffmpeg.ts:60-79`). So on that
  path the input lifetime is not this repo's constant to set.

Consequence, and the reason this section exists: the poll budget is the binding
constraint, the internal-storage TTL is the next one after it, and neither was
chosen with a whole-file decode in mind. [D8](#d8--the-shared-5-minute-poll-budget-is-a-ceiling-on-which-assets-can-get-scenemetadata-1192-must-add-a-per-call-override) decides what to do about that.

Prior art, and the reason this is not filed as fresh OSC friction: the *platform*
side of it is already logged — agents-repo
`docs/osc-feedback/submitted-2026-06-02-issue6-metadata.md` friction #2 records
that the SDK's `waitForJobToComplete` has a fixed internal poll loop with no
caller-supplied timeout and asks for exactly that. `pollOscJobUntilDone` is this
repo's own replacement for that helper, so the remaining fix is local code, not
an OSC gap.

---

## 3. Decision

### D1 — Scene detection runs as an ephemeral `eyevinn-ffmpeg-s3` job

The `SceneDetector` implementation moves from an HTTP call against a long-lived
`eyevinn-function-scenes` instance to the create-run-read-delete job pattern of
C3, against `FFPROBE_SERVICE_ID`.

**Input contract.** Identical to the probe runner's, because the detector reads
the same stored object:

- *Internal storage:* a short-lived **presigned GET URL** minted for the source
  object, passed as ffmpeg's `-i` argument. The presigned URL stays the only
  credential the detector sees, and the **mechanism** —
  `DEFAULT_SCENE_URL_TTL_SECONDS` / `sceneUrlTtlSeconds()` and the
  `SCENE_URL_TTL_SECONDS` override from `src/pipeline/scene-detector.ts` — is
  carried over unchanged. Its **30-minute default value is not** simply carried
  over: under D1 the URL must outlive a whole-file decode rather than a single
  short read, which makes the TTL a second ceiling alongside the poll budget.
  Both are settled in [D8](#d8--the-shared-5-minute-poll-budget-is-a-ceiling-on-which-assets-can-get-scenemetadata-1192-must-add-a-per-call-override).
- *External storage backends:* `-i "s3://<bucket>/<key>"` plus the credential
  **references** in the job body, exactly as `ffprobeExternalCmdLine` and the
  source-role mapping in `src/services/storage-backend-registry.ts` already do.
  Bytes never transit the API process in either case.
- *Filter and output:* a scene-change `select`, written as a `framemd5` object to the
  stack's object store with ffmpeg-s3's native S3 writer, e.g.
  `-i <source> -an -fps_mode passthrough -vf "select='gt(scene,0.4)'" -f framemd5 s3://<bucket>/<prefix>/<id>.framemd5`
  (the command shape recommended by the #1191 spike,
  `docs/investigations/1191-ffmpeg-s3-scene-cut-timestamps.md`). The detection
  **threshold must stay at the upstream service's `0.4`** (recorded in
  investigation 797 as the incumbent's own invocation) so that moving services
  does not silently change results.
- *Job name:* generated by the same lowercase-alphanumeric bounded-length rule
  as `probeJobName()`.
- *Completion:* `pollOscJobUntilDone` against `SuccessCriteriaMet`, as every
  other runner does — **but with a per-call budget, which the helper does not yet
  accept.** This is the one deliberate deviation from the C3 pattern and the only
  product-code change outside the detector itself that #1192 must make; see
  [D8](#d8--the-shared-5-minute-poll-budget-is-a-ceiling-on-which-assets-can-get-scenemetadata-1192-must-add-a-per-call-override).

**Output contract.** The result surface is an **object**, not the log. When the job
reaches `SuccessCriteriaMet`, the API reads `s3://<bucket>/<prefix>/<id>.framemd5`
back with the stack's storage credentials and parses it into `cuts: number[]`
(seconds). `framemd5` stamps each selected frame with a pts in the stream
timebase and states that timebase in a `#tb` header line, so the parser must
divide by it; it is **not** `pts_time`. Per C2 the resulting list feeds the
existing `parseSceneResult` path untouched. The log is **not** a result surface:
the #1191 spike settled from the service's source (`src/ffmpeg.ts`, pinned in
`docs/contracts/eyevinn-ffmpeg-s3-job-and-logs.json`, `sceneCutReadback.viaLogShowinfo`)
that a job exiting 0 writes no `showinfo` lines to its log, so a log-parsing
detector would read an empty result for every video. The object is deleted with
the job, or expires under the bucket's lifecycle; the location and lifecycle are
decided in #1192 against the live run below.

**Unconfirmed until a live run (preconditions for #1192).** The spike recorded
the object route as supported by the uploader but **not executed**
(`sceneCutReadback.viaS3Object.requiresLiveRun: true`). A live run on a clip with
known cuts must confirm that: the published image's ffmpeg has the `framemd5`
muxer; the output-path rewrite in the service does not mangle the `s3://`
destination; the object appears and parses as described; and the object location
and lifecycle. #1192 must not merge before the snapshot records that run.

**Rejected input variant:** passing the asset bytes through the API process, or
copying the source to a scratch bucket first. Neither is needed; both break the
"no bytes through the orchestrator" property that every other ffmpeg-s3 runner
upholds.

### D2 — `sceneMetadata` keeps its timecode contract, unchanged

`boundaries[].startSeconds` / `endSeconds` / `keyframeSeconds`, `sceneCount`,
`detectedAt`. This is the maintainer's 2026-10-14 choice in #883, and it means
**#883's option 1 — re-scoping `sceneMetadata` to carry keyframe image URIs — is
rejected.** Consequences:

- No change to `SceneMetadata` / `SceneBoundary` (`src/data/asset-repo.ts`), to
  `sceneMetadataSchema` (`src/routes/assets.ts`), to `structural.sceneDetection`
  (`src/data/asset-document.ts`), or to `openapi.json`.
- No consumer migration: `[start, end)` windows are what the clip/trim
  workflows were promised in #115.
- Mapping rule, as already implemented by `parseSceneResult` and therefore
  **not** to be re-derived by the implementer: ascending cut list → one boundary
  per cut, `startSeconds = keyframeSeconds = cut`, `endSeconds = next cut`,
  final boundary has **no** `endSeconds`.
- A detector-level note for #1192: emit `cuts`, not `scenes`. Both are accepted
  by the normaliser, `scenes` wins when both are present, and emitting only
  `cuts` keeps the detector free of window-stitching logic that already exists
  one layer up.

### D3 — Failure semantics: a failed or unreadable job persists NOTHING (the #881 rule, made normative)

This ADR promotes #881's behaviour from a local fix to an invariant of the slot:

> **Never persist `{ boundaries: [], sceneCount: 0 }` for a run that did not
> produce a readable, complete result.** An empty-boundaries record asserts
> "this video has no scene cuts", which an API consumer cannot distinguish from
> a genuine single-shot video. For a structural or transport gap that assertion
> is wrong for every input.

Normative consequences, in the order a run can fail:

| Outcome | What is persisted |
|---|---|
| `createJob` / token / presign fails | nothing; `sceneDetectionError` records the reason, `sceneMetadata` stays null |
| Poll ends `Failed` / `Error`, or the poll budget expires | nothing; error recorded. **Note the second case is not a rare edge:** with the 5-minute budget of [C6](#c6--the-poll-budget-and-the-two-input-url-lifetimes) it is the *expected* outcome for any asset whose decode pass runs longer, so until [D8](#d8--the-shared-5-minute-poll-budget-is-a-ceiling-on-which-assets-can-get-scenemetadata-1192-must-add-a-per-call-override) lands this rule means "no `sceneMetadata` for long assets, by design". And because every runner removes the job in a `finally` (C3), the timeout throw **tears the job down mid-decode** — the object is never written and the compute is wasted, so there is nothing to retry against. That makes D8 a prerequisite, not a tuning detail. |
| Job reached `SuccessCriteriaMet` but the object is missing or its read fails | nothing; error recorded |
| Object read succeeds but cannot be parsed (no `#tb` header, malformed line), or is **detectably truncated** | nothing; error recorded |
| Object parsed, cuts found | `sceneMetadata` with the boundaries, `detectedAt` = completion time |
| Object parsed, **zero** cuts found | see the rule immediately below |

**The zero-cut case is the sharp edge.** A genuinely single-shot video
legitimately produces no cuts, so `sceneCount: 0` is a *valid* result — but only
when "no cuts" is distinguishable from "the result did not arrive". With an object
route that is checkable: a zero-cut result may be persisted as success **only**
when the job reached `SuccessCriteriaMet` **and** the object exists and parses
as a well-formed `framemd5` file (its header and `#tb` line present, with zero
data lines). A missing object, an empty object, or one without the header is
unreadable and persists nothing. Until the live run in D1 confirms that a valid
zero-cut clip yields a header-only object, **a zero-cut result MUST be treated
as unreadable** — recorded as an error, not persisted as success.

The step's **surfacing** semantics are unchanged from ADR-023 §4.4: scene
detection is optional and fire-and-forget, so a failure settles the step
`skipped` with a `skipReason` (or records `sceneDetectionError`) and **never**
fails the pipeline execution or returns 5xx. The existing reason constants
`SCENE_DETECT_UNCONFIGURED_REASON` and `SCENE_DETECT_NO_STORAGE_REASON`
(`src/routes/assets.ts`) and the `skipped` + `skipReason` fields from #789 carry
this with no API change.

### D4 — Supersedes ADR-001's silence on the scene-detect slot

ADR-001 rejected `eyevinn-function-scenes` as a *general-purpose FFmpeg*
alternative (C4) but never named a service for the scene-detect capability
itself; the step was later wired to `eyevinn-function-scenes` without an ADR.
**ADR-027 assigns the scene-detect slot to `eyevinn-ffmpeg-s3` and extends
ADR-001's rejection of `eyevinn-function-scenes` to that slot as well** — on a
different and stronger ground than ADR-001's: not "too narrow", but "cannot
return the data the slot requires through any documented endpoint" (§1.2).

ADR-001's own text needs no correction — its ffmpeg-s3 row and its Consequences
bullet are both still accurate, and this decision makes the Consequences bullet
*more* true by adding scene detection to the list of jobs that one service
covers. ADR-001 is **extended**, not contradicted.

### D5 — ADR-023 §4 is superseded in principle now, and retired with #1193

ADR-023 §4 is a complete, implementation-ready design for **lazily provisioning
a long-lived `eyevinn-function-scenes` instance on first use** —
`ensureSceneDetectProvisioned()`, the single-flight guard, the stack-name
sanitize-and-truncate helper, the readiness deadline, and the persisted
`sceneDetectInstanceName`.

Under D1 **none of that applies to the scene-detect slot**: an ffmpeg-s3 job is
created per run and deleted on completion, so there is no optional service to
provision lazily, no instance name to persist, no readiness wait, and no
teardown obligation. `eyevinn-ffmpeg-s3` is already outside the long-lived
provisioned stack (ADR-001: *"NOT provisioned as a persistent instance"*;
`src/services/stack.ts` records it as the ephemeral runner).

Because the `eyevinn-function-scenes` path is still the code on `main` until
#1192 lands the rewrite and #1193 removes the wiring, ADR-023 §4 is **not
deleted now**. Instead:

1. A pointer note is added to ADR-023 §4 **in this PR**, marking the section
   superseded-in-principle by ADR-027 for the service choice while it remains
   the accurate description of the code until retirement. (This satisfies
   #1190's second acceptance criterion by *amending now*; the note also states
   when the full amendment lands, so either reading of the criterion is met.)
2. The **full** amendment — striking §4.1–§4.3 and §4.5–§4.7 and keeping §4.4's
   failure-surfacing rule, which survives D3 unchanged — happens as part of
   **#1193**, whose scope already says *"amend ADR-023 §4 accordingly"*. #1193
   is blocked by #1192, which waits on the live run named in D1.

ADR-023's **subtitles** decision (§5: explicit provisioning stays primary for
`eyevinn-auto-subtitles`) is untouched by this ADR.

### D6 — Fallbacks (F1 is now the decision)

#1191 — **closed, merged as #1205** — found that a successful job's log carries no
`showinfo` `pts_time` lines, so F1 below is promoted into D1. F2 to F4 stay as the
fallbacks if the live run shows the object route does not work, in order:

- **F1 — adopted in D1: read the cuts out of an uploaded object instead of the
  log, and that object must be ffmpeg's own muxer output.** ffmpeg-s3 has a
  **native S3 writer** that the thumbnail, re-wrap and clip runners already use
  to put outputs at `s3://bucket/key` with credentials in the job body
  (`makeOscThumbnailExtractor`, `makeOscRewrapRunner`, and the
  `s3Endpoint`/`s3AccessKey`/`s3SecretKey`/`s3Bucket` wiring in `src/main.ts`).
  D1 therefore pins a **`framemd5` muxer output** (`-f framemd5
  s3://<bucket>/<prefix>/<id>.framemd5`), whose own output lines carry the
  per-selected-frame pts plus the `#tb` timebase header: *the cut list is the
  output file*.
  **What this is not, and why.** An earlier revision of this item named ffmpeg's
  `metadata=print:file=<path>` **sidecar** — the mechanism the incumbent service
  uses internally (797). The pinned spike snapshot rules that out for the
  single-file upload path: `docs/contracts/eyevinn-ffmpeg-s3-job-and-logs.json`,
  symbol `uploadResult single-file S3 branch` (`src/ffmpeg.ts:317`, `:336-364`),
  records that for an `s3://` dest not ending in `/` the service uploads **only**
  the staging file whose basename equals the dest basename, so *"a sidecar
  written by ffmpeg's `metadata=print:file=<name>` filter is NOT uploaded by this
  branch; only the muxer's own output file is"*. The same snapshot's
  `sceneCutReadback.viaS3Object` states the constraint and then gives the
  `framemd5` command as the `shapeThatFitsTheUploader` — which is exactly why D1
  pins the muxer output and this item no longer names the sidecar.
  **Sidecar variant, considered and not chosen:** the recursive branch
  (`uploadResult recursive S3 branch`, `src/ffmpeg.ts:318-335`, dest path ending
  in `/`) *would* carry a sidecar, at the cost of uploading the whole staging
  directory one prefix level **above** the given prefix, while ffmpeg still has to
  write a real muxer output of its own. Strictly worse than `framemd5` for the
  same result; kept here only as the fallback-of-the-fallback if the live run
  shows the `framemd5` muxer is absent from the published image.
  **Open items are the live run, not the spike.** #1191 is closed and its
  question — *can a successful job's log carry the cuts?* — is **answered: no**.
  What remains unanswered is the snapshot's own
  `sceneCutReadback.viaS3Object.requiresLiveRun: true` list, carried into D1:
  the Alpine ffmpeg build has the `framemd5` muxer, the service's
  first-occurrence output-path rewrite does not mangle the `s3://` dest, and the
  object appears and parses. **Still-valid caveat:** a **presigned PUT** does not
  work with ffmpeg's muxers (#92, #316), so F1 must use the native writer with
  credentials in the job body — not a presigned destination URL.
- **F2 — if neither the log nor an object can carry the cuts: the slot stays
  unfilled, honestly.** Scene detection remains permanently `skipped` with an
  explicit reason (today's post-#881 behaviour), `sceneMetadata` is documented
  as not populated, and `scene-detect` is removed from the default pipelines in
  `src/pipeline/pipelines.ts` rather than being offered as a step that cannot
  succeed. #883 and #798 would then need reopening with ADR-027 amended, and the
  gap logged to `docs/osc-feedback/` as a catalog capability gap (no OSC service
  returns scene-cut timecodes) — the same treatment ADR-001 gave the search gap.
- **F3 — explicitly rejected, not a fallback:** reading
  `/images/{jobId}/time.txt` off `eyevinn-function-scenes`' static mount. It is
  an implementation artefact of a static file mount, documented as
  "must not be relied on" (797), on a service this ADR retires. A hidden
  dependency on an undocumented path is worse than an unfilled slot.
- **F4 — out of scope, recorded for completeness:** running scene detection on
  `encore`. Encore is the ABR transcoding service (ADR-001) with a job queue and
  callbacks; borrowing it for a `-f null -` analysis pass would reintroduce the
  heavyweight path ADR-001 reserved for multi-rendition ladders. Not evaluated,
  not chosen.

### D7 — Alternatives considered

| Option | Verdict | Why |
|---|---|---|
| Keep `eyevinn-function-scenes`, re-scope `sceneMetadata` to keyframe image URIs (#883 option 1) | **Rejected** | Maintainer decision 2026-10-14 (#883). Breaks the #115 promise to clip/trim, which needs timecodes; also a breaking API change, and the URIs are explicitly non-persistent (797). |
| Keep `eyevinn-function-scenes`, parse `time.txt` (#883 option 2) | **Rejected** | Undocumented static-mount artefact (= F3). |
| `eyevinn-ffmpeg-s3` (#883 option 3, "a different OSC service") | **CHOSEN** | Removes a service; reuses four runners' worth of built, tested machinery; keeps the timecode contract. |
| Detect scenes in-process with a bundled ffmpeg | **Rejected** | Pulls media bytes through the orchestrator, contradicts the OSC-native constraint of ADR-001, and makes the API's own resource envelope depend on asset size. |
| Add a new OSC service for scene timecodes | **Rejected for now** | None exists in the catalog; the gap would be an osc-feedback item (F2), not a v1 design. |

### D8 — The shared 5-minute poll budget is a ceiling on which assets can get `sceneMetadata`; #1192 must add a per-call override

**The problem, stated plainly.** D1 reuses `pollOscJobUntilDone`, whose budget is
a module-private `TIMEOUT_MS = 5 * 60_000` with no parameter, no env var and no
member on `PollOptions` ([C6](#c6--the-poll-budget-and-the-two-input-url-lifetimes)).
Scene detection, unlike every existing caller, **decodes the whole file**
(§4, last risk). Combined with [D3](#d3--failure-semantics-a-failed-or-unreadable-job-persists-nothing-the-881-rule-made-normative) —
an expired poll persists nothing — the arithmetic is unforgiving: **any asset
whose decode pass takes longer than five minutes gets no `sceneMetadata`, ever,
by design.** A single-pass decode at, say, 10× realtime crosses five minutes at
roughly a 50-minute source; an HD long-form asset on a cold container will not
make it. That is most of the corpus the clip/trim workflows of #115 care about.
Reusing the helper "unchanged" would therefore ship a step that succeeds on test
clips and silently never produces metadata for real programmes.

**Decision: do not accept the ceiling. Raise it explicitly, and pair it with the
URL lifetime.** #1192 must, as part of the detector rewrite:

1. **Add an optional per-call budget to the poll helper.** Extend `PollOptions`
   with a `timeoutMs?: number` (name is #1192's to choose), defaulting to
   `TIMEOUT_MS` so all four existing call sites keep today's behaviour bit for
   bit, and have `pollOscJobUntilDone` compute its deadline from the resolved
   value. The timeout message must name the caller's job rather than hardcoding
   "probe job". Export the default so the detector can express its own budget
   relative to it. This is a widening change with no behavioural effect on the
   probe, thumbnail, re-wrap or clip runners, and `test/osc-job-poll.test.ts`
   already exercises the helper with fake timers, so the new branch is testable
   without a live service.
2. **Choose the scene-detect budget from the same number as the source-URL
   TTL, not independently.** For the internal-storage path the presigned GET
   must outlive the decode, so the budget must stay **below**
   `sceneUrlTtlSeconds()` — today 30 minutes by default
   (`DEFAULT_SCENE_URL_TTL_SECONDS`), overridable per deployment via
   `SCENE_URL_TTL_SECONDS`. A scene-detect budget above the TTL is not a longer
   wait, it is a *guaranteed* mid-decode 403. So: budget ≤ TTL, with headroom
   for queueing and image pull; if an operator needs a longer budget they must
   raise `SCENE_URL_TTL_SECONDS` with it, and #1192 should fail loudly (or clamp
   and log) when the configured budget exceeds the configured TTL rather than
   let the pair drift silently. On the external-backend path the service mints
   its own 6-hour presign (C6), so only this repo's budget binds there.
3. **Make the resulting limit a documented property of the step, not a
   surprise.** Whatever budget #1192 lands is still finite, so some asset is
   still too long for it. The `skipReason` for a budget expiry must say so
   ("analysis exceeded the configured scene-detect budget"), so an operator can
   tell "too long for the current budget" from "the job failed" from "no cuts
   found" — the distinction [D3](#d3--failure-semantics-a-failed-or-unreadable-job-persists-nothing-the-881-rule-made-normative)
   exists to protect.

**What this ADR does *not* decide:** the actual numbers. Picking a budget and a
TTL needs the throughput figure from the live run named in D1 (how fast the
service's Alpine ffmpeg decodes a representative asset), which no one has yet.
#1192 sets them against that measurement; this ADR only forbids inheriting 5
minutes by silence and fixes the relationship between the two values.

**Rejected alternatives for the ceiling:**

| Option | Verdict | Why |
|---|---|---|
| Accept 5 minutes, document it as a known limit | **Rejected** | It is not a limit, it is a near-total gap: the slot exists for long-form clip/trim, and the honest version of this option is F2 (remove the step) rather than shipping one that works only on short clips. |
| Raise `TIMEOUT_MS` globally for all callers | **Rejected** | The awaited routes (`POST /:id/clip`, `POST /:id/export`) hold an HTTP request open for the whole wait — the reason `UNKNOWN_STATUS_GRACE_MS` exists at all (#786). A global raise lengthens held connections past any sensible gateway timeout for jobs that do not need it. |
| Poll in a detached loop with no budget | **Rejected** | Unbounded waits on OSC calls are the exact class of hazard already logged as friction (`incoming-waitforinstanceready-unbounded.md`, `incoming-osc-client-calls-cannot-be-bounded.md`) and the hazard D5 celebrates removing from this slot. A fire-and-forget step still must terminate. |
| Copy the helper into the detector with a different constant | **Rejected** | Two drifting copies of the terminal-status vocabulary, which is itself only partly evidenced (`ACTIVE_STATUS` padding, #786). One helper, one option. |

---

## 4. Consequences

**Positive**

- One fewer OSC catalog dependency at runtime, and one fewer long-lived
  instance per stack (#1193 removes it from existing stacks).
- No API or persistence change: `sceneMetadata`, its OpenAPI schema and
  `structural.sceneDetection` are all untouched, so no consumer migration and no
  document migration.
- The lazy-provisioning design in ADR-023 §4, with its 20-character stack-name
  truncation hazard and unbounded `waitForInstanceReady`, simply **falls away**
  for this slot — a class of failure removed rather than mitigated.
- The detector joins the pattern the team already debugs daily: same service id,
  same token, same poll **helper**, same cleanup, same external-backend
  credential mapping. **One qualification, not a free reuse:** the poll helper is
  reused but not unchanged — it needs the per-call budget of
  [D8](#d8--the-shared-5-minute-poll-budget-is-a-ceiling-on-which-assets-can-get-scenemetadata-1192-must-add-a-per-call-override),
  because a whole-file decode does not fit the 5-minute budget the four seek-or-
  short-pass runners share. And the result surface is an **object**, not
  `/logs/:name` (D1), so that part of the pattern is replaced rather than reused.
- The outcome #798 was opened for — its acceptance criterion 1, "a run completes
  and writes `sceneMetadata`" — becomes reachable for the first time. #798 itself
  is closed (2026-10-14, *not planned*); #1192 carries that criterion now.

**Negative / risks**

- **The decision is ahead of its evidence.** The spike ruled out the log route
  but did not run the object route; if the live run in D1 shows the object
  cannot carry the cuts, the slot stays unfilled (F2). This is accepted deliberately: the *negative* result
  about `eyevinn-function-scenes` is fully confirmed, so retiring it is correct
  regardless of which fallback wins.
- **A parsed muxer format is still a coupling.** An ffmpeg version bump in the
  service can change the `framemd5` header or timebase, and this repo has already
  been bitten by that class of coupling (`parseFfmpegLogToProbeResult`, the
  frame-rate precision note in `src/pipeline/osc-ffprobe.ts`). Mitigation: the
  pinned snapshot under `docs/contracts/`, plus a CI contract test in the shape
  of `test/scene-detect-contract.test.ts`.
- **A missing or truncated object would silently under-report cuts** — which is
  why D3 makes zero-cut and unparseable results non-persisting until the live run
  confirms a valid zero-cut object.
- **Cost shape changes** from one idle instance per stack to one short-lived
  instance per detection run. ADR-001 prices ffmpeg-s3 at ~10 tokens/day per
  active job instance, so a burst of ingests now costs more concurrent job
  instances than before. Not expected to be material, not measured here.
- **A full-length analysis pass is slower than a seek — and the shared poll
  budget is sized for seeks.** This is the sharpest consequence of the decision:
  until #1192 lands the per-call budget of
  [D8](#d8--the-shared-5-minute-poll-budget-is-a-ceiling-on-which-assets-can-get-scenemetadata-1192-must-add-a-per-call-override),
  `pollOscJobUntilDone`'s 5 minutes ([C6](#c6--the-poll-budget-and-the-two-input-url-lifetimes))
  plus D3's persist-nothing rule mean no `sceneMetadata` at all for any asset
  whose decode pass runs longer, and the expiring poll's `finally` kills the job
  mid-decode. Even after D8 the budget is finite, so a long-enough asset is
  always out of reach; D8.3 requires that case to be surfaced as its own
  `skipReason` instead of looking like a failure.
- **A long single-connection read needs its own object-store endpoint decision.**
  Unlike thumbnail/clip,
  scene detection decodes the whole file, so these jobs are long-running. The
  `#991` note in `src/main.ts` justifies keeping the *public* object-store
  endpoint for the short-seek runners precisely because they are **not** long
  single-connection reads — a scene-detect job **is**, so #1192 must decide the
  endpoint for it rather than copying the thumbnail runner's choice. Recorded
  here so the implementer does not inherit the wrong default.
- Two services' worth of docs, contracts and tests must be deleted (#1193) or
  the repo carries a dead path.

---

## 5. Follow-up implementation issues

| Issue | State | Scope |
|---|---|---|
| **#1191** | **closed — merged as #1205** | Spike: settled that the log route cannot carry the cuts on success; pinned the snapshot and the finding; recommended the S3 object route (not executed). Nothing in this ADR treats its question as still open. |
| **#1192** | open, blocked by the live run in D1 | Detector rewrite: new `SceneDetector` on ffmpeg-s3 per D1/D2, D3's failure table, **the per-call poll budget and the budget-vs-TTL rule of [D8](#d8--the-shared-5-minute-poll-budget-is-a-ceiling-on-which-assets-can-get-scenemetadata-1192-must-add-a-per-call-override) (a change to `src/pipeline/osc-job-poll.ts`, not only to the detector)**, the endpoint decision from §4's risks, and a contract test. |
| **#1193** | open, blocked by #1192 | Retire `eyevinn-function-scenes`: `src/pipeline/osc-scene-detect.ts`, `src/pipeline/function-scenes-contract.ts`, `test/scene-detect-contract.test.ts`, `docs/contracts/eyevinn-function-scenes-api.json`, the `SCENE_DETECT_SERVICE_ID` lazy-provisioning wiring in `src/services/stack.ts`, existing provisioned instances, **and the full ADR-023 §4 amendment (D5.2)**. |
| #798 | **closed 2026-10-14 — _not planned_** | Not a live follow-up. Its premise — a `GET` against `eyevinn-function-scenes` with a source-URL query parameter — does not exist (797), so it was closed alongside the #883 decision rather than carried forward. The outcome it wanted (`sceneMetadata` populated) is delivered by #1192; this ADR does not plan to reopen it. |

No new issue is filed by this ADR; #1191/#1192/#1193 already cover its scope.

---

## 6. Out of scope

- The ffmpeg scene-threshold *tuning* question (is `0.4` right for this
  corpus?). D1 pins it at the incumbent's value so the migration is
  behaviour-preserving; tuning is a separate, evidence-led change.
- Keyframe **images**. The incumbent produced them as a side effect; nothing in
  `sceneMetadata` models them and this ADR does not add them. If they are wanted
  later, the thumbnail runner is the natural home, not the detector.
- Subtitles / `eyevinn-auto-subtitles` (ADR-023 §5).
- Any change to the optional-step `skipped` / `skipReason` contract (#789).

---

## 7. Acceptance mapping (issue #1190)

| #1190 acceptance criterion | Where met |
|---|---|
| ADR-027 merged under `docs/architecture/`, citing the spike result from the spike issue | This file. #1191 is cited as the closed/merged spike (#1205) ([§2 C5](#c5--the-ffmpeg-s3-runtime-job-contract-is-not-in-the-catalog-schema-it-is-pinned-by-the-merged-1191-snapshot), [D6](#d6--fallbacks-f1-is-now-the-decision)); its negative log result is used, and its object-route recommendation is adopted but flagged as not yet run. The confirmed evidence this ADR rests on is investigation 797 plus the maintainer decision in #883. |
| ADR-023 §4 amended, or an explicit note of when it will be | **Both.** §4 carries a superseded-in-principle note from this PR; the full amendment lands with #1193 ([D5](#d5--adr-023-4-is-superseded-in-principle-now-and-retired-with-1193)). |
| Scope: the decision and its consequences | [Summary](#summary-of-the-decision), [D1](#d1--scene-detection-runs-as-an-ephemeral-eyevinn-ffmpeg-s3-job), [D8](#d8--the-shared-5-minute-poll-budget-is-a-ceiling-on-which-assets-can-get-scenemetadata-1192-must-add-a-per-call-override) (the poll-budget consequence of reusing the job pattern), [§4](#4-consequences) |
| Scope: supersedes ADR-001's silence on this slot | [D4](#d4--supersedes-adr-001s-silence-on-the-scene-detect-slot) |
| Scope: amends ADR-023 §4 once the old path is retired | [D5](#d5--adr-023-4-is-superseded-in-principle-now-and-retired-with-1193) |
| Scope: the detector's input and output contract | [D1](#d1--scene-detection-runs-as-an-ephemeral-eyevinn-ffmpeg-s3-job), [D2](#d2--scenemetadata-keeps-its-timecode-contract-unchanged), [§2 C1–C3](#c1--scenemetadata-already-models-timecodes-at-all-three-layers) |
| Scope: failure semantics (the #881 rule) | [D3](#d3--failure-semantics-a-failed-or-unreadable-job-persists-nothing-the-881-rule-made-normative) |
| Scope: the fallback if #1191 fails | [D6](#d6--fallbacks-f1-is-now-the-decision) |

---

## 8. References

**Decisions and records**
- `docs/architecture/ADR-001-osc-stack.md` — ffmpeg-s3 service row; alternatives table row "Lightweight FFmpeg jobs"; Consequences bullet on replacing the two function services; ffmpeg-s3 provisioning + cost notes.
- `docs/architecture/ADR-023-lazy-provisioning-optional-osc-services.md` — §2.2 (`eyevinn-function-scenes` create config = `name` only), §4 (lazy-provisioning design, superseded in principle by D5), §4.4 (failure surfacing, retained), §5 (subtitles, untouched).
- `docs/architecture/ADR-026-profiles-url-source.md` — citation-style precedent; catalog-limitation precedent.
- `docs/investigations/797-function-scenes-runtime-contract.md` — the confirmed negative result this decision rests on.
- `docs/contracts/eyevinn-function-scenes-api.json` — vendored upstream document, retired by #1193.
- `docs/contracts/eyevinn-ffmpeg-s3-job-and-logs.json` — the #1191/#1205 pinned snapshot (`Eyevinn/ffmpeg-s3` @ `95ede50`). Symbols relied on here: `runFFmpeg` (stderr discarded on exit 0), `uploadResult single-file S3 branch` (only the muxer's own output is uploaded — the F1 correction), `uploadResult recursive S3 branch`, `rewriteCmdString output substitution`, `aws s3 presign for s3:// inputs` (6-hour input presign), `Dockerfile runtime` (Alpine's ffmpeg package, muxer set not pinned), and `sceneCutReadback.viaLogShowinfo` / `.viaS3Object` with its `requiresLiveRun` list.
- `docs/investigations/1191-ffmpeg-s3-scene-cut-timestamps.md` — the spike write-up behind that snapshot.

**Code symbols verified on this branch (2026-10-15, `175ad51`; the poll-budget and TTL symbols re-read 2026-10-19 at `28e2d71`)**
- `src/pipeline/scene-detector.ts` — `SceneDetector`, `SceneDetectorResult`, `parseSceneResult`, `sceneUrlTtlSeconds`, `DEFAULT_SCENE_URL_TTL_SECONDS` (= `30 * 60`, env `SCENE_URL_TTL_SECONDS`), `detectScenes`.
- `src/pipeline/osc-scene-detect.ts` — `makeOscSceneDetector` (the deliberate throw, #881).
- `src/pipeline/function-scenes-contract.ts`, `test/scene-detect-contract.test.ts` — the pinned request contract (#799).
- `src/pipeline/osc-ffprobe.ts` — `makeOscProbeRunner`, `OscJobApi`, `ffprobeCmdLine`, `ffprobeExternalCmdLine`, `probeJobName`, `parseFfmpegLogToProbeResult`, the `/logs/:name` note.
- `src/pipeline/osc-job-poll.ts` — `pollOscJobUntilDone`, `PollOptions` (`failFastOnUnknownStatus` only), `TIMEOUT_MS` (module-private, 5 minutes), `POLL_INTERVAL_MS`, `UNKNOWN_STATUS_GRACE_MS`, `TERMINAL_STATUS`, `ACTIVE_STATUS`; `test/osc-job-poll.test.ts` (fake-timer coverage of the budget).
- `src/pipeline/osc-thumbnail.ts`, `src/pipeline/osc-rewrap.ts`, `src/pipeline/osc-clip.ts` — `makeOscThumbnailExtractor`, `makeOscRewrapRunner`, `makeOscClipRunner`: the four poll call sites that pass no budget, and the native S3 writer usage F1 relies on.
- `src/services/stack.ts` — `FFPROBE_SERVICE_ID = 'eyevinn-ffmpeg-s3'`, `SCENE_DETECT_SERVICE_ID`.
- `src/services/external-storage-credentials.ts`, `src/services/storage-backend-registry.ts` — ffmpeg-s3 source-role job-body field mapping.
- `src/main.ts` — the ffmpeg-s3 runner wiring block (`probe`, `thumbnailExtractor`, `rewrapRunner`, clip) and the #991 endpoint note.
- `src/data/asset-repo.ts` — `SceneMetadata`, `SceneBoundary`.
- `src/routes/assets.ts` — `sceneBoundarySchema`, `sceneMetadataSchema`, `SCENE_DETECT_UNCONFIGURED_REASON`, `SCENE_DETECT_NO_STORAGE_REASON`.
- `src/data/asset-document.ts` — `SceneBoundarySchema`, `structural.sceneDetection`.
- `src/pipeline/pipelines.ts` — the `scene-detect` step description.

**Issues** — #115, #797, #798, #799, #881, #883 (the decision), #1190 (this ADR), #1191 (spike, merged as #1205), #1192, #1193; #789 (`skipped` + `skipReason`), #548 (external-backend credential references), #92/#316 (ffmpeg cannot write to a presigned PUT), #991 (in-cluster object-store endpoint).
