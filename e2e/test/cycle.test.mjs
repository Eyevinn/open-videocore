import test from 'node:test';
import assert from 'node:assert/strict';
import { runCycle } from '../runner/cycle.mjs';

const HEAD = 'a'.repeat(40);
const D1 = `sha256:${'1'.repeat(64)}`;
const D2 = `sha256:${'2'.repeat(64)}`;
function deps(over = {}) {
  const store = new Map();
  const log = [];
  const d = {
    github: { headSha: async () => HEAD },
    registry: { latestDigest: async () => D1 },
    instance: { ensureFresh: async () => { log.push('ensure'); return { baseUrl: 'http://i', token: 't' }; } },
    health: async () => ({ commit: HEAD }),
    runSuite: async () => { log.push('suite'); return { suiteVersion: 'v1', status: 'green', build: { commit: HEAD, sourceDigest: 'sd', version: '1.5.0' }, cases: [{ id: 'health', status: 'pass' }] }; },
    store: { get: async (k) => store.get(k), put: async (k, v) => { store.set(k, v); } },
    opts: { waitMs: 50, pollMs: 1, retries: 2, backoffMs: 1 },
    sleep: async () => {},
    clock: () => '2026-10-07T00:00:00Z',
    ...over,
  };
  return { d, store, log };
}

test('green: records the result keyed by digest', async () => {
  const { d, store, log } = deps();
  const r = await runCycle(d);
  assert.equal(r.status, 'green');
  assert.deepEqual(log, ['ensure', 'suite']);
  assert.equal(store.get(D1).imageDigest, D1);
  assert.equal(store.get(D1).suiteVersion, 'v1');
});

test('already tested digest (green or red) is skipped and carries its status', async () => {
  for (const status of ['green', 'red']) {
    const { d, store, log } = deps();
    store.set(D1, { status });
    const r = await runCycle(d);
    assert.equal(r.action, 'skip');
    assert.equal(r.status, status);
    assert.deepEqual(log, []);
  }
});

test('a stale or infra-error record is NOT final: the same digest is tried again', async () => {
  for (const status of ['stale', 'infra-error']) {
    const { d, store, log } = deps();
    store.set(D1, { status });
    const r = await runCycle(d);
    assert.equal(r.status, 'green', status);
    assert.deepEqual(log, ['ensure', 'suite']);
  }
});

test('credentials in error messages are redacted from the stored record', async () => {
  const { d, store } = deps({
    secrets: ['hunter2-secret-value'],
    instance: { ensureFresh: async () => { throw new Error('401 for Bearer abc.def.ghi with key hunter2-secret-value token=ghp_ABCDEFGHIJKLMNOPQRSTUV'); } },
  });
  const r = await runCycle(d);
  assert.equal(r.status, 'infra-error');
  const stored = JSON.stringify(store.get(D1));
  for (const leak of ['abc.def.ghi', 'hunter2-secret-value', 'ghp_ABCDEFGHIJKLMNOPQRSTUV']) assert.equal(stored.includes(leak), false, leak);
});

test('red suite is recorded red', async () => {
  const { d, store } = deps({ runSuite: async () => ({ suiteVersion: 'v1', status: 'red', build: {}, cases: [{ id: 'ingest-url', status: 'fail' }] }) });
  assert.equal((await runCycle(d)).status, 'red');
  assert.equal(store.get(D1).status, 'red');
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

test('instance reporting an older commit than main is stale and the suite is not run', async () => {
  const { d, log } = deps({ health: async () => ({ commit: 'b'.repeat(40) }) });
  const r = await runCycle(d);
  assert.equal(r.status, 'stale');
  assert.match(r.detail, /timed out/);
  assert.deepEqual(log, ['ensure']);
});

test(':latest moving before the suite starts is stale', async () => {
  let calls = 0;
  const { d, log } = deps({ registry: { latestDigest: async () => (++calls === 1 ? D1 : D2) } });
  const r = await runCycle(d);
  assert.equal(r.status, 'stale');
  assert.match(r.detail, /before the suite/);
  assert.ok(!log.includes('suite'));
});

test(':latest moving during the suite is stale, with the cases kept for diagnosis', async () => {
  let calls = 0;
  const { d } = deps({ registry: { latestDigest: async () => (++calls < 3 ? D1 : D2) } });
  const r = await runCycle(d);
  assert.equal(r.status, 'stale');
  assert.match(r.detail, /during the suite/);
  assert.equal(r.cases.length, 1);
});

test('a suite crash is infra-error', async () => {
  const { d } = deps({ runSuite: async () => { throw new Error('socket hang up'); } });
  const r = await runCycle(d);
  assert.equal(r.status, 'infra-error');
  assert.match(r.detail, /socket hang up/);
});
