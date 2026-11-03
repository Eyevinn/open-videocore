# OSC friction: an `eyevinn-ffmpeg-s3` invocation can carry exactly one `s3://` output

**Date:** 2026-11-03
**Severity:** Medium (costs job count and wall time; no correctness impact)
**Service:** `eyevinn-ffmpeg-s3`
**Affected features:** multi-size thumbnail extraction behind `THUMBNAIL_MULTI_SIZE`
(#1303); previously full-frame thumbnail extraction (#332), clip/export (#92)

## What we needed

Issue #1303 adds two scaled variants (medium, 1280px wide; small, 360px wide)
alongside each full-size thumbnail frame, so a list or grid view can fetch a few
KB instead of a source-resolution JPEG. The natural shape is one ffmpeg
invocation per timecode that writes three outputs — the full frame and its two
scales — from a single decode of the source.

That shape is not available. One invocation writes one object, so the three
outputs became three separate ephemeral jobs.

## The limitation, against the pinned contract

Verified in `docs/contracts/eyevinn-ffmpeg-s3-job-and-logs.json` (source
`Eyevinn/ffmpeg-s3` @ `95ede50d3486cc4b2145871af08a4138ba5e3b9d`, verified
2026-10-14), symbols:

1. **`rewriteCmdString output detection`** (`src/ffmpeg.ts:90-99`) — "The output
   is the LAST argument that does not start with `-`". Exactly one output is
   detected per command, and an output is mandatory.
2. **`uploadResult single-file S3 branch`** (`src/ffmpeg.ts:317`, `:336-364`) —
   for an `s3://` dest that does not end in `/`, the job `readdir`s the staging
   directory and uploads **only** the one file whose basename equals the dest
   basename. Anything else ffmpeg wrote is discarded with the instance.
3. **`aws s3 presign for s3:// inputs`** (`src/ffmpeg.ts:60-79`) — any *earlier*
   `s3://` argument in the command is treated as an **input** and converted to a
   presigned HTTPS GET URL before ffmpeg sees it. So a second `s3://` output
   cannot simply be appended: it is reinterpreted as an input, and the `image2`
   muxer cannot write to a presigned HTTP endpoint (#92).

The `uploadResult recursive S3 branch` (`src/ffmpeg.ts:318-335`) does upload the
whole staging directory, but only for a dest path ending in `/`, and it uploads
to `dirname()` of that path — one prefix level **above** the one given. It gives
no control over the individual object keys, which is exactly what a per-size key
scheme needs, so it is not a usable alternative here.

Job body fields are per the same contract, `job.createJob.bodyFields` (`name`,
`cmdLineArgs`, `awsAccessKeyId`, `awsSecretAccessKey`, `s3EndpointUrl`) — there
is no output-list or multi-destination field among them.

## Concrete cost

With the flag on, each timecode needs one job for the full frame plus one job per
scaled size. At the two sizes shipped in #1303 that is **3 jobs per timecode —
3N ephemeral jobs for N requested timecodes, instead of N**.

| | Jobs per extraction | Relative wall time |
|---|---|---|
| `THUMBNAIL_MULTI_SIZE` off | N | 1x |
| `THUMBNAIL_MULTI_SIZE` on | 3N | ~3x |

The jobs run sequentially and each one carries the full ephemeral-instance
lifecycle — create, poll to a terminal status, remove — so the wall time of an
extraction scales with the job count, not with the pixels actually encoded. The
encoding itself is trivial: the scaled variants are derived from the
already-written full frame (a ~100 KB JPEG), not by re-seeking the source. The
cost is almost entirely instance churn and polling, i.e. it is caused by the
one-output limit rather than by the work requested.

That multiplier is the reason multi-size extraction is **opt-in and off by
default** rather than always on.

## Where this is handled in our code

`src/pipeline/osc-thumbnail.ts` — `scaledThumbnailFrameCmdLine` builds the
single-input/single-output derive command, `runOneFfmpegJob` dispatches one
ephemeral job for it, and `deriveScaledFrames` loops the sizes one job at a
time. The code comment above `scaledThumbnailFrameCmdLine` carries the same
contract citation as this note.

## What would help

- A documented way to declare **multiple output objects in one invocation** with
  per-object keys — e.g. an `outputs: [{ cmdLineArgsSuffix, dest }]` body field,
  or honouring every `s3://` argument in output position rather than only the
  last one.
- Failing that, the recursive branch would be usable if the upload prefix were
  the dest prefix as given (not its `dirname`), so a job could write several
  named files into one known prefix in a single invocation.
- State the one-output-per-invocation rule in the service documentation. It is
  currently only discoverable by reading the implementation, and it has shaped
  three separate features in this codebase (#92, #332, #1303).
