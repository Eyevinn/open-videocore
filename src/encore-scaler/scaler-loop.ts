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

  setMaxInstances(max: number): void {
    this.config.maxInstances = max;
  }

  setIdleTimeoutMs(ms: number): void {
    this.config.idleTimeoutMs = ms;
  }

  async tick(): Promise<void> {
    const { redis, workspaceId, maxInstances, idleTimeoutMs } = this.config;
    const minInstances = this.config.minInstances ?? 0;

    // 0. Reconcile stale activeJobs counts against each instance's real
    //    in-progress job count before making any scaling/dispatch decision.
    await this.reconcile();

    // 1. Pending work.
    const pending = await redis.llen(keys.queue(workspaceId));

    // 2. Current pool.
    let instances = await listInstances(redis, workspaceId);

    // 3. Scale up (one instance per tick). Pre-warm to minInstances regardless
    //    of pending work; otherwise scale up only when every instance is busy
    //    and there is pending work.
    const allBusy = instances.every((i) => i.activeJobs >= JOBS_PER_INSTANCE);
    const belowMin = instances.length < minInstances;
    if (
      instances.length < maxInstances &&
      (belowMin || (pending > 0 && allBusy))
    ) {
      const spawned = await spawnInstance(this.config);
      instances = [...instances, spawned];
    }

    // 4. Scale down idle instances, but never below minInstances.
    const now = Date.now();
    const survivors: EncoreInstanceRecord[] = [];
    let activeCount = instances.length;
    for (const inst of instances) {
      if (inst.activeJobs === 0 && now - inst.lastIdleAt > idleTimeoutMs && activeCount > minInstances) {
        await destroyInstance(inst.instanceId, this.config);
        activeCount -= 1;
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

  // Reconcile each instance's tracked activeJobs against its real IN_PROGRESS
  // job count. Corrects drift (e.g. a completion callback that never freed the
  // slot) so the pool can never get permanently stuck thinking every slot is
  // full. Runs once per tick, is a no-op when the pool is empty, and skips
  // instances already at zero (nothing to correct downward). Each instance is
  // handled in isolation: one unreachable instance never breaks the tick.
  async reconcile(): Promise<void> {
    const { redis, workspaceId, getToken } = this.config;

    const raw = await redis.hgetall(keys.pool(workspaceId));
    const entries = Object.entries(raw);
    if (entries.length === 0) return; // empty pool — nothing to reconcile

    for (const [instanceId, instanceJson] of entries) {
      try {
        let record: EncoreInstanceRecord;
        try {
          record = JSON.parse(instanceJson) as EncoreInstanceRecord;
        } catch {
          continue; // corrupt entry — leave it for the loop to skip elsewhere
        }
        // Nothing to correct downward on an already-idle instance.
        if (record.activeJobs === 0) continue;

        const token = await getToken();
        const url =
          `${record.url.replace(/\/$/, '')}` +
          `/encoreJobs/search/findByStatus?status=IN_PROGRESS&page=0&size=100`;
        const res = await fetch(url, {
          headers: { authorization: `Bearer ${token}` }
        });
        if (!res.ok) continue;

        const body = (await res.json().catch(() => ({}))) as {
          page?: { totalElements?: number };
        };
        const actualCount = body.page?.totalElements;
        if (typeof actualCount !== 'number') continue;

        if (record.activeJobs !== actualCount) {
          // eslint-disable-next-line no-console
          console.warn(
            `[encore-scaler] reconcile: correcting stale activeJobs for instance ${instanceId}: ` +
              `tracked=${record.activeJobs} actual=${actualCount}`
          );
          record.activeJobs = actualCount;
          // Do NOT update lastIdleAt here. The idle clock must only advance when
          // the callback poller confirms the completion (via decrementActiveJobs).
          // Setting lastIdleAt during reconciliation would start the teardown
          // countdown before the poller has had a chance to process the message,
          // causing the instance to be destroyed while the poller is still
          // fetching from it.
          await redis.hset(
            keys.pool(workspaceId),
            instanceId,
            JSON.stringify(record)
          );
        }
      } catch {
        // Swallow per-instance errors so one unreachable instance does not
        // break reconciliation (or the tick) for the rest of the pool.
        continue;
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
    const { redis, workspaceId, getToken, onDispatched } = this.config;
    try {
      const token = await getToken();
      // Inject the paired callback listener URL so Encore POSTs progress to the
      // listener bound to this exact instance (ADR-006).
      const payload = { ...job.payload };
      if (inst.callbackListenerUrl) {
        payload['progressCallbackUri'] = `${inst.callbackListenerUrl.replace(/\/$/, '')}/encoreCallback`;
      }
      const res = await fetch(`${inst.url.replace(/\/$/, '')}/encoreJobs`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${token}`
        },
        body: JSON.stringify(payload)
      });
      if (!res.ok) return false;

      // Capture the Encore-assigned UUID so the packaging step can construct a
      // valid encoreJobs/{uuid} URL. We store it separately (not in our Job table,
      // which is only updated via the callback path) with a 24h TTL.
      const body = await res.json().catch(() => ({})) as { id?: string; jobId?: string };
      const encoreUuid = String(body.id ?? body.jobId ?? '');
      await redis.hset(keys.jobInstance(workspaceId), job.jobId, inst.instanceId);
      await redis.hset(keys.jobStatus(workspaceId), job.jobId, 'running');
      if (encoreUuid && encoreUuid !== job.jobId) {
        await redis.set(keys.jobUuid(job.jobId), encoreUuid, 'EX', 86_400);
        // Reverse: lets the callback poller resolve externalId from the Encore
        // UUID delivered by the callback listener (which always uses its own
        // configured Encore URL, not the scaler-managed instance URL).
        await redis.set(keys.uuidToExternalId(encoreUuid), job.jobId, 'EX', 86_400);
      }

      // The job has now actually left the local queue and is running on an
      // Encore instance: advance the Job record from `queued` to `running`.
      // Best-effort so a repo failure never causes the caller to re-queue an
      // already-dispatched job.
      if (onDispatched) {
        try {
          await onDispatched(job.jobId);
        } catch {
          // Swallowed: dispatch itself succeeded.
        }
      }
      return true;
    } catch {
      return false;
    }
  }
}
