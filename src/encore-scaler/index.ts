// Encore auto-scaler public surface.
//
// makeScalingEncoreClient returns an object implementing the existing
// EncoreClient interface (src/pipeline/encore-client.ts) so transcode.ts keeps
// working unchanged: instead of POSTing to a single Encore instance, submit()
// enqueues the job to the scaler's Valkey buffer and getJobStatus() reads the
// status the scaler records.

import { keys, type EncoreScalerConfig, type QueuedJob } from './types.js';
import { toEncorePayload, type EncoreClient } from '../pipeline/encore-client.js';

export { EncoreScalerLoop } from './scaler-loop.js';
export { encoreScalerRouter } from './encore-scaler-router.js';
export type { EncoreScalerConfig } from './types.js';

// Build an EncoreClient that submits to the local scaler queue. The correlation
// key is the caller's externalId (encodeEncoreJobId), which is also the id the
// scaler tracks in its status/instance hashes and echoes back to the caller.
export function makeScalingEncoreClient(config: EncoreScalerConfig): EncoreClient {
  const { redis, workspaceId } = config;
  return {
    async submit(input) {
      const payload = toEncorePayload(input);
      const job: QueuedJob = {
        jobId: input.externalId,
        payload,
        enqueuedAt: Date.now()
      };
      await redis.lpush(keys.queue(workspaceId), JSON.stringify(job));
      await redis.hset(keys.jobStatus(workspaceId), input.externalId, 'QUEUED');
      // Our internal id IS the externalId: the scaler correlates on it and the
      // real Encore internal id is not known until the job is dispatched.
      return { encoreInternalId: input.externalId };
    },
    async getJobStatus(encoreJobId) {
      const status = await redis.hget(keys.jobStatus(workspaceId), encoreJobId);
      if (!status) return undefined;
      const s = status.toUpperCase();
      if (s === 'QUEUED' || s === 'RUNNING') return 'running';
      if (s === 'DONE' || s === 'SUCCESSFUL') return 'done';
      if (s === 'FAILED' || s === 'CANCELLED') return 'failed';
      return undefined;
    },
    async cancel(encoreJobId) {
      // The scaler tracks a job by our externalId (== encoreJobId here). Two
      // cases:
      //  (a) Still buffered in the local queue (not yet dispatched to an Encore
      //      instance): drop it from the queue so it never runs, and record the
      //      terminal CANCELLED status. No Encore call needed.
      //  (b) Already dispatched: resolve the Encore-assigned UUID and the
      //      instance it ran on (both stored at dispatch time, scaler-loop.ts)
      //      and POST the real Encore cancel endpoint on that instance.
      //      POST {instanceUrl}/encoreJobs/{uuid}/cancel — SVT Encore
      //      EncoreController.kt (github.com/svt/encore, verified 2026-07-09).
      //      404/409 are idempotent no-ops (job already gone/terminal).
      const encoreUuid = await redis.get(keys.jobUuid(encoreJobId));
      const instanceId = await redis.hget(keys.jobInstance(workspaceId), encoreJobId);

      if (!encoreUuid || !instanceId) {
        // Case (a): not yet dispatched. Remove any queue entry(ies) for this
        // job and mark it cancelled so getJobStatus reports 'failed'.
        const buffered = await redis.lrange(keys.queue(workspaceId), 0, -1);
        for (const entry of buffered) {
          try {
            const parsed = JSON.parse(entry) as { jobId?: string };
            if (parsed.jobId === encoreJobId) {
              await redis.lrem(keys.queue(workspaceId), 0, entry);
            }
          } catch {
            // Skip unparseable entries.
          }
        }
        await redis.hset(keys.jobStatus(workspaceId), encoreJobId, 'CANCELLED');
        return;
      }

      // Case (b): resolve the instance's base URL from the pool and POST cancel.
      const poolRaw = await redis.hget(keys.pool(workspaceId), instanceId);
      if (poolRaw) {
        try {
          const inst = JSON.parse(poolRaw) as { url?: string };
          if (inst.url) {
            const token = await config.getToken();
            const res = await fetch(
              `${inst.url.replace(/\/$/, '')}/encoreJobs/${encoreUuid}/cancel`,
              { method: 'POST', headers: { authorization: `Bearer ${token}` } }
            );
            // 404/409 = already gone/terminal: idempotent no-op. Only surface
            // other non-ok statuses.
            if (!res.ok && res.status !== 404 && res.status !== 409) {
              const text = await res.text().catch(() => '');
              throw new Error(
                `Encore job cancellation failed: ${res.status} ${text}`.trim()
              );
            }
          }
        } catch (err) {
          if (err instanceof Error && err.message.startsWith('Encore job cancellation failed')) {
            throw err;
          }
          // Unparseable pool entry / network error: fall through to mark status.
        }
      }
      await redis.hset(keys.jobStatus(workspaceId), encoreJobId, 'CANCELLED');
    }
  };
}
