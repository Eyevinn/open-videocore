// Encore-compatible REST facade over the auto-scaler.
//
// Callers speak the same /encoreJobs API they would speak to a single Encore
// instance. Submissions are enqueued to Valkey (the scaler loop dispatches
// them); status/cancel are proxied to whichever pooled instance ended up
// running the job.
//
//   POST   /encoreJobs      enqueue -> { id, status: 'QUEUED' }
//   GET    /encoreJobs/:id  proxy to the running instance, or QUEUED if unmapped
//   DELETE /encoreJobs/:id  remove from queue, or cancel on the instance with
//                           POST {instanceUrl}/encoreJobs/{transcoderJobId}/cancel
//                           (the verified transcoder cancel contract, #1232)
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
import {
  assertUnderJobThroughputCap,
  isJobThroughputCapExceededError
} from './job-throughput-cap.js';

export type EncoreScalerRouterOptions = {
  redis: Redis;
  workspaceId: string;
  // Resolves a fresh OSC token for proxied GET/DELETE calls to instances.
  getToken: () => Promise<string>;
  // Optional operator-configured job-throughput cap (issue #580): max number of
  // OUTSTANDING jobs (queued + being dispatched) admitted at once. Unset => no
  // cap (opt-in; behaviour unchanged). See src/encore-scaler/job-throughput-cap.ts.
  maxQueuedJobs?: number;
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

      // Optional operator-configured job-throughput cap (issue #580): reject an
      // over-limit submission with a machine-readable 429 + reason code rather
      // than growing an unbounded backlog. Checked against the scaler's own
      // Valkey queue/inflight state (single source of truth). No-op when unset.
      try {
        await assertUnderJobThroughputCap(redis, workspaceId, opts.maxQueuedJobs);
      } catch (err) {
        if (isJobThroughputCapExceededError(err)) {
          return reply.code(err.statusCode).send(err.toResponseBody());
        }
        throw err;
      }

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

      // Drain EVERY buffered queue entry for this job first (#746). A job can be
      // enqueued more than once (transport-class retry, #295), so removing only
      // the first match leaves duplicates behind (e.g. 11 of 12). Using
      // `lrem(..., 0, entry)` per distinct matching entry value removes all
      // occurrences; entries differ by `enqueuedAt` so duplicates are not
      // byte-identical. This runs even for a dispatched job so stale duplicates
      // never survive the cancel.
      const entries = await redis.lrange(keys.queue(workspaceId), 0, -1);
      let drained = false;
      for (const entry of entries) {
        try {
          const parsed = JSON.parse(entry) as QueuedJob;
          if (parsed.jobId === id) {
            // count 0 => remove ALL occurrences equal to this entry value.
            await redis.lrem(keys.queue(workspaceId), 0, entry);
            drained = true;
          }
        } catch {
          // ignore unparseable entries
        }
      }

      const instanceId = await redis.hget(keys.jobInstance(workspaceId), id);

      if (!instanceId) {
        // Not dispatched. If we drained one or more buffered entries the job is
        // cancelled; otherwise there was nothing to cancel.
        if (drained) {
          await redis.hset(keys.jobStatus(workspaceId), id, 'CANCELLED');
          return reply.code(200).send({ id, status: 'CANCELLED' });
        }
        return reply.code(404).send({ id, status: 'NOT_FOUND' });
      }

      const record = await redis.hget(keys.pool(workspaceId), instanceId);
      if (!record) {
        return reply.code(404).send({ id, status: 'NOT_FOUND' });
      }
      const { url } = JSON.parse(record) as { url: string };

      // The remote cancel leg (#1232). Contract source (CLAUDE.md rule 7):
      // upstream transcoder controller `EncoreController.kt`
      // (github.com/svt/encore, encore-web/src/main/kotlin/se/svt/oss/encore/
      // controller/EncoreController.kt) —
      // `@PostMapping("/{jobId}/cancel") fun cancel(@PathVariable jobId: UUID, ...)`:
      // POST, no request body, 404 when the job does not exist, and 409 only
      // when the job's status is not cancellable (NEW/QUEUED/IN_PROGRESS are
      // the cancellable states). This repo's client speaks the same shape —
      // `EncoreClient.cancel`, src/pipeline/encore-client.ts. `{jobId}` is the id the
      // TRANSCODER assigned, not our externalId: the scaler records it at
      // dispatch time under keys.jobUuid (scaler-loop.ts, `set` with a 24h TTL)
      // and the same resolution is done by makeScalingEncoreClient().cancel
      // (src/encore-scaler/index.ts). This facade previously sent
      // `DELETE {instanceUrl}/encoreJobs/{externalId}` — wrong method, wrong
      // path and the wrong id — so the remote leg was a silent no-op while the
      // caller was told CANCELLED.
      const transcoderJobId = await redis.get(keys.jobUuid(id));
      if (!transcoderJobId) {
        // Dispatched, but we never recorded (or have since expired) the id the
        // transcoder assigned, so there is no cancel we can address. Say so
        // instead of reporting a cancellation that did not happen — the job is
        // still running on the instance. Local state is left untouched so the
        // caller (or the reconciler) can retry once the id is resolvable.
        //
        // 503, deliberately NOT 404/409: in the upstream contract both of those
        // mean "nothing left to cancel" (404 unknown job, 409 already in a
        // non-cancellable/terminal status), and clients written against it —
        // including `EncoreClient.cancel` in src/pipeline/encore-client.ts,
        // `if (res.status === 404 || res.status === 409) return;` — treat them
        // as an idempotent success. Answering 409 here would let a client
        // pointed at this facade swallow "the cancel was never forwarded and
        // the job is still transcoding" as a completed cancellation. 503 is
        // outside that no-op window, so such a client throws and the caller can
        // retry.
        return reply.code(503).send({
          id,
          status: 'CANCEL_NOT_HONOURED',
          error:
            'job is dispatched but its transcoder-assigned job id is unknown, so the cancel could not be forwarded to the instance'
        });
      }

      try {
        const token = await getToken();
        const res = await fetch(
          `${url.replace(/\/$/, '')}/encoreJobs/${encodeURIComponent(transcoderJobId)}/cancel`,
          { method: 'POST', headers: { authorization: `Bearer ${token}` } }
        );
        // 404/409 => the job is already gone or already terminal. Per the
        // verified contract that is an idempotent no-op, so the job is not
        // running and CANCELLED is the honest answer.
        if (!res.ok && res.status !== 404 && res.status !== 409) {
          const text = await res.text().catch(() => '');
          return reply.code(502).send({
            id,
            status: 'CANCEL_FAILED',
            error: `encore instance rejected the cancel: ${res.status} ${text}`.trim()
          });
        }
        await redis.hset(keys.jobStatus(workspaceId), id, 'CANCELLED');
        return reply.code(200).send({ id, status: 'CANCELLED' });
      } catch {
        return reply.code(502).send({ id, error: 'failed to reach encore instance' });
      }
    }
  );
};
