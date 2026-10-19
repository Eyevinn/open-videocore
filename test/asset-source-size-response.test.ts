// The stored source length is readable from the asset contract (issue #1173).
//
// `Asset.sourceSizeBytes` was persisted, mapped onto the domain type and
// actively maintained, but it was not declared on the asset RESPONSE schema —
// and the response serializer parses every body through that schema, so the
// field was stripped on its way out and no client could read a video's size.
//
// The two halves that matter here:
//   1. an asset whose ingest DID record a length serialises it, on the
//      single-asset read AND on the listing;
//   2. an asset whose finalize path did NOT learn a length serialises NO
//      `sourceSizeBytes` member at all — absence must stay absence, because a
//      coerced `0` on the wire is indistinguishable from a legitimately empty
//      source object.
//
// Contract sources (CLAUDE.md rule 7) — all read from this tree, not from prose:
//   - response contract: `assetSchema` (src/routes/assets.ts), used by
//     `GET /api/v1/assets/{id}` and — via `listSchema` — `GET /api/v1/assets/`.
//     Serialised by fastify-type-provider-zod's `serializerCompiler`, which
//     parses the handler payload through the schema, so an undeclared field
//     cannot reach the wire.
//   - domain field: `Asset.sourceSizeBytes?: number` and
//     `UpdateAssetInput.sourceSizeBytes?: number` (src/data/asset-repo.ts).
//     `update()` normalises a non-positive patch value to `undefined`, which is
//     the "nothing recorded" state asserted below.
//   - ingest paths that record it: `PUT /api/v1/assets/:id/upload` (streams the
//     body and patches `sourceSizeBytes: bytesTransferred`) and
//     `POST /api/v1/assets/:id/upload-complete` (records
//     `finalizedSourceSizeBytes(...)`, which degrades to the `0` sentinel when
//     the store reports no size) — src/routes/asset-upload.ts.
//   - store contract: `WorkspaceStorage.putStream(key, stream, opts):
//     Promise<{ etag: string; bytesTransferred: number }>` and
//     `WorkspaceStorage.statObject(localKey): Promise<{ size: number; etag:
//     string } | undefined>` (`undefined` is NotFound) — src/data/storage.ts.
//   - key layout: `sourceObjectKey(assetId) = sources/<assetId>`
//     (src/routes/asset-upload.ts), which is how the fake store below decides
//     which asset's object it knows a size for.

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Readable } from 'node:stream';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { assetsRouter } from '../src/routes/assets.js';
import { assetUploadRouter, sourceObjectKey } from '../src/routes/asset-upload.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import type { WorkspaceStorage } from '../src/data/storage.js';

// Minimal object store: it knows the size of whatever `putStream` wrote, and
// reports NotFound (`undefined`) for an object written straight to a presigned
// URL, which never transits this process. That is exactly the documented path
// that cannot learn a length.
class FakeStore {
  readonly objects = new Map<string, number>();

  async putStream(
    key: string,
    source: Readable,
    opts: { maxBytes: number; totalBytes?: number; onProgress?: (b: number, t?: number) => void }
  ): Promise<{ etag: string; bytesTransferred: number }> {
    let transferred = 0;
    for await (const chunk of source) {
      transferred += (chunk as Buffer).length;
      opts.onProgress?.(transferred, opts.totalBytes);
    }
    this.objects.set(key, transferred);
    return { etag: 'etag-1', bytesTransferred: transferred };
  }
  async statObject(key: string): Promise<{ size: number; etag: string } | undefined> {
    const size = this.objects.get(key);
    return size === undefined ? undefined : { size, etag: 'etag-1' };
  }
  async presignedPut(key: string, ttl: number): Promise<string> {
    return `https://store.example/put/${key}?ttl=${ttl}`;
  }
  async removeObject(key: string): Promise<void> {
    this.objects.delete(key);
  }
}

type Harness = {
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  store: FakeStore;
};

async function buildApp(): Promise<Harness> {
  const app = Fastify({ maxParamLength: 500 });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // Mirrors the production octet-stream parser wiring (src/main.ts) so the
  // proxied PUT reads its body as a stream.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => {
    done(null, payload);
  });

  const assets = new InMemoryAssetRepository();
  const store = new FakeStore();
  const storageFor = () => store as unknown as WorkspaceStorage;

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    storageFor
  });
  await app.register(assetUploadRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    storageFor
  });
  await app.ready();
  return { app, assets, store };
}

// An ingest that DOES learn the length: the client streams the body through the
// API, so `putStream` reports `bytesTransferred`.
async function streamedUpload(h: Harness, bytes: number): Promise<string> {
  const asset = await h.assets.create({ name: 'streamed clip' });
  const res = await h.app.inject({
    method: 'PUT',
    url: `/api/v1/assets/${asset.id}/upload`,
    headers: { 'content-length': String(bytes), 'content-type': 'application/octet-stream' },
    payload: Buffer.alloc(bytes, 7)
  });
  expect(res.statusCode).toBe(200);
  return asset.id;
}

// An ingest that does NOT learn the length: the client PUTs to a presigned URL
// (bytes never transit the API) and finalizes; the store reports no size for the
// object, so the finalize records the "nothing recorded" sentinel.
async function presignedUploadWithoutSize(h: Harness): Promise<string> {
  const asset = await h.assets.create({ name: 'presigned clip' });
  const url = await h.app.inject({
    method: 'POST',
    url: `/api/v1/assets/${asset.id}/upload-url`,
    headers: { 'content-type': 'application/json' },
    payload: {}
  });
  expect(url.statusCode).toBe(200);
  const done = await h.app.inject({
    method: 'POST',
    url: `/api/v1/assets/${asset.id}/upload-complete`,
    headers: { 'content-type': 'application/json' },
    payload: {}
  });
  expect(done.statusCode).toBe(200);
  // Precondition for the assertion that follows: this path genuinely recorded
  // nothing, rather than recording a zero.
  expect(h.store.objects.has(sourceObjectKey(asset.id))).toBe(false);
  expect((await h.assets.get(asset.id))?.sourceSizeBytes).toBeUndefined();
  return asset.id;
}

async function getAsset(h: Harness, id: string): Promise<Record<string, unknown>> {
  const res = await h.app.inject({ method: 'GET', url: `/api/v1/assets/${id}` });
  expect(res.statusCode).toBe(200);
  return res.json() as Record<string, unknown>;
}

describe('sourceSizeBytes on the asset read contract (issue #1173)', () => {
  it('serialises the recorded length on GET /api/v1/assets/:id', async () => {
    const h = await buildApp();
    const id = await streamedUpload(h, 4096);

    const body = await getAsset(h, id);
    expect(body.sourceSizeBytes).toBe(4096);
  });

  it('omits sourceSizeBytes entirely when no length was recorded', async () => {
    const h = await buildApp();
    const id = await presignedUploadWithoutSize(h);

    const body = await getAsset(h, id);
    // Not `0`: a zero on the wire would read as a legitimately empty source.
    expect(Object.keys(body)).not.toContain('sourceSizeBytes');
    expect(body.sourceSizeBytes).toBeUndefined();
  });

  it('carries the same presence/absence split across GET /api/v1/assets/', async () => {
    const h = await buildApp();
    const withSize = await streamedUpload(h, 251_658_240);
    const withoutSize = await presignedUploadWithoutSize(h);

    const res = await h.app.inject({ method: 'GET', url: '/api/v1/assets/' });
    expect(res.statusCode).toBe(200);
    const items = (res.json() as { items: Record<string, unknown>[] }).items;

    const sized = items.find((i) => i.id === withSize);
    const unsized = items.find((i) => i.id === withoutSize);
    expect(sized?.sourceSizeBytes).toBe(251_658_240);
    expect(unsized).toBeDefined();
    expect(Object.keys(unsized as Record<string, unknown>)).not.toContain('sourceSizeBytes');
  });

  it('drops the length when the object key moves without a new one', async () => {
    // The recorded length always describes the recorded key (the repository
    // invariant), so the read contract must not keep advertising a stale size
    // after a relocation.
    const h = await buildApp();
    const id = await streamedUpload(h, 8192);
    expect((await getAsset(h, id)).sourceSizeBytes).toBe(8192);

    await h.assets.update(id, { objectKey: 'sources/relocated-elsewhere' });

    const body = await getAsset(h, id);
    expect(Object.keys(body)).not.toContain('sourceSizeBytes');
  });
});
