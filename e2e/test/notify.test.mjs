import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAlert, formatAlert, slackNotifier } from '../lib/notify.mjs';

const rec = (status, extra = {}) => ({ commit: 'abcdef0123456789', status, cases: [], ...extra });

test('shouldAlert: red and a first infra-error alert; green, stale and a repeated infra-error do not', () => {
  assert.equal(shouldAlert(rec('red')), true);
  assert.equal(shouldAlert(rec('infra-error')), true);
  assert.equal(shouldAlert(rec('infra-error'), { status: 'infra-error' }), false);
  assert.equal(shouldAlert(rec('infra-error'), { status: 'stale' }), true);
  assert.equal(shouldAlert(rec('green')), false);
  assert.equal(shouldAlert(rec('stale')), false);
});

test('formatAlert names the commit and the failed cases, not the skipped ones', () => {
  const text = formatAlert(rec('red', { cases: [{ id: 'health', status: 'pass' }, { id: 'package', status: 'fail', detail: 'timed out' }, { id: 'search', status: 'skipped' }] }));
  assert.match(text, /abcdef0/);
  assert.match(text, /`package` fail: timed out/);
  assert.doesNotMatch(text, /search/);
});

test('slackNotifier posts JSON to the webhook, masks secrets, and is a no-op without a webhook', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push([url, JSON.parse(init.body)]); return { ok: true, status: 200 }; };
  await slackNotifier({ webhookUrl: undefined, fetchImpl })(rec('red'));
  assert.equal(calls.length, 0);
  await slackNotifier({ webhookUrl: 'https://hooks.example/x', secrets: ['sekret-value'], fetchImpl })(rec('infra-error', { detail: 'bad sekret-value' }));
  assert.equal(calls.length, 1);
  assert.doesNotMatch(calls[0][1].text, /sekret-value/);
});

test('slackNotifier throws on a non-2xx answer', async () => {
  await assert.rejects(slackNotifier({ webhookUrl: 'https://h', fetchImpl: async () => ({ ok: false, status: 500 }) })(rec('red')), /HTTP 500/);
});
