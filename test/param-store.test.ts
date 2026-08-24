import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  ensureParameterStore,
  makeHttpParamStore,
  PARAM_STORE_SERVICE_ID,
  stackConfigKey,
  stripCredentials,
  type OscInstanceApi,
  type StackConfig
} from '../src/services/param-store.js';

const sampleConfig: StackConfig = {
  minioEndpoint: 'https://minio.example.osaas.io',
  couchdbUrl: 'https://couch.example.osaas.io',
  redisUrl: 'redis://valkey.svc.cluster.local:6379',
  encoreUrl: 'https://encore.example.osaas.io',
  encoreCallbackUrl: 'https://callback.example.osaas.io',
  sourceBucket: 'openvideocore-source',
  packagedBucket: 'openvideocore-packaged',
  services: [{ serviceId: 'minio-minio', instanceName: 'mystack' }]
};

describe('stripCredentials', () => {
  it('removes userinfo from a connection URL', () => {
    expect(
      stripCredentials('postgresql://user:secret@host:5432/db')
    ).toBe('postgresql://host:5432/db');
  });

  it('leaves a credential-free URL unchanged', () => {
    expect(stripCredentials('https://host.example.io')).toBe(
      'https://host.example.io/'
    );
  });

  it('strips userinfo from a non-standard scheme via regex fallback', () => {
    expect(stripCredentials('redis://:pass@host:6379')).toBe(
      'redis://host:6379'
    );
  });
});

describe('stackConfigKey', () => {
  it('namespaces by workspace under the openvideocore prefix', () => {
    expect(stackConfigKey('workspace-a', 'mystack')).toBe(
      'openvideocore/workspace-a/mystack'
    );
  });
});

describe('makeHttpParamStore', () => {
  it('writes the config as a JSON value with bearer auth', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 200 }));
    const store = makeHttpParamStore({
      baseUrl: 'https://config.example.osaas.io/',
      getOscToken: async () => 'test-sat',
      apiKey: 'key123',
      fetch: fetch as unknown as typeof globalThis.fetch
    });

    await store.storeStackConfig('workspace-a', 'mystack', sampleConfig);

    // Confirmed contract (smoke test 2026-06-01): create is POST /api/v1/config { key, value }
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/v1/config');
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h['authorization']).toBe('Bearer test-sat');
    expect(h['x-api-key']).toBe('key123');
    const body = JSON.parse(init.body as string) as { key: string; value: string };
    expect(body.key).toBe('openvideocore/workspace-a/mystack');
    expect(JSON.parse(body.value)).toEqual(sampleConfig);
  });

  it('refuses to store a credential-bearing value', async () => {
    const fetch = vi.fn();
    const store = makeHttpParamStore({
      baseUrl: 'https://config.example.osaas.io',
      getOscToken: async () => 'test-sat',
      apiKey: 'key123',
      fetch: fetch as unknown as typeof globalThis.fetch
    });

    await expect(
      store.storeStackConfig('workspace-a', 'mystack', {
        ...sampleConfig,
        couchdbUrl: 'https://user:secret@couch.example.osaas.io'
      })
    ).rejects.toThrow(/refusing to store credential-bearing/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads back and parses a stored config', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ value: JSON.stringify(sampleConfig) }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
    );
    const store = makeHttpParamStore({
      baseUrl: 'https://config.example.osaas.io',
      getOscToken: async () => 'test-sat',
      apiKey: 'key123',
      fetch: fetch as unknown as typeof globalThis.fetch
    });

    const loaded = await store.loadStackConfig('workspace-a', 'mystack');
    expect(loaded).toEqual(sampleConfig);
  });

  it('returns undefined on a 404 (no stored config)', async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 404 }));
    const store = makeHttpParamStore({
      baseUrl: 'https://config.example.osaas.io',
      getOscToken: async () => 'test-sat',
      apiKey: 'key123',
      fetch: fetch as unknown as typeof globalThis.fetch
    });

    expect(await store.loadStackConfig('workspace-a', 'ghost')).toBeUndefined();
  });

  it('throws on a non-404 read error', async () => {
    const fetch = vi.fn(async () => new Response('boom', { status: 500 }));
    const store = makeHttpParamStore({
      baseUrl: 'https://config.example.osaas.io',
      getOscToken: async () => 'test-sat',
      apiKey: 'key123',
      fetch: fetch as unknown as typeof globalThis.fetch
    });

    await expect(
      store.loadStackConfig('workspace-a', 'mystack')
    ).rejects.toThrow(/parameter store read failed: 500/);
  });
});

describe('makeHttpParamStore retry-with-backoff (issue #421)', () => {
  // A no-op sleep so backoff waits resolve instantly in tests (the retry policy
  // is exercised; the wall-clock backoff itself is unit-irrelevant here).
  const noSleep = async () => {};

  it('retries a transient failure then succeeds within the retry budget (listStackNames)', async () => {
    const key = stackConfigKey('workspace-a', 'mystack');
    const okBody = JSON.stringify({ items: [{ key }] });
    const fetch = vi
      .fn()
      // First round-trip: a TLS blip (fetch rejects), as observed at boot.
      .mockRejectedValueOnce(new Error('self-signed certificate in certificate chain'))
      // Second round-trip: succeeds.
      .mockResolvedValueOnce(
        new Response(okBody, {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    const debug = vi.fn();
    const store = makeHttpParamStore({
      baseUrl: 'https://config.example.osaas.io',
      getOscToken: async () => 'test-sat',
      apiKey: 'key123',
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: noSleep,
      log: { debug }
    });

    const names = await store.listStackNames('workspace-a');

    expect(names).toEqual(['mystack']);
    expect(fetch).toHaveBeenCalledTimes(2);
    // The transient failure was logged at debug before the successful retry.
    expect(debug).toHaveBeenCalledOnce();
  });

  it('retries a transient 5xx then succeeds (loadStackConfig)', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('boom', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ value: JSON.stringify(sampleConfig) }), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      );
    const store = makeHttpParamStore({
      baseUrl: 'https://config.example.osaas.io',
      getOscToken: async () => 'test-sat',
      apiKey: 'key123',
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: noSleep
    });

    const loaded = await store.loadStackConfig('workspace-a', 'mystack');
    expect(loaded).toEqual(sampleConfig);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('exhausts retries on persistent failure and propagates the error to the fallback', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('ETIMEDOUT');
    });
    const error = vi.fn();
    const store = makeHttpParamStore({
      baseUrl: 'https://config.example.osaas.io',
      getOscToken: async () => 'test-sat',
      apiKey: 'key123',
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: noSleep,
      retry: { attempts: 3 },
      log: { error }
    });

    await expect(store.listStackNames('workspace-a')).rejects.toThrow(/ETIMEDOUT/);
    // 3 attempts total (1 + 2 retries), then propagates (issue #420 fallback).
    expect(fetch).toHaveBeenCalledTimes(3);
    // Exhaustion is logged at error before handing off.
    expect(error).toHaveBeenCalledOnce();
  });

  it('does NOT retry a 4xx auth/config failure (hard failure)', async () => {
    const fetch = vi.fn(async () => new Response('forbidden', { status: 403 }));
    const warn = vi.fn();
    const store = makeHttpParamStore({
      baseUrl: 'https://config.example.osaas.io',
      getOscToken: async () => 'test-sat',
      apiKey: 'key123',
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: noSleep,
      log: { warn }
    });

    await expect(store.listStackNames('workspace-a')).rejects.toThrow(
      /parameter store list failed: 403/
    );
    // A single attempt — a 403 will not self-correct, so no retry.
    expect(fetch).toHaveBeenCalledOnce();
    expect(warn).toHaveBeenCalledOnce();
  });

  it('honours the attempts cap (single attempt when attempts=1)', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('ECONNRESET');
    });
    const store = makeHttpParamStore({
      baseUrl: 'https://config.example.osaas.io',
      getOscToken: async () => 'test-sat',
      apiKey: 'key123',
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: noSleep,
      retry: { attempts: 1 }
    });

    await expect(store.loadStackConfig('workspace-a', 'mystack')).rejects.toThrow(
      /ECONNRESET/
    );
    expect(fetch).toHaveBeenCalledOnce();
  });
});

describe('ensureParameterStore', () => {
  const log = { info: vi.fn(), warn: vi.fn() };

  function makeOsc(overrides: Partial<OscInstanceApi> = {}): OscInstanceApi {
    return {
      getServiceAccessToken: vi.fn(async () => 'sat'),
      getInstance: vi.fn(async () => undefined),
      createInstance: vi.fn(async () => ({ name: 'openvideocore-config' })),
      ...overrides
    };
  }

  beforeEach(() => {
    process.env['PARAMETER_STORE_API_KEY'] = 'key123';
    delete process.env['PARAMETER_STORE_INSTANCE_NAME'];
    log.info.mockReset();
    log.warn.mockReset();
  });

  afterEach(() => {
    delete process.env['PARAMETER_STORE_API_KEY'];
    delete process.env['PARAMETER_STORE_INSTANCE_NAME'];
  });

  it('returns false and does nothing when unconfigured', async () => {
    delete process.env['PARAMETER_STORE_API_KEY'];
    const osc = makeOsc();
    expect(await ensureParameterStore({ osc, log })).toBe(false);
    expect(osc.getInstance).not.toHaveBeenCalled();
  });

  it('creates the instance with the ConfigApiKey when it does not exist', async () => {
    const osc = makeOsc();
    expect(await ensureParameterStore({ osc, log })).toBe(true);
    expect(osc.createInstance).toHaveBeenCalledWith(
      PARAM_STORE_SERVICE_ID,
      'sat',
      // OSC instance names must be alphanumeric-only (no hyphens) — smoke-test
      // finding, mirrored by DEFAULT_PARAM_STORE_INSTANCE_NAME in param-store.ts.
      { name: 'ovcconfig', ConfigApiKey: 'key123' }
    );
  });

  it('is idempotent: does not create when the instance already exists', async () => {
    const osc = makeOsc({ getInstance: vi.fn(async () => ({ name: 'openvideocore-config' })) });
    expect(await ensureParameterStore({ osc, log })).toBe(true);
    expect(osc.createInstance).not.toHaveBeenCalled();
  });

  it('honours PARAMETER_STORE_INSTANCE_NAME', async () => {
    process.env['PARAMETER_STORE_INSTANCE_NAME'] = 'my-config';
    const osc = makeOsc();
    await ensureParameterStore({ osc, log });
    expect(osc.getInstance).toHaveBeenCalledWith(PARAM_STORE_SERVICE_ID, 'my-config', 'sat');
    expect(osc.createInstance).toHaveBeenCalledWith(
      PARAM_STORE_SERVICE_ID,
      'sat',
      { name: 'my-config', ConfigApiKey: 'key123' }
    );
  });

  it('degrades gracefully: warns and returns false on OSC failure', async () => {
    const osc = makeOsc({
      getInstance: vi.fn(async () => {
        throw new Error('osc down');
      })
    });
    expect(await ensureParameterStore({ osc, log })).toBe(false);
    expect(log.warn).toHaveBeenCalledOnce();
    expect(osc.createInstance).not.toHaveBeenCalled();
  });
});
