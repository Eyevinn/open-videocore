// Workspace-scoped jobs router (issue #5).
//
// Exposes job status for asynchronous pipelines (URL-pull ingest today). Every
// route is behind `authenticate`, so each handler runs with a validated
// request.workspaceId and the job repo scopes reads to that workspace. A job id
// from another workspace resolves to 404 (existence is not leaked).

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { InMemoryJobRepository, JOB_STATUSES, JOB_TYPES, type JobRepository } from '../data/job-repo.js';

const errorSchema = z.object({ error: z.string(), message: z.string().optional() });

const jobSchema = z.object({
  id: z.string(),
  workspaceId: z.string(),
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
  profile: z.string().optional(),
  renditionAssetIds: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string()
});

type JobsRouterOptions = {
  repository?: JobRepository;
};

export const jobsRouter: FastifyPluginAsync<JobsRouterOptions> = async (fastify, opts) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const repo = opts.repository ?? new InMemoryJobRepository();
  const guarded = { onRequest: app.authenticate };

  app.get(
    '/:id',
    {
      ...guarded,
      schema: {
        params: z.object({ id: z.string() }),
        response: { 200: jobSchema, 404: errorSchema }
      }
    },
    async (request, reply) => {
      const job = await repo.get(request.workspaceId, request.params.id);
      if (!job) {
        return reply.code(404).send({ error: 'not_found' });
      }
      return reply.code(200).send(job);
    }
  );
};
