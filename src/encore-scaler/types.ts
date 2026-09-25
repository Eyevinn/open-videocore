// Shared types for the Encore auto-scaler.
//
// The scaler is an Encore-compatible proxy: callers speak the same
// /encoreJobs REST API they would speak to a single Encore instance, but
// submissions are buffered in a Valkey list and dispatched to a pool of
// Encore OSC instances that the scaler spawns and tears down on demand.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - @osaas/client-core lib/core.d.ts:
//       createInstance(context, serviceId, token, body): Promise<any>
//       removeInstance(context, serviceId, name, token): Promise<void>
//       waitForInstanceReady(serviceId, name, ctx): Promise<void>
//     The returned instance object exposes `url` and `name` (see the
//     ServiceInstance typedef + instanceUrl() in src/routes/provision.ts).
//   - Context.getServiceAccessToken(serviceId): Promise<string>
//     (@osaas/client-core lib/context.d.ts:25)
//   - Encore serviceId is 'encore' (src/services/stack.ts:25,
//     src/routes/provision.ts:343-355).
//   - Encore REST payload shape: src/pipeline/encore-client.ts toEncorePayload().

// S3/MinIO credentials passed to each Encore OSC instance at creation time so
// Encore can read source files from the workspace's MinIO bucket. Without these
// Encore resolves s3:// URIs against AWS S3 and gets a 404.
export type EncoreS3Config = {
  endpoint: string;     // full URL, e.g. https://oscaidev-jonas.minio-minio.auto.prod-se.osaas.io
  accessKeyId: string;  // MinIO root user (always "admin" in OSC stacks)
  secretAccessKey: string;
  region?: string;      // S3 region string — MinIO ignores it but Encore requires a value
};

// A job reconcile() observed as silently dropped from an Encore instance's live
// QUEUED/IN_PROGRESS set with no completion callback (issue #449/#704).
//   - encoreJobId: our externalId (the id onDispatched/onJobsDropped resolve by).
//   - reason:      Encore's OWN terminal failure text when reconcile() could
//                  recover it from the job's FAILED encoreJob document (`message`),
//                  else undefined — meaning Encore reported no cause (the genuine
//                  gone-from-active-set case). main.ts surfaces `reason` when set
//                  and reserves the generic wording only for the undefined case.
export type DroppedJob = {
  encoreJobId: string;
  reason?: string;
};

export type EncoreScalerConfig = {
  workspaceId: string;
  maxInstances: number;
  // Optional operator-configured job-throughput cap (issue #580): the maximum
  // number of OUTSTANDING jobs (pending in the queue + being dispatched) the
  // deployment will admit at once. Unset => no cap (opt-in; submission behaviour
  // unchanged). Enforced at submit time against the scaler's own Valkey queue /
  // inflight state — NOT a second accounting path (ADR-020 Decision 2 applied to
  // jobs). See src/encore-scaler/job-throughput-cap.ts.
  maxQueuedJobs?: number;
  // Minimum instances to keep warm even when idle (default 0). When >= 1 the
  // scaler pre-warms up to this many instances regardless of pending work.
  minInstances?: number;
  idleTimeoutMs: number; // default 5 * 60 * 1000
  // Bounded wait (ms) for an instance's outbound TLS trust probe to its paired
  // per-instance callback-listener ingress to succeed before that instance is
  // marked eligible for its FIRST job (issue #463). The probe is a real HTTPS
  // request whose failure surfaces a PKIX/handshake/connection error — a
  // race exists between the callback-listener ingress certificate becoming
  // ready/trusted and the instance beginning to process (and fail) its first
  // job. On timeout the instance is quarantined from job assignment rather than
  // dispatched to. Default 60_000; override via ENCORE_CALLBACK_TRUST_TIMEOUT_MS.
  callbackTrustTimeoutMs?: number;
  // #708: grace window (ms) during which reconcile() will NOT re-raise a job as
  // silently dropped if the callback poller recorded its completion very
  // recently (keys.jobCompletionSeen). Closes the narrow race where reconcile
  // diffs the active set AFTER Encore drops the finished job but BEFORE the
  // poller has decremented record.activeJobs (observed ~4.4s in production).
  // Default DEFAULT_RECONCILE_GRACE_MS (10_000); override via
  // ENCORE_RECONCILE_GRACE_MS.
  reconcileGraceMs?: number;
  // #778: how often (ms) the tick sweeps OSC for scaler-owned Encore instances
  // that have NO pool record at all — instances orphaned by a spawn that died
  // between createInstance and the pool write, a wiped Valkey, or a deleted
  // deployment. Nothing else can ever tear those down: every teardown path
  // (scale-down, teardown()) iterates the pool hash, so an instance missing
  // from it bills forever. Unset or <= 0 disables the sweep (the default for
  // tests and any caller that has not opted in); the registry wires
  // DEFAULT_ORPHAN_REAP_INTERVAL_MS in production.
  orphanReapIntervalMs?: number;
  // #778 (review finding 4): bound (ms) on how long spawnInstance waits for an
  // OSC instance to report `running`. @osaas/client-core's waitForInstanceReady
  // polls getInstanceHealth in a `while` loop with NO timeout and no abort
  // (lib/core.js:343-353, v0.24.0), so without this a spawn can hang forever
  // while holding a live,
  // billing OSC instance that has no pool record — the very state the orphan
  // reaper's grace window is supposed to be able to outlast. On timeout the spawn
  // fails and its cleanup path destroys the Encore instance and any paired
  // listener. Unset uses DEFAULT_SPAWN_READY_TIMEOUT_MS.
  spawnReadyTimeoutMs?: number;
  // #778 (review round 2): how often (ms) that bounded wait re-checks
  // getInstanceHealth. The scaler owns the poll loop instead of racing a timer
  // against waitForInstanceReady, because the SDK helper exposes no abort and
  // would keep polling forever after we stopped waiting. Unset uses
  // DEFAULT_SPAWN_READY_POLL_INTERVAL_MS (1s, the SDK's own cadence).
  spawnReadyPollIntervalMs?: number;
  // #778: how long (ms) an instance must have been continuously observed as
  // orphaned before the reaper destroys it. Guards a spawn in progress, which
  // holds a live OSC instance with no pool record for as long as
  // waitForInstanceReady takes. Unset uses DEFAULT_ORPHAN_GRACE_MS.
  orphanGraceMs?: number;
  // Redis connection string, passed to each paired callback listener so it can
  // put completion messages on the packaging queue.
  redisUrl: string;
  // OSC config for spawning instances.
  oscContext: import('@osaas/client-core').Context;
  // Valkey connection (IORedis instance).
  redis: import('ioredis').Redis;
  // Base URL of this API (for progressCallbackUri forwarding).
  callbackBaseUrl?: string;
  // Resolves a fresh OSC service access token for the Encore instances. The
  // instance URLs returned by OSC require a bearer token exactly as the
  // existing makeHttpEncoreClient does (src/pipeline/encore-client.ts).
  getToken: () => Promise<string>;
  // MinIO S3 credentials injected into every spawned Encore instance. Required
  // for Encore to read source files from the workspace's MinIO bucket.
  s3Config?: EncoreS3Config;
  // Full URL of the Encore profile index each spawned instance should load its
  // transcoding profiles from (its `profilesUrl` config). When set, points at
  // this API's own public GET /api/v1/profiles/index.yml so Encore uses the
  // operator-managed profiles in CouchDB (issue #84). When unset the Encore
  // instance uses its service default.
  profilesUrl?: string;
  // Invoked after a queued job is successfully dispatched to an Encore instance
  // (after the Redis mapping/status writes). The scaler has no job repository of
  // its own, so main.ts wires this up to advance the corresponding Job from
  // `queued` to `running`. Best-effort: failures are swallowed so a repo hiccup
  // never re-queues an already-dispatched job.
  onDispatched?: (encoreJobId: string) => Promise<void>;
  // Invoked after each successful dispatch to durably capture the encode attempt
  // (ADR-012, #380). The scaler has no job repository of its own, so main.ts
  // wires this to jobRepository.appendEncodeAttempt so the attempt history is
  // written to CouchDB alongside the TTL'd Valkey retry counter — and therefore
  // survives after the Valkey key expires or is cleared on re-dispatch/settle.
  // `attempt` is the same dispatch number recorded in Valkey (1 on first
  // dispatch). Best-effort: failures are swallowed so a durable-write hiccup
  // never re-queues an already-dispatched job.
  onEncodeDispatched?: (encoreJobId: string, attempt: number) => Promise<void>;
  // Invoked once per tick to reconcile transcode jobs stuck in a non-terminal
  // state against Encore's terminal FAILED/404 outcomes (issue #273). The scaler
  // has no job repository of its own, so main.ts wires this up to run the
  // failed-transcode reconciliation sweep (src/pipeline/failed-transcode-
  // reconciler.ts). Best-effort: failures are swallowed so a sweep error never
  // breaks the tick's scaling/dispatch work.
  reconcileFailedTranscodes?: () => Promise<void>;
  // Invoked by reconcile() when it detects that one or more tracked jobs have
  // silently vanished from an Encore instance's live QUEUED/IN_PROGRESS set
  // without ever producing a completion callback (issue #449, ADR-016 Direction
  // 2 — reconcile-driven terminal settle). The scaler owns no repositories, so
  // it only raises the signal; main.ts wires this up to drive each dropped job
  // to a terminal `failed` state via the shared idempotent settle path. Each
  // entry carries our externalId (encoreJobId) and, when reconcile() could
  // recover Encore's OWN terminal failure text for that job (its FAILED
  // encoreJob document's `message` field — the same field the callback poller
  // surfaces, src/routes/internal.ts encoreCallbackSchema:95), the `reason`
  // string (issue #704). `reason` is left undefined for the genuine
  // gone-from-active-set case (Encore reported no cause), so main.ts can reserve
  // the generic wording only for that case. Best-effort: failures are swallowed
  // so a repo/settle hiccup never breaks the tick's scaling/dispatch work.
  onJobsDropped?: (drops: DroppedJob[]) => Promise<void>;
  // Invoked when a job is classified 'interrupted_by_scaledown' at the drain/
  // teardown boundary (#514) and re-enqueued for auto-retry (#515). The scaler
  // owns no repositories, so main.ts wires this up to annotate the caller-facing
  // Job record with the distinguishable, recoverable interruption reason
  // (interrupted=true, interruptionReason='interrupted_by_scaledown') WITHOUT
  // changing the job's status — the job stays `running` while it is auto-retried,
  // so the existing status enum stays backward compatible. `encoreJobId` is our
  // externalId (same id onDispatched/onJobsDropped resolve by). Best-effort: the
  // scaler swallows a thrown hook so a repo hiccup never blocks the re-enqueue.
  onJobInterrupted?: (encoreJobId: string, reason: 'interrupted_by_scaledown') => Promise<void>;
};

export type EncoreInstanceRecord = {
  instanceId: string; // OSC instance id (its `name`)
  url: string; // HTTP base URL of the Encore instance
  // HTTP base URL of the paired callback listener spawned alongside this
  // Encore instance. Undefined until the listener is ready.
  callbackListenerUrl?: string;
  // Set once the scaler has confirmed this instance's OUTBOUND TLS trust path
  // to its per-instance callback-listener ingress hostname is established
  // (issue #463): a real HTTPS probe to callbackListenerUrl that would surface
  // a PKIX/handshake/connection failure. Until this is set the instance is NOT
  // eligible for its first job. Once set it is never re-probed (no added
  // latency for already-warm instances). `callbackTrustConfirmedAt` records the
  // epoch-ms the probe passed (observability); `callbackTrustReady` is the gate.
  callbackTrustReady?: boolean;
  callbackTrustConfirmedAt?: number;
  // Epoch-ms of the FIRST trust probe attempt for this instance (issue #463).
  // The trust gate is a bounded WAIT across re-probes, not a single shot: an
  // early probe can fail with a transient PKIX/handshake error because the
  // per-instance callback-listener ingress certificate becomes trusted ~35s
  // after spawn. We therefore re-probe on later ticks and only quarantine once
  // (Date.now() - callbackTrustFirstProbeAt) exceeds callbackTrustTimeoutMs.
  // Persisted so the deadline survives across ticks and instance reloads.
  callbackTrustFirstProbeAt?: number;
  // Set when the trust probe fails to pass within the bounded wait
  // callbackTrustTimeoutMs (issue #463): the instance is quarantined from job
  // assignment and NOT dispatched to. Records the epoch-ms the quarantine was
  // applied so the condition is queryable rather than silently retried forever.
  callbackTrustQuarantinedAt?: number;
  // Set when the trust probe kept getting an authorisation rejection (HTTP
  // 401/403) from the paired callback-listener ingress for the whole bounded
  // wait (issue #813). The TLS trust path is fine but the callback path is NOT
  // usable: Encore's progress/completion POST will be rejected the same way, so
  // this instance's jobs are completed by the terminal-job reconciliation sweep
  // (src/pipeline/encore-callback-poller.ts sweepTerminalJobs) instead of by
  // callbacks. This is a DEGRADED state, explicitly distinct from
  // `callbackTrustReady` (callback path confirmed working): the instance is
  // still dispatched to — halting the pool would be worse than sweep-only
  // completion — but the condition is persisted (and logged) so an operator or
  // an alert can see it. `callbackPathUnusableStatus` records the rejecting
  // status for triage.
  callbackPathUnusableAt?: number;
  callbackPathUnusableStatus?: number;
  activeJobs: number; // jobs currently running on this instance
  lastIdleAt: number; // epoch ms when activeJobs last reached 0
  // Epoch ms at which this instance entered the pool ready to take work (#778).
  // The idle clock's FALLBACK basis: `lastIdleAt` only advances when a job
  // COMPLETES (encore-callback-poller.ts:320, routes/internal.ts:194), so an
  // instance that is spawned and never dispatched a job has no completion to
  // key off. Recording readiness explicitly means "never dispatched" is idle
  // from the moment it became ready and the existing idleTimeoutMs applies to
  // it like any other idle instance. Optional so records written by an earlier
  // version (or hand-repaired out of band) still load; the scale-down path
  // fails CLOSED when neither timestamp is a usable number — see
  // resolveIdleSince() in scaler-loop.ts.
  readyAt?: number;
  // Set when scale-down has selected this instance for teardown but it still
  // has real in-flight work (issue #513, drain-don't-kill). A draining instance
  // is removed from routing (never dispatched a new job) and is only torn down
  // once its real active-job count reaches zero. This prevents scale-down from
  // ever killing an instance with a genuine in-flight transcode when the tracked
  // activeJobs count has diverged from the instance's real IN_PROGRESS state.
  draining?: boolean;
};

export type QueuedJob = {
  jobId: string; // Our correlation id (encoreJobId / externalId)
  payload: Record<string, unknown>; // The raw Encore job payload to POST
  enqueuedAt: number;
  // Epoch ms before which this job must NOT be dispatched. Set when a job is
  // re-queued after a transport-class failure so the backoff (#295) is honoured
  // without the scaler loop blocking. Absent/0 => dispatch immediately.
  notBefore?: number;
  // How many times this job has already been dispatched to an Encore instance.
  // Absent on a first-time submission (treated as 0); set to the current attempt
  // count when a job is re-queued for a transport-class retry (#295).
  attempts?: number;
};

// Per-instance job capacity. OSC Encore instances process one job at a time by
// default; the scaler treats an instance as "busy" once it hits this count.
export const JOBS_PER_INSTANCE = 1;

// Valkey key builders — the single source of truth for the key schema so the
// loop and the router never drift.
export const keys = {
  queue: (workspaceId: string) => `encore:queue:${workspaceId}`,
  inflight: (workspaceId: string) => `encore:inflight:${workspaceId}`,
  pool: (workspaceId: string) => `encore:pool:${workspaceId}`,
  jobInstance: (workspaceId: string) => `encore:job-instance:${workspaceId}`,
  jobStatus: (workspaceId: string) => `encore:job-status:${workspaceId}`,
  // Encore-assigned UUID for a job (stored at dispatch time, TTL 24h).
  // Keyed by our encoreJobId (externalId) across workspaces since it's unique.
  jobUuid: (encoreJobId: string) => `encore:job-uuid:${encoreJobId}`,
  // Reverse mapping: Encore UUID → our externalId (encoreJobId). Stored at
  // dispatch time alongside jobUuid so the callback poller can resolve the
  // correct Encore instance URL even when the callback listener's built-in URL
  // points at the wrong (non-scaler) instance.
  uuidToExternalId: (encoreUuid: string) => `encore:uuid-ext:${encoreUuid}`,
  // Full Encore job URL (instanceUrl/encoreJobs/uuid) stored at dispatch time
  // with a 24h TTL. Lets the callback poller resolve the packaging URL without
  // depending on the instance still being in the pool — the scaler may have
  // already torn down the instance by the time the transcode callback arrives.
  jobEncoreUrl: (encoreJobId: string) => `encore:job-url:${encoreJobId}`,
  // Original Encore job payload, stored at dispatch time with a 24h TTL so a
  // transport-class failure can be re-dispatched (#295) without the caller
  // re-submitting. Keyed by our externalId (encoreJobId), which is globally
  // unique. Cleared once the job settles (success or exhausted retries).
  jobPayload: (encoreJobId: string) => `encore:job-payload:${encoreJobId}`,
  // How many times this job has been *dispatched* to an Encore instance (#295).
  // Starts at 1 on first dispatch and increments on each transport-class
  // re-dispatch. Bounded by MAX_ENCODE_ATTEMPTS. 24h TTL; cleared on settle.
  jobAttempts: (encoreJobId: string) => `encore:job-attempts:${encoreJobId}`,
  // #708: short-lived timestamp (Unix ms, stored as a string) written by the
  // callback poller the moment it accepts a job's completion, keyed by our
  // externalId (encoreJobId, globally unique like jobUuid). reconcile() reads it
  // to close the ~4.4s race in which it may diff the active-job set AFTER Encore
  // has dropped the finished job but BEFORE the poller has decremented
  // record.activeJobs — a job seen completing within the grace window
  // (reconcileGraceMs) is NOT re-raised as silently dropped. Given a PX TTL just
  // over the grace window so the key self-expires; the poller also deletes it on
  // the same completion path once the decrement is durably applied.
  jobCompletionSeen: (encoreJobId: string) => `encore:job-completion-seen:${encoreJobId}`,
  // #525 pt.2: set of encoreJobIds (externalIds) whose packaging has been
  // handed off but not yet confirmed complete, keyed per Encore instance. The
  // scaler's teardown eligibility check treats a non-empty set here as real
  // work, even when Encore itself already reports the instance's transcode
  // job(s) terminal — closing the race where scale-down destroys an instance
  // (minInstances:0, short idleTimeoutMs) before the packager has had a
  // chance to GET that instance's /encoreJobs/{uuid} endpoint. See
  // src/encore-scaler/packaging-pin.ts.
  pendingPackaging: (instanceId: string) => `encore:pending-packaging:${instanceId}`,
  // #778: hash of orphan-candidate instanceId -> epoch ms (string) of the FIRST
  // sweep that saw a scaler-owned Encore instance running on OSC with no pool
  // record. The orphan reaper only destroys an instance that is still orphaned
  // after the grace window, so an instance mid-spawn (created on OSC, pool
  // record not yet written — instance-pool.ts spawnInstance) is never reaped
  // out from under the spawn that is still in progress. Entries are deleted as
  // soon as the instance is adopted into the pool, reaped, or disappears.
  orphanSeen: (workspaceId: string) => `encore:orphan-seen:${workspaceId}`
};
