// Encore completion callback poller.
//
// The system uses eyevinn-encore-callback-listener as a cloud intermediary:
// Encore POSTs its completion webhook there, and the listener writes a message
// to a Redis sorted set (ZADD, score = Date.now()) on the queue key (default
// "packaging-queue"). The message is:
//   { jobId: "<encore-internal-uuid>", url: "<encoreInstanceUrl>/encoreJobs/<uuid>" }
//   (verified from eyevinn-encore-callback-listener source, 2026-07-07)
//
// Our API also exposes POST /api/v1/internal/encore-callback, but that route is
// only reachable when the API is deployed publicly. Locally it is never called.
// This poller closes that gap: it drains the same Redis sorted set the listener
// writes to, fetches the Encore job document over HTTP (authenticated with an
// OSC service access token for "encore"), and runs the SAME completion +
// pipeline-advancement logic the internal route runs.
//
// Contract sources verified before writing (CLAUDE.md rule 7):
//   - ioredis Redis.bzpopmin(key, timeout): Promise<[key, member, score] | null>
//     (ioredis built-in command binding).
//   - Context.getServiceAccessToken(serviceId): Promise<string>
//     (@osaas/client-core lib/context.d.ts:25).
//   - Encore job document fields externalId/status/output — src/routes/internal.ts
//     encoreCallbackSchema (SMOKE TEST CONFIRMED 2026-06-01).
//   - completeTranscode signature — src/pipeline/transcode.ts:138.
//   - JobRepository.findByEncoreJobId — src/data/job-repo.ts:129 (workspace-scoped
//     via PerWorkspaceJobRepository, which decodes the {workspaceId}__{jobId}
//     externalId — src/data/per-workspace-repos.ts:92).

import type { Redis } from 'ioredis';
import type { Context } from '@osaas/client-core';
import type { JobRepository } from '../data/job-repo.js';
import type { AssetRepository } from '../data/asset-repo.js';
import type { PipelineRepository, StepExecution } from '../data/pipeline-repo.js';
import type { PackagingService } from './packaging.js';
import { completeTranscode, type CallbackRendition } from './transcode.js';
import { decodeEncoreJobId } from '../data/job-repo.js';
import { keys, type EncoreInstanceRecord } from '../encore-scaler/types.js';

// Resolve the correct Encore job API URL using the reverse UUID mapping stored
// at dispatch time. The callback listener always uses its own configured Encore
// instance URL, which differs from the scaler-managed instance that actually ran
// the job. We look up the real instance URL from the Redis pool instead.
async function resolveUrlFromEncoreUuid(
  encoreUuid: string,
  redis: Redis
): Promise<string | undefined> {
  const externalId = await redis.get(keys.uuidToExternalId(encoreUuid));
  if (!externalId) return undefined;
  return resolveEncoreJobUrl(externalId, redis);
}

const DEFAULT_QUEUE_KEY = 'packaging-queue';
const BZPOPMIN_TIMEOUT_SECONDS = 5;

type Logger = {
  info(...a: any[]): void;
  warn(...a: any[]): void;
  error(...a: any[]): void;
};

type PollerDeps = {
  redis: Redis;
  jobRepository: JobRepository;
  assetRepository: AssetRepository;
  pipelineRepository?: PipelineRepository;
  packaging?: PackagingService;
  oscContext: Context;
  queueKey?: string;
  logger: Logger;
};

// A produced Encore output entry (subset — matches the internal route schema).
type EncoreOutput = {
  file?: string;
  type?: string;
  videoStreams?: Array<{ width?: number; height?: number }>;
  overallBitrate?: number;
};

// Are all steps of an execution terminal (done)? Mirrors the internal route.
function allStepsDone(steps: StepExecution[]): boolean {
  return steps.every((s) => s.status === 'done');
}

// Normalise Encore `output` to renditions. Identical to normaliseRenditions in
// src/routes/internal.ts — kept in sync deliberately (the route's copy is bound
// to its Zod-inferred type and can't be shared without a refactor).
function normaliseRenditions(output: EncoreOutput[] | undefined): CallbackRendition[] {
  if (!output) return [];
  const videoFiles = output.filter((o) => !o.type || o.type === 'VideoFile');
  return videoFiles.map((o, i) => {
    const stream = o.videoStreams?.[0];
    return {
      label: `rendition-${i + 1}`,
      width: stream?.width ?? 0,
      height: stream?.height ?? 0,
      objectKey: o.file ?? `rendition-${i + 1}`,
      bitrateBps: o.overallBitrate
    };
  });
}

// Build the Encore job API URL for packaging by looking up the instance URL +
// Encore UUID from the scaler's Redis pool. Mirrors resolveEncoreJobUrl in
// src/routes/internal.ts.
async function resolveEncoreJobUrl(
  encoreJobId: string,
  redis: Redis
): Promise<string | undefined> {
  const decoded = decodeEncoreJobId(encoreJobId);
  if (!decoded) return undefined;
  const { workspaceId } = decoded;
  const instanceId = await redis.hget(keys.jobInstance(workspaceId), encoreJobId);
  if (!instanceId) return undefined;
  const [instanceJson, encoreUuid] = await Promise.all([
    redis.hget(keys.pool(workspaceId), instanceId),
    redis.get(keys.jobUuid(encoreJobId))
  ]);
  if (!instanceJson || !encoreUuid) return undefined;
  try {
    const record = JSON.parse(instanceJson) as EncoreInstanceRecord;
    return `${record.url.replace(/\/+$/, '')}/encoreJobs/${encoreUuid}`;
  } catch {
    return undefined;
  }
}

// Decrement the running instance's activeJobs after a job completes. Mirrors in
// reverse the increment path in scaler-loop.dispatch(): the pool hash is the
// durable source of truth, so we read-modify-write the JSON EncoreInstanceRecord.
// Best-effort: any failure is swallowed so completion handling is never blocked.
async function decrementActiveJobs(
  redis: Redis,
  encoreJobId: string,
  logger: Logger
): Promise<void> {
  try {
    const decoded = decodeEncoreJobId(encoreJobId);
    if (!decoded) return;
    const { workspaceId } = decoded;
    const instanceId = await redis.hget(keys.jobInstance(workspaceId), encoreJobId);
    if (!instanceId) return;
    const instanceJson = await redis.hget(keys.pool(workspaceId), instanceId);
    if (!instanceJson) return;
    const record = JSON.parse(instanceJson) as EncoreInstanceRecord;
    record.activeJobs = Math.max(0, record.activeJobs - 1);
    if (record.activeJobs === 0) {
      record.lastIdleAt = Date.now();
    }
    await redis.hset(keys.pool(workspaceId), instanceId, JSON.stringify(record));
  } catch (err) {
    logger.warn({ msg: 'encore-callback-poller: failed to decrement activeJobs', encoreJobId, err });
  }
}

// Process one queue message: fetch the Encore job, resolve our job, complete the
// transcode, and advance the matching PipelineExecution.
//
// Throws on retryable failures (network errors, non-2xx Encore fetch, DB write
// errors) so the outer loop can re-queue the message and retry. Non-retryable
// cases (unparseable message, unknown externalId) log and return cleanly so the
// message is dropped rather than looped forever.
async function handleMessage(deps: PollerDeps, raw: string): Promise<void> {
  let message: { jobId?: string; url?: string };
  try {
    message = JSON.parse(raw);
  } catch (err) {
    // Unparseable: dropping is correct — retrying will never fix a corrupt message.
    deps.logger.warn({ msg: 'encore-callback-poller: unparseable queue message — dropping', raw, err });
    return;
  }

  // Prefer resolving the Encore job URL from our Redis pool mapping — the URL
  // embedded by the callback listener always points at its own configured Encore
  // instance, which may differ from the scaler-managed instance that ran the job.
  const encoreUuid = message.jobId;
  deps.logger.info({ msg: 'encore-callback-poller: processing message', encoreUuid, url: message.url });

  // Throws if OSC token fetch fails — caller will catch and re-queue.
  const sat = await deps.oscContext.getServiceAccessToken('encore');

  let resolvedUrl: string | undefined;
  if (encoreUuid) {
    resolvedUrl = await resolveUrlFromEncoreUuid(encoreUuid, deps.redis);
    deps.logger.info({ msg: 'encore-callback-poller: resolved url from redis', encoreUuid, resolvedUrl });
  }
  // Fall back to message.url (e.g. non-scaler deployments or missing mapping).
  const url = resolvedUrl ?? message.url;
  if (!url) {
    // No URL and no mapping: can't retry usefully — drop.
    deps.logger.warn({ msg: 'encore-callback-poller: queue message has no url — dropping', message });
    return;
  }

  // Fetch the Encore job document, authenticated with an OSC SAT for "encore".
  // The instance may be suspended (503) if the scaler tore it down before the
  // poller ran. Retry up to 3 times with brief backoff. If all attempts fail we
  // still know the job succeeded (the callback listener only fires on SUCCESSFUL),
  // so we complete it with empty renditions rather than leaving it stuck.
  let job: { externalId?: string; status?: string; message?: string; output?: EncoreOutput[] } | undefined;
  for (let attempt = 1; attempt <= 3; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${sat}` } });
    if (res.ok) {
      job = (await res.json()) as typeof job;
      break;
    }
    deps.logger.warn({ msg: 'encore-callback-poller: failed to fetch encore job', url, status: res.status, attempt });
    if (attempt < 3) await new Promise((r) => setTimeout(r, attempt * 2_000));
  }
  // If Encore is unreachable after retries, complete as SUCCESSFUL with no
  // renditions. The callback listener only enqueues on success, so we trust it.
  if (!job) {
    deps.logger.warn({ msg: 'encore-callback-poller: encore unreachable after retries — completing as successful with no renditions', url, encoreUuid });
    job = { externalId: encoreUuid ? (await deps.redis.get(`encore:uuid-ext:${encoreUuid}`)) ?? undefined : undefined, status: 'SUCCESSFUL', output: [] };
  }

  const externalId = job.externalId;
  const status = job.status;
  if (!externalId || !status) {
    // Corrupt Encore response — dropping, retrying won't fix it.
    deps.logger.warn({ msg: 'encore-callback-poller: encore job missing externalId/status — dropping', url });
    return;
  }

  deps.logger.info({ msg: 'encore-callback-poller: fetched encore job', externalId, status });

  const found = await deps.jobRepository.findByEncoreJobId(externalId);
  if (!found) {
    // Unknown externalId — could be from another deployment sharing the queue. Drop.
    deps.logger.info({ msg: 'encore-callback-poller: no local job for externalId — dropping', externalId });
    return;
  }

  deps.logger.info({ msg: 'encore-callback-poller: completing transcode', jobId: found.job.id, externalId, status });

  const upper = status.toUpperCase();
  const success = upper === 'SUCCESSFUL' || upper === 'SUCCESS';
  // completeTranscode touches CouchDB — let any throw propagate so the outer
  // loop re-queues and retries on transient DB errors.
  const result = await completeTranscode(
    {
      jobId: found.job.id,
      sourceAssetId: found.job.assetId,
      success,
      error: success ? undefined : (job.message ?? `encore status: ${status}`),
      renditions: success ? normaliseRenditions(job.output) : []
    },
    { jobs: deps.jobRepository, assets: deps.assetRepository }
  );

  // Free the slot on the Encore instance that ran this job so the scaler can
  // reuse its capacity. Only on a terminal completion that actually applied.
  if (result.applied) {
    await decrementActiveJobs(deps.redis, externalId, deps.logger);
  }

  // Advance the matching PipelineExecution — copied from src/routes/internal.ts
  // (the encore-callback handler). It can't be shared without a refactor.
  if (result.applied && deps.pipelineRepository) {
    const execution = await deps.pipelineRepository.findRunningByAssetAndStep(
      found.job.assetId,
      'transcode'
    );
    if (execution && execution.steps.some((s) => s.name === 'transcode' && s.encoreJobId === externalId)) {
      const now = new Date().toISOString();
      const steps: StepExecution[] = execution.steps.map((s) => ({ ...s }));
      const tIdx = steps.findIndex((s) => s.name === 'transcode' && s.encoreJobId === externalId);

      if (!success) {
        steps[tIdx] = {
          ...steps[tIdx],
          status: 'failed',
          error: job.message ?? `encore status: ${status}`,
          completedAt: now
        };
        await deps.pipelineRepository.update(execution.id, { steps, status: 'failed' });
      } else {
        steps[tIdx] = { ...steps[tIdx], status: 'done', completedAt: now };
        const nextIdx = steps.findIndex((s) => s.status === 'pending');
        if (nextIdx >= 0 && steps[nextIdx].name === 'package' && deps.packaging) {
          const encoreJobUrl = await resolveEncoreJobUrl(externalId, deps.redis);
          if (encoreJobUrl) {
            steps[nextIdx] = { ...steps[nextIdx], status: 'running', startedAt: now };
            await deps.pipelineRepository.update(execution.id, { steps, status: 'running' });
            void deps.packaging.triggerPackaging(found.job.assetId, encoreJobUrl);
          } else {
            steps[nextIdx] = {
              ...steps[nextIdx],
              status: 'failed',
              error: 'Encore instance no longer available for packaging',
              completedAt: now
            };
            await deps.pipelineRepository.update(execution.id, { steps, status: 'failed' });
          }
        } else {
          await deps.pipelineRepository.update(execution.id, {
            steps,
            status: allStepsDone(steps) ? 'done' : 'running'
          });
        }
      }
    }
  }

  deps.logger.info({
    msg: 'encore-callback-poller: applied encore completion',
    externalId,
    status,
    applied: result.applied,
    renditionCount: result.renditionCount
  });
}

// Two-phase processing: messages move from the main queue to a processing set
// before handleMessage runs, and are only removed from processing on success.
// On any failure the message is returned to the main queue so it is retried on
// the next iteration. On startup, leftover entries in the processing set (from a
// crash or hot-reload kill) are recovered back to the main queue automatically.
//
// Sorted-set operations used (ioredis bindings, verified against ioredis docs):
//   BZPOPMIN key timeout  → [key, member, score] | null
//   ZADD key score member → number (added/updated count)
//   ZREM key member       → number (removed count)
//   ZRANGEBYSCORE key min max → string[]

async function recoverProcessingQueue(
  redis: Redis,
  queueKey: string,
  processingKey: string,
  logger: Logger
): Promise<void> {
  // Any message left in the processing set did not complete in a prior run.
  // Move them all back to the main queue so they are retried.
  const stuck = await redis.zrangebyscore(processingKey, '-inf', '+inf', 'WITHSCORES');
  // WITHSCORES returns [member, score, member, score, ...].
  for (let i = 0; i < stuck.length; i += 2) {
    const member = stuck[i];
    const score = Number(stuck[i + 1]);
    await redis.zadd(queueKey, score, member);
    await redis.zrem(processingKey, member);
    logger.info({ msg: 'encore-callback-poller: recovered stuck message from processing set', member });
  }
}

// Start the background poller loop. Returns a stop() function that aborts the
// loop after the in-flight BZPOPMIN times out (up to BZPOPMIN_TIMEOUT_SECONDS).
export function startEncoreCallbackPoller(deps: PollerDeps): () => void {
  const queueKey = deps.queueKey ?? DEFAULT_QUEUE_KEY;
  const processingKey = `${queueKey}:processing`;
  const controller = new AbortController();
  const { signal } = controller;

  deps.logger.info({ msg: 'encore-callback-poller: starting', queueKey, processingKey });

  const loop = async (): Promise<void> => {
    // On startup, recover any messages left in the processing set from a prior
    // crashed or hot-reloaded process before entering the main loop.
    await recoverProcessingQueue(deps.redis, queueKey, processingKey, deps.logger).catch((err) => {
      deps.logger.warn({ msg: 'encore-callback-poller: recovery scan failed', err });
    });

    while (!signal.aborted) {
      let raw: string | undefined;
      let score: number | undefined;
      try {
        // BZPOPMIN blocks up to the timeout, then returns null so the loop can
        // check the abort signal and remain cancellable.
        const popped = await deps.redis.bzpopmin(queueKey, BZPOPMIN_TIMEOUT_SECONDS);
        if (signal.aborted) break;
        if (!popped) continue;
        // bzpopmin returns [key, member, score]; the member is our JSON message.
        raw = popped[1];
        score = Number(popped[2]);

        // Phase 1: move message to the processing set before doing any work.
        // If the process dies after this point, recoverProcessingQueue re-queues
        // it on the next startup.
        await deps.redis.zadd(processingKey, score, raw);

        await handleMessage(deps, raw);

        // Phase 2: processing succeeded — remove from the processing set.
        await deps.redis.zrem(processingKey, raw);
      } catch (err) {
        deps.logger.error({ msg: 'encore-callback-poller: loop error', err });
        // Return the message to the main queue so it is retried, then back off.
        if (raw !== undefined && score !== undefined) {
          await deps.redis.zadd(queueKey, score, raw).catch(() => {});
          await deps.redis.zrem(processingKey, raw).catch(() => {});
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    deps.logger.info({ msg: 'encore-callback-poller: stopped', queueKey });
  };

  void loop();

  return () => controller.abort();
}
