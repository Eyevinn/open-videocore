// Post-package output relocation (issue #208, ADR-011).
//
// ADR-011 (spike #206) decided the mechanism for landing a single execution's
// packaged output at a caller-supplied destination is POST-PACKAGE RELOCATION,
// NOT passing a per-job output path to the packager. This was verified against
// the live eyevinn-encore-packager schema (2026-07-13): the packager's
// `OutputFolder` is instance-scoped (see routes/provision.ts:578) and the Redis
// queue envelope is only `{ jobId, url }` (see pipeline/osc-packager-queue.ts:34
// and PackagingJob in pipeline/packaging.ts:83), so a per-execution output path
// cannot be threaded through the packager.
//
// So: the packager keeps writing to the DEFAULT staging bucket/prefix
// (unchanged). On packaging SUCCESS, if the execution carries a
// `destinationBucket` override, open-videocore server-side-copies (MinIO/S3
// CopyObject — no bytes proxied through this process) the produced
// CMAF/HLS/DASH objects from the staging location to the override destination,
// then treats the override location as canonical for that execution.
//
// CONTRACT (minio ^8.x, verified 2026-07-13):
//   - client.listObjectsV2(bucket, prefix, recursive) -> stream of { name }
//     (same call WorkspaceStorage.list uses, src/data/storage.ts:213)
//   - client.copyObject(targetBucket, targetObject, sourceBucketNameAndObject)
//     legacy 4-arg overload; sourceBucketNameAndObject is "/<bucket>/<key>".
//     Verified against node_modules/minio .../internal/client.d.ts:354.

// The minimal slice of the minio Client surface this module uses. Declared
// structurally so the real MinioClient satisfies it and a lightweight fake can
// be injected in tests. Mirrors the RedisLike precedent in osc-packager-queue.ts.
export interface RelocationClient {
  listObjectsV2(
    bucketName: string,
    prefix: string,
    recursive: boolean
  ): import('node:stream').Readable;
  copyObject(
    targetBucketName: string,
    targetObjectName: string,
    sourceBucketNameAndObjectName: string
  ): Promise<unknown>;
}

// A resolved destination for relocation: the target bucket and the (possibly
// empty) key prefix within it.
export type RelocationDestination = {
  bucket: string;
  prefix: string;
};

// Parse the persisted per-execution `destinationBucket` override into a target
// bucket + prefix. The value was validated and trailing-slash-normalized at the
// edge by destinationBucketSchema (src/routes/assets.ts:534) so it is always a
// non-empty, trailing-slash-terminated string that is EITHER an `s3://bucket/…/`
// URI OR a plain `bucket/optional/prefix/` path. We split on the first slash to
// separate bucket from prefix. Returns undefined for a malformed value (defence
// in depth — the schema already rejects these) so a bad override cannot land
// output in an unintended bucket.
export function parseDestination(
  destinationBucket: string
): RelocationDestination | undefined {
  let rest = destinationBucket;
  if (rest.startsWith('s3://')) {
    rest = rest.slice('s3://'.length);
  }
  // Drop the trailing slash the schema normalised on so the split does not yield
  // a spurious empty final segment.
  rest = rest.replace(/\/+$/, '');
  if (rest.length === 0) {
    return undefined;
  }
  const slash = rest.indexOf('/');
  if (slash < 0) {
    return { bucket: rest, prefix: '' };
  }
  const bucket = rest.slice(0, slash);
  const prefix = rest.slice(slash + 1);
  if (bucket.length === 0) {
    return undefined;
  }
  return { bucket, prefix };
}

// List every object key under a prefix in a bucket. Mirrors
// WorkspaceStorage.list (src/data/storage.ts:211) but is prefix-scoped so only
// this asset's packaged output is enumerated.
function listUnderPrefix(
  client: RelocationClient,
  bucket: string,
  prefix: string
): Promise<string[]> {
  return new Promise<string[]>((resolve, reject) => {
    const keys: string[] = [];
    const stream = client.listObjectsV2(bucket, prefix, true);
    stream.on('data', (obj: { name?: string }) => {
      if (obj.name) {
        keys.push(obj.name);
      }
    });
    stream.on('end', () => resolve(keys));
    stream.on('error', reject);
  });
}

// Compute the destination object key for a source key. The source key is the
// full key under the staging bucket (e.g. "packaged/<assetId>/index.m3u8"); the
// portion after `sourcePrefix` is preserved verbatim under the destination
// prefix so the packaged layout (shared CMAF segments + manifests) is mirrored
// intact at the destination.
function destinationKey(
  sourceKey: string,
  sourcePrefix: string,
  destPrefix: string
): string {
  const normalizedSourcePrefix = sourcePrefix.replace(/\/+$/, '');
  const relative = sourceKey.startsWith(`${normalizedSourcePrefix}/`)
    ? sourceKey.slice(normalizedSourcePrefix.length + 1)
    : sourceKey.startsWith(normalizedSourcePrefix)
      ? sourceKey.slice(normalizedSourcePrefix.length)
      : sourceKey;
  const base = destPrefix.replace(/\/+$/, '');
  return base.length > 0 ? `${base}/${relative}` : relative;
}

// The result of a relocation: the canonical destination and how many objects
// were copied. Recorded on the execution so delivery-URL resolution (#210) can
// read the location actually used.
export type RelocationResult = {
  destination: RelocationDestination;
  copied: number;
};

// Server-side-copy every object under the staging prefix into the destination.
// The source bucket is the packaged/staging bucket; the destination is the
// caller-supplied override. Copies are S3 CopyObject operations, so bytes never
// transit this process. Throws on the first copy failure so the caller can
// leave the relocation un-recorded and a later (idempotent) retry re-attempts.
export async function relocatePackagedOutput(
  client: RelocationClient,
  args: {
    sourceBucket: string;
    sourcePrefix: string;
    destination: RelocationDestination;
  }
): Promise<RelocationResult> {
  const { sourceBucket, sourcePrefix, destination } = args;
  const keys = await listUnderPrefix(client, sourceBucket, sourcePrefix);
  for (const key of keys) {
    const target = destinationKey(key, sourcePrefix, destination.prefix);
    // Legacy 4-arg copyObject overload: (targetBucket, targetObject,
    // "/<sourceBucket>/<sourceKey>"). Verified against minio ^8.x typings.
    await client.copyObject(destination.bucket, target, `/${sourceBucket}/${key}`);
  }
  return { destination, copied: keys.length };
}
