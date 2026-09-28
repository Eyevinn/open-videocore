import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ACCEPTANCE coverage for issue #804 (and the #335 symptom it shares a root
// cause with): a stack provisioned on a deployment must actually be transcodable.
//
// The bug: provision.ts wrote the stack config under a DERIVED namespace while
// main.ts read it under the constant, so every main.ts read missed. The read
// that mattered most was resolveS3Config — it silently returned undefined, the
// spawned Encore instance got NO `s3Endpoint`
// (src/encore-scaler/instance-pool.ts:368-372 only sets the s3* body fields when
// a config is present), and the job's hostless `s3://<bucket>/<key>` input
// (src/pipeline/transcode.ts:120) was then resolved against AWS S3 instead of
// the stack's own object store, failing with an unexplained 404.
//
// Both paths in this file start from a stack persisted exactly as the provision
// route persists it — via persistStackConfig under STACK_CONFIG_NAMESPACE — so
// the write side under test is the real one, not a fixture shaped to fit.
//
// Path 1, CLEAN deployment: a fresh store with NO `default` config and NO stale
// namespace fixture. Provision, resolve, build the transcode input URI, and
// resolve the Encore S3 config. The input URI must address the provisioned
// stack's source bucket, and the object-store endpoint handed to Encore must be
// the provisioned MinIO endpoint.
//
// Path 2, MIGRATION: a store whose config exists ONLY under a stale
// non-`default` namespace (a pre-#804 deployment). The resolver must adopt it
// via the bounded one-shot migration, end up with it rewritten under `default`,
// and then resolve the Encore S3 config to the same endpoint through the plain
// constant-namespace read.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - persistStackConfig({ paramStore, workspaceId, name, config, maxAttempts?,
//     delayMs? }): Promise<void> (src/routes/provision.ts).
//   - `export const STACK_CONFIG_NAMESPACE = "default"`,
//     `export type StackConfigKeyScanner = { listByPrefix(prefix: string):
//     Promise<Array<{ key: string; value: string }>> }`, and
//     WorkspaceStackResolver.resolve / .resolveStackName / .resolveStackConfig
//     (src/services/workspace-stack.ts).
//   - WorkspaceConnections.sourceBucket: string and
//     .s3Config: { endpoint, accessKey, secretKey } | undefined
//     (src/services/workspace-stack.ts:118).
//   - resolveEncoreS3Config(deps, stackKey): Promise<EncoreS3Config | undefined>
//     and EncoreS3Config = { endpoint, accessKeyId, secretAccessKey, region? }
//     (src/services/encore-s3-config.ts; src/encore-scaler/types.ts:24-29).
//   - Encore submit payload `inputs: [{ uri, type: 'AudioVideo' }]` built from
//     EncoreSubmitInput.inputUri (src/pipeline/encore-client.ts:81-95), whose
//     value is `s3://${sourceBucket}/${sourceObjectKey}`
//     (src/pipeline/transcode.ts:120).
//   - ParamStore + stackConfigKey(workspaceId, name) =
//     `openvideocore/{ws}/{name}` (src/services/param-store.ts:108-133).

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
import { resolveEncoreS3Config } from './encore-s3-config.js';
import { persistStackConfig } from '../routes/provision.js';
import { toEncorePayload } from '../pipeline/encore-client.js';
import {
  stackConfigKey,
  type ParamStore,
  type StackConfig
} from './param-store.js';
import type { Context } from '@osaas/client-core';

const STACK_NAME = 'mediastack';
const MINIO_ENDPOINT = 'https://mediastack-minio.example.test';
const SOURCE_BUCKET = 'openvideocore-source';
const PACKAGED_BUCKET = 'openvideocore-packaged';
const SOURCE_OBJECT_KEY = 'assets/asset-1/source.mp4';
const MINIO_ROOT_PASSWORD = 'minio-root-password';

// A namespace a PRE-#804 build could have derived and written under.
const STALE_NAMESPACE = 'workspace-tenant-a';

const oscContext = {} as unknown as Context;

const SAVED = {
  couch: process.env['COUCHDB_URL'],
  minio: process.env['MINIO_URL']
};
beforeEach(() => {
  // Force the parameter-store path, not the env override (buildEnvConnections).
  delete process.env['COUCHDB_URL'];
  delete process.env['MINIO_URL'];
});
afterEach(() => {
  if (SAVED.couch === undefined) delete process.env['COUCHDB_URL'];
  else process.env['COUCHDB_URL'] = SAVED.couch;
  if (SAVED.minio === undefined) delete process.env['MINIO_URL'];
  else process.env['MINIO_URL'] = SAVED.minio;
});

function provisionedConfig(): StackConfig {
  return {
    status: 'ready',
    minioEndpoint: MINIO_ENDPOINT,
    couchdbUrl: 'https://mediastack-couch.example.test',
    redisUrl: 'redis://mediastack-valkey.example.test:6379',
    sourceBucket: SOURCE_BUCKET,
    packagedBucket: PACKAGED_BUCKET,
    services: []
  };
}

// Namespace-aware in-memory ParamStore keyed by the real physical key
// (stackConfigKey, param-store.ts:131), plus the StackConfigKeyScanner view over
// the same backing map that main.ts supplies from its ConfigKvStore.
function makeStore() {
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
  const scanner: StackConfigKeyScanner = {
    async listByPrefix(prefix) {
      return [...byKey.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value: JSON.stringify(value) }));
    }
  };
  return { store, scanner, keys: () => [...byKey.keys()] };
}

function s3ConfigDeps(paramStore: ParamStore) {
  return {
    paramStore,
    secretAccessKey: MINIO_ROOT_PASSWORD,
    // On OSC no static ENCORE_S3_ENDPOINT is set: the endpoint MUST come from
    // the stack config, which is precisely what #804 broke.
    staticFallbackConfigured: false,
    log: { error: vi.fn() }
  };
}

describe('transcode reaches the provisioned object store (#804 acceptance)', () => {
  it('CLEAN deployment: provision, resolve, and submit — the input URI and the Encore endpoint both target the provisioned stack', async () => {
    const { store, scanner, keys } = makeStore();

    // A genuinely fresh deployment: nothing under `default`, and no stale
    // namespace fixture either.
    expect(keys()).toEqual([]);

    // WRITE side — exactly what the provision route does as its final step.
    await persistStackConfig({
      paramStore: store,
      workspaceId: STACK_CONFIG_NAMESPACE,
      name: STACK_NAME,
      config: provisionedConfig()
    });
    expect(keys()).toEqual([stackConfigKey(STACK_CONFIG_NAMESPACE, STACK_NAME)]);

    // READ side — the runtime resolver finds that stack with no migration help.
    const resolver = new WorkspaceStackResolver({
      paramStore: store,
      oscContext,
      minioPassword: MINIO_ROOT_PASSWORD,
      couchPassword: 'couch-password',
      staleNamespaceScanner: scanner
    });

    expect(await resolver.resolveStackName()).toBe(STACK_NAME);
    const connections = await resolver.resolve(STACK_NAME);
    expect(connections.storageFor).toBeDefined();
    expect(connections.sourceBucket).toBe(SOURCE_BUCKET);
    expect(connections.s3Config?.endpoint).toBe(MINIO_ENDPOINT);

    // The abr-vod transcode step builds its input as
    // `s3://${sourceBucket}/${sourceObjectKey}` (transcode.ts:120) from the
    // bucket the resolver just returned, and hands it to Encore as
    // inputs[0].uri (encore-client.ts:95).
    const payload = toEncorePayload({
      externalId: 'job-1',
      inputUri: `s3://${connections.sourceBucket}/${SOURCE_OBJECT_KEY}`,
      outputUri: `s3://${connections.packagedBucket}/packaged/asset-1/job-1`,
      profile: 'abr-vod'
    });
    expect(payload['inputs']).toEqual([
      { uri: `s3://${SOURCE_BUCKET}/${SOURCE_OBJECT_KEY}`, type: 'AudioVideo' }
    ]);

    // That URI carries no host, so it only reaches the right object store if the
    // spawned Encore instance is configured with the stack's own endpoint. This
    // is the value instance-pool.ts:369 copies into the create body as
    // `s3Endpoint`, and the exact read that silently returned undefined pre-#804.
    const s3 = await resolveEncoreS3Config(s3ConfigDeps(store), STACK_NAME);
    expect(s3).toEqual({
      endpoint: MINIO_ENDPOINT,
      accessKeyId: 'admin',
      secretAccessKey: MINIO_ROOT_PASSWORD
    });
  });

  it('MIGRATION path: a stack that exists ONLY under a stale namespace resolves, is rewritten under the constant, and then transcodes against the right endpoint', async () => {
    const { store, scanner, keys } = makeStore();

    // A PRE-#804 deployment: the provision route of that build wrote under its
    // derived namespace. Nothing exists under `default`.
    await persistStackConfig({
      paramStore: store,
      workspaceId: STALE_NAMESPACE,
      name: STACK_NAME,
      config: provisionedConfig()
    });
    expect(keys()).toEqual([stackConfigKey(STALE_NAMESPACE, STACK_NAME)]);
    expect(await store.loadStackConfig(STACK_CONFIG_NAMESPACE, STACK_NAME)).toBeUndefined();

    // Before the migration runs, the raw constant-namespace read that Encore's
    // endpoint resolution depends on finds nothing — and now FAILS LOUD instead
    // of silently returning undefined and letting Encore default elsewhere.
    await expect(
      resolveEncoreS3Config(s3ConfigDeps(store), STACK_NAME)
    ).rejects.toThrow(/no object-store endpoint resolvable/);

    const resolver = new WorkspaceStackResolver({
      paramStore: store,
      oscContext,
      minioPassword: MINIO_ROOT_PASSWORD,
      couchPassword: 'couch-password',
      staleNamespaceScanner: scanner
    });

    // One-shot migration: the stack is found, adopted, and rewritten.
    const connections = await resolver.resolve(STACK_NAME);
    expect(connections.sourceBucket).toBe(SOURCE_BUCKET);
    expect(connections.s3Config?.endpoint).toBe(MINIO_ENDPOINT);
    expect(keys()).toContain(stackConfigKey(STACK_CONFIG_NAMESPACE, STACK_NAME));

    // And now the plain constant-namespace read resolves it too — no scan, no
    // migration, just a direct hit.
    const s3 = await resolveEncoreS3Config(s3ConfigDeps(store), STACK_NAME);
    expect(s3).toEqual({
      endpoint: MINIO_ENDPOINT,
      accessKeyId: 'admin',
      secretAccessKey: MINIO_ROOT_PASSWORD
    });

    const payload = toEncorePayload({
      externalId: 'job-1',
      inputUri: `s3://${connections.sourceBucket}/${SOURCE_OBJECT_KEY}`,
      outputUri: `s3://${connections.packagedBucket}/packaged/asset-1/job-1`,
      profile: 'abr-vod'
    });
    expect(payload['inputs']).toEqual([
      { uri: `s3://${SOURCE_BUCKET}/${SOURCE_OBJECT_KEY}`, type: 'AudioVideo' }
    ]);
  });
});

describe('Encore object-store resolution fails loud (#804)', () => {
  it('throws when no stack is provisioned at all and no static endpoint is configured', async () => {
    const { store } = makeStore();
    await expect(
      resolveEncoreS3Config(s3ConfigDeps(store), STACK_NAME)
    ).rejects.toThrow(/Refusing to spawn a transcoder/);
  });

  it('throws when the stored config carries no object-store endpoint', async () => {
    const { store } = makeStore();
    await persistStackConfig({
      paramStore: store,
      workspaceId: STACK_CONFIG_NAMESPACE,
      name: STACK_NAME,
      config: { ...provisionedConfig(), minioEndpoint: '' }
    });
    await expect(
      resolveEncoreS3Config(s3ConfigDeps(store), STACK_NAME)
    ).rejects.toThrow(/no object-store endpoint resolvable/);
  });

  it('throws when the parameter-store read fails', async () => {
    const { store } = makeStore();
    const failing: ParamStore = {
      ...store,
      async loadStackConfig() {
        throw new Error('config service unreachable');
      }
    };
    await expect(
      resolveEncoreS3Config(s3ConfigDeps(failing), STACK_NAME)
    ).rejects.toThrow(/config service unreachable/);
  });

  it('throws when no object-store secret is configured anywhere', async () => {
    const { store } = makeStore();
    await persistStackConfig({
      paramStore: store,
      workspaceId: STACK_CONFIG_NAMESPACE,
      name: STACK_NAME,
      config: provisionedConfig()
    });
    await expect(
      resolveEncoreS3Config(
        { ...s3ConfigDeps(store), secretAccessKey: undefined },
        STACK_NAME
      )
    ).rejects.toThrow(/cannot resolve object-store credentials/);
  });

  it('defers to a configured static endpoint instead of throwing (local-dev override)', async () => {
    const { store } = makeStore();
    await expect(
      resolveEncoreS3Config(
        { ...s3ConfigDeps(store), staticFallbackConfigured: true },
        STACK_NAME
      )
    ).resolves.toBeUndefined();
  });

  it('falls back to the first provisioned stack when the requested key is not itself a stack name', async () => {
    const { store } = makeStore();
    await persistStackConfig({
      paramStore: store,
      workspaceId: STACK_CONFIG_NAMESPACE,
      name: STACK_NAME,
      config: provisionedConfig()
    });
    // `default` here is the fixed DEPLOYMENT_CONTEXT of a single-stack
    // deployment, which is not itself a stack name.
    const s3 = await resolveEncoreS3Config(s3ConfigDeps(store), 'default');
    expect(s3?.endpoint).toBe(MINIO_ENDPOINT);
  });
});
