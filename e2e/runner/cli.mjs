#!/usr/bin/env node
// One cycle. Env: GITHUB_TOKEN (optional), GHCR_USER, GHCR_TOKEN (read:packages), OSC_ACCESS_TOKEN,
// E2E_INSTANCE_NAME (default ovce2e), E2E_INSTANCE_* (see adapters.mjs), E2E_SOURCE_URL, E2E_RESULTS_DIR.
// Exit 0 only when the digest's result is green (fresh or already recorded); anything else exits 1 so a
// scheduler flags it, including a red result found on a skip.
import { runCycle } from './cycle.mjs';
import { githubAdapter, registryAdapter, oscInstanceAdapter, healthProbe } from './adapters.mjs';
import { fileStore } from './store-file.mjs';
import { createClient, runSuite } from '../suite/run.mjs';

const env = process.env;
const need = (k) => { if (!env[k]) { console.error(`missing env ${k}`); process.exit(2); } return env[k]; };
const secrets = [env.GHCR_TOKEN, env.GITHUB_TOKEN, env.OSC_ACCESS_TOKEN, env.E2E_INSTANCE_OSC_ACCESS_TOKEN, env.E2E_PARAMETER_STORE_API_KEY, env.E2E_MINIO_ROOT_PASSWORD, env.E2E_COUCHDB_ADMIN_PASSWORD].filter(Boolean);
const out = await runCycle({
  secrets,
  github: githubAdapter({ token: env.GITHUB_TOKEN }),
  registry: registryAdapter({ user: need('GHCR_USER'), token: need('GHCR_TOKEN') }),
  instance: oscInstanceAdapter({ name: env.E2E_INSTANCE_NAME ?? 'ovce2e', env }),
  health: healthProbe,
  store: fileStore(need('E2E_RESULTS_DIR')), // swap for the bucket store once the bucket exists
  runSuite: (inst, expectCommit) => runSuite({
    client: createClient({ baseUrl: inst.baseUrl, token: inst.token }),
    anon: createClient({ baseUrl: inst.baseUrl }),
    config: { secrets, runId: new Date().toISOString().replace(/\D/g, '').slice(0, 14), sourceUrl: need('E2E_SOURCE_URL'), expectCommit },
  }),
});
console.log(JSON.stringify(out, null, 2));
process.exit(out.status === 'green' ? 0 : 1);
