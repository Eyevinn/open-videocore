// Package-only pipeline tests (issue #739).
//
// `package: ['package']` (src/pipeline/pipelines.ts) is the only built-in
// pipeline whose FIRST step is `package`, so it is the only path that dispatches
// a packaging job directly from POST /api/v1/assets/:id/execute rather than from
// the transcode->package handoff in the callback poller. These tests pin the
// contract that dispatch obeys.
//
// CONTRACTS VERIFIED (no shapes guessed):
//   - `PackagingTrigger.triggerPackaging(assetId, encoreJobUrl)` and
//     `PackagingJob = { jobId: string; url: string }` —
//     src/pipeline/packaging.ts:166-192 ("url: the Encore job API URL the
//     packager fetches output details from", verified from the packager's
//     redisListener.ts, 2026-07-07). `url` is the packager's INPUT, so a
//     dispatch with an empty url is a job the packager can never act on.
//   - `StepExecution.encoreJobId` ("Encore external job ID (transcode steps)")
//     and `PipelineExecution` — src/data/pipeline-repo.ts:43-56 (field at :47)
//     and :58-70.
//   - `Rendition` (`asset.renditions[]`) — src/data/asset-repo.ts:384-400,
//     519-521.
//   - Encore pool key layout used to resolve the job URL: `keys.pool`,
//     `keys.jobInstance`, `keys.jobUuid` — src/encore-scaler/types.ts:222-227;
//     `encodeEncoreJobId` — src/data/job-repo.ts:287-289.
//   - Execute-route enum `PIPELINE_NAMES` — src/pipeline/pipelines.ts.

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
import { assetsRouter, latestCompletedTranscodeEncoreJobId } from '../src/routes/assets.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import { InMemoryJobRepository, encodeEncoreJobId } from '../src/data/job-repo.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import type { PipelineExecution } from '../src/data/pipeline-repo.js';
import type { EncoreClient, EncoreSubmitInput } from '../src/pipeline/encore-client.js';
import type { PackagingService } from '../src/pipeline/packaging.js';
import { keys } from '../src/encore-scaler/types.js';

const A = { authorization: 'Bearer token-a' };

// The context token embedded in every encoreJobId (job-repo.ts encodeEncoreJobId).
const CTX = 'ctx';
const ENCORE_JOB_ID = encodeEncoreJobId(CTX, 'job-local-1');
const INSTANCE_ID = 'encore-instance-1';
const INSTANCE_URL = 'https://encore-1.osc.example';
const ENCORE_UUID = '6f1c0f6e-0000-4000-8000-000000000001';
// The shape resolveEncoreJobUrlForPackaging builds: `${instanceUrl}/encoreJobs/${uuid}`.
const EXPECTED_JOB_URL = `${INSTANCE_URL}/encoreJobs/${ENCORE_UUID}`;

type PackagingCall = { assetId: string; encoreJobUrl: string };

// Minimal Redis double covering the two commands resolveEncoreJobUrlForPackaging
// issues: hget (job->instance, pool) and get (job uuid).
function makeRedis(opts: {
  jobInstance?: boolean;
  pool?: boolean;
  uuid?: boolean;
}): import('ioredis').Redis {
  const hashes: Record<string, Record<string, string>> = {};
  const strings: Record<string, string> = {};
  if (opts.jobInstance !== false) {
    hashes[keys.jobInstance(CTX)] = { [ENCORE_JOB_ID]: INSTANCE_ID };
  }
  if (opts.pool !== false) {
    hashes[keys.pool(CTX)] = {
      [INSTANCE_ID]: JSON.stringify({ id: INSTANCE_ID, url: INSTANCE_URL, activeJobs: 0 })
    };
  }
  if (opts.uuid !== false) {
    strings[keys.jobUuid(ENCORE_JOB_ID)] = ENCORE_UUID;
  }
  return {
    hget: async (key: string, field: string) => hashes[key]?.[field] ?? null,
    get: async (key: string) => strings[key] ?? null
  } as unknown as import('ioredis').Redis;
}

type Harness = {
  app: FastifyInstance;
  assets: InMemoryAssetRepository;
  pipelines: InMemoryPipelineRepository;
  submitted: EncoreSubmitInput[];
  packagingCalls: PackagingCall[];
};

function fakeEncore(): { client: EncoreClient; submitted: EncoreSubmitInput[] } {
  const submitted: EncoreSubmitInput[] = [];
  const client = {
    submit: vi.fn(async (input: EncoreSubmitInput) => {
      submitted.push(input);
      return { encoreInternalId: 'encore-internal-1' };
    }),
    getJobStatus: vi.fn(),
    cancel: vi.fn()
  } as unknown as EncoreClient;
  return { client, submitted };
}

async function buildApp(redisOpts?: {
  jobInstance?: boolean;
  pool?: boolean;
  uuid?: boolean;
}): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  registerAuth(app);
  const assets = new InMemoryAssetRepository();
  const jobs = new InMemoryJobRepository();
  const pipelines = new InMemoryPipelineRepository();
  const { client, submitted } = fakeEncore();
  const packagingCalls: PackagingCall[] = [];
  const packaging = {
    triggerPackaging: async (assetId: string, encoreJobUrl: string) => {
      packagingCalls.push({ assetId, encoreJobUrl });
    }
  } as unknown as PackagingService;

  await app.register(assetsRouter, {
    prefix: '/api/v1/assets',
    repository: assets,
    jobRepository: jobs,
    pipelineRepository: pipelines,
    encore: client,
    sourceBucket: 'src-bucket',
    outputBucket: 'out-bucket',
    packaging,
    ...(redisOpts ? { packagingRedis: makeRedis(redisOpts) } : {})
  });
  await app.ready();
  return { app, assets, pipelines, submitted, packagingCalls };
}

// An asset carrying a stored source object (so the source gate is never the
// reason a case fails) and, optionally, transcoded renditions.
async function makeAsset(
  h: Harness,
  opts: { renditions?: boolean; objectKey?: boolean } = {}
): Promise<string> {
  const asset = await h.assets.create({
    name: 'my-video',
    ...(opts.objectKey === false ? {} : { objectKey: 'ingest/my-video' })
  });
  if (opts.renditions !== false) {
    await h.assets.update(asset.id, {
      renditions: [
        { id: 'r1', label: '1080p', width: 1920, height: 1080, objectKey: 'transcode/r1.mp4' }
      ]
    });
  }
  return asset.id;
}

// A prior execution whose `transcode` step completed and whose `package` step
// failed — the recovery case the package-only pipeline exists for (#739).
async function recordCompletedTranscode(
  h: Harness,
  assetId: string,
  encoreJobId: string = ENCORE_JOB_ID
): Promise<PipelineExecution> {
  const execution = await h.pipelines.create({
    assetId,
    pipelineName: 'abr-vod',
    steps: ['transcode', 'package']
  });
  const updated = await h.pipelines.update(execution.id, {
    status: 'failed',
    steps: [
      { name: 'transcode', status: 'done', encoreJobId, jobId: 'job-1' },
      { name: 'package', status: 'failed', error: 'packager never signalled completion' }
    ]
  });
  return updated!;
}

function execute(app: FastifyInstance, id: string, pipeline = 'package') {
  return app.inject({
    method: 'POST',
    url: `/api/v1/assets/${id}/execute`,
    headers: A,
    payload: { pipeline }
  });
}

describe('package-only pipeline (issue #739)', () => {
  it('rejects with 409 no_renditions when the asset has nothing to package', async () => {
    const h = await buildApp({});
    const id = await makeAsset(h, { renditions: false });

    const res = await execute(h.app, id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_renditions');
    // Nothing was dispatched and no execution was created.
    expect(h.packagingCalls).toEqual([]);
    expect(h.submitted).toEqual([]);
    expect(await h.pipelines.listByAsset(id)).toEqual([]);
  });

  it('rejects with 409 no_transcode_job when renditions exist but no transcode job is recorded', async () => {
    const h = await buildApp({});
    const id = await makeAsset(h);

    const res = await execute(h.app, id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('no_transcode_job');
    expect(h.packagingCalls).toEqual([]);
    expect(await h.pipelines.listByAsset(id)).toEqual([]);
  });

  it('rejects with 409 instance_not_found when the Encore job URL cannot be resolved', async () => {
    // Instance scaled away: the job->instance mapping is gone, so there is no
    // URL the packager could fetch. Refuse rather than enqueue a dead job.
    const h = await buildApp({ jobInstance: false });
    const id = await makeAsset(h);
    await recordCompletedTranscode(h, id);

    const res = await execute(h.app, id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('instance_not_found');
    expect(h.packagingCalls).toEqual([]);
  });

  it('rejects with 409 instance_not_found when no packaging Redis is wired at all', async () => {
    const h = await buildApp(); // no packagingRedis
    const id = await makeAsset(h);
    await recordCompletedTranscode(h, id);

    const res = await execute(h.app, id);

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe('instance_not_found');
    expect(h.packagingCalls).toEqual([]);
  });

  it('dispatches packaging with the RESOLVED, non-empty Encore job URL and no transcode', async () => {
    const h = await buildApp({});
    const id = await makeAsset(h);
    await recordCompletedTranscode(h, id);

    const res = await execute(h.app, id);

    expect(res.statusCode).toBe(202);
    // Criterion 2: no Encore transcode job is dispatched by a package-only run.
    expect(h.submitted).toEqual([]);
    // The packager's INPUT is a real job URL, never '' (the regression this
    // test exists for): `{ jobId, url }` with url = the Encore job API URL.
    expect(h.packagingCalls).toHaveLength(1);
    expect(h.packagingCalls[0]).toEqual({ assetId: id, encoreJobUrl: EXPECTED_JOB_URL });
    expect(h.packagingCalls[0].encoreJobUrl).not.toBe('');
  });

  it('records the package-only run in pipeline history with step status', async () => {
    const h = await buildApp({});
    const id = await makeAsset(h);
    await recordCompletedTranscode(h, id);

    const res = await execute(h.app, id);
    expect(res.statusCode).toBe(202);
    const body = res.json();
    expect(body.pipelineName).toBe('package');
    expect(body.status).toBe('running');
    expect(body.steps).toHaveLength(1);
    expect(body.steps[0].name).toBe('package');
    expect(body.steps[0].status).toBe('running');

    // Criterion 4: it shows up in history like any other pipeline.
    const history = await h.app.inject({
      method: 'GET',
      url: `/api/v1/assets/${id}/pipelines`,
      headers: A
    });
    expect(history.statusCode).toBe(200);
    // GET /:id/pipelines responds with a bare array (z.array(pipelineExecutionSchema)).
    const names = (history.json() as PipelineExecution[]).map((e) => e.pipelineName);
    expect(names).toContain('package');
  });

  it('runs even when the asset source object is gone (packaging consumes transcode output)', async () => {
    // An asset whose source was archived/deleted after a successful transcode
    // still has exactly the output a package-only run packages, so the source
    // gate must not apply to it.
    const h = await buildApp({});
    const id = await makeAsset(h, { objectKey: false });
    await recordCompletedTranscode(h, id);

    const res = await execute(h.app, id);

    expect(res.statusCode).toBe(202);
    expect(h.packagingCalls).toHaveLength(1);
    expect(h.packagingCalls[0].encoreJobUrl).toBe(EXPECTED_JOB_URL);
  });

  it('still gates the source object for a transcode-first pipeline (unchanged)', async () => {
    const h = await buildApp({});
    const id = await makeAsset(h, { objectKey: false });

    const res = await execute(h.app, id, 'transcode');

    expect(res.statusCode).toBe(409);
    expect(h.submitted).toEqual([]);
  });
});

describe('latestCompletedTranscodeEncoreJobId (issue #739)', () => {
  const base = { id: 'x', assetId: 'a', createdAt: '', updatedAt: '' };

  function exec(createdAt: string, steps: PipelineExecution['steps']): PipelineExecution {
    return {
      ...base,
      id: `e-${createdAt}`,
      pipelineName: 'abr-vod',
      status: 'failed',
      steps,
      createdAt,
      updatedAt: createdAt
    };
  }

  it('returns undefined when no execution has a completed transcode', () => {
    expect(latestCompletedTranscodeEncoreJobId([])).toBeUndefined();
    expect(
      latestCompletedTranscodeEncoreJobId([
        exec('2026-09-01T00:00:00.000Z', [
          { name: 'transcode', status: 'running', encoreJobId: 'ctx__running' }
        ])
      ])
    ).toBeUndefined();
    // A done transcode with no recorded encoreJobId is not a usable handle.
    expect(
      latestCompletedTranscodeEncoreJobId([
        exec('2026-09-01T00:00:00.000Z', [{ name: 'transcode', status: 'done' }])
      ])
    ).toBeUndefined();
  });

  it('prefers the newest execution carrying a completed transcode', () => {
    const result = latestCompletedTranscodeEncoreJobId([
      exec('2026-09-01T00:00:00.000Z', [
        { name: 'transcode', status: 'done', encoreJobId: 'ctx__older' }
      ]),
      exec('2026-09-20T00:00:00.000Z', [
        { name: 'transcode', status: 'done', encoreJobId: 'ctx__newer' },
        { name: 'package', status: 'failed' }
      ]),
      // A newer execution with no usable transcode must not mask the one above.
      exec('2026-09-21T00:00:00.000Z', [{ name: 'package', status: 'failed' }])
    ]);
    expect(result).toBe('ctx__newer');
  });
});
