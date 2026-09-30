import { describe, it, expect, vi } from 'vitest';

// Unit coverage for the in-cluster object-store endpoint used by the spawned
// transcoders (issue #991) and for its wiring into the single resolver both
// scaler spawn paths take.
//
// What #991 requires this file to prove:
//   1. a new spawn gets the IN-CLUSTER endpoint when it is derivable and healthy;
//   2. it falls back to the PUBLIC endpoint (plus a warning) when the live probe
//      fails — the cross-cluster case CLAUDE.md warns about;
//   3. it falls back when the host shape is not derivable (bring-your-own store);
//   4. the opt-out env var switches the whole thing off, with no probe at all;
//   5. resolveEncoreS3Config behaves correctly WITH and WITHOUT the hook, and a
//      static ENCORE_S3_ENDPOINT override is honoured verbatim;
//   6. client-facing presigned URLs are UNCHANGED — still on the public host.
//
//   7. the PLATFORM contract (`getInternalEndpoint`) is the primary source of
//      the in-cluster address, with derivation kept only as the fallback;
//   8. the endpoint-provenance gate: a stack-config endpoint is mapped even when
//      a static ENCORE_S3_ENDPOINT pair is configured, while a value that truly
//      originates from ENCORE_S3_ENDPOINT never reaches the hook.
//
// Contract sources verified before writing (per CLAUDE.md rule 7):
//   - `getInternalEndpoint(context: Context, serviceId: string, name: string,
//     token: string): Promise<InternalEndpointInfo>` with
//     `InternalEndpointInfo = { serviceDns: string; ports: Array<{ name: string;
//     port: number; protocol: string }>; publicAccess: boolean }` —
//     node_modules/@osaas/client-core/lib/core.d.ts:130-148 (0.24.0),
//     re-exported from lib/index.d.ts:6.
//   - `Context.getServiceAccessToken(serviceId: string): Promise<string>`
//     (@osaas/client-core lib/context.d.ts:25).
//   - `StackConfig.services: { serviceId: string; instanceName: string }[]`
//     (src/services/param-store.ts) and OBJECT_STORE_SERVICE_ID
//     (src/services/stack.ts).
//   - resolveEncoreS3Config(deps: ResolveEncoreS3ConfigDeps, stackKey: string):
//     Promise<EncoreS3Config | undefined>, where ResolveEncoreS3ConfigDeps =
//     { paramStore, secretAccessKey, staticFallbackConfigured, log,
//       resolveEndpoint? } (src/services/encore-s3-config.ts).
//   - EncoreS3Config = { endpoint, accessKeyId, secretAccessKey, region? }
//     (src/encore-scaler/types.ts:24-29); `endpoint` is what the spawn body's
//     `s3Endpoint` is taken from (src/encore-scaler/instance-pool.ts:369).
//   - WorkspaceEncoreScalerConfig.resolveS3Config?: (stackKey: string) =>
//     Promise<EncoreS3Config | undefined>, consumed at BOTH spawn paths —
//     getOrCreate (src/encore-scaler/workspace-registry.ts:206-209) and
//     resumeExistingWorkspaces (:346-351) — so the two paths share one seam.
//   - ParamStore.loadStackConfig(workspaceId, name) / .listStackNames(workspaceId)
//     and StackConfig.minioEndpoint: string (src/services/param-store.ts:52-125).
//   - STACK_CONFIG_NAMESPACE (src/services/workspace-stack.ts).
//   - WorkspaceStorage.presignedPut(localKey, expirySeconds?) delegating to
//     minio Client.presignedPutObject(bucket, key, expiry)
//     (src/data/storage.ts:124-129).

import {
  DEFAULT_INTERNAL_PORT,
  INTERNAL_HEALTH_PATH,
  OBJECT_STORE_NAMESPACE,
  deriveInternalEndpoint,
  internalEndpointFromInfo,
  makeInternalEndpointProbe,
  makeInternalEndpointResolver,
  makeOscInternalEndpointLookup,
  resolveInternalEndpointSettings,
  selectInternalPort,
  type FetchLike,
  type GetInternalEndpointFn
} from './internal-minio-endpoint.js';
import { OBJECT_STORE_SERVICE_ID } from './stack.js';
import { resolveEncoreS3Config } from './encore-s3-config.js';
import { STACK_CONFIG_NAMESPACE } from './workspace-stack.js';
import type { ParamStore, StackConfig } from './param-store.js';
import { WorkspaceStorage } from '../data/storage.js';

const STACK_NAME = 'mediastack';
const PUBLIC_ENDPOINT = 'https://tenant-mediastack.minio-minio.auto.prod-se.osaas.io';
const INTERNAL_ENDPOINT = `http://tenant-mediastack.${OBJECT_STORE_NAMESPACE}.svc.cluster.local:${DEFAULT_INTERNAL_PORT}`;
const SECRET = 'object-store-root-password';

function makeLog() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  };
}

function makeStackConfig(overrides: Partial<StackConfig> = {}): StackConfig {
  return {
    status: 'ready',
    minioEndpoint: PUBLIC_ENDPOINT,
    couchdbUrl: 'https://tenant-mediastack.couchdb.auto.prod-se.osaas.io',
    redisUrl: 'redis://tenant-mediastack.valkey-io-valkey.svc.cluster.local:6379',
    sourceBucket: 'openvideocore-source',
    packagedBucket: 'openvideocore-packaged',
    services: [],
    ...overrides
  };
}

// Minimal in-memory ParamStore matching the real interface
// (src/services/param-store.ts:108-125).
function makeParamStore(config: StackConfig | undefined, name = STACK_NAME): ParamStore {
  const store = new Map<string, StackConfig>();
  if (config) store.set(`${STACK_CONFIG_NAMESPACE}/${name}`, config);
  return {
    storeStackConfig: async (ws, n, c) => {
      store.set(`${ws}/${n}`, c);
    },
    loadStackConfig: async (ws, n) => store.get(`${ws}/${n}`),
    deleteStackConfig: async (ws, n) => {
      store.delete(`${ws}/${n}`);
    },
    listStackNames: async (ws) =>
      [...store.keys()]
        .filter((k) => k.startsWith(`${ws}/`))
        .map((k) => k.slice(ws.length + 1))
  };
}

describe('deriveInternalEndpoint (issue #991)', () => {
  it('derives the in-cluster Service address from a managed public endpoint', () => {
    expect(deriveInternalEndpoint(PUBLIC_ENDPOINT)).toEqual({
      kind: 'derived',
      endpoint: INTERNAL_ENDPOINT
    });
  });

  it('uses the S3 API Service port, not the dead proxy port 80', () => {
    const derived = deriveInternalEndpoint(PUBLIC_ENDPOINT);
    expect(derived.kind === 'derived' && derived.endpoint.endsWith(':8080')).toBe(true);
  });

  it('honours an operator-supplied port override', () => {
    expect(deriveInternalEndpoint(PUBLIC_ENDPOINT, 9000)).toEqual({
      kind: 'derived',
      endpoint: `http://tenant-mediastack.${OBJECT_STORE_NAMESPACE}.svc.cluster.local:9000`
    });
  });

  it('is case-insensitive on the host', () => {
    expect(
      deriveInternalEndpoint('https://Tenant-MediaStack.MINIO-MINIO.auto.prod-se.osaas.io')
    ).toEqual({ kind: 'derived', endpoint: INTERNAL_ENDPOINT });
  });

  it('reports an endpoint that is already in-cluster rather than rewriting it', () => {
    expect(deriveInternalEndpoint(INTERNAL_ENDPOINT)).toEqual({ kind: 'already-internal' });
  });

  it.each([
    ['a bring-your-own store', 'https://s3.example.com'],
    ['a different service namespace', 'https://tenant-x.some-other-service.auto.prod-se.osaas.io'],
    ['a two-label host', 'https://minio-minio.localdomain'],
    ['a bare hostname', 'http://localhost:9000'],
    ['an IP address', 'http://10.0.0.5:9000'],
    ['a malformed URL', 'not a url at all']
  ])('refuses to derive from %s', (_label, endpoint) => {
    expect(deriveInternalEndpoint(endpoint).kind).toBe('not-derivable');
  });
});

describe('makeInternalEndpointProbe (issue #991)', () => {
  it('GETs the unauthenticated liveness path with a bounded timeout', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 200 })) as unknown as FetchLike;
    const probe = makeInternalEndpointProbe({ fetchImpl, timeoutMs: 1234 });

    await expect(probe(INTERNAL_ENDPOINT)).resolves.toBe(true);
    const calls = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(calls[0]?.[0]).toBe(`${INTERNAL_ENDPOINT}${INTERNAL_HEALTH_PATH}`);
    const init = calls[0]?.[1] as { method?: string; signal?: AbortSignal };
    expect(init.method).toBe('GET');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('treats a non-2xx response as unhealthy', async () => {
    const probe = makeInternalEndpointProbe({
      fetchImpl: (async () => ({ status: 503 })) as unknown as FetchLike
    });
    await expect(probe(INTERNAL_ENDPOINT)).resolves.toBe(false);
  });

  it('never throws — a rejected fetch (DNS/refused/timeout) is just unhealthy', async () => {
    const probe = makeInternalEndpointProbe({
      fetchImpl: (async () => {
        throw new Error('getaddrinfo ENOTFOUND');
      }) as unknown as FetchLike
    });
    await expect(probe(INTERNAL_ENDPOINT)).resolves.toBe(false);
  });
});

describe('makeInternalEndpointResolver (issue #991)', () => {
  it('PASSING PATH: uses the in-cluster endpoint when the probe succeeds', async () => {
    const log = makeLog();
    const probe = vi.fn(async () => true);
    const resolve = makeInternalEndpointResolver({ enabled: true, probe, log });

    await expect(resolve(PUBLIC_ENDPOINT)).resolves.toBe(INTERNAL_ENDPOINT);
    expect(probe).toHaveBeenCalledWith(INTERNAL_ENDPOINT);
    expect(log.warn).not.toHaveBeenCalled();
    // Adoption is logged once so an operator can confirm the ingress is out of
    // the data path without a line per spawn.
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('FALLBACK: returns the public endpoint and warns when the probe fails', async () => {
    const log = makeLog();
    const probe = vi.fn(async () => false);
    const resolve = makeInternalEndpointResolver({ enabled: true, probe, log });

    await expect(resolve(PUBLIC_ENDPOINT)).resolves.toBe(PUBLIC_ENDPOINT);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('FALLBACK: a probe that throws still fails soft to the public endpoint', async () => {
    const log = makeLog();
    const resolve = makeInternalEndpointResolver({
      enabled: true,
      probe: async () => {
        throw new Error('probe blew up');
      },
      log
    });

    await expect(resolve(PUBLIC_ENDPOINT)).resolves.toBe(PUBLIC_ENDPOINT);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('NON-DERIVABLE HOST: returns the endpoint untouched and never probes', async () => {
    const log = makeLog();
    const probe = vi.fn(async () => true);
    const resolve = makeInternalEndpointResolver({ enabled: true, probe, log });

    await expect(resolve('https://s3.example.com')).resolves.toBe('https://s3.example.com');
    expect(probe).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('OPT-OUT: returns the public endpoint with no probe and no warning', async () => {
    const log = makeLog();
    const probe = vi.fn(async () => true);
    const resolve = makeInternalEndpointResolver({ enabled: false, probe, log });

    await expect(resolve(PUBLIC_ENDPOINT)).resolves.toBe(PUBLIC_ENDPOINT);
    expect(probe).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
  });

  it('leaves an already-in-cluster endpoint alone without warning or probing', async () => {
    const log = makeLog();
    const probe = vi.fn(async () => true);
    const resolve = makeInternalEndpointResolver({ enabled: true, probe, log });

    await expect(resolve(INTERNAL_ENDPOINT)).resolves.toBe(INTERNAL_ENDPOINT);
    expect(probe).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('probes once per endpoint per TTL window, so a scale-up burst is not a probe burst', async () => {
    const log = makeLog();
    const probe = vi.fn(async () => true);
    let clock = 1_000;
    const resolve = makeInternalEndpointResolver({
      enabled: true,
      probe,
      log,
      positiveTtlMs: 60_000,
      now: () => clock
    });

    await Promise.all([
      resolve(PUBLIC_ENDPOINT),
      resolve(PUBLIC_ENDPOINT),
      resolve(PUBLIC_ENDPOINT)
    ]);
    expect(probe).toHaveBeenCalledTimes(1);

    clock += 59_000;
    await resolve(PUBLIC_ENDPOINT);
    expect(probe).toHaveBeenCalledTimes(1);

    // Past the TTL the state is re-established rather than trusted forever.
    clock += 2_000;
    await resolve(PUBLIC_ENDPOINT);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('re-probes an unhealthy endpoint after the shorter negative TTL and recovers', async () => {
    const log = makeLog();
    const probe = vi
      .fn<(endpoint: string) => Promise<boolean>>()
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);
    let clock = 0;
    const resolve = makeInternalEndpointResolver({
      enabled: true,
      probe,
      log,
      negativeTtlMs: 5_000,
      now: () => clock
    });

    await expect(resolve(PUBLIC_ENDPOINT)).resolves.toBe(PUBLIC_ENDPOINT);
    clock += 6_000;
    await expect(resolve(PUBLIC_ENDPOINT)).resolves.toBe(INTERNAL_ENDPOINT);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('platform internal-endpoint contract (issue #991)', () => {
  // Shapes here mirror @osaas/client-core lib/core.d.ts:130-136 exactly.
  const SERVICE_DNS = `tenant-mediastack.${OBJECT_STORE_NAMESPACE}.svc.cluster.local`;

  describe('selectInternalPort', () => {
    it('falls back when the platform reports no ports — the object-store reality today', () => {
      expect(selectInternalPort([], 8080)).toBe(8080);
      expect(selectInternalPort(undefined, 8080)).toBe(8080);
    });

    it('prefers a port explicitly named http when the platform does report ports', () => {
      expect(
        selectInternalPort(
          [
            { name: 'proxy', port: 80, protocol: 'TCP' },
            { name: 'http', port: 8080, protocol: 'TCP' }
          ],
          9999
        )
      ).toBe(8080);
    });

    it('never picks the dead proxy port when another is available', () => {
      expect(
        selectInternalPort(
          [
            { name: 'proxy', port: 80, protocol: 'TCP' },
            { name: 's3', port: 9000, protocol: 'TCP' }
          ],
          9999
        )
      ).toBe(9000);
    });
  });

  describe('internalEndpointFromInfo', () => {
    it('builds the URL from serviceDns and the fallback port when ports is empty', () => {
      expect(
        internalEndpointFromInfo(
          { serviceDns: SERVICE_DNS, ports: [], publicAccess: true },
          DEFAULT_INTERNAL_PORT
        )
      ).toBe(INTERNAL_ENDPOINT);
    });

    it('returns undefined rather than fabricating a URL when serviceDns is absent', () => {
      expect(internalEndpointFromInfo(undefined, 8080)).toBeUndefined();
      expect(
        internalEndpointFromInfo({ serviceDns: '  ', ports: [], publicAccess: true }, 8080)
      ).toBeUndefined();
    });
  });

  describe('makeOscInternalEndpointLookup', () => {
    it('mints a service access token for the object-store service and calls the SDK', async () => {
      const getInternalEndpointImpl = vi.fn(async () => ({
        serviceDns: SERVICE_DNS,
        ports: [],
        publicAccess: true
      })) as unknown as GetInternalEndpointFn;
      const oscContext = {
        getServiceAccessToken: vi.fn(async () => 'sat-token')
      } as unknown as Parameters<typeof makeOscInternalEndpointLookup>[0]['oscContext'];

      const lookup = makeOscInternalEndpointLookup({ oscContext, getInternalEndpointImpl });
      await expect(lookup('mediastack')).resolves.toEqual({
        serviceDns: SERVICE_DNS,
        ports: [],
        publicAccess: true
      });
      expect(getInternalEndpointImpl).toHaveBeenCalledWith(
        oscContext,
        OBJECT_STORE_SERVICE_ID,
        'mediastack',
        'sat-token'
      );
    });

    it('FAILS SOFT: an SDK throw (missing instance or internalEndpoint link) becomes undefined', async () => {
      const log = makeLog();
      const lookup = makeOscInternalEndpointLookup({
        oscContext: {
          getServiceAccessToken: async () => 'sat-token'
        } as unknown as Parameters<typeof makeOscInternalEndpointLookup>[0]['oscContext'],
        getInternalEndpointImpl: (async () => {
          throw new Error('Instance mediastack of service minio-minio not found');
        }) as unknown as GetInternalEndpointFn,
        log
      });

      await expect(lookup('mediastack')).resolves.toBeUndefined();
      expect(log.warn).toHaveBeenCalled();
    });
  });
});

describe('makeInternalEndpointResolver — platform lookup is primary (issue #991)', () => {
  const PLATFORM_DNS = 'tenant-elsewhere.minio-minio.svc.cluster.local';
  const PLATFORM_ENDPOINT = `http://${PLATFORM_DNS}:${DEFAULT_INTERNAL_PORT}`;

  it('PRIMARY: uses serviceDns from the platform, not the string derivation', async () => {
    const log = makeLog();
    const lookup = vi.fn(async () => ({
      serviceDns: PLATFORM_DNS,
      ports: [],
      publicAccess: true
    }));
    const resolve = makeInternalEndpointResolver({
      enabled: true,
      lookup,
      probe: async () => true,
      log
    });

    // The derivation would have produced INTERNAL_ENDPOINT; the platform's
    // answer wins, which is the whole point of the contract-first change.
    await expect(resolve(PUBLIC_ENDPOINT, 'mediastack')).resolves.toBe(PLATFORM_ENDPOINT);
    expect(lookup).toHaveBeenCalledWith('mediastack');
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'platform' }),
      expect.any(String)
    );
  });

  it('PRIMARY: takes the port from ports[] when the platform reports any', async () => {
    const log = makeLog();
    const resolve = makeInternalEndpointResolver({
      enabled: true,
      lookup: async () => ({
        serviceDns: PLATFORM_DNS,
        ports: [{ name: 'http', port: 9000, protocol: 'TCP' }],
        publicAccess: true
      }),
      probe: async () => true,
      log
    });

    await expect(resolve(PUBLIC_ENDPOINT, 'mediastack')).resolves.toBe(`http://${PLATFORM_DNS}:9000`);
  });

  it('FALLBACK: derives when the platform returns no usable serviceDns', async () => {
    const log = makeLog();
    const resolve = makeInternalEndpointResolver({
      enabled: true,
      lookup: async () => ({ serviceDns: '', ports: [], publicAccess: true }),
      probe: async () => true,
      log
    });

    await expect(resolve(PUBLIC_ENDPOINT, 'mediastack')).resolves.toBe(INTERNAL_ENDPOINT);
    expect(log.info).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'derived' }),
      expect.any(String)
    );
  });

  it('FALLBACK: derives when the lookup fails, and when no instance name is known', async () => {
    const log = makeLog();
    const resolve = makeInternalEndpointResolver({
      enabled: true,
      lookup: async () => undefined,
      probe: async () => true,
      log
    });

    await expect(resolve(PUBLIC_ENDPOINT, 'mediastack')).resolves.toBe(INTERNAL_ENDPOINT);
    // No instance name: the lookup cannot even be attempted.
    await expect(resolve(PUBLIC_ENDPOINT)).resolves.toBe(INTERNAL_ENDPOINT);
  });

  it('FAILS SOFT: a lookup that throws its contract still derives rather than rejecting', async () => {
    const log = makeLog();
    const resolve = makeInternalEndpointResolver({
      enabled: true,
      lookup: async () => {
        throw new Error('lookup contract violated');
      },
      probe: async () => true,
      log
    });

    await expect(resolve(PUBLIC_ENDPOINT, 'mediastack')).resolves.toBe(INTERNAL_ENDPOINT);
  });

  it('still PROBE-GATED: a platform-supplied endpoint that fails its probe falls back to public', async () => {
    const log = makeLog();
    const resolve = makeInternalEndpointResolver({
      enabled: true,
      lookup: async () => ({ serviceDns: PLATFORM_DNS, ports: [], publicAccess: true }),
      probe: async () => false,
      log
    });

    await expect(resolve(PUBLIC_ENDPOINT, 'mediastack')).resolves.toBe(PUBLIC_ENDPOINT);
    expect(log.warn).toHaveBeenCalled();
  });

  it('OPT-OUT: never calls the platform at all', async () => {
    const log = makeLog();
    const lookup = vi.fn(async () => ({
      serviceDns: PLATFORM_DNS,
      ports: [],
      publicAccess: true
    }));
    const resolve = makeInternalEndpointResolver({ enabled: false, lookup, probe: async () => true, log });

    await expect(resolve(PUBLIC_ENDPOINT, 'mediastack')).resolves.toBe(PUBLIC_ENDPOINT);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('looks the instance up once per TTL window, so a scale-up burst is not a lookup burst', async () => {
    const log = makeLog();
    const lookup = vi.fn(async () => ({
      serviceDns: PLATFORM_DNS,
      ports: [],
      publicAccess: true
    }));
    let clock = 1_000;
    const resolve = makeInternalEndpointResolver({
      enabled: true,
      lookup,
      probe: async () => true,
      log,
      positiveTtlMs: 60_000,
      now: () => clock
    });

    await Promise.all([
      resolve(PUBLIC_ENDPOINT, 'mediastack'),
      resolve(PUBLIC_ENDPOINT, 'mediastack'),
      resolve(PUBLIC_ENDPOINT, 'mediastack')
    ]);
    expect(lookup).toHaveBeenCalledTimes(1);

    clock += 61_000;
    await resolve(PUBLIC_ENDPOINT, 'mediastack');
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it('leaves an already-in-cluster endpoint alone without consulting the platform', async () => {
    const log = makeLog();
    const lookup = vi.fn(async () => ({
      serviceDns: PLATFORM_DNS,
      ports: [],
      publicAccess: true
    }));
    const resolve = makeInternalEndpointResolver({ enabled: true, lookup, probe: async () => true, log });

    await expect(resolve(INTERNAL_ENDPOINT, 'mediastack')).resolves.toBe(INTERNAL_ENDPOINT);
    expect(lookup).not.toHaveBeenCalled();
  });

  it('a non-derivable host with no platform answer still fails soft to the public endpoint', async () => {
    const log = makeLog();
    const resolve = makeInternalEndpointResolver({
      enabled: true,
      lookup: async () => undefined,
      probe: async () => true,
      log
    });

    await expect(resolve('https://s3.example.com', 'mediastack')).resolves.toBe(
      'https://s3.example.com'
    );
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('a bring-your-own host IS still moved in-cluster when the platform knows the instance', async () => {
    // Derivation refuses this host shape, but the platform contract is
    // authoritative and does not depend on the public host at all.
    const log = makeLog();
    const resolve = makeInternalEndpointResolver({
      enabled: true,
      lookup: async () => ({ serviceDns: PLATFORM_DNS, ports: [], publicAccess: true }),
      probe: async () => true,
      log
    });

    await expect(resolve('https://s3.example.com', 'mediastack')).resolves.toBe(PLATFORM_ENDPOINT);
  });
});

describe('resolveInternalEndpointSettings (issue #991)', () => {
  it('is enabled by default, on the S3 API port', () => {
    expect(resolveInternalEndpointSettings({})).toEqual({
      enabled: true,
      port: DEFAULT_INTERNAL_PORT,
      probeTimeoutMs: 3_000
    });
  });

  it.each(['off', 'OFF', ' off ', 'false', '0', 'no', 'disabled'])(
    'treats ENCORE_S3_INTERNAL_ENDPOINT=%s as the opt-out',
    (value) => {
      expect(resolveInternalEndpointSettings({ ENCORE_S3_INTERNAL_ENDPOINT: value }).enabled).toBe(
        false
      );
    }
  );

  it('stays enabled for any other value', () => {
    expect(resolveInternalEndpointSettings({ ENCORE_S3_INTERNAL_ENDPOINT: 'on' }).enabled).toBe(
      true
    );
  });

  it('accepts a port and probe-timeout override', () => {
    expect(
      resolveInternalEndpointSettings({
        ENCORE_S3_INTERNAL_PORT: '9000',
        ENCORE_S3_INTERNAL_PROBE_TIMEOUT_MS: '750'
      })
    ).toEqual({ enabled: true, port: 9000, probeTimeoutMs: 750 });
  });

  it.each(['abc', '0', '-1', '70000', ''])(
    'falls back to the default port for the invalid value %s rather than failing startup',
    (value) => {
      expect(resolveInternalEndpointSettings({ ENCORE_S3_INTERNAL_PORT: value }).port).toBe(
        DEFAULT_INTERNAL_PORT
      );
    }
  );
});

describe('resolveEncoreS3Config endpoint hook (issue #991)', () => {
  it('WITHOUT the hook: hands the transcoder the stored public endpoint (unchanged behaviour)', async () => {
    const log = makeLog();
    const config = await resolveEncoreS3Config(
      {
        paramStore: makeParamStore(makeStackConfig()),
        secretAccessKey: SECRET,
        staticFallbackConfigured: false,
        log
      },
      STACK_NAME
    );

    expect(config).toEqual({
      endpoint: PUBLIC_ENDPOINT,
      accessKeyId: 'admin',
      secretAccessKey: SECRET
    });
  });

  it('WITH the hook: hands the transcoder the mapped in-cluster endpoint', async () => {
    const log = makeLog();
    const config = await resolveEncoreS3Config(
      {
        paramStore: makeParamStore(makeStackConfig()),
        secretAccessKey: SECRET,
        staticFallbackConfigured: false,
        log,
        resolveEndpoint: makeInternalEndpointResolver({
          enabled: true,
          probe: async () => true,
          log
        })
      },
      STACK_NAME
    );

    expect(config?.endpoint).toBe(INTERNAL_ENDPOINT);
    // Credentials are untouched: only the endpoint moves.
    expect(config?.accessKeyId).toBe('admin');
    expect(config?.secretAccessKey).toBe(SECRET);
  });

  it('WITH the hook but an unhealthy cluster path: falls back to the public endpoint', async () => {
    const log = makeLog();
    const config = await resolveEncoreS3Config(
      {
        paramStore: makeParamStore(makeStackConfig()),
        secretAccessKey: SECRET,
        staticFallbackConfigured: false,
        log,
        resolveEndpoint: makeInternalEndpointResolver({
          enabled: true,
          probe: async () => false,
          log
        })
      },
      STACK_NAME
    );

    expect(config?.endpoint).toBe(PUBLIC_ENDPOINT);
    expect(log.warn).toHaveBeenCalled();
  });

  it('a hook that throws cannot break a spawn — the public endpoint is used', async () => {
    const log = makeLog();
    const config = await resolveEncoreS3Config(
      {
        paramStore: makeParamStore(makeStackConfig()),
        secretAccessKey: SECRET,
        staticFallbackConfigured: false,
        log,
        resolveEndpoint: async () => {
          throw new Error('resolver contract violated');
        }
      },
      STACK_NAME
    );

    expect(config?.endpoint).toBe(PUBLIC_ENDPOINT);
    expect(log.error).toHaveBeenCalled();
  });

  // PROVENANCE GATE (issue #991 review finding 3). The hook is applied to the
  // endpoint that came from the STACK CONFIG, whatever else is configured. A
  // leftover ENCORE_S3_ENDPOINT must not silently cost an operator the ingress
  // fix while their static value goes unused — the previous
  // `|| staticFallbackConfigured` gate did exactly that.
  it('PROVENANCE: a stack-config endpoint is still mapped even when a static pair is configured', async () => {
    const log = makeLog();
    const resolveEndpoint = vi.fn(async () => INTERNAL_ENDPOINT);
    const config = await resolveEncoreS3Config(
      {
        paramStore: makeParamStore(makeStackConfig()),
        secretAccessKey: SECRET,
        // A complete static ENCORE_S3_ENDPOINT + secret pair is configured, but
        // this stack HAS its own stored endpoint, so that is the one in play.
        staticFallbackConfigured: true,
        log,
        resolveEndpoint
      },
      STACK_NAME
    );

    expect(config?.endpoint).toBe(INTERNAL_ENDPOINT);
    expect(resolveEndpoint).toHaveBeenCalledWith(PUBLIC_ENDPOINT, undefined);
  });

  // The other half of the provenance rule: a value that genuinely originates
  // from ENCORE_S3_ENDPOINT never passes through the hook, because this
  // resolver returns undefined and the registry uses its own static s3Config
  // verbatim (workspace-registry.ts:206-209).
  it('STATIC OVERRIDE: the static endpoint is honoured verbatim and never reaches the hook', async () => {
    const log = makeLog();
    const resolveEndpoint = vi.fn(async () => INTERNAL_ENDPOINT);
    await expect(
      resolveEncoreS3Config(
        {
          paramStore: makeParamStore(undefined),
          secretAccessKey: SECRET,
          staticFallbackConfigured: true,
          log,
          resolveEndpoint
        },
        STACK_NAME
      )
    ).resolves.toBeUndefined();
    expect(resolveEndpoint).not.toHaveBeenCalled();
  });

  it('passes the object-store INSTANCE NAME from the stack config to the hook', async () => {
    const log = makeLog();
    const resolveEndpoint = vi.fn(async () => INTERNAL_ENDPOINT);
    await resolveEncoreS3Config(
      {
        paramStore: makeParamStore(
          makeStackConfig({
            services: [
              { serviceId: 'apache-couchdb', instanceName: STACK_NAME },
              { serviceId: OBJECT_STORE_SERVICE_ID, instanceName: STACK_NAME }
            ]
          })
        ),
        secretAccessKey: SECRET,
        staticFallbackConfigured: false,
        log,
        resolveEndpoint
      },
      STACK_NAME
    );

    expect(resolveEndpoint).toHaveBeenCalledWith(PUBLIC_ENDPOINT, STACK_NAME);
  });

  it('still FAILS LOUD (issue #804) when nothing resolves, hook or no hook', async () => {
    const log = makeLog();
    await expect(
      resolveEncoreS3Config(
        {
          paramStore: makeParamStore(undefined),
          secretAccessKey: SECRET,
          staticFallbackConfigured: false,
          log,
          resolveEndpoint: async (e) => e
        },
        STACK_NAME
      )
    ).rejects.toThrow(/no object-store endpoint resolvable/);
  });
});

describe('client-facing URLs stay public (issue #991 acceptance)', () => {
  // The presign path builds its URLs from the storage client the stack resolver
  // constructs out of the STORED public StackConfig.minioEndpoint
  // (services/workspace-stack.ts buildConnectionsFromStack), which this change
  // does not touch. This asserts the observable contract: presign output is on
  // the PUBLIC host, never the in-cluster one — an in-cluster name does not
  // resolve outside the cluster and SigV4 signs the Host header.
  it('presignedPut / presignedUploadPart keep the public host', async () => {
    const publicHost = new URL(PUBLIC_ENDPOINT).hostname;
    const fakeMinio = {
      presignedPutObject: vi.fn(
        async (bucket: string, key: string) => `https://${publicHost}/${bucket}/${key}?X-Amz-Signature=x`
      ),
      presignedUrl: vi.fn(
        async (_method: string, bucket: string, key: string) =>
          `https://${publicHost}/${bucket}/${key}?partNumber=1&X-Amz-Signature=x`
      )
    };
    const storage = new WorkspaceStorage(
      fakeMinio as unknown as ConstructorParameters<typeof WorkspaceStorage>[0],
      'openvideocore-source'
    );

    const putUrl = await storage.presignedPut('sources/asset-1');
    const partUrl = await storage.presignedUploadPart('sources/asset-1', 'upload-1', 1);

    for (const url of [putUrl, partUrl]) {
      expect(new URL(url).hostname).toBe(publicHost);
      expect(url).not.toContain('svc.cluster.local');
    }
  });

  it('the stored stack config is never rewritten, so no data migration is needed', async () => {
    const log = makeLog();
    const paramStore = makeParamStore(makeStackConfig());
    await resolveEncoreS3Config(
      {
        paramStore,
        secretAccessKey: SECRET,
        staticFallbackConfigured: false,
        log,
        resolveEndpoint: makeInternalEndpointResolver({
          enabled: true,
          probe: async () => true,
          log
        })
      },
      STACK_NAME
    );

    const stored = await paramStore.loadStackConfig(STACK_CONFIG_NAMESPACE, STACK_NAME);
    expect(stored?.minioEndpoint).toBe(PUBLIC_ENDPOINT);
  });
});
