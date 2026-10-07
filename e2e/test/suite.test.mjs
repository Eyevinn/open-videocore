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

test('wrong build commit fails health', async () => {
  const { result } = await run({}, { expectCommit: 'deadbeef' });
  assert.equal(byId(result).health.status, 'fail');
  assert.match(byId(result).health.detail, /expected deadbeef/);
});

test('results never contain the token', async () => {
  const { result, mock } = await run({ openAuth: true });
  assert.equal(JSON.stringify(result).includes(mock.token), false);
});
