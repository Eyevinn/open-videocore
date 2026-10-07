// Multi-workspace Encore scaler registry.
//
// One EncoreScalerLoop per workspace, created lazily on first submit. Each loop
// resolves and owns its OWN physical Valkey connection for the stack it serves
// (issue #615): the queue backbone is per-stack, so a job keyed to stack B is
// enqueued on stack B's Valkey — not stack A's. The OSC context is shared; the
// workspaceId, pool keys, MinIO endpoint, AND Valkey connection are all resolved
// per stack. When no per-stack resolver is wired (env-override single-stack
// deployments, tests) every loop falls back to the single injected `redis`.
//
// This implements EncoreClient so it can replace PerWorkspaceEncoreClient in
// main.ts with no changes to call sites. The workspaceId is decoded from the
// externalId embedded in every EncoreSubmitInput (see encodeEncoreJobId in
// data/job-repo.ts: format is `{workspaceId}::{jobLocalId}`).

import type { Redis } from 'ioredis';
import type { Context } from '@osaas/client-core';
import type { EncoreClient, EncoreSubmitInput, EncoreSubmitResult } from '../pipeline/encore-client.js';
import { decodeEncoreJobId } from '../data/job-repo.js';
import {
  DEFAULT_ORPHAN_REAP_INTERVAL_MS,
  EncoreScalerLoop
} from './scaler-loop.js';
import { makeScalingEncoreClient } from './index.js';
import { destroyInstance, listInstances, reconcilePoolFromOsc } from './instance-pool.js';
import { keys } from './types.js';
import { valkeyConnectionId } from './valkey-connection-id.js';
import type { DroppedJob, EncoreScalerConfig } from './types.js';

export type WorkspaceEncoreScalerConfig = {
  redis: Redis;
  oscContext: Context;
  maxInstances: number;
  minInstances?: number;
  // Optional operator-configured job-throughput cap (issue #580): max number of
  // OUTSTANDING jobs (queued + being dispatched) admitted per deployment before
  // submission is rejected with a 429. Unset => no cap (opt-in). Forwarded to
  // every per-workspace scaler client so the submit path enforces it against the
  // scaler's own Valkey state. See src/encore-scaler/job-throughput-cap.ts.
  maxQueuedJobs?: number;
  idleTimeoutMs: number;
  // Bounded wait (ms) forwarded to every per-workspace scaler loop for the
  // outbound callback-listener TLS-trust probe that gates first-job dispatch
  // (issue #463). Undefined uses the loop's built-in default.
  callbackTrustTimeoutMs?: number;
  // Grace window (ms) forwarded to every per-workspace scaler loop for the
  // reconcile dropped-job diff (issue #708): a job the callback poller recorded
  // completing within this window is not re-raised as silently dropped.
  // Undefined uses the loop's built-in default (DEFAULT_RECONCILE_GRACE_MS).
  reconcileGraceMs?: number;
  // #778: how often (ms) each per-workspace loop sweeps OSC for scaler-owned
  // Encore instances with no pool record and destroys the ones that have stayed
  // orphaned past the grace window. Undefined enables the sweep at
  // DEFAULT_ORPHAN_REAP_INTERVAL_MS; set to 0 to disable it entirely.
  orphanReapIntervalMs?: number;
  // #778: how long (ms) an instance must be continuously observed orphaned
  // before it is reaped. Undefined uses DEFAULT_ORPHAN_GRACE_MS (instance-pool).
  orphanGraceMs?: number;
  // #1071: bounded wait (ms) forwarded to every per-workspace loop for a freshly
  // created OSC instance to report `running`. Must cover OSC provisioning a new
  // worker node, not just a pod starting on an existing one. Undefined uses
  // DEFAULT_SPAWN_READY_TIMEOUT_MS (instance-pool, 15 min).
  spawnReadyTimeoutMs?: number;
  // Redis connection string forwarded to each spawned callback listener.
  redisUrl: string;
  // Optional per-stack Valkey resolver (issue #615). When supplied, called once
  // at loop creation time with the loop key (the EFFECTIVE stack identity the
  // transcode request resolved to) and preferred over the process-global
  // `redisUrl`/`redis` fields. Mirrors resolveS3Config below: each provisioned
  // stack has its OWN Valkey instance (provision.ts step 3 + StackConfig.redisUrl
  // in param-store.ts), so resolving the URL per stack lets each per-stack loop
  // enqueue/dispatch on its own physical Valkey rather than sharing stack A's.
  // Returns undefined when the stack has no stored Valkey URL — the loop then
  // falls back to the injected `redisUrl`/`redis` (unchanged single-Valkey
  // behaviour) rather than silently mis-routing.
  resolveRedisUrl?: (stackKey: string) => Promise<string | undefined>;
  // Optional enumeration of the stacks that have been provisioned (issue #1074).
  // Used ONLY by listStackConnections() below, so a read-only observer (GET
  // /scaler/status) can cover a stack whose loop has not been created yet in this
  // process — the case where a per-stack pool was invisible rather than reported
  // empty. Returns the stack keys loops are keyed by (the same identity
  // resolveRedisUrl is called with). When absent, listStackConnections() reports
  // only the stacks this registry has already resolved a connection for.
  listStackKeys?: () => Promise<string[]>;
  // Factory that opens a Valkey connection for a resolved per-stack URL (issue
  // #615). Injected (not `new IORedis` inline) so the registry stays free of a
  // hard ioredis dependency and tests can supply a fake connection. main.ts
  // wires this to the same `new IORedis(url, { lazyConnect, maxRetriesPerRequest:
  // null })` construction it uses for the process-global connection. Required
  // for per-stack connections to be created; when absent, resolveRedisUrl is
  // ignored and every loop uses the injected `redis`.
  makeRedis?: (redisUrl: string) => Redis;
  tickIntervalMs?: number;
  s3Config?: import('./types.js').EncoreS3Config;
  // Optional per-stack S3 config resolver. When supplied, called once at loop
  // creation time and preferred over the static s3Config field. Allows the
  // MinIO endpoint to be resolved from the parameter store per stack rather than
  // requiring a static ENCORE_S3_ENDPOINT env var. The argument is the loop key,
  // which is the EFFECTIVE stack identity the transcode request resolved to
  // (issue #615 — decoded from the encoreJobId contextId), so the endpoint is
  // resolved for the named stack, never the first-provisioned one.
  resolveS3Config?: (stackKey: string) => Promise<import('./types.js').EncoreS3Config | undefined>;
  // Forwarded to every spawned Encore instance as its `profilesUrl` so it loads
  // operator-managed profiles from this API's public index (issue #84).
  profilesUrl?: string;
  // Forwarded to every per-workspace scaler loop: invoked after a queued job is
  // dispatched to an Encore instance so the Job record can advance queued->running.
  onDispatched?: (encoreJobId: string) => Promise<void>;
  // Forwarded to every per-workspace scaler loop: invoked after each dispatch to
  // durably capture the encode attempt on the Job record (ADR-012, #380), so the
  // attempt history outlives the TTL'd Valkey retry counter.
  onEncodeDispatched?: (encoreJobId: string, attempt: number) => Promise<void>;
  // Forwarded to every per-workspace scaler loop: invoked once per tick to
  // reconcile transcode jobs stuck non-terminal against Encore FAILED/404
  // outcomes (issue #273). The scaler owns no repos, so main.ts supplies the
  // repo-driven sweep here.
  reconcileFailedTranscodes?: () => Promise<void>;
  // Forwarded to every per-workspace scaler loop: invoked by reconcile() when it
  // detects tracked jobs silently dropped from an Encore instance's active set
  // with no completion callback (issue #449). The scaler owns no repos, so
  // main.ts drives each id to a terminal `failed` state via the shared settle
  // path. Each drop carries Encore's own failure text when reconcile() could
  // recover it (issue #704) — see DroppedJob.
  onJobsDropped?: (drops: DroppedJob[]) => Promise<void>;
  // Forwarded to every per-workspace scaler loop: invoked when a job is
  // classified 'interrupted_by_scaledown' at the drain boundary (#514) and
  // re-enqueued for auto-retry (#515). The scaler owns no repos, so main.ts
  // annotates the caller-facing Job with the recoverable interruption reason
  // (without changing its status).
  onJobInterrupted?: (encoreJobId: string, reason: 'interrupted_by_scaledown') => Promise<void>;
};

// How long a stack enumeration (listStackKeys) is reused before it is fetched
// again (issue #1074). listStackConnections() is driven by GET /scaler/status,
// which is deliberately unauthenticated, so without a window every status read
// would be an external parameter-store call — one unauthenticated request
// amplified into platform load. 30s is short enough that a freshly provisioned
// stack shows up promptly (and its loop registers it immediately on first submit
// regardless) and long enough that polling the endpoint costs nothing.
const STACK_KEYS_CACHE_MS = 30_000;

// One provisioned stack and the Valkey its scaler loop reads and writes (issue
// #1074). Handed to read-only observers so they can query the SAME physical store
// the loop uses instead of the process-global one.
//
// `redis` is undefined when the connection could not be resolved at all — the
// stack is then reportable as UNOBSERVED (with `unobservedReason`) rather than
// omitted, which is the whole point: "no instances in this pool" and "this pool
// was never looked at" must not render identically.
//
// `connectionId` is the non-secret label from valkeyConnectionId() — never the
// URL, because the status endpoint that consumes this is unauthenticated.
export type ScalerStackConnection = {
  stackKey: string;
  connectionId?: string;
  redis?: Redis;
  unobservedReason?: string;
};

export class WorkspaceEncoreScalerRegistry implements EncoreClient {
  private readonly loops = new Map<string, { client: EncoreClient; loop: EncoreScalerLoop }>();

  // Per-stack Valkey connections (issue #615). Bounded by the number of DISTINCT
  // resolved stack keys, NOT by request volume: connections are created lazily in
  // resolveStackRedis() and cached here keyed by stackKey, and getOrCreate() (the
  // only per-request entry point) reuses the cached loop before it ever reaches
  // connection creation. So the connection count can never exceed the number of
  // provisioned stacks. `owned=true` means this registry opened the connection
  // (via makeRedis) and must close it on teardown; the fallback process-global
  // `this.config.redis` is owned by main.ts and left untouched.
  private readonly redisConnections = new Map<
    string,
    { redis: Redis; redisUrl: string; owned: boolean }
  >();

  // Last stack enumeration and when it was taken (issue #1074). Bounds the
  // external parameter-store reads an unauthenticated status poll can trigger,
  // and doubles as the fallback when a later enumeration fails: reporting the
  // previously known stacks beats reporting none.
  private stackKeysCache?: { keys: string[]; at: number };

  constructor(private readonly config: WorkspaceEncoreScalerConfig) {}

  // Resolve (and cache) the Valkey connection + URL for a stack key (issue #615).
  // Public: main.ts hands the per-stack connection to everything that reads
  // scaler state for one stack outside a loop — the per-stack callback pollers,
  // the packaging queue, the routes' job-instance / pin lookups and the
  // reconcile drop hook's retry gate — so no consumer is left on the
  // process-global connection by default.
  //
  // Mirrors how resolveS3Config resolves the MinIO endpoint per stack: the
  // resolveRedisUrl hook loads the stack's own StackConfig.redisUrl, and makeRedis
  // opens a connection to it. Cached per stackKey so the number of physical
  // connections stays bounded by the number of provisioned stacks (the loop cache
  // above already short-circuits repeat requests, but this second cache also makes
  // resumeExistingWorkspaces / teardown share the exact same connection object).
  //
  // Degrades safely (never silently shares stack A's connection for stack B): when
  // no resolver/factory is wired, or the stack has no stored redisUrl, it falls
  // back to the injected process-global `redis`/`redisUrl` — the unchanged
  // single-Valkey behaviour used by env-override deployments and tests.
  async resolveStackRedis(
    stackKey: string
  ): Promise<{ redis: Redis; redisUrl: string }> {
    const cached = this.redisConnections.get(stackKey);
    if (cached) return { redis: cached.redis, redisUrl: cached.redisUrl };

    // No per-stack resolution wired: use the injected process-global connection.
    if (!this.config.resolveRedisUrl || !this.config.makeRedis) {
      return { redis: this.config.redis, redisUrl: this.config.redisUrl };
    }

    const perStackUrl = await this.config.resolveRedisUrl(stackKey);
    if (!perStackUrl) {
      // The stack has no stored Valkey URL: the fixed deployment context of a
      // single-stack env-override run (not itself a provisioned stack), or a
      // stack still being provisioned whose config carries no redisUrl yet.
      // Fall back to the injected connection rather than fabricating one, but
      // do NOT cache it: a stack resolved mid-provision (a status read, a
      // poller sync) would otherwise stay bound to the first stack's Valkey
      // until the process restarted, with its loop, completions and packaging
      // all on the wrong store.
      return { redis: this.config.redis, redisUrl: this.config.redisUrl };
    }

    // If this stack's URL is identical to the process-global one, reuse the
    // already-open injected connection instead of opening a duplicate socket to
    // the same server (keeps the bound at "one per DISTINCT Valkey").
    if (perStackUrl === this.config.redisUrl) {
      const shared = {
        redis: this.config.redis,
        redisUrl: this.config.redisUrl,
        owned: false
      };
      this.redisConnections.set(stackKey, shared);
      return { redis: shared.redis, redisUrl: shared.redisUrl };
    }

    const redis = this.config.makeRedis(perStackUrl);
    this.redisConnections.set(stackKey, {
      redis,
      redisUrl: perStackUrl,
      owned: true
    });
    return { redis, redisUrl: perStackUrl };
  }

  // The Valkey holding the scaler state of the stack an Encore job was
  // dispatched on. Every scaler key is namespaced by the job's stack — the
  // encoreJobId prefix (keys in types.ts) — and lives on THAT stack's Valkey
  // (issue #615), so a reader of the job-instance / job-url / packaging-pin /
  // retry keys must use this connection, never the process-global one, or it
  // reads an empty namespace for every stack but the first. An undecodable id
  // falls back to the injected connection.
  async redisForEncoreJob(encoreJobId: string): Promise<Redis> {
    const decoded = decodeEncoreJobId(encoreJobId);
    if (!decoded) return this.config.redis;
    return (await this.resolveStackRedis(decoded.workspaceId)).redis;
  }

  // Provisioned stack keys, cached for STACK_KEYS_CACHE_MS (issue #1074). Never
  // throws: an enumeration failure yields the last known list, or an empty one,
  // so listStackConnections() still reports the stacks this registry already
  // holds connections for.
  private async enumerateStackKeys(fresh = false): Promise<string[]> {
    if (!this.config.listStackKeys) return [];
    const cached = this.stackKeysCache;
    if (!fresh && cached && Date.now() - cached.at < STACK_KEYS_CACHE_MS) return cached.keys;
    try {
      const keys = (await this.config.listStackKeys()).filter((key) => key.length > 0);
      this.stackKeysCache = { keys, at: Date.now() };
      return keys;
    } catch {
      // Parameter store unreachable: reuse the previous answer (stale beats
      // blank) and retry on the next call rather than caching the failure.
      return cached?.keys ?? [];
    }
  }

  // Every stack this registry can observe, paired with the Valkey its loop uses
  // (issue #1074).
  //
  // GET /scaler/status used to read the process-global connection only, so a pool
  // living on a per-stack Valkey was ABSENT from the response rather than shown
  // as empty, and a depth could be read from a different physical store than the
  // loop evaluated. This is the accessor that lets the status route fan out over
  // the same connections the loops actually use.
  //
  // The stack set is the union of:
  //   - `listStackKeys()` (provisioned stacks, including ones with no loop in
  //     this process yet — exactly the invisible case),
  //   - the live loop keys, and
  //   - the stack keys that already have a cached connection.
  // so nothing already known is dropped if the enumeration hook is absent or
  // fails.
  //
  // Resolution goes through resolveStackRedis(), NOT a re-implementation, so the
  // observer is handed the identical connection object the loop uses. That can
  // open a per-stack connection for a stack with no loop yet; it stays bounded by
  // the number of provisioned stacks (the cache is keyed by stackKey), the clients
  // are lazyConnect, and stopAll()/teardown() dispose the ones this registry owns.
  // Resolved sequentially rather than in parallel so two concurrent observations
  // cannot race the per-stack connection cache into opening duplicate sockets.
  //
  // `fresh` bypasses the enumeration cache. The unauthenticated status read
  // keeps the cache; a caller reacting to a provision or deprovision (the
  // per-stack callback-poller sync in main.ts) must see the stack that was just
  // added or removed, not a list cached by a status poll seconds earlier.
  async listStackConnections(
    options: { fresh?: boolean } = {}
  ): Promise<ScalerStackConnection[]> {
    const stackKeys = new Set<string>();
    for (const key of await this.enumerateStackKeys(options.fresh === true)) {
      stackKeys.add(key);
    }
    for (const key of this.loops.keys()) stackKeys.add(key);
    for (const key of this.redisConnections.keys()) stackKeys.add(key);

    const connections: ScalerStackConnection[] = [];
    for (const stackKey of stackKeys) {
      try {
        const { redis, redisUrl } = await this.resolveStackRedis(stackKey);
        connections.push({
          stackKey,
          connectionId: valkeyConnectionId(redisUrl),
          redis
        });
      } catch {
        // No error text is carried out of here. The consumer of this list is the
        // unauthenticated status endpoint, and a connection-open failure quotes
        // the connection string it failed on. The SHAPE of the fault is reported;
        // the detail stays in the server log.
        connections.push({
          stackKey,
          unobservedReason: "this stack's Valkey connection could not be resolved"
        });
      }
    }
    return connections;
  }

  // `workspaceId` here is the loop key: the EFFECTIVE stack identity the request
  // resolved to (issue #615), decoded from the encoreJobId contextId. The loop
  // cache and every per-stack coordinate (Encore pool, Valkey queue keys, MinIO
  // endpoint via resolveS3Config) are keyed by it, so two stacks in one workspace
  // never share a mis-resolved client.
  private async getOrCreate(workspaceId: string): Promise<EncoreClient> {
    const existing = this.loops.get(workspaceId);
    if (existing) return existing.client;

    let s3Config = this.config.s3Config;
    if (this.config.resolveS3Config) {
      s3Config = (await this.config.resolveS3Config(workspaceId)) ?? s3Config;
    }

    // Resolve this stack's OWN Valkey connection + URL (issue #615) so the loop's
    // queue/dispatch and the callback listeners it spawns all use the physical
    // Valkey belonging to this stack, not the first-provisioned one.
    const { redis, redisUrl } = await this.resolveStackRedis(workspaceId);

    const scalerConfig: EncoreScalerConfig = {
      workspaceId,
      maxInstances: this.config.maxInstances,
      minInstances: this.config.minInstances,
      maxQueuedJobs: this.config.maxQueuedJobs,
      idleTimeoutMs: this.config.idleTimeoutMs,
      callbackTrustTimeoutMs: this.config.callbackTrustTimeoutMs,
      reconcileGraceMs: this.config.reconcileGraceMs,
      // #778: enable the orphan sweep for every live loop. Instances that never
      // made it into (or were lost from) the pool hash are invisible to every
      // other teardown path, so without this they bill until an operator spots
      // them by hand.
      orphanReapIntervalMs:
        this.config.orphanReapIntervalMs ?? DEFAULT_ORPHAN_REAP_INTERVAL_MS,
      orphanGraceMs: this.config.orphanGraceMs,
      // #1071: node provisioning can take minutes; a spawn must be allowed to
      // wait for it rather than timing out and tearing the half-born instance
      // down.
      spawnReadyTimeoutMs: this.config.spawnReadyTimeoutMs,
      oscContext: this.config.oscContext,
      redis,
      redisUrl,
      getToken: () => this.config.oscContext.getServiceAccessToken('encore'),
      s3Config,
      profilesUrl: this.config.profilesUrl,
      onDispatched: this.config.onDispatched,
      onEncodeDispatched: this.config.onEncodeDispatched,
      reconcileFailedTranscodes: this.config.reconcileFailedTranscodes,
      onJobsDropped: this.config.onJobsDropped,
      onJobInterrupted: this.config.onJobInterrupted
    };

    const loop = new EncoreScalerLoop(scalerConfig);
    loop.start(this.config.tickIntervalMs ?? 10_000);

    const client = makeScalingEncoreClient(scalerConfig);
    this.loops.set(workspaceId, { client, loop });
    return client;
  }

  async submit(input: EncoreSubmitInput): Promise<EncoreSubmitResult> {
    const decoded = decodeEncoreJobId(input.externalId);
    if (!decoded) {
      throw new Error(`Cannot decode workspaceId from externalId: ${input.externalId}`);
    }
    return (await this.getOrCreate(decoded.workspaceId)).submit(input);
  }

  async getJobStatus(encoreJobId: string): Promise<string | undefined> {
    const decoded = decodeEncoreJobId(encoreJobId);
    if (!decoded) return undefined;
    return (await this.getOrCreate(decoded.workspaceId)).getJobStatus(encoreJobId);
  }

  async cancel(encoreJobId: string): Promise<void> {
    const decoded = decodeEncoreJobId(encoreJobId);
    // Unknown workspace: nothing to cancel — treat as an idempotent no-op,
    // mirroring getJobStatus above.
    if (!decoded) return;
    return (await this.getOrCreate(decoded.workspaceId)).cancel(encoreJobId);
  }

  setMaxInstances(max: number): void {
    this.config.maxInstances = max;
    for (const { loop } of this.loops.values()) {
      loop.setMaxInstances(max);
    }
  }

  setIdleTimeoutMs(ms: number): void {
    this.config.idleTimeoutMs = ms;
    for (const { loop } of this.loops.values()) {
      loop.setIdleTimeoutMs(ms);
    }
  }

  // Scan Redis for workspaceIds that have an existing pool OR a pending queue
  // and start their loops immediately. Pool keys cover the normal restart case
  // (instances already spawned). Queue keys cover the case where a job was
  // submitted but no instance was ever spawned yet.
  //
  // When a queue key exists but no pool key (or pool is empty), the pool may
  // have been lost due to an unclean shutdown or Valkey restart while OSC
  // instances kept running. In that case, reconcilePoolFromOsc() re-discovers
  // those instances from OSC and re-populates the pool so the loop can dispatch
  // to them instead of spawning fresh duplicates.
  //
  // ISOLATION (review follow-up on #804): each workspace is resumed inside its
  // own try/catch. Since #804 `resolveS3Config` FAILS LOUD — it throws when no
  // object-store endpoint is resolvable and no static fallback is configured
  // (services/encore-s3-config.ts) — and `resolveStackRedis` / OSC calls can
  // throw too. Without a per-iteration guard, one unresolvable stack early in
  // the loop would abandon the resume for every remaining workspace, so a
  // single broken stack could starve every healthy one of its scaler loop on
  // restart. Log and continue instead: a stack that cannot be resumed here is
  // still resumed lazily on its next request (getOrCreate).
  //
  // `log` mirrors teardownAll's injected-callback shape
  // (workspace-registry.ts: `teardownAll(log?: (msg: string, err?: unknown) =>
  // void)`) so the registry keeps no logger dependency of its own.
  async resumeExistingWorkspaces(
    log?: (msg: string, err?: unknown) => void
  ): Promise<void> {
    // The restart discovery scan covers EVERY stack's Valkey, not only the
    // injected process-global connection (the first-provisioned stack's). Each
    // stack's pool/queue keys live on its own Valkey (issue #615), so a scan of
    // the first stack's store alone never found another stack's running pool:
    // that stack came back with no loop — no reconcile, no idle scale-down, no
    // dispatch of its queued jobs — until a request for it happened to arrive.
    // Once a workspaceId is discovered, resolveStackRedis() below binds it to
    // its own per-stack Valkey for reconcile + the live loop.
    const workspaceIdsWithPool = new Set<string>();
    const workspaceIds = new Set<string>();
    for (const { redis, connectionId } of await this.distinctStackRedis(log)) {
      let poolKeys: string[];
      let queueKeys: string[];
      try {
        [poolKeys, queueKeys] = await Promise.all([
          redis.keys('encore:pool:*'),
          redis.keys('encore:queue:*')
        ]);
      } catch (err) {
        log?.(
          `encore-scaler: failed to scan Valkey ${connectionId} for pools/queues to ` +
            'resume; continuing with the remaining connections',
          err
        );
        continue;
      }
      for (const key of poolKeys) {
        const id = key.slice('encore:pool:'.length);
        if (id) { workspaceIds.add(id); workspaceIdsWithPool.add(id); }
      }
      for (const key of queueKeys) {
        const id = key.slice('encore:queue:'.length);
        if (id) workspaceIds.add(id);
      }
    }

    for (const workspaceId of workspaceIds) {
      // Per-workspace guard: one unresumable stack must not starve the rest.
      try {
        // Reconcile from OSC when the pool is absent or empty — this re-discovers
        // any instances that survived a Valkey wipe or unclean shutdown so the
        // loop can dispatch to them rather than spawning duplicates.
        if (!workspaceIdsWithPool.has(workspaceId)) {
          let s3Config = this.config.s3Config;
          if (this.config.resolveS3Config) {
            // Throws (not undefined) when no endpoint is resolvable and no static
            // fallback is set — see the fail-loud note on this method.
            s3Config = (await this.config.resolveS3Config(workspaceId)) ?? s3Config;
          }
          // Re-populate the pool on the stack's OWN Valkey (issue #615): resolve the
          // per-stack connection so the re-discovered instances are written to the
          // physical Valkey this workspace's loop will read from, not the
          // first-provisioned one.
          const { redis, redisUrl } = await this.resolveStackRedis(workspaceId);
          const scalerConfig = {
            workspaceId,
            maxInstances: this.config.maxInstances,
            minInstances: this.config.minInstances,
            idleTimeoutMs: this.config.idleTimeoutMs,
            oscContext: this.config.oscContext,
            redis,
            redisUrl,
            getToken: () => this.config.oscContext.getServiceAccessToken('encore'),
            s3Config,
            profilesUrl: this.config.profilesUrl,
            onDispatched: this.config.onDispatched
          };
          await reconcilePoolFromOsc(scalerConfig).catch(() => {
            // OSC unavailable at startup — skip; the loop will spawn fresh instances.
          });
        }
        await this.getOrCreate(workspaceId);
      } catch (err) {
        log?.(
          `encore-scaler: failed to resume workspace ${workspaceId}; skipping it and ` +
            'continuing with the remaining workspaces (it will be resumed lazily on its ' +
            'next request)',
          err
        );
      }
    }
  }

  // Every physically distinct Valkey this registry can reach: the injected
  // process-global connection plus one per provisioned stack with its own
  // store, deduplicated by connectionId so a stack sharing the global Valkey is
  // not scanned twice. Resolution failures are logged and skipped, never thrown.
  private async distinctStackRedis(
    log?: (msg: string, err?: unknown) => void
  ): Promise<Array<{ redis: Redis; redisUrl: string; connectionId: string }>> {
    const byConnection = new Map<string, { redis: Redis; redisUrl: string }>();
    byConnection.set(valkeyConnectionId(this.config.redisUrl), {
      redis: this.config.redis,
      redisUrl: this.config.redisUrl
    });
    let connections: ScalerStackConnection[] = [];
    try {
      connections = await this.listStackConnections({ fresh: true });
    } catch (err) {
      log?.('encore-scaler: failed to enumerate stack Valkey connections to resume', err);
    }
    for (const connection of connections) {
      if (!connection.redis || !connection.connectionId) continue;
      if (!byConnection.has(connection.connectionId)) {
        byConnection.set(connection.connectionId, {
          redis: connection.redis,
          redisUrl:
            this.redisConnections.get(connection.stackKey)?.redisUrl ?? this.config.redisUrl
        });
      }
    }
    return [...byConnection].map(([connectionId, entry]) => ({ ...entry, connectionId }));
  }

  // Tear down a single workspace's scaler: stop its background loop and destroy
  // every pooled Encore OSC instance (and its paired callback listener). A clean
  // no-op when the workspace has no active loop/pool. Sub-task of #107.
  //
  // Contracts verified before writing (CLAUDE.md rule 7):
  //   - this.loops: Map<string, { client: EncoreClient; loop: EncoreScalerLoop }>
  //     (workspace-registry.ts:45)
  //   - EncoreScalerLoop.stop(): void (scaler-loop.ts:58)
  //   - listInstances(redis: Redis, workspaceId: string):
  //       Promise<EncoreInstanceRecord[]> (instance-pool.ts:52)
  //   - destroyInstance(instanceId: string, config: EncoreScalerConfig):
  //       Promise<void> (instance-pool.ts:171). It removes the Encore instance
  //     AND its same-named paired callback listener
  //     (ENCORE_CALLBACK_LISTENER_SERVICE_ID, instance-pool.ts:180-192) and is
  //     idempotent, so a missing instance never throws.
  //   - EncoreInstanceRecord.instanceId: string (types.ts:69)
  async teardown(workspaceId: string): Promise<void> {
    // 1. Stop the loop if this workspace has one, and remove it from the map so a
    //    later submit() re-creates a fresh loop via getOrCreate().
    const existing = this.loops.get(workspaceId);
    if (existing) {
      existing.loop.stop();
      this.loops.delete(workspaceId);
    }

    // 2. Destroy every pooled instance. Reads THIS stack's Valkey (issue #615)
    //    so teardown works even for a pool that outlived its in-memory loop
    //    (e.g. resumed by resumeExistingWorkspaces() but never re-registered),
    //    AND the injected first-stack Valkey when that is a different store: a
    //    stack resolved while its config had no Valkey URL yet used to be
    //    bound to the first stack's Valkey, so its pool could live there, and
    //    a stale copy of it would otherwise outlive the stack. On each store,
    //    every pooled instance is destroyed and the stack's scaler keys are
    //    purged. A missing/empty pool is a clean no-op. If a Valkey is
    //    unavailable its read rejects; swallow it so teardown still handles
    //    the other store and closes the per-stack connection in step 3.
    const { redis, redisUrl } = await this.resolveStackRedis(workspaceId);
    const stores: Array<{ redis: Redis; redisUrl: string }> = [{ redis, redisUrl }];
    // Every other Valkey this registry knows: the stale copy can be on
    // whichever stack's Valkey was the activation one when the fallback bound
    // this stack to it, and that is not necessarily the current first stack.
    const seen = new Set<Redis>([redis]);
    for (const other of await this.distinctStackRedis()) {
      if (seen.has(other.redis)) continue;
      seen.add(other.redis);
      stores.push({ redis: other.redis, redisUrl: other.redisUrl });
    }
    for (const store of stores) {
      let instances: Awaited<ReturnType<typeof listInstances>> = [];
      try {
        instances = await listInstances(store.redis, workspaceId);
      } catch {
        instances = [];
      }

      if (instances.length > 0) {
        // destroyInstance() only reads oscContext, redis and workspaceId from
        // the config (instance-pool.ts). Build a minimal correctly-typed config
        // for this workspace on THIS store; getToken is required by the type
        // but unused on the teardown path.
        const scalerConfig: EncoreScalerConfig = {
          workspaceId,
          maxInstances: this.config.maxInstances,
          minInstances: this.config.minInstances,
          idleTimeoutMs: this.config.idleTimeoutMs,
          reconcileGraceMs: this.config.reconcileGraceMs,
          oscContext: this.config.oscContext,
          redis: store.redis,
          redisUrl: store.redisUrl,
          getToken: () => this.config.oscContext.getServiceAccessToken('encore'),
          s3Config: this.config.s3Config,
          profilesUrl: this.config.profilesUrl,
          onDispatched: this.config.onDispatched
        };

        for (const inst of instances) {
          await destroyInstance(inst.instanceId, scalerConfig);
        }
      }

      // Purge the stack's remaining scaler keys on this store so a deprovisioned
      // stack neither shows up in GET /scaler/status nor is resumed at the next
      // boot. Best-effort: the stack's own Valkey is being deprovisioned anyway.
      try {
        await store.redis.del(
          keys.pool(workspaceId),
          keys.queue(workspaceId),
          keys.inflight(workspaceId),
          keys.jobInstance(workspaceId),
          keys.jobStatus(workspaceId),
          keys.orphanSeen(workspaceId),
          keys.spawnFailure(workspaceId)
        );
      } catch {
        // Unreachable store: nothing more to clean here.
      }
    }

    // 3. Close this stack's Valkey connection if THIS registry opened it (issue
    //    #615). The injected process-global connection (owned=false) is owned by
    //    main.ts and must NOT be closed here — deactivateScaler() disposes it.
    this.closeStackRedis(workspaceId);
  }

  // Close and forget a stack's per-stack Valkey connection, but only if this
  // registry opened it (owned=true). A no-op for a stack backed by the injected
  // process-global connection. Keeps the connection count bounded by disposing
  // sockets as stacks are torn down.
  private closeStackRedis(stackKey: string): void {
    const entry = this.redisConnections.get(stackKey);
    if (!entry) return;
    this.redisConnections.delete(stackKey);
    if (entry.owned) {
      try {
        entry.redis.disconnect();
      } catch {
        // Best-effort: a never-connected lazyConnect client or an already-closed
        // socket must not turn teardown into a throw.
      }
    }
  }

  // Destroy OSC instances for every active workspace, then stop all loops.
  // Called on graceful shutdown so leaked instances don't accumulate across
  // server restarts. If a workspace teardown fails it is logged and skipped
  // so one bad workspace never blocks the others from being cleaned up.
  async teardownAll(log?: (msg: string, err?: unknown) => void): Promise<void> {
    const workspaceIds = [...this.loops.keys()];
    for (const workspaceId of workspaceIds) {
      try {
        await this.teardown(workspaceId);
      } catch (err) {
        log?.(`encore-scaler: teardownAll failed for workspace ${workspaceId}`, err);
      }
    }
    // stopAll() as a safety net for any loop not already stopped by teardown().
    this.stopAll();
  }

  stopAll(): void {
    for (const { loop } of this.loops.values()) {
      loop.stop();
    }
    this.loops.clear();
    // Safety net: close any per-stack Valkey connection this registry opened
    // that a teardown() did not already dispose (issue #615). Owned connections
    // only; the injected process-global one is left for main.ts to close.
    for (const stackKey of [...this.redisConnections.keys()]) {
      this.closeStackRedis(stackKey);
    }
  }
}
