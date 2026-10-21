// Per-stack packager queues. Every on-demand packager listens on the same
// shared Valkey, so a packager provisioned for a non-first stack must consume
// its own queue key, and packaging work must target the stack the job belongs
// to — not the first provisioned stack. Before this, a transcode on a second
// stack provisioned the FIRST stack's packager, which then read renditions from
// the first stack's object store and failed every HeadObject with a 404.

import { describe, expect, it, vi } from 'vitest';
import {
  PACKAGER_REDIS_QUEUE,
  buildPackagerCreateBody,
  packagerQueueForStack,
  packagingStackName
} from './packager-provisioning.js';
import { makeOscPackagerQueue } from '../pipeline/osc-packager-queue.js';

const REFS = { patRef: '{{secrets.pat}}', s3SecretRef: '{{secrets.s3}}' };
const COORDS = {
  stackName: 'stack2',
  redisUrl: 'redis://valkey:6379',
  minioEndpoint: 'https://minio.example',
  packagedBucket: 'openvideocore-packaged'
};

describe('packagingStackName', () => {
  const names = ['stack1', 'stack2'];

  it('targets the ambient stack when it is provisioned', () => {
    expect(packagingStackName(names, 'stack2')).toBe('stack2');
  });

  it('falls back to the first provisioned stack without an ambient stack', () => {
    expect(packagingStackName(names, undefined)).toBe('stack1');
  });

  it('falls back to the first provisioned stack for an unprovisioned name', () => {
    expect(packagingStackName(names, 'gone')).toBe('stack1');
  });

  it('is undefined when no stack is provisioned', () => {
    expect(packagingStackName([], 'stack2')).toBeUndefined();
  });
});

describe('packager create body queue key', () => {
  it('scopes the queue key to the stack', () => {
    expect(packagerQueueForStack('stack2')).toBe(`${PACKAGER_REDIS_QUEUE}:stack2`);
    const body = buildPackagerCreateBody(
      { ...COORDS, redisQueue: packagerQueueForStack('stack2') },
      REFS
    );
    expect(body['RedisQueue']).toBe(`${PACKAGER_REDIS_QUEUE}:stack2`);
  });

  it('keeps the shared key when no per-stack key is given', () => {
    expect(buildPackagerCreateBody(COORDS, REFS)['RedisQueue']).toBe(PACKAGER_REDIS_QUEUE);
  });
});

describe('makeOscPackagerQueue queue key resolution', () => {
  function fakeClient() {
    return {
      zadd: vi.fn(async () => 1),
      zrangebyscore: vi.fn(async () => []),
      zrem: vi.fn(async () => 0)
    };
  }

  it('enqueues onto the key the resolver returns', async () => {
    const client = fakeClient();
    const resolve = vi.fn(async (defaultKey: string) => `${defaultKey}:stack2`);
    const queue = makeOscPackagerQueue(client as never, 'q', undefined, resolve);
    await queue.enqueue({ jobId: 'a1', url: 'https://encore/encoreJobs/u1' });
    expect(resolve).toHaveBeenCalledWith('q');
    expect(client.zadd).toHaveBeenCalledWith('q:stack2', expect.any(Number), expect.any(String));
  });

  it('enqueues onto the default key without a resolver', async () => {
    const client = fakeClient();
    const queue = makeOscPackagerQueue(client as never, 'q');
    await queue.enqueue({ jobId: 'a1', url: 'https://encore/encoreJobs/u1' });
    expect(client.zadd).toHaveBeenCalledWith('q', expect.any(Number), expect.any(String));
  });
});
