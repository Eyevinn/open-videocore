import test from 'node:test';
import assert from 'node:assert/strict';
import { registryAdapter, oscInstanceAdapter, healthProbe, SERVICE_ID } from '../runner/adapters.mjs';

const COMMIT = 'c'.repeat(40);
const res = (status, body, headers = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => body, headers: { get: (k) => headers[k.toLowerCase()] ?? null } });

// A fake GHCR: token endpoint, an image index with an attestation entry, an amd64 manifest, and the config blob.
function fakeRegistry({ labels = { 'io.osaas.repo.commit': COMMIT }, index = true, tokenStatus = 200, blobKey = 'Labels' } = {}) {
  const seen = [];
  const fetchImpl = async (url, init = {}) => {
    const u = String(url); seen.push([u, init.headers]);
    if (u.includes('/token')) return tokenStatus === 200 ? res(200, { token: 'BEARER' }) : res(tokenStatus, {});
    if (u.endsWith('/manifests/latest')) {
      return index
        ? res(200, { manifests: [{ digest: 'sha256:att', platform: { os: 'unknown', architecture: 'unknown' } }, { digest: 'sha256:amd', platform: { os: 'linux', architecture: 'amd64' } }] }, { 'docker-content-digest': 'sha256:indexdigest' })
        : res(200, { config: { digest: 'sha256:cfg' } }, { 'docker-content-digest': 'sha256:manifestdigest' });
    }
    if (u.endsWith('/manifests/sha256:amd')) return res(200, { config: { digest: 'sha256:cfg' } });
    if (u.endsWith('/blobs/sha256:cfg')) return res(200, { config: { [blobKey]: labels } });
    return res(404, {});
  };
  return { seen, fetchImpl };
}
const regOpts = { user: 'u', token: 'p' };

test('registry: token exchange (Basic), index -> linux/amd64 manifest -> config labels; returns tag digest and commit', async () => {
  const { seen, fetchImpl } = fakeRegistry();
  const r = await registryAdapter({ ...regOpts, fetchImpl }).latest();
  assert.deepEqual(r, { digest: 'sha256:indexdigest', commit: COMMIT });
  assert.match(seen[0][0], /ghcr\.io\/token.*scope=repository:eyevinn-osaas\/open-videocore:pull/);
  assert.equal(seen[0][1].authorization, `Basic ${Buffer.from('u:p').toString('base64')}`);
  assert.ok(seen.slice(1).every(([, h]) => h.authorization === 'Bearer BEARER'));
  assert.ok(!seen.some(([u]) => u.endsWith('/manifests/sha256:att')), 'the attestation entry is never fetched');
});

test('registry: a plain manifest (no index) and lowercase "labels" both work', async () => {
  const { fetchImpl } = fakeRegistry({ index: false, blobKey: 'labels' });
  assert.equal((await registryAdapter({ ...regOpts, fetchImpl }).latest()).commit, COMMIT);
});

test('registry: 401 on the token exchange, a missing label, or a malformed label are errors', async () => {
  await assert.rejects(registryAdapter({ ...regOpts, fetchImpl: fakeRegistry({ tokenStatus: 401 }).fetchImpl }).latest(), /HTTP 401/);
  await assert.rejects(registryAdapter({ ...regOpts, fetchImpl: fakeRegistry({ labels: {} }).fetchImpl }).latest(), /io\.osaas\.repo\.commit/);
  await assert.rejects(registryAdapter({ ...regOpts, fetchImpl: fakeRegistry({ labels: { 'io.osaas.repo.commit': '../x' } }).fetchImpl }).latest(), /io\.osaas\.repo\.commit/);
});

// A fake @osaas/client-core that records every call.
function fakeCore({ existing, images = ['ghcr.io/eyevinn-osaas/open-videocore:latest'], logs }) {
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
    getLogsForInstance: async () => { calls.push(['logs']); return typeof logs === 'function' ? logs() : [JSON.stringify({ time: Date.now() + 1000, msg: 'Server listening at http://127.0.0.1:8080' })]; },
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

test('osc: a restart is only trusted once a "Server listening" line newer than the restart appears', async () => {
  let polls = 0; let t = 1_000_000;
  const fresh = () => ++polls < 3
    ? [JSON.stringify({ time: t - 600_000, msg: 'Server listening at http://old' }), 'not json at all', JSON.stringify({ time: t, msg: 'something else' })]
    : [JSON.stringify({ time: t + 5000, msg: 'Server listening at http://new' })];
  const { calls, core } = fakeCore({ existing: true, logs: fresh });
  await oscInstanceAdapter({ name: 'ovce2e', env, importCore: async () => core, sleep: async () => {}, now: () => t, freshPodMs: 60_000 }).ensureFresh();
  assert.equal(calls.filter((c) => c[0] === 'logs').length, 3);
});

test('osc: if no new pod ever starts, ensureFresh fails instead of returning the pre-restart pod', async () => {
  let t = 1_000_000;
  const { core } = fakeCore({ existing: true, logs: () => [JSON.stringify({ time: t - 600_000, msg: 'Server listening at http://old' })] });
  const adapter = oscInstanceAdapter({ name: 'ovce2e', env, importCore: async () => core, sleep: async () => { t += 30_000; }, now: () => t, freshPodMs: 60_000 });
  await assert.rejects(adapter.ensureFresh(), /pre-restart pod/);
});
