// Bounds of a persisted scaler config adopted at boot (issue #1078, review
// finding 8), plus the fallback-reason union (review finding 9).
//
// WHY: `parseScalerRuntimeConfig` enforces only a sanity floor — usable integers
// with maxInstances >= 1 — because the authoritative range is applied at WRITE
// time by the route. Once boot started READING the record (#1078), a record
// written under looser bounds (or by a future/older build) would be adopted
// verbatim: the scaler loops would run below the documented minimum idle timeout
// or above the documented instance ceiling, and — worse — the value could not be
// SERIALIZED by `scalerConfigResponseSchema`, so GET /api/v1/scaler/config would
// answer 500 on every call for the lifetime of that process. These tests pin the
// clamp that prevents it.
//
// Contract sources verified (CLAUDE.md rule 7):
//   - src/services/param-store.ts `SCALER_CONFIG_BOUNDS`
//     ({ maxInstances: { min: 1, max: 20 }, minInstances: { min: 0, max: 10 },
//     idleTimeoutMs: { min: 10_000 } }) — the authoritative range, consumed by
//     routes/scaler.ts `scalerConfigSchema` (request 400s AND, through
//     `scalerConfigResponseSchema`, the 200 response schema).
//   - src/services/param-store.ts `makeScalerConfigStore(kv)`,
//     `SCALER_CONFIG_KEY` ('openvideocore/scalerconfig'),
//     `ScalerRuntimeConfig` (three required integers), `ConfigKvStore`
//     (set/get/delete/listByPrefix) — the seam the fake below implements.
//   - src/services/scaler-boot-config.ts `resolveScalerBootConfig`,
//     `clampPersistedScalerConfig`, `ScalerBootConfig`
//     ({ ...config, source, fallbackReason? }), `ScalerBootFallbackReason`.
//   - src/routes/scaler.ts `ScalerRouterOptions` ({ maxInstances, minInstances?,
//     idleTimeoutMs, configSource?, configStore?, onConfigChange? }) and the
//     GET /config handler.
//   - Fastify zod wiring copied from test/scaler-boot-persisted-config.test.ts
//     (setValidatorCompiler/setSerializerCompiler + inject).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { scalerRouter } from '../src/routes/scaler.js';
import {
  makeScalerConfigStore,
  SCALER_CONFIG_BOUNDS,
  SCALER_CONFIG_KEY,
  type ConfigKvStore
} from '../src/services/param-store.js';
import {
  clampPersistedScalerConfig,
  resolveScalerBootConfig
} from '../src/services/scaler-boot-config.js';

function memKv(): ConfigKvStore & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    async set(key: string, value: string) {
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
}

const ENV = { maxInstances: 3, minInstances: 0, idleTimeoutMs: 300_000 };

// Parseable (three integers, maxInstances >= 1) but outside every bound the
// route enforces: above the instance ceiling, above the warm-floor ceiling, and
// below the minimum idle timeout. PATCHing these would be a 400
// (src/routes/scaler.config-persistence.test.ts covers that), so no running
// build can write them — an older build, a hand-edited record or a later
// tightening of the bounds can.
const OUT_OF_BOUNDS = { maxInstances: 50, minInstances: 99, idleTimeoutMs: 5_000 };

function recordingLog() {
  const warns: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  const infos: Array<{ obj: Record<string, unknown>; msg: string }> = [];
  return {
    warns,
    infos,
    warn: (obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg }),
    info: (obj: Record<string, unknown>, msg: string) => infos.push({ obj, msg })
  };
}

describe('boot clamps a persisted scaler config into the route bounds (issue #1078)', () => {
  it('clamps every out-of-range field to the nearest allowed value', async () => {
    const kv = memKv();
    await kv.set(SCALER_CONFIG_KEY, JSON.stringify(OUT_OF_BOUNDS));

    const resolved = await resolveScalerBootConfig({
      env: ENV,
      store: makeScalerConfigStore(kv)
    });

    // Still the operator's intent ("as high as allowed", "as short as allowed"),
    // not a silent revert to an unrelated env value.
    expect(resolved).toEqual({
      maxInstances: SCALER_CONFIG_BOUNDS.maxInstances.max,
      minInstances: SCALER_CONFIG_BOUNDS.minInstances.max,
      idleTimeoutMs: SCALER_CONFIG_BOUNDS.idleTimeoutMs.min,
      source: 'persisted'
    });
  });

  it('warns with the stored and the applied numbers when it clamps', async () => {
    const log = recordingLog();
    const kv = memKv();
    await kv.set(SCALER_CONFIG_KEY, JSON.stringify(OUT_OF_BOUNDS));

    await resolveScalerBootConfig({ env: ENV, store: makeScalerConfigStore(kv), log });

    // Repairing an operator's stored value is a degradation they have to be able
    // to see — and the log line has to name BOTH numbers or it cannot be acted on.
    expect(log.warns).toHaveLength(1);
    expect(log.warns[0]!.obj['clampedFrom']).toEqual(OUT_OF_BOUNDS);
    expect(log.warns[0]!.obj['maxInstances']).toBe(SCALER_CONFIG_BOUNDS.maxInstances.max);
    expect(log.warns[0]!.obj['idleTimeoutMs']).toBe(SCALER_CONFIG_BOUNDS.idleTimeoutMs.min);
    expect(log.warns[0]!.msg).toMatch(/clamp/i);
  });

  it('does not warn, and changes nothing, for an in-range persisted record', async () => {
    const log = recordingLog();
    const kv = memKv();
    const inRange = { maxInstances: 9, minInstances: 2, idleTimeoutMs: 45_000 };
    await makeScalerConfigStore(kv).save(inRange);

    const resolved = await resolveScalerBootConfig({
      env: ENV,
      store: makeScalerConfigStore(kv),
      log
    });

    expect(resolved).toEqual({ ...inRange, source: 'persisted' });
    expect(log.warns).toHaveLength(0);
  });

  it('clamps a sub-minimum idle timeout up to the documented floor', () => {
    // Unit-level, so the floor itself is pinned independently of the store seam:
    // a 1s idle timeout would thrash the spawn/destroy cycle the floor exists for.
    const { config, clamped } = clampPersistedScalerConfig({
      maxInstances: 2,
      minInstances: 0,
      idleTimeoutMs: 1_000
    });
    expect(config.idleTimeoutMs).toBe(SCALER_CONFIG_BOUNDS.idleTimeoutMs.min);
    expect(clamped).toEqual({ idleTimeoutMs: 1_000 });
    // Fields already in range are untouched.
    expect(config.maxInstances).toBe(2);
  });
});

describe('GET /scaler/config survives a boot from an out-of-bounds persisted record (issue #1078)', () => {
  it('answers 200 with in-range values instead of failing response validation', async () => {
    const kv = memKv();
    await kv.set(SCALER_CONFIG_KEY, JSON.stringify(OUT_OF_BOUNDS));

    const boot = await resolveScalerBootConfig({ env: ENV, store: makeScalerConfigStore(kv) });

    // Wired exactly as main.ts does: the resolved values seed the router.
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(scalerRouter, {
      maxInstances: boot.maxInstances,
      minInstances: boot.minInstances,
      idleTimeoutMs: boot.idleTimeoutMs,
      configSource: boot.source,
      configStore: makeScalerConfigStore(kv)
    });
    await app.ready();

    const res = await app.inject({ method: 'GET', url: '/config' });
    await app.close();

    // Without the clamp the 200 response schema (scalerConfigResponseSchema,
    // which extends scalerConfigSchema) rejects the serialized body and every
    // call to this endpoint answers 500 for the life of the process.
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.maxInstances).toBeLessThanOrEqual(SCALER_CONFIG_BOUNDS.maxInstances.max);
    expect(body.minInstances).toBeLessThanOrEqual(SCALER_CONFIG_BOUNDS.minInstances.max);
    expect(body.idleTimeoutMs).toBeGreaterThanOrEqual(SCALER_CONFIG_BOUNDS.idleTimeoutMs.min);
    // Still an operator-set config, so the provenance stays "runtime".
    expect(body.sources.maxInstances).toEqual({ source: 'runtime' });
  });
});

// The env branch needs the same clamp as the persisted one (issue #1078, review
// finding A). Before #1078 the config endpoint was seeded with a hardcoded
// minInstances: 0 and never saw ENCORE_MIN_INSTANCES; now main.ts forwards
// `scalerBootConfig.minInstances`, so an out-of-range or non-numeric ENCORE_*
// value reaches `scalerConfigResponseSchema` — which applies
// SCALER_CONFIG_BOUNDS to the 200 body — and would 500 GET and PATCH
// /api/v1/scaler/config for the life of the process.
describe('boot clamps out-of-range environment values too (issue #1078)', () => {
  // Mirrors the wiring main.ts does: resolved boot values seed the router, with
  // no parameter store (the 'no-store' fallback), which is exactly the state a
  // deployment configured only through ENCORE_* env vars boots in.
  async function getConfig(env: {
    maxInstances: number;
    minInstances: number;
    idleTimeoutMs: number;
  }) {
    const log = recordingLog();
    const boot = await resolveScalerBootConfig({ env, log });

    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(scalerRouter, {
      maxInstances: boot.maxInstances,
      minInstances: boot.minInstances,
      idleTimeoutMs: boot.idleTimeoutMs,
      configSource: boot.source
    });
    await app.ready();
    const res = await app.inject({ method: 'GET', url: '/config' });
    await app.close();
    return { res, boot, log };
  }

  it('answers 200 when ENCORE_MIN_INSTANCES is above the permitted ceiling', async () => {
    // 12 > SCALER_CONFIG_BOUNDS.minInstances.max (10): parseable, settable as an
    // env var, and rejected by the response schema if adopted verbatim.
    const { res, boot, log } = await getConfig({ ...ENV, minInstances: 12 });

    expect(res.statusCode).toBe(200);
    expect(res.json().minInstances).toBe(SCALER_CONFIG_BOUNDS.minInstances.max);
    expect(boot.minInstances).toBe(SCALER_CONFIG_BOUNDS.minInstances.max);
    expect(boot.source).toBe('env');
    // The operator has to be able to see that their env value was repaired, and
    // the line has to name both numbers to be actionable.
    const clampWarn = log.warns.find((w) => w.obj['clampedFrom'] !== undefined);
    expect(clampWarn).toBeDefined();
    expect(clampWarn!.obj['clampedFrom']).toEqual({ minInstances: 12 });
    expect(clampWarn!.msg).toMatch(/clamp/i);
  });

  it('answers 200 when an ENCORE_* value is non-numeric (parseInt -> NaN)', async () => {
    // main.ts reads these with parseInt, so `ENCORE_MIN_INSTANCES=none` arrives
    // as NaN — which fails z.number().int() in the response schema exactly like
    // an out-of-range number does, and is NOT caught by a plain min/max compare.
    const { res, boot } = await getConfig({
      maxInstances: Number.parseInt('none', 10),
      minInstances: Number.parseInt('none', 10),
      idleTimeoutMs: Number.parseInt('', 10)
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.maxInstances).toBe(SCALER_CONFIG_BOUNDS.maxInstances.min);
    expect(body.minInstances).toBe(SCALER_CONFIG_BOUNDS.minInstances.min);
    expect(body.idleTimeoutMs).toBe(SCALER_CONFIG_BOUNDS.idleTimeoutMs.min);
    expect(Number.isInteger(boot.maxInstances)).toBe(true);
    expect(Number.isInteger(boot.minInstances)).toBe(true);
    expect(Number.isInteger(boot.idleTimeoutMs)).toBe(true);
  });

  it('leaves in-range environment values untouched and unwarned', async () => {
    const { res, boot, log } = await getConfig(ENV);

    expect(res.statusCode).toBe(200);
    expect(boot).toEqual({ ...ENV, source: 'env', fallbackReason: 'no-store' });
    expect(log.warns).toHaveLength(0);
    // An unconfigured deployment still reports its values as env-sourced.
    expect(res.json().sources.minInstances).toEqual({ source: 'env' });
  });
});

describe('the boot fallback reasons are all reachable (issue #1078)', () => {
  // Source-level, in the idiom of the main.ts wiring assertions in
  // test/scaler-boot-persisted-config.test.ts: a reason an operator can never
  // observe is dead code that documents a precision the resolver does not have.
  const source = readFileSync(
    new URL('../src/services/scaler-boot-config.ts', import.meta.url),
    'utf8'
  );

  it('does not advertise a reason the store seam cannot produce', () => {
    // ScalerConfigStore.load() collapses "key absent" and "blob unusable" into
    // undefined, so 'unusable-record' could never be returned. It must not be a
    // member of the union (a comment explaining its absence is fine).
    expect(source).not.toMatch(/^\s*\|\s*'unusable-record'/m);
  });

  it('keeps the reasons the resolver actually returns', () => {
    for (const reason of ['no-store', 'no-record', 'load-failed', 'load-timeout']) {
      expect(source).toContain(`'${reason}'`);
    }
  });
});
