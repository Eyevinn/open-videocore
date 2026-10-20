import { cases, CaseFailure, InfraFailure, SUITE_VERSION } from './cases.mjs';
import { createClient } from '../lib/http.mjs';
import { redact, redactValue } from '../lib/redact.mjs';
import { sweepLeftovers } from './sweep.mjs';

// Budgets, in ms. `transcodeMs` is 900 s (#1248): every run spawns a fresh encode instance and the observed cold
// starts on 2026-10-19 were 343 s and 382 s, too close to the old 600 s to tell a slow cold start from a stuck job.
// Each one is overridable per instance through the environment, see TIMEOUT_ENV.
export const DEFAULT_TIMEOUTS = {
  ingestMs: 120_000, readyMs: 300_000, metadataMs: 60_000, transcodeMs: 900_000, packageMs: 600_000, searchMs: 30_000,
};

/** Environment variable per budget. */
export const TIMEOUT_ENV = {
  ingestMs: 'E2E_TIMEOUT_INGEST_MS',
  readyMs: 'E2E_TIMEOUT_READY_MS',
  metadataMs: 'E2E_TIMEOUT_METADATA_MS',
  transcodeMs: 'E2E_TIMEOUT_TRANSCODE_MS',
  packageMs: 'E2E_TIMEOUT_PACKAGE_MS',
  searchMs: 'E2E_TIMEOUT_SEARCH_MS',
};

/**
 * The timeout overrides present in `env`; absent variables keep DEFAULT_TIMEOUTS.
 * A variable that is set but is not a positive number throws, so a typo cannot silently halve a budget.
 * @param {Record<string, string | undefined>} env
 */
export function timeoutsFromEnv(env = {}) {
  const out = {};
  for (const [key, name] of Object.entries(TIMEOUT_ENV)) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number of milliseconds, got "${raw}"`);
    out[key] = Math.trunc(n);
  }
  return out;
}

/**
 * Run the suite. A failed `chain` case marks later chain cases `skipped` so the result names the first
 * broken stage. Teardown deletes the asset if the `delete` case did not.
 *
 * Status: `green` with no failures; `infra-error` when every failure was a platform failure (an InfraFailure, see
 * cases.mjs) — not final, so the runner retries the same commit; `red` otherwise.
 * @param {{ client: any, anon: any, config: any, sleep?: Function, now?: Function }} deps
 */
export async function runSuite({ client, anon, ingress, config, sleep, now = Date.now }) {
  const cfg = { pollMs: 2_000, ...config, timeouts: { ...DEFAULT_TIMEOUTS, ...config.timeouts } };
  const ctx = { client, anon, ingress: ingress ?? anon, config: cfg, sleep, now, state: {} };
  let swept = 0;
  if (cfg.sweep !== false) { try { swept = await sweepLeftovers({ client, now }); } catch { /* best effort */ } }
  const results = [];
  let chainBroken = false;
  for (const c of cases) {
    if (c.chain && chainBroken) { results.push({ id: c.id, status: 'skipped', ms: 0 }); continue; }
    const t0 = now();
    try {
      await c.run(ctx);
      results.push({ id: c.id, status: 'pass', ms: now() - t0 });
    } catch (e) {
      results.push({
        id: c.id,
        status: 'fail',
        ms: now() - t0,
        ...(e instanceof InfraFailure && { failureClass: 'infra' }),
        // `observed` is masked like `detail`: its `error`/`message` fields are copied from an upstream response body
        // (a 502 is the free-form `{error, message}`), so an echoed credential must not reach the result store raw.
        ...(e?.observed && { observed: redactValue(e.observed, config.secrets) }),
        detail: redact(String(e instanceof CaseFailure ? e.message : `${e?.name}: ${e?.message}`), config.secrets).slice(0, 500),
      });
      if (c.chain) chainBroken = true;
    }
  }
  if (ctx.state.assetId && !ctx.state.deleted) {
    try { await client.request('DELETE', `/api/v1/assets/${ctx.state.assetId}`, { query: { force: 'true' } }); } catch { /* best effort */ }
  }
  const failed = results.filter((r) => r.status === 'fail');
  const status = failed.length === 0 ? 'green'
    : failed.every((r) => r.failureClass === 'infra') ? 'infra-error'
      : 'red'; // one real failure outweighs any number of platform ones: the image is not green
  return { suiteVersion: SUITE_VERSION, status, build: ctx.state.build, swept, cases: results };
}

export { createClient };
