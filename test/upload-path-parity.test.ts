// Regression guard: single-part and multipart upload paths reach the SAME
// usable asset state (issue #613; guards the v1.3.1 single-part objectKey bug,
// cluster prod-se, 2026-09-07).
//
// The v1.3.1 single-part finalize path transitioned the asset but never recorded
// `objectKey`, so every source-consuming operation (transcode/package/
// thumbnails/clip/export) resolved a missing source and returned 409 no_object —
// while the multipart path recorded the key and worked. No test caught the
// divergence. This file locks the two flows together:
//
//   1. Finalize an asset through BOTH paths and assert the resulting documents
//      are equivalent on every source-location field the downstream operations
//      depend on (objectKey, status).
//   2. Parameterized over both upload paths, run the source-consuming operations
//      that resolve the source through the unified resolver (issue #612) and
//      assert NONE return 409 no_object.
//
// Contract sources verified (no guessing):
//   - Upload routes + sourceObjectKey(): src/routes/asset-upload.ts
//       single-part : POST /:id/upload-url  -> (client PUTs) -> POST /:id/upload-complete
//       multipart   : POST /:id/multipart/initiate -> .../complete -> POST /:id/upload-complete
//     objectKey persisted on finalize: asset-upload.ts upload-complete handler
//     and multipart complete handler (the #611 fix).
//   - Source resolution + 409 no_object: src/pipeline/source-object.ts
//       NO_SOURCE_OBJECT_ERROR === 'no_object'; requireSourceObject() sends 409.
//   - Downstream routes resolve source BEFORE the not-configured gate:
//       POST /:id/transcode  (assets.ts ~2800, requireSourceObject then 501)
//       POST /:id/thumbnails (assets.ts ~3325, requireSourceObject then 501)
//     so on an app with no encore/extractor wired a RESOLVABLE source yields 501
//     not_configured, and an UNRESOLVABLE one yields 409 no_object — which is
//     exactly the pre/post-fix distinction this guard pins.
//   - thumbnails body schema requires timecodes[].min(1): assets.ts:483.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      const map: Record<string, string> = { 'token-a': 'workspace-a' };
      const ws = token ? map[token] : undefined;
      if (!ws) throw new actual.AuthError('invalid token');
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { assetUploadRouter, sourceObjectKey } from '../src/routes/asset-upload.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';

// Minimal WorkspaceStorage stand-in: the parity routes exercised here only need
// the presign/multipart methods to return deterministic values. No bytes move.
class FakeStorage {
  constructor(readonly workspaceId: string) {}
  async presignedPut(key: string, ttl: number) {
    return `https://minio.example/put/${key}?ttl=${ttl}`;
  }
  async initiateMultipartUpload(_key: string) {
    return 'upload-xyz';
  }
  async presignedUploadPart(key: string, uploadId: string, partNumber: number, ttl: number) {
    return `https://minio.example/part/${key}?u=${uploadId}&p=${partNumber}&ttl=${ttl}`;
  }
  async completeMultipartUpload(_key: string, _uploadId: string, _parts: unknown[]) {
    return { etag: 'final-etag' };
  }
  async abortMultipartUpload(_key: string, _uploadId: string) {}
}

const A = { authorization: 'Bearer token-a' } as const;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ maxParamLength: 500 });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repository = new InMemoryAssetRepository();
  const storageFor = (workspaceId: string) =>
    new FakeStorage(workspaceId) as unknown as import('../src/data/storage.js').WorkspaceStorage;
  // assetsRouter is registered WITHOUT encore/extractor/packaging, so a
  // resolvable source falls through to 501 not_configured — never 409 no_object.
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository });
  await app.register(assetUploadRouter, {
    prefix: '/api/v1/assets',
    repository,
    storageFor
  });
  await app.ready();
  return app;
}

async function createAsset(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: A,
    payload: { name: 'clip' }
  });
  expect(res.statusCode).toBe(201);
  return res.json().id as string;
}

// Drive an asset through the single-part flow to a finalized (processing) state.
async function finalizeSinglePart(app: FastifyInstance, id: string) {
  const url = await app.inject({
    method: 'POST',
    url: `/api/v1/assets/${id}/upload-url`,
    headers: A
  });
  expect(url.statusCode).toBe(200);
  const done = await app.inject({
    method: 'POST',
    url: `/api/v1/assets/${id}/upload-complete`,
    headers: A
  });
  expect(done.statusCode).toBe(200);
}

// Drive an asset through the multipart flow to a finalized (processing) state.
async function finalizeMultipart(app: FastifyInstance, id: string) {
  const initiate = await app.inject({
    method: 'POST',
    url: `/api/v1/assets/${id}/multipart/initiate`,
    headers: A
  });
  expect(initiate.statusCode).toBe(200);
  const uploadId = initiate.json().uploadId as string;
  const complete = await app.inject({
    method: 'POST',
    url: `/api/v1/assets/${id}/multipart/${uploadId}/complete`,
    headers: A,
    payload: { parts: [{ partNumber: 1, etag: 'etag-1' }] }
  });
  expect(complete.statusCode).toBe(200);
  // Multipart complete records objectKey but does NOT transition; the explicit
  // upload-complete performs the lifecycle transition, mirroring the single-part
  // flow so both paths converge on the same (status, objectKey).
  const done = await app.inject({
    method: 'POST',
    url: `/api/v1/assets/${id}/upload-complete`,
    headers: A
  });
  expect(done.statusCode).toBe(200);
}

const PATHS = [
  { name: 'single-part', finalize: finalizeSinglePart },
  { name: 'multipart', finalize: finalizeMultipart }
] as const;

describe('upload path parity (issue #613)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  it('both paths converge on the same source-location fields', async () => {
    const singleId = await createAsset(app);
    await finalizeSinglePart(app, singleId);

    const multiId = await createAsset(app);
    await finalizeMultipart(app, multiId);

    const single = (
      await app.inject({ method: 'GET', url: `/api/v1/assets/${singleId}`, headers: A })
    ).json();
    const multi = (
      await app.inject({ method: 'GET', url: `/api/v1/assets/${multiId}`, headers: A })
    ).json();

    // Each records its OWN deterministic source key...
    expect(single.objectKey).toBe(sourceObjectKey(singleId));
    expect(multi.objectKey).toBe(sourceObjectKey(multiId));
    // ...and, id aside, the key shape is identical (the #611 divergence: one
    // path left objectKey undefined).
    expect(single.objectKey.replace(singleId, '<id>')).toBe(
      multi.objectKey.replace(multiId, '<id>')
    );
    // Both land in the same lifecycle state.
    expect(single.status).toBe('processing');
    expect(multi.status).toBe(single.status);
    // CI-failing guard: neither path may finalize without an objectKey. A
    // regression (single-part dropping the key again) makes this undefined.
    expect(single.objectKey).toBeTruthy();
    expect(multi.objectKey).toBeTruthy();
  });

  // Parameterized downstream-operation set run against BOTH upload paths. Each
  // op here resolves the source through the unified resolver (issue #612) before
  // its not-configured gate, so a correctly finalized asset must NOT produce
  // 409 no_object on either path.
  for (const { name, finalize } of PATHS) {
    describe(`${name} finalize -> source-consuming operations`, () => {
      it('transcode does not return 409 no_object', async () => {
        const id = await createAsset(app);
        await finalize(app, id);
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/assets/${id}/transcode`,
          headers: A,
          payload: {}
        });
        expect(res.statusCode).not.toBe(409);
        expect(res.json().error).not.toBe('no_object');
      });

      it('thumbnails does not return 409 no_object', async () => {
        const id = await createAsset(app);
        await finalize(app, id);
        const res = await app.inject({
          method: 'POST',
          url: `/api/v1/assets/${id}/thumbnails`,
          headers: A,
          payload: { timecodes: [0] }
        });
        expect(res.statusCode).not.toBe(409);
        expect(res.json().error).not.toBe('no_object');
      });
    });
  }

  // Negative control: WITHOUT finalizing (no objectKey recorded), the same ops
  // DO return 409 no_object. This proves the assertions above are load-bearing
  // and would have caught the v1.3.1 bug rather than passing vacuously.
  it('un-finalized asset DOES return 409 no_object (negative control)', async () => {
    const id = await createAsset(app);
    const transcode = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/transcode`,
      headers: A,
      payload: {}
    });
    expect(transcode.statusCode).toBe(409);
    expect(transcode.json().error).toBe('no_object');

    const thumbnails = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${id}/thumbnails`,
      headers: A,
      payload: { timecodes: [0] }
    });
    expect(thumbnails.statusCode).toBe(409);
    expect(thumbnails.json().error).toBe('no_object');
  });
});
