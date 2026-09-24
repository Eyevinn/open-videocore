// Unauthenticated browser-fetch coverage for thumbnail rendering (issue #803,
// broken out of #785; the route itself landed as #800).
//
// The regression this guards: a page renders a thumbnail with a plain
// `<img src=...>`, and a browser `<img>` GET carries NO Authorization header.
// Pointed at the bearer-gated byte route it fails silently (the browser only
// sees a non-200 and swallows it), which is exactly how the original bug went
// unnoticed. The fix is the URL-issuing sibling route: the API hands back a
// short-lived signed object-store URL that a header-less GET can use.
//
// What is asserted here, and at which layer:
//   1. header-less GET semantics on BOTH thumbnail routes (this suite, in
//      process, runs in CI) — an <img>-shaped request to either API route is
//      refused 401, and the URL the browser is meant to use instead is an
//      off-API, signed URL that carries no Authorization requirement from this
//      API at all.
//   2. the storage hop — an actual header-less GET of the issued URL returning
//      200 image/jpeg, and the same object refusing an UNSIGNED GET — needs a
//      live object store. It cannot be proven against a test double (a double
//      would only be asserting its own stub logic), so it lives in the gated
//      `describe.skipIf` block at the bottom, implemented against the real
//      signer + real object store and skipped when no stack is wired up. Same
//      honesty pattern as test/burn-in-decoded-frame.e2e.test.ts.
//      See docs/osc-feedback/incoming-minio-presigned-blocked.md — whether an
//      anonymous presigned GET is reachable from outside the cluster is still
//      an open question against OSC storage, so asserting a 200 from a stub
//      here would be actively misleading.
//
// Contract sources verified (read before writing any assertion):
//   - GET /:id/thumbnails/:index/url — src/routes/assets.ts:4431 (handler:
//     404 unknown asset / out-of-range index, 501 no storage, 502 sign failure,
//     200 otherwise; signs via storageFor().presignedGet(objectKey, ttl) at
//     src/routes/assets.ts:4467).
//   - 200 body shape `thumbnailUrlSchema` { assetId, index, objectKey, url,
//     expiresAt, expiresInSeconds } — src/routes/assets.ts:611.
//   - GET /:id/thumbnails/:index (byte route, image/jpeg) —
//     src/routes/assets.ts:4384.
//   - 401 presence gate: `authGate` — src/auth/middleware.ts:76, attached as
//     the router's first preHandler at src/routes/assets.ts:1560; the 401 body
//     + `WWW-Authenticate: Bearer` header come from src/auth/middleware.ts:44.
//   - `requireAuth` (presence-only token check) — src/auth/workspace.ts:52.
//   - `WorkspaceStorage.presignedGet(localKey, expirySeconds)` /
//     `WorkspaceStorage` constructor (client, bucket) — src/data/storage.ts:132,
//     src/data/storage.ts:108; `thumbnailUrlTtlSeconds()` +
//     DEFAULT_THUMBNAIL_URL_TTL_SECONDS (THUMBNAIL_URL_TTL_SECONDS, default
//     300s) — src/data/storage.ts:68 / :64.
//   - live MinioClient construction options — src/services/workspace-stack.ts:319.
//   - harness setup (Fastify + zod compilers + registerAuth + assetsRouter with
//     a WorkspaceStorage double) reused from test/thumbnail.test.ts and
//     test/delivery.test.ts.

import { afterEach, describe, it, expect, vi } from 'vitest';
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
      const map: Record<string, string> = { 'token-a': 'workspace-a', 'token-b': 'workspace-b' };
      const ws = token ? map[token] : undefined;
      if (!ws) throw new actual.AuthError('invalid token');
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { WorkspaceStorage, DEFAULT_THUMBNAIL_URL_TTL_SECONDS } from '../src/data/storage.js';

const A = { authorization: 'Bearer token-a' };

// Smallest thing that is recognisably JPEG bytes: SOI + EOI markers. The byte
// route streams whatever storage hands back, so the exact payload only has to
// be distinguishable from an error body.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

// Storage double. `presignedGet` returns an ABSOLUTE URL on a different origin
// than the API — that is the real signer's shape (src/data/storage.ts:132
// delegates to the SDK's presignedGetObject, which returns an absolute
// object-store URL). No assertion below depends on the double's own
// authorisation behaviour; the double is only a seam for "what did the route
// ask to be signed, and did it return that verbatim".
function fakeStorage(): {
  storage: WorkspaceStorage;
  presignedGet: ReturnType<typeof vi.fn>;
} {
  const presignedGet = vi.fn(
    async (key: string, ttl?: number) =>
      `https://object-store.example/source-bucket/${key}?X-Amz-Expires=${ttl}&X-Amz-Signature=deadbeef`
  );
  const storage = {
    presignedGet,
    getObject: vi.fn(async () => Readable.from([JPEG_BYTES])),
    statObject: vi.fn(async () => ({ size: JPEG_BYTES.length, etag: 'etag' }))
  } as unknown as WorkspaceStorage;
  return { storage, presignedGet };
}

async function buildApp(
  opts: { withStorage?: boolean } = {}
): Promise<{
  app: FastifyInstance;
  repo: InMemoryAssetRepository;
  presignedGet: ReturnType<typeof vi.fn>;
}> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryAssetRepository();
  const { storage, presignedGet } = fakeStorage();
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    storageFor: opts.withStorage === false ? undefined : () => storage
  });
  await app.ready();
  return { app, repo, presignedGet };
}

// An asset with one recorded thumbnail key, i.e. the state a list/detail page
// is in when it decides to render an <img>.
async function assetWithThumbnail(
  app: FastifyInstance,
  repo: InMemoryAssetRepository
): Promise<{ id: string; key: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/api/v1/assets',
    headers: A,
    payload: { name: 'clip' }
  });
  const id = res.json().id as string;
  const key = `thumbnails/${id}/thumb_0s.jpg`;
  await repo.update(id, { objectKey: `ingest/${id}`, thumbnails: [key] });
  return { id, key };
}

afterEach(() => {
  delete process.env['THUMBNAIL_URL_TTL_SECONDS'];
});

describe('thumbnail URL issuance (GET /:id/thumbnails/:index/url)', () => {
  it('hands back an off-API signed URL a header-less <img> GET can use', async () => {
    const { app, repo } = await buildApp();
    const { id, key } = await assetWithThumbnail(app, repo);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/thumbnails/0/url`,
      headers: A
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    // Response contract: src/routes/assets.ts:611 (thumbnailUrlSchema).
    expect(body.assetId).toBe(id);
    expect(body.index).toBe(0);
    expect(body.objectKey).toBe(key);
    expect(typeof body.url).toBe('string');
    expect(typeof body.expiresAt).toBe('string');
    expect(body.expiresInSeconds).toBe(DEFAULT_THUMBNAIL_URL_TTL_SECONDS);

    // The point of the whole change: the URL the browser is told to load is NOT
    // a path on this API, so loading it never traverses the bearer gate that an
    // <img> cannot satisfy. It is absolute, on the object store's origin, and
    // carries the signature as query parameters.
    const url = new URL(body.url);
    expect(url.protocol).toMatch(/^https?:$/);
    expect(url.pathname.startsWith('/api/')).toBe(false);
    expect(url.searchParams.get('X-Amz-Signature')).toBeTruthy();
  });

  it('signs the recorded object key for the configured TTL and reports that window', async () => {
    process.env['THUMBNAIL_URL_TTL_SECONDS'] = '120';
    const { app, repo, presignedGet } = await buildApp();
    const { id, key } = await assetWithThumbnail(app, repo);

    const before = Date.now();
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/thumbnails/0/url`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();

    // Contract: presignedGet(objectKey, ttl) — src/routes/assets.ts:4467,
    // src/data/storage.ts:132. The URL is returned verbatim, so a browser gets
    // the signature exactly as the signer produced it.
    expect(presignedGet).toHaveBeenCalledWith(key, 120);
    expect(body.url).toBe(await presignedGet.mock.results[0].value);
    expect(body.expiresInSeconds).toBe(120);
    // expiresAt is derived from the same window that was signed, so a caller can
    // schedule a refresh without re-deriving it.
    const expiresAt = Date.parse(body.expiresAt);
    expect(expiresAt).toBeGreaterThanOrEqual(before + 120_000 - 5_000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 120_000 + 5_000);
  });

  it('still requires a bearer token to MINT a URL — an <img> GET cannot', async () => {
    const { app, repo } = await buildApp();
    const { id } = await assetWithThumbnail(app, repo);

    // No Authorization header: exactly what a browser sends for <img src=...>.
    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/thumbnails/0/url`
    });

    // 401 presence gate — src/auth/middleware.ts:44.
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
    expect(res.json().error).toBe('unauthorized');
    // Nothing signed leaks into an anonymous response.
    expect(res.body).not.toContain('X-Amz-Signature');
  });

  it('refuses an anonymous request before resolving the asset (no existence leak)', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assets/does-not-exist/thumbnails/0/url'
    });
    // 401, not 404: the gate runs before the handler, so an anonymous caller
    // cannot probe which asset ids exist.
    expect(res.statusCode).toBe(401);
  });
});

describe('unauthenticated access to the thumbnail bytes is still refused', () => {
  it('the token-protected byte route rejects a no-Authorization GET (the original silent failure)', async () => {
    const { app, repo } = await buildApp();
    const { id } = await assetWithThumbnail(app, repo);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/thumbnails/0`
    });

    // This is the request an <img src="/api/v1/assets/<id>/thumbnails/0"> makes.
    // It is refused, which is why thumbnails rendered as a broken/blank image
    // and why the URL-issuing route exists.
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).not.toContain('image/jpeg');
    expect(res.rawPayload.subarray(0, 2)).not.toEqual(JPEG_BYTES.subarray(0, 2));
  });

  it('serves the same bytes to a bearer-carrying caller (the refusal is about auth, not a missing object)', async () => {
    const { app, repo } = await buildApp();
    const { id } = await assetWithThumbnail(app, repo);

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/thumbnails/0`,
      headers: A
    });

    // Byte route contract: src/routes/assets.ts:4384 (image/jpeg stream).
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('image/jpeg');
    expect(res.rawPayload).toEqual(JPEG_BYTES);
  });

  it('rejects a bearer-less GET even for an unknown asset and a bad index', async () => {
    const { app, repo } = await buildApp();
    const { id } = await assetWithThumbnail(app, repo);

    for (const url of [
      '/api/v1/assets/does-not-exist/thumbnails/0',
      `/api/v1/assets/${id}/thumbnails/99`,
      `/api/v1/assets/${id}/thumbnails/not-a-number`
    ]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(401);
    }
  });
});

// ---------------------------------------------------------------------------
// Storage hop — real signed URL against a real object store.
//
// GATED, and skipped by default. Proving that a header-less GET of the issued
// URL returns 200 image/jpeg — and that the SAME object refuses an unsigned GET
// — is a statement about the object store's signature verification and bucket
// policy, not about this API. A test double cannot establish it (it would only
// re-assert the double's own stub), and there is no object store in CI or in the
// dev container, so this block runs ONLY when one is wired up via env:
//
//   THUMBNAIL_E2E_S3_ENDPOINT    e.g. https://minio.example:9000
//   THUMBNAIL_E2E_S3_ACCESS_KEY
//   THUMBNAIL_E2E_S3_SECRET_KEY
//   THUMBNAIL_E2E_S3_BUCKET      the (private) source bucket thumbnails live in
//
// Run it from OUTSIDE the cluster: that is the exact verification
// docs/osc-feedback/incoming-minio-presigned-blocked.md is still waiting on —
// whether an anonymous presigned GET is reachable at all, or whether the 403
// recorded there is unchanged.
// ---------------------------------------------------------------------------

const E2E_ENDPOINT = process.env['THUMBNAIL_E2E_S3_ENDPOINT'];
const E2E_ACCESS_KEY = process.env['THUMBNAIL_E2E_S3_ACCESS_KEY'];
const E2E_SECRET_KEY = process.env['THUMBNAIL_E2E_S3_SECRET_KEY'];
const E2E_BUCKET = process.env['THUMBNAIL_E2E_S3_BUCKET'];
const E2E_SKIP = !E2E_ENDPOINT || !E2E_ACCESS_KEY || !E2E_SECRET_KEY || !E2E_BUCKET;

// Every external call is bounded, per the API's own rule for outbound calls.
const E2E_TIMEOUT_MS = 15_000;

describe.skipIf(E2E_SKIP)('browser fetch of a real presigned thumbnail URL (live object store)', () => {
  // Built inside the block so the import is not paid for in the skipped case.
  async function liveStorage(): Promise<{ storage: WorkspaceStorage; put: (key: string) => Promise<void>; remove: (key: string) => Promise<void> }> {
    const { Client: MinioClient } = await import('minio');
    const url = new URL(E2E_ENDPOINT as string);
    const useSSL = url.protocol === 'https:';
    // Client options mirror src/services/workspace-stack.ts:319.
    const client = new MinioClient({
      endPoint: url.hostname,
      port: url.port ? Number(url.port) : useSSL ? 443 : 80,
      useSSL,
      accessKey: E2E_ACCESS_KEY as string,
      secretKey: E2E_SECRET_KEY as string
    });
    const bucket = E2E_BUCKET as string;
    return {
      storage: new WorkspaceStorage(client, bucket),
      // putObject(bucket, key, payload, size, metaData) —
      // node_modules/minio/dist/esm/internal/client.d.mts:291.
      put: async (key: string) => {
        await client.putObject(bucket, key, JPEG_BYTES, JPEG_BYTES.length, {
          'Content-Type': 'image/jpeg'
        });
      },
      remove: async (key: string) => {
        await client.removeObject(bucket, key);
      }
    };
  }

  it('a GET with NO Authorization header returns 200 image/jpeg, and the same object refuses an unsigned GET', async () => {
    const { storage, put, remove } = await liveStorage();
    const key = `thumbnails/e2e-${Date.now()}/thumb_0s.jpg`;
    await put(key);
    try {
      const signed = await storage.presignedGet(key, DEFAULT_THUMBNAIL_URL_TTL_SECONDS);

      // The browser path: a bare GET, no headers at all.
      const rendered = await fetch(signed, { signal: AbortSignal.timeout(E2E_TIMEOUT_MS) });
      expect(rendered.status).toBe(200);
      expect(rendered.headers.get('content-type')).toContain('image/jpeg');
      expect(Buffer.from(await rendered.arrayBuffer())).toEqual(JPEG_BYTES);

      // Same object, signature stripped: the bucket is private, so an
      // unauthenticated AND unsigned read must be refused.
      const unsigned = new URL(signed);
      unsigned.search = '';
      const refused = await fetch(unsigned, { signal: AbortSignal.timeout(E2E_TIMEOUT_MS) });
      expect([401, 403]).toContain(refused.status);
    } finally {
      await remove(key).catch(() => undefined);
    }
  });
});
