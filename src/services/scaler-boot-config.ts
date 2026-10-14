// Boot-time resolution of the scaler runtime config (issue #1078).
//
// BEFORE: main.ts read ENCORE_MAX_INSTANCES / ENCORE_MIN_INSTANCES /
// ENCORE_IDLE_TIMEOUT_MS at boot and nothing else, so a value an operator had
// set through PATCH /api/v1/scaler/config — which IS written durably (#1077) —
// was silently discarded on every restart or redeploy. The record survived; the
// behaviour did not.
//
// AFTER: boot reads the persisted record first and the environment is the
// FALLBACK, not the winner. Precedence, in order:
//   1. the persisted snapshot in the parameter store, when one exists and parses
//   2. the deployment's environment values / built-in defaults
// A runtime PATCH still overrides both for the serving process (routes/scaler.ts).
//
// Contract sources verified (CLAUDE.md rule 7):
//   - src/services/param-store.ts `ScalerConfigStore.load(): Promise<ScalerRuntimeConfig | undefined>`
//     and `makeScalerConfigStore(kv)` — the write side (#1077) always stores a
//     COMPLETE {maxInstances,minInstances,idleTimeoutMs} snapshot under
//     `SCALER_CONFIG_KEY` ('openvideocore/scalerconfig'), so one successful read
//     yields a whole config and never needs merging with the env values.
//   - src/services/param-store.ts `ScalerRuntimeConfig` — the three required
//     integer fields, and `parseScalerRuntimeConfig`, which returns `undefined`
//     (rather than throwing) for an unusable blob so this resolver can treat
//     "stored garbage" exactly like "nothing stored".
//   - src/services/param-store.ts `ConfigKvStore.get` /
//     `makeHttpConfigKvStore` — the read is one HTTP GET /api/v1/config/{key}
//     with the client's own AbortController timeout (DEFAULT_TIMEOUT_MS = 10_000)
//     and throws on a non-2xx other than 404.
//   - src/routes/scaler.ts `ScalerRouterOptions` ({ maxInstances, minInstances?,
//     idleTimeoutMs, configSource?, configStore? }) — where the resolved values go.
//
// ALL-OR-NOTHING. The resolved config is either entirely persisted or entirely
// env-sourced. Field-by-field merging is deliberately NOT done: the stored blob
// is one snapshot written by one PATCH, so mixing half of it with env values
// would produce a combination no operator ever asked for (e.g. a persisted
// maxInstances of 1 against an env idle timeout chosen for a cap of 10).

import type { ScalerConfigStore, ScalerRuntimeConfig } from './param-store.js';

// The env-sourced (or built-in default) values boot falls back to. main.ts
// resolves these from ENCORE_MAX_INSTANCES / ENCORE_MIN_INSTANCES /
// ENCORE_IDLE_TIMEOUT_MS before calling this.
export type ScalerEnvConfig = ScalerRuntimeConfig;

// Why boot ended up on the environment values. Logged, and worth keeping
// distinct: 'no-store' and 'no-record' are NORMAL (an unconfigured deployment,
// or one never configured through the API), while 'unusable-record',
// 'load-failed' and 'load-timeout' mean a persisted value may exist and is NOT
// being honoured — an operator-visible degradation that has to be warn-logged
// with its reason rather than passed over in silence.
export type ScalerBootFallbackReason =
  // No parameter store is configured for this deployment (PARAMETER_STORE_API_KEY
  // unset, or the config-service instance URL unresolvable). PATCH also responds
  // 501 in this state, so there can be no persisted record to miss.
  | 'no-store'
  // Store reachable, key absent: a deployment never configured through the API.
  | 'no-record'
  // Store reachable, record present but not a usable config
  // (parseScalerRuntimeConfig returned undefined).
  | 'unusable-record'
  // The read threw (HTTP error, auth failure, DNS, connection refused).
  | 'load-failed'
  // The read did not answer within the boot budget below.
  | 'load-timeout';

export type ScalerBootConfig = ScalerRuntimeConfig & {
  // 'persisted' = these three numbers came from the parameter store;
  // 'env' = from the environment/defaults. Carried into the scaler router so
  // GET /api/v1/scaler/config can report provenance honestly (#1079) instead of
  // calling a restored operator value an environment value.
  source: 'persisted' | 'env';
  // Set only when source is 'env', naming why. Undefined for 'persisted'.
  fallbackReason?: ScalerBootFallbackReason;
};

// Boot budget for the single config-service read. The HTTP ConfigKvStore
// already aborts at DEFAULT_TIMEOUT_MS (10s), but this resolver sits on the
// startup path and must not be able to hang it if a caller passes a store
// implementation without its own deadline. Kept slightly above the client's own
// timeout so the client's abort — which carries the better error message —
// normally wins the race.
export const SCALER_BOOT_LOAD_TIMEOUT_MS = 12_000;

// Minimal structural logger, satisfied by Fastify's `app.log`
// (ParamStoreLogger in param-store.ts uses the same idiom).
export type ScalerBootConfigLogger = {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
};

export type ResolveScalerBootConfigOptions = {
  // Env/default values; used as-is whenever the store yields nothing usable.
  env: ScalerEnvConfig;
  // Durable store. Undefined when the parameter store is unconfigured.
  store?: ScalerConfigStore | undefined;
  log?: ScalerBootConfigLogger | undefined;
  timeoutMs?: number;
};

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<{ ok: true; value: T } | { ok: false }> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ ok: false }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false }), timeoutMs);
  });
  return Promise.race([
    promise.then((value) => ({ ok: true as const, value })),
    timeout
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Resolve the config the process should boot with. NEVER REJECTS: an
// unreachable, slow or broken store degrades to the env values with a warning,
// because refusing to start over an unreadable optional record would turn a
// config-service outage into a total API outage.
export async function resolveScalerBootConfig(
  opts: ResolveScalerBootConfigOptions
): Promise<ScalerBootConfig> {
  const { env, store, log } = opts;
  const timeoutMs = opts.timeoutMs ?? SCALER_BOOT_LOAD_TIMEOUT_MS;

  const fallback = (
    reason: ScalerBootFallbackReason,
    detail?: Record<string, unknown>
  ): ScalerBootConfig => {
    const payload = {
      reason,
      maxInstances: env.maxInstances,
      minInstances: env.minInstances,
      idleTimeoutMs: env.idleTimeoutMs,
      ...detail
    };
    // 'no-store'/'no-record' are expected states, not problems: info. The other
    // three mean a persisted value might be being ignored: warn, with the reason.
    if (reason === 'no-store' || reason === 'no-record') {
      log?.info(payload, 'scaler config: using environment values at boot');
    } else {
      log?.warn(
        payload,
        'scaler config: could not load the persisted record at boot, falling back to environment values'
      );
    }
    return { ...env, source: 'env', fallbackReason: reason };
  };

  if (!store) return fallback('no-store');

  let loaded: ScalerRuntimeConfig | undefined;
  try {
    const raced = await withTimeout(store.load(), timeoutMs);
    if (!raced.ok) return fallback('load-timeout', { timeoutMs });
    loaded = raced.value;
  } catch (err) {
    // No credentials or URLs in the log line: the store client's error text is
    // already credential-free (`config kv read failed: <status> <body>`), and we
    // log the error object the same way the rest of main.ts does.
    return fallback('load-failed', { err });
  }

  // `undefined` covers BOTH "key absent" and "stored blob unusable" — the
  // ScalerConfigStore.load contract collapses the two (param-store.ts:849-851),
  // so boot cannot tell them apart and reports the conservative reason.
  if (!loaded) return fallback('no-record');

  log?.info(
    {
      maxInstances: loaded.maxInstances,
      minInstances: loaded.minInstances,
      idleTimeoutMs: loaded.idleTimeoutMs,
      envMaxInstances: env.maxInstances,
      envMinInstances: env.minInstances,
      envIdleTimeoutMs: env.idleTimeoutMs
    },
    'scaler config: loaded persisted values at boot, overriding environment values'
  );
  return { ...loaded, source: 'persisted' };
}
