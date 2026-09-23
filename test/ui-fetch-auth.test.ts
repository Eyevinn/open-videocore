// @vitest-environment happy-dom
//
// Regression test for the ops UI's own request path (issue #741, from #734).
// #711's auth gate was covered only by test/workspace-acl.test.ts, which asserts
// 401 for anonymous API traffic. Nothing drove the bundled UI's apiFetch()
// (public/app.js) against a gated router, so the #734 UI regression — apiFetch
// sending no bearer credential — shipped undetected.
//
// Verified contract (per CLAUDE.md rule 7):
//   - authGate(app) 401 presence gate: src/auth/middleware.ts:76-87 (issue #711),
//     rejecting anonymous requests with { error: 'unauthorized' } + WWW-Authenticate.
//   - apiFetch(): public/app.js:137-172 — builds headers and calls fetch().
//   - GET /api/v1/assets list route: src/routes/assets.ts (assetsRouter).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { apiFetch } from '../public/app.js';

async function buildGatedApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repository = new InMemoryAssetRepository();
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository });
  await app.ready();
  return app;
}

describe('ops UI fetch path against a gated router (issue #741)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildGatedApp();
    // Route the UI's global fetch through Fastify's injector so apiFetch()
    // exercises the real authGate without a live socket.
    vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
      const u = new URL(url);
      const res = await app.inject({
        method: (init.method as any) || 'GET',
        url: u.pathname + u.search,
        headers: init.headers as Record<string, string>,
        payload: init.body as any,
      });
      return new Response(res.body, {
        status: res.statusCode,
        headers: res.headers as Record<string, string>,
      });
    });
    window.localStorage.clear();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await app.close();
  });

  it('rejects the UI request when no credential is sent (pre-fix behaviour)', async () => {
    await expect(apiFetch('/assets')).rejects.toMatchObject({ status: 401 });
  });

  it('succeeds once the UI forwards a valid bearer credential', async () => {
    const res = await apiFetch('/assets', {
      headers: { authorization: 'Bearer operator-token' },
    });
    expect(res).toBeTruthy();
  });
});
