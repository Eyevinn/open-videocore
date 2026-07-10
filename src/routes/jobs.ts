// Workspace-scoped jobs router (issue #5).
//
// Exposes job status for asynchronous pipelines (URL-pull ingest today). Every
// route is behind `authenticate`, so each handler runs with a validated
// request.workspaceId and the job repo scopes reads to that workspace. A job id
// from another workspace resolves to 404 (existence is not leaked).

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Redis } from 'ioredis';
import { InMemoryJobRepository, JOB_STATUSES, JOB_TYPES, type JobRepository, type JobStatus } from '../data/job-repo.js';
import type { PipelineRepository, StepExecution } from '../data/pipeline-repo.js';
import { keys } from '../encore-scaler/types.js';
import { decodeEncoreJobId } from '../data/job-repo.js';

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

const jobSchema = z.object({
  id: z.string(),
  type: z.enum(JOB_TYPES),
  status: z.enum(JOB_STATUSES),
  assetId: z.string(),
  sourceUrl: z.string(),
  progress: z.number(),
  bytesTransferred: z.number(),
  totalBytes: z.number().optional(),
  attempts: z.number(),
  error: z.string().optional(),
  // Transcode-job fields (issue #8). Present only when type === 'transcode'.
  encoreJobId: z.string().optional(),
  encoreInternalJobId: z.string().optional(),
  encoreInstanceId: z.string().optional(), // which pool instance is running this job
  profile: z.string().optional(),
  renditionAssetIds: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

type JobsRouterOptions = {
  repository?: JobRepository;
  redis?: Redis; // for Encore instance lookup
  pipelineRepository?: PipelineRepository; // to release the running pipeline lock on cancel
};

export const jobsRouter: FastifyPluginAsync<JobsRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const repo = opts.repository ?? new InMemoryJobRepository();

  app.get(
    '/',
    {
      
      schema: {
        querystring: z.object({
          limit: z.coerce.number().min(1).max(100).default(50),
          offset: z.coerce.number().min(0).default(0)
        }),
        response: {
          200: z.object({ items: z.array(jobSchema), total: z.number() })
        }
      }
    },
    async (request) => {
      return repo.list(request.query);
    }
  );

  // Cancel a job. Requests Encore cancellation (best-effort) and sets the job's
  // status to `cancelled` synchronously, distinct from `failed`. When the job
  // belongs to a running transcode PipelineExecution, its running `transcode`
  // step is marked failed so the asset's pipeline no longer shows RUNNING and a
  // new transcode can be submitted immediately (issue #126).
  app.delete(
    '/:id',
    {

      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: jobSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const job = await repo.get(request.params.id);
      if (!job) return reply.code(404).send({ error: 'not_found' });

      // Already terminal: repeated cancels are idempotent — return as-is without
      // re-cancelling (avoids a terminal→terminal transition, which would throw).
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') {
        return reply.code(200).send(job);
      }

      // Best-effort Encore cancellation. Must never block the synchronous status
      // update: Encore may be unreachable and cancelling a gone/terminal job is a
      // safe no-op per EncoreClient.cancel's contract (src/pipeline/encore-client.ts:44).
      if (job.encoreInternalJobId) {
        const encore = request.connections?.encore;
        if (encore) {
          try {
            await encore.cancel(job.encoreInternalJobId);
          } catch {
            // Encore unreachable or job already gone — proceed with local cancel.
          }
        }
      }

      // Synchronous local state: mark the job cancelled.
      const updated = await repo.update(request.params.id, {
        status: 'cancelled',
        error: 'cancelled by operator'
      });

      // Release the running pipeline lock: mark the running transcode step failed
      // so the asset's pipeline is no longer RUNNING. No-op when no running
      // execution is found (e.g. non-transcode/ingest jobs).
      const pipelineRepo = opts.pipelineRepository;
      if (pipelineRepo) {
        const execution = await pipelineRepo.findRunningByAssetAndStep(job.assetId, 'transcode');
        if (execution) {
          const now = new Date().toISOString();
          const steps: StepExecution[] = execution.steps.map((s) => ({ ...s }));
          const tIdx = steps.findIndex((s) => s.name === 'transcode');
          if (tIdx >= 0) {
            steps[tIdx] = {
              ...steps[tIdx],
              status: 'failed',
              error: 'cancelled by operator',
              completedAt: now
            };
            await pipelineRepo.update(execution.id, { steps, status: 'failed' });
          }
        }
      }

      return reply.code(200).send(updated ?? job);
    }
  );

  app.get(
    '/:id',
    {
      
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: jobSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const job = await repo.get(request.params.id);
      if (!job) {
        return reply.code(404).send({ error: 'not_found' });
      }
      // For running transcode jobs, actively poll Encore for the current status.
      // This bridges the gap when the encore-callback-listener cannot reach the
      // API (e.g. local dev). If Encore has no record the job is marked failed.
      if (job.status === 'running' && job.type === 'transcode' && job.encoreInternalJobId) {
        const encore = request.connections?.encore;
        if (encore) {
          try {
            const encoreStatus = await encore.getJobStatus(job.encoreInternalJobId) as JobStatus | undefined;
            if (encoreStatus && encoreStatus !== job.status) {
              const updated = await repo.update(job.id, { status: encoreStatus });
              return reply.code(200).send(updated ?? job);
            }
          } catch {
            // Encore unreachable or job not found — leave status as-is
          }
        }
      }
      // Annotate with the Encore pool instance that is (or was) running this job.
      // Read from opts live so a stack provisioned after startup (which activates
      // the scaler and sets opts.redis) is picked up without a restart (#103).
      const redis = opts.redis;
      if (redis && job.encoreJobId) {
        try {
          const decoded = decodeEncoreJobId(job.encoreJobId);
          if (decoded) {
            const instanceId = await redis.hget(keys.jobInstance(decoded.workspaceId), job.encoreJobId);
            if (instanceId) {
              return reply.code(200).send({ ...job, encoreInstanceId: instanceId });
            }
          }
        } catch {
          // non-fatal — omit encoreInstanceId if lookup fails
        }
      }
      return reply.code(200).send(job);
    }
  );
};
