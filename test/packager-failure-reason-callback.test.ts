// POST /api/v1/internal/packagerCallback/failure accepts an optional structured
// `reason` and maps it to `errorDetail.code` (issue #1340, from #1336).
// Additive to test/packaging.test.ts, which covers the `{ message }`-only body.
//
// CONTRACTS VERIFIED (no shapes guessed):
//   - The route and its body schema: `packagerFailureSchema` =
//     `{ message, reason? }` and the handler at
//     src/routes/internal.ts (route `'/packagerCallback/failure'`, mounted under
//     the `/api/v1/internal` prefix by src/main.ts). The route answers 200 for
//     every accepted body — it is best-effort and the packager never reads the
//     response.
//   - `StepErrorDetail` / `STEP_ERROR_CODES` / `stepErrorDetailSchema` —
//     src/pipeline/step-error-detail.ts:74-82, :110-136, :138+. `errorDetail` is
//     the `stepExecutionSchema` member at src/routes/pipelines.ts:45 and
//     src/routes/assets.ts:1798, and is what a client branches on.
//   - `StepExecution.errorDetail` on the stored step —
//     src/data/pipeline-repo.ts:81.
//   - The packager side that will send `reason`: `onPackageFail(message, err)`
//     currently POSTs `{ message }` only (Eyevinn/encore-packager@main,
//     src/callbackListener.ts:88-108), hence every "reason absent" case here.
//   - The 15-minute fallback the reason short-circuits:
//     `DEFAULT_PACKAGE_STALL_TIMEOUT_MS` in
//     src/pipeline/stalled-package-reconciler.ts.

import { describe, it, expect } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { internalRouter } from '../src/routes/internal.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import { stepErrorDetailSchema } from '../src/pipeline/step-error-detail.js';
import { PACKAGE_ERROR_MESSAGES } from '../src/pipeline/package-failure-detail.js';

const FAILURE_URL = '/api/v1/internal/packagerCallback/failure';

// A message the text classifier can only place in the catch-all, so any sharper
// code in these tests must have come from `reason`.
const UNCLASSIFIABLE = 'Packaging of job abc failed: exit status 1';

async function buildApp() {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  const pipelines = new InMemoryPipelineRepository();
  await app.register(internalRouter, {
    prefix: '/api/v1/internal',
    pipelineRepository: pipelines
  });
  await app.ready();
  return { app, pipelines };
}

// An execution stalled on a RUNNING `package` step — the state the failure
// callback correlates against, since the callback carries no id of ours.
async function seedRunningPackage(pipelines: InMemoryPipelineRepository, assetId: string) {
  const exec = await pipelines.create({ assetId, steps: ['package'] });
  await pipelines.update(exec.id, {
    steps: exec.steps.map((s) => (s.name === 'package' ? { ...s, status: 'running' } : s))
  });
  return exec;
}

async function packageStepAfterFailure(payload: Record<string, unknown>) {
  const { app, pipelines } = await buildApp();
  const exec = await seedRunningPackage(pipelines, `asset-${Math.random().toString(36).slice(2)}`);
  const res = await app.inject({ method: 'POST', url: FAILURE_URL, payload });
  const after = await pipelines.get(exec.id);
  await app.close();
  return {
    res,
    execution: after,
    step: after?.steps.find((s) => s.name === 'package')
  };
}

describe('packager failure callback: structured reason (#1340)', () => {
  it('maps reason=unsupported_media to packager_unsupported_media and fails the run at once', async () => {
    const { res, execution, step } = await packageStepAfterFailure({
      message: UNCLASSIFIABLE,
      reason: 'unsupported_media'
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    // Fails fast: the run is terminal as soon as the callback is handled, with
    // no 15-minute watchdog pass needed to get there.
    expect(execution?.status).toBe('failed');
    expect(step?.status).toBe('failed');
    expect(step?.completedAt).toBeTruthy();

    // ...and carries the code the reason asserted, not the catch-all the
    // message text alone would have produced.
    expect(step?.errorDetail?.code).toBe('packager_unsupported_media');
    expect(step?.errorDetail?.message).toBe(PACKAGE_ERROR_MESSAGES.packager_unsupported_media);
    expect(stepErrorDetailSchema.safeParse(step?.errorDetail).success).toBe(true);
  });

  it('maps reason=invalid_credentials to packager_auth (the #1335 class)', async () => {
    const { res, step } = await packageStepAfterFailure({
      message: UNCLASSIFIABLE,
      reason: 'invalid_credentials'
    });
    expect(res.statusCode).toBe(200);
    expect(step?.status).toBe('failed');
    expect(step?.errorDetail?.code).toBe('packager_auth');
  });

  it('maps reason=packaging_failed to packager_failed, still letting a sharper message win', async () => {
    const plain = await packageStepAfterFailure({
      message: UNCLASSIFIABLE,
      reason: 'packaging_failed'
    });
    expect(plain.step?.errorDetail?.code).toBe('packager_failed');

    const sharper = await packageStepAfterFailure({
      message: 'Packaging Error: 8 (PARSER_FAILURE): Cannot parse media file',
      reason: 'packaging_failed'
    });
    expect(sharper.step?.errorDetail?.code).toBe('packager_unsupported_media');
  });

  it('accepts a known reason in any case, with surrounding whitespace', async () => {
    const { res, step } = await packageStepAfterFailure({
      message: UNCLASSIFIABLE,
      reason: ' Unsupported_Media '
    });
    expect(res.statusCode).toBe(200);
    expect(step?.errorDetail?.code).toBe('packager_unsupported_media');
  });

  it('acknowledges an unknown reason and classifies from the message instead', async () => {
    // Never a 4xx: the packager does not read the response, so rejecting the
    // body would only discard the failure and push the run back to the
    // 15-minute watchdog — exactly what #1340 removes.
    const { res, execution, step } = await packageStepAfterFailure({
      message: 'Packaging Error: 8 (PARSER_FAILURE): Cannot parse media file',
      reason: 'a_class_we_have_never_seen'
    });
    expect(res.statusCode).toBe(200);
    expect(execution?.status).toBe('failed');
    expect(step?.errorDetail?.code).toBe('packager_unsupported_media');
  });

  it('never copies the reason or the packager text onto the served detail', async () => {
    const { step } = await packageStepAfterFailure({
      message:
        'Packaging of job 9 failed: GET http://packager-stack-a.internal:8080/encoreJobs/ab12' +
        '?token=secret-token-value returned 401',
      reason: 'invalid_credentials'
    });
    expect(Object.keys(step?.errorDetail ?? {}).sort()).toEqual(['code', 'message']);
    expect(step?.errorDetail?.message).not.toContain('secret-token-value');
    expect(step?.errorDetail?.message).not.toContain('packager-stack-a');
    expect(step?.errorDetail?.message).not.toContain('http');
    // The raw text keeps going exactly where it already went: the step's own
    // `error` field (and the server log).
    expect(step?.error).toContain('packager failure:');
    expect(step?.error).toContain('secret-token-value');
  });
});

describe('packager failure callback with NO reason is unchanged (#1340 back-compat)', () => {
  it('fails the correlated run and classifies from the message, exactly as before', async () => {
    const { res, execution, step } = await packageStepAfterFailure({
      message: UNCLASSIFIABLE
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(execution?.status).toBe('failed');
    expect(step?.status).toBe('failed');
    expect(step?.error).toBe(`packager failure: ${UNCLASSIFIABLE}`);
    expect(step?.errorDetail).toEqual({
      code: 'packager_failed',
      message: PACKAGE_ERROR_MESSAGES.packager_failed
    });
  });

  it('keeps the message-only classification of an unparseable media and a rejected token', async () => {
    const parser = await packageStepAfterFailure({
      message: 'Packaging Error: 8 (PARSER_FAILURE): Cannot parse media file, apco is not supported'
    });
    expect(parser.step?.errorDetail?.code).toBe('packager_unsupported_media');

    const auth = await packageStepAfterFailure({
      message: 'Packaging of job 3 failed: request to the job endpoint returned 401 Unauthorized'
    });
    expect(auth.step?.errorDetail?.code).toBe('packager_auth');
  });

  it('produces the same step as an explicitly undefined reason', async () => {
    const without = await packageStepAfterFailure({ message: UNCLASSIFIABLE });
    const undefinedReason = await packageStepAfterFailure({
      message: UNCLASSIFIABLE,
      reason: undefined
    });
    expect(undefinedReason.res.statusCode).toBe(without.res.statusCode);
    expect(undefinedReason.step?.status).toBe(without.step?.status);
    expect(undefinedReason.step?.error).toBe(without.step?.error);
    expect(undefinedReason.step?.errorDetail).toEqual(without.step?.errorDetail);
  });

  it('still acknowledges when no execution is awaiting packaging', async () => {
    const { app } = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: FAILURE_URL,
      payload: { message: 'orphan failure', reason: 'unsupported_media' }
    });
    expect(res.statusCode).toBe(200);
    await app.close();
  });
});
