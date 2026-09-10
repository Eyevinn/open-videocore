// Per-stack dependency reachability preflight (issue #617, parent #602).
//
// These tests exercise the core preflight in isolation with injected probe
// clients (no live network I/O), covering the issue #617 acceptance criteria:
//   - a fully healthy stack reports every configured dependency reachable
//     with the CHECKED endpoint, and healthy === true;
//   - a stack with ONE unreachable dependency reports that dependency
//     unreachable (naming it + the checked endpoint), the others reachable,
//     and healthy === false;
//   - firstUnreachable() converts an unhealthy result into the SAME
//     DependencyUnreachableError (#616) the transcode path maps to a 504,
//     so the diagnostics surface and the fail-fast guard compose;
//   - an unconfigured dependency (no coordinate / no probe client) is reported
//     not_configured and does NOT by itself mark the stack unhealthy.
//
// Contract sources cited before writing:
//   - checkStackReachability / firstUnreachable / StackReachabilityDeps /
//     DependencyReachability: src/services/stack-reachability.ts.
//   - DependencyUnreachableError + StackDependency taxonomy + sanitizeEndpoint:
//     src/encore-scaler/dependency-timeout.ts (#616), reused verbatim.
//   - QueueProbeClient.ping(): ioredis ping(): Promise<"PONG">
//     (node_modules/ioredis/.../RedisCommander.d.ts:3545).
//   - StorageProbeClient.bucketExists(): minio bucketExists(name): Promise<boolean>
//     (node_modules/minio/.../client.d.ts:207).

import { describe, it, expect } from 'vitest';
import {
  checkStackReachability,
  firstUnreachable,
  type QueueProbeClient,
  type StorageProbeClient
} from './stack-reachability.js';
import {
  DependencyUnreachableError,
  isDependencyUnreachableError
} from '../encore-scaler/dependency-timeout.js';

const REDIS_URL = 'redis://valkey.stack.internal:6379';
const MINIO_ENDPOINT = 'https://minio.stack.internal:9000';
const BUCKET = 'openvideocore-source';

function okQueue(): QueueProbeClient {
  return { ping: async () => 'PONG' };
}
function downQueue(): QueueProbeClient {
  return {
    ping: async () => {
      throw new Error('ECONNREFUSED');
    }
  };
}
function okStorage(): StorageProbeClient {
  return { bucketExists: async () => true };
}
function downStorage(): StorageProbeClient {
  return {
    bucketExists: async () => {
      throw new Error('ENOTFOUND');
    }
  };
}

const COORDS = {
  stackName: 'default',
  redisUrl: REDIS_URL,
  minioEndpoint: MINIO_ENDPOINT,
  bucket: BUCKET
};

describe('checkStackReachability — healthy stack', () => {
  it('reports every configured dependency reachable with its checked endpoint', async () => {
    const result = await checkStackReachability(COORDS, {
      queueClient: okQueue(),
      storageClient: okStorage(),
      timeoutMs: 1000
    });
    expect(result.healthy).toBe(true);
    expect(result.stackName).toBe('default');

    const queue = result.dependencies.find((d) => d.dependency === 'queue');
    const storage = result.dependencies.find((d) => d.dependency === 'storage');
    expect(queue?.reachable).toBe(true);
    expect(queue?.endpoint).toBe(REDIS_URL);
    expect(storage?.reachable).toBe(true);
    expect(storage?.endpoint).toBe(MINIO_ENDPOINT);
  });

  it('firstUnreachable returns undefined for a healthy stack', async () => {
    const result = await checkStackReachability(COORDS, {
      queueClient: okQueue(),
      storageClient: okStorage(),
      timeoutMs: 1000
    });
    expect(firstUnreachable(result)).toBeUndefined();
  });
});

describe('checkStackReachability — one unreachable dependency', () => {
  it('names the unreachable dependency + endpoint, leaves the other reachable, healthy=false', async () => {
    const result = await checkStackReachability(COORDS, {
      queueClient: downQueue(),
      storageClient: okStorage(),
      timeoutMs: 1000
    });
    expect(result.healthy).toBe(false);

    const queue = result.dependencies.find((d) => d.dependency === 'queue');
    const storage = result.dependencies.find((d) => d.dependency === 'storage');
    expect(queue?.reachable).toBe(false);
    expect(queue?.reason).toBe('unreachable');
    expect(queue?.endpoint).toBe(REDIS_URL);
    expect(storage?.reachable).toBe(true);
  });

  it('firstUnreachable composes with the fail-fast fix: a DependencyUnreachableError naming the dependency', async () => {
    const result = await checkStackReachability(COORDS, {
      queueClient: okQueue(),
      storageClient: downStorage(),
      timeoutMs: 1000
    });
    expect(result.healthy).toBe(false);
    const err = firstUnreachable(result);
    expect(isDependencyUnreachableError(err)).toBe(true);
    expect(err).toBeInstanceOf(DependencyUnreachableError);
    expect(err?.dependency).toBe('storage');
    expect(err?.endpoint).toBe(MINIO_ENDPOINT);
    // The 504 body the transcode path sends (err.toResponseBody()) names the
    // dependency + endpoint and never leaks an internal cause.
    const body = err!.toResponseBody();
    expect(body).toMatchObject({
      error: 'dependency_unreachable',
      dependency: 'storage',
      endpoint: MINIO_ENDPOINT
    });
  });

  it('credential-bearing redis URL is sanitised in the reported endpoint', async () => {
    const result = await checkStackReachability(
      { ...COORDS, redisUrl: 'redis://user:s3cr3t@valkey.stack.internal:6379' },
      { queueClient: downQueue(), storageClient: okStorage(), timeoutMs: 1000 }
    );
    const queue = result.dependencies.find((d) => d.dependency === 'queue');
    expect(queue?.endpoint).toBe('redis://valkey.stack.internal:6379');
    expect(JSON.stringify(result)).not.toContain('s3cr3t');
  });
});

describe('checkStackReachability — unconfigured dependency', () => {
  it('reports a dependency with no coordinate/client as not_configured and does NOT mark the stack unhealthy', async () => {
    // Only the queue is configured; no storage endpoint/client supplied.
    const result = await checkStackReachability(
      { stackName: 'default', redisUrl: REDIS_URL },
      { queueClient: okQueue(), timeoutMs: 1000 }
    );
    const queue = result.dependencies.find((d) => d.dependency === 'queue');
    const storage = result.dependencies.find((d) => d.dependency === 'storage');
    expect(queue?.reachable).toBe(true);
    expect(storage?.reachable).toBe(false);
    expect(storage?.reason).toBe('not_configured');
    // A not_configured dependency could not be checked and does not by itself
    // make the stack unhealthy.
    expect(result.healthy).toBe(true);
    expect(firstUnreachable(result)).toBeUndefined();
  });

  it('a coordinate present but no probe client wired is also not_configured', async () => {
    const result = await checkStackReachability(COORDS, { timeoutMs: 1000 });
    for (const d of result.dependencies) {
      expect(d.reachable).toBe(false);
      expect(d.reason).toBe('not_configured');
    }
    expect(result.healthy).toBe(true);
  });
});

describe('checkStackReachability — bounded deadline', () => {
  it('a never-settling probe is reported unreachable via the bounded timeout (not a hang)', async () => {
    const hangingQueue: QueueProbeClient = {
      ping: () => new Promise<string>(() => {}) // never settles
    };
    const result = await checkStackReachability(COORDS, {
      queueClient: hangingQueue,
      storageClient: okStorage(),
      timeoutMs: 20
    });
    const queue = result.dependencies.find((d) => d.dependency === 'queue');
    expect(queue?.reachable).toBe(false);
    expect(queue?.reason).toBe('unreachable');
    expect(queue?.failure).toBe('timeout');
    expect(result.healthy).toBe(false);
  });
});
