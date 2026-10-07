import test from 'node:test';
import assert from 'node:assert/strict';
import { runCycle } from '../runner/cycle.mjs';

const HEAD = 'a'.repeat(40);
function deps(over = {}) {
  const store = new Map();
  const log = [];
  const d = {
    github: { headSha: async () => HEAD },
    registry: { latestDigest: async () => 'sha256:one' },
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
  assert.equal(store.get('sha256:one').imageDigest, 'sha256:one');
  assert.equal(store.get('sha256:one').suiteVersion, 'v1');
});

test('already tested digest is skipped without touching the instance', async () => {
  const { d, store, log } = deps();
  store.set('sha256:one', { status: 'green' });
  const r = await runCycle(d);
  assert.equal(r.action, 'skip');
  assert.deepEqual(log, []);
});

test('red suite is recorded red', async () => {
  const { d, store } = deps({ runSuite: async () => ({ suiteVersion: 'v1', status: 'red', build: {}, cases: [{ id: 'ingest-url', status: 'fail' }] }) });
  assert.equal((await runCycle(d)).status, 'red');
  assert.equal(store.get('sha256:one').status, 'red');
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
  const { d, log } = deps({ registry: { latestDigest: async () => (++calls === 1 ? 'sha256:one' : 'sha256:two') } });
  const r = await runCycle(d);
  assert.equal(r.status, 'stale');
  assert.match(r.detail, /before the suite/);
  assert.ok(!log.includes('suite'));
});

test(':latest moving during the suite is stale, with the cases kept for diagnosis', async () => {
  let calls = 0;
  const { d } = deps({ registry: { latestDigest: async () => (++calls < 3 ? 'sha256:one' : 'sha256:two') } });
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
