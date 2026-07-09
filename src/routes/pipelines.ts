// Top-level pipeline execution routes (issue #161).
//
// Provides a cross-asset view of pipeline executions so operators can see
// all in-flight and completed pipelines without navigating per-asset.
// Steps for running transcode jobs are enriched with live progress from
// the linked job document at read time.

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { PipelineRepository } from '../data/pipeline-repo.js';
import type { JobRepository } from '../data/job-repo.js';
import type { AssetRepository } from '../data/asset-repo.js';

const stepStatusSchema = z.enum(['pending', 'running', 'done', 'failed']);

const stepExecutionSchema = z.object({
  name: z.enum(['extract-metadata', 'thumbnail', 'subtitles', 'scene-detect', 'transcode', 'package']),
  status: stepStatusSchema,
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
};

// Enrich step executions with live progress from the linked job.
async function enrichWithProgress(
  steps: ReturnType<typeof cloneSteps>,
  jobRepository: JobRepository
): Promise<typeof steps> {
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

function cloneSteps<T extends { steps: unknown[] }>(execution: T) {
  return (execution.steps as Array<Record<string, unknown>>).map((s) => ({ ...s }));
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

      // Enrich each execution with asset name and job progress.
      const enriched = await Promise.all(
        items.map(async (exec) => {
          const asset = await assetRepository.get(exec.assetId);
          const steps = await enrichWithProgress(
            exec.steps.map((s) => ({ ...s })),
            jobRepository
          );
          return {
            ...exec,
            assetName: asset?.name,
            steps
          };
        })
      );

      return reply.code(200).send({ items: enriched, total });
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
      const asset = await assetRepository.get(exec.assetId);
      const steps = await enrichWithProgress(
        exec.steps.map((s) => ({ ...s })),
        jobRepository
      );
      return reply.code(200).send({
        ...exec,
        assetName: asset?.name,
        steps
      });
    }
  );
};
