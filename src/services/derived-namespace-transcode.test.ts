import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Acceptance coverage for issue #804: a stack provisioned under a NON-`default`
// namespace must transcode end to end, with NO `default`-namespaced config
// present anywhere in the store and no manual parameter-store intervention.
//
// Two defects combined to break this on a fresh stack:
//   1. deriveWorkspaceId picked a tenant id out of `listSubscriptions`, which
//      describes the services the deployment is subscribed TO (published by OTHER
//      tenants) and never identified the caller. PR #777 then PERSISTED that
//      guess to `openvideocore/_meta/workspace-id`, freezing a namespace the
//      deployment does not own.
//   2. Eight parameter-store reads in src/main.ts still addressed the LITERAL
//      `default` namespace. The one that broke transcoding is resolveS3Config:
//      with nothing found it returned undefined, the registry fell back to the
//      static s3Config built from the (unset on OSC) ENCORE_S3_ENDPOINT, and
//      spawnInstance therefore omitted the whole s3 block — so Encore resolved
//      `s3://` inputs against AWS and the job died with
//      `ffprobe failed ... Server returned 404 Not Found`.
//
// Contracts verified for these tests (CLAUDE.md rule 7):
//   - Context.getPersonalAccessToken(): string | undefined
//     — @osaas/client-core lib/context.d.ts:23.
//   - PAT payload shape { iss, iat, exp, patId, userId, tenantId } on a
//     three-segment HS256 JWT — read-only introspection of this deployment's live
//     OSC_ACCESS_TOKEN, 2026-09-24. The SDK sends that same token as
//     `x-pat-jwt: Bearer <pat>` on every catalog call (lib/admin.js), so its
//     tenantId IS the tenant OSC attributes this deployment's writes to.
//   - Subscription = { serviceId: string; tenantId: string };
//     listSubscriptions(context: Context): Promise<Subscription[]>
//     — @osaas/client-core lib/admin.d.ts:2-5,42.
//   - ParamStore.storeStackConfig / loadStackConfig / listStackNames
//     — src/services/param-store.ts:108-125.
//   - stackConfigKey(workspaceId, name) = `openvideocore/<ws>/<name>`
//     — src/services/param-store.ts:131-133.
//   - StackConfig.minioEndpoint: string — src/services/param-store.ts:52-95.
//   - spawnInstance maps s3Config.endpoint onto the Encore instance's
//     `s3Endpoint` config key — src/encore-scaler/instance-pool.ts:164-169.
//   - The registry prefers resolveS3Config(stackKey) over the static s3Config and
//     carries the result into EncoreScalerConfig.s3Config
//     — src/encore-scaler/workspace-registry.ts (getOrCreate: resolveS3Config ??
//     s3Config, then `s3Config,` into EncoreScalerConfig).
//   - createResolveS3Config(deps): (stackKey: string) =>
//     Promise<EncoreS3Config | undefined> — src/services/scaler-s3-config.ts.
//     This is the SHIPPED policy main.ts wires as the registry's resolveS3Config;
//     the tests below execute it directly rather than a copy, so main.ts cannot
//     silently drift away from the behaviour asserted here.

// SYNTHETIC fixture values throughout, matching the convention in the sibling
// suites (workspace-namespace-stability.test.ts:452-458,
// provision.workspace-pin.test.ts:95, scaler-redis-url.test.ts:41): no assertion
// below depends on a real tenant or stack name, and the observed live values stay
// in issue #804 rather than in this public repo.
//
// The tenant this deployment's own credential names.
const CREDENTIAL_TENANT = 'workspace-tenant-a';
// Publisher tenants of the services this deployment is subscribed TO, as the live
// payload carries them. The LEXICOGRAPHICALLY SMALLEST is what the pre-#804
// derivation returned (readTenantIdFromOsc: `.sort()` then `[0]`,
// workspace-stack.ts:543-548) — i.e. a tenant that merely publishes a service this
// deployment consumes, not the deployment's own. Ordered so that the credential
// tenant is NOT the smallest, which is the condition the issue reproduces.
const PUBLISHER_TENANTS = ['publisher-one', 'publisher-two'];

// A well-formed PAT carrying the verified claim set. The signature is never
// checked (readTenantIdFromCredential decodes only; it makes no trust decision),
// so a placeholder third segment is faithful to what the code reads.
function makePat(tenantId: string): string {
  const seg = (o: unknown) =>
    Buffer.from(JSON.stringify(o), 'utf8').toString('base64url');
  return [
    seg({ alg: 'HS256', typ: 'JWT' }),
    seg({
      iss: 'token.osaas.eyevinn.se',
      iat: 1_700_000_000,
      exp: 1_900_000_000,
      patId: '00000000-0000-0000-0000-000000000000',
      userId: 'user-000000000000000000',
      tenantId
    }),
    'signature-not-verified-here'
  ].join('.');
}

// Every OSC instance the mocked SDK was asked to create, so the test can assert
// the exact `s3Endpoint` Encore is configured with.
const createdInstances: Array<{
  serviceId: string;
  body: Record<string, string>;
}> = [];

vi.mock('@osaas/client-core', () => ({
  // Live-shaped payload: most entries carry no tenantId at all, and those that
  // do name the PUBLISHER of the subscribed service, not the caller.
  listSubscriptions: vi.fn(async () => [
    { serviceId: 'minio-minio' },
    { serviceId: 'apache-couchdb' },
    { serviceId: 'valkey-io-valkey' },
    { serviceId: 'eyevinn-encore', tenantId: PUBLISHER_TENANTS[1] },
    { serviceId: 'eyevinn-app-config-svc', tenantId: PUBLISHER_TENANTS[1] },
    { serviceId: 'eyevinn-scenechange', tenantId: PUBLISHER_TENANTS[0] }
  ]),
  createInstance: vi.fn(
    async (
      _ctx: unknown,
      serviceId: string,
      _sat: string,
      body: Record<string, string>
    ) => {
      createdInstances.push({ serviceId, body });
      return { name: body['name'], url: `https://${body['name']}.example.test` };
    }
  ),
  waitForInstanceReady: vi.fn(async () => {}),
  removeInstance: vi.fn(async () => {}),
  listInstances: vi.fn(async () => []),
  Context: class {}
}));

import {
  WorkspaceStackResolver,
  resolveWorkspaceId,
  deriveWorkspaceId,
  readTenantIdFromCredential,
  STACK_CONFIG_NAMESPACE,
  WORKSPACE_ID_ENV_VAR,
  WORKSPACE_ID_PIN_KEY,
  type StackResolverLogger,
  type WorkspaceIdStore
} from './workspace-stack.js';
import {
  stackConfigKey,
  type ParamStore,
  type StackConfig
} from './param-store.js';
import { createResolveS3Config } from './scaler-s3-config.js';
import { persistStackConfig } from '../routes/provision.js';
import { spawnInstance } from '../encore-scaler/instance-pool.js';
import type { EncoreScalerConfig } from '../encore-scaler/types.js';
import type { Context } from '@osaas/client-core';
import type { Redis } from 'ioredis';

// The deployment's own authenticated Context: a PAT naming CREDENTIAL_TENANT,
// plus the service-access-token accessor the scaler uses.
const oscContext = {
  getPersonalAccessToken: () => makePat(CREDENTIAL_TENANT),
  getServiceAccessToken: async () => 'service-access-token'
} as unknown as Context;

const SAVED = {
  couch: process.env['COUCHDB_URL'],
  minio: process.env['MINIO_URL'],
  workspaceId: process.env[WORKSPACE_ID_ENV_VAR]
};

beforeEach(() => {
  // Force the parameter-store path, not the env-var override
  // (buildEnvConnections, workspace-stack.ts).
  delete process.env['COUCHDB_URL'];
  delete process.env['MINIO_URL'];
  delete process.env[WORKSPACE_ID_ENV_VAR];
  createdInstances.length = 0;
});

afterEach(() => {
  for (const [key, value] of [
    ['COUCHDB_URL', SAVED.couch],
    ['MINIO_URL', SAVED.minio],
    [WORKSPACE_ID_ENV_VAR, SAVED.workspaceId]
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

// Deliberately NOT the host readyConfig() derives, so an assertion on this value
// proves the endpoint came from the stored config rather than from any default.
const MINIO_ENDPOINT = 'https://stack-minio.example.test';

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

// One fake config-service instance serving BOTH the ParamStore view (stack
// configs at `openvideocore/<ns>/<name>`) and the WorkspaceIdStore view
// (get/set/listByPrefix) — exactly how main.ts wires the real deployment.
function makeConfigService(): {
  paramStore: ParamStore;
  pinStore: WorkspaceIdStore;
  namespacesRead: string[];
  raw: Map<string, string>;
} {
  const kv = new Map<string, string>();
  const namespacesRead: string[] = [];
  const paramStore: ParamStore = {
    async storeStackConfig(ws, name, config) {
      kv.set(stackConfigKey(ws, name), JSON.stringify(config));
    },
    async loadStackConfig(ws, name) {
      namespacesRead.push(ws);
      const raw = kv.get(stackConfigKey(ws, name));
      return raw ? (JSON.parse(raw) as StackConfig) : undefined;
    },
    async deleteStackConfig(ws, name) {
      kv.delete(stackConfigKey(ws, name));
    },
    async listStackNames(ws) {
      namespacesRead.push(ws);
      const prefix = stackConfigKey(ws, '');
      return [...kv.keys()]
        .filter((k) => k.startsWith(prefix))
        .map((k) => k.slice(prefix.length));
    }
  };
  const pinStore: WorkspaceIdStore = {
    async get(key) {
      return kv.get(key);
    },
    async set(key, value) {
      kv.set(key, value);
    },
    async listByPrefix(prefix) {
      return [...kv.entries()]
        .filter(([k]) => k.startsWith(prefix))
        .map(([key, value]) => ({ key, value }));
    }
  };
  return { paramStore, pinStore, namespacesRead, raw: kv };
}

function makeLog(): StackResolverLogger {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// Minimal Fastify-shaped logger for the resolveS3Config policy under test.
function makeAppLog() {
  return { warn: vi.fn(), error: vi.fn(), info: vi.fn() };
}

describe('derived namespace is the deployment credential tenant (issue #804)', () => {
  it('reads the tenant off the deployment\'s own PAT rather than a subscription publisher', () => {
    expect(readTenantIdFromCredential(oscContext)).toBe(CREDENTIAL_TENANT);
  });

  it('derives the credential tenant, not the lexicographically smallest publisher', async () => {
    const derived = await deriveWorkspaceId(oscContext);
    expect(derived).toBe(CREDENTIAL_TENANT);
    // The exact pre-#804 answer, reproduced live against a real account: the
    // smallest publisher tenant. It must no longer win.
    expect(derived).not.toBe(PUBLISHER_TENANTS[0]);
    expect(derived).not.toBe(STACK_CONFIG_NAMESPACE);
  });

  it('pins the credential tenant on a fresh deployment', async () => {
    const { pinStore } = makeConfigService();
    const resolution = await resolveWorkspaceId(oscContext, { store: pinStore });
    expect(resolution.workspaceId).toBe(CREDENTIAL_TENANT);
    expect(resolution.source).toBe('credential');
    expect(resolution.deterministic).toBe(true);
    expect(await pinStore.get(WORKSPACE_ID_PIN_KEY)).toBe(CREDENTIAL_TENANT);
  });

  it('corrects a #777-frozen pin that disagrees with the credential when nothing is stranded', async () => {
    const { pinStore, raw } = makeConfigService();
    // A stack whose pin was frozen by #777 to a publisher tenant, with no stack
    // config stored under it.
    raw.set(WORKSPACE_ID_PIN_KEY, PUBLISHER_TENANTS[0]!);

    const log = makeLog();
    const resolution = await resolveWorkspaceId(oscContext, {
      store: pinStore,
      log
    });
    expect(resolution.workspaceId).toBe(CREDENTIAL_TENANT);
    expect(resolution.source).toBe('credential');
    expect(await pinStore.get(WORKSPACE_ID_PIN_KEY)).toBe(CREDENTIAL_TENANT);
    expect(log.warn).toHaveBeenCalled();
  });

  it('keeps a mismatched pin that real stack configs live under, and reports it', async () => {
    const { paramStore, pinStore, raw } = makeConfigService();
    // The reported live state: the pin AND the stack config both sit under a
    // namespace the deployment does not own. Re-pointing would strand the stack,
    // so the namespace is kept and the operator is told how to move it.
    raw.set(WORKSPACE_ID_PIN_KEY, PUBLISHER_TENANTS[0]!);
    await paramStore.storeStackConfig(
      PUBLISHER_TENANTS[0]!,
      'mediastack',
      readyConfig('mediastack')
    );

    const log = makeLog();
    const resolution = await resolveWorkspaceId(oscContext, {
      store: pinStore,
      log
    });
    expect(resolution.workspaceId).toBe(PUBLISHER_TENANTS[0]);
    expect(resolution.source).toBe('pinned');
    expect(log.warn).toHaveBeenCalled();
    // The warning must describe a lever that WORKS: it names the env var, the
    // value to set, and the fact that the keys are copied (#804 review, finding 2 —
    // the previous message told the operator to set a var that moved nothing).
    const warning = (log.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .map((c) => String(c[1]))
      .join('\n');
    expect(warning).toContain(`${WORKSPACE_ID_ENV_VAR}=${CREDENTIAL_TENANT}`);
    expect(warning).toContain(stackConfigKey(PUBLISHER_TENANTS[0]!, '<stack>'));
    expect(warning).toContain(stackConfigKey(CREDENTIAL_TENANT, '<stack>'));

    // The documented correction lever wins outright over the pin.
    process.env[WORKSPACE_ID_ENV_VAR] = CREDENTIAL_TENANT;
    const overridden = await resolveWorkspaceId(oscContext, { store: pinStore });
    expect(overridden.workspaceId).toBe(CREDENTIAL_TENANT);
    expect(overridden.source).toBe('env');
  });

  // #804 review, finding 2: the correction lever must MOVE THE STACK, not just the
  // pointer. Before this, setting OVC_WORKSPACE_ID on the reported live state
  // (pin + config under a publisher namespace) re-pointed reads at a namespace
  // holding nothing — turning a working stack into an unresolvable one, now a hard
  // failure because resolveS3Config throws rather than silently defaulting.
  it('migrates the stack configs into the namespace OVC_WORKSPACE_ID names, and pins it', async () => {
    const { paramStore, pinStore, raw } = makeConfigService();
    raw.set(WORKSPACE_ID_PIN_KEY, PUBLISHER_TENANTS[0]!);
    const stranded = { ...readyConfig('mediastack'), minioEndpoint: MINIO_ENDPOINT };
    await paramStore.storeStackConfig(PUBLISHER_TENANTS[0]!, 'mediastack', stranded);
    await paramStore.storeStackConfig(
      PUBLISHER_TENANTS[0]!,
      'second',
      readyConfig('second')
    );

    process.env[WORKSPACE_ID_ENV_VAR] = CREDENTIAL_TENANT;
    const log = makeLog();
    const resolution = await resolveWorkspaceId(oscContext, { store: pinStore, log });
    expect(resolution.workspaceId).toBe(CREDENTIAL_TENANT);
    expect(resolution.source).toBe('env');

    // EVERY stack config is now readable under the namespace reads address, and
    // byte-identical to what was stored (no re-serialisation).
    expect(await paramStore.loadStackConfig(CREDENTIAL_TENANT, 'mediastack')).toEqual(
      stranded
    );
    expect(await paramStore.listStackNames(CREDENTIAL_TENANT)).toEqual(
      expect.arrayContaining(['mediastack', 'second'])
    );
    expect(raw.get(stackConfigKey(CREDENTIAL_TENANT, 'mediastack'))).toBe(
      raw.get(stackConfigKey(PUBLISHER_TENANTS[0]!, 'mediastack'))
    );
    // The originals are left in place: a copy, not a move.
    expect(raw.has(stackConfigKey(PUBLISHER_TENANTS[0]!, 'mediastack'))).toBe(true);
    // And the move is durable — the pin now names the new namespace, so removing
    // the env var does not send the deployment back to the namespace it left.
    expect(await pinStore.get(WORKSPACE_ID_PIN_KEY)).toBe(CREDENTIAL_TENANT);
    delete process.env[WORKSPACE_ID_ENV_VAR];
    const afterRestart = await resolveWorkspaceId(oscContext, { store: pinStore });
    expect(afterRestart.workspaceId).toBe(CREDENTIAL_TENANT);
    expect(afterRestart.source).toBe('pinned');
  });

  it('does not overwrite configs already under the configured namespace, and does not pin a bare override', async () => {
    const { paramStore, pinStore } = makeConfigService();
    const own = { ...readyConfig('mediastack'), minioEndpoint: MINIO_ENDPOINT };
    await paramStore.storeStackConfig(CREDENTIAL_TENANT, 'mediastack', own);
    // A stale copy under another namespace must NOT clobber the live one.
    await paramStore.storeStackConfig(
      PUBLISHER_TENANTS[0]!,
      'mediastack',
      readyConfig('stale')
    );

    process.env[WORKSPACE_ID_ENV_VAR] = CREDENTIAL_TENANT;
    const resolution = await resolveWorkspaceId(oscContext, { store: pinStore });
    expect(resolution.workspaceId).toBe(CREDENTIAL_TENANT);
    expect(await paramStore.loadStackConfig(CREDENTIAL_TENANT, 'mediastack')).toEqual(own);
    // Nothing was migrated, so the env override stays non-persisting exactly as it
    // was before the #804 review.
    expect(await pinStore.get(WORKSPACE_ID_PIN_KEY)).toBeUndefined();
  });

  it('migrates nothing when several namespaces hold configs, and says so', async () => {
    const { paramStore, pinStore, raw } = makeConfigService();
    await paramStore.storeStackConfig(PUBLISHER_TENANTS[0]!, 'mediastack', readyConfig('a'));
    await paramStore.storeStackConfig(PUBLISHER_TENANTS[1]!, 'other', readyConfig('b'));

    process.env[WORKSPACE_ID_ENV_VAR] = CREDENTIAL_TENANT;
    const log = makeLog();
    const resolution = await resolveWorkspaceId(oscContext, { store: pinStore, log });
    expect(resolution.workspaceId).toBe(CREDENTIAL_TENANT);
    // Which history is current is not knowable here: copy nothing, pin nothing,
    // and tell the operator what to do by hand.
    expect(raw.has(stackConfigKey(CREDENTIAL_TENANT, 'mediastack'))).toBe(false);
    expect(await pinStore.get(WORKSPACE_ID_PIN_KEY)).toBeUndefined();
    expect(log.warn).toHaveBeenCalled();
  });

  it('never fails the resolve when the migration write throws', async () => {
    const { paramStore, pinStore, raw } = makeConfigService();
    await paramStore.storeStackConfig(PUBLISHER_TENANTS[0]!, 'mediastack', readyConfig('a'));
    const failing: WorkspaceIdStore = {
      get: (key) => pinStore.get(key),
      set: async () => {
        throw new Error('config service unavailable');
      },
      listByPrefix: (prefix) => pinStore.listByPrefix!(prefix)
    };

    process.env[WORKSPACE_ID_ENV_VAR] = CREDENTIAL_TENANT;
    const log = makeLog();
    const resolution = await resolveWorkspaceId(oscContext, { store: failing, log });
    expect(resolution.workspaceId).toBe(CREDENTIAL_TENANT);
    expect(resolution.source).toBe('env');
    expect(raw.has(stackConfigKey(CREDENTIAL_TENANT, 'mediastack'))).toBe(false);
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('a stack under a non-default namespace transcodes (issue #804 acceptance)', () => {
  it('routes the Encore instance\'s s3Endpoint at the stack\'s MinIO with NO default-namespaced config present', async () => {
    const { paramStore, pinStore, namespacesRead, raw } = makeConfigService();

    // --- PROVISION, exactly as the provision route does as its final step -----
    const workspaceId = (await resolveWorkspaceId(oscContext, { store: pinStore }))
      .workspaceId;
    expect(workspaceId).toBe(CREDENTIAL_TENANT);
    expect(workspaceId).not.toBe(STACK_CONFIG_NAMESPACE);

    await persistStackConfig({
      paramStore,
      workspaceId,
      name: 'mediastack',
      config: { ...readyConfig('mediastack'), minioEndpoint: MINIO_ENDPOINT }
    });

    // The persisted workspace id matches the deployment's credential tenant.
    expect(await pinStore.get(WORKSPACE_ID_PIN_KEY)).toBe(CREDENTIAL_TENANT);

    // CRITICAL per the issue's verification note: NO `default`-namespaced config
    // may exist, so nothing can accidentally satisfy the old literal read.
    expect([...raw.keys()]).toContain(
      stackConfigKey(CREDENTIAL_TENANT, 'mediastack')
    );
    expect(
      [...raw.keys()].some((k) =>
        k.startsWith(stackConfigKey(STACK_CONFIG_NAMESPACE, ''))
      )
    ).toBe(false);
    // And the pre-fix read finds nothing, which is exactly why transcoding broke.
    expect(
      await paramStore.loadStackConfig(STACK_CONFIG_NAMESPACE, 'mediastack')
    ).toBeUndefined();

    // --- RESOLVE the scaler's S3 config, as main.ts wires it -----------------
    const stackResolver = new WorkspaceStackResolver({
      paramStore,
      oscContext,
      minioPassword: 'minio-root-password',
      couchPassword: 'couch-admin-password',
      workspaceIdStore: pinStore,
      log: makeLog()
    });

    const appLog = makeAppLog();
    // The SHIPPED policy — the exact factory main.ts wires into
    // WorkspaceEncoreScalerRegistry.resolveS3Config — not a copy of it, so
    // main.ts cannot drift away from what this test proves (#804).
    const resolveS3Config = createResolveS3Config({
      stackConfigSource: stackResolver,
      // On OSC this env var is unset — the condition under which the silent
      // fallback previously produced an AWS-bound Encore instance.
      encoreS3Endpoint: undefined,
      encoreS3SecretKey: 'minio-root-password',
      log: appLog
    });

    namespacesRead.length = 0;
    const s3Config = await resolveS3Config('mediastack');
    expect(s3Config).toEqual({
      endpoint: MINIO_ENDPOINT,
      accessKeyId: 'admin',
      secretAccessKey: 'minio-root-password'
    });
    // Resolution used the deployment's own namespace; `default` was never needed.
    expect(namespacesRead).toContain(CREDENTIAL_TENANT);
    expect(namespacesRead).not.toContain(PUBLISHER_TENANTS[0]);

    // --- SPAWN, and assert the URI Encore will resolve inputs against --------
    // The registry carries the resolved s3Config into EncoreScalerConfig
    // (workspace-registry.ts:195-197,217); spawnInstance maps it onto the Encore
    // instance's own `s3Endpoint` config key (instance-pool.ts:164-169).
    const redis = {
      hset: vi.fn(async () => 1)
    } as unknown as Redis;

    const scalerConfig = {
      workspaceId: 'mediastack',
      maxInstances: 2,
      idleTimeoutMs: 60_000,
      redisUrl: 'redis://mediastack-valkey.example.test:6379',
      oscContext,
      redis,
      getToken: async () => 'service-access-token',
      s3Config
    } as unknown as EncoreScalerConfig;

    await spawnInstance(scalerConfig);

    const encoreInstance = createdInstances.find((i) => i.serviceId === 'encore');
    expect(encoreInstance).toBeDefined();
    // THE acceptance assertion: Encore is pointed at the stack's own MinIO, so
    // `s3://` inputs resolve there instead of defaulting to AWS S3 (the 404 the
    // issue reports).
    expect(encoreInstance!.body['s3Endpoint']).toBe(MINIO_ENDPOINT);
    expect(encoreInstance!.body['s3AccessKeyId']).toBe('admin');
    expect(encoreInstance!.body['s3SecretAccessKey']).toBe('minio-root-password');
  });

  it('fails loudly when no endpoint resolves and no static one is configured', async () => {
    const { paramStore, pinStore } = makeConfigService();
    // Nothing provisioned at all: the endpoint is genuinely unresolvable.
    const stackResolver = new WorkspaceStackResolver({
      paramStore,
      oscContext,
      minioPassword: 'pw',
      couchPassword: 'pw',
      workspaceIdStore: pinStore,
      log: makeLog()
    });
    const appLog = makeAppLog();
    const resolveS3Config = createResolveS3Config({
      stackConfigSource: stackResolver,
      encoreS3Endpoint: undefined,
      encoreS3SecretKey: 'minio-root-password',
      log: appLog
    });

    await expect(resolveS3Config('mediastack')).rejects.toThrow(
      /unresolvable MinIO S3 endpoint/
    );
    expect(appLog.error).toHaveBeenCalled();
  });

  it('still defers to an explicitly configured static endpoint instead of throwing', async () => {
    const { paramStore, pinStore } = makeConfigService();
    const stackResolver = new WorkspaceStackResolver({
      paramStore,
      oscContext,
      minioPassword: 'pw',
      couchPassword: 'pw',
      workspaceIdStore: pinStore,
      log: makeLog()
    });
    const appLog = makeAppLog();
    const resolveS3Config = createResolveS3Config({
      stackConfigSource: stackResolver,
      encoreS3Endpoint: 'https://ops-configured-minio.example.test',
      encoreS3SecretKey: 'minio-root-password',
      log: appLog
    });

    // Returns undefined so the registry uses its static s3Config — an intentional
    // ops override, not a silent default — and says so.
    await expect(resolveS3Config('mediastack')).resolves.toBeUndefined();
    expect(appLog.warn).toHaveBeenCalled();
    expect(appLog.error).not.toHaveBeenCalled();
  });
});
