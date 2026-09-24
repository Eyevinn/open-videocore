# OSC friction: ffmpeg-s3 job reaches a success status even when ffmpeg wrote no output

- Date: 2026-09-24
- Context: issue #786 (clip returns 201 with a `ready` child asset but no object)
- Services: `eyevinn-ffmpeg-s3`

## What happened

`POST /api/v1/assets/:id/clip` returned 201 with a child asset marked `ready`
whose object answered `NoSuchKey`. The clip job had been given a presigned HTTPS
PUT URL as ffmpeg's output target. ffmpeg's `http` protocol is read-only for
output unless driven with `-method PUT`, and an MP4 muxed to a non-seekable
target cannot rewrite its `moov` atom, so nothing was ever written — yet the job
still reached a terminal status our poller did not classify as a failure, and the
API reported success.

## OSC gaps

1. **No structured job result.** `eyevinn-ffmpeg-s3` exposes no per-job result
   object (exit code, output URIs, bytes written). The only completion signal is
   the instance `status` string, which reflects the *container/job lifecycle*,
   not the ffmpeg process outcome. A job whose ffmpeg failed to write anything
   can still land on `SuccessCriteriaMet`. Every caller therefore has to verify
   the output object out-of-band (we now HEAD the written key — see
   `src/pipeline/clip.ts:clip` and `src/pipeline/rewrap.ts:rewrap`).
2. **Terminal status vocabulary is undocumented.** `waitForJobToComplete` in the
   SDK polls for `'Complete'`, which this service never sets; the observed
   terminal value is `'SuccessCriteriaMet'` (already logged for issue #6). There
   is no published enumeration of the terminal values, so callers cannot write a
   closed-world success check with confidence. We now treat *anything* outside
   `{'SuccessCriteriaMet', 'Complete'}` as a failure, which is the safe default
   but will misreport if the service introduces a new success value.
3. **Logs disappear with the instance.** `getLogsForInstance` is the only place
   ffmpeg's stderr is visible, and it is only reachable while the ephemeral
   instance exists. Removing the spent job (which we must do, or instances
   accumulate) destroys the sole diagnostic. We now fetch logs *before*
   `removeJob` whenever the outcome is not a known-good status.
4. **Output protocol constraints are implicit.** That ffmpeg output must be an
   `s3://bucket/key` URI plus `awsAccessKeyId` / `awsSecretAccessKey` /
   `s3EndpointUrl` in the job body — and that a presigned PUT URL silently
   produces nothing — is not stated anywhere in the service description. This is
   now the third time we have hit it (thumbnails #92, export/re-wrap #316, clip
   #786).

## What would help

- A per-job result document: ffmpeg exit code, stderr tail, and the list of
  output URIs actually written, retained after the instance is reaped.
- A documented, closed set of terminal `status` values, with an explicit
  distinction between "job ran" and "job produced its declared output".
- Service documentation stating that ffmpeg output must be `s3://…` with the
  credential fields in the job body, and rejecting a job whose output target is
  an `http(s)://` URL rather than accepting it and writing nothing.
