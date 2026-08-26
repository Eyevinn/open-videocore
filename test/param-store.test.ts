import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import pino from 'pino';
import {
  ensureParameterStore,
  makeHttpParamStore,
  PARAM_STORE_SERVICE_ID,
  stackConfigKey,
  stripCredentials,
  type OscInstanceApi,
  type ParamStoreLogger,
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

// Regression test for issue #440 (crash from #437, fix from #438).
//
// #437 crashed at runtime with `TypeError: this[writeSym] is not a function`.
// Root cause: makeHttpParamStore built its diagnostic logger by SPREADING the
// injected logger into a plain object — `const diag = { ...NOOP, ...config.log }`
// (src/services/param-store.ts:353). A real pino instance exposes its level
// methods (info/warn/debug/error) as OWN-ENUMERABLE properties bound to the
// instance's internal `writeSym`. Spreading copies the function REFERENCES but
// rebinds `this` to the plain `diag` object at call time; the plain object has
// no `writeSym`, so the first diag.* call throws.
//
// In production the logger passed to paramStoreFromEnv is `app.log` — a live
// pino instance (src/main.ts:210) — so the bug only manifests with a real pino
// logger, never with the vi.fn() stubs used by the tests above. This test wires
// a REAL pino instance to reproduce it.
//
// Expected: FAILS on the pre-fix spread implementation (the diag call throws),
// PASSES once #438 lands (call THROUGH the logger instead of spreading it).
describe('makeHttpParamStore diagnostic logger binding (issue #440 regression)', () => {
  const noSleep = async () => {};

  // A real pino instance writing each JSON log line into `lines`, so we can
  // assert the underlying logger actually received the original object + message
  // (not merely that no error was thrown). pino level codes: debug=20, info=30,
  // warn=40, error=50 (confirmed against pino@10 in node_modules).
  function makeCapturingPino(): { logger: ParamStoreLogger; lines: Array<Record<string, unknown>> } {
    const lines: Array<Record<string, unknown>> = [];
    const logger = pino(
      { level: 'debug' },
      {
        write(chunk: string) {
          lines.push(JSON.parse(chunk) as Record<string, unknown>);
        }
      }
    );
    return { logger, lines };
  }

  it('invokes info/warn/debug/error through a real pino logger without detaching (none throw; underlying logger receives obj+msg)', async () => {
    const { logger, lines } = makeCapturingPino();

    // storeStackConfig emits diag.warn (write-failure path) then throws on !ok;
    // a successful write emits diag.info. Drive a success to exercise diag.info.
    const okFetch = vi.fn(async () => new Response(null, { status: 200 }));
    const store = makeHttpParamStore({
      baseUrl: 'https://config.example.osaas.io',
      getOscToken: async () => 'test-sat',
      apiKey: 'key123',
      fetch: okFetch as unknown as typeof globalThis.fetch,
      sleep: noSleep,
      log: logger
    });

    // On the pre-fix spread build, this throws `this[writeSym] is not a function`
    // at the first diag.info call INSIDE storeStackConfig — the assertion that it
    // resolves is what catches the regression.
    await expect(
      store.storeStackConfig('workspace-a', 'mystack', {
        minioEndpoint: 'https://minio.example.osaas.io',
        couchdbUrl: 'https://couch.example.osaas.io',
        redisUrl: 'redis://valkey.svc.cluster.local:6379',
        sourceBucket: 'openvideocore-source',
        packagedBucket: 'openvideocore-packaged',
        services: [{ serviceId: 'minio-minio', instanceName: 'mystack' }]
      })
    ).resolves.toBeUndefined();

    // The underlying pino logger actually received the diagnostic object + msg
    // (info level 30), proving we called THROUGH it, not into a detached copy.
    const info = lines.find((l) => l['level'] === 30);
    expect(info).toBeDefined();
    expect(info?.['op']).toBe('storeStackConfig');
    expect(info?.['key']).toBe(stackConfigKey('workspace-a', 'mystack'));
    expect(info?.['msg']).toBe('param-store write ok');
  });

  it('exercises every diag level (debug on retry, error on exhaustion) through the real pino logger', async () => {
    const { logger, lines } = makeCapturingPino();

    // Persistent transient failure: withRetry logs diag.debug on the first
    // retryable attempt and diag.error on exhaustion. Both call sites live on
    // the SAME resolved `diag`, so both must survive the spread-vs-callthrough
    // fix. On the buggy build the first diag.debug throws.
    const fetch = vi.fn(async () => {
      throw new Error('ETIMEDOUT');
    });
    const store = makeHttpParamStore({
      baseUrl: 'https://config.example.osaas.io',
      getOscToken: async () => 'test-sat',
      apiKey: 'key123',
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: noSleep,
      retry: { attempts: 3 },
      log: logger
    });

    // The refresh (listStackNames) fails persistently. The UNDERLYING ERROR
    // (ETIMEDOUT) must propagate — NOT `this[writeSym] is not a function` from
    // the logger detaching. On the pre-fix build the diag.debug call throws
    // first and masks ETIMEDOUT, so this assertion fails for the right reason.
    await expect(store.listStackNames('workspace-a')).rejects.toThrow(/ETIMEDOUT/);

    // debug (20) logged on each pre-exhaustion retry; error (50) on exhaustion.
    const debug = lines.find((l) => l['level'] === 20);
    const error = lines.find((l) => l['level'] === 50);
    expect(debug).toBeDefined();
    expect(debug?.['op']).toBe('listStackNames');
    expect(error).toBeDefined();
    expect(error?.['op']).toBe('listStackNames');
    // The exhaustion record carries the real underlying error, not the logger's.
    expect(error?.['error']).toMatch(/ETIMEDOUT/);
    expect(error?.['msg']).toBe('param-store call exhausted retries; handing off to fallback');
  });

  it('logs the underlying param-store refresh failure rather than the logger throwing (non-retryable 4xx via withRetry)', async () => {
    const { logger, lines } = makeCapturingPino();

    // A 403 is a NonRetryableParamStoreError: withRetry logs diag.warn then
    // rethrows immediately. The rethrown error must be the param-store failure,
    // never a logger self-crash.
    const fetch = vi.fn(async () => new Response('forbidden', { status: 403 }));
    const store = makeHttpParamStore({
      baseUrl: 'https://config.example.osaas.io',
      getOscToken: async () => 'test-sat',
      apiKey: 'key123',
      fetch: fetch as unknown as typeof globalThis.fetch,
      sleep: noSleep,
      log: logger
    });

    await expect(store.listStackNames('workspace-a')).rejects.toThrow(
      /parameter store list failed: 403/
    );

    const warn = lines.find((l) => l['level'] === 40);
    expect(warn).toBeDefined();
    expect(warn?.['op']).toBe('listStackNames');
    expect(warn?.['error']).toMatch(/parameter store list failed: 403/);
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
