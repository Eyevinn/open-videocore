import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  resolveEncoreProfilesUrl,
  resolveEncoreProfilesUrlFromParamStore,
  resolvePublicBaseUrl,
  LOCAL_PROFILES_INDEX_PATH,
  STACK_ENCORE_PROFILES_URL_FIELD
} from './public-base-url.js';

const DEFAULT_INDEX =
  'https://raw.githubusercontent.com/Eyevinn/encore-test-profiles/refs/heads/main/profiles.yml';

// Save/restore the env vars this resolver reads so tests never leak state.
const SAVED = {
  override: process.env['ENCORE_PROFILES_URL_OVERRIDE'],
  base: process.env['PUBLIC_BASE_URL'],
  oscHostname: process.env['OSC_HOSTNAME']
};

beforeEach(() => {
  delete process.env['ENCORE_PROFILES_URL_OVERRIDE'];
  delete process.env['PUBLIC_BASE_URL'];
  delete process.env['OSC_HOSTNAME'];
});

afterEach(() => {
  if (SAVED.override === undefined) delete process.env['ENCORE_PROFILES_URL_OVERRIDE'];
  else process.env['ENCORE_PROFILES_URL_OVERRIDE'] = SAVED.override;
  if (SAVED.base === undefined) delete process.env['PUBLIC_BASE_URL'];
  else process.env['PUBLIC_BASE_URL'] = SAVED.base;
  if (SAVED.oscHostname === undefined) delete process.env['OSC_HOSTNAME'];
  else process.env['OSC_HOSTNAME'] = SAVED.oscHostname;
});

describe('resolveEncoreProfilesUrl precedence (issue #315)', () => {
  it('tier 1: ENCORE_PROFILES_URL_OVERRIDE wins over every lower tier', () => {
    process.env['ENCORE_PROFILES_URL_OVERRIDE'] = 'https://custom.example/index.yml';
    process.env['PUBLIC_BASE_URL'] = 'https://app.example';
    const result = resolveEncoreProfilesUrl(
      DEFAULT_INDEX,
      'https://paramstore.example/index.yml'
    );
    expect(result).toBe('https://custom.example/index.yml');
  });

  it('tier 1: override is normalised (trailing slashes stripped)', () => {
    process.env['ENCORE_PROFILES_URL_OVERRIDE'] = 'https://custom.example/index.yml//';
    expect(resolveEncoreProfilesUrl(DEFAULT_INDEX, 'https://paramstore.example/x')).toBe(
      'https://custom.example/index.yml'
    );
  });

  it('tier 2: PUBLIC_BASE_URL derivation wins over the param-store value', () => {
    process.env['PUBLIC_BASE_URL'] = 'https://app.example';
    const result = resolveEncoreProfilesUrl(
      DEFAULT_INDEX,
      'https://paramstore.example/index.yml'
    );
    expect(result).toBe(`https://app.example${LOCAL_PROFILES_INDEX_PATH}`);
  });

  it('tier 3: param-store value is used DIRECTLY when no env-var seam is set', () => {
    const result = resolveEncoreProfilesUrl(
      DEFAULT_INDEX,
      'https://paramstore.example/custom/index.yml'
    );
    expect(result).toBe('https://paramstore.example/custom/index.yml');
  });

  it('tier 3: param-store value is normalised (trailing slashes stripped)', () => {
    const result = resolveEncoreProfilesUrl(
      DEFAULT_INDEX,
      'https://paramstore.example/custom/index.yml///'
    );
    expect(result).toBe('https://paramstore.example/custom/index.yml');
  });

  it('tier 4 fall-through: UNSET param-store value is byte-identical to pre-#315', () => {
    // No arg at all — exactly how existing callers invoked it before #315.
    expect(resolveEncoreProfilesUrl(DEFAULT_INDEX)).toBe(DEFAULT_INDEX);
    // Explicit undefined — same result.
    expect(resolveEncoreProfilesUrl(DEFAULT_INDEX, undefined)).toBe(DEFAULT_INDEX);
    // Empty string is treated as unset, not as a URL.
    expect(resolveEncoreProfilesUrl(DEFAULT_INDEX, '')).toBe(DEFAULT_INDEX);
  });

  it('resolvePublicBaseUrl returns undefined when neither PUBLIC_BASE_URL nor OSC_HOSTNAME is set', () => {
    expect(resolvePublicBaseUrl()).toBeUndefined();
  });

  it('resolvePublicBaseUrl derives from OSC_HOSTNAME when PUBLIC_BASE_URL is unset (issue #283)', () => {
    process.env['OSC_HOSTNAME'] = 'my-app.osaas.io';
    expect(resolvePublicBaseUrl()).toBe('https://my-app.osaas.io');
  });

  it('resolvePublicBaseUrl: explicit PUBLIC_BASE_URL wins over OSC_HOSTNAME', () => {
    process.env['PUBLIC_BASE_URL'] = 'https://app.example';
    process.env['OSC_HOSTNAME'] = 'my-app.osaas.io';
    expect(resolvePublicBaseUrl()).toBe('https://app.example');
  });

  it('resolvePublicBaseUrl normalises OSC_HOSTNAME (trailing slashes stripped)', () => {
    process.env['OSC_HOSTNAME'] = 'my-app.osaas.io//';
    expect(resolvePublicBaseUrl()).toBe('https://my-app.osaas.io');
  });

  it('tier 2: OSC_HOSTNAME-derived base flows through resolveEncoreProfilesUrl', () => {
    process.env['OSC_HOSTNAME'] = 'my-app.osaas.io';
    const result = resolveEncoreProfilesUrl(
      DEFAULT_INDEX,
      'https://paramstore.example/index.yml'
    );
    expect(result).toBe(`https://my-app.osaas.io${LOCAL_PROFILES_INDEX_PATH}`);
  });
});

describe('resolveEncoreProfilesUrlFromParamStore (issue #315)', () => {
  const NS = 'default';

  it('returns undefined when there is no parameter store', async () => {
    const result = await resolveEncoreProfilesUrlFromParamStore({
      paramStore: undefined,
      namespace: NS
    });
    expect(result).toBeUndefined();
  });

  it('returns undefined when no stack is provisioned', async () => {
    const paramStore = {
      listStackNames: vi.fn(async () => [] as string[]),
      loadStackConfig: vi.fn(async () => undefined)
    };
    const result = await resolveEncoreProfilesUrlFromParamStore({ paramStore, namespace: NS });
    expect(result).toBeUndefined();
    expect(paramStore.loadStackConfig).not.toHaveBeenCalled();
  });

  it('returns the stored full profiles-index URL from the first stack', async () => {
    const paramStore = {
      listStackNames: vi.fn(async () => ['mystack']),
      loadStackConfig: vi.fn(async () => ({
        [STACK_ENCORE_PROFILES_URL_FIELD]: 'https://paramstore.example/index.yml'
      }))
    };
    const result = await resolveEncoreProfilesUrlFromParamStore({ paramStore, namespace: NS });
    expect(result).toBe('https://paramstore.example/index.yml');
    expect(paramStore.loadStackConfig).toHaveBeenCalledWith(NS, 'mystack');
  });

  it('returns undefined (back-compat) when the field is absent from the stack config', async () => {
    const paramStore = {
      listStackNames: vi.fn(async () => ['mystack']),
      loadStackConfig: vi.fn(
        async (): Promise<{ encoreProfilesUrl?: string; minioEndpoint: string }> => ({
          minioEndpoint: 'http://minio:9000'
        })
      )
    };
    const result = await resolveEncoreProfilesUrlFromParamStore({ paramStore, namespace: NS });
    expect(result).toBeUndefined();
  });

  it('treats an empty stored value as unset', async () => {
    const paramStore = {
      listStackNames: vi.fn(async () => ['mystack']),
      loadStackConfig: vi.fn(async () => ({ [STACK_ENCORE_PROFILES_URL_FIELD]: '' }))
    };
    const result = await resolveEncoreProfilesUrlFromParamStore({ paramStore, namespace: NS });
    expect(result).toBeUndefined();
  });

  it('swallows read errors and reports via onError, resolving undefined', async () => {
    const boom = new Error('param store down');
    const paramStore = {
      listStackNames: vi.fn(async () => {
        throw boom;
      }),
      loadStackConfig: vi.fn(async () => undefined)
    };
    const onError = vi.fn();
    const result = await resolveEncoreProfilesUrlFromParamStore({
      paramStore,
      namespace: NS,
      onError
    });
    expect(result).toBeUndefined();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('end-to-end: a stored value flows through the resolver as tier 3', async () => {
    const paramStore = {
      listStackNames: vi.fn(async () => ['mystack']),
      loadStackConfig: vi.fn(async () => ({
        [STACK_ENCORE_PROFILES_URL_FIELD]: 'https://paramstore.example/index.yml'
      }))
    };
    const fromStore = await resolveEncoreProfilesUrlFromParamStore({ paramStore, namespace: NS });
    expect(resolveEncoreProfilesUrl(DEFAULT_INDEX, fromStore)).toBe(
      'https://paramstore.example/index.yml'
    );
  });
});
