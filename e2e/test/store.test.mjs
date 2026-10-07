import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileStore } from '../runner/store-file.mjs';

const D = `sha256:${'a'.repeat(64)}`;

test('round trip by digest', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'e2e-store-'));
  const s = fileStore(dir);
  assert.equal(await s.get(D), undefined);
  await s.put(D, { status: 'green' });
  assert.deepEqual(await s.get(D), { status: 'green' });
});

test('malformed or hostile digests are refused and write nothing outside by-digest/', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'e2e-store-'));
  const s = fileStore(dir);
  for (const bad of ['../../etc/x', 'sha256:../../x', 'sha256:short', '', undefined, `${D}/../x`, 'sha256:' + 'A'.repeat(64)]) {
    await assert.rejects(s.put(bad, {}), /malformed image digest/, String(bad));
    await assert.rejects(s.get(bad), /malformed image digest/, String(bad));
  }
  assert.deepEqual(await readdir(dir), []);
});
