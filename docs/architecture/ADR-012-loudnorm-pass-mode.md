# ADR-012: loudnorm pass mode — single-pass shipped default, two-pass as future orchestration

**Status:** PROPOSED 2026-08-22
**Date:** 2026-08-22
**Author agent:** claude-opus-4-8
**Issue:** #384 (decision fed by contract spike #383; consumed by profile issue #385/#386)

---

## Context

A loudness-normalisation profile applies ffmpeg's `loudnorm` filter to bring an
audio output to an EBU R128 target (integrated loudness `I`, true-peak `TP`,
loudness range `LRA`). `loudnorm` can run two ways:

- **Single pass** — one ffmpeg invocation runs `loudnorm` in its *dynamic*
  (streaming) mode. It adapts as it reads and lands *approximately* on the
  target. This is a profile-only change: one `loudnorm=…` string in the
  `AudioEncode.filters` list.
- **Two pass (measure-then-apply)** — a first pass runs `loudnorm` in analysis
  mode (`print_format=json`) to measure the source's integrated loudness, true
  peak, LRA and threshold; a second pass runs `loudnorm` again with those
  measured values pinned (`measured_I`, `measured_TP`, `measured_LRA`,
  `measured_thresh`, plus `linear=true`) so the correction is *linear* and lands
  within ffmpeg's stated tolerance.

Issue #384 explicitly flags this as a decision to make, not to assume: single
pass is a profile-only change; two pass is orchestration work that crosses into
the pipeline (a measure step feeding measured values into a second encode),
touching the job and callback model. This ADR records the chosen mode, the
accuracy/cost trade-off, and — because two pass is the more expensive option —
describes the two-pass orchestration surface concretely enough for the profile
issue to consume it should we ever promote it.

The audio-filter contract this decision rests on was verified in the #383 spike:
`docs/architecture/encore-audioencode-loudnorm-contract.md`.

## Verified constraint

### A single Encore job = one ffmpeg invocation per output encode

Source: `docs/architecture/encore-audioencode-loudnorm-contract.md` (#383),
cross-checked against this repo's job/callback model.

- Encore's `AudioEncode.filters: List<String>` is joined with commas and inserted
  verbatim into the ffmpeg audio filter chain for that output
  (`(dialogueEnhanceFilters + mixFilters + filters).joinToString(",")` — SVT
  Encore `AudioEncode.kt`, cited in the #383 spike §2). A single-pass
  `loudnorm=I=-23:TP=-1:LRA=7` element is therefore expressible directly in a
  served profile YAML.
- Encore selects a profile **by name only**; the job body carries no filter
  shape. `toEncorePayload` submits `{ externalId, profile, profileParams?,
  outputFolder, baseName, inputs }` with **no `outputs` field**
  (`src/pipeline/encore-client.ts:81-98`). The filter shape lives entirely in the
  served YAML (`src/routes/profiles.ts:219-235`, `GET /:name/yaml`).
- `profileParams` is a flat string map forwarded verbatim into Encore's job
  document, which Encore evaluates as SpEL expression properties inside the named
  profile (`src/pipeline/encore-client.ts:33-39` and `:81-98`;
  `EncoreJob.profileParams: Map<String, Any?>`). This is how a target — or a set
  of measured values — is parametrised without editing the profile document.
- **One Encore job runs one ffmpeg invocation per output encode.** There is no
  in-job "run twice, thread the measurement between runs" primitive. True
  measure-then-apply two-pass loudnorm therefore **cannot** be expressed inside a
  single Encore job by a profile alone. It requires either:
  - (a) ffmpeg's own single-invocation *dynamic* `loudnorm` (one pass,
    approximate) — profile-only; or
  - (b) an orchestrated **measure job → apply job** flow across *two* Encore jobs,
    with the first job's measured values threaded into the second job's
    `profileParams`. This crosses into the pipeline: it needs a new step whose
    completion callback parses a measurement and dispatches a second encode.

### The job/callback model that option (b) would have to extend

Sources (this repo):

- `src/pipeline/encore-callback-poller.ts` — completion is delivered as a queue
  message `{ jobId, url }` (the callback-listener envelope, lines 8-9, 70-75).
  `handleMessage` (lines 227-445) fetches the finished Encore job document over
  HTTP, resolves our job by `externalId`, runs `completeTranscode`, and advances
  the matching `PipelineExecution` — including the existing "next step is
  `package` → enqueue packaging" hand-off (lines 386-434). Any measure→apply flow
  would hook the *same* place: on a `measure` step completing, read the
  measurement off the Encore job document and dispatch the apply job, exactly as
  the `package` step is enqueued today.
- The Encore job document fetched at `src/pipeline/encore-callback-poller.ts:264-289`
  is typed as `{ externalId?, status?, message?, output? }`. A measure pass would
  need its measured loudness values to surface on that document (or a sibling
  artifact) so the poller can read them — see "OSC feedback / open question"
  below.
- `src/routes/jobs.ts:34` accepts an optional `profile` per job; the transcode
  path threads `profileParams` through to Encore
  (`src/pipeline/transcode.ts:43-49,100`). An apply job would reuse this exact
  path, passing the measured values as `profileParams`.

## Options evaluated

### Option A — single-pass dynamic loudnorm (profile-only)

One `AudioEncode.filters` element, e.g.
`loudnorm=I=-23:TP=-1:LRA=7` (or with `I`/`TP`/`LRA` supplied via `profileParams`
so the target is parametrisable per job).

- **Orchestration cost:** none. No API, job-model, or callback change. A served
  profile is the entire change (matches #385's "profile + profileParams" scope).
- **Accuracy (qualitative):** dynamic `loudnorm` adapts as it streams and lands
  *approximately* on the target. Per well-known ffmpeg `loudnorm` behaviour,
  single-pass output typically drifts on the order of **~±1 LUFS** from the
  requested integrated target and can *pump* (audible level-riding) on
  wide-loudness-range material, because the correction is applied before the
  whole programme's loudness is known. It does not guarantee landing within EBU
  R128's tight tolerance.
- **Latency/compute cost:** the audio encode reads the stream **once**; cost is
  ~1x the audio-processing pass. No second job, no orchestration latency.

### Option B — two-pass measure-then-apply (orchestrated across two Encore jobs)

A `measure` Encore job runs `loudnorm=…:print_format=json` and emits measured
values; those values are threaded as `profileParams` into a second `apply` Encore
job whose profile runs `loudnorm=…:measured_I=…:measured_TP=…:measured_LRA=…:measured_thresh=…:linear=true`.

- **Orchestration cost:** significant. It adds a pipeline step and a second
  Encore job, a completion callback that parses the measurement, and a way to
  surface the measured JSON from the measure job (open OSC question below). This
  expands #385 from profile-only into pipeline orchestration.
- **Accuracy (qualitative):** with the measured values pinned and `linear=true`,
  the correction is a single linear gain over the whole programme, landing
  **within ffmpeg's stated `loudnorm` tolerance** and without the pumping that
  dynamic mode can introduce. This is the accurate EBU R128 path.
- **Latency/compute cost:** the audio is processed **twice** (measure + apply),
  so ~**2x** the audio-processing cost/latency for that output, plus the fixed
  overhead of a second Encore job dispatch and its callback round-trip through the
  poller.

## Decision

**CHOSEN: Option A — single-pass dynamic loudnorm as the shipped profile
default.** **Option B (two-pass measure-then-apply) is recorded as a documented
future orchestration option**, not shipped now.

Rationale:

- Option A is **implementable today with zero job/API/callback change** — purely
  a served profile (plus optional `profileParams` for the target). It matches the
  profile-only scope the profile issue (#385) is chartered for and lets loudness
  normalisation ship immediately.
- Option B is the more *accurate* mode, but it is **orchestration work that
  crosses into the pipeline** (a measure step, a second Encore job, a
  measurement-parsing callback, and an unresolved way to surface the measured
  JSON). Making it the default would expand #385 from a profile change into a
  pipeline feature and pull in the job/callback model — a materially larger scope
  than the profile issue is sized for.
- The accuracy gap of Option A (**~±1 LUFS** drift, possible pumping on wide-LRA
  material) is acceptable for a first shipped loudness profile and is the standard
  trade-off for single-pass loudnorm. Consumers needing tight EBU R128 compliance
  are directed to the Option B surface below, which is described concretely so it
  can be promoted without re-deciding the mechanism.

If, after empirical validation (deferred — see below), single-pass drift proves
unacceptable for the target material, promote Option B using the surface in the
next section; this ADR should then be superseded/addended rather than
re-litigated.

### Concrete two-pass orchestration surface (for #385/#386 to consume if promoted)

Described concretely so the profile issue can build against a fixed shape rather
than re-designing it:

1. **Two served profiles** (both profile-only YAML, same `filters` contract as
   §Verified constraint):
   - `loudnorm-measure` — an `AudioEncode` whose `filters` contains
     `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:print_format=json`. Target values come
     from `profileParams` (`I`, `TP`, `LRA`). This job's purpose is measurement,
     not delivery.
   - `loudnorm-apply` — an `AudioEncode` whose `filters` contains
     `loudnorm=I=${I}:TP=${TP}:LRA=${LRA}:measured_I=${measured_I}:measured_TP=${measured_TP}:measured_LRA=${measured_LRA}:measured_thresh=${measured_thresh}:linear=true`.
     All eight values arrive via `profileParams` (contract:
     `src/pipeline/encore-client.ts:33-39,81-98`).
2. **Dispatch the measure job** through the existing transcode path
   (`src/pipeline/transcode.ts:100`, `src/pipeline/encore-client.ts` `submit`),
   selecting `profile: "loudnorm-measure"` with the target as `profileParams`. It
   becomes a new `measure` step on the `PipelineExecution`.
3. **On measure-job completion**, hook the existing completion handler
   (`src/pipeline/encore-callback-poller.ts` `handleMessage`, lines 386-434 — the
   same place the `package` step is advanced today). Read the four measured values
   emitted by the `print_format=json` pass off the finished Encore job document
   (`{ externalId, status, message, output }`, lines 264-289) — see the open OSC
   question about *where* that JSON surfaces.
4. **Dispatch the apply job** selecting `profile: "loudnorm-apply"`, threading the
   measured values plus the original target as `profileParams`, reusing the exact
   `submit`/`profileParams` path. Its completion advances the execution as a
   normal transcode does.

This keeps the mechanism entirely inside patterns the repo already has (named
profiles + `profileParams` + the poller's step-advancement hand-off); the only
genuinely new pieces are the `measure` step and the measurement-parsing branch in
the callback.

## Empirical validation: DEFERRED (no Encore instance)

**0 Encore instances are provisioned for this workspace** (verified during #383
via OSC `list-service-instances` for serviceId `encore`: "0 instances running").
Therefore this ADR **cannot** produce real measured numbers for single-pass drift
or for the second-pass latency multiplier. The accuracy/cost figures above are
stated **qualitatively** from well-known ffmpeg `loudnorm` characteristics
(single-pass dynamic drift ~±1 LUFS with possible pumping on wide-LRA material;
two-pass linear landing within ffmpeg's stated tolerance at ~2x audio-processing
cost). **No numbers have been fabricated.**

Empirical validation is **DEFERRED pending a live Encore instance**, and is a
continuation of the deferred live test recorded in the #383 deliverable
(`docs/architecture/encore-audioencode-loudnorm-contract.md` §5). The concrete
measurement procedure to run once an instance exists:

1. Provision an Encore instance and point its profiles index at this API's
   `GET /index.yml` (`src/routes/profiles.ts:128-150`).
2. Create the `loudnorm` (single-pass) profile; on representative material with a
   *wide* loudness range, submit a job and measure the output integrated loudness
   with `ffmpeg -i <output> -af loudnorm=print_format=json -f null -`. Record the
   drift from the requested `I` target and note any audible pumping.
3. Create the `loudnorm-measure` / `loudnorm-apply` profiles, run the two-pass
   flow on the same material, and record (a) the measured drift (expected within
   ffmpeg tolerance) and (b) the wall-clock/compute delta of the second pass vs
   the single pass.
4. If single-pass drift on the target material is unacceptable, promote Option B
   per the surface above and supersede/addend this ADR with the measured numbers.

## Consequences

- #385 ships loudness normalisation as a **profile-only** change (a `loudnorm`
  `AudioEncode.filters` element, target optionally via `profileParams`), with **no
  job/API/callback change** — consistent with its profile-only charter.
- The API documents that the shipped loudness mode is **approximate single-pass**
  (~±1 LUFS, possible pumping on wide-LRA material), not guaranteed-tight EBU
  R128. Consumers needing tight compliance are pointed at the Option B surface.
- Promoting Option B later is a **bounded, pre-designed** change (two profiles + a
  `measure` step + a measurement-parsing branch in
  `encore-callback-poller.handleMessage`), not a re-decision.
- One OSC open question must be answered before Option B can be built (below).

## OSC feedback / open question

Option B depends on **where the `loudnorm print_format=json` measured values
surface** from a completed measure job. The poller reads the finished Encore job
document as `{ externalId, status, message, output }`
(`src/pipeline/encore-callback-poller.ts:264-289`); it is **not verified** that
ffmpeg's `loudnorm` JSON (written to stderr by ffmpeg) is captured onto that
document in a machine-readable field, versus only appearing in worker logs. This
must be verified against a live Encore instance before Option B is committed to.
Logged to `docs/osc-feedback/incoming-loudnorm-measure-surface.md`.

## Contract sources

In-repo (`Eyevinn/open-videocore`, branch `issue-384/loudnorm-pass-mode-adr`,
stacked on `issue-383/verify-audioencode-loudnorm`):

- `src/pipeline/encore-client.ts:33-39,81-98` — `profileParams` shape
  (`Map<String, Any?>`, forwarded verbatim), and `toEncorePayload` selecting the
  profile by name with **no `outputs` field**.
- `src/pipeline/encore-callback-poller.ts:8-9,70-75,227-289,386-434` — the
  `{ jobId, url }` completion envelope, the finished-Encore-job document shape
  `{ externalId, status, message, output }`, and the step-advancement hand-off
  that a measure→apply flow would hook.
- `src/routes/profiles.ts:128-150,219-235` — `GET /index.yml` (name → `name/yaml`)
  and `GET /:name/yaml` raw-YAML serving; the served-profile delivery path.
- `src/routes/jobs.ts:34`, `src/pipeline/transcode.ts:43-49,100` — the per-job
  `profile` selection and the `profileParams` threading a measure/apply flow
  reuses.

Referenced deliverable:

- `docs/architecture/encore-audioencode-loudnorm-contract.md` (#383) — the
  verified `AudioEncode.filters: List<String>` contract, the comma-join into the
  ffmpeg filter chain, and the deferred-live-test note this ADR's empirical
  validation continues.
