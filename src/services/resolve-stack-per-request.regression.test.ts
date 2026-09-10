import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { WorkspaceStackResolver } from './workspace-stack.js';
import {
  STACK_CONFIG_NAMESPACE
} from './workspace-stack.js';
import type { ParamStore, StackConfig } from './param-store.js';
import type { Context } from '@osaas/client-core';

// Regression coverage for issue #615: the transcode path must resolve the
// TARGET stack's connection coordinates keyed by the stack the request names,
// NOT by whichever stack was provisioned first in the process.
//
// WorkspaceStackResolver.resolveStackName is the single source of truth for the
// EFFECTIVE stack identity a request routes to. The scaler auto-scaler partitions
// its Encore pool / Valkey queue keys / MinIO endpoint resolution by exactly this
// identity (main.ts wires resolveStackContext -> resolveStackName -> the
// encodeEncoreJobId contextId), so proving resolveStackName never collapses a
// named healthy stack onto the first-provisioned one proves the request uses the
// named stack regardless of provisioning order.

const fakeContext = {} as unknown as Context;

// Env vars the resolver reads for the env-override path. Cleared so this suite
// always exercises the parameter-store path (mirrors resolver-health.test.ts).
const SAVED = {
  couch: process.env['COUCHDB_URL'],
  minio: process.env['MINIO_URL']
};

beforeEach(() => {
  delete process.env['COUCHDB_URL'];
  delete process.env['MINIO_URL'];
});

afterEach(() => {
  if (SAVED.couch === undefined) delete process.env['COUCHDB_URL'];
  else process.env['COUCHDB_URL'] = SAVED.couch;
  if (SAVED.minio === undefined) delete process.env['MINIO_URL'];
  else process.env['MINIO_URL'] = SAVED.minio;
});

// A ready stack config with distinct per-stack coordinates. The MinIO endpoint
// and Valkey URL differ per stack so a mis-resolution is observable.
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

// In-memory ParamStore over a Map, preserving INSERTION order for listStackNames
// so a test can control which stack is "first provisioned". This mirrors the
// app-config-svc contract: listStackNames returns the names under the workspace
// prefix in stored order (services/param-store.ts makeHttpParamStore).
function makeOrderedParamStore(order: string[]): {
  store: ParamStore;
  configs: Map<string, StackConfig>;
} {
  const configs = new Map<string, StackConfig>();
  for (const name of order) configs.set(name, readyConfig(name));
  const store: ParamStore = {
    async storeStackConfig(_ws, name, config) {
      configs.set(name, config);
    },
    async loadStackConfig(_ws, name) {
      return configs.get(name);
    },
    async deleteStackConfig(_ws, name) {
      configs.delete(name);
    },
    async listStackNames() {
      return [...configs.keys()];
    }
  };
  return { store, configs };
}

function makeResolver(store: ParamStore): WorkspaceStackResolver {
  return new WorkspaceStackResolver({
    paramStore: store,
    oscContext: fakeContext,
    minioPassword: 'pw',
    couchPassword: 'pw'
  });
}

describe('resolveStackName routes to the NAMED stack regardless of provision order (issue #615)', () => {
  it('returns the requested healthy stack when it was provisioned FIRST', async () => {
    // healthy provisioned first, unhealthy second.
    const { store } = makeOrderedParamStore(['healthy', 'unhealthy']);
    const resolver = makeResolver(store);
    expect(await resolver.resolveStackName('healthy')).toBe('healthy');
  });

  it('returns the requested healthy stack when it was provisioned SECOND', async () => {
    // unhealthy provisioned first, healthy second — the pre-#615 "first stack
    // wins" bug would collapse this onto 'unhealthy'.
    const { store } = makeOrderedParamStore(['unhealthy', 'healthy']);
    const resolver = makeResolver(store);
    expect(await resolver.resolveStackName('healthy')).toBe('healthy');
  });

  it('never rewrites a named stack that has a stored config to the first-listed one', async () => {
    const { store } = makeOrderedParamStore(['first', 'second', 'third']);
    const resolver = makeResolver(store);
    // Each named stack resolves to ITSELF, not to 'first'.
    expect(await resolver.resolveStackName('second')).toBe('second');
    expect(await resolver.resolveStackName('third')).toBe('third');
    expect(await resolver.resolveStackName('first')).toBe('first');
  });

  it('falls back to the first provisioned stack for the workspace default (no name)', async () => {
    const { store } = makeOrderedParamStore(['alpha', 'beta']);
    const resolver = makeResolver(store);
    expect(await resolver.resolveStackName(undefined)).toBe('alpha');
  });

  it('falls back to the first provisioned stack when the requested name has no config', async () => {
    // A stale UI selection for a stack that was never provisioned must not break
    // routing — mirrors resolve()'s fallback semantics.
    const { store } = makeOrderedParamStore(['alpha', 'beta']);
    const resolver = makeResolver(store);
    expect(await resolver.resolveStackName('does-not-exist')).toBe('alpha');
  });

  it('returns undefined when no stack is provisioned (caller uses the fixed context)', async () => {
    const { store } = makeOrderedParamStore([]);
    const resolver = makeResolver(store);
    expect(await resolver.resolveStackName('anything')).toBeUndefined();
    expect(await resolver.resolveStackName(undefined)).toBeUndefined();
  });

  it('returns undefined when no parameter store is configured', async () => {
    const resolver = new WorkspaceStackResolver({
      paramStore: undefined,
      oscContext: fakeContext,
      minioPassword: '',
      couchPassword: ''
    });
    expect(await resolver.resolveStackName('healthy')).toBeUndefined();
  });

  it('reads the requested name under the shared STACK_CONFIG_NAMESPACE', async () => {
    // The resolver keys reads by (namespace, name); assert it uses the exported
    // namespace constant so the read key matches the provision write key.
    const seen: Array<{ ws: string; name: string }> = [];
    const store: ParamStore = {
      async storeStackConfig() {},
      async loadStackConfig(ws, name) {
        seen.push({ ws, name });
        return name === 'healthy' ? readyConfig('healthy') : undefined;
      },
      async deleteStackConfig() {},
      async listStackNames() {
        return ['healthy'];
      }
    };
    const resolver = makeResolver(store);
    await resolver.resolveStackName('healthy');
    expect(seen[0]).toEqual({ ws: STACK_CONFIG_NAMESPACE, name: 'healthy' });
  });
});
