// Registration-time reachability + permission validation for external
// S3-compatible storage backends (issue #550, parent #524 open question 4).
//
// Catches a misconfigured endpoint / bad credentials / insufficient bucket
// permissions at REGISTRATION time rather than surfacing them later at ingest
// or job time. The probe is deliberately NON-DESTRUCTIVE and REVERSIBLE: it
// only ever writes, reads, and then removes a single tiny object under a
// reserved, namespaced probe key — it never touches any pre-existing object in
// the target bucket.
//
// PRIOR ART cited + reused:
//   - S3-compatible access is done through the `minio` client exactly as the
//     rest of the codebase does (services/workspace-stack.ts:172-180 builds a
//     MinioClient from an endpoint URL + credentials; data/storage.ts wraps the
//     same client for statObject / putObject / removeObject / listObjectsV2).
//     We reuse that client construction + method contract verified against
//     node_modules/minio/dist/main/internal/client.d.ts (ClientOptions:42-56 —
//     endPoint/port/useSSL/accessKey/secretKey/region/sessionToken;
//     bucketExists:207, listObjectsV2, putObject:291, statObject:239,
//     removeObject:240).
//   - The injectable-deps + machine-readable-outcome shape mirrors the
//     reachability self-check in services/profiles-reachability.ts
//     (checkProfilesIndexReachable -> a discriminated ReachabilityOutcome, with
//     an injected fetch so it is testable without live network I/O). Here the
//     seam is an injected S3-probe-client factory so this check is unit-testable
//     without a live bucket.
//
// OUT OF SCOPE (issue #550) — FOLLOW-UP: watch-folder event-notification
// CAPABILITY detection for external buckets. This probe validates reachability +
// read/list/write permissions only; it does NOT detect whether the external
// bucket can emit the object-created events the watch-folder ingest path
// (pipeline/watch-folder.ts) relies on. External S3-compatible stores vary in
// whether/how they expose bucket notifications, so capability detection is
// deferred to a dedicated follow-up issue rather than bundled here.
//
// SECRET HYGIENE: the secretAccessKey / sessionToken are consumed only to build
// the probe client and are NEVER placed in any returned result, reason string,
// or thrown error (mirrors the redaction discipline in
// storage-backend-registry.ts). Error messages carry only the S3 error CODE and
// a redacted, non-secret summary of the failing operation.

import { Client as MinioClient } from 'minio';
import { Readable } from 'node:stream';

// The non-secret + secret coordinates needed to reach the target bucket. Mirrors
// RegisterBackendInput (storage-backend-registry.ts:140-150) minus the
// registry-only fields (name/role/publicBaseUrl), so the registry can hand the
// same request block straight through.
export type ExternalBackendProbeTarget = {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region?: string;
  endpointUrl?: string;
  sessionToken?: string;
};

// A minimal, NON-DESTRUCTIVE probe surface over an S3-compatible bucket. Only
// the four operations the permission probe needs, so a test double never has to
// implement the whole minio Client. Production wires a real MinioClient (which
// structurally satisfies this) via defaultProbeClientFactory.
export interface BucketProbeClient {
  // Connectivity + read/authz signal: a bucket HEAD. Reachability failure or a
  // credential/permission failure both surface here first.
  bucketExists(bucketName: string): Promise<boolean>;
  // List permission probe. Returns an object-key stream; we only need to know
  // the LIST call is authorized, so the caller drains at most one event.
  listObjectsV2(
    bucketName: string,
    prefix?: string,
    recursive?: boolean
  ): import('node:stream').Readable;
  // Write permission probe (reversible): PUT the single probe object.
  putObject(
    bucketName: string,
    objectName: string,
    stream: Readable | Buffer | string,
    size?: number
  ): Promise<unknown>;
  // Read-back of the probe object we just wrote (confirms read permission on an
  // object we own, without reading any pre-existing object).
  statObject(bucketName: string, objectName: string): Promise<unknown>;
  // Reverses the write probe: DELETE the probe object so the bucket is left
  // exactly as it was found.
  removeObject(bucketName: string, objectName: string): Promise<void>;
}

// Machine-readable failure reason codes. Stable, snake_case identifiers a caller
// (or the router) can branch on without parsing a human string. Ordered from
// coarsest (cannot reach / authenticate) to finest (a specific permission).
export type ValidationFailureReason =
  | 'unreachable' // network/DNS/TLS/connection failure reaching the endpoint
  | 'unauthorized' // credentials rejected (auth failed)
  | 'bucket_not_found' // reached + authenticated, but the bucket does not exist
  | 'forbidden_list' // LIST permission denied
  | 'forbidden_write' // PUT permission denied
  | 'forbidden_read' // read-back (stat) permission denied
  | 'probe_cleanup_failed' // write succeeded but the probe object could not be removed
  | 'unknown'; // an S3 error we could not classify

// The check result. Discriminated on `ok` (mirrors ReachabilityOutcome,
// profiles-reachability.ts:121-124). On failure it carries a machine-readable
// `reason` plus a redacted, secret-free `message` and the raw S3 error `code`
// (never the secret). On success it reports which capabilities were confirmed.
export type ExternalBackendValidationResult =
  | {
      ok: true;
      checks: { reachable: true; list: boolean; write: boolean; read: boolean };
    }
  | {
      ok: false;
      reason: ValidationFailureReason;
      // Secret-free human summary. Safe to log / return to the caller.
      message: string;
      // The underlying S3/HTTP error code when one was available (e.g.
      // 'AccessDenied', 'NoSuchBucket', 'InvalidAccessKeyId'). Never a secret.
      code?: string;
    };

// Injectable factory so the probe is unit-testable without a live bucket
// (mirrors the injected FetchLike in profiles-reachability.ts:67-70). Production
// defaults to defaultProbeClientFactory, which builds a real MinioClient.
export type ProbeClientFactory = (target: ExternalBackendProbeTarget) => BucketProbeClient;

// Build a real minio-backed probe client from the target coordinates, exactly as
// workspace-stack.ts:172-180 constructs its MinioClient (endpoint URL -> host /
// port / useSSL). endpointUrl is optional for AWS-native S3; when absent the
// minio client falls back to its AWS default endpoint (s3.amazonaws.com), which
// is the same shape the credential mapping already tolerates
// (external-storage-credentials.ts:99 leaves s3Endpoint unset for AWS-native).
export function defaultProbeClientFactory(target: ExternalBackendProbeTarget): BucketProbeClient {
  const opts: ConstructorParameters<typeof MinioClient>[0] = target.endpointUrl
    ? (() => {
        const url = new URL(target.endpointUrl as string);
        const useSSL = url.protocol === 'https:';
        return {
          endPoint: url.hostname,
          port: url.port ? Number(url.port) : useSSL ? 443 : 80,
          useSSL,
          accessKey: target.accessKeyId,
          secretKey: target.secretAccessKey,
          ...(target.region ? { region: target.region } : {}),
          ...(target.sessionToken ? { sessionToken: target.sessionToken } : {})
        };
      })()
    : {
        // AWS-native default endpoint (no explicit endpointUrl).
        endPoint: 's3.amazonaws.com',
        useSSL: true,
        accessKey: target.accessKeyId,
        secretKey: target.secretAccessKey,
        ...(target.region ? { region: target.region } : {}),
        ...(target.sessionToken ? { sessionToken: target.sessionToken } : {})
      };
  return new MinioClient(opts);
}

// A reserved, clearly-labelled key prefix for the reversible write probe. Using
// a fixed, self-describing prefix keeps the probe object trivially identifiable
// (and removable) and avoids any collision with real content keys.
const PROBE_KEY_PREFIX = '.openvideocore-registration-probe/';

// The tiny payload written by the write probe. Content is irrelevant; kept
// minimal so the probe transfers a handful of bytes.
const PROBE_PAYLOAD = 'openvideocore-registration-probe';

// Extract a non-secret S3/HTTP error code from a thrown minio error. minio
// surfaces the S3 error code on `.code` (see data/storage.ts:97,459-461, which
// already branches on err.code). Returns undefined when no code is present.
function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

// S3 error codes that unambiguously mean the credentials were rejected.
const AUTH_CODES = new Set([
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'InvalidToken',
  'ExpiredToken',
  'TokenRefreshRequired',
  'AuthorizationHeaderMalformed'
]);

// S3 error codes that mean the bucket does not exist.
const NOT_FOUND_CODES = new Set(['NoSuchBucket', 'NotFound']);

// Whether a thrown error looks like a transport/connection failure (endpoint
// unreachable) rather than an S3-level error response. minio/undici surface
// these as Node system errors with an errno-style `code` and NO S3 error body.
function isUnreachable(err: unknown): boolean {
  const code = errorCode(err);
  if (!code) return false;
  return (
    code === 'ENOTFOUND' ||
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'EAI_AGAIN' ||
    code === 'UND_ERR_CONNECT_TIMEOUT' ||
    code.startsWith('ERR_TLS') ||
    code.startsWith('CERT_') ||
    code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
  );
}

// Drain at most one event from a minio object-listing stream to confirm the
// LIST call itself is authorized, then destroy the stream. Resolves true on
// 'data'/'end' (list authorized), rejects on 'error' (so the caller can
// classify AccessDenied vs. other). Mirrors the stream-draining pattern in
// data/storage.ts:224-236 / routes/storage.ts:467-498 but bounded to one event.
function probeList(client: BucketProbeClient, bucket: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const stream = client.listObjectsV2(bucket, PROBE_KEY_PREFIX, false);
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      stream.destroy();
      resolve();
    };
    stream.on('data', done);
    stream.on('end', done);
    stream.on('error', (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    });
  });
}

// Perform the registration-time reachability + permission validation.
//
// Sequence (each step is the minimal probe for one capability):
//   1. bucketExists  — connectivity + authentication + bucket existence.
//   2. listObjectsV2 — LIST permission (bounded to one event).
//   3. putObject     — WRITE permission (reversible: reserved probe key).
//   4. statObject    — READ permission (of the object we just wrote).
//   5. removeObject  — REVERSE the write probe (leave the bucket unchanged).
//
// Never performs a destructive operation on any pre-existing object. Never
// leaks the secret: only the S3 error code + a redacted summary reach the
// result. On any failure the function returns a machine-readable result rather
// than throwing, so the caller can decide whether to refuse registration or
// mark the backend degraded (issue #550 acceptance).
export async function validateExternalBackend(
  target: ExternalBackendProbeTarget,
  deps: { probeClientFactory?: ProbeClientFactory } = {}
): Promise<ExternalBackendValidationResult> {
  const factory = deps.probeClientFactory ?? defaultProbeClientFactory;

  let client: BucketProbeClient;
  try {
    client = factory(target);
  } catch (err) {
    // A malformed endpointUrl (bad URL) lands here.
    return {
      ok: false,
      reason: 'unreachable',
      message: 'could not construct a client for the external backend endpoint',
      ...(errorCode(err) ? { code: errorCode(err) } : {})
    };
  }

  // 1. Connectivity + auth + existence.
  try {
    const exists = await client.bucketExists(target.bucket);
    if (!exists) {
      return {
        ok: false,
        reason: 'bucket_not_found',
        message: 'the external backend was reachable and authenticated, but the bucket does not exist'
      };
    }
  } catch (err) {
    if (isUnreachable(err)) {
      return {
        ok: false,
        reason: 'unreachable',
        message: 'the external backend endpoint could not be reached',
        ...(errorCode(err) ? { code: errorCode(err) } : {})
      };
    }
    const code = errorCode(err);
    if (code && AUTH_CODES.has(code)) {
      return {
        ok: false,
        reason: 'unauthorized',
        message: 'the external backend rejected the supplied credentials',
        code
      };
    }
    if (code && NOT_FOUND_CODES.has(code)) {
      return {
        ok: false,
        reason: 'bucket_not_found',
        message: 'the external backend bucket does not exist',
        code
      };
    }
    if (code === 'AccessDenied') {
      // Reached + (usually) authenticated, but not allowed to HEAD the bucket.
      return {
        ok: false,
        reason: 'unauthorized',
        message: 'the supplied credentials are not authorized for the external bucket',
        code
      };
    }
    return classifyUnknown(err, 'connectivity check');
  }

  // 2. LIST permission.
  let listOk = false;
  try {
    await probeList(client, target.bucket);
    listOk = true;
  } catch (err) {
    const code = errorCode(err);
    if (code === 'AccessDenied' || code === 'Forbidden') {
      return {
        ok: false,
        reason: 'forbidden_list',
        message: 'the supplied credentials lack list permission on the external bucket',
        code
      };
    }
    return classifyUnknown(err, 'list permission probe');
  }

  // 3. WRITE permission (reversible probe object under the reserved prefix).
  const probeKey = `${PROBE_KEY_PREFIX}${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let writeOk = false;
  try {
    await client.putObject(
      target.bucket,
      probeKey,
      Buffer.from(PROBE_PAYLOAD),
      Buffer.byteLength(PROBE_PAYLOAD)
    );
    writeOk = true;
  } catch (err) {
    const code = errorCode(err);
    if (code === 'AccessDenied' || code === 'Forbidden') {
      return {
        ok: false,
        reason: 'forbidden_write',
        message: 'the supplied credentials lack write permission on the external bucket',
        code
      };
    }
    return classifyUnknown(err, 'write permission probe');
  }

  // 4. READ permission (of the object we just wrote — never a pre-existing one).
  let readOk = false;
  let readErr: unknown;
  try {
    await client.statObject(target.bucket, probeKey);
    readOk = true;
  } catch (err) {
    readErr = err;
  }

  // 5. REVERSE the write probe unconditionally, so the bucket is left as found.
  try {
    await client.removeObject(target.bucket, probeKey);
  } catch (err) {
    // Write succeeded but we could not clean up: surface it so the operator can
    // remove the stray probe object. This is the only path that could leave a
    // (clearly-labelled, tiny) artifact behind.
    return {
      ok: false,
      reason: 'probe_cleanup_failed',
      message: `wrote a registration probe object but could not remove it (key prefix "${PROBE_KEY_PREFIX}"); please delete it manually`,
      ...(errorCode(err) ? { code: errorCode(err) } : {})
    };
  }

  if (!readOk) {
    const code = errorCode(readErr);
    if (code === 'AccessDenied' || code === 'Forbidden') {
      return {
        ok: false,
        reason: 'forbidden_read',
        message: 'the supplied credentials lack read permission on the external bucket',
        code
      };
    }
    return classifyUnknown(readErr, 'read permission probe');
  }

  return { ok: true, checks: { reachable: true, list: listOk, write: writeOk, read: readOk } };
}

// Fallback classifier for an S3 error we did not explicitly branch on. Never
// includes the secret — only the S3 code and a redacted operation label.
function classifyUnknown(
  err: unknown,
  operation: string
): Extract<ExternalBackendValidationResult, { ok: false }> {
  const code = errorCode(err);
  return {
    ok: false,
    reason: 'unknown',
    message: `the external backend ${operation} failed with an unclassified error`,
    ...(code ? { code } : {})
  };
}
