// The packager's success callback releases the packaging pin on the Valkey of
// the stack the transcode ran on. Every scaler key — including the pin set and
// the terminal-instance mapping the unpin resolves through — lives on the job's
// own stack's Valkey (#615); the route used to unpin on the first stack's
// connection, so a pin taken for a job on any other stack was never released
// and the idle instance stayed out of scale-down until the pin's TTL.

import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import type { Redis } from 'ioredis';

import { internalRouter } from './internal.js';
import { InMemoryAssetRepository } from '../data/asset-repo.js';
import { InMemoryJobRepository } from '../data/job-repo.js';
import { InMemoryPipelineRepository } from '../data/pipeline-repo.js';
import { keys } from '../encore-scaler/types.js';

class FakeRedis {
  strings = new Map<string, string>();
  sets = new Map<string, Set<string>>();
  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }
  async hget(): Promise<string | null> {
    return null;
  }
  async sadd(key: string, member: string): Promise<number> {
    let s = this.sets.get(key);
    if (!s) {
      s = new Set();
      this.sets.set(key, s);
    }
    s.add(member);
    return 1;
  }
  async srem(key: string, member: string): Promise<number> {
    return this.sets.get(key)?.delete(member) ? 1 : 0;
  }
  async pexpire(): Promise<number> {
    return 1;
  }
}

describe('packager success callback unpins on the job’s stack Valkey', () => {
  it('resolves the pinned instance and releases the pin through redisForJob', async () => {
    const encoreJobId = 'stack2__job-abc';
    const instanceId = 'inst-9';
    const firstStackRedis = new FakeRedis();
    const stack2Redis = new FakeRedis();
    stack2Redis.strings.set(keys.jobTerminalInstance(encoreJobId), instanceId);
    await stack2Redis.sadd(keys.pendingPackaging(instanceId), encoreJobId);

    const assets = new InMemoryAssetRepository();
    const jobs = new InMemoryJobRepository();
    const pipelines = new InMemoryPipelineRepository();
    const asset = await assets.create({ name: 'source.mp4' });
    const execution = await pipelines.create({
      assetId: asset.id,
      pipelineName: 'abr-vod',
      steps: ['transcode', 'package']
    });
    await pipelines.update(execution.id, {
      status: 'running',
      steps: execution.steps.map((s) =>
        s.name === 'transcode'
          ? { ...s, status: 'done' as const, encoreJobId }
          : { ...s, status: 'running' as const }
      )
    });

    const redisForJob = vi.fn(async () => stack2Redis as unknown as Redis);
    const app = Fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    await app.register(internalRouter, {
      prefix: '/api/v1/internal',
      packaging: { handleSuccess: async () => true } as never,
      repository: assets,
      jobRepository: jobs,
      pipelineRepository: pipelines,
      redis: firstStackRedis as unknown as Redis,
      redisForJob
    });
    await app.ready();

    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/internal/packagerCallback/success',
      payload: { url: 'https://encore.example/encoreJobs/u1', jobId: asset.id }
    });
    expect(res.statusCode).toBe(200);

    expect(redisForJob).toHaveBeenCalledWith(encoreJobId);
    expect(stack2Redis.sets.get(keys.pendingPackaging(instanceId))?.size ?? 0).toBe(0);
    expect(firstStackRedis.sets.size).toBe(0);
    await app.close();
  });
});
