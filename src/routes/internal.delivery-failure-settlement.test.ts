// Issue #1279, settlement ORDER. Companion to internal.delivery-failure.test.ts,
// which stubs `packaging` and therefore cannot observe the bug this file exists
// for: the real PackagingService settles the `package` Job inside handleSuccess,
// and if that happens BEFORE the destination copy is attempted the Job is
// already `done` — a terminal status — when the delivery failure is discovered,
// so `failed` can never be written and GET /api/v1/jobs/{id} keeps answering
// `done` for an output that never arrived.
//
// Every test here therefore drives the REAL PackagingService (with `jobs` +
// `pipeline` wired, which is what makes completePackageJob run) through the
// packager success route.
//
// Contracts exercised here:
//   - PackagingService(deps: PackagingDeps { assets, queue, jobs, pipeline })
//     and `handleSuccess(payload, options?: PackagerSuccessOptions)`
//     (src/pipeline/packaging.ts)
//   - completePackageJob / failPackageJob early-return on an inactive job
//     (`if (!isActiveJobStatus(job.status)) return job.id;`,
//     src/pipeline/package-job.ts) and JOB_STATUSES / ALLOWED_JOB_TRANSITIONS
//     (src/data/job-repo.ts): `done` is terminal.
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
import { PackagingService, type PackageQueue } from '../pipeline/packaging.js';
import type { RelocationClient } from '../pipeline/output-relocation.js';

const noopQueue: PackageQueue = { enqueue: async () => {} };

function listingClient(opts: { keys: string[]; copy: () => Promise<unknown> }): RelocationClient {
  return {
    listObjectsV2: () => Readable.from(opts.keys.map((name) => ({ name }))),
    copyObject: () => opts.copy()
  };
}

// Same fixture shape as internal.delivery-failure.test.ts, except `packaging` is
// a real PackagingService sharing the repositories the route reads back.
// `destinationBucket: null` builds an execution with NO destination override.
async function buildFixture(
  client: RelocationClient,
  opts?: { destinationBucket?: string | null }
) {
  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const pipelines = new InMemoryPipelineRepository();

  const asset = await assets.create({ name: 'source.mp4' });
  const packageJob = await jobs.create({ assetId: asset.id, type: 'package' });
  await jobs.update(packageJob.id, { status: 'running' });

  const destinationBucket =
    opts?.destinationBucket === null
      ? undefined
      : (opts?.destinationBucket ?? 'customer-delivery/vod/');
  const execution = await pipelines.create({
    assetId: asset.id,
    pipelineName: 'abr-vod',
    steps: ['transcode', 'package'],
    ...(destinationBucket ? { destinationBucket } : {})
  });
  await pipelines.update(execution.id, {
    steps: execution.steps.map((s) =>
      s.name === 'transcode'
        ? { ...s, status: 'done' as const }
        : { ...s, status: 'running' as const, jobId: packageJob.id }
    )
  });

  const packaging = new PackagingService({
    assets,
    queue: noopQueue,
    jobs,
    pipeline: pipelines,
    publicBaseUrl: 'https://cdn.example/packaged'
  });

  const dispatched: Array<{ type: string }> = [];
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(internalRouter, {
    prefix: '/api/v1/internal',
    packaging,
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

  return { app, assets, jobs, pipelines, asset, packageJob, execution, dispatched, packaging };
}

async function postSuccess(fx: Awaited<ReturnType<typeof buildFixture>>) {
  return fx.app.inject({
    method: 'POST',
    url: '/api/v1/internal/packagerCallback/success',
    payload: { url: 'https://transcoder.example/encoreJobs/u1', jobId: fx.asset.id }
  });
}

describe('packager success settlement order against the real PackagingService', () => {
  it('leaves the package Job failed, not done, when delivery to the destination fails', async () => {
    const fx = await buildFixture(
      listingClient({
        keys: ['packaged/asset/index.m3u8'],
        copy: () => Promise.reject(new Error('AccessDenied: destination bucket write denied'))
      })
    );

    const res = await postSuccess(fx);
    expect(res.statusCode).toBe(200);

    // The assertion the stubbed companion test cannot make: with the real
    // service in the path, a Job settled `done` before the copy was attempted
    // would be terminal and stay `done` here.
    const job = await fx.jobs.get(fx.packageJob.id);
    expect(job?.status).toBe('failed');
    expect(job?.status).not.toBe('done');
    expect(job?.error).toContain('output delivery to destination failed');
    expect(job?.error).toContain('AccessDenied');

    const execution = await fx.pipelines.get(fx.execution.id);
    expect(execution?.status).toBe('failed');
    expect(execution?.steps.find((s) => s.name === 'package')?.status).toBe('failed');
    expect(execution?.resolvedOutputLocation).toBeUndefined();

    expect(fx.dispatched.map((e) => e.type)).toContain('package.failed');
    expect(fx.dispatched.map((e) => e.type)).not.toContain('package.complete');
    await fx.app.close();
  });

  it('still settles the package Job done when the delivery copy succeeds', async () => {
    const fx = await buildFixture(
      listingClient({ keys: ['packaged/asset/index.m3u8'], copy: () => Promise.resolve({}) })
    );

    const res = await postSuccess(fx);
    expect(res.statusCode).toBe(200);

    // Proves the real service DOES own the terminal write on the happy path —
    // without this, the test above could pass merely because nothing settled
    // the Job at all.
    const job = await fx.jobs.get(fx.packageJob.id);
    expect(job?.status).toBe('done');
    expect(job?.progress).toBe(100);

    const execution = await fx.pipelines.get(fx.execution.id);
    expect(execution?.status).toBe('done');
    expect(execution?.resolvedOutputLocation).toEqual({
      bucket: 'customer-delivery',
      prefix: 'vod'
    });
    expect(fx.dispatched.map((e) => e.type)).toContain('package.complete');
    await fx.app.close();
  });

  it('settles the package Job done when no destination override was requested', async () => {
    // No destinationBucket means no delivery step to fail: the pre-#1279
    // behaviour must be untouched for the common case.
    const fx = await buildFixture(
      listingClient({ keys: [], copy: () => Promise.reject(new Error('never called')) }),
      { destinationBucket: null }
    );

    const res = await postSuccess(fx);
    expect(res.statusCode).toBe(200);

    const job = await fx.jobs.get(fx.packageJob.id);
    expect(job?.status).toBe('done');

    const execution = await fx.pipelines.get(fx.execution.id);
    expect(execution?.status).toBe('done');
    // The asset still records where the packager actually put the output.
    expect((await fx.assets.get(fx.asset.id))?.manifestUrls?.hls).toBeTruthy();
    expect(fx.dispatched.map((e) => e.type)).toContain('package.complete');
    await fx.app.close();
  });
});
