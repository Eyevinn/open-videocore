// Scaler config values must say where they came from (issue #1079).
//
// Runtime config lives in the scaler router's closure and nothing persists it,
// so a restart silently reverts every PATCH. The wire could not tell the two
// apart: `{"maxInstances": 3}` looked identical whether 3 was the deployment's
// environment value or a number an operator had just set. Each value now
// carries `{ source: "env" | "runtime", updatedAt? }`.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - PATCH body schema: `scalerConfigSchema.partial()` in src/routes/scaler.ts
//     — { maxInstances?, minInstances?, idleTimeoutMs? }, additionalProperties
//     false. UNCHANGED by #1079: provenance is response-only.
//   - GET/PATCH /config response: `scalerConfigResponseSchema` in
//     src/routes/scaler.ts — scalerConfigSchema + `sources` for all three fields.
//   - GET /status response: `scalerStatusSchema` in src/routes/scaler.ts —
//     { workspaces, maxInstances, jobsPerInstance, idleTimeoutMs, scalerActive,
//       sources } where `sources` covers maxInstances and idleTimeoutMs only
//       (jobsPerInstance is the compiled-in JOBS_PER_INSTANCE constant, neither
//       env-derived nor settable).
//   - Env-derived seed values: src/main.ts:2285-2297 builds the router options
//     from ENCORE_MAX_INSTANCES (main.ts:889) and ENCORE_IDLE_TIMEOUT_MS
//     (main.ts:899); minInstances defaults to 0.
//   - MIN_IDLE_TIMEOUT_MS floor (10_000) in src/routes/scaler.ts — used here to
//     keep PATCH bodies valid.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { scalerRouter } from '../src/routes/scaler.js';

const ENV_MAX_INSTANCES = 3;
const ENV_MIN_INSTANCES = 0;
const ENV_IDLE_TIMEOUT_MS = 300_000;

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  // No redis: the scaler-off branch. Config provenance is independent of
  // whether a pool exists, and this keeps the test to the config surface.
  await app.register(scalerRouter, {
    prefix: '/scaler',
    maxInstances: ENV_MAX_INSTANCES,
    minInstances: ENV_MIN_INSTANCES,
    idleTimeoutMs: ENV_IDLE_TIMEOUT_MS
  });
  await app.ready();
  return app;
}

describe('scaler config value provenance (issue #1079)', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  it('reports source "env" for every field on a deployment never configured via the API', async () => {
    const res = await app.inject({ method: 'GET', url: '/scaler/config' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      maxInstances: ENV_MAX_INSTANCES,
      minInstances: ENV_MIN_INSTANCES,
      idleTimeoutMs: ENV_IDLE_TIMEOUT_MS,
      sources: {
        maxInstances: { source: 'env' },
        minInstances: { source: 'env' },
        idleTimeoutMs: { source: 'env' }
      }
    });
  });

  it('omits updatedAt for env values rather than reporting a boot time', async () => {
    // Nothing records when an environment variable was set, and process start is
    // when the value was READ. A timestamp here would be invented.
    const sources = (await app.inject({ method: 'GET', url: '/scaler/config' })).json().sources;
    for (const field of ['maxInstances', 'minInstances', 'idleTimeoutMs']) {
      expect(sources[field].updatedAt).toBeUndefined();
    }
  });

  it('flips only the patched fields to "runtime" and leaves the rest "env"', async () => {
    const patched = await app.inject({
      method: 'PATCH',
      url: '/scaler/config',
      payload: { maxInstances: 7 }
    });

    expect(patched.statusCode).toBe(200);
    const body = patched.json();
    expect(body.maxInstances).toBe(7);
    expect(body.sources.maxInstances.source).toBe('runtime');
    // Untouched by this PATCH, so still the deployment's own values.
    expect(body.sources.minInstances).toEqual({ source: 'env' });
    expect(body.sources.idleTimeoutMs).toEqual({ source: 'env' });

    // And a subsequent GET agrees — provenance is state, not a property of the
    // PATCH response.
    const after = (await app.inject({ method: 'GET', url: '/scaler/config' })).json();
    expect(after.sources.maxInstances.source).toBe('runtime');
    expect(after.sources.idleTimeoutMs).toEqual({ source: 'env' });
  });

  it('timestamps a runtime value with an ISO 8601 UTC updatedAt', async () => {
    const before = Date.now();
    const body = (
      await app.inject({
        method: 'PATCH',
        url: '/scaler/config',
        payload: { idleTimeoutMs: 60_000 }
      })
    ).json();
    const after = Date.now();

    const { updatedAt } = body.sources.idleTimeoutMs;
    expect(typeof updatedAt).toBe('string');
    // ISO 8601, UTC (Z), millisecond precision — the repo's `updatedAt`
    // convention (e.g. src/data/couch-asset-repo.ts:298).
    expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    const parsed = Date.parse(updatedAt);
    expect(parsed).toBeGreaterThanOrEqual(before);
    expect(parsed).toBeLessThanOrEqual(after);
  });

  it('counts a field as runtime-set even when the submitted value equals the env value', async () => {
    // Provenance answers "who set this", not "did the number move". An operator
    // who PATCHes maxInstances back to 3 has taken ownership of it, and after a
    // restart reverts it to 3 the field will read "env" again — which is the
    // signal this issue is about.
    const body = (
      await app.inject({
        method: 'PATCH',
        url: '/scaler/config',
        payload: { maxInstances: ENV_MAX_INSTANCES }
      })
    ).json();

    expect(body.maxInstances).toBe(ENV_MAX_INSTANCES);
    expect(body.sources.maxInstances.source).toBe('runtime');
  });

  it('reverts to "env" on restart, because nothing persists runtime config yet', async () => {
    await app.inject({ method: 'PATCH', url: '/scaler/config', payload: { maxInstances: 9 } });

    // A fresh router instance is this process restarting: the closure that held
    // the runtime value is gone. Pinned deliberately — when persistence ships, a
    // restored value must keep reporting "runtime" with its original updatedAt,
    // and this expectation is the one that must change with it.
    const restarted = await buildApp();
    try {
      const body = (await restarted.inject({ method: 'GET', url: '/scaler/config' })).json();
      expect(body.maxInstances).toBe(ENV_MAX_INSTANCES);
      expect(body.sources.maxInstances).toEqual({ source: 'env' });
    } finally {
      await restarted.close();
    }
  });

  it('reports provenance on GET /status for the config values it carries', async () => {
    const before = (await app.inject({ method: 'GET', url: '/scaler/status' })).json();
    expect(before.sources).toEqual({
      maxInstances: { source: 'env' },
      idleTimeoutMs: { source: 'env' }
    });

    await app.inject({ method: 'PATCH', url: '/scaler/config', payload: { maxInstances: 5 } });

    const after = (await app.inject({ method: 'GET', url: '/scaler/status' })).json();
    expect(after.maxInstances).toBe(5);
    expect(after.sources.maxInstances.source).toBe('runtime');
    expect(after.sources.maxInstances.updatedAt).toEqual(expect.any(String));
    expect(after.sources.idleTimeoutMs).toEqual({ source: 'env' });
    // jobsPerInstance is a compiled-in constant, so it is deliberately absent
    // from `sources`: neither "env" nor "runtime" would be true of it.
    expect(after.sources.jobsPerInstance).toBeUndefined();
    expect(after.jobsPerInstance).toEqual(expect.any(Number));
  });

  it('keeps the existing response fields untouched (additive change)', async () => {
    const status = (await app.inject({ method: 'GET', url: '/scaler/status' })).json();
    expect(status).toMatchObject({
      workspaces: [],
      maxInstances: ENV_MAX_INSTANCES,
      idleTimeoutMs: ENV_IDLE_TIMEOUT_MS,
      scalerActive: false
    });

    const config = (await app.inject({ method: 'GET', url: '/scaler/config' })).json();
    expect(config).toMatchObject({
      maxInstances: ENV_MAX_INSTANCES,
      minInstances: ENV_MIN_INSTANCES,
      idleTimeoutMs: ENV_IDLE_TIMEOUT_MS
    });
  });

  it('ignores a sources key echoed back into PATCH — provenance is server-owned', async () => {
    // A read-modify-write client will GET the config and PATCH the object back.
    // The body validator strips unknown keys, so the echoed `sources` is dropped
    // rather than failing the request or being mistaken for a settable value:
    // the round-trip keeps working, and provenance stays something only the
    // server can assert.
    const res = await app.inject({
      method: 'PATCH',
      url: '/scaler/config',
      payload: {
        maxInstances: 4,
        sources: {
          maxInstances: { source: 'env' },
          minInstances: { source: 'env' },
          idleTimeoutMs: { source: 'env' }
        }
      }
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.maxInstances).toBe(4);
    // The claim in the submitted body ("env") did not win: the server set it, so
    // the server calls it runtime.
    expect(body.sources.maxInstances.source).toBe('runtime');
    expect(body.sources.maxInstances.updatedAt).toEqual(expect.any(String));
  });
});
