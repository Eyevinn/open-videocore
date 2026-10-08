import test from 'node:test';
import assert from 'node:assert/strict';
import { localSource, oscInstanceAdapter, healthProbe, SERVICE_ID } from '../runner/adapters.mjs';

const COMMIT = 'c'.repeat(40);

test('localSource: commit from git, digest from scripts/source-digest.mjs of the checkout', async () => {
  const calls = [];
  const exec = (cmd, args, opts) => { calls.push([cmd, ...args]); return cmd === 'git' ? `${COMMIT}\n` : '6c7c967485812293\n'; };
  const r = await localSource({ repoRoot: '/repo', exec }).expected();
  assert.deepEqual(r, { commit: COMMIT, sourceDigest: '6c7c967485812293' });
  assert.deepEqual(calls[0], ['git', 'rev-parse', 'HEAD']);
  assert.deepEqual(calls[1], ['node', 'scripts/source-digest.mjs', '/repo']);
});

test('localSource: refuses a malformed commit or an empty digest', async () => {
  await assert.rejects(localSource({ repoRoot: '/r', exec: (c) => (c === 'git' ? 'nonsense' : 'd') }).expected(), /commit sha/);
  await assert.rejects(localSource({ repoRoot: '/r', exec: (c) => (c === 'git' ? COMMIT : '') }).expected(), /printed nothing/);
});

// A fake @osaas/client-core that records every call.
function fakeCore({ existing, images = ['ghcr.io/eyevinn-osaas/open-videocore:latest'] }) {
  const calls = []; let present = existing;
  class Context {
    constructor(cfg) { calls.push(['Context', cfg]); }
    async getServiceAccessToken(s) { calls.push(['sat', s]); return 'SAT'; }
    getEnvironment() { return 'prod'; }
    getPersonalAccessToken() { return 'PAT'; }
  }
  return { calls, core: {
    Context,
    createFetch: async (url, init) => {
      calls.push(['fetch', String(url), init.method, init.headers]);
      if (String(url).includes('/mysubscriptions')) return [{ serviceId: SERVICE_ID, apiUrl: 'https://api.svc.example/services/ovc' }];
      if (String(url).includes('/health/')) return { images };
      if (init.method === 'POST') { present = true; return { name: 'ovce2e' }; }
      throw new Error('unexpected fetch ' + url);
    },
    getInstance: async (ctx, s, n, t) => { calls.push(['getInstance', n]); if (!present) throw new Error('404'); return { name: n, url: 'https://i.example' }; },
    removeInstance: async () => { calls.push(['removeInstance']); present = false; },
    restartInstance: async () => { calls.push(['restartInstance']); },
    waitForInstanceReady: async () => { calls.push(['wait']); },
  } };
}
const env = { OSC_ACCESS_TOKEN: 'pat', E2E_INSTANCE_OSC_ACCESS_TOKEN: 'o', E2E_PARAMETER_STORE_API_KEY: 'k', E2E_PARAMETER_STORE: 'ps', E2E_MINIO_ROOT_PASSWORD: 'm', E2E_COUCHDB_ADMIN_PASSWORD: 'c' };
const names = (calls) => calls.map((c) => c[0]);
const fast = { sleep: async () => {}, waitGoneMs: 1000 };

test('osc: no instance -> created on the BETA channel with x-jwt, never via createInstance', async () => {
  const { calls, core } = fakeCore({ existing: false });
  const inst = await oscInstanceAdapter({ name: 'ovce2e', env, importCore: async () => core, ...fast }).ensureFresh();
  assert.deepEqual(inst, { baseUrl: 'https://i.example', token: 'SAT' });
  const post = calls.find((c) => c[0] === 'fetch' && c[2] === 'POST');
  assert.equal(new URL(post[1]).searchParams.get('beta'), 'true');
  assert.equal(post[3]['x-jwt'], 'Bearer SAT');
  const sub = calls.find((c) => String(c[1]).includes('/mysubscriptions'));
  assert.equal(sub[3]['x-pat-jwt'], 'Bearer PAT');
  assert.ok(!names(calls).includes('restartInstance') && !names(calls).includes('removeInstance'));
});

test('osc: the create body carries the required service config', async () => {
  const bodies = [];
  const { core } = fakeCore({ existing: false });
  const orig = core.createFetch; core.createFetch = async (u, i) => { if (i.method === 'POST') bodies.push(JSON.parse(i.body)); return orig(u, i); };
  await oscInstanceAdapter({ name: 'ovce2e', env, importCore: async () => core, ...fast }).ensureFresh();
  assert.deepEqual(Object.keys(bodies[0]).sort(), ['CouchdbAdminPassword', 'MinioRootPassword', 'OscAccessToken', 'ParameterStore', 'ParameterStoreApiKey', 'name']);
});

test('osc: a beta instance is restarted, not recreated', async () => {
  const { calls, core } = fakeCore({ existing: true });
  await oscInstanceAdapter({ name: 'ovce2e', env, importCore: async () => core, ...fast }).ensureFresh();
  const n = names(calls);
  assert.ok(n.includes('restartInstance') && !n.includes('removeInstance'));
  assert.ok(!calls.some((c) => c[0] === 'fetch' && c[2] === 'POST'));
});

test('osc: an instance on the STABLE channel is removed and recreated on beta', async () => {
  const { calls, core } = fakeCore({ existing: true, images: ['ghcr.io/eyevinn-osaas/open-videocore:stable'] });
  await oscInstanceAdapter({ name: 'ovce2e', env, importCore: async () => core, ...fast }).ensureFresh();
  const n = names(calls);
  assert.ok(n.indexOf('removeInstance') < n.findIndex((x, i) => x === 'fetch' && calls[i][2] === 'POST'));
  assert.ok(!n.includes('restartInstance'));
  const health = calls.find((c) => String(c[1]).includes('/health/ovce2e'));
  assert.equal(health[3]['x-jwt'], 'Bearer SAT');
});

test('healthProbe: sends x-jwt, returns the build, undefined on 401 or network error', async () => {
  const seen = [];
  const ok = async (u, init) => { seen.push([String(u), init.headers]); return { ok: true, json: async () => ({ build: { sourceDigest: 'abc' } }) }; };
  assert.deepEqual(await healthProbe({ baseUrl: 'https://i/', token: 'T' }, ok), { sourceDigest: 'abc' });
  assert.equal(seen[0][0], 'https://i/health');
  assert.equal(seen[0][1]['x-jwt'], 'Bearer T');
  assert.equal(await healthProbe({ baseUrl: 'https://i', token: 'T' }, async () => ({ ok: false, status: 401 })), undefined);
  assert.equal(await healthProbe({ baseUrl: 'https://i', token: 'T' }, async () => { throw new Error('net'); }), undefined);
});
