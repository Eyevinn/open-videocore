// errorDetail.code for a failed `package` step (issue #1338, from #1336).
//
// CONTRACTS VERIFIED (no shapes guessed):
//   - `STEP_ERROR_CODES` / `StepErrorDetail` — src/pipeline/step-error-detail.ts.
//     `code` must be a member of the tuple; `message` is required; every other
//     member is optional, so a `{ code, message }` detail is a valid one.
//   - `stepErrorDetailSchema` — same file — is the `errorDetail` member of
//     `stepExecutionSchema` (src/routes/pipelines.ts:41, src/routes/assets.ts:1798)
//     and is what `toStepErrorDetail` (src/data/couch-pipeline-repo.ts:295)
//     parses a stored detail with. A code the schema rejects would be dropped on
//     read, so each produced detail is parsed with that schema here.
//   - The 15-minute completion watchdog: `reconcileStalledPackages` /
//     `DEFAULT_PACKAGE_STALL_TIMEOUT_MS` — src/pipeline/stalled-package-reconciler.ts.
//   - The packager failure callback body is `{ message }` only
//     (`packagerFailureSchema`, src/routes/internal.ts), which is why the
//     classifier takes a single free-text argument.

import { describe, it, expect } from 'vitest';

import { InMemoryPipelineRepository } from '../data/pipeline-repo.js';
import type { StepExecution } from '../data/pipeline-repo.js';
import {
  STEP_ERROR_CODES,
  stepErrorDetailSchema
} from './step-error-detail.js';
import {
  buildPackageFailureErrorDetail,
  buildPackageTimeoutErrorDetail,
  classifyPackageFailure,
  PACKAGE_ERROR_MESSAGES
} from './package-failure-detail.js';
import {
  reconcileStalledPackages,
  DEFAULT_PACKAGE_STALL_TIMEOUT_MS
} from './stalled-package-reconciler.js';

describe('package step error codes', () => {
  it('declares the four packager codes alongside the existing source_read_failed', () => {
    expect(STEP_ERROR_CODES).toContain('source_read_failed');
    expect(STEP_ERROR_CODES).toContain('packager_timeout');
    expect(STEP_ERROR_CODES).toContain('packager_unsupported_media');
    expect(STEP_ERROR_CODES).toContain('packager_auth');
    expect(STEP_ERROR_CODES).toContain('packager_failed');
  });

  it('produces details the response schema accepts', () => {
    for (const code of [
      'packager_timeout',
      'packager_unsupported_media',
      'packager_auth',
      'packager_failed'
    ] as const) {
      const detail =
        code === 'packager_timeout'
          ? buildPackageTimeoutErrorDetail()
          : { code, message: PACKAGE_ERROR_MESSAGES[code] };
      const parsed = stepErrorDetailSchema.safeParse(detail);
      expect(parsed.success).toBe(true);
    }
  });
});

describe('classifyPackageFailure', () => {
  // packager_unsupported_media — the callback reason or the packager log says
  // the media could not be parsed (PARSER_FAILURE).
  it('maps a PARSER_FAILURE reason to packager_unsupported_media', () => {
    expect(classifyPackageFailure('shaka packager error: PARSER_FAILURE (3)')).toBe(
      'packager_unsupported_media'
    );
    expect(
      classifyPackageFailure(
        'packaging job failed\n  [0613/091201:ERROR] Error: 3 (parser_failure): could not determine container'
      )
    ).toBe('packager_unsupported_media');
    expect(classifyPackageFailure('Parser Failure while reading the input')).toBe(
      'packager_unsupported_media'
    );
  });

  // packager_auth — the credential the packager was given was rejected.
  it('maps a rejected credential to packager_auth', () => {
    expect(classifyPackageFailure('request failed with status 401')).toBe('packager_auth');
    expect(classifyPackageFailure('Unauthorized')).toBe('packager_auth');
    expect(classifyPackageFailure('invalid access token')).toBe('packager_auth');
    expect(classifyPackageFailure('the service token is expired')).toBe('packager_auth');
    expect(classifyPackageFailure('authentication failed for the job endpoint')).toBe(
      'packager_auth'
    );
  });

  // packager_failed — the fallback for everything we cannot place, including a
  // failure reported with no text at all.
  it('maps anything else to packager_failed', () => {
    expect(classifyPackageFailure('packager exited with code 1')).toBe('packager_failed');
    expect(classifyPackageFailure('connection reset while uploading the segments')).toBe(
      'packager_failed'
    );
    expect(classifyPackageFailure(undefined)).toBe('packager_failed');
    expect(classifyPackageFailure('')).toBe('packager_failed');
  });

  // 403 on this path is a storage permissions verdict on the media, not a
  // verdict on the credential: classifying it as packager_auth would send an
  // operator after a credential that is fine.
  it('does not read a storage 403 as a credential rejection', () => {
    expect(classifyPackageFailure('storage answered 403 for the input object')).toBe(
      'packager_failed'
    );
  });
});

describe('the detail carries the code and a user-safe message only', () => {
  it('never copies the packager text, a URL or a host into the detail', () => {
    const raw =
      'PARSER_FAILURE while fetching http://packager-stack-a.internal:8080/encoreJobs/' +
      'ab12?token=secret-token-value from 10.1.2.3';
    const detail = buildPackageFailureErrorDetail(raw);

    expect(detail.code).toBe('packager_unsupported_media');
    expect(Object.keys(detail).sort()).toEqual(['code', 'message']);
    expect(detail.message).not.toContain('http');
    expect(detail.message).not.toContain('://');
    expect(detail.message).not.toContain('packager-stack-a');
    expect(detail.message).not.toContain('10.1.2.3');
    expect(detail.message).not.toContain('secret-token-value');
    expect(detail.message).toBe(PACKAGE_ERROR_MESSAGES.packager_unsupported_media);
  });

  it('keeps every message free of URLs, hosts and raw packager text', () => {
    for (const message of Object.values(PACKAGE_ERROR_MESSAGES)) {
      expect(message).not.toMatch(/https?:|:\/\/|s3:|\b\d{1,3}(?:\.\d{1,3}){3}\b/);
      expect(message.length).toBeGreaterThan(0);
    }
  });
});

describe('the completion watchdog stamps packager_timeout', () => {
  // packager_timeout — the 15-minute bound expires with no packager signal.
  async function stuckPackage(startedAt: string) {
    const pipeline = new InMemoryPipelineRepository();
    const execution = await pipeline.create({
      assetId: 'asset-timeout',
      pipelineName: 'abr-vod',
      steps: ['transcode', 'package']
    });
    const steps: StepExecution[] = execution.steps.map((s) => ({ ...s }));
    steps[0] = { ...steps[0], status: 'done', completedAt: startedAt };
    steps[1] = { ...steps[1], status: 'running', startedAt };
    await pipeline.update(execution.id, { steps });
    return { pipeline, executionId: execution.id };
  }

  it('sets errorDetail.code = packager_timeout when the watchdog fires', async () => {
    const startedAt = new Date('2026-11-10T10:00:00.000Z').toISOString();
    const { pipeline, executionId } = await stuckPackage(startedAt);
    const base = Date.parse(startedAt);

    const result = await reconcileStalledPackages({
      pipeline,
      packagerPresent: async () => true,
      now: () => base + DEFAULT_PACKAGE_STALL_TIMEOUT_MS + 1
    });
    expect(result.failed).toBe(1);

    const step = (await pipeline.get(executionId))?.steps.find((s) => s.name === 'package');
    expect(step?.status).toBe('failed');
    expect(step?.errorDetail?.code).toBe('packager_timeout');
    expect(step?.errorDetail?.message).toBe(PACKAGE_ERROR_MESSAGES.packager_timeout);
    // The free text keeps the operational diagnostic; the detail does not.
    expect(step?.error).toMatch(/within \d+ minutes/i);
    expect(step?.errorDetail?.message).not.toContain('present=');
  });

  it('leaves a healthy running package step untouched', async () => {
    const startedAt = new Date('2026-11-10T10:00:00.000Z').toISOString();
    const { pipeline, executionId } = await stuckPackage(startedAt);
    const base = Date.parse(startedAt);

    await reconcileStalledPackages({
      pipeline,
      now: () => base + 1000
    });

    const step = (await pipeline.get(executionId))?.steps.find((s) => s.name === 'package');
    expect(step?.status).toBe('running');
    expect(step?.errorDetail).toBeUndefined();
  });
});
