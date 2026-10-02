// Issue #1093 — the object-store credential carries its own stack identity, the
// identity is logged every time a client is constructed, and the secret never
// is.
//
// Three layers are covered here:
//   1. the pure assertion/logging helpers (object-store-stack-identity.ts);
//   2. the API's per-stack client (WorkspaceStackResolver.resolve ->
//      buildConnectionsFromStack, services/workspace-stack.ts);
//   3. the transcoder's object-store config (resolveEncoreS3Config,
//      services/encore-s3-config.ts).
//
// The submit-time refusal itself (a deliberately mis-routed read failing with a
// stack-mismatch error rather than a missing-object error) is covered end to end
// through the HTTP routes in test/stack-routing-data-plane.test.ts.
//
// Contract sources verified (CLAUDE.md rule 7):
//   - WorkspaceConnections.s3Config:
//       { endpoint, accessKey, secretKey, stackName } | undefined
//     and WorkspaceConnections.stackName (src/services/workspace-stack.ts).
//   - WorkspaceStackResolver constructor opts
//       { paramStore, oscContext, minioPassword, couchPassword, optionalSteps?,
//         resolverHealth?, staleNamespaceScanner?, log? }
//     (src/services/workspace-stack.ts).
//   - ParamStore.{storeStackConfig,loadStackConfig,deleteStackConfig,
//     listStackNames} and StackConfig (src/services/param-store.ts).
//   - resolveEncoreS3Config(deps, stackKey): Promise<EncoreS3Config | undefined>
//     with deps { paramStore, secretAccessKey, staticFallbackConfigured, log,
//     resolveEndpoint? } (src/services/encore-s3-config.ts).
//   - EncoreS3Config = { endpoint, accessKeyId, secretAccessKey, region? }
//     (src/encore-scaler/types.ts).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  objectStoreEndpointHost,
  objectStoreClientLogFields,
  objectStoreStackMismatch,
  objectStoreStackMismatchMessage,
  logObjectStoreClient,
  OBJECT_STORE_CLIENT_EVENT
} from './object-store-stack-identity.js';
import { WorkspaceStackResolver, STACK_CONFIG_NAMESPACE } from './workspace-stack.js';
import { resolveEncoreS3Config } from './encore-s3-config.js';
import type { ParamStore, StackConfig } from './param-store.js';
import type { Context } from '@osaas/client-core';

const fakeContext = {} as unknown as Context;

// The one string that must never reach a log line.
const SECRET = 'objectstore-secret-must-never-be-logged';

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

// In-memory ParamStore preserving insertion order for listStackNames, matching
// the app-config-svc contract the HTTP client implements.
function makeParamStore(names: string[]): ParamStore {
  const configs = new Map<string, StackConfig>();
  for (const n of names) configs.set(n, readyConfig(n));
  return {
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
}

// Recording logger. `lines` is the SERIALISED output, so a secret smuggled
// through a nested object would still be caught by the substring assertions.
function makeLogger(): {
  log: { info: (o: unknown, m?: string) => void; warn: (o: unknown, m?: string) => void; error: (o: unknown, m?: string) => void };
  entries: Array<{ level: string; obj: unknown; msg?: string }>;
  lines: () => string;
} {
  const entries: Array<{ level: string; obj: unknown; msg?: string }> = [];
  return {
    log: {
      info: (obj, msg) => entries.push({ level: 'info', obj, msg }),
      warn: (obj, msg) => entries.push({ level: 'warn', obj, msg }),
      error: (obj, msg) => entries.push({ level: 'error', obj, msg })
    },
    entries,
    lines: () => JSON.stringify(entries)
  };
}

// The resolver reads these for its env-override path; cleared so the suite
// exercises the parameter-store path (mirrors resolver-health.test.ts).
const SAVED = { couch: process.env['COUCHDB_URL'], minio: process.env['MINIO_URL'] };

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

describe('objectStoreStackMismatch (issue #1093)', () => {
  it('reports the expected (routed) and actual (credential) stack ids', () => {
    const mismatch = objectStoreStackMismatch(
      { stackName: 'a', endpoint: 'https://a-minio.example.test/ignored?x=1' },
      'b'
    );
    expect(mismatch).toEqual({
      expectedStack: 'b',
      actualStack: 'a',
      actualEndpointHost: 'a-minio.example.test'
    });
    const message = objectStoreStackMismatchMessage(mismatch!);
    expect(message).toContain('belong to stack "a"');
    expect(message).toContain('routes to stack "b"');
  });

  it('allows a credential resolved for the routed stack', () => {
    expect(
      objectStoreStackMismatch({ stackName: 'b', endpoint: 'https://b.example' }, 'b')
    ).toBeUndefined();
  });

  it('allows the paths that have no stack identity to compare', () => {
    // Env-override / in-memory connections: credential present, no stack record.
    expect(
      objectStoreStackMismatch({ stackName: undefined, endpoint: 'https://x' }, 'b')
    ).toBeUndefined();
    // No routed stack: no resolver wired, or no stack provisioned at all.
    expect(objectStoreStackMismatch({ stackName: 'a' }, undefined)).toBeUndefined();
    // No object storage at all.
    expect(objectStoreStackMismatch(undefined, 'b')).toBeUndefined();
  });

  it('compares identity, not endpoint host — the same stack may answer on two hosts', () => {
    // Issue #991: the transcoder uses the in-cluster address while the API uses
    // the public ingress for the SAME instance.
    expect(
      objectStoreStackMismatch(
        { stackName: 'b', endpoint: 'http://minio.svc.cluster.local:9000' },
        'b'
      )
    ).toBeUndefined();
  });
});

describe('object-store client construction log (issue #1093)', () => {
  it('logs the stack id and endpoint host only, never the secret', () => {
    const fields = objectStoreClientLogFields({
      source: 'stack-resolver',
      stackName: 'b',
      // Deliberately passed the WHOLE credential shape's endpoint plus a
      // userinfo component: neither the secret nor the userinfo may survive.
      endpoint: `https://admin:${SECRET}@b-minio.example.test:443/bucket`
    });
    expect(fields).toEqual({
      event: OBJECT_STORE_CLIENT_EVENT,
      source: 'stack-resolver',
      stackName: 'b',
      endpointHost: 'b-minio.example.test'
    });
    expect(JSON.stringify(fields)).not.toContain(SECRET);
  });

  it('records the requested stack when the config came from a different one', () => {
    const fields = objectStoreClientLogFields({
      source: 'transcoder-config',
      stackName: 'primary',
      requestedStackName: 'default',
      endpoint: 'https://primary-minio.example.test'
    });
    expect(fields.requestedStackName).toBe('default');
    // ...and omits it when it agrees, so the common line stays quiet.
    expect(
      objectStoreClientLogFields({
        source: 'transcoder-config',
        stackName: 'primary',
        requestedStackName: 'primary',
        endpoint: 'https://primary-minio.example.test'
      }).requestedStackName
    ).toBeUndefined();
  });

  it('no-ops on an error-only logger instead of throwing', () => {
    expect(() =>
      logObjectStoreClient({ error: () => {} } as never, {
        source: 'stack-resolver',
        stackName: 'b'
      })
    ).not.toThrow();
  });

  it('reports no host for an absent or unparseable endpoint', () => {
    expect(objectStoreEndpointHost(undefined)).toBeUndefined();
    expect(objectStoreEndpointHost('')).toBeUndefined();
    expect(objectStoreEndpointHost('not a url')).toBeUndefined();
  });
});

describe("the API's per-stack object-store client (issue #1093)", () => {
  it('tags the resolved credential with the stack it was built for', async () => {
    const resolver = new WorkspaceStackResolver({
      paramStore: makeParamStore(['primary', 'secondary']),
      oscContext: fakeContext,
      minioPassword: SECRET,
      couchPassword: SECRET
    });

    const secondary = await resolver.resolve('secondary');
    expect(secondary.stackName).toBe('secondary');
    expect(secondary.s3Config?.stackName).toBe('secondary');
    expect(secondary.s3Config?.endpoint).toBe('https://secondary-minio.example.test');
    // The tag travels WITH the credential, so the submit-time assertion passes
    // for a correctly routed request and fails for the other stack's identity.
    expect(objectStoreStackMismatch(secondary.s3Config, 'secondary')).toBeUndefined();
    expect(objectStoreStackMismatch(secondary.s3Config, 'primary')).toEqual({
      expectedStack: 'primary',
      actualStack: 'secondary',
      actualEndpointHost: 'secondary-minio.example.test'
    });
  });

  it('logs the stack identity on construction and never the secret', async () => {
    const logger = makeLogger();
    const resolver = new WorkspaceStackResolver({
      paramStore: makeParamStore(['primary']),
      oscContext: fakeContext,
      minioPassword: SECRET,
      couchPassword: SECRET,
      log: logger.log
    });

    await resolver.resolve('primary');

    const constructed = logger.entries.filter(
      (e) => (e.obj as { event?: string }).event === OBJECT_STORE_CLIENT_EVENT
    );
    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.obj).toEqual({
      event: OBJECT_STORE_CLIENT_EVENT,
      source: 'stack-resolver',
      stackName: 'primary',
      endpointHost: 'primary-minio.example.test'
    });
    // Across EVERY line the resolver emitted — not just the one above.
    expect(logger.lines()).not.toContain(SECRET);
  });

  it('logs the env-override client with no stack identity, and no secret', async () => {
    process.env['MINIO_URL'] = 'https://local-minio.example.test:9000';
    process.env['MINIO_SECRET_KEY'] = SECRET;
    try {
      const logger = makeLogger();
      const resolver = new WorkspaceStackResolver({
        paramStore: makeParamStore(['primary']),
        oscContext: fakeContext,
        minioPassword: SECRET,
        couchPassword: SECRET,
        log: logger.log
      });

      const conns = await resolver.resolve('primary');
      // Not a stack record: no identity on either the connections or the
      // credential, so the submit-time assertion has nothing to compare and the
      // env-override path behaves exactly as before.
      expect(conns.stackName).toBeUndefined();
      expect(conns.s3Config?.stackName).toBeUndefined();
      expect(objectStoreStackMismatch(conns.s3Config, 'primary')).toBeUndefined();

      const constructed = logger.entries.filter(
        (e) => (e.obj as { event?: string }).event === OBJECT_STORE_CLIENT_EVENT
      );
      expect(constructed).toHaveLength(1);
      expect(constructed[0]!.obj).toEqual({
        event: OBJECT_STORE_CLIENT_EVENT,
        source: 'env-override',
        stackName: undefined,
        endpointHost: 'local-minio.example.test:9000'
      });
      expect(logger.lines()).not.toContain(SECRET);
    } finally {
      delete process.env['MINIO_SECRET_KEY'];
    }
  });
});

describe("the transcoder's object-store config (issue #1093)", () => {
  function deps(paramStore: ParamStore, log: { error: (o: unknown, m?: string) => void; info?: (o: unknown, m?: string) => void }) {
    return {
      paramStore,
      secretAccessKey: SECRET,
      staticFallbackConfigured: false,
      log
    };
  }

  it('logs the stack identity it resolved, and no secret', async () => {
    const logger = makeLogger();
    const s3 = await resolveEncoreS3Config(deps(makeParamStore(['primary']), logger.log), 'primary');

    expect(s3?.endpoint).toBe('https://primary-minio.example.test');
    expect(s3?.secretAccessKey).toBe(SECRET);

    const constructed = logger.entries.filter(
      (e) => (e.obj as { event?: string }).event === OBJECT_STORE_CLIENT_EVENT
    );
    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.obj).toEqual({
      event: OBJECT_STORE_CLIENT_EVENT,
      source: 'transcoder-config',
      stackName: 'primary',
      endpointHost: 'primary-minio.example.test'
    });
    expect(logger.lines()).not.toContain(SECRET);
  });

  it('names BOTH stacks when the requested key fell back to the first provisioned stack', async () => {
    const logger = makeLogger();
    // `default` is the fixed deployment context of a single-stack deployment —
    // not a stack name — so the documented fallback applies. Pre-#1093 that was
    // invisible; now the line says which stack the transcoder actually got.
    const s3 = await resolveEncoreS3Config(
      deps(makeParamStore(['primary', 'secondary']), logger.log),
      'default'
    );
    expect(s3?.endpoint).toBe('https://primary-minio.example.test');

    const constructed = logger.entries.filter(
      (e) => (e.obj as { event?: string }).event === OBJECT_STORE_CLIENT_EVENT
    );
    expect(constructed).toHaveLength(1);
    expect(constructed[0]!.obj).toEqual({
      event: OBJECT_STORE_CLIENT_EVENT,
      source: 'transcoder-config',
      stackName: 'primary',
      requestedStackName: 'default',
      endpointHost: 'primary-minio.example.test'
    });
    expect(logger.lines()).not.toContain(SECRET);
  });

  it('logs the endpoint the transcoder will actually use when the in-cluster hook maps it', async () => {
    const logger = makeLogger();
    const s3 = await resolveEncoreS3Config(
      {
        ...deps(makeParamStore(['primary']), logger.log),
        resolveEndpoint: async () => 'http://minio.svc.cluster.local:9000'
      },
      'primary'
    );
    expect(s3?.endpoint).toBe('http://minio.svc.cluster.local:9000');
    expect(
      (logger.entries.find(
        (e) => (e.obj as { event?: string }).event === OBJECT_STORE_CLIENT_EVENT
      )!.obj as { endpointHost: string }).endpointHost
    ).toBe('minio.svc.cluster.local:9000');
    // Still the SAME stack identity: the mapped host is not a different stack
    // (issue #991), which is exactly why the assertion compares ids.
    expect(
      (logger.entries.find(
        (e) => (e.obj as { event?: string }).event === OBJECT_STORE_CLIENT_EVENT
      )!.obj as { stackName: string }).stackName
    ).toBe('primary');
    expect(logger.lines()).not.toContain(SECRET);
  });

  it('logs nothing on the failure paths that construct no client', async () => {
    const logger = makeLogger();
    await expect(
      resolveEncoreS3Config(
        { paramStore: undefined, secretAccessKey: SECRET, staticFallbackConfigured: false, log: logger.log },
        'primary'
      )
    ).rejects.toThrow(/parameter store is not configured/);
    expect(
      logger.entries.filter((e) => (e.obj as { event?: string }).event === OBJECT_STORE_CLIENT_EVENT)
    ).toHaveLength(0);
    expect(logger.lines()).not.toContain(SECRET);
  });
});
