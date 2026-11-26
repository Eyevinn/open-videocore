// Storage rejections from the multipart upload routes carry their real cause
// (issue #1343).
//
// A credential/signature rejection by the object store used to be
// indistinguishable from "this upload session is stale": both came back as the
// generic 502 `storage_error`, and the storage error code reached neither the
// response nor the log in a field an operator could filter on. These tests pin:
//
//   1. the classifier maps the auth/signature family of S3 error codes onto the
//      distinct `storage_auth_failed` error code (still cause
//      `storage_backend_error`, still 502) and names the storage's code in a
//      safe message, while a non-auth refusal (NoSuchBucket) keeps
//      `storage_error`;
//   2. the three multipart handlers (initiate, part-url, complete) answer with
//      that documented body for the signature-mismatch, access-denied and
//      no-such-bucket cases, not a generic 500;
//   3. the server-side log carries the storage error code, the storage request
//      id and this request's id — and never the signing material the store puts
//      in a SignatureDoesNotMatch response body.
//
// ─── Contract sources verified (no guessing, CLAUDE.md rule 7) ───────────────
//   - Error envelope + classification under test:
//       src/routes/upload-failure-cause.ts — `uploadErrorSchema`
//       (fields `error` / `cause` / `message` / `code`),
//       `classifyUploadFailure`, `isStorageAuthErrorCode`,
//       `STORAGE_AUTH_ERROR_CODE`, `storageRequestId`,
//       `UploadFailureError.toLogFields()`.
//   - The routes under test and the storage call each one makes:
//       src/routes/asset-upload.ts — POST /:id/multipart/initiate
//       (`viaStorage('initiateMultipartUpload', ...)`),
//       GET /:id/multipart/:uploadId/part-url
//       (`viaStorage('presignedUploadPart', ...)`),
//       POST /:id/multipart/:uploadId/complete
//       (`viaStorage('completeMultipartUpload', ...)`), and the router's
//       `setErrorHandler`.
//   - The storage client's own surface for those calls:
//       src/data/storage.ts — `WorkspaceStorage.initiateMultipartUpload`,
//       `presignedUploadPart`, `completeMultipartUpload`, `statObject`. None of
//       them wraps or translates the client error, so what reaches the handler
//       is the minio error verbatim.
//   - The thrown error's shape (what fields the fixtures may rely on):
//       node_modules/minio/dist/main/errors.d.ts — `class S3Error extends
//       ExtendableError { code?: string; region?: string }`;
//       node_modules/minio/dist/main/internal/xml-parser.js:53-67 `parseError`
//       lowercases every element of the store's XML error body onto the error
//       (so `<Code>` -> `.code`, `<RequestId>` -> `.requestid`, and — for a
//       SignatureDoesNotMatch body — `<StringToSign>` -> `.stringtosign`,
//       `<SignatureProvided>` -> `.signatureprovided`, `<AWSAccessKeyId>` ->
//       `.awsaccesskeyid`), and :101-111 copies the `x-amz-request-id` header on
//       as `.amzRequestid`. :79-81 synthesises code 'AccessDenied' for a
//       bodiless 403.
//   - App wiring (content-type parser, maxParamLength) mirrors
//       test/upload-failure-cause.test.ts `buildApp`.

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetUploadRouter } from '../src/routes/asset-upload.js';
import {
  classifyUploadFailure,
  isStorageAuthErrorCode,
  storageRequestId,
  uploadErrorSchema,
  STORAGE_AUTH_ERROR_CODE
} from '../src/routes/upload-failure-cause.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import type { WorkspaceStorage } from '../src/data/storage.js';

// The signing material a real SignatureDoesNotMatch body carries. Kept as
// constants so every assertion checks for the SAME strings that the fixture
// error puts on the thrown object.
const STRING_TO_SIGN = 'AWS4-HMAC-SHA256\n20261126T101500Z\n20261126/us-east-1/s3/aws4_request';
const SIGNATURE_PROVIDED = 'deadbeefcafe0123456789abcdef';
const ACCESS_KEY_ID = 'AKIAEXAMPLEKEYID';
const STORE_REQUEST_ID = '17A1B2C3D4E5F6A7';

// An error shaped like the one minio throws for an S3 error response: the S3
// code on `.code`, the body's elements lowercased onto the error, the
// `x-amz-request-id` header on `.amzRequestid` (xml-parser.js:53-67, :101-111).
function s3Error(code: string, extra: Record<string, string> = {}): Error & { code: string } {
  const err = new Error(`${code}: the storage backend said no`) as Error & { code: string };
  err.code = code;
  Object.assign(err, { amzRequestid: STORE_REQUEST_ID, requestid: STORE_REQUEST_ID }, extra);
  return err;
}

// The full signature-mismatch error, signing material included.
function signatureMismatchError(): Error & { code: string } {
  return s3Error('SignatureDoesNotMatch', {
    stringtosign: STRING_TO_SIGN,
    signatureprovided: SIGNATURE_PROVIDED,
    awsaccesskeyid: ACCESS_KEY_ID
  });
}

// A WorkspaceStorage stand-in that fails one named method with `err`.
function failingStorage(err: unknown, only: string): WorkspaceStorage {
  const boom = (name: string) => async () => {
    if (only === name) throw err;
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

async function buildApp(
  storage: WorkspaceStorage,
  logs?: string[]
): Promise<{ app: FastifyInstance; repo: InMemoryAssetRepository }> {
  const app = Fastify({
    maxParamLength: 500,
    ...(logs
      ? {
          logger: {
            level: 'warn',
            stream: {
              write: (line: string) => {
                logs.push(line);
              }
            }
          }
        }
      : {})
  });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });
  const repo = new InMemoryAssetRepository();
  await app.register(assetUploadRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    storageFor: () => storage
  });
  await app.ready();
  return { app, repo };
}

function expectUploadError(res: { statusCode: number; json: () => unknown }) {
  const parsed = uploadErrorSchema.safeParse(res.json());
  expect(parsed.success, `not an upload error envelope: ${JSON.stringify(res.json())}`).toBe(true);
  return parsed.success ? parsed.data : ({} as never);
}

// ─── 1. Classification ───────────────────────────────────────────────────────

describe('storage auth rejections are classified apart from other refusals (issue #1343)', () => {
  it.each([
    'SignatureDoesNotMatch',
    'InvalidAccessKeyId',
    'InvalidToken',
    'ExpiredToken',
    'TokenRefreshRequired',
    'AuthorizationHeaderMalformed',
    'AccessDenied',
    'Forbidden'
  ])('maps %s to 502 storage_auth_failed with the storage code echoed', (code) => {
    expect(isStorageAuthErrorCode(code)).toBe(true);
    const failure = classifyUploadFailure(s3Error(code), 'initiateMultipartUpload');
    expect(failure.statusCode).toBe(502);
    expect(failure.errorCode).toBe(STORAGE_AUTH_ERROR_CODE);
    expect(failure.errorCode).toBe('storage_auth_failed');
    // The cause taxonomy is unchanged: this is still an upstream storage
    // failure, so a client that branches on `cause` keeps working.
    expect(failure.failureCause).toBe('storage_backend_error');
    expect(failure.detailCode).toBe(code);
    expect(failure.message).toContain(code);
    expect(failure.message).toContain('initiateMultipartUpload');
  });

  it('keeps the generic storage_error code for a refusal that is not about credentials', () => {
    const failure = classifyUploadFailure(s3Error('NoSuchBucket'), 'completeMultipartUpload');
    expect(isStorageAuthErrorCode('NoSuchBucket')).toBe(false);
    expect(failure.statusCode).toBe(502);
    expect(failure.errorCode).toBe('storage_error');
    expect(failure.failureCause).toBe('storage_backend_error');
    expect(failure.detailCode).toBe('NoSuchBucket');
    // The storage's code is named in the message too, so an operator reading a
    // bare error body does not have to know to look at `code`.
    expect(failure.message).toContain('NoSuchBucket');
  });

  it('reads the storage request id from either the header field or the body field', () => {
    expect(storageRequestId(s3Error('AccessDenied'))).toBe(STORE_REQUEST_ID);
    const bodyOnly = new Error('no header') as Error & { requestid: string };
    bodyOnly.requestid = 'BODY-ONLY-ID';
    expect(storageRequestId(bodyOnly)).toBe('BODY-ONLY-ID');
    expect(storageRequestId(new Error('transport failure'))).toBeUndefined();
    expect(storageRequestId(undefined)).toBeUndefined();
  });

  it('never puts signing material in the response body', () => {
    const body = classifyUploadFailure(
      signatureMismatchError(),
      'presignedUploadPart'
    ).toResponseBody();
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(STRING_TO_SIGN);
    expect(serialised).not.toContain(SIGNATURE_PROVIDED);
    expect(serialised).not.toContain(ACCESS_KEY_ID);
    // What it DOES carry: the code, twice (machine field and message).
    expect(body.code).toBe('SignatureDoesNotMatch');
    expect(body.message).toContain('SignatureDoesNotMatch');
  });

  it('never puts signing material in the log fields, but keeps code and request id', () => {
    const fields = classifyUploadFailure(signatureMismatchError(), 'presignedUploadPart')
      .toLogFields();
    const serialised = JSON.stringify(fields);
    expect(serialised).not.toContain(STRING_TO_SIGN);
    expect(serialised).not.toContain(SIGNATURE_PROVIDED);
    expect(serialised).not.toContain(ACCESS_KEY_ID);
    expect(fields['storageErrorCode']).toBe('SignatureDoesNotMatch');
    expect(fields['storageRequestId']).toBe(STORE_REQUEST_ID);
    expect(fields['uploadFailureErrorCode']).toBe('storage_auth_failed');
    expect(fields['uploadFailureOperation']).toBe('presignedUploadPart');
  });
});

// ─── 2. The three multipart routes ───────────────────────────────────────────

type Case = { label: string; method: 'POST' | 'GET'; url: (id: string) => string; op: string; payload?: unknown };

const MULTIPART_ROUTES: Case[] = [
  {
    label: 'initiate',
    method: 'POST',
    url: (id) => `/api/v1/assets/${id}/multipart/initiate`,
    op: 'initiateMultipartUpload'
  },
  {
    label: 'part-url',
    method: 'GET',
    url: (id) => `/api/v1/assets/${id}/multipart/upload-id-1/part-url?partNumber=3`,
    op: 'presignedUploadPart'
  },
  {
    label: 'complete',
    method: 'POST',
    url: (id) => `/api/v1/assets/${id}/multipart/upload-id-1/complete`,
    op: 'completeMultipartUpload',
    payload: { parts: [{ partNumber: 1, etag: 'etag-1' }] }
  }
];

describe('multipart routes report a storage rejection with its real cause (issue #1343)', () => {
  for (const route of MULTIPART_ROUTES) {
    it(`${route.label}: a signature mismatch is 502 storage_auth_failed, not a generic 500`, async () => {
      const { app, repo } = await buildApp(failingStorage(signatureMismatchError(), route.op));
      const asset = await repo.create({ name: `sig-${route.label}` });
      const res = await app.inject({
        method: route.method,
        url: route.url(asset.id),
        ...(route.payload ? { payload: route.payload } : {})
      });
      expect(res.statusCode).toBe(502);
      const body = expectUploadError(res);
      expect(body.error).toBe('storage_auth_failed');
      expect(body.cause).toBe('storage_backend_error');
      expect(body.code).toBe('SignatureDoesNotMatch');
      expect(body.message).toContain('SignatureDoesNotMatch');
      // No secret leaves the process in the response.
      expect(res.payload).not.toContain(STRING_TO_SIGN);
      expect(res.payload).not.toContain(SIGNATURE_PROVIDED);
      expect(res.payload).not.toContain(ACCESS_KEY_ID);
      await app.close();
    });

    it(`${route.label}: an access-denied is 502 storage_auth_failed with the storage code`, async () => {
      const { app, repo } = await buildApp(failingStorage(s3Error('AccessDenied'), route.op));
      const asset = await repo.create({ name: `denied-${route.label}` });
      const res = await app.inject({
        method: route.method,
        url: route.url(asset.id),
        ...(route.payload ? { payload: route.payload } : {})
      });
      expect(res.statusCode).toBe(502);
      const body = expectUploadError(res);
      expect(body.error).toBe('storage_auth_failed');
      expect(body.code).toBe('AccessDenied');
      expect(body.message).toContain('AccessDenied');
      await app.close();
    });

    it(`${route.label}: a missing bucket is 502 storage_error with the storage code`, async () => {
      const { app, repo } = await buildApp(failingStorage(s3Error('NoSuchBucket'), route.op));
      const asset = await repo.create({ name: `nobucket-${route.label}` });
      const res = await app.inject({
        method: route.method,
        url: route.url(asset.id),
        ...(route.payload ? { payload: route.payload } : {})
      });
      expect(res.statusCode).toBe(502);
      const body = expectUploadError(res);
      expect(body.error).toBe('storage_error');
      expect(body.cause).toBe('storage_backend_error');
      expect(body.code).toBe('NoSuchBucket');
      expect(body.message).toContain('NoSuchBucket');
      await app.close();
    });
  }

  it('the asset is left in uploading after a rejected multipart complete', async () => {
    const { app, repo } = await buildApp(
      failingStorage(signatureMismatchError(), 'completeMultipartUpload')
    );
    const asset = await repo.create({ name: 'unchanged' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/multipart/upload-id-1/complete`,
      payload: { parts: [{ partNumber: 1, etag: 'etag-1' }] }
    });
    expect(res.statusCode).toBe(502);
    const after = await repo.get(asset.id);
    expect(after?.status).toBe('uploading');
    expect(after?.objectKey).toBeUndefined();
    await app.close();
  });
});

// ─── 3. The log ──────────────────────────────────────────────────────────────

describe('a storage rejection is logged with its code and request id, never its secrets (issue #1343)', () => {
  it('logs the storage error code, the storage request id and this request id', async () => {
    const logs: string[] = [];
    const { app, repo } = await buildApp(
      failingStorage(signatureMismatchError(), 'initiateMultipartUpload'),
      logs
    );
    const asset = await repo.create({ name: 'logged' });
    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/multipart/initiate`
    });
    expect(res.statusCode).toBe(502);
    const record = logs
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((entry) => entry['msg'] === 'upload failed');
    expect(record, `no 'upload failed' record in ${JSON.stringify(logs)}`).toBeDefined();
    expect(record?.['storageErrorCode']).toBe('SignatureDoesNotMatch');
    expect(record?.['storageRequestId']).toBe(STORE_REQUEST_ID);
    expect(record?.['uploadFailureErrorCode']).toBe('storage_auth_failed');
    expect(record?.['uploadFailureOperation']).toBe('initiateMultipartUpload');
    expect(typeof record?.['requestId']).toBe('string');
    await app.close();
  });

  it('leaks no signing material into any log line', async () => {
    const logs: string[] = [];
    const { app, repo } = await buildApp(
      failingStorage(signatureMismatchError(), 'completeMultipartUpload'),
      logs
    );
    const asset = await repo.create({ name: 'no-leak' });
    await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/multipart/upload-id-1/complete`,
      payload: { parts: [{ partNumber: 1, etag: 'etag-1' }] }
    });
    const all = logs.join('\n');
    expect(all).toContain('SignatureDoesNotMatch');
    expect(all).not.toContain(STRING_TO_SIGN);
    expect(all).not.toContain(SIGNATURE_PROVIDED);
    expect(all).not.toContain(ACCESS_KEY_ID);
    await app.close();
  });
});
