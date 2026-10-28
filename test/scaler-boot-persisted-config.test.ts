// Boot-time load of the persisted scaler config (issue #1078).
//
// #1077 made PATCH /api/v1/scaler/config durable; nothing read the record back,
// so main.ts booted every process from ENCORE_MAX_INSTANCES / ENCORE_MIN_INSTANCES
// / ENCORE_IDLE_TIMEOUT_MS and an operator's cap was silently reverted by every
// restart. These tests pin the precedence (persisted over env), the documented
// fallback when the store cannot be read, and the restart behaviour end to end:
// PATCH, "restart", and the config endpoint AND the loop-facing cap both come
// back with the persisted value.
//
// Contract sources verified (CLAUDE.md rule 7):
//   - src/services/scaler-boot-config.ts `resolveScalerBootConfig`,
//     `ScalerBootConfig` ({ maxInstances, minInstances, idleTimeoutMs, source,
//     fallbackReason? }), `SCALER_BOOT_LOAD_TIMEOUT_MS`.
//   - src/services/param-store.ts `ScalerConfigStore.save/load`,
//     `makeScalerConfigStore(kv)`, `SCALER_CONFIG_KEY`
//     ('openvideocore/scalerconfig'), `ScalerRuntimeConfig` (three required
//     integers), `parseScalerRuntimeConfig` (undefined for an unusable blob).
//   - src/services/param-store.ts `ConfigKvStore.set/get/delete/listByPrefix` —
//     the seam the in-memory fake below implements, identical to the shape
//     makeHttpConfigKvStore returns.
//   - src/routes/scaler.ts `ScalerRouterOptions` ({ maxInstances, minInstances?,
//     idleTimeoutMs, configStore?, configSource?, onConfigChange? }), the
//     PATCH/GET /config handlers and `scalerConfigResponseSchema.sources`
//     (configValueSourceSchema: source 'env' | 'runtime', optional updatedAt).
//   - src/encore-scaler/workspace-registry.ts
//     `WorkspaceEncoreScalerRegistry.setMaxInstances/setIdleTimeoutMs` — the
//     fan-out the live loops see.
//   - Fastify zod wiring copied from src/routes/scaler.config-persistence.test.ts
//     (setValidatorCompiler/setSerializerCompiler + inject).

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { scalerRouter } from '../src/routes/scaler.js';
import {
  makeScalerConfigStore,
  SCALER_CONFIG_KEY,
  type ConfigKvStore
} from '../src/services/param-store.js';
import {
  resolveScalerBootConfig,
  SCALER_BOOT_LOAD_TIMEOUT_MS
} from '../src/services/scaler-boot-config.js';

// In-memory ConfigKvStore, structurally identical to makeHttpConfigKvStore from
// the caller's point of view. `failGet` reproduces an unreachable/rejecting
// config service the way the HTTP client does: a thrown Error. `hangGet` never
// settles, which is the boot-hang case the resolver's deadline exists for.
function memKv(opts: { failGet?: Error; hangGet?: boolean } = {}): ConfigKvStore & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  return {
    store,
    async set(key: string, value: string) {
      store.set(key, value);
    },
    async get(key: string) {
      if (opts.failGet) throw opts.failGet;
      if (opts.hangGet) return new Promise<string | undefined>(() => {});
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

// The deployment's environment values, deliberately DIFFERENT from every
// persisted value used below so "persisted won" cannot be confused with
// "the env value happened to match".
const ENV = { maxInstances: 3, minInstances: 0, idleTimeoutMs: 300_000 };
const PERSISTED = { maxInstances: 9, minInstances: 2, idleTimeoutMs: 45_000 };

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

describe('resolveScalerBootConfig precedence (issue #1078)', () => {
  it('prefers the persisted snapshot over the env values for all three fields', async () => {
    const kv = memKv();
    await makeScalerConfigStore(kv).save(PERSISTED);

    const resolved = await resolveScalerBootConfig({
      env: ENV,
      store: makeScalerConfigStore(kv)
    });

    // AC1: a persisted value and a different env value -> boot uses the persisted one.
    expect(resolved).toEqual({ ...PERSISTED, source: 'persisted' });
  });

  it('reads the snapshot from the key the PATCH path writes', async () => {
    const kv = memKv();
    await makeScalerConfigStore(kv).save(PERSISTED);
    // One instance-global key, no per-workspace fan-out: the boot read and the
    // PATCH write must agree on it or the restore silently never happens.
    expect([...kv.store.keys()]).toEqual([SCALER_CONFIG_KEY]);

    const resolved = await resolveScalerBootConfig({
      env: ENV,
      store: makeScalerConfigStore(kv)
    });
    expect(resolved.maxInstances).toBe(PERSISTED.maxInstances);
  });

  it('uses the env values when nothing is persisted', async () => {
    const log = recordingLog();
    const resolved = await resolveScalerBootConfig({
      env: ENV,
      store: makeScalerConfigStore(memKv()),
      log
    });

    // AC2: no persisted value -> env/defaults, and this is an ordinary state,
    // not a degradation, so it must not raise a warning an operator has to triage.
    expect(resolved).toEqual({ ...ENV, source: 'env', fallbackReason: 'no-record' });
    expect(log.warns).toHaveLength(0);
    expect(log.infos).toHaveLength(1);
  });

  it('uses the env values when no parameter store is configured', async () => {
    const log = recordingLog();
    const resolved = await resolveScalerBootConfig({ env: ENV, store: undefined, log });

    expect(resolved).toEqual({ ...ENV, source: 'env', fallbackReason: 'no-store' });
    expect(log.warns).toHaveLength(0);
  });

  it('falls back to env and WARNS with the reason when the store is unreachable', async () => {
    const log = recordingLog();
    const err = new Error('config kv read failed: 503 upstream unavailable');
    const resolved = await resolveScalerBootConfig({
      env: ENV,
      store: makeScalerConfigStore(memKv({ failGet: err })),
      log
    });

    // Defined behaviour for an unreachable store: boot continues on the env
    // values rather than refusing to start, but the operator gets one warning
    // naming the reason AND the values actually in force.
    expect(resolved).toEqual({ ...ENV, source: 'env', fallbackReason: 'load-failed' });
    expect(log.warns).toHaveLength(1);
    expect(log.warns[0]!.obj['reason']).toBe('load-failed');
    expect(log.warns[0]!.obj['err']).toBe(err);
    expect(log.warns[0]!.obj['maxInstances']).toBe(ENV.maxInstances);
    expect(log.warns[0]!.msg).toMatch(/persisted/i);
  });

  it('falls back to env and warns when the stored record is not a usable config', async () => {
    const log = recordingLog();
    const kv = memKv();
    // Exactly what parseScalerRuntimeConfig rejects (non-integer / missing fields).
    await kv.set(SCALER_CONFIG_KEY, '{"maxInstances":"nine"}');

    const resolved = await resolveScalerBootConfig({
      env: ENV,
      store: makeScalerConfigStore(kv),
      log
    });

    // ScalerConfigStore.load collapses "absent" and "unusable" into undefined,
    // so boot reports the conservative reason — what matters is that it does not
    // throw and does not boot on a half-read config.
    expect(resolved).toEqual({ ...ENV, source: 'env', fallbackReason: 'no-record' });
  });

  it('does not hang boot on a store read that never answers', async () => {
    const log = recordingLog();
    const resolved = await resolveScalerBootConfig({
      env: ENV,
      store: makeScalerConfigStore(memKv({ hangGet: true })),
      log,
      timeoutMs: 20
    });

    expect(resolved).toEqual({ ...ENV, source: 'env', fallbackReason: 'load-timeout' });
    expect(log.warns[0]!.obj['reason']).toBe('load-timeout');
    // The production budget is a real number, so a store with no deadline of its
    // own still cannot wedge startup forever.
    expect(SCALER_BOOT_LOAD_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it('never rejects, whatever the store does', async () => {
    const hostile = {
      save: async () => undefined,
      load: async () => {
        throw new Error('boom');
      }
    };
    await expect(
      resolveScalerBootConfig({ env: ENV, store: hostile })
    ).resolves.toMatchObject({ source: 'env' });
  });
});

// Build the scaler router the way main.ts does, from an already-resolved boot
// config, so these tests exercise the real handler wiring.
async function buildApp(opts: {
  boot: { maxInstances: number; minInstances: number; idleTimeoutMs: number };
  configSource: 'env' | 'persisted';
  kv?: ConfigKvStore;
  onConfigChange?: (cfg: {
    maxInstances: number;
    minInstances: number;
    idleTimeoutMs: number;
  }) => void;
}) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(scalerRouter, {
    maxInstances: opts.boot.maxInstances,
    minInstances: opts.boot.minInstances,
    idleTimeoutMs: opts.boot.idleTimeoutMs,
    configSource: opts.configSource,
    ...(opts.kv ? { configStore: makeScalerConfigStore(opts.kv) } : {}),
    ...(opts.onConfigChange ? { onConfigChange: opts.onConfigChange } : {})
  });
  await app.ready();
  return app;
}

describe('GET /scaler/config after a restart that restored the persisted config (issue #1078)', () => {
  it('serves the persisted values and attributes them to an operator, not the environment', async () => {
    const app = await buildApp({ boot: PERSISTED, configSource: 'persisted' });
    const res = await app.inject({ method: 'GET', url: '/config' });
    await app.close();

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.maxInstances).toBe(PERSISTED.maxInstances);
    expect(body.minInstances).toBe(PERSISTED.minInstances);
    expect(body.idleTimeoutMs).toBe(PERSISTED.idleTimeoutMs);
    // A restored value is an operator's value. Reporting it as "env" would make a
    // successful restore indistinguishable from the revert bug #1078 fixes.
    // `updatedAt` is absent because the stored snapshot carries no timestamp —
    // the process knows WHO set it, not when.
    expect(body.sources.maxInstances).toEqual({ source: 'runtime' });
    expect(body.sources.minInstances).toEqual({ source: 'runtime' });
    expect(body.sources.idleTimeoutMs).toEqual({ source: 'runtime' });
  });

  it('still reports env provenance for a deployment that was never configured through the API', async () => {
    const app = await buildApp({ boot: ENV, configSource: 'env' });
    const res = await app.inject({ method: 'GET', url: '/config' });
    await app.close();

    expect(res.json().sources).toEqual({
      maxInstances: { source: 'env' },
      minInstances: { source: 'env' },
      idleTimeoutMs: { source: 'env' }
    });
  });

  it('stamps updatedAt once a PATCH lands on a restored process', async () => {
    const kv = memKv();
    const app = await buildApp({ boot: PERSISTED, configSource: 'persisted', kv });
    const res = await app.inject({
      method: 'PATCH',
      url: '/config',
      payload: { maxInstances: 5, minInstances: 1, idleTimeoutMs: 60_000 }
    });
    await app.close();

    expect(res.statusCode).toBe(200);
    expect(res.json().sources.maxInstances.updatedAt).toEqual(expect.any(String));
  });
});

describe('restart round-trip: PATCH, restart, config and loop cap both follow (issue #1078)', () => {
  it('carries a PATCHed cap across a process restart into the config endpoint and the scaler loops', async () => {
    // One parameter store shared by both "processes", exactly as a redeploy sees
    // the same eyevinn-app-config-svc instance.
    const kv = memKv();

    // --- process 1: boots on the env values, operator PATCHes the cap ---
    const firstBoot = await resolveScalerBootConfig({
      env: ENV,
      store: makeScalerConfigStore(kv)
    });
    expect(firstBoot.source).toBe('env');

    const liveFanOut: Array<{ maxInstances: number; idleTimeoutMs: number }> = [];
    const app1 = await buildApp({
      boot: firstBoot,
      configSource: 'env',
      kv,
      onConfigChange: (cfg) =>
        liveFanOut.push({ maxInstances: cfg.maxInstances, idleTimeoutMs: cfg.idleTimeoutMs })
    });
    const patched = await app1.inject({
      method: 'PATCH',
      url: '/config',
      payload: PERSISTED
    });
    await app1.close();
    expect(patched.statusCode).toBe(200);
    // The running process applied it live (pre-existing #1077 behaviour).
    expect(liveFanOut).toEqual([
      { maxInstances: PERSISTED.maxInstances, idleTimeoutMs: PERSISTED.idleTimeoutMs }
    ]);

    // --- restart: new process, same env, same store ---
    const secondBoot = await resolveScalerBootConfig({
      env: ENV,
      store: makeScalerConfigStore(kv)
    });
    expect(secondBoot).toEqual({ ...PERSISTED, source: 'persisted' });

    // The scaler registry/loops are initialised from the RESOLVED values, which
    // is what makes the effective instance cap match the reported one. Stand-in
    // for WorkspaceEncoreScalerRegistry's constructor options
    // (workspace-registry.ts: maxInstances/minInstances/idleTimeoutMs are copied
    // into each loop's EncoreScalerConfig at getOrCreate time).
    const registryOptions = {
      maxInstances: secondBoot.maxInstances,
      minInstances: secondBoot.minInstances,
      idleTimeoutMs: secondBoot.idleTimeoutMs
    };
    expect(registryOptions).toEqual(PERSISTED);

    const app2 = await buildApp({ boot: secondBoot, configSource: 'persisted', kv });
    const configRes = await app2.inject({ method: 'GET', url: '/config' });
    const statusRes = await app2.inject({ method: 'GET', url: '/status' });
    await app2.close();

    // AC3: GET /scaler/config reflects the PATCH after the restart...
    expect(configRes.json()).toMatchObject({
      maxInstances: PERSISTED.maxInstances,
      minInstances: PERSISTED.minInstances,
      idleTimeoutMs: PERSISTED.idleTimeoutMs,
      sources: { maxInstances: { source: 'runtime' } }
    });
    // ...and so does the cap the status surface reports for the loops, so the two
    // cannot disagree about the effective instance ceiling.
    expect(statusRes.json()).toMatchObject({
      maxInstances: PERSISTED.maxInstances,
      idleTimeoutMs: PERSISTED.idleTimeoutMs
    });
    expect(statusRes.json().maxInstances).toBe(registryOptions.maxInstances);
  });
});

describe('main.ts boot wiring (issue #1078)', () => {
  // Source-level assertion in the idiom of test/scaler-config-value-source.test.ts:
  // the boot path cannot be imported without starting a server, but the wiring is
  // the whole point of the issue — the resolved values must reach BOTH the scaler
  // registry and the config route, not just one of them.
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

  it('resolves the boot config through the store-first resolver', () => {
    expect(main).toContain('resolveScalerBootConfig');
    expect(main).toContain('const encoreMaxInstances = scalerBootConfig.maxInstances');
    expect(main).toContain('const encoreMinInstances = scalerBootConfig.minInstances');
    expect(main).toContain('const encoreIdleTimeoutMs = scalerBootConfig.idleTimeoutMs');
  });

  it('feeds the resolved values to the scaler registry and the config route', () => {
    // Registry (live loops) — the env var must no longer be read inline here,
    // which is what made a persisted warm floor unreachable.
    expect(main).toContain('minInstances: encoreMinInstances');
    expect(main).not.toContain("minInstances: parseInt(process.env['ENCORE_MIN_INSTANCES']");
    // Route options, plus the provenance flag so a restored value reports
    // source "runtime".
    expect(main).toContain('configSource:');
  });

  it('keeps the env vars as the fallback, not the winner', () => {
    expect(main).toContain("process.env['ENCORE_MAX_INSTANCES']");
    expect(main).toContain("process.env['ENCORE_IDLE_TIMEOUT_MS']");
    expect(main).toContain("process.env['ENCORE_MIN_INSTANCES']");
    // The env reads feed the resolver's `env` argument only.
    expect(main).toContain('encoreMaxInstancesFromEnv');
  });
});
