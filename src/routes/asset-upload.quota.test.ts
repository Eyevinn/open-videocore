// Integration tests for the total storage cap on DIRECT-UPLOAD ingest
// (issue #579, ADR-020). Exercises the two direct-upload admission points:
//   - proxied PUT /:id/upload   — reserve (Content-Length) then commit true size
//   - POST /:id/upload-complete — post-hoc admission against the real object size
// Covers: over-cap -> 409 quota_exceeded; under-cap -> success; no cap -> behaviour
// unchanged; and the concurrent-in-flight race (two proxied PUTs that together
// exceed the cap: exactly one is admitted).

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { Readable } from 'node:stream';

import { assetUploadRouter } from './asset-upload.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import type { WorkspaceStorage } from '../data/storage.js';
import {
  InMemoryStorageQuotaStore,
  StorageQuotaGuard
} from '../data/storage-quota.js';

// A minimal fake WorkspaceStorage: putStream reports the declared totalBytes as
// transferred; statObject returns a fixed size per key (for upload-complete).
function fakeStorage(sizes: Map<string, number> = new Map()): WorkspaceStorage {
  return {
    async putStream(
      _key: string,
      _src: Readable,
      opts: { maxBytes: number; totalBytes?: number }
    ) {
      const bytes = opts.totalBytes ?? 0;
      return { etag: 'etag', bytesTransferred: bytes };
    },
    async statObject(key: string) {
      const size = sizes.get(key);
      return size === undefined ? undefined : { size, etag: 'etag' };
    },
    async removeObject() {
      /* no-op in fake */
    }
  } as unknown as WorkspaceStorage;
}

async function buildApp(args: {
  guard?: StorageQuotaGuard;
  repo: InMemoryAssetRepository;
  storage: WorkspaceStorage;
}) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Pass the binary upload body through as a stream, mirroring the production
  // content-type parser wiring (src/main.ts:176-186) so PUT /:id/upload reads
  // request.body as a Readable instead of 415-ing on the octet-stream body.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });
  await app.register(assetUploadRouter, {
    prefix: '/api/v1/assets',
    repository: args.repo,
    storageFor: () => args.storage,
    quota: args.guard
  });
  await app.ready();
  return app;
}

describe('direct-upload proxied PUT — storage cap (issue #579)', () => {
  it('rejects an over-cap upload with 409 quota_exceeded and does not advance the asset', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'big' });
    const guard = new StorageQuotaGuard({
      store: new InMemoryStorageQuotaStore({ consumedBytes: 900 }),
      capBytes: () => 1000
    });
    const app = await buildApp({ guard, repo, storage: fakeStorage() });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/assets/${asset.id}/upload`,
      headers: { 'content-length': '200', 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(200)
    });

    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'quota_exceeded' });
    // Asset was not advanced to processing.
    const after = await repo.get(asset.id);
    expect(after?.status).not.toBe('processing');
    await app.close();
  });

  it('accepts an under-cap upload (200) and commits the true size to the counter', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'ok' });
    const store = new InMemoryStorageQuotaStore();
    const guard = new StorageQuotaGuard({ store, capBytes: () => 1000 });
    const app = await buildApp({ guard, repo, storage: fakeStorage() });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/assets/${asset.id}/upload`,
      headers: { 'content-length': '200', 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(200)
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'processing' });
    const c = await store.read();
    expect(c.consumedBytes).toBe(200);
    expect(c.reservedBytes).toBe(0);
    await app.close();
  });

  it('no cap configured => upload succeeds unchanged (opt-in)', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'nocap' });
    const store = new InMemoryStorageQuotaStore({ consumedBytes: 10 ** 12 });
    const guard = new StorageQuotaGuard({ store, capBytes: () => undefined });
    const app = await buildApp({ guard, repo, storage: fakeStorage() });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/assets/${asset.id}/upload`,
      headers: { 'content-length': '999999999', 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(16)
    });

    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('no quota guard wired => upload succeeds unchanged (absent opt-in)', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'unwired' });
    const app = await buildApp({ repo, storage: fakeStorage() });

    const res = await app.inject({
      method: 'PUT',
      url: `/api/v1/assets/${asset.id}/upload`,
      headers: { 'content-length': '200', 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(200)
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });

  it('concurrent race: two uploads that together exceed the cap admit exactly one', async () => {
    // Shared counter, cap 1000. Each upload declares 600 bytes.
    const store = new InMemoryStorageQuotaStore();
    const guard = new StorageQuotaGuard({ store, capBytes: () => 1000 });
    const repo = new InMemoryAssetRepository();
    const a1 = await repo.create({ name: 'a1' });
    const a2 = await repo.create({ name: 'a2' });
    const app = await buildApp({ guard, repo, storage: fakeStorage() });

    const mk = (id: string) =>
      app.inject({
        method: 'PUT',
        url: `/api/v1/assets/${id}/upload`,
        headers: { 'content-length': '600', 'content-type': 'application/octet-stream' },
        payload: Buffer.alloc(600)
      });

    const [r1, r2] = await Promise.all([mk(a1.id), mk(a2.id)]);
    const statuses = [r1.statusCode, r2.statusCode].sort();
    expect(statuses).toEqual([200, 409]);
    // Exactly one upload's bytes are committed.
    expect((await store.read()).consumedBytes).toBe(600);
    await app.close();
  });
});

describe('direct-upload upload-complete (presigned/multipart finalize) — storage cap (issue #579)', () => {
  it('rejects finalize when the stored object would exceed the cap (409 quota_exceeded)', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'presigned' });
    // Object already landed in MinIO at sources/<id> with a 400-byte size.
    const storage = fakeStorage(new Map([[`sources/${asset.id}`, 400]]));
    const guard = new StorageQuotaGuard({
      store: new InMemoryStorageQuotaStore({ consumedBytes: 800 }),
      capBytes: () => 1000
    });
    const app = await buildApp({ guard, repo, storage });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/upload-complete`
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ error: 'quota_exceeded' });
    const after = await repo.get(asset.id);
    expect(after?.status).not.toBe('processing');
    await app.close();
  });

  it('admits finalize under the cap and commits the real object size', async () => {
    const repo = new InMemoryAssetRepository();
    const asset = await repo.create({ name: 'presigned-ok' });
    const storage = fakeStorage(new Map([[`sources/${asset.id}`, 150]]));
    const store = new InMemoryStorageQuotaStore();
    const guard = new StorageQuotaGuard({ store, capBytes: () => 1000 });
    const app = await buildApp({ guard, repo, storage });

    const res = await app.inject({
      method: 'POST',
      url: `/api/v1/assets/${asset.id}/upload-complete`
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'processing' });
    expect((await store.read()).consumedBytes).toBe(150);
    await app.close();
  });
});
