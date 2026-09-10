// Optional operator-configured job-throughput / concurrency cap (issue #580).
//
// Verifies the three required behaviours:
//   1. over-cap job submission is rejected with the documented 4xx (429) +
//      reason code (`job_throughput_cap_exceeded`);
//   2. under-cap submission succeeds (job enqueued);
//   3. no cap configured => unchanged behaviour (submission always succeeds,
//      no queue read).
//
// The cap reuses the scaler's OWN Valkey state (queue depth + inflight depth)
// as the single source of truth — NOT a second accounting path (ADR-020
// Decision 2 applied to jobs). The tests therefore drive a minimal in-memory
// Valkey fake whose LLEN reflects the list contents the real scaler maintains.
//
// Contract sources cited before writing:
//   - assertUnderJobThroughputCap / resolveJobThroughputCap /
//     JobThroughputCapExceededError: src/encore-scaler/job-throughput-cap.ts.
//   - makeScalingEncoreClient(config).submit reads config.maxQueuedJobs and calls
//     assertUnderJobThroughputCap BEFORE enqueueing: src/encore-scaler/index.ts.
//   - keys.queue / keys.inflight builders + EncoreScalerConfig.maxQueuedJobs:
//     src/encore-scaler/types.ts.
//   - EncoreSubmitInput shape: src/pipeline/encore-client.ts.

import { describe, it, expect } from 'vitest';
import type { Redis } from 'ioredis';
import type { Context } from '@osaas/client-core';
import { makeScalingEncoreClient } from './index.js';
import type { EncoreScalerConfig } from './types.js';
import { keys } from './types.js';
import type { EncoreSubmitInput } from '../pipeline/encore-client.js';
import {
  JOB_THROUGHPUT_CAP_REASON,
  JobThroughputCapExceededError,
  assertUnderJobThroughputCap,
  isJobThroughputCapExceededError,
  outstandingJobCount,
  resolveJobThroughputCap
} from './job-throughput-cap.js';

// Minimal in-memory Valkey fake supporting only the list ops the cap + submit
// path exercise: lpush (append), llen (length), hset (no-op store). Mirrors the
// real scaler's encore:queue / encore:inflight list semantics.
class FakeRedis {
  private lists = new Map<string, string[]>();
  private hashes = new Map<string, Map<string, string>>();

  async lpush(key: string, value: string): Promise<number> {
    const arr = this.lists.get(key) ?? [];
    arr.unshift(value);
    this.lists.set(key, arr);
    return arr.length;
  }

  async llen(key: string): Promise<number> {
    return this.lists.get(key)?.length ?? 0;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    const h = this.hashes.get(key) ?? new Map<string, string>();
    h.set(field, value);
    this.hashes.set(key, h);
    return 1;
  }

  // Test helper: seed N entries onto a list directly.
  seedList(key: string, count: number): void {
    this.lists.set(key, Array.from({ length: count }, (_, i) => `seed-${i}`));
  }
}

function asRedis(f: FakeRedis): Redis {
  return f as unknown as Redis;
}

const WORKSPACE = 'default';

function config(redis: Redis, maxQueuedJobs?: number): EncoreScalerConfig {
  return {
    workspaceId: WORKSPACE,
    maxInstances: 3,
    maxQueuedJobs,
    idleTimeoutMs: 1000,
    redisUrl: 'redis://valkey.internal:6379',
    oscContext: {} as unknown as Context,
    redis,
    getToken: async () => 'token'
  };
}

function submitInput(id = 'default::01ABC'): EncoreSubmitInput {
  return {
    externalId: id,
    inputUri: 's3://src/in.mp4',
    outputUri: 's3://out/transcode/asset/job',
    profile: 'program'
  };
}

describe('resolveJobThroughputCap (#580) — opt-in env parsing', () => {
  it('returns undefined (no cap) when ENCORE_MAX_QUEUED_JOBS is unset', () => {
    expect(resolveJobThroughputCap({})).toBeUndefined();
  });

  it('returns undefined for zero, negative, or non-numeric values', () => {
    expect(resolveJobThroughputCap({ ENCORE_MAX_QUEUED_JOBS: '0' })).toBeUndefined();
    expect(resolveJobThroughputCap({ ENCORE_MAX_QUEUED_JOBS: '-5' })).toBeUndefined();
    expect(resolveJobThroughputCap({ ENCORE_MAX_QUEUED_JOBS: 'abc' })).toBeUndefined();
  });

  it('parses a positive integer cap', () => {
    expect(resolveJobThroughputCap({ ENCORE_MAX_QUEUED_JOBS: '10' })).toBe(10);
  });
});

describe('outstandingJobCount (#580) — single source of truth (queue + inflight)', () => {
  it('sums the scaler queue depth and inflight depth, not a separate counter', async () => {
    const fake = new FakeRedis();
    fake.seedList(keys.queue(WORKSPACE), 3);
    fake.seedList(keys.inflight(WORKSPACE), 2);
    expect(await outstandingJobCount(asRedis(fake), WORKSPACE)).toBe(5);
  });
});

describe('assertUnderJobThroughputCap (#580)', () => {
  it('no-ops when no cap is configured (opt-in)', async () => {
    const fake = new FakeRedis();
    fake.seedList(keys.queue(WORKSPACE), 1000);
    await expect(
      assertUnderJobThroughputCap(asRedis(fake), WORKSPACE, undefined)
    ).resolves.toBeUndefined();
  });

  it('admits when there is headroom (outstanding < cap)', async () => {
    const fake = new FakeRedis();
    fake.seedList(keys.queue(WORKSPACE), 1);
    await expect(
      assertUnderJobThroughputCap(asRedis(fake), WORKSPACE, 2)
    ).resolves.toBeUndefined();
  });

  it('rejects with a 429 cap-exceeded error when outstanding >= cap', async () => {
    const fake = new FakeRedis();
    fake.seedList(keys.queue(WORKSPACE), 2);
    const err = await assertUnderJobThroughputCap(asRedis(fake), WORKSPACE, 2).catch(
      (e: unknown) => e
    );
    expect(isJobThroughputCapExceededError(err)).toBe(true);
    const capErr = err as JobThroughputCapExceededError;
    expect(capErr.statusCode).toBe(429);
    expect(capErr.reason).toBe(JOB_THROUGHPUT_CAP_REASON);
    expect(capErr.toResponseBody()).toMatchObject({
      error: 'job_throughput_cap_exceeded',
      cap: 2,
      outstanding: 2
    });
  });
});

describe('makeScalingEncoreClient.submit cap enforcement (#580)', () => {
  it('under-cap submission succeeds and enqueues the job', async () => {
    const fake = new FakeRedis();
    // 1 outstanding, cap 3 => headroom for this submission.
    fake.seedList(keys.queue(WORKSPACE), 1);
    const client = makeScalingEncoreClient(config(asRedis(fake), 3));

    const result = await client.submit(submitInput());
    expect(result.encoreInternalId).toBe('default::01ABC');
    // The job was actually appended (queue now holds 2).
    expect(await fake.llen(keys.queue(WORKSPACE))).toBe(2);
  });

  it('over-cap submission is rejected with the documented 429 + reason code and does NOT enqueue', async () => {
    const fake = new FakeRedis();
    // Already at cap (2 outstanding, cap 2): submitting one more must be rejected.
    fake.seedList(keys.queue(WORKSPACE), 2);
    const client = makeScalingEncoreClient(config(asRedis(fake), 2));

    const err = await client.submit(submitInput()).catch((e: unknown) => e);
    expect(isJobThroughputCapExceededError(err)).toBe(true);
    expect((err as JobThroughputCapExceededError).statusCode).toBe(429);
    expect((err as JobThroughputCapExceededError).reason).toBe(
      'job_throughput_cap_exceeded'
    );
    // The rejected submission must NOT have grown the backlog.
    expect(await fake.llen(keys.queue(WORKSPACE))).toBe(2);
  });

  it('no cap configured => unchanged behaviour (large backlog still admitted)', async () => {
    const fake = new FakeRedis();
    fake.seedList(keys.queue(WORKSPACE), 10_000);
    const client = makeScalingEncoreClient(config(asRedis(fake), undefined));

    const result = await client.submit(submitInput());
    expect(result.encoreInternalId).toBe('default::01ABC');
    expect(await fake.llen(keys.queue(WORKSPACE))).toBe(10_001);
  });
});
