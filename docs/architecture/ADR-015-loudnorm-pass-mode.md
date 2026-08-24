# ADR-015: Loudness-normalisation pass mode (single-pass dynamic vs dual-pass linear) and its cost delta

**Status:** PROPOSED 2026-08-24
**Date:** 2026-08-24
**Author agent:** claude-opus-4-8 (surface-backend-api)
**Issue:** #384 (decision spike; broken down from #375)
**Depends on:** #383 (verified `AudioEncode` `filters`/`params` contract —
`docs/architecture/encore-audioencode-loudnorm-contract.md`, merged on main)
**Consumed by:** the loudness-profile feature issue (needs to know which mode the
served profile expresses before it can pin the profile field).

---

## Context

The parent issue explicitly flags loudness-normalisation pass mode as a decision
to make, not to assume. ffmpeg `loudnorm` supports two normalisation modes:

- **Single pass (dynamic)** — the filter measures and corrects loudness in one
  streaming pass. It is approximate: because it cannot see the whole programme
  before it starts adjusting, the correction is dynamic (range-compressing) and
  the integrated result drifts from the requested target.
- **Dual pass (linear)** — a first *measure* pass computes the input's true
  loudness statistics; those measured values are fed into a second *apply* pass
  that linearly scales the audio to hit the target. This is the accurate EBU R128
  flow but requires two runs over the audio.

Single pass is a **profile-only** change (a static `filters[]` element, per
#383). Dual pass is **orchestration work**: a measure step must produce per-input
statistics that a second encode consumes, which crosses into the job/pipeline and
callback model. This ADR records which mode the served profile expresses and what
it costs, and — because it recommends single pass as the default while keeping
dual pass reachable — describes the dual-pass orchestration surface concretely
enough for the downstream profile issue to consume.

## Verified contract sources (CLAUDE.md rule 7)

Every symbol below was read against its authoritative source before citing. No
signature, option name, or field is guessed.

### 1. The `loudnorm` filter option contract (authoritative: ffmpeg source)

Source: FFmpeg `doc/filters.texi`, `@section loudnorm` (fetched from
`https://raw.githubusercontent.com/FFmpeg/FFmpeg/master/doc/filters.texi`,
`filters.texi:5855` onward). Verbatim from that section:

> "EBU R128 loudness normalization. Includes both dynamic and linear
> normalization modes. Support for both single pass (livestreams, files) and
> double pass (files) modes."

Exact option symbols verified from the same `@table @option` block:

| Option | Role | Notes (verbatim from `filters.texi`) |
|--------|------|--------------------------------------|
| `I, i` | integrated loudness **target** | "Range is -70.0 - -5.0. Default value is -24.0." |
| `LRA, lra` | loudness-range target | "Default value is 7.0." |
| `TP, tp` | max true-peak target | "Default value is -2.0." |
| `measured_I, measured_i` | **measured** IL of input | "Range is -99.0 - +0.0." — a *measured* value, only known after pass 1 |
| `measured_LRA, measured_lra` | measured LRA of input | measured value from pass 1 |
| `measured_TP, measured_tp` | measured true peak of input | measured value from pass 1 |
| `measured_thresh` | measured threshold of input | measured value from pass 1 |
| `linear` | linear (dual-pass) scaling | "`measured_I`, `measured_LRA`, `measured_TP`, and `measured_thresh` **must all be specified**. … If any of these conditions aren't met, normalization mode will revert to `dynamic`." |
| `print_format` | stats print format | "Options are summary, json, or none. Default value is none." — set `json` for machine-readable pass-1 stats |
| `stats_file` | write stats to file | "Format is controlled by `print_format` … Specify `-` to write to standard output." |

**The load-bearing fact:** `linear` (dual-pass) is only honoured when all four
`measured_*` values are supplied; otherwise ffmpeg *silently* falls back to
dynamic single-pass. Those four values are **per-input runtime data** — they are
different for every source and are unknown until pass 1 runs.

### 2. How a `loudnorm` filter reaches Encore/ffmpeg (authoritative: #383 spike)

Source: `docs/architecture/encore-audioencode-loudnorm-contract.md` (merged on
main) and the upstream symbols it verified:

- The filter lives in a served-profile `AudioEncode.filters: List<String>`
  (`svt/encore` `AudioEncode.kt`, file commit
  `4e01ab9c34d8cbee4cc0c58e76d103dc3f12f23a`); each string is inserted verbatim
  into the ffmpeg audio filter chain via
  `(dialogueEnhanceFilters + mixFilters + filters).joinToString(",")`.
- A profile is **static YAML selected by name** — the OSC job body carries no
  filter shape (`src/pipeline/encore-client.ts:81-97`, `toEncorePayload`; there
  is no top-level `outputs` field, only `profile: input.profile`).
- The one dynamic per-job channel into a profile is `profileParams`, evaluated by
  Encore as SpEL expression properties: `EncoreJob.profileParams: Map<String,
  Any?>` default `{}` (`svt/encore` `EncoreJob.kt`, cited at
  `encore-client.ts:33-38` and `encore-client.ts:87-92`).

### 3. Encore's job model is single-pass per job (authoritative: in-repo client)

An Encore job runs one profile against one input and reports completion once
(`src/pipeline/encore-client.ts:48-59`, the `EncoreClient` interface:
`submit` / `getJobStatus` / `cancel`). There is no "measure then re-encode within
one job" primitive. A dual-pass flow is therefore **two Encore jobs** unless the
measured values can be injected into a single apply-job's profile.

### 4. Existing multi-step orchestration surface (authoritative: in-repo)

Source: `src/pipeline/pipelines.ts` and `src/data/pipeline-repo.ts`.

- `PIPELINE_STEPS` (`pipelines.ts:22`) is an ordered const tuple:
  `['extract-metadata', 'thumbnail', 'subtitles', 'scene-detect', 'transcode',
  'package']`. `PipelineStepName` (`pipelines.ts:23`) is its element type.
- A `PipelineExecution` (`pipeline-repo.ts:30-58`) carries an ordered
  `steps: StepExecution[]`; each `StepExecution` (`pipeline-repo.ts:19-28`) has
  `name`, `status`, `jobId`, `encoreJobId`, `startedAt`, `completedAt`. Steps
  advance as OSC callbacks arrive (repo header, `pipeline-repo.ts:1-10`).
- Executions are **in-memory / ephemeral** by design (`pipeline-repo.ts:8-10`).

So the platform already models a job feeding a later job through ordered steps —
this is the surface a dual-pass measure→apply flow would extend.

## Analysis: is dual-pass expressible inside one served profile?

**No.** A served profile is static YAML resolved by name (§2), so it cannot carry
the four per-input `measured_*` values that `linear` requires (§1). If a static
profile ships `loudnorm=...:linear=true` *without* the `measured_*` values, ffmpeg
silently reverts to dynamic single-pass (§1, verbatim) — i.e. it is single-pass
wearing a dual-pass label, which is worse than an honest single-pass profile.

There are exactly two ways to reach true dual-pass under the verified contracts:

- **(A) Two Encore jobs (measure job → apply job).** A first job runs a
  measure-only profile (`loudnorm=...:print_format=json`, no re-encode intent
  beyond producing stats) whose ffmpeg stats output is parsed; its four
  `measured_*` values are then supplied to a second apply job. The apply job's
  profile must consume those values dynamically — which forces path (B) for the
  second leg anyway.
- **(B) One apply job with measured values injected via `profileParams`.** The
  served apply profile is parametrised so the `loudnorm` filter string reads the
  four `measured_*` values from SpEL `profileParams` (the only per-job dynamic
  channel, §2). The caller (or a preceding measure step) supplies the measured
  values in the job body's `profileParams` map. This still needs a measure step
  upstream to produce those numbers, so in practice dual-pass = measure step
  (A-style) **plus** parametrised apply profile (B-style).

Either way, dual-pass is **not** a profile-only change: it requires a new
measure step that produces stats and plumbs them into the apply job. Single-pass
is a profile-only change and needs none of that.

## Accuracy vs cost trade-off (documented, methodology-transparent)

Live measurement on representative material is **BLOCKED in this environment**:
`list-service-instances` for serviceId `encore` reports 0 provisioned instances
(same blocker recorded in the #383 spike, §5, and the friction log referenced
below), and no ffmpeg binary is available in this workspace (`which ffmpeg` →
absent) to run the standard offline comparison. No numbers have been fabricated.
What is documented instead is (a) the *direction and mechanism* of the trade-off
that follows directly from the verified filter contract, and (b) the **exact
runnable procedure** to obtain the measured numbers once an Encore instance or an
ffmpeg host exists, so the acceptance line ("document which mode and what it
costs") is satisfied with a reproducible method rather than invented figures.

### Accuracy (mechanism, from §1)

- **Single-pass dynamic** cannot see the whole programme before it begins
  correcting, so its *integrated* result drifts from the `I` target and it
  applies dynamic range adjustment. ffmpeg's own docs scope single pass at
  "livestreams, files" and reserve "double pass" for files (`filters.texi:5857`),
  i.e. single pass is the streaming-grade approximation. Typical published drift
  for dynamic mode is on the order of ~1 LU from target on varied material; this
  is exactly what the offline procedure below quantifies for *our* representative
  material rather than assuming.
- **Dual-pass linear** hits the `I` target within EBU R128 tolerance because it
  scales linearly using true measured stats, provided the `linear` guard
  conditions hold (target LRA ≥ source LRA and the scaled peak ≤ target TP,
  `filters.texi` `linear` note); otherwise ffmpeg reverts to dynamic anyway.

### Cost (mechanism, from §3/§4)

- **Single-pass:** one Encore job. No extra latency, no extra orchestration, no
  extra billed transcode.
- **Dual-pass:** approximately **2× the audio-processing work** (a measure pass
  plus an apply pass) plus the added wall-clock of a second job dispatch +
  callback round-trip (the measure job must fully settle before the apply job's
  `profileParams` can be populated — jobs settle via the callback poller, §3).
  The measure pass is audio-decode-only (no video re-encode) so its *compute*
  cost is a fraction of a full transcode, but its *latency* cost is a whole extra
  job lifecycle (queue → run → callback), which on a shared Encore queue can
  dominate. It also doubles the per-job orchestration state to track.

### Exact procedure to obtain the measured numbers (run once a host exists)

1. On representative source(s) with an audio stream, run the measure pass and
   capture stats:
   `ffmpeg -i <src> -af loudnorm=I=-23:TP=-1:LRA=7:print_format=json -f null -`
   Record the reported `input_i`, `input_tp`, `input_lra`, `input_thresh`.
2. **Single-pass output + verify:**
   `ffmpeg -i <src> -af loudnorm=I=-23:TP=-1:LRA=7 <out_single>` then re-measure
   `ffmpeg -i <out_single> -af loudnorm=print_format=json -f null -` and record
   the delta `|measured_I − (−23)|` (the single-pass drift in LU) and the
   wall-clock.
3. **Dual-pass output + verify:**
   `ffmpeg -i <src> -af loudnorm=I=-23:TP=-1:LRA=7:linear=true:measured_I=<input_i>:measured_TP=<input_tp>:measured_LRA=<input_lra>:measured_thresh=<input_thresh> <out_dual>`
   then re-measure as in step 2. Record the (expected near-zero) drift and the
   combined wall-clock of pass 1 + pass 2.
4. Report: single-pass drift (LU), dual-pass drift (LU), and the latency ratio
   dual/single. Fold the numbers back into this ADR's trade-off table.

## Decision

**Default to single-pass dynamic loudness normalisation. Ship it as a static
served profile.** Keep dual-pass linear as an explicitly opt-in future capability
whose orchestration surface is specified below (but not built by this ADR).

Rationale:

1. **Cost/benefit for a media-asset API.** Single-pass is a zero-orchestration,
   single-job, one-line profile change (§2). Dual-pass roughly doubles audio work
   and adds a full extra job lifecycle of latency (§3), for an accuracy gain
   (~sub-LU) that only matters for broadcast-grade delivery, not for the general
   VOD/asset-management use the profile serves.
2. **Honesty of the served artefact.** A static profile *cannot* carry the four
   `measured_*` values (§1/§2); shipping `linear=true` in a static profile would
   silently degrade to dynamic (§1, verbatim). Single-pass is the only mode a
   static profile can express *truthfully*.
3. **Reversibility.** Choosing single-pass now does not foreclose dual-pass: the
   apply-side of dual-pass reuses the same `profileParams` SpEL channel already
   verified for parametrised profiles (§2, #287), and the measure step slots into
   the existing ordered-step model (§4). The migration is additive.

### Served single-pass profile shape (the profile issue consumes this)

A single `AudioEncode.filters[]` element on an existing profile name (per #383):

```yaml
# in the profile's encodes[] list, on an entry with type: AudioEncode
filters:
  - loudnorm=I=-23:TP=-1:LRA=7
```

`I`/`TP`/`LRA` are the EBU R128 targets from §1 (shown at broadcast R128 values;
the exact target numbers are the profile issue's call). No `linear`, no
`measured_*`, no `print_format` — dynamic single-pass. **No API, job-payload, or
orchestration change is required** (the filter travels entirely inside served
YAML, §2).

## If dual-pass is later chosen: concrete orchestration surface

Specified now so the profile issue can scope against it; **not implemented here.**

1. **New pipeline step `measure-loudness`** added to `PIPELINE_STEPS`
   (`src/pipeline/pipelines.ts:22`) immediately before `transcode`. It is a
   measure-only Encore job whose served profile carries
   `loudnorm=I=…:TP=…:LRA=…:print_format=json` and produces the four `measured_*`
   stats. It records its `encoreJobId` on its `StepExecution`
   (`pipeline-repo.ts:19-28`) like any transcode step.
2. **Stats capture.** The measure job's ffmpeg `loudnorm` JSON stats (fields
   `input_i`, `input_tp`, `input_lra`, `input_thresh`) must be surfaced to our
   callback path. This is the one genuinely new plumbing need — ffmpeg writes the
   JSON to its log/`stats_file` (§1), and the served measure profile / callback
   must expose those four numbers to the pipeline. (Friction: Encore's callback
   surfaces job status, not arbitrary ffmpeg stats — logged below.)
3. **Apply job via `profileParams`.** The `transcode` step supplies the four
   captured values to the apply job through `EncoreSubmitInput.profileParams`
   (`encore-client.ts:39`), and the served apply profile references them as SpEL,
   e.g. a `filters[]` element built from
   `loudnorm=I=…:TP=…:LRA=…:linear=true:measured_I=${measuredI}:measured_TP=${measuredTp}:measured_LRA=${measuredLra}:measured_thresh=${measuredThresh}`.
   This reuses the verified `profileParams: Map<String, Any?>` channel (§2); no
   new Encore API is needed for the apply leg.
4. **Sequencing.** The apply `transcode` step must not dispatch until the
   `measure-loudness` step settles with all four stats (they gate the second
   job's params). This is the same "step N feeds step N+1" pattern the pipeline
   already models (§4), extended with a data hand-off (measured stats) rather
   than just a status hand-off.

## Consequences

- The profile issue can proceed **immediately** on the single-pass shape above —
  a profile-only change with zero orchestration risk.
- Dual-pass is scoped, contract-verified, and reversible-into, but deferred; if
  taken up it is its own issue implementing the four-part surface above.
- The `measured_*`/`linear` silent-fallback behaviour (§1) is a documented trap:
  no static profile may ever ship `linear=true` — only a `profileParams`-injected
  apply profile may, and only when the four measured values are guaranteed
  present.
- Live accuracy/latency numbers remain to be filled in via the runnable procedure
  above once an Encore instance or an ffmpeg host is available.
