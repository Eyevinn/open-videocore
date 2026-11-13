// Storage teardown must survive a service API that publishes no collection
// read (issue #1211, split from #1166).
//
// WHAT HAPPENED. Deleting a stack on the stable channel reported
//   {"serviceId":"minio-minio","role":"storage","status":"failed",
//    "error":"Route GET:/minioinstance not found"}
// and left the object store running. The path and the serviceId in that error
// are both CORRECT — see the contract sources below — so there is nothing to
// re-route. What is missing is the route itself: the object store's instance
// API does not implement the collection GET that the #1039 absence
// confirmation depends on, so teardown failed before it ever issued a DELETE.
//
// CONTRACT SOURCES (per CLAUDE.md rule 7):
//   - OSC catalog, `get-service-schema` (fetched 2026-10-15): the object store's
//     serviceId is exactly `minio-minio` (name "minio", category storage) — the
//     value `OBJECT_STORE_SERVICE_ID` already holds in src/services/stack.ts:40
//     and the one the failing teardown already used.
//   - The service's own OpenAPI, `https://api-minio-minio.auto.prod-se.osaas.io/docs/json`,
//     as recorded in docs/architecture/ADR-026-profiles-url-source.md (C5,
//     fetched live 2026-10-04): `POST /minioinstance` with body
//     `{ name, RootUser, RootPassword }`. The instance path segment IS
//     `minioinstance`; the document carries no collection GET.
//   - @osaas/client-core 0.24.0 lib/core.js:160-170 `listInstances` — GETs
//     `service.apiUrl` (the collection) with no catch, so an unregistered route
//     rejects. lib/core.js:106-117 `removeInstance` — DELETEs
//     `service.apiUrl + '/' + name`. lib/fetch.js defaultErrorFactory — a non-ok
//     JSON response becomes `FetchError { message: res.message, httpCode }`,
//     i.e. Fastify's `Route GET:/minioinstance not found` with httpCode 404.
//
// These tests drive the REAL SDK and mock only the fetch layer, like
// deprovision.probe.test.ts, because the behaviour under test lives in how the
// SDK's errors are classified.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { deprovisionStackFromConfig } from './deprovision.js';
import { OBJECT_STORE_SERVICE_ID } from './stack.js';

const NAME = 'delstk1007';

// The apiUrl the catalog publishes for minio-minio, verbatim from ADR-026 C5.
const API_URL = 'https://api-minio-minio.auto.prod-se.osaas.io/minioinstance';

const osc = {
  getServiceAccessToken: vi.fn(async () => 'test-sat'),
  getEnvironment: () => 'prod',
  getPersonalAccessToken: () => 'test-pat'
} as never;

const stored = [{ serviceId: OBJECT_STORE_SERVICE_ID, instanceName: NAME }];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

const SUBSCRIPTIONS = [
  {
    serviceId: OBJECT_STORE_SERVICE_ID,
    apiUrl: API_URL,
    serviceType: 'instance'
  }
];

// Fastify's not-found body for a route that is not registered — the exact
// payload behind the error string reported on #1166.
const routeNotFound = (method: string, path: string) =>
  json(
    {
      message: `Route ${method}:${path} not found`,
      error: 'Not Found',
      statusCode: 404
    },
    404
  );

type Handlers = {
  instance: () => Promise<Response>;
  list: () => Promise<Response>;
  remove?: () => Promise<Response>;
};

function installFetch(handlers: Handlers): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname.startsWith('catalog.svc.')) return json(SUBSCRIPTIONS);
    const isInstanceUrl = url.pathname.endsWith(`/${NAME}`);
    if (isInstanceUrl && init?.method === 'DELETE') {
      return (handlers.remove ?? (async () => json({})))();
    }
    if (isInstanceUrl) return handlers.instance();
    return handlers.list();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock as unknown as ReturnType<typeof vi.fn>;
}

function deletesIn(fetchMock: ReturnType<typeof vi.fn>) {
  return fetchMock.mock.calls.filter(
    (c: unknown[]) => (c[1] as RequestInit | undefined)?.method === 'DELETE'
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('object-store teardown when the service publishes no collection read (#1211)', () => {
  it('still issues the DELETE when the confirming read answers "Route GET:... not found"', async () => {
    const fetchMock = installFetch({
      // The single-instance read is not registered either, so getInstance
      // swallows the 404 and resolves undefined.
      instance: async () => routeNotFound('GET', `/minioinstance/${NAME}`),
      list: async () => routeNotFound('GET', '/minioinstance'),
      remove: async () => json({})
    });

    const result = await deprovisionStackFromConfig(osc, NAME, stored);

    expect(result.services[0]?.status).toBe('removed');
    expect(result.status).toBe('removed');

    const deletes = deletesIn(fetchMock);
    expect(deletes).toHaveLength(1);
    // Addressed at the catalog-published apiUrl for the `minio-minio`
    // serviceId — unchanged by this fix, and asserted so a future "fix" that
    // rewrites the path has to argue with the contract.
    expect(String(deletes[0]?.[0])).toBe(`${API_URL}/${NAME}`);
  });

  it('no longer reports the #1166 failure string for the storage service', async () => {
    installFetch({
      instance: async () => routeNotFound('GET', `/minioinstance/${NAME}`),
      list: async () => routeNotFound('GET', '/minioinstance'),
      remove: async () => json({})
    });

    const result = await deprovisionStackFromConfig(osc, NAME, stored);

    expect(result.services[0]?.serviceId).toBe('minio-minio');
    expect(result.services[0]?.error).toBeUndefined();
  });

  it('reports not_found when the DELETE says the instance is already gone', async () => {
    const fetchMock = installFetch({
      instance: async () => routeNotFound('GET', `/minioinstance/${NAME}`),
      list: async () => routeNotFound('GET', '/minioinstance'),
      remove: async () => json({ message: 'instance not found' }, 404)
    });

    const result = await deprovisionStackFromConfig(osc, NAME, stored);

    // A retry of a completed teardown converges instead of failing forever.
    expect(result.services[0]?.status).toBe('not_found');
    expect(result.status).toBe('not_found');
    expect(deletesIn(fetchMock)).toHaveLength(1);
  });

  it('still fails when the REMOVAL route is the one that is missing', async () => {
    installFetch({
      instance: async () => routeNotFound('GET', `/minioinstance/${NAME}`),
      list: async () => routeNotFound('GET', '/minioinstance'),
      remove: async () => routeNotFound('DELETE', `/minioinstance/${NAME}`)
    });

    const result = await deprovisionStackFromConfig(osc, NAME, stored);

    // Nothing was removed and nothing proved absent: the config must be kept
    // and the operation retried (#1039).
    expect(result.services[0]?.status).toBe('failed');
    expect(result.services[0]?.error).toContain('not found');
  });

  it('a transport fault on the confirming read is still failed, not a removal', async () => {
    // The #1039 guarantee is untouched: only a MISSING ROUTE falls through to
    // the DELETE. An unreachable control plane must not delete on spec.
    const fetchMock = installFetch({
      instance: async () => {
        throw new TypeError('fetch failed');
      },
      list: async () => {
        throw new TypeError('fetch failed');
      }
    });

    const result = await deprovisionStackFromConfig(osc, NAME, stored);

    expect(result.services[0]?.status).toBe('failed');
    expect(deletesIn(fetchMock)).toHaveLength(0);
  });

  it('a 5xx on the confirming read is still failed, not a removal', async () => {
    const fetchMock = installFetch({
      instance: async () => json({ message: 'upstream error' }, 503),
      list: async () => json({ message: 'upstream error' }, 503)
    });

    const result = await deprovisionStackFromConfig(osc, NAME, stored);

    expect(result.services[0]?.status).toBe('failed');
    expect(result.services[0]?.error).toContain('upstream error');
    expect(deletesIn(fetchMock)).toHaveLength(0);
  });

  it('a successful collection read that confirms absence still skips the DELETE', async () => {
    const fetchMock = installFetch({
      instance: async () => json({ message: 'not found' }, 404),
      list: async () => json([{ name: 'someotherstack' }])
    });

    const result = await deprovisionStackFromConfig(osc, NAME, stored);

    expect(result.services[0]?.status).toBe('not_found');
    expect(deletesIn(fetchMock)).toHaveLength(0);
  });
});
