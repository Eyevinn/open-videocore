// Package-step Job records (issue #976).
//
// The `package` step produces the artifact a caller actually consumes (the
// HLS/DASH manifests) and was the only pipeline step with no observable object:
// `GET /api/v1/jobs` listed `ingest-url` and `transcode` jobs for a packaged
// asset and nothing for the packaging itself, `steps[].jobId` stayed empty, and
// a packaging failure existed only as `packagingError` on the asset.
//
// CONTRACTS VERIFIED (no shapes guessed):
//   - `JOB_TYPES` / `Job` / `CreateJobInput` / `UpdateJobInput` /
//     `ALLOWED_JOB_TRANSITIONS` — src/data/job-repo.ts. `package` is a member of
//     JOB_TYPES; `packagingId` + `outputPrefix` are the package-job counterparts
//     of the transcode job's `encoreJobId` (the precedent this mirrors:
//     `submitTranscode` creates `{ type: 'transcode', assetId }` then patches
//     `{ encoreJobId, status }`, and `completeTranscode` settles
//     `{ status: 'done', progress: 100 }` / `{ status: 'failed', error }` —
//     src/pipeline/transcode.ts).
//   - `GET /api/v1/jobs` response `{ items: Job[], total }` and the per-job
//     schema (`type: z.enum(JOB_TYPES)`) — src/routes/jobs.ts jobSchema.
//   - `StepExecution.jobId` ("internal job repo ID") — src/data/pipeline-repo.ts.
//   - `PackagingTrigger.triggerPackaging(assetId, encoreJobUrl)` and
//     `PackagingJob = { jobId, url }` — src/pipeline/packaging.ts.
//   - Packager callbacks: success `{ url, jobId, outputPath? }`, failure
//     `{ message }` only (no jobId — correlated by running `package` step) —
//     src/routes/internal.ts.
//   - `reconcileStalledPackages` (#336 sweep) — src/pipeline/stalled-package-reconciler.ts.
//   - `packagingId(assetId)` / `outputPrefix(assetId)` — src/pipeline/packaging.ts.
//   - Encore pool key layout used to resolve the packager's input URL:
//     `keys.jobInstance` / `keys.pool` / `keys.jobUuid` —
//     src/encore-scaler/types.ts; `encodeEncoreJobId` — src/data/job-repo.ts.

import { describe, it, expect, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

vi.mock('../src/auth/workspace.js', async () => {
  const actual = await vi.importActual<typeof import('../src/auth/workspace.js')>(
    '../src/auth/workspace.js'
  );
  return {
    ...actual,
    resolveWorkspaceId: vi.fn(async (token?: string) => {
      const map: Record<string, string> = { 'token-a': 'workspace-a' };
      const ws = token ? map[token] : undefined;
      if (!ws) throw new actual.AuthError('invalid token');
      return ws;
    })
  };
});

import { registerAuth } from '../src/auth/middleware.js';
import { assetsRouter } from '../src/routes/assets.js';
import { internalRouter } from '../src/routes/internal.js';
import { jobsRouter } from '../src/routes/jobs.js';
import { pipelinesRouter } from '../src/routes/pipelines.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import {
  InMemoryJobRepository,
  JOB_TYPES,
  encodeEncoreJobId,
  type Job
} from '../src/data/job-repo.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import {
  PackagingService,
  outputPrefix,
  packagingId,
  type PackageQueue,
  type PackagingJob
} from '../src/pipeline/packaging.js';
import { reconcileStalledPackages } from '../src/pipeline/stalled-package-reconciler.js';
import type { EncoreClient } from '../src/pipeline/encore-client.js';
import { keys } from '../src/encore-scaler/types.js';

const A = { authorization: 'Bearer token-a' };

// Encore pool coordinates the package-only execute path resolves the packager's
// input URL from (same shape as test/package-only-pipeline.test.ts).
const CTX = 'ctx';
const ENCORE_JOB_ID = encodeEncoreJobId(CTX, 'job-local-1');
const INSTANCE_ID = 'encore-instance-1';
const INSTANCE_URL = 'https://encore-1.osc.example';
const ENCORE_UUID = '6f1c0f6e-0000-4000-8000-000000000001';

function makeRedis(): import('ioredis').Redis {
  const hashes: Record<string, Record<string, string>> = {
    [keys.jobInstance(CTX)]: { [ENCORE_JOB_ID]: INSTANCE_ID },
    [keys.pool(CTX)]: {
      [INSTANCE_ID]: JSON.stringify({ id: INSTANCE_ID, url: INSTANCE_URL, activeJobs: 0 })
    }
  };
  const strings: Record<string, string> = { [keys.jobUuid(ENCORE_JOB_ID)]: ENCORE_UUID };
  return {
    hget: async (key: string, field: string) => hashes[key]?.[field] ?? null,
    get: async (key: string) => strings[key] ?? null,
    sadd: async () => 1,
    pexpire: async () => 1,
    srem: async () => 1
  } as unknown as import('ioredis').Redis;
}

function fakeQueue(opts: { fail?: boolean } = {}): {
  queue: PackageQueue;
  enqueued: PackagingJob[];
} {
  const enqueued: PackagingJob[] = [];
  return {
    enqueued,
    queue: {
      enqueue: vi.fn(async (job: PackagingJob) => {
        if (opts.fail) throw new Error('valkey unreachable');
        enqueued.push(job);
      })
    }
  };
}

type Harness = {
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  jobs: InMemoryJobRepository;
  pipelines: InMemoryPipelineRepository;
  packaging: PackagingService;
  enqueued: PackagingJob[];
};

async function buildApp(opts: { queueFails?: boolean } = {}): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);

  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const pipelines = new InMemoryPipelineRepository();
  const { queue, enqueued } = fakeQueue({ fail: opts.queueFails });
  const packaging = new PackagingService({
    assets,
    queue,
    jobs,
    pipeline: pipelines,
    publicBaseUrl: 'https://cdn.example/packaged'
  });
  const encore = {
    submit: vi.fn(async () => ({ encoreInternalId: 'encore-internal-1' })),
    getJobStatus: vi.fn(),
    cancel: vi.fn()
  } as unknown as EncoreClient;

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    jobRepository: jobs,
    pipelineRepository: pipelines,
    encore,
    sourceBucket: 'src-bucket',
    outputBucket: 'out-bucket',
    packaging,
    packagingRedis: makeRedis()
  });
  await app.register(jobsRouter, {
    prefix: '/api/v1/jobs',
    repository: jobs,
    pipelineRepository: pipelines
  });
  await app.register(internalRouter, {
    prefix: '/api/v1/internal',
    packaging,
    repository: assets,
    jobRepository: jobs,
    pipelineRepository: pipelines
  });
  await app.register(pipelinesRouter, {
    prefix: '/api/v1/pipelines',
    pipelineRepository: pipelines,
    jobRepository: jobs,
    assetRepository: assets
  });
  await app.ready();
  return { app, assets, jobs, pipelines, packaging, enqueued };
}

// An asset with a stored source object and transcoded renditions, plus the
// completed-transcode execution history the package-only pipeline reads to
// resolve the packager's input (issue #739).
async function seedPackageableAsset(h: Harness): Promise<string> {
  const asset = await h.assets.create({ name: 'my-video', objectKey: 'ingest/my-video' });
  await h.assets.update(asset.id, {
    renditions: [
      { id: 'r1', label: '1080p', width: 1920, height: 1080, objectKey: 'transcode/r1.mp4' }
    ]
  });
  const prior = await h.pipelines.create({
    assetId: asset.id,
    pipelineName: 'abr-vod',
    steps: ['transcode', 'package']
  });
  await h.pipelines.update(prior.id, {
    status: 'failed',
    steps: [
      { name: 'transcode', status: 'done', encoreJobId: ENCORE_JOB_ID, jobId: 'job-prior' },
      { name: 'package', status: 'failed', error: 'packager never signalled completion' }
    ]
  });
  return asset.id;
}

function runPackagePipeline(app: FastifyInstance, assetId: string) {
  return app.inject({
    method: 'POST',
    url: `/api/v1/assets/${assetId}/execute`,
    headers: A,
    payload: { pipeline: 'package' }
  });
}

async function listJobs(app: FastifyInstance): Promise<Job[]> {
  const res = await app.inject({ method: 'GET', url: '/api/v1/jobs', headers: A });
  expect(res.statusCode).toBe(200);
  return res.json().items as Job[];
}

describe('package step Job record (issue #976)', () => {
  it('`package` is a legal job type on the API contract', () => {
    expect(JOB_TYPES).toContain('package');
  });

  describe('a pipeline run with a `package` step', () => {
    it('produces a job of type `package` in GET /api/v1/jobs', async () => {
      const h = await buildApp();
      const assetId = await seedPackageableAsset(h);

      const res = await runPackagePipeline(h.app, assetId);
      expect(res.statusCode).toBe(202);

      const items = await listJobs(h.app);
      const pkg = items.filter((j) => j.type === 'package');
      expect(pkg).toHaveLength(1);
      expect(pkg[0].assetId).toBe(assetId);
      expect(pkg[0].status).toBe('running');
      // Carries the packaging correlation id + the deterministic output prefix,
      // exactly as a transcode job carries its encoreJobId.
      expect(pkg[0].packagingId).toBe(packagingId(assetId));
      expect(pkg[0].outputPrefix).toBe(outputPrefix(assetId));
      // First enqueue reads as attempt 1, so a re-enqueue is distinguishable
      // from a slow first run.
      expect(pkg[0].attempts).toBe(1);
      // The packaging job really was handed to the packager.
      expect(h.enqueued).toHaveLength(1);
      expect(h.enqueued[0].jobId).toBe(assetId);
    });

    it("populates the execution's `package` step jobId, and it resolves to that job", async () => {
      const h = await buildApp();
      const assetId = await seedPackageableAsset(h);

      const res = await runPackagePipeline(h.app, assetId);
      const executionId = res.json().executionId ?? res.json().id;

      const execution = (await h.pipelines.listByAsset(assetId)).find(
        (e) => e.status === 'running'
      );
      expect(execution).toBeDefined();
      const step = execution!.steps.find((s) => s.name === 'package');
      expect(step?.status).toBe('running');
      expect(step?.jobId).toBeTruthy();

      const jobRes = await h.app.inject({
        method: 'GET',
        url: `/api/v1/jobs/${step!.jobId}`,
        headers: A
      });
      expect(jobRes.statusCode).toBe(200);
      expect(jobRes.json().type).toBe('package');
      expect(jobRes.json().assetId).toBe(assetId);
      // The execution id is echoed by the route (sanity: the run was created).
      expect(executionId ?? execution!.id).toBeTruthy();
    });

    it('re-enqueueing bumps the attempt count instead of creating a second job', async () => {
      const h = await buildApp();
      const assetId = await seedPackageableAsset(h);

      await h.packaging.triggerPackaging(assetId, `${INSTANCE_URL}/encoreJobs/${ENCORE_UUID}`);
      await h.packaging.triggerPackaging(assetId, `${INSTANCE_URL}/encoreJobs/${ENCORE_UUID}`);

      const pkg = (await listJobs(h.app)).filter((j) => j.type === 'package');
      expect(pkg).toHaveLength(1);
      expect(pkg[0].attempts).toBe(2);
    });

    it('settles the job `done` on the packager success callback', async () => {
      const h = await buildApp();
      const assetId = await seedPackageableAsset(h);
      await runPackagePipeline(h.app, assetId);

      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/internal/packagerCallback/success',
        payload: { url: `${INSTANCE_URL}/encoreJobs/${ENCORE_UUID}`, jobId: assetId }
      });
      expect(res.statusCode).toBe(200);

      const pkg = (await listJobs(h.app)).find((j) => j.type === 'package');
      expect(pkg?.status).toBe('done');
      expect(pkg?.progress).toBe(100);
      expect(pkg?.error).toBeUndefined();
    });
  });

  describe('a packaging failure is visible in the Jobs tab with its reason', () => {
    it('records the packager failure callback reason on the package job', async () => {
      const h = await buildApp();
      const assetId = await seedPackageableAsset(h);
      await runPackagePipeline(h.app, assetId);

      // The packager's failure callback carries { message } only.
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/internal/packagerCallback/failure',
        payload: { message: 'shaka packager exited with code 1' }
      });
      expect(res.statusCode).toBe(200);

      const pkg = (await listJobs(h.app)).find((j) => j.type === 'package');
      expect(pkg?.status).toBe('failed');
      expect(pkg?.error).toContain('shaka packager exited with code 1');
      // Readable WITHOUT opening the asset record — that is the point of #976.
      expect(pkg?.error).toBe('packager failure: shaka packager exited with code 1');
    });

    it('records the reason on PackagingService.handleFailure', async () => {
      const h = await buildApp();
      const assetId = await seedPackageableAsset(h);
      await h.packaging.triggerPackaging(assetId, `${INSTANCE_URL}/encoreJobs/${ENCORE_UUID}`);

      await h.packaging.handleFailure(assetId, 'packager could not read the Encore job');

      const pkg = (await listJobs(h.app)).find((j) => j.type === 'package');
      expect(pkg?.status).toBe('failed');
      expect(pkg?.error).toBe('packager could not read the Encore job');
    });

    it('fails the job with the reason when the enqueue itself fails', async () => {
      const h = await buildApp({ queueFails: true });
      const assetId = await seedPackageableAsset(h);

      // triggerPackaging still never throws.
      await expect(
        h.packaging.triggerPackaging(assetId, `${INSTANCE_URL}/encoreJobs/${ENCORE_UUID}`)
      ).resolves.toBeTruthy();

      const pkg = (await listJobs(h.app)).find((j) => j.type === 'package');
      expect(pkg?.status).toBe('failed');
      expect(pkg?.error).toContain('failed to enqueue packaging job');
      expect(pkg?.error).toContain('valkey unreachable');
      // The asset annotation is unchanged (belt and braces, not a replacement).
      expect((await h.assets.get(assetId))?.packagingError).toContain('valkey unreachable');
    });
  });

  describe("#336's stalled-package sweep", () => {
    it('leaves a failed package job explaining why the run was swept', async () => {
      const h = await buildApp();
      const assetId = await seedPackageableAsset(h);
      await runPackagePipeline(h.app, assetId);

      const execution = (await h.pipelines.listByAsset(assetId)).find(
        (e) => e.status === 'running'
      )!;
      // Age the running `package` step past the bound.
      await h.pipelines.update(execution.id, {
        steps: execution.steps.map((s) =>
          s.name === 'package'
            ? { ...s, startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() }
            : s
        )
      });

      const result = await reconcileStalledPackages({
        pipeline: h.pipelines,
        jobs: h.jobs,
        packagerPresent: async () => false,
        stallTimeoutMs: 15 * 60 * 1000
      });
      expect(result.failed).toBe(1);

      const pkg = (await listJobs(h.app)).find((j) => j.type === 'package');
      expect(pkg?.status).toBe('failed');
      // The SAME diagnostic the sweep wrote onto the step.
      const step = (await h.pipelines.get(execution.id))!.steps.find((s) => s.name === 'package');
      expect(pkg?.error).toBe(step?.error);
      expect(pkg?.error).toContain('packager never signalled completion');
      expect(pkg?.error).toContain('present=false');
    });
  });

  describe('historical executions without a package job (no regression)', () => {
    it('still render in GET /api/v1/pipelines with the package step intact', async () => {
      const h = await buildApp();
      const asset = await h.assets.create({ name: 'legacy', objectKey: 'ingest/legacy' });
      const legacy = await h.pipelines.create({
        assetId: asset.id,
        pipelineName: 'abr-vod',
        steps: ['transcode', 'package']
      });
      // Pre-#976 shape: the `package` step carries no jobId at all.
      await h.pipelines.update(legacy.id, {
        status: 'done',
        steps: [
          { name: 'transcode', status: 'done', jobId: 'job-legacy' },
          { name: 'package', status: 'done', completedAt: new Date().toISOString() }
        ]
      });

      const res = await h.app.inject({ method: 'GET', url: '/api/v1/pipelines', headers: A });
      expect(res.statusCode).toBe(200);
      const item = res.json().items.find((e: { id: string }) => e.id === legacy.id);
      expect(item).toBeDefined();
      const step = item.steps.find((s: { name: string }) => s.name === 'package');
      expect(step.status).toBe('done');
      expect(step.jobId).toBeUndefined();
      // And no package job was invented for it.
      expect((await listJobs(h.app)).filter((j) => j.type === 'package')).toHaveLength(0);
    });

    it('the packager failure callback and the sweep still settle a jobless historical run', async () => {
      const h = await buildApp();
      const asset = await h.assets.create({ name: 'legacy-running' });
      const legacy = await h.pipelines.create({
        assetId: asset.id,
        pipelineName: 'abr-vod',
        steps: ['package']
      });
      await h.pipelines.update(legacy.id, {
        steps: [
          {
            name: 'package',
            status: 'running',
            startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString()
          }
        ]
      });

      // Sweep: fails the step without a job record and without throwing.
      const swept = await reconcileStalledPackages({
        pipeline: h.pipelines,
        jobs: h.jobs,
        stallTimeoutMs: 15 * 60 * 1000
      });
      expect(swept.failed).toBe(1);
      const after = await h.pipelines.get(legacy.id);
      expect(after?.steps[0].status).toBe('failed');
      expect(after?.status).toBe('failed');
      expect(await listJobs(h.app)).toHaveLength(0);

      // Failure callback against no running package step: still a plain 200 ack.
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/internal/packagerCallback/failure',
        payload: { message: 'late failure' }
      });
      expect(res.statusCode).toBe(200);
    });
  });
});
