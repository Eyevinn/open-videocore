// Cancel handler tests (issue #126).
//
// Exercises DELETE /api/v1/jobs/:id for a running transcode job:
//   1. status becomes `cancelled` synchronously and the running
//      PipelineExecution's transcode step is marked failed (pipeline lock
//      released, so a new transcode can be submitted immediately).
//   2. a second DELETE is idempotent — still 200, still `cancelled`, and does
//      not re-request Encore cancellation or throw.
//   3. a late completeTranscode callback on the cancelled job is a clean no-op
//      ({ applied: false }) and does NOT throw InvalidJobTransitionError.
//
// Uses in-memory repos and a fake EncoreClient decorated onto request.connections
// (the same shape the production preHandler injects — see src/main.ts).

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { jobsRouter } from '../src/routes/jobs.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { completeTranscode } from '../src/pipeline/transcode.js';

// A fake EncoreClient recording cancel() calls. Only cancel() is exercised here.
function makeFakeEncore() {
  const cancelled: string[] = [];
  return {
    cancelled,
    client: {
      submit: vi.fn(),
      getJobStatus: vi.fn(),
      cancel: vi.fn(async (id: string) => {
        cancelled.push(id);
      })
    }
  };
}

type Harness = {
  app: FastifyInstance;
  jobs: InMemoryJobRepository;
  pipelines: InMemoryPipelineRepository;
  assets: InMemoryAssetRepository;
  encore: ReturnType<typeof makeFakeEncore>;
};

async function buildApp(): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const jobs = new InMemoryJobRepository();
  const pipelines = new InMemoryPipelineRepository();
  const assets = new InMemoryAssetRepository();
  const encore = makeFakeEncore();

  // Mirror the production preHandler (src/main.ts): every request carries a
  // `connections` object exposing the resolved Encore client.
  app.decorateRequest('connections', null);
  app.addHook('preHandler', async (request) => {
    (request as unknown as { connections: unknown }).connections = {
      encore: encore.client
    };
  });

  await app.register(jobsRouter, {
    prefix: '/api/v1/jobs',
    repository: jobs,
    pipelineRepository: pipelines
  });
  await app.ready();
  return { app, jobs, pipelines, assets, encore };
}

// Create a running transcode job + a running PipelineExecution whose transcode
// step is `running` (so findRunningByAssetAndStep matches it).
async function seedRunningTranscode(h: Harness, assetId: string) {
  const job = await h.jobs.create({ type: 'transcode', assetId });
  await h.jobs.update(job.id, {
    status: 'running',
    encoreJobId: `ctx__${job.id}`,
    encoreInternalJobId: 'encore-internal-1'
  });

  const execution = await h.pipelines.create({
    assetId,
    pipelineName: 'abr-vod',
    steps: ['transcode', 'package']
  });
  const steps = execution.steps.map((s) =>
    s.name === 'transcode' ? { ...s, status: 'running' as const, jobId: job.id } : s
  );
  await h.pipelines.update(execution.id, { steps, status: 'running' });

  return { jobId: job.id, executionId: execution.id };
}

describe('cancel handler (issue #126)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildApp();
  });

  it('cancels a running transcode job synchronously and releases the pipeline lock', async () => {
    const { jobId, executionId } = await seedRunningTranscode(h, 'asset-1');

    const res = await h.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${jobId}` });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');

    // Encore cancellation requested (best-effort) with the internal job id.
    expect(h.encore.cancelled).toEqual(['encore-internal-1']);

    // Job persisted as cancelled.
    const job = await h.jobs.get(jobId);
    expect(job?.status).toBe('cancelled');

    // Pipeline lock released: the running transcode step is now failed and the
    // execution is no longer RUNNING, so a fresh transcode can be submitted.
    const execution = await h.pipelines.get(executionId);
    expect(execution?.status).toBe('failed');
    const transcodeStep = execution?.steps.find((s) => s.name === 'transcode');
    expect(transcodeStep?.status).toBe('failed');
    expect(transcodeStep?.error).toBe('cancelled by operator');
    // No running execution remains for this asset+step.
    expect(await h.pipelines.findRunningByAssetAndStep('asset-1', 'transcode')).toBeUndefined();
  });

  it('is idempotent: a second DELETE returns 200 cancelled and does not re-cancel', async () => {
    const { jobId } = await seedRunningTranscode(h, 'asset-2');

    const first = await h.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${jobId}` });
    expect(first.statusCode).toBe(200);
    expect(first.json().status).toBe('cancelled');

    const second = await h.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${jobId}` });
    expect(second.statusCode).toBe(200);
    expect(second.json().status).toBe('cancelled');

    // Already-terminal short-circuit: Encore was only asked to cancel once.
    expect(h.encore.cancelled).toEqual(['encore-internal-1']);
  });

  it('a late completeTranscode callback on a cancelled job is a clean no-op', async () => {
    const { jobId } = await seedRunningTranscode(h, 'asset-3');
    await h.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${jobId}` });

    // Simulate a late Encore completion arriving after cancel. It must not throw
    // (cancelled is terminal) and must report that nothing was applied.
    const result = await completeTranscode(
      {
        jobId,
        sourceAssetId: 'asset-3',
        success: true,
        renditions: []
      },
      { jobs: h.jobs, assets: h.assets }
    );

    expect(result).toEqual({ applied: false, renditionCount: 0 });

    // Job is still cancelled — the late callback did not corrupt state.
    const job = await h.jobs.get(jobId);
    expect(job?.status).toBe('cancelled');
  });
});
