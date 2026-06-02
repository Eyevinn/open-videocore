import { describe, it, expect, beforeEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

// ADR-003 / issue #59: open-videocore no longer performs in-app workspace
// scoping. OSC provides structural tenant isolation, so the auth wall is a PURE
// GATE: any bearer token is admitted (the wall authenticated it upstream); no
// token is rejected 401. No per-request tenant resolution, no cross-workspace
// isolation within a deployment.

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

const auth = (token: string) => ({ authorization: `Bearer ${token}` });

describe('auth gate (ADR-003 / issue #59)', () => {
  let app: FastifyInstance;
  beforeEach(async () => { app = await buildApp(); });

  it('rejects requests without a token (401)', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/assets' });
    expect(res.statusCode).toBe(401);
    expect(res.headers['www-authenticate']).toBe('Bearer');
  });

  it('admits any request that carries a bearer token', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/assets', headers: auth('any-token'), payload: { name: 'clip one' } });
    expect(res.statusCode).toBe(201);
  });

  it('serves a single shared resource context — all authenticated callers see the same data', async () => {
    await app.inject({ method: 'POST', url: '/api/v1/assets', headers: auth('token-a'), payload: { name: 'a-asset' } });
    await app.inject({ method: 'POST', url: '/api/v1/assets', headers: auth('token-b'), payload: { name: 'b-asset' } });
    const list = await app.inject({ method: 'GET', url: '/api/v1/assets', headers: auth('token-b') });
    const names = list.json().items.map((i: { name: string }) => i.name).sort();
    expect(names).toEqual(['a-asset', 'b-asset']);
  });

  it('an asset created under one token is readable under another (no isolation)', async () => {
    const created = await app.inject({ method: 'POST', url: '/api/v1/assets', headers: auth('token-a'), payload: { name: 'shared' } });
    const id = created.json().id;
    const read = await app.inject({ method: 'GET', url: `/api/v1/assets/${id}`, headers: auth('token-b') });
    expect(read.statusCode).toBe(200);
  });
});
