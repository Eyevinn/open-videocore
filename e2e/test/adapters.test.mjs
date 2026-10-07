import test from 'node:test';
import assert from 'node:assert/strict';
import { githubAdapter, oscInstanceAdapter, SERVICE_ID } from '../runner/adapters.mjs';

const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });

test('github: head sha from commits/main, error on non-200', async () => {
  const urls = [];
  const g = githubAdapter({ fetchImpl: async (u) => { urls.push(String(u)); return res(200, { sha: 'abc' }); } });
  assert.equal(await g.headSha(), 'abc');
  assert.equal(urls[0], 'https://api.github.com/repos/Eyevinn/open-videocore/commits/main');
  await assert.rejects(githubAdapter({ fetchImpl: async () => res(403, {}) }).headSha(), /HTTP 403/);
});

function fakeCore({ existing }) {
  const calls = [];
  class Context { constructor(cfg) { calls.push(['Context', cfg]); } async getServiceAccessToken(s) { calls.push(['sat', s]); return 'SAT'; } }
  return { calls, core: {
    Context,
    getInstance: async (ctx, s, n, t) => { calls.push(['getInstance', s, n, t]); if (!existing && calls.filter((c) => c[0] === 'getInstance').length === 1) throw new Error('404'); return { name: n, url: 'https://i.example' }; },
    createInstance: async (ctx, s, t, body) => { calls.push(['createInstance', s, t, body]); return { name: body.name }; },
    restartInstance: async (ctx, s, n, t) => { calls.push(['restartInstance', s, n, t]); },
    waitForInstanceReady: async (s, n) => { calls.push(['wait', s, n]); },
  } };
}
const env = { OSC_ACCESS_TOKEN: 'pat', E2E_INSTANCE_OSC_ACCESS_TOKEN: 'o', E2E_PARAMETER_STORE_API_KEY: 'k', E2E_PARAMETER_STORE: 'ps', E2E_MINIO_ROOT_PASSWORD: 'm', E2E_COUCHDB_ADMIN_PASSWORD: 'c' };

test('osc: existing instance is restarted, not recreated', async () => {
  const { calls, core } = fakeCore({ existing: true });
  const inst = await oscInstanceAdapter({ name: 'ovce2e', env, importCore: async () => core }).ensureFresh();
  assert.deepEqual(inst, { baseUrl: 'https://i.example', token: 'SAT' });
  const names = calls.map((c) => c[0]);
  assert.ok(names.includes('restartInstance') && !names.includes('createInstance'));
  assert.ok(names.indexOf('restartInstance') < names.indexOf('wait'));
});

test('osc: missing instance is created with the required config options', async () => {
  const { calls, core } = fakeCore({ existing: false });
  await oscInstanceAdapter({ name: 'ovce2e', env, importCore: async () => core }).ensureFresh();
  const create = calls.find((c) => c[0] === 'createInstance');
  assert.equal(create[1], SERVICE_ID);
  assert.deepEqual(Object.keys(create[3]).sort(), ['CouchdbAdminPassword', 'MinioRootPassword', 'OscAccessToken', 'ParameterStore', 'ParameterStoreApiKey', 'name']);
  assert.ok(!calls.some((c) => c[0] === 'restartInstance'));
});
