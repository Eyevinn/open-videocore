// Direct client-side upload tests (issue #4).
//
// Exercises the upload sub-router against the in-memory asset repository and a
// fake WorkspaceStorage that records the calls it receives. We assert that:
//   - single-part presign returns a URL + object key
//   - the multipart flow (initiate -> part-url -> complete) wires through to
//     storage with the right arguments
//   - upload-complete transitions the asset uploading -> processing
//   - the presigned-URL TTL is configurable via UPLOAD_URL_TTL_SECONDS
//   - abort/cleanup calls storage.abortMultipartUpload
//   - cross-workspace asset ids resolve to 404 (no existence leak)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      const map: Record<string, string> = { 'token-a': 'workspace-a', 'token-b': 'workspace-b' };
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

// A fake stand-in for WorkspaceStorage that records calls and returns
// deterministic values. Typed loosely; the router only uses the methods below.
class FakeStorage {
  calls: { method: string; args: unknown[] }[] = [];
  constructor(readonly workspaceId: string) {}

  private record(method: string, args: unknown[]) {
    this.calls.push({ method, args });
  }

  async presignedPut(key: string, ttl: number) {
    this.record('presignedPut', [key, ttl]);
    return `https://minio.example/put/${key}?ttl=${ttl}`;
  }
  async initiateMultipartUpload(key: string) {
    this.record('initiateMultipartUpload', [key]);
    return 'upload-xyz';
  }
  async presignedUploadPart(key: string, uploadId: string, partNumber: number, ttl: number) {
    this.record('presignedUploadPart', [key, uploadId, partNumber, ttl]);
    return `https://minio.example/part/${key}?u=${uploadId}&p=${partNumber}&ttl=${ttl}`;
  }
  async completeMultipartUpload(key: string, uploadId: string, parts: unknown[]) {
    this.record('completeMultipartUpload', [key, uploadId, parts]);
    return { etag: 'final-etag' };
  }
  async abortMultipartUpload(key: string, uploadId: string) {
    this.record('abortMultipartUpload', [key, uploadId]);
  }
}

const auth = (token: string) => ({ authorization: `Bearer ${token}` });
const A = auth('token-a');

async function buildApp(): Promise<{ app: FastifyInstance; storages: Map<string, FakeStorage> }> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repository = new InMemoryAssetRepository();
  const storages = new Map<string, FakeStorage>();
  const storageFor = (workspaceId: string) => {
    let s = storages.get(workspaceId);
    if (!s) {
      s = new FakeStorage(workspaceId);
      storages.set(workspaceId, s);
    }
    return s as unknown as import('../src/data/storage.js').WorkspaceStorage;
  };
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository });
  await app.register(assetUploadRouter, {
    prefix: '/api/v1/assets',
    repository,
    storageFor
  });
  await app.ready();
  return { app, storages };
}

async function createAsset(app: FastifyInstance): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: A,
    payload: { name: 'clip' }
  });
  return res.json().id as string;
}

describe('direct client-side upload (issue #4)', () => {
  let app: FastifyInstance;
  let storages: Map<string, FakeStorage>;

  beforeEach(async () => {
    ({ app, storages } = await buildApp());
  });

  afterEach(() => {
    delete process.env['UPLOAD_URL_TTL_SECONDS'];
  });

  describe('single-part presign', () => {
    it('returns a presigned PUT URL and object key', async () => {
      const id = await createAsset(app);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/upload-url`,
        headers: A
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.method).toBe('PUT');
      expect(body.objectKey).toBe(sourceObjectKey(id));
      expect(body.url).toContain('https://minio.example/put/');
      expect(body.expiresInSeconds).toBe(900);
    });

    it('returns 404 for an unknown asset', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assets/nope/upload-url',
        headers: A
      });
      expect(res.statusCode).toBe(404);
    });

    it('does not leak a cross-workspace asset (404)', async () => {
      const id = await createAsset(app);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/upload-url`,
        headers: auth('token-b')
      });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('TTL is configurable', () => {
    it('uses UPLOAD_URL_TTL_SECONDS when set', async () => {
      process.env['UPLOAD_URL_TTL_SECONDS'] = '120';
      const id = await createAsset(app);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/upload-url`,
        headers: A
      });
      expect(res.json().expiresInSeconds).toBe(120);
      const storage = storages.get('workspace-a')!;
      const call = storage.calls.find((c) => c.method === 'presignedPut')!;
      expect(call.args[1]).toBe(120);
    });

    it('defaults to 900 seconds (15 min) when unset', async () => {
      const id = await createAsset(app);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/upload-url`,
        headers: A
      });
      expect(res.json().expiresInSeconds).toBe(900);
    });
  });

  describe('multipart flow', () => {
    it('initiates, issues part URLs, and completes', async () => {
      const id = await createAsset(app);

      const initiate = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/multipart/initiate`,
        headers: A
      });
      expect(initiate.statusCode).toBe(200);
      const uploadId = initiate.json().uploadId;
      expect(uploadId).toBe('upload-xyz');
      expect(initiate.json().objectKey).toBe(sourceObjectKey(id));

      const partUrl = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${id}/multipart/${uploadId}/part-url?partNumber=2`,
        headers: A
      });
      expect(partUrl.statusCode).toBe(200);
      expect(partUrl.json().partNumber).toBe(2);
      expect(partUrl.json().url).toContain('p=2');

      const complete = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/multipart/${uploadId}/complete`,
        headers: A,
        payload: {
          parts: [
            { partNumber: 1, etag: 'etag-1' },
            { partNumber: 2, etag: 'etag-2' }
          ]
        }
      });
      expect(complete.statusCode).toBe(200);

      const storage = storages.get('workspace-a')!;
      const completeCall = storage.calls.find((c) => c.method === 'completeMultipartUpload')!;
      expect(completeCall.args[1]).toBe(uploadId);
      expect(completeCall.args[2]).toHaveLength(2);

      // Object key was persisted on the asset.
      const read = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}`, headers: A });
      expect(read.json().objectKey).toBe(sourceObjectKey(id));
    });

    it('rejects an out-of-range part number (400)', async () => {
      const id = await createAsset(app);
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${id}/multipart/upload-xyz/part-url?partNumber=0`,
        headers: A
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects a complete with no parts (400)', async () => {
      const id = await createAsset(app);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/multipart/upload-xyz/complete`,
        headers: A,
        payload: { parts: [] }
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('upload-complete transition', () => {
    it('transitions the asset uploading -> processing', async () => {
      const id = await createAsset(app);
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/upload-complete`,
        headers: A
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('processing');

      const read = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}`, headers: A });
      expect(read.json().status).toBe('processing');
      expect(read.json().statusHistory.map((h: { to: string }) => h.to)).toEqual([
        'uploading',
        'processing'
      ]);
    });

    it('returns 404 for an unknown asset', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assets/nope/upload-complete',
        headers: A
      });
      expect(res.statusCode).toBe(404);
    });

    it('rejects upload-complete on an archived (terminal) asset (422)', async () => {
      const id = await createAsset(app);
      // Archive the asset; archived is terminal, so any transition out is illegal.
      await app.inject({ method: 'DELETE', url: `/api/v1/assets/${id}`, headers: A });
      const res = await app.inject({
        method: 'POST',
        url: `/api/v1/assets/${id}/upload-complete`,
        headers: A
      });
      expect(res.statusCode).toBe(422);
      expect(res.json().error).toBe('invalid_state_transition');
    });
  });

  describe('cleanup / abort', () => {
    it('aborts an in-progress multipart upload', async () => {
      const id = await createAsset(app);
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/v1/assets/${id}/multipart/upload-xyz`,
        headers: A
      });
      expect(res.statusCode).toBe(204);
      const storage = storages.get('workspace-a')!;
      const abortCall = storage.calls.find((c) => c.method === 'abortMultipartUpload')!;
      expect(abortCall).toBeTruthy();
      expect(abortCall.args[1]).toBe('upload-xyz');
    });

    it('returns 404 when aborting against an unknown asset', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/v1/assets/nope/multipart/upload-xyz',
        headers: A
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
