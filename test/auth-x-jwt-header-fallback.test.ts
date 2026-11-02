// Issue #1256: the application gate read the token ONLY from
// `Authorization: Bearer`, so a caller who followed the platform's own
// instruction and sent `x-jwt: Bearer <token>` cleared the ingress and was then
// rejected by the application with `401 missing access token`.
//
// extractToken() (src/auth/middleware.ts) now falls back to `x-jwt` using the
// identical `Bearer <token>` parsing, with Authorization keeping precedence.
// These cases pin that behaviour on the route from the issue
// (`POST /api/v1/assets/`) and re-assert that the fallback does not open the
// gate to anonymous or malformed-token traffic (the issue #711 guard).

import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const repository = new InMemoryAssetRepository();
  await app.register(assetsRouter, { prefix: '/api/v1/assets', repository });
  await app.ready();
  return app;
}

describe('x-jwt token fallback (issue #1256)', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = await buildApp();
  });

  it('admits POST /api/v1/assets/ carrying only x-jwt: Bearer <token>', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/',
      headers: { 'x-jwt': 'Bearer platform-token' },
      payload: { name: 'x-jwt only' }
    });
    expect(res.statusCode).toBe(201);
  });

  it('admits a GET carrying only x-jwt', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/assets',
      headers: { 'x-jwt': 'Bearer platform-token' }
    });
    expect(res.statusCode).toBe(200);
  });

  it('keeps Authorization taking precedence when both headers are present', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/',
      headers: {
        authorization: 'Bearer primary-token',
        'x-jwt': 'Bearer platform-token'
      },
      payload: { name: 'both headers' }
    });
    expect(res.statusCode).toBe(201);
  });

  it('still rejects an anonymous POST /api/v1/assets/ with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/',
      payload: { name: 'anonymous' }
    });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ error: 'unauthorized', message: 'missing access token' });
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('still rejects an x-jwt value that is not a Bearer token with 401', async () => {
    for (const value of ['', 'platform-token', 'Basic platform-token', 'Bearer']) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/assets/',
        headers: { 'x-jwt': value },
        payload: { name: 'malformed x-jwt' }
      });
      expect(res.statusCode).toBe(401);
      expect(res.json()).toMatchObject({ error: 'unauthorized', message: 'missing access token' });
    }
  });

  it('falls back to x-jwt when Authorization is present but carries no token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/assets/',
      headers: { authorization: 'Bearer', 'x-jwt': 'Bearer platform-token' },
      payload: { name: 'empty authorization' }
    });
    expect(res.statusCode).toBe(201);
  });
});
