# ADR-027: Scene detection runs on `eyevinn-ffmpeg-s3`, not `eyevinn-function-scenes`

**Status:** PROPOSED 2026-10-15 — decision record only; no product code changes in this PR
**Date:** 2026-10-15
**Author agent:** architect
**Issue:** #1190 — *ADR-027: scene detection runs on `eyevinn-ffmpeg-s3`, not `eyevinn-function-scenes`*. Records the decision the maintainer took on **2026-10-14 in #883** (*re-scope `sceneMetadata` — `eyevinn-function-scenes` cannot return cut timecodes*, now closed). Grounded in #797 / `docs/investigations/797-function-scenes-runtime-contract.md` and in the partial fix #881. Supersedes ADR-001's silence on the scene-detect slot ([D4](#d4--supersedes-adr-001s-silence-on-the-scene-detect-slot)) and amends ADR-023 §4 ([D5](#d5--adr-023-4-is-superseded-in-principle-now-and-retired-with-1193)). Blocking spike: **#1191** (open, unmerged — see [§2 C5](#c5--the-ffmpeg-s3-runtime-job-contract-is-not-in-the-catalog-schema-and-is-not-yet-pinned-1191)). Follow-ups: #1192 (detector rewrite), #1193 (retire the old path). Related: #115 (the step), #798 (the fix this unblocks), #799 (the pinned request contract).

**Citation style.** Code is cited as **file path + symbol name**, without line
numbers, for the reason ADR-026 gives: this branch will drift behind `main`
until merge, and a record whose method is citation-grounding must not land with
stale line numbers. Every symbol named below was read on this branch at
`175ad51` on 2026-10-15. Where an issue body or the Scope of #1190 cites a line
number, the symbol at that line is named instead.

---

## Summary of the decision

| Question | Decision |
|---|---|
| Which OSC service detects scenes? | **`eyevinn-ffmpeg-s3`**, as an ephemeral per-job instance — the same runner that already serves probe, thumbnail, re-wrap and clip. |
| Which service is retired? | **`eyevinn-function-scenes`**. It cannot return cut timecodes through any documented endpoint (#797). |
| Does `sceneMetadata` change? | **No.** It keeps its timecode contract: `boundaries[].startSeconds` / `endSeconds` / `keyframeSeconds`, plus `sceneCount` and `detectedAt`. No OpenAPI change. |
| What does a failed job persist? | **Nothing.** Never `{ boundaries: [], sceneCount: 0 }`. The #881 rule becomes normative ([D3](#d3--failure-semantics-a-failed-or-unreadable-job-persists-nothing-the-881-rule-made-normative)). |
| Is the new path proven? | **Not yet.** #1191 is the pending spike that pins the ffmpeg-s3 job + log contract. Fallbacks if it fails: [D6](#d6--fallbacks-if-1191-fails). |
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
  rejects on.
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
  2026-06-01; friction logged as
  `docs/osc-feedback/incoming-issue6-metadata.md` friction #4.)

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

### C5 — the ffmpeg-s3 runtime job contract is NOT in the catalog schema, and is not yet pinned (#1191)

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
a **successfully completed** job's log carries the scene filter's per-cut
timestamps, and whether that log is truncated on a long video. **That is exactly
#1191, which is open and whose PR is not merged.** Nothing in this ADR should be
read as a spike result. No `docs/contracts/` snapshot for
`eyevinn-ffmpeg-s3` exists yet (`docs/contracts/` holds
`eyevinn-function-scenes-api.json` and `encore-findbystatus-paging.json` only);
producing one is #1191's deliverable and a precondition for #1192.

Logged as OSC friction (the catalog cannot describe an ephemeral job runner's job
body or result surface) in the agents repo at
`docs/osc-feedback/incoming-ffmpeg-s3-job-contract-not-in-catalog-schema.md`.

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
  credential the detector sees, with the TTL rationale and
  `DEFAULT_SCENE_URL_TTL_SECONDS` / `sceneUrlTtlSeconds()` from
  `src/pipeline/scene-detector.ts` carried over unchanged.
- *External storage backends:* `-i "s3://<bucket>/<key>"` plus the credential
  **references** in the job body, exactly as `ffprobeExternalCmdLine` and the
  source-role mapping in `src/services/storage-backend-registry.ts` already do.
  Bytes never transit the API process in either case.
- *Filter:* a scene-change `select` plus `showinfo`, with `-f null -` so no
  output file is produced — the form #1191 is specified to run. The detection
  **threshold must stay at the upstream service's `0.4`**
  (`select='gt(scene,0.4)'`, recorded in investigation 797 as the incumbent's
  own invocation) so that moving services does not silently change results.
- *Job name:* generated by the same lowercase-alphanumeric bounded-length rule
  as `probeJobName()`.

**Output contract.** The job's **log** is the result surface, read with
`getLogsForInstance` over `/logs/:name` and parsed into `cuts: number[]`
(seconds, from `showinfo`'s `pts_time`). Per C2 that feeds the existing
`parseSceneResult` path untouched. This is a *log-parsing* detector, which is
the same compromise `parseFfmpegLogToProbeResult` already makes for technical
metadata — accepted there, accepted here, and for the same reason: ffmpeg-s3
exposes no structured result channel.

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
| Poll ends `Failed` / `Error`, or the poll budget expires | nothing; error recorded |
| Job reached `SuccessCriteriaMet` but the log read fails | nothing; error recorded |
| Log read succeeds but cannot be parsed, or is **detectably truncated** | nothing; error recorded |
| Log parsed, cuts found | `sceneMetadata` with the boundaries, `detectedAt` = completion time |
| Log parsed, **zero** cuts found | see the rule immediately below |

**The zero-cut case is the sharp edge, and it is conditional on #1191.** A
genuinely single-shot video legitimately produces no cuts, so `sceneCount: 0` is
a *valid* result — but only if "no cuts in the log" is distinguishable from "the
log did not carry the cuts" or "the log was cut short". #1191 question 2 (*is
the log truncated or paged on a long video, and at what size?*) is precisely
that question. Therefore:

- **Until #1191 confirms both that a successful job's log carries the filter
  output and that truncation is detectable, a zero-cut result MUST be treated as
  unreadable** — recorded as an error, not persisted as success.
- Once #1191 confirms it, a zero-cut result may be persisted as success **only**
  when the parser has positive evidence the log is complete (the spike's
  snapshot must name that evidence — e.g. ffmpeg's end-of-run summary line).
  Absent such a marker, the conservative behaviour above stands permanently.

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
   is blocked by #1192, which is blocked by #1191.

ADR-023's **subtitles** decision (§5: explicit provisioning stays primary for
`eyevinn-auto-subtitles`) is untouched by this ADR.

### D6 — Fallbacks if #1191 fails

#1191 asks whether a successful job's log carries `showinfo` `pts_time` lines.
If it does not, in order:

- **F1 — write the filter metadata to an object instead of the log.** ffmpeg's
  `metadata=print:file=<path>` is how the incumbent service already captures the
  cuts (797), and ffmpeg-s3 has a **native S3 writer** that the thumbnail,
  re-wrap and clip runners already use to put outputs at `s3://bucket/key` with
  credentials in the job body (`makeOscThumbnailExtractor`,
  `makeOscRewrapRunner`, and the `s3Endpoint`/`s3AccessKey`/`s3SecretKey`/
  `s3Bucket` wiring in `src/main.ts`). The job writes the metadata file to the
  stack's object store; the API reads it back as an object and parses it. #1191
  is already scoped to confirm this variant. **Caveat, not yet verified:** the
  thumbnail runner's note records that a **presigned PUT** does *not* work with
  ffmpeg's muxers (#92, #316) — F1 must use the native writer with credentials,
  and whether the writer accepts a non-media output path is the open question.
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
  same token, same poll, same `/logs/:name`, same cleanup, same external-backend
  credential mapping.
- #798's acceptance criterion 1 ("a run completes and writes `sceneMetadata`")
  becomes reachable for the first time.

**Negative / risks**

- **The decision is ahead of its evidence.** #1191 is unmerged; if the log does
  not carry the cuts on success, the implementation shape changes (F1) or the
  slot stays unfilled (F2). This is accepted deliberately: the *negative* result
  about `eyevinn-function-scenes` is fully confirmed, so retiring it is correct
  regardless of which fallback wins.
- **Log parsing is a brittle result channel.** An ffmpeg version bump in the
  service can change the `showinfo` format, and this repo has already been bitten
  by exactly that class of coupling (`parseFfmpegLogToProbeResult`, the frame-rate
  precision note in `src/pipeline/osc-ffprobe.ts`). Mitigation: the pinned
  snapshot #1191 produces under `docs/contracts/`, plus a CI contract test in the
  shape of `test/scene-detect-contract.test.ts`.
- **Log truncation would silently under-report cuts on long videos** — which is
  why D3 makes zero-cut and truncation-suspect results non-persisting until
  #1191 settles it.
- **Cost shape changes** from one idle instance per stack to one short-lived
  instance per detection run. ADR-001 prices ffmpeg-s3 at ~10 tokens/day per
  active job instance, so a burst of ingests now costs more concurrent job
  instances than before. Not expected to be material, not measured here.
- **A full-length analysis pass is slower than a seek.** Unlike thumbnail/clip,
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
| **#1191** | open — **blocks everything below** | Spike: confirm the cuts are readable from a successful ffmpeg-s3 job; pin a `docs/contracts/` snapshot + a `docs/investigations/` finding; confirm the F1 fallback if the log route fails. |
| **#1192** | open, blocked by #1191 | Detector rewrite: new `SceneDetector` on ffmpeg-s3 per D1/D2, D3's failure table, the endpoint decision from §4's last risk, and a contract test. |
| **#1193** | open, blocked by #1192 | Retire `eyevinn-function-scenes`: `src/pipeline/osc-scene-detect.ts`, `src/pipeline/function-scenes-contract.ts`, `test/scene-detect-contract.test.ts`, `docs/contracts/eyevinn-function-scenes-api.json`, the `SCENE_DETECT_SERVICE_ID` lazy-provisioning wiring in `src/services/stack.ts`, existing provisioned instances, **and the full ADR-023 §4 amendment (D5.2)**. |
| #798 | open | Closed by #1192, not by this ADR. |

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
| ADR-027 merged under `docs/architecture/`, citing the spike result from the spike issue | This file. #1191 is cited as the **pending** spike ([§2 C5](#c5--the-ffmpeg-s3-runtime-job-contract-is-not-in-the-catalog-schema-and-is-not-yet-pinned-1191), [D6](#d6--fallbacks-if-1191-fails)); its PR is unmerged, so no result is claimed. The confirmed evidence this ADR rests on is investigation 797 plus the maintainer decision in #883. |
| ADR-023 §4 amended, or an explicit note of when it will be | **Both.** §4 carries a superseded-in-principle note from this PR; the full amendment lands with #1193 ([D5](#d5--adr-023-4-is-superseded-in-principle-now-and-retired-with-1193)). |
| Scope: the decision and its consequences | [Summary](#summary-of-the-decision), [D1](#d1--scene-detection-runs-as-an-ephemeral-eyevinn-ffmpeg-s3-job), [§4](#4-consequences) |
| Scope: supersedes ADR-001's silence on this slot | [D4](#d4--supersedes-adr-001s-silence-on-the-scene-detect-slot) |
| Scope: amends ADR-023 §4 once the old path is retired | [D5](#d5--adr-023-4-is-superseded-in-principle-now-and-retired-with-1193) |
| Scope: the detector's input and output contract | [D1](#d1--scene-detection-runs-as-an-ephemeral-eyevinn-ffmpeg-s3-job), [D2](#d2--scenemetadata-keeps-its-timecode-contract-unchanged), [§2 C1–C3](#c1--scenemetadata-already-models-timecodes-at-all-three-layers) |
| Scope: failure semantics (the #881 rule) | [D3](#d3--failure-semantics-a-failed-or-unreadable-job-persists-nothing-the-881-rule-made-normative) |
| Scope: the fallback if #1191 fails | [D6](#d6--fallbacks-if-1191-fails) |

---

## 8. References

**Decisions and records**
- `docs/architecture/ADR-001-osc-stack.md` — ffmpeg-s3 service row; alternatives table row "Lightweight FFmpeg jobs"; Consequences bullet on replacing the two function services; ffmpeg-s3 provisioning + cost notes.
- `docs/architecture/ADR-023-lazy-provisioning-optional-osc-services.md` — §2.2 (`eyevinn-function-scenes` create config = `name` only), §4 (lazy-provisioning design, superseded in principle by D5), §4.4 (failure surfacing, retained), §5 (subtitles, untouched).
- `docs/architecture/ADR-026-profiles-url-source.md` — citation-style precedent; catalog-limitation precedent.
- `docs/investigations/797-function-scenes-runtime-contract.md` — the confirmed negative result this decision rests on.
- `docs/contracts/eyevinn-function-scenes-api.json` — vendored upstream document, retired by #1193.

**Code symbols verified on this branch (2026-10-15, `175ad51`)**
- `src/pipeline/scene-detector.ts` — `SceneDetector`, `SceneDetectorResult`, `parseSceneResult`, `sceneUrlTtlSeconds`, `DEFAULT_SCENE_URL_TTL_SECONDS`, `detectScenes`.
- `src/pipeline/osc-scene-detect.ts` — `makeOscSceneDetector` (the deliberate throw, #881).
- `src/pipeline/function-scenes-contract.ts`, `test/scene-detect-contract.test.ts` — the pinned request contract (#799).
- `src/pipeline/osc-ffprobe.ts` — `makeOscProbeRunner`, `OscJobApi`, `ffprobeCmdLine`, `ffprobeExternalCmdLine`, `probeJobName`, `parseFfmpegLogToProbeResult`, the `/logs/:name` note.
- `src/pipeline/osc-job-poll.ts` — `pollOscJobUntilDone`.
- `src/services/stack.ts` — `FFPROBE_SERVICE_ID = 'eyevinn-ffmpeg-s3'`, `SCENE_DETECT_SERVICE_ID`.
- `src/services/external-storage-credentials.ts`, `src/services/storage-backend-registry.ts` — ffmpeg-s3 source-role job-body field mapping.
- `src/main.ts` — the ffmpeg-s3 runner wiring block (`probe`, `thumbnailExtractor`, `rewrapRunner`, clip) and the #991 endpoint note.
- `src/data/asset-repo.ts` — `SceneMetadata`, `SceneBoundary`.
- `src/routes/assets.ts` — `sceneBoundarySchema`, `sceneMetadataSchema`, `SCENE_DETECT_UNCONFIGURED_REASON`, `SCENE_DETECT_NO_STORAGE_REASON`.
- `src/data/asset-document.ts` — `SceneBoundarySchema`, `structural.sceneDetection`.
- `src/pipeline/pipelines.ts` — the `scene-detect` step description.

**Issues** — #115, #797, #798, #799, #881, #883 (the decision), #1190 (this ADR), #1191 (pending spike), #1192, #1193; #789 (`skipped` + `skipReason`), #548 (external-backend credential references), #92/#316 (ffmpeg cannot write to a presigned PUT), #991 (in-cluster object-store endpoint).
