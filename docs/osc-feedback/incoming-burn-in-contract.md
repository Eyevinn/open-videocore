# OSC friction — Encore burn-in `subtitles=` filter + S3 file-path resolution unverified (issues #387/#388)

**Date:** 2026-08-22
**Surface:** backend-api
**Service:** eyevinn-encore (OSC transcode service)

## What we needed

Issue #388 burns a sidecar caption (srt/vtt) into a transcode rendition by
injecting an FFmpeg `subtitles=<key>[:force_style='...']` filter into the
selected server-side profile's `VideoEncode.filters` list, threaded via the
`profileParams['subtitlesFilter']` SpEL lever (ADR-014 D3). The `filters` field
itself is confirmed present on `VideoEncode`/`X264Encode`
(eyevinn.github.io/encore-doc, Table 3 — "for adding extra FFmpeg Filters").

## Friction

Two things are NOT pinned by any reachable contract, and could not be verified
in this environment (0 Encore instances provisioned; no ffmpeg binary):

1. **The exact burn-in filter string + its `<file>`-path resolution against
   Encore's S3-backed execution environment.** The encore-doc has NO mention of
   `subtitles=`, `force_style`, `burn`, `.srt`, or `.vtt` (all confirmed absent).
   The `subtitles=<file>` filter is the generic libavfilter filter, but how its
   `<file>` argument resolves for an S3-backed input inside Encore (staged local
   path? presigned URL? relative to a working dir?) is undocumented. ADR-014 C1 /
   open-dependency 1 flags this for a live smoke test before landing burn-in in
   production.

2. **Whether the server-side profile can be re-authored with a
   `#{profileParams['subtitlesFilter']?:''}` placeholder** (ADR-014 D3
   sub-option 1, the chosen mechanism) or whether the `toEncorePayload`
   payload-augmentation fallback (sub-option 2) is required. This is a
   provisioning/profile-catalogue decision for surface-infra.

## What we shipped despite the friction

- The request shape, source resolution (sidecarKey verbatim / subtitleTrack →
  objectKey), the srt/vtt format gate (ttml rejected at request time), and the
  filter-string construction + threading into `profileParams['subtitlesFilter']`
  are all implemented and covered by deterministic unit tests
  (`src/pipeline/burn-in.test.ts`, `src/pipeline/transcode.test.ts`).
- The ADR acceptance line "verified by inspecting a DECODED FRAME" is **DEFERRED
  honestly**: a gated/skipped harness
  (`test/burn-in-decoded-frame.e2e.test.ts`) documents exactly what to run once a
  live Encore + ffmpeg are available (gated on `BURN_IN_E2E_ENCORE_URL` +
  `BURN_IN_E2E_FFMPEG`). No visual result was fabricated.

## Ask

When an Encore instance is provisioned, smoke-test the `subtitles=` filter and
record: (a) the exact filter string that burns a caption, (b) how the `<file>`
argument must reference the workspace-local S3 key, and (c) whether the profile
placeholder or the payload-augmentation path is used. Then un-skip the
decoded-frame harness.
