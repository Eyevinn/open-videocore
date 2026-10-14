import test from 'node:test';
import assert from 'node:assert/strict';
import { s3Store } from '../runner/store-s3.mjs';

const D = 'd'.repeat(40);
class Cmd { constructor(input) { this.input = input; } }
const sdk = { PutObjectCommand: class extends Cmd {}, GetObjectCommand: class extends Cmd {} };

function fakeClient() {
  const objects = new Map(); const sent = [];
  return { sent, objects, send: async (cmd) => {
    sent.push([cmd.constructor === sdk.PutObjectCommand ? 'put' : 'get', cmd.input]);
    if (cmd instanceof sdk.PutObjectCommand) { objects.set(cmd.input.Key, cmd.input.Body); return {}; }
    if (!objects.has(cmd.input.Key)) { const e = new Error('nope'); e.name = 'NoSuchKey'; throw e; }
    return { Body: { transformToString: async () => objects.get(cmd.input.Key) } };
  } };
}

test('put writes by-commit and latest; get reads it back', async () => {
  const client = fakeClient();
  const s = await s3Store({ bucket: 'b', client, sdk });
  assert.equal(await s.get(D), undefined);
  await s.put(D, { status: 'green', commit: D });
  assert.deepEqual([...client.objects.keys()].sort(), [`results/by-commit/${D}.json`, 'results/latest.json']);
  assert.deepEqual(await s.get(D), { status: 'green', commit: D });
  assert.ok(client.sent.every(([, i]) => i.Bucket === 'b'));
  assert.equal(client.sent.find(([k]) => k === 'put')[1].ContentType, 'application/json');
});

test('a 404 without a name is also "missing"; other errors propagate', async () => {
  const s404 = await s3Store({ bucket: 'b', sdk, client: { send: async () => { const e = new Error('x'); e.$metadata = { httpStatusCode: 404 }; throw e; } } });
  assert.equal(await s404.get(D), undefined);
  const s500 = await s3Store({ bucket: 'b', sdk, client: { send: async () => { const e = new Error('boom'); e.$metadata = { httpStatusCode: 500 }; throw e; } } });
  await assert.rejects(s500.get(D), /boom/);
});

test('hostile commit values never reach the bucket key', async () => {
  const client = fakeClient();
  const s = await s3Store({ bucket: 'b', client, sdk });
  for (const bad of ['../x', 'sha256:../../x', '']) { await assert.rejects(s.get(bad), /malformed/); await assert.rejects(s.put(bad, {}), /malformed/); }
  assert.equal(client.sent.length, 0);
});

test('the real SDK exports what the store uses', async () => {
  const m = await import('@aws-sdk/client-s3');
  for (const k of ['S3Client', 'GetObjectCommand', 'PutObjectCommand']) assert.equal(typeof m[k], 'function', k);
});
