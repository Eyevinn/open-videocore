import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Integration coverage for issues #712 and #804: the resolver's READ namespace
// must equal the provision route's WRITE namespace.
//
// #712 made both sides DERIVE the namespace and checked the two derivations
// agreed. #804 removes the derivation instead: both sides use the CONSTANT
// `STACK_CONFIG_NAMESPACE`, so the keys are identical by construction and there
// is no second computation left that could drift. The root cause #804 fixes is
// precisely that provision.ts wrote under a derived namespace while main.ts read
// under the constant — every read missed, and resolveS3Config in particular
// silently fell through so Encore resolved `s3://` inputs against the wrong
// endpoint and 404'd.
//
// Nothing is derived because nothing CAN be: the parameter store is a single
// eyevinn-app-config-svc instance per deployment
// (DEFAULT_PARAM_STORE_INSTANCE_NAME = 'ovcconfig', param-store.ts:704) resolved
// through the deployment's own Context (param-store.ts:759), and one deployment
// serves exactly one tenant (ADR-018 "One deployed stack == one tenant's
// workspace"; ADR-020 Decision 1 "One deployed open-videocore instance is one
// tenant").
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - `export const STACK_CONFIG_NAMESPACE = "default"`
//     (src/services/workspace-stack.ts).
//   - persistStackConfig({ paramStore, workspaceId, name, config, maxAttempts?,
//     delayMs? }): Promise<void> (src/routes/provision.ts).
//   - WorkspaceStackResolver.resolveStackName / .resolve
//     (src/services/workspace-stack.ts).
//   - stackConfigKey(workspaceId, name) = `openvideocore/{ws}/{name}`
//     (src/services/param-store.ts:131-133).
//   - WorkspaceConnections.s3Config: { endpoint, accessKey, secretKey } |
//     undefined (src/services/workspace-stack.ts:118).

// Mocked so an accidental re-introduction of an OSC-derived namespace fails
// loudly rather than passing silently.
vi.mock('@osaas/client-core', () => ({
  listSubscriptions: vi.fn(async () => {
    throw new Error('listSubscriptions must never be called for namespace resolution (#804)');
  }),
  Context: class {}
}));

import {
  WorkspaceStackResolver,
  STACK_CONFIG_NAMESPACE
} from './workspace-stack.js';
import { persistStackConfig } from '../routes/provision.js';
import {
  stackConfigKey,
  type ParamStore,
  type StackConfig
} from './param-store.js';
import { listSubscriptions, type Context } from '@osaas/client-core';

const mockedListSubscriptions = vi.mocked(listSubscriptions);

// The deployment's own authenticated Context. Neither side reads anything off it
// for namespace purposes any more.
const oscContext = {} as unknown as Context;

// Ensure the resolver takes the parameter-store path (not the env override).
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
});

// A ready stack config with distinct per-stack coordinates so a mis-resolution
// (reading the wrong namespace) is observable as a missing stack.
function readyConfig(host: string): StackConfig {
  return {
    status: 'ready',
    minioEndpoint: `https://${host}-minio.example.test`,
    couchdbUrl: `https://${host}-couch.example.test`,
    redisUrl: `redis://${host}-valkey.example.test:6379`,
    sourceBucket: 'openvideocore-source',
    packagedBucket: 'openvideocore-packaged',
    services: []
  };
}

// Namespace-AWARE in-memory ParamStore keyed by the SAME physical key the real
// store uses (stackConfigKey(workspaceId, name), param-store.ts:131). This makes
// the write namespace and the read namespace observable: a stack written under
// <ns> is only listed/loaded when read under that SAME <ns>, exactly like the
// HTTP store. Insertion order is preserved so listStackNames returns
// first-provisioned first.
function makeNamespacedParamStore(): {
  store: ParamStore;
  keys: () => string[];
} {
  const byKey = new Map<string, StackConfig>();
  const store: ParamStore = {
    async storeStackConfig(ws, name, config) {
      byKey.set(stackConfigKey(ws, name), config);
    },
    async loadStackConfig(ws, name) {
      return byKey.get(stackConfigKey(ws, name));
    },
    async deleteStackConfig(ws, name) {
      byKey.delete(stackConfigKey(ws, name));
    },
    async listStackNames(ws) {
      const prefix = stackConfigKey(ws, '');
      return [...byKey.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    }
  };
  return { store, keys: () => [...byKey.keys()] };
}

describe('provision write namespace equals resolver read namespace (#712, #804)', () => {
  it('writes the stack under the constant namespace segment', async () => {
    const { store, keys } = makeNamespacedParamStore();

    await persistStackConfig({
      paramStore: store,
      workspaceId: STACK_CONFIG_NAMESPACE,
      name: 'primary',
      config: readyConfig('primary')
    });

    // The physical key carries the constant `default` in the middle segment and
    // the stack NAME in the last — the name is the discriminator.
    expect(keys()).toEqual(['openvideocore/default/primary']);
    expect(keys()).toEqual([stackConfigKey(STACK_CONFIG_NAMESPACE, 'primary')]);
  });

  it('resolver resolves the SAME stack provision wrote, with no derivation on either side', async () => {
    const { store } = makeNamespacedParamStore();

    // WRITE side, exactly as the provision route does as its final step.
    await persistStackConfig({
      paramStore: store,
      workspaceId: STACK_CONFIG_NAMESPACE,
      name: 'primary',
      config: readyConfig('primary')
    });

    // READ side: the resolver reads the same constant namespace. No stale-
    // namespace scanner is wired — this is the CLEAN case, and it must resolve
    // with no migration help whatsoever.
    const resolver = new WorkspaceStackResolver({
      paramStore: store,
      oscContext,
      minioPassword: 'pw',
      couchPassword: 'pw'
    });

    expect(await resolver.resolveStackName('primary')).toBe('primary');
    expect(await resolver.resolveStackName(undefined)).toBe('primary');

    // resolve() builds real connections from that same stack: proves the read
    // resolves the provisioned coordinates, not the no-storage in-memory
    // fallback the pre-fix divergence produced.
    const connections = await resolver.resolve('primary');
    expect(connections.storageFor).toBeDefined();
    expect(connections.s3Config?.endpoint).toBe(
      'https://primary-minio.example.test'
    );

    expect(mockedListSubscriptions).not.toHaveBeenCalled();
  });

  it('keeps two stacks written into the SAME store distinct (last segment is the discriminator)', async () => {
    const { store, keys } = makeNamespacedParamStore();

    await persistStackConfig({
      paramStore: store,
      workspaceId: STACK_CONFIG_NAMESPACE,
      name: 'primary',
      config: readyConfig('primary')
    });
    await persistStackConfig({
      paramStore: store,
      workspaceId: STACK_CONFIG_NAMESPACE,
      name: 'secondary',
      config: readyConfig('secondary')
    });

    expect(keys()).toEqual([
      'openvideocore/default/primary',
      'openvideocore/default/secondary'
    ]);

    const resolver = new WorkspaceStackResolver({
      paramStore: store,
      oscContext,
      minioPassword: 'pw',
      couchPassword: 'pw'
    });

    expect((await resolver.resolve('primary')).s3Config?.endpoint).toBe(
      'https://primary-minio.example.test'
    );
    expect((await resolver.resolve('secondary')).s3Config?.endpoint).toBe(
      'https://secondary-minio.example.test'
    );
  });
});
