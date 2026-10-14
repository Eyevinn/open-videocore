// Tests for the durable PATCH /scaler/config path (issue #1077).
//
// Before #1077 the handler only moved module-scope values and called
// onConfigChange, so an operator's change was lost on the next restart. These
// tests pin the observable contract: a 2xx response means the values are in the
// parameter store, and a store failure means NOTHING moved.
//
// Contract sources verified (CLAUDE.md rule 7):
//   - Route + options: src/routes/scaler.ts `scalerRouter`, ScalerRouterOptions
//     ({ maxInstances, minInstances?, idleTimeoutMs, onConfigChange?,
//     configStore? }) and the `scalerConfigSchema` body/response validation
//     (maxInstances 1..20, minInstances 0..10, idleTimeoutMs >= 10_000).
//   - Store seam: src/services/param-store.ts `ScalerConfigStore.save/load`,
//     `makeScalerConfigStore(kv)`, `SCALER_CONFIG_KEY`
//     ('openvideocore/scalerconfig'), `parseScalerRuntimeConfig`.
//   - KV seam the store writes through: src/services/param-store.ts
//     `ConfigKvStore.set/get/delete/listByPrefix`.
//   - Fastify zod wiring copied from src/routes/health.test.ts:37-49
//     (setValidatorCompiler/setSerializerCompiler + inject).

import { describe, it, expect, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { scalerRouter } from './scaler.js';
import {
  makeScalerConfigStore,
  parseScalerRuntimeConfig,
  SCALER_CONFIG_KEY,
  type ConfigKvStore,
  type ScalerConfigStore
} from '../services/param-store.js';

// In-memory ConfigKvStore, structurally identical to the HTTP one
// (makeHttpConfigKvStore) from the caller's point of view. `failSet` makes the
// write path fail exactly the way the HTTP client does: a thrown Error.
function memKv(opts: { failSet?: Error } = {}): ConfigKvStore & {
  store: Map<string, string>;
  setCalls: number;
} {
  const store = new Map<string, string>();
  const kv = {
    store,
    setCalls: 0,
    async set(key: string, value: string) {
      kv.setCalls += 1;
      if (opts.failSet) throw opts.failSet;
      store.set(key, value);
    },
    async get(key: string) {
      return store.get(key);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async listByPrefix(prefix: string) {
      return [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value }));
    }
  };
  return kv;
}

const BOOT = { maxInstances: 3, minInstances: 0, idleTimeoutMs: 300_000 };

async function buildApp(options: {
  configStore?: ScalerConfigStore;
  onConfigChange?: (cfg: {
    maxInstances: number;
    minInstances: number;
    idleTimeoutMs: number;
  }) => void;
}) {
  const app = Fastify({ logger: false });
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(scalerRouter, {
    maxInstances: BOOT.maxInstances,
    minInstances: BOOT.minInstances,
    idleTimeoutMs: BOOT.idleTimeoutMs,
    ...(options.configStore ? { configStore: options.configStore } : {}),
    ...(options.onConfigChange ? { onConfigChange: options.onConfigChange } : {})
  });
  await app.ready();
  return app;
}

describe('PATCH /scaler/config persists to the parameter store (issue #1077)', () => {
  it('writes the new values under SCALER_CONFIG_KEY and returns 200', async () => {
    const kv = memKv();
    const applied: unknown[] = [];
    const app = await buildApp({
      configStore: makeScalerConfigStore(kv),
      onConfigChange: (cfg) => applied.push(cfg)
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/config',
      payload: { maxInstances: 7, minInstances: 2, idleTimeoutMs: 60_000 }
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      maxInstances: 7,
      minInstances: 2,
      idleTimeoutMs: 60_000
    });

    // Acceptance criterion: the value is IN the store once the request completes.
    const raw = kv.store.get(SCALER_CONFIG_KEY);
    expect(raw).toBeDefined();
    expect(JSON.parse(raw as string)).toEqual({
      maxInstances: 7,
      minInstances: 2,
      idleTimeoutMs: 60_000
    });
    // ...and it round-trips through the reader the boot-load side (#1078) uses.
    expect(parseScalerRuntimeConfig(raw as string)).toEqual({
      maxInstances: 7,
      minInstances: 2,
      idleTimeoutMs: 60_000
    });

    // The live values moved too, and the registry callback saw them.
    expect(applied).toEqual([
      { maxInstances: 7, minInstances: 2, idleTimeoutMs: 60_000 }
    ]);
    const get = await app.inject({ method: 'GET', url: '/config' });
    expect(get.json()).toEqual({
      maxInstances: 7,
      minInstances: 2,
      idleTimeoutMs: 60_000
    });
    await app.close();
  });

  it('persists a COMPLETE snapshot when only one field is patched', async () => {
    const kv = memKv();
    const app = await buildApp({ configStore: makeScalerConfigStore(kv) });

    const res = await app.inject({
      method: 'PATCH',
      url: '/config',
      payload: { maxInstances: 5 }
    });

    expect(res.statusCode).toBe(200);
    // The stored blob carries all three fields (merged over the live values), so
    // the boot-load side never has to reconstruct a partial record.
    expect(JSON.parse(kv.store.get(SCALER_CONFIG_KEY) as string)).toEqual({
      maxInstances: 5,
      minInstances: BOOT.minInstances,
      idleTimeoutMs: BOOT.idleTimeoutMs
    });
    await app.close();
  });

  it('returns 503 and leaves the live values unchanged when the store write fails', async () => {
    const kv = memKv({ failSet: new Error('config kv write failed: 500 boom') });
    const onConfigChange = vi.fn();
    const app = await buildApp({
      configStore: makeScalerConfigStore(kv),
      onConfigChange
    });

    const res = await app.inject({
      method: 'PATCH',
      url: '/config',
      payload: { maxInstances: 9, minInstances: 1, idleTimeoutMs: 45_000 }
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('scaler_config_persist_failed');
    // This router is unauthenticated, so the upstream failure text must stay in
    // the log and off the wire (same discipline as the redacted spawn-failure
    // message, #1071).
    expect(res.body).not.toContain('boom');
    expect(kv.setCalls).toBe(1);
    expect(kv.store.has(SCALER_CONFIG_KEY)).toBe(false);

    // Nothing was applied: the registry callback never fired and GET /config
    // still reports the boot values. The API never claims a value it could not
    // make durable.
    expect(onConfigChange).not.toHaveBeenCalled();
    const get = await app.inject({ method: 'GET', url: '/config' });
    expect(get.json()).toEqual(BOOT);
    await app.close();
  });

  it('returns 501 and changes nothing when no parameter store is configured', async () => {
    const onConfigChange = vi.fn();
    const app = await buildApp({ onConfigChange });

    const res = await app.inject({
      method: 'PATCH',
      url: '/config',
      payload: { maxInstances: 4 }
    });

    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('scaler_config_not_persistable');
    expect(onConfigChange).not.toHaveBeenCalled();
    const get = await app.inject({ method: 'GET', url: '/config' });
    expect(get.json()).toEqual(BOOT);
    await app.close();
  });

  it('rejects an out-of-range value before touching the store (validation unchanged)', async () => {
    const kv = memKv();
    const app = await buildApp({ configStore: makeScalerConfigStore(kv) });

    for (const payload of [
      { maxInstances: 0 },
      { maxInstances: 21 },
      { minInstances: -1 },
      { minInstances: 11 },
      { idleTimeoutMs: 9_999 },
      { maxInstances: 1.5 }
    ]) {
      const res = await app.inject({ method: 'PATCH', url: '/config', payload });
      expect(res.statusCode).toBe(400);
    }

    expect(kv.setCalls).toBe(0);
    expect(kv.store.size).toBe(0);
    await app.close();
  });
});

describe('scaler config store contract for the boot-load side (issue #1078)', () => {
  it('round-trips a saved config through load()', async () => {
    const kv = memKv();
    const store = makeScalerConfigStore(kv);
    await store.save({ maxInstances: 11, minInstances: 3, idleTimeoutMs: 20_000 });
    expect([...kv.store.keys()]).toEqual([SCALER_CONFIG_KEY]);
    await expect(store.load()).resolves.toEqual({
      maxInstances: 11,
      minInstances: 3,
      idleTimeoutMs: 20_000
    });
  });

  it('load() returns undefined when nothing is stored', async () => {
    await expect(makeScalerConfigStore(memKv()).load()).resolves.toBeUndefined();
  });

  it('load() returns undefined for an unusable stored blob rather than throwing', async () => {
    for (const bad of [
      'not json',
      'null',
      '[]',
      '{}',
      '{"maxInstances":3,"minInstances":0}',
      '{"maxInstances":"3","minInstances":0,"idleTimeoutMs":1000}',
      '{"maxInstances":0,"minInstances":0,"idleTimeoutMs":1000}',
      '{"maxInstances":3,"minInstances":-1,"idleTimeoutMs":1000}',
      '{"maxInstances":3,"minInstances":0,"idleTimeoutMs":-1}',
      '{"maxInstances":3.5,"minInstances":0,"idleTimeoutMs":1000}'
    ]) {
      const kv = memKv();
      kv.store.set(SCALER_CONFIG_KEY, bad);
      await expect(makeScalerConfigStore(kv).load()).resolves.toBeUndefined();
    }
  });

  it('accepts a persisted value outside the route bounds (reader is structural, not policy)', () => {
    // The route owns the bounds at WRITE time; the reader must not discard a
    // value that a future, tighter bound would reject, or a bound change would
    // silently reset a running deployment at boot.
    expect(
      parseScalerRuntimeConfig(
        '{"maxInstances":99,"minInstances":50,"idleTimeoutMs":1}'
      )
    ).toEqual({ maxInstances: 99, minInstances: 50, idleTimeoutMs: 1 });
  });

  it('never writes extra keys from a wider caller object into the stored blob', async () => {
    const kv = memKv();
    const store = makeScalerConfigStore(kv);
    await store.save({
      maxInstances: 2,
      minInstances: 1,
      idleTimeoutMs: 15_000,
      // A caller passing a wider object must not leak fields into the store.
      secretish: 'nope'
    } as never);
    expect(JSON.parse(kv.store.get(SCALER_CONFIG_KEY) as string)).toEqual({
      maxInstances: 2,
      minInstances: 1,
      idleTimeoutMs: 15_000
    });
  });

  it('uses a single-segment key so the stale-namespace stack scan cannot match it', () => {
    // services/workspace-stack.ts scanStaleNamespacedStacks only considers keys
    // with EXACTLY two segments after the `openvideocore/` prefix as candidate
    // stack configs.
    expect(SCALER_CONFIG_KEY.startsWith('openvideocore/')).toBe(true);
    expect(SCALER_CONFIG_KEY.slice('openvideocore/'.length).split('/')).toHaveLength(1);
  });
});
