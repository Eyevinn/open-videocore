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
//   - src/services/param-store.ts `SCALER_CONFIG_BOUNDS` — the authoritative
//     per-field range, which routes/scaler.ts `scalerConfigSchema` applies to the
//     PATCH body AND (through `scalerConfigResponseSchema`) to the 200 response
//     of GET/PATCH /api/v1/scaler/config. The clamp below applies the same
//     constant, see IN BOUNDS.
//
// IN BOUNDS. `parseScalerRuntimeConfig` enforces only a sanity floor (usable
// integers), by design: the full range check lives with the write path so
// tightening a bound later cannot silently discard an operator's stored value.
// That was harmless while nothing read the record, but this resolver makes the
// read authoritative, so the loaded values are CLAMPED into SCALER_CONFIG_BOUNDS
// here and a clamp is warn-logged with the stored and applied numbers. Without
// it a record written under looser bounds (e.g. idleTimeoutMs 5000, maxInstances
// 50) would run the loops below the documented minimum idle timeout or above the
// documented instance ceiling AND fail the 200 response schema of
// GET /api/v1/scaler/config, turning every call into a 500. Clamping rather than
// rejecting keeps the operator's intent ("as high as allowed", "as short as
// allowed") instead of silently reverting to an unrelated env value.
//
// The ENV BRANCH is clamped by the same function for the same reason: since this
// resolver's output seeds the config endpoint, an out-of-range or non-numeric
// ENCORE_MIN_INSTANCES / ENCORE_MAX_INSTANCES / ENCORE_IDLE_TIMEOUT_MS would
// fail that same 200 response schema. Before #1078 it could not: minInstances
// was a hardcoded 0 at the endpoint and the env values never reached it.
//
// ALL-OR-NOTHING. The resolved config is either entirely persisted or entirely
// env-sourced. Field-by-field merging is deliberately NOT done: the stored blob
// is one snapshot written by one PATCH, so mixing half of it with env values
// would produce a combination no operator ever asked for (e.g. a persisted
// maxInstances of 1 against an env idle timeout chosen for a cap of 10).

import { SCALER_CONFIG_BOUNDS } from './param-store.js';
import type { ScalerConfigStore, ScalerRuntimeConfig } from './param-store.js';

// The env-sourced (or built-in default) values boot falls back to. main.ts
// resolves these from ENCORE_MAX_INSTANCES / ENCORE_MIN_INSTANCES /
// ENCORE_IDLE_TIMEOUT_MS before calling this.
export type ScalerEnvConfig = ScalerRuntimeConfig;

// Why boot ended up on the environment values. Logged, and worth keeping
// distinct: 'no-store' and 'no-record' are NORMAL (an unconfigured deployment,
// or one never configured through the API), while 'load-failed' and
// 'load-timeout' mean a persisted value may exist and is NOT being honoured —
// an operator-visible degradation that has to be warn-logged with its reason
// rather than passed over in silence.
//
// There is deliberately NO 'unusable-record' member. The store seam does not
// expose that case: `ScalerConfigStore.load()` collapses "key absent" and
// "stored blob unusable" into `undefined` (param-store.ts `makeScalerConfigStore`
// -> `parseScalerRuntimeConfig`), so boot genuinely cannot tell them apart and a
// member for it would be unreachable dead code claiming a precision this
// resolver does not have. Both arrive as 'no-record'. An unusable blob is also
// the narrower of the two risks after the clamp below: a record that parses but
// sits outside the route's bounds is now repaired and warn-logged rather than
// adopted or dropped.
export type ScalerBootFallbackReason =
  // No parameter store is configured for this deployment (PARAMETER_STORE_API_KEY
  // unset, or the config-service instance URL unresolvable). PATCH also responds
  // 501 in this state, so there can be no persisted record to miss.
  | 'no-store'
  // Store reachable, nothing usable under the key: either a deployment never
  // configured through the API, or a stored blob parseScalerRuntimeConfig
  // rejected — indistinguishable through `load()`, see the note above.
  | 'no-record'
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

// One field clamped into [min, max?] from SCALER_CONFIG_BOUNDS. Returns the
// applied value plus the original one when they differ, so the caller can
// report exactly what it repaired.
//
// NOT-A-NUMBER. A non-finite value (NaN from `parseInt('')`/`parseInt('abc')`
// on an ENCORE_* environment variable, or an Infinity) is treated as out of
// range and clamped to `bounds.min`, because the two comparisons below are both
// false for NaN and would otherwise let it through — and NaN fails
// `z.number().int()` in the route's response schema just as surely as 12 fails
// `.max(10)`. `bounds.min` is the conservative choice: the smallest value the
// API documents, reported in the caller's warn log next to the unusable input.
// Fractional values are not handled because neither producer can emit one:
// `parseScalerRuntimeConfig` admits only integers, and main.ts reads the
// environment with `parseInt`.
function clampField(
  value: number,
  bounds: { min: number; max?: number }
): { value: number; clampedFrom?: number } {
  if (!Number.isFinite(value)) return { value: bounds.min, clampedFrom: value };
  let applied = value;
  if (applied < bounds.min) applied = bounds.min;
  if (bounds.max !== undefined && applied > bounds.max) applied = bounds.max;
  return applied === value ? { value } : { value: applied, clampedFrom: value };
}

// Apply the route's bounds to a config, whether it was loaded from the store or
// read from the environment (see IN BOUNDS in the file header). Reports which
// fields moved so the caller warn-logs a repair instead of adopting a config the
// API itself would reject.
export function clampPersistedScalerConfig(loaded: ScalerRuntimeConfig): {
  config: ScalerRuntimeConfig;
  clamped: Partial<Record<keyof ScalerRuntimeConfig, number>>;
} {
  const maxInstances = clampField(loaded.maxInstances, SCALER_CONFIG_BOUNDS.maxInstances);
  const minInstances = clampField(loaded.minInstances, SCALER_CONFIG_BOUNDS.minInstances);
  const idleTimeoutMs = clampField(loaded.idleTimeoutMs, SCALER_CONFIG_BOUNDS.idleTimeoutMs);
  const clamped: Partial<Record<keyof ScalerRuntimeConfig, number>> = {};
  if (maxInstances.clampedFrom !== undefined) clamped.maxInstances = maxInstances.clampedFrom;
  if (minInstances.clampedFrom !== undefined) clamped.minInstances = minInstances.clampedFrom;
  if (idleTimeoutMs.clampedFrom !== undefined) clamped.idleTimeoutMs = idleTimeoutMs.clampedFrom;
  return {
    config: {
      maxInstances: maxInstances.value,
      minInstances: minInstances.value,
      idleTimeoutMs: idleTimeoutMs.value
    },
    clamped
  };
}

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

  // The environment values need the SAME clamp as a loaded record, for the same
  // reason: ENCORE_MIN_INSTANCES=12, ENCORE_MAX_INSTANCES=50,
  // ENCORE_IDLE_TIMEOUT_MS=5000 or a non-numeric value (parseInt -> NaN) are
  // outside `scalerConfigResponseSchema` just as much as a stale stored record
  // is, and since #1078 these values are what seeds the config endpoint — an
  // unclamped one would fail the 200 response schema and turn every GET/PATCH
  // /api/v1/scaler/config into a 500 for the life of the process. Deliberately
  // the same `clampPersistedScalerConfig` / SCALER_CONFIG_BOUNDS as the
  // persisted branch, so the two cannot drift, and warn-logged in the same shape
  // (reason + clampedFrom + applied values + bounds) — only the reason differs,
  // naming the environment as the source of the out-of-range input.
  const fallback = (
    reason: ScalerBootFallbackReason,
    detail?: Record<string, unknown>
  ): ScalerBootConfig => {
    const { config, clamped } = clampPersistedScalerConfig(env);
    if (Object.keys(clamped).length > 0) {
      log?.warn(
        {
          reason: 'out-of-bounds-env',
          clampedFrom: clamped,
          maxInstances: config.maxInstances,
          minInstances: config.minInstances,
          idleTimeoutMs: config.idleTimeoutMs,
          bounds: SCALER_CONFIG_BOUNDS
        },
        "scaler config: the deployment's environment values are outside the permitted " +
          'range; clamped to the nearest allowed values at boot'
      );
    }
    const payload = {
      reason,
      maxInstances: config.maxInstances,
      minInstances: config.minInstances,
      idleTimeoutMs: config.idleTimeoutMs,
      ...detail
    };
    // 'no-store'/'no-record' are expected states, not problems: info. The other
    // two mean a persisted value might be being ignored: warn, with the reason.
    if (reason === 'no-store' || reason === 'no-record') {
      log?.info(payload, 'scaler config: using environment values at boot');
    } else {
      log?.warn(
        payload,
        'scaler config: could not load the persisted record at boot, falling back to environment values'
      );
    }
    return { ...config, source: 'env', fallbackReason: reason };
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
  // ScalerConfigStore.load contract collapses the two (param-store.ts
  // `makeScalerConfigStore.load` -> `parseScalerRuntimeConfig`), so boot cannot
  // tell them apart and reports the conservative reason (see the note on
  // ScalerBootFallbackReason).
  if (!loaded) return fallback('no-record');

  // A parseable record can still be out of the route's range (the parser only
  // enforces a sanity floor). Repair it rather than adopt it: an unclamped value
  // would be rejected by the very endpoint that has to report it.
  const { config, clamped } = clampPersistedScalerConfig(loaded);
  if (Object.keys(clamped).length > 0) {
    log?.warn(
      {
        reason: 'out-of-bounds-record',
        clampedFrom: clamped,
        maxInstances: config.maxInstances,
        minInstances: config.minInstances,
        idleTimeoutMs: config.idleTimeoutMs,
        bounds: SCALER_CONFIG_BOUNDS
      },
      'scaler config: the persisted record is outside the permitted range; ' +
        'clamped to the nearest allowed values at boot'
    );
  }

  log?.info(
    {
      maxInstances: config.maxInstances,
      minInstances: config.minInstances,
      idleTimeoutMs: config.idleTimeoutMs,
      envMaxInstances: env.maxInstances,
      envMinInstances: env.minInstances,
      envIdleTimeoutMs: env.idleTimeoutMs
    },
    'scaler config: loaded persisted values at boot, overriding environment values'
  );
  return { ...config, source: 'persisted' };
}
