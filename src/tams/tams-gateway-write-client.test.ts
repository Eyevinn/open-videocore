import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { Asset } from '../data/asset-repo.js';
import {
  buildPostSegmentBody,
  buildPutFlowBody,
  deriveFlowId,
  deriveSourceId,
  fullDurationTimerange,
  makeHttpTamsWriteClient,
  TAMS_BRIDGE_FLOW_NAMESPACE,
  TAMS_BRIDGE_SOURCE_NAMESPACE,
  uuidv5
} from './tams-gateway-write-client.js';

// Minimal Response builder for the injected fetch fake (mirrors encore-client.test).
function makeRes(status: number, body = ''): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return body;
    },
    async json() {
      return body ? JSON.parse(body) : {};
    }
  } as unknown as Response;
}

const BASE = 'https://tams-gateway.example.io/';
const TOKEN = 'delegated-osc-token';

// A ready asset with a known ffprobe duration (technicalMetadata.durationSeconds).
function readyAsset(overrides: Partial<Asset> = {}): Asset {
  const now = '2026-07-12T00:00:00.000Z';
  return {
    id: '01J0AVCORE0000000000000001',
    name: 'clip',
    status: 'ready',
    statusHistory: [{ at: now, from: null, to: 'uploading' }],
    technicalMetadata: {
      codec: 'h264',
      width: 1920,
      height: 1080,
      durationSeconds: 10,
      bitrateBps: 5_000_000,
      containerFormat: 'mp4',
      audioTracks: [],
      extractedAt: now
    },
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe('uuidv5 derivation (ADR-009 deterministic ids)', () => {
  it('is a pure function: identical inputs yield identical output', () => {
    const a = uuidv5('01J0AVCORE0000000000000001', TAMS_BRIDGE_FLOW_NAMESPACE);
    const b = uuidv5('01J0AVCORE0000000000000001', TAMS_BRIDGE_FLOW_NAMESPACE);
    expect(a).toBe(b);
    // Well-formed v5 UUID: version nibble 5, RFC-4122 variant (8/9/a/b).
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('flow and source namespaces produce DISTINCT ids for the same asset', () => {
    const ulid = '01J0AVCORE0000000000000001';
    expect(deriveFlowId(ulid)).not.toBe(deriveSourceId(ulid));
    expect(deriveFlowId(ulid)).toBe(uuidv5(ulid, TAMS_BRIDGE_FLOW_NAMESPACE));
    expect(deriveSourceId(ulid)).toBe(uuidv5(ulid, TAMS_BRIDGE_SOURCE_NAMESPACE));
  });

  it('matches the RFC 4122 v5 reference vector (uuid of "www.example.com" in DNS ns)', () => {
    // Canonical published test vector for UUIDv5 (SHA-1, DNS namespace).
    expect(
      uuidv5('www.example.com', '6ba7b810-9dad-11d1-80b4-00c04fd430c8')
    ).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
  });
});

describe('fullDurationTimerange (ADR-009 single full-duration segment)', () => {
  it('whole seconds -> [0:0_<n>:0)', () => {
    expect(fullDurationTimerange(10)).toBe('[0:0_10:0)');
  });

  it('fractional seconds -> nanoseconds on the TAI timescale', () => {
    expect(fullDurationTimerange(10.5)).toBe('[0:0_10:500000000)');
  });

  it('returns undefined for missing / zero / non-finite duration (skip signal)', () => {
    expect(fullDurationTimerange(undefined)).toBeUndefined();
    expect(fullDurationTimerange(0)).toBeUndefined();
    expect(fullDurationTimerange(-1)).toBeUndefined();
    expect(fullDurationTimerange(Number.NaN)).toBeUndefined();
  });
});

describe('request-body builders', () => {
  it('PUT flow body carries the flow id and the derived source id (source_id)', () => {
    expect(buildPutFlowBody('flow-1', 'source-1')).toEqual({
      id: 'flow-1',
      source_id: 'source-1'
    });
  });

  it('POST segment body carries exactly the timerange', () => {
    expect(buildPostSegmentBody('[0:0_10:0)')).toEqual({ timerange: '[0:0_10:0)' });
  });
});

describe('makeHttpTamsWriteClient.indexAsset', () => {
  let doFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    doFetch = vi.fn();
  });

  function client() {
    return makeHttpTamsWriteClient({
      gatewayBaseUrl: BASE,
      oscAccessToken: TOKEN,
      fetch: doFetch as unknown as typeof globalThis.fetch,
      logger: () => {}
    });
  }

  it('first-index: issues PUT /flows/{derivedFlowId} then POST .../segments with derived ids + full-duration timerange', async () => {
    doFetch.mockResolvedValue(makeRes(200, '{}'));
    const asset = readyAsset();
    const flowId = deriveFlowId(asset.id);
    const sourceId = deriveSourceId(asset.id);

    const result = await client().indexAsset(asset);

    expect(result).toEqual({
      indexed: true,
      flowId,
      sourceId,
      timerange: '[0:0_10:0)'
    });

    expect(doFetch).toHaveBeenCalledTimes(2);

    // Call 1: PUT /flows/{flowId} — creates flow + source. Trailing slash on
    // baseUrl is stripped.
    const [putUrl, putInit] = doFetch.mock.calls[0];
    expect(putUrl).toBe(`https://tams-gateway.example.io/flows/${flowId}`);
    expect(putInit.method).toBe('PUT');
    expect(putInit.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(putInit.body)).toEqual({ id: flowId, source_id: sourceId });

    // Call 2: POST /flows/{flowId}/segments — the single full-duration segment.
    const [segUrl, segInit] = doFetch.mock.calls[1];
    expect(segUrl).toBe(`https://tams-gateway.example.io/flows/${flowId}/segments`);
    expect(segInit.method).toBe('POST');
    expect(segInit.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(segInit.body)).toEqual({ timerange: '[0:0_10:0)' });
  });

  it('re-index is idempotent: second call targets the IDENTICAL ids + timerange (no duplicate entities)', async () => {
    doFetch.mockResolvedValue(makeRes(200, '{}'));
    const asset = readyAsset();

    const first = await client().indexAsset(asset);
    const second = await client().indexAsset(asset);

    // Deterministic ids + timerange are identical across both index passes.
    expect(second).toEqual(first);

    // Both passes hit the SAME flow id path (PUT) and SAME segment path (POST)
    // with the SAME body — a safe upsert over one flow/source/segment, never a
    // second distinct entity.
    const putCalls = doFetch.mock.calls.filter(([, init]) => init.method === 'PUT');
    const segCalls = doFetch.mock.calls.filter(([, init]) => init.method === 'POST');
    expect(putCalls).toHaveLength(2);
    expect(segCalls).toHaveLength(2);
    expect(putCalls[0][0]).toBe(putCalls[1][0]);
    expect(segCalls[0][0]).toBe(segCalls[1][0]);
    expect(putCalls[0][1].body).toBe(putCalls[1][1].body);
    expect(segCalls[0][1].body).toBe(segCalls[1][1].body);
  });

  it('skips (no-op) an asset with no known duration and never calls the gateway', async () => {
    const asset = readyAsset({ technicalMetadata: null });

    const result = await client().indexAsset(asset);

    expect(result).toEqual({ indexed: false, skippedReason: 'skipped-no-duration' });
    expect(doFetch).not.toHaveBeenCalled();
  });

  it('throws with status + body when the flow PUT fails (error handling)', async () => {
    doFetch.mockResolvedValueOnce(makeRes(500, 'boom'));
    await expect(client().indexAsset(readyAsset())).rejects.toThrow(/TAMS flow PUT failed.*500 boom/);
    expect(doFetch).toHaveBeenCalledTimes(1); // no segment call after a PUT failure
  });

  it('throws with status + body when the segment POST fails (error handling)', async () => {
    doFetch
      .mockResolvedValueOnce(makeRes(200, '{}'))
      .mockResolvedValueOnce(makeRes(422, 'bad range'));
    await expect(client().indexAsset(readyAsset())).rejects.toThrow(
      /TAMS segment POST failed.*422 bad range/
    );
    expect(doFetch).toHaveBeenCalledTimes(2);
  });
});
