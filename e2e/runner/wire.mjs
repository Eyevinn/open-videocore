// Builds the cycle's dependencies from the environment, shared by the one-shot CLI and the server.
import { registryAdapter, oscInstanceAdapter, healthProbe } from './adapters.mjs';
import { fileStore } from './store-file.mjs';
import { s3Store } from './store-s3.mjs';
import { createClient, runSuite } from '../suite/run.mjs';

export class ConfigError extends Error {}

export async function buildDeps(env) {
  const need = (k) => { if (!env[k]) throw new ConfigError(`missing env ${k}`); return env[k]; };
  const secrets = ['GHCR_TOKEN', 'OSC_ACCESS_TOKEN', 'E2E_INSTANCE_OSC_ACCESS_TOKEN', 'E2E_PARAMETER_STORE_API_KEY',
    'E2E_MINIO_ROOT_PASSWORD', 'E2E_COUCHDB_ADMIN_PASSWORD', 'E2E_S3_SECRET_KEY'].map((k) => env[k]).filter(Boolean);
  const store = env.E2E_S3_ENDPOINT
    ? await s3Store({ bucket: need('E2E_S3_BUCKET'), endpoint: env.E2E_S3_ENDPOINT, accessKeyId: need('E2E_S3_ACCESS_KEY'), secretAccessKey: need('E2E_S3_SECRET_KEY') })
    : fileStore(need('E2E_RESULTS_DIR'));
  const sourceUrl = need('E2E_SOURCE_URL');
  return {
    secrets,
    registry: registryAdapter({ user: need('GHCR_USER'), token: need('GHCR_TOKEN') }),
    instance: oscInstanceAdapter({ name: env.E2E_INSTANCE_NAME ?? 'ovce2e', env }),
    health: healthProbe,
    store,
    runSuite: (inst, expected) => runSuite({
      client: createClient({ baseUrl: inst.baseUrl, token: inst.token }),
      anon: createClient({ baseUrl: inst.baseUrl }),
      config: { secrets, runId: new Date().toISOString().replace(/\D/g, '').slice(0, 14), sourceUrl, expectCommit: expected.commit },
    }),
  };
}
