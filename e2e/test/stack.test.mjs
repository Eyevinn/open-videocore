import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureStack } from '../runner/stack.mjs';

// A stateful fake of the provisioning endpoints. `stack` holds the stack record (undefined = absent).
function fakeClient({ stack, createStatus = 202, createdBecomes = 'ready', provisioningPolls = 1, operation = 'done', opPolls = 1, opError } = {}) {
  const calls = []; let s = stack; let statusPolls = 0; let opCount = 0;
  return { calls, request: async (method, path, opts) => {
    calls.push(`${method} ${path}`);
    if (method === 'GET' && path === '/api/v1/provision/e2e') {
      if (!s) return { status: 404, body: {}, text: '' };
      if (s.status === 'provisioning' && ++statusPolls > provisioningPolls) s = { status: createdBecomes };
      return { status: 200, body: s, text: '' };
    }
    if (method === 'POST' && path === '/api/v1/provision/') {
      assert.deepEqual(opts.json, { name: 'e2e' });
      if (createStatus !== 202) return { status: createStatus, body: {}, text: 'nope' };
      s = { status: 'provisioning' };
      return { status: 202, body: { operationId: 'op1', name: 'e2e', status: 'pending' }, text: '' };
    }
    if (method === 'GET' && path === '/api/v1/provision/operations/op1') {
      const st = ++opCount < opPolls ? 'running' : operation;
      return { status: 200, body: { id: 'op1', type: 'provision', name: 'e2e', status: st, startedAt: 1, error: opError }, text: '' };
    }
    throw new Error(`unexpected ${method} ${path}`);
  } };
}
const fast = { sleep: async () => {}, pollMs: 1, timeoutMs: 10_000 };

test('an existing ready stack is left alone', async () => {
  const c = fakeClient({ stack: { status: 'ready' } });
  assert.deepEqual(await ensureStack(c, fast), { name: 'e2e', provisioned: false });
  assert.ok(!c.calls.some((x) => x.startsWith('POST')));
});

test('a missing stack is provisioned: POST, wait for the operation, wait for ready', async () => {
  const c = fakeClient({ stack: undefined, opPolls: 3 });
  assert.deepEqual(await ensureStack(c, fast), { name: 'e2e', provisioned: true });
  assert.equal(c.calls.filter((x) => x === 'POST /api/v1/provision/').length, 1);
  assert.ok(c.calls.filter((x) => x.includes('operations')).length >= 3);
});

test('a stack that is already provisioning is waited for, not created again', async () => {
  const c = fakeClient({ stack: { status: 'provisioning' }, provisioningPolls: 2 });
  assert.deepEqual(await ensureStack(c, fast), { name: 'e2e', provisioned: false });
  assert.ok(!c.calls.some((x) => x.startsWith('POST')));
});

test('degraded only because the packager is lazily provisioned counts as ready', async () => {
  const c = fakeClient({ stack: { status: 'degraded', reason: { code: 'packaging_capability_missing', capability: 'packaging', message: 'x' } } });
  assert.equal((await ensureStack(c, fast)).provisioned, false);
});

test('degraded for a core capability, or failed, is an error with the reason', async () => {
  await assert.rejects(ensureStack(fakeClient({ stack: { status: 'degraded', reason: { code: 'core_capability_missing', capability: 'storage', message: 'minio down' } } }), fast), /degraded: core_capability_missing minio down/);
  await assert.rejects(ensureStack(fakeClient({ stack: { status: 'failed', reason: { code: 'stack_provisioning_failed', message: 'quota' } } }), fast), /failed: stack_provisioning_failed quota/);
});

test('a failed provisioning operation carries its error', async () => {
  await assert.rejects(ensureStack(fakeClient({ stack: undefined, operation: 'failed', opError: 'could not create minio' }), fast), /provisioning stack e2e failed: could not create minio/);
});

test('501 and an unexpected create status are errors', async () => {
  await assert.rejects(ensureStack(fakeClient({ stack: undefined, createStatus: 501 }), fast), /does not support provisioning/);
  await assert.rejects(ensureStack(fakeClient({ stack: undefined, createStatus: 400 }), fast), /returned HTTP 400/);
});

test('an operation that never finishes times out instead of hanging', async () => {
  let t = 0;
  const c = fakeClient({ stack: undefined, opPolls: 1e9 });
  await assert.rejects(ensureStack(c, { sleep: async () => { t += 60_000; }, now: () => t, pollMs: 1, timeoutMs: 300_000 }), /timed out/);
});
