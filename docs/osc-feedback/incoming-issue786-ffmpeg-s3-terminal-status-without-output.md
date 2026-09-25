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
2. **The whole `job.status` vocabulary is undocumented — not just the terminal
   values.** `waitForJobToComplete` in the SDK polls for `'Complete'`, which this
   service never sets; the observed terminal value is `'SuccessCriteriaMet'`
   (already logged for issue #6). `getJob` is typed `Promise<any>`
   (`@osaas/client-core/lib/job.d.ts:51`), so neither the terminal nor the
   in-progress values are discoverable from the contract. We had to establish
   them by polling a live job every 2s (2026-09-24): a job reports
   `status: "Running"` for its entire execution and flips straight to
   `"SuccessCriteriaMet"` on exit — there is no intermediate or empty value in
   between. That single observation is the ENTIRE evidence base for our
   in-progress set, and it cost us a review round: because a caller cannot tell
   "a status I do not recognise" apart from "still working", any fail-fast on an
   unrecognised status risks failing a healthy job that happens to report a
   queueing value we have never seen (`Pending`, `ContainerCreating`, …) during a
   cold start. We ended up (a) padding the in-progress set with a guessed
   scheduling vocabulary, (b) stretching the tolerance window to 120s to clear a
   plausible image pull, and (c) restricting the fail-fast to the two pipelines
   that hold an HTTP request open, leaving the per-ingest pipelines to poll to
   the 5-minute timeout — three guesses standing in for one published list
   (`osc-job-poll.ts`). A published enumeration, or a boolean `done`/`succeeded`
   field, would remove all three.
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
- A documented, closed set of `status` values — in-progress *and* terminal —
  with an explicit distinction between "job ran" and "job produced its declared
  output". Today `'Running'` and `'SuccessCriteriaMet'` are only known to us by
  observation. The **in-progress** list matters as much as the terminal one:
  client code that wants to fail fast on an unexpected status has to know which
  values mean "still working", including every queueing/cold-start value the
  scheduler can emit before the container runs. We are currently guessing that
  list. If a full enumeration is not on the cards, a single boolean (`terminal`
  or `done`) on the job document would be enough — a caller could then poll on
  the boolean and treat `status` as display text.
- Service documentation stating that ffmpeg output must be `s3://…` with the
  credential fields in the job body, and rejecting a job whose output target is
  an `http(s)://` URL rather than accepting it and writing nothing.
