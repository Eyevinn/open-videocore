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
// What is asserted here, and at which layer — ALL of it runs in CI:
//   1. header-less GET semantics on BOTH thumbnail routes — an <img>-shaped
//      request to either API route is refused 401, and the URL the browser is
//      meant to use instead is an off-API, signed URL that carries no
//      Authorization requirement from this API at all.
//   2. the storage hop, end to end: the URL the route issues is signed by the
//      REAL storage client and then fetched over a real HTTP hop with no
//      Authorization header, against an object store that independently
//      recomputes the AWS SigV4 query signature (test/s3-presigned-verifier.ts)
//      and serves bytes only when it matches an unexpired presigned request.
//      Unsigned, tampered and expired variants of the same URL are refused 403.
//      No container runtime or live stack needed, so these assertions run on
//      every push (issue #803 acceptance criterion 3).
//
// On the object store this is modelled against: an earlier OSC friction log
// (agents repo, docs/osc-feedback/incoming-minio-presigned-blocked.md,
// 2026-06-02) recorded every presigned GET returning 403 from outside the
// cluster, which is why the proxying byte route exists at all. That was re-verified
// on 2026-09-25 against a live OSC storage instance from outside the cluster
// and no longer reproduces — an anonymous presigned GET returned
// 200 image/jpeg, while the unsigned, tampered and expired variants returned
// 403 AccessDenied / 403 SignatureDoesNotMatch / 403 AccessDenied (recorded in
// the agents repo as docs/osc-feedback/incoming-presigned-get-thumbnails.md,
// which supersedes the 2026-06-02 log). Those are exactly the four outcomes the
// in-process verifier reproduces, and the live re-check is kept as a gated
// sibling suite in test/thumbnail-presigned-fetch.e2e.test.ts.
//
// Contract sources verified (read before writing any assertion):
//   - GET /:id/thumbnails/:index/url — src/routes/assets.ts:4440 (handler:
//     404 unknown asset / out-of-range index, 501 no storage, 502 sign failure,
//     200 otherwise; signs via storageFor().presignedGet(objectKey, ttl) at
//     src/routes/assets.ts:4476).
//   - 200 body shape `thumbnailUrlSchema` { assetId, index, objectKey, url,
//     expiresAt, expiresInSeconds } — src/routes/assets.ts:611.
//   - GET /:id/thumbnails/:index (byte route, image/jpeg) —
//     src/routes/assets.ts:4393.
//   - 401 presence gate: `authGate` — src/auth/middleware.ts:76, attached as
//     the router's first preHandler at src/routes/assets.ts:1560; the 401 body
//     + `WWW-Authenticate: Bearer` header come from src/auth/middleware.ts:48.
//   - `requireAuth` (presence-only token check) — src/auth/workspace.ts:52.
//   - `WorkspaceStorage.presignedGet(localKey, expirySeconds)` /
//     `WorkspaceStorage` constructor (client, bucket) — src/data/storage.ts:132,
//     src/data/storage.ts:108; `thumbnailUrlTtlSeconds()` +
//     DEFAULT_THUMBNAIL_URL_TTL_SECONDS (THUMBNAIL_URL_TTL_SECONDS, default
//     300s) — src/data/storage.ts:68 / :64.
//   - storage client construction options — src/services/workspace-stack.ts:319
//     (endPoint/port/useSSL/accessKey/secretKey; the test client additionally
//     pins `region` so presigning never needs a GetBucketLocation round trip —
//     node_modules/minio/dist/esm/internal/client.mjs:539).
//   - `presignedGetObject(bucket, object, expires, respHeaders, requestDate)` —
//     node_modules/minio/dist/esm/internal/client.mjs:2619; the `requestDate`
//     parameter is what lets the expired-URL case be deterministic.
//   - harness setup (Fastify + zod compilers + registerAuth + assetsRouter with
//     a WorkspaceStorage double) reused from test/thumbnail.test.ts and
//     test/delivery.test.ts.

import { afterEach, describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { Readable } from 'node:stream';
import { Client as MinioClient } from 'minio';
import {
  startVerifyingObjectStore,
  type VerifyingObjectStore
} from './s3-presigned-verifier.js';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    // The gate on this router is presence-only (`requireAuth`,
    // src/auth/workspace.ts:52), so exactly one valid token is enough; a
    // second workspace here would imply tenant-scoping coverage this suite
    // does not have (the handler's `repo.get` is unscoped — see #803 review).
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      if (token !== 'token-a') throw new actual.AuthError('invalid token');
      return 'workspace-a';
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

// Every outbound call is bounded, per the API's own rule for external calls.
// Loopback, so this only ever fires if the fixture server wedges.
const FETCH_TIMEOUT_MS = 10_000;

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
// The storage hop, end to end, in CI.
//
// Everything above stops at "the route returned a string". These tests take the
// string the route actually issued, signed by the REAL storage client, and make
// the request a browser would make: an HTTP GET with no Authorization header,
// no cookies, nothing. The object store on the other end is
// test/s3-presigned-verifier.ts, which recomputes the AWS SigV4 query signature
// from the spec (node:crypto only, no help from the signing SDK) and serves
// bytes only when it matches an unexpired presigned request — so a URL this
// suite accepts is one a real S3-compatible store accepts, and the four
// outcomes below are the four observed live on 2026-09-25 (see file header).
// ---------------------------------------------------------------------------

const E2E_BUCKET = 'source-bucket';

async function buildAppOverVerifyingStore(): Promise<{
  app: FastifyInstance;
  repo: InMemoryAssetRepository;
  store: VerifyingObjectStore;
  client: MinioClient;
}> {
  const store = await startVerifyingObjectStore();
  const endpoint = new URL(store.endpoint);
  // Mirrors src/services/workspace-stack.ts:319, plus a pinned region so
  // signing needs no GetBucketLocation round trip (client.mjs:539).
  const client = new MinioClient({
    endPoint: endpoint.hostname,
    port: Number(endpoint.port),
    useSSL: false,
    accessKey: store.accessKey,
    secretKey: store.secretKey,
    region: store.region
  });
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repo = new InMemoryAssetRepository();
  const storage = new WorkspaceStorage(client, E2E_BUCKET);
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: repo,
    storageFor: () => storage
  });
  await app.ready();
  return { app, repo, store, client };
}

describe('a real browser fetch of the issued URL (signature-verifying object store)', () => {
  let ctx: Awaited<ReturnType<typeof buildAppOverVerifyingStore>> | undefined;

  afterEach(async () => {
    await ctx?.store.close();
    await ctx?.app.close();
    ctx = undefined;
  });

  async function mintUrl(): Promise<{ url: string; key: string }> {
    ctx = await buildAppOverVerifyingStore();
    const { app, repo, store } = ctx;
    const { id, key } = await assetWithThumbnail(app, repo);
    store.putObject(E2E_BUCKET, key, JPEG_BYTES, 'image/jpeg');

    const res = await app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/thumbnails/0/url`,
      headers: A
    });
    expect(res.statusCode).toBe(200);
    return { url: res.json().url as string, key };
  }

  it('serves 200 image/jpeg to a GET carrying NO Authorization header', async () => {
    const { url } = await mintUrl();

    // No headers, no credentials: exactly what <img src={url}> sends.
    const rendered = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

    expect(rendered.status).toBe(200);
    expect(rendered.headers.get('content-type')).toBe('image/jpeg');
    expect(Buffer.from(await rendered.arrayBuffer())).toEqual(JPEG_BYTES);
    // ...and the store confirms it authorised the request on the signature
    // alone, with no Authorization header present.
    const served = ctx!.store.requests.at(-1)!;
    expect(served.hadAuthorizationHeader).toBe(false);
    expect(served.status).toBe(200);
  });

  it('refuses the same object when the signature is stripped (403 AccessDenied)', async () => {
    const { url } = await mintUrl();

    const unsigned = new URL(url);
    unsigned.search = '';
    const refused = await fetch(unsigned, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('AccessDenied');
    expect(refused.headers.get('content-type')).not.toContain('image/jpeg');
  });

  it('refuses a tampered signature (403 SignatureDoesNotMatch)', async () => {
    const { url } = await mintUrl();

    // Same expiry window, same credential scope, one flipped signature: the
    // URL is only good for the exact object+window it was signed for.
    const tampered = new URL(url);
    tampered.searchParams.set('X-Amz-Signature', 'deadbeef'.repeat(8));
    const refused = await fetch(tampered, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('SignatureDoesNotMatch');
  });

  it('refuses a correctly signed URL once its TTL has elapsed (403 AccessDenied)', async () => {
    const { key } = await mintUrl();

    // Signed for the default TTL but backdated past it, so the signature is
    // valid and the window is not — no sleeping, no fake timers.
    const signedInThePast = await ctx!.client.presignedGetObject(
      E2E_BUCKET,
      key,
      DEFAULT_THUMBNAIL_URL_TTL_SECONDS,
      undefined,
      new Date(Date.now() - (DEFAULT_THUMBNAIL_URL_TTL_SECONDS + 60) * 1000)
    );
    const refused = await fetch(signedInThePast, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
    });

    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('AccessDenied');
  });

  it('does not serve a sibling object the URL was not signed for (403, not a blanket bucket read)', async () => {
    const { url } = await mintUrl();

    // The signature covers one key. Point it at a sibling key and the
    // signature no longer matches — a leaked thumbnail URL is not a bucket key.
    const neighbour = new URL(url);
    neighbour.pathname = `/${E2E_BUCKET}/thumbnails/someone-else/thumb_0s.jpg`;
    const refused = await fetch(neighbour, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });

    expect(refused.status).toBe(403);
    expect(await refused.text()).toContain('SignatureDoesNotMatch');
  });
});
