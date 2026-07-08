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

  // Cancel / mark a job as failed. Useful for orphaned jobs (e.g. Encore jobs
  // lost when a stack was reprovisioned).
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
      const updated = await repo.update(request.params.id, {
        status: 'failed',
        error: 'cancelled by operator'
      });
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
