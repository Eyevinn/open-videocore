// GET /health reports whether the application's 401 presence gate is wired
// (issue #1256 review, guarding the issue #711 regression).
//
// Why this exists: before the application accepted `x-jwt`, the e2e suite told
// a gated image from an un-gated one by sending `x-jwt` alone from behind the
// platform ingress and expecting the application's own 401. Now that
// `src/auth/middleware.ts` extractToken accepts that header, every request
// which clears the ingress carries a token the application admits, so the
// behavioural probe can no longer provoke that 401 and an image with NO auth
// gate answers like a gated one. `features.authGateRegistered` is the
// observable image-level signal that replaces it, so these tests pin that it
// reflects reality rather than being hardcoded true.

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import {
  serializerCompiler,
  validatorCompiler
} from 'fastify-type-provider-zod';
import { healthRouter } from '../src/routes/health.js';
import { registerAuth } from '../src/auth/middleware.js';
import type { BuildInfo } from '../src/build-info.js';
import type { ResolverHealthSnapshot } from '../src/services/resolver-health.js';

const build: BuildInfo = {
  version: 'v1.6.0-1-gdeadbee',
  commit: 'deadbee',
  sourceDigest: '11cb8d5651d972cc',
  builtAt: '2026-10-29T00:00:00Z',
  packageVersion: '1.6.0'
};

const resolver: ResolverHealthSnapshot = {
  degraded: false,
  mode: 'none',
  noStorageFallbackTotal: 0,
  staleFallbackTotal: 0,
  lastDegradedAt: null
};

// Build an instance with the health router, optionally with the explicit
// gate reader and/or with registerAuth actually wired.
async function buildApp(opts: {
  authGateRegistered?: () => boolean;
  wireAuth?: boolean;
} = {}) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  if (opts.wireAuth) {
    registerAuth(app);
  }
  await app.register(healthRouter, {
    buildInfo: build,
    resolverSnapshot: () => resolver,
    ingestSignals: () => ({
      storageAvailable: true,
      hasEnvMinio: true,
      watchFolderFlag: false
    }),
    ...(opts.authGateRegistered
      ? { authGateRegistered: opts.authGateRegistered }
      : {})
  });
  await app.ready();
  return app;
}

const features = async (app: Awaited<ReturnType<typeof buildApp>>) =>
  (await app.inject({ method: 'GET', url: '/health' })).json().features;

describe('GET /health features.authGateRegistered (issue #1256 review)', () => {
  it('reports true when the supplied reader says the gate is wired', async () => {
    const app = await buildApp({ authGateRegistered: () => true });
    expect(await features(app)).toEqual({ authGateRegistered: true });
    await app.close();
  });

  it('reports false when the gate is absent — the flag is not hardcoded', async () => {
    // The point of the whole signal: an image without the gate must say so,
    // otherwise the e2e suite would promote a #711 regression as green.
    const app = await buildApp({ authGateRegistered: () => false });
    expect(await features(app)).toEqual({ authGateRegistered: false });
    await app.close();
  });

  it('falls back to the instance decorators: false with no registerAuth', async () => {
    const app = await buildApp();
    expect((await features(app)).authGateRegistered).toBe(false);
    await app.close();
  });

  it('falls back to the instance decorators: true once registerAuth ran', async () => {
    // registerAuth before the router registration, so the child context the
    // plugin runs in has inherited the `authenticate` decorator.
    const app = await buildApp({ wireAuth: true });
    expect((await features(app)).authGateRegistered).toBe(true);
    await app.close();
  });

  it('is read per request, not captured once at boot', async () => {
    // main.ts registers the health router BEFORE it calls registerAuth, so a
    // value captured at registration time would report a live gate as absent.
    let wired = false;
    const app = await buildApp({ authGateRegistered: () => wired });
    expect((await features(app)).authGateRegistered).toBe(false);
    wired = true;
    expect((await features(app)).authGateRegistered).toBe(true);
    await app.close();
  });

  it('leaves the rest of the /health contract intact', async () => {
    const app = await buildApp({ authGateRegistered: () => true });
    const body = (await app.inject({ method: 'GET', url: '/health' })).json();
    expect(body.status).toBe('ok');
    expect(body.service).toBe('open-videocore-api');
    expect(body.build.commit).toBe('deadbee');
    expect(body.resolver.degraded).toBe(false);
    expect(body.ingest.directUpload).toEqual({ available: true });
    await app.close();
  });
});
