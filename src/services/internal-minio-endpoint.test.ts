import { describe, expect, it, vi } from 'vitest';
import {
  deriveInternalMinioEndpoint,
  makeHealthProbe,
  makeInternalEndpointResolver
} from './internal-minio-endpoint.js';
import { resolveEncoreS3Config } from './encore-s3-config.js';
import type { ParamStore, StackConfig } from './param-store.js';

const PUBLIC = 'https://teamnenda-nendavodstg.minio-minio.auto.prod-se.osaas.io';
const INTERNAL = 'http://teamnenda-nendavodstg.minio-minio.svc.cluster.local:8080';

const log = () => ({ error: vi.fn(), warn: vi.fn() });

describe('deriveInternalMinioEndpoint', () => {
  it('maps an OSC MinIO instance URL to its in-cluster Service', () => {
    expect(deriveInternalMinioEndpoint(PUBLIC)).toBe(INTERNAL);
  });

  it('honours a port override', () => {
    expect(deriveInternalMinioEndpoint(PUBLIC, 9000)).toBe(
      'http://teamnenda-nendavodstg.minio-minio.svc.cluster.local:9000'
    );
  });

  it.each([
    'https://s3.amazonaws.com',
    'http://localhost:9000',
    'https://mediastack-minio.example.test',
    'https://other.notminio.auto.prod-se.osaas.io',
    'not a url',
    ''
  ])('returns undefined for a non-OSC-MinIO endpoint: %s', (url) => {
    expect(deriveInternalMinioEndpoint(url)).toBeUndefined();
  });
});

describe('makeHealthProbe', () => {
  it('is true only on HTTP 200 from the MinIO liveness path', async () => {
    const fetchFn = vi.fn(async (_url: string, _init?: unknown) => new Response('', { status: 200 }));
    expect(await makeHealthProbe(1000, fetchFn as unknown as typeof fetch)(INTERNAL)).toBe(true);
    expect(fetchFn.mock.calls[0]![0]).toBe(`${INTERNAL}/minio/health/live`);
  });

  it('is false on a non-200 and on a network error, never throws', async () => {
    const bad = vi.fn(async (_url: string) => new Response('', { status: 503 }));
    expect(await makeHealthProbe(1000, bad as unknown as typeof fetch)(INTERNAL)).toBe(false);
    const boom = vi.fn(async (_url: string) => {
      throw new Error('getaddrinfo ENOTFOUND');
    });
    expect(await makeHealthProbe(1000, boom as unknown as typeof fetch)(INTERNAL)).toBe(false);
  });
});

describe('makeInternalEndpointResolver', () => {
  it('passing path: returns the internal endpoint when the probe succeeds', async () => {
    const probe = vi.fn(async () => true);
    const l = log();
    const resolve = makeInternalEndpointResolver({ enabled: true, probe, log: l });
    expect(await resolve(PUBLIC)).toBe(INTERNAL);
    expect(probe).toHaveBeenCalledWith(INTERNAL);
    expect(l.warn).not.toHaveBeenCalled();
  });

  it('fallback: keeps the public endpoint and warns when the probe fails', async () => {
    const l = log();
    const resolve = makeInternalEndpointResolver({ enabled: true, probe: async () => false, log: l });
    expect(await resolve(PUBLIC)).toBe(PUBLIC);
    expect(l.warn).toHaveBeenCalledOnce();
  });

  it('fallback: keeps the public endpoint when the probe throws', async () => {
    const l = log();
    const resolve = makeInternalEndpointResolver({
      enabled: true,
      probe: async () => {
        throw new Error('x');
      },
      log: l
    });
    expect(await resolve(PUBLIC)).toBe(PUBLIC);
  });

  it('fallback: keeps a non-derivable endpoint without probing, and warns', async () => {
    const probe = vi.fn(async () => true);
    const l = log();
    const resolve = makeInternalEndpointResolver({ enabled: true, probe, log: l });
    expect(await resolve('https://byo-minio.example.test')).toBe('https://byo-minio.example.test');
    expect(probe).not.toHaveBeenCalled();
    expect(l.warn).toHaveBeenCalledOnce();
  });

  it('opt-out: returns the public endpoint untouched and never probes', async () => {
    const probe = vi.fn(async () => true);
    const resolve = makeInternalEndpointResolver({ enabled: false, probe, log: log() });
    expect(await resolve(PUBLIC)).toBe(PUBLIC);
    expect(probe).not.toHaveBeenCalled();
  });

  it('caches probe results, and retries a failure after the negative TTL', async () => {
    let t = 0;
    const results = [false, true];
    const probe = vi.fn(async () => results.shift() ?? true);
    const resolve = makeInternalEndpointResolver({
      enabled: true,
      probe,
      log: log(),
      negativeTtlMs: 1000,
      positiveTtlMs: 10_000,
      now: () => t
    });
    expect(await resolve(PUBLIC)).toBe(PUBLIC); // probe #1 fails
    expect(await resolve(PUBLIC)).toBe(PUBLIC); // cached negative
    expect(probe).toHaveBeenCalledTimes(1);
    t = 1500;
    expect(await resolve(PUBLIC)).toBe(INTERNAL); // probe #2 passes
    expect(await resolve(PUBLIC)).toBe(INTERNAL); // cached positive
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('resolveEncoreS3Config with resolveEndpoint', () => {
  const stack = { minioEndpoint: PUBLIC } as unknown as StackConfig;
  const paramStore = {
    loadStackConfig: async () => stack,
    listStackNames: async () => []
  } as unknown as ParamStore;
  const deps = (resolveEndpoint?: (e: string) => Promise<string>) => ({
    paramStore,
    secretAccessKey: 'pw',
    staticFallbackConfigured: false,
    log: log(),
    ...(resolveEndpoint ? { resolveEndpoint } : {})
  });

  it('hands Encore the resolved (internal) endpoint', async () => {
    const resolve = makeInternalEndpointResolver({ enabled: true, probe: async () => true, log: log() });
    expect(await resolveEncoreS3Config(deps(resolve), 'nendavodstg')).toEqual({
      endpoint: INTERNAL,
      accessKeyId: 'admin',
      secretAccessKey: 'pw'
    });
  });

  it('falls back to the public endpoint when the internal one is unusable', async () => {
    const resolve = makeInternalEndpointResolver({ enabled: true, probe: async () => false, log: log() });
    const cfg = await resolveEncoreS3Config(deps(resolve), 'nendavodstg');
    expect(cfg?.endpoint).toBe(PUBLIC);
  });

  it('is unchanged when no resolveEndpoint hook is supplied', async () => {
    const cfg = await resolveEncoreS3Config(deps(), 'nendavodstg');
    expect(cfg?.endpoint).toBe(PUBLIC);
  });
});
