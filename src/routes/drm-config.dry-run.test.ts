// Tests for the DRM dry-run key request (issue #1297, ADR-008 §9 row
// `POST /api/v1/drm/config/test`).
//
// Covers the issue's acceptance criteria:
//   - success with a STUBBED provider: ok, the signalled system ids, a latency;
//   - a provider error mapped to an `errorCode` STRING ONLY, with no key
//     material, no provider message and no credential in the body or in
//     anything the route logged;
//   - 501 when DRM_ENABLED=false — before the parameter store is read and
//     before a provider is built;
//   - the route published in openapi.json, with the version tracking
//     package.json.
//
// Contract sources (CLAUDE.md rule 7) are cited in src/routes/drm-config.ts;
// every symbol asserted here is imported from its single definition rather
// than retyped: `KeyProviderError` (src/drm/key-provider-error.ts),
// `DRM_ERROR_CODES` (src/types/drm.ts), `DEFAULT_DRM_SYSTEM_IDS` /
// `CLEAR_KEY_SYSTEM_ID` (src/drm/key-provider.ts) and
// `DRM_NOT_CONFIGURED_PAYLOAD` (src/drm/drm-config.ts).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import {
  drmConfigRouter,
  type DrmKeyProviderFactory,
  type DrmStackNameResolver
} from './drm-config.js';
import {
  DRM_NOT_CONFIGURED_PAYLOAD,
  DRM_NOT_CONFIGURED_STATUS,
  type DrmStackConfig
} from '../drm/drm-config.js';
import { KeyProviderError } from '../drm/key-provider-error.js';
import {
  CLEAR_KEY_SYSTEM_ID,
  DEFAULT_DRM_SYSTEM_IDS,
  type ContentKey,
  type DrmSignalling,
  type KeyProvider,
  type KeyRequest
} from '../drm/key-provider.js';
import { ENV_PASSWORD, ENV_USERNAME } from '../drm/cpix-provider.js';
import { ClearKeyDevNotAllowedError } from '../drm/clearkey-dev-provider.js';
import { DRM_ERROR_CODES } from '../types/drm.js';
import type { ParamStore, StackConfig } from '../services/param-store.js';

const STACK = 'mystack';
const URL_UNDER_TEST = '/api/v1/drm/config/test';

// A credential value and a raw key byte pattern that must appear in NO response
// body. Distinctive so a substring search over the serialised payload means
// something.
const SECRET_VALUE = 'operator-credential-7b3f-never-leaves';
const KEY_BYTE = 0xa7;

const CONFIG: DrmStackConfig = {
  enabled: true,
  providerKind: 'cpix',
  providerId: 'primary',
  keyServerUrl: 'https://keys.example.com/cpix',
  spekeVersion: '2.0',
  authMode: 'basic'
};

function storedStack(drm?: DrmStackConfig): StackConfig {
  return {
    status: 'ready',
    services: [{ serviceId: 'eyevinn-minio-minio', instanceName: 'mystack-minio' }],
    ...(drm ? { drm } : {})
  } as StackConfig;
}

function makeParamStore(initial?: StackConfig) {
  const entries = new Map<string, StackConfig>();
  if (initial) entries.set(STACK, initial);
  const loadStackConfig = vi.fn(async (_ws: string, name: string) => entries.get(name));
  const storeStackConfig = vi.fn(async (_ws: string, name: string, cfg: StackConfig) => {
    entries.set(name, cfg);
  });
  const paramStore = {
    loadStackConfig,
    storeStackConfig,
    deleteStackConfig: vi.fn(async () => {}),
    listStackNames: vi.fn(async () => [...entries.keys()])
  } as unknown as ParamStore;
  return { paramStore, loadStackConfig, storeStackConfig, entries };
}

// Mirrors WorkspaceStackResolver.resolveStackName (workspace-stack.ts:1251).
function makeResolver(entries: Map<string, StackConfig>): DrmStackNameResolver {
  return {
    resolveStackName: vi.fn(async (requested?: string) => {
      if (requested && entries.has(requested)) return requested;
      const names = [...entries.keys()];
      return names.length > 0 ? names[0] : undefined;
    })
  };
}

// A stubbed `KeyProvider` (src/drm/key-provider.ts): returns one key carrying
// recognisable raw bytes plus signalling for the requested system ids, and
// records the request it was given so the throwaway-contentId behaviour can be
// asserted.
function stubProvider(
  onAcquire?: (req: KeyRequest) => Promise<never> | void
): { provider: KeyProvider; requests: KeyRequest[]; keys: ContentKey[] } {
  const requests: KeyRequest[] = [];
  const keys: ContentKey[] = [];
  const provider: KeyProvider = {
    id: 'primary',
    kind: 'cpix',
    acquire: async (req, signal) => {
      requests.push(req);
      expect(signal).toBeInstanceOf(AbortSignal);
      const thrown = onAcquire?.(req);
      if (thrown) await thrown;
      const key: ContentKey = {
        trackGroup: req.trackGroups[0]!,
        keyId: '3a2b1c00-0000-4000-8000-000000000001',
        key: new Uint8Array(16).fill(KEY_BYTE)
      };
      keys.push(key);
      const signalling: DrmSignalling = {
        pssh: Object.fromEntries(
          req.systems.map((id) => [id, 'cHNzaC1ib3gtYmFzZTY0'])
        ) as DrmSignalling['pssh'],
        licenceUrls: {} as DrmSignalling['licenceUrls']
      };
      return { keys: [key], signalling };
    }
  };
  return { provider, requests, keys };
}

async function buildApp(opts: {
  paramStore?: ParamStore;
  stackResolver?: DrmStackNameResolver;
  createKeyProvider?: DrmKeyProviderFactory;
}) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(drmConfigRouter, { prefix: '/api/v1/drm', ...opts });
  await app.ready();
  return app;
}

async function wire(createKeyProvider: DrmKeyProviderFactory, drm: DrmStackConfig = CONFIG) {
  const store = makeParamStore(storedStack(drm));
  const app = await buildApp({
    paramStore: store.paramStore,
    stackResolver: makeResolver(store.entries),
    createKeyProvider
  });
  return { app, ...store };
}

const envBackup = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  if (!envBackup.has(name)) envBackup.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

// Everything the route wrote to a log, so the "no secret in logs" criterion is
// checked against real output rather than assumed.
let logged: string[] = [];

beforeEach(() => {
  setEnv('DRM_ENABLED', 'true');
  // A credential IS in the environment for every case, so a leak would have
  // something to leak.
  setEnv(ENV_USERNAME, 'key-service-operator');
  setEnv(ENV_PASSWORD, SECRET_VALUE);
  logged = [];
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
      logged.push(args.map((a) => String(a)).join(' '));
    });
  }
});

afterEach(() => {
  for (const [name, value] of envBackup) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  envBackup.clear();
  vi.restoreAllMocks();
});

describe('POST /api/v1/drm/config/test', () => {
  it('reports ok with the signalled system ids and a latency, and no key material', async () => {
    const stub = stubProvider();
    const { app } = await wire(() => stub.provider);

    const res = await app.inject({ method: 'POST', url: URL_UNDER_TEST });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    // The configured-or-default system ids (resolveDrmSystemIds, with no
    // `systems` in CONFIG) are what the stub signalled and what is reported.
    expect(body.systems).toEqual([...DEFAULT_DRM_SYSTEM_IDS]);
    expect(typeof body.latencyMs).toBe('number');
    expect(body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(body.error).toBeUndefined();
    // The closed response schema: ok / systems / latencyMs and nothing else.
    expect(Object.keys(body).sort()).toEqual(['latencyMs', 'ok', 'systems']);

    // NO KEY MATERIAL and no key IDENTIFIER crosses the boundary, in any
    // encoding, and the raw bytes were zeroed in place after the call.
    const hex = Buffer.from(new Uint8Array(16).fill(KEY_BYTE)).toString('hex');
    const base64 = Buffer.from(new Uint8Array(16).fill(KEY_BYTE)).toString('base64');
    expect(res.payload).not.toContain(hex);
    expect(res.payload).not.toContain(base64);
    expect(res.payload).not.toContain('3a2b1c00-0000-4000-8000-000000000001');
    expect(res.payload).not.toContain(SECRET_VALUE);
    expect(stub.keys[0]!.key.every((b) => b === 0)).toBe(true);
  });

  it('uses a throwaway contentId that is not an asset id, and a single-key request', async () => {
    const stub = stubProvider();
    const { app } = await wire(() => stub.provider);

    await app.inject({ method: 'POST', url: URL_UNDER_TEST });
    await app.inject({ method: 'POST', url: URL_UNDER_TEST });

    expect(stub.requests).toHaveLength(2);
    const [first, second] = stub.requests;
    // Labelled, random, and never repeated — so no real asset's keys can be
    // minted or re-requested by a test run (ADR-008 §6 "Idempotency" binds
    // contentId to an asset id).
    expect(first!.contentId).toMatch(/^drm-config-test-/);
    expect(second!.contentId).not.toBe(first!.contentId);
    // Single-key profile (ADR-008 D3) and the configured scheme default.
    expect(first!.trackGroups).toEqual(['SD']);
    expect(first!.scheme).toBe('cbcs');
    expect(first!.keyIds).toBeUndefined();
  });

  it('maps a provider failure to an errorCode string only — no message, no credential', async () => {
    // The adapter classifies its own failures (KeyProviderError.errorCode);
    // the message below is the kind of text that must NOT reach the response.
    const stub = stubProvider(() =>
      Promise.reject(
        new KeyProviderError(
          'key_provider_rejected',
          `provider said: 401 for user key-service-operator password ${SECRET_VALUE}`,
          3
        )
      )
    );
    const { app } = await wire(() => stub.provider);

    const res = await app.inject({ method: 'POST', url: URL_UNDER_TEST });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.error).toBe('key_provider_rejected');
    expect(DRM_ERROR_CODES).toContain(body.error);
    expect(body.systems).toEqual([]);
    expect(typeof body.latencyMs).toBe('number');
    // ERROR CODE ONLY: no provider prose, no credential, no extra member that
    // could carry either — in the body or in anything that was logged.
    expect(Object.keys(body).sort()).toEqual(['error', 'latencyMs', 'ok', 'systems']);
    expect(res.payload).not.toContain(SECRET_VALUE);
    expect(res.payload).not.toContain('provider said');
    expect(res.payload).not.toContain('key-service-operator');
    for (const line of logged) {
      expect(line).not.toContain(SECRET_VALUE);
      expect(line).not.toContain('provider said');
    }
  });

  it('maps an unclassified throw to the unreachable code rather than a 500', async () => {
    const stub = stubProvider(() => Promise.reject(new Error(`boom ${SECRET_VALUE}`)));
    const { app } = await wire(() => stub.provider);

    const res = await app.inject({ method: 'POST', url: URL_UNDER_TEST });
    expect(res.statusCode).toBe(200);
    expect(res.json().error).toBe('key_provider_unreachable');
    expect(res.payload).not.toContain(SECRET_VALUE);
  });

  it('reports a provider-construction refusal as an errorCode, without calling it', async () => {
    // A misconfigured stack (e.g. a non-https key server) is refused by the
    // adapter's CONSTRUCTOR with a KeyProviderError — exactly what an operator
    // runs this route to discover.
    const factory = vi.fn(() => {
      throw new KeyProviderError('drm_not_configured', 'key server url must use https');
    });
    const { app } = await wire(factory as unknown as DrmKeyProviderFactory);

    const res = await app.inject({ method: 'POST', url: URL_UNDER_TEST });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: false,
      systems: [],
      error: 'drm_not_configured'
    });
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("reports a development-only provider refusing to start as 'drm_not_configured'", async () => {
    // `ClearKeyDevNotAllowedError` (src/drm/clearkey-dev-provider.ts) extends
    // `Error`, not `KeyProviderError`, so the unreachable fallback would claim
    // the key server could not be reached — when no request was ever sent. The
    // stack is simply configured for a provider this process refuses to run.
    const factory = vi.fn(() => {
      throw new ClearKeyDevNotAllowedError();
    });
    const { app } = await wire(factory as unknown as DrmKeyProviderFactory);

    const res = await app.inject({ method: 'POST', url: URL_UNDER_TEST });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      ok: false,
      systems: [],
      error: 'drm_not_configured'
    });
    // The thrown message is never echoed (ADR-008 §10).
    expect(res.payload).not.toContain('NODE_ENV');
  });

  it('reports ok for a provider that signals only the system it speaks for', async () => {
    // `clearkey-dev` answers for the clear-key system id whatever was
    // requested, so `systems` reports what was SIGNALLED.
    const provider: KeyProvider = {
      id: 'primary',
      kind: 'clearkey-dev',
      acquire: async (req) => ({
        keys: [
          {
            trackGroup: req.trackGroups[0]!,
            keyId: '3a2b1c00-0000-4000-8000-000000000002',
            key: new Uint8Array(16).fill(1)
          }
        ],
        signalling: {
          pssh: { [CLEAR_KEY_SYSTEM_ID]: 'cHNzaA==' } as DrmSignalling['pssh'],
          licenceUrls: {} as DrmSignalling['licenceUrls'],
          dev: true
        }
      })
    };
    const { app } = await wire(() => provider);

    const res = await app.inject({ method: 'POST', url: URL_UNDER_TEST });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, systems: [CLEAR_KEY_SYSTEM_ID] });
  });

  it('is ok:false with an invalid-response code when the provider signals no system', async () => {
    const provider: KeyProvider = {
      id: 'primary',
      kind: 'cpix',
      acquire: async () => ({
        keys: [],
        signalling: {
          pssh: {} as DrmSignalling['pssh'],
          licenceUrls: {} as DrmSignalling['licenceUrls']
        }
      })
    };
    const { app } = await wire(() => provider);

    const res = await app.inject({ method: 'POST', url: URL_UNDER_TEST });
    expect(res.json()).toMatchObject({
      ok: false,
      systems: [],
      error: 'key_provider_invalid_response'
    });
  });

  it('is 501 not_configured with DRM_ENABLED off, with no store read and no provider built', async () => {
    setEnv('DRM_ENABLED', 'false');
    const factory = vi.fn(() => {
      throw new Error('a flag-off deployment must not build a key provider');
    });
    const { app, loadStackConfig } = await wire(
      factory as unknown as DrmKeyProviderFactory
    );

    const res = await app.inject({ method: 'POST', url: URL_UNDER_TEST });
    expect(res.statusCode).toBe(DRM_NOT_CONFIGURED_STATUS);
    expect(res.statusCode).toBe(501);
    expect(res.json()).toEqual({ ...DRM_NOT_CONFIGURED_PAYLOAD });
    // The kill switch is total: no parameter-store read, no provider, no
    // credential env read, no socket (ADR-008 D9).
    expect(loadStackConfig).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
    expect(res.payload).not.toContain(SECRET_VALUE);
  });

  it('is 501 when no parameter store is configured on the deployment', async () => {
    const app = await buildApp({
      createKeyProvider: () => stubProvider().provider
    });
    const res = await app.inject({ method: 'POST', url: URL_UNDER_TEST });
    expect(res.statusCode).toBe(DRM_NOT_CONFIGURED_STATUS);
    expect(res.json().error).toBe(DRM_NOT_CONFIGURED_PAYLOAD.error);
  });

  it('is 404 when the stack has no DRM configuration stored yet', async () => {
    const factory = vi.fn(() => stubProvider().provider);
    // A provisioned stack whose StackConfig carries no `drm` block at all.
    const store = makeParamStore(storedStack());
    const app = await buildApp({
      paramStore: store.paramStore,
      stackResolver: makeResolver(store.entries),
      createKeyProvider: factory as unknown as DrmKeyProviderFactory
    });

    const res = await app.inject({ method: 'POST', url: URL_UNDER_TEST });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('published OpenAPI contract for /api/v1/drm/config/test', () => {
  type Spec = {
    info: { version: string };
    paths: Record<
      string,
      Record<
        string,
        {
          responses: Record<
            string,
            { content?: { 'application/json': { schema: Record<string, unknown> } } }
          >;
        }
      >
    >;
  };

  const spec = JSON.parse(
    readFileSync(new URL('../../openapi.json', import.meta.url), 'utf8')
  ) as Spec;

  it('documents the dry-run operation with its declared outcomes', () => {
    const path = spec.paths['/api/v1/drm/config/test'];
    expect(path).toBeDefined();
    expect(Object.keys(path)).toEqual(['post']);
    expect(Object.keys(path.post.responses).sort()).toEqual(['200', '404', '501']);
  });

  it('publishes a CLOSED result schema whose error is an errorCode enum only', () => {
    const schema = spec.paths['/api/v1/drm/config/test'].post.responses['200'].content![
      'application/json'
    ].schema as {
      additionalProperties?: unknown;
      properties: Record<string, { enum?: string[] }>;
      required: string[];
    };
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual([
      'error',
      'latencyMs',
      'ok',
      'systems'
    ]);
    expect(schema.required.sort()).toEqual(['latencyMs', 'ok', 'systems']);
    // The published `error` cannot be prose: it is the closed code enum.
    expect(schema.properties['error']!.enum).toEqual([...DRM_ERROR_CODES]);
    // And no key- or credential-shaped member exists in the contract at all.
    for (const name of ['key', 'keys', 'keyId', 'keyIds', 'password', 'token']) {
      expect(Object.keys(schema.properties)).not.toContain(name);
    }
  });

  it('carries the bumped spec version, which tracks package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
    ) as { version: string };
    expect(spec.info.version).toBe(pkg.version);
  });
});
