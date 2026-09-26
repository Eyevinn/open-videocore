# OSC friction — packager input is an Encore job URL only, with no rendition-keyed form (issue #739)

**Date:** 2026-09-26
**Surface:** data-pipeline
**Service:** `eyevinn-encore-packager` (with `eyevinn-encore` / the scaler pool)
**Related:** issue #739 (package-only pipeline), #525 pt.2 (packaging pin),
`incoming-per-job-packager-output.md` (the OUTPUT-side counterpart of this gap)

## What we needed

A way to package an asset's **already-transcoded** renditions into HLS/DASH
without re-encoding — driven from the packaged output that already exists in the
bucket, not from the transcode run that produced it.

Two product needs depend on it:

1. **Recovery.** When a pipeline's `transcode` succeeds and its `package` fails,
   the transcode output is intact. The only route back to a packaged asset was
   to re-run the whole `abr-vod` pipeline and redo the encode (5-7 minutes of
   4K five-rung compute, measured ~0.36x real-time, to reproduce bytes that
   already exist).
2. **Cost.** A user who wants HLS/DASH for an asset transcoded last week has no
   cheap path to it at all.

## Friction

The packager's consumed work item carries **only** a job correlation id and an
Encore job API URL. Verified in this repo against the packager's own
`redisListener.ts` (contract recorded 2026-07-07):

- `src/pipeline/packaging.ts` — `export type PackagingJob = { jobId: string; url: string }`,
  documented as "jobId: our correlation id returned verbatim in the packager
  callback / url: the Encore job API URL the packager fetches output details from".
- `src/pipeline/osc-packager-queue.ts` — the queue envelope: Redis sorted set,
  producer `ZADD`, consumer `BZPOPMIN`, message shape `{ jobId, url }`.
- `src/pipeline/packaging.ts` — `PackagingTrigger.triggerPackaging(assetId, encoreJobUrl)`:
  the URL is the only input our side can vary per job.

There is **no form of that work item keyed by the output itself** — no
`renditions[].objectKey` list, no bucket + prefix, no manifest-input descriptor.
The packager's only way to find media is to `GET` the Encore job document and
read the output list off it.

That indirection is what bounds the feature, because an Encore job document is
only served while the Encore instance that ran it is alive. Under the autoscaler
(`minInstances: 0`, short `idleTimeoutMs`) that instance is torn down soon after
the transcode goes idle. So:

- packaging is only possible while the producing Encore instance happens to
  still be pooled;
- the dispatch-time URL key (`encore:job-url:*`, 24h TTL) preserves the *address*
  but not the *answer* — the URL stops resolving when the instance goes;
- we are forced to keep the instance alive artificially. The packaging pin
  (`src/encore-scaler/packaging-pin.ts`, `encore:pending-packaging:*`) exists
  solely to hold an otherwise-idle Encore instance out of scale-down until the
  packager has had a chance to fetch a job document — we pay for idle transcode
  compute purely so a packaging service can read a JSON file.

The package-only pipeline added in #739 therefore has to refuse the
"transcoded last week" case up front (`409 instance_not_found`) rather than
enqueue a job the packager could never act on: an enqueue with an unreachable
URL produces no output, no callback, and a stall that only surfaces 15 minutes
later via our own stalled-package reconciler.

## Ask for OSC

Add an **output-addressed work item** to `eyevinn-encore-packager`, accepted from
the same queue envelope, for example:

- an optional `inputs` (or `sources`) field carrying the object keys / a bucket
  prefix to package, used **instead of** fetching an Encore job document when
  present; falling back to today's `url` behaviour when absent.

Failing that, an equivalent would be to let the packager accept the *content* of
an Encore job document inline (the output descriptor list we already hold), so
the input does not depend on a live Encore instance.

## Why it would help

- Packaging stops being coupled to transcode-instance lifetime, so
  "package this existing asset" becomes a first-class, cheap operation instead
  of a re-encode.
- The packaging pin subsystem — and the idle Encore compute it deliberately
  keeps running — could be retired.
- Removes a class of failure (`Encore instance no longer available for
  packaging`, stalled packager jobs) that is not about packaging at all, and
  that we currently mitigate with pins, TTL keys and a reconciler.
- Pairs with the output-side ask in `incoming-per-job-packager-output.md`: with
  a per-job input AND a per-job output base, a packaging job becomes fully
  self-describing.
