// TAMS bridge config gate (issue #171, sub-task of #116).
//
// The TAMS indexing bridge is OPT-IN. Deployments that do not use it must run
// exactly as before: no TAMS client constructed, no network call, no error.
// This module is the single decision point that decides — from config alone —
// whether the indexing path proceeds or is a clean no-op.
//
// Contract source (ADR-009, config-gating rule; #169):
//   - Parameter-store / env key: `TAMS_STORE_URL`.
//   - "TAMS is configured" iff the value is a present, non-empty string after
//     trimming: `typeof v === 'string' && v.trim().length > 0`.
//   - Unconfigured => bridge disabled: NO TAMS client, NO network call, a single
//     structured log line, NO error thrown.
//   - Configured => the trimmed value is the gateway base URL and feeds
//     `TamsGatewayClientConfig.gatewayBaseUrl` (src/tams/tams-gateway-client.ts).
//     Auth is the separate delegated OSC access token — not sourced here.
//
// Env-read + degrade-when-unset style follows src/services/param-store.ts
// (`process.env['...']`, return-a-clear-absent-result rather than throw; see
// paramStoreFromEnv). The structured-log style follows the injected Fastify /
// pino logger used across the codebase — `log.info({ ...fields }, 'message')`
// (see src/main.ts, src/services/webhook-dispatcher.ts DispatcherLogger).
//
// This module is deliberately self-contained: it does NOT import the concrete
// index-write client (#170). The future indexing trigger (#172) consumes this
// gate to decide whether to construct anything at all.

import type { TamsGatewayClientConfig } from './tams-gateway-client.js';

// The env / parameter-store key that gates the bridge (ADR-009).
export const TAMS_STORE_URL_ENV = 'TAMS_STORE_URL' as const;

// Minimal structured logger surface, compatible with Fastify's logger. Injected
// so the "bridge disabled" line is observable without coupling to a concrete
// logger (mirrors DispatcherLogger in src/services/webhook-dispatcher.ts).
export type TamsConfigLogger = {
  info: (obj: unknown, msg?: string) => void;
};

const noopLogger: TamsConfigLogger = { info: () => {} };

// The resolved bridge configuration when TAMS is configured. `gatewayBaseUrl`
// is the trimmed `TAMS_STORE_URL` value and is shaped to feed directly into
// `TamsGatewayClientConfig.gatewayBaseUrl` (src/tams/tams-gateway-client.ts).
export type TamsBridgeConfig = {
  gatewayBaseUrl: TamsGatewayClientConfig['gatewayBaseUrl'];
};

// Result of reading + validating the config. A discriminated union so callers
// branch exhaustively: `configured: true` carries the resolved config;
// `configured: false` is the clean "not configured" outcome with no config.
export type TamsConfigResult =
  | { configured: true; config: TamsBridgeConfig }
  | { configured: false };

// Read and validate the TAMS bridge config from the environment.
//
// Returns `{ configured: true, config }` when `TAMS_STORE_URL` is a present,
// non-empty string after trimming (ADR-009), with `config.gatewayBaseUrl` set to
// the trimmed value. Otherwise returns `{ configured: false }` — no throw. The
// env source is injectable for tests; it defaults to `process.env`.
export function readTamsConfig(
  env: NodeJS.ProcessEnv = process.env
): TamsConfigResult {
  const raw = env[TAMS_STORE_URL_ENV];
  // ADR-009 configured predicate: present, non-empty string after trimming.
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return { configured: false };
  }
  return { configured: true, config: { gatewayBaseUrl: raw.trim() } };
}

// Outcome of the gate. `proceed` carries the resolved config so the caller can
// construct the client / gateway config; `skip` carries nothing — the caller
// must construct nothing and make no network call.
export type TamsGateDecision =
  | { action: 'proceed'; config: TamsBridgeConfig }
  | { action: 'skip' };

// Gate helper: given a config result, decide whether the indexing path proceeds.
//
// When unconfigured, emits EXACTLY ONE structured log line and returns
// `{ action: 'skip' }` — the caller constructs nothing and makes no network
// call. When configured, returns `{ action: 'proceed', config }` and logs
// nothing (the normal path stays quiet). Never throws.
export function gateTamsIndexing(
  result: TamsConfigResult,
  log: TamsConfigLogger = noopLogger
): TamsGateDecision {
  if (!result.configured) {
    log.info(
      { env: TAMS_STORE_URL_ENV },
      'TAMS store not configured — indexing bridge disabled'
    );
    return { action: 'skip' };
  }
  return { action: 'proceed', config: result.config };
}

// Convenience one-shot: read from the environment and gate in a single call.
// The future indexing trigger (#172) can use this without touching the concrete
// write client. Env source is injectable for tests (defaults to process.env).
export function resolveTamsGate(
  log: TamsConfigLogger = noopLogger,
  env: NodeJS.ProcessEnv = process.env
): TamsGateDecision {
  return gateTamsIndexing(readTamsConfig(env), log);
}
