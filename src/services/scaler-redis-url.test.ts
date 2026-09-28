import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Unit coverage for the Encore auto-scaler's Valkey URL resolution (issues #780,
// #804).
//
// #780 fixed main.ts's resolveStackRedisUrl reading a namespace that disagreed
// with the write side; the symptom was `GET /api/v1/scaler/status` reporting
// `scalerActive:false` with nothing logged, and no transcode ever dispatched.
//
// #804 settles what that namespace IS: the CONSTANT `STACK_CONFIG_NAMESPACE`,
// on both the read and the write side. There is nothing to derive — the
// parameter store is one eyevinn-app-config-svc instance per deployment
// (DEFAULT_PARAM_STORE_INSTANCE_NAME = 'ovcconfig', param-store.ts:704) and one
// deployment is one tenant (ADR-018 "One deployed stack == one tenant's
// workspace"; ADR-020 Decision 1), so the middle key segment can only ever hold
// one value. Stacks stay separated by the LAST segment, the stack name.
//
// Cases below:
//   (a) a stack written under the constant namespace resolves a Valkey URL, and
//       the resolver lists/reads ONLY the constant — no derivation, no scan;
//   (b) several stacks in one store still resolve independently by name (the
//       collapse does not reintroduce a collision);
//   (c) a pre-#804 stack whose config exists ONLY under a stale derived
//       namespace still resolves, via the bounded one-shot migration, and is
//       rewritten under the constant;
//   (d) a resolved stack config that carries no Valkey URL is reported as a
//       fault and logged at warn (never silent);
//   (e) a parameter-store failure is reported and logged at warn;
//   (f) no provisioned stack is reported as such and logged (at info — ordinary
//       pre-provision state, but still visible).
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - WorkspaceStackResolver.resolveStackConfig(stackName?):
//     Promise<StackConfig | undefined> (src/services/workspace-stack.ts), which
//     reads through loadStackConfigWithMigration / listStackNamesWithMigration.
//   - WorkspaceStackResolver constructor option
//     `staleNamespaceScanner?: StackConfigKeyScanner` and
//     `StackConfigKeyScanner = { listByPrefix(prefix: string):
//     Promise<Array<{ key: string; value: string }>> }`
//     (src/services/workspace-stack.ts), structurally satisfied by
//     ConfigKvStore.listByPrefix (src/services/param-store.ts:602-608).
//   - ParamStore interface (storeStackConfig / loadStackConfig /
//     deleteStackConfig / listStackNames) and the physical key layout
//     stackConfigKey(workspaceId, name) = `openvideocore/{ws}/{name}`
//     (src/services/param-store.ts:108-133).
//   - StackConfig.redisUrl: string (src/services/param-store.ts:63).

// @osaas/client-core is mocked only so constructing a Context stub costs
// nothing. Nothing in the namespace path calls into it any more (#804 removed
// the listSubscriptions tenant scan entirely) — asserted explicitly below.
vi.mock('@osaas/client-core', () => ({
  listSubscriptions: vi.fn(async () => {
    throw new Error('listSubscriptions must never be called for namespace resolution (#804)');
  }),
  Context: class {}
}));

import {
  WorkspaceStackResolver,
  STACK_CONFIG_NAMESPACE,
  type StackConfigKeyScanner
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

// A namespace value a PRE-#804 build could have written under. Deliberately not
// `default` so a read that still derived would diverge from a read that does not.
const STALE_NAMESPACE = 'workspace-tenant-a';

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
  mockedListSubscriptions.mockClear();
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
// makes a namespace regression reproducible here. `scanner` is the
// StackConfigKeyScanner view over the same backing map, mirroring how main.ts
// hands the resolver the ConfigKvStore built against the same config service.
function makeNamespacedParamStore(): {
  store: ParamStore;
  scanner: StackConfigKeyScanner;
  reads: string[];
  lists: string[];
  keys(): string[];
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
  const scanner: StackConfigKeyScanner = {
    async listByPrefix(prefix) {
      return [...byKey.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value: JSON.stringify(value) }));
    }
  };
  return { store, scanner, reads, lists, keys: () => [...byKey.keys()] };
}

function makeResolver(
  paramStore: ParamStore | undefined,
  scanner?: StackConfigKeyScanner
): WorkspaceStackResolver {
  return new WorkspaceStackResolver({
    paramStore,
    oscContext,
    minioPassword: 'not-used',
    couchPassword: 'not-used',
    ...(scanner ? { staleNamespaceScanner: scanner } : {})
  });
}

// ScalerLogger stub (scaler-redis-url.ts: info/warn take (obj, msg)).
function makeLog() {
  const info = vi.fn<(obj: object, msg: string) => void>();
  const warn = vi.fn<(obj: object, msg: string) => void>();
  const log: ScalerLogger = { info, warn };
  return { log, info, warn };
}

describe('scaler Valkey URL resolution (#780, #804)', () => {
  it('resolves the Valkey URL from the CONSTANT namespace, with no derivation and no cross-namespace scan', async () => {
    const { store, scanner, reads, lists } = makeNamespacedParamStore();
    await store.storeStackConfig(STACK_CONFIG_NAMESPACE, 'mediastack', readyConfig());

    const resolution = await resolveStackRedisUrl(makeResolver(store, scanner));

    expect(resolution).toEqual({
      outcome: 'resolved',
      redisUrl: 'redis://stack-valkey.example.test:6379'
    });
    // Every list and every read used the constant — nothing else was touched.
    expect(lists).toEqual([STACK_CONFIG_NAMESPACE]);
    expect(
      reads.every((k) => k.startsWith(stackConfigKey(STACK_CONFIG_NAMESPACE, '')))
    ).toBe(true);
    // #804: the namespace is a constant, so no OSC round-trip happens at all.
    expect(mockedListSubscriptions).not.toHaveBeenCalled();
  });

  it('keeps several stacks in ONE store separated by name (collapsing the middle segment reintroduces no collision)', async () => {
    const { store, scanner } = makeNamespacedParamStore();
    await store.storeStackConfig(
      STACK_CONFIG_NAMESPACE,
      'alpha',
      readyConfig({ redisUrl: 'redis://alpha-valkey.example.test:6379' })
    );
    await store.storeStackConfig(
      STACK_CONFIG_NAMESPACE,
      'beta',
      readyConfig({ redisUrl: 'redis://beta-valkey.example.test:6379' })
    );

    const resolver = makeResolver(store, scanner);
    expect((await resolver.resolveStackConfig('alpha'))?.redisUrl).toBe(
      'redis://alpha-valkey.example.test:6379'
    );
    expect((await resolver.resolveStackConfig('beta'))?.redisUrl).toBe(
      'redis://beta-valkey.example.test:6379'
    );
  });

  it('still resolves a pre-#804 stack whose config lives only under a stale derived namespace, and rewrites it under the constant', async () => {
    const { store, scanner, keys } = makeNamespacedParamStore();
    // Exactly the production layout issue #804 describes: a pre-#804 build wrote
    // the stack under its derived namespace, and nothing exists under `default`.
    await store.storeStackConfig(STALE_NAMESPACE, 'legacystack', readyConfig());
    expect(STALE_NAMESPACE).not.toBe(STACK_CONFIG_NAMESPACE);

    const resolution = await resolveStackRedisUrl(makeResolver(store, scanner));

    expect(resolution).toEqual({
      outcome: 'resolved',
      redisUrl: 'redis://stack-valkey.example.test:6379'
    });
    // One-shot migration: the config now also lives under the constant, so the
    // next read is a direct hit and the fallback is never taken again.
    expect(keys()).toContain(stackConfigKey(STACK_CONFIG_NAMESPACE, 'legacystack'));
    expect(await store.loadStackConfig(STACK_CONFIG_NAMESPACE, 'legacystack')).toBeDefined();
  });

  it('does NOT migrate when the store holds stack configs under SEVERAL stale namespaces (refuses to guess)', async () => {
    const { store, scanner, keys } = makeNamespacedParamStore();
    await store.storeStackConfig('tenant-one', 'ambiguous', readyConfig());
    await store.storeStackConfig('tenant-two', 'ambiguous', readyConfig());

    const resolution = await resolveStackRedisUrl(makeResolver(store, scanner));

    expect(resolution).toEqual({ outcome: 'no-stack' });
    expect(keys()).not.toContain(stackConfigKey(STACK_CONFIG_NAMESPACE, 'ambiguous'));
  });

  it('does NOT migrate when no scanner is wired (a plain miss stays a miss)', async () => {
    const { store } = makeNamespacedParamStore();
    await store.storeStackConfig(STALE_NAMESPACE, 'legacystack', readyConfig());

    const resolution = await resolveStackRedisUrl(makeResolver(store));
    expect(resolution).toEqual({ outcome: 'no-stack' });
  });

  it('reports and logs at warn when a resolved stack config carries no Valkey URL', async () => {
    const { store, scanner } = makeNamespacedParamStore();
    await store.storeStackConfig(
      STACK_CONFIG_NAMESPACE,
      'mediastack',
      readyConfig({ redisUrl: '' })
    );

    const resolution = await resolveStackRedisUrl(makeResolver(store, scanner));
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
    const { store, scanner } = makeNamespacedParamStore();

    const resolution = await resolveStackRedisUrl(makeResolver(store, scanner));
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
});
