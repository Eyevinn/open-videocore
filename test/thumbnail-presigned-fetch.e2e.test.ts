// Live re-check of the presigned thumbnail URL against a REAL object store
// (issue #803). The in-CI half of this coverage lives in
// test/thumbnail-unauthenticated-fetch.test.ts and needs nothing but Node; this
// file exists for the one question a local fixture cannot answer — whether the
// deployment's ingress in front of object storage lets an anonymous presigned
// GET through at all.
//
// Background: an OSC friction log (agents repo,
// docs/osc-feedback/incoming-minio-presigned-blocked.md, 2026-06-02) recorded
// every presigned GET returning 403 from OUTSIDE the cluster, which is why the
// proxying byte route exists at all. Re-verified 2026-09-25 against a live OSC
// storage instance from outside the cluster and it no longer reproduces:
//
//   presigned anonymous GET  → 200 image/jpeg (72175 bytes, JPEG SOI ff d8)
//   unsigned anonymous GET   → 403 AccessDenied
//   tampered signature       → 403 SignatureDoesNotMatch
//   backdated/expired URL    → 403 AccessDenied
//
// (Recorded in the agents repo as
// docs/osc-feedback/incoming-presigned-get-thumbnails.md, which supersedes the
// 2026-06-02 log.)
//
// This suite is how that re-check is re-run on any deployment, so the answer
// never has to be taken on trust again. SKIPPED unless all four env vars are
// set — like test/encore-scaler.e2e.test.ts, it needs a real stack and real
// credentials, which CI has neither of.
//
//   THUMBNAIL_E2E_S3_ENDPOINT    e.g. https://<instance>.<host>
//   THUMBNAIL_E2E_S3_ACCESS_KEY
//   THUMBNAIL_E2E_S3_SECRET_KEY
//   THUMBNAIL_E2E_S3_BUCKET      the (private) source bucket thumbnails live in
//
// Run it from OUTSIDE the cluster; run from inside, a 200 proves nothing about
// what a browser gets.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - `WorkspaceStorage.presignedGet(localKey, expirySeconds)` —
//     src/data/storage.ts:132; `new WorkspaceStorage(client, bucket)` —
//     src/data/storage.ts:108.
//   - DEFAULT_THUMBNAIL_URL_TTL_SECONDS (300) — src/data/storage.ts:64.
//   - storage client construction options — src/services/workspace-stack.ts:319.
//   - `putObject(bucketName, objectName, stream|Buffer|string, size?,
//     metaData?)` — node_modules/minio/dist/esm/internal/client.d.mts:291;
//     `presignedGetObject(bucketName, objectName, expires, respHeaders,
//     requestDate)` — node_modules/minio/dist/esm/internal/client.mjs:2619.

import { describe, expect, it } from 'vitest';
import { Client as MinioClient } from 'minio';

import { WorkspaceStorage, DEFAULT_THUMBNAIL_URL_TTL_SECONDS } from '../src/data/storage.js';

const ENDPOINT = process.env['THUMBNAIL_E2E_S3_ENDPOINT'];
const ACCESS_KEY = process.env['THUMBNAIL_E2E_S3_ACCESS_KEY'];
const SECRET_KEY = process.env['THUMBNAIL_E2E_S3_SECRET_KEY'];
const BUCKET = process.env['THUMBNAIL_E2E_S3_BUCKET'];
const SKIP = !ENDPOINT || !ACCESS_KEY || !SECRET_KEY || !BUCKET;

// Every external call is bounded, per the API's own rule for outbound calls.
const TIMEOUT_MS = 15_000;

// Smallest recognisably-JPEG payload: SOI + EOI.
const JPEG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe.skipIf(SKIP)('browser fetch of a real presigned thumbnail URL (live object store)', () => {
  function liveClient(): { client: MinioClient; storage: WorkspaceStorage; bucket: string } {
    const url = new URL(ENDPOINT as string);
    const useSSL = url.protocol === 'https:';
    const client = new MinioClient({
      endPoint: url.hostname,
      port: url.port ? Number(url.port) : useSSL ? 443 : 80,
      useSSL,
      accessKey: ACCESS_KEY as string,
      secretKey: SECRET_KEY as string
    });
    const bucket = BUCKET as string;
    return { client, storage: new WorkspaceStorage(client, bucket), bucket };
  }

  it('serves 200 image/jpeg to a header-less GET and refuses unsigned, tampered and expired GETs', async () => {
    const { client, storage, bucket } = liveClient();
    const key = `thumbnails/e2e-${Date.now()}/thumb_0s.jpg`;
    await client.putObject(bucket, key, JPEG_BYTES, JPEG_BYTES.length, {
      'Content-Type': 'image/jpeg'
    });
    try {
      const signed = await storage.presignedGet(key, DEFAULT_THUMBNAIL_URL_TTL_SECONDS);

      // The browser path: a bare GET, no headers at all.
      const rendered = await fetch(signed, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      expect(rendered.status).toBe(200);
      expect(rendered.headers.get('content-type')).toContain('image/jpeg');
      expect(Buffer.from(await rendered.arrayBuffer())).toEqual(JPEG_BYTES);

      // Same object, signature stripped: the bucket is private, so an
      // unauthenticated AND unsigned read must be refused.
      const unsigned = new URL(signed);
      unsigned.search = '';
      const strippedRes = await fetch(unsigned, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      expect(strippedRes.status).toBe(403);

      const tampered = new URL(signed);
      tampered.searchParams.set('X-Amz-Signature', 'deadbeef'.repeat(8));
      const tamperedRes = await fetch(tampered, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      expect(tamperedRes.status).toBe(403);

      // Correctly signed, but backdated past its own TTL.
      const expired = await client.presignedGetObject(
        bucket,
        key,
        DEFAULT_THUMBNAIL_URL_TTL_SECONDS,
        undefined,
        new Date(Date.now() - (DEFAULT_THUMBNAIL_URL_TTL_SECONDS + 60) * 1000)
      );
      const expiredRes = await fetch(expired, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      expect(expiredRes.status).toBe(403);
    } finally {
      await client.removeObject(bucket, key).catch(() => undefined);
    }
  });
});
