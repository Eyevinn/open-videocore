// Per-stack Encore `profilesUrl` across a RESTART (issue #1271).
//
// The regression this pins. #1164 made each stack read its own profiles by
// rewriting this app's own index URL to the stack-scoped route
// (`stackScopedProfilesIndexUrl`). ADR-026 (#1207) then made the index
// published into a stack's OWN object-store bucket the PRIMARY tier. On a FRESH
// instance no bucket exists yet, so the boot publish reports `bucket-missing`,
// the global URL stays the app-path form and #1164's rewrite keeps every stack
// correct. After a RESTART the buckets exist, the boot publish (scoped to the
// DEFAULT, first-listed stack) succeeds, and the global URL becomes that one
// stack's bucket index — which has no stack-scoped form, so every stack's
// Encore was handed the FIRST-listed stack's profile index and a job using a
// profile that exists only on its own stack failed with "Could not find
// location for profile".
//
// Contracts exercised (CLAUDE.md rule 7):
//   - `makePerStackProfilesUrlResolver({ defaultProfilesUrl, paramStoreProfilesUrl?,
//     publishForStack, log? })` — src/services/per-stack-profiles-url.ts.
//   - `PublishOutcome` shape `{ ok: true; indexUrl }` / `{ ok: false; reason }`
//     — src/services/profile-index-publisher.ts.
//   - `WorkspaceEncoreScalerConfig.resolveProfilesUrl` + `profilesUrl`
//     — src/encore-scaler/workspace-registry.ts (the hook is AWAITED at loop
//     creation and falls back to the process-global URL on undefined).
//   - `publishedProfilesIndexUrl(endpoint, bucket?)` and `PROFILES_BUCKET`
//     — src/services/profile-index-publisher.ts (the URL shape asserted below).

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Redis } from 'ioredis';

vi.mock('@osaas/client-core', () => ({
  createInstance: vi.fn(),
  removeInstance: vi.fn(),
  listInstances: vi.fn(async () => []),
  getInstanceHealth: vi.fn(async () => 'running'),
  getInstance: vi.fn()
}));

import { WorkspaceEncoreScalerRegistry } from '../src/encore-scaler/workspace-registry.js';
import { keys } from '../src/encore-scaler/types.js';
import {
  PROFILES_BUCKET,
  publishedProfilesIndexUrl
} from '../src/services/profile-index-publisher.js';
import { localProfilesIndexPathForStack } from '../src/services/public-base-url.js';
import {
  makePerStackProfilesUrlResolver,
  type StackPublishResult
} from '../src/services/per-stack-profiles-url.js';

// Minimal Valkey double: the registry's resume scan (KEYS), the pool hash reads
// and teardown are all it touches on this path.
class FakeRedis {
  private hashes = new Map<string, Map<string, string>>();

  constructor(readonly label: string) {}

  async hset(key: string, field: string, value: string): Promise<number> {
    let h = this.hashes.get(key);
    if (!h) {
      h = new Map();
      this.hashes.set(key, h);
    }
    h.set(field, value);
    return 1;
  }
  async hgetall(key: string): Promise<Record<string, string>> {
    return Object.fromEntries(this.hashes.get(key) ?? new Map());
  }
  async keys(pattern: string): Promise<string[]> {
    const prefix = pattern.replace(/\*$/, '');
    return [...this.hashes.keys()].filter((k) => k.startsWith(prefix));
  }
  async llen(): Promise<number> {
    return 0;
  }
  async hdel(): Promise<number> {
    return 0;
  }
  async del(): Promise<number> {
    return 0;
  }
  disconnect(): void {}
}

const OSC_CONTEXT = {
  getServiceAccessToken: async () => 'token',
  getPersonalAccessToken: () => 'pat'
} as unknown as import('@osaas/client-core').Context;

const REMOTE_DEFAULT =
  'https://raw.githubusercontent.com/Eyevinn/encore-test-profiles/refs/heads/main/profiles.yml';

// Two provisioned stacks, each with its own object store. `stack-b` is the
// first-listed one (a stack created through the API ends up first, #1165), so it
// is the stack the BOOT publish is scoped to and whose bucket URL seeds the
// process-global `profilesUrl`.
const STACK_A = 'stack-a';
const STACK_B = 'stack-b';
const STACK_A_ENDPOINT = 'http://ovc-stack-a.minio-minio.svc.cluster.local:8080';
const STACK_B_ENDPOINT = 'http://ovc-stack-b.minio-minio.svc.cluster.local:8080';
const STACK_A_INDEX = publishedProfilesIndexUrl(STACK_A_ENDPOINT)!;
const STACK_B_INDEX = publishedProfilesIndexUrl(STACK_B_ENDPOINT)!;

// What the boot-time publish resolved to on a RESTARTED instance: the default
// (first-listed) stack's bucket index, origin 'object-store'.
const BOOT_GLOBAL_PROFILES_URL = STACK_B_INDEX;

const registries: WorkspaceEncoreScalerRegistry[] = [];
const envBackup = { ...process.env };
afterEach(() => {
  for (const r of registries.splice(0)) r.stopAll();
  process.env = { ...envBackup };
});

// The stack-scoped publisher main.ts wires (`publishProfileIndexToObjectStore`),
// faked: one stack name in, that stack's own bucket index URL out.
function fakePublisher(endpoints: Record<string, string | undefined>, calls?: string[]) {
  return async (stackName: string): Promise<StackPublishResult> => {
    calls?.push(stackName);
    const endpoint = endpoints[stackName];
    if (!endpoint) return { ok: false, reason: 'bucket-missing' };
    return { ok: true, indexUrl: publishedProfilesIndexUrl(endpoint)! };
  };
}

describe('per-stack profilesUrl resolution (issue #1271)', () => {
  it('gives each stack its OWN published bucket index, not the first-listed stack’s', async () => {
    const resolve = makePerStackProfilesUrlResolver({
      defaultProfilesUrl: REMOTE_DEFAULT,
      publishForStack: fakePublisher({
        [STACK_A]: STACK_A_ENDPOINT,
        [STACK_B]: STACK_B_ENDPOINT
      })
    });

    await expect(resolve(STACK_A)).resolves.toBe(STACK_A_INDEX);
    await expect(resolve(STACK_B)).resolves.toBe(STACK_B_INDEX);
    // The precise shape of the regression: stack A must NOT be handed the
    // first-listed stack's bucket index.
    await expect(resolve(STACK_A)).resolves.not.toBe(BOOT_GLOBAL_PROFILES_URL);
  });

  it('falls back to THIS stack’s app-path index when its own bucket is missing', async () => {
    process.env['PUBLIC_BASE_URL'] = 'https://videocore.example';
    delete process.env['ENCORE_PROFILES_URL_OVERRIDE'];
    const resolve = makePerStackProfilesUrlResolver({
      defaultProfilesUrl: REMOTE_DEFAULT,
      // Only the first-listed stack has a publishable bucket.
      publishForStack: fakePublisher({ [STACK_B]: STACK_B_ENDPOINT })
    });

    await expect(resolve(STACK_A)).resolves.toBe(
      `https://videocore.example${localProfilesIndexPathForStack(STACK_A)}`
    );
    await expect(resolve(STACK_B)).resolves.toBe(STACK_B_INDEX);
  });

  it('never resolves to another stack’s bucket when publishing throws', async () => {
    delete process.env['PUBLIC_BASE_URL'];
    delete process.env['ENCORE_PROFILES_URL_OVERRIDE'];
    const resolve = makePerStackProfilesUrlResolver({
      defaultProfilesUrl: REMOTE_DEFAULT,
      paramStoreProfilesUrl: 'https://profiles.example/index.yml',
      publishForStack: async () => {
        throw new Error('object store unreachable');
      }
    });

    const url = await resolve(STACK_A);
    expect(url).toBe('https://profiles.example/index.yml');
    expect(url).not.toContain(PROFILES_BUCKET);
  });

  it('returns undefined for a loop key that is not a stack name, so the global URL is kept', async () => {
    const resolve = makePerStackProfilesUrlResolver({
      defaultProfilesUrl: REMOTE_DEFAULT,
      publishForStack: fakePublisher({})
    });
    await expect(resolve('deployment_context')).resolves.toBeUndefined();
  });

  it('caches a stack’s own published index but retries a fallback resolution', async () => {
    process.env['PUBLIC_BASE_URL'] = 'https://videocore.example';
    const calls: string[] = [];
    const endpoints: Record<string, string | undefined> = {
      [STACK_A]: undefined,
      [STACK_B]: STACK_B_ENDPOINT
    };
    const resolve = makePerStackProfilesUrlResolver({
      defaultProfilesUrl: REMOTE_DEFAULT,
      publishForStack: fakePublisher(endpoints, calls)
    });

    await resolve(STACK_B);
    await resolve(STACK_B);
    expect(calls.filter((c) => c === STACK_B)).toHaveLength(1);

    // A stack read before its bucket exists must not stay pinned to the
    // fallback tier for the life of the process (same rule as resolveStackRedis).
    await resolve(STACK_A);
    endpoints[STACK_A] = STACK_A_ENDPOINT;
    await expect(resolve(STACK_A)).resolves.toBe(STACK_A_INDEX);
    expect(calls.filter((c) => c === STACK_A)).toHaveLength(2);
  });
});

describe('scaler loops after a restart (issue #1271)', () => {
  it('spawns each resumed stack’s instances against that stack’s own profiles index', async () => {
    const globalRedis = new FakeRedis('redis://stack-b-valkey:6379');
    const stackARedis = new FakeRedis('redis://stack-a-valkey:6379');
    // Both stacks have a live pool that survived the restart.
    for (const [redis, stack] of [
      [globalRedis, STACK_B],
      [stackARedis, STACK_A]
    ] as const) {
      await redis.hset(
        keys.pool(stack),
        'inst-1',
        JSON.stringify({
          instanceId: 'inst-1',
          url: `https://${stack}-inst-1.example`,
          activeJobs: 0,
          lastIdleAt: Date.now()
        })
      );
    }

    const registry = new WorkspaceEncoreScalerRegistry({
      redis: globalRedis as unknown as Redis,
      redisUrl: 'redis://stack-b-valkey:6379',
      oscContext: OSC_CONTEXT,
      maxInstances: 1,
      idleTimeoutMs: 60_000,
      tickIntervalMs: 60_000,
      orphanReapIntervalMs: 0,
      resolveRedisUrl: async (stackKey) =>
        stackKey === STACK_A ? 'redis://stack-a-valkey:6379' : 'redis://stack-b-valkey:6379',
      makeRedis: (url) =>
        (url === 'redis://stack-a-valkey:6379'
          ? stackARedis
          : globalRedis) as unknown as Redis,
      listStackKeys: async () => [STACK_B, STACK_A],
      // What boot resolved process-wide on a restarted instance: the
      // first-listed stack's bucket index.
      profilesUrl: BOOT_GLOBAL_PROFILES_URL,
      resolveProfilesUrl: makePerStackProfilesUrlResolver({
        defaultProfilesUrl: REMOTE_DEFAULT,
        publishForStack: fakePublisher({
          [STACK_A]: STACK_A_ENDPOINT,
          [STACK_B]: STACK_B_ENDPOINT
        })
      })
    });
    registries.push(registry);

    await registry.resumeExistingWorkspaces();

    const loops = (
      registry as unknown as {
        loops: Map<string, { loop: { config: { profilesUrl?: string } } }>;
      }
    ).loops;
    expect([...loops.keys()].sort()).toEqual([STACK_A, STACK_B]);
    expect(loops.get(STACK_A)!.loop.config.profilesUrl).toBe(STACK_A_INDEX);
    expect(loops.get(STACK_B)!.loop.config.profilesUrl).toBe(STACK_B_INDEX);
  });

  it('keeps the process-global URL for a loop key that has no per-stack form', async () => {
    const globalRedis = new FakeRedis('redis://valkey:6379');
    const registry = new WorkspaceEncoreScalerRegistry({
      redis: globalRedis as unknown as Redis,
      redisUrl: 'redis://valkey:6379',
      oscContext: OSC_CONTEXT,
      maxInstances: 1,
      idleTimeoutMs: 60_000,
      tickIntervalMs: 60_000,
      orphanReapIntervalMs: 0,
      profilesUrl: BOOT_GLOBAL_PROFILES_URL,
      resolveProfilesUrl: makePerStackProfilesUrlResolver({
        defaultProfilesUrl: REMOTE_DEFAULT,
        publishForStack: fakePublisher({})
      })
    });
    registries.push(registry);

    const client = await (
      registry as unknown as { getOrCreate: (id: string) => Promise<unknown> }
    ).getOrCreate('deployment_context');
    expect(client).toBeDefined();

    const loops = (
      registry as unknown as {
        loops: Map<string, { loop: { config: { profilesUrl?: string } } }>;
      }
    ).loops;
    expect(loops.get('deployment_context')!.loop.config.profilesUrl).toBe(
      BOOT_GLOBAL_PROFILES_URL
    );
  });
});
