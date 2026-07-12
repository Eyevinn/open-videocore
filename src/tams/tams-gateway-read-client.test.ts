import { describe, it, expect, vi, beforeEach } from 'vitest';

import { makeHttpTamsGatewayReadClient } from './tams-gateway-read-client.js';

// Minimal Response builder for the injected fetch fake. Uses a real `Headers`
// object so the paging-header parsing path is exercised faithfully (the client
// derives the paging envelope from X-Paging-* / Link headers, ADR-008 "Paging").
function makeRes(
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers(headers),
    async text() {
      return typeof body === 'string' ? body : JSON.stringify(body);
    },
    async json() {
      return body;
    }
  } as unknown as Response;
}

const BASE = 'https://tams-gateway.example.io/';
const TOKEN = 'osc-delegated-token';
const FLOW_ID = 'flow-uuid-123';

describe('makeHttpTamsGatewayReadClient', () => {
  let doFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    doFetch = vi.fn();
  });

  function client() {
    return makeHttpTamsGatewayReadClient({
      gatewayBaseUrl: BASE,
      oscAccessToken: TOKEN,
      fetch: doFetch as unknown as typeof globalThis.fetch
    });
  }

  // -- listFlows: GET /flows (ADR-008 API table, line 66) --------------------
  describe('listFlows', () => {
    it('GETs /flows with the delegated OSC Bearer token and returns typed flows', async () => {
      const flows = [
        { id: 'flow-a', source_id: 'source-a', label: 'A' },
        { id: 'flow-b', source_id: 'source-b', read_only: true }
      ];
      doFetch.mockResolvedValue(makeRes(200, flows));

      const res = await client().listFlows();

      expect(doFetch).toHaveBeenCalledTimes(1);
      const [url, init] = doFetch.mock.calls[0];
      // Trailing slash on baseUrl is stripped before the path is appended.
      expect(url).toBe('https://tams-gateway.example.io/flows');
      expect(init.method).toBe('GET');
      expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(res.flows).toEqual(flows);
      expect(res.flows[0].id).toBe('flow-a');
    });
  });

  // -- getFlow: GET /flows/{id} (ADR-008 API table, line 68) -----------------
  describe('getFlow', () => {
    it('GETs /flows/{id} and returns the single typed flow (with its source id)', async () => {
      const flow = { id: FLOW_ID, source_id: 'source-x', label: 'clip' };
      doFetch.mockResolvedValue(makeRes(200, flow));

      const res = await client().getFlow({ flowId: FLOW_ID });

      expect(doFetch).toHaveBeenCalledTimes(1);
      const [url, init] = doFetch.mock.calls[0];
      expect(url).toBe(`https://tams-gateway.example.io/flows/${FLOW_ID}`);
      expect(init.method).toBe('GET');
      expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(res.flow.id).toBe(FLOW_ID);
      expect(res.flow.source_id).toBe('source-x');
    });

    it('url-encodes the flow id path parameter', async () => {
      doFetch.mockResolvedValue(makeRes(200, { id: 'a/b' }));
      await client().getFlow({ flowId: 'a/b' });
      const [url] = doFetch.mock.calls[0];
      expect(url).toBe('https://tams-gateway.example.io/flows/a%2Fb');
    });
  });

  // -- listFlowSegments: GET /flows/{id}/segments?timerange=... ---------------
  //    (ADR-008 API table, line 75; "Paging", lines 90-94) --------------------
  describe('listFlowSegments', () => {
    it('GETs segments with a timerange filter and returns typed segments + paging', async () => {
      const segments = [
        { timerange: '[0:0_10:0)', object_id: 'seg-1' },
        { timerange: '[10:0_20:0)', object_id: 'seg-2' }
      ];
      doFetch.mockResolvedValue(
        makeRes(200, segments, {
          'X-Paging-Limit': '2',
          'X-Paging-Count': '2',
          'X-Paging-Reverse-Order': 'false',
          'X-Paging-Timerange': '[0:0_20:0)',
          'X-Paging-NextKey': 'opaque-next-key'
        })
      );

      const res = await client().listFlowSegments({
        flowId: FLOW_ID,
        timerange: '[0:0_20:0)',
        limit: 2
      });

      expect(doFetch).toHaveBeenCalledTimes(1);
      const [url, init] = doFetch.mock.calls[0];
      const parsed = new URL(url);
      expect(parsed.origin + parsed.pathname).toBe(
        `https://tams-gateway.example.io/flows/${FLOW_ID}/segments`
      );
      expect(parsed.searchParams.get('timerange')).toBe('[0:0_20:0)');
      expect(parsed.searchParams.get('limit')).toBe('2');
      expect(init.method).toBe('GET');
      expect(init.headers.authorization).toBe(`Bearer ${TOKEN}`);

      expect(res.segments).toEqual(segments);
      expect(res.paging).toEqual({
        limit: 2,
        count: 2,
        reverseOrder: false,
        timerange: '[0:0_20:0)',
        nextKey: 'opaque-next-key'
      });
    });

    it('sends the page continuation key as the `page` query param', async () => {
      doFetch.mockResolvedValue(makeRes(200, []));
      await client().listFlowSegments({ flowId: FLOW_ID, page: 'next-key-abc' });
      const [url] = doFetch.mock.calls[0];
      expect(new URL(url).searchParams.get('page')).toBe('next-key-abc');
    });

    it('omits query params entirely for an unfiltered, unpaged read', async () => {
      doFetch.mockResolvedValue(makeRes(200, []));
      await client().listFlowSegments({ flowId: FLOW_ID });
      const [url] = doFetch.mock.calls[0];
      expect(url).toBe(
        `https://tams-gateway.example.io/flows/${FLOW_ID}/segments`
      );
      expect(url).not.toContain('?');
    });

    it('derives the next-page key from a Link rel="next" header when X-Paging-NextKey is absent', async () => {
      doFetch.mockResolvedValue(
        makeRes(200, [], {
          Link: '</flows/f/segments?page=link-derived-key>; rel="next"'
        })
      );
      const res = await client().listFlowSegments({ flowId: FLOW_ID });
      expect(res.paging.nextKey).toBe('link-derived-key');
    });

    it('returns an empty paging envelope when no paging headers are present', async () => {
      doFetch.mockResolvedValue(makeRes(200, []));
      const res = await client().listFlowSegments({ flowId: FLOW_ID });
      expect(res.segments).toEqual([]);
      expect(res.paging).toEqual({});
    });
  });

  // -- error contract: non-OK responses throw with status + body -------------
  describe('error handling', () => {
    it('throws with the status and response text on a non-OK response', async () => {
      doFetch.mockResolvedValue(makeRes(404, 'not found'));
      await expect(client().getFlow({ flowId: 'missing' })).rejects.toThrow(
        /TAMS gateway read failed: 404 not found/
      );
    });
  });
});
