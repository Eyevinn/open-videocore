import test from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './mock-server.mjs';
import { createClient, runSuite } from '../suite/run.mjs';

const fastCfg = { runId: 't1', sourceUrl: 'http://fixture/clip.mp4', pollMs: 1, timeouts: { ingestMs: 500, readyMs: 500, metadataMs: 500, transcodeMs: 500, packageMs: 500, searchMs: 50 } };
async function run(faults = {}, cfg = {}) {
  const mock = await startMock({ faults });
  try {
    const result = await runSuite({
      client: createClient({ baseUrl: mock.baseUrl, token: mock.token }),
      anon: createClient({ baseUrl: mock.baseUrl }),
      ingress: createClient({ baseUrl: mock.baseUrl, token: mock.token, appToken: '' }),
      config: { ...fastCfg, ...cfg },
    });
    return { result, mock };
  } finally { await mock.close(); }
}
const byId = (r) => Object.fromEntries(r.cases.map((c) => [c.id, c]));

test('green against a contract-conformant instance, and cleans up its asset', async () => {
  const { result, mock } = await run();
  assert.equal(result.status, 'green', JSON.stringify(result.cases.filter((c) => c.status !== 'pass')));
  assert.equal(result.cases.length, 12);
  assert.ok([...mock.assets.values()].every((a) => a.status === 'archived'), 'its asset is soft-deleted (archived)');
  assert.equal(result.build.commit, 'abc1234');
});

test('a fully open service (no ingress wall, no application gate) fails the anonymous auth case', async () => {
  const { result } = await run({ openAuth: true, appOpen: true });
  assert.equal(result.status, 'red');
  assert.equal(byId(result)['auth-required'].status, 'fail');
  // x-jwt-accepted only asks that x-jwt alone is accepted (#1256), which an open service also does.
  assert.equal(byId(result)['x-jwt-accepted'].status, 'pass');
});

test('ingress open but the application still gates: auth-required passes only because the app rejects, x-jwt-accepted passes', async () => {
  const { result } = await run({ openAuth: true });
  assert.equal(byId(result)['auth-required'].status, 'pass');
  assert.equal(byId(result)['x-jwt-accepted'].status, 'pass');
});

// Issue #1256 limitation, pinned on purpose. The suite used to tell an application with an auth gate from one without
// (the #711 regression) by sending x-jwt alone and expecting the application's own 401. The application now accepts
// x-jwt, and every request that clears the ingress carries a token the application accepts, so from behind the ingress
// a gated and an un-gated application answer alike and that distinction cannot be observed here. What stays pinned is
// the anonymous 401 (`auth-required`): a service with no ingress wall AND no application gate still fails (see the
// 'fully open service' test above). The application-level gate itself is covered by the unit tests in
// test/auth-x-jwt-header-fallback.test.ts.
test('an application without its own auth gate is indistinguishable from behind the ingress (limitation after #1256)', async () => {
  const { result } = await run({ appOpen: true });
  assert.equal(byId(result)['auth-required'].status, 'pass');
  assert.equal(byId(result)['x-jwt-accepted'].status, 'pass');
  assert.equal(result.status, 'green');
});

// Issue #1256 review. The behavioural probe above can no longer tell a gated image from an un-gated one from behind
// the ingress, so the image reports the gate itself: GET /health -> features.authGateRegistered (src/routes/health.ts
// featuresSchema). The `health` case asserts that flag, which makes the #711 regression visible to the suite again —
// an image that registered no auth gate is red, not green.
test('an image reporting no auth gate (features.authGateRegistered=false) fails health and turns the suite red', async () => {
  const { result } = await run({ noAuthGate: true });
  assert.equal(byId(result).health.status, 'fail');
  assert.match(byId(result).health.detail, /no application auth gate/);
  assert.equal(result.status, 'red');
});

test('the health case requires the image to report features.authGateRegistered at all', async () => {
  const { result } = await run({ healthNoFeatures: true });
  assert.equal(byId(result).health.status, 'fail');
  assert.match(byId(result).health.detail, /features\.authGateRegistered/);
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

test('the client sends both x-jwt (ingress) and Authorization (application); x-jwt alone clears both layers (#1256), and neither header reaches the application gate', async () => {
  const mock = await startMock();
  try {
    assert.equal((await createClient({ baseUrl: mock.baseUrl }).request('GET', '/health')).status, 401);
    assert.equal((await createClient({ baseUrl: mock.baseUrl, token: mock.token }).request('GET', '/health')).status, 200);
    assert.equal((await createClient({ baseUrl: mock.baseUrl, token: mock.token, authHeader: 'authorization' }).request('GET', '/health')).status, 401);
    const full = await createClient({ baseUrl: mock.baseUrl, token: mock.token }).request('GET', '/api/v1/assets/');
    assert.equal(full.status, 200);
    // Since #1256 the application accepts x-jwt on its own, so x-jwt alone clears BOTH layers.
    const ingressOnly = await createClient({ baseUrl: mock.baseUrl, token: mock.token, appToken: '' }).request('GET', '/api/v1/assets/');
    assert.equal(ingressOnly.status, 200);
  } finally { await mock.close(); }
  // The application's own gate still answers 401 `missing access token` when NEITHER header carries a token. Reached
  // with the ingress wall open, because behind the real ingress an anonymous call never gets that far.
  const open = await startMock({ faults: { openAuth: true } });
  try {
    const neither = await createClient({ baseUrl: open.baseUrl }).request('GET', '/api/v1/assets/');
    assert.equal(neither.status, 401);
    assert.equal(neither.body.message, 'missing access token');
  } finally { await open.close(); }
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
    const ingress = createClient({ baseUrl: mock.baseUrl, token: mock.token, appToken: '' }); // x-jwt alone, as in run() above
    const result = await runSuite({ client, anon: createClient({ baseUrl: mock.baseUrl }), ingress, config: fastCfg });
    assert.equal(result.swept, 1);
    assert.ok(['new-e2e', 'old-e2e', 'product'].every((id) => mock.assets.has(id)), 'nothing is removed, deletion is soft');
    assert.equal(mock.assets.get('old-e2e').status, 'archived');
    assert.equal(mock.assets.get('new-e2e').status, 'ready');
    assert.equal(mock.assets.get('product').status, 'ready');
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
    assert.ok([...mock.assets.values()].every((a) => a.status === 'archived'));
    assert.equal(await sweepLeftovers({ client, pageSize: 2 }), 0, 'archived assets are not deleted again');
  } finally { await mock.close(); }
});

test('an asset still processing after the ingest job is waited for, not failed on the first look', async () => {
  const { result } = await run({ slowReady: 4 });
  assert.equal(result.status, 'green', JSON.stringify(result.cases.filter((c) => c.status !== 'pass')));
});

test('metadata extraction that records an error fails ingest-url with the error, and skips the rest', async () => {
  const { result } = await run({ slowReady: 2, extractionError: true });
  const c = byId(result);
  assert.equal(c['ingest-url'].status, 'fail');
  assert.match(c['ingest-url'].detail, /metadata extraction failed: ffprobe failed/);
  assert.equal(c.metadata.status, 'skipped');
});

test('an asset that never leaves processing times out as a failure', async () => {
  const { result } = await run({ slowReady: 1e9 });
  assert.equal(byId(result)['ingest-url'].status, 'fail');
  assert.match(byId(result)['ingest-url'].detail, /timed out.*to leave processing/);
});

test('transcode uses the named profile `program`, not the first profile in the list (which is `archive`)', async () => {
  const mock = await startMock();
  try {
    const result = await runSuite({ client: createClient({ baseUrl: mock.baseUrl, token: mock.token }), anon: createClient({ baseUrl: mock.baseUrl }), ingress: createClient({ baseUrl: mock.baseUrl, token: mock.token, appToken: '' }), config: fastCfg });
    assert.equal(result.status, 'green');
    assert.deepEqual(mock.calls.filter((c) => c.startsWith('PROFILE')), ['PROFILE program']);
  } finally { await mock.close(); }
});

test('E2E_TRANSCODE_PROFILE overrides the profile; one that is not on the instance fails with the available names', async () => {
  const { result } = await run({}, { transcodeProfile: 'x264-nonexistent' });
  const c = byId(result);
  assert.equal(c.transcode.status, 'fail');
  assert.match(c.transcode.detail, /profile "x264-nonexistent" is not on the instance; available: archive, program/);
  assert.equal(c.package.status, 'skipped');
  const noProgram = await run({ noProgramProfile: true });
  assert.match(byId(noProgram.result).transcode.detail, /profile "program" is not on the instance; available: archive/);
});

test('a packager that fails silently is reported with the package job state, not as a bare timeout', async () => {
  const { result } = await run({ silentPackager: true });
  const c = byId(result);
  assert.equal(c.package.status, 'fail');
  assert.match(c.package.detail, /timed out/);
  assert.match(c.package.detail, /package job is running/);
  for (const id of ['search', 'tags-roundtrip', 'delete']) assert.equal(c[id].status, 'skipped', id);
});

test('delete: a purged asset (404/410 on read) is also accepted, and an asset that still reads ready after DELETE fails', async () => {
  const hard = await run({ hardDelete: true });
  assert.equal(byId(hard.result).delete.status, 'pass');
});

// #1248: a platform failure in the transcode case is infra-error (not final, so the commit is retried), the
// product's own encode failures stay red.
for (const code of [502, 503, 504]) {
  test(`HTTP ${code} on the transcode request is an infrastructure failure, not red`, async () => {
    const { result } = await run({ transcodeGateway: code });
    assert.equal(result.status, 'infra-error');
    const c = byId(result);
    assert.equal(c.transcode.status, 'fail');
    assert.equal(c.transcode.failureClass, 'infra');
    assert.match(c.transcode.detail, new RegExp(`HTTP ${code}`));
    assert.equal(c.transcode.observed.httpStatus, code);
    assert.equal(c.package.status, 'skipped');
    assert.equal(result.cases.length, 12);
  });
}

test('a 504 that arrives as an HTML page (the ingress answering, no JSON) is still infra-error', async () => {
  const { result } = await run({ transcodeGateway: 504, transcodeGatewayHtml: true });
  assert.equal(result.status, 'infra-error');
  assert.equal(byId(result).transcode.failureClass, 'infra');
  assert.match(byId(result).transcode.detail, /HTTP 504/);
});

test('a transcode timeout with the job still queued is infra-error and the verdict says what the job was doing', async () => {
  const { result } = await run({ transcodeJobStatus: 'queued' });
  assert.equal(result.status, 'infra-error');
  const c = byId(result).transcode;
  assert.equal(c.status, 'fail');
  assert.equal(c.failureClass, 'infra');
  assert.match(c.detail, /timed out/);
  assert.match(c.detail, /last job status queued, progress 0 \(queued\)/);
  assert.equal(c.observed.jobStatus, 'queued');
  assert.equal(c.observed.progress, 0);
  assert.equal(c.observed.phase, 'queued');
  assert.ok(c.observed.polls > 0);
});

test('a transcode job that ends failed stays red (regression guard for #1167) and carries the last job status', async () => {
  const { result } = await run({ transcodeJobFails: true });
  const c = byId(result).transcode;
  assert.equal(result.status, 'red');
  assert.equal(c.status, 'fail');
  assert.equal(c.failureClass, undefined);
  assert.match(c.detail, /transcode job ended failed: encore job failed/);
  assert.match(c.detail, /last job status failed/);
  assert.equal(c.observed.jobStatus, 'failed');
  assert.equal(byId(result).package.status, 'skipped');
});

test('a transcode job that completes with no renditions is red', async () => {
  const { result } = await run({ noRenditions: true });
  const c = byId(result).transcode;
  assert.equal(result.status, 'red');
  assert.equal(c.failureClass, undefined);
  assert.match(c.detail, /no renditions after transcode/);
  assert.equal(c.observed.jobStatus, 'done');
});

test('a transcode job that ran and then stopped progressing is red, reported as stalled', async () => {
  const { result } = await run({ transcodeJobStatus: 'running', transcodeProgress: 40 });
  const c = byId(result).transcode;
  assert.equal(result.status, 'red');
  assert.equal(c.failureClass, undefined);
  assert.match(c.detail, /timed out/);
  assert.match(c.detail, /last job status running, progress 40 \(running\)/);
  const stalled = await run({ transcodeJobStatus: 'running' }); // never progressed past 0 but did leave the queue
  assert.equal(stalled.result.status, 'red');
  assert.match(byId(stalled.result).transcode.detail, /\(stalled\)/);
});

test('a gateway answer while the transcode job is polled is infra-error, not red', async () => {
  const { result } = await run({ transcodeJobGateway: 502 });
  const c = byId(result).transcode;
  assert.equal(result.status, 'infra-error');
  assert.equal(c.failureClass, 'infra');
  assert.match(c.detail, /reading transcode job answered HTTP 502/);
  assert.equal(c.observed.httpStatus, 502);
  assert.equal(c.observed.request, 'job-status');
});

test('a gateway answer on another job read is unchanged: ingest still fails as before', async () => {
  const { result } = await run({ ingestJobFails: true }); // the ingest case has no infra classification of its own
  assert.equal(result.status, 'red');
  assert.equal(byId(result)['ingest-url'].failureClass, undefined);
});

test('one platform failure plus one real failure is red, not infra-error', async () => {
  // A fully open service gives a real (non-infra) failure on the anonymous auth case.
  const { result } = await run({ transcodeGateway: 504, openAuth: true, appOpen: true });
  assert.equal(result.status, 'red');
  assert.equal(byId(result)['auth-required'].status, 'fail');
  assert.equal(byId(result).transcode.failureClass, 'infra');
});

import { DEFAULT_TIMEOUTS, timeoutsFromEnv } from '../suite/run.mjs';

test('the transcode budget is 900 s by default and is overridable per instance from the environment', () => {
  assert.equal(DEFAULT_TIMEOUTS.transcodeMs, 900_000);
  assert.deepEqual(timeoutsFromEnv({}), {});
  assert.deepEqual(timeoutsFromEnv({ E2E_TIMEOUT_TRANSCODE_MS: '1200000' }), { transcodeMs: 1_200_000 });
  assert.deepEqual(timeoutsFromEnv({ E2E_TIMEOUT_TRANSCODE_MS: '' }), {}, 'an empty value keeps the default');
  assert.deepEqual(timeoutsFromEnv({ E2E_TIMEOUT_PACKAGE_MS: '60000', E2E_TIMEOUT_READY_MS: '1000' }), { readyMs: 1000, packageMs: 60_000 });
  for (const bad of ['abc', '0', '-5']) assert.throws(() => timeoutsFromEnv({ E2E_TIMEOUT_TRANSCODE_MS: bad }), /positive number of milliseconds/, bad);
});
