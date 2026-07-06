// Background scaling loop.
//
// One tick():
//   1. Count pending jobs (LLEN encore:queue).
//   2. Load the instance pool from Valkey.
//   3. Scale up: if there is pending work, every instance is busy, and the pool
//      is below maxInstances, spawn one instance (one per tick — spawns are
//      slow, so we grow gradually rather than stampede).
//   4. Scale down: destroy idle instances whose idle age exceeds idleTimeoutMs.
//   5. Dispatch: for each instance with spare capacity, atomically move a job
//      from the queue to the inflight list (RPOPLPUSH), POST it to the instance,
//      and record the job->instance mapping + status. On dispatch failure the
//      job is returned to the queue so it is retried, never lost.
//
// Idempotency / crash-safety: the RPOPLPUSH into encore:inflight means a job is
// only removed from the queue once it is claimed for a specific POST attempt; a
// failed POST re-queues it. The pool + mapping hashes are the durable state, so
// a restarted loop resumes from Valkey rather than in-memory bookkeeping.

import {
  JOBS_PER_INSTANCE,
  keys,
  type EncoreInstanceRecord,
  type EncoreScalerConfig,
  type QueuedJob
} from './types.js';
import {
  destroyInstance,
  listInstances,
  spawnInstance,
  updateInstance
} from './instance-pool.js';

export class EncoreScalerLoop {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private config: EncoreScalerConfig) {}

  start(intervalMs = 10_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      // Guard against overlapping ticks if one runs long (spawns are slow).
      if (this.running) return;
      this.running = true;
      void this.tick()
        .catch(() => {
          // A tick failure must not kill the interval; the next tick retries.
        })
        .finally(() => {
          this.running = false;
        });
    }, intervalMs);
    // Do not keep the event loop alive solely for the scaler.
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  async tick(): Promise<void> {
    const { redis, workspaceId, maxInstances, idleTimeoutMs } = this.config;

    // 1. Pending work.
    const pending = await redis.llen(keys.queue(workspaceId));

    // 2. Current pool.
    let instances = await listInstances(redis, workspaceId);

    // 3. Scale up (one instance per tick).
    const allBusy = instances.every((i) => i.activeJobs >= JOBS_PER_INSTANCE);
    if (pending > 0 && allBusy && instances.length < maxInstances) {
      const spawned = await spawnInstance(this.config);
      instances = [...instances, spawned];
    }

    // 4. Scale down idle instances.
    const now = Date.now();
    const survivors: EncoreInstanceRecord[] = [];
    for (const inst of instances) {
      if (inst.activeJobs === 0 && now - inst.lastIdleAt > idleTimeoutMs) {
        await destroyInstance(inst.instanceId, this.config);
      } else {
        survivors.push(inst);
      }
    }
    instances = survivors;

    // 5. Dispatch pending jobs to instances with spare capacity.
    for (const inst of instances) {
      while (inst.activeJobs < JOBS_PER_INSTANCE) {
        const claimed = await redis.rpoplpush(
          keys.queue(workspaceId),
          keys.inflight(workspaceId)
        );
        if (!claimed) break; // queue empty

        let job: QueuedJob;
        try {
          job = JSON.parse(claimed) as QueuedJob;
        } catch {
          // Unparseable entry: drop it from inflight and move on.
          await redis.lrem(keys.inflight(workspaceId), 1, claimed);
          continue;
        }

        const dispatched = await this.dispatch(inst, job);
        // Whether or not dispatch succeeded, the job is no longer "inflight"
        // under this attempt: success recorded the mapping, failure re-queued.
        await redis.lrem(keys.inflight(workspaceId), 1, claimed);

        if (!dispatched) {
          // Re-queue at the head so it is retried on the next tick.
          await redis.rpush(keys.queue(workspaceId), claimed);
          break; // instance likely unhealthy; stop feeding it this tick
        }

        inst.activeJobs += 1;
        await updateInstance(redis, workspaceId, inst);
      }
    }
  }

  // POST a queued job's raw Encore payload to a chosen instance and record the
  // job->instance mapping + QUEUED->running status. Returns false on any
  // non-2xx / network error so the caller can re-queue.
  private async dispatch(
    inst: EncoreInstanceRecord,
    job: QueuedJob
  ): Promise<boolean> {
    const { redis, workspaceId, getToken } = this.config;
    try {
      const token = await getToken();
      const res = await fetch(`${inst.url.replace(/\/$/, '')}/encoreJobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(job.payload)
      });
      if (!res.ok) return false;

      await redis.hset(keys.jobInstance(workspaceId), job.jobId, inst.instanceId);
      await redis.hset(keys.jobStatus(workspaceId), job.jobId, 'running');
      return true;
    } catch {
      return false;
    }
  }
}
