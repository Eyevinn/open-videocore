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
import { resolveBuildInfo, type BuildInfo } from '../build-info.js';
import type { ResolverHealthSnapshot } from '../services/resolver-health.js';
import type { IngestAvailabilitySignals } from '../services/ingest-availability.js';

const healthyResolver: ResolverHealthSnapshot = {
  degraded: false,
  mode: 'none',
  noStorageFallbackTotal: 0,
  staleFallbackTotal: 0,
  lastDegradedAt: null
};

const someBuild: BuildInfo = {
  version: 'v1.5.0-56-g92a13cc',
  commit: '92a13cc',
  sourceDigest: '11cb8d5651d972cc',
  builtAt: '2026-09-25T06:11:02Z',
  packageVersion: '1.5.0'
};

async function buildApp(
  signals: IngestAvailabilitySignals,
  buildInfo: BuildInfo = someBuild
) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(healthRouter, {
    buildInfo,
    resolverSnapshot: () => healthyResolver,
    ingestSignals: () => signals
  });
  await app.ready();
  return app;
}

const configured: IngestAvailabilitySignals = {
  storageAvailable: true,
  hasEnvMinio: true,
  watchFolderFlag: true
};

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

// Issue #827: a deployment reported its last release tag as its version, so a
// released build and a rolling build with the same package.json version were
// indistinguishable from the outside. /health is the single documented
// endpoint that answers "which build is this?".
describe('GET /health build identity (issue #827)', () => {
  it('reports the injected build identity alongside the package version', async () => {
    const app = await buildApp(configured);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().build).toEqual({
      version: 'v1.5.0-56-g92a13cc',
      commit: '92a13cc',
      sourceDigest: '11cb8d5651d972cc',
      builtAt: '2026-09-25T06:11:02Z',
      packageVersion: '1.5.0'
    });
    await app.close();
  });

  it('distinguishes two builds carrying the same package.json version', async () => {
    // The exact scenario from the issue: a stack built at the release tag and a
    // stack built 56 commits later. package.json says 1.5.0 on both.
    const released = await buildApp(
      configured,
      resolveBuildInfo(
        {
          BUILD_VERSION: 'v1.5.0',
          BUILD_COMMIT: '0f3c1ab',
          BUILD_SOURCE_DIGEST: 'aaaaaaaaaaaaaaaa'
        },
        '1.5.0'
      )
    );
    const rolling = await buildApp(
      configured,
      resolveBuildInfo(
        {
          BUILD_VERSION: 'v1.5.0-56-g92a13cc',
          BUILD_COMMIT: '92a13cc',
          BUILD_SOURCE_DIGEST: 'bbbbbbbbbbbbbbbb'
        },
        '1.5.0'
      )
    );

    const a = (await released.inject({ method: 'GET', url: '/health' })).json();
    const b = (await rolling.inject({ method: 'GET', url: '/health' })).json();

    // Same release line...
    expect(a.build.packageVersion).toBe(b.build.packageVersion);
    // ...different build, on every identifier that carries build identity.
    expect(a.build.version).not.toBe(b.build.version);
    expect(a.build.commit).not.toBe(b.build.commit);
    expect(a.build.sourceDigest).not.toBe(b.build.sourceDigest);

    await released.close();
    await rolling.close();
  });

  it('reports the source digest even when no git metadata was injected', async () => {
    // The platform builds the published image from the repository fork and is
    // not guaranteed to pass git-derived build args. The digest is computed by
    // the image build itself, so it is still there — and it still differs
    // between builds, which is the acceptance criterion.
    const app = await buildApp(
      configured,
      resolveBuildInfo({ BUILD_SOURCE_DIGEST: '11cb8d5651d972cc' }, '1.5.0')
    );
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.build.sourceDigest).toBe('11cb8d5651d972cc');
    expect(body.build.version).toBe('unknown');
    expect(body.build.commit).toBe('unknown');
    expect(body.build.builtAt).toBeNull();
    await app.close();
  });

  it('serves the full build string unauthenticated (deliberate, issue #827)', async () => {
    // Design call recorded in src/routes/health.ts: the full build string is
    // NOT auth-gated. This test exists so that gating it later is a conscious
    // change rather than an accident — no Authorization header is sent here.
    const app = await buildApp(configured);
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json().build.version).toBe('v1.5.0-56-g92a13cc');
    await app.close();
  });
});
