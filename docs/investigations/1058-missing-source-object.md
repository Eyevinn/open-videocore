# 1058 — Why `ingest/<assetId>` is missing from `openvideocore-source` when the transcoder reads it

**Date:** 2026-10-02
**Author:** surface-backend-api agent
**Type:** root-cause analysis (diagnosis task — no behavioural fix in this commit, see "Why no fix is committed")
**Related:** #615 (per-request stack keying of the transcode path), #639 (per-stack source bucket), #804 (fail-loud endpoint resolution), #991 (in-cluster object-store endpoint), #616 (submit-time reachability preflight)

## Summary

The object is **not missing**. It is written, committed, and still present — in the
**wrong object-storage instance** relative to the one the transcoder is pointed at.

On an installation with two provisioned stacks, this API's **data plane**
(asset/job documents *and* object bytes) is wired to the **default stack — the
first name returned by the parameter store's stack listing** and ignores the
`X-Stack-Name` request header, while the **transcode control plane** (the Encore
auto-scaler pool, its Valkey queue, and the `s3Endpoint` each spawned transcoder
is created with) is keyed by the **header-named stack** (issue #615). When those
two stacks are not the same stack, the source object is written to instance A and
read from instance B.

Both instances hold a bucket with the **same name** — `openvideocore-source` is a
hard-coded literal applied to every provisioned stack
(`src/routes/provision.ts:59`, created at `:902`) — so nothing in the failing
`s3://openvideocore-source/ingest/<assetId>` URI, in the transcoder's error, or
in the submit-time preflight distinguishes "wrong instance" from "missing
object". The failure presents as ffprobe 404 / `NoSuchKey`.

This is size-independent. The 449 MB file is a **confounded** variable: the
reported working case is a *different stack* that also happens to use small
clips. See point 3 for the positive evidence that multipart handling is not
involved.

## Point 1 — which endpoint and bucket each of the three paths uses

### Write path (URL-pull worker) → the DEFAULT stack

`POST /api/v1/assets/ingest-url` creates the asset, fixes the key as
`ingest/<assetId>`, and hands the worker a storage handle from the
**sync `storageFor()` factory**:

- `src/routes/assets.ts:2885-2886` — `const objectKey = \`ingest/${asset.id}\`` and
  `repo.update(asset.id, { objectKey })`.
- `src/routes/assets.ts:2899-2901` — `void runner({ jobId, assetId, objectKey, sourceUrl }, { … storage: storageFor() … })`.
- `src/pipeline/url-pull-worker.ts:119` — the worker's only write:
  `deps.storage.putStream(objectKey, …)`.

`storageFor()` is defined in the entrypoint and resolves the stack **with no
stack name**:

```ts
const storageFor: StorageFactory = (): WorkspaceStorage => {
  const conns = stackResolver.resolveCached();      // <-- no stack name
  if (!conns?.storageFor) { throw new Error('object storage is not configured for this stack'); }
  return conns.storageFor();
};
```
— `src/main.ts:658-664`.

`resolveCached(stackName?)` keys its cache by `stackName ?? ''`
(`src/services/workspace-stack.ts:1072-1077`), and the `''` entry is the one
`resolve()` builds when **no** name is given, which selects
`listStackNamesWithMigration(ps)[0]` — the first listed stack
(`src/services/workspace-stack.ts:874-886`, cache write at `:964-969`,
`cacheKey` at `:807`).

That `''` entry is guaranteed warm **inside the very same request**, not by luck:
the assets router's repository is `PerWorkspaceAssetRepository`, whose every call
is `(await this.resolver.resolve()).assets` — again **no stack name**
(`src/data/per-workspace-repos.ts:77`; the job, search, profile, pipeline,
collection and audit wrappers are identical, `:148`, `:188`, `:235-247`, `:258`,
`:265`, `:281`, `:306`, `:342`). `repo.create()` at `src/routes/assets.ts:2880`
therefore resolves and caches the default stack before `storageFor()` is called
at `:2901`.

So: **bytes and documents both land on the first-listed stack's MinIO/CouchDB,
whatever `X-Stack-Name` said.** The bucket is that stack's
`StackConfig.sourceBucket` (`src/services/workspace-stack.ts:213-214`, client
built from `config.minioEndpoint` at `:190-198`).

### Metadata-extraction read path → the DEFAULT stack (which is why it succeeds)

Extraction is handed the same factory's handle:

- `src/routes/assets.ts:1822-1840` — `triggerExtraction()` → `storage: storageFor()`.
- Called for URL-pull at `src/routes/assets.ts:2902-2907`, only once the pull
  settled the asset into `processing`.
- The probe reads a presigned GET minted from that handle
  (`src/pipeline/metadata-extractor.ts:10-16, 24-32`;
  `WorkspaceStorage.presignedGet`, `src/data/storage.ts:132-134`).

Because the write and this read go through the *same* `storageFor()` (default
stack), **successful metadata extraction proves the object exists — on the
default stack's instance.** It says nothing about the instance the transcoder
will use. This is exactly why the reported sequence is "pull done ✔, metadata ✔,
transcode 404".

### Transcoder read path → the HEADER-NAMED stack

Two independent inputs decide what the transcoder reads:

**Bucket name** comes from the per-request connections — i.e. the header-named
stack:

- `src/main.ts:461-473` — the global preHandler sets
  `request.connections = await stackResolver.resolve(stackName)` from
  `x-stack-name`.
- `src/routes/assets.ts:4448` — `sourceBucket: request.connections?.sourceBucket ?? opts.sourceBucket`
  (same at `:2523` for the pipeline path).
- `src/pipeline/transcode.ts:120` — `const inputUri = \`s3://${params.sourceBucket}/${params.sourceObjectKey}\``.

**Endpoint and credentials** come from the scaler, keyed by the header-named
stack:

- `src/routes/assets.ts:4433` — `workspaceId: await transcodeContext(request)`.
- `src/routes/assets.ts:1775-1781` — `transcodeContext()` reads `x-stack-name`
  and returns `opts.resolveStackContext(requested)`.
- `src/main.ts:1871-1872` — that option is
  `stackResolver.resolveStackName(requestedStackName)`, which returns the
  requested name **verbatim** whenever it has a stored config
  (`src/services/workspace-stack.ts:998-1012`).
- That value is the `contextId` of `encodeEncoreJobId` and therefore the scaler's
  partition key (`src/pipeline/transcode.ts:116`), which is fed to
  `resolveS3Config(stackKey)` — `src/main.ts:1151-1176`.
- `src/services/encore-s3-config.ts:196-237` — loads *that* stack's config and
  returns `{ endpoint: <that stack's minioEndpoint, mapped>, accessKeyId: 'admin',
  secretAccessKey }`.
- `src/encore-scaler/instance-pool.ts:367-372` — those become the Encore
  instance's `s3Endpoint` / `s3AccessKeyId` / `s3SecretAccessKey`.

**The mismatch, stated exactly:** the object key and the bucket *name* agree
across all three paths; the **endpoint** does not. Write/probe use
`resolve()`/`resolveCached()` with no name (first-listed stack); the transcoder
uses `resolveStackName(X-Stack-Name)` (named stack). With two MinIO instances
both exposing `openvideocore-source`, the result is a clean `NoSuchKey`.

### Why nothing catches it today

Three separate guards all pass:

1. The submit-time reachability preflight probes the named stack's storage but
   only does a **bucket** HEAD: `bucketExists(bucket)`
   (`src/services/stack-reachability.ts:100-104`, invoked at `:216`; call site
   `src/routes/assets.ts:4408-4425` passing
   `request.connections.s3Config.endpoint` + `request.connections.storageClient`).
   The bucket exists on *both* instances, so the probe is green.
2. `resolveEncoreS3Config` is fail-loud about an *unresolvable* endpoint (#804)
   but has no notion of "resolvable, but not the instance the bytes are in". Its
   `names[0]` fallback (`src/services/encore-s3-config.ts:199-204`) is a second,
   independent way to reach the wrong instance when the requested stack has no
   stored config.
3. Credentials are process-global — `accessKeyId: 'admin'`
   (`src/services/encore-s3-config.ts:80, 235`) plus one env secret — and the
   API's own per-stack client uses the same single `minioPassword`
   (`src/services/workspace-stack.ts:192-198`,
   `WorkspaceStackResolver` constructor `:724-756`). So if both instances share
   that root password, a cross-instance read **authenticates successfully** and
   returns `NoSuchKey` rather than a 403 that would have named the problem.

## Point 2 — lifecycle / expiry / cleanup / move-after-extract

**Nothing in this codebase removes or relocates `ingest/<assetId>` on the path
between a successful pull and a transcode read.** Audited exhaustively:

- **No lifecycle or expiry rule is ever configured.** `setBucketLifecycle`,
  `Expiration` and `AbortIncompleteMultipartUpload` appear nowhere in `src/`
  (grep, 2026-10-02). The provision route creates buckets
  (`src/routes/provision.ts:902`) and sets an anonymous-read policy on the
  packaged bucket only; it installs no ILM rule. Any expiry rule on a live
  instance is therefore **operator/instance-side configuration, not ours** — see
  "runtime data a human must check".
- **Archived-asset purge sweep** deletes `asset.objectKey`
  (`src/pipeline/archived-asset-purge-sweep.ts:263`) but enumerates **only**
  `status: 'archived'` assets (`:192-201`). A freshly pulled asset is
  `processing`/`ready`, never `archived`.
- **Abandoned-upload sweep** (`src/pipeline/abandoned-upload-sweep.ts:94-165`)
  writes **status only** (`uploading -> failed`, `:141`). It never touches object
  storage.
- **Direct-upload quota rollback** deletes the object
  (`src/routes/asset-upload.ts:624`) but only on the `PUT`-complete path and only
  when `quota.admit()` throws `QuotaExceededError`. The URL-pull path reserves
  *before* streaming and treats an over-cap pull as a permanent failure, so the
  job would be `failed`, not `done`
  (`src/pipeline/url-pull-worker.ts:116, 136, 147-153, 60-66`).
- **No move/rename after extract.** Extraction writes only asset-document fields;
  the source key is a single authoritative field (`Asset.objectKey`, resolved by
  `src/pipeline/source-object.ts:61-67`) and no code infers, rewrites or
  re-prefixes it after ingest. The only server-side `copyObject` calls are
  archive-tier relocation (`src/pipeline/archive-tier-relocation.ts:250`),
  archive rehydration (`src/pipeline/archive-tier-rehydrate.ts:193`) and packaged
  **output** relocation (`src/pipeline/output-relocation.ts:150`) — all
  operator-triggered tier/destination operations, none of them on the
  ingest→transcode path.

## Point 3 — does the pull report `done` before the multipart upload is committed?

**No. Positively ruled out from the code.**

`putStream` awaits the minio client's `putObject` and only then returns, and the
worker marks the job `done` strictly after that returns:

- `src/data/storage.ts:263-264` — `const result = await this.client.putObject(this.bucket, key, pass, opts.totalBytes); return { etag: result.etag, bytesTransferred: transferred };`
- `src/pipeline/url-pull-worker.ts:119-144` — `await deps.storage.putStream(…)`,
  then `await deps.jobs.update(jobId, { status: 'done', … })`.

And in the client, a known-size stream above the part size takes the multipart
path whose promise resolves **only after `completeMultipartUpload`**:

- `node_modules/minio/dist/esm/internal/client.mjs:1399-1404` — `calculatePartSize(size)`, then `uploadStream(...)` when `size > partSize`.
- `node_modules/minio/dist/esm/internal/client.mjs:1437-1511` — `uploadStream` uploads each part and ends with `return await this.completeMultipartUpload(bucketName, objectName, uploadId, eTags)` (`:1508`), awaited at `:1462-1509`.

So `status: done` **implies the object was committed** at the endpoint it was
written to. The reported `bytesTransferred` of 449,056,937 additionally shows
`Content-Length` was known (progress is only computed against a known total,
`src/pipeline/url-pull-worker.ts:122-131`), so the multipart branch — not the
"unknown size" branch — is what ran.

Two size-related notes recorded for completeness, neither of which can make the
object absent:

1. **Small clips take a different code path.** `size <= partSize` is buffered and
   PUT in one request (`client.mjs:1400-1402`); 449 MB exceeds the computed part
   size and is multipart. The paths differ, but both commit before resolving. The
   discriminator in the report is better explained by stack identity (point 1)
   than by this difference.
2. **Retry + resume interaction (latent, secondary).** A failed attempt leaves an
   orphaned multipart upload — the worker retries up to `MAX_ATTEMPTS`
   (`src/pipeline/url-pull-worker.ts:40, 101-158`) and nothing aborts the partial
   upload (`WorkspaceStorage.abortMultipartUpload`, `src/data/storage.ts:220-222`,
   is only used by the client-driven multipart route). The next attempt *resumes*
   it: `uploadStream` calls `findUploadId` and compares `listParts` etags
   (`client.mjs:1445-1455, 1469-1479`). Note that the client increments
   `partNumber` **before** using it in the part request
   (`client.mjs:1480` vs `:1486`), so the first part is uploaded as part 2 and the
   resume comparison is keyed one off the server's numbering. That is a
   correctness risk for *resumed* large uploads (wrong-offset or duplicated part
   content), **not** a disappearance mechanism — and large files are the only ones
   that reach it. Worth a separate issue; it does not explain #1058.

## Conclusion

Root cause: **an endpoint-resolution asymmetry between the data plane and the
transcode control plane on a multi-stack installation.**

- Everything that writes or reads bytes through this API resolves the stack with
  **no name** → the first-listed stack (`src/main.ts:658-664`,
  `src/data/per-workspace-repos.ts:77`,
  `src/services/workspace-stack.ts:874-886`).
- The transcode submission resolves the stack **from `X-Stack-Name`** → the named
  stack (`src/routes/assets.ts:1775-1781, 4433`, `src/main.ts:1871-1872`,
  `src/services/workspace-stack.ts:998-1012`), and that identity selects the
  `s3Endpoint` the transcoder is created with (`src/main.ts:1151-1176`,
  `src/services/encore-s3-config.ts:218-237`,
  `src/encore-scaler/instance-pool.ts:367-372`).
- Identical bucket names on every stack (`src/routes/provision.ts:59`) plus a
  bucket-only preflight (`src/services/stack-reachability.ts:100-104`) make the
  mismatch silent until ffprobe reports `NoSuchKey`.

Issue #615 introduced per-request stack keying for the control plane; the data
plane was never threaded through, so for any request that names a stack other
than the first-listed one, the two halves address different object stores. Before
#615 the transcode path used the fixed deployment context, which fell through to
the same first-listed stack as the data plane — which is why this is a
regression that only appears on an installation with more than one stack.

## Why no fix is committed

Both ways to close the gap are larger than a contained bug fix and change
documented behaviour, so neither is guessed at here:

- **(a) Point the control plane at the data plane's stack** — make
  `transcodeContext` resolve with no name. Two lines, but it deliberately
  disables #615, whose behaviour is pinned by
  `test/transcode-stack-routing.test.ts` ("keys the scaler context by the named
  stack") and `src/services/transcode-namespace-acceptance.test.ts`. Removing a
  tested, ADR-adjacent routing guarantee is an architecture decision, not an
  implementation detail.
- **(b) Thread the stack through the data plane** (the real fix) — `storageFor`
  is a **synchronous, request-less** `StorageFactory` (`src/main.ts:658`) and the
  `PerWorkspace*` repositories take no stack argument at all
  (`src/data/per-workspace-repos.ts`). Honouring the header there touches every
  ingest, probe, thumbnail, clip, package, export, delivery and sweep call site,
  and it also has to decide where the *asset document* lives. Cross-cutting.

Recommended sequencing:

1. **Immediate operational mitigation (no deploy):** have clients stop sending an
   `X-Stack-Name` that names anything other than the first-listed stack for this
   installation, or run the affected workload on the first-listed stack. That
   makes the control plane and data plane agree again.
2. **Small, contained hardening (tracked separately as #1059):** widen the
   submit-time preflight from `bucketExists` to a `statObject` of
   `source.objectKey` against the storage the transcoder will actually read
   (`src/services/stack-reachability.ts:100-104, 216`; call site
   `src/routes/assets.ts:4408-4425`; `WorkspaceStorage.statObject`,
   `src/data/storage.ts:136-146`). This converts the silent downstream
   `NoSuchKey` into an immediate, named submit error on every deployment. It does
   **not** fix the mismatch — it stops it being invisible — which is why it is a
   separate issue with its own regression test rather than part of this
   diagnosis.

   One caveat for whoever implements it: the existing object-presence precedent
   on this route, the #389 burn-in check, resolves its storage through
   `storageFor()` — the **data-plane/default** stack
   (`src/routes/assets.ts:4374`). Copying that would re-check the instance the
   bytes are already in and stay green on exactly the #1058 case. The check has
   to run against the storage the transcoder is given, i.e. the connections the
   `s3Endpoint` was derived from.
3. **The real fix (architect / ADR):** decide whether one deployment addresses
   one stack (then (a), and `X-Stack-Name` must stop influencing transcode
   routing) or genuinely many (then (b), and the data plane must be threaded).
   ADR-018/ADR-020's "one deployment == one tenant" framing points at (a);
   #615's premise points at (b).

## Runtime data a human must obtain to confirm this

Everything above is from the code. One runtime fact closes it, and two more
settle the alternatives:

1. **Did the failing requests carry an `X-Stack-Name` naming a non-first stack?**
   The resolver already logs both halves: `{ source: 'x-stack-name', namespace,
   stackName }` when a header is present
   (`src/services/workspace-stack.ts:855-858`) and `{ source: 'default',
   namespace, listed: <names> }` for the no-header resolution (`:880-883`). If
   `stackName` on the failing ingest/transcode requests differs from
   `listed[0]`, the diagnosis is confirmed outright. Also compare the
   `encore-scaler: using the in-cluster object-store endpoint` /
   `failed its health probe` lines (`src/services/internal-minio-endpoint.ts:610-628`)
   for the endpoint host actually handed to the transcoder.
2. **Object-storage audit/access logs for both instances**, filtered on
   `ingest/<assetId>`: expect a successful multipart PUT + GET (the probe) on one
   instance and only a failed GET (`NoSuchKey`) on the other. A `DELETE` on the
   first instance would instead point at an instance-side ILM rule (point 2
   showed this codebase issues none).
3. **Each instance's ILM / lifecycle configuration**, to rule out an
   operator-configured expiry or incomplete-multipart-abort rule. Not derivable
   from the codebase.

A cheap positive control that needs no logs: ingest and transcode the same
449 MB file with **no** `X-Stack-Name` header at all. If it succeeds, the file
size is exonerated and the stack asymmetry is the cause.
