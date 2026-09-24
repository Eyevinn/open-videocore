// Structured failure-cause codes for ingest upload errors (issue #771).
//
// WHY
// ---
// Until now an upload failure reached the caller as a bare HTTP status (most
// visibly a 413) plus a free-text message, so a client could not tell WHY the
// upload failed: a body-size limit, a broken connection, or the storage backend
// rejecting the write all looked alike. The ops UI could therefore only print
// "Upload failed: HTTP 413".
//
// This module defines the machine-readable `cause` code that every error
// response from the upload surface now carries, plus the classifier that maps
// the failure paths that actually exist in the current routing onto it.
//
// CONTRACT SOURCES VERIFIED (no guessing — CLAUDE.md rule 7)
// ---------------------------------------------------------
//   - The upload surface and its current error responses:
//       src/routes/asset-upload.ts — `errorSchema` (error/message), the 413
//       `payload_too_large` reply in the PUT /:id/upload handler, the 404
//       `not_found` / 501 `not_configured` replies on every storage-backed
//       handler, and the router `setErrorHandler` mapping WorkspaceAccessError
//       -> 403 forbidden, InvalidStateTransitionError -> 422
//       invalid_state_transition, QuotaExceededError -> 409 quota_exceeded.
//   - The transports a failure can occur on, post-#747/#758:
//       public/upload.js — `chooseUploadStrategy` routes by size to the proxied
//       PUT /:id/upload (stream), the single presigned PUT (presigned), or the
//       multipart part PUTs (multipart).
//   - Oversize stream cap: src/data/storage.ts `SourceTooLargeError`
//     (statusCode = 413, raised from `WorkspaceStorage.putStream` when the
//     streamed body passes `maxBytes`).
//   - Total-cap rejection: src/data/storage-quota.ts `QuotaExceededError`
//     (statusCode = 409, `reason = 'quota_exceeded'`).
//   - Framework body-limit rejection: node_modules/fastify/lib/errors.js:105-110
//     `FST_ERR_CTP_BODY_TOO_LARGE` — createError(code, msg, 413, RangeError).
//   - S3/MinIO error shape: node_modules/minio/dist/main/errors.d.ts
//     `class S3Error extends ExtendableError { code?: string; region?: string }`
//     — the non-secret S3 error code (e.g. 'NoSuchUpload', 'AccessDenied') is on
//     `.code`; transport failures instead surface Node errno-style codes.
//   - Prior art for the shape (machine-readable sub-code + secret-free message +
//     optional underlying `code`): src/routes/storage.ts `validationErrorSchema`
//     and src/services/external-backend-validation.ts `ValidationFailureReason`
//     / `isUnreachable` (whose errno list this module reuses).
//
// FIELD NAME: the response field is `cause`, matching the issue's
// "failure-cause code" wording. The sibling `reason` field used by
// `backend_validation_failed` (routes/storage.ts) is a sub-code of ONE error
// envelope; `cause` here is cross-cutting — it is present on EVERY error body
// the upload surface returns, whatever the `error` code is. The two do not
// overlap on any route.

import { z } from 'zod';
import { SourceTooLargeError } from '../data/storage.js';
import { QuotaExceededError } from '../data/storage-quota.js';

// ─── The cause-code enum ────────────────────────────────────────────────────
//
// Stable snake_case identifiers. A client MUST treat an unrecognised value as
// `unknown` (forward compatibility) rather than failing to render.
export const uploadFailureCauseSchema = z.enum([
  // A body-size limit rejected the payload: the route's own 10 GiB stream cap
  // (SourceTooLargeError), Fastify's `bodyLimit`
  // (FST_ERR_CTP_BODY_TOO_LARGE), or — for the proxied PUT /:id/upload path —
  // an upstream proxy's own request-body limit. The proxy variant never reaches
  // this process (see the client note in public/upload.js), so the client maps
  // a bodiless 413 onto this same code.
  'body_size_limit_exceeded',
  // The connection carrying the bytes broke or could not be established:
  // the client disconnected mid-stream, or the API could not reach the object
  // storage endpoint (DNS/TCP/TLS). Retryable.
  'network_error',
  // The storage backend was reached but refused or failed the operation — an
  // S3-level error such as AccessDenied, NoSuchBucket, NoSuchUpload or
  // InvalidPart. The non-secret S3 code is echoed in `code`.
  'storage_backend_error',
  // No object storage is wired on this deployment (the 501 `not_configured`
  // degradation every storage-backed upload handler already returns).
  'storage_not_configured',
  // The deployment-wide storage cap would be exceeded (409 quota_exceeded).
  'quota_exceeded',
  // No such asset in the caller's workspace (404 — never leaks existence).
  'asset_not_found',
  // The asset is not in a state that allows this upload step (422).
  'invalid_asset_state',
  // The caller may not touch this asset/workspace (403).
  'not_authorized',
  // An upload failure that could not be classified. Reserved so clients always
  // have a defined fallback branch.
  'unknown'
]);

export type UploadFailureCause = z.infer<typeof uploadFailureCauseSchema>;

// The error body every upload route returns on failure. `error` and `message`
// are UNCHANGED from the pre-#771 shape (src/routes/asset-upload.ts
// `errorSchema`), so existing consumers keep working; `cause` is the new
// required machine-readable discriminator and `code` optionally carries the
// non-secret underlying S3/errno code for diagnostics.
export const uploadErrorSchema = z.object({
  error: z.string(),
  cause: uploadFailureCauseSchema,
  message: z.string().optional(),
  code: z.string().optional()
});

export type UploadErrorBody = z.infer<typeof uploadErrorSchema>;

// HTTP status for each cause. The four pre-existing mappings (413/409/404/422,
// plus 501 and 403) are preserved exactly; the two genuinely new causes are
// 502 Bad Gateway, because both describe an upstream (object storage) failure
// rather than a fault in the caller's request.
export const UPLOAD_FAILURE_STATUS: Record<UploadFailureCause, number> = {
  body_size_limit_exceeded: 413,
  network_error: 502,
  storage_backend_error: 502,
  storage_not_configured: 501,
  quota_exceeded: 409,
  asset_not_found: 404,
  invalid_asset_state: 422,
  not_authorized: 403,
  unknown: 500
};

// The `error` code paired with each cause. These preserve the exact strings the
// upload routes already returned (asset-upload.ts) so no existing client that
// branches on `error` regresses.
export const UPLOAD_FAILURE_ERROR_CODE: Record<UploadFailureCause, string> = {
  body_size_limit_exceeded: 'payload_too_large',
  network_error: 'storage_unreachable',
  storage_backend_error: 'storage_error',
  storage_not_configured: 'not_configured',
  quota_exceeded: 'quota_exceeded',
  asset_not_found: 'not_found',
  invalid_asset_state: 'invalid_state_transition',
  not_authorized: 'forbidden',
  unknown: 'upload_failed'
};

// A classified upload failure, ready to be turned into an HTTP response by the
// router's error handler. Mirrors DependencyUnreachableError's
// `toResponseBody()` precedent (src/encore-scaler/dependency-timeout.ts): the
// underlying error is kept for the server-side log but never serialised.
//
// NOTE: the machine-readable code lives on `failureCause`, not `cause` — the
// latter is the standard ES2022 Error field and is reserved here for the
// underlying error, exactly as DependencyUnreachableError uses it.
export class UploadFailureError extends Error {
  readonly failureCause: UploadFailureCause;
  readonly statusCode: number;
  readonly errorCode: string;
  // Non-secret underlying S3 error code or Node errno (e.g. 'NoSuchUpload',
  // 'ECONNREFUSED') when one was available. Never a credential.
  readonly detailCode?: string;
  // The storage operation that failed, for the server-side log only.
  readonly operation?: string;

  constructor(
    failureCause: UploadFailureCause,
    message: string,
    opts: { detailCode?: string; operation?: string; errorCode?: string; cause?: unknown } = {}
  ) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'UploadFailureError';
    this.failureCause = failureCause;
    this.statusCode = UPLOAD_FAILURE_STATUS[failureCause];
    this.errorCode = opts.errorCode ?? UPLOAD_FAILURE_ERROR_CODE[failureCause];
    this.detailCode = opts.detailCode;
    this.operation = opts.operation;
  }

  toResponseBody(): UploadErrorBody {
    return {
      error: this.errorCode,
      cause: this.failureCause,
      message: this.message,
      ...(this.detailCode ? { code: this.detailCode } : {})
    };
  }
}

export function isUploadFailureError(err: unknown): err is UploadFailureError {
  return err instanceof UploadFailureError;
}

// Pull the non-secret error code off a thrown error. minio puts the S3 error
// code on `.code` (S3Error, node_modules/minio/dist/main/errors.d.ts) and Node
// puts the errno there for transport failures — same field, both cases.
function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

// Codes that mean "the bytes never made it over the wire" rather than "the
// store answered with an error". The endpoint half of this list is reused
// verbatim from src/services/external-backend-validation.ts `isUnreachable`
// (same minio/undici client, same failure modes); the stream half covers the
// OTHER end of the proxied PUT — the caller hanging up mid-body, which surfaces
// on the request stream we pipe into storage.
const CONNECTION_ERROR_CODES = new Set([
  // endpoint unreachable (external-backend-validation.ts `isUnreachable`)
  'ENOTFOUND',
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_SOCKET',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  // caller hung up / socket died mid-transfer
  'ECONNABORTED',
  'EPIPE',
  'ERR_STREAM_PREMATURE_CLOSE',
  'ERR_STREAM_DESTROYED',
  'ABORT_ERR'
]);

export function isConnectionError(err: unknown): boolean {
  const code = errorCode(err);
  if (!code) {
    // An aborted request surfaces as a plain Error named 'AbortError' with no
    // errno (Node/undici), so fall back to the name for that one case.
    return (err as { name?: unknown } | null)?.name === 'AbortError';
  }
  return (
    CONNECTION_ERROR_CODES.has(code) || code.startsWith('ERR_TLS') || code.startsWith('CERT_')
  );
}

// Whether a thrown error is Fastify's request-body-limit rejection. Verified
// against node_modules/fastify/lib/errors.js:105-110 (FST_ERR_CTP_BODY_TOO_LARGE,
// status 413).
export function isBodyLimitError(err: unknown): boolean {
  return errorCode(err) === 'FST_ERR_CTP_BODY_TOO_LARGE';
}

// Classify any error thrown at (or on the way to) the storage boundary into a
// structured upload failure.
//
// Ordering matters: the explicit domain errors are matched first, then the
// transport check, and only then does an unrecognised failure become
// `storage_backend_error` — the accurate default for something that went wrong
// inside a storage call that DID reach the store.
export function classifyUploadFailure(err: unknown, operation?: string): UploadFailureError {
  if (isUploadFailureError(err)) {
    return err;
  }
  // The streamed body passed the route's byte cap (data/storage.ts
  // SourceTooLargeError, statusCode 413).
  if (err instanceof SourceTooLargeError) {
    return new UploadFailureError('body_size_limit_exceeded', err.message, { operation, cause: err });
  }
  // Fastify rejected the body before the handler ever ran.
  if (isBodyLimitError(err)) {
    return new UploadFailureError(
      'body_size_limit_exceeded',
      (err as Error).message,
      { operation, detailCode: 'FST_ERR_CTP_BODY_TOO_LARGE', cause: err }
    );
  }
  // The deployment-wide cap refused the bytes (storage-quota.ts
  // QuotaExceededError, statusCode 409, reason 'quota_exceeded').
  if (err instanceof QuotaExceededError) {
    return new UploadFailureError('quota_exceeded', err.message, {
      errorCode: err.reason,
      operation,
      cause: err
    });
  }
  const code = errorCode(err);
  if (isConnectionError(err)) {
    return new UploadFailureError(
      'network_error',
      operation
        ? `the connection carrying the upload failed during ${operation}`
        : 'the connection carrying the upload failed',
      { ...(code ? { detailCode: code } : {}), operation, cause: err }
    );
  }
  return new UploadFailureError(
    'storage_backend_error',
    operation
      ? `the storage backend rejected or failed the upload during ${operation}`
      : 'the storage backend rejected or failed the upload',
    { ...(code ? { detailCode: code } : {}), operation, cause: err }
  );
}

// Run a storage call and rethrow any failure as a classified UploadFailureError,
// so every failure that crosses the storage boundary reaches the caller with a
// cause code instead of a bare 500. Errors raised OUTSIDE a storage call are
// deliberately NOT funnelled through here — they keep bubbling to the app-level
// handler as a genuine 500, so a bug in our own code is never mislabelled as a
// storage failure.
export async function viaStorage<T>(operation: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw classifyUploadFailure(err, operation);
  }
}
