import test from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './mock-server.mjs';
import { createClient, runSuite } from '../suite/run.mjs';

const fastCfg = { runId: 't1', sourceUrl: 'http://fixture/clip.mp4', pollMs: 1, timeouts: { ingestMs: 500, metadataMs: 500, transcodeMs: 500, packageMs: 500, searchMs: 50 } };
async function run(faults = {}, cfg = {}) {
  const mock = await startMock({ faults });
  try {
    const result = await runSuite({
      client: createClient({ baseUrl: mock.baseUrl, token: mock.token }),
      anon: createClient({ baseUrl: mock.baseUrl }),
      config: { ...fastCfg, ...cfg },
    });
    return { result, mock };
  } finally { await mock.close(); }
}
const byId = (r) => Object.fromEntries(r.cases.map((c) => [c.id, c]));

test('green against a contract-conformant instance, and cleans up its asset', async () => {
  const { result, mock } = await run();
  assert.equal(result.status, 'green', JSON.stringify(result.cases.filter((c) => c.status !== 'pass')));
  assert.equal(result.cases.length, 11);
  assert.equal(mock.assets.size, 0);
  assert.equal(result.build.commit, 'abc1234');
});

test('anonymous access allowed -> auth-required fails (regression guard for #711)', async () => {
  const { result } = await run({ openAuth: true });
  assert.equal(result.status, 'red');
  assert.equal(byId(result)['auth-required'].status, 'fail');
});

test('ingest job failure fails ingest and skips the rest of the chain', async () => {
  const { result } = await run({ ingestJobFails: true });
  const c = byId(result);
  assert.equal(c['ingest-url'].status, 'fail');
  assert.match(c['ingest-url'].detail, /failed.*download failed/);
  for (const id of ['metadata', 'thumbnails', 'transcode', 'package', 'search', 'tags-roundtrip', 'delete']) assert.equal(c[id].status, 'skipped', id);
  assert.equal(c.health.status, 'pass');
});

test('packagingError fails package, later chain cases skipped', async () => {
  const { result } = await run({ packagingError: true });
  const c = byId(result);
  assert.equal(c.package.status, 'fail');
  assert.match(c.package.detail, /packagingError/);
  assert.equal(c.search.status, 'skipped');
});

test('asset missing from search times out as a failure', async () => {
  const { result } = await run({ searchEmpty: true });
  assert.equal(byId(result).search.status, 'fail');
  assert.match(byId(result).search.detail, /timed out/);
});

test('wrong build commit fails health; "unknown" commit is not a mismatch', async () => {
  const { result } = await run({}, { expectCommit: 'deadbeef' });
  assert.equal(byId(result).health.status, 'fail');
  assert.match(byId(result).health.detail, /expected deadbeef/);
  const mock = await startMock({ commit: 'unknown' });
  try {
    const r = await runSuite({ client: createClient({ baseUrl: mock.baseUrl, token: mock.token }), anon: createClient({ baseUrl: mock.baseUrl }), config: { ...fastCfg, expectCommit: 'deadbeef' } });
    assert.equal(byId(r).health.status, 'pass');
  } finally { await mock.close(); }
});

test('the client sends x-jwt, never Authorization, and anonymous health is rejected like the ingress does', async () => {
  const mock = await startMock();
  try {
    assert.equal((await createClient({ baseUrl: mock.baseUrl }).request('GET', '/health')).status, 401);
    assert.equal((await createClient({ baseUrl: mock.baseUrl, token: mock.token }).request('GET', '/health')).status, 200);
    assert.equal((await createClient({ baseUrl: mock.baseUrl, token: mock.token, authHeader: 'authorization' }).request('GET', '/health')).status, 401);
  } finally { await mock.close(); }
});

test('results never contain the token', async () => {
  const { result, mock } = await run({ openAuth: true });
  assert.equal(JSON.stringify(result).includes(mock.token), false);
});

import { sweepLeftovers } from '../suite/sweep.mjs';

test('sweep deletes only old e2e- assets, keeps recent and foreign ones, and runs before the cases', async () => {
  const mock = await startMock();
  try {
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    mock.seed({ id: 'old-e2e', name: 'e2e-20260101', createdAt: old });
    mock.seed({ id: 'new-e2e', name: 'e2e-now', createdAt: new Date().toISOString() });
    mock.seed({ id: 'product', name: 'Real asset', createdAt: old });
    const client = createClient({ baseUrl: mock.baseUrl, token: mock.token });
    const result = await runSuite({ client, anon: createClient({ baseUrl: mock.baseUrl }), config: fastCfg });
    assert.equal(result.swept, 1);
    assert.deepEqual([...mock.assets.keys()].sort(), ['new-e2e', 'product']);
    assert.equal(result.status, 'green');
  } finally { await mock.close(); }
});

test('sweep pages through the list', async () => {
  const mock = await startMock();
  try {
    const old = new Date(Date.now() - 3 * 3600_000).toISOString();
    for (let i = 0; i < 5; i++) mock.seed({ id: `o${i}`, name: `e2e-${i}`, createdAt: old });
    const client = createClient({ baseUrl: mock.baseUrl, token: mock.token });
    const n = await sweepLeftovers({ client, pageSize: 2 }); // three list calls
    assert.equal(n, 5);
    assert.equal(mock.assets.size, 0);
  } finally { await mock.close(); }
});
