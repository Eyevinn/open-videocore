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
import { EncoreScalerLoop } from './scaler-loop.js';
import { makeScalingEncoreClient } from './index.js';
import { destroyInstance, listInstances, reconcilePoolFromOsc } from './instance-pool.js';
import { keys } from './types.js';
import type { EncoreScalerConfig } from './types.js';

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
  // path.
  onJobsDropped?: (encoreJobIds: string[]) => Promise<void>;
  // Forwarded to every per-workspace scaler loop: invoked when a job is
  // classified 'interrupted_by_scaledown' at the drain boundary (#514) and
  // re-enqueued for auto-retry (#515). The scaler owns no repos, so main.ts
  // annotates the caller-facing Job with the recoverable interruption reason
  // (without changing its status).
  onJobInterrupted?: (encoreJobId: string, reason: 'interrupted_by_scaledown') => Promise<void>;
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

  constructor(private readonly config: WorkspaceEncoreScalerConfig) {}

  // Resolve (and cache) the Valkey connection + URL for a stack key (issue #615).
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
  private async resolveStackRedis(
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
      // The stack has no stored Valkey URL (e.g. the fixed deployment context of
      // a single-stack env-override run, which is not itself a provisioned stack).
      // Fall back to the injected connection rather than fabricating one.
      const fallback = {
        redis: this.config.redis,
        redisUrl: this.config.redisUrl,
        owned: false
      };
      this.redisConnections.set(stackKey, fallback);
      return { redis: fallback.redis, redisUrl: fallback.redisUrl };
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
  async resumeExistingWorkspaces(): Promise<void> {
    // The restart discovery scan runs against the injected process-global
    // connection (`this.config.redis` — the first-provisioned stack's Valkey).
    // Once a workspaceId is discovered, resolveStackRedis() below re-binds it to
    // its OWN per-stack Valkey for reconcile + the live loop (issue #615), so job
    // routing is per-stack. A stack whose pool/queue keys live ONLY on a
    // different physical Valkey is not discovered by this scan on restart, but is
    // resumed lazily the moment a request/submit for it arrives (getOrCreate ->
    // resolveStackRedis). Documented in
    // docs/osc-feedback/incoming-issue615-per-stack-valkey-connection.md.
    const [poolKeys, queueKeys] = await Promise.all([
      this.config.redis.keys('encore:pool:*'),
      this.config.redis.keys('encore:queue:*')
    ]);
    const workspaceIdsWithPool = new Set<string>();
    const workspaceIds = new Set<string>();
    for (const key of poolKeys) {
      const id = key.slice('encore:pool:'.length);
      if (id) { workspaceIds.add(id); workspaceIdsWithPool.add(id); }
    }
    for (const key of queueKeys) {
      const id = key.slice('encore:queue:'.length);
      if (id) workspaceIds.add(id);
    }

    for (const workspaceId of workspaceIds) {
      // Reconcile from OSC when the pool is absent or empty — this re-discovers
      // any instances that survived a Valkey wipe or unclean shutdown so the
      // loop can dispatch to them rather than spawning duplicates.
      if (!workspaceIdsWithPool.has(workspaceId)) {
        let s3Config = this.config.s3Config;
        if (this.config.resolveS3Config) {
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
    }
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

    // 2. Destroy every pooled instance. Reads directly from THIS stack's Valkey
    //    (issue #615) so teardown works even for a pool that outlived its
    //    in-memory loop (e.g. resumed by resumeExistingWorkspaces() but never
    //    re-registered). A missing/empty pool yields an empty list — a clean
    //    no-op. If Redis itself is unavailable the read rejects; swallow it so
    //    teardown stays a no-op (there is nothing we can safely destroy without
    //    the pool state), but still close the per-stack connection in step 3.
    const { redis, redisUrl } = await this.resolveStackRedis(workspaceId);
    let instances: Awaited<ReturnType<typeof listInstances>> = [];
    try {
      instances = await listInstances(redis, workspaceId);
    } catch {
      instances = [];
    }

    if (instances.length > 0) {
      // destroyInstance() only reads oscContext, redis and workspaceId from the
      // config (instance-pool.ts:171-198). Build a minimal correctly-typed config
      // for this workspace; getToken is required by the type but unused on the
      // teardown path.
      const scalerConfig: EncoreScalerConfig = {
        workspaceId,
        maxInstances: this.config.maxInstances,
        minInstances: this.config.minInstances,
        idleTimeoutMs: this.config.idleTimeoutMs,
        oscContext: this.config.oscContext,
        redis,
        redisUrl,
        getToken: () => this.config.oscContext.getServiceAccessToken('encore'),
        s3Config: this.config.s3Config,
        profilesUrl: this.config.profilesUrl,
        onDispatched: this.config.onDispatched
      };

      for (const inst of instances) {
        await destroyInstance(inst.instanceId, scalerConfig);
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
