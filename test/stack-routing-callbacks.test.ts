// Regression coverage for issue #1058, part 2: the paths with NO request stack.
//
// The #1058 fix routes the data plane by the request's `X-Stack-Name`. The
// unauthenticated OSC callbacks carry no such header, so without a way back to
// the originating stack a job on any non-first-listed stack can never be
// settled: `findByEncoreJobId` misses on the default stack, the callback 404s,
// and the job stays `running` with its asset `processing` forever.
//
// Two different identity sources are exercised here, because the two callbacks
// carry different information:
//   - the Encore completion callback embeds the stack in the externalId we
//     issued (`encodeEncoreJobId(contextId, jobLocalId)`, src/data/job-repo.ts);
//   - the packager callbacks carry only our assetId (success) or nothing at all
//     (failure), so the router searches the provisioned stacks.
//
// As with test/stack-routing-data-plane.test.ts, only the resolver boundary is
// stubbed; the routers, the PerWorkspace* repositories and the ALS context are
// production code.

import { describe, it, expect } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { internalRouter } from '../src/routes/internal.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository, encodeEncoreJobId } from '../src/data/job-repo.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import {
  PerWorkspaceAssetRepository,
  PerWorkspaceJobRepository,
  PerWorkspacePipelineRepository
} from '../src/data/per-workspace-repos.js';
import { currentRequestStackName } from '../src/services/request-stack-context.js';
import type { WorkspaceConnections, WorkspaceStackResolver } from '../src/services/workspace-stack.js';
import type { PackagingService } from '../src/pipeline/packaging.js';

type Stack = {
  name: string;
  assets: InMemoryAssetRepository;
  jobs: InMemoryJobRepository;
  pipelines: InMemoryPipelineRepository;
  connections: WorkspaceConnections;
};

function makeStack(name: string): Stack {
  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const pipelines = new InMemoryPipelineRepository();
  const connections = {
    assets,
    jobs,
    pipelines,
    sourceBucket: 'openvideocore-source',
    packagedBucket: 'openvideocore-packaged',
    stackName: name
  } as unknown as WorkspaceConnections;
  return { name, assets, jobs, pipelines, connections };
}

type Harness = {
  app: FastifyInstance;
  stacks: Record<string, Stack>;
  handledSuccessIn: Array<string | undefined>;
};

async function buildApp(names: string[]): Promise<Harness> {
  const stacks: Record<string, Stack> = {};
  for (const n of names) stacks[n] = makeStack(n);
  const pick = (requested?: string): Stack =>
    (requested && stacks[requested]) || stacks[names[0]!]!;

  const resolver = {
    resolve: async (stackName?: string) => pick(stackName).connections,
    resolveCached: (stackName?: string) => pick(stackName).connections
  } as unknown as WorkspaceStackResolver;

  // Records the ambient stack each packager success callback was handled in.
  // The real PackagingService resolves the asset through the stack-scoped repo,
  // so the context it runs in IS the stack the manifest write lands on.
  const handledSuccessIn: Array<string | undefined> = [];
  const packaging = {
    handleSuccess: async (payload: { jobId: string }) => {
      handledSuccessIn.push(currentRequestStackName());
      const assets = new PerWorkspaceAssetRepository(resolver);
      const asset = await assets.get(payload.jobId);
      if (!asset) return false;
      await assets.update(asset.id, { manifestUrls: { hls: 'https://example/master.m3u8' } });
      return true;
    }
  } as unknown as PackagingService;

  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(internalRouter, {
    prefix: '/api/v1/internal',
    repository: new PerWorkspaceAssetRepository(resolver),
    jobRepository: new PerWorkspaceJobRepository(resolver),
    pipelineRepository: new PerWorkspacePipelineRepository(resolver),
    packaging,
    listStackNames: async () => names
  });
  await app.ready();
  return { app, stacks, handledSuccessIn };
}

// Seed a dispatched transcode job + its asset on one stack, exactly as the
// transcode submit path does: the job's encoreJobId is
// `<resolved stack>__<job local id>`.
async function seedTranscodeJob(stack: Stack): Promise<{ assetId: string; jobId: string; externalId: string }> {
  const asset = await stack.assets.create({ name: 'clip' });
  await stack.assets.update(asset.id, { objectKey: `ingest/${asset.id}`, status: 'processing' });
  const job = await stack.jobs.create({ type: 'transcode', assetId: asset.id });
  const externalId = encodeEncoreJobId(stack.name, job.id);
  await stack.jobs.update(job.id, { encoreJobId: externalId, status: 'running' });
  return { assetId: asset.id, jobId: job.id, externalId };
}

describe('Encore completion callback settles the job on its OWN stack (issue #1058)', () => {
  it('settles a non-default-stack job from a header-less callback', async () => {
    const h = await buildApp(['a', 'b']);
    const seeded = await seedTranscodeJob(h.stacks['b']!);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/internal/encore-callback',
      payload: { externalId: seeded.externalId, status: 'SUCCESSFUL', output: [] }
    });

    // Pre-fix: 404 not_found, because the lookup ran against stack 'a'.
    expect(res.statusCode).toBe(200);
    expect(res.json().applied).toBe(true);
    const job = await h.stacks['b']!.jobs.get(seeded.jobId);
    expect(job?.status).toBe('done');
    expect((await h.stacks['a']!.jobs.list()).items).toHaveLength(0);
  });

  it('leaves default-stack behaviour unchanged', async () => {
    const h = await buildApp(['a', 'b']);
    const seeded = await seedTranscodeJob(h.stacks['a']!);

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/internal/encore-callback',
      payload: { externalId: seeded.externalId, status: 'SUCCESSFUL', output: [] }
    });

    expect(res.statusCode).toBe(200);
    expect((await h.stacks['a']!.jobs.get(seeded.jobId))?.status).toBe('done');
  });

  it('still 404s an unknown job on every stack', async () => {
    const h = await buildApp(['a', 'b']);
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/internal/encore-callback',
      payload: { externalId: encodeEncoreJobId('b', 'no-such-job'), status: 'SUCCESSFUL' }
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('packager callbacks reach non-default stacks (issue #1058)', () => {
  it('applies a success callback in the stack that owns the asset', async () => {
    const h = await buildApp(['a', 'b']);
    const asset = await h.stacks['b']!.assets.create({ name: 'clip' });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/internal/packagerCallback/success',
      payload: { url: 'https://example/out', jobId: asset.id, outputPath: `/${asset.id}/pkg/` }
    });

    expect(res.statusCode).toBe(200);
    expect(h.handledSuccessIn).toEqual(['b']);
    expect((await h.stacks['b']!.assets.get(asset.id))?.manifestUrls).toBeDefined();
  });

  it('handles a default-stack asset in the default context (no stack name)', async () => {
    const h = await buildApp(['a', 'b']);
    const asset = await h.stacks['a']!.assets.create({ name: 'clip' });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/internal/packagerCallback/success',
      payload: { url: 'https://example/out', jobId: asset.id, outputPath: `/${asset.id}/pkg/` }
    });

    expect(res.statusCode).toBe(200);
    expect(h.handledSuccessIn).toEqual([undefined]);
  });

  it('attributes a failure callback to a running package step on a non-default stack', async () => {
    const h = await buildApp(['a', 'b']);
    const asset = await h.stacks['b']!.assets.create({ name: 'clip' });
    const execution = await h.stacks['b']!.pipelines.create({
      assetId: asset.id,
      pipelineName: 'abr-vod',
      steps: ['transcode', 'package']
    });
    await h.stacks['b']!.pipelines.update(execution.id, {
      steps: [
        { name: 'transcode', status: 'done' },
        { name: 'package', status: 'running' }
      ]
    });

    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/internal/packagerCallback/failure',
      payload: { message: 'packager blew up' }
    });

    expect(res.statusCode).toBe(200);
    const after = await h.stacks['b']!.pipelines.get(execution.id);
    expect(after?.status).toBe('failed');
    expect(after?.steps.find((s) => s.name === 'package')?.error).toContain('packager blew up');
  });
});
