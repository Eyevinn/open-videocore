// Deliver an EXISTING asset object to a registered export destination
// (issue #1131, prerequisite for #945 / the #910/#911 export-from-detail UI).
//
// WHAT THIS IS. A plain deliver-to-destination of bytes that already exist: no
// transcode, no packaging, no re-wrap. The route layer resolves which
// destination was asked for; this module moves ONE object there and reports
// whether it actually landed.
//
// WHY A DEDICATED MODULE (and not a `destination` field on POST /:id/export).
// `POST /api/v1/assets/{id}/export` is a container re-wrap: it dispatches an OSC
// ffmpeg `-c copy` job through the injected `rewrapRunner` and produces a NEW
// child asset (src/routes/assets.ts, the `/:id/export` handler; body =
// `{ targetFormat, outputName?, asVersion? }`, `exportBodySchema`
// src/routes/assets.ts:723-730). The output location of that job is the
// workspace's own bucket, taken from the runner's `s3Config`
// (`requestRunnerS3Config`, src/routes/assets.ts:2037-2042), and the OSC
// ffmpeg-s3 job body carries exactly ONE S3 identity
// (`ffmpegS3CredentialMapping` -> awsAccessKeyId / awsSecretAccessKey /
// s3EndpointUrl, src/services/external-storage-credentials.ts:155-180), so that
// job cannot read from one credentialed store and write to another. Delivery is
// therefore a different operation from re-wrap, with a different terminal
// condition ("the object is present at the destination" vs "a child asset was
// produced"), which is why it gets its own endpoint and its own module.
//
// BYTE MOVEMENT CONTRACT (verified against minio ^8.x typings):
//   - bucketExists(bucketName): Promise<boolean>
//     (node_modules/minio/dist/esm/internal/client.d.mts:207)
//   - statObject(bucketName, objectName): Promise<BucketItemStat>  (size, etag)
//     (client.d.mts:239)
//   - copyObject(targetBucketName, targetObjectName,
//                sourceBucketNameAndObjectName): Promise<CopyObjectResult>
//     — the legacy 4-arg overload, source spelled "/<bucket>/<key>"
//     (client.d.mts:354). This is the SAME server-side-copy primitive the
//     ADR-011 post-package relocation uses (src/pipeline/output-relocation.ts:
//     136-153) and the archive-tier relocation uses
//     (src/pipeline/archive-tier-relocation.ts:57-65), so bytes never transit
//     this process and no new storage abstraction is introduced.
//
// TRUTHFUL TERMINAL STATUS (the whole point of #1131 — #945 reports the outcome
// to an operator). `deliverAssetObject` reports `ok: true` ONLY after it has
// re-read the object AT THE DESTINATION and found it present with the source's
// byte count. Every other path returns `ok: false` with a machine-readable
// reason:
//   - the destination bucket is not writable with the credentials this client
//     holds                                            -> destination_unreachable
//   - the source object is not actually in the source bucket -> source_missing
//   - the object is larger than a single server-side copy can carry
//                                                       -> source_too_large
//   - the copy call itself failed                       -> copy_failed
//   - the copy call succeeded but nothing (or a short object) is at the
//     destination afterwards                            -> not_landed
//   - the operation did not settle inside the bound      -> timeout
// A copy is NEVER reported as a success on the strength of the copy call alone.

// The slice of the MinIO/S3 client surface delivery needs. Declared
// structurally (the real `minio.Client` satisfies it, and a fake is injectable
// in tests) — the same seam style as `RelocationClient`
// (src/pipeline/output-relocation.ts:29-40) and `ArchiveCopyClient`
// (src/pipeline/archive-tier-relocation.ts:57-65).
export interface DeliveryObjectClient {
  bucketExists(bucketName: string): Promise<boolean>;
  statObject(bucketName: string, objectName: string): Promise<{ size: number; etag: string }>;
  copyObject(
    targetBucketName: string,
    targetObjectName: string,
    sourceBucketNameAndObjectName: string
  ): Promise<unknown>;
}

// The object to deliver, already resolved by the caller: the bucket it lives in
// plus its key. The key comes from the ONE authoritative source field
// (`Asset.objectKey` via `requireSourceObject`,
// src/pipeline/source-object.ts:96); the bucket from the request's resolved
// stack (`WorkspaceConnections.sourceBucket`,
// src/services/workspace-stack.ts:150) or from an `s3://bucket/key` source URI.
export type DeliverySource = {
  bucket: string;
  key: string;
};

// Where the bytes go: the destination bucket plus the (possibly empty) key
// prefix inside it. Produced by the caller from the registry's resolved
// destination string via `parseDestination`
// (src/pipeline/output-relocation.ts:57-80), so the named-destination path
// keys output exactly as the ADR-011 relocation does — including any #574
// per-destination path template.
export type DeliveryTarget = {
  bucket: string;
  prefix: string;
};

// Every way a delivery can fail to put the bytes where the caller asked.
// Deliberately exhaustive and machine-readable: the route maps each reason to
// one status code, so no failure can reach the caller dressed as a success.
export type DeliveryFailureReason =
  | 'destination_unreachable'
  | 'source_missing'
  | 'source_too_large'
  | 'copy_failed'
  | 'not_landed'
  | 'timeout';

export type DeliveryOutcome =
  | {
      ok: true;
      // The coordinates the object was VERIFIED at (re-read after the copy).
      bucket: string;
      objectKey: string;
      bytes: number;
      etag: string;
    }
  | {
      ok: false;
      reason: DeliveryFailureReason;
      // Human-readable, secret-free explanation. Never carries a credential:
      // the only external material in scope here is a bucket name and an object
      // key, both non-secret (the same fields the #209 destination pre-flight
      // already puts in its 422 message, src/routes/assets.ts:2536-2539).
      message: string;
    };

// A single server-side CopyObject can carry at most 5 GiB (the S3 CopyObject
// limit; a larger object needs the multipart upload-part-copy flow, which this
// slice does not implement). Checked BEFORE the copy from the source stat we
// already have, so an over-size object gets a clear, attributable refusal
// instead of an opaque `EntityTooLarge` from the store.
export const SINGLE_COPY_MAX_BYTES = 5 * 1024 * 1024 * 1024;

// Default bound on a whole delivery (probe + stat + copy + verify). A hung
// store must not hold the request open indefinitely; on expiry we report
// `timeout` — explicitly NOT a success, because we could not confirm the
// object landed (the copy may still complete store-side afterwards).
export const DEFAULT_DELIVERY_TIMEOUT_MS = 120_000;

// 12-factor timeout override (config via env, no redeploy needed to retune).
// Mirrors the env-read helpers in src/data/storage.ts (`uploadUrlTtlSeconds`,
// storage.ts:27-40): an unset/unparseable/non-positive value falls back to the
// default rather than disabling the bound.
export function deliveryTimeoutMs(): number {
  const raw = process.env['DELIVERY_TIMEOUT_MS'];
  if (!raw) return DEFAULT_DELIVERY_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_DELIVERY_TIMEOUT_MS;
  return Math.floor(parsed);
}

// The destination key for a delivered object: the source key preserved UNDER
// the destination prefix, so a delivered object is deterministically mappable
// back to the asset's source object. Same rule as the archive tier's
// `archiveKeyFor` (src/pipeline/archive-tier-relocation.ts:102-106).
export function deliveredKeyFor(sourceKey: string, destPrefix: string): string {
  const base = destPrefix.replace(/\/+$/, '');
  const rel = sourceKey.replace(/^\/+/, '');
  return base.length > 0 ? `${base}/${rel}` : rel;
}

export type DeliverAssetObjectArgs = {
  source: DeliverySource;
  target: DeliveryTarget;
  // Bound for the whole operation; defaults to `deliveryTimeoutMs()`.
  timeoutMs?: number;
};

// Deliver one existing object to the destination and report, truthfully,
// whether it landed.
//
// Sequence (each step is a precondition for the next, so a failure never
// produces a half-reported success):
//   1. PROBE the destination bucket with this client's credentials. This is the
//      issue #209 pre-flight applied to delivery (`bucketExists` is
//      authoritative for a plain `bucket/prefix/` destination — see the
//      pre-flight comment at src/routes/assets.ts:2500-2544), and it is what
//      turns "we cannot write there" into a clear refusal rather than a copy
//      that fails opaquely.
//   2. STAT the source, so we never copy-and-claim-success for an object that
//      is not there (an asset document can outlive its bytes).
//   3. COPY server-side.
//   4. RE-READ the destination object and compare its byte count against the
//      source's. Only then is the delivery a success. Sizes are compared and
//      etags are NOT: a multipart-uploaded object's etag is not a plain content
//      hash, so an etag comparison would reject correct copies.
export async function deliverAssetObject(
  client: DeliveryObjectClient,
  args: DeliverAssetObjectArgs
): Promise<DeliveryOutcome> {
  const timeoutMs = args.timeoutMs ?? deliveryTimeoutMs();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      runDelivery(client, args),
      new Promise<DeliveryOutcome>((resolve) => {
        timer = setTimeout(
          () =>
            resolve({
              ok: false,
              reason: 'timeout',
              message: `delivery to "${args.target.bucket}" did not complete within ${timeoutMs}ms; the object's presence at the destination could not be confirmed`
            }),
          timeoutMs
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function runDelivery(
  client: DeliveryObjectClient,
  args: DeliverAssetObjectArgs
): Promise<DeliveryOutcome> {
  const { source, target } = args;

  // 1. Destination reachable/writable with the credentials we hold?
  let reachable = false;
  try {
    reachable = await client.bucketExists(target.bucket);
  } catch (err) {
    // A probe failure (network / credential / policy error) means we cannot
    // confirm the destination is usable, so we refuse rather than copy blind —
    // the same treatment the #209 pre-flight gives a failed probe
    // (src/routes/assets.ts:2525-2534).
    return {
      ok: false,
      reason: 'destination_unreachable',
      message: `destination bucket "${target.bucket}" could not be verified with the configured storage credentials: ${errMessage(err)}`
    };
  }
  if (!reachable) {
    return {
      ok: false,
      reason: 'destination_unreachable',
      message: `destination bucket "${target.bucket}" is not reachable with the configured storage credentials`
    };
  }

  // 2. Source object actually present?
  let sourceStat: { size: number; etag: string } | undefined;
  try {
    sourceStat = await client.statObject(source.bucket, source.key);
  } catch (err) {
    if (isNotFound(err)) {
      return {
        ok: false,
        reason: 'source_missing',
        message: `source object "${source.key}" is not present in bucket "${source.bucket}"; nothing was delivered`
      };
    }
    return {
      ok: false,
      reason: 'copy_failed',
      message: `source object "${source.key}" could not be read from bucket "${source.bucket}": ${errMessage(err)}`
    };
  }
  if (!sourceStat) {
    return {
      ok: false,
      reason: 'source_missing',
      message: `source object "${source.key}" is not present in bucket "${source.bucket}"; nothing was delivered`
    };
  }
  if (sourceStat.size > SINGLE_COPY_MAX_BYTES) {
    return {
      ok: false,
      reason: 'source_too_large',
      message: `source object is ${sourceStat.size} bytes, above the ${SINGLE_COPY_MAX_BYTES}-byte single-copy limit for a direct delivery`
    };
  }

  // 3. Server-side copy. Bytes never transit this process.
  const destKey = deliveredKeyFor(source.key, target.prefix);
  try {
    await client.copyObject(target.bucket, destKey, `/${source.bucket}/${source.key}`);
  } catch (err) {
    return {
      ok: false,
      reason: 'copy_failed',
      message: `copying "${source.key}" to "${target.bucket}/${destKey}" failed: ${errMessage(err)}`
    };
  }

  // 4. Verify the object is really AT the destination before claiming success.
  let landed: { size: number; etag: string } | undefined;
  try {
    landed = await client.statObject(target.bucket, destKey);
  } catch (err) {
    if (isNotFound(err)) {
      landed = undefined;
    } else {
      return {
        ok: false,
        reason: 'not_landed',
        message: `the copy of "${source.key}" to "${target.bucket}/${destKey}" could not be verified: ${errMessage(err)}`
      };
    }
  }
  if (!landed) {
    return {
      ok: false,
      reason: 'not_landed',
      message: `the store reported the copy succeeded but no object is present at "${target.bucket}/${destKey}"`
    };
  }
  if (landed.size !== sourceStat.size) {
    return {
      ok: false,
      reason: 'not_landed',
      message: `the object at "${target.bucket}/${destKey}" is ${landed.size} bytes but the source is ${sourceStat.size} bytes; the delivery is incomplete`
    };
  }

  return {
    ok: true,
    bucket: target.bucket,
    objectKey: destKey,
    bytes: landed.size,
    etag: landed.etag
  };
}

// Why a destination that declares its OWN endpoint cannot be delivered to by
// this API, and why that has to be a refusal rather than an attempt.
//
// A registered destination keeps its secret access key in OSC per-service
// secrets (ADR-017 D1 / ADR-018 D1): the registry persists only the NON-SECRET
// record (`StorageBackendRecord`, src/services/storage-backend-registry.ts:
// 82-110 — no secretAccessKey field) and fans the secret out to the consuming
// services' secret stores. The OSC client SDK exposes a WRITE-ONLY secret API —
// `saveSecret(serviceId, name, value, ctx)` and no read
// (node_modules/@osaas/client-core/lib/core.d.ts:154, exports at
// lib/index.d.ts:6) — so this process cannot reconstruct a credential for a
// foreign endpoint, and `resolveForOutput` deliberately returns the non-secret
// record only (storage-backend-registry.ts:1019-1052).
//
// The only credential the API itself holds is the one its own object-storage
// client is built with (`WorkspaceConnections.s3Config`,
// src/services/workspace-stack.ts:152). So a delivery can only be performed
// against that store — which is exactly the reading the registry already
// encodes: `resolveDestinationBucket` returns the PLAIN `bucket/prefix/` form
// (storage-backend-registry.ts:992-997), the form the #209 pre-flight treats as
// "a bucket on the configured client"
// (src/routes/assets.ts:2508-2515), whereas an externally-credentialed backend
// is rendered as an `s3://…` URI precisely so it is NOT probed against that
// client (`backendOutputDestination`, storage-backend-registry.ts:1055-1072).
//
// Attempting the copy anyway would be WORSE than refusing: a bucket of the same
// literal name on our own store would accept the copy and verify clean, so we
// would report a success for bytes that never reached the operator's endpoint —
// the same class of indistinguishable cross-endpoint confusion issue #1058
// refuses to submit a transcode for (src/routes/assets.ts:2340-2358). #1131
// requires a truthful terminal status, so an unverifiable endpoint claim is
// refused up front.
//
// Returns a human-readable reason to refuse, or undefined when delivery may
// proceed (the destination makes no endpoint claim, or it names the same
// host:port our own client is authenticated against).
export function destinationEndpointRefusal(
  destinationEndpointUrl: string | undefined,
  deploymentStorageEndpoint: string | undefined
): string | undefined {
  if (destinationEndpointUrl === undefined || destinationEndpointUrl.length === 0) {
    return undefined;
  }
  const claimed = endpointAuthority(destinationEndpointUrl);
  const ours = deploymentStorageEndpoint ? endpointAuthority(deploymentStorageEndpoint) : undefined;
  if (claimed !== undefined && ours !== undefined && claimed === ours) {
    return undefined;
  }
  return (
    `destination is registered at endpoint "${destinationEndpointUrl}", which this API holds no credentials for ` +
    `(a destination's secret access key is stored write-only in OSC per-service secrets and cannot be read back), ` +
    `so a delivery there cannot be performed or verified from here`
  );
}

// The comparable authority (lowercased host plus explicit port) of a storage
// endpoint. Accepts a bare `host:port` as well as a full URL, because both
// forms occur: `StackConfig.minioEndpoint` is a URL and an operator-registered
// `endpointUrl` is validated as a URL (`registerDestinationSchema`,
// src/routes/export-destinations.ts:157), while env overrides may be bare
// hosts. Returns undefined when the value cannot be parsed at all, so callers
// treat it as "not comparable" rather than guessing a match.
function endpointAuthority(endpoint: string): string | undefined {
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(endpoint) ? endpoint : `https://${endpoint}`;
  try {
    const url = new URL(candidate);
    if (url.hostname.length === 0) return undefined;
    return url.port.length > 0
      ? `${url.hostname.toLowerCase()}:${url.port}`
      : url.hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

// A missing object, as reported by the S3/MinIO client. Same codes the
// WorkspaceStorage stat wrapper (src/data/storage.ts:146-156) and the archive
// tier's `statOrUndefined` (src/pipeline/archive-tier-relocation.ts:309-323)
// treat as absence.
function isNotFound(err: unknown): boolean {
  const code = (err as { code?: string } | null)?.code;
  return code === 'NotFound' || code === 'NoSuchKey';
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
