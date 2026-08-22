# OSC friction — where does loudnorm print_format=json surface on a completed Encore job? (issue #384)

**Date:** 2026-08-22
**Surface:** backend-api / architecture
**Service:** `encore` (SVT Encore)
**Related:** ADR-012, decision #384, contract spike #383

## What we needed

To evaluate a two-pass (measure-then-apply) loudness-normalisation flow (ADR-012,
Option B), a `measure` Encore job would run
`loudnorm=I=…:TP=…:LRA=…:print_format=json` and emit the measured integrated
loudness, true peak, LRA and threshold. Our completion path must then read those
four measured values off the finished job and thread them as `profileParams`
(`measured_I`, `measured_TP`, `measured_LRA`, `measured_thresh`) into a second
`apply` Encore job.

## Friction

It is **not verified** where ffmpeg's `loudnorm` JSON surfaces on a completed
Encore job. ffmpeg writes the `print_format=json` block to **stderr**, but our
completion path only reads the Encore job document, typed as
`{ externalId, status, message, output }`
(`src/pipeline/encore-callback-poller.ts:264-289`). It is unknown whether Encore
captures the ffmpeg stderr JSON onto that document in a machine-readable field, or
whether it only lands in worker logs (which the poller does not read).

No live Encore instance is provisioned for this workspace (0 instances — verified
in #383), so this could not be confirmed empirically.

## What would unblock us

Confirmation (against a live Encore instance, or upstream docs/source) of a
machine-readable field on the completed `EncoreJob` document that carries the
per-output ffmpeg `loudnorm print_format=json` measurement — or a documented way
to retrieve it per output without scraping free-text logs. Without it, Option B's
measure→apply hand-off has no reliable value source and stays deferred.

## Current mitigation

ADR-012 ships single-pass dynamic `loudnorm` as the default (profile-only, no
measurement needed) and records two-pass as a documented future option pending
this answer plus the deferred live test from #383.
