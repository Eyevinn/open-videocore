# OSC friction — no per-job output base on the packager (issue #206 / #190)

**Date:** 2026-07-13
**Surface:** data-pipeline / architecture
**Service:** `eyevinn-encore-packager`
**Related:** ADR-011, request #190, spike #206

## What we needed

A per-execution packaged-output destination override: for a single packaging
job, direct the CMAF (HLS/DASH) output to a caller-chosen destination bucket
while every other job continues to use the instance default. Request #190
assumed this could be "passed through to the packager job payload."

## Friction

Verified via OSC MCP `get-service-schema` for `eyevinn-encore-packager`
(retrieved 2026-07-13): the packager exposes **no per-job output-base field**.

- `OutputFolder` (REQUIRED) is the only output-base control, and it is set at
  PROVISION time — instance-scoped, not per-job.
- `OutputSubfolderTemplate` (default `$INPUTNAME$/$JOBID$`) only varies a
  subfolder *inside* `OutputFolder`. Its one per-job-controllable token,
  `$EXTERNALID$` (from the Encore job's `externalId`), can change the subfolder
  but never the base bucket.
- The S3 credentials/endpoint (`AwsAccessKeyId`, `AwsSecretAccessKey`,
  `AwsRegion`, `AwsSessionToken`, `S3EndpointUrl`) are also instance-scoped, so
  even the destination's auth is fixed per instance.
- The consumed queue envelope is a Redis/Valkey sorted-set entry
  `{ jobId, url }` (verified in this repo: `src/pipeline/packaging.ts` lines
  83-86, `src/pipeline/osc-packager-queue.ts` lines 9-16). There is no slot in
  the message for an output path.

Because of this, the "OSC-native" approach in the spike (packager reads a
per-job output base) is **blocked**. We instead adopted a post-package
relocation workaround (ADR-011), which copies the CMAF output from a private
staging bucket to the requested destination after completion.

## Ask for OSC

Add an **optional per-job output base** to `eyevinn-encore-packager`, honoured
from the consumed queue message (and/or an equivalent per-job field), for
example:

- an optional `outputFolder` (or `destination`) field on the queue envelope
  that, when present, overrides the instance `OutputFolder` for that job only;
  falling back to the instance `OutputFolder` when absent, and
- optionally per-job S3 credentials/endpoint so a destination in a different
  account/endpoint than the instance default is reachable.

## Why it would help

- Removes the double-write/relocation cost: the packager would write straight to
  the final destination instead of us copying every CMAF object out of a staging
  bucket afterwards (MinIO IO + transient double storage per execution).
- Removes the alternative of running one packager instance per destination
  bucket (persistent cost + an instance-pool subsystem to operate).
- Lets a private staging bucket stay unnecessary for the common case, while
  still supporting per-tenant / per-delivery destination routing from a single
  packager instance.

When available, ADR-011 commits to migrating from relocation to this native
per-job output path and retiring the copy step.
