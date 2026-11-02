// #1248, second pass: the two platform failures that used to be recorded `red` (final, blocks promotion until a
// human deletes the record) and must be `infra-error` (not final, retried next cycle):
//   - a job read that is never answered mid-encode — a dropped connection, a TLS failure, or the AbortError from the
//     per-request budget in lib/http.mjs. A transport error is no evidence about the encode.
//   - a job the product itself reports as interrupted by infrastructure. openapi.json v1.5.0 GET /api/v1/jobs/{id}:
//     `interrupted` is "True when the job was interrupted by an infrastructure/topology event (not a media failure)
//     and is being auto-retried. The job stays `running` — it is NOT reported as `failed`"; `interruptionReason`
//     enum `interrupted_by_scaledown` is "RECOVERABLE and typically AUTO-RETRIED by the service".
// Purely additive: suite.test.mjs keeps its own cases, including the #1167 red regression guard.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startMock } from './mock-server.mjs';
import { createClient, runSuite } from '../suite/run.mjs';
import { redactValue } from '../lib/redact.mjs';

const fastCfg = { runId: 't2', sourceUrl: 'http://fixture/clip.mp4', pollMs: 1, timeouts: { ingestMs: 500, readyMs: 500, metadataMs: 500, transcodeMs: 500, packageMs: 500, searchMs: 50 } };
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

test('the job read throws mid-encode (dropped connection) -> infra-error, not red', async () => {
  // The first read answers `running` at 50 %, every read after it is dropped: a transport error with the job
  // mid-encode, which before this change fell into the timeout branch and was classified `running` -> red.
  const { result } = await run(
    { transcodeJobStatus: 'running', transcodeProgress: 50, transcodeJobReadsOk: 1, transcodeJobDropReads: 99 },
    { timeouts: { ...fastCfg.timeouts, transcodeMs: 10_000 } },
  );
  const c = byId(result).transcode;
  assert.equal(result.status, 'infra-error');
  assert.equal(c.status, 'fail');
  assert.equal(c.failureClass, 'infra');
  assert.match(c.detail, /went unanswered 3 times in a row/);
  assert.match(c.detail, /fetch failed|socket hang up|other side closed|ECONNRESET/);
  assert.equal(c.observed.request, 'job-status');
  assert.equal(c.observed.readErrors, 3);
  assert.equal(c.observed.jobStatus, 'running', 'the verdict still says what the last answered read saw');
  assert.equal(c.observed.phase, 'running');
  assert.ok(c.observed.polls >= 1);
  assert.equal(byId(result).package.status, 'skipped');
  assert.equal(result.cases.length, 12);
});

test('fewer than three unanswered reads in a row are absorbed: the wait survives and the job still completes green', async () => {
  // One blip must not end a 900 s wait. Reads 1 and 2 are dropped, read 3 answers the finished job.
  const { result } = await run(
    { transcodeJobDropReads: 2 },
    { timeouts: { ...fastCfg.timeouts, transcodeMs: 10_000 } },
  );
  assert.equal(result.status, 'green', JSON.stringify(result.cases.filter((c) => c.status !== 'pass')));
  assert.equal(byId(result).transcode.status, 'pass');
});

test('interrupted/interruptionReason set -> infra-error, not red, and the phase says interrupted', async () => {
  const { result } = await run({ transcodeJobStatus: 'running', transcodeProgress: 20, transcodeJobInterrupted: true });
  const c = byId(result).transcode;
  assert.equal(result.status, 'infra-error');
  assert.equal(c.status, 'fail');
  assert.equal(c.failureClass, 'infra');
  assert.match(c.detail, /timed out/);
  assert.match(c.detail, /interrupted \(interrupted_by_scaledown\)/);
  assert.equal(c.observed.interrupted, true);
  assert.equal(c.observed.interruptionReason, 'interrupted_by_scaledown');
  assert.equal(c.observed.phase, 'interrupted');
  assert.equal(c.observed.jobStatus, 'running', 'the contract says an interrupted job stays running');
  assert.equal(byId(result).package.status, 'skipped');
});

test('an interrupted job that never left the queue is infra-error too', async () => {
  const { result } = await run({ transcodeJobStatus: 'queued', transcodeJobInterrupted: true });
  const c = byId(result).transcode;
  assert.equal(result.status, 'infra-error');
  assert.equal(c.failureClass, 'infra');
  assert.equal(c.observed.phase, 'interrupted');
});

test('a running job with no interruption reported still goes red: the infra class needs the contract field', async () => {
  const { result } = await run({ transcodeJobStatus: 'running', transcodeProgress: 20 });
  const c = byId(result).transcode;
  assert.equal(result.status, 'red');
  assert.equal(c.failureClass, undefined);
  assert.equal(c.observed.phase, 'running');
  assert.equal(c.observed.interrupted, undefined);
});

test('observed is masked like detail: a credential echoed in a gateway body does not reach the result', async () => {
  const secret = 'tok-abcdef0123456789';
  const { result } = await run(
    { transcodeGateway: 502, transcodeGatewayError: `upstream rejected Authorization: Bearer ${secret}` },
    { secrets: [secret] },
  );
  const c = byId(result).transcode;
  assert.equal(c.failureClass, 'infra');
  assert.equal(JSON.stringify(result).includes(secret), false, 'the token is nowhere in the stored result');
  assert.match(c.observed.error, /\[redacted\]/);
  assert.equal(c.observed.httpStatus, 502, 'numbers survive the masking pass');
});

test('redactValue masks strings anywhere in a structure and leaves other types alone', () => {
  const out = redactValue({ httpStatus: 502, error: 'Bearer abc123def456', nested: ['secret-value-here', 7, null], ok: true }, ['secret-value-here']);
  assert.equal(out.httpStatus, 502);
  assert.equal(out.error, '[redacted]');
  assert.deepEqual(out.nested, ['[redacted]', 7, null]);
  assert.equal(out.ok, true);
});
