// Encore-compatible REST facade over the auto-scaler.
//
// Callers speak the same /encoreJobs API they would speak to a single Encore
// instance. Submissions are enqueued to Valkey (the scaler loop dispatches
// them); status/cancel are proxied to whichever pooled instance ended up
// running the job.
//
//   POST   /encoreJobs      enqueue -> { id, status: 'QUEUED' }
//   GET    /encoreJobs/:id  proxy to the running instance, or QUEUED if unmapped
//   DELETE /encoreJobs/:id  remove from queue, or cancel on the instance
//
// Payload shape mirrors src/pipeline/encore-client.ts toEncorePayload(): the
// only field we depend on for correlation is `externalId`. Everything else is
// forwarded verbatim to Encore, so we validate loosely (externalId required,
// arbitrary extra fields passed through).

import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Redis } from 'ioredis';
import { keys, type QueuedJob } from './types.js';

export type EncoreScalerRouterOptions = {
  redis: Redis;
  workspaceId: string;
  // Resolves a fresh OSC token for proxied GET/DELETE calls to instances.
  getToken: () => Promise<string>;
};

// The raw Encore job payload. externalId is our correlation key and is
// required; all other fields are forwarded to Encore untouched.
const submitSchema = z
  .object({ externalId: z.string().min(1) })
  .passthrough();

const idParamSchema = z.object({ id: z.string().min(1) });

export const encoreScalerRouter: FastifyPluginAsync<EncoreScalerRouterOptions> = async (
  fastify,
  opts
) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>();
  const { redis, workspaceId, getToken } = opts;

  // POST /encoreJobs — buffer the job and report it QUEUED. The scaler loop
  // picks it up and dispatches it to a pooled instance.
  app.post(
    '/encoreJobs',
    { schema: { body: submitSchema } },
    async (request, reply) => {
      const payload = request.body as Record<string, unknown> & { externalId: string };
      const jobId = payload.externalId;

      const job: QueuedJob = {
        jobId,
        payload,
        enqueuedAt: Date.now()
      };
      // LPUSH + RPOPLPUSH (in the loop) gives FIFO ordering.
      await redis.lpush(keys.queue(workspaceId), JSON.stringify(job));
      await redis.hset(keys.jobStatus(workspaceId), jobId, 'QUEUED');

      return reply.code(202).send({ id: jobId, status: 'QUEUED' });
    }
  );

  // GET /encoreJobs/:id — if the job has been dispatched, proxy the status GET
  // to its instance; otherwise it is still buffered, so report QUEUED.
  app.get(
    '/encoreJobs/:id',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const instanceId = await redis.hget(keys.jobInstance(workspaceId), id);
      if (!instanceId) {
        return reply.code(200).send({ id, status: 'QUEUED' });
      }

      const record = await redis.hget(keys.pool(workspaceId), instanceId);
      if (!record) {
        // Instance was scaled down after the job left it; fall back to the
        // last known status we recorded.
        const status = (await redis.hget(keys.jobStatus(workspaceId), id)) ?? 'UNKNOWN';
        return reply.code(200).send({ id, status });
      }

      const { url } = JSON.parse(record) as { url: string };
      try {
        const token = await getToken();
        const res = await fetch(`${url.replace(/\/$/, '')}/encoreJobs/${encodeURIComponent(id)}`, {
          headers: { authorization: `Bearer ${token}` }
        });
        if (res.status === 404) {
          return reply.code(404).send({ id, status: 'NOT_FOUND' });
        }
        const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return reply.code(res.status).send(body);
      } catch {
        return reply.code(502).send({ id, error: 'failed to reach encore instance' });
      }
    }
  );

  // DELETE /encoreJobs/:id — if still queued, remove it from the buffer; if
  // dispatched, forward the cancel to its instance.
  app.delete(
    '/encoreJobs/:id',
    { schema: { params: idParamSchema } },
    async (request, reply) => {
      const { id } = request.params;
      const instanceId = await redis.hget(keys.jobInstance(workspaceId), id);

      if (!instanceId) {
        // Still buffered: find and remove the matching queue entry.
        const entries = await redis.lrange(keys.queue(workspaceId), 0, -1);
        for (const entry of entries) {
          try {
            const parsed = JSON.parse(entry) as QueuedJob;
            if (parsed.jobId === id) {
              await redis.lrem(keys.queue(workspaceId), 1, entry);
              await redis.hset(keys.jobStatus(workspaceId), id, 'CANCELLED');
              return reply.code(200).send({ id, status: 'CANCELLED' });
            }
          } catch {
            // ignore unparseable entries
          }
        }
        return reply.code(404).send({ id, status: 'NOT_FOUND' });
      }

      const record = await redis.hget(keys.pool(workspaceId), instanceId);
      if (!record) {
        return reply.code(404).send({ id, status: 'NOT_FOUND' });
      }
      const { url } = JSON.parse(record) as { url: string };
      try {
        const token = await getToken();
        const res = await fetch(`${url.replace(/\/$/, '')}/encoreJobs/${encodeURIComponent(id)}`, {
          method: 'DELETE',
          headers: { authorization: `Bearer ${token}` }
        });
        await redis.hset(keys.jobStatus(workspaceId), id, 'CANCELLED');
        return reply.code(res.ok ? 200 : res.status).send({ id, status: 'CANCELLED' });
      } catch {
        return reply.code(502).send({ id, error: 'failed to reach encore instance' });
      }
    }
  );
};
