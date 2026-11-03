// Optional thumbnail size selector (issue #1304).
//
// Covers the `?size=small|medium|full` query parameter on both index-addressed
// thumbnail routes:
//   - GET /:id/thumbnails/:index/url   (presigned URL, src/routes/assets.ts)
//   - GET /:id/thumbnails/:index       (byte proxy, same file)
// for each size, the not-recorded fallback (which must stay 200), the invalid
// value (400), and the invariant the issue is explicit about: the INDEX keeps
// its meaning and `thumbnails: string[]` is untouched.
//
// Contract sources verified:
//   - route handlers `/:id/thumbnails/:index` and `/:id/thumbnails/:index/url`
//     in src/routes/assets.ts, plus `thumbnailUrlSchema` (the 200 body) and
//     `thumbnailSizeQuerySchema` (the new parameter) in the same file.
//   - `ThumbnailSize` = { fullObjectKey, variant: 'small' | 'medium', width,
//     objectKey } — src/data/asset-repo.ts:457 — reachable through
//     `UpdateAssetInput.thumbnailSizes` (src/data/asset-repo.ts:841) and applied
//     by `InMemoryAssetRepository.applyPatch` (src/data/asset-repo.ts:1872).
//   - `scaledThumbnailObjectKey(assetId, timecodeSeconds, width)` and
//     `THUMBNAIL_SIZE_VARIANTS` (medium = 1280, small = 360) —
//     src/pipeline/thumbnail.ts. Imported here rather than hand-written, so the
//     `thumb_<t>s_360.jpg` / `_1280.jpg` convention these tests assert is the
//     one the #1303 extraction pipeline actually writes.
//   - `WorkspaceStorage.presignedGet` / `.getObject` — src/data/storage.ts.
//   - harness (Fastify + zod compilers + registerAuth + assetsRouter with a
//     WorkspaceStorage double) reused from test/thumbnail-unauthenticated-fetch.ts.

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { Readable } from 'node:stream';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      if (token !== 'token-a') throw new actual.AuthError('invalid token');
      return 'workspace-a';
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import type { ThumbnailSize } from '../src/data/asset-repo.js';
import {
  scaledThumbnailObjectKey,
  thumbnailObjectKey,
  THUMBNAIL_SIZE_VARIANTS
} from '../src/pipeline/thumbnail.js';
import type { WorkspaceStorage } from '../src/data/storage.js';

const A = { authorization: 'Bearer token-a' };

const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

// Widths read off the pipeline's own variant table, not restated, so these
// tests fail if #1303's size definitions ever move.
const widthOf = (variant: 'small' | 'medium'): number => {
  const entry = THUMBNAIL_SIZE_VARIANTS.find((v) => v.variant === variant);
  if (!entry) throw new Error(`no THUMBNAIL_SIZE_VARIANTS entry for ${variant}`);
  return entry.width;
};

function fakeStorage(): {
  storage: WorkspaceStorage;
  presignedGet: ReturnType<typeof vi.fn>;
  getObject: ReturnType<typeof vi.fn>;
} {
  const presignedGet = vi.fn(
    async (key: string, ttl?: number) =>
      `https://object-store.example/source-bucket/${key}?X-Amz-Expires=${ttl}&X-Amz-Signature=deadbeef`
  );
  const getObject = vi.fn(async (_key: string) => Readable.from([JPEG_BYTES]));
  const storage = {
    presignedGet,
    getObject,
    statObject: vi.fn(async () => ({ size: JPEG_BYTES.length, etag: 'etag' }))
  } as unknown as WorkspaceStorage;
  return { storage, presignedGet, getObject };
}

async function buildApp(): Promise<{
  app: FastifyInstance;
  repo: InMemoryAssetRepository;
  presignedGet: ReturnType<typeof vi.fn>;
  getObject: ReturnType<typeof vi.fn>;
}> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryAssetRepository();
  const { storage, presignedGet, getObject } = fakeStorage();
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    storageFor: () => storage
  });
  await app.ready();
  return { app, repo, presignedGet, getObject };
}

// An asset extracted WITH `THUMBNAIL_MULTI_SIZE=true`: two frames, each with a
// recorded small and medium variant. Exactly the shape the #1303 orchestrator
// writes (src/pipeline/thumbnail.ts — only storage-confirmed variants recorded).
async function assetWithAllSizes(
  app: FastifyInstance,
  repo: InMemoryAssetRepository
): Promise<{ id: string; fullKeys: string[] }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: A,
    payload: { name: 'clip' }
  });
  const id = res.json().id as string;
  const timecodes = [0, 30];
  const fullKeys = timecodes.map((t) => thumbnailObjectKey(id, t));
  const thumbnailSizes: ThumbnailSize[] = timecodes.flatMap((t, i) =>
    (['small', 'medium'] as const).map((variant) => ({
      fullObjectKey: fullKeys[i]!,
      variant,
      width: widthOf(variant),
      objectKey: scaledThumbnailObjectKey(id, t, widthOf(variant))
    }))
  );
  await repo.update(id, { objectKey: `ingest/${id}`, thumbnails: fullKeys, thumbnailSizes });
  return { id, fullKeys };
}

// A pre-#1303 asset (or one extracted with the flag off): full-size keys only,
// `thumbnailSizes` absent. This is the fallback case the issue requires to be a
// 200 with the full-size object, never a 404.
async function assetWithoutSizes(
  app: FastifyInstance,
  repo: InMemoryAssetRepository
): Promise<{ id: string; fullKey: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: A,
    payload: { name: 'legacy clip' }
  });
  const id = res.json().id as string;
  const fullKey = thumbnailObjectKey(id, 0);
  await repo.update(id, { objectKey: `ingest/${id}`, thumbnails: [fullKey] });
  return { id, fullKey };
}

describe('GET /:id/thumbnails/:index/url?size=', () => {
  it('signs the recorded small variant (thumb_<t>s_360.jpg) for size=small', async () => {
    const { app, repo, presignedGet } = await buildApp();
    const { id } = await assetWithAllSizes(app, repo);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/thumbnails/0/url?size=small`,
      headers: A
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.objectKey).toBe(scaledThumbnailObjectKey(id, 0, 360));
    expect(body.objectKey).toMatch(/thumb_0s_360\.jpg$/);
    expect(body.size).toBe('small');
    // The key handed to the signer is the scaled one, not the full frame.
    expect(presignedGet.mock.calls[0]?.[0]).toBe(body.objectKey);
    // Index semantics unchanged: the response still reports the index asked for.
    expect(body.index).toBe(0);
    expect(body.url).toContain('X-Amz-Signature');
  });

  it('signs the recorded medium variant (thumb_<t>s_1280.jpg) for size=medium', async () => {
    const { app, repo, presignedGet } = await buildApp();
    const { id } = await assetWithAllSizes(app, repo);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/thumbnails/0/url?size=medium`,
      headers: A
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.objectKey).toBe(scaledThumbnailObjectKey(id, 0, 1280));
    expect(body.objectKey).toMatch(/thumb_0s_1280\.jpg$/);
    expect(body.size).toBe('medium');
    expect(presignedGet.mock.calls[0]?.[0]).toBe(body.objectKey);
  });

  it('serves the full frame for size=full and for a request with no size at all', async () => {
    const { app, repo } = await buildApp();
    const { id, fullKeys } = await assetWithAllSizes(app, repo);

    for (const url of [
      `/api/v1/assets/${id}/thumbnails/0/url?size=full`,
      `/api/v1/assets/${id}/thumbnails/0/url`
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: A });
      expect(res.statusCode).toBe(200);
      // Default is `full`, so an existing client that never learns about the
      // parameter keeps getting byte-identical behaviour.
      expect(res.json().objectKey).toBe(fullKeys[0]);
      expect(res.json().size).toBe('full');
    }
  });

  it('falls back to the full key with 200 when the asset has no recorded sizes', async () => {
    const { app, repo, presignedGet } = await buildApp();
    const { id, fullKey } = await assetWithoutSizes(app, repo);

    for (const size of ['small', 'medium'] as const) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${id}/thumbnails/0/url?size=${size}`,
        headers: A
      });
      // The size is a preference, not a selector that can fail: a pre-#1303
      // asset answers 200 with the full frame rather than 404.
      expect(res.statusCode).toBe(200);
      expect(res.json().objectKey).toBe(fullKey);
      // `size` reports what was SERVED, so the caller can see the fallback.
      expect(res.json().size).toBe('full');
    }
    // Nothing that does not exist was ever signed.
    for (const call of presignedGet.mock.calls) {
      expect(call[0]).toBe(fullKey);
    }
  });

  it('falls back per-size on a partial extraction (medium landed, small did not)', async () => {
    const { app, repo } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets',
      headers: A,
      payload: { name: 'partial' }
    });
    const id = res.json().id as string;
    const fullKey = thumbnailObjectKey(id, 12);
    await repo.update(id, {
      objectKey: `ingest/${id}`,
      thumbnails: [fullKey],
      thumbnailSizes: [
        {
          fullObjectKey: fullKey,
          variant: 'medium',
          width: 1280,
          objectKey: scaledThumbnailObjectKey(id, 12, 1280)
        }
      ]
    });

    const medium = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/thumbnails/0/url?size=medium`,
      headers: A
    });
    expect(medium.statusCode).toBe(200);
    expect(medium.json().objectKey).toBe(scaledThumbnailObjectKey(id, 12, 1280));
    expect(medium.json().size).toBe('medium');

    const small = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/thumbnails/0/url?size=small`,
      headers: A
    });
    expect(small.statusCode).toBe(200);
    expect(small.json().objectKey).toBe(fullKey);
    expect(small.json().size).toBe('full');
  });

  it('resolves the size of the frame AT THAT INDEX, not of the first one', async () => {
    const { app, repo } = await buildApp();
    const { id } = await assetWithAllSizes(app, repo);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/thumbnails/1/url?size=small`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    // Frame at t=30s, index 1 — the sizes hang off the full key, so the index
    // meaning is unchanged (issue #1303/#1304).
    expect(res.json().objectKey).toBe(scaledThumbnailObjectKey(id, 30, 360));
    expect(res.json().index).toBe(1);
  });

  it('rejects an unrecognised size with 400 and signs nothing', async () => {
    const { app, repo, presignedGet } = await buildApp();
    const { id } = await assetWithAllSizes(app, repo);

    for (const bad of ['tiny', 'SMALL', 'thumb', '360', '']) {
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${id}/thumbnails/0/url?size=${bad}`,
        headers: A
      });
      // Boundary validation 400 — the same envelope every other invalid query
      // or body on this router produces (see test/asset-detail-lock-actions.ts,
      // which pins `code: 'FST_ERR_VALIDATION'` for this router).
      expect(res.statusCode).toBe(400);
      const body = res.json();
      expect(typeof body.message).toBe('string');
      expect(body.message).toContain('size');
    }
    expect(presignedGet).not.toHaveBeenCalled();
  });

  it('still 404s an out-of-range index regardless of the requested size', async () => {
    const { app, repo } = await buildApp();
    const { id } = await assetWithAllSizes(app, repo);

    for (const url of [
      `/api/v1/assets/${id}/thumbnails/99/url?size=small`,
      `/api/v1/assets/${id}/thumbnails/not-a-number/url?size=medium`
    ]) {
      const res = await app.inject({ method: 'GET', url, headers: A });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toBe('not_found');
    }
  });

  it('does not change the thumbnails list route (index-keyed proxy URLs, no size)', async () => {
    const { app, repo } = await buildApp();
    const { id, fullKeys } = await assetWithAllSizes(app, repo);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/thumbnails`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    // `thumbnails: string[]` is one entry per FULL frame, still addressed by
    // index — the scaled variants never appear as extra list entries.
    expect(res.json().thumbnails).toEqual(
      fullKeys.map((_k, i) => `/api/v1/assets/${id}/thumbnails/${i}`)
    );
  });
});

describe('GET /:id/thumbnails/:index?size= (byte proxy)', () => {
  it('streams the recorded scaled object for small and medium', async () => {
    const { app, repo, getObject } = await buildApp();
    const { id } = await assetWithAllSizes(app, repo);

    for (const [size, width] of [
      ['small', 360],
      ['medium', 1280]
    ] as const) {
      getObject.mockClear();
      const res = await app.inject({
        method: 'GET',
        url: `/api/v1/assets/${id}/thumbnails/0?size=${size}`,
        headers: A
      });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toContain('image/jpeg');
      expect(getObject).toHaveBeenCalledWith(scaledThumbnailObjectKey(id, 0, width));
      // The bytes cannot say which rendition they are, so the header does.
      expect(res.headers['x-thumbnail-size']).toBe(size);
      expect(res.rawPayload).toEqual(JPEG_BYTES);
    }
  });

  it('streams the full object when no size is asked for', async () => {
    const { app, repo, getObject } = await buildApp();
    const { id, fullKeys } = await assetWithAllSizes(app, repo);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/thumbnails/0`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(getObject).toHaveBeenCalledWith(fullKeys[0]);
    expect(res.headers['x-thumbnail-size']).toBe('full');
  });

  it('falls back to the full object (200) when the size was never recorded', async () => {
    const { app, repo, getObject } = await buildApp();
    const { id, fullKey } = await assetWithoutSizes(app, repo);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/thumbnails/0?size=small`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    expect(getObject).toHaveBeenCalledWith(fullKey);
    expect(res.headers['x-thumbnail-size']).toBe('full');
    expect(res.rawPayload).toEqual(JPEG_BYTES);
  });

  it('rejects an unrecognised size with 400 and fetches nothing', async () => {
    const { app, repo, getObject } = await buildApp();
    const { id } = await assetWithAllSizes(app, repo);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/thumbnails/0?size=tiny`,
      headers: A
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['content-type']).not.toContain('image/jpeg');
    expect(getObject).not.toHaveBeenCalled();
  });
});
