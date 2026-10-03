// The READ paths resolve each stack's OWN object-store credential (issue #1094).
//
// #1094 requires the credential to be resolved alongside the endpoint in BOTH
// read paths that hand out object-store access:
//   - the API's per-stack client — WorkspaceStackResolver ->
//     buildConnectionsFromStack (services/workspace-stack.ts), which builds the
//     S3 client used for presigned uploads/reads and exposes `s3Config` to the
//     per-job runners (pipeline/runner-option.ts);
//   - the spawned transcoders — resolveEncoreS3Config
//     (services/encore-s3-config.ts), whose result the scaler copies into the
//     Encore create body (encore-scaler/instance-pool.ts:618-622).
//
// Acceptance: two stacks resolve to DIFFERENT credentials; stack A's credential
// is not a credential stack B's object store would accept; no secret appears in
// a log line; and a stack provisioned before #1094 still resolves to the exact
// legacy pair (the compatible fallback — #1096 migrates it).
//
// Contract sources (CLAUDE.md rule 7):
//   - ParamStore.{storeStackConfig,loadStackConfig,listStackNames} and
//     stackConfigKey(workspaceId, name) (services/param-store.ts).
//   - StackConfig.objectStoreAccessKeyId?: string (services/param-store.ts).
//   - resolveEncoreS3Config(deps, stackKey): Promise<EncoreS3Config |
//     undefined>, EncoreS3Config = { endpoint, accessKeyId, secretAccessKey,
//     region? } (services/encore-s3-config.ts; encore-scaler/types.ts).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@osaas/client-core', () => ({
  listSubscriptions: vi.fn(async () => {
    throw new Error('listSubscriptions must never be called (#804)');
  }),
  Context: class {}
}));

import { WorkspaceStackResolver, STACK_CONFIG_NAMESPACE } from './workspace-stack.js';
import { resolveEncoreS3Config } from './encore-s3-config.js';
import {
  LEGACY_OBJECT_STORE_ACCESS_KEY_ID,
  deriveObjectStoreCredential
} from './object-store-credentials.js';
import {
  stackConfigKey,
  type ParamStore,
  type StackConfig
} from './param-store.js';
import type { Context } from '@osaas/client-core';

// MINIO_ROOT_PASSWORD. Since #1094 this is the derivation SEED and the legacy
// fallback secret — the same env value in both roles.
const SEED = 'deployment-wide-object-store-password';
const COUCH_PASSWORD = 'couch-password';

const CRED_A = deriveObjectStoreCredential(SEED, 'stacka');
const CRED_B = deriveObjectStoreCredential(SEED, 'stackb');

const oscContext = {} as unknown as Context;

const SAVED = {
  couch: process.env['COUCHDB_URL'],
  minio: process.env['MINIO_URL']
};

beforeEach(() => {
  // Force the parameter-store path, not the env override.
  delete process.env['COUCHDB_URL'];
  delete process.env['MINIO_URL'];
});
afterEach(() => {
  if (SAVED.couch === undefined) delete process.env['COUCHDB_URL'];
  else process.env['COUCHDB_URL'] = SAVED.couch;
  if (SAVED.minio === undefined) delete process.env['MINIO_URL'];
  else process.env['MINIO_URL'] = SAVED.minio;
});

function configFor(name: string, objectStoreAccessKeyId?: string): StackConfig {
  return {
    status: 'ready',
    minioEndpoint: `https://${name}-objectstore.example.test`,
    couchdbUrl: `https://${name}-documents.example.test`,
    redisUrl: `redis://${name}-queue.example.test:6379`,
    sourceBucket: 'openvideocore-source',
    packagedBucket: 'openvideocore-packaged',
    ...(objectStoreAccessKeyId ? { objectStoreAccessKeyId } : {}),
    services: []
  };
}

function makeStore(configs: Record<string, StackConfig>) {
  const byKey = new Map<string, StackConfig>();
  for (const [name, config] of Object.entries(configs)) {
    byKey.set(stackConfigKey(STACK_CONFIG_NAMESPACE, name), config);
  }
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
  return store;
}

function makeResolver(store: ParamStore) {
  return new WorkspaceStackResolver({
    paramStore: store,
    oscContext,
    minioPassword: SEED,
    couchPassword: COUCH_PASSWORD
  });
}

function s3ConfigDeps(store: ParamStore, log = { error: vi.fn() }) {
  return {
    paramStore: store,
    // The legacy deployment-wide secret (ENCORE_S3_SECRET_KEY /
    // MINIO_SECRET_KEY / MINIO_ROOT_PASSWORD).
    secretAccessKey: SEED,
    // The per-stack derivation seed (#1094).
    objectStoreCredentialSeed: SEED,
    staticFallbackConfigured: false,
    log
  };
}

describe("the API's per-stack client uses the stack's own credential (issue #1094)", () => {
  it('resolves two stacks to two different credentials', async () => {
    const store = makeStore({
      stacka: configFor('stacka', CRED_A.accessKeyId),
      stackb: configFor('stackb', CRED_B.accessKeyId)
    });
    const resolver = makeResolver(store);

    const a = await resolver.resolve('stacka');
    const b = await resolver.resolve('stackb');

    expect(a.s3Config).toEqual({
      endpoint: 'https://stacka-objectstore.example.test',
      accessKey: CRED_A.accessKeyId,
      secretKey: CRED_A.secretAccessKey
    });
    expect(b.s3Config).toEqual({
      endpoint: 'https://stackb-objectstore.example.test',
      accessKey: CRED_B.accessKeyId,
      secretKey: CRED_B.secretAccessKey
    });

    // Different stacks, different credentials — and neither is the former
    // process-global root pair.
    expect(a.s3Config?.accessKey).not.toBe(b.s3Config?.accessKey);
    expect(a.s3Config?.secretKey).not.toBe(b.s3Config?.secretKey);
    for (const connections of [a, b]) {
      expect(connections.s3Config?.accessKey).not.toBe(
        LEGACY_OBJECT_STORE_ACCESS_KEY_ID
      );
      expect(connections.s3Config?.secretKey).not.toBe(SEED);
    }
  });

  it('keeps the exact legacy pair for a stack provisioned before #1094', async () => {
    const store = makeStore({ oldstack: configFor('oldstack') });
    const connections = await makeResolver(store).resolve('oldstack');

    expect(connections.s3Config).toEqual({
      endpoint: 'https://oldstack-objectstore.example.test',
      accessKey: LEGACY_OBJECT_STORE_ACCESS_KEY_ID,
      secretKey: SEED
    });
  });
});

describe('spawned transcoders get the stack\'s own credential (issue #1094)', () => {
  it('resolves the credential alongside the endpoint, per stack', async () => {
    const store = makeStore({
      stacka: configFor('stacka', CRED_A.accessKeyId),
      stackb: configFor('stackb', CRED_B.accessKeyId)
    });

    const a = await resolveEncoreS3Config(s3ConfigDeps(store), 'stacka');
    const b = await resolveEncoreS3Config(s3ConfigDeps(store), 'stackb');

    expect(a).toEqual({
      endpoint: 'https://stacka-objectstore.example.test',
      accessKeyId: CRED_A.accessKeyId,
      secretAccessKey: CRED_A.secretAccessKey
    });
    expect(b).toEqual({
      endpoint: 'https://stackb-objectstore.example.test',
      accessKeyId: CRED_B.accessKeyId,
      secretAccessKey: CRED_B.secretAccessKey
    });

    // A transcoder spawned for stack A is handed a key stack B's object store
    // has never issued — so the same byte stream cannot be read across stacks.
    expect(a?.accessKeyId).not.toBe(b?.accessKeyId);
    expect(a?.secretAccessKey).not.toBe(b?.secretAccessKey);
    expect(a?.secretAccessKey).not.toBe(SEED);
  });

  it('matches the credential the API client uses for the same stack', async () => {
    const store = makeStore({ stacka: configFor('stacka', CRED_A.accessKeyId) });

    const connections = await makeResolver(store).resolve('stacka');
    const transcoder = await resolveEncoreS3Config(s3ConfigDeps(store), 'stacka');

    // Both read paths must agree, or an upload the API accepts is unreadable by
    // the transcoder it spawns.
    expect(transcoder?.accessKeyId).toBe(connections.s3Config?.accessKey);
    expect(transcoder?.secretAccessKey).toBe(connections.s3Config?.secretKey);
  });

  it('keeps the legacy pair for a pre-#1094 stack, and for a deployment with no seed', async () => {
    const store = makeStore({ oldstack: configFor('oldstack') });

    expect(await resolveEncoreS3Config(s3ConfigDeps(store), 'oldstack')).toEqual({
      endpoint: 'https://oldstack-objectstore.example.test',
      accessKeyId: LEGACY_OBJECT_STORE_ACCESS_KEY_ID,
      secretAccessKey: SEED
    });

    // A migrated stack on a deployment where no seed is configured cannot
    // derive the secret; it degrades to the legacy pair rather than throwing.
    const migrated = makeStore({
      stacka: configFor('stacka', CRED_A.accessKeyId)
    });
    const noSeed = await resolveEncoreS3Config(
      { ...s3ConfigDeps(migrated), objectStoreCredentialSeed: undefined },
      'stacka'
    );
    expect(noSeed?.accessKeyId).toBe(LEGACY_OBJECT_STORE_ACCESS_KEY_ID);
  });

  it('never logs the secret, including on the fail-loud path', async () => {
    const log = { error: vi.fn() };
    // A stored config with no endpoint: the resolver logs and throws.
    const store = makeStore({
      stacka: { ...configFor('stacka', CRED_A.accessKeyId), minioEndpoint: '' }
    });

    await expect(
      resolveEncoreS3Config(s3ConfigDeps(store, log), 'stacka')
    ).rejects.toThrow(/no object-store endpoint resolvable/);

    const logged = JSON.stringify(log.error.mock.calls);
    expect(logged).not.toContain(CRED_A.secretAccessKey);
    expect(logged).not.toContain(SEED);
  });
});
