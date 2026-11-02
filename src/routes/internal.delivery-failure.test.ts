// Issue #1279: when a job asks for its packaged output to be delivered to a
// destination (requested as `destination`, `externalBackend` or
// `destinationBucket` — all three normalize into the execution's single
// `destinationBucket` override, see resolveOutputDestination in
// src/routes/assets.ts) and the server-side copy to that destination fails, the
// packager success callback used to log the error and still settle the
// execution `done`. The output then existed only in the stack's internal
// staging bucket while the caller saw success.
//
// Contracts exercised here:
//   - PipelineExecution.status: 'running' | 'done' | 'failed'
//     and StepExecution.status / StepExecution.error (src/data/pipeline-repo.ts)
//   - JobRepository.update({ status, error }) with JOB_STATUSES including
//     'failed' (src/data/job-repo.ts)
//   - POST /api/v1/internal/packagerCallback/success body { url, jobId }
//     (src/routes/internal.ts, packagerSuccessSchema)

import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { Readable } from 'node:stream';

import { internalRouter } from './internal.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryJobRepository } from '../data/job-repo.js';
import { InMemoryPipelineRepository } from '../data/pipeline-repo.js';
import type { RelocationClient } from '../pipeline/output-relocation.js';

function listingClient(opts: { keys: string[]; copy: () => Promise<unknown> }): RelocationClient {
  return {
    listObjectsV2: () => Readable.from(opts.keys.map((name) => ({ name }))),
    copyObject: () => opts.copy()
  };
}

async function buildFixture(client: RelocationClient) {
  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const pipelines = new InMemoryPipelineRepository();

  const asset = await assets.create({ name: 'source.mp4' });
  const packageJob = await jobs.create({ assetId: asset.id, type: 'package' });
  await jobs.update(packageJob.id, { status: 'running' });

  const execution = await pipelines.create({
    assetId: asset.id,
    pipelineName: 'abr-vod',
    steps: ['transcode', 'package'],
    destinationBucket: 'customer-delivery/vod/'
  });
  await pipelines.update(execution.id, {
    steps: execution.steps.map((s) =>
      s.name === 'transcode'
        ? { ...s, status: 'done' as const }
        : { ...s, status: 'running' as const, jobId: packageJob.id }
    )
  });

  const dispatched: Array<{ type: string }> = [];
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(internalRouter, {
    prefix: '/api/v1/internal',
    packaging: { handleSuccess: async () => true } as never,
    repository: assets,
    jobRepository: jobs,
    pipelineRepository: pipelines,
    resolveRelocation: async () => ({ client, packagedBucket: 'packaged' }),
    webhookDispatcher: {
      dispatch: async (event: { type: string }) => {
        dispatched.push(event);
      }
    } as never
  });
  await app.ready();

  return { app, assets, jobs, pipelines, asset, packageJob, execution, dispatched };
}

describe('packager success with a failed delivery to the requested destination', () => {
  it('does not settle the execution done and records why delivery failed', async () => {
    const client = listingClient({
      keys: ['packaged/asset/index.m3u8'],
      copy: () => Promise.reject(new Error('AccessDenied: destination bucket write denied'))
    });
    const fx = await buildFixture(client);

    const res = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/internal/packagerCallback/success',
      payload: { url: 'https://transcoder.example/encoreJobs/u1', jobId: fx.asset.id }
    });
    expect(res.statusCode).toBe(200);

    const execution = await fx.pipelines.get(fx.execution.id);
    expect(execution?.status).toBe('failed');
    const step = execution?.steps.find((s) => s.name === 'package');
    expect(step?.status).toBe('failed');
    expect(step?.error).toContain('output delivery to destination failed');
    expect(step?.error).toContain('AccessDenied');
    // The output never reached the destination, so no resolved location is
    // recorded and the relocation stays un-recorded (a re-driven package step
    // re-attempts the copy).
    expect(execution?.resolvedOutputLocation).toBeUndefined();
    expect(execution?.relocatedPackagingIds ?? []).not.toContain(fx.asset.id);

    // The caller-visible Job is failed with the same reason, not done.
    const job = await fx.jobs.get(fx.packageJob.id);
    expect(job?.status).toBe('failed');
    expect(job?.error).toContain('output delivery to destination failed');

    expect(fx.dispatched.map((e) => e.type)).toContain('package.failed');
    expect(fx.dispatched.map((e) => e.type)).not.toContain('package.complete');
    await fx.app.close();
  });

  it('still settles done when the delivery copy succeeds', async () => {
    const client = listingClient({
      keys: ['packaged/asset/index.m3u8'],
      copy: () => Promise.resolve({})
    });
    const fx = await buildFixture(client);

    const res = await fx.app.inject({
      method: 'POST',
      url: '/api/v1/internal/packagerCallback/success',
      payload: { url: 'https://transcoder.example/encoreJobs/u1', jobId: fx.asset.id }
    });
    expect(res.statusCode).toBe(200);

    const execution = await fx.pipelines.get(fx.execution.id);
    expect(execution?.status).toBe('done');
    expect(execution?.steps.find((s) => s.name === 'package')?.status).toBe('done');
    expect(execution?.resolvedOutputLocation).toEqual({
      bucket: 'customer-delivery',
      prefix: 'vod'
    });
    expect(fx.dispatched.map((e) => e.type)).toContain('package.complete');
    await fx.app.close();
  });
});
