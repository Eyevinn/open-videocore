// Structured failure-cause codes on ingest upload errors (issue #771).
//
// Before #771 an upload failure reached the caller as a bare status (413) or,
// for anything raised inside a storage call, an unstructured 500 — so the UI
// could not tell "too big" from "connection died" from "the store said no".
// These tests pin the new contract end to end:
//
//   1. the classifier maps each real failure path onto its cause code, and
//   2. the upload routes actually return `{ error, cause, message?, code? }`
//      with the right status for every one of those paths.
//
// ─── Contract sources verified (no guessing, CLAUDE.md rule 7) ───────────────
//   - Enum + envelope + status/error mapping:
//       src/routes/upload-failure-cause.ts — `uploadFailureCauseSchema`,
//       `uploadErrorSchema`, `UPLOAD_FAILURE_STATUS`, `UPLOAD_FAILURE_ERROR_CODE`,
//       `classifyUploadFailure`, `viaStorage`, `UploadFailureError`.
//   - The routes under test and their storage calls:
//       src/routes/asset-upload.ts — PUT /:id/upload (putStream),
//       POST /:id/upload-url (presignedPut), POST /:id/multipart/initiate
//       (initiateMultipartUpload), GET /:id/multipart/:uploadId/part-url
//       (presignedUploadPart), POST /:id/multipart/:uploadId/complete
//       (completeMultipartUpload), DELETE /:id/multipart/:uploadId
//       (abortMultipartUpload), POST /:id/upload-complete (statObject).
//   - Oversize cap: src/data/storage.ts `SourceTooLargeError` (statusCode 413).
//   - Total cap: src/data/storage-quota.ts `QuotaExceededError`
//     (statusCode 409, reason 'quota_exceeded').
//   - Fastify body-limit code: node_modules/fastify/lib/errors.js:105-110
//     `FST_ERR_CTP_BODY_TOO_LARGE`.
//   - S3 error code field: node_modules/minio/dist/main/errors.d.ts
//     `class S3Error { code?: string }`.
//   - App wiring for the octet-stream body parser mirrors
//     src/routes/asset-upload.quota.test.ts buildApp().

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetUploadRouter } from '../src/routes/asset-upload.js';
import {
  classifyFrameworkError,
  classifyUploadFailure,
  isConnectionError,
  uploadErrorSchema,
  uploadFailureCauseSchema,
  UploadFailureError,
  UPLOAD_FAILURE_STATUS,
  viaStorage
} from '../src/routes/upload-failure-cause.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { SourceTooLargeError, type WorkspaceStorage } from '../src/data/storage.js';
import { QuotaExceededError } from '../src/data/storage-quota.js';

// An error shaped like the ones minio throws: the S3 error code (or a Node
// errno for transport failures) on `.code`.
function codedError(message: string, code: string): Error & { code: string } {
  const err = new Error(message) as Error & { code: string };
  err.code = code;
  return err;
}

// A WorkspaceStorage stand-in whose every method rejects with the supplied
// error, so each route's storage boundary can be failed in isolation.
function failingStorage(err: unknown, only?: string): WorkspaceStorage {
  const boom = (name: string) => async () => {
    if (!only || only === name) throw err;
    return undefined as never;
  };
  return {
    putStream: boom('putStream'),
    presignedPut: boom('presignedPut'),
    initiateMultipartUpload: boom('initiateMultipartUpload'),
    presignedUploadPart: boom('presignedUploadPart'),
    completeMultipartUpload: boom('completeMultipartUpload'),
    abortMultipartUpload: boom('abortMultipartUpload'),
    statObject: boom('statObject'),
    removeObject: boom('removeObject')
  } as unknown as WorkspaceStorage;
}

async function buildApp(storage?: WorkspaceStorage): Promise<{
  app: FastifyInstance;
  repo: InMemoryAssetRepository;
}> {
  // maxParamLength raised for long multipart upload ids (see #272 note in
  // test/asset-upload.test.ts).
  const app = Fastify({ maxParamLength: 500 });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Stream the binary upload body through, mirroring src/main.ts.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });
  const repo = new InMemoryAssetRepository();
  await app.register(assetUploadRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    ...(storage ? { storageFor: () => storage } : {})
  });
  await app.ready();
  return { app, repo };
}

// Assert a response is the structured upload error envelope and return it.
function expectUploadError(res: { statusCode: number; json: () => unknown }) {
  const parsed = uploadErrorSchema.safeParse(res.json());
  expect(parsed.success, `not an upload error envelope: ${JSON.stringify(res.json())}`).toBe(true);
  return parsed.success ? parsed.data : ({} as never);
}

// ─── 1. The classifier ───────────────────────────────────────────────────────

describe('classifyUploadFailure (issue #771)', () => {
  it('maps an oversize streamed body to body_size_limit_exceeded / 413', () => {
    const failure = classifyUploadFailure(new SourceTooLargeError(1024), 'putStream');
    expect(failure.failureCause).toBe('body_size_limit_exceeded');
    expect(failure.statusCode).toBe(413);
    // The pre-#771 `error` code is preserved so existing clients do not regress.
    expect(failure.errorCode).toBe('payload_too_large');
  });

  it("maps Fastify's FST_ERR_CTP_BODY_TOO_LARGE to body_size_limit_exceeded / 413", () => {
    const failure = classifyUploadFailure(
      codedError('Request body is too large', 'FST_ERR_CTP_BODY_TOO_LARGE')
    );
    expect(failure.failureCause).toBe('body_size_limit_exceeded');
    expect(failure.statusCode).toBe(413);
    expect(failure.detailCode).toBe('FST_ERR_CTP_BODY_TOO_LARGE');
  });

  it.each([
    ['FST_ERR_VALIDATION', 'invalid_request', 400],
    ['FST_ERR_CTP_EMPTY_JSON_BODY', 'invalid_request', 400],
    ['FST_ERR_CTP_INVALID_JSON_BODY', 'invalid_request', 400],
    ['FST_ERR_CTP_INVALID_CONTENT_LENGTH', 'invalid_request', 400],
    ['FST_ERR_CTP_INVALID_MEDIA_TYPE', 'unsupported_media_type', 415],
    ['FST_ERR_CTP_BODY_TOO_LARGE', 'body_size_limit_exceeded', 413]
  ] as const)(
    'classifyFrameworkError maps %s to %s / %d',
    (code, cause, status) => {
      const failure = classifyFrameworkError(codedError('framework said no', code));
      expect(failure?.failureCause).toBe(cause);
      expect(failure?.statusCode).toBe(status);
      expect(failure?.detailCode).toBe(code);
    }
  );

  it('classifyFrameworkError returns undefined for a non-framework error', () => {
    expect(classifyFrameworkError(codedError('s3 said no', 'AccessDenied'))).toBeUndefined();
    expect(classifyFrameworkError(new Error('plain'))).toBeUndefined();
  });

  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'EPIPE',
    'EAI_AGAIN',
    'ERR_STREAM_PREMATURE_CLOSE',
    'ERR_TLS_CERT_ALTNAME_INVALID'
  ])('maps the transport failure %s to network_error / 502', (code) => {
    const failure = classifyUploadFailure(codedError('socket problem', code), 'putStream');
    expect(failure.failureCause).toBe('network_error');
    expect(failure.statusCode).toBe(502);
    expect(failure.detailCode).toBe(code);
  });

  it('maps an aborted request (AbortError, no errno) to network_error', () => {
    const abort = new Error('The operation was aborted');
    abort.name = 'AbortError';
    expect(isConnectionError(abort)).toBe(true);
    expect(classifyUploadFailure(abort).failureCause).toBe('network_error');
  });

  it.each(['NoSuchUpload', 'InvalidPart', 'AccessDenied', 'NoSuchBucket'])(
    'maps the S3 error %s to storage_backend_error / 502 and echoes the code',
    (code) => {
      const failure = classifyUploadFailure(codedError('s3 said no', code), 'completeMultipartUpload');
      expect(failure.failureCause).toBe('storage_backend_error');
      expect(failure.statusCode).toBe(502);
      expect(failure.detailCode).toBe(code);
    }
  );

  it('defaults an uncoded storage-boundary failure to storage_backend_error', () => {
    const failure = classifyUploadFailure(new Error('something went wrong'), 'putStream');
    expect(failure.failureCause).toBe('storage_backend_error');
    expect(failure.detailCode).toBeUndefined();
  });

  it('maps a total-cap rejection to quota_exceeded / 409 keeping the existing error code', () => {
    const failure = classifyUploadFailure(
      new QuotaExceededError({ capBytes: 10, consumedBytes: 9, requestedBytes: 5 })
    );
    expect(failure.failureCause).toBe('quota_exceeded');
    expect(failure.statusCode).toBe(409);
    expect(failure.errorCode).toBe('quota_exceeded');
  });

  it('is idempotent — re-classifying an already-classified failure is a no-op', () => {
    const first = classifyUploadFailure(codedError('nope', 'ECONNREFUSED'), 'putStream');
    expect(classifyUploadFailure(first, 'somethingElse')).toBe(first);
  });

  it('never echoes the underlying error text (which can carry endpoint detail)', () => {
    const leaky = codedError(
      'connect ECONNREFUSED minio.internal:9000 accessKey=AKIAEXAMPLE secret=hunter2',
      'ECONNREFUSED'
    );
    const body = classifyUploadFailure(leaky, 'putStream').toResponseBody();
    expect(JSON.stringify(body)).not.toContain('hunter2');
    expect(JSON.stringify(body)).not.toContain('AKIAEXAMPLE');
    expect(body.cause).toBe('network_error');
  });

  it('produces a body that satisfies the published envelope for every cause', () => {
    for (const cause of uploadFailureCauseSchema.options) {
      const body = new UploadFailureError(cause, 'boom', { detailCode: 'X' }).toResponseBody();
      expect(uploadErrorSchema.safeParse(body).success).toBe(true);
      expect(body.cause).toBe(cause);
      expect(UPLOAD_FAILURE_STATUS[cause]).toBeGreaterThanOrEqual(400);
    }
  });

  it('viaStorage classifies whatever the storage call throws', async () => {
    await expect(
      viaStorage('presignedPut', async () => {
        throw codedError('refused', 'ECONNREFUSED');
      })
    ).rejects.toMatchObject({ failureCause: 'network_error', operation: 'presignedPut' });
  });
});

// ─── 2. The routes ───────────────────────────────────────────────────────────

describe('upload routes return a structured cause (issue #771)', () => {
  it('proxied PUT: an oversize body is 413 body_size_limit_exceeded', async () => {
    const { app, repo } = await buildApp(failingStorage(new SourceTooLargeError(1024), 'putStream'));
    const asset = await repo.create({ name: 'big' });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/assets/${asset.id}/upload`,
      headers: { 'content-type': 'application/octet-stream', 'content-length': '4' },
      payload: Buffer.alloc(4)
    });
    expect(res.statusCode).toBe(413);
    const body = expectUploadError(res);
    expect(body.cause).toBe('body_size_limit_exceeded');
    // The pre-#771 machine code is unchanged.
    expect(body.error).toBe('payload_too_large');
    // The asset must not have advanced on a failed upload.
    expect((await repo.get(asset.id))?.status).toBe('uploading');
    await app.close();
  });

  it('proxied PUT: a dropped connection is 502 network_error', async () => {
    const { app, repo } = await buildApp(
      failingStorage(codedError('socket hang up', 'ECONNRESET'), 'putStream')
    );
    const asset = await repo.create({ name: 'dropped' });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/assets/${asset.id}/upload`,
      headers: { 'content-type': 'application/octet-stream', 'content-length': '4' },
      payload: Buffer.alloc(4)
    });
    expect(res.statusCode).toBe(502);
    const body = expectUploadError(res);
    expect(body.cause).toBe('network_error');
    expect(body.code).toBe('ECONNRESET');
    expect((await repo.get(asset.id))?.status).toBe('uploading');
    await app.close();
  });

  it('proxied PUT: a storage rejection is 502 storage_backend_error with the S3 code', async () => {
    const { app, repo } = await buildApp(
      failingStorage(codedError('Access Denied', 'AccessDenied'), 'putStream')
    );
    const asset = await repo.create({ name: 'denied' });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/assets/${asset.id}/upload`,
      headers: { 'content-type': 'application/octet-stream', 'content-length': '4' },
      payload: Buffer.alloc(4)
    });
    expect(res.statusCode).toBe(502);
    const body = expectUploadError(res);
    expect(body.cause).toBe('storage_backend_error');
    expect(body.code).toBe('AccessDenied');
    await app.close();
  });

  it('presign: an unreachable store is 502 network_error', async () => {
    const { app, repo } = await buildApp(
      failingStorage(codedError('connect ECONNREFUSED', 'ECONNREFUSED'), 'presignedPut')
    );
    const asset = await repo.create({ name: 'presign' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/upload-url`
    });
    expect(res.statusCode).toBe(502);
    expect(expectUploadError(res).cause).toBe('network_error');
    await app.close();
  });

  it('multipart initiate: a storage failure is 502 storage_backend_error', async () => {
    const { app, repo } = await buildApp(
      failingStorage(codedError('no such bucket', 'NoSuchBucket'), 'initiateMultipartUpload')
    );
    const asset = await repo.create({ name: 'mp' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/multipart/initiate`
    });
    expect(res.statusCode).toBe(502);
    const body = expectUploadError(res);
    expect(body.cause).toBe('storage_backend_error');
    expect(body.code).toBe('NoSuchBucket');
    await app.close();
  });

  it('multipart complete: an expired session is 502 storage_backend_error (NoSuchUpload)', async () => {
    const { app, repo } = await buildApp(
      failingStorage(codedError('no such upload', 'NoSuchUpload'), 'completeMultipartUpload')
    );
    const asset = await repo.create({ name: 'mp-complete' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/multipart/upload-123/complete`,
      payload: { parts: [{ partNumber: 1, etag: 'etag-1' }] }
    });
    expect(res.statusCode).toBe(502);
    const body = expectUploadError(res);
    expect(body.cause).toBe('storage_backend_error');
    expect(body.code).toBe('NoSuchUpload');
    await app.close();
  });

  it('multipart abort: an unreachable store is 502 network_error', async () => {
    const { app, repo } = await buildApp(
      failingStorage(codedError('timed out', 'ETIMEDOUT'), 'abortMultipartUpload')
    );
    const asset = await repo.create({ name: 'abort' });
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/v1/assets/${asset.id}/multipart/upload-123`
    });
    expect(res.statusCode).toBe(502);
    expect(expectUploadError(res).cause).toBe('network_error');
    // The abort failed, so the asset is NOT settled to failed (issue #748's
    // transition only runs after a successful abort).
    expect((await repo.get(asset.id))?.status).toBe('uploading');
    await app.close();
  });

  it('an unknown asset is 404 asset_not_found on every upload route', async () => {
    const { app } = await buildApp(failingStorage(new Error('unused')));
    const routes: { method: 'POST' | 'GET' | 'DELETE' | 'PUT'; url: string }[] = [
      { method: 'POST', url: '/api/v1/assets/nope/upload-url' },
      { method: 'POST', url: '/api/v1/assets/nope/multipart/initiate' },
      { method: 'GET', url: '/api/v1/assets/nope/multipart/u1/part-url?partNumber=1' },
      { method: 'DELETE', url: '/api/v1/assets/nope/multipart/u1' },
      { method: 'POST', url: '/api/v1/assets/nope/upload-complete' }
    ];
    for (const route of routes) {
      const res = await app.inject({ method: route.method, url: route.url });
      expect(res.statusCode, route.url).toBe(404);
      const body = expectUploadError(res);
      expect(body.cause, route.url).toBe('asset_not_found');
      expect(body.error, route.url).toBe('not_found');
    }
    await app.close();
  });

  it('proxied PUT: an unparseable content type is 415 unsupported_media_type', async () => {
    // No parser is registered for application/pdf (buildApp mirrors src/main.ts,
    // which registers octet-stream + the media types), so Fastify rejects the
    // body with FST_ERR_CTP_INVALID_MEDIA_TYPE (415) BEFORE the handler runs.
    const { app, repo } = await buildApp(failingStorage(new Error('unused')));
    const asset = await repo.create({ name: 'wrong-type' });
    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/assets/${asset.id}/upload`,
      headers: { 'content-type': 'application/pdf' },
      payload: 'not a video'
    });
    expect(res.statusCode).toBe(415);
    const body = expectUploadError(res);
    expect(body.cause).toBe('unsupported_media_type');
    expect(body.error).toBe('unsupported_media_type');
    expect(body.code).toBe('FST_ERR_CTP_INVALID_MEDIA_TYPE');
    await app.close();
  });

  it('part-url: an out-of-range part number is 400 invalid_request', async () => {
    const { app, repo } = await buildApp(failingStorage(new Error('unused')));
    const asset = await repo.create({ name: 'bad-part' });
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${asset.id}/multipart/upload-123/part-url?partNumber=0`
    });
    expect(res.statusCode).toBe(400);
    const body = expectUploadError(res);
    expect(body.cause).toBe('invalid_request');
    expect(body.error).toBe('invalid_request');
    expect(body.code).toBe('FST_ERR_VALIDATION');
    await app.close();
  });

  it('multipart complete: an empty parts list is 400 invalid_request', async () => {
    const { app, repo } = await buildApp(failingStorage(new Error('unused')));
    const asset = await repo.create({ name: 'no-parts' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/multipart/upload-123/complete`,
      payload: { parts: [] }
    });
    expect(res.statusCode).toBe(400);
    expect(expectUploadError(res).cause).toBe('invalid_request');
    await app.close();
  });

  it('multipart complete: an oversized JSON body is 413 body_size_limit_exceeded', async () => {
    // The framework `bodyLimit` (default 1048576 bytes,
    // node_modules/fastify/lib/config-validator.js:1265 `defaultInitOptions`)
    // DOES police the JSON-bodied routes, which Fastify buffers — unlike
    // PUT /:id/upload, whose custom stream parser bypasses buffering and whose
    // 10 GiB cap is enforced by SourceTooLargeError instead. This proves the
    // FST_ERR_CTP_BODY_TOO_LARGE branch is reachable through a real route.
    const { app, repo } = await buildApp(failingStorage(new Error('unused')));
    const asset = await repo.create({ name: 'huge-parts' });
    const oversized = JSON.stringify({
      parts: [{ partNumber: 1, etag: 'e'.repeat(1024 * 1024 + 64) }]
    });
    expect(Buffer.byteLength(oversized)).toBeGreaterThan(1048576);
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/multipart/upload-123/complete`,
      headers: { 'content-type': 'application/json' },
      payload: oversized
    });
    expect(res.statusCode).toBe(413);
    const body = expectUploadError(res);
    expect(body.cause).toBe('body_size_limit_exceeded');
    expect(body.code).toBe('FST_ERR_CTP_BODY_TOO_LARGE');
    await app.close();
  });

  it('an unclassifiable fault is 500 unknown, still in the published envelope', async () => {
    // A bug in our own code — NOT a storage call — must still carry a cause, and
    // must be `unknown` rather than being mislabelled a storage failure.
    const { app, repo } = await buildApp(failingStorage(new Error('unused')));
    const asset = await repo.create({ name: 'boom' });
    repo.get = async () => {
      throw new Error('repository exploded');
    };
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/upload-url`
    });
    expect(res.statusCode).toBe(500);
    const body = expectUploadError(res);
    expect(body.cause).toBe('unknown');
    expect(body.error).toBe('upload_failed');
    // The underlying error text stays server-side.
    expect(JSON.stringify(body)).not.toContain('repository exploded');
    await app.close();
  });

  it('a deployment with no object storage is 501 storage_not_configured', async () => {
    const { app, repo } = await buildApp(); // no storageFor
    const asset = await repo.create({ name: 'nostorage' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/upload-url`
    });
    expect(res.statusCode).toBe(501);
    const body = expectUploadError(res);
    expect(body.cause).toBe('storage_not_configured');
    expect(body.error).toBe('not_configured');
    await app.close();
  });
});
