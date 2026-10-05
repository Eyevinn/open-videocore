// Teardown must tell "the instance is gone" from "I could not check" (#1039).
//
// CONTRACT SOURCES (read in node_modules/@osaas/client-core, SDK 0.24.0 —
// the version pinned in package.json):
//   - lib/core.js:127-150 `getInstance(context, serviceId, name, token)`: the
//     catch rethrows ONLY for a `FetchError` with `httpCode === 401`, returns
//     `undefined` for `httpCode === 404`, and then falls through to a bare
//     `return undefined` for EVERY other error.
//   - lib/fetch.js:21-45 `createFetch`: a rejected `fetch` (network fault, DNS,
//     timeout) is rethrown as `new FetchError({ message })` with NO httpCode; a
//     non-ok response becomes a `FetchError` carrying `response.status`. Both
//     land in getInstance's catch, so both surface as `undefined`.
//   - lib/core.js:160-170 `listInstances(context, serviceId, token)`: NO catch,
//     so any transport or HTTP error rejects; on success it resolves the raw
//     JSON array from the instances endpoint, elements carrying `name`.
//   - lib/core.js:8-22 `getService`: both calls above resolve the service's
//     `apiUrl` from `https://catalog.svc.{env}.osaas.io/mysubscriptions` first.
//   - lib/context.d.ts `Context.getServiceAccessToken(serviceId): Promise<string>`.
//
// These tests therefore drive the REAL SDK and mock only the fetch layer, which
// is the only place the "any error reads as not found" trap is observable.
// teardownService is module-private; it is exercised through the exported
// deprovisionStackFromConfig with a single stored service, so `services[0]` is
// that one teardown's result.

import { describe, it, expect, vi, afterEach } from 'vitest';
import { getInstance } from '@osaas/client-core';
import { deprovisionStackFromConfig } from './deprovision.js';

const SERVICE_ID = 'minio-minio';
const NAME = 'mystack';
const API_URL = 'https://api.example.osaas.io/servicename';

// Minimal Context stub. teardownService calls getServiceAccessToken; the SDK's
// getService (lib/core.js:9-15) additionally reads getEnvironment() to build the
// catalog URL and getPersonalAccessToken() for its header. Stubbing the token
// exchange keeps it out of the fetch mock below.
const osc = {
  getServiceAccessToken: vi.fn(async () => 'test-sat'),
  getEnvironment: () => 'prod',
  getPersonalAccessToken: () => 'test-pat'
} as never;

const stored = [{ serviceId: SERVICE_ID, instanceName: NAME }];

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

// The subscriptions payload getService() searches (lib/core.js:17).
const SUBSCRIPTIONS = [
  { serviceId: SERVICE_ID, apiUrl: API_URL, serviceType: 'instance' }
];

type Handlers = {
  // GET {apiUrl}/{name} — the single-instance read getInstance performs.
  instance: () => Promise<Response>;
  // GET {apiUrl} — the collection read listInstances performs.
  list: () => Promise<Response>;
  // DELETE {apiUrl}/{name} — removeInstance.
  remove?: () => Promise<Response>;
};

function installFetch(handlers: Handlers): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname.startsWith('catalog.svc.')) {
      return json(SUBSCRIPTIONS);
    }
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

// A rejected fetch — what a DNS failure, a connection reset or a timeout looks
// like to the SDK (undici rejects with TypeError: fetch failed).
const networkFault = async (): Promise<Response> => {
  throw new TypeError('fetch failed');
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('teardown probe distinguishes absent from unverifiable (issue #1039)', () => {
  it('documents the trap: getInstance resolves undefined when the request FAILS', async () => {
    // Catalog resolves; the instance read faults. getInstance swallows it.
    installFetch({ instance: networkFault, list: networkFault });

    await expect(
      getInstance(osc, SERVICE_ID, NAME, 'test-sat')
    ).resolves.toBeUndefined();
  });

  it('a probe that could not be checked reports failed, not not_found', async () => {
    const fetchMock = installFetch({
      instance: networkFault,
      list: networkFault
    });

    const result = await deprovisionStackFromConfig(osc, NAME, stored);

    expect(result.services[0]?.status).toBe('failed');
    expect(result.status).toBe('failed');
    // The instance was NEVER deleted on the strength of an unverifiable probe.
    const deletes = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE'
    );
    expect(deletes).toHaveLength(0);
  });

  it('a genuine 404 still reports not_found (retry convergence preserved)', async () => {
    const fetchMock = installFetch({
      instance: async () => json({ message: 'not found' }, 404),
      // The confirming read succeeds and does not list the instance.
      list: async () => json([{ name: 'someotherstack' }])
    });

    const result = await deprovisionStackFromConfig(osc, NAME, stored);

    expect(result.services[0]?.status).toBe('not_found');
    expect(result.status).toBe('not_found');
    const deletes = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE'
    );
    expect(deletes).toHaveLength(0);
  });

  it('a 5xx on the instance read reports failed rather than not_found', async () => {
    installFetch({
      instance: async () => json({ message: 'upstream error' }, 503),
      list: async () => json({ message: 'upstream error' }, 503)
    });

    const result = await deprovisionStackFromConfig(osc, NAME, stored);

    expect(result.services[0]?.status).toBe('failed');
    expect(result.services[0]?.error).toContain('upstream error');
  });

  it('removes an instance the list still shows even though the probe came back empty', async () => {
    // The single-instance read faults, but the collection read succeeds and
    // proves the instance is alive — it must be removed, not written off.
    const fetchMock = installFetch({
      instance: networkFault,
      list: async () => json([{ name: NAME, url: 'https://live.example' }])
    });

    const result = await deprovisionStackFromConfig(osc, NAME, stored);

    expect(result.services[0]?.status).toBe('removed');
    const deletes = fetchMock.mock.calls.filter(
      (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE'
    );
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0]?.[0])).toBe(`${API_URL}/${NAME}`);
  });
});
