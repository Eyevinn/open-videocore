import { cases, CaseFailure, SUITE_VERSION } from './cases.mjs';
import { createClient } from '../lib/http.mjs';
import { redact } from '../lib/redact.mjs';
import { sweepLeftovers } from './sweep.mjs';

export const DEFAULT_TIMEOUTS = {
  ingestMs: 120_000, readyMs: 300_000, metadataMs: 60_000, transcodeMs: 600_000, packageMs: 600_000, searchMs: 30_000,
};

/**
 * Run the suite. A failed `chain` case marks later chain cases `skipped` so the result names the first
 * broken stage. Teardown deletes the asset if the `delete` case did not.
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
      results.push({ id: c.id, status: 'fail', ms: now() - t0, detail: redact(String(e instanceof CaseFailure ? e.message : `${e?.name}: ${e?.message}`), config.secrets).slice(0, 500) });
      if (c.chain) chainBroken = true;
    }
  }
  if (ctx.state.assetId && !ctx.state.deleted) {
    try { await client.request('DELETE', `/api/v1/assets/${ctx.state.assetId}`, { query: { force: 'true' } }); } catch { /* best effort */ }
  }
  const status = results.some((r) => r.status === 'fail') ? 'red' : 'green';
  return { suiteVersion: SUITE_VERSION, status, build: ctx.state.build, swept, cases: results };
}

export { createClient };
