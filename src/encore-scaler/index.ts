// Encore auto-scaler public surface.
//
// makeScalingEncoreClient returns an object implementing the existing
// EncoreClient interface (src/pipeline/encore-client.ts) so transcode.ts keeps
// working unchanged: instead of POSTing to a single Encore instance, submit()
// enqueues the job to the scaler's Valkey buffer and getJobStatus() reads the
// status the scaler records.

import { keys, type EncoreScalerConfig, type QueuedJob } from './types.js';
import { toEncorePayload, type EncoreClient } from '../pipeline/encore-client.js';
import {
  resolveDependencyTimeoutMs,
  sanitizeEndpoint,
  withDependencyTimeout
} from './dependency-timeout.js';
import { assertUnderJobThroughputCap } from './job-throughput-cap.js';
import { resolveEncoreCancelUrl } from './cancel-target.js';

// Per-request bound (ms) on the outbound Encore cancel POST. The cancel is
// issued inside the operator's synchronous DELETE /jobs/:id request and the peer
// may be a frozen Encore instance, so it needs its own ceiling rather than
// Node's default (none). Sized like the callback probe's per-request bound
// (DEFAULT_PROBE_REQUEST_TIMEOUT_MS, src/encore-scaler/callback-trust-probe.ts):
// cancel is a control-plane POST, not a transfer.
const CANCEL_REQUEST_TIMEOUT_MS = 5_000;

export { EncoreScalerLoop } from './scaler-loop.js';
export { encoreScalerRouter } from './encore-scaler-router.js';
export type { EncoreScalerConfig } from './types.js';

// Build an EncoreClient that submits to the local scaler queue. The correlation
// key is the caller's externalId (encodeEncoreJobId), which is also the id the
// scaler tracks in its status/instance hashes and echoes back to the caller.
export function makeScalingEncoreClient(config: EncoreScalerConfig): EncoreClient {
  const { redis, workspaceId } = config;
  // Endpoint shown in the fail-fast error/log — credentials stripped (#616).
  const queueEndpoint = sanitizeEndpoint(config.redisUrl);
  const dependencyTimeoutMs = resolveDependencyTimeoutMs();
  return {
    async submit(input) {
      // Optional operator-configured job-throughput cap (issue #580): reject the
      // submission up front with a 429 (JobThroughputCapExceededError) when
      // accepting one more job would exceed the configured ceiling, instead of
      // silently growing an unbounded backlog. Checked BEFORE the enqueue writes,
      // against the scaler's own Valkey queue/inflight state (single source of
      // truth — no parallel counter). No-op when config.maxQueuedJobs is unset.
      await assertUnderJobThroughputCap(redis, workspaceId, config.maxQueuedJobs);

      const payload = toEncorePayload(input);
      const job: QueuedJob = {
        jobId: input.externalId,
        payload,
        enqueuedAt: Date.now()
      };
      // Bound the outbound Valkey writes on the transcode submit path (#616).
      // The shared IORedis client is `lazyConnect` with `maxRetriesPerRequest:
      // null` (src/main.ts:744), so a command issued while Valkey is unreachable
      // is buffered offline and never rejects — the request would otherwise hang
      // until the inbound socket is dropped (~50s) with no response. A bounded
      // deadline turns that silent hang into a prompt, named DependencyUnreachable
      // error the route maps to a 504 (see routes/assets.ts, routes/encore-compat.ts).
      await withDependencyTimeout(
        () => redis.lpush(keys.queue(workspaceId), JSON.stringify(job)),
        {
          dependency: 'queue',
          endpoint: queueEndpoint,
          stackName: workspaceId,
          operation: `lpush ${keys.queue(workspaceId)}`,
          timeoutMs: dependencyTimeoutMs
        }
      );
      await withDependencyTimeout(
        () => redis.hset(keys.jobStatus(workspaceId), input.externalId, 'QUEUED'),
        {
          dependency: 'queue',
          endpoint: queueEndpoint,
          stackName: workspaceId,
          operation: `hset ${keys.jobStatus(workspaceId)}`,
          timeoutMs: dependencyTimeoutMs
        }
      );
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
      // The scaler tracks a job by our externalId (== encoreJobId here). A job
      // may simultaneously have (i) one or MORE buffered queue entries and (ii)
      // a dispatched Encore job — the two are not mutually exclusive, because a
      // transport-class retry (#295) re-enqueues the same externalId while an
      // earlier attempt may already be dispatched. So we ALWAYS drain every
      // queue entry first, then, if the job was dispatched, POST the real Encore
      // cancel on its instance. Draining only when undispatched (or removing a
      // single entry) leaves orphaned duplicates that the loop would later
      // dispatch with nobody listening for completion (#746).

      // (1) Drain EVERY buffered queue entry for this job. Reading the list once
      // and issuing `lrem(..., 0, entry)` per DISTINCT matching entry value
      // removes all occurrences (queue entries differ by `enqueuedAt`, so
      // duplicates are not byte-identical). Idempotent: a re-run finds nothing.
      const buffered = await redis.lrange(keys.queue(workspaceId), 0, -1);
      for (const entry of buffered) {
        try {
          const parsed = JSON.parse(entry) as { jobId?: string };
          if (parsed.jobId === encoreJobId) {
            // count 0 => remove ALL occurrences equal to this entry value.
            await redis.lrem(keys.queue(workspaceId), 0, entry);
          }
        } catch {
          // Skip unparseable entries.
        }
      }

      // (2) If the job was dispatched, POST the real Encore cancel endpoint for
      // the job URL it was dispatched to.
      //   POST {instanceUrl}/encoreJobs/{uuid}/cancel — SVT Encore
      //   EncoreController.kt (github.com/svt/encore, verified 2026-07-09).
      //   404/409 are idempotent no-ops (job already gone/terminal).
      //
      // #1219: resolution goes through resolveEncoreCancelUrl, which prefers the
      // dispatch-time URL (keys.jobEncoreUrl, 24h TTL) and only then falls back
      // to UUID + instance. Resolving from the LIVE keys.jobInstance mapping and
      // keys.pool alone — as this path used to — silently POSTs nothing for any
      // job whose live mapping has been cleared (success, scale-down/transport
      // re-enqueue, dropped-job handling) or whose instance has left the pool,
      // and step (3) below then records CANCELLED while the job keeps running on
      // Encore. That is the defect #1219 reports: Videocore shows CANCELLED,
      // Encore shows IN_PROGRESS. See src/encore-scaler/cancel-target.ts.
      const encoreJobUrl = await resolveEncoreCancelUrl(redis, workspaceId, encoreJobId);

      // A cancel that could not be DELIVERED must not be reported as a cancel
      // (#1219): the whole complaint is Videocore claiming CANCELLED for a job
      // still running on Encore. So the failure is held, the local terminal
      // status is still recorded in step (3) (nothing may re-dispatch a job the
      // operator cancelled), and the error is then surfaced to the caller.
      let deliveryError: unknown;
      if (encoreJobUrl) {
        try {
          const token = await config.getToken();
          const res = await fetch(`${encoreJobUrl.replace(/\/+$/, '')}/cancel`, {
            method: 'POST',
            headers: { authorization: `Bearer ${token}` },
            // Bound the outbound call: a frozen Encore instance (the #1219 state)
            // is exactly the peer that can accept a connection and never answer,
            // and this call is awaited by the operator's DELETE /jobs/:id request.
            signal: AbortSignal.timeout(CANCEL_REQUEST_TIMEOUT_MS)
          });
          // 404/409 = already gone/terminal: idempotent no-op. Only surface other
          // non-ok statuses.
          if (!res.ok && res.status !== 404 && res.status !== 409) {
            const text = await res.text().catch(() => '');
            throw new Error(`Encore job cancellation failed: ${res.status} ${text}`.trim());
          }
        } catch (err) {
          deliveryError = err;
        }
      }

      // (3) Record the terminal CANCELLED status so getJobStatus reports 'failed'.
      await redis.hset(keys.jobStatus(workspaceId), encoreJobId, 'CANCELLED');

      if (deliveryError) throw deliveryError;
    }
  };
}
