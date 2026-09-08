// Fail-fast named-dependency error on an unreachable stack dependency (#616).
//
// The transcode submit path enqueues onto the stack's Valkey queue via
// makeScalingEncoreClient.submit -> redis.lpush / redis.hset (src/encore-scaler/
// index.ts). The shared IORedis client is `lazyConnect` with
// `maxRetriesPerRequest: null` (src/main.ts:744), so a command issued while
// Valkey is unreachable is buffered offline and never rejects — the request
// hangs until the inbound socket is dropped (~50s) with no response.
//
// These tests simulate an unreachable Valkey with a Redis fake whose commands
// never settle, and assert that submit() now:
//   1. rejects PROMPTLY (well inside the bounded deadline), and
//   2. rejects with a structured DependencyUnreachableError that NAMES the
//      failing dependency (queue) and its credential-stripped endpoint.
//
// Contract sources cited before writing:
//   - makeScalingEncoreClient(config).submit(input): src/encore-scaler/index.ts,
//     uses config.redis (ioredis Redis), config.workspaceId, config.redisUrl.
//   - EncoreScalerConfig shape: src/encore-scaler/types.ts (redis, redisUrl,
//     workspaceId, getToken, oscContext, ...).
//   - EncoreSubmitInput shape: src/pipeline/encore-client.ts (externalId,
//     inputUri, outputUri, profile).
//   - keys.queue / keys.jobStatus builders: src/encore-scaler/types.ts.

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Redis } from 'ioredis';
import type { Context } from '@osaas/client-core';
import { makeScalingEncoreClient } from './index.js';
import type { EncoreScalerConfig } from './types.js';
import type { EncoreSubmitInput } from '../pipeline/encore-client.js';
import {
  DependencyUnreachableError,
  isDependencyUnreachableError,
  sanitizeEndpoint,
  withDependencyTimeout
} from './dependency-timeout.js';

afterEach(() => {
  vi.useRealTimers();
});

// A Redis stand-in whose write commands NEVER settle — this is exactly what an
// ioredis client with `maxRetriesPerRequest: null` does while its socket cannot
// reach Valkey: the command sits in the offline queue forever.
function unreachableRedis(): Redis {
  const neverSettles = () => new Promise<never>(() => {});
  return {
    lpush: neverSettles,
    hset: neverSettles
  } as unknown as Redis;
}

function config(redis: Redis): EncoreScalerConfig {
  return {
    workspaceId: 'default',
    maxInstances: 1,
    idleTimeoutMs: 1000,
    redisUrl: 'redis://user:secretpass@valkey.internal:6379',
    oscContext: {} as unknown as Context,
    redis,
    getToken: async () => 'token'
  };
}

const submitInput: EncoreSubmitInput = {
  externalId: 'default::01ABC',
  inputUri: 's3://src/in.mp4',
  outputUri: 's3://out/transcode/asset/job',
  profile: 'program'
};

describe('withDependencyTimeout (#616)', () => {
  it('rejects with a named DependencyUnreachableError when the op does not settle in time', async () => {
    vi.useFakeTimers();
    const p = withDependencyTimeout(() => new Promise<never>(() => {}), {
      dependency: 'queue',
      endpoint: 'redis://valkey.internal:6379',
      stackName: 'default',
      operation: 'lpush encore:queue:default',
      timeoutMs: 5000
    });
    const assertion = expect(p).rejects.toBeInstanceOf(DependencyUnreachableError);
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('normalises a hard connect error to a DependencyUnreachableError (connect_error)', async () => {
    const boom = new Error('ECONNREFUSED 127.0.0.1:6379');
    await expect(
      withDependencyTimeout(() => Promise.reject(boom), {
        dependency: 'queue',
        endpoint: 'redis://valkey.internal:6379',
        timeoutMs: 5000
      })
    ).rejects.toMatchObject({
      name: 'DependencyUnreachableError',
      dependency: 'queue',
      reason: 'connect_error',
      cause: boom
    });
  });

  it('resolves normally when the op settles before the deadline', async () => {
    await expect(
      withDependencyTimeout(() => Promise.resolve('ok'), {
        dependency: 'queue',
        endpoint: 'redis://valkey.internal:6379',
        timeoutMs: 5000
      })
    ).resolves.toBe('ok');
  });
});

describe('sanitizeEndpoint (#616)', () => {
  it('strips credentials from a redis URL', () => {
    expect(sanitizeEndpoint('redis://user:secretpass@valkey.internal:6379')).toBe(
      'redis://valkey.internal:6379'
    );
  });

  it('never leaks the password in the sanitised value', () => {
    expect(sanitizeEndpoint('redis://user:secretpass@valkey.internal:6379')).not.toContain(
      'secretpass'
    );
  });
});

describe('makeScalingEncoreClient.submit fails fast on unreachable queue (#616)', () => {
  it('rejects promptly with a named-dependency error instead of hanging', async () => {
    vi.useFakeTimers();
    const client = makeScalingEncoreClient(config(unreachableRedis()));

    const p = client.submit(submitInput);
    // Attach the rejection assertion BEFORE advancing timers so the race's
    // timeout branch is awaited deterministically.
    const settled = p.then(
      () => ({ ok: true as const }),
      (err: unknown) => ({ ok: false as const, err })
    );

    await vi.advanceTimersByTimeAsync(5000);
    const outcome = await settled;

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected submit to reject');
    expect(isDependencyUnreachableError(outcome.err)).toBe(true);
    const err = outcome.err as DependencyUnreachableError;
    // Names the failing dependency and endpoint, with credentials stripped.
    expect(err.dependency).toBe('queue');
    expect(err.endpoint).toBe('redis://valkey.internal:6379');
    expect(err.endpoint).not.toContain('secretpass');
    expect(err.reason).toBe('timeout');
    expect(err.operation).toContain('encore:queue:default');
    // A response body the route can send verbatim.
    expect(err.toResponseBody()).toEqual({
      error: 'dependency_unreachable',
      dependency: 'queue',
      endpoint: 'redis://valkey.internal:6379',
      message: expect.stringContaining('queue')
    });
  });
});
