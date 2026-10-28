// The on-demand packager teardown must tell "no packager exists" from "I could
// not check" (issue #1056 — the same defect #1039 fixed for the stored-service
// teardown in deprovision.ts).
//
// Why this needs its own test rather than being covered by deprovision.probe
// .test.ts: teardownOnDemandPackager does NOT call the SDK's `getInstance` by
// name. It calls `osc.getInstance`, a method on the narrow PackagerOscApi
// interface, which carries no error contract at its call site. The
// swallow-every-error behaviour only appears in packagerOscApiFromContext,
// which binds that method to the real SDK — so these tests go through that
// adapter and mock only the fetch layer, the single place the trap is
// observable.
//
// CONTRACT SOURCES (read in node_modules/@osaas/client-core, SDK 0.24.0 — the
// version pinned in package.json):
//   - lib/core.js:127-150 `getInstance(context, serviceId, name, token)`: the
//     catch rethrows ONLY for a `FetchError` with `httpCode === 401`, returns
//     `undefined` for `httpCode === 404`, then falls through to a bare
//     `return undefined` for EVERY other error.
//   - lib/core.js:160-170 `listInstances(context, serviceId, token)`: NO catch,
//     so any transport or HTTP error rejects; on success it resolves the raw
//     JSON array from the instances endpoint, elements carrying `name`.
//   - lib/core.js:36-46 `removeInstance(context, serviceId, name, token)`:
//     DELETE {apiUrl}/{name}.
//   - lib/core.js:8-22 `getService`: every call above resolves the service's
//     `apiUrl` from `https://catalog.svc.{env}.osaas.io/mysubscriptions` first.
//   - lib/context.d.ts `Context.getServiceAccessToken(serviceId): Promise<string>`.
//   - src/services/stack.ts:54 `PACKAGER_SERVICE_ID` — the serviceId probed.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  packagerOscApiFromContext,
  packagerTeardownAsServiceResults,
  teardownOnDemandPackager
} from './packager-provisioning.js';
import { PACKAGER_SERVICE_ID, PACKAGER_TEARDOWN_ROLE } from './stack.js';

const NAME = 'mystack';
const API_URL = 'https://api.example.osaas.io/encore-packager';

// Minimal Context stub. The adapter calls getServiceAccessToken; the SDK's
// getService (lib/core.js:9-15) additionally reads getEnvironment() to build the
// catalog URL and getPersonalAccessToken() for its header.
const osc = {
  getServiceAccessToken: vi.fn(async () => 'test-sat'),
  getEnvironment: () => 'prod',
  getPersonalAccessToken: () => 'test-pat'
} as never;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  });
}

// The subscriptions payload getService() searches (lib/core.js:17).
const SUBSCRIPTIONS = [
  { serviceId: PACKAGER_SERVICE_ID, apiUrl: API_URL, serviceType: 'instance' }
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

function deletesIn(fetchMock: ReturnType<typeof vi.fn>): unknown[] {
  return fetchMock.mock.calls.filter(
    (c: unknown[]) => (c[1] as RequestInit | undefined)?.method === 'DELETE'
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('teardownOnDemandPackager probe (issue #1056)', () => {
  // Acceptance: "the packager's getInstance resolves undefined because the fetch
  // layer rejected (`fetch failed`), so teardownOnDemandPackager returns failed,
  // not not_found".
  it('reports failed when the probe could not be verified, not not_found', async () => {
    const fetchMock = installFetch({
      instance: networkFault,
      list: networkFault
    });

    const result = await teardownOnDemandPackager(
      packagerOscApiFromContext(osc),
      NAME
    );

    expect(result.status).toBe('failed');
    expect(result.serviceId).toBe(PACKAGER_SERVICE_ID);
    expect(result.error).toContain('fetch failed');
    // Nothing was deleted on the strength of an unverifiable probe.
    expect(deletesIn(fetchMock)).toHaveLength(0);
  });

  // Acceptance: "a genuine 404 still returns not_found, so retries still
  // converge". A stack that never packaged must not be reported as a failure.
  it('reports not_found for a genuine 404 (retry convergence preserved)', async () => {
    const fetchMock = installFetch({
      instance: async () => json({ message: 'not found' }, 404),
      // The confirming read succeeds and does not list this stack's packager.
      list: async () => json([{ name: 'someotherstack' }])
    });

    const result = await teardownOnDemandPackager(
      packagerOscApiFromContext(osc),
      NAME
    );

    expect(result.status).toBe('not_found');
    expect(deletesIn(fetchMock)).toHaveLength(0);
  });

  it('reports failed when the instance read 5xxs', async () => {
    installFetch({
      instance: async () => json({ message: 'upstream error' }, 503),
      list: async () => json({ message: 'upstream error' }, 503)
    });

    const result = await teardownOnDemandPackager(
      packagerOscApiFromContext(osc),
      NAME
    );

    expect(result.status).toBe('failed');
    expect(result.error).toContain('upstream error');
  });

  it('removes a packager the list still shows after an empty probe', async () => {
    // The single-instance read faults, but the collection read succeeds and
    // proves the packager is alive — it must be removed, not written off as
    // "never provisioned".
    const fetchMock = installFetch({
      instance: networkFault,
      list: async () => json([{ name: NAME, url: 'https://live.example' }])
    });

    const result = await teardownOnDemandPackager(
      packagerOscApiFromContext(osc),
      NAME
    );

    expect(result.status).toBe('removed');
    const deletes = deletesIn(fetchMock) as unknown[][];
    expect(deletes).toHaveLength(1);
    expect(String(deletes[0]?.[0])).toBe(`${API_URL}/${NAME}`);
  });

  it('removes the packager the probe found', async () => {
    const fetchMock = installFetch({
      instance: async () => json({ name: NAME }),
      list: async () => json([{ name: NAME }])
    });

    const result = await teardownOnDemandPackager(
      packagerOscApiFromContext(osc),
      NAME
    );

    expect(result.status).toBe('removed');
    expect(deletesIn(fetchMock)).toHaveLength(1);
  });
});

describe('packagerTeardownAsServiceResults (issue #1056)', () => {
  it('carries a failed packager into the stack result as a leftover', () => {
    expect(
      packagerTeardownAsServiceResults({
        serviceId: PACKAGER_SERVICE_ID,
        status: 'failed',
        error: 'fetch failed'
      })
    ).toEqual([
      {
        serviceId: PACKAGER_SERVICE_ID,
        role: PACKAGER_TEARDOWN_ROLE,
        status: 'failed',
        error: 'fetch failed'
      }
    ]);
  });

  it('reports a packager that WAS removed, which used to be invisible', () => {
    expect(
      packagerTeardownAsServiceResults({
        serviceId: PACKAGER_SERVICE_ID,
        status: 'removed'
      })
    ).toEqual([
      {
        serviceId: PACKAGER_SERVICE_ID,
        role: PACKAGER_TEARDOWN_ROLE,
        status: 'removed'
      }
    ]);
  });

  it('contributes nothing for a confirmed-absent packager', () => {
    // A stack that never packaged has no packager. Reporting it as a
    // not_found member would downgrade an otherwise fully removed stack to
    // `partial`, so it is omitted — mirroring how an optional service that was
    // never activated yields no entry (deprovision.ts:optionalStoredServices).
    expect(
      packagerTeardownAsServiceResults({
        serviceId: PACKAGER_SERVICE_ID,
        status: 'not_found'
      })
    ).toEqual([]);
  });

  it('contributes nothing when the packager teardown was not attempted', () => {
    expect(packagerTeardownAsServiceResults(undefined)).toEqual([]);
  });
});
