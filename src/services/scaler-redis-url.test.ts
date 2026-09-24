import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Unit coverage for issue #780: the Encore auto-scaler's Valkey URL resolution
// must use the deployment's DERIVED parameter-store namespace (with the #733
// legacy fallback), not the literal `default` namespace.
//
// Before this fix, main.ts's resolveStackRedisUrl read
// `listStackNames(STACK_CONFIG_NAMESPACE)` / `loadStackConfig(STACK_CONFIG_NAMESPACE, ...)`
// — the literal string `default`. #712 moved both sides of the read/write
// contract onto the tenant-scoped namespace derived by deriveWorkspaceId, so on
// any deployment whose tenant id is not `default` that read found nothing, the
// scaler never activated, and NOTHING was logged: the only symptom was
// `GET /api/v1/scaler/status` reporting `scalerActive:false` while no transcode
// could ever be dispatched.
//
// The cases below are the #780 acceptance criteria:
//   (a) a stack whose derived namespace is NOT `default` (post-#712) resolves a
//       Valkey URL — the scaler activates;
//   (b) a stack whose config lives only under `default` (pre-#712) still
//       resolves, via the same one-shot legacy fallback;
//   (c) a resolved stack config that carries no Valkey URL is reported as a
//       fault and logged at warn (never silent);
//   (d) a parameter-store failure is reported and logged at warn;
//   (e) no provisioned stack is reported as such and logged (at info — ordinary
//       pre-provision state, but still visible).
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - WorkspaceStackResolver.resolveStackConfig(stackName?):
//     Promise<StackConfig | undefined> (src/services/workspace-stack.ts), which
//     derives the namespace via deriveWorkspaceId (workspace-stack.ts:403) and
//     reads through loadStackConfigWithLegacyFallback /
//     listStackNamesWithLegacyFallback (workspace-stack.ts:481,524).
//   - ParamStore interface (storeStackConfig / loadStackConfig /
//     deleteStackConfig / listStackNames) and the physical key layout
//     stackConfigKey(workspaceId, name) = `openvideocore/{ws}/{name}`
//     (src/services/param-store.ts:108-133).
//   - StackConfig.redisUrl: string (src/services/param-store.ts:63).
//   - Subscription = { serviceId, tenantId } / listSubscriptions(context)
//     (@osaas/client-core admin.d.ts:2-5,42, as cited in workspace-stack.ts:395-397).

const TENANT = 'workspace-tenant-a';

// Mock @osaas/client-core so deriveWorkspaceId derives a controllable namespace
// from the Context: a real tenant id by default (the post-#712 deployment this
// bug broke), reprogrammed per test to an empty subscription list when the
// `default` fallback is wanted (workspace-stack.ts:411).
vi.mock('@osaas/client-core', () => ({
  listSubscriptions: vi.fn(async () => [
    { serviceId: 'minio-minio', tenantId: TENANT }
  ]),
  Context: class {}
}));

import {
  WorkspaceStackResolver,
  STACK_CONFIG_NAMESPACE
} from './workspace-stack.js';
import {
  stackConfigKey,
  type ParamStore,
  type StackConfig
} from './param-store.js';
import {
  resolveStackRedisUrl,
  logScalerNotActivated,
  type ScalerLogger
} from './scaler-redis-url.js';
import { listSubscriptions, type Context } from '@osaas/client-core';

const mockedListSubscriptions = vi.mocked(listSubscriptions);

// The deployment's own authenticated Context; deriveWorkspaceId reads its
// tenant through the mocked listSubscriptions above, so a bare stub suffices.
const oscContext = {} as unknown as Context;

// The resolver must take the parameter-store path, not the env override
// (buildEnvConnections). resolveStackConfig never consults the env override,
// but the surrounding test env is cleaned for parity with the other resolver
// tests.
const SAVED = {
  couch: process.env['COUCHDB_URL'],
  minio: process.env['MINIO_URL']
};
beforeEach(() => {
  delete process.env['COUCHDB_URL'];
  delete process.env['MINIO_URL'];
  mockedListSubscriptions.mockImplementation(async () => [
    { serviceId: 'minio-minio', tenantId: TENANT }
  ]);
});
afterEach(() => {
  if (SAVED.couch === undefined) delete process.env['COUCHDB_URL'];
  else process.env['COUCHDB_URL'] = SAVED.couch;
  if (SAVED.minio === undefined) delete process.env['MINIO_URL'];
  else process.env['MINIO_URL'] = SAVED.minio;
  vi.restoreAllMocks();
});

function readyConfig(overrides: Partial<StackConfig> = {}): StackConfig {
  return {
    status: 'ready',
    minioEndpoint: 'https://stack-minio.example.test',
    couchdbUrl: 'https://stack-couch.example.test',
    redisUrl: 'redis://stack-valkey.example.test:6379',
    sourceBucket: 'openvideocore-source',
    packagedBucket: 'openvideocore-packaged',
    services: [],
    ...overrides
  };
}

// Namespace-AWARE in-memory ParamStore keyed by the same physical key the real
// HTTP store uses (stackConfigKey, param-store.ts:131), so a write under one
// namespace is only visible when read under that SAME namespace — which is what
// makes the literal-`default` regression reproducible here.
function makeNamespacedParamStore(): {
  store: ParamStore;
  reads: string[];
  lists: string[];
} {
  const byKey = new Map<string, StackConfig>();
  const reads: string[] = [];
  const lists: string[] = [];
  const store: ParamStore = {
    async storeStackConfig(ws, name, config) {
      byKey.set(stackConfigKey(ws, name), config);
    },
    async loadStackConfig(ws, name) {
      reads.push(stackConfigKey(ws, name));
      return byKey.get(stackConfigKey(ws, name));
    },
    async deleteStackConfig(ws, name) {
      byKey.delete(stackConfigKey(ws, name));
    },
    async listStackNames(ws) {
      lists.push(ws);
      const prefix = stackConfigKey(ws, '');
      return [...byKey.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    }
  };
  return { store, reads, lists };
}

function makeResolver(paramStore: ParamStore | undefined): WorkspaceStackResolver {
  return new WorkspaceStackResolver({
    paramStore,
    oscContext,
    minioPassword: 'not-used',
    couchPassword: 'not-used'
  });
}

// ScalerLogger stub (scaler-redis-url.ts: info/warn take (obj, msg)).
function makeLog() {
  const info = vi.fn<(obj: object, msg: string) => void>();
  const warn = vi.fn<(obj: object, msg: string) => void>();
  const log: ScalerLogger = { info, warn };
  return { log, info, warn };
}

describe('scaler Valkey URL resolution (#780)', () => {
  it('resolves the Valkey URL when the derived namespace is NOT "default" (post-#712 stack)', async () => {
    const { store, lists } = makeNamespacedParamStore();
    // Exactly the production layout from the issue: the stack config exists
    // ONLY under the tenant-scoped key, nothing under `default`.
    await store.storeStackConfig(TENANT, 'mediastack', readyConfig());

    const resolution = await resolveStackRedisUrl(makeResolver(store));

    expect(resolution).toEqual({
      outcome: 'resolved',
      redisUrl: 'redis://stack-valkey.example.test:6379'
    });
    // Regression guard: the derived tenant namespace is what was listed. A read
    // of the literal `default` would have listed nothing and left the scaler
    // inactive, which is the bug.
    expect(lists).toContain(TENANT);
    expect(TENANT).not.toBe(STACK_CONFIG_NAMESPACE);
  });

  it('activates from the tenant-scoped key without reading the legacy namespace', async () => {
    const { store, reads, lists } = makeNamespacedParamStore();
    await store.storeStackConfig(TENANT, 'mediastack', readyConfig());

    const resolution = await resolveStackRedisUrl(makeResolver(store));

    expect(resolution.outcome).toBe('resolved');
    // #733 acceptance carried over: a post-#712 stack takes NO fallback read.
    expect(lists).not.toContain(STACK_CONFIG_NAMESPACE);
    expect(reads.every((k) => !k.startsWith(stackConfigKey(STACK_CONFIG_NAMESPACE, '')))).toBe(true);
  });

  it('still resolves a pre-#712 stack whose config lives only under "default" (legacy fallback)', async () => {
    const { store } = makeNamespacedParamStore();
    // Written before the tenant-scoped namespace existed.
    await store.storeStackConfig(STACK_CONFIG_NAMESPACE, 'legacystack', readyConfig());

    const resolution = await resolveStackRedisUrl(makeResolver(store));

    expect(resolution).toEqual({
      outcome: 'resolved',
      redisUrl: 'redis://stack-valkey.example.test:6379'
    });
    // Migrate-on-read (#733): the config is now also under the tenant key.
    expect(await store.loadStackConfig(TENANT, 'legacystack')).toBeDefined();
  });

  it('reports and logs at warn when a resolved stack config carries no Valkey URL', async () => {
    const { store } = makeNamespacedParamStore();
    await store.storeStackConfig(TENANT, 'mediastack', readyConfig({ redisUrl: '' }));

    const resolution = await resolveStackRedisUrl(makeResolver(store));
    expect(resolution).toEqual({ outcome: 'no-redis-url' });

    const { log, info, warn } = makeLog();
    logScalerNotActivated(log, resolution);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(info).not.toHaveBeenCalled();
  });

  it('reports and logs at warn when the parameter-store read fails', async () => {
    const { store } = makeNamespacedParamStore();
    const failing: ParamStore = {
      ...store,
      async listStackNames() {
        throw new Error('parameter store unreachable');
      }
    };

    const resolution = await resolveStackRedisUrl(makeResolver(failing));
    expect(resolution.outcome).toBe('error');

    const { log, warn } = makeLog();
    logScalerNotActivated(log, resolution);
    expect(warn).toHaveBeenCalledTimes(1);
    const payload = warn.mock.calls[0]![0] as { err: { message: string } };
    expect(payload.err.message).toBe('parameter store unreachable');
  });

  it('reports no-stack (and logs it) when nothing is provisioned', async () => {
    const { store } = makeNamespacedParamStore();

    const resolution = await resolveStackRedisUrl(makeResolver(store));
    expect(resolution).toEqual({ outcome: 'no-stack' });

    const { log, info, warn } = makeLog();
    logScalerNotActivated(log, resolution);
    // Ordinary pre-provision state: visible, but not a fault.
    expect(info).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('reports no-stack when no parameter store is configured', async () => {
    const resolution = await resolveStackRedisUrl(makeResolver(undefined));
    expect(resolution).toEqual({ outcome: 'no-stack' });
  });

  it('still resolves when the derived namespace IS "default" (no subscriptions)', async () => {
    // deriveWorkspaceId falls back to STACK_CONFIG_NAMESPACE when the
    // subscription list is empty (workspace-stack.ts:411) — the single-stack /
    // offline case must keep working.
    mockedListSubscriptions.mockImplementation(async () => []);
    const { store } = makeNamespacedParamStore();
    await store.storeStackConfig(STACK_CONFIG_NAMESPACE, 'mediastack', readyConfig());

    const resolution = await resolveStackRedisUrl(makeResolver(store));
    expect(resolution).toEqual({
      outcome: 'resolved',
      redisUrl: 'redis://stack-valkey.example.test:6379'
    });
  });
});
