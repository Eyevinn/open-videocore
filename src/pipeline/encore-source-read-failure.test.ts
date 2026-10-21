// Source-read failure -> structured execution error (issue #1060).
//
// #1060's complaint: a transcode that failed because its SOURCE object could not
// be read surfaces to the caller as one opaque sentence,
//
//   dropped by Encore: ffprobe failed for input s3://<bucket>/<key>:
//   Server returned 404 Not Found
//
// so the caller has to open the transcoder job and then the bucket to discover
// the key is simply absent. These tests pin the three layers of the fix:
//
//   Layer 1 — the pure recogniser (parseSourceReadFailure /
//             buildSourceReadErrorDetail): which failure texts are source reads,
//             what is extracted, and — critically — what is NOT a source read.
//   Layer 2 — the settle path that produced #1060's symptom: the scaler's
//             reconcile-detected drop (main.ts onJobsDropped ->
//             settleFailedTranscode) must stamp the structured detail on the
//             failed `transcode` step while leaving `error` untouched.
//   Layer 3 — the wire contract: a mocked transcoder FAILED callback POSTed to
//             POST /api/v1/internal/encore-callback, then read back through
//             GET /api/v1/pipelines/:executionId, so the detail is proven to
//             survive the response schema rather than only the repository.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
// -----------------------------------------------------------
//   - Transcoder failure payload field names — `encoreCallbackSchema`
//     `{ externalId, status, message, output? }`, src/routes/internal.ts:122-127,
//     under the SMOKE-TEST-CONFIRMED field list at src/routes/internal.ts:101-112
//     ("message — error message when status=FAILED"). The scaler reads the same
//     `{ externalId?, message? }` pair off the per-instance FAILED page
//     (src/encore-scaler/scaler-loop.ts:660-664). Status strings are normalised
//     at src/pipeline/encore-client.ts:101-107 (FAILED -> 'failed').
//   - The verbatim #1058/#1060 failure text — the in-repo `FFPROBE_404` fixture,
//     src/encore-scaler/profiles-index-auth-retry.test.ts:99-101.
//   - The JDK HTTP failure format string + `parseHttpFailureDetail` —
//     src/encore-scaler/retry-policy.ts:191-220.
//   - `settleFailedTranscode(deps, job, error, reason?)` + SettleReason —
//     src/pipeline/failed-transcode-reconciler.ts.
//   - `StepExecution` (`error`, new `errorDetail`) — src/data/pipeline-repo.ts;
//     the response schemas it must pass — src/routes/pipelines.ts
//     stepExecutionSchema and src/routes/assets.ts stepExecutionSchema.
//   - In-memory repositories + `encodeEncoreJobId` — src/data/*-repo.ts.

import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import {
  buildSourceReadErrorDetail,
  parseSourceReadFailure,
  redactUrlsInText,
  MAX_STORAGE_ERROR_CHARS
} from './encore-source-read-failure.js';
import { settleFailedTranscode } from './failed-transcode-reconciler.js';
import { classifyEncoreFailure } from '../encore-scaler/retry-policy.js';
import { InMemoryJobRepository, encodeEncoreJobId } from '../data/job-repo.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryPipelineRepository } from '../data/pipeline-repo.js';
import { internalRouter } from '../routes/internal.js';
import { pipelinesRouter } from '../routes/pipelines.js';

// ---------------------------------------------------------------------------
// Fixtures: transcoder failure texts
// ---------------------------------------------------------------------------

// #1060's own text, verbatim from the issue and byte-identical to the in-repo
// FFPROBE_404 fixture (src/encore-scaler/profiles-index-auth-retry.test.ts:99-101).
const FFPROBE_404 =
  'ffprobe failed for input s3://ovc-media/src/missing.mov: Server returned 404 Not Found';

// The same failure as it reaches the settle path on the drop route: the reason is
// the FAILED job document's own `message`, prefixed by main.ts (#704).
const DROPPED = (reason: string) => `dropped by Encore: ${reason}`;

// A 403 on the source, in the JDK HttpURLConnection format string
// (retry-policy.ts:191-198).
const SOURCE_403 =
  'java.io.IOException: Server returned HTTP response code: 403 for URL: ' +
  'https://minio.example.osaas.io/ovc-media/src/clip.mov while reading input ' +
  's3://ovc-media/src/clip.mov';

// A connection-class read: no HTTP status is ever received.
const SOURCE_CONN_REFUSED =
  'ffprobe failed for input s3://ovc-media/src/clip.mov: ' +
  'com.amazonaws.SdkClientException: Unable to execute HTTP request: Connection refused';

describe('#1060 layer 1 — recognising a source-read failure', () => {
  it("extracts code, status, bucket and key from #1060's own ffprobe 404 text", () => {
    const detail = buildSourceReadErrorDetail({
      failureText: FFPROBE_404,
      encoreJobId: 'ws1__job-a',
      assetId: 'asset-1'
    });

    expect(detail).toEqual({
      code: 'source_read_failed',
      message:
        'the transcode source could not be read: storage answered 404 (the object does not exist) ' +
        'for bucket "ovc-media", key "src/missing.mov"',
      storageError: FFPROBE_404,
      httpStatus: 404,
      source: {
        url: 's3://ovc-media/src/missing.mov',
        bucket: 'ovc-media',
        key: 'src/missing.mov'
      },
      encoreJobId: 'ws1__job-a',
      assetId: 'asset-1'
    });
  });

  it('sees through the drop path\'s "dropped by Encore: " prefix', () => {
    // The two observation paths differ only by this prefix (main.ts #704), so
    // the recogniser must not depend on which one carried the text.
    expect(parseSourceReadFailure(DROPPED(FFPROBE_404))).toMatchObject({
      httpStatus: 404,
      bucket: 'ovc-media',
      key: 'src/missing.mov'
    });
  });

  it('recognises a 403 on the source read and reports it as access denied', () => {
    const detail = buildSourceReadErrorDetail({ failureText: SOURCE_403 });
    expect(detail?.code).toBe('source_read_failed');
    expect(detail?.httpStatus).toBe(403);
    expect(detail?.message).toContain('403 (access denied)');
  });

  it('recognises a connection-class read failure and carries NO http status', () => {
    const detail = buildSourceReadErrorDetail({ failureText: SOURCE_CONN_REFUSED });
    expect(detail?.code).toBe('source_read_failed');
    expect(detail?.httpStatus).toBeUndefined();
    expect(detail?.message).toContain('the connection to storage failed');
    expect(detail?.source).toEqual({
      url: 's3://ovc-media/src/clip.mov',
      bucket: 'ovc-media',
      key: 'src/clip.mov'
    });
  });

  // The NEGATIVE cases are the point of a narrow recogniser: anything it does not
  // recognise must surface exactly as it does today (no detail at all), so a
  // failure with a different remedy is never mislabelled "your source is missing".
  it.each([
    ['an undefined message', undefined],
    ['an empty message', '   '],
    [
      'the generic gone-from-active-set wording',
      'dropped by Encore: gone from active set with no completion'
    ],
    [
      'a profile/configuration error',
      'Job execution failed: Could not find location for profile program! Profiles: {}'
    ],
    [
      'an edge-auth 401 on the unauthenticated profiles index (#1101 owns this)',
      'java.io.IOException: Server returned HTTP response code: 401 for URL: ' +
        'https://api.example/api/v1/profiles/index.yml'
    ],
    [
      'a 404 on the profiles index (not a source read)',
      'java.io.IOException: Server returned HTTP response code: 404 for URL: ' +
        'https://api.example/api/v1/profiles/index.yml'
    ],
    [
      'a 5xx from the storage (a platform problem, not a missing key)',
      'ffprobe failed for input s3://ovc-media/src/clip.mov: Server returned 503 Service Unavailable'
    ],
    [
      'a 404 with no input URI named anywhere',
      'java.io.IOException: Server returned HTTP response code: 404 for URL: https://sidecar.example/x'
    ],
    [
      'a demux error on an intact source (#293 — not a read verdict)',
      'Error during demuxing: I/O error'
    ]
  ])('does NOT produce a structured error for %s', (_label, text) => {
    expect(parseSourceReadFailure(text as string | undefined)).toBeUndefined();
    expect(buildSourceReadErrorDetail({ failureText: text as string | undefined })).toBeUndefined();
  });

  it('omits correlation ids that the settle path could not resolve', () => {
    const detail = buildSourceReadErrorDetail({ failureText: FFPROBE_404 });
    expect(detail).toBeDefined();
    expect('encoreJobId' in detail!).toBe(false);
    expect('assetId' in detail!).toBe(false);
  });

  it('does not change retry classification (an ffprobe 404 stays deterministic)', () => {
    // Guard rail: #1060 changes how a settled failure is DESCRIBED, never
    // whether it is retried. retry-policy.ts:320-323 documents that an ffprobe
    // 404 must stay deterministic — the object genuinely is not there.
    expect(classifyEncoreFailure(FFPROBE_404)).toBe('deterministic');
    expect(classifyEncoreFailure(DROPPED(FFPROBE_404))).toBe('deterministic');
  });
});

describe('#1060 layer 1 — credential redaction', () => {
  it('strips userinfo and the presigned query string from the surfaced source URL', () => {
    const detail = buildSourceReadErrorDetail({
      failureText:
        'ffprobe failed for input ' +
        'https://AKIAEXAMPLE:supersecret@minio.example.osaas.io/ovc-media/src/clip.mov' +
        '?X-Amz-Signature=deadbeefcafe&X-Amz-Credential=AKIAEXAMPLE: Server returned 403 Forbidden'
    });

    expect(detail?.code).toBe('source_read_failed');
    // Neither the password, the access key id, nor the live signature may reach
    // an API response.
    for (const secret of ['supersecret', 'deadbeefcafe', 'AKIAEXAMPLE']) {
      expect(detail?.source?.url).not.toContain(secret);
      expect(detail?.storageError).not.toContain(secret);
    }
    expect(detail?.source?.url).toContain('minio.example.osaas.io/ovc-media/src/clip.mov');
    expect(detail?.httpStatus).toBe(403);
  });

  it('redactUrlsInText leaves a credential-free s3:// URI untouched', () => {
    expect(redactUrlsInText('input s3://ovc-media/src/clip.mov failed')).toBe(
      'input s3://ovc-media/src/clip.mov failed'
    );
  });

  it('bounds the underlying storage error it echoes back', () => {
    const long = `${FFPROBE_404} ${'x'.repeat(MAX_STORAGE_ERROR_CHARS * 2)}`;
    const detail = buildSourceReadErrorDetail({ failureText: long });
    expect(detail?.storageError?.length).toBe(MAX_STORAGE_ERROR_CHARS + 1); // + the ellipsis
  });
});

// ---------------------------------------------------------------------------
// Layer 2: the settle path that produced #1060's symptom
// ---------------------------------------------------------------------------

// A `running` transcode job over a `processing` source asset, plus a running
// PipelineExecution whose `transcode` step is running — the exact shape the
// scaler's drop detection observes (mirrors stuckTranscode in
// failed-transcode-reconciler.test.ts).
async function runningTranscode(externalId: string) {
  const jobs = new InMemoryJobRepository();
  const assets = new InMemoryAssetRepository();
  const pipeline = new InMemoryPipelineRepository();

  const asset = await assets.create({ name: 'clip.mov', objectKey: 'src/missing.mov' });
  await assets.update(asset.id, { status: 'processing' });

  const job = await jobs.create({ type: 'transcode', assetId: asset.id, profile: 'program' });
  await jobs.update(job.id, { encoreJobId: externalId, status: 'queued' });
  await jobs.update(job.id, { status: 'running', encoreInternalJobId: 'encore-internal-1' });

  const execution = await pipeline.create({
    assetId: asset.id,
    pipelineName: 'transcode',
    steps: ['transcode']
  });
  const steps = execution.steps.map((s) => ({
    ...s,
    status: 'running' as const,
    encoreJobId: externalId
  }));
  await pipeline.update(execution.id, { steps });

  return { jobs, assets, pipeline, jobId: job.id, assetId: asset.id, executionId: execution.id };
}

describe('#1060 layer 2 — the drop settle stamps the structured error on the step', () => {
  it('surfaces the code, redacted location and ids on a reconcile-detected drop', async () => {
    const externalId = encodeEncoreJobId('ws1', 'job-1060');
    const { jobs, assets, pipeline, jobId, assetId, executionId } =
      await runningTranscode(externalId);

    // Exactly what main.ts onJobsDropped does with a recovered Encore reason
    // (#704): the failure text is `dropped by Encore: ${message}` and the settle
    // reason is the conditional 'gone-from-active-set' (#709).
    await settleFailedTranscode(
      { jobs, assets, pipeline },
      (await jobs.get(jobId))!,
      DROPPED(FFPROBE_404),
      'gone-from-active-set'
    );

    const execution = await pipeline.get(executionId);
    expect(execution?.status).toBe('failed');
    const step = execution?.steps.find((s) => s.name === 'transcode');
    expect(step?.status).toBe('failed');

    // The free text is UNCHANGED — nothing that reads `error` today breaks.
    expect(step?.error).toBe(DROPPED(FFPROBE_404));

    // ...and the structured answer #1060 asks for is now alongside it.
    expect(step?.errorDetail).toEqual({
      code: 'source_read_failed',
      message:
        'the transcode source could not be read: storage answered 404 (the object does not exist) ' +
        'for bucket "ovc-media", key "src/missing.mov"',
      storageError: DROPPED(FFPROBE_404),
      httpStatus: 404,
      source: {
        url: 's3://ovc-media/src/missing.mov',
        bucket: 'ovc-media',
        key: 'src/missing.mov'
      },
      encoreJobId: externalId,
      assetId
    });
  });

  it('leaves the step exactly as before for a failure it does not recognise', async () => {
    const externalId = encodeEncoreJobId('ws1', 'job-generic');
    const { jobs, assets, pipeline, jobId, executionId } = await runningTranscode(externalId);

    await settleFailedTranscode(
      { jobs, assets, pipeline },
      (await jobs.get(jobId))!,
      'dropped by Encore: gone from active set with no completion',
      'gone-from-active-set'
    );

    const step = (await pipeline.get(executionId))?.steps.find((s) => s.name === 'transcode');
    expect(step?.status).toBe('failed');
    expect(step?.error).toBe('dropped by Encore: gone from active set with no completion');
    expect(step?.errorDetail).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Layer 3: the wire contract, from a mocked FAILED callback to the execution GET
// ---------------------------------------------------------------------------

describe('#1060 layer 3 — GET on the execution shows the structured error', () => {
  it('maps a mocked transcoder FAILED payload onto the execution status response', async () => {
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);

    const externalId = encodeEncoreJobId('ws1', 'job-wire');
    const { jobs, assets, pipeline, assetId, executionId } = await runningTranscode(externalId);

    await app.register(internalRouter, {
      prefix: '/api/v1/internal',
      jobRepository: jobs,
      repository: assets,
      pipelineRepository: pipeline
    });
    await app.register(pipelinesRouter, {
      prefix: '/api/v1/pipelines',
      pipelineRepository: pipeline,
      jobRepository: jobs,
      assetRepository: assets
    });
    await app.ready();

    // The mocked transcoder failure payload. Field names per encoreCallbackSchema
    // (src/routes/internal.ts:122-127): externalId / status / message.
    const callback = await app.inject({
      method: 'POST',
      url: '/api/v1/internal/encore-callback',
      payload: { externalId, status: 'FAILED', message: FFPROBE_404 }
    });
    expect(callback.statusCode).toBe(200);
    expect(callback.json()).toMatchObject({ applied: true });

    // Read the execution back over HTTP, so the detail is proven to pass the
    // response schema (stepExecutionSchema) rather than merely be persisted.
    const read = await app.inject({ method: 'GET', url: `/api/v1/pipelines/${executionId}` });
    expect(read.statusCode).toBe(200);
    const body = read.json() as {
      assetId: string;
      status: string;
      steps: Array<{
        name: string;
        status: string;
        error?: string;
        encoreJobId?: string;
        errorDetail?: Record<string, unknown>;
      }>;
    };

    expect(body.status).toBe('failed');
    // #1060 also asks for the transcoder job id and the asset id on the response.
    expect(body.assetId).toBe(assetId);
    const step = body.steps.find((s) => s.name === 'transcode');
    expect(step?.encoreJobId).toBe(externalId);
    expect(step?.error).toBe(FFPROBE_404);
    expect(step?.errorDetail).toEqual({
      code: 'source_read_failed',
      message:
        'the transcode source could not be read: storage answered 404 (the object does not exist) ' +
        'for bucket "ovc-media", key "src/missing.mov"',
      storageError: FFPROBE_404,
      httpStatus: 404,
      source: {
        url: 's3://ovc-media/src/missing.mov',
        bucket: 'ovc-media',
        key: 'src/missing.mov'
      },
      encoreJobId: externalId,
      assetId
    });

    await app.close();
  });
});
