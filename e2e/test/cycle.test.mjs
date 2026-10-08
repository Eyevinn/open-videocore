import test from 'node:test';
import assert from 'node:assert/strict';
import { runCycle } from '../runner/cycle.mjs';

const C1 = 'a'.repeat(40);
const C2 = 'b'.repeat(40);
const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
function deps(over = {}) {
  const store = new Map();
  const log = [];
  const d = {
    registry: { latest: async () => ({ digest: D1, commit: C1 }) },
    instance: { ensureFresh: async () => { log.push('ensure'); return { baseUrl: 'http://i', token: 't' }; } },
    health: async () => ({ commit: 'unknown', sourceDigest: 'unknown', version: 'unknown' }),
    runSuite: async () => { log.push('suite'); return { suiteVersion: 'v1', status: 'green', build: {}, cases: [{ id: 'health', status: 'pass' }] }; },
    store: { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v); } },
    opts: { waitMs: 50, pollMs: 1, retries: 2, backoffMs: 1 },
    sleep: async () => {},
    clock: () => '2026-10-08T00:00:00Z',
    ...over,
  };
  return { d, store, log };
}

test('green: recorded under the commit read from the :latest label, with its image digest', async () => {
  const { d, store, log } = deps();
  const r = await runCycle(d);
  assert.equal(r.status, 'green');
  assert.deepEqual(log, ['ensure', 'suite']);
  const rec = store.get(C1);
  assert.equal(rec.commit, C1);
  assert.equal(rec.imageDigest, D1);
  assert.equal(rec.suiteVersion, 'v1');
});

test('the suite receives the label commit', async () => {
  let got;
  const { d } = deps({ runSuite: async (inst, expected) => { got = expected; return { suiteVersion: 'v1', status: 'green', build: {}, cases: [] }; } });
  await runCycle(d);
  assert.deepEqual(got, { commit: C1 });
});

test('already tested commit (green or red) is skipped and carries its status', async () => {
  for (const status of ['green', 'red']) {
    const { d, store, log } = deps();
    store.set(C1, { status });
    const r = await runCycle(d);
    assert.equal(r.action, 'skip');
    assert.equal(r.status, status);
    assert.deepEqual(log, []);
  }
});

test('a stale or infra-error record is NOT final: the same commit is tried again', async () => {
  for (const status of ['stale', 'infra-error']) {
    const { d, store, log } = deps();
    store.set(C1, { status });
    assert.equal((await runCycle(d)).status, 'green', status);
    assert.deepEqual(log, ['ensure', 'suite']);
  }
});

test('a new :latest commit is a new key: the old result does not block it', async () => {
  const { d, store } = deps({ registry: { latest: async () => ({ digest: D2, commit: C2 }) } });
  store.set(C1, { status: 'green' });
  assert.equal((await runCycle(d)).status, 'green');
  assert.equal(store.get(C2).status, 'green');
});

test('red suite is recorded red', async () => {
  const { d, store } = deps({ runSuite: async () => ({ suiteVersion: 'v1', status: 'red', build: {}, cases: [{ id: 'ingest-url', status: 'fail' }] }) });
  assert.equal((await runCycle(d)).status, 'red');
  assert.equal(store.get(C1).status, 'red');
});

test('a registry failure aborts the cycle and records nothing (no commit, no key)', async () => {
  const { d, store, log } = deps({ registry: { latest: async () => { throw new Error('registry token exchange returned HTTP 401'); } } });
  await assert.rejects(runCycle(d), /HTTP 401/);
  assert.equal(store.size, 0);
  assert.deepEqual(log, []);
});

test(':latest moving while the instance restarts is stale and the suite is not run', async () => {
  let calls = 0;
  const { d, log } = deps({ registry: { latest: async () => (++calls === 1 ? { digest: D1, commit: C1 } : { digest: D2, commit: C2 }) } });
  const r = await runCycle(d);
  assert.equal(r.status, 'stale');
  assert.match(r.detail, /:latest moved/);
  assert.deepEqual(log, ['ensure']);
});

test('instance that never answers /health is stale and the suite is not run', async () => {
  const { d, log } = deps({ health: async () => undefined });
  const r = await runCycle(d);
  assert.equal(r.status, 'stale');
  assert.match(r.detail, /timed out/);
  assert.deepEqual(log, ['ensure']);
});

test('instance create/restart failing three times is infra-error, not red', async () => {
  let n = 0;
  const { d, log } = deps({ instance: { ensureFresh: async () => { n++; throw new Error('boom'); } } });
  const r = await runCycle(d);
  assert.equal(n, 3);
  assert.equal(r.status, 'infra-error');
  assert.match(r.detail, /boom/);
  assert.deepEqual(log, []);
});

test('create/restart succeeding on the second attempt still runs the suite', async () => {
  let n = 0; const log = [];
  const { d } = deps({
    instance: { ensureFresh: async () => { if (++n < 2) throw new Error('flaky'); return { baseUrl: 'http://i', token: 't' }; } },
    runSuite: async () => { log.push('suite'); return { suiteVersion: 'v1', status: 'green', build: {}, cases: [] }; },
  });
  assert.equal((await runCycle(d)).status, 'green');
  assert.deepEqual(log, ['suite']);
});

test('a suite crash is infra-error', async () => {
  const { d } = deps({ runSuite: async () => { throw new Error('socket hang up'); } });
  const r = await runCycle(d);
  assert.equal(r.status, 'infra-error');
  assert.match(r.detail, /socket hang up/);
});

test('credentials in error messages are redacted from the stored record', async () => {
  const { d, store } = deps({
    secrets: ['hunter2-secret-value'],
    instance: { ensureFresh: async () => { throw new Error('401 for Bearer abc.def.ghi with key hunter2-secret-value token=ghp_ABCDEFGHIJKLMNOPQRSTUV'); } },
  });
  assert.equal((await runCycle(d)).status, 'infra-error');
  const stored = JSON.stringify(store.get(C1));
  for (const leak of ['abc.def.ghi', 'hunter2-secret-value', 'ghp_ABCDEFGHIJKLMNOPQRSTUV']) assert.equal(stored.includes(leak), false, leak);
});
