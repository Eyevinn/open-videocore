#!/usr/bin/env node
// One cycle. Env: GITHUB_TOKEN (optional), GHCR_USER, GHCR_TOKEN (read:packages), OSC_ACCESS_TOKEN,
// E2E_INSTANCE_NAME (default ovce2e), E2E_INSTANCE_* (see adapters.mjs), E2E_SOURCE_URL, E2E_RESULTS_DIR.
// Exit 0 when a result was recorded or skipped, 1 on a red/stale/infra-error result so a scheduler flags it.
import { runCycle } from './cycle.mjs';
import { githubAdapter, registryAdapter, oscInstanceAdapter, healthProbe } from './adapters.mjs';
import { fileStore } from './store-file.mjs';
import { createClient, runSuite } from '../suite/run.mjs';

const env = process.env;
const need = (k) => { if (!env[k]) { console.error(`missing env ${k}`); process.exit(2); } return env[k]; };
const out = await runCycle({
  github: githubAdapter({ token: env.GITHUB_TOKEN }),
  registry: registryAdapter({ user: need('GHCR_USER'), token: need('GHCR_TOKEN') }),
  instance: oscInstanceAdapter({ name: env.E2E_INSTANCE_NAME ?? 'ovce2e', env }),
  health: healthProbe,
  store: fileStore(need('E2E_RESULTS_DIR')), // swap for the bucket store once the bucket exists
  runSuite: (inst, expectCommit) => runSuite({
    client: createClient({ baseUrl: inst.baseUrl, token: inst.token }),
    anon: createClient({ baseUrl: inst.baseUrl }),
    config: { runId: new Date().toISOString().replace(/\D/g, '').slice(0, 14), sourceUrl: need('E2E_SOURCE_URL'), expectCommit },
  }),
});
console.log(JSON.stringify(out, null, 2));
process.exit(out.action === 'skip' || out.status === 'green' ? 0 : 1);
