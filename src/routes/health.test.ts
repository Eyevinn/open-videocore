// Tests for GET /health ingest-availability surface (issue #644).
//
// Builds the healthRouter over a real Fastify instance (with the zod type
// provider, exactly as main.ts wires it) and drives it with app.inject(), so
// the response schema is exercised end-to-end. Covers the acceptance criteria:
// watch-folder reported available only when prerequisites are satisfied, a
// machine-readable reason when unavailable, and direct upload + URL pull
// reported alongside.

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';
import { healthRouter } from './health.js';
import type { ResolverHealthSnapshot } from '../services/resolver-health.js';
import type { IngestAvailabilitySignals } from '../services/ingest-availability.js';

const healthyResolver: ResolverHealthSnapshot = {
  degraded: false,
  mode: 'none',
  noStorageFallbackTotal: 0,
  staleFallbackTotal: 0,
  lastDegradedAt: null
};

async function buildApp(signals: IngestAvailabilitySignals) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(healthRouter, {
    resolverSnapshot: () => healthyResolver,
    ingestSignals: () => signals
  });
  await app.ready();
  return app;
}

describe('GET /health ingest availability (issue #644)', () => {
  it('reports all ingest methods available when fully configured', async () => {
    const app = await buildApp({
      storageAvailable: true,
      hasEnvMinio: true,
      watchFolderFlag: true
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.ingest.directUpload).toEqual({ available: true });
    expect(body.ingest.urlPull).toEqual({ available: true });
    expect(body.ingest.watchFolder).toEqual({ available: true });
    await app.close();
  });

  it('reports watch folder unavailable with a machine-readable reason when enabled but no MINIO_URL', async () => {
    const app = await buildApp({
      storageAvailable: true,
      hasEnvMinio: false,
      watchFolderFlag: true
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();
    // Direct upload + URL pull are still available (param-store-backed storage).
    expect(body.ingest.directUpload.available).toBe(true);
    expect(body.ingest.urlPull.available).toBe(true);
    // Watch folder is discoverably misconfigured.
    expect(body.ingest.watchFolder).toEqual({
      available: false,
      reason: 'missing-storage-endpoint'
    });
    await app.close();
  });

  it('reports watch folder not-enabled and storage-gated methods unavailable when no storage at all', async () => {
    const app = await buildApp({
      storageAvailable: false,
      hasEnvMinio: false,
      watchFolderFlag: false
    });
    const res = await app.inject({ method: 'GET', url: '/health' });
    const body = res.json();
    expect(body.ingest.directUpload).toEqual({
      available: false,
      reason: 'no-storage-endpoint'
    });
    expect(body.ingest.urlPull).toEqual({
      available: false,
      reason: 'no-storage-endpoint'
    });
    expect(body.ingest.watchFolder).toEqual({
      available: false,
      reason: 'not-enabled'
    });
    await app.close();
  });
});
