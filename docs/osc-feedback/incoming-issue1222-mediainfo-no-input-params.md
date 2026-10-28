# OSC Friction: the transcoder's first analyze step (`mediainfo`) accepts no input params, so a source dropout during analysis cannot be made recoverable

**Mirror.** The authoritative copy of this log lives with the rest of the OSC
friction logs in the agents repo, at
`docs/osc-feedback/incoming-issue1222-mediainfo-no-input-params.md`. This copy
is here so the code that cites it (`src/pipeline/encore-input-params.ts`) can
point at a path inside its own repo.

**Date:** 2026-10-15
**Severity:** Low–Medium (the encode itself now recovers from a source dropout;
the analyze step that runs before it still cannot, so the same dropout a few
seconds earlier fails the job outright)
**Service:** encore (Encore transcoding service on OSC)
**Affected features:** transcode submission (`POST /api/v1/transcode`), input
recovery params (#1222), source-read failure classification (#1219 family)

## Context: what we are trying to do

Every transcode this API submits reads its source over the network. Issue #1222
made those reads survive a dropout by setting ffmpeg input params on each job
input — `reconnect`, `reconnect_on_network_error`, `reconnect_delay_max`,
`rw_timeout` (see `src/pipeline/encore-input-params.ts` in
`eng-open-videocore`). The job document's `Input.params` map is the service's own
supported channel for this.

Contract source (read at the build the scaler spawns:
github.com/Eyevinn/encore tag `v0.2.8-3`, commit
`aa45875c53ef5e3c296299191bc2cc996d3dc5b3`, fetched 2026-10-15):

- `Input.params: LinkedHashMap<String, String?>` —
  `encore-common/src/main/kotlin/se/svt/oss/encore/model/input/Input.kt:41`.
- `fun List<Input>.inputParams(readDuration: Double?)` — `Input.kt:253-259` —
  renders each entry before `-i <accessUri>`, i.e. as ffmpeg **input** options,
  which is where these four have to be to take effect.

That works for the encode. It does not reach the analysis that happens first.

## The limitation

A job's inputs are analyzed before the encode, and that analysis runs **two
separate probes**, only one of which can be influenced by `Input.params`.

1. `MediaAnalyzerService.analyzeInput(input)` —
   `encore-common/src/main/kotlin/se/svt/oss/encore/service/mediaanalyzer/MediaAnalyzerService.kt:60-70`
   (tag `v0.2.8-3`) — filters our map down to ffprobe-valid keys and passes it
   under exactly one named argument:

   ```kotlin
   val ffprobeInputParams = LinkedHashMap(input.params.filterKeys { ffprobeValidParams.contains(it) })

   input.analyzed = mediaAnalyzer.analyze(
       file = input.accessUri,
       probeInterlaced = probeInterlaced,
       ffprobeInputParams = ffprobeInputParams,
   )
   ```

   The parameter name is the whole story: the only params channel out of
   `analyzeInput` is an **ffprobe** one.

2. `MediaAnalyzer.analyze(...)` in the bundled analyzer library
   (`se.svt.oss:media-analyzer:2.0.7`, pinned at
   `encore-common/build.gradle.kts:8`; source read at
   github.com/svt/media-analyzer tag `release-2.0.7`,
   `src/main/kotlin/se/svt/oss/mediaanalyzer/MediaAnalyzer.kt:33-68`) runs
   `mediainfo` **first**, before ffprobe, and passes it no params:

   ```kotlin
   val mediaInfo = try {
       mediaInfoAnalyzer.analyze(file, disableImageSequenceDetection)
   } catch (e: Exception) {
       log.warn(e) { "Error running mediainfo on $file!" }
       null
   }
   ...
   val probeResult = ffprobeAnalyzer.analyze(file, ffprobeInputParams)
   ```

   `ffprobeInputParams` is threaded to `ffprobeAnalyzer.analyze` only. The
   `mediaInfoAnalyzer.analyze` signature takes `(file: String,
   disableImageSequenceDetection: Boolean)` — there is no params argument to
   pass anything to.

3. `MediaInfoAnalyzer.analyze` (same tag,
   `src/main/kotlin/se/svt/oss/mediaanalyzer/mediainfo/MediaInfoAnalyzer.kt:13-30`)
   builds a fixed command line:

   ```kotlin
   add("mediainfo")
   add("--Output=JSON")
   if (disableImageSequenceDetection) { add("--File_TestContinuousFileNames=0") }
   add(file)
   ```

   So `mediainfo` opens the resolved `https://` access URI with its own HTTP
   client and its own (absent) retry and read-deadline behaviour. There is no
   injection point for an input option at any layer we can reach, and no
   equivalent of `rw_timeout`/`reconnect` on that command line.

Net effect: for the window in which the first analyze step is reading the
source, a dropout behaves exactly as it did before #1222 — our params are not in
that code path and cannot be put there from the job document. The `catch` above
means a mediainfo *error* is tolerated and analysis falls through to ffprobe
(which does get our params); a mediainfo read that *hangs* is the harmful case,
because nothing on that command line bounds it.

## Why we cannot work around it

- It is service-side and pre-encode: by the time our params are rendered
  (`Input.inputParams`, `Input.kt:253-259`) the analyze step has already run.
- There is no job-level or instance-level setting in the job contract that
  changes the mediainfo invocation — the command line is constructed in library
  code with no configuration input.
- Skipping the step is not ours to skip either: `analyzeInput` is called for
  every input on the service's own path.

So the honest scope of #1222 is "the encode's source reads recover"; the
analysis window in front of it is still a single unprotected read, and we
documented it as such in the module rather than implying full coverage.

## What we would like from the service

Any of these would close the gap, cheapest first:

1. **Thread the same filtered map to the mediainfo step**, or add a
   `mediaInfoInputParams` argument, so an operator-set read deadline applies to
   the whole analyze phase and not just ffprobe.
2. **A bounded mediainfo invocation** — a wall-clock timeout on the
   `mediainfo` child process (it is currently started and waited on with no
   deadline), so a hung source read fails the step instead of pinning the job.
   The existing `catch` already makes a *failed* mediainfo non-fatal, so a
   timeout would degrade gracefully to the ffprobe path on its own.
3. **A documented statement of which input params apply to which phase** —
   encode only, ffprobe only, or all three — in the `Input.params` schema
   description (`Input.kt:41`, currently just "Input params required to properly
   decode input", example `{ "ac": "2" }`). Today the only way to know that
   `rw_timeout` does not protect the mediainfo read is to read two repositories
   of library source.

## References

- Issue #1222 (set reconnect and rw_timeout params so source dropouts
  recover); PR #1230 and its review finding that this limitation was cited as
  logged friction before the log existed — this file is that log.
- `src/pipeline/encore-input-params.ts` (in `eng-open-videocore`) — the params
  we set and the note pointing here.
- github.com/Eyevinn/encore `v0.2.8-3`:
  `encore-common/.../model/input/Input.kt:41,253-259`,
  `encore-common/.../service/mediaanalyzer/MediaAnalyzerService.kt:60-70`,
  `encore-common/build.gradle.kts:8`.
- github.com/svt/media-analyzer `release-2.0.7`:
  `src/main/kotlin/se/svt/oss/mediaanalyzer/MediaAnalyzer.kt:33-68`,
  `src/main/kotlin/se/svt/oss/mediaanalyzer/mediainfo/MediaInfoAnalyzer.kt:13-30`.
- Related, already logged:
  `incoming-issue1219-encore-cancel-not-honoured-by-frozen-job.md` — the other
  half of the frozen-source story (a job stuck in an unbounded read cannot be
  cancelled either).
