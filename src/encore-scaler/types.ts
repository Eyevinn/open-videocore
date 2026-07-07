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

export type EncoreScalerConfig = {
  workspaceId: string;
  maxInstances: number;
  // Minimum instances to keep warm even when idle (default 0). When >= 1 the
  // scaler pre-warms up to this many instances regardless of pending work.
  minInstances?: number;
  idleTimeoutMs: number; // default 5 * 60 * 1000
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
};

export type EncoreInstanceRecord = {
  instanceId: string; // OSC instance id (its `name`)
  url: string; // HTTP base URL of the Encore instance
  // HTTP base URL of the paired callback listener spawned alongside this
  // Encore instance. Undefined until the listener is ready.
  callbackListenerUrl?: string;
  activeJobs: number; // jobs currently running on this instance
  lastIdleAt: number; // epoch ms when activeJobs last reached 0
};

export type QueuedJob = {
  jobId: string; // Our correlation id (encoreJobId / externalId)
  payload: Record<string, unknown>; // The raw Encore job payload to POST
  enqueuedAt: number;
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
  uuidToExternalId: (encoreUuid: string) => `encore:uuid-ext:${encoreUuid}`
};
