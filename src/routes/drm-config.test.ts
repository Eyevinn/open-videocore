// Tests for the DRM configuration admin surface (issue #1296, ADR-008 §9):
// GET and PUT /api/v1/drm/config.
//
// Covers the issue's acceptance criteria:
//   - the 400 invalid_field rejections (a credential-shaped field; an `http:`
//     keyServerUrl), with nothing written to the parameter store;
//   - the 501 when DRM_ENABLED is off, with NO parameter-store call at all;
//   - a no-secret-in-response check: a credential value present in the
//     environment, and one hand-injected into the stored block, appear nowhere
//     in any response body;
//   - the new routes in openapi.json, with a CLOSED GET schema and the version
//     tracking package.json.
//
// Contract sources (CLAUDE.md rule 7) are cited in src/routes/drm-config.ts;
// the symbols asserted here — DRM_NOT_CONFIGURED_PAYLOAD, the credential env
// var names, DRM_STACK_CONFIG_FIELD_NAMES — are imported from their single
// definitions rather than retyped as literals.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Fastify from 'fastify';
import { readFileSync } from 'node:fs';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import {
  drmConfigRouter,
  DRM_INVALID_FIELD_ERROR,
  type DrmStackNameResolver
} from './drm-config.js';
import {
  DRM_NOT_CONFIGURED_PAYLOAD,
  DRM_NOT_CONFIGURED_STATUS,
  DRM_STACK_CONFIG_FIELD_NAMES,
  type DrmStackConfig
} from '../drm/drm-config.js';
import { ENV_PASSWORD, ENV_USERNAME } from '../drm/cpix-provider.js';
import { STACK_CONFIG_NAMESPACE } from '../services/workspace-stack.js';
import type { ParamStore, StackConfig } from '../services/param-store.js';

const STACK = 'mystack';

// A credential value that must never appear in any response body. Distinctive
// so a substring search over the serialised response is meaningful.
const SECRET_VALUE = 'correct-horse-battery-staple-9f21';

const VALID_CONFIG: DrmStackConfig = {
  enabled: true,
  providerKind: 'cpix',
  providerId: 'primary',
  label: 'operator key service',
  keyServerUrl: 'https://keys.example.com/cpix',
  spekeVersion: '2.0',
  authMode: 'basic',
  scheme: 'cbcs',
  trackGroups: ['AUDIO', 'SD']
};

// A stored stack config carrying the other coordinates a real stack has, so a
// DRM write can be shown to preserve them (storeDrmStackConfig is a
// read-modify-write over the WHOLE StackConfig).
function storedStack(drm?: DrmStackConfig): StackConfig {
  return {
    status: 'ready',
    services: [{ serviceId: 'eyevinn-minio-minio', instanceName: 'mystack-minio' }],
    ...(drm ? { drm } : {})
  } as StackConfig;
}

type Harness = {
  paramStore: ParamStore;
  loadStackConfig: ReturnType<typeof vi.fn>;
  storeStackConfig: ReturnType<typeof vi.fn>;
  entries: Map<string, StackConfig>;
};

function makeParamStore(initial?: StackConfig): Harness {
  const entries = new Map<string, StackConfig>();
  if (initial) entries.set(STACK, initial);
  const loadStackConfig = vi.fn(async (_ws: string, name: string) => entries.get(name));
  const storeStackConfig = vi.fn(async (_ws: string, name: string, cfg: StackConfig) => {
    entries.set(name, JSON.parse(JSON.stringify(cfg)) as StackConfig);
  });
  const paramStore = {
    loadStackConfig,
    storeStackConfig,
    deleteStackConfig: vi.fn(async () => {}),
    listStackNames: vi.fn(async () => [...entries.keys()])
  } as unknown as ParamStore;
  return { paramStore, loadStackConfig, storeStackConfig, entries };
}

// Mirrors WorkspaceStackResolver.resolveStackName (workspace-stack.ts:1251): a
// requested name with a stored config wins verbatim, otherwise the first listed
// stack is the workspace default, and undefined when nothing is provisioned.
function makeResolver(entries: Map<string, StackConfig>): DrmStackNameResolver {
  return {
    resolveStackName: vi.fn(async (requested?: string) => {
      if (requested && entries.has(requested)) return requested;
      const names = [...entries.keys()];
      return names.length > 0 ? names[0] : undefined;
    })
  };
}

async function buildApp(opts: {
  paramStore?: ParamStore;
  stackResolver?: DrmStackNameResolver;
}) {
  const app = Fastify();
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);
  await app.register(drmConfigRouter, { prefix: '/api/v1/drm', ...opts });
  await app.ready();
  return app;
}

// Full wiring with DRM on: a stored stack (optionally with a DRM block) plus a
// resolver over the same entries.
async function wire(drm?: DrmStackConfig) {
  const store = makeParamStore(storedStack(drm));
  const app = await buildApp({
    paramStore: store.paramStore,
    stackResolver: makeResolver(store.entries)
  });
  return { app, ...store };
}

const envBackup = new Map<string, string | undefined>();
function setEnv(name: string, value: string | undefined): void {
  if (!envBackup.has(name)) envBackup.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

beforeEach(() => {
  // DRM on by default; the flag-off cases set it explicitly.
  setEnv('DRM_ENABLED', 'true');
  setEnv(ENV_USERNAME, undefined);
  setEnv(ENV_PASSWORD, undefined);
});

afterEach(() => {
  for (const [name, value] of envBackup) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  envBackup.clear();
  vi.restoreAllMocks();
});

describe('GET /api/v1/drm/config', () => {
  it('returns the non-secret coordinates and the credential STATUS, never a credential value', async () => {
    setEnv(ENV_USERNAME, 'key-service-operator');
    setEnv(ENV_PASSWORD, SECRET_VALUE);
    const { app } = await wire(VALID_CONFIG);

    const res = await app.inject({ method: 'GET', url: '/api/v1/drm/config' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({ ...VALID_CONFIG, credentials: 'configured' });

    // The no-secret check, over the RAW payload rather than the parsed object:
    // neither the credential value nor the username appears anywhere.
    expect(res.payload).not.toContain(SECRET_VALUE);
    expect(res.payload).not.toContain('key-service-operator');
    // And no credential-bearing FIELD exists on the response at all — the only
    // thing said about a credential is the status string.
    for (const name of ['password', 'username', 'token', 'secret', 'clientKey']) {
      expect(Object.keys(body)).not.toContain(name);
    }
    expect(body.credentials).toBe('configured');
  });

  it("reports credentials 'missing' when the auth mode's env vars are unset", async () => {
    const { app } = await wire(VALID_CONFIG);
    const res = await app.inject({ method: 'GET', url: '/api/v1/drm/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json().credentials).toBe('missing');
  });

  it('does not echo a credential-shaped key that is present in the STORED block', async () => {
    // A block hand-edited into the parameter store (or written by an older
    // build) must not be able to smuggle a value out through the read path:
    // the projection in toDrmConfigView and the closed response schema both
    // drop it.
    const polluted = {
      ...VALID_CONFIG,
      password: SECRET_VALUE,
      sessionKey: SECRET_VALUE
    } as unknown as DrmStackConfig;
    const { app } = await wire(polluted);

    const res = await app.inject({ method: 'GET', url: '/api/v1/drm/config' });
    expect(res.statusCode).toBe(200);
    expect(res.payload).not.toContain(SECRET_VALUE);
    expect(Object.keys(res.json())).not.toContain('password');
    expect(Object.keys(res.json())).not.toContain('sessionKey');
  });

  it('is 501 not_configured with DRM_ENABLED off, without reading the parameter store', async () => {
    setEnv('DRM_ENABLED', 'false');
    const { app, loadStackConfig } = await wire(VALID_CONFIG);

    const res = await app.inject({ method: 'GET', url: '/api/v1/drm/config' });
    expect(res.statusCode).toBe(DRM_NOT_CONFIGURED_STATUS);
    expect(res.json()).toEqual({ ...DRM_NOT_CONFIGURED_PAYLOAD });
    // The kill switch is total: no parameter-store traffic at all.
    expect(loadStackConfig).not.toHaveBeenCalled();
  });

  it('is 501 not_configured when no parameter store is wired', async () => {
    const app = await buildApp({ stackResolver: makeResolver(new Map()) });
    const res = await app.inject({ method: 'GET', url: '/api/v1/drm/config' });
    expect(res.statusCode).toBe(DRM_NOT_CONFIGURED_STATUS);
    expect(res.json().error).toBe(DRM_NOT_CONFIGURED_PAYLOAD.error);
  });

  it('is 404 when no stack is provisioned, and when the stack holds no DRM config', async () => {
    const empty = makeParamStore();
    const noStack = await buildApp({
      paramStore: empty.paramStore,
      stackResolver: makeResolver(empty.entries)
    });
    const resNoStack = await noStack.inject({ method: 'GET', url: '/api/v1/drm/config' });
    expect(resNoStack.statusCode).toBe(404);
    expect(resNoStack.json().error).toBe('not_found');

    const { app } = await wire();
    const resNoDrm = await app.inject({ method: 'GET', url: '/api/v1/drm/config' });
    expect(resNoDrm.statusCode).toBe(404);
    expect(resNoDrm.json().error).toBe('not_found');
  });

  it('reads the stack named by X-Stack-Name under the deployment namespace', async () => {
    const { app, loadStackConfig } = await wire(VALID_CONFIG);
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/drm/config',
      headers: { 'x-stack-name': STACK }
    });
    expect(res.statusCode).toBe(200);
    expect(loadStackConfig).toHaveBeenCalledWith(STACK_CONFIG_NAMESPACE, STACK);
  });
});

describe('PUT /api/v1/drm/config', () => {
  it('rejects a credential-shaped field with 400 invalid_field and stores nothing', async () => {
    const { app, storeStackConfig } = await wire();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/drm/config',
      payload: { ...VALID_CONFIG, password: SECRET_VALUE }
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe(DRM_INVALID_FIELD_ERROR);
    expect(body.fields.map((f: { field: string }) => f.field)).toContain('password');
    // The rejected VALUE is never echoed back (ADR-008 §10).
    expect(res.payload).not.toContain(SECRET_VALUE);
    expect(storeStackConfig).not.toHaveBeenCalled();
  });

  it('rejects an unanticipated credential-shaped field name with 400 invalid_field', async () => {
    // The allow-list, not the denylist, is the defence: a name nobody listed
    // (`clientSecret2`) is not a DRM coordinate, so it is refused rather than
    // persisted in cleartext.
    const { app, storeStackConfig } = await wire();
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/drm/config',
      payload: { ...VALID_CONFIG, clientSecret2: SECRET_VALUE }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe(DRM_INVALID_FIELD_ERROR);
    expect(res.payload).not.toContain(SECRET_VALUE);
    expect(storeStackConfig).not.toHaveBeenCalled();
  });

  it('rejects a plaintext http: keyServerUrl with 400 invalid_field and stores nothing', async () => {
    const { app, storeStackConfig } = await wire();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/drm/config',
      payload: { ...VALID_CONFIG, keyServerUrl: 'http://keys.example.com/cpix' }
    });
    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error).toBe(DRM_INVALID_FIELD_ERROR);
    expect(body.fields.map((f: { field: string }) => f.field)).toContain('keyServerUrl');
    expect(storeStackConfig).not.toHaveBeenCalled();
  });

  it('is 501 not_configured with DRM_ENABLED off, without writing the parameter store', async () => {
    setEnv('DRM_ENABLED', 'false');
    const { app, storeStackConfig, loadStackConfig } = await wire();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/drm/config',
      payload: VALID_CONFIG
    });
    expect(res.statusCode).toBe(DRM_NOT_CONFIGURED_STATUS);
    expect(res.json()).toEqual({ ...DRM_NOT_CONFIGURED_PAYLOAD });
    expect(storeStackConfig).not.toHaveBeenCalled();
    expect(loadStackConfig).not.toHaveBeenCalled();
  });

  it('is 501 not_configured when no parameter store is wired', async () => {
    const app = await buildApp({ stackResolver: makeResolver(new Map()) });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/drm/config',
      payload: VALID_CONFIG
    });
    expect(res.statusCode).toBe(DRM_NOT_CONFIGURED_STATUS);
    expect(res.json().error).toBe(DRM_NOT_CONFIGURED_PAYLOAD.error);
  });

  it('persists only the allowlisted coordinates and preserves the rest of the stack config', async () => {
    const { app, entries } = await wire();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/drm/config',
      payload: VALID_CONFIG
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ...VALID_CONFIG, credentials: 'missing' });

    const persisted = entries.get(STACK);
    expect(persisted?.drm).toEqual(VALID_CONFIG);
    // Read-modify-write: the stack's other coordinates survive the DRM write.
    expect(persisted?.services).toHaveLength(1);
    expect(persisted?.status).toBe('ready');
    // The derived view field is NOT stored state.
    expect(Object.keys(persisted?.drm ?? {})).not.toContain('credentials');
    for (const key of Object.keys(persisted?.drm ?? {})) {
      expect(DRM_STACK_CONFIG_FIELD_NAMES as readonly string[]).toContain(key);
    }
  });

  it('accepts the exact body GET returned (read-modify-write round trip)', async () => {
    setEnv(ENV_USERNAME, 'key-service-operator');
    setEnv(ENV_PASSWORD, SECRET_VALUE);
    const { app, entries } = await wire(VALID_CONFIG);

    const read = await app.inject({ method: 'GET', url: '/api/v1/drm/config' });
    expect(read.statusCode).toBe(200);

    const written = await app.inject({
      method: 'PUT',
      url: '/api/v1/drm/config',
      payload: read.json()
    });
    expect(written.statusCode).toBe(200);
    expect(written.json()).toEqual(read.json());
    // The round trip did not smuggle the status field into the store.
    expect(Object.keys(entries.get(STACK)?.drm ?? {})).not.toContain('credentials');
    expect(written.payload).not.toContain(SECRET_VALUE);
  });

  it('is 404 when no stack is provisioned to write to', async () => {
    const empty = makeParamStore();
    const app = await buildApp({
      paramStore: empty.paramStore,
      stackResolver: makeResolver(empty.entries)
    });
    const res = await app.inject({
      method: 'PUT',
      url: '/api/v1/drm/config',
      payload: VALID_CONFIG
    });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toBe('not_found');
    expect(empty.storeStackConfig).not.toHaveBeenCalled();
  });
});

describe('published OpenAPI contract for /api/v1/drm/config', () => {
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

  it('documents both operations with their declared outcomes', () => {
    const path = spec.paths['/api/v1/drm/config'];
    expect(path).toBeDefined();
    expect(Object.keys(path).sort()).toEqual(['get', 'put']);
    expect(Object.keys(path.get.responses).sort()).toEqual(['200', '404', '501']);
    expect(Object.keys(path.put.responses).sort()).toEqual(['200', '400', '404', '501']);
  });

  it('publishes a CLOSED GET schema that carries the status field and no credential field', () => {
    const schema = spec.paths['/api/v1/drm/config'].get.responses['200'].content![
      'application/json'
    ].schema as {
      additionalProperties?: unknown;
      properties: Record<string, unknown>;
      required: string[];
    };
    // The point of the closed schema: nothing beyond the declared view can
    // cross this boundary.
    expect(schema.additionalProperties).toBe(false);
    expect(Object.keys(schema.properties).sort()).toEqual(
      [...DRM_STACK_CONFIG_FIELD_NAMES, 'credentials'].sort()
    );
    expect(schema.required).toContain('credentials');
    for (const name of ['password', 'username', 'token', 'secret', 'clientKey']) {
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
