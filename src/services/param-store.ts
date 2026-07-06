// OSC parameter store client (issue #31, ADR-002).
//
// After a stack is provisioned we persist its non-secret connection
// coordinates to the OSC parameter store (the `eyevinn-app-config-svc`
// service) so the API can reconnect to a named stack at runtime without the
// caller re-supplying every endpoint. Deprovision (#29) also reads the stored
// `services` list to know what to tear down.
//
// The @osaas/client-core SDK does not (as of 2026-06-01) expose parameter-store
// helpers — the store is itself an OSC service instance exposing an HTTP
// key/value API guarded by an API key. We therefore talk to it over HTTP here,
// mirroring the narrow-interface + HTTP-impl pattern used by EncoreClient
// (pipeline/encore-client.ts). The friction is logged to
// docs/osc-feedback/incoming-issue31-param-store.md.
//
// SECURITY: only non-secret connection coordinates are stored. Passwords and
// password-bearing connection strings must never be written here — callers are
// responsible for stripping credentials before handing values to storeStackConfig
// (see stripCredentials).

// The connection coordinates persisted for a provisioned stack. Every value is
// a host/URL/endpoint or a bucket name — NO passwords, NO credential-bearing
// connection strings. See the storage list in issue #31.
export type StackConfig = {
  minioEndpoint: string;
  // CouchDB host/URL only — no embedded password.
  couchdbUrl: string;
  redisUrl: string;
  encoreUrl: string;
  encoreCallbackUrl: string;
  sourceBucket: string;
  packagedBucket: string;
  // The OSC instances that make up the stack, for deprovision (#29).
  services: { serviceId: string; instanceName: string }[];
};

// Narrow interface so the provision/read routes can be tested without a live
// parameter store. The HTTP implementation is makeHttpParamStore.
export interface ParamStore {
  // Persist all coordinates for one named stack, scoped to a workspace.
  storeStackConfig(
    workspaceId: string,
    name: string,
    config: StackConfig
  ): Promise<void>;
  // Read back the coordinates for a named stack, or undefined if none stored.
  loadStackConfig(
    workspaceId: string,
    name: string
  ): Promise<StackConfig | undefined>;
  // Remove the stored coordinates for a named stack (deprovision, #29). Must be
  // idempotent: deleting an already-absent entry resolves without error.
  deleteStackConfig(workspaceId: string, name: string): Promise<void>;
  // List all stack names persisted for a workspace.
  listStackNames(workspaceId: string): Promise<string[]>;
}

// Key under which a stack's config blob is stored. Namespaced by workspace so
// two tenants may use the same stack name without collision, and prefixed with
// `openvideocore/` so open-videocore keys are distinguishable from any other
// consumer of a shared store.
export function stackConfigKey(workspaceId: string, name: string): string {
  return `openvideocore/${workspaceId}/${name}`;
}

// Strip any embedded userinfo (user:password@) from a URL-shaped connection
// string, leaving scheme://host[:port][/path]. Used to guarantee that no
// password is ever persisted. Non-URL strings are returned unchanged.
export function stripCredentials(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    url.username = '';
    url.password = '';
    return url.toString();
  } catch {
    // Not a parseable URL — fall back to a regex strip of a userinfo segment.
    return connectionString.replace(/(^[a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, '$1');
  }
}

// True if a connection string carries embedded userinfo (user[:password]@).
// Distinct from stripCredentials' round-trip — that also normalises the URL
// (e.g. adds a trailing slash), which is not a credential leak.
export function hasCredentials(connectionString: string): boolean {
  try {
    const url = new URL(connectionString);
    return url.username !== '' || url.password !== '';
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\/[^@/]*@/i.test(connectionString);
  }
}

// Defensive assertion: throw if any value in the config still carries an
// embedded credential. Called before writing so a regression upstream cannot
// silently leak a password into the store.
function assertNoCredentials(config: StackConfig): void {
  for (const key of [
    'couchdbUrl',
    'redisUrl',
    'minioEndpoint',
    'encoreUrl',
    'encoreCallbackUrl'
  ] as const) {
    if (hasCredentials(config[key])) {
      throw new Error(
        `refusing to store credential-bearing value for "${key}" in the parameter store`
      );
    }
  }
}

export type HttpParamStoreConfig = {
  // Base URL of the eyevinn-app-config-svc instance (PARAMETER_STORE_URL).
  baseUrl: string;
  // ConfigApiKey set on the eyevinn-app-config-svc instance (PARAMETER_STORE_API_KEY).
  apiKey: string;
  // OSC service access token for the eyevinn-app-config-svc service. Required
  // by OSC's reverse proxy (Authorization: Bearer). Refreshed by the caller.
  getOscToken: () => Promise<string>;
  // Injectable fetch for tests; defaults to global fetch.
  fetch?: typeof globalThis.fetch;
  // Per-request timeout in milliseconds. All external OSC calls must be bounded.
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;

// HTTP-backed parameter store client for eyevinn-app-config-svc.
//
// SMOKE TEST CONFIRMED (2026-06-01) — real API contract:
//   POST   /api/v1/config          { key, value }  → 200 { key, value }  (create or overwrite)
//   GET    /api/v1/config/{key}    →  200 { key, value } | 404 { reason }
//   PUT    /api/v1/config/{key}    { value }        → 200 { key, value } | 404
//   DELETE /api/v1/config/{key}    → 200 { message } | 404 { reason }
//
// Auth: OSC SAT in `Authorization: Bearer <sat>` (reverse proxy) +
//       `x-api-key: <ConfigApiKey>` (app layer).
//
// Keys containing `/` are encoded with encodeURIComponent so the
// `openvideocore/<workspaceId>/<name>` namespace survives as a single segment.
export function makeHttpParamStore(config: HttpParamStoreConfig): ParamStore {
  const doFetch = config.fetch ?? globalThis.fetch;
  const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = config.baseUrl.replace(/\/$/, '');

  function configUrl(key?: string): string {
    const path = key ? `/${encodeURIComponent(key)}` : '';
    return `${base}/api/v1/config${path}`;
  }

  async function withTimeout<T>(
    run: (signal: AbortSignal) => Promise<T>
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await run(controller.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  async function buildHeaders(): Promise<Record<string, string>> {
    const sat = await config.getOscToken();
    return {
      'content-type': 'application/json',
      authorization: `Bearer ${sat}`,
      'x-api-key': config.apiKey
    };
  }

  return {
    async storeStackConfig(workspaceId, name, stackConfig) {
      assertNoCredentials(stackConfig);
      const key = stackConfigKey(workspaceId, name);
      const value = JSON.stringify(stackConfig);
      // POST creates or overwrites — confirmed idempotent in smoke test.
      const h = await buildHeaders();
      const res = await withTimeout((signal) =>
        doFetch(configUrl(), {
          method: 'POST',
          headers: h,
          body: JSON.stringify({ key, value }),
          signal
        })
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`parameter store write failed: ${res.status} ${text}`.trim());
      }
    },

    async loadStackConfig(workspaceId, name) {
      const key = stackConfigKey(workspaceId, name);
      const h = await buildHeaders();
      const res = await withTimeout((signal) =>
        doFetch(configUrl(key), { method: 'GET', headers: h, signal })
      );
      if (res.status === 404) return undefined;
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`parameter store read failed: ${res.status} ${text}`.trim());
      }
      const body = (await res.json().catch(() => ({}))) as { value?: string };
      if (typeof body.value !== 'string' || body.value.length === 0) return undefined;
      try {
        return JSON.parse(body.value) as StackConfig;
      } catch {
        throw new Error(`parameter store value for "${key}" is not valid JSON`);
      }
    },

    async deleteStackConfig(workspaceId, name) {
      const key = stackConfigKey(workspaceId, name);
      const h = await buildHeaders();
      const res = await withTimeout((signal) =>
        doFetch(configUrl(key), { method: 'DELETE', headers: h, signal })
      );
      // 404 = already gone — idempotent success.
      if (res.status === 404 || res.ok) return;
      const text = await res.text().catch(() => '');
      throw new Error(`parameter store delete failed: ${res.status} ${text}`.trim());
    },

    async listStackNames(workspaceId) {
      const prefix = `openvideocore/${workspaceId}/`;
      const h = await buildHeaders();
      // The app-config-svc list endpoint returns { items: [{ key, value }], total }
      // with a configurable limit. We fetch up to 200 to cover realistic use.
      const res = await withTimeout((signal) =>
        doFetch(`${base}/api/v1/config?limit=100`, { method: 'GET', headers: h, signal })
      );
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`parameter store list failed: ${res.status} ${text}`.trim());
      }
      const body = (await res.json()) as { items?: { key: string }[] };
      return (body.items ?? [])
        .map((item) => item.key)
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length));
    }
  };
}

// Build a ParamStore from the environment. Requires PARAMETER_STORE_URL +
// PARAMETER_STORE_API_KEY. Returns undefined when unconfigured (provision
// route will surface a 501).
export function paramStoreFromEnv(
  getOscToken: () => Promise<string>
): ParamStore | undefined {
  const baseUrl = process.env['PARAMETER_STORE_URL'];
  const apiKey = process.env['PARAMETER_STORE_API_KEY'];
  if (!baseUrl || !apiKey) return undefined;
  return makeHttpParamStore({ baseUrl, apiKey, getOscToken });
}

export const PARAM_STORE_SERVICE_ID = 'eyevinn-app-config-svc' as const;

// OSC instance name must be alphanumeric-only (OSC constraint).
const DEFAULT_PARAM_STORE_INSTANCE_NAME = 'ovcconfig';

const VALKEY_SERVICE_ID = 'valkey-io-valkey';

export interface OscInstanceApi {
  getServiceAccessToken(serviceId: string): Promise<string>;
  getInstance(
    serviceId: string,
    name: string,
    sat: string
  ): Promise<{ name?: string } | undefined>;
  createInstance(
    serviceId: string,
    sat: string,
    body: Record<string, unknown>
  ): Promise<{ name?: string }>;
  waitForInstanceReady(serviceId: string, name: string): Promise<void>;
  getPortsForInstance(
    serviceId: string,
    name: string,
    sat: string
  ): Promise<Array<{ externalIp: string; externalPort: number; internalPort: number }>>;
}

export type EnsureParameterStoreOptions = {
  osc: OscInstanceApi;
  log: { info: (msg: string) => void; warn: (msg: string) => void };
};

// Idempotently ensure the eyevinn-app-config-svc instance exists on first
// startup (issue #35). Any OSC failure is logged as a warning and swallowed.
export async function ensureParameterStore(
  opts: EnsureParameterStoreOptions
): Promise<boolean> {
  const apiKey = process.env['PARAMETER_STORE_API_KEY'];
  if (!process.env['PARAMETER_STORE_URL'] || !apiKey) return false;

  const name =
    process.env['PARAMETER_STORE_INSTANCE_NAME'] ??
    DEFAULT_PARAM_STORE_INSTANCE_NAME;

  try {
    const sat = await opts.osc.getServiceAccessToken(PARAM_STORE_SERVICE_ID);
    const existing = await opts.osc.getInstance(PARAM_STORE_SERVICE_ID, name, sat);
    if (existing) return true;

    // Provision a dedicated Valkey for the config service so it is never
    // shared with the pipeline queue. Named "${name}redis" (alphanumeric only).
    const valkeyName = `${name}redis`;
    const valkeySat = await opts.osc.getServiceAccessToken(VALKEY_SERVICE_ID);
    let valkeyPorts: Array<{ externalIp: string; externalPort: number; internalPort: number }>;
    const existingValkey = await opts.osc.getInstance(VALKEY_SERVICE_ID, valkeyName, valkeySat);
    if (existingValkey) {
      opts.log.info(`config Valkey "${valkeyName}" already exists`);
      valkeyPorts = await opts.osc.getPortsForInstance(VALKEY_SERVICE_ID, valkeyName, valkeySat);
    } else {
      await opts.osc.createInstance(VALKEY_SERVICE_ID, valkeySat, { name: valkeyName });
      opts.log.info(`config Valkey "${valkeyName}" created, waiting for ready…`);
      await opts.osc.waitForInstanceReady(VALKEY_SERVICE_ID, valkeyName);
      valkeyPorts = await opts.osc.getPortsForInstance(VALKEY_SERVICE_ID, valkeyName, valkeySat);
    }

    const port = valkeyPorts.find((p) => p.internalPort === 6379) ?? valkeyPorts[0];
    if (!port) throw new Error(`no ports returned for Valkey instance "${valkeyName}"`);
    const redisUrl = `redis://${port.externalIp}:${port.externalPort}`;

    await opts.osc.createInstance(PARAM_STORE_SERVICE_ID, sat, {
      name,
      ConfigApiKey: apiKey,
      RedisUrl: redisUrl
    });
    opts.log.info(`parameter store instance "${name}" created with dedicated Valkey`);
    return true;
  } catch (err) {
    opts.log.warn(
      `parameter store auto-bootstrap skipped: ${
        err instanceof Error ? err.message : String(err)
      }`
    );
    return false;
  }
}
