// Pre-dispatch source-object readiness check for the transcode step (issue
// #1059).
//
// PROBLEM this module fixes. The asset reaches `ready`, POST /:id/execute is
// accepted, and ~2 minutes later the transcoder fails with an opaque probe 404
// because the object named by the job's `s3://<bucket>/<key>` input is not
// there (root-cause context: issues #1057 / #1058 — large source objects
// disappearing from the source bucket between ingest completion and the
// transcode read). Everything up to that point looks healthy: `Asset.objectKey`
// is set, so the unified resolver (source-object.ts) is satisfied, and nothing
// on the submit path ever asks the object store whether the BYTES are still
// there.
//
// So this module does the one thing that was missing: a HEAD (stat) of the
// EXACT bucket + key the transcoder will read, immediately before the job is
// submitted, and a comparison against the size recorded at ingest/pull
// completion when such a size is available. A miss fails the execution
// synchronously with an error that NAMES the bucket, the key and the storage
// endpoint, instead of surfacing as a transcoder 404 minutes later.
//
// SCOPE — the ingest-completion path is deliberately untouched. Issue #1059's
// third bullet asked whether the readiness check at ingest completion could be
// made to use the same storage endpoint as the transcode input "only if this is a
// small, well-contained change". It is not: that check is the metadata
// extractor's probe of a PRESIGNED GET URL
// (src/pipeline/metadata-extractor.ts:172-174), and presigned URLs must stay on
// the stack's PUBLIC endpoint because SigV4 signs the Host header and the
// transcoder may be handed the in-cluster alias of the same store, which is
// explicitly excluded from every client-facing URL (see "SCOPE — what must stay
// PUBLIC" in src/services/internal-minio-endpoint.ts). Equalising the two views
// means signing per-consumer URLs against a second endpoint — a design change.
// What this module does instead is check the bucket + key at the moment of
// submission, which is where the reported failure actually bites.
//
// Shape and conventions are deliberately the same as the burn-in sidecar
// availability check (checkBurnInObjectAvailable, src/pipeline/burn-in.ts:322):
// a narrow injected stat reader, a machine-readable outcome union, and a
// message the route can forward verbatim.
//
// CONTRACT SOURCES VERIFIED (CLAUDE.md rule 7):
//   - `WorkspaceStorage.statObject(localKey): Promise<{ size: number; etag:
//     string } | undefined>` — `undefined` is a NotFound (src/data/storage.ts:
//     136-146). This is the HEAD equivalent the check is built on; the narrow
//     `SourceStatReader` below is exactly its `{ size }` subset.
//   - The transcoder input the check must mirror is
//     `inputUri = s3://${params.sourceBucket}/${params.sourceObjectKey}`
//     (src/pipeline/transcode.ts:120), forwarded as
//     `EncoreSubmitInput.inputUri` (src/pipeline/encore-client.ts:17-27) into
//     the job document's `inputs: [{ uri, type: 'AudioVideo' }]`
//     (toEncorePayload, src/pipeline/encore-client.ts:95). There is NO other
//     input field, so bucket + key is the whole input location.
//   - The bucket in that URI is the resolved stack's source bucket
//     (`WorkspaceConnections.sourceBucket`, src/services/workspace-stack.ts:117,
//     set from `StackConfig.sourceBucket` at :248) and the per-request
//     `StorageFactory` is bound to the SAME `config.sourceBucket`
//     (workspace-stack.ts:213-214), so a stat through that factory addresses
//     exactly the object the transcoder will read.
//   - The storage endpoint the transcoder resolves the URI against is the
//     stack's object-store endpoint (`WorkspaceConnections.s3Config.endpoint`,
//     workspace-stack.ts:250, from `StackConfig.minioEndpoint`), handed to the
//     spawned transcoder as `EncoreS3Config.endpoint`
//     (src/services/encore-s3-config.ts:228-237). In production the transcoder
//     may be given the in-cluster alias of that SAME object store
//     (services/internal-minio-endpoint.ts), which is why the endpoint is
//     reported for diagnosis but is not itself re-resolved here.
//   - Bounded-deadline + named-dependency plumbing reused verbatim:
//     `withDependencyTimeout(op, detail)` / `resolveDependencyTimeoutMs(env)`
//     (src/encore-scaler/dependency-timeout.ts:139, :29) and `sanitizeEndpoint`
//     (:120) — the same guard the transcode path's reachability preflight uses
//     (src/services/stack-reachability.ts), so the storage HEAD can never hang
//     the request.
//   - The recorded ingest size the stat is compared against is
//     `Asset.sourceSizeBytes` (src/data/asset-repo.ts), round-tripped through
//     the document's `administrative.storage.sizeBytes`
//     (src/data/asset-document.ts) and written from the true transferred length
//     at both ingest completion points: `bytesTransferred` from
//     `WorkspaceStorage.putStream(): Promise<{ etag, bytesTransferred }>`
//     (src/data/storage.ts) in src/pipeline/url-pull-worker.ts and
//     src/routes/asset-upload.ts.

import {
  resolveDependencyTimeoutMs,
  sanitizeEndpoint,
  withDependencyTimeout
} from '../encore-scaler/dependency-timeout.js';

// The minimal object-store surface this check needs: stat one workspace-local
// key and report its size, or `undefined` when the object is absent. EXACTLY the
// `{ size }` subset of `WorkspaceStorage.statObject` (src/data/storage.ts:136),
// so the check depends on the narrow method rather than the whole class and
// stays unit-testable with a fake.
export type SourceStatReader = {
  statObject(objectKey: string): Promise<{ size: number } | undefined>;
};

// The exact location the transcoder will read, as it appears in the job's
// `s3://<bucket>/<key>` input, plus the endpoint that URI is resolved against.
export type TranscodeSourceTarget = {
  // Bucket from the input URI (transcode.ts:120 `params.sourceBucket`).
  bucket: string;
  // Key from the input URI (transcode.ts:120 `params.sourceObjectKey`).
  objectKey: string;
  // Object-store endpoint the transcoder resolves the URI against. Optional
  // because the env-override / in-memory connection paths carry no stack
  // `s3Config`; the messages then name the bucket and key only.
  endpoint?: string;
  // Size recorded for this object at ingest completion. In production this is
  // `Asset.sourceSizeBytes` (src/data/asset-repo.ts), written from the true
  // transferred length by the URL-pull worker (`bytesTransferred`,
  // src/pipeline/url-pull-worker.ts) and the streaming upload route
  // (src/routes/asset-upload.ts), and persisted in the asset document's
  // `administrative.storage.sizeBytes` (src/data/asset-document.ts).
  //
  // Undefined for assets ingested before #1059 and for the ingest paths that
  // never learn a length (presigned-PUT completion, external-bucket
  // registration); the size comparison is then skipped and presence alone is
  // enforced. When supplied (and > 0) a mismatch is a hard failure: the object
  // present under the right key with the wrong length is a truncated or
  // replaced source, which the transcoder would either reject late or transcode
  // incorrectly.
  expectedSizeBytes?: number;
  // Stack/workspace name, echoed into the bounded-deadline diagnostics only.
  stackName?: string;
};

// Why the source is not usable. Machine-readable so a route can map it to a
// status code without string-matching the message.
//   absent        — HEAD/stat found no object at that key (the #1057/#1058 case)
//   empty         — the object exists but is zero-length
//   size-mismatch — the object's length differs from the size recorded at
//                   ingest/pull completion
//   probe-failed  — the object store could not be asked (error or deadline), so
//                   presence is UNKNOWN; we refuse rather than dispatch blind
export type SourceUnreadableReason = 'absent' | 'empty' | 'size-mismatch' | 'probe-failed';

export type SourceReadiness =
  | { readable: true; sizeBytes: number }
  | {
      readable: false;
      reason: SourceUnreadableReason;
      // Message naming the bucket, the key and the storage endpoint — safe to
      // forward to the caller verbatim (no credentials: the endpoint is run
      // through sanitizeEndpoint and the stored endpoint carries no secret).
      message: string;
      // Observed size, when the object existed.
      sizeBytes?: number;
    };

// `"<key>" in bucket "<bucket>" at storage endpoint <endpoint>` — the three
// coordinates an operator needs to go and look for the object themselves.
function describeTarget(target: TranscodeSourceTarget, safeEndpoint?: string): string {
  const where = safeEndpoint
    ? `at storage endpoint ${safeEndpoint}`
    : 'at the configured storage endpoint';
  return `"${target.objectKey}" in bucket "${target.bucket}" ${where}`;
}

/**
 * Verify the transcode source object is present and readable BEFORE the job is
 * submitted (issue #1059).
 *
 * Returns a machine-readable outcome rather than throwing, so the caller decides
 * the HTTP mapping. The stat is bounded by the shared dependency deadline, so a
 * stalled object store fails the submission promptly instead of hanging the
 * request; any error or deadline is reported as `probe-failed` (presence
 * unknown) rather than being swallowed.
 */
export async function checkTranscodeSourceReadable(
  target: TranscodeSourceTarget,
  storage: SourceStatReader,
  opts: { timeoutMs?: number } = {}
): Promise<SourceReadiness> {
  const timeoutMs = opts.timeoutMs ?? resolveDependencyTimeoutMs();
  // Sanitize ONCE, up front, and use the result for every outward-facing string:
  // the messages below (forwarded verbatim into the route's 409/502 body) and the
  // bounded-deadline detail, whose `DependencyUnreachableDetail.endpoint` is
  // documented as "the endpoint we were talking to, with any credentials
  // stripped" (src/encore-scaler/dependency-timeout.ts:46-48) and whose message
  // is also forwarded. Matches the other two call sites, which sanitize before
  // handing the endpoint over (src/encore-scaler/index.ts, services/
  // stack-reachability.ts). No stored endpoint carries credentials today; this
  // makes the path structurally unable to leak one if that ever changes.
  const safeEndpoint = target.endpoint ? sanitizeEndpoint(target.endpoint) : undefined;
  let stat: { size: number } | undefined;
  try {
    stat = await withDependencyTimeout(() => storage.statObject(target.objectKey), {
      dependency: 'storage',
      // `endpoint` is diagnostic text on the bounded-deadline error only; the
      // env-override path carries no stack endpoint, so name the bucket instead
      // of fabricating a URL.
      endpoint: safeEndpoint ?? `bucket ${target.bucket}`,
      ...(target.stackName !== undefined ? { stackName: target.stackName } : {}),
      operation: `statObject ${target.bucket}/${target.objectKey}`,
      timeoutMs
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      readable: false,
      reason: 'probe-failed',
      message:
        `could not verify that the transcode source object ${describeTarget(target, safeEndpoint)} is readable: ` +
        `${detail} — refusing to start the transcode, because a source the object store cannot ` +
        'confirm would fail the transcode minutes later with an opaque probe error'
    };
  }

  if (!stat) {
    return {
      readable: false,
      reason: 'absent',
      message:
        `the transcode source object ${describeTarget(target, safeEndpoint)} does not exist — refusing to start ` +
        'the transcode, which would otherwise fail minutes later with an opaque probe error. The ' +
        'object was deleted or never landed under that key; re-ingest the source and retry'
    };
  }
  if (stat.size <= 0) {
    return {
      readable: false,
      reason: 'empty',
      sizeBytes: stat.size,
      message:
        `the transcode source object ${describeTarget(target, safeEndpoint)} exists but is zero-length — ` +
        'refusing to start the transcode; re-ingest the source and retry'
    };
  }
  if (
    target.expectedSizeBytes !== undefined &&
    target.expectedSizeBytes > 0 &&
    stat.size !== target.expectedSizeBytes
  ) {
    return {
      readable: false,
      reason: 'size-mismatch',
      sizeBytes: stat.size,
      message:
        `the transcode source object ${describeTarget(target, safeEndpoint)} is ${stat.size} bytes, but ` +
        `${target.expectedSizeBytes} bytes were recorded when ingest completed — the stored source ` +
        'has been truncated or replaced; refusing to start the transcode, re-ingest the source and retry'
    };
  }
  return { readable: true, sizeBytes: stat.size };
}
