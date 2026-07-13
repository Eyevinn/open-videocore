# OSC friction: packager failure callback omits the jobId

- **Service:** eyevinn-encore-packager (callbackListener)
- **Surfaced by:** issue #209 (validate per-execution destination against configured storage credentials)
- **Date:** 2026-07-13

## What happened

The packager POSTs completion callbacks to
`{CallbackUrl}/packagerCallback/success` and `{CallbackUrl}/packagerCallback/failure`.

- The **success** body echoes `{ url, jobId, outputPath? }`, so open-videocore can
  correlate the callback to the exact asset/execution it enqueued (`jobId` = the
  `packagingId`/`assetId` we submitted).
- The **failure** body is `{ message }` ONLY. It does **not** echo `jobId`
  (verified against `callbackListener.ts`).

## Impact

Because the failure path carries no correlation id, open-videocore cannot map a
packager failure back to the specific job it enqueued using any
packager-supplied value. This matters for issue #209: when a per-execution
destination override cannot be pre-validated (e.g. an external `s3://` endpoint
the API holds no credentials for and cannot probe with `bucketExists`), the only
signal that the destination was unusable is this failure callback — and it can't
say which job failed.

## Workaround implemented

We correlate by **open-videocore-side execution state** instead of a
packager-supplied id: on `packagerCallback/failure` we find every pipeline
execution currently blocked on a `running` `package` step (those are the ones
awaiting a packager callback), mark that step + execution `failed`, and record
the packager's `message` as an attributable error on the execution record. This
is best-effort and can over-attribute when multiple package steps are in flight
concurrently, but it beats an opaque log-only failure.

## Suggested upstream fix

Echo the enqueued `jobId` (and ideally `outputPath`) on the failure callback
body exactly as the success callback does, so consumers can attribute a failure
to a single job deterministically.
