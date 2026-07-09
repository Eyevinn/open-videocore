// Top-level pipeline execution routes (issue #161).
//
// Provides a cross-asset view of pipeline executions so operators can see
// all in-flight and completed pipelines without navigating per-asset.
// Steps for running transcode jobs are enriched with live progress from
// the linked job document at read time.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PipelineRepository, StepExecution } from '../data/pipeline-repo.js';
import type { JobRepository } from '../data/job-repo.js';
import type { AssetRepository } from '../data/asset-repo.js';
import type { EncoreClient } from '../pipeline/encore-client.js';

const stepExecutionSchema = z.object({
  name: z.enum(['extract-metadata', 'thumbnail', 'subtitles', 'scene-detect', 'transcode', 'package']),
  status: z.enum(['pending', 'running', 'done', 'failed']),
  jobId: z.string().optional(),
  encoreJobId: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
  progress: z.number().optional()
});

const pipelineExecutionSchema = z.object({
  id: z.string(),
  assetId: z.string(),
  assetName: z.string().optional(),
  pipelineName: z.string(),
  status: z.enum(['running', 'done', 'failed']),
  steps: z.array(stepExecutionSchema),
  createdAt: z.string(),
  updatedAt: z.string()
});

const listResponseSchema = z.object({
  items: z.array(pipelineExecutionSchema),
  total: z.number()
});

export type PipelinesRouterOptions = {
  pipelineRepository: PipelineRepository;
  jobRepository: JobRepository;
  assetRepository: AssetRepository;
  encoreClient?: EncoreClient;
};

// Enrich step executions with live progress from the linked job.
async function enrichWithProgress(
  steps: StepExecution[],
  jobRepository: JobRepository
): Promise<StepExecution[]> {
  return Promise.all(
    steps.map(async (step) => {
      if (step.status === 'running' && step.jobId) {
        const job = await jobRepository.get(step.jobId);
        if (job && job.progress != null) {
          return { ...step, progress: job.progress };
        }
      }
      return step;
    })
  );
}

export const pipelinesRouter: FastifyPluginAsync<PipelinesRouterOptions> = async (app, opts) => {
  const { pipelineRepository, jobRepository, assetRepository } = opts;
  const server = app.withTypeProvider<ZodTypeProvider>();

  // List all pipeline executions across all assets, newest first.
  //   200 — paginated list
  server.get(
    '/',
    {
      schema: {
        querystring: z.object({
          status: z.enum(['running', 'done', 'failed']).optional(),
          limit: z.coerce.number().int().min(1).max(200).optional(),
          offset: z.coerce.number().int().min(0).optional()
        }),
        response: { 200: listResponseSchema }
      }
    },
    async (request, reply) => {
      const { status, limit = 50, offset = 0 } = request.query;
      const { items, total } = await pipelineRepository.listAll({ status, limit, offset });

      const enriched = await Promise.all(
        items.map(async (exec) => {
          const [asset, steps] = await Promise.all([
            assetRepository.get(exec.assetId).catch(() => undefined),
            enrichWithProgress([...exec.steps], jobRepository)
          ]);
          return { ...exec, assetName: asset?.name, steps };
        })
      );

      return reply.code(200).send({ items: enriched, total });
    }
  );

  // Cancel a pipeline execution: remove any pending Encore jobs from the
  // scaler queue and mark the execution + all non-terminal steps as failed.
  //   200 — cancelled execution
  //   404 — unknown execution ID
  server.delete(
    '/:executionId',
    {
      schema: {
        params: z.object({ executionId: z.string() }),
        response: {
          200: pipelineExecutionSchema,
          404: z.object({ error: z.string() })
        }
      }
    },
    async (request, reply) => {
      const exec = await pipelineRepository.get(request.params.executionId);
      if (!exec) {
        return reply.code(404).send({ error: 'not_found' });
      }

      // Cancel any pending Encore jobs so they are removed from the scaler
      // queue and don't keep triggering instance spawning.
      // Read encoreClient from opts at request time — it is updated by
      // activateScaler() after router registration, so the destructured
      // value captured at registration would always be stale.
      const encoreClient = opts.encoreClient;
      if (encoreClient) {
        for (const step of exec.steps) {
          if (step.encoreJobId && step.status !== 'done') {
            await encoreClient.cancel(step.encoreJobId).catch(() => {});
          }
        }
      }

      // Mark each non-terminal step as failed and the execution overall.
      const now = new Date().toISOString();
      const updatedSteps = exec.steps.map((step) =>
        step.status === 'done' ? step : { ...step, status: 'failed' as const, completedAt: now }
      );
      const updated = await pipelineRepository.update(exec.id, {
        status: 'failed',
        steps: updatedSteps
      });

      // Also mark the linked job(s) as failed in the job repository.
      for (const step of exec.steps) {
        if (step.jobId && step.status !== 'done') {
          await jobRepository.update(step.jobId, { status: 'failed', error: 'Cancelled by operator' }).catch(() => {});
        }
      }

      return reply.code(200).send({ ...(updated ?? exec), steps: updatedSteps });
    }
  );

  // Fetch a single pipeline execution by ID.
  //   200 — the execution
  //   404 — unknown execution ID
  server.get(
    '/:executionId',
    {
      schema: {
        params: z.object({ executionId: z.string() }),
        response: {
          200: pipelineExecutionSchema,
          404: z.object({ error: z.string() })
        }
      }
    },
    async (request, reply) => {
      const exec = await pipelineRepository.get(request.params.executionId);
      if (!exec) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const [asset, steps] = await Promise.all([
        assetRepository.get(exec.assetId).catch(() => undefined),
        enrichWithProgress([...exec.steps], jobRepository)
      ]);
      return reply.code(200).send({ ...exec, assetName: asset?.name, steps });
    }
  );
};
