// A cancelled run is distinguishable from a failed one (issue #1339).
//
// Cancelling a run settles it as `failed` — that is the only terminal status
// `PipelineExecution['status']` carries — so until now an operator's own cancel
// was byte-identical to a genuine breakage on the wire. These tests pin the
// marker that separates them: `errorDetail.code = 'cancelled'` on the steps the
// cancel settled, with every status value left exactly as it was.
//
// CONTRACT SOURCES VERIFIED BEFORE WRITING (CLAUDE.md rule 7)
//   - `PipelineExecution['status']` = `running | done | failed` and `StepStatus`
//     = `pending | running | done | failed | skipped` — src/data/pipeline-repo.ts.
//     Neither carries `cancelled`, which is why the marker is a code and not a
//     status.
//   - `STEP_ERROR_CODES` (now including `cancelled`) and `stepErrorDetailSchema`
//     — src/pipeline/step-error-detail.ts. The schema is what
//     `toStepErrorDetail` (src/data/couch-pipeline-repo.ts) parses stored
//     details with, so a code it rejects would not survive a CouchDB round-trip.
//   - `buildCancelledStepErrorDetail` / `CANCELLED_STEP_MESSAGE` —
//     src/pipeline/cancelled-run-detail.ts.
//   - The two cancel routes: `DELETE /:executionId` (src/routes/pipelines.ts)
//     and `DELETE /:id` (src/routes/jobs.ts).
//   - The served shape: `stepExecutionSchema` / `pipelineExecutionSchema` in
//     src/routes/pipelines.ts, and the generated openapi.json operations
//     `delete /api/v1/pipelines/{executionId}` and `get /api/v1/pipelines/`.

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import Fastify, { type FastifyInstance } from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';

import { jobsRouter } from '../src/routes/jobs.js';
import { pipelinesRouter } from '../src/routes/pipelines.js';
import { InMemoryJobRepository } from '../src/data/job-repo.js';
import { InMemoryPipelineRepository, type StepExecution } from '../src/data/pipeline-repo.js';
import { InMemoryAssetRepository } from '../src/data/asset-repo.js';
import type { EncoreClient } from '../src/pipeline/encore-client.js';
import {
  STEP_ERROR_CODES,
  stepErrorDetailSchema
} from '../src/pipeline/step-error-detail.js';
import {
  CANCELLED_STEP_MESSAGE,
  buildCancelledStepErrorDetail
} from '../src/pipeline/cancelled-run-detail.js';

const CANCELLED_DETAIL = { code: 'cancelled', message: CANCELLED_STEP_MESSAGE };

type Harness = {
  app: FastifyInstance;
  jobs: InMemoryJobRepository;
  pipelines: InMemoryPipelineRepository;
  assets: InMemoryAssetRepository;
  cancelled: string[];
};

// Both cancel routes on one app, over the same in-memory repositories, so a
// cancel issued through either is observed through the other's reads.
async function buildApp(): Promise<Harness> {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  const jobs = new InMemoryJobRepository();
  const pipelines = new InMemoryPipelineRepository();
  const assets = new InMemoryAssetRepository();
  const cancelled: string[] = [];
  const encore = {
    submit: vi.fn(),
    getJobStatus: vi.fn(),
    cancel: vi.fn(async (id: string) => {
      cancelled.push(id);
    })
  };

  // Mirror the production preHandler (src/main.ts): every request carries a
  // `connections` object exposing the resolved transcoder client.
  app.decorateRequest('connections', null);
  app.addHook('preHandler', async (request) => {
    (request as unknown as { connections: unknown }).connections = { encore };
  });

  await app.register(jobsRouter, {
    prefix: '/api/v1/jobs',
    repository: jobs,
    pipelineRepository: pipelines,
    assetRepository: assets
  });
  await app.register(pipelinesRouter, {
    prefix: '/api/v1/pipelines',
    pipelineRepository: pipelines,
    jobRepository: jobs,
    assetRepository: assets,
    encoreClient: encore as unknown as EncoreClient
  });
  await app.ready();
  return { app, jobs, pipelines, assets, cancelled };
}

// A run mid-flight: `extract-metadata` already done, `subtitles` skipped
// because its optional service is unconfigured (#789), `transcode` running on
// a job, `package` still pending. Cancelling this covers every step state the
// cancel path has to decide about.
async function seedMixedRun(h: Harness) {
  const asset = await h.assets.create({ name: 'clip.mov', objectKey: 'src/clip.mov' });
  await h.assets.update(asset.id, { status: 'processing' });

  const job = await h.jobs.create({ type: 'transcode', assetId: asset.id, profile: 'program' });
  await h.jobs.update(job.id, { encoreJobId: 'ctx__job-1339', status: 'queued' });
  await h.jobs.update(job.id, { status: 'running', encoreInternalJobId: 'encore-internal-1' });

  const execution = await h.pipelines.create({
    assetId: asset.id,
    pipelineName: 'abr-vod',
    steps: ['extract-metadata', 'subtitles', 'transcode', 'package']
  });
  const steps: StepExecution[] = execution.steps.map((s) => {
    if (s.name === 'extract-metadata') return { ...s, status: 'done' as const };
    if (s.name === 'subtitles')
      return { ...s, status: 'skipped' as const, skipReason: 'no subtitle service on this stack' };
    if (s.name === 'transcode')
      return { ...s, status: 'running' as const, jobId: job.id, encoreJobId: 'ctx__job-1339' };
    return s;
  });
  await h.pipelines.update(execution.id, { steps });

  return { assetId: asset.id, jobId: job.id, executionId: execution.id };
}

describe('#1339 — a cancelled run carries a distinct marker', () => {
  it('DELETE /api/v1/pipelines/:executionId stamps errorDetail.code=cancelled on the steps it settles', async () => {
    const h = await buildApp();
    const { executionId } = await seedMixedRun(h);

    const res = await h.app.inject({
      method: 'DELETE',
      url: `/api/v1/pipelines/${executionId}`
    });
    expect(res.statusCode).toBe(200);

    const body = res.json() as {
      status: string;
      steps: { name: string; status: string; errorDetail?: { code: string; message: string } }[];
    };
    // The run still reports `failed` — no new status value reaches a client.
    expect(body.status).toBe('failed');

    const byName = Object.fromEntries(body.steps.map((s) => [s.name, s]));

    // The two steps the cancel settled carry the marker.
    expect(byName.transcode.status).toBe('failed');
    expect(byName.transcode.errorDetail).toEqual(CANCELLED_DETAIL);
    expect(byName.package.status).toBe('failed');
    expect(byName.package.errorDetail).toEqual(CANCELLED_DETAIL);

    // Already-settled steps are untouched: a completed step is not relabelled,
    // and a skipped optional step is not turned into a cancellation.
    expect(byName['extract-metadata'].status).toBe('done');
    expect(byName['extract-metadata'].errorDetail).toBeUndefined();
    expect(byName.subtitles.status).toBe('skipped');
    expect(byName.subtitles.errorDetail).toBeUndefined();
  });

  it('persists the marker on the execution, not just in the cancel response', async () => {
    const h = await buildApp();
    const { executionId } = await seedMixedRun(h);

    await h.app.inject({ method: 'DELETE', url: `/api/v1/pipelines/${executionId}` });

    const stored = await h.pipelines.get(executionId);
    expect(stored?.status).toBe('failed');
    expect(stored?.steps.find((s) => s.name === 'transcode')?.errorDetail).toEqual(
      CANCELLED_DETAIL
    );

    // ...and a later GET of the run serves it through the response schema.
    const get = await h.app.inject({ method: 'GET', url: `/api/v1/pipelines/${executionId}` });
    expect(get.statusCode).toBe(200);
    const step = (
      get.json() as { steps: { name: string; errorDetail?: { code: string } }[] }
    ).steps.find((s) => s.name === 'transcode');
    expect(step?.errorDetail?.code).toBe('cancelled');
  });

  it('DELETE /api/v1/jobs/:id marks the run cancelled, not merely failed', async () => {
    const h = await buildApp();
    const { jobId, executionId } = await seedMixedRun(h);

    const res = await h.app.inject({ method: 'DELETE', url: `/api/v1/jobs/${jobId}` });
    expect(res.statusCode).toBe(200);

    const execution = await h.pipelines.get(executionId);
    const transcode = execution?.steps.find((s) => s.name === 'transcode');
    expect(transcode?.status).toBe('failed');
    // The free text is unchanged — anything reading `error` today still works —
    // and the machine-readable marker now sits alongside it.
    expect(transcode?.error).toBe('cancelled by operator');
    expect(transcode?.errorDetail).toEqual(CANCELLED_DETAIL);
  });

  it('a genuinely failed step keeps its own detail when the run is cancelled afterwards', async () => {
    const h = await buildApp();
    const { executionId } = await seedMixedRun(h);

    // A real failure lands on `transcode` first: a source-read failure with its
    // own code (#1060). The cancel that follows must not overwrite it, or an
    // operator loses the reason the run was stopped by hand.
    const seeded = await h.pipelines.get(executionId);
    const steps: StepExecution[] = (seeded?.steps ?? []).map((s) =>
      s.name === 'transcode'
        ? {
            ...s,
            status: 'failed' as const,
            error: 'dropped by Encore: ffprobe failed for input s3://b/k: Server returned 404',
            errorDetail: { code: 'source_read_failed' as const, message: 'source unreadable' }
          }
        : s
    );
    await h.pipelines.update(executionId, { steps });

    await h.app.inject({ method: 'DELETE', url: `/api/v1/pipelines/${executionId}` });

    const after = await h.pipelines.get(executionId);
    expect(after?.steps.find((s) => s.name === 'transcode')?.errorDetail?.code).toBe(
      'source_read_failed'
    );
    // The still-pending step is the one that reports the cancellation.
    expect(after?.steps.find((s) => s.name === 'package')?.errorDetail).toEqual(CANCELLED_DETAIL);
  });

  it('builds a detail with the code and a fixed, caller-safe sentence only', () => {
    const detail = buildCancelledStepErrorDetail();
    expect(detail).toEqual(CANCELLED_DETAIL);
    // No storage error, HTTP status, source location or correlation id: a cancel
    // has none of those, so nothing is invented for it.
    expect(Object.keys(detail).sort()).toEqual(['code', 'message']);
  });

  it('survives a stored round-trip: the response schema accepts the cancelled code', () => {
    // `toStepErrorDetail` (src/data/couch-pipeline-repo.ts) hydrates a stored
    // detail by parsing it with this schema and degrades anything it rejects to
    // "no detail" — so this parse is what makes the marker durable.
    const parsed = stepErrorDetailSchema.safeParse(buildCancelledStepErrorDetail());
    expect(parsed.success).toBe(true);
    expect(STEP_ERROR_CODES).toContain('cancelled');
  });
});

describe('#1339 — the contract gains the marker and no new status value', () => {
  const spec = JSON.parse(
    readFileSync(new URL('../openapi.json', import.meta.url), 'utf8')
  ) as Record<string, unknown>;

  // Every `errorDetail.code` enum in the document, wherever a step is served
  // (GET/DELETE /api/v1/pipelines[/{executionId}] and the asset execution
  // routes), so one route cannot document the marker while another omits it.
  function errorDetailCodeEnums(node: unknown, found: string[][] = []): string[][] {
    if (Array.isArray(node)) {
      for (const item of node) errorDetailCodeEnums(item, found);
      return found;
    }
    if (node && typeof node === 'object') {
      const obj = node as Record<string, unknown>;
      const detail = obj.errorDetail as
        | { properties?: { code?: { enum?: string[] } } }
        | undefined;
      const codeEnum = detail?.properties?.code?.enum;
      if (codeEnum) found.push(codeEnum);
      for (const value of Object.values(obj)) errorDetailCodeEnums(value, found);
    }
    return found;
  }

  it('documents `cancelled` in every served errorDetail.code enum', () => {
    const enums = errorDetailCodeEnums(spec);
    expect(enums.length).toBeGreaterThan(0);
    for (const codes of enums) {
      expect(codes).toContain('cancelled');
    }
  });

  it('leaves the run and step status enums exactly as existing clients know them', () => {
    const paths = (spec as { paths: Record<string, Record<string, unknown>> }).paths;
    const cancelOp = paths['/api/v1/pipelines/{executionId}'].delete as {
      responses: Record<
        string,
        {
          content: {
            'application/json': {
              schema: {
                properties: {
                  status: { enum: string[] };
                  steps: { items: { properties: { status: { enum: string[] } } } };
                };
              };
            };
          };
        }
      >;
    };
    const schema = cancelOp.responses['200'].content['application/json'].schema;
    expect(schema.properties.status.enum).toEqual(['running', 'done', 'failed']);
    expect(schema.properties.steps.items.properties.status.enum).toEqual([
      'pending',
      'running',
      'done',
      'failed',
      'skipped'
    ]);
  });
});
