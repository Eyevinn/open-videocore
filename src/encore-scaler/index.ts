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
    }
  };
}
