// Non-secret `StackConfig.drm` model, credential STATUS reader and the shared
// `DRM_ENABLED` gate — unit tests (ADR-008 §5.2, §9, D5, D6, D9; issue #1295).
//
// The three acceptance criteria of #1295 are the three `describe` blocks at the
// bottom:
//   1. flag-off makes NO parameter-store calls;
//   2. `credentials: 'configured' | 'missing'` per auth mode, never the value;
//   3. no secret value appears in any serialised output or log line.
//
// NO NETWORK: the parameter store is a `vi.fn()` double throughout, so a
// "no parameter-store call" assertion is about the call count of that double,
// not about an unobservable absence of traffic.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CPIX_AUTH_MODES,
  DRM_CREDENTIAL_ENV_VARS,
  DRM_NOT_CONFIGURED_PAYLOAD,
  DRM_NOT_CONFIGURED_STATUS,
  DRM_PROVIDER_KINDS,
  DRM_SPEKE_VERSIONS,
  DrmConfigValidationFailure,
  assertValidDrmStackConfig,
  drmGateClosed,
  loadDrmStackConfig,
  readDrmCredentialStatus,
  storeDrmStackConfig,
  toDrmConfigView,
  validateDrmStackConfig,
  type DrmStackConfig
} from '../src/drm/drm-config.js';
import {
  ENV_CLIENT_CERT,
  ENV_CLIENT_KEY,
  ENV_PASSWORD,
  ENV_TOKEN,
  ENV_USERNAME
} from '../src/drm/cpix-provider.js';
import { DEFAULT_DRM_SYSTEM_IDS } from '../src/drm/key-provider.js';
import type { ParamStore, StackConfig } from '../src/services/param-store.js';

// A registered system id, taken from the shared defaults rather than retyped.
const SYSTEM_ID = DEFAULT_DRM_SYSTEM_IDS[0] as string;

const VALID_CONFIG: DrmStackConfig = {
  enabled: true,
  providerKind: 'cpix',
  providerId: 'primary',
  label: 'operator free text',
  keyServerUrl: 'https://keys.example.com/cpix',
  spekeVersion: '2.0',
  authMode: 'basic',
  scheme: 'cbcs',
  systems: [SYSTEM_ID],
  licenceUrls: { [SYSTEM_ID]: 'https://licence.example.com/lic' },
  trackGroups: ['AUDIO', 'SD']
};

// The stored stack config a DRM write merges into. Minimal but complete enough
// for the StackConfig contract (param-store.ts:`StackConfig`).
const STORED_STACK: StackConfig = {
  status: 'ready',
  minioEndpoint: 'https://minio.example.com',
  couchdbUrl: 'https://couch.example.com',
  redisUrl: 'redis://valkey.example.com:6379',
  sourceBucket: 'source',
  packagedBucket: 'packaged',
  services: [{ serviceId: 'svc', instanceName: 'inst' }]
};

// `null` (not `undefined`) means "this stack has no stored config": passing
// `undefined` explicitly would re-trigger the default parameter and silently
// hand back a populated store.
function makeParamStore(stored: StackConfig | null = STORED_STACK) {
  let current: StackConfig | undefined = stored ? { ...stored } : undefined;
  return {
    loadStackConfig: vi.fn(async () => current),
    storeStackConfig: vi.fn(async (_ws: string, _name: string, cfg: StackConfig) => {
      current = { ...cfg };
    }),
    deleteStackConfig: vi.fn(async () => {}),
    listStackNames: vi.fn(async () => ['main'])
  } satisfies ParamStore & Record<string, unknown>;
}

// A reply double matching `DrmGateReply` (and structurally `FastifyReply`).
function makeReply() {
  const sent: { status?: number; payload?: unknown } = {};
  return {
    sent,
    code(status: number) {
      sent.status = status;
      return {
        send(payload: unknown) {
          sent.payload = payload;
          return payload;
        }
      };
    }
  };
}

// Env vars this suite touches, restored after every test so no test leaks a
// flag or a credential into the next one.
const TOUCHED = [
  'DRM_ENABLED',
  ENV_USERNAME,
  ENV_PASSWORD,
  ENV_TOKEN,
  ENV_CLIENT_CERT,
  ENV_CLIENT_KEY
] as const;
const originals = new Map<string, string | undefined>();

beforeEach(() => {
  for (const name of TOUCHED) {
    originals.set(name, process.env[name]);
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of TOUCHED) {
    const value = originals.get(name);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  vi.restoreAllMocks();
});

describe('validateDrmStackConfig (ADR-008 §5.2)', () => {
  it('accepts a fully populated valid config', () => {
    expect(validateDrmStackConfig(VALID_CONFIG)).toEqual([]);
  });

  it('requires an https keyServerUrl and rejects plaintext http', () => {
    const errors = validateDrmStackConfig({
      ...VALID_CONFIG,
      keyServerUrl: 'http://keys.example.com/cpix'
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe('keyServerUrl');
  });

  it('rejects a keyServerUrl with embedded userinfo', () => {
    const errors = validateDrmStackConfig({
      ...VALID_CONFIG,
      keyServerUrl: 'https://operator:hunter2@keys.example.com/cpix'
    });
    expect(errors.map((e) => e.field)).toContain('keyServerUrl');
  });

  it("requires keyServerUrl for providerKind 'cpix' but not for 'clearkey-dev'", () => {
    const { keyServerUrl: _omitted, ...withoutUrl } = VALID_CONFIG;
    expect(validateDrmStackConfig(withoutUrl).map((e) => e.field)).toContain(
      'keyServerUrl'
    );
    expect(
      validateDrmStackConfig({ ...withoutUrl, providerKind: 'clearkey-dev' })
    ).toEqual([]);
  });

  it('rejects an out-of-enum providerKind, spekeVersion, authMode and scheme', () => {
    for (const [field, bad] of [
      ['providerKind', 'not-a-kind'],
      ['spekeVersion', '3.0'],
      ['authMode', 'oauth'],
      ['scheme', 'cens']
    ] as const) {
      const errors = validateDrmStackConfig({ ...VALID_CONFIG, [field]: bad });
      expect(errors.map((e) => e.field)).toContain(field);
    }
  });

  it('accepts every member of each shared enum', () => {
    for (const providerKind of DRM_PROVIDER_KINDS) {
      expect(
        validateDrmStackConfig({ ...VALID_CONFIG, providerKind })
      ).toEqual([]);
    }
    for (const spekeVersion of DRM_SPEKE_VERSIONS) {
      expect(
        validateDrmStackConfig({ ...VALID_CONFIG, spekeVersion })
      ).toEqual([]);
    }
    for (const authMode of CPIX_AUTH_MODES) {
      expect(validateDrmStackConfig({ ...VALID_CONFIG, authMode })).toEqual([]);
    }
  });

  it('rejects a system id that is not a UUID and a non-https licence URL', () => {
    expect(
      validateDrmStackConfig({ ...VALID_CONFIG, systems: ['not-a-uuid'] }).map(
        (e) => e.field
      )
    ).toContain('systems[0]');
    expect(
      validateDrmStackConfig({
        ...VALID_CONFIG,
        licenceUrls: { [SYSTEM_ID]: 'http://licence.example.com/lic' }
      }).map((e) => e.field)
    ).toContain(`licenceUrls.${SYSTEM_ID}`);
  });

  it('rejects an unknown trackGroup', () => {
    expect(
      validateDrmStackConfig({ ...VALID_CONFIG, trackGroups: ['UHD2'] }).map(
        (e) => e.field
      )
    ).toContain('trackGroups[0]');
  });

  it('rejects a credential-shaped field outright (ADR-008 D5)', () => {
    const errors = validateDrmStackConfig({
      ...VALID_CONFIG,
      password: 'hunter2'
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]?.field).toBe('password');
  });

  it('assertValidDrmStackConfig throws DrmConfigValidationFailure', () => {
    expect(() => assertValidDrmStackConfig({})).toThrow(
      DrmConfigValidationFailure
    );
    expect(() => assertValidDrmStackConfig(VALID_CONFIG)).not.toThrow();
  });
});

describe('drmGateClosed (ADR-008 D9, §9)', () => {
  it('sends 501 not_configured when DRM_ENABLED is unset', () => {
    const reply = makeReply();
    expect(drmGateClosed(reply)).toBe(true);
    expect(reply.sent.status).toBe(DRM_NOT_CONFIGURED_STATUS);
    expect(reply.sent.status).toBe(501);
    expect(reply.sent.payload).toEqual(DRM_NOT_CONFIGURED_PAYLOAD);
    expect((reply.sent.payload as { error: string }).error).toBe('not_configured');
  });

  it('lets the handler proceed and sends nothing when DRM_ENABLED is true', () => {
    process.env['DRM_ENABLED'] = 'true';
    const reply = makeReply();
    expect(drmGateClosed(reply)).toBe(false);
    expect(reply.sent.status).toBeUndefined();
    expect(reply.sent.payload).toBeUndefined();
  });

  it('reads the flag at call time rather than caching it', () => {
    const first = makeReply();
    expect(drmGateClosed(first)).toBe(true);
    process.env['DRM_ENABLED'] = 'true';
    expect(drmGateClosed(makeReply())).toBe(false);
  });
});

// --- Acceptance criterion 1 -------------------------------------------------
// "Unit test: flag-off makes no parameter-store calls."
describe('AC1: with DRM_ENABLED off, no parameter-store call is made', () => {
  it('loadDrmStackConfig short-circuits before touching the parameter store', async () => {
    const paramStore = makeParamStore();
    await expect(
      loadDrmStackConfig(paramStore, 'ws-1', 'main')
    ).resolves.toBeUndefined();
    expect(paramStore.loadStackConfig).not.toHaveBeenCalled();
    expect(paramStore.storeStackConfig).not.toHaveBeenCalled();
    expect(paramStore.listStackNames).not.toHaveBeenCalled();
    expect(paramStore.deleteStackConfig).not.toHaveBeenCalled();
  });

  it('storeDrmStackConfig refuses before touching the parameter store', async () => {
    const paramStore = makeParamStore();
    await expect(
      storeDrmStackConfig(paramStore, 'ws-1', 'main', VALID_CONFIG)
    ).rejects.toThrow(/not configured/i);
    expect(paramStore.loadStackConfig).not.toHaveBeenCalled();
    expect(paramStore.storeStackConfig).not.toHaveBeenCalled();
  });

  it('the gate itself performs no parameter-store access at all', () => {
    const paramStore = makeParamStore();
    expect(drmGateClosed(makeReply())).toBe(true);
    expect(paramStore.loadStackConfig).not.toHaveBeenCalled();
    expect(paramStore.storeStackConfig).not.toHaveBeenCalled();
  });

  it('with the flag ON the same calls DO reach the parameter store, and the write preserves other coordinates', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const paramStore = makeParamStore();
    await storeDrmStackConfig(paramStore, 'ws-1', 'main', VALID_CONFIG);
    expect(paramStore.storeStackConfig).toHaveBeenCalledTimes(1);
    const written = paramStore.storeStackConfig.mock.calls[0]?.[2] as StackConfig;
    expect(written.drm).toEqual(VALID_CONFIG);
    // Read-modify-write: every pre-existing coordinate survives.
    expect(written.couchdbUrl).toBe(STORED_STACK.couchdbUrl);
    expect(written.services).toEqual(STORED_STACK.services);
    await expect(loadDrmStackConfig(paramStore, 'ws-1', 'main')).resolves.toEqual(
      VALID_CONFIG
    );
  });

  it('a DRM write to a stack with no stored config is refused rather than inventing one', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const paramStore = makeParamStore(null);
    await expect(
      storeDrmStackConfig(paramStore, 'ws-1', 'missing', VALID_CONFIG)
    ).rejects.toThrow(/no stack config/i);
    expect(paramStore.storeStackConfig).not.toHaveBeenCalled();
  });
});

// --- Acceptance criterion 2 -------------------------------------------------
// "Unit test: `credentials: 'configured'|'missing'` per auth mode, never the value."
describe("AC2: readDrmCredentialStatus reports only 'configured' | 'missing' per auth mode", () => {
  const SECRET = 'super-secret-credential-value';

  it("returns 'missing' for every auth mode when the environment is empty", () => {
    for (const authMode of CPIX_AUTH_MODES) {
      expect(readDrmCredentialStatus(authMode, {})).toBe('missing');
    }
  });

  it("returns 'configured' for every auth mode when its documented vars are all set", () => {
    for (const authMode of CPIX_AUTH_MODES) {
      const env: NodeJS.ProcessEnv = {};
      for (const name of DRM_CREDENTIAL_ENV_VARS[authMode]) env[name] = SECRET;
      expect(readDrmCredentialStatus(authMode, env)).toBe('configured');
    }
  });

  it("returns 'missing' for a half-configured multi-var mode", () => {
    // basic needs username AND password; mtls needs cert AND key.
    expect(
      readDrmCredentialStatus('basic', { [ENV_USERNAME]: SECRET })
    ).toBe('missing');
    expect(
      readDrmCredentialStatus('mtls', { [ENV_CLIENT_CERT]: SECRET })
    ).toBe('missing');
  });

  it("treats an empty or whitespace-only value as 'missing'", () => {
    expect(readDrmCredentialStatus('bearer', { [ENV_TOKEN]: '' })).toBe('missing');
    expect(readDrmCredentialStatus('bearer', { [ENV_TOKEN]: '   ' })).toBe(
      'missing'
    );
  });

  it('reads process.env at call time when no env is supplied', () => {
    expect(readDrmCredentialStatus('bearer')).toBe('missing');
    process.env[ENV_TOKEN] = SECRET;
    expect(readDrmCredentialStatus('bearer')).toBe('configured');
  });

  it('returns ONLY the status string — never the credential value', () => {
    for (const authMode of CPIX_AUTH_MODES) {
      const env: NodeJS.ProcessEnv = {};
      for (const name of DRM_CREDENTIAL_ENV_VARS[authMode]) env[name] = SECRET;
      const status = readDrmCredentialStatus(authMode, env);
      expect(typeof status).toBe('string');
      expect(['configured', 'missing']).toContain(status);
      expect(status).not.toContain(SECRET);
      expect(JSON.stringify(status)).not.toContain(SECRET);
    }
  });

  it('does not reveal WHICH var of a mode is missing', () => {
    const status = readDrmCredentialStatus('basic', { [ENV_USERNAME]: SECRET });
    expect(status).toBe('missing');
    expect(status).not.toContain(ENV_PASSWORD);
  });

  it('toDrmConfigView reports the status for the configured auth mode', () => {
    const view = toDrmConfigView(VALID_CONFIG, {
      [ENV_USERNAME]: SECRET,
      [ENV_PASSWORD]: SECRET
    });
    expect(view.credentials).toBe('configured');
    expect(toDrmConfigView(VALID_CONFIG, {}).credentials).toBe('missing');
  });
});

// --- Acceptance criterion 3 -------------------------------------------------
// "Unit test: no secret value appears in any serialised output or log line."
describe('AC3: no secret value appears in any serialised output or log line', () => {
  const SECRET = 'LEAKED-CREDENTIAL-0xDEADBEEF';

  // Every credential env var set to a recognisable sentinel, so a leak through
  // any path shows up as this exact string.
  function pollutedEnv(): NodeJS.ProcessEnv {
    return {
      [ENV_USERNAME]: SECRET,
      [ENV_PASSWORD]: SECRET,
      [ENV_TOKEN]: SECRET,
      [ENV_CLIENT_CERT]: SECRET,
      [ENV_CLIENT_KEY]: SECRET
    };
  }

  it('the serialised config view contains no credential value', () => {
    const view = toDrmConfigView(VALID_CONFIG, pollutedEnv());
    const serialised = JSON.stringify(view);
    expect(serialised).not.toContain(SECRET);
    expect(serialised).toContain('"credentials":"configured"');
    // No credential-named key is present either.
    for (const key of ['password', 'username', 'token', 'clientCert', 'clientKey']) {
      expect(Object.keys(view)).not.toContain(key);
    }
  });

  it('the credential status for every auth mode serialises without the value', () => {
    const env = pollutedEnv();
    for (const authMode of CPIX_AUTH_MODES) {
      const serialised = JSON.stringify({
        authMode,
        credentials: readDrmCredentialStatus(authMode, env)
      });
      expect(serialised).not.toContain(SECRET);
    }
  });

  it('the 501 gate payload contains no credential value', () => {
    process.env[ENV_TOKEN] = SECRET;
    const reply = makeReply();
    drmGateClosed(reply);
    expect(JSON.stringify(reply.sent.payload)).not.toContain(SECRET);
  });

  it('a validation error message names the field but never echoes the submitted value', () => {
    const errors = validateDrmStackConfig({ ...VALID_CONFIG, password: SECRET });
    const serialised = JSON.stringify(errors);
    expect(serialised).toContain('password');
    expect(serialised).not.toContain(SECRET);

    let thrown: unknown;
    try {
      assertValidDrmStackConfig({ ...VALID_CONFIG, token: SECRET });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(DrmConfigValidationFailure);
    const message = (thrown as Error).message;
    expect(message).toContain('token');
    expect(message).not.toContain(SECRET);
    expect(JSON.stringify((thrown as DrmConfigValidationFailure).errors)).not.toContain(
      SECRET
    );
  });

  it('a userinfo-bearing URL is rejected, and the rejection does not echo the password', () => {
    const errors = validateDrmStackConfig({
      ...VALID_CONFIG,
      keyServerUrl: `https://operator:${SECRET}@keys.example.com/cpix`
    });
    expect(errors.map((e) => e.field)).toContain('keyServerUrl');
    expect(JSON.stringify(errors)).not.toContain(SECRET);
  });

  it('nothing written to the parameter store carries a credential value', async () => {
    process.env['DRM_ENABLED'] = 'true';
    for (const name of Object.keys(pollutedEnv())) process.env[name] = SECRET;
    const paramStore = makeParamStore();
    await storeDrmStackConfig(paramStore, 'ws-1', 'main', VALID_CONFIG);
    const written = paramStore.storeStackConfig.mock.calls[0]?.[2] as StackConfig;
    expect(JSON.stringify(written)).not.toContain(SECRET);
  });

  it('no log line emitted while reading status or gating carries a credential value', () => {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => String(a)).join(' '));
      });
    }
    const env = pollutedEnv();
    for (const authMode of CPIX_AUTH_MODES) readDrmCredentialStatus(authMode, env);
    toDrmConfigView(VALID_CONFIG, env);
    drmGateClosed(makeReply());
    validateDrmStackConfig({ ...VALID_CONFIG, password: SECRET });
    // The module is silent, and in particular never logs a credential.
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines).toEqual([]);
  });
});
