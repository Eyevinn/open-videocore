import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldAlert, formatAlert, slackNotifier } from '../lib/notify.mjs';

const rec = (status, extra = {}) => ({ commit: 'abcdef0123456789', status, cases: [], ...extra });

test('shouldAlert: green, red and a first infra-error post; stale and a repeated infra-error do not', () => {
  assert.equal(shouldAlert(rec('red')), true);
  assert.equal(shouldAlert(rec('infra-error')), true);
  assert.equal(shouldAlert(rec('infra-error'), { status: 'infra-error' }), false);
  assert.equal(shouldAlert(rec('infra-error'), { status: 'stale' }), true);
  assert.equal(shouldAlert(rec('green')), true);
  assert.equal(shouldAlert(rec('stale')), false);
});

test('formatAlert: green is a one-line pass with the case count', () => {
  const text = formatAlert(rec('green', { cases: [{ id: 'a', status: 'pass' }, { id: 'b', status: 'pass' }] }));
  assert.match(text, /green.*abcdef0.*2\/2/);
  assert.doesNotMatch(text, /rotating_light/);
});

test('formatAlert names the commit and the failed cases, not the skipped ones', () => {
  const text = formatAlert(rec('red', { cases: [{ id: 'health', status: 'pass' }, { id: 'package', status: 'fail', detail: 'timed out' }, { id: 'search', status: 'skipped' }] }));
  assert.match(text, /abcdef0/);
  assert.match(text, /`package` fail: timed out/);
  assert.doesNotMatch(text, /search/);
});

test('slackNotifier posts to the channel with the bot token, masks secrets, and is a no-op without a token', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push([url, init.headers.authorization, JSON.parse(init.body)]); return { ok: true, status: 200, json: async () => ({ ok: true }) }; };
  await slackNotifier({ token: undefined, fetchImpl })(rec('red'));
  assert.equal(calls.length, 0);
  await slackNotifier({ token: 'xoxb-t', secrets: ['sekret-value'], fetchImpl })(rec('infra-error', { detail: 'bad sekret-value' }));
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'https://slack.com/api/chat.postMessage');
  assert.equal(calls[0][2].channel, 'C0C4GLN8GAC');
  assert.doesNotMatch(calls[0][2].text, /sekret-value/);
});

test('formatAlert for infra-error says it is infrastructure and that the commit is retried, never "red" (#1248)', () => {
  const text = formatAlert(rec('infra-error', {
    suiteAttempts: 2,
    retriedAfter: 'transcode: transcode request answered HTTP 504',
    cases: [{ id: 'health', status: 'pass' }, { id: 'transcode', status: 'fail', failureClass: 'infra', detail: 'transcode request answered HTTP 504' }, { id: 'package', status: 'skipped' }],
  }));
  assert.match(text, /infrastructure problem/);
  assert.match(text, /retried on the next cycle/);
  assert.doesNotMatch(text, /\bred\b/i);
  assert.match(text, /`transcode` fail \(infrastructure\): transcode request answered HTTP 504/);
  assert.match(text, /ran 2 times/);
  assert.doesNotMatch(text, /package/, 'skipped cases are not listed');
});

test('formatAlert for red still reads as a red verdict', () => {
  const text = formatAlert(rec('red', { cases: [{ id: 'transcode', status: 'fail', detail: 'transcode job ended failed' }] }));
  assert.match(text, /rotating_light/);
  assert.match(text, /\*red\*/);
  assert.doesNotMatch(text, /infrastructure/);
});

test('slackNotifier throws on an HTTP error or a Slack error answer', async () => {
  await assert.rejects(slackNotifier({ token: 't', fetchImpl: async () => ({ ok: false, status: 500 }) })(rec('red')), /HTTP 500/);
  await assert.rejects(slackNotifier({ token: 't', fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error: 'not_in_channel' }) }) })(rec('red')), /not_in_channel/);
});
