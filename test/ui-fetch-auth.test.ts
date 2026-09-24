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
//   - apiFetch(path, options): public/app.js:172 — builds headers and calls
//     fetch(). It spreads `...uiAuthHeader()` (public/app.js:179) onto every
//     gated request, so a bare `apiFetch('/assets')` carries a credential of its
//     own with NO caller-supplied authorization header (the #740 fix).
//   - uiAuthHeader(): public/app.js:164-166 — returns
//     `{ Authorization: 'Bearer ' + UI_ACCESS_TOKEN }`, an opaque per-page token
//     held only in the module realm (never persisted).
//   - GET /api/v1/assets list route: src/routes/assets.ts (assetsRouter); the
//     list envelope is `{ items, limit, offset, total }` (listSchema,
//     src/routes/assets.ts:804-809).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { apiFetch } from '../public/app.js';

// Mirror apiFetch's own base (public/app.js: `window.location.origin + '/api/v1'`)
// so the raw-fetch contrast case hits the same gated router without importing a
// private module const.
const API_BASE = window.location.origin + '/api/v1';

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

  it('rejects a raw fetch with no credential (the pre-fix UI behaviour → 401)', async () => {
    // Contrast case: a bare request that carries no Authorization header — the
    // exact shape apiFetch produced BEFORE #740 — is rejected by the presence
    // gate (src/auth/workspace.ts:54, "missing access token").
    const res = await fetch(API_BASE + '/assets');
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('unauthorized');
  });

  it('succeeds through the real apiFetch credential path (post-#740 uiAuthHeader)', async () => {
    // Drive the request through the REAL apiFetch with NO manual authorization
    // header. The credential must come from apiFetch itself via uiAuthHeader()
    // (public/app.js:179). Pre-#740 apiFetch sent no bearer, so this call was
    // the 401 "missing access token" case above; post-#740 it satisfies the
    // presence gate and returns the assets list envelope.
    const res = await apiFetch('/assets');
    expect(res).toMatchObject({
      items: expect.any(Array),
      limit: expect.any(Number),
      offset: expect.any(Number),
      total: expect.any(Number),
    });
    // A fresh in-memory repository holds no assets: an empty, well-formed list.
    expect(res.items).toEqual([]);
    expect(res.total).toBe(0);
  });
});
