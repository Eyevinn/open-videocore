// Regression tests for issue #344: POST /api/v1/assets/ingest-url must validate
// its request body against the published schema and REJECT unknown / non-
// actionable properties with a 4xx, rather than silently accepting and
// discarding them (a dropped-metadata bug that used to be expensive to find).
//
// The accepted set is exactly the fields the handler acts on today (`sourceUrl`,
// `name`, `description`) PLUS `title` and `tags`, which issue #343 (separate
// branch) wires into the descriptive namespace. `title`/`tags` are allowed here
// even though main's handler does not yet read them, so #343 and #344 compose
// without a validation regression.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';

import { assetsRouter, type StorageFactory } from './assets.js';

// A no-op storage factory: URL-pull ingest responds 501 unless one is present.
// The stubbed runPull below never touches it, so an empty object is enough.
const storageFor: StorageFactory = () => ({}) as never;

// Stub the in-process pull worker so the accepted request returns 202 without
// performing any real network / S3 work.
const runPull = vi.fn(async () => undefined);

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    storageFor,
    runPull: runPull as never
  });
  await app.ready();
  return app;
}

beforeEach(() => {
  runPull.mockClear();
});

describe('POST /api/v1/assets/ingest-url body validation (issue #344)', () => {
  it('accepts a request with honoured fields incl. title and tags', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/ingest-url',
      // s3:// avoids the SSRF DNS lookup (only http/https hosts are resolved),
      // keeping the test hermetic.
      payload: {
        sourceUrl: 's3://ingest-bucket/clip.mp4',
        name: 'My Clip',
        description: 'a short clip',
        title: 'My Clip Title',
        tags: ['news', 'sports']
      }
    });

    expect(res.statusCode).toBe(202);
    const body = res.json() as { assetId: string; jobId: string };
    expect(body.assetId).toBeTruthy();
    expect(body.jobId).toBeTruthy();
  });

  it('rejects a request with an unknown property (400)', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/ingest-url',
      payload: {
        sourceUrl: 's3://ingest-bucket/clip.mp4',
        // Not part of the accepted shape — previously accepted and silently
        // dropped; now it must fail validation.
        metadata: { dropped: 'silently' }
      }
    });

    expect(res.statusCode).toBe(400);
    const body = res.json() as { message?: string };
    // Descriptive error: the message names the unrecognized key.
    expect(typeof body.message).toBe('string');
    expect(body.message).toMatch(/metadata/);
    // The unknown property must not have kicked off any ingest work.
    expect(runPull).not.toHaveBeenCalled();
  });
});
