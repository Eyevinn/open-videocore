// Multi-workspace Encore scaler registry.
//
// One EncoreScalerLoop per workspace, created lazily on first submit. All
// loops share the same Redis connection and OSC context; only the workspaceId
// and pool keys differ.
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
  idleTimeoutMs: number;
  // Bounded wait (ms) forwarded to every per-workspace scaler loop for the
  // outbound callback-listener TLS-trust probe that gates first-job dispatch
  // (issue #463). Undefined uses the loop's built-in default.
  callbackTrustTimeoutMs?: number;
  // Redis connection string forwarded to each spawned callback listener.
  redisUrl: string;
  tickIntervalMs?: number;
  s3Config?: import('./types.js').EncoreS3Config;
  // Optional per-workspace S3 config resolver. When supplied, called once at
  // loop creation time and preferred over the static s3Config field. Allows the
  // MinIO endpoint to be resolved from the parameter store per workspace rather
  // than requiring a static ENCORE_S3_ENDPOINT env var.
  resolveS3Config?: (workspaceId: string) => Promise<import('./types.js').EncoreS3Config | undefined>;
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
};

export class WorkspaceEncoreScalerRegistry implements EncoreClient {
  private readonly loops = new Map<string, { client: EncoreClient; loop: EncoreScalerLoop }>();

  constructor(private readonly config: WorkspaceEncoreScalerConfig) {}

  private async getOrCreate(workspaceId: string): Promise<EncoreClient> {
    const existing = this.loops.get(workspaceId);
    if (existing) return existing.client;

    let s3Config = this.config.s3Config;
    if (this.config.resolveS3Config) {
      s3Config = (await this.config.resolveS3Config(workspaceId)) ?? s3Config;
    }

    const scalerConfig: EncoreScalerConfig = {
      workspaceId,
      maxInstances: this.config.maxInstances,
      minInstances: this.config.minInstances,
      idleTimeoutMs: this.config.idleTimeoutMs,
      callbackTrustTimeoutMs: this.config.callbackTrustTimeoutMs,
      oscContext: this.config.oscContext,
      redis: this.config.redis,
      redisUrl: this.config.redisUrl,
      getToken: () => this.config.oscContext.getServiceAccessToken('encore'),
      s3Config,
      profilesUrl: this.config.profilesUrl,
      onDispatched: this.config.onDispatched,
      onEncodeDispatched: this.config.onEncodeDispatched,
      reconcileFailedTranscodes: this.config.reconcileFailedTranscodes
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
        const scalerConfig = {
          workspaceId,
          maxInstances: this.config.maxInstances,
          minInstances: this.config.minInstances,
          idleTimeoutMs: this.config.idleTimeoutMs,
          oscContext: this.config.oscContext,
          redis: this.config.redis,
          redisUrl: this.config.redisUrl,
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

    // 2. Destroy every pooled instance. Reads directly from Valkey so teardown
    //    works even for a pool that outlived its in-memory loop (e.g. resumed by
    //    resumeExistingWorkspaces() but never re-registered). A missing/empty
    //    pool yields an empty list — a clean no-op. If Redis itself is
    //    unavailable the read rejects; swallow it so teardown stays a no-op
    //    (there is nothing we can safely destroy without the pool state).
    let instances;
    try {
      instances = await listInstances(this.config.redis, workspaceId);
    } catch {
      return;
    }
    if (instances.length === 0) return;

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
      redis: this.config.redis,
      redisUrl: this.config.redisUrl,
      getToken: () => this.config.oscContext.getServiceAccessToken('encore'),
      s3Config: this.config.s3Config,
      profilesUrl: this.config.profilesUrl,
      onDispatched: this.config.onDispatched
    };

    for (const inst of instances) {
      await destroyInstance(inst.instanceId, scalerConfig);
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
  }
}
