import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Coverage for WorkspaceStackResolver.listReadyStackNames() (issue #1098,
// #1141 review finding 1) — the readiness-filtered counterpart of
// listStackNames().
//
// WHY THE TWO DIFFER. `listStackNames()` returns every key under the workspace
// prefix with NO status read, and swallows a read failure as "no stacks"
// because its callers are best-effort sweeps and unauthenticated callbacks. The
// records it returns deliberately include the `status: 'provisioning'` entry
// the provision route writes BEFORE creating services and the
// `status: 'failed'` entry it writes on a failure path — both persist so the
// deprovision route can still read their `services[]`.
//
// The deployment-wide storage-quota sum (src/data/storage-quota-stack-sum.ts)
// cannot use that listing: it must tell "this stack is simply not live" apart
// from "a live stack resolved without object storage", and both produce
// connections with no storage client. So it asks here instead, and for the same
// reason a parameter-store read failure must THROW rather than being reported
// as "those stacks are not ready" — a transient outage reported as a silent
// skip would let the sweep commit a short deployment total.
//
// Cases:
//   (a) 'ready' and a status-less legacy record are listed; 'provisioning' and
//       'failed' are not — while listStackNames() still returns all four;
//   (b) listing order follows the underlying listing;
//   (c) no parameter store configured => [] (env-override / bare local run),
//       matching listStackNames();
//   (d) a FAILING list read THROWS here, where listStackNames() returns [];
//   (e) a FAILING per-stack config read THROWS here too — an unreadable record
//       is not evidence that the stack is not ready.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - WorkspaceStackResolver.listReadyStackNames(): Promise<string[]> and
//     listStackNames(): Promise<string[]> (src/services/workspace-stack.ts),
//     reading through listStackNamesWithMigration / loadStackConfigWithMigration
//     under the constant namespace `STACK_CONFIG_NAMESPACE`
//     (src/services/workspace-stack.ts:958-986).
//   - isReadyStack(config) = `config.status === undefined || config.status ===
//     'ready'`, with 'provisioning'/'failed' "skipped by the resolver but
//     [remaining] readable for deprovision cleanup"
//     (src/services/param-store.ts:121-128).
//   - ParamStore { storeStackConfig, loadStackConfig, deleteStackConfig,
//     listStackNames } and stackConfigKey(workspaceId, name) =
//     `openvideocore/{ws}/{name}` (src/services/param-store.ts:130-157).
//   - StackConfig fields { status?, minioEndpoint, couchdbUrl, redisUrl,
//     sourceBucket, packagedBucket, services } (src/services/param-store.ts:52-).
//   - WorkspaceStackResolver constructor options { paramStore, oscContext,
//     minioPassword, couchPassword, ... } (src/services/workspace-stack.ts:907).

// Mirrors the mock used by the other resolver suites: the namespace segment is
// a constant (#804), so no OSC round-trip may happen on this path.
vi.mock('@osaas/client-core', () => ({
  listSubscriptions: vi.fn(async () => {
    throw new Error('listSubscriptions must never be called to list stacks (#804)');
  }),
  Context: class {}
}));

import { WorkspaceStackResolver, STACK_CONFIG_NAMESPACE } from './workspace-stack.js';
import { stackConfigKey, type ParamStore, type StackConfig } from './param-store.js';
import { type Context } from '@osaas/client-core';

const oscContext = {} as unknown as Context;

const SAVED = {
  couch: process.env['COUCHDB_URL'],
  minio: process.env['MINIO_URL']
};
beforeEach(() => {
  // The env override short-circuits resolve(); the listing paths do not consult
  // it, but keep the environment neutral so that stays an assertion-free fact.
  delete process.env['COUCHDB_URL'];
  delete process.env['MINIO_URL'];
});
afterEach(() => {
  if (SAVED.couch === undefined) delete process.env['COUCHDB_URL'];
  else process.env['COUCHDB_URL'] = SAVED.couch;
  if (SAVED.minio === undefined) delete process.env['MINIO_URL'];
  else process.env['MINIO_URL'] = SAVED.minio;
  vi.restoreAllMocks();
});

function configFor(name: string, status?: StackConfig['status']): StackConfig {
  return {
    ...(status ? { status } : {}),
    minioEndpoint: `https://${name}-objectstore.example.test`,
    couchdbUrl: `https://${name}-documents.example.test`,
    redisUrl: `redis://${name}-queue.example.test:6379`,
    sourceBucket: 'openvideocore-source',
    packagedBucket: 'openvideocore-packaged',
    services: []
  };
}

// In-memory ParamStore keyed by the real physical key (stackConfigKey), with
// injectable read failures.
function makeStore(
  entries: Array<[string, StackConfig]>,
  fail?: { list?: boolean; loadName?: string }
) {
  const byKey = new Map<string, StackConfig>();
  for (const [name, config] of entries) {
    byKey.set(stackConfigKey(STACK_CONFIG_NAMESPACE, name), config);
  }
  const order = entries.map(([name]) => name);
  const store: ParamStore = {
    async storeStackConfig(ws, name, config) {
      byKey.set(stackConfigKey(ws, name), config);
    },
    async loadStackConfig(ws, name) {
      if (fail?.loadName === name) {
        throw new Error(`parameter store read failed for ${name}`);
      }
      return byKey.get(stackConfigKey(ws, name));
    },
    async deleteStackConfig(ws, name) {
      byKey.delete(stackConfigKey(ws, name));
    },
    async listStackNames(ws) {
      if (fail?.list) throw new Error('parameter store list failed');
      const prefix = stackConfigKey(ws, '');
      return order.filter((name) => byKey.has(`${prefix}${name}`));
    }
  };
  return store;
}

function makeResolver(paramStore: ParamStore | undefined): WorkspaceStackResolver {
  return new WorkspaceStackResolver({
    paramStore,
    oscContext,
    minioPassword: 'not-used',
    couchPassword: 'not-used'
  });
}

describe('WorkspaceStackResolver.listReadyStackNames (#1098, #1141 finding 1)', () => {
  const MIXED: Array<[string, StackConfig]> = [
    ['stack-ready', configFor('stack-ready', 'ready')],
    ['stack-provisioning', configFor('stack-provisioning', 'provisioning')],
    ['stack-failed', configFor('stack-failed', 'failed')],
    // Written before `status` existed (#106 back-compat): read as ready.
    ['stack-legacy', configFor('stack-legacy')]
  ];

  it('(a) returns only ready and status-less-legacy stacks', async () => {
    const resolver = makeResolver(makeStore(MIXED));
    expect(await resolver.listReadyStackNames()).toEqual(['stack-ready', 'stack-legacy']);
  });

  it('(a2) listStackNames still returns every record, including the non-ready ones', async () => {
    const resolver = makeResolver(makeStore(MIXED));
    // The unfiltered listing is what deprovision needs and what the quota sweep
    // must NOT use; the two methods are deliberately different.
    expect(await resolver.listStackNames()).toEqual([
      'stack-ready',
      'stack-provisioning',
      'stack-failed',
      'stack-legacy'
    ]);
  });

  it('(b) preserves the underlying listing order', async () => {
    const resolver = makeResolver(
      makeStore([
        ['stack-z', configFor('stack-z', 'ready')],
        ['stack-m', configFor('stack-m')],
        ['stack-a', configFor('stack-a', 'ready')]
      ])
    );
    expect(await resolver.listReadyStackNames()).toEqual(['stack-z', 'stack-m', 'stack-a']);
  });

  it('(b2) every stack non-ready => no ready stacks, without throwing', async () => {
    const resolver = makeResolver(
      makeStore([
        ['stack-provisioning', configFor('stack-provisioning', 'provisioning')],
        ['stack-failed', configFor('stack-failed', 'failed')]
      ])
    );
    expect(await resolver.listReadyStackNames()).toEqual([]);
  });

  it('(c) no parameter store configured => no stacks', async () => {
    const resolver = makeResolver(undefined);
    expect(await resolver.listReadyStackNames()).toEqual([]);
    expect(await resolver.listStackNames()).toEqual([]);
  });

  it('(d) a failing list read THROWS, where listStackNames reports "no stacks"', async () => {
    const resolver = makeResolver(makeStore(MIXED, { list: true }));
    // "We could not read the store" must never be mistaken for "nothing is
    // ready" — the quota sweep would commit a short deployment-wide total.
    await expect(resolver.listReadyStackNames()).rejects.toThrow('parameter store list failed');
    // The best-effort listing keeps its documented swallow-and-report-empty.
    await expect(resolver.listStackNames()).resolves.toEqual([]);
  });

  it('(e) a failing per-stack config read THROWS rather than dropping that stack', async () => {
    const resolver = makeResolver(makeStore(MIXED, { loadName: 'stack-ready' }));
    await expect(resolver.listReadyStackNames()).rejects.toThrow(
      'parameter store read failed for stack-ready'
    );
  });
});
