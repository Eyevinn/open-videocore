// An asset must leave PROCESSING when its last active job reaches a terminal
// state — including via cancel and via a late completion (#1227).
//
// Reported state: after a job was cancelled and then re-run, the asset still
// read PROCESSING in the UI. The cause is that `processing` was written when the
// work was DISPATCHED but only ever cleared by the transcode completion handler
// (`completeTranscode`, src/pipeline/transcode.ts). DELETE /api/v1/jobs/:id made
// the job terminal, failed the running pipeline step, and left the asset alone.
//
// These tests pin the recompute at the cancel edge (the acceptance criterion's
// named path) plus the pure rule it applies.
//
// Contracts verified before writing (CLAUDE.md rule 7):
//   - `DELETE /api/v1/jobs/{id}` — path, `{ id }` path param and the job-shaped
//     200 body: `jobsRouter`'s delete handler + `jobSchema` (src/routes/jobs.ts)
//     and openapi.json paths./api/v1/jobs/{id}.delete (200 = the job object;
//     the asset is NOT on the wire here, so nothing in the response contract
//     changes). `JobsRouterOptions.repository` / `.pipelineRepository` /
//     `.assetRepository` — same file.
//   - `InMemoryJobRepository` (`create({ type, assetId })`, `update(id, patch)`,
//     `get`, `findActiveByAssetId`), `JOB_STATUSES`, `JOB_TYPES`,
//     `isActiveJobStatus` — src/data/job-repo.ts.
//   - `InMemoryAssetRepository` (`create({ name })`, `update(id, { status })`,
//     `get`), `ASSET_STATUSES`, `ALLOWED_TRANSITIONS`
//     (`processing: ['ready','failed','archived']`, `uploading: ['processing',
//     ...]`, `ready: ['processing', ...]`, `failed: ['uploading','processing',
//     ...]`), `Asset.status` / `.statusHistory` (`StatusTransition`
//     `{ at, from, to, reason? }`) / `.renditions`, and
//     `UpdateAssetInput.statusReason` — src/data/asset-repo.ts.
//   - `assetStateAfterTerminalJob` / `priorStatusBeforeProcessing` /
//     `recomputeAssetStateAfterTerminalJob` —
//     src/pipeline/asset-state-after-terminal-job.ts.
//   - `InMemoryPipelineRepository.create({ assetId, pipelineName, steps })` /
//     `update` / `findRunningByAssetAndStep` — src/data/pipeline-repo.ts.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { jobsRouter } from '../src/routes/jobs.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { InMemoryPipelineRepository } from '../src/data/pipeline-repo.js';
import { InMemoryAssetRepository, type Rendition, type StatusTransition } from '../src/data/asset-repo.js';
import {
  assetStateAfterTerminalJob,
  priorStatusBeforeProcessing,
  recomputeAssetStateAfterTerminalJob
} from '../src/pipeline/asset-state-after-terminal-job.js';

type Harness = {
  app: FastifyInstance;
  jobs: InMemoryJobRepository;
  pipelines: InMemoryPipelineRepository;
  assets: InMemoryAssetRepository;
  cancelled: string[];
};

// The production wiring (src/main.ts `jobsRouterOptions`): the jobs router gets
// the job repo, the pipeline repo and the asset repo.
async function buildApp(): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const jobs = new InMemoryJobRepository();
  const pipelines = new InMemoryPipelineRepository();
  const assets = new InMemoryAssetRepository();
  const cancelled: string[] = [];

  app.decorateRequest('connections', null);
  app.addHook('preHandler', async (request) => {
    (request as unknown as { connections: unknown }).connections = {
      encore: {
        submit: vi.fn(),
        getJobStatus: vi.fn(),
        cancel: vi.fn(async (id: string) => {
          cancelled.push(id);
        })
      }
    };
  });

  await app.register(jobsRouter, {
    prefix: '/api/v1/jobs',
    repository: jobs,
    pipelineRepository: pipelines,
    assetRepository: assets
  });
  await app.ready();
  return { app, jobs, pipelines, assets, cancelled };
}

// An asset that was `ready` and is now `processing` because a transcode was
// dispatched on it — the state the reported asset was in.
async function readySourceInProcessing(h: Harness) {
  const asset = await h.assets.create({ name: 'clip' });
  await h.assets.update(asset.id, { status: 'processing' });
  await h.assets.update(asset.id, { status: 'ready' });
  await h.assets.update(asset.id, { status: 'processing' });
  return asset.id;
}

// A running transcode job on `assetId`, with the running PipelineExecution the
// cancel handler releases.
async function runningTranscode(h: Harness, assetId: string) {
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
  return job.id;
}

const oneRendition: Rendition[] = [
  {
    id: 'rendition-1',
    label: '1080p',
    width: 1920,
    height: 1080,
    objectKey: 'transcode/asset/job/1080.mp4',
    codec: 'h264',
    bitrateBps: 5_000_000
  }
];

describe('asset state after a job reaches a terminal state via cancel (#1227)', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await buildApp();
  });

  it('releases the asset from PROCESSING to its prior state when its last job is cancelled', async () => {
    const assetId = await readySourceInProcessing(h);
    const jobId = await runningTranscode(h, assetId);
    expect((await h.assets.get(assetId))?.status).toBe('processing');

    const res = await h.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${jobId}` });

    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('cancelled');

    // The acceptance criterion: the asset no longer sits PROCESSING with
    // nothing running. It was `ready` before the transcode was dispatched and a
    // cancel destroys nothing, so it goes back to `ready`.
    const asset = await h.assets.get(assetId);
    expect(asset?.status).toBe('ready');

    // ...and the history says WHY it moved, so this settle is distinguishable
    // from a completed transcode (`UpdateAssetInput.statusReason`, #1085).
    const last = asset?.statusHistory.at(-1) as StatusTransition;
    expect(last.from).toBe('processing');
    expect(last.to).toBe('ready');
    expect(last.reason).toContain('cancelled');
  });

  it('leaves the asset READY when renditions are already registered on it', async () => {
    const assetId = await readySourceInProcessing(h);
    await h.assets.update(assetId, { renditions: oneRendition });
    const jobId = await runningTranscode(h, assetId);

    await h.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${jobId}` });

    const asset = await h.assets.get(assetId);
    expect(asset?.status).toBe('ready');
    expect(asset?.renditions).toHaveLength(1);
  });

  it('keeps the asset PROCESSING while another job is still active on it', async () => {
    const assetId = await readySourceInProcessing(h);
    const jobId = await runningTranscode(h, assetId);
    // A second transcode of the same source is genuinely running.
    const other = await h.jobs.create({ type: 'transcode', assetId });
    await h.jobs.update(other.id, { status: 'running' });

    await h.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${jobId}` });

    expect((await h.assets.get(assetId))?.status).toBe('processing');

    // ...and when that one is cancelled too, the asset is finally released.
    await h.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${other.id}` });
    expect((await h.assets.get(assetId))?.status).toBe('ready');
  });

  it('fails an asset whose cancelled job was the URL pull still fetching its source', async () => {
    // An ingest asset goes `uploading -> processing` when the pull starts, and
    // `processing -> uploading` is not a legal move, so there is no prior state
    // to return to. The pull never delivered the bytes, so the asset is failed —
    // not left PROCESSING.
    const asset = await h.assets.create({ name: 'pulled' });
    await h.assets.update(asset.id, { status: 'processing' });
    const job = await h.jobs.create({ type: 'ingest-url', assetId: asset.id, sourceUrl: 'https://example.test/a.mp4' });
    await h.jobs.update(job.id, { status: 'running' });

    await h.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${job.id}` });

    expect((await h.assets.get(asset.id))?.status).toBe('failed');
  });

  it('returns a re-driven asset to the failed state it was re-driven from', async () => {
    const asset = await h.assets.create({ name: 'retried' });
    await h.assets.update(asset.id, { status: 'failed' });
    await h.assets.update(asset.id, { status: 'processing' });
    const jobId = await runningTranscode(h, asset.id);

    await h.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${jobId}` });

    expect((await h.assets.get(asset.id))?.status).toBe('failed');
  });

  it('does not move an asset that is not PROCESSING, and stays 200 on cancel', async () => {
    const asset = await h.assets.create({ name: 'idle' });
    await h.assets.update(asset.id, { status: 'processing' });
    await h.assets.update(asset.id, { status: 'ready' });
    const job = await h.jobs.create({ type: 'transcode', assetId: asset.id });
    await h.jobs.update(job.id, { status: 'running' });

    const res = await h.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${job.id}` });

    expect(res.statusCode).toBe(200);
    const after = await h.assets.get(asset.id);
    expect(after?.status).toBe('ready');
    // No status entry was appended: nothing was written to the asset at all.
    expect(after?.statusHistory.at(-1)?.to).toBe('ready');
    expect(after?.statusHistory.at(-1)?.reason).toBeUndefined();
  });

  it('is idempotent: a repeated cancel does not move the released asset again', async () => {
    const assetId = await readySourceInProcessing(h);
    const jobId = await runningTranscode(h, assetId);

    await h.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${jobId}` });
    const historyLength = (await h.assets.get(assetId))?.statusHistory.length;
    const second = await h.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${jobId}` });

    expect(second.statusCode).toBe(200);
    const asset = await h.assets.get(assetId);
    expect(asset?.status).toBe('ready');
    expect(asset?.statusHistory.length).toBe(historyLength);
  });
});

describe('the recompute rule itself (#1227)', () => {
  const history = (...pairs: [string | null, string][]): StatusTransition[] =>
    pairs.map(([from, to], i) => ({
      at: `2026-10-16T10:0${i}:00.000Z`,
      from: from as StatusTransition['from'],
      to: to as StatusTransition['to']
    }));

  it('reads the prior state as the `from` of the most recent move INTO processing', () => {
    expect(
      priorStatusBeforeProcessing(
        history([null, 'uploading'], ['uploading', 'processing'], ['processing', 'ready'], ['ready', 'processing'])
      )
    ).toBe('ready');
    expect(priorStatusBeforeProcessing(history([null, 'uploading']))).toBeUndefined();
  });

  it('never moves an asset while the job is still active', () => {
    for (const jobStatus of ['pending', 'queued', 'running'] as const) {
      expect(
        assetStateAfterTerminalJob({
          current: 'processing',
          jobStatus,
          jobType: 'transcode',
          hasRenditions: false,
          statusHistory: history([null, 'uploading'], ['uploading', 'processing'])
        })
      ).toBeUndefined();
    }
  });

  it('never moves an asset that is not processing', () => {
    for (const current of ['uploading', 'ready', 'failed', 'archived'] as const) {
      expect(
        assetStateAfterTerminalJob({
          current,
          jobStatus: 'cancelled',
          jobType: 'transcode',
          hasRenditions: false,
          statusHistory: history([null, 'uploading'], ['uploading', 'processing'])
        })
      ).toBeUndefined();
    }
  });

  it('prefers READY whenever renditions exist, whatever the terminal job state', () => {
    for (const jobStatus of ['done', 'failed', 'cancelled'] as const) {
      expect(
        assetStateAfterTerminalJob({
          current: 'processing',
          jobStatus,
          jobType: 'transcode',
          hasRenditions: true,
          statusHistory: history([null, 'uploading'], ['uploading', 'processing'])
        })
      ).toBe('ready');
    }
  });

  it('follows a failed job to FAILED when nothing was produced', () => {
    expect(
      assetStateAfterTerminalJob({
        current: 'processing',
        jobStatus: 'failed',
        jobType: 'transcode',
        hasRenditions: false,
        statusHistory: history([null, 'uploading'], ['uploading', 'processing'], ['processing', 'ready'], ['ready', 'processing'])
      })
    ).toBe('failed');
  });

  it('never leaves the asset in processing on any terminal job state', () => {
    for (const jobStatus of ['done', 'failed', 'cancelled'] as const) {
      for (const jobType of ['ingest-url', 'transcode', 'package'] as const) {
        for (const hasRenditions of [true, false]) {
          for (const h of [
            history([null, 'uploading'], ['uploading', 'processing']),
            history([null, 'uploading'], ['uploading', 'processing'], ['processing', 'ready'], ['ready', 'processing']),
            history([null, 'uploading'], ['uploading', 'failed'], ['failed', 'processing']),
            // Defensive: no recorded move into processing at all.
            history([null, 'uploading'])
          ]) {
            const next = assetStateAfterTerminalJob({
              current: 'processing',
              jobStatus,
              jobType,
              hasRenditions,
              statusHistory: h
            });
            expect(next).toBeDefined();
            expect(next).not.toBe('processing');
            expect(next).not.toBe('archived');
          }
        }
      }
    }
  });

  it('reports why it did nothing, and never throws when the asset write fails', async () => {
    const jobs = new InMemoryJobRepository();
    const assets = new InMemoryAssetRepository();
    const asset = await assets.create({ name: 'clip' });
    await assets.update(asset.id, { status: 'processing' });
    const job = await jobs.create({ type: 'transcode', assetId: asset.id });
    await jobs.update(job.id, { status: 'running' });

    // Still active => nothing to recompute.
    expect(
      (await recomputeAssetStateAfterTerminalJob({ ...job, status: 'running' }, { jobs, assets })).outcome
    ).toBe('job-not-terminal');

    // Unknown asset => reported, not thrown.
    expect(
      (
        await recomputeAssetStateAfterTerminalJob(
          { id: job.id, type: 'transcode', status: 'cancelled', assetId: 'nope' },
          { jobs, assets }
        )
      ).outcome
    ).toBe('asset-unknown');

    // A store that rejects the write is reported and warned about.
    const warnings: Record<string, unknown>[] = [];
    const result = await recomputeAssetStateAfterTerminalJob(
      { ...job, status: 'cancelled' },
      {
        jobs,
        assets: Object.assign(Object.create(Object.getPrototypeOf(assets) as object), assets, {
          get: async (id: string) => assets.get(id),
          update: async () => {
            throw new Error('couch unreachable');
          }
        }) as unknown as InMemoryAssetRepository,
        logWarn: (detail) => warnings.push(detail)
      }
    );
    expect(result.outcome).toBe('write-failed');
    expect(result.error).toBe('couch unreachable');
    expect(warnings).toHaveLength(1);
    expect((await assets.get(asset.id))?.status).toBe('processing');
  });
});
