# OSC friction: packager callbacks carry no per-ENQUEUE identity, only the asset id

- **Service:** eyevinn-encore-packager (redisListener `QueueMessage`, callbackListener)
- **Surfaced by:** issue #1265 (encryption params on the package job + callback settlement of `drm.status`)
- **Date:** 2026-11-05

## What happened

The queue contract is `QueueMessage = { jobId: Type.String(), url: Type.String() }`
(`src/redisListener.ts`), and the success callback echoes `{ url, jobId, outputPath? }`
while the failure callback is `{ message }` only (see the companion log
`incoming-issue209-packager-failure-callback-no-jobid.md`). `jobId` is OUR value and
we set it to the asset id, so the only thing a completion callback identifies is the
**asset** — never the **enqueue** it is answering.

For DRM that distinction is load-bearing. One asset can be packaged more than once,
and the runs are not equivalent: one may carry per-job encryption parameters and
another may be a clear re-package. When a success callback arrives, nothing in the
payload says which of those runs produced the output that just landed.

## Impact

`asset.drm.status = 'pending'` means "an encrypted package was enqueued and we do not
yet know whether it landed". Settling that state on the next success callback for the
asset can stamp `protected` for output that was never encrypted — a false protection
claim in the API response (ADR-008 §8).

Our workaround is entirely API-side: the encrypted enqueue stamps the `package` Job id
it was recorded under onto the DRM block, and the callback settlement only fires when
that id matches the package run now completing
(`correlatesWithRun`, `src/pipeline/packaging.ts`). It is sound for the common case but
not complete: a re-enqueue that lands while the previous run's package job is still
active reuses that same job record, so the two runs remain indistinguishable by job id
alone. Closing that window needs an identifier that round-trips through the packager.

## What would help

1. Let the queue message carry an opaque, per-message correlation id (any value the
   caller supplies) and echo it back on **both** the success and failure callbacks.
   That alone makes every completion attributable to one enqueue.
2. Failing that, echo the queue message's full envelope on the callbacks (including the
   per-job options the message carried), so a consumer can tell an encrypted run from a
   clear one.

Both are strictly additive to `QueueMessage` and the callback bodies, and neither
requires the packager to understand DRM. They are the same contract gap as
`incoming-packager-no-encryption-support.md` (no per-job encryption option) seen from
the completion side rather than the submission side.
