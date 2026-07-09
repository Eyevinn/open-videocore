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
import { destroyInstance, listInstances } from './instance-pool.js';
import { keys } from './types.js';
import type { EncoreScalerConfig } from './types.js';

export type WorkspaceEncoreScalerConfig = {
  redis: Redis;
  oscContext: Context;
  maxInstances: number;
  minInstances?: number;
  idleTimeoutMs: number;
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
      oscContext: this.config.oscContext,
      redis: this.config.redis,
      redisUrl: this.config.redisUrl,
      getToken: () => this.config.oscContext.getServiceAccessToken('encore'),
      s3Config,
      profilesUrl: this.config.profilesUrl,
      onDispatched: this.config.onDispatched
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

  // Scan Redis for workspaceIds that have an existing pool and start their loops
  // immediately. This repairs stale activeJobs counts left by a previous server
  // run without waiting for the first job submission to trigger getOrCreate.
  async resumeExistingWorkspaces(): Promise<void> {
    const poolPattern = 'encore:pool:*';
    const existingKeys = await this.config.redis.keys(poolPattern);
    for (const key of existingKeys) {
      // key = "encore:pool:{workspaceId}"
      const workspaceId = key.slice('encore:pool:'.length);
      if (workspaceId) await this.getOrCreate(workspaceId);
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

  stopAll(): void {
    for (const { loop } of this.loops.values()) {
      loop.stop();
    }
    this.loops.clear();
  }
}
