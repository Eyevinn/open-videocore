import { describe, it, expect, vi, afterEach } from 'vitest';

// Regression coverage for issue #804's second half: resolveS3Config now REJECTS
// for a stack whose MinIO endpoint cannot be resolved (fail loudly instead of
// handing Encore a job it would resolve against AWS S3 and 404 on). That
// rejection is wanted on the submit path, but resumeExistingWorkspaces iterates
// every discovered stack in one `for` loop — so before this fix a single
// unresolvable stack aborted the loop and left EVERY REMAINING workspace
// unresumed, with the rejection swallowed by main.ts as one `failed to resume
// existing workspaces` warning.
//
// Contracts verified for this test (CLAUDE.md rule 7):
//   - WorkspaceEncoreScalerConfig fields used below — redis, oscContext,
//     maxInstances, idleTimeoutMs, redisUrl, resolveS3Config, resolveRedisUrl,
//     makeRedis, tickIntervalMs — src/encore-scaler/workspace-registry.ts
//     (the exported WorkspaceEncoreScalerConfig type).
//   - resolveS3Config?: (stackKey: string) => Promise<EncoreS3Config | undefined>,
//     documented as MAY REJECT — src/encore-scaler/workspace-registry.ts.
//   - resumeExistingWorkspaces(log?: (msg: string, err?: unknown) => void):
//     Promise<void>, and stopAll(): void — same file.
//   - Pool keys are `encore:pool:<workspaceId>` and queue keys
//     `encore:queue:<workspaceId>` — src/encore-scaler/types.ts `keys`.

vi.mock('@osaas/client-core', () => ({
  listInstances: vi.fn(async () => []),
  removeInstance: vi.fn(async () => {}),
  createInstance: vi.fn(async () => ({ name: 'x', url: 'https://x.example.test' })),
  waitForInstanceReady: vi.fn(async () => {}),
  Context: class {}
}));

import { WorkspaceEncoreScalerRegistry } from './workspace-registry.js';
import type { Redis } from 'ioredis';
import type { Context } from '@osaas/client-core';

const registries: WorkspaceEncoreScalerRegistry[] = [];

afterEach(() => {
  // The loops started by getOrCreate use an unref'd interval; stop them anyway
  // so no tick can run against the fakes after the test ends.
  for (const registry of registries.splice(0)) registry.stopAll();
});

// Every discovered stack already has a pool entry, so resumeExistingWorkspaces
// skips reconcilePoolFromOsc and goes straight to getOrCreate for each.
function makeRedis(workspaceIds: string[]): Redis {
  return {
    keys: vi.fn(async (pattern: string) =>
      pattern === 'encore:pool:*'
        ? workspaceIds.map((id) => `encore:pool:${id}`)
        : []
    )
  } as unknown as Redis;
}

const oscContext = {
  getServiceAccessToken: async () => 'service-access-token'
} as unknown as Context;

describe('resumeExistingWorkspaces isolates a stack whose S3 config is unresolvable (issue #804)', () => {
  it('resumes the other workspaces and reports the skipped one', async () => {
    const workspaceIds = ['stack-a', 'stack-b', 'stack-c'];

    // `stack-b` is the stack with no resolvable MinIO endpoint: the shipped
    // policy (services/scaler-s3-config.ts) rejects for it rather than letting
    // Encore default to AWS.
    const resolveS3Config = vi.fn(async (stackKey: string) => {
      if (stackKey === 'stack-b') {
        throw new Error(
          `encore-scaler: unresolvable MinIO S3 endpoint for stack "${stackKey}"`
        );
      }
      return {
        endpoint: `https://${stackKey}-minio.example.test`,
        accessKeyId: 'admin',
        secretAccessKey: 'minio-root-password'
      };
    });

    // getOrCreate resolves S3 BEFORE the per-stack Valkey, so this records
    // exactly which workspaces got past the rejection point and were resumed.
    const resolveRedisUrl = vi.fn(async (_stackKey: string) => undefined);

    const registry = new WorkspaceEncoreScalerRegistry({
      redis: makeRedis(workspaceIds),
      oscContext,
      maxInstances: 1,
      idleTimeoutMs: 60_000,
      redisUrl: 'redis://process-global.example.test:6379',
      resolveS3Config,
      resolveRedisUrl,
      makeRedis: () => makeRedis([]),
      // Long enough that no tick can fire during the test.
      tickIntervalMs: 3_600_000
    });
    registries.push(registry);

    const logged: Array<{ msg: string; err: unknown }> = [];
    await expect(
      registry.resumeExistingWorkspaces((msg, err) => logged.push({ msg, err }))
    ).resolves.toBeUndefined();

    // Every stack was attempted — the rejection did not abort the loop.
    expect(resolveS3Config.mock.calls.map((c) => c[0])).toEqual(workspaceIds);

    // THE regression assertion: `stack-c`, discovered AFTER the failing one,
    // still resumed. Before the fix it never got this far.
    const resumed = resolveRedisUrl.mock.calls.map((c) => c[0]);
    expect(resumed).toContain('stack-a');
    expect(resumed).toContain('stack-c');
    // The failing stack stops at the S3 step and is retried on its next submit.
    expect(resumed).not.toContain('stack-b');

    // It is reported rather than silently skipped.
    expect(logged).toHaveLength(1);
    expect(logged[0]!.msg).toContain('stack-b');
    expect((logged[0]!.err as Error).message).toMatch(
      /unresolvable MinIO S3 endpoint/
    );
  });

  it('still resumes every workspace when no stack is unresolvable', async () => {
    const workspaceIds = ['stack-a', 'stack-b'];
    const resolveRedisUrl = vi.fn(async (_stackKey: string) => undefined);

    const registry = new WorkspaceEncoreScalerRegistry({
      redis: makeRedis(workspaceIds),
      oscContext,
      maxInstances: 1,
      idleTimeoutMs: 60_000,
      redisUrl: 'redis://process-global.example.test:6379',
      resolveS3Config: async (stackKey: string) => ({
        endpoint: `https://${stackKey}-minio.example.test`,
        accessKeyId: 'admin',
        secretAccessKey: 'minio-root-password'
      }),
      resolveRedisUrl,
      makeRedis: () => makeRedis([]),
      tickIntervalMs: 3_600_000
    });
    registries.push(registry);

    const logged: string[] = [];
    await registry.resumeExistingWorkspaces((msg) => logged.push(msg));

    expect(resolveRedisUrl.mock.calls.map((c) => c[0])).toEqual(workspaceIds);
    expect(logged).toEqual([]);
  });
});
