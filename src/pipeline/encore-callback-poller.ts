// Encore completion callback poller.
//
// The system uses eyevinn-encore-callback-listener as a cloud intermediary:
// Encore POSTs its completion webhook there, and the listener writes a message
// to a Redis sorted set (ZADD, score = Date.now()) on the queue key. Our
// scaler-paired listeners are configured with the dedicated queue
// "ovc:transcode-done" (see DEFAULT_QUEUE_KEY below and instance-pool.ts). The
// message is:
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
import { isStepComplete } from '../data/pipeline-repo.js';
import type { PipelineRepository, StepExecution } from '../data/pipeline-repo.js';
import { completeTranscode, type CallbackRendition } from './transcode.js';
import { decodeEncoreJobId } from '../data/job-repo.js';
import { keys, type EncoreInstanceRecord } from '../encore-scaler/types.js';
import { DEFAULT_RECONCILE_GRACE_MS } from '../encore-scaler/scaler-loop.js';
import { decideRetry, clearRetryState, makePriorAttemptCanceler } from '../encore-scaler/retry-store.js';
import { pinInstanceForPackaging, unpinInstanceForPackaging } from '../encore-scaler/packaging-pin.js';
import { DEFAULT_PACKAGE_STALL_TIMEOUT_MS } from './stalled-package-reconciler.js';

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

// Dedicated queue for our scaler-paired callback listeners. MUST match the
// RedisQueue passed to the callback listener in
// src/encore-scaler/instance-pool.ts spawnInstance(). Using a dedicated key
// (not the shared "packaging-queue") stops an external eyevinn-encore-packager
// from winning the BZPOPMIN race and consuming our completion messages (#93).
const DEFAULT_QUEUE_KEY = 'ovc:transcode-done';
const BZPOPMIN_TIMEOUT_SECONDS = 5;

// The eyevinn-encore-packager's INPUT queue (#94). Must match the RedisQueue
// set on the provisioned packager instance (provision.ts). We use the same key
// as PackagingService / makeOscPackagerQueue ('encore-packager:jobs') so all
// producers target one queue and the provisioned packager need only be told that
// one key. We push the packaging job here (ZADD onto a Redis sorted set) and the
// packager consumes it via BZPOPMIN — the OSC-native transcode->package handoff.
//
// CONTRACT (packager input message shape, verified from encore-packager
// redisListener.ts and osc-packager-queue.ts:9-16):
//   { jobId: string, url: string }
//   - jobId: our correlation id (assetId) — echoed in the packager's
//            /packagerCallback/success payload so the callback resolves the asset.
//   - url:   Encore job API URL the packager fetches output details from.
const DEFAULT_PACKAGING_QUEUE_KEY = 'encore-packager:jobs';

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
  oscContext: Context;
  queueKey?: string;
  // The eyevinn-encore-packager's input queue key (#94). Defaults to
  // "packaging-queue". Overridable so a deployment can point at a differently
  // named packager queue without a code change.
  packagingQueueKey?: string;
  // #464: bounds for the independent reconciliation sweep. All optional; when
  // unset the poller applies the defaults below so behaviour is identical to
  // before these knobs existed. Threaded the same way queueKey/packagingQueueKey
  // are (raw value in, default applied here), so no new config-passing style is
  // introduced. main.ts reads them from ENCORE_SWEEP_* env vars.
  //   sweepIntervalMs   — how often the reconciliation loop runs.
  //   sweepPageSize     — per-instance findByStatus page size (per-cycle fan-out
  //                       bound on jobs pulled from one instance per status).
  //   sweepMaxInstances — optional cap on Encore instances scanned per cycle.
  sweepIntervalMs?: number;
  sweepPageSize?: number;
  sweepMaxInstances?: number;
  // #708: grace window (ms) for reconcile's dropped-job diff. The poller stamps
  // keys.jobCompletionSeen the instant it accepts a completion and gives that key
  // a PX TTL derived from this value, so a reconcile tick that races the
  // activeJobs decrement (observed ~4.4s in production) sees the completion and
  // does NOT re-raise the job as silently dropped. Threaded the same way
  // sweepIntervalMs is (raw value in, default applied at use); main.ts reads it
  // from ENCORE_RECONCILE_GRACE_MS. Unset => DEFAULT_RECONCILE_GRACE_MS so
  // behaviour is unchanged when the env var is absent.
  reconcileGraceMs?: number;
  // #830: minimum interval between two persisted progress writes for the SAME
  // transcode job. The sweep reads Encore's own `progress` off the IN_PROGRESS
  // findByStatus page it already pages through per instance; without a bound,
  // every sweep cycle would issue a CouchDB write per running job. Threaded the
  // same way sweepIntervalMs is (raw value in, default applied at use); main.ts
  // reads it from ENCORE_PROGRESS_WRITE_INTERVAL_MS. Unset =>
  // DEFAULT_PROGRESS_WRITE_INTERVAL_MS. Mirrors url-pull-worker.ts's
  // PROGRESS_INTERVAL_MS (:43-44), which throttles ingest progress writes for
  // exactly the same reason.
  progressWriteIntervalMs?: number;
  // On-demand packager provisioning (epic #226, issue #244; #496). The SAME
  // closure the assets router receives as `ensurePackaging` (src/routes/assets.ts
  // opts, called at assets.ts:1484 on the manual package-start path). Threaded in
  // here so the AUTOMATIC transcode->package handoff below provisions + waits for
  // the packager BEFORE enqueueing, mirroring the manual path's ordering: on a
  // stack where the packager was never provisioned this path previously ZADD'd a
  // job onto a queue with zero consumers, and reconcileStalledPackages (#336)
  // failed the step 15 minutes later. Idempotent + concurrency-safe (issue #245):
  // a reused running instance returns immediately. When absent (the queue stack
  // isn't active, or a test pre-wires packaging) the handoff proceeds as before.
  // Throwing fails the `package` step with a diagnostic instead of enqueueing.
  ensurePackaging?: () => Promise<void>;
  logger: Logger;
};

// Purge stale ("ghost") entries from the packager's input queue BEFORE a new
// packaging job is enqueued (#498). A job ZADD'd onto encore-packager:jobs while
// no packager instance exists sits there indefinitely — nothing expires or purges
// unconsumed entries. When a packager is later provisioned on-demand (#496/#497)
// it drains EVERY queued member in arrival order, including ancient ones that
// reference Encore jobs/instances long gone. Because the packager's
// /packagerCallback/failure carries no jobId (packager contract gap — see
// docs/osc-feedback/incoming-encore-packager-contract.md findings #2 and #6), the
// failure handler in src/routes/internal.ts cannot attribute a ghost's failure to
// its own (dead) job, so it fails WHATEVER execution currently has a running
// `package` step — misattributing the ghost's failure to an unrelated, freshly
// enqueued, healthy packaging run (observed live on stack ovctest 2026-09-01).
//
// The bound is DEFAULT_PACKAGE_STALL_TIMEOUT_MS — the SAME window
// reconcileStalledPackages (#336) uses to fail a stuck `package` step. A queue
// entry older than that timeout is definitionally a ghost: any execution it
// belonged to would already have been failed by the stalled-package reconciler,
// so no pipeline step could still be waiting on it. Scores are the enqueue
// timestamp (Date.now() at ZADD time — the established scoring convention), so we
// ZRANGEBYSCORE for members below the cutoff and ZREM them. Purely defensive: any
// Redis error is caught + logged and NEVER thrown into the enqueue path — a purge
// hiccup must not block a real packaging job from being queued. Every purged entry
// is logged (no silent drops) with its content and age for operator inspection.
export async function purgeStalePackagingJobs(
  redis: Pick<Redis, 'zrangebyscore' | 'zrem'>,
  queueKey: string,
  opts: { logger: Pick<Logger, 'warn'>; now?: () => number; staleBoundMs?: number }
): Promise<void> {
  const now = opts.now ?? (() => Date.now());
  const staleBoundMs = opts.staleBoundMs ?? DEFAULT_PACKAGE_STALL_TIMEOUT_MS;
  const cutoff = now() - staleBoundMs;
  try {
    // Members whose score (enqueue time) is strictly older than the cutoff. The
    // exclusive upper bound `(<cutoff>` keeps an entry sitting exactly on the
    // boundary rather than aging it out a millisecond early.
    const stale = await redis.zrangebyscore(queueKey, '-inf', `(${cutoff}`, 'WITHSCORES');
    // WITHSCORES returns a flat [member, score, member, score, ...] array.
    for (let i = 0; i < stale.length; i += 2) {
      const member = stale[i]!;
      const score = Number(stale[i + 1]);
      const removed = await redis.zrem(queueKey, member);
      if (removed > 0) {
        opts.logger.warn({
          msg: 'encore-callback-poller: purged stale packaging job before enqueue',
          queueKey,
          entry: member,
          enqueuedAt: new Date(score).toISOString(),
          ageMs: now() - score,
          staleBoundMs
        });
      }
    }
  } catch (err) {
    // Defensive: a purge failure must never block the real enqueue that follows.
    opts.logger.warn({ msg: 'encore-callback-poller: stale packaging-job purge failed — continuing to enqueue', queueKey, err });
  }
}

// Push a packaging job onto the packager's input queue (#94). We ZADD the
// { jobId, url } envelope onto the sorted set (score = Date.now() for FIFO), the
// same producer operation the callback-listener uses; the packager consumes it
// via BZPOPMIN. jobId = assetId so the packager's success callback resolves back
// to the asset. Best-effort: a queue failure records packagingError on the asset
// (mirroring the former PackagingService.triggerPackaging behaviour) and never
// throws into the caller so pipeline advancement is not blocked.
async function enqueuePackagingJob(
  deps: PollerDeps,
  assetId: string,
  encoreJobUrl: string
): Promise<void> {
  const queueKey = deps.packagingQueueKey ?? DEFAULT_PACKAGING_QUEUE_KEY;
  const message = JSON.stringify({ jobId: assetId, url: encoreJobUrl });
  // #498: purge stale ghost entries BEFORE our ZADD so the packager instance this
  // job's own on-demand provisioning (#496/#497) just brought up can never drain
  // an ancient job whose no-jobId failure callback would be misattributed to THIS
  // fresh, healthy run. Best-effort — purgeStalePackagingJobs never throws, so a
  // purge hiccup cannot block the enqueue below.
  await purgeStalePackagingJobs(deps.redis, queueKey, { logger: deps.logger });
  try {
    await deps.redis.zadd(queueKey, Date.now(), message);
    deps.logger.info({ msg: 'encore-callback-poller: enqueued packaging job', queueKey, assetId, url: encoreJobUrl });
  } catch (err) {
    const emsg = err instanceof Error ? err.message : String(err);
    deps.logger.error({ msg: 'encore-callback-poller: failed to enqueue packaging job', queueKey, assetId, err });
    try {
      await deps.assetRepository.update(assetId, {
        packagingError: `failed to enqueue packaging job: ${emsg}`
      });
    } catch {
      // Detached safety: nothing more we can do if the error write also fails.
    }
  }
}

// A produced Encore output entry (subset — matches the internal route schema).
type EncoreOutput = {
  file?: string;
  type?: string;
  videoStreams?: Array<{ width?: number; height?: number }>;
  overallBitrate?: number;
};

// Are all steps of an execution settled? Mirrors the internal route: `done` and
// `skipped` (issue #789) both count, so an execution containing an unconfigured
// optional step still closes out as complete.
function allStepsDone(steps: StepExecution[]): boolean {
  return steps.every(isStepComplete);
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
// Resolve the full Encore job URL for a given encoreJobId (externalId).
// Tries the direct URL key stored at dispatch time first (jobEncoreUrl), which
// is independent of the pool and survives instance scale-down. Falls back to
// reconstructing from the pool record + UUID key for jobs dispatched before
// the direct-URL key was introduced. Mirrors resolveEncoreJobUrl in
// src/routes/internal.ts.
async function resolveEncoreJobUrl(
  encoreJobId: string,
  redis: Redis
): Promise<string | undefined> {
  // Fast path: full URL stored at dispatch time (unaffected by pool teardown).
  const direct = await redis.get(keys.jobEncoreUrl(encoreJobId));
  if (direct) return direct;

  // Fallback: reconstruct from pool record + UUID (pre-jobEncoreUrl jobs).
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
  logger: Logger,
  // #707: the success path hdel's keys.jobInstance BEFORE this runs (so a later
  // reconcile tick's drop diff can't re-observe the job), which would leave this
  // function unable to resolve the instance from that mapping. Callers on that
  // path pass the instanceId they captured before the delete; when omitted we
  // resolve it from keys.jobInstance exactly as before (failure/retry paths, which
  // do not delete the mapping).
  knownInstanceId?: string
): Promise<void> {
  try {
    const decoded = decodeEncoreJobId(encoreJobId);
    if (!decoded) return;
    const { workspaceId } = decoded;
    const instanceId =
      knownInstanceId ?? (await redis.hget(keys.jobInstance(workspaceId), encoreJobId));
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

  // #707: on a SUCCESSFUL (terminal) callback, atomically stamp a TERMINAL value
  // onto keys.jobStatus AND hdel keys.jobInstance as the FIRST Redis writes on the
  // success path — before completeTranscode, the retry gate, the pipeline advance,
  // and the packaging handoff below. This closes a race with ScalerLoop.reconcile():
  // when Encore completes a job it leaves that instance's live QUEUED/IN_PROGRESS
  // set, so the next reconcile tick sees tracked activeJobs > actual. Its
  // drop-detection diff (scaler-loop.ts:505-521) then looks at each job still
  // mapped to this instance whose keys.jobStatus is still 'running' — guard 2
  // (scaler-loop.ts:513 `if (st !== 'RUNNING' && st !== 'QUEUED') continue`) is the
  // only thing that keeps a legitimately-completed job out of droppedJobIds. Until
  // this write lands, dispatch left that status as 'running' (scaler-loop.ts:699),
  // so guard 2 was inert and the finished job was raised via onJobsDropped and
  // settled permanently `failed` with "dropped by Encore: gone from active set with
  // no completion" (main.ts:1152). Writing 'SUCCESSFUL' here makes guard 2 short-
  // circuit the completed job on every subsequent reconcile tick. hdel'ing
  // keys.jobInstance additionally removes the job from the trackedInstances map the
  // diff iterates (scaler-loop.ts:506-509), so it is no longer even a candidate.
  // Best-effort: a Valkey hiccup here must never block the completion flow that
  // follows, so failures are logged and swallowed. The status/instance keys are
  // scaler-only bookkeeping (a non-scaler deployment has no such keys and this is a
  // harmless no-op) — the durable terminal state is still owned by completeTranscode.
  //
  // We hdel keys.jobInstance here (before completeTranscode), but two later steps
  // still need the instanceId that mapping held: the packaging pin (scaler-loop
  // teardown guard, #525 pt.2) and the activeJobs decrement (frees the instance's
  // slot for reuse). Both previously RE-READ keys.jobInstance downstream; since we
  // are about to delete it, we resolve the instanceId ONCE here and thread it into
  // those steps via terminalInstanceId so they no longer depend on the mapping
  // still existing. Undefined when the job isn't scaler-tracked (non-scaler
  // deployment, or the mapping was already gone) — the downstream steps fall back
  // to their own resolution / no-op exactly as before.
  let terminalInstanceId: string | undefined;
  if (success) {
    const decoded = decodeEncoreJobId(externalId);
    if (decoded) {
      try {
        terminalInstanceId =
          (await deps.redis.hget(keys.jobInstance(decoded.workspaceId), externalId)) ?? undefined;
        await deps.redis.hset(keys.jobStatus(decoded.workspaceId), externalId, 'SUCCESSFUL');
        await deps.redis.hdel(keys.jobInstance(decoded.workspaceId), externalId);
      } catch (err) {
        deps.logger.warn({ msg: 'encore-callback-poller: failed to stamp terminal jobStatus/hdel jobInstance', externalId, err });
      }
    }
  }

  // #381: the retry classification for the attempt being settled terminally.
  // Set from the retry gate's decision on the settle branch below; consumed
  // after completeTranscode to finalize the durable encode-attempt log.
  let terminalFailureClass: import('../encore-scaler/retry-policy.js').MessageFailureClass | undefined;

  // #295: before settling a FAILED job terminal, ask the retry gate whether this
  // is a transport-class failure (S3 pool-acquire timeout on write / severed read
  // I/O on an intact source) that should be re-dispatched instead. Only jobs that
  // still belong to this workspace's scaler pool are eligible; a non-scaler
  // deployment (no jobPayload key) falls through to the normal settle path.
  //
  // If the gate re-dispatches, we must NOT run completeTranscode (that would
  // settle the caller-facing job to `failed`), must NOT decrement the slot for
  // the dead attempt (the fresh dispatch manages its own slot via its own
  // callback), and must NOT touch the pipeline execution — the job stays
  // `running` until the retry succeeds or the bound is exhausted. This is also
  // the #273 coordination point: a still-`running` job is exactly what #273's
  // reconciler leaves alone, so the two never double-settle.
  if (!success) {
    const decoded = decodeEncoreJobId(externalId);
    if (decoded) {
      const failureMessage = job.message ?? `encore status: ${status}`;
      let decision;
      try {
        decision = await decideRetry(
          deps.redis,
          decoded.workspaceId,
          externalId,
          failureMessage,
          // #745: cancel any still-active prior Encore attempt for this externalId
          // before the retry is re-dispatched. Encore's token is the same service
          // access token the poller already uses to fetch job documents (line ~352).
          makePriorAttemptCanceler(() => deps.oscContext.getServiceAccessToken('encore'))
        );
      } catch (err) {
        // If the retry gate itself errors, fall through to the normal terminal
        // settle rather than leaving the job hung.
        deps.logger.warn({ msg: 'encore-callback-poller: retry gate error — settling terminal', externalId, err });
        decision = undefined;
      }
      if (decision?.action === 'retry') {
        deps.logger.warn({
          msg: 'encore-callback-poller: transport-class encode failure — re-dispatching',
          externalId,
          attempt: decision.attempt,
          failureClass: decision.failureClass,
          backoffMs: decision.backoffMs,
          failureMessage
        });
        // #381: close out the attempt that just FAILED before the retry is
        // dispatched. Stamp its endedAt + the retry classification onto the
        // durable encode-attempt log (appended at dispatch time by #380), so this
        // attempt keeps a distinct start/end pair and its class. The subsequent
        // re-dispatch appends a fresh (open) attempt entry via onEncodeDispatched.
        // Best-effort: a durable-write hiccup must not block the retry.
        try {
          await deps.jobRepository.finalizeEncodeAttempt(found.job.id, {
            endedAt: new Date().toISOString(),
            classification: decision.failureClass
          });
        } catch (err) {
          deps.logger.warn({ msg: 'encore-callback-poller: failed to finalize encode attempt (retry)', jobId: found.job.id, externalId, err });
        }
        // Free the slot on the instance that ran the FAILED attempt so the
        // scaler can dispatch the retry (and other work) — the retry re-enters
        // the queue and will be dispatched by the loop like any other job.
        await decrementActiveJobs(deps.redis, externalId, deps.logger);
        return; // do not settle; the retry is pending.
      }
      if (decision?.action === 'skip') {
        // #743: this job already has a retry entry queued/inflight, so decideRetry
        // did NOT enqueue a duplicate. Treat as a pure no-op: the pending retry
        // owns the re-dispatch (and already finalized/decremented for its own
        // attempt), so do NOT settle, finalize another encode attempt, or free a
        // slot for this duplicate failure signal.
        deps.logger.info({
          msg: 'encore-callback-poller: retry already queued/inflight — skipping duplicate re-dispatch',
          externalId,
          failureClass: decision.failureClass,
          failureMessage
        });
        return; // do not settle; a retry is already pending.
      }
      if (decision?.action === 'settle') {
        // Retries exhausted or non-retryable: fall through to settle terminal,
        // then clear the retry bookkeeping.
        deps.logger.info({
          msg: 'encore-callback-poller: encode failure settling terminal',
          externalId,
          reason: decision.reason,
          failureClass: decision.failureClass
        });
        // #381: carry the classification so the terminal attempt's durable log
        // entry records why this final attempt failed.
        terminalFailureClass = decision.failureClass;
      }
    }
  }

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

  // #525 pt.2: on a successful completion, pin the instance that ran this job
  // against premature scale-down BEFORE decrementActiveJobs below — that call
  // is what makes the instance look idle to the scaler's teardown check, so
  // the pin MUST be in place before it, not after. Resolved via the same
  // jobInstance mapping decrementActiveJobs itself reads. If we can't resolve
  // the instance (already gone) there's nothing to pin; the packaging attempt
  // below will discover that on its own terms. Released (see
  // releasePendingPackagingPin below) as soon as we determine packaging either
  // isn't needed or wasn't started, or by the packager's success callback once
  // packaging genuinely completes; otherwise self-expires via the pin's TTL.
  let pinnedInstanceId: string | undefined;
  if (result.applied && success) {
    // #707: keys.jobInstance was hdel'd above (terminal-stamp), so resolve the
    // instance from terminalInstanceId captured before that delete rather than
    // re-reading the now-absent mapping.
    try {
      if (terminalInstanceId) {
        await pinInstanceForPackaging(deps.redis, terminalInstanceId, externalId);
        pinnedInstanceId = terminalInstanceId;
      }
    } catch (err) {
      deps.logger.warn({ msg: 'encore-callback-poller: failed to pin instance for packaging handoff', externalId, err });
    }
  }
  const releasePendingPackagingPin = async (): Promise<void> => {
    if (!pinnedInstanceId) return;
    await unpinInstanceForPackaging(deps.redis, pinnedInstanceId, externalId).catch((err) => {
      deps.logger.warn({ msg: 'encore-callback-poller: failed to release packaging pin', externalId, instanceId: pinnedInstanceId, err });
    });
  };

  // Free the slot on the Encore instance that ran this job so the scaler can
  // reuse its capacity. Only on a terminal completion that actually applied.
  if (result.applied) {
    // #708: stamp keys.jobCompletionSeen (Unix ms) BEFORE decrementActiveJobs.
    // decrementActiveJobs is the exact read-modify-write reconcile races against:
    // reconcile may diff Encore's active set (which no longer lists this finished
    // job) before this decrement lands (observed ~4.4s in production) and would
    // otherwise re-raise the job as silently dropped. Writing the timestamp first
    // guarantees reconcile's grace-window check sees the completion for the whole
    // race window. PX TTL derives from the grace window (with a small margin) so
    // the key self-expires just after the window even if the delete below is
    // skipped (e.g. instance already gone). Best-effort: a write hiccup must not
    // block completion.
    const graceMs = deps.reconcileGraceMs ?? DEFAULT_RECONCILE_GRACE_MS;
    try {
      await deps.redis.set(
        keys.jobCompletionSeen(externalId),
        String(Date.now()),
        'PX',
        graceMs + 2_000
      );
    } catch (err) {
      deps.logger.warn({ msg: 'encore-callback-poller: failed to record job completion timestamp', externalId, err });
    }
    // #707: on the success path keys.jobInstance was already hdel'd above, so pass
    // the instanceId captured before that delete. On the settle-failure path
    // terminalInstanceId is undefined and the mapping still exists, so
    // decrementActiveJobs resolves it from Redis exactly as before.
    await decrementActiveJobs(deps.redis, externalId, deps.logger, terminalInstanceId);
    // #708: the decrement has landed, so reconcile now sees the corrected
    // activeJobs count and no longer needs the grace-window marker. Delete it
    // eagerly (the PX TTL is only the safety net for when this delete is skipped).
    await deps.redis.del(keys.jobCompletionSeen(externalId)).catch(() => {});
    // #381: close out the final (open) encode-attempt on the durable log now
    // that the job has settled terminally. On success the attempt records only
    // endedAt (no failure classification), so the elapsed time of the successful
    // attempt is derivable from its start/end pair. On a settled failure it also
    // records the retry classification captured above. If no dispatch was ever
    // recorded (pre-#380 job) the helper synthesises a single finalised attempt
    // so the field reads exactly one attempt and is never 0. Best-effort: a
    // durable-write hiccup must not block the completion flow.
    try {
      await deps.jobRepository.finalizeEncodeAttempt(found.job.id, {
        endedAt: new Date().toISOString(),
        ...(success ? {} : { classification: terminalFailureClass })
      });
    } catch (err) {
      deps.logger.warn({ msg: 'encore-callback-poller: failed to finalize encode attempt (terminal)', jobId: found.job.id, externalId, err });
    }
    // Job has settled terminally (success, or a failure that exhausted/was not
    // eligible for retry): drop the #295 retry bookkeeping so it does not linger.
    await clearRetryState(deps.redis, externalId).catch(() => {});
  }

  // #525 pt.2: tracks whether the pin above was actually handed off to a
  // genuinely in-flight packaging job (in which case it must stay pinned until
  // the packager's success callback releases it) versus every other outcome
  // below (no pipeline, no package step, URL/provisioning failure), which
  // should release the pin immediately rather than waiting out its TTL.
  let packagingHandedOff = false;

  // Advance the matching PipelineExecution — copied from src/routes/internal.ts
  // (the encore-callback handler). It can't be shared without a refactor.
  if (result.applied && deps.pipelineRepository) {
    let execution = await deps.pipelineRepository.findRunningByAssetAndStep(
      found.job.assetId,
      'transcode'
    );
    // #709: reversible drop-detection recovery. When the scaler's
    // gone-from-active-set drop settled this job it also FAILED the pipeline's
    // `transcode` step and moved the execution to `failed` (settleFailedTranscode
    // -> releasePipelineLock), so findRunningByAssetAndStep above finds nothing.
    // A genuine SUCCESSFUL callback arriving afterwards has just corrected the Job
    // to `done` (completeTranscode override, result.applied === true). Re-open the
    // failed execution's transcode step here so the SAME advancement code below
    // resumes the pipeline (package / playback URL) instead of leaving it stuck
    // `failed`. Scoped strictly: only on `success`, and only for a `failed`
    // execution whose transcode step carries THIS externalId — a genuine
    // Encore-error failure (job never carried droppedByScaler, so completeTranscode
    // no-oped and result.applied is false) never reaches here.
    if (!execution && success) {
      const failedExecutions = await deps.pipelineRepository.listByAsset(found.job.assetId);
      const reopenable = failedExecutions.find(
        (e) =>
          e.status === 'failed' &&
          e.steps.some((s) => s.name === 'transcode' && s.encoreJobId === externalId && s.status === 'failed')
      );
      if (reopenable) {
        const now = new Date().toISOString();
        const steps: StepExecution[] = reopenable.steps.map((s) => ({ ...s }));
        const tIdx = steps.findIndex((s) => s.name === 'transcode' && s.encoreJobId === externalId);
        // Re-open the transcode step to `running` and the execution to `running`
        // so it matches the shape the advancement code below expects; that code
        // then marks the step `done` and steps into `package`.
        steps[tIdx] = { ...steps[tIdx], status: 'running', error: undefined, completedAt: undefined };
        const reopened = await deps.pipelineRepository.update(reopenable.id, { steps, status: 'running' });
        deps.logger.info({
          msg: 'encore-callback-poller: re-opened drop-failed pipeline for corrective SUCCESSFUL callback',
          assetId: found.job.assetId,
          externalId,
          executionId: reopenable.id
        });
        execution = reopened ?? { ...reopenable, status: 'running', steps };
      }
    }
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
        if (nextIdx >= 0 && steps[nextIdx].name === 'package') {
          // #525: prefer the `url` already resolved (and proven reachable — we
          // just fetched this exact job document with it) earlier in this same
          // function, over re-deriving it from the dispatch-time Redis keys
          // (jobEncoreUrl / jobUuid+pool). Those keys are written ONLY inside
          // scaler-loop.ts dispatch()'s `if (encoreUuid && ...)` branch — if
          // Encore's POST /encoreJobs response omitted `id` (or the pool record
          // was later wiped by scale-down), none of them exist, yet `url` above
          // was still resolved successfully via message.url (the callback
          // listener observes Encore's own webhook independently of our
          // dispatch-time bookkeeping, and message.url is already in the exact
          // `${instanceUrl}/encoreJobs/${uuid}` shape the packager needs — see
          // the module doc comment). Previously this re-derived the URL from
          // scratch and, on that gap, failed the `package` step with the
          // misleading "Encore instance no longer available for packaging" —
          // silently (no log line) — even though the instance was fine and we
          // had a working URL in hand the whole time. resolveEncoreJobUrl is
          // now only a defensive fallback for the case (which should not arise
          // given the `!url` guard earlier in this function) where `url` is
          // somehow unset.
          const encoreJobUrl = url ?? (await resolveEncoreJobUrl(externalId, deps.redis));
          if (encoreJobUrl) {
            // On-demand packager provisioning (epic #226, issue #244; #496):
            // ensure the packager is provisioned + wired + ready BEFORE enqueueing,
            // exactly as the manual package-start path does at
            // src/routes/assets.ts:1484. This automatic transcode->package handoff
            // previously ZADD'd straight onto the queue, so on a stack where the
            // packager had not yet been provisioned the job landed on a queue with
            // no consumer and reconcileStalledPackages (#336) failed the step 15
            // minutes later. Idempotent/concurrency-safe (issue #245): a reused
            // running instance returns immediately. When no ensure hook is wired
            // (the queue stack isn't active, or a test pre-wires packaging) this is
            // skipped and packaging proceeds as before. A provisioning failure
            // fails the `package` step with a diagnostic rather than silently
            // enqueueing onto a queue nothing will consume.
            try {
              if (deps.ensurePackaging) {
                await deps.ensurePackaging();
              }
            } catch (err) {
              const emsg = err instanceof Error ? err.message : String(err);
              steps[nextIdx] = {
                ...steps[nextIdx],
                status: 'failed',
                error: `on-demand packager provisioning failed before packaging handoff: ${emsg}`,
                completedAt: now
              };
              await deps.pipelineRepository.update(execution.id, { steps, status: 'failed' });
              deps.logger.error({
                msg: 'encore-callback-poller: ensurePackaging failed at transcode->package handoff',
                assetId: found.job.assetId,
                err
              });
              await releasePendingPackagingPin();
              return;
            }
            steps[nextIdx] = { ...steps[nextIdx], status: 'running', startedAt: now };
            await deps.pipelineRepository.update(execution.id, { steps, status: 'running' });
            // OSC-native handoff (#94): push the packaging job onto the
            // eyevinn-encore-packager's input queue ("packaging-queue") instead
            // of calling PackagingService.triggerPackaging in-process. The
            // packager consumes it, performs ABR (HLS/DASH) packaging, writes to
            // S3, and POSTs /api/v1/internal/packagerCallback/success — which
            // advances this execution's `package` step to `done`.
            await enqueuePackagingJob(deps, found.job.assetId, encoreJobUrl);
            // #525 pt.2: packaging is genuinely in flight against the pinned
            // instance now — leave it pinned. The packager's success callback
            // (routes/internal.ts /packagerCallback/success) releases it; a
            // failure (no jobId in that callback — encore-packager contract
            // gap) relies on the pin's own TTL to self-heal.
            packagingHandedOff = true;
          } else {
            // #525: this branch should now be unreachable in practice, since
            // `url` is required truthy earlier in this function — but log
            // loudly rather than failing the step silently, so a future gap
            // here is diagnosable from the poller's own logs instead of
            // presenting only as an opaque "no longer available" pipeline
            // error with nothing between "completing transcode" and "applied
            // encore completion" to explain it.
            deps.logger.error({
              msg: 'encore-callback-poller: no Encore job URL available for packaging handoff — failing package step',
              assetId: found.job.assetId,
              externalId
            });
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

  // #525 pt.2: every path above that did NOT hand this job's pin off to a
  // genuinely enqueued packaging job — no pipelineRepository, no matching
  // execution, a failed transcode, a non-package next step, or a resolution/
  // provisioning failure that already released it once (a second release is a
  // harmless no-op) — must release the pin here so the instance isn't held
  // alive for nothing until the TTL expires.
  if (!packagingHandedOff) {
    await releasePendingPackagingPin();
  }

  deps.logger.info({
    msg: 'encore-callback-poller: applied encore completion',
    externalId,
    status,
    applied: result.applied,
    renditionCount: result.renditionCount
  });
}

// Sweep all scaler-managed Encore instances for terminal jobs (both SUCCESSFUL
// and FAILED) whose callback message was never written to the queue. This is a
// fallback for the missing `await` bug in eyevinn-encore-callback-listener's
// pushMessage (the zAdd is fire-and-forget, so messages can silently fail to
// land in Redis) AND for the case where Encore/the listener simply never calls
// back on failure the way it does on success. The sweep runs every
// SWEEP_INTERVAL_MS and re-synthesises the same message format the callback
// listener would have produced, then pushes it to the main queue only if the
// job is not already there and is not yet terminal in our DB — the downstream
// handleMessage path re-fetches the live Encore job and derives success/failure
// itself, so both outcomes flow through the same completion logic.
//
// Reconciling FAILED jobs here closes the "job looks stuck running after an
// Encore failure" gap: if Encore fails a job outright (e.g. a ProbeResult parse
// error on an unsupported input) and no completion message ever lands, the
// local job, source asset, and pipeline `transcode` step would otherwise stay
// non-terminal forever. CANCELLED is deliberately NOT swept — that status is set
// synchronously by our own operator-initiated cancel route (src/routes/jobs.ts)
// and does not depend on an Encore callback.
//
// Contract: Encore /encoreJobs/search/findByStatus returns Spring HATEOAS pages:
//   { _embedded: { encoreJobs: [{ id: "<uuid>", externalId: "...", ... }] },
//     page: { totalElements: N } }
// (verified from Encore source and OSC docs, 2026-07-07)
//
// #464 — THE single independent job-status reconciliation loop. sweepTerminalJobs
// (below) is the one and only periodic reconciler that polls the authoritative
// per-instance Encore status endpoint for non-terminal scaler-managed jobs and
// drives any job terminal-at-instance but non-terminal locally to its correct
// terminal state via the SHARED handleMessage -> completeTranscode path (idempotent
// — it skips jobs already terminal locally and messages already queued/processing,
// so a job that ALSO received its real callback is never double-processed). Do NOT
// add a second control loop; extend this one. Cross-references #448 (its terminal-
// reconciliation counterpart) — the two coordinate rather than duplicate: a still-
// `running` retry left by handleMessage is exactly what #448's reconciler leaves
// alone, so they never double-settle a job.
//
// Interval and per-cycle fan-out (page size, instances scanned) are bounded and
// configurable via ENCORE_SWEEP_* env vars (defaults below keep behaviour
// unchanged when unset).
const DEFAULT_SWEEP_INTERVAL_MS = 30_000;
const DEFAULT_SWEEP_PAGE_SIZE = 100;

// Encore terminal statuses we reconcile in the sweep. Both are handled by the
// SAME discovery → synthesize-message → enqueue mechanism; handleMessage derives
// the actual success/failure from the live Encore job document it re-fetches, so
// the only thing that differs per status is the findByStatus query below.
const SWEEP_STATUSES = ['SUCCESSFUL', 'FAILED'] as const;

// #830 — live transcode progress.
//
// A running transcode reported progress: 0 for its entire duration: Encore
// computes the value and returns it on every job document, the Job record has a
// `progress` field, the pipelines route enriches a running step from it
// (src/routes/pipelines.ts:56-71 enrichWithProgress) and both UI surfaces render
// it — but nothing ever copied Encore's number onto our job. The push channel
// (progressCallbackUri, injected at dispatch by scaler-loop.ts:992-996) delivers
// only the terminal callback on current stacks (#812), so the value is read here
// instead, off a response this loop already fetches.
//
// CONTRACT SOURCES VERIFIED (CLAUDE.md rule 7) — Encore's own OpenAPI document,
// fetched live from a running OSC Encore instance at GET /v3/api-docs
// (2026-09-25, instance scalerovctestmtvumibi):
//   - path `/encoreJobs/search/findByStatus`, operationId
//     `executeSearch-encorejob-get`, `status` query enum
//     [NEW, QUEUED, IN_PROGRESS, SUCCESSFUL, FAILED, CANCELLED]; 200 response
//     schema `PagedModelEntityModelEncoreJob` =
//     { _embedded: { encoreJobs: EntityModelEncoreJob[] }, page, _links }.
//   - `EntityModelEncoreJob.progress` — {"type":"integer","format":"int32",
//     "default":"0","description":"The EncoreJob progress","example":57,
//     "readOnly":true}. Integer percent, 0-100 (the live evidence on #830 shows
//     8 -> 27 -> 47 -> 75 over one run).
//   - `EntityModelEncoreJob.externalId` — {"type":"string","description":
//     "External id - for external backreference"}. This is OUR encoreJobId: the
//     transcode dispatch submits `externalId: encoreJobId`
//     (src/pipeline/transcode.ts:146) and JobRepository.findByEncoreJobId
//     (src/data/job-repo.ts:257) resolves it back to the local job — the same
//     lookup the terminal sweep below already performs.
//   - Write target: UpdateJobInput.progress (src/data/job-repo.ts:176), clamped
//     to 0-100 by clampProgress (job-repo.ts:306-309).
const PROGRESS_STATUS = 'IN_PROGRESS';

// Minimum gap between two persisted progress writes for one job (#830 acceptance
// criterion: "Progress writes are throttled rather than issued on every poll").
const DEFAULT_PROGRESS_WRITE_INTERVAL_MS = 10_000;

// Drop a throttle entry this long after its last write, so the map cannot grow
// without bound across a long-lived process (a job that stops appearing on the
// IN_PROGRESS page has finished and will never be rate-limited again).
const PROGRESS_THROTTLE_TTL_MS = 60 * 60_000;

type ProgressThrottleEntry = { at: number; value: number };

// Throttle state keyed by the poller's own deps object, so each running poller
// (and each test) gets an isolated map that is collected with it.
const progressThrottleByDeps = new WeakMap<PollerDeps, Map<string, ProgressThrottleEntry>>();

function progressThrottleState(deps: PollerDeps): Map<string, ProgressThrottleEntry> {
  let state = progressThrottleByDeps.get(deps);
  if (!state) {
    state = new Map();
    progressThrottleByDeps.set(deps, state);
  }
  return state;
}

// Read Encore's reported `progress` for every IN_PROGRESS job on ONE instance and
// persist it onto the matching local transcode job.
//
// Deliberately additive and best-effort: it never enqueues, never changes a job's
// status, and swallows every fetch/parse/repository error (a progress number is
// cosmetic — failing to read it must never disturb the terminal reconciliation
// this sweep exists for). Runs inside the existing per-instance sweep loop, so it
// adds no control loop and no new timer (#464: "Do NOT add a second control loop;
// extend this one").
//
// Two independent guards keep CouchDB writes off the poll cadence:
//   1. unchanged value  — Encore reports integer percent, so most cycles repeat
//                         the previous number; those are skipped outright.
//   2. minimum interval — a changed value is still only written once per
//                         progressWriteIntervalMs per job.
// Returns the number of jobs actually written (test observability).
export async function syncInProgressJobProgress(
  deps: PollerDeps,
  record: EncoreInstanceRecord,
  sat: string,
  opts: { pageSize: number; now?: () => number }
): Promise<number> {
  const { logger, jobRepository } = deps;
  const now = opts.now ?? (() => Date.now());
  const intervalMs = deps.progressWriteIntervalMs ?? DEFAULT_PROGRESS_WRITE_INTERVAL_MS;
  const throttle = progressThrottleState(deps);

  const searchUrl =
    `${record.url.replace(/\/+$/, '')}/encoreJobs/search/findByStatus` +
    `?status=${PROGRESS_STATUS}&page=0&size=${opts.pageSize}`;

  let encoreJobs: Array<{ externalId?: string; progress?: number }> = [];
  try {
    const res = await fetch(searchUrl, { headers: { authorization: `Bearer ${sat}` } });
    if (!res.ok) return 0;
    const body = (await res.json()) as {
      _embedded?: { encoreJobs?: typeof encoreJobs };
    };
    encoreJobs = body._embedded?.encoreJobs ?? [];
  } catch {
    return 0;
  }

  let written = 0;
  const at = now();

  for (const encoreJob of encoreJobs) {
    const externalId = encoreJob.externalId;
    const progress = encoreJob.progress;
    // `progress` is optional on the schema and defaults to 0; a non-numeric or
    // absent value carries no information, so there is nothing to copy.
    if (!externalId || typeof progress !== 'number' || !Number.isFinite(progress)) continue;

    const previous = throttle.get(externalId);
    // Guard 1: Encore has not moved since the last value we persisted.
    if (previous && previous.value === progress) continue;
    // Guard 2: it has moved, but not long enough ago to spend a write on.
    if (previous && at - previous.at < intervalMs) continue;

    try {
      const found = await jobRepository.findByEncoreJobId(externalId);
      if (!found) continue;
      const { job } = found;
      // Never write progress onto a job that has already settled — a terminal
      // job's progress is whatever completeTranscode left there.
      if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') continue;
      if (job.progress === progress) {
        // Already correct in the store (e.g. first sight after a restart):
        // record it so the unchanged-value guard suppresses future cycles.
        throttle.set(externalId, { at, value: progress });
        continue;
      }
      await jobRepository.update(job.id, { progress });
      throttle.set(externalId, { at, value: progress });
      written++;
      logger.info({
        msg: 'encore-callback-poller: progress updated from encore',
        externalId,
        jobId: job.id,
        progress,
        instanceId: record.instanceId
      });
    } catch (err) {
      logger.warn({ msg: 'encore-callback-poller: progress update failed', externalId, err });
    }
  }

  // Bounded-memory housekeeping: forget jobs we have not written for in an hour.
  for (const [key, entry] of throttle) {
    if (at - entry.at > PROGRESS_THROTTLE_TTL_MS) throttle.delete(key);
  }

  return written;
}

// Scan `encore:pool:*` keys to find all workspaces that have an active pool,
// then for each workspace check every Encore instance for (a) live progress on
// its IN_PROGRESS jobs (#830, syncInProgressJobProgress above) and (b) terminal
// jobs (SUCCESSFUL or FAILED) that have a UUID→externalId mapping but whose local
// job is not yet in a terminal state. If such a job exists and is not already in the
// queue, push a synthetic message so the regular loop picks it up and runs the
// shared handleMessage → completeTranscode path (which marks the job done or
// failed based on the live Encore status).
export async function sweepTerminalJobs(deps: PollerDeps, queueKey: string): Promise<void> {
  const { redis, oscContext, logger, jobRepository } = deps;

  // Per-cycle fan-out bounds (#464). Page size caps jobs pulled per instance per
  // status; maxInstances optionally caps how many Encore instances are scanned in
  // one cycle so a very large pool cannot make a single sweep unbounded. Defaults
  // preserve today's behaviour (page size 100, no instance cap) when env is unset.
  const pageSize = deps.sweepPageSize ?? DEFAULT_SWEEP_PAGE_SIZE;
  const maxInstances = deps.sweepMaxInstances;

  const poolKeys = await redis.keys('encore:pool:*');
  if (poolKeys.length === 0) return;

  let instancesScanned = 0;

  let sat: string;
  try {
    sat = await oscContext.getServiceAccessToken('encore');
  } catch (err) {
    logger.warn({ msg: 'encore-callback-poller: sweep — failed to get SAT, skipping', err });
    return;
  }

  const processingKey = `${queueKey}:processing`;

  for (const poolKey of poolKeys) {
    const poolRaw = await redis.hgetall(poolKey).catch(() => ({}));
    for (const instanceJson of Object.values(poolRaw)) {
      // #464: bound instances scanned per cycle when configured. A non-scanned
      // instance is simply picked up on the next sweep, so no job is stranded —
      // reconciliation still completes within a bounded number of intervals.
      if (maxInstances !== undefined && instancesScanned >= maxInstances) return;
      instancesScanned++;

      let record: EncoreInstanceRecord;
      try { record = JSON.parse(instanceJson) as EncoreInstanceRecord; } catch { continue; }

      // #830: copy Encore's own `progress` onto the matching local jobs for this
      // instance's IN_PROGRESS page. Same loop, same timer, same page-size bound
      // as the terminal statuses below; never throws (best-effort by contract).
      await syncInProgressJobProgress(deps, record, sat, { pageSize });

      // Query each terminal status in turn. Both SUCCESSFUL and FAILED jobs are
      // reconciled the same way — the only per-status difference is this query;
      // handleMessage re-derives success/failure from the live Encore document.
      for (const status of SWEEP_STATUSES) {
        const searchUrl =
          `${record.url.replace(/\/+$/, '')}/encoreJobs/search/findByStatus` +
          `?status=${status}&page=0&size=${pageSize}`;
        let encoreJobs: Array<{ id?: string }> = [];
        try {
          const res = await fetch(searchUrl, { headers: { authorization: `Bearer ${sat}` } });
          if (!res.ok) continue;
          const body = (await res.json()) as {
            _embedded?: { encoreJobs?: typeof encoreJobs };
          };
          encoreJobs = body._embedded?.encoreJobs ?? [];
        } catch { continue; }

        for (const encoreJob of encoreJobs) {
          const encoreUuid = encoreJob.id;
          if (!encoreUuid) continue;

          // Is this one of our jobs? (UUID→externalId written at dispatch time, TTL 24h)
          const externalId = await redis.get(keys.uuidToExternalId(encoreUuid));
          if (!externalId) continue;

          // Skip if the local job is already terminal — avoids repeated re-queueing.
          try {
            const found = await jobRepository.findByEncoreJobId(externalId);
            if (!found || found.job.status === 'done' || found.job.status === 'failed') continue;
          } catch { continue; }

          // Build the message the callback listener would have produced.
          // (verified from eyevinn-encore-callback-listener src/api.ts onSuccess handler)
          const message = JSON.stringify({
            jobId: encoreUuid,
            url: `${record.url.replace(/\/+$/, '')}/encoreJobs/${encoreUuid}`
          });

          // Skip if the message is already in the main queue or processing set.
          const [inQueue, inProcessing] = await Promise.all([
            redis.zscore(queueKey, message),
            redis.zscore(processingKey, message)
          ]);
          if (inQueue !== null || inProcessing !== null) continue;

          logger.info({
            msg: 'encore-callback-poller: sweep found unreconciled terminal job — re-queuing',
            encoreUuid,
            externalId,
            status,
            instanceId: record.instanceId
          });
          await redis.zadd(queueKey, Date.now(), message);
        }
      }
    }
  }
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

  // Dedicated connection for the blocking BZPOPMIN call (root cause of a
  // production incident on stack "ovctest", 2026-09-10 — see
  // docs/osc-feedback and the eng-open-videocore-agents PR that logged it).
  //
  // deps.redis is a SHARED IORedis client: the same connection object backs
  // every other Valkey call in the process — makeScalingEncoreClient.submit's
  // lpush/hset, WorkspaceEncoreScalerRegistry status reads, the /scaler/status
  // route, etc. (src/main.ts wires the one `redis` instance into all of
  // those). Redis commands on a single connection are answered strictly in
  // FIFO order, so a BLOCKING command occupies that connection for its full
  // duration. This loop reissues BZPOPMIN back-to-back with ~zero idle time
  // (a fresh call is sent the instant the previous one resolves), so the
  // shared connection is in-flight on a blocking call almost continuously.
  // Any other command queued behind it (e.g. the transcode submit path's
  // `hset encore:job-status:<stack>`) must wait for that call to finish —
  // up to BZPOPMIN_TIMEOUT_SECONDS (5s) — before it is even sent. That
  // contends directly with withDependencyTimeout's own 5000ms bound
  // (src/encore-scaler/dependency-timeout.ts, #616/#634), so submit-path
  // writes routinely lose the race and fail with a DependencyUnreachableError
  // even though Valkey itself answers in single-digit milliseconds — the
  // encode had already completed successfully by the time the job was
  // reported "failed" (see docs/osc-feedback/incoming-redis-status-write-
  // timeout-permanently-fails-succeeded-job.md in eng-open-videocore-agents).
  //
  // ioredis's own guidance is that a connection issuing a blocking command
  // must be dedicated to it (see ioredis README, "Blocking commands"). Use
  // .duplicate() to open a second connection with the same options as
  // deps.redis, reserved for BZPOPMIN only; every other command in this file
  // keeps using deps.redis unchanged.
  const blockingRedis = deps.redis.duplicate();
  // ioredis emits 'error' on connection failures; without a listener Node
  // treats it as an unhandled 'error' event. deps.redis relies on ioredis's
  // own internal handling (no explicit listener elsewhere in this codebase),
  // but that suppression is per-instance, so this duplicated connection needs
  // its own no-op listener — reconnection is still handled internally by
  // ioredis's default retryStrategy; we only log for operator visibility.
  blockingRedis.on('error', (err) => {
    deps.logger.warn({ msg: 'encore-callback-poller: blocking connection error', err });
  });

  deps.logger.info({ msg: 'encore-callback-poller: starting', queueKey, processingKey });

  // Fallback sweep: periodically poll all Encore instances for terminal jobs
  // (SUCCESSFUL and FAILED) that never produced a queue message — either because
  // eyevinn-encore-callback-listener dropped it (missing `await` on zAdd) or
  // because Encore never called back on failure at all. Reconciling FAILED here
  // closes the "job looks stuck running after an Encore failure" gap. First sweep
  // fires after SWEEP_INTERVAL_MS, not immediately, so the normal queue-drain
  // path gets first chance on startup.
  // #464: interval is configurable (ENCORE_SWEEP_INTERVAL_MS) but defaults to the
  // original 30s so behaviour is unchanged when unset.
  const sweepIntervalMs = deps.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  const sweepTimer = setInterval(() => {
    void sweepTerminalJobs(deps, queueKey).catch((err) => {
      deps.logger.warn({ msg: 'encore-callback-poller: sweep error', err });
    });
  }, sweepIntervalMs);
  sweepTimer.unref?.();

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
        // check the abort signal and remain cancellable. Issued on the
        // dedicated blockingRedis connection (see comment on its
        // construction above) so it never holds up deps.redis, which every
        // other command in the process shares.
        const popped = await blockingRedis.bzpopmin(queueKey, BZPOPMIN_TIMEOUT_SECONDS);
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

  return () => {
    controller.abort();
    clearInterval(sweepTimer);
    // Release the dedicated blocking connection. The in-flight BZPOPMIN (if
    // any) will still resolve/timeout server-side, but .disconnect() drops
    // our end immediately rather than waiting on it — deactivateScaler
    // callers expect stop() to return promptly (issue #103).
    blockingRedis.disconnect();
  };
}
