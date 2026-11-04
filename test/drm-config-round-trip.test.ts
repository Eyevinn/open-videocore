// DRM config GET→PUT round trip and the write-path field ALLOWLIST — unit tests
// for the two review findings on PR #1326 (issue #1295).
//
// Finding 1: the read view's derived `credentials` STATUS field collided with
// the write-side credential name denylist, so reading the config and writing it
// back always produced a misleading `400`. These tests pin the round trip.
//
// Finding 2: validation never enumerated the candidate's own keys, so a field
// named `clientSecret` / `authToken` / `pwd` passed every check, was persisted
// verbatim and was spread back into the response — and a typo'd field like
// `scheem` validated clean while doing nothing. These tests pin the allowlist.
//
// Contract sources (fetched 2026-11-04, CLAUDE.md rule 7):
//   - ADR-008 §5.2 "Configuration model" — the exact field list of the
//     `StackConfig.drm` block, mirrored by `DRM_STACK_CONFIG_FIELD_NAMES`.
//   - ADR-008 §9 "API surface" — `GET /api/v1/drm/config` reports "credential
//     presence as `credentials: "configured" | "missing"`, never values", and
//     `PUT /api/v1/drm/config` "rejects any body field that looks like a
//     credential (`400 invalid_field`)".
//   - src/drm/drm-config.ts:`DrmConfigView`, `toDrmConfigView`,
//     `validateDrmStackConfig`, `projectDrmStackConfig`, `storeDrmStackConfig`.
//   - src/services/param-store.ts:`makeHttpParamStore` (injected `fetch`),
//     `HttpParamStoreConfig`, `StackConfig` — the store boundary whose
//     `storeStackConfig` persists the block via `JSON.stringify`.
//
// NO NETWORK: the parameter store is either a `vi.fn()` double or
// `makeHttpParamStore` with an injected `fetch` double.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DRM_CREDENTIAL_STATUSES,
  DRM_STACK_CONFIG_FIELD_NAMES,
  DrmConfigValidationFailure,
  projectDrmStackConfig,
  storeDrmStackConfig,
  toDrmConfigView,
  validateDrmStackConfig,
  type DrmStackConfig
} from '../src/drm/drm-config.js';
import {
  ENV_PASSWORD,
  ENV_TOKEN,
  ENV_USERNAME
} from '../src/drm/cpix-provider.js';
import { DEFAULT_DRM_SYSTEM_IDS } from '../src/drm/key-provider.js';
import {
  makeHttpParamStore,
  type ParamStore,
  type StackConfig
} from '../src/services/param-store.js';

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
  certificateUrls: { [SYSTEM_ID]: 'https://certs.example.com/cert' },
  trackGroups: ['AUDIO', 'SD']
};

const STORED_STACK: StackConfig = {
  status: 'ready',
  minioEndpoint: 'https://minio.example.com',
  couchdbUrl: 'https://couch.example.com',
  redisUrl: 'redis://valkey.example.com:6379',
  sourceBucket: 'source',
  packagedBucket: 'packaged',
  services: [{ serviceId: 'svc', instanceName: 'inst' }]
};

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

const TOUCHED = ['DRM_ENABLED', ENV_USERNAME, ENV_PASSWORD, ENV_TOKEN] as const;
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

// --- Finding 1 --------------------------------------------------------------
describe('GET→PUT round trip of the DRM config (ADR-008 §9)', () => {
  it('accepts the exact body a GET returned, unchanged', () => {
    // What `GET /api/v1/drm/config` serialises, including the derived
    // `credentials` status field.
    const view = toDrmConfigView(VALID_CONFIG, {});
    expect(view.credentials).toBe('missing');
    // ...is a valid PUT body. No 400, not even a "nearly valid" one.
    expect(validateDrmStackConfig(view)).toEqual([]);
  });

  it("round-trips with credentials: 'configured' too, not only 'missing'", () => {
    const view = toDrmConfigView(VALID_CONFIG, {
      [ENV_USERNAME]: 'operator',
      [ENV_PASSWORD]: 'secret-value'
    });
    expect(view.credentials).toBe('configured');
    expect(validateDrmStackConfig(view)).toEqual([]);
    // Belt and braces: every member of the status union is an acceptable body.
    for (const status of DRM_CREDENTIAL_STATUSES) {
      expect(
        validateDrmStackConfig({ ...VALID_CONFIG, credentials: status })
      ).toEqual([]);
    }
  });

  it('writes the read-back body to the store, dropping the derived status field', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const paramStore = makeParamStore();
    const view = toDrmConfigView(VALID_CONFIG, {});

    await expect(
      storeDrmStackConfig(paramStore, 'ws-1', 'main', view)
    ).resolves.toBeUndefined();

    const written = paramStore.storeStackConfig.mock.calls[0]?.[2] as StackConfig;
    // The persisted block is the coordinates only: `credentials` is derived at
    // read time and is not stored state.
    expect(written.drm).toEqual(VALID_CONFIG);
    expect(Object.keys(written.drm ?? {})).not.toContain('credentials');
    // Other stack coordinates survive the read-modify-write.
    expect(written.couchdbUrl).toBe(STORED_STACK.couchdbUrl);
  });

  it('refuses a non-status value under the `credentials` name', () => {
    for (const bad of [
      { username: 'operator', password: 'hunter2' },
      'hunter2',
      ['hunter2']
    ]) {
      const errors = validateDrmStackConfig({
        ...VALID_CONFIG,
        credentials: bad
      });
      expect(errors.map((e) => e.field)).toContain('credentials');
      // The rejection names the field, never the submitted value.
      expect(JSON.stringify(errors)).not.toContain('hunter2');
    }
  });
});

// --- Finding 2 --------------------------------------------------------------
describe('write-path field allowlist (ADR-008 §5.2 field list)', () => {
  it('rejects a credential-shaped field the name denylist does not know', () => {
    for (const name of ['clientSecret', 'authToken', 'pwd', 'sessionKey']) {
      const errors = validateDrmStackConfig({
        ...VALID_CONFIG,
        [name]: 'super-secret-value'
      });
      expect(errors.length).toBeGreaterThan(0);
      expect(errors.map((e) => e.field)).toContain(name);
      expect(JSON.stringify(errors)).not.toContain('super-secret-value');
    }
  });

  it('never persists or returns such a field', async () => {
    process.env['DRM_ENABLED'] = 'true';
    const SECRET = 'LEAKED-CREDENTIAL-0xDEADBEEF';
    const smuggled = {
      ...VALID_CONFIG,
      clientSecret: SECRET
    } as unknown as DrmStackConfig;
    const paramStore = makeParamStore();

    await expect(
      storeDrmStackConfig(paramStore, 'ws-1', 'main', smuggled)
    ).rejects.toThrow(DrmConfigValidationFailure);
    expect(paramStore.storeStackConfig).not.toHaveBeenCalled();

    // And if such a block ever reached a response path anyway, the view does
    // not echo it: the projection keeps only the known coordinates.
    const view = toDrmConfigView(smuggled, {});
    expect(JSON.stringify(view)).not.toContain(SECRET);
    expect(Object.keys(view)).not.toContain('clientSecret');
    expect(JSON.stringify(projectDrmStackConfig(smuggled))).not.toContain(SECRET);
  });

  it("rejects a typo'd field instead of silently ignoring it", () => {
    // `scheem` would previously validate clean and then do nothing — the
    // operator's intended `scheme` change was lost without a word.
    const errors = validateDrmStackConfig({ ...VALID_CONFIG, scheem: 'cenc' });
    expect(errors.map((e) => e.field)).toContain('scheem');
    // The message tells the operator what IS allowed, so the typo is obvious.
    expect(errors.find((e) => e.field === 'scheem')?.reason).toContain('scheme');
  });

  it('rejects an unknown field even when every known field is valid', () => {
    // Also covers the ADR-008 §5.2 sketch keys the implemented model replaced
    // (`systemIds`, singular `certificateUrl`): they are not members of
    // `DrmStackConfig`, so they are refused rather than stored and ignored.
    for (const name of ['systemIds', 'certificateUrl', 'workspaceId']) {
      expect(
        validateDrmStackConfig({ ...VALID_CONFIG, [name]: 'whatever' }).map(
          (e) => e.field
        )
      ).toContain(name);
    }
  });

  it('allows every allowlisted field and nothing else', () => {
    // The allowlist and the fully populated valid config agree: the config
    // exercises every key, and validation accepts it.
    expect([...DRM_STACK_CONFIG_FIELD_NAMES].sort()).toEqual(
      Object.keys(VALID_CONFIG).sort()
    );
    expect(validateDrmStackConfig(VALID_CONFIG)).toEqual([]);
  });

  it('projectDrmStackConfig keeps the coordinates and drops everything else', () => {
    const projected = projectDrmStackConfig({
      ...VALID_CONFIG,
      credentials: 'configured',
      clientSecret: 'nope',
      scheem: 'cenc'
    } as unknown as DrmStackConfig);
    expect(projected).toEqual(VALID_CONFIG);
    expect(Object.keys(projected).sort()).toEqual(Object.keys(VALID_CONFIG).sort());
  });

  it('the store boundary refuses an unknown DRM field before any HTTP call', async () => {
    // Defence in depth: a writer that bypasses `storeDrmStackConfig` and sets
    // `StackConfig.drm` directly still cannot persist an unknown field, because
    // `storeStackConfig` asserts before it serialises
    // (param-store.ts:`assertNoCredentials` → `assertNoDrmCredentials`).
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const store = makeHttpParamStore({
      baseUrl: 'https://config.example.test/',
      getOscToken: async () => 'test-sat',
      apiKey: 'key123',
      fetch: fetch as unknown as typeof globalThis.fetch
    });

    await expect(
      store.storeStackConfig('ws-1', 'main', {
        ...STORED_STACK,
        drm: { ...VALID_CONFIG, clientSecret: 'nope' } as unknown as DrmStackConfig
      })
    ).rejects.toThrow(/unknown field "clientSecret"/);
    expect(fetch).not.toHaveBeenCalled();

    // The same writer succeeds with a clean block, so the guard is specific to
    // the unknown key rather than refusing DRM writes wholesale.
    await expect(
      store.storeStackConfig('ws-1', 'main', { ...STORED_STACK, drm: VALID_CONFIG })
    ).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
