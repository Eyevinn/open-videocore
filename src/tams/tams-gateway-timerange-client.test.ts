import { describe, it, expect, vi, beforeEach } from 'vitest';

import { makeTamsTimerangeReadClient } from './tams-gateway-timerange-client.js';
import { TamsGatewayError, isTamsNotFound } from './tams-gateway-error.js';

// Minimal Response builder for the injected fetch fake. `bodyIsJson` lets a test
// simulate an unparseable-JSON 2xx body (json() throws) while still exposing a
// text() for the non-2xx error path.
function makeRes(
  status: number,
  body: unknown = '',
  headers: Record<string, string> = {},
  opts: { unparseable?: boolean } = {}
): Response {
  const headerMap = new Map(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])
  );
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get(name: string) {
        return headerMap.has(name.toLowerCase()) ? headerMap.get(name.toLowerCase())! : null;
      }
    },
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
    async json() {
      if (opts.unparseable) throw new SyntaxError('Unexpected token < in JSON');
      return body;
    }
  } as unknown as Response;
}

const BASE = 'https://tams-gateway.example.osc/';
const TOKEN = 'osc-delegated-token';
const FLOW_ID = 'flow-abc';
const TIMERANGE = '[0:0_10:0)';

describe('makeTamsTimerangeReadClient.listFlowSegments (timerange read)', () => {
  let doFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    doFetch = vi.fn();
  });

  function client() {
    return makeTamsTimerangeReadClient({
      gatewayBaseUrl: BASE,
      oscAccessToken: TOKEN,
      fetch: doFetch as unknown as typeof globalThis.fetch
    });
  }

  it('200: returns typed segments matching the pinned schema plus header paging', async () => {
    doFetch.mockResolvedValue(
      makeRes(
        200,
        [
          { timerange: '[0:0_5:0)', object_id: 'seg-1' },
          { timerange: '[5:0_10:0)', object_id: 'seg-2' }
        ],
        {
          'X-Paging-Limit': '2',
          'X-Paging-Count': '2',
          'X-Paging-Reverse-Order': 'false',
          'X-Paging-Timerange': '[0:0_10:0)',
          'X-Paging-NextKey': 'opaque-next-key'
        }
      )
    );

    const res = await client().listFlowSegments({ flowId: FLOW_ID, timerange: TIMERANGE });

    expect(res.segments).toHaveLength(2);
    expect(res.segments[0].timerange).toBe('[0:0_5:0)');
    // Open-shape passthrough: non-tabled fields are preserved, not dropped.
    expect(res.segments[0].object_id).toBe('seg-1');
    expect(res.paging).toEqual({
      limit: 2,
      count: 2,
      reverseOrder: false,
      timerange: '[0:0_10:0)',
      nextKey: 'opaque-next-key'
    });

    // Verify the 1:1 endpoint mapping, Bearer auth, and query encoding.
    expect(doFetch).toHaveBeenCalledTimes(1);
    const [url, init] = doFetch.mock.calls[0];
    // URLSearchParams percent-encodes the reserved timerange chars ([ : )).
    // Decoding the query param must round-trip back to the pinned grammar.
    const parsed = new URL(url);
    expect(parsed.pathname).toBe(`/flows/${FLOW_ID}/segments`);
    expect(parsed.searchParams.get('timerange')).toBe(TIMERANGE);
    expect(init.method).toBe('GET');
    expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('falls back to the Link rel="next" header when X-Paging-NextKey is absent', async () => {
    doFetch.mockResolvedValue(
      makeRes(200, [{ timerange: '[0:0_5:0)' }], {
        Link: '<https://tams-gateway.example.osc/flows/flow-abc/segments?page=key-from-link>; rel="next"'
      })
    );

    const res = await client().listFlowSegments({ flowId: FLOW_ID });
    expect(res.paging.nextKey).toBe('key-from-link');
  });

  // --- Error-handling contract: not-found -----------------------------------
  it('404: throws a typed not-found error (kind + status), not a null return', async () => {
    doFetch.mockResolvedValue(makeRes(404, 'flow not found'));

    const err = await client()
      .listFlowSegments({ flowId: 'missing', timerange: TIMERANGE })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TamsGatewayError);
    expect(err.kind).toBe('not-found');
    expect(err.status).toBe(404);
    expect(err.operation).toBe('listFlowSegments');
    expect(isTamsNotFound(err)).toBe(true);
  });

  // --- Error-handling contract: error-status (4xx non-404, 5xx) -------------
  it('403: throws a typed client-error for a non-404 4xx', async () => {
    doFetch.mockResolvedValue(makeRes(403, 'forbidden'));

    const err = await client()
      .listFlowSegments({ flowId: FLOW_ID })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TamsGatewayError);
    expect(err.kind).toBe('client-error');
    expect(err.status).toBe(403);
    expect(isTamsNotFound(err)).toBe(false);
  });

  it('500: throws a typed server-error carrying the status and body text', async () => {
    doFetch.mockResolvedValue(makeRes(500, 'boom'));

    const err = await client()
      .listFlowSegments({ flowId: FLOW_ID })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TamsGatewayError);
    expect(err.kind).toBe('server-error');
    expect(err.status).toBe(500);
    expect(err.message).toContain('500');
    expect(err.message).toContain('boom');
  });

  it('network failure / timeout maps to a typed server-error (no HTTP status)', async () => {
    doFetch.mockRejectedValue(new Error('socket hang up'));

    const err = await client()
      .listFlowSegments({ flowId: FLOW_ID })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TamsGatewayError);
    expect(err.kind).toBe('server-error');
    expect(err.status).toBeUndefined();
  });

  // --- Error-handling contract: malformed payload ---------------------------
  it('2xx with a body that fails schema validation: throws invalid-payload with issues', async () => {
    // Missing the required `timerange` field on a segment.
    doFetch.mockResolvedValue(makeRes(200, [{ object_id: 'seg-1' }]));

    const err = await client()
      .listFlowSegments({ flowId: FLOW_ID })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TamsGatewayError);
    expect(err.kind).toBe('invalid-payload');
    expect(err.status).toBe(200);
    expect(err.validationIssues).toBeDefined();
    expect(err.validationIssues.join(' ')).toMatch(/timerange/);
  });

  it('2xx whose body is not an array: throws invalid-payload', async () => {
    doFetch.mockResolvedValue(makeRes(200, { not: 'an array' }));

    const err = await client()
      .listFlowSegments({ flowId: FLOW_ID })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TamsGatewayError);
    expect(err.kind).toBe('invalid-payload');
  });

  it('2xx with unparseable JSON: throws invalid-payload', async () => {
    doFetch.mockResolvedValue(makeRes(200, '', {}, { unparseable: true }));

    const err = await client()
      .listFlowSegments({ flowId: FLOW_ID })
      .catch((e) => e);

    expect(err).toBeInstanceOf(TamsGatewayError);
    expect(err.kind).toBe('invalid-payload');
    expect(err.status).toBe(200);
  });
});
