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
import { recordDispatch } from './retry-store.js';
import { probeCallbackTrust } from './callback-trust-probe.js';

// Default bounded wait for the outbound callback-listener TLS-trust probe
// (issue #463) when EncoreScalerConfig.callbackTrustTimeoutMs is unset.
export const DEFAULT_CALLBACK_TRUST_TIMEOUT_MS = 60_000;

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
        .catch((err) => {
          // A tick failure must not kill the interval; the next tick retries.
          // Log so spawn/dispatch errors are visible rather than silently lost.
          console.error('[encore-scaler] tick error (workspace=%s):', this.config.workspaceId, err);
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

    // 0b. Reconcile transcode jobs stuck in a non-terminal state against
    //     Encore's terminal FAILED / garbage-collected (404) outcomes (#273).
    //     A failed Encore job never produces a completion message (the callback
    //     listener only enqueues SUCCESSFUL jobs), so without this sweep the
    //     VideoCore job stays `running` and its asset `processing` forever. The
    //     sweep is repo-driven and lives in main.ts (the scaler owns no repos),
    //     wired via this callback. Best-effort: a sweep failure must never break
    //     the tick's scaling/dispatch work.
    if (this.config.reconcileFailedTranscodes) {
      try {
        await this.config.reconcileFailedTranscodes();
      } catch (err) {
        console.error(
          '[encore-scaler] failed-transcode reconcile error (workspace=%s):',
          this.config.workspaceId,
          err
        );
      }
    }

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
      // Gate first-job dispatch on confirmed outbound TLS trust to the paired
      // callback-listener ingress (issue #463). An instance that has never been
      // probed is NOT eligible for its first job until the probe passes; an
      // instance that has already passed once (callbackTrustReady) skips this
      // entirely, so warm instances incur no added latency. A quarantined
      // instance is never dispatched to. This never throws into the tick: a
      // probe failure keeps the job in the queue for a later tick.
      if (!(await this.ensureCallbackTrust(inst))) {
        continue; // not eligible this tick — leave its capacity unused
      }
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

        // Honour a retry backoff (#295): a job re-queued after a transport-class
        // failure carries a `notBefore` timestamp. If it is not yet due, return
        // it to the queue untouched and stop feeding this instance this tick —
        // the next tick will re-evaluate. This keeps the loop non-blocking while
        // still spacing out re-dispatches.
        if (job.notBefore && job.notBefore > Date.now()) {
          await redis.lrem(keys.inflight(workspaceId), 1, claimed);
          await redis.rpush(keys.queue(workspaceId), claimed);
          break;
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

    // Accumulate the externalIds (our encoreJobId) of jobs this reconcile
    // observes as silently dropped — tracked as running against an instance but
    // no longer present in that instance's live QUEUED/IN_PROGRESS set with no
    // completion callback (issue #449, ADR-016 Direction 2). The scaler owns no
    // repositories, so it only raises the signal via onJobsDropped; the terminal
    // write is owned by the reconciler/main.ts repo layer.
    const droppedJobIds: string[] = [];

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
        const base = record.url.replace(/\/$/, '');
        // Fetch both QUEUED and IN_PROGRESS job documents (not just counts) — a
        // freshly dispatched job sits in QUEUED until Encore picks it up, so
        // counting only IN_PROGRESS would make the instance look idle
        // immediately after dispatch and trigger a spurious scale-up on the next
        // tick. We request the documents (size=100) rather than size=1 so we can
        // read each active job's externalId and thereby tell WHICH tracked jobs
        // (if any) have silently vanished — the dropped-job signal for #449.
        // Contract: Encore /encoreJobs/search/findByStatus returns Spring
        // HATEOAS pages { _embedded: { encoreJobs: [{ id, externalId, ... }] },
        // page: { totalElements: N } } (verified in
        // encore-callback-poller.ts:505-508, SVT Encore, 2026-07-07).
        const [resQ, resP] = await Promise.all([
          fetch(`${base}/encoreJobs/search/findByStatus?status=QUEUED&page=0&size=100`, {
            headers: { authorization: `Bearer ${token}` }
          }),
          fetch(`${base}/encoreJobs/search/findByStatus?status=IN_PROGRESS&page=0&size=100`, {
            headers: { authorization: `Bearer ${token}` }
          })
        ]);
        if (!resQ.ok || !resP.ok) continue;

        type EncoreJobPage = {
          _embedded?: { encoreJobs?: Array<{ externalId?: string }> };
          page?: { totalElements?: number };
        };
        const [bodyQ, bodyP] = await Promise.all([
          resQ.json().catch(() => ({})) as Promise<EncoreJobPage>,
          resP.json().catch(() => ({})) as Promise<EncoreJobPage>
        ]);
        const queuedCount = bodyQ.page?.totalElements;
        const inProgressCount = bodyP.page?.totalElements;
        if (typeof queuedCount !== 'number' || typeof inProgressCount !== 'number') continue;
        const actualCount = queuedCount + inProgressCount;

        if (record.activeJobs !== actualCount) {
          // eslint-disable-next-line no-console
          console.warn(
            `[encore-scaler] reconcile: correcting stale activeJobs for instance ${instanceId}: ` +
              `tracked=${record.activeJobs} actual=${actualCount}`
          );

          // tracked > actual is the silently-dropped signal (ADR-016): a job we
          // think is running has left Encore's active set with no completion.
          // Resolve exactly which of our jobs vanished by diffing the jobs we
          // track against this instance (jobInstance hash, written at dispatch,
          // scaler-loop.ts:290) — restricted to those still marked `running`
          // (jobStatus hash, scaler-loop.ts:291) — against the externalIds
          // Encore still reports active. Anything tracked-running for this
          // instance that Encore no longer lists is dropped.
          if (actualCount < record.activeJobs) {
            const activeExternalIds = new Set<string>();
            for (const j of bodyQ._embedded?.encoreJobs ?? []) {
              if (j.externalId) activeExternalIds.add(j.externalId);
            }
            for (const j of bodyP._embedded?.encoreJobs ?? []) {
              if (j.externalId) activeExternalIds.add(j.externalId);
            }

            const trackedInstances = await redis.hgetall(keys.jobInstance(workspaceId));
            const trackedStatuses = await redis.hgetall(keys.jobStatus(workspaceId));
            for (const [jobId, mappedInstanceId] of Object.entries(trackedInstances)) {
              if (mappedInstanceId !== instanceId) continue;
              // Only jobs still locally marked running are candidates; a job the
              // callback poller / cancel already settled has a terminal status.
              const st = (trackedStatuses[jobId] ?? '').toUpperCase();
              if (st !== 'RUNNING' && st !== 'QUEUED') continue;
              if (activeExternalIds.has(jobId)) continue; // still live on Encore
              droppedJobIds.push(jobId);
              // Overwrite the stale Valkey status (written `running` at dispatch,
              // scaler-loop.ts:291) so a subsequent makeScalingEncoreClient
              // getJobStatus (index.ts:41) agrees with the durable job record and
              // does not re-report `running` (ADR-016 Point 3).
              await redis.hset(keys.jobStatus(workspaceId), jobId, 'FAILED');
            }
          }

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

    // Raise the dropped-job signal (issue #449, ADR-016). The scaler owns no
    // repositories, so main.ts wires onJobsDropped to drive each id to a
    // terminal `failed` state through the shared idempotent settle path.
    // Best-effort: a hook failure must never break the tick, exactly as the
    // other repo-bridge hooks are treated (scaler-loop.ts:341-347).
    if (droppedJobIds.length > 0 && this.config.onJobsDropped) {
      try {
        await this.config.onJobsDropped(droppedJobIds);
      } catch (err) {
        console.error(
          '[encore-scaler] onJobsDropped error (workspace=%s):',
          workspaceId,
          err
        );
      }
    }
  }

  // First-job readiness gate (issue #463): confirm this instance's OUTBOUND TLS
  // trust path to its per-instance callback-listener ingress is established
  // before the instance is marked eligible for its first job. Returns true when
  // the instance may receive jobs this tick, false when it must be skipped.
  //
  // Idempotency / no added latency for warm instances:
  //   - callbackTrustReady === true  -> already confirmed, return true, no probe.
  //   - callbackTrustQuarantinedAt set -> previously timed out, skip (false).
  //   - callbackListenerUrl undefined -> nothing to probe against (e.g. an
  //     instance re-discovered from OSC where the listener URL is unknown, see
  //     instance-pool.ts:135-137). Fail open: allow dispatch as before so this
  //     gate never regresses the reconcile-from-OSC path.
  //
  // The gate is a bounded WAIT across re-probes, not a single shot (issue #463).
  // The tick loop re-invokes this each tick, so we probe again on later ticks:
  //   - On success the record is stamped callbackTrustReady=true and persisted
  //     so no future tick re-probes.
  //   - A probe failure (tls-trust, connection, OR timeout) while still inside
  //     the bounded window is NOT quarantining — we return false (ineligible
  //     this tick) so a later tick re-probes. This lets the transient PKIX race
  //     (the ingress cert becomes trusted ~35s after spawn) resolve instead of
  //     permanently sidelining an instance on an early fast-fail PKIX error.
  //   - Only once the elapsed time since the FIRST probe exceeds the bounded
  //     deadline do we quarantine the instance and emit a structured error
  //     (instanceId + ingress hostname) rather than throw into the tick loop.
  //
  // callbackTrustTimeoutMs plays TWO roles here (intentionally the same value):
  //   1. the per-probe AbortSignal window for a single HTTPS handshake, and
  //   2. the overall cross-tick bounded-wait deadline measured from the first
  //      probe. A PKIX/handshake failure fast-fails (~1s) and does NOT consume
  //      the AbortSignal window, so the deadline is what actually bounds the
  //      wait across re-probes.
  private async ensureCallbackTrust(inst: EncoreInstanceRecord): Promise<boolean> {
    if (inst.callbackTrustReady) return true;
    if (inst.callbackTrustQuarantinedAt) return false;
    // No listener URL to probe (reconciled-from-OSC instance): fail open.
    if (!inst.callbackListenerUrl) return true;

    const timeoutMs =
      this.config.callbackTrustTimeoutMs ?? DEFAULT_CALLBACK_TRUST_TIMEOUT_MS;
    let hostname = inst.callbackListenerUrl;
    try {
      hostname = new URL(inst.callbackListenerUrl).hostname;
    } catch {
      // keep the raw URL for logging if it does not parse
    }

    // Stamp (and persist) the first-probe epoch so the bounded-wait deadline
    // survives across ticks and instances reloaded from Valkey.
    if (inst.callbackTrustFirstProbeAt === undefined) {
      inst.callbackTrustFirstProbeAt = Date.now();
      await updateInstance(this.config.redis, this.config.workspaceId, inst);
    }

    const result = await probeCallbackTrust(inst.callbackListenerUrl, timeoutMs);

    if (result.ok) {
      inst.callbackTrustReady = true;
      inst.callbackTrustConfirmedAt = Date.now();
      await updateInstance(this.config.redis, this.config.workspaceId, inst);
      return true;
    }

    // Probe failed. If we are still inside the bounded wait, do NOT quarantine —
    // stay ineligible this tick and let a later tick re-probe so the transient
    // PKIX/handshake race can resolve. This treats tls-trust, connection, and a
    // per-probe timeout identically while the deadline has not been exceeded.
    const elapsedMs = Date.now() - inst.callbackTrustFirstProbeAt;
    if (elapsedMs <= timeoutMs) {
      return false;
    }

    // Bounded wait EXCEEDED: quarantine the instance from job assignment and
    // surface a structured, queryable error (instanceId + ingress hostname). Do
    // NOT throw — keep the tick non-fatal.
    inst.callbackTrustQuarantinedAt = Date.now();
    await updateInstance(this.config.redis, this.config.workspaceId, inst);
    console.error(
      '[encore-scaler] callback-trust bounded wait exceeded — quarantining instance from job assignment',
      {
        workspaceId: this.config.workspaceId,
        instanceId: inst.instanceId,
        callbackIngressHostname: hostname,
        errorClass: result.errorClass,
        detail: result.detail,
        timeoutMs,
        elapsedMs
      }
    );
    return false;
  }

  // POST a queued job's raw Encore payload to a chosen instance and record the
  // job->instance mapping + QUEUED->running status. Returns false on any
  // non-2xx / network error so the caller can re-queue.
  private async dispatch(
    inst: EncoreInstanceRecord,
    job: QueuedJob
  ): Promise<boolean> {
    const { redis, workspaceId, getToken, onDispatched, onEncodeDispatched } = this.config;
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

      // Persist the payload + attempt count so a transport-class failure (#295)
      // can re-dispatch this exact job without the caller re-submitting. A
      // first-time submission has no `attempts` field (treated as 0), so its
      // first dispatch is attempt 1; a re-queued retry carries the prior count.
      // Best-effort: retry bookkeeping must never cause an already-dispatched
      // job to be re-queued as a dispatch failure.
      const attemptNumber = (job.attempts ?? 0) + 1;
      try {
        await recordDispatch(redis, job.jobId, job.payload, attemptNumber);
      } catch {
        // Swallowed: dispatch itself succeeded; the job just loses retry state.
      }

      // Durably capture the encode attempt on the Job record (ADR-012, #380).
      // This mirrors the Valkey counter above but writes to CouchDB via the
      // repo hook, so the attempt history outlives the TTL'd/cleared Valkey key.
      // Best-effort, same rationale as recordDispatch: never fail dispatch here.
      if (onEncodeDispatched) {
        try {
          await onEncodeDispatched(job.jobId, attemptNumber);
        } catch (err) {
          // Best-effort by design (never re-queue an already-dispatched job),
          // but the failure must be OBSERVABLE (issue #451): a silently dropped
          // append left dispatched jobs with attempts:0 and no encodeAttemptLog.
          console.warn(
            '[encore-scaler] dispatch: onEncodeDispatched failed to durably append encode attempt %d for %s:',
            attemptNumber,
            job.jobId,
            err
          );
        }
      }
      if (encoreUuid && encoreUuid !== job.jobId) {
        await redis.set(keys.jobUuid(job.jobId), encoreUuid, 'EX', 86_400);
        // Reverse: lets the callback poller resolve externalId from the Encore
        // UUID delivered by the callback listener (which always uses its own
        // configured Encore URL, not the scaler-managed instance URL).
        await redis.set(keys.uuidToExternalId(encoreUuid), job.jobId, 'EX', 86_400);
        // Store the full Encore job URL at dispatch time so the packaging step
        // can look it up without depending on the instance still being in the
        // pool. The pool record may be gone by the time the transcode callback
        // is processed (e.g. instance scaled down, pool wiped), leading to a
        // misleading "Encore instance no longer available for packaging" error.
        const encoreJobUrl = `${inst.url.replace(/\/+$/, '')}/encoreJobs/${encoreUuid}`;
        await redis.set(keys.jobEncoreUrl(job.jobId), encoreJobUrl, 'EX', 86_400);
      } else {
        // Encore didn't return a usable UUID in the POST response body — log so
        // this is diagnosable. The packaging step will fall back to the pool
        // lookup, which may also fail if the UUID was not captured.
        console.warn('[encore-scaler] dispatch: Encore POST response missing id — UUID key not stored for', job.jobId);
      }

      // The job has now actually left the local queue and is running on an
      // Encore instance: advance the Job record from `queued` to `running`.
      // Best-effort so a repo failure never causes the caller to re-queue an
      // already-dispatched job.
      if (onDispatched) {
        try {
          await onDispatched(job.jobId);
        } catch (err) {
          // Best-effort by design, but observable (issue #451): a dropped
          // queued->running flip must not vanish silently either.
          console.warn(
            '[encore-scaler] dispatch: onDispatched failed to advance job %s to running:',
            job.jobId,
            err
          );
        }
      }
      return true;
    } catch {
      return false;
    }
  }
}
